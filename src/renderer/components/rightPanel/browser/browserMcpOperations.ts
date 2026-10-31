import {
  buildElementLocatorScript,
  COLLECT_ROOTS_SCRIPT,
  DESCRIBE_ELEMENT_SCRIPT,
} from "../../../../shared/browserElementLocator";
import { SCROLL_FUNCTION } from "../../../../shared/browserScroll";
import {
  describeBrowserUrlRedaction,
  type BrowserUrlRedactionInfo,
} from "../../../../shared/browserRedaction";
import {
  parseObservationRequest,
  startActionObservation,
} from "./browserObservation";
import { resolveAxRef, snapshotAxTree, type AxNode } from "./browserAxSnapshot";
import type { BrowserMcpCommandArgs } from "./browserMcpController";
import {
  acquireCaptureRenderLease,
  withCaptureRenderMode,
  type CaptureRenderLease,
} from "./captureRenderMode";

const TEXT_PREVIEW_LENGTH = 160;

// 公共元素描述函数片段（normalize + describe）。定位脚本、fill 脚本与
// CDP callFunctionOn 复用。注意：const 在同一作用域重复声明会抛
// SyntaxError，因此每个脚本作用域只能注入一次。

// 路由 mock 规则(渲染进程侧累积,route 追加/覆盖,routeClear 清空;提交给主进程 Fetch 拦截)。
// 按实例隔离:每个浏览器实例维护自己的规则,实例卸载时由
// clearBrowserRouteRulesForInstance 清理,避免跨实例残留/误提交。
type BrowserRouteRule = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

const browserRouteRulesByInstance = new Map<string, BrowserRouteRule[]>();

/** 实例卸载时清理其累积的路由规则,防止残留规则影响其他实例。 */
export const clearBrowserRouteRulesForInstance = (instanceId: string): void => {
  browserRouteRulesByInstance.delete(instanceId);
};

/**
 * 每个浏览器实例（= 右侧面板一个浏览器 tab）最近一次主 Frame 导航状态。
 *
 * 主 Frame 导航失败后 Chromium 会停留在 chrome-error://chromewebdata/
 * 错误页，此时 capturePage 仍能返回全黑 PNG。Screenshot 等操作在捕获前
 * 检查该状态，失败时直接返回原导航错误，避免把错误页图片当作正常结果。
 * 状态以 instanceId 为 key 隔离，实例（tab）关闭时清理。
 */
type MainFrameNavigationState =
  | { status: "success"; url: string }
  | {
      status: "failed";
      url: string;
      errorCode?: number;
      errorDescription: string;
    };

const mainFrameNavigationStates = new Map<string, MainFrameNavigationState>();

/** 主 Frame 导航成功（含页面内导航、重定向目标加载）后记录并清除失败状态。 */
export const recordMainFrameNavigationSuccess = (
  instanceId: string,
  url: string,
): void => {
  mainFrameNavigationStates.set(instanceId, { status: "success", url });
};

/** 主 Frame 导航失败时记录，供 screenshot 等操作拒绝执行。 */
export const recordMainFrameNavigationFailure = (
  instanceId: string,
  url: string,
  errorCode: number | undefined,
  errorDescription: string,
): void => {
  mainFrameNavigationStates.set(instanceId, {
    status: "failed",
    url,
    ...(errorCode !== undefined ? { errorCode } : {}),
    errorDescription,
  });
};

/** 实例（tab）关闭或卸载时清理对应状态，避免跨实例残留。 */
export const clearBrowserNavigationState = (instanceId: string): void => {
  mainFrameNavigationStates.delete(instanceId);
};

const getMainFrameNavigationState = (
  instanceId: string | undefined,
): MainFrameNavigationState | undefined =>
  instanceId ? mainFrameNavigationStates.get(instanceId) : undefined;

// Electron webview console-message level: 0=verbose, 1=info, 2=warning, 3=error.
const CONSOLE_LEVEL_MIN: Record<string, number> = {
  verbose: 0,
  info: 1,
  warning: 2,
  error: 3,
};

const requiredString = (args: BrowserMcpCommandArgs, field: string): string => {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

/**
 * 无障碍快照 ref → CDP 对象（issue #251）：先按标签页 + 文档代际查表，再确认
 * 节点仍属于快照时的主文档。backendNodeId 在跨进程导航后可能被新文档复用，
 * 只做查表会静默命中新页面上的另一个节点，因此文档归属校验不可省略。
 */
const resolveRefObject = async (
  webContentsId: number,
  instanceId: string,
  ref: string,
): Promise<{ objectId: string; backendNodeId: number }> => {
  const { backendNodeId, documentBackendId } = resolveAxRef(instanceId, ref);
  const staleError = (detail?: string): Error =>
    new Error(
      `Element for ref ${ref} no longer belongs to the current document (the page navigated, reloaded or re-rendered). Capture a new accessibility snapshot (browser-devtools action=ax).${detail ? ` (${detail})` : ""}`,
    );
  const resolveObject = async (backend: number): Promise<string> => {
    let resolved: { object?: { objectId?: string } } | undefined;
    try {
      resolved = (await window.snow.browserCdpCommand(
        webContentsId,
        "DOM.resolveNode",
        { backendNodeId: backend },
      )) as { object?: { objectId?: string } };
    } catch (error) {
      throw staleError(error instanceof Error ? error.message : String(error));
    }
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
      throw staleError();
    }
    return objectId;
  };
  const documentObjectId = await resolveObject(documentBackendId);
  const objectId = await resolveObject(backendNodeId);
  const membership = (await window.snow.browserCdpCommand(
    webContentsId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function(snapshotDocument) {
        return snapshotDocument === document &&
          this.isConnected &&
          this.getRootNode({ composed: true }) === snapshotDocument;
      }`,
      arguments: [{ objectId: documentObjectId }],
      returnByValue: true,
    },
  )) as { result?: { value?: unknown } };
  if (membership?.result?.value !== true) {
    throw staleError();
  }
  return { objectId, backendNodeId };
};

/**
 * 无障碍快照 ref 回指：resolveRefObject（含文档归属校验）→ callFunctionOn
 * 取元素中心坐标与可见性（页面上下文执行）。返回 objectId 供 type 复用。
 */
const resolveRefHandle = async (
  webContentsId: number,
  instanceId: string,
  ref: string,
): Promise<{
  objectId: string;
  info: {
    x: number;
    y: number;
    visible: boolean;
    tag: string;
    viewportW: number;
    viewportH: number;
  };
}> => {
  const { objectId } = await resolveRefObject(webContentsId, instanceId, ref);
  const called = (await window.snow.browserCdpCommand(
    webContentsId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function() {
        // 视口外元素自动滚入可视区（selector/text 定位路径已内置
        // scrollIntoView，这里对齐行为，避免 "outside the viewport" 误报）。
        try {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } catch {
          // 非布局元素（如 SVG 内部节点）可能不支持 scrollIntoView，忽略。
        }
        const r = this.getBoundingClientRect();
        const style = getComputedStyle(this);
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          visible: r.width > 0 && r.height > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none',
          tag: this.tagName ? this.tagName.toLowerCase() : '',
          viewportW: window.innerWidth,
          viewportH: window.innerHeight,
        };
      }`,
      returnByValue: true,
    },
  )) as {
    result?: {
      value?: {
        x?: number;
        y?: number;
        visible?: boolean;
        tag?: string;
        viewportW?: number;
        viewportH?: number;
      };
    };
  };
  const info = called?.result?.value;
  if (!info || !info.visible) {
    throw new Error(`Element for ref ${ref} is not visible on the page.`);
  }
  if (
    typeof info.x !== "number" ||
    typeof info.y !== "number" ||
    info.x < 0 ||
    info.y < 0 ||
    info.x >= (info.viewportW ?? 0) ||
    info.y >= (info.viewportH ?? 0)
  ) {
    throw new Error(
      `Element for ref ${ref} is outside the browser viewport; scroll to it first.`,
    );
  }
  return {
    objectId,
    info: {
      x: info.x,
      y: info.y,
      visible: true,
      tag: info.tag ?? "",
      viewportW: info.viewportW ?? 0,
      viewportH: info.viewportH ?? 0,
    },
  };
};

const requiredRawString = (
  args: BrowserMcpCommandArgs,
  field: string,
): string => {
  const value = args[field];
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
};

const optionalString = (
  args: BrowserMcpCommandArgs,
  field: string,
  emptyAsMissing = false,
): string | undefined => {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (emptyAsMissing && typeof value === "string" && !value.trim()) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string when provided`);
  }
  return value.trim();
};

/** Payload 复用非空校验，但不沿用结构字段的 trim；导航空白仍可视为缺省。 */
const optionalPayloadString = (
  args: BrowserMcpCommandArgs,
  field: string,
  emptyAsMissing = false,
): string | undefined => {
  const validated = optionalString(args, field, emptyAsMissing);
  return validated === undefined ? undefined : (args[field] as string);
};

const requiredPayloadString = (
  args: BrowserMcpCommandArgs,
  field: string,
): string => {
  requiredString(args, field);
  return args[field] as string;
};

type PageMetadata = {
  instanceId: string;
  url: string;
  title: string;
  /** 仅当该 URL 的 query/fragment 会被工具脱敏策略移除时出现。 */
  urlRedaction?: BrowserUrlRedactionInfo;
};

const currentPageMetadata = async (
  webview: Electron.WebviewTag,
  instanceId: string,
): Promise<PageMetadata> => {
  const url = webview.getURL();
  const redaction = describeBrowserUrlRedaction(url);
  return {
    instanceId,
    url,
    // JS dialog 会暂停页面脚本；metadata 必须使用原生 getter，避免阻塞响应入口。
    title: webview.getTitle(),
    ...(redaction ? { urlRedaction: redaction } : {}),
  };
};

/**
 * network 列表默认精简（issue #237）：只回传「定位哪条请求值得看」所需的
 * 决策字段；请求/响应头与请求体不再随列表展开，改按 id 查询详情。
 * requestId 仅 CDP 记录存在，webrequest 回退记录不会带该字段。
 */
const NETWORK_LIST_FIELDS = [
  "id",
  "requestId",
  "cdpFrameId",
  "method",
  "url",
  "status",
  "resourceType",
  "durationMs",
  "source",
  "mimeType",
  "fromCache",
  "error",
] as const;

const toCompactNetworkRecord = (
  record: unknown,
): Record<string, unknown> | null => {
  if (record === null || typeof record !== "object") {
    return null;
  }
  const source = record as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const field of NETWORK_LIST_FIELDS) {
    if (source[field] !== undefined) {
      compact[field] = source[field];
    }
  }
  return compact;
};

/**
 * 统一动作回执（issue #236）：
 * - success 仅代表输入事件已派发，不再暗示站点已处理；
 * - before 保存动作前页面元信息，顶层 url/title 表示动作后的当前状态；
 * - observation 为有界观察结果；observe=none 时明确标注未观察。
 */
const actionReceipt = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  const request = parseObservationRequest(args);
  const before = await currentPageMetadata(webview, instanceId);
  const frameId =
    typeof args.frameId === "string" && args.frameId ? args.frameId : undefined;
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof startActionObservation>> | null = null;
  if (request) {
    try {
      handle = await startActionObservation(
        webview,
        request,
        getConsoleMessages,
        startedAt,
        frameId,
      );
    } catch {
      // 探针不可用时退化为「派发回执」，不影响动作本身。
      handle = null;
    }
  }
  try {
    const payload = await run();
    const observation = handle ? await handle.stop() : null;
    const current = await currentPageMetadata(webview, instanceId);
    return {
      ...payload,
      ...current,
      success: true,
      dispatched: true,
      before: { url: before.url, title: before.title },
      observation: observation ?? { mode: "none" },
    };
  } catch (error) {
    // 动作失败也要结束观察，避免页面残留观察器。
    if (handle) {
      await handle.cancel().catch(() => undefined);
    }
    throw error;
  }
};

/** 等待一次加载完成（did-stop-loading）；trigger 触发导航/重载。 */
const waitForLoad = (
  webview: Electron.WebviewTag,
  timeoutMs: number,
  trigger: () => void | Promise<unknown>,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let sawSuccessfulNavigation = false;
    const handleNavigate = (): void => {
      sawSuccessfulNavigation = true;
    };
    const handleStop = (): void => {
      cleanup();
      resolve();
    };
    const handleFail = (
      event: Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      },
    ): void => {
      if (event.isMainFrame === false) {
        return;
      }
      if (
        event.errorCode === -3 ||
        (event.errorCode === -2 && sawSuccessfulNavigation)
      ) {
        return;
      }
      cleanup();
      reject(
        new Error(
          event.errorDescription ||
            `Failed to load ${event.validatedURL || "the target page"}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Browser load timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      webview.removeEventListener(
        "did-navigate",
        handleNavigate as EventListener,
      );
      webview.removeEventListener(
        "did-navigate-in-page",
        handleNavigate as EventListener,
      );
      webview.removeEventListener(
        "did-stop-loading",
        handleStop as EventListener,
      );
      webview.removeEventListener("did-fail-load", handleFail as EventListener);
    };

    webview.addEventListener("did-navigate", handleNavigate as EventListener);
    webview.addEventListener(
      "did-navigate-in-page",
      handleNavigate as EventListener,
    );
    webview.addEventListener("did-stop-loading", handleStop as EventListener);
    webview.addEventListener("did-fail-load", handleFail as EventListener);
    try {
      const pending = trigger();
      if (
        pending &&
        typeof (pending as Promise<unknown>).catch === "function"
      ) {
        (pending as Promise<unknown>).catch((error: unknown) => {
          const code =
            error instanceof Error
              ? (error as Error & { code?: string }).code
              : undefined;
          if (code === "ERR_ABORTED" || code === "ERR_FAILED") {
            return;
          }
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

const waitForNavigation = (
  webview: Electron.WebviewTag,
  url: string,
  timeoutMs: number,
): Promise<void> => waitForLoad(webview, timeoutMs, () => webview.loadURL(url));

const waitForReload = (
  webview: Electron.WebviewTag,
  timeoutMs: number,
  ignoreCache: boolean,
): Promise<void> =>
  waitForLoad(webview, timeoutMs, () =>
    ignoreCache ? webview.reloadIgnoringCache() : webview.reload(),
  );

const navigate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const timeoutMs =
    typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
  const reload = args.reload === true;
  const ignoreCache = args.ignoreCache === true;
  // Blank optional navigation fields mean no script / no URL, not invalid input.
  const initScript = optionalPayloadString(args, "initScript", true);
  const url = optionalString(args, "url", true) ?? "";
  if (!reload && !url) {
    throw new Error("url is required unless reload=true for browser-navigate");
  }
  if (reload && url) {
    throw new Error(
      "url cannot be combined with reload=true for browser-navigate",
    );
  }
  const webContentsId = webview.getWebContentsId();
  let scriptId: string | null = null;
  if (initScript) {
    if (
      /cookie|localStorage|sessionStorage|indexedDB|authorization|password|secret|token/i.test(
        initScript,
      )
    ) {
      throw new Error("Credential/storage access is not allowed in initScript");
    }
    const added = (await window.snow.browserCdpCommand(
      webContentsId,
      "Page.addScriptToEvaluateOnNewDocument",
      { source: initScript },
    )) as { identifier?: string };
    scriptId = typeof added?.identifier === "string" ? added.identifier : null;
  }
  try {
    if (reload) {
      await waitForReload(webview, timeoutMs, ignoreCache);
    } else {
      await waitForNavigation(webview, url, timeoutMs);
    }
  } finally {
    if (scriptId) {
      await window.snow
        .browserCdpCommand(
          webContentsId,
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: scriptId },
        )
        .catch(() => {});
    }
  }
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
    reloaded: reload,
  };
};

/**
 * 三路定位（selector / text / ref）并执行 actionBody，返回元素中心坐标与描述。
 * ref 走无障碍树确定性定位；selector/text 走 DOM 定位脚本（含 shadowRoot 遍历）。
 */
const locateElementTarget = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  actionBody: string,
  exact = false,
): Promise<{
  x: number;
  y: number;
  width?: number;
  height?: number;
  element: unknown;
}> => {
  const selector = optionalPayloadString(args, "selector");
  const text = optionalPayloadString(args, "text");
  const ref = optionalString(args, "ref");
  if (ref) {
    const { info } = await resolveRefHandle(
      webview.getWebContentsId(),
      instanceId,
      ref,
    );
    return { x: info.x, y: info.y, element: { tagName: info.tag, ref } };
  }
  const locateScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    exact,
    actionBody,
  );
  return (await webview.executeJavaScript(locateScript)) as {
    x: number;
    y: number;
    width?: number;
    height?: number;
    element: unknown;
  };
};

const click = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> =>
  actionReceipt(webview, instanceId, args, getConsoleMessages, async () => {
    const x = typeof args.x === "number" ? args.x : null;
    const y = typeof args.y === "number" ? args.y : null;
    let target: { x: number; y: number; element: unknown };
    if (x !== null && y !== null) {
      target = { x: Math.round(x), y: Math.round(y), element: null };
    } else {
      target = await locateElementTarget(
        webview,
        instanceId,
        args,
        `const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      throw new Error('Clickable element is outside the browser viewport');
    }
    return {
      x,
      y,
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        href: element.href || null,
      },
    };`,
        args.exact === true,
      );
    }
    webview.focus();
    await webview.sendInputEvent({
      type: "mouseMove",
      x: target.x,
      y: target.y,
    });
    await webview.sendInputEvent({
      type: "mouseDown",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1,
    });
    // 按下与抬起之间留出真实点击间隔：部分站点（如必应搜索结果）在
    // mouseup 前有 JS 拦截逻辑，瞬时点击会被忽略。
    await new Promise((resolve) => setTimeout(resolve, 50));
    await webview.sendInputEvent({
      type: "mouseUp",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1,
    });
    if (args.dblClick === true) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await webview.sendInputEvent({
        type: "mouseDown",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 2,
      });
      await webview.sendInputEvent({
        type: "mouseUp",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 2,
      });
    }
    return { element: target.element };
  });

const evaluate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  window.snow.browserFrameOperation(webview.getWebContentsId(), "evaluate", {
    ...args,
    instanceId,
  });

/** 一次性设值逻辑（作用域内元素为 element）：原生 setter + input/change 事件
 * （React 受控组件兼容，与 Playwright fill 同原理）。定位脚本与 ref 回指共用。
 * 注意：本片段不再定义 describe —— selector/text 路径由定位脚本注入，
 * ref 路径由调用方在 functionDeclaration 中注入 DESCRIBE_ELEMENT_SCRIPT。 */
const buildFillBody = (
  value: string,
  submit: boolean,
): string => `const value = ${JSON.stringify(value)};
  if (element.matches('input[type="checkbox"], input[type="radio"]')) {
    const desired = value === 'true' || value === '1' || value === 'checked';
    const isRadio = element.type === 'radio';
    if (!(isRadio && !desired) && element.checked !== desired) {
      element.click();
      if (element.checked !== desired) {
        element.checked = desired;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  } else if (element.matches('select')) {
    const option = Array.from(element.options).find((candidate) => candidate.value === value || candidate.label === value);
    if (!option) {
      throw new Error('No option matches the provided value: ' + value);
    }
    if (option.disabled) {
      throw new Error('Option is disabled: ' + value);
    }
    if (!element.multiple) {
      for (const item of element.options) item.selected = false;
    }
    option.selected = true;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const editable = element.matches(
      'input:not([type="hidden"]), textarea, [contenteditable="true"], [contenteditable=""]'
    );
    if (!editable) {
      throw new Error('Target element is not editable (expected input, textarea, select, checkbox, radio, or contenteditable)');
    }
    if (element.readOnly) {
      throw new Error('Target element is readonly');
    }
    if (element.matches('[contenteditable="true"], [contenteditable=""]')) {
      element.textContent = value;
    } else {
      const proto = element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        element.value = value;
      }
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (${JSON.stringify(submit)}) {
    const form = element.closest('form');
    if (form) {
      form.requestSubmit();
    } else {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
  }
  element.focus();
  return {
    element: {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
    },
  };`;

/** 逐键输入的目标标记属性（issue #256）：焦点校验据此找回目标元素。 */
const TYPE_TARGET_MARKER = "data-snow-type-target";

type TypeTargetState = {
  status: "focused" | "lost" | "missing";
  /** 焦点不在目标上时，当前焦点元素的简述。 */
  active?: string;
  /** 输入结束后目标取值/文本是否包含本次输入（只回布尔，不回显取值）。 */
  valueContainsInput?: boolean;
};

/** 页面上下文片段：按标记在 document 与 open shadow root 中找回目标，定义 target。 */
const buildTypeTargetLookup = (token: string): string => `
  ${COLLECT_ROOTS_SCRIPT}
  const markerSelector = '[${TYPE_TARGET_MARKER}="' + ${JSON.stringify(token)} + '"]';
  let target = null;
  for (const root of roots) {
    target = root.querySelector(markerSelector);
    if (target) break;
  }`;

/**
 * 焦点校验脚本：深层 activeElement（穿透 shadow root）沿 parentNode/host 向上
 * 追溯到目标才算聚焦成功。focusFirst=true 时先聚焦并等两帧，让 focus 监听器
 * 与异步渲染的抢焦点行为在校验前发生。
 */
const buildTypeTargetCheckScript = (
  token: string,
  focusFirst: boolean,
  expectedText: string | null,
): string => `(async () => {
  ${buildTypeTargetLookup(token)}
  if (!target) return { status: 'missing' };
  if (${JSON.stringify(focusFirst)}) {
    target.focus();
    await new Promise((resolve) => {
      // 后台/隐藏 webview 可能不调度动画帧，超时兜底。
      const timer = setTimeout(resolve, 100);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }));
    });
  }
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  let within = false;
  for (let node = active; node; node = node.parentNode || node.host) {
    if (node === target) {
      within = true;
      break;
    }
  }
  const result = { status: within ? 'focused' : 'lost' };
  if (!within) {
    if (!active || active === document.body || active === document.documentElement) {
      result.active = 'the document body (no element focused)';
    } else {
      const tag = active.tagName ? active.tagName.toLowerCase() : 'unknown';
      const label = String(
        active.getAttribute('aria-label') ||
        active.getAttribute('placeholder') ||
        active.getAttribute('name') ||
        ''
      ).trim().slice(0, 60);
      result.active = tag + (active.id ? '#' + active.id : '') + (label ? ' "' + label + '"' : '');
    }
  }
  const expected = ${JSON.stringify(expectedText)};
  if (expected !== null) {
    const current = typeof target.value === 'string' ? target.value : (target.textContent || '');
    result.valueContainsInput = current.includes(expected);
  }
  return result;
})()`;

const describeTypeTargetFailure = (state: TypeTargetState): string =>
  state.status === "missing"
    ? "the target element was removed or replaced (the page re-rendered)"
    : `focus moved to ${state.active ?? "another element"}`;

/**
 * 逐键模式（issue #256）：真实键盘事件只会送达当前焦点元素，因此聚焦后先确认
 * 焦点确实在目标上，每个按键前再复查一次；焦点被抢或目标被替换时立即报错并
 * 停止输入，submit 的 Enter 也只在焦点仍在目标上时发送。
 */
const typeByKeys = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  value: string,
  submit: boolean,
  delayMs: number,
): Promise<Record<string, unknown>> => {
  const selector = optionalPayloadString(args, "selector");
  const text = optionalPayloadString(args, "text");
  const ref = optionalString(args, "ref");
  const webContentsId = webview.getWebContentsId();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let element: unknown;
  if (ref) {
    const { objectId } = await resolveRefHandle(webContentsId, instanceId, ref);
    const marked = (await window.snow.browserCdpCommand(
      webContentsId,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(marker, token) {
          this.setAttribute(marker, token);
          return {
            element: {
              tagName: this.tagName ? this.tagName.toLowerCase() : '',
              id: this.id || null,
              text: (this.innerText || this.textContent || '')
                .replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_PREVIEW_LENGTH}),
            },
          };
        }`,
        arguments: [{ value: TYPE_TARGET_MARKER }, { value: token }],
        returnByValue: true,
      },
    )) as { result?: { value?: { element?: unknown } } };
    element = marked?.result?.value?.element;
  } else {
    const markScript = buildElementLocatorScript(
      selector ?? null,
      text ?? null,
      false,
      `element.setAttribute(${JSON.stringify(TYPE_TARGET_MARKER)}, ${JSON.stringify(token)});
      return {
        element: {
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        },
      };`,
    );
    element = (
      (await webview.executeJavaScript(markScript)) as { element: unknown }
    ).element;
  }
  const check = async (
    focusFirst: boolean,
    expectedText: string | null = null,
  ): Promise<TypeTargetState> =>
    (await webview.executeJavaScript(
      buildTypeTargetCheckScript(token, focusFirst, expectedText),
    )) as TypeTargetState;
  try {
    // 先让 guest 获得输入焦点再聚焦目标：顺序反过来时，guest 获焦的瞬间
    // 页面可能把焦点交给其他元素。
    webview.focus();
    const initial = await check(true);
    if (initial.status !== "focused") {
      throw new Error(
        `Focus check failed before typing: ${describeTypeTargetFailure(initial)}. Nothing was typed. Re-observe the page (browser-devtools action=ax) and retry.`,
      );
    }
    const chars = Array.from(value);
    for (const [index, char] of chars.entries()) {
      if (index > 0) {
        const state = await check(false);
        if (state.status !== "focused") {
          throw new Error(
            `Focus was lost while typing: ${describeTypeTargetFailure(state)} after ${index} of ${chars.length} characters; the remaining characters were not sent. Re-observe the page before retrying (the target may already contain partial input).`,
          );
        }
      }
      await webview.sendInputEvent({ type: "keyDown", keyCode: char });
      await webview.sendInputEvent({ type: "char", keyCode: char });
      await webview.sendInputEvent({ type: "keyUp", keyCode: char });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const final = await check(false, value);
    if (submit) {
      if (final.status !== "focused") {
        throw new Error(
          `Focus was lost before submitting: ${describeTypeTargetFailure(final)}. All ${chars.length} characters were typed but Enter was not sent. Re-observe the page before retrying.`,
        );
      }
      await webview.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      await webview.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }
    return {
      mode: "keys",
      element,
      typedChars: chars.length,
      // 每个按键发送前都确认过焦点在目标上。
      focusVerified: true,
      focusRetained: final.status === "focused",
      ...(final.valueContainsInput !== undefined
        ? { valueContainsInput: final.valueContainsInput }
        : {}),
    };
  } finally {
    await webview
      .executeJavaScript(
        `(() => {${buildTypeTargetLookup(token)}
          if (target) target.removeAttribute(${JSON.stringify(TYPE_TARGET_MARKER)});
        })()`,
      )
      .catch(() => {});
  }
};

/** 输入/设值的实际派发逻辑（不含观察与回执）；fill_form 复用。 */
const typeInto = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<Record<string, unknown>> => {
  const selector = optionalPayloadString(args, "selector");
  const text = optionalPayloadString(args, "text");
  const ref = optionalString(args, "ref");
  const value = requiredRawString(args, "value");
  const submit = args.submit === true;
  const delayMs = typeof args.delayMs === "number" ? args.delayMs : 0;
  const webContentsId = webview.getWebContentsId();

  // 逐键模式：用真实键盘事件逐字符输入（触发表单校验），全程校验焦点。
  if (delayMs > 0) {
    return typeByKeys(webview, instanceId, args, value, submit, delayMs);
  }

  // 默认一次性设值模式。
  if (ref) {
    const { objectId } = await resolveRefHandle(webContentsId, instanceId, ref);
    const filled = (await window.snow.browserCdpCommand(
      webContentsId,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function() {
          const element = this;
          ${DESCRIBE_ELEMENT_SCRIPT}
          ${buildFillBody(value, submit)}
        }`,
        returnByValue: true,
      },
    )) as { result?: { value?: { element?: unknown } } };
    const result = filled?.result?.value;
    return {
      mode: "fill",
      value,
      element: result?.element,
    };
  }
  const fillScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    false,
    buildFillBody(value, submit),
  );
  const result = (await webview.executeJavaScript(fillScript)) as {
    element: unknown;
  };
  return {
    mode: "fill",
    value,
    element: result.element,
  };
};

const type = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> =>
  actionReceipt(webview, instanceId, args, getConsoleMessages, () =>
    typeInto(webview, instanceId, args),
  );

/** 批量填充表单：逐个元素复用 type 的填充逻辑，单项失败不中断，汇总结果。 */
const fillForm = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> =>
  actionReceipt(webview, instanceId, args, getConsoleMessages, async () => {
    const elements = Array.isArray(args.elements) ? args.elements : [];
    if (elements.length === 0) {
      throw new Error("elements must be a non-empty array");
    }
    const results: { index: number; ok: boolean; error?: string }[] = [];
    let successCount = 0;
    for (const [index, item] of elements.entries()) {
      const itemArgs =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as BrowserMcpCommandArgs)
          : {};
      try {
        await typeInto(webview, instanceId, itemArgs);
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
      results,
      successCount,
      failureCount: results.length - successCount,
    };
  });

/** 主进程直通操作：页面元数据 + 操作结果合并返回。 */
const passthrough = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  invoke: () => Promise<unknown>,
): Promise<unknown> => {
  const metadata = await currentPageMetadata(webview, instanceId);
  const result = await invoke();
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { ...metadata, ...(result as object) }
    : { ...metadata, result };
};

const readStringOrNull = (value: unknown): string | null | undefined =>
  typeof value === "string" ? value : value === null ? null : undefined;

const emulatePage = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserEmulate(webview.getWebContentsId(), {
      colorScheme:
        args.colorScheme === null
          ? "auto"
          : args.colorScheme === "dark" ||
              args.colorScheme === "light" ||
              args.colorScheme === "auto"
            ? args.colorScheme
            : undefined,
      cpuThrottlingRate:
        args.cpuThrottlingRate === null
          ? 1
          : typeof args.cpuThrottlingRate === "number"
            ? args.cpuThrottlingRate
            : undefined,
      extraHttpHeaders:
        args.extraHttpHeaders === null
          ? null
          : args.extraHttpHeaders !== undefined &&
              typeof args.extraHttpHeaders === "object" &&
              !Array.isArray(args.extraHttpHeaders)
            ? (args.extraHttpHeaders as Record<string, string>)
            : undefined,
      geolocation:
        args.geolocation === null
          ? null
          : args.geolocation !== undefined &&
              typeof args.geolocation === "object" &&
              !Array.isArray(args.geolocation) &&
              typeof (args.geolocation as { latitude?: unknown }).latitude ===
                "number" &&
              typeof (args.geolocation as { longitude?: unknown }).longitude ===
                "number"
            ? {
                latitude: (args.geolocation as { latitude: number }).latitude,
                longitude: (args.geolocation as { longitude: number })
                  .longitude,
                accuracy:
                  typeof (args.geolocation as { accuracy?: unknown })
                    .accuracy === "number"
                    ? (args.geolocation as { accuracy: number }).accuracy
                    : undefined,
              }
            : undefined,
      networkConditions: readStringOrNull(args.networkConditions),
      userAgent: readStringOrNull(args.userAgent),
      viewport: readStringOrNull(args.viewport),
    }),
  );

const resizePage = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserResizePage(
      webview.getWebContentsId(),
      typeof args.width === "number" ? args.width : 800,
      typeof args.height === "number" ? args.height : 600,
    ),
  );

const traceStart = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserTraceStart(
      webview.getWebContentsId(),
      Array.isArray(args.categories)
        ? args.categories.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined,
    ),
  );

const traceStop = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserTraceStop(webview.getWebContentsId(), {
      filePath: optionalString(args, "filePath"),
    }),
  );

const traceInsight = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserTraceInsight(
      webview.getWebContentsId(),
      requiredString(args, "insightId"),
    ),
  );

const cssStyles = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalPayloadString(args, "selector");
  const ref = optionalString(args, "ref");
  const backendNodeId = ref
    ? (await resolveRefObject(webview.getWebContentsId(), instanceId, ref))
        .backendNodeId
    : undefined;
  if (!selector && backendNodeId === undefined) {
    throw new Error(
      "Either selector or ref is required for browser-get_css_styles",
    );
  }
  return passthrough(webview, instanceId, () =>
    window.snow.browserCssStyles(webview.getWebContentsId(), {
      selector,
      backendNodeId,
      pageIdx: typeof args.pageIdx === "number" ? args.pageIdx : undefined,
      pageSize: typeof args.pageSize === "number" ? args.pageSize : undefined,
    }),
  );
};

const auditPage = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserAudit(
      webview.getWebContentsId(),
      Array.isArray(args.categories)
        ? args.categories.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined,
    ),
  );

const heapOperation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserHeap("take", {
      ...args,
      webContentsId: webview.getWebContentsId(),
    }),
  );

type RecordingRenderLease = {
  webContentsId: number;
  recordingId: string;
  render: CaptureRenderLease;
  cancelled: boolean;
  stopped: boolean;
};
const recordingRenderLeases = new Map<string, RecordingRenderLease>();
let unsubscribeRecordingStopped: (() => void) | undefined;

const releaseRecordingRenderLease = (
  instanceId: string,
  lease: RecordingRenderLease,
): void => {
  lease.render.release();
  if (recordingRenderLeases.get(instanceId) === lease)
    recordingRenderLeases.delete(instanceId);
  if (recordingRenderLeases.size === 0) {
    unsubscribeRecordingStopped?.();
    unsubscribeRecordingStopped = undefined;
  }
};

/** 卸载立即释放本 pane；带代际 id 停止，不能误停止随后启动的另一场录屏。 */
export const clearBrowserRecordingRenderLease = (instanceId: string): void => {
  const lease = recordingRenderLeases.get(instanceId);
  if (!lease) return;
  lease.cancelled = true;
  releaseRecordingRenderLease(instanceId, lease);
  void window.snow
    .browserScreencastStop(lease.webContentsId, lease.recordingId)
    .catch(() => {});
};

const screencastStart = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  if (recordingRenderLeases.has(instanceId))
    throw new Error(
      "A screencast is already starting or recording for this browser tab",
    );
  const lease: RecordingRenderLease = {
    webContentsId: webview.getWebContentsId(),
    recordingId: crypto.randomUUID(),
    render: acquireCaptureRenderLease(instanceId),
    cancelled: false,
    stopped: false,
  };
  recordingRenderLeases.set(instanceId, lease);
  try {
    const metadata = await currentPageMetadata(webview, instanceId);
    if (!unsubscribeRecordingStopped) {
      unsubscribeRecordingStopped = window.snow.onBrowserScreencastStopped(
        (event) => {
          for (const [id, active] of recordingRenderLeases) {
            if (
              active.webContentsId === event.webContentsId &&
              active.recordingId === event.recordingId
            ) {
              active.stopped = true;
              releaseRecordingRenderLease(id, active);
            }
          }
        },
      );
    }
    await lease.render.ready;
    if (lease.cancelled)
      throw new Error("Browser tab was closed before recording started");
    const result = await window.snow.browserScreencastStart(
      lease.webContentsId,
      {
        recordingId: lease.recordingId,
        filePath: optionalString(args, "filePath"),
        quality: typeof args.quality === "number" ? args.quality : undefined,
        maxWidth: typeof args.maxWidth === "number" ? args.maxWidth : undefined,
        maxFrames:
          typeof args.maxFrames === "number" ? args.maxFrames : undefined,
        maxDurationMs:
          typeof args.maxDurationMs === "number"
            ? args.maxDurationMs
            : undefined,
      },
    );
    if (lease.cancelled) {
      // 卸载可能早于主进程 session 创建；start 返回后再次按代际停止。
      await window.snow
        .browserScreencastStop(lease.webContentsId, lease.recordingId)
        .catch(() => {});
      throw new Error("Browser tab was closed while recording started");
    }
    if (!result.started) releaseRecordingRenderLease(instanceId, lease);
    return { ...metadata, ...result };
  } catch (error) {
    releaseRecordingRenderLease(instanceId, lease);
    throw error;
  }
};

const screencastStop = async (
  webview: Electron.WebviewTag,
  instanceId: string,
): Promise<unknown> => {
  const lease = recordingRenderLeases.get(instanceId);
  return passthrough(webview, instanceId, async () => {
    const result = await window.snow.browserScreencastStop(
      webview.getWebContentsId(),
      lease?.recordingId,
    );
    // IPC 成功返回时录屏已实际结束；通知可能尚在消息队列中。
    if (lease) {
      lease.stopped = true;
      releaseRecordingRenderLease(instanceId, lease);
    }
    return result;
  });
};

const PAGE_TOOL_REGISTRY_SNIPPET = `const registry = window.__snowPageTools;
  const entries = Array.isArray(registry) ? registry : registry && typeof registry === 'object' ? Object.values(registry) : [];`;

const listPageTools = async (
  webview: Electron.WebviewTag,
  instanceId: string,
): Promise<unknown> => {
  const tools = (await webview.executeJavaScript(`(() => {
    ${PAGE_TOOL_REGISTRY_SNIPPET}
    const out = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
      out.push({
        name: entry.name.trim(),
        description: typeof entry.description === 'string' ? entry.description.slice(0, 500) : '',
        parameters: entry.parameters && typeof entry.parameters === 'object' ? entry.parameters : null,
      });
    }
    return out;
  })()`)) as unknown[];
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    tools,
    total: tools.length,
    note: "Page tools are registered by the page via window.__snowPageTools (an array or record of { name, description?, parameters?, run(args) }).",
  };
};

const callPageTool = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const name = requiredString(args, "name");
  const params = args.params ?? null;
  const result = await webview.executeJavaScript(`(async () => {
    ${PAGE_TOOL_REGISTRY_SNIPPET}
    const target = entries.find((candidate) => candidate && typeof candidate === 'object' && typeof candidate.name === 'string' && candidate.name.trim() === ${JSON.stringify(name)});
    if (!target) throw new Error('Page tool not found: ' + ${JSON.stringify(name)});
    if (typeof target.run !== 'function') throw new Error('Page tool has no run() function');
    const value = await target.run(${JSON.stringify(params)});
    if (value !== undefined) {
      try { JSON.stringify(value); } catch { throw new Error('Page tool returned a non-serializable value'); }
    }
    return value === undefined ? null : value;
  })()`);
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    result,
  };
};

const UPLOAD_MARKER = "data-snow-upload";

const uploadFile = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const files = Array.isArray(args.files)
    ? args.files.filter((item): item is string => typeof item === "string")
    : [];
  if (files.length === 0) {
    throw new Error("files must be a non-empty string array");
  }
  const webContentsId = webview.getWebContentsId();
  const ref = optionalString(args, "ref");

  if (ref) {
    const { backendNodeId } = await resolveRefObject(
      webContentsId,
      instanceId,
      ref,
    );
    await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.setFileInputFiles",
      {
        backendNodeId,
        files,
      },
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      success: true,
      uploaded: files.length,
      target: { ref },
    };
  }

  // selector/text：定位并打临时标记，再经 CDP DOM 查询后注入文件。
  await locateElementTarget(
    webview,
    instanceId,
    args,
    `if (!element.matches('input[type="file"]')) {
      throw new Error('Target element is not a file input');
    }
    element.setAttribute('${UPLOAD_MARKER}', '1');
    return {
      x: 0,
      y: 0,
      element: {
        tagName: 'input',
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
      },
    };`,
  );
  try {
    const doc = (await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.getDocument",
      { depth: -1, pierce: true },
    )) as { root?: { nodeId?: number } };
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      throw new Error("Failed to resolve the page document");
    }
    const query = (await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.querySelector",
      { nodeId: rootNodeId, selector: `[${UPLOAD_MARKER}="1"]` },
    )) as { nodeId?: number };
    if (typeof query?.nodeId !== "number" || query.nodeId === 0) {
      throw new Error("Failed to locate the file input element");
    }
    await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.setFileInputFiles",
      {
        nodeId: query.nodeId,
        files,
      },
    );
  } finally {
    await webview
      .executeJavaScript(
        `document.querySelector('[${UPLOAD_MARKER}="1"]')?.removeAttribute('${UPLOAD_MARKER}')`,
      )
      .catch(() => {});
  }
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
    uploaded: files.length,
  };
};

const historyNavigation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  direction: "back" | "forward",
): Promise<unknown> => {
  const canGo =
    direction === "back" ? webview.canGoBack() : webview.canGoForward();
  if (!canGo) {
    throw new Error(`Cannot go ${direction}: no history entry`);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`browser-${direction} timed out waiting for navigation`),
      );
    }, 10_000);
    const handle = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      webview.removeEventListener("did-navigate", handle as EventListener);
      webview.removeEventListener(
        "did-navigate-in-page",
        handle as EventListener,
      );
      webview.removeEventListener("did-stop-loading", handle as EventListener);
    };
    webview.addEventListener("did-navigate", handle as EventListener);
    webview.addEventListener("did-navigate-in-page", handle as EventListener);
    webview.addEventListener("did-stop-loading", handle as EventListener);
    if (direction === "back") {
      webview.goBack();
    } else {
      webview.goForward();
    }
  });
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
  };
};

type BrowserCaptureRequest = Parameters<
  typeof window.snow.browserCaptureScreenshot
>[1];
type BrowserCaptureResult = Awaited<
  ReturnType<typeof window.snow.browserCaptureScreenshot>
>;

/** 主进程截图期间持有帧订阅，这里只调用一次，产帧与重试都在主进程内处理。 */
const captureScreenshot = (
  webContentsId: number,
  request: BrowserCaptureRequest,
): Promise<BrowserCaptureResult> =>
  window.snow.browserCaptureScreenshot(webContentsId, request);

const screenshotInRenderMode = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  // 最近一次主 Frame 导航失败时，页面停留在 Chromium 错误页，截图
  // 只会返回全黑图像。此时直接返回原导航错误，不把错误页当作正常结果。
  const navigationState = getMainFrameNavigationState(instanceId);
  if (navigationState?.status === "failed") {
    throw new Error(
      `Browser screenshot unavailable: main-frame navigation to ${navigationState.url} failed with ${navigationState.errorDescription}`,
    );
  }
  const format: "png" | "jpeg" | "webp" =
    args.format === "jpeg" || args.format === "webp" ? args.format : "png";
  const quality = typeof args.quality === "number" ? args.quality : undefined;
  const filePath = optionalString(args, "filePath");
  const fullPage = args.fullPage === true;
  const selector = optionalPayloadString(args, "selector");
  const ref = optionalString(args, "ref");
  const webContentsId = webview.getWebContentsId();

  let clip: { x: number; y: number; width: number; height: number } | null =
    null;
  let elementInfo: unknown = null;
  if (ref) {
    const { objectId } = await resolveRefHandle(webContentsId, instanceId, ref);
    const rectInfo = (await window.snow.browserCdpCommand(
      webContentsId,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function() {
          try {
            this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          } catch {}
          const rect = this.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) throw new Error('Element has no layout box');
          return {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
            element: {
              tagName: this.tagName ? this.tagName.toLowerCase() : '',
              id: this.id || null,
              text: (this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_PREVIEW_LENGTH}),
            },
          };
        }`,
        returnByValue: true,
      },
    )) as {
      result?: {
        value?: {
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          element?: unknown;
        };
      };
    };
    const value = rectInfo?.result?.value;
    if (
      !value ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      typeof value.width !== "number" ||
      typeof value.height !== "number"
    ) {
      throw new Error(`Element for ref ${ref} could not be captured`);
    }
    clip = { x: value.x, y: value.y, width: value.width, height: value.height };
    elementInfo = value.element ?? null;
  } else if (selector) {
    const target = await locateElementTarget(
      webview,
      instanceId,
      args,
      `const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error('Element has no layout box');
      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
        element: {
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        },
      };`,
      args.exact === true,
    );
    clip = {
      x: target.x,
      y: target.y,
      width: target.width ?? 0,
      height: target.height ?? 0,
    };
    elementInfo = target.element;
  }

  const result = await captureScreenshot(webContentsId, {
    format,
    quality,
    fullPage,
    clip: clip ?? undefined,
    filePath,
  });
  const metadata = await currentPageMetadata(webview, instanceId);
  if (result.savedTo) {
    return {
      ...metadata,
      fullPage: fullPage && clip === null,
      savedTo: result.savedTo,
      bytes: result.bytes,
      mimeType: result.mimeType,
      element: elementInfo,
    };
  }
  if (!result.data) {
    throw new Error("Browser screenshot did not return image data");
  }
  return {
    ...metadata,
    fullPage: fullPage && clip === null,
    bytes: result.bytes,
    mimeType: result.mimeType,
    element: elementInfo,
    content: [
      {
        type: "text",
        text: `Browser screenshot captured: ${metadata.title || metadata.url}`,
      },
      {
        type: "image",
        data: result.data,
        mimeType: result.mimeType,
      },
    ],
  };
};

/**
 * 非激活浏览器 tab 的 webview 不产帧，截图会一直挂起；先临时进入渲染态
 * （见 captureRenderMode）再执行，后台 tab 的产帧由主进程持有帧订阅保证。
 */
const screenshot = (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  withCaptureRenderMode(instanceId, () =>
    screenshotInRenderMode(webview, instanceId, args),
  );

const wait = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  window.snow.browserFrameOperation(webview.getWebContentsId(), "wait", {
    ...args,
    instanceId,
  });

const pressKey = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> =>
  actionReceipt(webview, instanceId, args, getConsoleMessages, async () => {
    const key = requiredString(args, "key");
    webview.focus();

    // 支持 "Control+a" / "Shift+ArrowDown" 形式的组合键
    const parts = key.split("+");
    const mainKey = parts.pop();
    if (!mainKey) {
      throw new Error("key must not be empty for browser-press_key");
    }
    // 按下修饰键
    for (const modifier of parts) {
      await webview.sendInputEvent({ type: "keyDown", keyCode: modifier });
    }
    await webview.sendInputEvent({ type: "keyDown", keyCode: mainKey });
    await webview.sendInputEvent({ type: "char", keyCode: mainKey });
    await webview.sendInputEvent({ type: "keyUp", keyCode: mainKey });
    // 释放修饰键
    for (const modifier of [...parts].reverse()) {
      await webview.sendInputEvent({ type: "keyUp", keyCode: modifier });
    }

    return { key };
  });

const scroll = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> =>
  actionReceipt(webview, instanceId, args, getConsoleMessages, async () => {
    const selector = optionalPayloadString(args, "selector");
    const ref = optionalString(args, "ref");
    const position =
      args.position === "top" || args.position === "bottom"
        ? args.position
        : null;
    const deltaY =
      position === null && typeof args.deltaY === "number" ? args.deltaY : null;
    if (position === null && deltaY === null) {
      throw new Error(
        "Either deltaY or position is required for browser-scroll",
      );
    }
    const webContentsId = webview.getWebContentsId();
    let result: Record<string, unknown> | undefined;
    if (ref) {
      const { objectId } = await resolveRefObject(
        webContentsId,
        instanceId,
        ref,
      );
      const called = (await window.snow.browserCdpCommand(
        webContentsId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function(deltaY, position) {
            return (${SCROLL_FUNCTION})(this, deltaY, position);
          }`,
          arguments: [{ value: deltaY }, { value: position }],
          awaitPromise: true,
          returnByValue: true,
        },
      )) as { result?: { value?: Record<string, unknown> } };
      result = called?.result?.value;
    } else {
      result = (await webview.executeJavaScript(`(async () => {
        const selector = ${JSON.stringify(selector ?? null)};
        let start = null;
        if (selector) {
          ${COLLECT_ROOTS_SCRIPT}
          try {
            for (const root of roots) {
              start = root.querySelector(selector);
              if (start) break;
            }
          } catch {
            throw new Error('Invalid CSS selector: ' + selector);
          }
          if (!start) {
            throw new Error('No element matches the selector: ' + selector);
          }
        }
        return (${SCROLL_FUNCTION})(start, ${JSON.stringify(deltaY)}, ${JSON.stringify(position)});
      })()`)) as Record<string, unknown> | undefined;
    }
    if (!result || typeof result !== "object") {
      throw new Error("Browser scroll did not return a result");
    }
    return {
      ...(position ? { position } : { deltaY }),
      ...result,
    };
  });

const hover = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalPayloadString(args, "selector");
  const text = optionalPayloadString(args, "text");
  const exact = args.exact === true;
  const locateScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    exact,
    `const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      throw new Error('Hoverable element is outside the browser viewport');
    }
    return {
      x,
      y,
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        href: element.href || null,
      },
    };`,
  );
  const target = (await webview.executeJavaScript(locateScript)) as {
    x: number;
    y: number;
    element: unknown;
  };
  const metadata = await currentPageMetadata(webview, instanceId);
  webview.focus();
  await webview.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
  return {
    ...metadata,
    success: true,
    element: target.element,
    position: { x: target.x, y: target.y },
  };
};

const selectOption = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> =>
  actionReceipt(webview, instanceId, args, getConsoleMessages, async () => {
    const selector = optionalPayloadString(args, "selector");
    const text = optionalPayloadString(args, "text");
    const exact = args.exact === true;
    const values = args.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("values is required and must be a non-empty array");
    }
    const stringValues = values.map(String);

    const selectScript = buildElementLocatorScript(
      selector ?? null,
      text ?? null,
      exact,
      `if (element.tagName !== 'SELECT') {
      throw new Error('Target element is not a <select> element');
    }
    const values = ${JSON.stringify(stringValues)};
    const multiple = element.multiple;
    if (!multiple) {
      element.value = values[0];
      // 处理 value 未命中时按 option text 匹配
      if (element.selectedIndex === -1) {
        for (const option of element.options) {
          if (option.text === values[0] || option.textContent === values[0]) {
            option.selected = true;
            element.value = option.value;
            break;
          }
        }
      }
    } else {
      for (const option of element.options) {
        option.selected = values.includes(option.value) ||
          values.includes(option.text) ||
          values.includes(option.textContent);
      }
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    const selectedOptions = Array.from(element.selectedOptions).map((option) => ({
      value: option.value,
      text: option.text,
    }));
    return {
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        multiple,
      },
      selectedOptions,
    };`,
    );
    const result = (await webview.executeJavaScript(selectScript)) as {
      element: unknown;
      selectedOptions: unknown;
    };
    return {
      values: stringValues,
      element: result.element,
      selectedOptions: result.selectedOptions,
    };
  });

const devtools = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> => {
  const consoleMessages = getConsoleMessages();
  const action = typeof args.action === "string" ? args.action : "snapshot";
  if (action === "ax") {
    const verbose = args.verbose === true;
    const maxNodes = typeof args.maxNodes === "number" ? args.maxNodes : 200;
    const raw = (await window.snow.browserCdpCommand(
      webview.getWebContentsId(),
      "Accessibility.getFullAXTree",
      {},
    )) as { nodes?: AxNode[] };
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    if (nodes.length === 0) {
      throw new Error(
        "Accessibility tree is empty; ensure the page is loaded and the browser debugger is available (close page DevTools if open)",
      );
    }
    const result = snapshotAxTree(instanceId, nodes, { verbose, maxNodes });
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      accessibility: result.tree,
      stats: {
        totalNodes: result.totalNodes,
        emitted: result.emitted,
        truncated: result.truncated,
      },
      note: "Elements are addressable via [uid=...] with browser-click ref=<uid> or browser-type ref=<uid>. Compact output keeps control values (value/min/max) and states (checked/selected/expanded/disabled); password-like values are masked. Uids are bound to this tab and its current document: after a navigation or reload they are rejected, so take a new snapshot after the page changes.",
    };
  }
  if (action === "trace") {
    const durationMs =
      typeof args.durationMs === "number" ? args.durationMs : 3000;
    const result = await window.snow.browserTrace(
      webview.getWebContentsId(),
      durationMs,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      trace: result,
    };
  }
  if (action === "open") {
    await window.snow.openBrowserDevTools(webview.getWebContentsId());
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      opened: true,
    };
  }
  if (action === "console") {
    const level = typeof args.level === "string" ? args.level : "info";
    const minLevel = CONSOLE_LEVEL_MIN[level] ?? CONSOLE_LEVEL_MIN.info;
    const types = Array.isArray(args.types)
      ? args.types.filter((item): item is string => typeof item === "string")
      : undefined;
    const pageIdx = typeof args.pageIdx === "number" ? args.pageIdx : undefined;
    const pageSize =
      typeof args.pageSize === "number" ? args.pageSize : undefined;
    const includePreserved = args.includePreserved === true;
    const frameId =
      typeof args.frameId === "string" && args.frameId
        ? args.frameId
        : undefined;
    const webviewFallback = async (
      note: string,
    ): Promise<Record<string, unknown>> => {
      const messages = consoleMessages.filter((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const message = entry as {
          level?: unknown;
          type?: unknown;
          kind?: unknown;
        };
        if (typeof message.level !== "number" || message.level < minLevel)
          return false;
        // Electron console-message 没有 CDP type；以其已知级别映射 kind，
        // 未知类别不可误匹配显式 types（例如 log/debug）。
        const kind =
          message.type ??
          message.kind ??
          ["verbose", "info", "warning", "error"][message.level];
        return !types?.length || types.includes(String(kind));
      });
      const total = messages.length;
      const size = pageSize ?? Math.max(total, 1);
      const paged =
        pageIdx !== undefined || pageSize !== undefined
          ? messages.slice((pageIdx ?? 0) * size, (pageIdx ?? 0) * size + size)
          : messages;
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        source: "webview",
        messages: paged,
        total,
        level,
        note,
      };
    };
    let response: Record<string, unknown> | undefined;
    try {
      let result:
        | Awaited<ReturnType<typeof window.snow.browserConsoleRecords>>
        | undefined;
      try {
        result = await window.snow.browserConsoleRecords(
          webview.getWebContentsId(),
          {
            level: minLevel,
            types,
            pageIdx,
            pageSize,
            includePreserved,
            frameId,
          },
        );
      } catch (error) {
        // 帧作用域要求帧归属；不得回退到没有帧信息的 webview 控制台流。
        if (frameId) throw error;
        // CDP 不可用时仍应用相同 level/types 过滤，并共用 finally 清理。
      }
      if (!result) {
        if (frameId)
          throw new Error(
            "Frame-scoped console records require CDP capture; the webview console fallback has no frame attribution",
          );
        response = await webviewFallback(
          "CDP console capture is unavailable; falling back to the webview console-message stream (no stack traces).",
        );
      } else if (
        !frameId &&
        result.total === 0 &&
        consoleMessages.length > 0 &&
        !includePreserved
      ) {
        response = await webviewFallback(
          "CDP console capture just started; showing webview console-message data (no stack traces). Query again after the next messages.",
        );
      } else {
        response = {
          ...(await currentPageMetadata(webview, instanceId)),
          source: "cdp",
          messages: result.messages,
          total: result.total,
          pageIdx: result.pageIdx,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
          archivedGenerations: result.archivedGenerations,
          level,
          ...(frameId ? { frameId } : {}),
        };
      }
    } finally {
      if (args.clearConsole === true) {
        try {
          const cleared = await window.snow.browserConsoleClear(
            webview.getWebContentsId(),
          );
          if (response) response.cleared = cleared.cleared;
        } catch {
          // 不把清理失败伪报成功，也不吞掉已成功读取的 fallback 数据。
          if (response) response.clearError = "CDP console clear failed";
        }
      }
    }
    return response;
  }
  if (action === "console_message") {
    const messageId =
      typeof args.msgid === "number" && Number.isFinite(args.msgid)
        ? Math.floor(args.msgid)
        : null;
    if (messageId === null || messageId <= 0) {
      throw new Error("msgid is required for browser-devtools console_message");
    }
    const record = await window.snow.browserConsoleRecord(
      webview.getWebContentsId(),
      messageId,
    );
    if (record === null || record === undefined) {
      const fallback = consoleMessages[messageId - 1] ?? null;
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        found: fallback !== null,
        message: fallback,
      };
    }
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      found: true,
      message: record,
    };
  }
  if (action === "network") {
    const filter = optionalPayloadString(args, "filter");
    const includeStatic = args.static === true;
    const resourceTypes = Array.isArray(args.resourceTypes)
      ? args.resourceTypes.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined;
    const methods = Array.isArray(args.methods)
      ? args.methods.filter((item): item is string => typeof item === "string")
      : undefined;
    const pageIdx =
      typeof args.pageIdx === "number" && Number.isFinite(args.pageIdx)
        ? Math.max(0, Math.min(1000, Math.floor(args.pageIdx)))
        : 0;
    // 显式 pageSize 优先（分页上限 1000）；旧 limit 默认 50，上限 200。
    const explicitPageSize =
      typeof args.pageSize === "number" && Number.isFinite(args.pageSize);
    const requestedSize = explicitPageSize
      ? (args.pageSize as number)
      : typeof args.limit === "number" && Number.isFinite(args.limit)
        ? args.limit
        : 50;
    const pageSize = Math.max(
      1,
      Math.min(explicitPageSize ? 1000 : 200, Math.floor(requestedSize)),
    );
    const includePreserved = args.includePreserved === true;
    // 默认精简列表；includeHeaders=true 兼容需要请求/响应头的调用方。
    const includeHeaders = args.includeHeaders === true;
    const frameId =
      typeof args.frameId === "string" && args.frameId
        ? args.frameId
        : undefined;
    const result = await window.snow.browserNetworkRequests(
      webview.getWebContentsId(),
      {
        filter,
        resourceTypes,
        methods,
        includeStatic,
        pageIdx,
        pageSize,
        includePreserved,
        frameId,
      },
    );
    const pageRecords = result.records.slice(0, pageSize);
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      requests: includeHeaders
        ? pageRecords
        : pageRecords
            .map(toCompactNetworkRecord)
            .filter(
              (record): record is Record<string, unknown> => record !== null,
            ),
      total: result.total,
      pageIdx,
      pageSize,
      hasMore: result.hasMore || result.records.length > pageSize,
      archivedGenerations: result.archivedGenerations,
      source: result.source,
      static: includeStatic,
      headersIncluded: includeHeaders,
      preflightTotal: result.preflightTotal,
      ...(frameId ? { frameId } : {}),
      note: includeHeaders
        ? "Full records include requestHeaders and responseHeaders; bodies are still omitted. Use action=networkDetails requestId=<requestId from action=network> for bodies (only cdp records have a requestId; iframe/OOPIF records use a frame-scoped key)."
        : 'Compact list: id, requestId, cdpFrameId, method, url, status, resourceType, durationMs, source, error. Headers and bodies are omitted: call action=network_detail requestId=<id> for the full record, or action=networkDetails requestId=<requestId from action=network> for headers plus bodies (only cdp records have a requestId; iframe/OOPIF records use a frame-scoped key). Pass includeHeaders=true to include headers in the list, and methods=["OPTIONS"] to inspect CORS preflight requests.',
    };
  }
  if (action === "network_detail") {
    const requestId =
      typeof args.requestId === "string" && /^\d+$/.test(args.requestId.trim())
        ? Number(args.requestId.trim())
        : args.requestId;
    if (
      typeof requestId !== "number" ||
      !Number.isSafeInteger(requestId) ||
      requestId <= 0
    ) {
      throw new Error(
        "requestId must be a positive safe integer for browser-devtools network_detail",
      );
    }
    const record = await window.snow.browserNetworkDetail(
      webview.getWebContentsId(),
      requestId,
    );
    if (!record) {
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        found: false,
        requestId,
        error: `No network record found with id ${requestId}`,
      };
    }
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      found: true,
      requestId,
      request: record,
    };
  }
  if (action === "network_clear") {
    const result = await window.snow.browserNetworkClear(
      webview.getWebContentsId(),
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      cleared: result.cleared,
      success: true,
    };
  }
  if (action === "networkDetails") {
    const requestId = requiredPayloadString(args, "requestId");
    const maxBodyBytes =
      typeof args.maxBodyBytes === "number" ? args.maxBodyBytes : undefined;
    const requestFilePath = optionalString(args, "requestFilePath");
    const responseFilePath = optionalString(args, "responseFilePath");
    const details = await window.snow.browserNetworkDetails(
      webview.getWebContentsId(),
      requestId,
      { maxBodyBytes, requestFilePath, responseFilePath },
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      details,
    };
  }
  if (action === "networkState") {
    const state = requiredString(args, "state");
    if (state !== "online" && state !== "offline") {
      throw new Error(
        "state must be online or offline for browser-devtools networkState",
      );
    }
    const result = await window.snow.browserNetworkState(
      webview.getWebContentsId(),
      state === "offline",
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      state: result.state,
    };
  }
  if (action === "route") {
    const pattern = requiredPayloadString(args, "pattern");
    const rule: BrowserRouteRule = {
      pattern,
      status: typeof args.status === "number" ? args.status : undefined,
      body: typeof args.body === "string" ? args.body : undefined,
      contentType:
        typeof args.contentType === "string" ? args.contentType : undefined,
      headers:
        args.headers !== null &&
        typeof args.headers === "object" &&
        !Array.isArray(args.headers)
          ? (args.headers as Record<string, string>)
          : undefined,
    };
    // 同一 pattern 覆盖，其余规则保留；全量提交给主进程。
    const rules = browserRouteRulesByInstance.get(instanceId) ?? [];
    const existingIndex = rules.findIndex((item) => item.pattern === pattern);
    if (existingIndex >= 0) {
      rules[existingIndex] = rule;
    } else {
      rules.push(rule);
    }
    browserRouteRulesByInstance.set(instanceId, rules);
    const result = await window.snow.browserRouteSet(
      webview.getWebContentsId(),
      rules,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      active: result.active,
      rule: { pattern },
    };
  }
  if (action === "routeClear") {
    browserRouteRulesByInstance.delete(instanceId);
    const result = await window.snow.browserRouteClear(
      webview.getWebContentsId(),
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      active: result.active,
    };
  }
  if (action === "storageSave") {
    const fileName =
      typeof args.fileName === "string" && args.fileName.trim()
        ? args.fileName.trim()
        : undefined;
    const result = await window.snow.browserStorageSave(
      webview.getWebContentsId(),
      fileName,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      storage: result,
    };
  }
  if (action === "storageRestore") {
    const fileName = requiredString(args, "fileName");
    const result = await window.snow.browserStorageRestore(
      webview.getWebContentsId(),
      fileName,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      storage: result,
    };
  }
  if (action === "cookies") {
    const domain = optionalString(args, "domain");
    const showValues = args.showValues === true;
    const cookies = await window.snow.browserCookies(
      webview.getWebContentsId(),
      domain,
      showValues,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      cookies,
      total: cookies.length,
      masked: !showValues,
      ...(showValues
        ? {
            note: "WARNING: this output contains plaintext cookie values (sensitive credentials).",
          }
        : {}),
    };
  }
  if (action === "cookieDelete") {
    const name = requiredPayloadString(args, "name");
    const domain = requiredString(args, "domain");
    const result = await window.snow.browserCookieDelete(
      webview.getWebContentsId(),
      name,
      domain,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      deleted: result.deleted,
      name,
      domain,
    };
  }
  if (action === "dialog") {
    const dialogResponse = args.dialogResponse;
    if (
      dialogResponse !== null &&
      typeof dialogResponse === "object" &&
      typeof (dialogResponse as { accept?: unknown }).accept === "boolean"
    ) {
      const accept = (dialogResponse as { accept: boolean }).accept;
      const promptText =
        typeof (dialogResponse as { promptText?: unknown }).promptText ===
        "string"
          ? (dialogResponse as { promptText: string }).promptText
          : undefined;
      const dialogId =
        typeof (dialogResponse as { dialogId?: unknown }).dialogId ===
          "string" && (dialogResponse as { dialogId: string }).dialogId
          ? (dialogResponse as { dialogId: string }).dialogId
          : undefined;
      const responded = await window.snow.browserDialogRespond(
        webview.getWebContentsId(),
        accept,
        promptText,
        dialogId,
      );
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        responded,
        ...(dialogId ? { dialogId } : {}),
      };
    }
    const dialogs = await window.snow.browserDialogs(
      webview.getWebContentsId(),
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      dialogs,
      pending: dialogs.length,
    };
  }

  const maxContentLength =
    typeof args.maxContentLength === "number" ? args.maxContentLength : 20_000;
  const snapshot = await webview.executeJavaScript(`(() => {
    const text = String(document.body?.innerText || '').slice(0, ${maxContentLength});
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      contentType: document.contentType,
      characterSet: document.characterSet,
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      text,
      links: Array.from(document.links).slice(0, 100).map((link) => ({
        text: String(link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        href: link.href,
      })),
    };
  })()`);
  return {
    instanceId,
    snapshot,
  };
};

/** 会产生页面副作用、支持动作后观察（observe/expect）的工具。 */
const OBSERVABLE_OPERATIONS = new Set([
  "click",
  "type",
  "fill_form",
  "select_option",
  "press_key",
  "scroll",
]);

export const executeBrowserMcpOperation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  operation: string,
  args: BrowserMcpCommandArgs,
  getConsoleMessages: () => readonly unknown[],
): Promise<unknown> => {
  // console/network 是整页记录接口：帧作用域在数据查询层过滤，不能走帧操作分支。
  const pageRecordAction =
    operation === "devtools" &&
    (args.action === "console" || args.action === "network");
  const frameRouted =
    args.frameId !== undefined && args.frameId !== null && !pageRecordAction;
  if (operation === "frames" || operation === "drag") {
    return window.snow.browserFrameOperation(
      webview.getWebContentsId(),
      operation,
      args,
    );
  }
  // 子 frame 动作在主进程执行；观察仍作用于顶层页面（URL/标题/弹窗/事件）。
  if (frameRouted) {
    const runFrame = async (): Promise<Record<string, unknown>> => {
      const result = await window.snow.browserFrameOperation(
        webview.getWebContentsId(),
        operation,
        args,
      );
      return result !== null &&
        typeof result === "object" &&
        !Array.isArray(result)
        ? { ...(result as object) }
        : { result };
    };
    return OBSERVABLE_OPERATIONS.has(operation)
      ? actionReceipt(webview, instanceId, args, getConsoleMessages, runFrame)
      : runFrame();
  }
  switch (operation) {
    case "navigate":
      return navigate(webview, instanceId, args);
    case "click":
      return click(webview, instanceId, args, getConsoleMessages);
    case "evaluate":
      return evaluate(webview, instanceId, args);
    case "type":
      return type(webview, instanceId, args, getConsoleMessages);
    case "fill_form":
      return fillForm(webview, instanceId, args, getConsoleMessages);
    case "emulate":
      return emulatePage(webview, instanceId, args);
    case "resize_page":
      return resizePage(webview, instanceId, args);
    case "performance_start_trace":
      return traceStart(webview, instanceId, args);
    case "performance_stop_trace":
      return traceStop(webview, instanceId, args);
    case "performance_analyze_insight":
      return traceInsight(webview, instanceId, args);
    case "get_css_styles":
      return cssStyles(webview, instanceId, args);
    case "audit":
      return auditPage(webview, instanceId, args);
    case "take_heapsnapshot":
      return heapOperation(webview, instanceId, args);
    case "screencast_start":
      return screencastStart(webview, instanceId, args);
    case "screencast_stop":
      return screencastStop(webview, instanceId);
    case "list_page_tools":
      return listPageTools(webview, instanceId);
    case "call_page_tool":
      return callPageTool(webview, instanceId, args);
    case "screenshot":
      return screenshot(webview, instanceId, args);
    case "wait":
      return wait(webview, instanceId, args);
    case "press_key":
      return pressKey(webview, instanceId, args, getConsoleMessages);
    case "scroll":
      return scroll(webview, instanceId, args, getConsoleMessages);
    case "hover":
      return hover(webview, instanceId, args);
    case "select_option":
      return selectOption(webview, instanceId, args, getConsoleMessages);
    case "devtools":
      return devtools(webview, instanceId, args, getConsoleMessages);
    case "upload-file":
      return uploadFile(webview, instanceId, args);
    case "back":
      return historyNavigation(webview, instanceId, "back");
    case "forward":
      return historyNavigation(webview, instanceId, "forward");
    default:
      throw new Error(`Unsupported browser operation: ${operation}`);
  }
};
