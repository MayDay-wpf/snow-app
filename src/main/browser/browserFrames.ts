import type { BrowserFramesResult } from "../../preload/types/browser";
import { ipcMain, type WebContents, type WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  getBrowserWebContents,
  ensureWebContentsDebugger,
} from "../ipc/handlers/browserNetworkRecorder";
import { buildElementLocatorScript } from "../../shared/browserElementLocator";
import { SCROLL_FUNCTION } from "../../shared/browserScroll";
import { serializeAxTree, type AxNode } from "../../shared/browserAxSnapshot";
import {
  describeBrowserUrlRedaction,
  redactBrowserResult,
  redactBrowserText,
  redactBrowserUrl,
} from "../../shared/browserRedaction";
import { buildTabContentScript } from "./browserTabContent";
import { getCssStyles } from "./browserCssInspector";
import { runBrowserAudit, type AuditCategories } from "./browserAudit";
import { frameCdpDeadline, getFrameTargetManager } from "./frameTargetManager";

type Args = Record<string, unknown>;
type FrameEntry = {
  id: string;
  frame: WebFrameMain;
  marker: string;
  refs: Map<string, number>;
  /** CDP target of the validated document; reused until the document/context probe fails. */
  cdp?: CdpFrame;
};
type State = { entries: Map<string, FrameEntry>; tail: Promise<unknown> };
type CdpFrame = { frameId: string; contextId: number; sessionId?: string };
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
const states = new Map<number, State>();
const frameOperations = new Set([
  "frames",
  "evaluate",
  "get_tab_content",
  "wait",
  "click",
  "hover",
  "type",
  "select_option",
  "upload-file",
  "devtools",
  "drag",
  "fill_form",
  "scroll",
  "press_key",
  "get_css_styles",
  "audit",
  "observe",
]);
const bounded = (
  args: Args,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const value = args[key] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Invalid ${key}`);
  return value;
};
const stateFor = (contents: WebContents): State => {
  let state = states.get(contents.id);
  if (!state) {
    state = { entries: new Map(), tail: Promise.resolve() };
    states.set(contents.id, state);
    contents.once("destroyed", () => states.delete(contents.id));
  }
  return state;
};
const alive = (contents: WebContents, entry: FrameEntry): void => {
  if (
    contents.isDestroyed() ||
    entry.frame.isDestroyed() ||
    entry.frame.detached ||
    !contents.mainFrame.framesInSubtree.includes(entry.frame)
  )
    throw new Error(
      "FRAME_STALE: frame was detached or replaced; enumerate frames again",
    );
};
const frameCommand = (
  contents: WebContents,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<any> =>
  frameCdpDeadline(method, () =>
    contents.debugger.sendCommand(method, params, sessionId),
  );

const rawExecute = async (
  frame: WebFrameMain,
  script: string,
  userGesture = false,
): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.executeJavaScript(script, userGesture),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "FRAME_EXECUTION_TIMEOUT: execution did not finish within 30 seconds",
              ),
            ),
          30000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const execute = async (
  contents: WebContents,
  entry: FrameEntry,
  script: string,
): Promise<unknown> => {
  alive(contents, entry);
  return rawExecute(
    entry.frame,
    `(async () => {
    if (globalThis[${JSON.stringify(entry.marker)}] !== document) throw new Error('FRAME_STALE: document was replaced; enumerate frames again');
    return await (${script});
  })()`,
  );
};
const entryFor = async (
  contents: WebContents,
  frame: WebFrameMain,
): Promise<FrameEntry> => {
  const state = stateFor(contents);
  for (const entry of state.entries.values()) {
    if (entry.frame !== frame) continue;
    try {
      if (await execute(contents, entry, "true")) return entry;
    } catch {
      state.entries.delete(entry.id);
    }
  }
  if (frame.isDestroyed() || frame.detached)
    throw new Error("FRAME_STALE: frame is no longer attached");
  const id = `frame-${randomUUID()}`;
  const marker = `__snow_document_${randomUUID().replaceAll("-", "")}`;
  await rawExecute(
    frame,
    `Object.defineProperty(globalThis, ${JSON.stringify(marker)}, { value: document, configurable: true }); true`,
  );
  const entry: FrameEntry = { id, frame, marker, refs: new Map() };
  state.entries.set(id, entry);
  // Expired documents are pruned during enumeration, and the guest owns all remaining state.
  if (state.entries.size > 512) {
    const oldest = state.entries.keys().next().value;
    if (oldest) state.entries.delete(oldest);
  }
  return entry;
};
const selectFrame = async (
  contents: WebContents,
  frameId: unknown,
): Promise<FrameEntry> => {
  if (frameId === undefined || frameId === null)
    return entryFor(contents, contents.mainFrame);
  if (typeof frameId !== "string" || !/^frame-[0-9a-f-]{36}$/.test(frameId))
    throw new Error("Invalid frameId; use browser-frames");
  const entry = stateFor(contents).entries.get(frameId);
  if (!entry)
    throw new Error(
      "FRAME_STALE: unknown frameId for this browser; enumerate frames again",
    );
  await execute(contents, entry, "true");
  return entry;
};
const enumerate = async (
  contents: WebContents,
): Promise<BrowserFramesResult> => {
  const frames = contents.mainFrame.framesInSubtree;
  const state = stateFor(contents);
  for (const [id, entry] of state.entries) {
    if (
      !frames.includes(entry.frame) ||
      entry.frame.isDestroyed() ||
      entry.frame.detached
    )
      state.entries.delete(id);
  }
  const entries = new Map<WebFrameMain, FrameEntry>();
  const unavailable: { frameTreeNodeId: number; error: string }[] = [];
  for (const frame of frames) {
    try {
      entries.set(frame, await entryFor(contents, frame));
    } catch {
      unavailable.push({
        frameTreeNodeId: frame.frameTreeNodeId,
        error: "Frame unavailable during enumeration",
      });
    }
  }
  return {
    frames: [...entries.values()].map((entry) => ({
      frameId: entry.id,
      parentFrameId: entry.frame.parent
        ? (entries.get(entry.frame.parent)?.id ?? null)
        : null,
      isMainFrame: entry.frame === contents.mainFrame,
      url: redactBrowserUrl(entry.frame.url),
      name: redactBrowserText(entry.frame.name),
    })),
    unavailable,
  };
};

/** Map only frames descended from this guest. A temporary DOM marker correlates isolated CDP worlds
 * to WebFrameMain without inspecting URLs, cookies or storage. Cross-origin frames live in their own
 * CDP targets; the shared manager owns their sessions and this probe verifies the exact document. */
const withCdpFrame = async <T>(
  contents: WebContents,
  entry: FrameEntry,
  action: (target: CdpFrame) => Promise<T>,
): Promise<T> => {
  await frameCdpDeadline("ensureWebContentsDebugger", () =>
    ensureWebContentsDebugger(contents),
  );
  if (!contents.debugger.isAttached())
    throw new Error("FRAME_CDP_UNAVAILABLE: close page DevTools and retry");
  // Reuse the CDP target of this exact document instead of re-probing every session and
  // frame per operation. The document marker still gates reuse; a destroyed context or
  // detached session falls back to full discovery rather than being retried.
  const cached = entry.cdp;
  if (cached) {
    let usable = false;
    try {
      await execute(contents, entry, "true");
      const probe = (await frameCommand(
        contents,
        "Runtime.evaluate",
        {
          contextId: cached.contextId,
          expression: "true",
          returnByValue: true,
        },
        cached.sessionId,
      )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      usable = !probe.exceptionDetails && probe.result?.value === true;
    } catch {
      usable = false;
    }
    if (usable) return await action(cached);
    entry.cdp = undefined;
  }
  const attribute = `data-snow-frame-${randomUUID()}`;
  const objectGroup = `snow-frame-${randomUUID()}`;
  const discoveryErrors: string[] = [];
  const probedSessions = new Set<string>();
  let framesProbed = 0;
  let probeFailures = 0;
  let lastProbeError = "";
  const command = (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any> => frameCommand(contents, method, params, sessionId);
  const describe = (error: unknown): string =>
    redactBrowserText(error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  await execute(
    contents,
    entry,
    `(() => { if (!document.documentElement) throw new Error('Frame document is not ready'); document.documentElement.setAttribute(${JSON.stringify(attribute)}, '1'); return true; })()`,
  );
  const probeSession = async (
    sessionId: string | undefined,
  ): Promise<CdpFrame | undefined> => {
    if (sessionId) probedSessions.add(sessionId);
    let tree: { frameTree?: FrameTree };
    try {
      tree = (await command("Page.getFrameTree", {}, sessionId)) as {
        frameTree?: FrameTree;
      };
    } catch (error) {
      probeFailures += 1;
      lastProbeError = describe(error);
      return undefined;
    }
    if (!tree.frameTree) {
      probeFailures += 1;
      lastProbeError = "empty frame tree";
      return undefined;
    }
    const list: FrameTree[] = [];
    const walk = (node: FrameTree): void => {
      list.push(node);
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(tree.frameTree);
    for (const node of list) {
      framesProbed += 1;
      try {
        const world = await command(
          "Page.createIsolatedWorld",
          {
            frameId: node.frame.id,
            worldName: "snow-frame-tools",
            grantUniveralAccess: false,
          },
          sessionId,
        );
        if (typeof world.executionContextId !== "number")
          throw new Error("Frame context unavailable");
        const probe = await command(
          "Runtime.evaluate",
          {
            contextId: world.executionContextId,
            expression: `document.documentElement?.getAttribute(${JSON.stringify(attribute)}) === '1'`,
            returnByValue: true,
            objectGroup,
          },
          sessionId,
        );
        if (!probe.exceptionDetails && probe.result?.value === true)
          return {
            frameId: node.frame.id,
            contextId: world.executionContextId,
            sessionId,
          };
      } catch (error) {
        probeFailures += 1;
        lastProbeError = describe(error);
      }
    }
    return undefined;
  };
  try {
    const rootTarget = await probeSession(undefined);
    if (rootTarget) {
      await execute(contents, entry, "true");
      entry.cdp = rootTarget;
      return await action(rootTarget);
    }
    const manager = getFrameTargetManager(contents);
    try {
      await manager.ensure();
    } catch (error) {
      discoveryErrors.push(`iframe targets: ${describe(error)}`);
    }
    for (const sessionId of manager.sessionIds()) {
      const targetFrame = await probeSession(sessionId);
      if (!targetFrame) continue;
      await execute(contents, entry, "true");
      entry.cdp = targetFrame;
      return await action(targetFrame);
    }
    const diagnostics = manager.diagnostics();
    for (const error of diagnostics.errors.slice(0, 2))
      discoveryErrors.push(`discovery: ${describe(error)}`);
    // Distinguish a replaced document from a missing CDP context; never fall back to the main frame.
    await execute(contents, entry, "true");
    const details = [
      `targets=${diagnostics.sessions}`,
      `frames=${framesProbed}`,
      `probeFailures=${probeFailures}`,
      ...(discoveryErrors.length
        ? [`discovery=${discoveryErrors.slice(0, 2).join(" | ")}`]
        : []),
      ...(lastProbeError ? [`lastProbe=${lastProbeError}`] : []),
    ].join(", ");
    throw new Error(
      `FRAME_CDP_UNAVAILABLE: no isolated CDP context matched this frame; no main-frame fallback (${details})`,
    );
  } finally {
    await execute(
      contents,
      entry,
      `(() => { document.documentElement?.removeAttribute(${JSON.stringify(attribute)}); return true; })()`,
    ).catch(() => {});
    for (const sessionId of [undefined, ...probedSessions])
      await command(
        "Runtime.releaseObjectGroup",
        { objectGroup },
        sessionId,
      ).catch(() => {});
  }
};
/** Resolve an opaque frameId to the CDP frame id of its exact document, for page-level
 * record queries (console/network) that filter by frame. Uses the same document probe as
 * frame operations; an unmatched frame fails instead of falling back to the main frame. */
export const resolveFrameCdpId = async (
  contents: WebContents,
  frameId: unknown,
): Promise<string> => {
  const entry = await selectFrame(contents, frameId);
  return withCdpFrame(contents, entry, async (target) => target.frameId);
};
const elementHandle = async (
  contents: WebContents,
  entry: FrameEntry,
  target: CdpFrame,
  args: Args,
): Promise<string> => {
  const send = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> => frameCommand(contents, method, params, target.sessionId);
  if (typeof args.ref === "string") {
    const backend = entry.refs.get(args.ref);
    if (backend === undefined)
      throw new Error(
        "FRAME_REF_STALE: ref belongs to another frame/document/snapshot; capture AX again",
      );
    const resolved = await send("DOM.resolveNode", {
      backendNodeId: backend,
      executionContextId: target.contextId,
    });
    if (!resolved.object?.objectId)
      throw new Error("FRAME_REF_STALE: element no longer exists");
    const membership = await send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration:
        "function() { return this.ownerDocument === document && this.isConnected; }",
      returnByValue: true,
    });
    if (membership.result?.value !== true)
      throw new Error(
        "FRAME_REF_STALE: element is outside the selected document",
      );
    return resolved.object.objectId;
  }
  const script = buildElementLocatorScript(
    typeof args.selector === "string" ? args.selector : null,
    typeof args.text === "string" ? args.text : null,
    args.exact === true,
    "return element;",
  );
  const result = await send("Runtime.evaluate", {
    expression: script,
    contextId: target.contextId,
    awaitPromise: true,
    returnByValue: false,
  });
  if (result.exceptionDetails || !result.result?.objectId)
    throw new Error("Frame target element was not found or is not actionable");
  return result.result.objectId;
};
const withElement = async <T>(
  contents: WebContents,
  entry: FrameEntry,
  args: Args,
  action: (target: CdpFrame, objectId: string) => Promise<T>,
): Promise<T> =>
  withCdpFrame(contents, entry, async (target) => {
    const objectId = await elementHandle(contents, entry, target, args);
    try {
      const prepared = (await frameCommand(
        contents,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
        if (!this.isConnected || this.ownerDocument !== document || !(this instanceof Element) || this.matches(':disabled,[aria-disabled="true"]')) throw new Error('Element is stale or disabled');
        this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return true;
      }`,
          returnByValue: true,
        },
        target.sessionId,
      )) as { exceptionDetails?: unknown };
      if (prepared.exceptionDetails)
        throw new Error("Frame target element is stale or disabled");
      await execute(contents, entry, "true");
      return await action(target, objectId);
    } finally {
      await frameCommand(
        contents,
        "Runtime.releaseObject",
        { objectId },
        target.sessionId,
      ).catch(() => {});
    }
  });

/** Translate frame-local coordinates through each parent document; reject unsupported transforms
 * rather than sending an approximate event to another element. No cross-origin DOM access is used. */
const rootPointerPoint = async (
  contents: WebContents,
  entry: FrameEntry,
  target: CdpFrame,
  objectId: string,
): Promise<{ x: number; y: number }> => {
  const local = (await frameCommand(
    contents,
    "Runtime.callFunctionOn",
    {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
      const style = getComputedStyle(this);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) throw new Error('Element is hidden');
      const rect = Array.from(this.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
      if (!rect) throw new Error('Element has no layout');
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (right <= left || bottom <= top) throw new Error('Element is outside the viewport');
      const x = (left + right) / 2, y = (top + bottom) / 2;
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot?.elementFromPoint) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
      let node = this;
      while (node && node !== hit && !node.contains(hit)) node = node.getRootNode()?.host;
      if (!node) throw new Error('Element is obscured');
      return { x, y };
    }`,
    },
    target.sessionId,
  )) as {
    result?: { value?: { x: number; y: number } };
    exceptionDetails?: unknown;
  };
  if (local.exceptionDetails || !local.result?.value)
    throw new Error(
      "Frame element is hidden, obscured or outside the viewport",
    );
  let point = local.result.value;
  let childFrame = entry.frame;
  let childProtocolId = target.frameId;
  while (childFrame.parent) {
    const parent = childFrame.parent;
    const parentEntry = await entryFor(contents, parent);
    const translated = await withCdpFrame(
      contents,
      parentEntry,
      async (parentTarget) => {
        const owner = (await frameCommand(
          contents,
          "DOM.getFrameOwner",
          { frameId: childProtocolId },
          parentTarget.sessionId,
        )) as { backendNodeId?: number };
        if (!owner.backendNodeId)
          throw new Error("FRAME_STALE: frame owner is unavailable");
        const resolved = (await frameCommand(
          contents,
          "DOM.resolveNode",
          {
            backendNodeId: owner.backendNodeId,
            executionContextId: parentTarget.contextId,
          },
          parentTarget.sessionId,
        )) as { object?: { objectId?: string } };
        const ownerId = resolved.object?.objectId;
        if (!ownerId)
          throw new Error("FRAME_STALE: frame owner is unavailable");
        try {
          const mapped = (await frameCommand(
            contents,
            "Runtime.callFunctionOn",
            {
              objectId: ownerId,
              returnByValue: true,
              functionDeclaration: `function(x, y) {
            if (!this.isConnected || this.ownerDocument !== document) throw new Error('Frame owner is stale');
            this.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            for (let node = this; node instanceof Element; node = node.parentElement || node.getRootNode().host) {
              const style = getComputedStyle(node);
              if (style.perspective !== 'none' || style.rotate !== 'none' || style.scale !== 'none') throw new Error('Perspective or individual rotate/scale transforms are unsupported');
              if (style.transform !== 'none') {
                const matrix = new DOMMatrixReadOnly(style.transform);
                if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) throw new Error('Rotated, skewed or mirrored frames are unsupported');
              }
            }
            const rect = this.getBoundingClientRect();
            if (!this.offsetWidth || !this.offsetHeight || rect.width <= 0 || rect.height <= 0) throw new Error('Frame is hidden');
            const style = getComputedStyle(this);
            const sx = rect.width / this.offsetWidth, sy = rect.height / this.offsetHeight;
            const px = rect.left + (this.clientLeft + parseFloat(style.paddingLeft) + x) * sx;
            const py = rect.top + (this.clientTop + parseFloat(style.paddingTop) + y) * sy;
            let hit = document.elementFromPoint(px, py);
            while (hit?.shadowRoot?.elementFromPoint) { const next = hit.shadowRoot.elementFromPoint(px, py); if (!next || next === hit) break; hit = next; }
            if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight || hit !== this) throw new Error('Frame is clipped or obscured');
            return { x: px, y: py };
          }`,
              arguments: [{ value: point.x }, { value: point.y }],
            },
            parentTarget.sessionId,
          )) as {
            result?: { value?: { x: number; y: number } };
            exceptionDetails?: unknown;
          };
          if (mapped.exceptionDetails || !mapped.result?.value)
            throw new Error(
              "Frame pointer mapping failed: hidden/obscured frame or unsupported rotation/skew/perspective",
            );
          return { point: mapped.result.value, frameId: parentTarget.frameId };
        } finally {
          await frameCommand(
            contents,
            "Runtime.releaseObject",
            { objectId: ownerId },
            parentTarget.sessionId,
          ).catch(() => {});
        }
      },
    );
    point = translated.point;
    childProtocolId = translated.frameId;
    childFrame = parent;
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error("Invalid frame pointer coordinates");
  await execute(contents, entry, "true");
  return point;
};

/** drag 端点定位：定位元素 → 就绪检查 → 映射到 root 视口坐标并附元素描述。 */
const dragElementPoint = async (
  contents: WebContents,
  entry: FrameEntry,
  args: Args,
  prefix: "from" | "to",
): Promise<{ x: number; y: number; element: unknown }> =>
  withCdpFrame(contents, entry, async (target) => {
    const locator: Args = {
      selector: args[`${prefix}Selector`],
      text: args[`${prefix}Text`],
      ref: args[`${prefix}Ref`],
      exact: args[`${prefix}Exact`] === true,
    };
    const objectId = await elementHandle(contents, entry, target, locator);
    try {
      const prepared = (await frameCommand(
        contents,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
        if (!this.isConnected || this.ownerDocument !== document || !(this instanceof Element) || this.matches(':disabled,[aria-disabled="true"]')) throw new Error('Element is stale or disabled');
        this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return true;
      }`,
          returnByValue: true,
        },
        target.sessionId,
      )) as { exceptionDetails?: unknown };
      if (prepared.exceptionDetails)
        throw new Error("Drag target element is stale or disabled");
      const point = await rootPointerPoint(contents, entry, target, objectId);
      const described = (await frameCommand(
        contents,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
        return {
          tagName: this.tagName ? this.tagName.toLowerCase() : '',
          id: this.id || null,
          text: (this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        };
      }`,
          returnByValue: true,
        },
        target.sessionId,
      )) as { result?: { value?: unknown } };
      return { ...point, element: described.result?.value ?? null };
    } finally {
      await frameCommand(
        contents,
        "Runtime.releaseObject",
        { objectId },
        target.sessionId,
      ).catch(() => {});
    }
  });

type FrameKeyStroke = {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  text?: string;
};

const FRAME_MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const FRAME_NAMED_KEYS: Record<string, FrameKeyStroke> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
};
for (let index = 1; index <= 12; index++) {
  FRAME_NAMED_KEYS[`F${index}`] = {
    key: `F${index}`,
    code: `F${index}`,
    windowsVirtualKeyCode: 111 + index,
  };
}

const normalizeFrameModifier = (value: string): string => {
  switch (value.toLowerCase()) {
    case "ctrl":
    case "control":
      return "Control";
    case "shift":
      return "Shift";
    case "alt":
    case "option":
      return "Alt";
    case "meta":
    case "cmd":
    case "command":
      return "Meta";
    default:
      return value;
  }
};

const frameKeyStroke = (value: string): FrameKeyStroke => {
  const named = FRAME_NAMED_KEYS[value];
  if (named) return named;
  if (value.length !== 1)
    throw new Error(`Unsupported key for frame press_key: ${value}`);
  const upper = value.toUpperCase();
  if (/^[A-Z]$/.test(upper)) {
    return {
      key: value,
      text: value,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  if (/^[0-9]$/.test(value)) {
    return {
      key: value,
      text: value,
      code: `Digit${value}`,
      windowsVirtualKeyCode: value.charCodeAt(0),
    };
  }
  return { key: value, text: value };
};

/** 向指定帧会话派发按键；命中已聚焦元素，不依赖 webview 主帧焦点。 */
const dispatchFrameKey = async (
  contents: WebContents,
  sessionId: string | undefined,
  key: string,
): Promise<void> => {
  const parts = key
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const mainKey = parts.pop();
  if (!mainKey) throw new Error("key must not be empty for browser-press_key");
  const send = (params: Record<string, unknown>): Promise<unknown> =>
    frameCommand(contents, "Input.dispatchKeyEvent", params, sessionId);
  const modifiers: { name: string; bit: number }[] = [];
  for (const part of parts) {
    const name = normalizeFrameModifier(part);
    const bit = FRAME_MODIFIER_BITS[name];
    if (bit === undefined)
      throw new Error(`Unsupported modifier for frame press_key: ${part}`);
    modifiers.push({ name, bit });
  }
  let active = 0;
  for (const { name, bit } of modifiers) {
    active |= bit;
    const stroke = frameKeyStroke(name);
    await send({
      type: "keyDown",
      key: stroke.key,
      ...(stroke.code ? { code: stroke.code } : {}),
      ...(stroke.windowsVirtualKeyCode !== undefined
        ? { windowsVirtualKeyCode: stroke.windowsVirtualKeyCode }
        : {}),
      modifiers: active,
    });
  }
  const stroke = frameKeyStroke(mainKey);
  const text =
    stroke.text !== undefined &&
    (active & FRAME_MODIFIER_BITS.Shift) !== 0 &&
    /^[a-z]$/.test(stroke.text)
      ? stroke.text.toUpperCase()
      : stroke.text;
  await send({
    type: text ? "keyDown" : "rawKeyDown",
    key: text && text !== stroke.text ? text : stroke.key,
    ...(stroke.code ? { code: stroke.code } : {}),
    ...(stroke.windowsVirtualKeyCode !== undefined
      ? { windowsVirtualKeyCode: stroke.windowsVirtualKeyCode }
      : {}),
    ...(text ? { text } : {}),
    modifiers: active,
  });
  await send({
    type: "keyUp",
    key: stroke.key,
    ...(stroke.code ? { code: stroke.code } : {}),
    ...(stroke.windowsVirtualKeyCode !== undefined
      ? { windowsVirtualKeyCode: stroke.windowsVirtualKeyCode }
      : {}),
    modifiers: active,
  });
  for (const { name, bit } of [...modifiers].reverse()) {
    active &= ~bit;
    const modifierStroke = frameKeyStroke(name);
    await send({
      type: "keyUp",
      key: modifierStroke.key,
      ...(modifierStroke.code ? { code: modifierStroke.code } : {}),
      ...(modifierStroke.windowsVirtualKeyCode !== undefined
        ? { windowsVirtualKeyCode: modifierStroke.windowsVirtualKeyCode }
        : {}),
      modifiers: active,
    });
  }
};

const perform = async (
  contents: WebContents,
  entry: FrameEntry,
  operation: string,
  args: Args,
): Promise<unknown> => {
  const urlRedaction = describeBrowserUrlRedaction(entry.frame.url);
  const metadata = {
    frameId: entry.id,
    url: redactBrowserUrl(entry.frame.url),
    title: await execute(contents, entry, "String(document.title || '')"),
    // URL 脱敏隐藏了 query/hash，必须标注，避免被误判为地址栏未更新。
    ...(urlRedaction ? { urlRedaction } : {}),
  };
  if (operation === "evaluate") {
    const format =
      args.format === "function" || typeof args.function === "string"
        ? "function"
        : "script";
    let source: string;
    if (typeof args.sourcePath === "string" && args.sourcePath.trim()) {
      source = await readFile(args.sourcePath, "utf8");
    } else if (typeof args.expression === "string" && args.expression.trim()) {
      source = args.expression;
    } else if (typeof args.function === "string" && args.function.trim()) {
      source = args.function;
    } else {
      throw new Error("expression, function, or sourcePath is required");
    }
    if (
      /cookie|localStorage|sessionStorage|indexedDB|authorization|password|secret|token/i.test(
        source,
      )
    )
      throw new Error(
        "Credential/storage access is not allowed in frame evaluation",
      );
    if (format === "function") {
      const callArgs = Array.isArray(args.args) ? args.args : [];
      source = `(${source})\n.apply(undefined, ${JSON.stringify(callArgs)})`;
    }
    if (args.waitForStableDom !== false) {
      await execute(
        contents,
        entry,
        `new Promise((resolve) => {
        let timer;
        let observer;
        const settle = () => { if (timer) clearTimeout(timer); if (observer) observer.disconnect(); resolve(true); };
        observer = new MutationObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(settle, 80); });
        timer = setTimeout(settle, 80);
        try { observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true }); } catch {}
        setTimeout(settle, 1000);
      })`,
      );
    }
    // Preserve JavaScript Script completion semantics (including declarations and semicolons).
    // Internal expression probes still use execute; user scripts must not be wrapped in parentheses.
    await execute(contents, entry, "true");
    const resultValue = await rawExecute(entry.frame, source);
    await execute(contents, entry, "true");
    if (typeof args.filePath === "string" && args.filePath.trim()) {
      const text = JSON.stringify(resultValue, null, 2) ?? "undefined";
      await mkdir(dirname(args.filePath), { recursive: true });
      await writeFile(args.filePath, text, "utf8");
      return {
        ...metadata,
        savedTo: args.filePath,
        bytes: Buffer.byteLength(text, "utf8"),
      };
    }
    return {
      ...metadata,
      result: resultValue,
    };
  }
  if (operation === "get_tab_content") {
    const maxLength = bounded(args, "maxLength", 20000, 1000, 100000);
    const result = await execute(
      contents,
      entry,
      buildTabContentScript(
        maxLength,
        args.includeTimes !== false,
        Math.min(4000, maxLength),
      ),
    );
    return { ...metadata, ...(result as object) };
  }
  if (
    operation === "devtools" &&
    (args.action === undefined || args.action === "snapshot")
  ) {
    const maxLength = bounded(args, "maxContentLength", 20000, 1000, 100000);
    const result = await execute(
      contents,
      entry,
      `(() => ({ title: document.title, content: String(document.body?.innerText || '').slice(0, ${maxLength}) }))()`,
    );
    return { ...metadata, ...(result as object) };
  }
  if (operation === "wait") {
    const conditions = ["text", "textGone", "selector", "selectorGone"].filter(
      (key) => typeof args[key] === "string" && args[key],
    );
    const fixed = args.time !== undefined && args.time !== null;
    if ((fixed && conditions.length) || (!fixed && !conditions.length))
      throw new Error(
        "wait requires time or text/selector conditions, not both",
      );
    const timeout = fixed
      ? bounded(args, "time", 100, 100, 30000)
      : bounded(args, "timeoutMs", 30000, 1000, 120000);
    const start = Date.now();
    while (true) {
      const satisfied = await execute(
        contents,
        entry,
        `(() => { const args = ${JSON.stringify(args)};
        const text = String(document.body?.innerText || '');
        return ${JSON.stringify(conditions)}.every(key => key === 'text' ? text.includes(args[key]) : key === 'textGone' ? !text.includes(args[key]) : key === 'selector' ? !!document.querySelector(args[key]) : !document.querySelector(args[key]));
      })()`,
      );
      if ((!fixed && satisfied) || (fixed && Date.now() - start >= timeout))
        return {
          ...metadata,
          success: true,
          status: fixed ? "elapsed" : "satisfied",
          waitedMs: Date.now() - start,
        };
      if (Date.now() - start >= timeout)
        return {
          ...metadata,
          success: false,
          status: "timed-out",
          error: "Frame wait timed out",
          waitedMs: Date.now() - start,
          note: "The condition was not met within the timeout. This is not proof that the preceding action failed; verify the page state (browser-devtools snapshot or browser-get_tab_content) before repeating a side-effecting action.",
        };
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, timeout - (Date.now() - start))),
      );
    }
  }
  if (operation === "observe") {
    const rawExpect = args.expect;
    const expect =
      rawExpect !== null &&
      typeof rawExpect === "object" &&
      !Array.isArray(rawExpect)
        ? (rawExpect as Record<string, unknown>)
        : {};
    const readExpect = (field: string): string | undefined => {
      const value = expect[field];
      return typeof value === "string" && value.trim()
        ? value.trim()
        : undefined;
    };
    const conditions = {
      urlIncludes: readExpect("urlIncludes"),
      selector: readExpect("selector"),
      text: readExpect("text"),
    };
    const sampleText = args.sampleText === true;
    const maxChars = bounded(args, "maxChars", 4000, 100, 20000);
    return withCdpFrame(contents, entry, async (target) => {
      // 条件值只作为 JSON 字面量进入脚本；不拼接调用方提供的代码。
      const evaluated = (await frameCommand(
        contents,
        "Runtime.evaluate",
        {
          contextId: target.contextId,
          expression: `(() => {
        const conditions = ${JSON.stringify(conditions)};
        const bodyText = String(document.body ? document.body.innerText : '');
        const checks = {};
        if (conditions.urlIncludes !== undefined) checks.urlIncludes = String(location.href).includes(conditions.urlIncludes);
        if (conditions.selector !== undefined) { try { checks.selector = !!document.querySelector(conditions.selector); } catch (error) { checks.selector = false; } }
        if (conditions.text !== undefined) checks.text = bodyText.includes(conditions.text);
        const values = Object.keys(checks).map((key) => checks[key]);
        return {
          url: location.href,
          title: String(document.title || ''),
          matches: values.length > 0 && values.every(Boolean),
          ...(${JSON.stringify(sampleText)} ? { text: bodyText.replace(/[ \\t]+\\n/g, '\\n').trim().slice(0, ${maxChars}) } : {}),
        };
      })()`,
          returnByValue: true,
        },
        target.sessionId,
      )) as {
        result?: { value?: Record<string, unknown> };
        exceptionDetails?: unknown;
      };
      const value = evaluated.result?.value;
      if (
        evaluated.exceptionDetails ||
        !value ||
        typeof value.url !== "string" ||
        typeof value.matches !== "boolean"
      )
        throw new Error("Frame observation failed");
      return { ...metadata, ...value };
    });
  }
  if (operation === "devtools") {
    if (args.action !== "ax")
      throw new Error("frameId is supported only for devtools snapshot/ax");
    return withCdpFrame(contents, entry, async (target) => {
      const result = (await frameCommand(
        contents,
        "Accessibility.getFullAXTree",
        { frameId: target.frameId },
        target.sessionId,
      )) as { nodes?: AxNode[] };
      entry.refs.clear();
      const snapshot = serializeAxTree(result.nodes ?? [], {
        verbose: args.verbose === true,
        maxNodes: bounded(args, "maxNodes", 200, 1, 1000),
        redactValues: true,
        refForNode: (node) => {
          if (
            !node.backendDOMNodeId ||
            (node.frameId && node.frameId !== target.frameId)
          )
            return null;
          const ref = `fr-${randomUUID()}`;
          entry.refs.set(ref, node.backendDOMNodeId);
          return ref;
        },
      });
      return { ...metadata, ...snapshot, valuesRedacted: true };
    });
  }
  if (operation === "press_key") {
    const key = args.key;
    if (typeof key !== "string" || !key.trim())
      throw new Error("key must not be empty for browser-press_key");
    return withCdpFrame(contents, entry, async (target) => {
      contents.focus();
      await dispatchFrameKey(contents, target.sessionId, key);
      return { ...metadata, success: true, key };
    });
  }
  if (operation === "scroll") {
    const position =
      args.position === "top" || args.position === "bottom"
        ? args.position
        : null;
    const deltaY =
      position === null && typeof args.deltaY === "number" ? args.deltaY : null;
    if (position === null && deltaY === null)
      throw new Error(
        "Either deltaY or position is required for browser-scroll",
      );
    const hasTarget =
      (typeof args.selector === "string" && args.selector.length > 0) ||
      typeof args.ref === "string";
    return withCdpFrame(contents, entry, async (target) => {
      let result: unknown;
      if (hasTarget) {
        const objectId = await elementHandle(contents, entry, target, args);
        try {
          const called = (await frameCommand(
            contents,
            "Runtime.callFunctionOn",
            {
              objectId,
              functionDeclaration: `function(deltaY, position) { return (${SCROLL_FUNCTION})(this, deltaY, position); }`,
              arguments: [{ value: deltaY }, { value: position }],
              awaitPromise: true,
              returnByValue: true,
            },
            target.sessionId,
          )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
          if (called.exceptionDetails)
            throw new Error(
              "Frame scroll failed: target is not scrollable or is stale",
            );
          result = called.result?.value;
        } finally {
          await frameCommand(
            contents,
            "Runtime.releaseObject",
            { objectId },
            target.sessionId,
          ).catch(() => {});
        }
      } else {
        const called = (await frameCommand(
          contents,
          "Runtime.evaluate",
          {
            contextId: target.contextId,
            expression: `(${SCROLL_FUNCTION})(null, ${JSON.stringify(deltaY)}, ${JSON.stringify(position)})`,
            awaitPromise: true,
            returnByValue: true,
          },
          target.sessionId,
        )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        if (called.exceptionDetails) throw new Error("Frame scroll failed");
        result = called.result?.value;
      }
      if (!result || typeof result !== "object")
        throw new Error("Browser scroll did not return a result");
      return {
        ...metadata,
        ...(position ? { position } : { deltaY }),
        ...(result as Record<string, unknown>),
      };
    });
  }
  if (operation === "get_css_styles") {
    const pageIdx = typeof args.pageIdx === "number" ? args.pageIdx : undefined;
    const pageSize =
      typeof args.pageSize === "number" ? args.pageSize : undefined;
    return withCdpFrame(contents, entry, async (target) => {
      const objectId = await elementHandle(contents, entry, target, args);
      try {
        const result = await getCssStyles(contents.id, {
          objectId,
          sessionId: target.sessionId,
          pageIdx,
          pageSize,
        });
        return { ...metadata, ...result };
      } finally {
        await frameCommand(
          contents,
          "Runtime.releaseObject",
          { objectId },
          target.sessionId,
        ).catch(() => {});
      }
    });
  }
  if (operation === "audit") {
    const selected = Array.isArray(args.categories)
      ? args.categories.filter(
          (item): item is AuditCategories =>
            item === "accessibility" ||
            item === "seo" ||
            item === "best-practices",
        )
      : [];
    const categories: AuditCategories[] =
      selected.length > 0
        ? selected
        : ["accessibility", "seo", "best-practices"];
    return withCdpFrame(contents, entry, async (target) => {
      // 审计必须使用被扫描文档自身的 URL/标题，避免元数据与帧文档导航错位。
      const scope = (await frameCommand(
        contents,
        "Runtime.evaluate",
        {
          contextId: target.contextId,
          expression: `({ url: location.href, title: String(document.title || '') })`,
          returnByValue: true,
        },
        target.sessionId,
      )) as {
        result?: { value?: { url?: unknown; title?: unknown } };
        exceptionDetails?: unknown;
      };
      const documentInfo = scope.result?.value;
      if (
        scope.exceptionDetails ||
        typeof documentInfo?.url !== "string" ||
        typeof documentInfo?.title !== "string"
      )
        throw new Error("Audit document context is unavailable");
      const result = await runBrowserAudit(contents.id, categories, {
        sessionId: target.sessionId,
        contextId: target.contextId,
        cdpFrameId: target.frameId,
        url: documentInfo.url,
        title: documentInfo.title,
      });
      return { ...metadata, ...result };
    });
  }
  if (operation === "drag") {
    const fromEntry = await selectFrame(contents, args.fromFrameId);
    const toEntry = await selectFrame(contents, args.toFrameId);
    const from = await dragElementPoint(contents, fromEntry, args, "from");
    const to = await dragElementPoint(contents, toEntry, args, "to");
    await frameCdpDeadline("ensureWebContentsDebugger", () =>
      ensureWebContentsDebugger(contents),
    );
    if (!contents.debugger.isAttached())
      throw new Error("FRAME_CDP_UNAVAILABLE: close page DevTools and retry");
    contents.focus();
    const send = (params: Record<string, unknown>): Promise<unknown> =>
      frameCommand(contents, "Input.dispatchMouseEvent", params);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(8, Math.min(24, Math.round(distance / 16)));
    await send({ type: "mouseMoved", x: from.x, y: from.y, buttons: 0 });
    await send({
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= steps; step++) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      await send({ type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    await send({
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return {
      ...metadata,
      success: true,
      from: from.element,
      to: to.element,
    };
  }
  if (operation === "fill_form") {
    const elements = Array.isArray(args.elements) ? args.elements : [];
    if (elements.length === 0)
      throw new Error("elements must be a non-empty array");
    const results: { index: number; ok: boolean; error?: string }[] = [];
    let successCount = 0;
    for (const [index, item] of elements.entries()) {
      const itemArgs =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as Args)
          : {};
      try {
        await perform(contents, entry, "type", itemArgs);
        results.push({ index, ok: true });
        successCount += 1;
      } catch (error) {
        results.push({
          index,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ...metadata,
      results,
      successCount,
      failureCount: results.length - successCount,
    };
  }
  return withElement(contents, entry, args, async (target, objectId) => {
    const send = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<any> => frameCommand(contents, method, params, target.sessionId);
    const locate = async (body: string): Promise<unknown> => {
      await execute(contents, entry, "true");
      const result = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `async function() { const element = this; if (!element.isConnected || element.ownerDocument !== document) throw new Error('Element is stale'); ${body} }`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          "Frame element operation failed: target is stale or does not support this action",
        );
      return result.result?.value;
    };
    if (operation === "upload-file") {
      if (
        !Array.isArray(args.files) ||
        !args.files.length ||
        args.files.some((file) => typeof file !== "string" || !isAbsolute(file))
      )
        throw new Error("files must be non-empty absolute paths");
      for (const file of args.files as string[])
        if (!(await stat(file)).isFile())
          throw new Error("Upload path is not a regular file");
      await locate(
        `if (element.tagName !== 'INPUT' || element.type !== 'file') throw new Error('Target is not a file input'); if (${args.files.length} > 1 && !element.multiple) throw new Error('File input does not accept multiple files'); return true;`,
      );
      await send("DOM.setFileInputFiles", { objectId, files: args.files });
      return { ...metadata, success: true, fileCount: args.files.length };
    }
    if (operation === "click" || operation === "hover") {
      const { x, y } = await rootPointerPoint(
        contents,
        entry,
        target,
        objectId,
      );
      contents.focus();
      const pointer = (params: Record<string, unknown>): Promise<unknown> =>
        frameCommand(contents, "Input.dispatchMouseEvent", params);
      await pointer({ type: "mouseMoved", x, y });
      if (operation === "click") {
        await pointer({
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await pointer({
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        if (args.dblClick === true) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          await pointer({
            type: "mousePressed",
            x,
            y,
            button: "left",
            clickCount: 2,
          });
          await pointer({
            type: "mouseReleased",
            x,
            y,
            button: "left",
            clickCount: 2,
          });
        }
      }
      return { ...metadata, success: true };
    }
    if (operation === "select_option") {
      if (
        !Array.isArray(args.values) ||
        !args.values.length ||
        args.values.some((value) => typeof value !== "string")
      )
        throw new Error("values must be a non-empty string array");
      const selected =
        await locate(`if (element.tagName !== 'SELECT') throw new Error('Target is not a select');
        const values = ${JSON.stringify(args.values)};
        if (!element.multiple && values.length > 1) throw new Error('Target is not a multiple select');
        const options = values.map(value => Array.from(element.options).find(option => option.value === value || option.label === value));
        if (options.some(option => !option || option.disabled)) throw new Error('Option is unavailable');
        for (const option of element.options) option.selected = options.includes(option);
        element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(element.selectedOptions).map(option => option.value);`);
      return { ...metadata, success: true, selected };
    }
    if (operation === "type") {
      if (typeof args.value !== "string")
        throw new Error("value must be a string");
      const delay = bounded(args, "delayMs", 0, 0, 1000);
      const submitForm = async (): Promise<void> => {
        if (args.submit === true) {
          await locate(
            "if (element.form) element.form.requestSubmit(); return true;",
          );
        }
      };
      contents.focus();
      const mode = await locate(`const tag = element.tagName;
        if (tag === 'SELECT') return 'select';
        if (tag === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) return 'choice';
        if (!element.isContentEditable && !(tag === 'INPUT' || tag === 'TEXTAREA')) throw new Error('Target is not editable');
        if (element.readOnly) throw new Error('Target is readonly');
        return 'text';`);
      if (mode === "choice") {
        const checked =
          args.value === "true" ||
          args.value === "1" ||
          args.value === "checked";
        const applied = await locate(`const desired = ${checked};
          const isRadio = element.type === 'radio';
          if (isRadio && !desired && element.checked) {
            element.checked = false;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (element.checked !== desired) {
            element.click();
            if (element.checked !== desired) {
              element.checked = desired;
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          return element.checked;`);
        if (applied !== checked)
          throw new Error(
            "Frame control did not apply the requested checked state",
          );
        await submitForm();
        return {
          ...metadata,
          success: true,
          mode: "choice",
          checked: applied === true,
        };
      }
      if (mode === "select") {
        const selected =
          await locate(`const wanted = ${JSON.stringify(args.value)};
          const option = Array.from(element.options).find((candidate) => candidate.value === wanted || candidate.label === wanted);
          if (!option) throw new Error('No option matches the provided value: ' + wanted);
          if (option.disabled) throw new Error('Option is disabled: ' + wanted);
          if (!element.multiple) for (const item of element.options) item.selected = false;
          option.selected = true;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          if (!option.selected) throw new Error('Frame select did not apply the requested option');
          return Array.from(element.selectedOptions).map((item) => item.value);`);
        await submitForm();
        return { ...metadata, success: true, mode: "select", selected };
      }
      if (delay === 0) {
        const applied =
          await locate(`const value = ${JSON.stringify(args.value)};
          element.focus();
          if (element.isContentEditable) {
            element.textContent = value;
          } else {
            const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (!setter) throw new Error('Target does not support text values');
            setter.call(element, value);
          }
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return element.isContentEditable ? element.textContent : element.value;`);
        if (applied !== args.value)
          throw new Error("Frame input did not apply the requested value");
        await submitForm();
        return { ...metadata, success: true };
      }
      await locate(`element.focus();
        if (element.isContentEditable) {
          element.textContent = '';
          const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        } else {
          const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, '');
        }
        element.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
      const values = delay ? [...args.value] : [args.value];
      if (delay && values.length * delay > 120000)
        throw new Error("Frame typing would exceed the operation timeout");
      for (const text of values) {
        await locate(
          "const root = element.getRootNode(); if (root.activeElement !== element && !element.contains(root.activeElement)) throw new Error('Target lost focus'); return true;",
        );
        if (delay) {
          await frameCommand(contents, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: text,
            text,
          });
          await frameCommand(contents, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: text,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          await frameCommand(contents, "Input.insertText", { text });
        }
      }
      const applied = await locate(
        "element.dispatchEvent(new Event('change', { bubbles: true })); return element.isContentEditable ? element.textContent : element.value;",
      );
      if (applied !== args.value)
        throw new Error("Frame input did not apply the requested value");
      await submitForm();
      return { ...metadata, success: true };
    }
    throw new Error("Unsupported frame operation");
  });
};
export const registerBrowserFrameHandlers = (): void => {
  ipcMain.handle(
    "browser:frame-operation",
    async (
      event,
      webContentsId: unknown,
      operation: unknown,
      args: unknown,
    ) => {
      try {
        if (
          typeof webContentsId !== "number" ||
          typeof operation !== "string" ||
          !frameOperations.has(operation) ||
          !args ||
          typeof args !== "object" ||
          Array.isArray(args)
        )
          throw new Error("Invalid frame operation arguments");
        const contents = getBrowserWebContents(webContentsId);
        if (
          contents.hostWebContents?.id !== event.sender.id ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("Frame operation is not owned by this renderer");
        const state = stateFor(contents);
        const parameters = args as Args;
        const task = state.tail
          .catch(() => {})
          .then(async () => {
            if (operation === "frames") return enumerate(contents);
            const entry = await selectFrame(contents, parameters.frameId);
            return perform(contents, entry, operation, parameters);
          });
        state.tail = task.catch(() => {});
        return redactBrowserResult({
          instanceId: parameters.instanceId,
          ...((await task) as object),
        });
      } catch (error) {
        throw new Error(
          redactBrowserText(
            error instanceof Error
              ? error.message
              : typeof (error as { message?: unknown })?.message === "string"
                ? String((error as { message: string }).message)
                : "Frame operation failed",
          ),
        );
      }
    },
  );
};
