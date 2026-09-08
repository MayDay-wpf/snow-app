import { captureWebviewPage } from "./captureWebviewPage";
import {
  resolveAxRef,
  serializeAxTree,
  type AxNode,
} from "./browserAxSnapshot";
import type { BrowserMcpCommandArgs } from "./browserMcpController";

const TEXT_PREVIEW_LENGTH = 160;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

// 公共元素描述函数片段（normalize + describe）。定位脚本、fill 脚本与
// CDP callFunctionOn 复用。注意：const 在同一作用域重复声明会抛
// SyntaxError，因此每个脚本作用域只能注入一次。
const DESCRIBE_ELEMENT_SCRIPT = `
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const describe = (element) => normalize(
    element.innerText ||
    element.textContent ||
    element.value ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title')
  );`;

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

// executeJavaScript 的结果可能含循环引用/函数等无法 JSON 序列化的值，
// MCP 返回链路要求 JSON 安全，这里做兜底转换。
const toJsonSafe = (value: unknown): unknown => {
  if (value === undefined) {
    return null;
  }
  try {
    JSON.stringify(value);
    return value;
  } catch {
    try {
      return JSON.parse(
        JSON.stringify(value, (_key, item) =>
          typeof item === "function" ? undefined : item,
        ),
      );
    } catch {
      return String(value);
    }
  }
};

// 公共元素定位脚本：selector/text + shadowRoot 遍历 + 可见性/禁用检查 +
// scrollIntoView 居中。actionBody 在元素就绪后执行（可返回任意结果）。
// 被 click / type 复用，避免定位逻辑重复。
const buildElementLocatorScript = (
  selector: string | null,
  text: string | null,
  exact: boolean,
  actionBody: string,
): string => `(async () => {
  const selector = ${JSON.stringify(selector)};
  const text = ${JSON.stringify(text)};
  const exact = ${JSON.stringify(exact)};
  const interactiveSelector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]'
  ].join(',');
  ${DESCRIBE_ELEMENT_SCRIPT}
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
  };
  const collectRoots = (root, roots) => {
    roots.push(root);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        collectRoots(element.shadowRoot, roots);
      }
    }
  };
  const roots = [];
  collectRoots(document, roots);
  let element = null;
  if (selector) {
    try {
      for (const root of roots) {
        const match = root.querySelector(selector);
        if (match) {
          element = match.closest(interactiveSelector) || match;
          break;
        }
      }
    } catch (error) {
      throw new Error('Invalid CSS selector: ' + selector);
    }
  }
  if (!element && text) {
    const expected = normalize(text);
    const candidates = roots.flatMap((root) =>
      Array.from(root.querySelectorAll(interactiveSelector))
    );
    const matches = candidates.filter((candidate) => {
      if (!isVisible(candidate) || candidate.matches(':disabled,[aria-disabled="true"]')) {
        return false;
      }
      const actual = describe(candidate);
      return exact ? actual === expected : actual.includes(expected);
    });
    element = matches.sort((left, right) => {
      const leftText = describe(left);
      const rightText = describe(right);
      const leftExact = leftText === expected ? 0 : 1;
      const rightExact = rightText === expected ? 0 : 1;
      return leftExact - rightExact || leftText.length - rightText.length;
    })[0] || null;
  }
  if (!element || !isVisible(element)) {
    throw new Error('Target element was not found or is not visible');
  }
  if (element.matches(':disabled,[aria-disabled="true"]')) {
    throw new Error('Target element is disabled');
  }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  ${actionBody}
})()`;

const requiredString = (args: BrowserMcpCommandArgs, field: string): string => {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

/**
 * 无障碍快照 ref 回指：uid → backendDOMNodeId → DOM.resolveNode → callFunctionOn
 * 取元素中心坐标与可见性（页面上下文执行）。返回 objectId 供 type 复用。
 */
const resolveRefHandle = async (
  webview: Electron.WebviewTag,
  webContentsId: number,
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
  const backend = resolveAxRef(ref);
  if (backend === null) {
    throw new Error(
      `Ref ${ref} is not in the current snapshot. Capture a new accessibility snapshot (browser-devtools action=ax) first.`,
    );
  }
  const resolved = (await window.snow.browserCdpCommand(
    webContentsId,
    "DOM.resolveNode",
    { backendNodeId: backend },
  )) as { object?: { objectId?: string } };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error(
      `Element for ref ${ref} no longer exists in the DOM. Capture a new accessibility snapshot.`,
    );
  }
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
): string | undefined => {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string when provided`);
  }
  return value.trim();
};

const currentPageMetadata = async (
  webview: Electron.WebviewTag,
  instanceId: string,
): Promise<{ instanceId: string; url: string; title: string }> => ({
  instanceId,
  url: webview.getURL(),
  title: await webview.executeJavaScript("document.title || ''"),
});

const waitForNavigation = (
  webview: Electron.WebviewTag,
  url: string,
  timeoutMs: number,
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
            `Failed to navigate browser to ${event.validatedURL || url}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Browser navigation timed out after ${timeoutMs}ms`));
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
    Promise.resolve(webview.loadURL(url)).catch((error: unknown) => {
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
  });

const navigate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const url = requiredString(args, "url");
  const timeoutMs =
    typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
  await waitForNavigation(webview, url, timeoutMs);
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
  };
};

/**
 * 三路定位（selector / text / ref）并执行 actionBody，返回元素中心坐标与描述。
 * ref 走无障碍树确定性定位；selector/text 走 DOM 定位脚本（含 shadowRoot 遍历）。
 */
const locateElementTarget = async (
  webview: Electron.WebviewTag,
  args: BrowserMcpCommandArgs,
  actionBody: string,
  exact = false,
): Promise<{ x: number; y: number; element: unknown }> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const ref = optionalString(args, "ref");
  if (ref) {
    const { info } = await resolveRefHandle(
      webview,
      webview.getWebContentsId(),
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
    element: unknown;
  };
};

const click = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const target = await locateElementTarget(
    webview,
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
  const metadata = await currentPageMetadata(webview, instanceId);
  webview.focus();
  await webview.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
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
  return {
    ...metadata,
    success: true,
    element: target.element,
  };
};

const evaluate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const expression = requiredString(args, "expression");
  let result: unknown;
  let error: string | undefined;
  try {
    result = await webview.executeJavaScript(expression);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    ...(error !== undefined ? { error } : { result: toJsonSafe(result) }),
  };
};

/** 一次性设值逻辑（作用域内元素为 element）：原生 setter + input/change 事件
 * （React 受控组件兼容，与 Playwright fill 同原理）。定位脚本与 ref 回指共用。
 * 注意：本片段不再定义 describe —— selector/text 路径由定位脚本注入，
 * ref 路径由调用方在 functionDeclaration 中注入 DESCRIBE_ELEMENT_SCRIPT。 */
const buildFillBody = (
  value: string,
  submit: boolean,
): string => `const editable = element.matches(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [contenteditable=""]'
  );
  if (!editable) {
    throw new Error('Target element is not editable (expected input, textarea, or contenteditable)');
  }
  const value = ${JSON.stringify(value)};
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

const type = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const ref = optionalString(args, "ref");
  const value = requiredRawString(args, "value");
  const submit = args.submit === true;
  const delayMs = typeof args.delayMs === "number" ? args.delayMs : 0;
  const webContentsId = webview.getWebContentsId();

  // 逐键模式：聚焦元素，用真实键盘事件逐字符输入（触发表单校验）。
  if (delayMs > 0) {
    let target: { element: unknown };
    if (ref) {
      const { objectId } = await resolveRefHandle(webview, webContentsId, ref);
      const focused = (await window.snow.browserCdpCommand(
        webContentsId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
            this.focus();
            return {
              element: {
                tagName: this.tagName ? this.tagName.toLowerCase() : '',
                id: this.id || null,
                text: (this.innerText || this.textContent || this.value || '')
                  .replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_PREVIEW_LENGTH}),
              },
            };
          }`,
          returnByValue: true,
        },
      )) as { result?: { value?: { element?: unknown } } };
      target = { element: focused?.result?.value?.element };
    } else {
      const focusScript = buildElementLocatorScript(
        selector ?? null,
        text ?? null,
        false,
        `element.focus();
        return {
          element: {
            tagName: element.tagName.toLowerCase(),
            id: element.id || null,
            text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
          },
        };`,
      );
      target = (await webview.executeJavaScript(focusScript)) as {
        element: unknown;
      };
    }
    webview.focus();
    for (const char of value) {
      await webview.sendInputEvent({ type: "keyDown", keyCode: char });
      await webview.sendInputEvent({ type: "char", keyCode: char });
      await webview.sendInputEvent({ type: "keyUp", keyCode: char });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (submit) {
      await webview.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      await webview.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      success: true,
      mode: "keys",
      element: target.element,
    };
  }

  // 默认一次性设值模式。
  if (ref) {
    const { objectId } = await resolveRefHandle(webview, webContentsId, ref);
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
      ...(await currentPageMetadata(webview, instanceId)),
      success: true,
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
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
    mode: "fill",
    value,
    element: result.element,
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
    const backend = resolveAxRef(ref);
    if (backend === null) {
      throw new Error(
        `Ref ${ref} is not in the current snapshot. Capture a new accessibility snapshot (browser-devtools action=ax) first.`,
      );
    }
    await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.setFileInputFiles",
      {
        backendNodeId: backend,
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

const screenshot = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  // 最近一次主 Frame 导航失败时，页面停留在 Chromium 错误页，capturePage
  // 只会返回全黑 PNG。此时直接返回原导航错误，不把错误页当作正常结果。
  const navigationState = getMainFrameNavigationState(instanceId);
  if (navigationState?.status === "failed") {
    throw new Error(
      `Browser screenshot unavailable: main-frame navigation to ${navigationState.url} failed with ${navigationState.errorDescription}`,
    );
  }
  // Viewport-only by default: full-page captures of long pages produce
  // huge base64 payloads that inflate context and may exceed provider
  // per-image limits.
  const fullPage = args.fullPage === true;
  const dataUrl = fullPage
    ? await captureWebviewPage(webview)
    : (await webview.capturePage()).toDataURL();
  if (!dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("Browser screenshot did not return PNG data");
  }
  const base64 = dataUrl.slice("data:image/png;base64,".length);
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `Browser screenshot is too large to return (${estimatedBytes} bytes, maximum ${MAX_SCREENSHOT_BYTES} bytes)`,
    );
  }
  const metadata = await currentPageMetadata(webview, instanceId);
  return {
    ...metadata,
    fullPage,
    content: [
      {
        type: "text",
        text: `Browser screenshot captured: ${metadata.title || metadata.url}`,
      },
      {
        type: "image",
        data: base64,
        mimeType: "image/png",
      },
    ],
  };
};

const wait = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const metadata = await currentPageMetadata(webview, instanceId);

  // 固定时长等待
  if (typeof args.time === "number") {
    const waitTime = Math.min(Math.max(args.time, 100), 30_000);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    return {
      ...metadata,
      condition: "time",
      waitedMs: waitTime,
      success: true,
    };
  }

  // 文本出现/消失、元素出现/消失等待：轮询页面，100ms 间隔
  const text = optionalString(args, "text");
  const textGone = optionalString(args, "textGone");
  const selector = optionalString(args, "selector");
  const selectorGone = optionalString(args, "selectorGone");
  const condition = text
    ? "text"
    : textGone
      ? "textGone"
      : selector
        ? "selector"
        : "selectorGone";
  const expected = text ?? textGone ?? selector ?? selectorGone;
  if (!expected) {
    throw new Error(
      "One of time, text, textGone, selector, or selectorGone is required for browser-wait",
    );
  }
  const timeoutMs =
    typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
  const pollInterval = 100;
  const startedAt = Date.now();
  // selector 条件直接复用定位脚本的校验逻辑：无效 CSS 选择器视为不满足，
  // 最终以超时失败返回（并携带提示），不会抛出未包装的异常。
  const selectorQuery = (sel: string): string => `(() => {
    try {
      const element = document.querySelector(${JSON.stringify(sel)});
      return element !== null;
    } catch {
      return false;
    }
  })()`;
  const isSelectorCondition =
    condition === "selector" || condition === "selectorGone";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let satisfied: boolean;
    if (isSelectorCondition) {
      const found = (await webview.executeJavaScript(
        selectorQuery(expected),
      )) as boolean;
      satisfied = condition === "selector" ? found : !found;
    } else {
      const pageText = await webview.executeJavaScript(
        "String(document.body?.innerText || '')",
      );
      const found = pageText.includes(expected);
      satisfied = condition === "text" ? found : !found;
    }
    if (satisfied) {
      return {
        ...metadata,
        condition,
        value: expected,
        waitedMs: Date.now() - startedAt,
        success: true,
      };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        ...metadata,
        condition,
        value: expected,
        waitedMs: Date.now() - startedAt,
        success: false,
        error: `Timed out waiting for ${condition}: "${expected}"${
          isSelectorCondition && condition === "selector"
            ? " (element not found or selector is invalid)"
            : ""
        }`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
};

const pressKey = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const key = requiredString(args, "key");
  const metadata = await currentPageMetadata(webview, instanceId);
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

  return { ...metadata, success: true, key };
};

const hover = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
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
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
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
  const metadata = await currentPageMetadata(webview, instanceId);
  return {
    ...metadata,
    success: true,
    values: stringValues,
    element: result.element,
    selectedOptions: result.selectedOptions,
  };
};

const devtools = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  consoleMessages: readonly unknown[],
): Promise<unknown> => {
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
    const result = serializeAxTree(nodes, { verbose, maxNodes });
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      accessibility: result.tree,
      stats: {
        totalNodes: result.totalNodes,
        emitted: result.emitted,
        truncated: result.truncated,
      },
      note: "Elements are addressable via [uid=...] with browser-click ref=<uid> or browser-type ref=<uid>. Take a new snapshot after the page changes.",
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
    const level = typeof args.level === "string" ? args.level : undefined;
    const minLevel = level !== undefined ? CONSOLE_LEVEL_MIN[level] : undefined;
    const messages =
      minLevel === undefined
        ? consoleMessages
        : consoleMessages.filter((entry) => {
            const entryLevel = (entry as { level?: unknown }).level;
            return typeof entryLevel === "number" && entryLevel >= minLevel;
          });
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      messages,
      totalMessages: messages.length,
      level: level ?? "all",
    };
  }
  if (action === "network") {
    const filter = optionalString(args, "filter");
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const includeStatic = args.static === true;
    const requests = await window.snow.browserNetworkRequests(
      webview.getWebContentsId(),
      filter,
      limit,
      includeStatic,
    );
    // 为每条记录附加序号，便于用 network_detail 按 index 查询
    const numbered = (requests as unknown[]).map((record, index) => ({
      index: index + 1,
      record,
    }));
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      requests: numbered,
      total: numbered.length,
      static: includeStatic,
      note: "Use action=networkDetails with a requestId to fetch full headers and bodies (CDP records).",
    };
  }
  if (action === "network_detail") {
    const requestId = args.requestId;
    if (typeof requestId !== "number") {
      throw new Error(
        "requestId is required for browser-devtools network_detail",
      );
    }
    const record = await window.snow.browserNetworkRequest(requestId);
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
    const requestId = requiredString(args, "requestId");
    const maxBodyBytes =
      typeof args.maxBodyBytes === "number" ? args.maxBodyBytes : undefined;
    const details = await window.snow.browserNetworkDetails(
      webview.getWebContentsId(),
      requestId,
      maxBodyBytes,
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
    const pattern = requiredString(args, "pattern");
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
    const name = requiredString(args, "name");
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
      const responded = await window.snow.browserDialogRespond(
        webview.getWebContentsId(),
        accept,
        promptText,
      );
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        responded,
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

export const executeBrowserMcpOperation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  operation: string,
  args: BrowserMcpCommandArgs,
  consoleMessages: readonly unknown[],
): Promise<unknown> => {
  switch (operation) {
    case "navigate":
      return navigate(webview, instanceId, args);
    case "click":
      return click(webview, instanceId, args);
    case "evaluate":
      return evaluate(webview, instanceId, args);
    case "type":
      return type(webview, instanceId, args);
    case "screenshot":
      return screenshot(webview, instanceId, args);
    case "wait":
      return wait(webview, instanceId, args);
    case "press_key":
      return pressKey(webview, instanceId, args);
    case "hover":
      return hover(webview, instanceId, args);
    case "select_option":
      return selectOption(webview, instanceId, args);
    case "devtools":
      return devtools(webview, instanceId, args, consoleMessages);
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
