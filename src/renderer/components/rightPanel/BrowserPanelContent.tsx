import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserElementPicker,
  BrowserFindBar,
  type BrowserFindResult,
  BrowserBookmarksBar,
  BrowserToolbar,
  captureWebviewPage,
  useBrowserHomepage,
  useWebviewElementPicker,
  useWebviewScreenshot,
  type PickedElement,
} from "./browser";
import type { BrowserDownloadItemEvent } from "../../../preload/modules/systemApi";
import { DEFAULT_BROWSER_HOMEPAGE } from "./browser/browserHomepageConstants";
import {
  findDeviceSizePreset,
  useBrowserDeviceSize,
} from "./browser/browserDeviceSize";
import {
  focusBrowserMcpInstance,
  registerBrowserMcpInstance,
} from "./browser/browserMcpController";
import {
  clearBrowserNavigationState,
  clearBrowserRouteRulesForInstance,
  executeBrowserMcpOperation,
  recordMainFrameNavigationFailure,
  recordMainFrameNavigationSuccess,
} from "./browser/browserMcpOperations";
import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "../../hooks/useAppControl";
import {
  WEB_SNAPSHOT_REQUEST_EVENT,
  WEB_SNAPSHOT_RESULT_EVENT,
  type WebPageSnapshot,
  type WebSnapshotRequest,
  type WebSnapshotResult,
} from "./browserSnapshotEvents";

export type BrowserPanelContentProps = {
  instanceId: string;
  initialUrl: string;
  isActive: boolean;
  onTitleChange?: (title: string) => void;
  /** 页面每次导航（含页面内跳转）后的最新 URL 回调，用于上层同步 tab 数据 */
  onUrlChange?: (url: string) => void;
  /**
   * guest 页面请求打开新标签页（window.open / target=_blank）时的回调：
   * 上层据此新建一个浏览器 tab（RightPanel 模式直接新建；独立窗口模式
   * 经主进程转发回主窗口新建）。activate=false 时后台打开不切换。
   */
  onOpenNewTab?: (url: string, activate: boolean) => void;
  /** 独立浏览器窗口模式：工具栏菜单显示「还原为标签页」（主面板 tab 内为 false/缺省） */
  detached?: boolean;
};

const normalizeUrl = (input: string, homepage: string): string => {
  const trimmed = input.trim();
  if (!trimmed) {
    return homepage || DEFAULT_BROWSER_HOMEPAGE;
  }
  // Already has a protocol (http, https, or file)
  if (/^(https?|file):\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Looks like a domain (contains a dot, no spaces)
  if (/^\S+\.\S+/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  // Otherwise treat as a search query
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
};

/**
 * Navigation error codes that are expected during normal browsing and should
 * not surface as real failures:
 *
 *   -3  ERR_ABORTED  page redirected (Cloudflare challenge, Google -> localized)
 *   -2  ERR_FAILED   request cancelled or interrupted by a redirect
 *
 * These fire through both the webview `did-fail-load` event and the
 * main-process `GUEST_VIEW_MANAGER_CALL` IPC handler promise rejection.
 */
const SUPPRESSED_ERROR_CODES = new Set([-3, -2]);

// ---------------------------------------------------------------------------
// F4 网页快照（三层）：正文提取脚本 + 渲染进程清洗 + 单层超时工具。
// 快照失败一律静默降级（返回空/undefined），不抛异常、不打断拖入流程。
// ---------------------------------------------------------------------------

/** 快照正文的硬上限（字符数），超长按段落边界截断 */
const MAX_SNAPSHOT_TEXT_LENGTH = 8000;
/** 元素区域摘要的长度上限 */
const MAX_ELEMENT_TEXT_LENGTH = 2000;
/** 截图 dataURL 的硬上限（字符数，约 3MB，防消息 payload 过大） */
const MAX_SNAPSHOT_DATA_URL_LENGTH = 3 * 1024 * 1024;
/** 单层快照采集的超时（毫秒），输入框侧另有 5s 全链路超时兜底 */
const SNAPSHOT_LAYER_TIMEOUT_MS = 3000;

/**
 * webview 内执行的整页正文提取脚本（IIFE）：
 * `article` 优先，克隆 root 后移除脚本/样式/导航/表单等噪声节点，
 * 返回 `{ text }`（innerText，可能为空串）。executeJavaScript 走
 * webview 宿主侧注入，不受页面 CSP 限制（与现有 MCP 操作一致）。
 */
const EXTRACT_PAGE_TEXT_SCRIPT = `(() => {
  const root = document.querySelector('article') || document.body;
  if (!root) return { text: '' };
  const clone = root.cloneNode(true);
  clone.querySelectorAll(
    'script, style, noscript, nav, footer, header, form, svg, canvas, button, iframe, [hidden], [aria-hidden="true"]'
  ).forEach((el) => el.remove());
  return { text: clone.innerText || '' };
})();`;

/** 截断标记：追加在正文末尾，提示内容已截断（随快照文本发送给 AI） */
const TRUNCATION_MARKER = "\n…（内容已截断）";

/**
 * 渲染进程侧的正文清洗：折叠连续空白与空行（段落间最多保留一个空行）、
 * 去除纯符号/装饰行（如 `----`、`...`）、连续重复行去重（广告/固定文案）。
 */
const cleanSnapshotText = (raw: string): string => {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let prevLine = "";
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) {
      // 段落分隔：最多保留一个空行
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      prevLine = "";
      continue;
    }
    // 纯符号/装饰行（无任何字母/数字，含 CJK 判断）丢弃
    if (!/[\p{L}\p{N}]/u.test(line)) {
      continue;
    }
    // 与上一行完全相同（连续重复）去重
    if (prevLine === line) {
      continue;
    }
    prevLine = line;
    out.push(line);
  }
  // 去除首尾空行
  while (out[0] === "") {
    out.shift();
  }
  while (out[out.length - 1] === "") {
    out.pop();
  }
  return truncateSnapshotText(out.join("\n"));
};

/** 按段落边界（最后一个 \n\n）截断到 ≤8000 字符，末尾追加截断标记。 */
const truncateSnapshotText = (text: string): string => {
  if (text.length <= MAX_SNAPSHOT_TEXT_LENGTH) {
    return text;
  }
  const slice = text.slice(0, MAX_SNAPSHOT_TEXT_LENGTH);
  const paraBreak = slice.lastIndexOf("\n\n");
  const cutAt =
    paraBreak > 0
      ? paraBreak
      : Math.max(1, MAX_SNAPSHOT_TEXT_LENGTH - TRUNCATION_MARKER.length);
  return `${text.slice(0, cutAt).replace(/\n+$/, "")}${TRUNCATION_MARKER}`;
};

/** webview 内执行正文提取脚本，返回清洗后的文本（失败/为空 → ""）。 */
const extractPageText = async (
  webview: Electron.WebviewTag,
): Promise<string> => {
  const result = (await webview.executeJavaScript(
    EXTRACT_PAGE_TEXT_SCRIPT,
  )) as { text?: string } | null;
  return cleanSnapshotText(result?.text ?? "");
};

/**
 * 给单层采集加超时：超时返回 undefined（该层静默降级）。底层 Promise
 * 无法取消，但超时后其结果已被忽略，不影响整体链路。
 */
const withLayerTimeout = <T,>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> =>
  new Promise<T | undefined>((resolve) => {
    const timer = window.setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });

/** 拖拽时记录的 URL 与 webview 实时 URL 的宽松比较（忽略结尾斜杠差异）。 */
const normalizeUrlForCompare = (url: string): string => url.replace(/\/+$/, "");

/**
 * 侧边浏览器的实现说明（单 webview 模型）：
 *
 * 每个 BrowserPanelContent 承载一个浏览器 tab（右侧面板 RightPanel 的 tab
 * 即浏览器标签页，独立浏览器窗口固定承载一个实例），内部只有一个
 * <webview>，不再有实例内部的二级标签页。标签页的增删 / 切换由上层
 * RightPanel 的 tab 体系承担，实例 id 与 RightPanel tab id 一致。
 *
 * guest 页面内 target=_blank / window.open 的标签页级打开请求：主进程
 * browserPopupWindow 判定后 deny 并通过 browser:open-tab IPC 通知，这里按
 * guest webContents id 判断是否属于本实例的 webview，是则经 onOpenNewTab
 * 请求上层新建浏览器 tab（disposition 为 background-tab 时后台打开，不
 * 切换）。两个上报来源在此汇合：JS window.open（无 features）走主进程
 * setWindowOpenHandler；target=_blank 链接点击因 Electron bug
 * （electron#30886）不触发该 handler，改由 guest preload 拦截点击经
 * browser:guest-open-tab 中继。窗口级弹出（new-popup / 带
 * width=height= 等 features）仍由主进程创建真实 BrowserWindow
 * （OAuth 登录依赖 window.opener）。
 */

export const BrowserPanelContent = ({
  instanceId,
  initialUrl,
  isActive,
  onTitleChange,
  onUrlChange,
  onOpenNewTab,
  detached = false,
}: BrowserPanelContentProps): React.JSX.Element => {
  // onTitleChange / onUrlChange / onOpenNewTab 由 RightPanel 内联传入,每次
  // 父组件 render 都是新引用。通过 ref 持有,事件监听 effect 只需依赖
  // instanceId,监听器只绑定一次,避免每次父组件重渲染都反复卸载/重建
  // webview 监听器。
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  // onUrlChange 与 onTitleChange 同因,同样经 ref 持有。
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const onOpenNewTabRef = useRef(onOpenNewTab);
  onOpenNewTabRef.current = onOpenNewTab;
  const { homepage, loaded, setHomepage } = useBrowserHomepage();
  const homepageRef = useRef(homepage);
  homepageRef.current = homepage;
  // 设备显示尺寸（移动端界面调试）：全局共享持久化，非 "default" 时
  // webview 视口约束为所选设备尺寸并居中。
  const { deviceSizeId, setDeviceSize } = useBrowserDeviceSize();
  const activeDeviceSize = findDeviceSizePreset(deviceSizeId);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // 单页面状态：本实例唯一 <webview> 的导航状态。src 驱动 <webview src>
  // 属性（仅在显式导航时更新），addressInput 跟随页面内导航实时更新。
  // 初始地址：显式 initialUrl 立即使用；否则 homepage 已就绪（模块启动时
  // 预读）则直接以其为起始页；尚未就绪时留空，等 homepage 加载完成后的
  // effect 补导航兜底。
  const computeStartUrl = useCallback((): string => {
    if (initialUrl) {
      return normalizeUrl(initialUrl, homepage);
    }
    return loaded && homepage ? homepage : "";
  }, [initialUrl, homepage, loaded]);

  const [src, setSrc] = useState<string>(computeStartUrl);
  const [addressInput, setAddressInput] = useState<string>(computeStartUrl);
  const [title, setTitle] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState<boolean>(
    () => !!computeStartUrl(),
  );
  // 本实例唯一 webview（工具栏操作 / MCP / 截图 / 元素选择都作用于它）。
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  // 本实例 webview 的 guest webContents id：主进程 browser:open-tab 事件
  // 按此判断发起请求的 guest 是否属于本实例。
  const guestWebContentsIdRef = useRef<number | null>(null);
  const consoleMessagesRef = useRef<unknown[]>([]);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [findVisible, setFindVisible] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  // 下载列表（webview JS 弹窗走 Electron 原生对话框，无需自绘）。
  const [downloads, setDownloads] = useState<BrowserDownloadItemEvent[]>([]);
  const browserContentRef = useRef<HTMLDivElement>(null);
  const { isCapturing, captureScreenshot } = useWebviewScreenshot(webviewRef);
  const {
    isPicking,
    picked,
    togglePicker,
    cancelPicker,
    confirmPicker,
    applyElementStyle,
  } = useWebviewElementPicker(webviewRef);
  // picked 状态的 ref 镜像：快照请求监听器只绑定一次，经 ref 读取最新值，
  // 避免闭包捕获到旧的 picked。
  const pickedRef = useRef<PickedElement | null>(null);
  pickedRef.current = picked;

  // 计算元素选择备注弹窗的锚点（相对 .browser-content 的左上角）。
  // guest 视口坐标通过 webview 元素的位置偏移到宿主坐标，再换算到
  // 内容区局部坐标；缩放时按 zoomFactor 同步放大（DIP = CSS px × zoom）。
  const pickerAnchor = useMemo(() => {
    if (!picked) {
      return null;
    }
    const webview = webviewRef.current;
    const content = browserContentRef.current;
    if (!webview || !content) {
      return null;
    }
    const webviewRect = webview.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const scale = webview.getZoomFactor();
    return {
      left: webviewRect.left + picked.rect.x * scale - contentRect.left,
      top: webviewRect.top + picked.rect.y * scale - contentRect.top,
      width: picked.rect.width * scale,
      height: picked.rect.height * scale,
    };
  }, [picked]);

  /**
   * 静音状态对齐 Chrome 后台标签页：仅当右侧面板 tab 激活（独立窗口固定
   * isActive）时允许出声，其余静音（避免多个浏览器 tab 同时播放音频）。
   * webview 方法要求 guest 已 dom-ready，未就绪会抛异常，调用方需
   * try/catch；dom-ready 事件里也会补一次。
   */
  const applyMutedState = useCallback((): void => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    try {
      webview.setAudioMuted(!isActiveRef.current);
    } catch {
      // guest 尚未就绪(dom-ready 未触发),等待 dom-ready 后重试。
    }
  }, []);

  /**
   * 为本实例唯一的 webview 绑定事件监听（元素挂载时调用一次）。
   * handler 通过 refs 读取最新状态，闭包仅捕获 instanceId 与 webview。
   */
  const attachWebviewListeners = useCallback(
    (webview: Electron.WebviewTag): void => {
      const handleDomReady = (): void => {
        try {
          // 记录 guest id：主进程 browser:open-tab 事件按此判断归属。
          guestWebContentsIdRef.current = webview.getWebContentsId();
        } catch {
          // guest 尚未就绪，忽略。
        }
        // guest 就绪后补一次静音设置（挂载时 setAudioMuted 可能抛异常）。
        applyMutedState();
      };

      const handleNavigationStateUpdate = (): void => {
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
      };

      // did-navigate fires for every navigation including server-side redirects
      // and in-page pushState. We update the address bar for display but
      // deliberately do NOT update src — changing src would trigger a
      // fresh loadURL via the webview attribute observer, re-triggering the
      // redirect and creating an infinite loop (e.g. Cloudflare challenges).
      const handleDidNavigate = (e: Electron.DidNavigateEvent): void => {
        // 导航成功（含重定向目标、页面内 pushState）后清除失败状态，
        // 使 screenshot 等 MCP 操作恢复正常执行。
        recordMainFrameNavigationSuccess(instanceId, e.url);
        setAddressInput(e.url);
        handleNavigationStateUpdate();
        // Keep the menu's zoom display in sync with the webview's actual zoom
        // (Electron persists zoom per webContents across navigations).
        setZoomFactor(webview.getZoomFactor());
        // 上报最新 URL，供 RightPanel 同步 tab.data.url（拖拽引用需要实时地址）
        onUrlChangeRef.current?.(e.url);
      };

      const handleDidStartLoading = (): void => {
        setIsLoading(true);
      };

      const handleDidStopLoading = (): void => {
        setIsLoading(false);
        handleNavigationStateUpdate();
      };

      const handlePageTitleUpdated = (
        e: Electron.PageTitleUpdatedEvent,
      ): void => {
        setTitle(e.title);
        if (e.title) {
          onTitleChangeRef.current?.(e.title);
        }
      };

      // ERR_ABORTED (-3) and ERR_FAILED (-2) are expected when a page redirects
      // (e.g. Cloudflare managed challenge, Google -> localized). Chromium aborts
      // the original request, which fires did-fail-load. Suppress these so the
      // console stays clean; the redirect target loads normally afterward.
      const handleDidFailLoad = (
        e: Event & {
          errorCode?: number;
          errorDescription?: string;
          validatedURL?: string;
          isMainFrame?: boolean;
        },
      ): void => {
        if (
          e.errorCode !== undefined &&
          SUPPRESSED_ERROR_CODES.has(e.errorCode)
        ) {
          return;
        }
        // 仅主 Frame 失败才记录导航失败状态（子资源失败不影响页面截图）。
        if (e.isMainFrame === false) {
          return;
        }
        recordMainFrameNavigationFailure(
          instanceId,
          e.validatedURL || "",
          e.errorCode,
          e.errorDescription ||
            `Navigation failed with code ${e.errorCode ?? "unknown"}`,
        );
      };

      const handleFoundInPage = (e: Electron.FoundInPageEvent): void => {
        setFindResult({
          activeMatchOrdinal: e.result.activeMatchOrdinal,
          matches: e.result.matches,
        });
      };

      const handleConsoleMessage = (e: Electron.ConsoleMessageEvent): void => {
        consoleMessagesRef.current = [
          ...consoleMessagesRef.current,
          {
            level: e.level,
            message: e.message,
            line: e.line,
            sourceId: e.sourceId,
            recordedAt: new Date().toISOString(),
          },
        ].slice(-500);
      };

      webview.addEventListener("dom-ready", handleDomReady);
      webview.addEventListener("did-navigate", handleDidNavigate);
      webview.addEventListener("did-navigate-in-page", handleDidNavigate);
      webview.addEventListener(
        "did-start-loading",
        handleDidStartLoading as EventListener,
      );
      webview.addEventListener(
        "did-stop-loading",
        handleDidStopLoading as EventListener,
      );
      webview.addEventListener(
        "page-title-updated",
        handlePageTitleUpdated as EventListener,
      );
      webview.addEventListener(
        "did-fail-load",
        handleDidFailLoad as EventListener,
      );
      webview.addEventListener("found-in-page", handleFoundInPage);
      webview.addEventListener("console-message", handleConsoleMessage);
    },
    [instanceId, applyMutedState],
  );

  /**
   * 稳定 ref callback（React 重渲染时函数引用不变，不会触发 detach/
   * attach，监听器只绑定一次）。
   */
  const handleWebviewRef = useCallback(
    (el: Electron.WebviewTag | null): void => {
      const webview = el as unknown as Electron.WebviewTag | null;
      webviewRef.current = webview;
      if (!webview) {
        return;
      }
      // allowpopups 必须为字符串属性：React 18 对未知 boolean 属性
      // （allowpopups 不在 React 白名单）会丢弃并仅告警，而 Electron
      // 类型声明又将其标为 boolean，无法在 JSX 中直接写字符串。
      // 在元素挂载时（早于 guest attach）通过 DOM API 写入，否则
      // guest 保持 disablePopups=true，所有 window.open 被拦截。
      webview.setAttribute("allowpopups", "true");
      attachWebviewListeners(webview);
    },
    [attachWebviewListeners],
  );

  // homepage 加载完成后（且没有显式 initialUrl），让页面导航到真实首页。
  // useState 只评估一次初始值，迟到的 homepage 必须在此补上。
  useEffect(() => {
    if (!loaded || initialUrl) {
      return;
    }
    const url = normalizeUrl(homepage || DEFAULT_BROWSER_HOMEPAGE, homepage);
    setSrc((prev) => (prev ? prev : url));
    setAddressInput((prev) => (prev ? prev : url));
  }, [loaded, initialUrl, homepage]);

  // src 置位时进入加载态（homepage 迟到补导航时 did-start-loading 尚未
  // 触发），did-stop-loading 负责清除。
  useEffect(() => {
    if (src) {
      setIsLoading(true);
    }
  }, [src]);

  // 主进程 browser:open-tab：guest 内的标签页级打开请求（JS window.open
  // 无 features 走 setWindowOpenHandler；target=_blank 链接点击经 guest
  // preload 拦截 + browser:guest-open-tab 中继）。按 guest webContents id
  // 判断：属于本实例的 webview 发起时才经 onOpenNewTab 请求上层新建浏览器
  // tab（弹出窗口内的请求不会命中）。
  useEffect(() => {
    return window.snow.onBrowserOpenTab((event) => {
      if (guestWebContentsIdRef.current !== event.guestWebContentsId) {
        return;
      }
      onOpenNewTabRef.current?.(
        event.url,
        event.disposition !== "background-tab",
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 下载列表：初始拉取一次，之后由主进程增量推送。
  useEffect(() => {
    window.snow
      .listBrowserDownloads()
      .then((items) => {
        setDownloads(items);
      })
      .catch(() => {});
    const unsubscribeDownloads = window.snow.onDownloadsUpdated(setDownloads);
    return () => {
      unsubscribeDownloads();
    };
  }, []);

  const handleDownloadOpen = (id: number): void => {
    void window.snow.openBrowserDownload(id).catch(() => {});
  };
  const handleDownloadShowInFolder = (id: number): void => {
    window.snow.showBrowserDownloadInFolder(id);
  };
  const handleDownloadCancel = (id: number): void => {
    void window.snow.cancelBrowserDownload(id).catch(() => {});
  };

  // MCP 命令桥：所有页面级操作（navigate/click/devtools 等）作用于本实例
  // 唯一的 webview；get_tab_content 提取页面正文。标签页的增删切换由上层
  // RightPanel 的 tab 体系承担（browser-create / browser-list /
  // browser-close / browser-focus）。
  useEffect(() => {
    const unregister = registerBrowserMcpInstance(
      instanceId,
      async (operation, args) => {
        const webview = webviewRef.current;
        if (!webview) {
          throw new Error("浏览器当前没有可操作的页面");
        }
        if (operation === "get_tab_content") {
          const maxLength =
            typeof args.maxLength === "number" ? args.maxLength : 20000;
          const content = (await webview.executeJavaScript(
            "document.body ? document.body.innerText : ''",
          )) as string;
          return {
            url: webview.getURL(),
            title: webview.getTitle(),
            content: String(content ?? "").slice(0, maxLength),
          };
        }
        return executeBrowserMcpOperation(
          webview,
          instanceId,
          operation,
          args,
          consoleMessagesRef.current,
        ).then((result) => {
          if (
            operation === "devtools" &&
            args.action === "console" &&
            args.clearConsole === true
          ) {
            consoleMessagesRef.current = [];
          }
          return result;
        });
      },
    );
    return () => {
      unregister();
      // 实例卸载时清理其累积的路由规则与导航状态,避免残留影响其他实例。
      clearBrowserRouteRulesForInstance(instanceId);
      clearBrowserNavigationState(instanceId);
    };
  }, [instanceId]);

  useEffect(() => {
    if (isActive) {
      focusBrowserMcpInstance(instanceId);
    }
  }, [instanceId, isActive]);

  // F4 网页快照提供方：接收输入框拖入浏览器 tab 后的快照请求，对本实例
  // 唯一的 webview 完成三层提取（整页正文 / 元素区域 / 可视区截图）后回发
  // 结果事件。请求-响应均走全局 CustomEvent：多浏览器 tab 按 instanceId
  // 分流。监听器只绑定一次，状态一律经 ref 读取（webviewRef /
  // pickedRef），避免闭包过期。任一环节失败都静默降级（回发
  // snapshot=undefined），不抛异常、不打断拖入流程。
  useEffect(() => {
    const dispatchSnapshotResult = (
      requestId: number,
      snapshot?: WebPageSnapshot,
    ): void => {
      window.dispatchEvent(
        new CustomEvent<WebSnapshotResult>(WEB_SNAPSHOT_RESULT_EVENT, {
          detail: { requestId, snapshot },
        }),
      );
    };

    const collectWebSnapshot = async (
      webview: Electron.WebviewTag,
      requestedUrl: string,
    ): Promise<WebPageSnapshot | undefined> => {
      // URL 兜底校验：页面已导航到其他地址则视为过期引用，直接降级，
      // 避免快照内容与 chip 上的 URL 不一致。
      let currentUrl = "";
      try {
        currentUrl = webview.getURL();
      } catch {
        return undefined;
      }
      if (!currentUrl) {
        return undefined;
      }
      if (
        normalizeUrlForCompare(currentUrl) !==
        normalizeUrlForCompare(requestedUrl)
      ) {
        return undefined;
      }

      // ① 整页正文：webview 内 JS 提取 + 渲染进程清洗（≤8000 字符）。
      const text = await withLayerTimeout(
        extractPageText(webview),
        SNAPSHOT_LAYER_TIMEOUT_MS,
      );

      // ② 元素区域：picked 由本实例的 webview 产生（webviewRef 指向它）。
      let elementText: string | undefined;
      let elementSelector: string | undefined;
      const picked = pickedRef.current;
      if (picked) {
        const sliced = picked.text.slice(0, MAX_ELEMENT_TEXT_LENGTH);
        elementText = sliced || undefined;
        elementSelector = picked.selector;
      }

      // ③ 可视区截图：复用 captureWebviewPage；dataURL 过大（>~3MB）省略。
      // 截图独立成层——正文/区域失败时截图仍可附。
      let screenshotDataUrl: string | undefined;
      try {
        const dataUrl = await withLayerTimeout(
          captureWebviewPage(webview),
          SNAPSHOT_LAYER_TIMEOUT_MS,
        );
        if (dataUrl && dataUrl.length <= MAX_SNAPSHOT_DATA_URL_LENGTH) {
          screenshotDataUrl = dataUrl;
        }
      } catch {
        // 截图失败：仅返回文本层。
      }

      if (!text && !elementText && !screenshotDataUrl) {
        // 三层全部失败：视为抓取失败，输入框侧降级为纯 URL 引用。
        return undefined;
      }
      const snapshot: WebPageSnapshot = { text: text || "" };
      if (elementText) {
        snapshot.elementText = elementText;
      }
      if (elementSelector) {
        snapshot.elementSelector = elementSelector;
      }
      if (screenshotDataUrl) {
        snapshot.screenshotDataUrl = screenshotDataUrl;
      }
      return snapshot;
    };

    const handleSnapshotRequest = (event: Event): void => {
      const detail = (event as CustomEvent<WebSnapshotRequest>).detail;
      if (!detail || typeof detail.requestId !== "number") {
        return;
      }
      // 多浏览器 tab 并存：只响应属于本实例的快照请求。
      if (detail.instanceId !== instanceId) {
        return;
      }
      const webview = webviewRef.current;
      if (!webview) {
        // webview 不可用：降级纯 URL 引用（不抛错）。
        dispatchSnapshotResult(detail.requestId, undefined);
        return;
      }
      void collectWebSnapshot(webview, detail.url).then(
        (snapshot) => dispatchSnapshotResult(detail.requestId, snapshot),
        () => dispatchSnapshotResult(detail.requestId, undefined),
      );
    };

    window.addEventListener(WEB_SNAPSHOT_REQUEST_EVENT, handleSnapshotRequest);
    return () => {
      window.removeEventListener(
        WEB_SNAPSHOT_REQUEST_EVENT,
        handleSnapshotRequest,
      );
    };
  }, [instanceId]);

  // 右侧面板 tab 非激活时 webview 静音,避免后台页面持续播放音频/占用
  // 音频设备(对齐 Chrome 后台标签页行为);激活时恢复声音。
  useEffect(() => {
    applyMutedState();
  }, [isActive, applyMutedState]);

  const handleNavigate = (rawInput?: string): void => {
    const input = (rawInput ?? addressInput).trim();
    if (!input) {
      return;
    }
    const url = normalizeUrl(input, homepageRef.current);
    // 地址栏即时回显输入值（即使未命中导航也保持所见即所得）。
    setAddressInput(url);
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    if (url === src) {
      // Same URL — src won't change, so explicitly reload.
      webview.reload();
    } else {
      // Different URL — updating src triggers navigation via the webview's
      // attribute observer. We intentionally do NOT call loadURL() directly
      // here, as that would race with the src-triggered navigation and cause
      // spurious ERR_ABORTED errors via GUEST_VIEW_MANAGER_CALL.
      setSrc(url);
    }
  };

  const handleAddressChange = (value: string): void => {
    setAddressInput(value);
  };

  const handleAddressKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (e.key !== "Enter") {
      return;
    }
    // 中文输入法等 IME 组合输入期间按 Enter 是「确认候选词」而非提交：
    // 此时 keydown 的 isComposing 为 true（部分平台 keyCode 为 229），
    // 必须忽略，否则候选词还没上屏就触发导航，输入的内容直接丢失。
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }
    e.preventDefault();
    handleNavigate();
  };

  const handleBack = (): void => {
    const webview = webviewRef.current;
    if (webview && webview.canGoBack()) {
      webview.goBack();
    }
  };

  const handleForward = (): void => {
    const webview = webviewRef.current;
    if (webview && webview.canGoForward()) {
      webview.goForward();
    }
  };

  const handleReload = (): void => {
    webviewRef.current?.reload();
  };

  const handleClearCache = async (): Promise<void> => {
    try {
      await window.snow.clearBrowserCache();
    } catch (error) {
      console.error("Failed to clear browser cache:", error);
    }
    // Reload ignoring cache so the effect is immediately visible.
    webviewRef.current?.reloadIgnoringCache();
  };

  const handleClearCookies = async (): Promise<void> => {
    try {
      await window.snow.clearBrowserCookies();
    } catch (error) {
      console.error("Failed to clear browser cookies:", error);
    }
    webviewRef.current?.reload();
  };

  // 跳转到浏览器设置页（起始页 / 密码管理 / 用户脚本 / 导入）。
  const handleOpenSettings = (): void => {
    window.dispatchEvent(
      new CustomEvent(APP_CONTROL_OPEN_SETTINGS_EVENT, {
        detail: { view: "browser-settings" },
      }),
    );
  };

  // 独立窗口「还原为标签页」：把当前页面（URL + 标题）连同 instanceId 经
  // 主进程转发给主窗口 RightPanel，恢复为右侧面板浏览器 tab（保持实例
  // id，MCP 路由不受影响），随后主进程关闭本独立窗口。
  const handleRestoreToTabs = useCallback((): void => {
    window.snow.restoreBrowserToMainWindow({
      instanceId,
      url: addressInput || src,
      title,
    });
  }, [instanceId, addressInput, src, title]);

  const applyZoom = (next: number): void => {
    setZoomFactor(next);
    webviewRef.current?.setZoomFactor(next);
  };

  const handleZoomIn = (): void => {
    const next = Math.min(Math.round((zoomFactor + 0.1) * 100) / 100, 5);
    applyZoom(next);
  };

  const handleZoomOut = (): void => {
    const next = Math.max(Math.round((zoomFactor - 0.1) * 100) / 100, 0.25);
    applyZoom(next);
  };

  const handleZoomReset = (): void => {
    applyZoom(1);
  };

  const handleSetDeviceSize = useCallback(
    (id: string): void => {
      void setDeviceSize(id);
    },
    [setDeviceSize],
  );

  const handleForceReload = (): void => {
    webviewRef.current?.reloadIgnoringCache();
  };

  const handleOpenDevTools = (): void => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    void window.snow
      .openBrowserDevTools(webview.getWebContentsId())
      .catch((error) => {
        console.error("Failed to open browser DevTools:", error);
      });
  };

  const handleOpenFind = (): void => {
    setFindVisible(true);
  };

  const handleFindSearch = (text: string): void => {
    setFindText(text);
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    if (text) {
      webview.findInPage(text);
    } else {
      webview.stopFindInPage("clearSelection");
      setFindResult(null);
    }
  };

  const handleFindNext = (): void => {
    if (!findText) {
      return;
    }
    webviewRef.current?.findInPage(findText, {
      forward: true,
      findNext: true,
    });
  };

  const handleFindPrev = (): void => {
    if (!findText) {
      return;
    }
    webviewRef.current?.findInPage(findText, {
      forward: false,
      findNext: true,
    });
  };

  const handleFindClose = (): void => {
    webviewRef.current?.stopFindInPage("clearSelection");
    setFindVisible(false);
    setFindText("");
    setFindResult(null);
  };

  // allowpopups 是必须的：webview guest 默认 disablePopups=true，所有
  // window.open / target=_blank 都会被 Chromium 直接拦截（window.open
  // 返回 null），不会到达主进程 setWindowOpenHandler。放行后由主进程
  // browserPopupWindow 分流：窗口级弹出（OAuth 等带 features 的）创建
  // 真实弹出窗体；标签页级打开经 browser:open-tab IPC 回到这里，经
  // onOpenNewTab 请求上层新建浏览器 tab（target=_blank 链接点击因
  // electron#30886 由 guest preload 拦截中继，见 browserPopupWindow.ts）。
  //
  // 注意：必须写字符串 "true" 而非布尔值！React 18 对未知 boolean 属性
  // （allowpopups 不在 React 白名单）会丢弃并仅打印告警，导致 guest 保持
  // disablePopups=true（实测 DOM 上 hasAttribute 为 false）。
  return (
    <div className="browser-panel">
      <BrowserToolbar
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={isLoading}
        canPickElement={!isLoading && !!src}
        addressInput={addressInput}
        isCapturing={isCapturing}
        isPickingElement={isPicking}
        onAddressChange={handleAddressChange}
        onAddressKeyDown={handleAddressKeyDown}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onScreenshot={captureScreenshot}
        onToggleElementPicker={togglePicker}
        zoomFactor={zoomFactor}
        homepage={homepage}
        deviceSizeId={deviceSizeId}
        onClearCache={handleClearCache}
        onClearCookies={handleClearCookies}
        onOpenSettings={handleOpenSettings}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onForceReload={handleForceReload}
        onFindInPage={handleOpenFind}
        onOpenDevTools={handleOpenDevTools}
        onSetHomepage={setHomepage}
        onSetDeviceSize={handleSetDeviceSize}
        onRestoreToTabs={detached ? handleRestoreToTabs : undefined}
        downloads={downloads}
        onDownloadOpen={handleDownloadOpen}
        onDownloadShowInFolder={handleDownloadShowInFolder}
        onDownloadCancel={handleDownloadCancel}
      />
      <BrowserBookmarksBar
        activeUrl={addressInput || src}
        activeTitle={title}
        onNavigate={(url) => handleNavigate(url)}
      />
      <div
        className={`browser-content${activeDeviceSize ? " has-device-size" : ""}`}
        ref={browserContentRef}
        style={
          activeDeviceSize
            ? ({
                "--device-size-width": `${activeDeviceSize.width}px`,
                "--device-size-height": `${activeDeviceSize.height}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        <webview
          ref={handleWebviewRef}
          src={src}
          className="browser-webview"
          preload={window.snow.browserWebviewPreloadPath}
          webpreferences="sandbox=no,contextIsolation=yes,nodeIntegration=no"
        />
        {pickerAnchor && picked && (
          <BrowserElementPicker
            anchorLeft={pickerAnchor.left}
            anchorTop={pickerAnchor.top}
            anchorWidth={pickerAnchor.width}
            anchorHeight={pickerAnchor.height}
            element={picked}
            onConfirm={confirmPicker}
            onCancel={cancelPicker}
            onStyleChange={applyElementStyle}
          />
        )}
        {findVisible && (
          <BrowserFindBar
            value={findText}
            result={findResult}
            onSearch={handleFindSearch}
            onNext={handleFindNext}
            onPrev={handleFindPrev}
            onClose={handleFindClose}
          />
        )}
      </div>
    </div>
  );
};
