import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Plus, X } from "lucide-react";
import {
  BrowserElementPicker,
  BrowserFindBar,
  type BrowserFindResult,
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
import { useI18n } from "../../i18n";
import { setWebTagDragData } from "./browserDrag";
import { extractUrlHost } from "../mainContent/chatInput/fileTagUtils";
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
   * 实例内部全部标签页快照回调（标签页增删 / 导航 / 切换激活页时触发，
   * 激活页置首）。上层（RightPanel）据此同步 BrowserTabData.tabs，
   * 供「在新窗口中打开」与「还原为标签页」迁移时完整携带。
   */
  onTabsChange?: (tabs: { url: string; title: string }[]) => void;
  /** 独立浏览器窗口模式：工具栏菜单显示「还原为标签页」（主面板 tab 内为 false/缺省） */
  detached?: boolean;
  /**
   * 实例内部标签页快照（独立窗口「还原为标签页」时携带，用于初始化多个
   * 内部标签页）。提供时优先于 initialUrl，第一个标签页为激活页。
   */
  initialTabs?: { url: string; title: string }[];
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

/** 浏览器实例内部的标签页状态（每个标签页对应一个独立 <webview>）。 */
type BrowserWebviewTab = {
  id: string;
  /** 当前加载的 URL，驱动 <webview src> 属性（仅在显式导航时更新） */
  src: string;
  /** 地址栏显示值（跟随页面内导航实时更新） */
  addressInput: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
};

const createWebviewTab = (url: string): BrowserWebviewTab => ({
  id: `browser-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  src: url,
  addressInput: url,
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: !!url,
});

/**
 * 侧边浏览器标签页维度的实现说明：
 *
 * 一个 BrowserPanelContent（右侧面板中的一个浏览器 tab）内部可包含多个
 * 标签页，每个标签页对应一个独立 <webview>（独立的历史记录 / 前进后退 /
 * 缩放，对齐 Chrome 行为）。标签页间切换只切换显示与焦点，各 webview
 * 保持挂载以保留页面状态。
 *
 * 新标签页的来源：
 * 1. 用户点击标签栏 + 按钮（打开首页）；
 * 2. guest 页面内的标签页级打开请求 —— 主进程 browserPopupWindow 判定后
 *    deny 并通过 browser:open-tab IPC 通知，这里按 guest webContents id
 *    路由到本实例后新建标签页（disposition 为 background-tab 时后台打开，
 *    不切换）。两个上报来源在此汇合：JS window.open（无 features）走主
 *    进程 setWindowOpenHandler；target=_blank 链接点击因 Electron bug
 *    （electron#30886）不触发该 handler，改由 guest preload 拦截点击经
 *    browser:guest-open-tab 中继。窗口级弹出（new-popup / 带
 *    width=height= 等 features）仍由主进程创建真实 BrowserWindow
 *    （OAuth 登录依赖 window.opener）。
 */

// ---------------------------------------------------------------------------
// C1 拖拽预览卡片（单例）：拖动浏览器标签页时以「🌐 标题 + 域名」小卡片
// 替代浏览器默认的整 tab 拖影。卡片经 setDragImage 截取为拖影位图，
// 元素以 position: fixed 定位在视口外（见 .drag-preview-card 样式），
// 不可见但仍参与渲染，可被正常截取。
// ---------------------------------------------------------------------------

const getDragPreviewCard = (
  ref: RefObject<HTMLDivElement | null>,
  title: string,
  url: string,
): HTMLDivElement | null => {
  let el = ref.current;
  if (!el) {
    el = document.createElement("div");
    el.className = "drag-preview-card";
    const icon = document.createElement("span");
    icon.className = "drag-preview-icon";
    icon.textContent = "🌐";
    const titleEl = document.createElement("span");
    titleEl.className = "drag-preview-title";
    const urlEl = document.createElement("span");
    urlEl.className = "drag-preview-url";
    el.append(icon, titleEl, urlEl);
    document.body.appendChild(el);
    ref.current = el;
  }
  const titleEl = el.querySelector<HTMLElement>(".drag-preview-title");
  const urlEl = el.querySelector<HTMLElement>(".drag-preview-url");
  if (titleEl) {
    titleEl.textContent = title;
  }
  if (urlEl) {
    urlEl.textContent = extractUrlHost(url);
  }
  return el;
};

/** 拖拽结束清理预览卡片文本（元素保持挂载复用，避免残留旧数据）。 */
const clearDragPreviewCard = (ref: RefObject<HTMLDivElement | null>): void => {
  const el = ref.current;
  if (!el) {
    return;
  }
  el.querySelector<HTMLElement>(".drag-preview-title")?.replaceChildren();
  el.querySelector<HTMLElement>(".drag-preview-url")?.replaceChildren();
};

export const BrowserPanelContent = ({
  instanceId,
  initialUrl,
  isActive,
  onTitleChange,
  onUrlChange,
  onTabsChange,
  detached = false,
  initialTabs,
}: BrowserPanelContentProps): React.JSX.Element => {
  const { t } = useI18n();
  // onTitleChange 由 RightPanel 内联传入,每次父组件 render 都是新引用。
  // 通过 ref 持有,事件监听 effect 只需依赖 instanceId,监听器只绑定一次,
  // 避免多个浏览器实例时每次父组件重渲染都反复卸载/重建 webview 监听器。
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  // onUrlChange 与 onTitleChange 同因,同样经 ref 持有。
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const { homepage, loaded, setHomepage } = useBrowserHomepage();
  const homepageRef = useRef(homepage);
  homepageRef.current = homepage;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // onTabsChange 同因（父组件内联回调，引用每次 render 变化），经 ref 持有，
  // 快照同步 effect 无需依赖它，避免每次父组件重渲染都重新绑定。
  const onTabsChangeRef = useRef(onTabsChange);
  onTabsChangeRef.current = onTabsChange;

  // 初始标签页：显式 initialUrl 立即使用；否则 homepage 已就绪（模块启动
  // 时预读）则直接以其填充首个标签页，webview 首帧即加载预设起始页；
  // 尚未就绪时 src 留空，等 homepage 加载完成后的 effect 补导航兜底。
  // 独立窗口「还原为标签页」时携带 initialTabs（实例内全部标签页快照），
  // 优先于 initialUrl，逐个重建内部标签页，第一个为激活页。
  const initialTabIdRef = useRef<string>(
    `browser-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [webviewTabs, setWebviewTabs] = useState<BrowserWebviewTab[]>(() => {
    const snapshotTabs = initialTabs?.filter((tab) => tab.url.trim());
    if (snapshotTabs && snapshotTabs.length > 0) {
      return snapshotTabs.map((tab, index) => ({
        id:
          index === 0
            ? initialTabIdRef.current
            : `browser-tab-${Date.now()}-${index}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
        src: tab.url,
        addressInput: tab.url,
        title: tab.title ?? "",
        canGoBack: false,
        canGoForward: false,
        isLoading: true,
      }));
    }
    const startUrl = initialUrl
      ? normalizeUrl(initialUrl, homepage)
      : loaded && homepage
        ? homepage
        : "";
    return [
      {
        id: initialTabIdRef.current,
        src: startUrl,
        addressInput: startUrl,
        title: "",
        canGoBack: false,
        canGoForward: false,
        isLoading: !!startUrl,
      },
    ];
  });
  const [activeWebviewTabId, setActiveWebviewTabId] = useState<string>(
    initialTabIdRef.current,
  );
  const activeWebviewTabIdRef = useRef<string>(initialTabIdRef.current);
  // 事件监听器通过 ref 读取最新标签页数据，避免反复重绑监听器。
  const webviewTabsRef = useRef(webviewTabs);
  webviewTabsRef.current = webviewTabs;
  // tabId -> webview 元素（所有标签页保持挂载以保留页面状态）。
  const webviewElementsRef = useRef<Map<string, Electron.WebviewTag>>(
    new Map(),
  );
  // guest webContents id -> tabId，用于把主进程 browser:open-tab 事件
  // 路由到发起请求的那个 webview 所属的浏览器实例。
  const webviewGuestIdToTabIdRef = useRef<Map<number, string>>(new Map());
  // 当前激活标签页的 webview（工具栏操作 / MCP / 截图 / 元素选择都作用于它）。
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const consoleMessagesRef = useRef<unknown[]>([]);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [findVisible, setFindVisible] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  // 下载列表（webview JS 弹窗走 Electron 原生对话框，无需自绘）。
  const [downloads, setDownloads] = useState<BrowserDownloadItemEvent[]>([]);
  const browserContentRef = useRef<HTMLDivElement>(null);
  // C1 拖拽预览卡片单例（挂载于 document.body，跨拖拽复用，卸载时移除）。
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  // 卸载时移除拖拽预览卡片，避免残留到 document.body。
  useEffect(() => {
    return () => {
      dragPreviewRef.current?.remove();
      dragPreviewRef.current = null;
    };
  }, []);
  const { isCapturing, feedback, captureScreenshot } =
    useWebviewScreenshot(webviewRef);
  const {
    isPicking,
    picked,
    togglePicker,
    cancelPicker,
    confirmPicker,
    applyElementStyle,
  } = useWebviewElementPicker(webviewRef);
  // picked 状态的 ref 镜像：快照请求监听器只绑定一次，经 ref 读取最新值，
  // 避免闭包捕获到旧的 picked（参考 webviewTabsRef 的 ref 模式）。
  const pickedRef = useRef<PickedElement | null>(null);
  pickedRef.current = picked;

  const activeTab =
    webviewTabs.find((tab) => tab.id === activeWebviewTabId) ?? webviewTabs[0];

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

  const updateWebviewTab = useCallback(
    (
      tabId: string,
      updater: (tab: BrowserWebviewTab) => BrowserWebviewTab,
    ): void => {
      setWebviewTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
      );
    },
    [],
  );

  /**
   * 静音状态对齐 Chrome 后台标签页：仅当右侧面板 tab 激活且该标签页为
   * 当前激活标签页时才允许出声，其余全部静音（避免多个浏览器实例/标签页
   * 同时播放音频）。webview 方法要求 guest 已 dom-ready，未就绪会抛异常，
   * 调用方需 try/catch；dom-ready 事件里也会补一次。
   */
  const applyMutedState = useCallback((): void => {
    const mutedForTab = (tabId: string): boolean =>
      !isActiveRef.current || tabId !== activeWebviewTabIdRef.current;
    for (const [tabId, webview] of webviewElementsRef.current) {
      try {
        webview.setAudioMuted(mutedForTab(tabId));
      } catch {
        // guest 尚未就绪(dom-ready 未触发),等待 dom-ready 后重试。
      }
    }
  }, []);

  /**
   * 为某个标签页的 webview 绑定事件监听（元素挂载时调用一次）。
   * 所有 handler 通过 refs 读取最新状态，闭包仅捕获 tabId 与 webview。
   */
  const attachWebviewListeners = useCallback(
    (webview: Electron.WebviewTag, tabId: string): void => {
      const handleDomReady = (): void => {
        try {
          // 注册 guest id -> tabId 映射：主进程 browser:open-tab 事件按此路由。
          webviewGuestIdToTabIdRef.current.set(
            webview.getWebContentsId(),
            tabId,
          );
        } catch {
          // guest 尚未就绪，忽略。
        }
        // guest 就绪后补一次静音设置（挂载时 setAudioMuted 可能抛异常）。
        applyMutedState();
      };

      const handleNavigationStateUpdate = (): void => {
        const canGoBack = webview.canGoBack();
        const canGoForward = webview.canGoForward();
        updateWebviewTab(tabId, (tab) => ({ ...tab, canGoBack, canGoForward }));
      };

      // did-navigate fires for every navigation including server-side redirects
      // and in-page pushState. We update the address bar for display but
      // deliberately do NOT update tab.src — changing src would trigger a
      // fresh loadURL via the webview attribute observer, re-triggering the
      // redirect and creating an infinite loop (e.g. Cloudflare challenges).
      const handleDidNavigate = (e: Electron.DidNavigateEvent): void => {
        // 导航成功（含重定向目标、页面内 pushState）后清除失败状态，
        // 使 screenshot 等 MCP 操作恢复正常执行。
        recordMainFrameNavigationSuccess(tabId, e.url);
        updateWebviewTab(tabId, (tab) => ({ ...tab, addressInput: e.url }));
        handleNavigationStateUpdate();
        // 仅激活标签页驱动工具栏状态与上层（RightPanel tab 标题/URL）同步。
        if (tabId === activeWebviewTabIdRef.current) {
          // Keep the menu's zoom display in sync with the webview's actual zoom
          // (Electron persists zoom per webContents across navigations).
          setZoomFactor(webview.getZoomFactor());
          // 上报最新 URL，供 RightPanel 同步 tab.data.url（拖拽引用需要实时地址）
          onUrlChangeRef.current?.(e.url);
        }
      };

      const handleDidStartLoading = (): void => {
        updateWebviewTab(tabId, (tab) => ({ ...tab, isLoading: true }));
      };

      const handleDidStopLoading = (): void => {
        updateWebviewTab(tabId, (tab) => ({ ...tab, isLoading: false }));
        handleNavigationStateUpdate();
      };

      const handlePageTitleUpdated = (
        e: Electron.PageTitleUpdatedEvent,
      ): void => {
        updateWebviewTab(tabId, (tab) => ({ ...tab, title: e.title }));
        if (tabId === activeWebviewTabIdRef.current && e.title) {
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
          tabId,
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
    [updateWebviewTab, applyMutedState],
  );

  /**
   * 所有 webview 共用的稳定 ref callback（React 重渲染时函数引用不变，
   * 不会触发 detach/attach，监听器只绑定一次）。tabId 通过 data-tab-id
   * 属性读取，避免为每个 tab 生成独立闭包。
   */
  const handleWebviewRef = useCallback(
    (el: Electron.WebviewTag | null): void => {
      const webview = el as unknown as Electron.WebviewTag | null;
      if (!webview) {
        return;
      }
      const tabId = (webview as HTMLElement).dataset.tabId;
      if (!tabId) {
        return;
      }
      // allowpopups 必须为字符串属性：React 18 对未知 boolean 属性
      // （allowpopups 不在 React 白名单）会丢弃并仅告警，而 Electron
      // 类型声明又将其标为 boolean，无法在 JSX 中直接写字符串。
      // 在元素挂载时（早于 guest attach）通过 DOM API 写入，否则
      // guest 保持 disablePopups=true，所有 window.open 被拦截。
      webview.setAttribute("allowpopups", "true");
      const isNew = !webviewElementsRef.current.has(tabId);
      webviewElementsRef.current.set(tabId, webview);
      if (isNew) {
        attachWebviewListeners(webview, tabId);
      }
      if (tabId === activeWebviewTabIdRef.current) {
        webviewRef.current = webview;
      }
    },
    [attachWebviewListeners],
  );

  // homepage 加载完成后（且没有显式 initialUrl / initialTabs），让第一个
  // 标签页导航到真实首页。useState 只评估一次初始值，迟到的 homepage 必须
  // 在此补上。还原场景已携带显式标签页，无需补导航。
  useEffect(() => {
    if (!loaded || initialUrl || (initialTabs && initialTabs.length > 0)) {
      return;
    }
    const url = normalizeUrl(homepage || DEFAULT_BROWSER_HOMEPAGE, homepage);
    setWebviewTabs((prev) => {
      const first = prev[0];
      if (!first || first.src) {
        return prev;
      }
      return [{ ...first, src: url, addressInput: url, isLoading: true }];
    });
  }, [loaded, initialUrl, homepage, initialTabs]);

  // 新增标签页。activate=false 时在后台打开（background-tab，如 Ctrl+点击）。
  const addWebviewTab = (url: string, activate: boolean): string => {
    const normalized = normalizeUrl(url, homepageRef.current);
    const newTab = createWebviewTab(normalized);
    setWebviewTabs((prev) => [...prev, newTab]);
    if (activate) {
      activeWebviewTabIdRef.current = newTab.id;
      setActiveWebviewTabId(newTab.id);
      // 新 webview 挂载后 ref callback 会依据 activeWebviewTabIdRef 接管。
      webviewRef.current = null;
      applyMutedState();
    }
    return newTab.id;
  };

  const handleNewWebviewTab = (): void => {
    addWebviewTab(homepageRef.current || DEFAULT_BROWSER_HOMEPAGE, true);
  };

  // 主进程 browser:open-tab：guest 内的标签页级打开请求（JS window.open
  // 无 features 走 setWindowOpenHandler；target=_blank 链接点击经 guest
  // preload 拦截 + browser:guest-open-tab 中继）。按 guest webContents id
  // 路由：属于本实例的 webview 发起时才在此新建标签页（弹出窗口内的
  // 请求不会命中注册表）。
  useEffect(() => {
    return window.snow.onBrowserOpenTab((event) => {
      const tabId = webviewGuestIdToTabIdRef.current.get(
        event.guestWebContentsId,
      );
      if (!tabId) {
        return;
      }
      addWebviewTab(event.url, event.disposition !== "background-tab");
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

  // MCP 命令桥：页面级操作（navigate/click/devtools 等）作用于「当前激活
  // 标签页」的 webview（对齐浏览器语义）；标签页级操作（open_tab /
  // list_tabs / close_tab / focus_tab / get_tab_content）在此直接处理。
  useEffect(() => {
    const unregister = registerBrowserMcpInstance(
      instanceId,
      async (operation, args) => {
        // 标签页维度操作：与具体页面无关，优先于页面级操作处理。
        switch (operation) {
          case "open_tab": {
            const rawUrl = typeof args.url === "string" ? args.url : "";
            const url = normalizeUrl(rawUrl, homepageRef.current);
            const tabId = addWebviewTab(url, true);
            return { tabId, url, activated: true };
          }
          case "list_tabs": {
            return {
              tabs: webviewTabsRef.current.map((tab) => ({
                tabId: tab.id,
                title: tab.title,
                url: tab.src || tab.addressInput,
                isActive: tab.id === activeWebviewTabIdRef.current,
              })),
              totalTabs: webviewTabsRef.current.length,
            };
          }
          case "close_tab": {
            const tabId = typeof args.tabId === "string" ? args.tabId : "";
            if (!tabId) {
              throw new Error("tabId is required for browser-close_tab");
            }
            if (!webviewTabsRef.current.some((tab) => tab.id === tabId)) {
              throw new Error(`Browser tab was not found: ${tabId}`);
            }
            handleCloseWebviewTab(tabId);
            return { tabId, closed: true };
          }
          case "focus_tab": {
            const tabId = typeof args.tabId === "string" ? args.tabId : "";
            if (!tabId) {
              throw new Error("tabId is required for browser-focus_tab");
            }
            if (!webviewTabsRef.current.some((tab) => tab.id === tabId)) {
              throw new Error(`Browser tab was not found: ${tabId}`);
            }
            handleActivateWebviewTab(tabId);
            return { tabId, focused: true };
          }
          case "get_tab_content": {
            const webview = webviewRef.current;
            if (!webview) {
              throw new Error("浏览器当前没有可操作的激活标签页");
            }
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
        }

        const webview = webviewRef.current;
        if (!webview) {
          throw new Error("浏览器当前没有可操作的激活标签页");
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
      // 实例卸载时清理其累积的路由规则,避免残留规则影响其他实例。
      clearBrowserRouteRulesForInstance(instanceId);
      // 同时清理本实例所有标签页的导航状态。
      for (const tabId of webviewElementsRef.current.keys()) {
        clearBrowserNavigationState(tabId);
      }
    };
  }, [instanceId]);

  useEffect(() => {
    if (isActive) {
      focusBrowserMcpInstance(instanceId);
    }
  }, [instanceId, isActive]);

  // F4 网页快照提供方：接收输入框拖入标签页后的快照请求，对目标 webview
  // 完成三层提取（整页正文 / 元素区域 / 可视区截图）后回发结果事件。
  // 请求-响应均走全局 CustomEvent：多浏览器实例按 instanceId 分流，
  // 标签页按 tabId 定位（外层 RightPanel tab 拖入无 tabId → 激活标签页兜底）。
  // 监听器只绑定一次，状态一律经 ref 读取（webviewElementsRef /
  // activeWebviewTabIdRef / pickedRef），避免闭包过期。任一环节失败都
  // 静默降级（回发 snapshot=undefined），不抛异常、不打断拖入流程。
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
      tabId: string,
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

      // ② 元素区域：picked 由激活标签页的 webview 产生（webviewRef 指向它），
      // 仅当请求的正是激活标签页时才附带，避免快照错串到其他标签页。
      let elementText: string | undefined;
      let elementSelector: string | undefined;
      const picked = pickedRef.current;
      if (picked && tabId === activeWebviewTabIdRef.current) {
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
      // 多浏览器实例并存：只响应属于本实例的快照请求。
      if (detail.instanceId !== instanceId) {
        return;
      }
      // 外层 RightPanel tab 拖入时无 tabId → 以本实例激活标签页兜底。
      const tabId = detail.tabId || activeWebviewTabIdRef.current;
      const webview = webviewElementsRef.current.get(tabId) ?? null;
      if (!webview) {
        // 标签页已关闭 / webview 不可用：降级纯 URL 引用（不抛错）。
        dispatchSnapshotResult(detail.requestId, undefined);
        return;
      }
      void collectWebSnapshot(webview, detail.url, tabId).then(
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

  // 非激活 tab 的 webview 静音,避免多个浏览器实例时后台页面持续播放
  // 音频/占用音频设备(对齐 Chrome 后台标签页行为);激活时恢复声音。
  // 切换内部标签页 / 右侧面板 tab 激活状态变化时重新应用。
  useEffect(() => {
    applyMutedState();
  }, [isActive, activeWebviewTabId, applyMutedState]);

  const handleActivateWebviewTab = (tabId: string): void => {
    if (tabId === activeWebviewTabIdRef.current) {
      return;
    }
    // 切换标签页时退出元素选择模式，避免注入脚本/高亮残留在旧页面。
    cancelPicker();
    activeWebviewTabIdRef.current = tabId;
    setActiveWebviewTabId(tabId);
    const webview = webviewElementsRef.current.get(tabId) ?? null;
    webviewRef.current = webview;
    applyMutedState();
    setZoomFactor(webview ? webview.getZoomFactor() : 1);
    webview?.focus();
    // 上报新激活标签页的标题与 URL，保持 RightPanel tab 数据同步。
    const tab = webviewTabsRef.current.find((item) => item.id === tabId);
    if (tab) {
      onTitleChangeRef.current?.(tab.title);
      if (tab.src) {
        onUrlChangeRef.current?.(tab.src);
      }
    }
  };

  const handleCloseWebviewTab = (tabId: string): void => {
    // 清理 guest id 与元素注册（webview 元素随 React 卸载销毁）。
    for (const [guestId, mappedTabId] of webviewGuestIdToTabIdRef.current) {
      if (mappedTabId === tabId) {
        webviewGuestIdToTabIdRef.current.delete(guestId);
      }
    }
    webviewElementsRef.current.delete(tabId);
    clearBrowserNavigationState(tabId);

    const tabsBefore = webviewTabsRef.current;
    const index = tabsBefore.findIndex((tab) => tab.id === tabId);
    const wasActive = activeWebviewTabIdRef.current === tabId;
    const remaining = tabsBefore.filter((tab) => tab.id !== tabId);

    if (remaining.length === 0) {
      // 关闭最后一个标签页：新建一个首页标签页（对齐 Chrome 行为）。
      const url = normalizeUrl(homepageRef.current, homepageRef.current);
      const newTab = createWebviewTab(url);
      setWebviewTabs([newTab]);
      activeWebviewTabIdRef.current = newTab.id;
      setActiveWebviewTabId(newTab.id);
      webviewRef.current = null;
      applyMutedState();
      return;
    }

    setWebviewTabs(remaining);

    if (wasActive) {
      // 激活左侧相邻标签页；没有则右侧相邻（与原位置 index 对齐）。
      const nextActive = remaining[index - 1] ?? remaining[index];
      activeWebviewTabIdRef.current = nextActive.id;
      setActiveWebviewTabId(nextActive.id);
      const webview = webviewElementsRef.current.get(nextActive.id) ?? null;
      webviewRef.current = webview;
      applyMutedState();
      setZoomFactor(webview ? webview.getZoomFactor() : 1);
      webview?.focus();
      onTitleChangeRef.current?.(nextActive.title);
      if (nextActive.src) {
        onUrlChangeRef.current?.(nextActive.src);
      }
    }
  };

  const handleNavigate = (rawInput?: string): void => {
    const currentTab = webviewTabsRef.current.find(
      (tab) => tab.id === activeWebviewTabIdRef.current,
    );
    if (!currentTab) {
      return;
    }
    const input = (rawInput ?? currentTab.addressInput).trim();
    if (!input) {
      return;
    }
    const url = normalizeUrl(input, homepageRef.current);
    const webview = webviewRef.current;
    // 地址栏即时回显输入值（即使未命中导航也保持所见即所得）。
    updateWebviewTab(currentTab.id, (tab) => ({ ...tab, addressInput: url }));
    if (!webview) {
      return;
    }
    if (url === currentTab.src) {
      // Same URL — src won't change, so explicitly reload.
      webview.reload();
    } else {
      // Different URL — updating src triggers navigation via the webview's
      // attribute observer. We intentionally do NOT call loadURL() directly
      // here, as that would race with the src-triggered navigation and cause
      // spurious ERR_ABORTED errors via GUEST_VIEW_MANAGER_CALL.
      updateWebviewTab(currentTab.id, (tab) => ({ ...tab, src: url }));
    }
  };

  const handleAddressChange = (value: string): void => {
    updateWebviewTab(activeWebviewTabIdRef.current, (tab) => ({
      ...tab,
      addressInput: value,
    }));
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

  // 实例内部全部标签页的快照（激活页置首，其余保持原有顺序）。
  // 供「在新窗口中打开」与「还原为标签页」迁移时完整携带标签页状态，
  // 上层还原/重建时第一个标签页即激活页。
  const buildTabsSnapshot = useCallback((): {
    url: string;
    title: string;
  }[] => {
    const activeId = activeWebviewTabIdRef.current;
    const tabs = webviewTabsRef.current;
    const active = tabs.find((tab) => tab.id === activeId);
    const rest = tabs.filter((tab) => tab.id !== activeId);
    return [...(active ? [active] : []), ...rest].map((tab) => ({
      url: tab.src || tab.addressInput,
      title: tab.title,
    }));
  }, []);

  // 标签页增删 / 导航 / 切换激活页时向上层同步快照（父组件经
  // BrowserTabData.tabs 持久化，供窗口迁移时携带）。
  useEffect(() => {
    onTabsChangeRef.current?.(buildTabsSnapshot());
  }, [webviewTabs, activeWebviewTabId, buildTabsSnapshot]);

  // 独立窗口「还原为标签页」：把当前实例的全部内部标签页快照
  // （含激活页），连同 instanceId 经主进程转发给主窗口 RightPanel，
  // 恢复为右侧面板浏览器 tab（保持实例 id，MCP 路由不受影响），
  // 随后主进程关闭本独立窗口。
  const handleRestoreToTabs = useCallback((): void => {
    window.snow.restoreBrowserToMainWindow({
      instanceId,
      tabs: buildTabsSnapshot(),
    });
  }, [instanceId, buildTabsSnapshot]);

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
  // 真实弹出窗体；标签页级打开经 browser:open-tab IPC 回到这里新建
  // 内部标签页（target=_blank 链接点击因 electron#30886 由 guest preload
  // 拦截中继，见 browserPopupWindow.ts）。
  //
  // 注意：必须写字符串 "true" 而非布尔值！React 18 对未知 boolean 属性
  // （allowpopups 不在 React 白名单）会丢弃并仅打印告警，导致 guest 保持
  // disablePopups=true（实测 DOM 上 hasAttribute 为 false）。
  return (
    <div className="browser-panel">
      <BrowserToolbar
        canGoBack={activeTab?.canGoBack ?? false}
        canGoForward={activeTab?.canGoForward ?? false}
        isLoading={activeTab?.isLoading ?? false}
        canPickElement={!(activeTab?.isLoading ?? false) && !!activeTab?.src}
        addressInput={activeTab?.addressInput ?? ""}
        isCapturing={isCapturing}
        isPickingElement={isPicking}
        screenshotFeedback={feedback}
        onAddressChange={handleAddressChange}
        onAddressKeyDown={handleAddressKeyDown}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onScreenshot={captureScreenshot}
        onToggleElementPicker={togglePicker}
        zoomFactor={zoomFactor}
        homepage={homepage}
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
        onRestoreToTabs={detached ? handleRestoreToTabs : undefined}
        downloads={downloads}
        onDownloadOpen={handleDownloadOpen}
        onDownloadShowInFolder={handleDownloadShowInFolder}
        onDownloadCancel={handleDownloadCancel}
      />
      <div className="browser-tab-bar" role="tablist">
        {webviewTabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeWebviewTabId}
            className={`browser-tab ${
              tab.id === activeWebviewTabId ? "active" : ""
            }`}
            onClick={() => handleActivateWebviewTab(tab.id)}
            draggable={!!(tab.addressInput || tab.src)}
            onDragStart={(event) => {
              // 冒泡防护：内层标签页拖拽不得触发外层 right-panel-tab-item 的
              // onDragStart（外层会用同步 URL 覆盖内层实时 URL，导致引用错页）。
              event.stopPropagation();
              const url = tab.addressInput || tab.src;
              // 携带 instanceId + tabId：输入框 drop 后可请求本标签页的三层网页快照。
              if (
                !url ||
                !setWebTagDragData(event, url, tab.title, {
                  instanceId,
                  tabId: tab.id,
                })
              ) {
                event.preventDefault();
                return;
              }
              // C1 自定义拖影：以「🌐 标题 + 域名」预览卡片替代默认整 tab 快照
              // （偏移到卡片左边缘，跟随鼠标）。
              const preview = getDragPreviewCard(
                dragPreviewRef,
                tab.title,
                url,
              );
              if (preview) {
                event.dataTransfer.setDragImage(preview, 12, 12);
              }
            }}
            onDragEnd={() => {
              // C1：拖拽结束清理预览卡片文本（元素保持挂载复用，由卸载 effect 移除）。
              clearDragPreviewCard(dragPreviewRef);
            }}
            title={
              tab.title || tab.addressInput || t("rightPanel.browserNewTab")
            }
          >
            <span className="browser-tab-title">
              {tab.title || tab.addressInput || t("rightPanel.browserNewTab")}
            </span>
            <button
              type="button"
              className="browser-tab-close"
              aria-label={t("rightPanel.browserCloseTab")}
              onClick={(e) => {
                e.stopPropagation();
                handleCloseWebviewTab(tab.id);
              }}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="browser-tab-new"
          title={t("rightPanel.browserNewTab")}
          aria-label={t("rightPanel.browserNewTab")}
          onClick={handleNewWebviewTab}
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="browser-content" ref={browserContentRef}>
        {webviewTabs.map((tab) => (
          <webview
            key={tab.id}
            data-tab-id={tab.id}
            ref={handleWebviewRef}
            src={tab.src}
            className={`browser-webview ${
              tab.id === activeWebviewTabId ? "" : "is-hidden"
            }`}
            preload={window.snow.browserWebviewPreloadPath}
            webpreferences="sandbox=no,contextIsolation=yes,nodeIntegration=no"
          />
        ))}
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
