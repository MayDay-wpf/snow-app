import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MainContent } from "./components/MainContent";
import { RightPanel, type RightPanelRef } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { isFeaturePageView } from "./components/featurePages";
import { SETTINGS_VIEW_IDS } from "./components/sidebar/settingsItems";
import { NotificationNavigationBridge } from "./components/NotificationNavigationBridge";
import { RemoteControlBridge } from "./components/RemoteControlBridge";
import { PluginRuntimeBridge } from "./plugins/PluginRuntimeBridge";
import { ClientScriptBridge } from "./userscripts/ClientScriptBridge";
import {
  ChatConversationProvider,
  useChatConversationContext,
} from "./components/mainContent/chatMessages";
import type { MainContentView } from "./components/mainContent/types";
import { SshConnectWizard } from "./components/sidebar/mainSidebar/SshConnectWizard";
import { ConfirmDialog } from "./components/common/ConfirmDialog";
import { AppLockOverlay } from "./components/AppLockOverlay";
import { ShortcutHelpOverlay } from "./components/ShortcutHelpOverlay";
import { rightPanelEvents } from "./components/rightPanel/rightPanelEvents";
import {
  OPEN_PROJECT_MCP_PANEL_EVENT,
  requestOpenProjectMcpPanel,
} from "./components/mainContent/chatInput/projectMcpNavigation";
import { OPEN_REPO_WIKI_EVENT } from "./components/repoWiki/repoWikiNavigation";
import {
  KeyboardShortcutsProvider,
  useKeyboardShortcutsSettings,
} from "./components/KeyboardShortcutsProvider";
import { shortcutEvents } from "./components/shortcutEvents";
import {
  ensureMessageTimeVisibilityLoaded,
  toggleMessageTimeVisible,
} from "./components/mainContent/chatMessages/utils/messageTimeVisibility";
import { useAppControl } from "./hooks/useAppControl";
import { setActiveSshWorkspace } from "./ssh/sshConnectionStore";
import { CONVERSATION_SELECTED_EVENT } from "./components/mainContent/chatMessages/hooks/useConversationManagement";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useI18n } from "./i18n";
import { useTheme } from "./hooks/useTheme";
import {
  readPanelCollapsedState,
  writePanelCollapsedState,
} from "./utils/layoutPanelState";
import { ThemeBackgroundPetLayer } from "./components/pet/ThemeBackgroundPetLayer";
import { ThemeBackgroundImageLayer } from "./components/sidebar/themeSettings/ThemeBackgroundImageLayer";
import { adjustUiFontSize, resetUiFontSize } from "./utils/uiZoom";
import { installToolCardStyleShortcut } from "./utils/toolCardStyle";
import { hasCustomWindowFrame } from "./utils/platform";
import {
  CLOSE_BEHAVIOR_SETTING_CODE,
  CLOSE_BEHAVIOR_SETTING_NAME,
} from "./constants/closeBehavior";
import type { WorkspaceDirectoryRecord } from "../preload";

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 248;
const RIGHT_PANEL_MIN_WIDTH = 280;
const RIGHT_PANEL_MAX_WIDTH = 640;
const RIGHT_PANEL_DEFAULT_WIDTH = 320;
// 右面板拖宽越过最大宽度此距离进入"待全屏区"，持续拖拽保持 500ms 后出现
// 遮罩提示；此后不回拉、松开鼠标即进入全屏。
const RIGHT_PANEL_FULLSCREEN_OVERDRAG = 56;
const RIGHT_PANEL_FULLSCREEN_DWELL_MS = 500;
// 拖窄越过最小宽度此距离并停留后自动收起面板；未松手回拉到展开阈值内即重新展开。
const PANEL_COLLAPSE_OVERDRAG = 40;
const PANEL_EXPAND_OVERDRAG = 24;
const PANEL_COLLAPSE_DWELL_MS = 220;
// 拖拽中收起/展开时临时恢复 CSS 过渡的时长。
const PANEL_TOGGLE_TRANSITION_MS = 200;
// 拖拽中收起后分隔条需清零的占位属性。
const RESIZER_HOLD_PROPERTIES = [
  "width",
  "min-width",
  "margin-left",
  "margin-right",
] as const;
const MAIN_CONTENT_MIN_WIDTH = 420;
// 窗口内容宽度 ≤ 此值时视为手机尺寸：自动收起两侧面板，聊天区独占窗口。
const MOBILE_BREAKPOINT = 720;
const PANEL_RESIZER_WIDTH = 10;
// 自动展开的滞回余量：拉宽到收起阈值以上再多出此宽度才恢复展开，
// 避免用户在阈值附近来回拖动时面板反复收起/展开。
const AUTO_EXPAND_MARGIN = 80;
const APP_LAYOUT_HORIZONTAL_PADDING = 20;
const APP_LAYOUT_GAP_TOTAL = 20;

/**
 * 勾选「不再询问」时先把行为写入设置（须等待落库完成，退出会中断 IPC），
 * 再执行后续动作；写入失败不阻断退出/最小化，仅保持询问。
 */
const persistCloseBehaviorThen = (
  behavior: "exit" | "minimize",
  proceed: () => void,
): void => {
  void window.snow
    .setSystemSetting(
      CLOSE_BEHAVIOR_SETTING_NAME,
      CLOSE_BEHAVIOR_SETTING_CODE,
      behavior,
    )
    .catch(() => undefined)
    .then(() => proceed());
};

type ResizeTarget = "sidebar" | "right-panel";

/**
 * 主进程 globalShortcut 触发的动作 → shortcutEvents 事件名映射。
 * 与 ShortcutHandlerBridge 中 registerHandler 的 emit 保持一致。
 */
const GLOBAL_ACTION_EVENTS: Record<
  string,
  Parameters<typeof shortcutEvents.emit>[0]
> = {
  cancelSession: "stop-generation",
  openSearch: "toggle-search",
  openMemo: "toggle-memo",
  openTodo: "toggle-todo",
  cycleProject: "cycle-project",
  openProjectExplorer: "open-project-explorer",
  openProjectMemory: "toggle-project-memory",
  openScheduledTasks: "toggle-scheduled-tasks",
  openPlugins: "toggle-plugins",
  cycleApiProfile: "open-api-profile-menu",
  togglePet: "toggle-pet",
  focusInput: "focus-chat-input",
  toggleSidebar: "toggle-sidebar",
  toggleRightPanel: "toggle-right-panel",
  newChat: "new-chat",
  newChatInNewWindow: "new-chat-in-new-window",
  sendMessage: "send-message",
  stopGeneration: "stop-generation",
  prevConversation: "prev-conversation",
  nextConversation: "next-conversation",
  scrollToTop: "scroll-to-top",
  scrollToBottom: "scroll-to-bottom",
  copyLastResponse: "copy-last-response",
  openSettings: "open-settings",
  toggleRightPanelFullscreen: "toggle-right-panel-fullscreen",
  showShortcutHelp: "show-shortcut-help",
  toggleMessageTime: "toggle-message-time",
  uiZoomIn: "ui-zoom-in",
  uiZoomOut: "ui-zoom-out",
  uiZoomReset: "ui-zoom-reset",
};

type PanelSizeStyle = CSSProperties & {
  "--sidebar-width": string;
  "--right-panel-width": string;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * 快捷键处理器桥接组件。
 *
 * 此组件运行在 KeyboardShortcutsProvider 和 ChatConversationProvider 内部，
 * 负责：
 * 1. 调用 useKeyboardShortcuts() 启动 document keydown 监听
 * 2. 注册快捷键动作的处理器：
 *    - cancelSession / stopGeneration：直接调用 handleAbort
 *    - openSearch / openMemo / openTodo / cycleProject /
 *      openProjectExplorer / cycleApiProfile / focusInput 等：通过
 *      shortcutEvents 事件总线分发到各目标组件
 *    - togglePet：读取宠物设置并取反（主进程负责创建/收起宠物窗口）
 *
 * 注册通过 registerHandler 完成，handler 使用 ref 保持最新值。
 * 注：toggleWindow 不在此注册——它由主进程 globalShortcut 处理，
 * 窗口隐藏时也要能呼出，渲染进程 keydown 无法覆盖该场景。
 */
const ShortcutHandlerBridge = (): null => {
  const { registerHandler } = useKeyboardShortcutsSettings();
  const { handleAbort, streamingConversationIds } =
    useChatConversationContext();

  // 使用 ref 持有最新的 handleAbort，避免每次渲染都重新注册 handler
  const handleAbortRef = useRef(handleAbort);
  useEffect(() => {
    handleAbortRef.current = handleAbort;
  }, [handleAbort]);

  // 同步"进行中会话"数量到主进程托盘 tooltip（渲染层是流式状态的唯一持有者）。
  useEffect(() => {
    void window.snow.setTrayActiveSessions(streamingConversationIds.size);
  }, [streamingConversationIds]);

  // 工具卡风格切换：固定快捷键 mod+shift+u（不进可配置快捷键面板，
  // 界面上也不提供开关；帮助浮层里单独列出）。
  useEffect(() => installToolCardStyleShortcut(), []);

  useEffect(() => {
    const unsubCancel = registerHandler("cancelSession", () => {
      handleAbortRef.current();
    });
    const unsubStopGeneration = registerHandler("stopGeneration", () => {
      handleAbortRef.current();
    });
    const unsubSearch = registerHandler("openSearch", () => {
      shortcutEvents.emit("toggle-search");
    });
    const unsubMemo = registerHandler("openMemo", () => {
      shortcutEvents.emit("toggle-memo");
    });
    const unsubTodo = registerHandler("openTodo", () => {
      shortcutEvents.emit("toggle-todo");
    });
    const unsubCycle = registerHandler("cycleProject", () => {
      shortcutEvents.emit("cycle-project");
    });
    const unsubExplorer = registerHandler("openProjectExplorer", () => {
      shortcutEvents.emit("open-project-explorer");
    });
    const unsubProjectMemory = registerHandler("openProjectMemory", () => {
      shortcutEvents.emit("toggle-project-memory");
    });
    const unsubScheduledTasks = registerHandler("openScheduledTasks", () => {
      shortcutEvents.emit("toggle-scheduled-tasks");
    });
    const unsubPlugins = registerHandler("openPlugins", () => {
      shortcutEvents.emit("toggle-plugins");
    });
    const unsubCycleApiProfile = registerHandler("cycleApiProfile", () => {
      shortcutEvents.emit("open-api-profile-menu");
    });
    const unsubNewChat = registerHandler("newChat", () => {
      shortcutEvents.emit("new-chat");
    });
    const unsubNewChatInNewWindow = registerHandler(
      "newChatInNewWindow",
      () => {
        shortcutEvents.emit("new-chat-in-new-window");
      },
    );
    const unsubCycleDetachedWindow = registerHandler(
      "cycleDetachedWindow",
      () => {
        void window.snow.focusNextDetachedPanelWindow();
      },
    );
    const unsubSendMessage = registerHandler("sendMessage", () => {
      shortcutEvents.emit("send-message");
    });
    const unsubSendMessageNow = registerHandler("sendMessageNow", () => {
      shortcutEvents.emit("send-message-now");
    });
    const unsubPrevConversation = registerHandler("prevConversation", () => {
      shortcutEvents.emit("prev-conversation");
    });
    const unsubNextConversation = registerHandler("nextConversation", () => {
      shortcutEvents.emit("next-conversation");
    });
    const unsubScrollToTop = registerHandler("scrollToTop", () => {
      shortcutEvents.emit("scroll-to-top");
    });
    const unsubScrollToBottom = registerHandler("scrollToBottom", () => {
      shortcutEvents.emit("scroll-to-bottom");
    });
    const unsubCopyLastResponse = registerHandler("copyLastResponse", () => {
      shortcutEvents.emit("copy-last-response");
    });
    const unsubOpenSettings = registerHandler("openSettings", () => {
      shortcutEvents.emit("open-settings");
    });
    const unsubToggleRightPanelFullscreen = registerHandler(
      "toggleRightPanelFullscreen",
      () => {
        shortcutEvents.emit("toggle-right-panel-fullscreen");
      },
    );
    const unsubShowShortcutHelp = registerHandler("showShortcutHelp", () => {
      shortcutEvents.emit("show-shortcut-help");
    });
    const unsubToggleMessageTime = registerHandler("toggleMessageTime", () => {
      shortcutEvents.emit("toggle-message-time");
    });
    const unsubTogglePet = registerHandler("togglePet", () => {
      // 切换宠物启停：读取当前设置并取反，主进程 pets:set-enabled
      // 负责创建/收起宠物窗口。
      void window.snow.getPetSettings().then((petSettings) => {
        void window.snow.setPetEnabled(!petSettings.enabled);
      });
    });
    const unsubFocusInput = registerHandler("focusInput", () => {
      shortcutEvents.emit("focus-chat-input");
    });
    const unsubToggleSidebar = registerHandler("toggleSidebar", () => {
      shortcutEvents.emit("toggle-sidebar");
    });
    const unsubToggleRightPanel = registerHandler("toggleRightPanel", () => {
      shortcutEvents.emit("toggle-right-panel");
    });
    const unsubUiZoomIn = registerHandler("uiZoomIn", () => {
      adjustUiFontSize(1);
    });
    const unsubUiZoomOut = registerHandler("uiZoomOut", () => {
      adjustUiFontSize(-1);
    });
    const unsubUiZoomReset = registerHandler("uiZoomReset", () => {
      resetUiFontSize();
    });

    return () => {
      unsubCancel();
      unsubStopGeneration();
      unsubSearch();
      unsubMemo();
      unsubTodo();
      unsubCycle();
      unsubExplorer();
      unsubProjectMemory();
      unsubScheduledTasks();
      unsubPlugins();
      unsubCycleApiProfile();
      unsubNewChat();
      unsubNewChatInNewWindow();
      unsubCycleDetachedWindow();
      unsubSendMessage();
      unsubSendMessageNow();
      unsubPrevConversation();
      unsubNextConversation();
      unsubScrollToTop();
      unsubScrollToBottom();
      unsubCopyLastResponse();
      unsubOpenSettings();
      unsubToggleRightPanelFullscreen();
      unsubShowShortcutHelp();
      unsubToggleMessageTime();
      unsubTogglePet();
      unsubFocusInput();
      unsubToggleSidebar();
      unsubToggleRightPanel();
      unsubUiZoomIn();
      unsubUiZoomOut();
      unsubUiZoomReset();
    };
  }, [registerHandler]);

  // 主进程 globalShortcut 触发（仅前台生效关闭的动作）后转发到
  // 同一渲染层分发链路；toggleWindow 已在主进程直接处理。
  useEffect(() => {
    const unsubStopGeneration = shortcutEvents.on("stop-generation", () => {
      handleAbortRef.current();
    });
    const unsubTogglePet = shortcutEvents.on("toggle-pet", () => {
      void window.snow.getPetSettings().then((petSettings) => {
        void window.snow.setPetEnabled(!petSettings.enabled);
      });
    });
    const unsubToggleMessageTime = shortcutEvents.on(
      "toggle-message-time",
      () => {
        toggleMessageTimeVisible();
      },
    );
    const unsubUiZoomIn = shortcutEvents.on("ui-zoom-in", () => {
      adjustUiFontSize(1);
    });
    const unsubUiZoomOut = shortcutEvents.on("ui-zoom-out", () => {
      adjustUiFontSize(-1);
    });
    const unsubUiZoomReset = shortcutEvents.on("ui-zoom-reset", () => {
      resetUiFontSize();
    });
    void ensureMessageTimeVisibilityLoaded();
    return () => {
      unsubStopGeneration();
      unsubTogglePet();
      unsubToggleMessageTime();
      unsubUiZoomIn();
      unsubUiZoomOut();
      unsubUiZoomReset();
    };
  }, []);

  useEffect(() => {
    return window.snow.onGlobalShortcutTriggered((action) => {
      const event = GLOBAL_ACTION_EVENTS[action];
      if (event) {
        shortcutEvents.emit(event);
      }
    });
  }, []);

  // 启动快捷键引擎的 document keydown 监听
  useKeyboardShortcuts();

  return null;
};

export const App = (): React.JSX.Element => {
  const rightPanelRef = useRef<RightPanelRef>(null);
  // 布局外壳 DOM 引用：拖动面板宽度时直接操作其上的 CSS 变量，
  // 避免高频 setState 触发整棵组件树（含 GitDiffView 等重组件）重渲染。
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const [activeMainView, setActiveMainView] = useState<MainContentView>("chat");
  const [activeDirectory, setActiveDirectory] =
    useState<WorkspaceDirectoryRecord | null>(null);

  // 激活目录上报去重：不同来源（侧边栏、通知桥、远程控制等）会以新对象引用
  // 上报同一目录；保持引用不变可避免右侧面板（Git 等）因对象变更而无谓刷新，
  // 也让侧边栏显示形态切换（split/tree）不产生任何数据层副作用。
  const handleActiveDirectoryChange = useCallback(
    (directory: WorkspaceDirectoryRecord | null): void => {
      setActiveDirectory((prev) => {
        if (prev === directory) {
          return prev;
        }
        if (!prev || !directory) {
          return directory;
        }
        if (
          prev.directoryId === directory.directoryId &&
          prev.path === directory.path &&
          prev.name === directory.name &&
          prev.kind === directory.kind &&
          prev.source === directory.source &&
          prev.isActive === directory.isActive
        ) {
          return prev;
        }
        return directory;
      });
    },
    [],
  );

  // 活动 SSH 项目持有 1 个连接引用：连接状态不再随右侧面板挂载/卸载在
  // connected 与 idle 之间抖动，会话管理区看到的就是工作区真实状态。
  const activeSshWorkspacePath =
    activeDirectory?.kind === "ssh" ? activeDirectory.path : null;
  useEffect(() => {
    setActiveSshWorkspace(activeSshWorkspacePath);
    return () => {
      setActiveSshWorkspace(null);
    };
  }, [activeSshWorkspacePath]);

  // 左右面板的收起状态是全局偏好：首屏优先从 localStorage 恢复；
  // 首次使用层叠风格（尚无记忆）时沿用其右面板默认收起。
  const [initialPanelState] = useState(() => {
    const stored = readPanelCollapsedState();
    return {
      sidebar: stored?.sidebar ?? false,
      rightPanel:
        stored?.rightPanel ??
        document.documentElement.getAttribute("data-layout-style") ===
          "layered",
    };
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    initialPanelState.sidebar,
  );
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(
    initialPanelState.rightPanel,
  );
  const [isRightPanelFullscreen, setIsRightPanelFullscreen] = useState(false);
  // 拖宽右面板进入越界区后的"待全屏"状态：主内容区据此显示遮罩提醒。
  const [isRightPanelFullscreenPending, setIsRightPanelFullscreenPending] =
    useState(false);
  // 拖拽中被收起的面板：手势结束前保持分隔条挂载，避免丢失指针捕获。
  const [collapseHoldTarget, setCollapseHoldTarget] =
    useState<ResizeTarget | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [rightPanelWidth, setRightPanelWidth] = useState(
    RIGHT_PANEL_DEFAULT_WIDTH,
  );
  const [showSshWizard, setShowSshWizard] = useState(false);
  // SSH 向导取消回调：向导经合集右键「添加项目」打开时需要清理目标合集
  const sshWizardCanceledRef = useRef<(() => void) | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  // 关闭确认弹窗的「不再询问」勾选：勾选后点退出/最小化会把对应行为
  // 写入设置，之后主进程 close 拦截直接自动执行，不再弹出确认。
  const [closeNeverAskAgain, setCloseNeverAskAgain] = useState(false);

  // 运行中把布局风格切到「层叠」时，右面板无条件收起一次；之后就跟随全局记忆，
  // 由用户操作决定展开/收起，不再被风格反复打断。
  useEffect(() => {
    const root = document.documentElement;
    let previousStyle = root.getAttribute("data-layout-style") ?? "";
    const observer = new MutationObserver(() => {
      const layoutStyle = root.getAttribute("data-layout-style") ?? "";
      if (layoutStyle === previousStyle) {
        return;
      }
      previousStyle = layoutStyle;
      if (layoutStyle !== "layered") {
        return;
      }
      setIsRightPanelFullscreen(false);
      setIsRightPanelCollapsed(true);
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-layout-style"],
    });
    return () => observer.disconnect();
  }, []);

  // 面板收起状态变化后写入全局记忆（顶栏按钮、快捷键、自动收窄都会经过这里）。
  useEffect(() => {
    writePanelCollapsedState({
      sidebar: isSidebarCollapsed,
      rightPanel: isRightPanelCollapsed,
    });
  }, [isSidebarCollapsed, isRightPanelCollapsed]);

  const hasCustomFrame = hasCustomWindowFrame();
  const isMacOS = navigator.userAgent.includes("Mac");
  const { t } = useI18n();
  const { themeSettings } = useTheme();
  useAppControl({ activeDirectory, setActiveMainView });

  // 切换会话时退出非聊天主视图（如团队协作、独立页面），让主界面跟随会话回到聊天。
  useEffect(() => {
    const handler = (): void => {
      setActiveMainView("chat");
    };
    window.addEventListener(CONVERSATION_SELECTED_EVENT, handler);
    return () => {
      window.removeEventListener(CONVERSATION_SELECTED_EVENT, handler);
    };
  }, []);

  // 项目右键菜单「仓库 Wiki」：切到 Wiki 独立页面。
  useEffect(() => {
    const handleOpenWiki = (): void => {
      setActiveMainView("repo-wiki");
    };
    window.addEventListener(OPEN_REPO_WIKI_EVENT, handleOpenWiki);
    return () => {
      window.removeEventListener(OPEN_REPO_WIKI_EVENT, handleOpenWiki);
    };
  }, []);

  // 右侧面板（浏览器 / 终端）的 MCP 门禁横幅请求打开项目 MCP 弹窗：弹窗
  // 挂在聊天输入区，先切回聊天视图；独立浏览器窗口的同类请求经主进程转发，
  // 同样走这条链路（由 ChatInputView 消费 pending 标记后打开弹窗）。
  useEffect(() => {
    const handleOpenRequest = (): void => {
      setActiveMainView("chat");
    };
    window.addEventListener(OPEN_PROJECT_MCP_PANEL_EVENT, handleOpenRequest);
    const dispose = window.snow.onOpenProjectMcpRequest((serverId) =>
      requestOpenProjectMcpPanel(serverId),
    );
    return () => {
      window.removeEventListener(
        OPEN_PROJECT_MCP_PANEL_EVENT,
        handleOpenRequest,
      );
      dispose();
    };
  }, []);

  // 独立页面（备忘录 / 项目记忆 / 定时任务 / 插件）与设置页渲染在主内容区，而右面板
  // 全屏会把主内容区整体隐藏 —— 打开这些页面时先退出全屏，避免"点了没反应"。
  useEffect(() => {
    if (
      (isFeaturePageView(activeMainView) ||
        SETTINGS_VIEW_IDS.has(activeMainView)) &&
      isRightPanelFullscreen
    ) {
      setIsRightPanelFullscreen(false);
    }
  }, [activeMainView, isRightPanelFullscreen]);

  // 监听主进程的关闭请求：所有关闭路径（标题栏按钮、Alt+F4、任务栏）都会被
  // 主进程按「关闭 Snow App 时」设置拦截——退出/最小化已自动执行，仅询问
  // 行为才回推 window:close-requested，此处弹出二次确认。
  useEffect(() => {
    const dispose = window.snow.onCloseRequested(() => {
      setCloseNeverAskAgain(false);
      setShowCloseConfirm(true);
    });
    return () => {
      dispose();
    };
  }, []);

  // autoCollapsedRef 记录被自动收起的面板（此前处于展开状态），拉宽后据此恢复；
  // 用户手动收起/展开会清除标记，手动收起的面板不会被自动展开。
  const lastContentWidthRef = useRef(window.innerWidth);
  const autoCollapsedRef = useRef({ sidebar: false, rightPanel: false });
  const clearAutoCollapsed = useCallback((target: "sidebar" | "rightPanel") => {
    autoCollapsedRef.current[target] = false;
  }, []);

  // 监听右侧面板的展开请求：工具调用组件打开 diff 预览时，
  // 若面板处于折叠状态则自动展开，保证用户能看到新 tab。
  useEffect(() => {
    return rightPanelEvents.on("request-expand", () => {
      if (isRightPanelCollapsed) {
        clearAutoCollapsed("rightPanel");
        setIsRightPanelCollapsed(false);
      }
    });
  }, [isRightPanelCollapsed, clearAutoCollapsed]);

  // 快捷键切换左右侧边栏收起/展开（toggleSidebar / toggleRightPanel）：
  // 手动切换视为用户接管，清除自动恢复标记（手动收起的不再自动展开）。
  useEffect(() => {
    const unsubSidebar = shortcutEvents.on("toggle-sidebar", () => {
      clearAutoCollapsed("sidebar");
      setIsSidebarCollapsed((isCollapsed) => !isCollapsed);
    });
    const unsubRightPanel = shortcutEvents.on("toggle-right-panel", () => {
      clearAutoCollapsed("rightPanel");
      setIsRightPanelCollapsed((isCollapsed) => !isCollapsed);
    });
    const unsubRightPanelFullscreen = shortcutEvents.on(
      "toggle-right-panel-fullscreen",
      () => {
        setIsRightPanelFullscreen((isFullscreen) => !isFullscreen);
      },
    );
    return () => {
      unsubSidebar();
      unsubRightPanel();
      unsubRightPanelFullscreen();
    };
  }, [clearAutoCollapsed]);

  // 窗口缩窄时自动收起侧面板，拉宽到足够宽度时自动恢复：从左边缩窄 → 收起侧栏；
  // 从右边缩窄 → 收起右面板；方向未知（角部拖拽 / 系统吸附 / 程序化改尺寸都不
  // 上报方向）时右面板优先。宽度 ≤ MOBILE_BREAKPOINT 视为手机尺寸，两侧面板
  // 全部收起，聊天区独占窗口。
  // 收窄决策：宽度不足就收起面板，并记录为"可自动恢复"。每收起一个就按最新可见
  // 宽度重算，避免多收一个面板；收起某面板真正释放的是它当前的宽度，按当前宽度
  // 判定才能保证聊天区不会停在 MAIN_CONTENT_MIN_WIDTH 之下。
  const collapsePanelsToFit = useCallback(
    (contentWidth: number, edge: "left" | "right" | null): void => {
      if (contentWidth <= MOBILE_BREAKPOINT) {
        if (!isSidebarCollapsed) {
          autoCollapsedRef.current.sidebar = true;
          setIsSidebarCollapsed(true);
        }
        if (!isRightPanelCollapsed) {
          autoCollapsedRef.current.rightPanel = true;
          setIsRightPanelCollapsed(true);
        }
        return;
      }
      const order: ResizeTarget[] =
        edge === "left"
          ? ["sidebar", "right-panel"]
          : ["right-panel", "sidebar"];
      let nextSidebarCollapsed = isSidebarCollapsed;
      let nextRightCollapsed = isRightPanelCollapsed;
      for (const target of order) {
        // Only visible panels can become auto-collapsed; preserve manual collapse.
        if (target === "sidebar" ? nextSidebarCollapsed : nextRightCollapsed) {
          continue;
        }
        const visibleSidebarWidth = nextSidebarCollapsed ? 0 : sidebarWidth;
        const visibleRightPanelWidth = nextRightCollapsed ? 0 : rightPanelWidth;
        const visibleChrome =
          APP_LAYOUT_HORIZONTAL_PADDING +
          (nextSidebarCollapsed ? 0 : PANEL_RESIZER_WIDTH) +
          (nextRightCollapsed ? 0 : PANEL_RESIZER_WIDTH);
        const need =
          target === "sidebar"
            ? sidebarWidth +
              MAIN_CONTENT_MIN_WIDTH +
              visibleRightPanelWidth +
              visibleChrome
            : rightPanelWidth +
              MAIN_CONTENT_MIN_WIDTH +
              visibleSidebarWidth +
              visibleChrome;
        if (contentWidth >= need) {
          continue; // 该面板收起后已够宽，无需继续收起
        }
        if (target === "sidebar") {
          nextSidebarCollapsed = true;
          autoCollapsedRef.current.sidebar = true;
        } else {
          nextRightCollapsed = true;
          autoCollapsedRef.current.rightPanel = true;
        }
      }
      if (nextSidebarCollapsed !== isSidebarCollapsed) {
        setIsSidebarCollapsed(nextSidebarCollapsed);
      }
      if (nextRightCollapsed !== isRightPanelCollapsed) {
        setIsRightPanelCollapsed(nextRightCollapsed);
      }
    },
    [isSidebarCollapsed, isRightPanelCollapsed, sidebarWidth, rightPanelWidth],
  );

  // 宽度变化入口：缩窄交给收窄决策，拉宽按滞回恢复此前被自动收起的面板。
  const handleContentWidthChange = useCallback(
    (contentWidth: number, edge: "left" | "right" | null): void => {
      const prevWidth = lastContentWidthRef.current;
      lastContentWidthRef.current = contentWidth;
      if (contentWidth === prevWidth) {
        return; // 纯移动窗口，宽度未变
      }
      // 当前可见的水平方向固定开销：窗口内边距 + 可见面板间的分隔条。
      const chrome =
        APP_LAYOUT_HORIZONTAL_PADDING +
        (isSidebarCollapsed ? 0 : PANEL_RESIZER_WIDTH) +
        (isRightPanelCollapsed ? 0 : PANEL_RESIZER_WIDTH);

      if (contentWidth > prevWidth) {
        // 拉宽：宽度足够时恢复此前被自动收起的面板。
        // 顺序判定（先侧栏后右面板），右面板判定时计入侧栏即将展开的宽度，
        // 避免两个面板同时恢复后超出窗口宽度。恢复成本按面板当前宽度计算，
        // 与收窄判定同一口径，宽面板不会在窗口偏窄时反复收起/恢复。
        const auto = autoCollapsedRef.current;
        let nextSidebarCollapsed = isSidebarCollapsed;
        let nextRightCollapsed = isRightPanelCollapsed;
        if (auto.sidebar && isSidebarCollapsed) {
          const otherPanelWidth = isRightPanelCollapsed ? 0 : rightPanelWidth;
          const need =
            sidebarWidth +
            MAIN_CONTENT_MIN_WIDTH +
            otherPanelWidth +
            chrome +
            AUTO_EXPAND_MARGIN;
          if (contentWidth >= need) {
            nextSidebarCollapsed = false;
          }
        }
        if (auto.rightPanel && isRightPanelCollapsed) {
          const otherPanelWidth = nextSidebarCollapsed ? 0 : sidebarWidth;
          const need =
            rightPanelWidth +
            MAIN_CONTENT_MIN_WIDTH +
            otherPanelWidth +
            chrome +
            AUTO_EXPAND_MARGIN;
          if (contentWidth >= need) {
            nextRightCollapsed = false;
          }
        }
        if (!nextSidebarCollapsed) {
          auto.sidebar = false;
        }
        if (!nextRightCollapsed) {
          auto.rightPanel = false;
        }
        if (nextSidebarCollapsed !== isSidebarCollapsed) {
          setIsSidebarCollapsed(nextSidebarCollapsed);
        }
        if (nextRightCollapsed !== isRightPanelCollapsed) {
          setIsRightPanelCollapsed(nextRightCollapsed);
        }
        return;
      }

      // 缩窄：按方向自动收起对应面板，并记录为"可自动恢复"。
      collapsePanelsToFit(contentWidth, edge);
    },
    [
      collapsePanelsToFit,
      isSidebarCollapsed,
      isRightPanelCollapsed,
      sidebarWidth,
      rightPanelWidth,
    ],
  );

  useEffect(
    () =>
      window.snow.onWindowResizeEdgeChanged(({ edge, contentWidth }) =>
        handleContentWidthChange(contentWidth, edge),
      ),
    [handleContentWidthChange],
  );

  // 主进程只在能判定方向时才上报（角部拖拽、系统吸附、程序化改尺寸都不上报），
  // 这里用外壳宽度兜底：等一个回合确认没有方向事件处理过该宽度后，按右面板优先
  // 的顺序收窄，聊天区不会在方向未知的缩放路径下被压扁。
  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell) {
      return;
    }
    const measure = (): number =>
      Math.round(shell.getBoundingClientRect().width);
    let pending = 0;
    const observer = new ResizeObserver(() => {
      const width = measure();
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        pending = 0;
        if (
          width !== measure() ||
          Math.abs(width - lastContentWidthRef.current) <= 1
        ) {
          return; // 宽度仍在变化，或方向逻辑已经处理过该宽度
        }
        handleContentWidthChange(width, null);
      }, 80);
    });
    observer.observe(shell);
    return () => {
      window.clearTimeout(pending);
      observer.disconnect();
    };
  }, [handleContentWidthChange]);

  // 启动时（含窗口尺寸被系统恢复成窄宽度的情况）按同一规则收窄一次，避免一进来
  // 就是聊天区被压扁的布局；收起属自动行为，记录标记以便拉宽后恢复默认布局。
  // 经 ref 调用保持"仅挂载时执行"：手动展开的面板不会被随后的状态变化重新收起。
  const collapsePanelsToFitRef = useRef(collapsePanelsToFit);
  collapsePanelsToFitRef.current = collapsePanelsToFit;
  useEffect(() => {
    collapsePanelsToFitRef.current(window.innerWidth, null);
  }, []);

  const handleConfirmClose = useCallback((): void => {
    setShowCloseConfirm(false);
    if (closeNeverAskAgain) {
      persistCloseBehaviorThen("exit", () => {
        void window.snow.confirmCloseWindow();
      });
      return;
    }
    void window.snow.confirmCloseWindow();
  }, [closeNeverAskAgain]);

  const handleCancelClose = useCallback((): void => {
    setShowCloseConfirm(false);
  }, []);

  // 关闭提醒中的"最小化"选项：隐藏窗口到托盘（Windows/Linux），
  // macOS 则移除 Dock 图标、仅保留菜单栏托盘。会话/任务保持后台运行。
  const handleMinimizeClose = useCallback((): void => {
    setShowCloseConfirm(false);
    if (closeNeverAskAgain) {
      persistCloseBehaviorThen("minimize", () => {
        void window.snow.hideWindowToTray();
      });
      return;
    }
    void window.snow.hideWindowToTray();
  }, [closeNeverAskAgain]);

  const handleOpenTerminal = useCallback(
    (cwd?: string) => {
      // Pass the full path (including ssh://) to ptyManager.
      // ptyManager detects ssh:// and spawns an SSH session instead of a local shell.
      const rawPath = cwd ?? activeDirectory?.path ?? "";
      const targetCwd = rawPath;
      if (isRightPanelCollapsed) {
        clearAutoCollapsed("rightPanel");
        setIsRightPanelCollapsed(false);
      }
      // Defer to ensure panel is visible before fitting terminal
      requestAnimationFrame(() => {
        rightPanelRef.current?.openTerminal(targetCwd);
      });
    },
    [activeDirectory, isRightPanelCollapsed, clearAutoCollapsed],
  );

  const handleOpenBrowser = useCallback(() => {
    if (isRightPanelCollapsed) {
      clearAutoCollapsed("rightPanel");
      setIsRightPanelCollapsed(false);
    }
    requestAnimationFrame(() => {
      rightPanelRef.current?.openBrowser();
    });
  }, [isRightPanelCollapsed, clearAutoCollapsed]);

  const handleOpenDrawing = useCallback(() => {
    if (isRightPanelCollapsed) {
      setIsRightPanelCollapsed(false);
    }
    requestAnimationFrame(() => {
      rightPanelRef.current?.openDrawing();
    });
  }, [isRightPanelCollapsed]);

  const handleOpenTaskManager = useCallback(() => {
    if (isRightPanelCollapsed) {
      setIsRightPanelCollapsed(false);
    }
    requestAnimationFrame(() => {
      rightPanelRef.current?.openTaskManager();
    });
  }, [isRightPanelCollapsed]);

  const handleOpenPluginPanel = useCallback(
    (pluginId: string, panelId: string) => {
      if (isRightPanelCollapsed) {
        setIsRightPanelCollapsed(false);
      }
      requestAnimationFrame(() => {
        rightPanelRef.current?.openPluginPanel(pluginId, panelId);
      });
    },
    [isRightPanelCollapsed],
  );

  const handleOpenCodebase = useCallback(
    (projectId: string, projectName: string) => {
      if (isRightPanelCollapsed) {
        clearAutoCollapsed("rightPanel");
        setIsRightPanelCollapsed(false);
      }
      requestAnimationFrame(() => {
        rightPanelRef.current?.openCodebase(projectId, projectName);
      });
    },
    [isRightPanelCollapsed, clearAutoCollapsed],
  );

  const handleOpenProjectExplorer = useCallback(
    (directoryId: string) => {
      if (isRightPanelCollapsed) {
        clearAutoCollapsed("rightPanel");
        setIsRightPanelCollapsed(false);
      }
      requestAnimationFrame(() => {
        rightPanelRef.current?.openExplorer(directoryId);
      });
    },
    [isRightPanelCollapsed, clearAutoCollapsed],
  );

  const handleOpenFile = useCallback(
    (
      filePath: string,
      fileName: string,
      isSsh?: boolean,
      sshSessionId?: string | null,
      focusLine?: number,
      sshWorkspaceRoot?: string,
      sshWorkspaceId?: string,
    ) => {
      if (isRightPanelCollapsed) {
        clearAutoCollapsed("rightPanel");
        setIsRightPanelCollapsed(false);
      }
      requestAnimationFrame(() => {
        rightPanelRef.current?.openFile(
          filePath,
          fileName,
          isSsh,
          sshSessionId,
          focusLine,
          sshWorkspaceRoot,
          sshWorkspaceId,
        );
      });
    },
    [isRightPanelCollapsed, clearAutoCollapsed],
  );

  const handleOpenSshWizard = useCallback(
    (options?: { onCanceled?: () => void }): void => {
      sshWizardCanceledRef.current = options?.onCanceled ?? null;
      setShowSshWizard(true);
    },
    [],
  );

  const handleSshWizardConfirm = useCallback(
    async (sshUrl: string): Promise<void> => {
      setShowSshWizard(false);
      const notifyCanceled = sshWizardCanceledRef.current;
      sshWizardCanceledRef.current = null;
      const trimmedPath = sshUrl.trim();
      const name = trimmedPath.replace(/^ssh:\/\//, "") || trimmedPath;
      try {
        await window.snow.upsertWorkspaceDirectory({
          directoryId: `ssh:${trimmedPath}`,
          name,
          path: trimmedPath,
          kind: "ssh",
          isActive: true,
          sortOrder: 0,
          source: "manual",
        });
      } catch (error) {
        // 添加失败即流程结束：通知发起方清理一次性状态后再向上抛出
        notifyCanceled?.();
        throw error;
      }
    },
    [],
  );

  const handleSshWizardCancel = useCallback((): void => {
    setShowSshWizard(false);
    sshWizardCanceledRef.current?.();
    sshWizardCanceledRef.current = null;
  }, []);

  const isChatFloatActive = isRightPanelFullscreen && activeMainView === "chat";

  const shellClasses = [
    "app-shell",
    // Windows / Linux 无原生标题栏：复用合并式顶栏（LOGO + 自绘窗口按钮）样式。
    hasCustomFrame ? "is-custom-frame" : "",
    isSidebarCollapsed ? "sidebar-collapsed" : "",
    isRightPanelCollapsed ? "right-panel-collapsed" : "",
    isRightPanelFullscreen ? "right-panel-fullscreen" : "",
    // 全屏时聊天视图悬浮为底部卡片（其他视图仍完全隐藏）
    isChatFloatActive ? "chat-float-enabled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const panelSizeStyle: PanelSizeStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--right-panel-width": `${rightPanelWidth}px`,
  };

  const getMaxPanelWidth = (target: ResizeTarget): number => {
    const visibleSidebarWidth = isSidebarCollapsed ? 0 : sidebarWidth;
    const visibleRightPanelWidth = isRightPanelCollapsed ? 0 : rightPanelWidth;
    const otherPanelWidth =
      target === "sidebar" ? visibleRightPanelWidth : visibleSidebarWidth;
    const minWidth =
      target === "sidebar" ? SIDEBAR_MIN_WIDTH : RIGHT_PANEL_MIN_WIDTH;
    const availableWidth =
      window.innerWidth - APP_LAYOUT_HORIZONTAL_PADDING - APP_LAYOUT_GAP_TOTAL;
    const mainSafeMax =
      availableWidth - otherPanelWidth - MAIN_CONTENT_MIN_WIDTH;
    // On large screens, allow panels to grow proportionally instead of being
    // capped at a fixed pixel value. The original max is kept as a floor so
    // small-screen behaviour is unchanged.
    const ratioMax =
      target === "sidebar" ? availableWidth * 0.3 : availableWidth * 0.6;
    const absoluteMax =
      target === "sidebar"
        ? Math.max(SIDEBAR_MAX_WIDTH, ratioMax)
        : Math.max(RIGHT_PANEL_MAX_WIDTH, ratioMax);

    return Math.max(minWidth, Math.min(absoluteMax, mainSafeMax));
  };

  const startPanelResize = (
    target: ResizeTarget,
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();

    const shellElement = appShellRef.current;
    const resizerElement = event.currentTarget;
    if (!shellElement) {
      return;
    }

    const panelElement = shellElement.querySelector<HTMLElement>(
      target === "sidebar" ? ".sidebar" : ".right-panel",
    );
    if (!panelElement) {
      return;
    }
    const topBarElement = shellElement.querySelector<HTMLElement>(".top-bar");
    const sidebarElement = shellElement.querySelector<HTMLElement>(".sidebar");
    const mainElement =
      shellElement.querySelector<HTMLElement>(".main-content");
    const rightPanelElement =
      shellElement.querySelector<HTMLElement>(".right-panel");
    const chatAreaElement =
      shellElement.querySelector<HTMLElement>(".chat-area");

    const panelVariable =
      target === "sidebar" ? "--sidebar-width" : "--right-panel-width";
    const startX = event.clientX;
    const startWidth = target === "sidebar" ? sidebarWidth : rightPanelWidth;
    const minWidth =
      target === "sidebar" ? SIDEBAR_MIN_WIDTH : RIGHT_PANEL_MIN_WIDTH;
    const maxWidth = getMaxPanelWidth(target);
    const linkedFullscreenPanel =
      target === "sidebar" && isRightPanelFullscreen ? rightPanelElement : null;
    const floatingCardElement =
      target === "sidebar" && isChatFloatActive ? mainElement : null;
    const frozenChatWidth = chatAreaElement
      ? chatAreaElement.getBoundingClientRect().width
      : 0;
    // 拖动期间的最新宽度，结束后一次性提交到 React state。
    let latestWidth = startWidth;

    const overrideStack: {
      element: HTMLElement;
      property: string;
      previous: string;
      priority: string;
    }[] = [];
    const override = (element: HTMLElement | null, property: string): void => {
      if (!element) {
        return;
      }
      overrideStack.push({
        element,
        property,
        previous: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
    };

    override(panelElement, "transition");
    override(panelElement, "width");
    override(panelElement, "min-width");
    override(topBarElement, "transition");
    override(topBarElement, panelVariable);
    override(chatAreaElement, "width");
    override(linkedFullscreenPanel, "--sidebar-width");
    override(floatingCardElement, "--chat-float-region-left");
    override(resizerElement, "width");
    override(resizerElement, "min-width");
    override(resizerElement, "margin-left");
    override(resizerElement, "margin-right");

    const shieldedElements = [
      sidebarElement,
      mainElement,
      rightPanelElement,
      ...shellElement.querySelectorAll<HTMLElement>("webview, iframe"),
    ].filter((element): element is HTMLElement => element !== null);

    panelElement.style.setProperty("transition", "none");
    topBarElement?.style.setProperty("transition", "none");
    if (chatAreaElement) {
      chatAreaElement.style.width = `${frozenChatWidth}px`;
    }
    for (const element of shieldedElements) {
      override(element, "pointer-events");
      element.style.setProperty("pointer-events", "none");
    }

    document.body.classList.add("is-panel-resizing");
    resizerElement.classList.add("is-active");
    resizerElement.setPointerCapture(event.pointerId);

    // 右面板待全屏流程：越界区持续拖拽保持 1s 后出现遮罩提示（armed），
    // 此后不回拉、松开鼠标即进入全屏；回拉或提前松手则取消。
    // armed 用手势内局部变量记录（拖拽监听器是手势开始时的旧闭包，
    // 不能依赖 React state 读最新值），state 仅驱动遮罩渲染。
    let fullscreenTimer: number | null = null;
    let fullscreenArmed = false;
    const cancelFullscreenArm = (): void => {
      if (fullscreenTimer !== null) {
        window.clearTimeout(fullscreenTimer);
        fullscreenTimer = null;
      }
      if (fullscreenArmed) {
        fullscreenArmed = false;
        setIsRightPanelFullscreenPending(false);
      }
    };

    // 拖窄收起流程：越过最小宽度停留后收起，未松手回拉即展开；
    // 收起状态同样用手势内局部变量记录。
    let collapseTimer: number | null = null;
    let transitionTimer: number | null = null;
    let panelCollapsed = false;
    const cancelCollapseTimer = (): void => {
      if (collapseTimer !== null) {
        window.clearTimeout(collapseTimer);
        collapseTimer = null;
      }
    };

    const applyPanelWidth = (width: number): void => {
      panelElement.style.width = `${width}px`;
      panelElement.style.minWidth = `${width}px`;
      topBarElement?.style.setProperty(panelVariable, `${width}px`);
      if (linkedFullscreenPanel) {
        linkedFullscreenPanel.style.setProperty(
          "--sidebar-width",
          `${width}px`,
        );
      }
      if (floatingCardElement) {
        floatingCardElement.style.setProperty(
          "--chat-float-region-left",
          `${width + 20}px`,
        );
      }
    };

    // 收起/展开瞬间临时恢复样式表过渡，动画结束后回到无过渡跟手拖拽。
    const playToggleTransition = (): void => {
      panelElement.style.removeProperty("transition");
      topBarElement?.style.removeProperty("transition");
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
      }
      transitionTimer = window.setTimeout(() => {
        transitionTimer = null;
        panelElement.style.setProperty("transition", "none");
        topBarElement?.style.setProperty("transition", "none");
      }, PANEL_TOGGLE_TRANSITION_MS);
    };

    const setPanelCollapsed = (collapsed: boolean): void => {
      panelCollapsed = collapsed;
      playToggleTransition();
      if (collapsed) {
        panelElement.style.width = "0px";
        panelElement.style.minWidth = "0px";
        // 保留挂载的分隔条不能再占位：布局风格可能用 !important 负外边距
        // 让它压住相邻面板，收起后会把主区拉出缝隙，这里强制清零。
        for (const property of RESIZER_HOLD_PROPERTIES) {
          resizerElement.style.setProperty(property, "0px", "important");
        }
        // 收起态交给 CSS 的 sidebar-collapsed 规则计算全屏/悬浮布局。
        linkedFullscreenPanel?.style.removeProperty("--sidebar-width");
        floatingCardElement?.style.removeProperty("--chat-float-region-left");
        setCollapseHoldTarget(target);
      } else {
        for (const property of RESIZER_HOLD_PROPERTIES) {
          resizerElement.style.removeProperty(property);
        }
      }
      if (target === "sidebar") {
        clearAutoCollapsed("sidebar");
        setIsSidebarCollapsed(collapsed);
      } else {
        clearAutoCollapsed("rightPanel");
        setIsRightPanelCollapsed(collapsed);
      }
    };

    const stopResize = (): void => {
      // 遮罩提示已出现且未回拉：松手进入右面板全屏。
      if (fullscreenArmed) {
        fullscreenArmed = false;
        setIsRightPanelFullscreen(true);
      }
      if (fullscreenTimer !== null) {
        window.clearTimeout(fullscreenTimer);
        fullscreenTimer = null;
      }
      cancelCollapseTimer();
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      setIsRightPanelFullscreenPending(false);
      setCollapseHoldTarget(null);
      document.body.classList.remove("is-panel-resizing");
      resizerElement.classList.remove("is-active");
      // 收起结束时保留拖拽前宽度，下次展开恢复原尺寸。
      const committedWidth = panelCollapsed ? startWidth : latestWidth;
      shellElement.style.setProperty(panelVariable, `${committedWidth}px`);
      if (target === "sidebar") {
        setSidebarWidth(committedWidth);
      } else {
        setRightPanelWidth(committedWidth);
      }
      for (const entry of overrideStack) {
        if (entry.previous === "" && entry.priority === "") {
          entry.element.style.removeProperty(entry.property);
          continue;
        }
        entry.element.style.setProperty(
          entry.property,
          entry.previous,
          entry.priority,
        );
      }
      overrideStack.length = 0;
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", stopResize);
      document.removeEventListener("pointercancel", stopResize);
      resizerElement.removeEventListener("lostpointercapture", stopResize);
    };

    const handlePointerMove = (pointerEvent: PointerEvent): void => {
      const deltaX = pointerEvent.clientX - startX;
      const nextWidth =
        target === "sidebar" ? startWidth + deltaX : startWidth - deltaX;
      // 右面板拖到最大宽度后仍向外拖拽：持续保持 1s 后出现遮罩提示。
      const isOverdrag =
        target === "right-panel" &&
        !isRightPanelFullscreen &&
        nextWidth >= maxWidth + RIGHT_PANEL_FULLSCREEN_OVERDRAG;
      if (isOverdrag) {
        // 计时器 id 保留为"已武装"标记，避免武装后重复计时。
        if (fullscreenTimer === null) {
          fullscreenTimer = window.setTimeout(() => {
            fullscreenArmed = true;
            setIsRightPanelFullscreenPending(true);
          }, RIGHT_PANEL_FULLSCREEN_DWELL_MS);
        }
      } else {
        cancelFullscreenArm();
      }
      // 拖窄越界：停留后收起；已收起时回拉进入展开阈值即恢复。
      if (panelCollapsed) {
        if (nextWidth <= minWidth - PANEL_EXPAND_OVERDRAG) {
          return;
        }
        setPanelCollapsed(false);
      } else if (nextWidth <= minWidth - PANEL_COLLAPSE_OVERDRAG) {
        if (collapseTimer === null) {
          collapseTimer = window.setTimeout(() => {
            collapseTimer = null;
            setPanelCollapsed(true);
          }, PANEL_COLLAPSE_DWELL_MS);
        }
      } else {
        cancelCollapseTimer();
      }
      const clampedWidth = Math.round(clamp(nextWidth, minWidth, maxWidth));
      latestWidth = clampedWidth;
      applyPanelWidth(clampedWidth);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", stopResize);
    document.addEventListener("pointercancel", stopResize);
    resizerElement.addEventListener("lostpointercapture", stopResize);
  };

  return (
    <KeyboardShortcutsProvider>
      <ChatConversationProvider
        directoryId={activeDirectory?.directoryId}
        directoryPath={activeDirectory?.path}
      >
        <NotificationNavigationBridge
          activeDirectory={activeDirectory}
          onActiveDirectoryChange={handleActiveDirectoryChange}
          onSelectMainView={setActiveMainView}
        />
        <RemoteControlBridge
          activeDirectory={activeDirectory}
          onActiveDirectoryChange={handleActiveDirectoryChange}
          onSelectMainView={setActiveMainView}
        />
        <ShortcutHandlerBridge />
        <PluginRuntimeBridge activeDirectory={activeDirectory} />
        <ClientScriptBridge
          activeDirectory={activeDirectory}
          activeView={activeMainView}
          isSidebarCollapsed={isSidebarCollapsed}
          isRightPanelCollapsed={isRightPanelCollapsed}
          onSelectMainView={setActiveMainView}
        />
        <div
          ref={appShellRef}
          className={shellClasses}
          style={panelSizeStyle}
          data-snow-anchor="app.root"
        >
          <ThemeBackgroundImageLayer />
          <ThemeBackgroundPetLayer background={themeSettings.background} />
          <TopBar
            activeView={activeMainView}
            isSidebarCollapsed={isSidebarCollapsed}
            isRightPanelCollapsed={isRightPanelCollapsed}
            activeDirectory={activeDirectory}
            onToggleSidebar={() => {
              // 手动切换视为用户接管，清除自动恢复标记（手动收起的不再自动展开）
              clearAutoCollapsed("sidebar");
              setIsSidebarCollapsed((isCollapsed) => !isCollapsed);
            }}
            onToggleRightPanel={() => {
              clearAutoCollapsed("rightPanel");
              setIsRightPanelCollapsed((isCollapsed) => !isCollapsed);
            }}
            isRightPanelFullscreen={isRightPanelFullscreen}
            onToggleRightPanelFullscreen={() =>
              setIsRightPanelFullscreen((isFullscreen) => !isFullscreen)
            }
            onSelectView={setActiveMainView}
            onOpenTerminal={handleOpenTerminal}
            onOpenBrowser={handleOpenBrowser}
            onOpenCodebase={handleOpenCodebase}
            onOpenProjectExplorer={handleOpenProjectExplorer}
            onOpenDrawing={handleOpenDrawing}
            onOpenTaskManager={handleOpenTaskManager}
            onOpenPluginPanel={handleOpenPluginPanel}
          />
          <div className="app-layout">
            <Sidebar
              activeDirectory={activeDirectory}
              activeMainView={activeMainView}
              isCollapsed={isSidebarCollapsed}
              onActiveDirectoryChange={handleActiveDirectoryChange}
              onSelectMainView={setActiveMainView}
              onOpenSshWizard={handleOpenSshWizard}
              onOpenTerminal={handleOpenTerminal}
              onOpenFile={handleOpenFile}
            />
            {(!isSidebarCollapsed || collapseHoldTarget === "sidebar") && (
              <div
                className="panel-resizer sidebar-resizer layout-resizer"
                role="separator"
                aria-label="Resize sidebar"
                aria-orientation="vertical"
                onPointerDown={(event) => startPanelResize("sidebar", event)}
              />
            )}
            <MainContent
              activeDirectory={activeDirectory}
              activeView={activeMainView}
              isFloating={isChatFloatActive}
              isFullscreenPending={isRightPanelFullscreenPending}
              onActiveDirectoryChange={handleActiveDirectoryChange}
              onSelectView={setActiveMainView}
            />
            {(!isRightPanelCollapsed ||
              collapseHoldTarget === "right-panel") && (
              <div
                className="panel-resizer right-panel-resizer layout-resizer"
                role="separator"
                aria-label="Resize review panel"
                aria-orientation="vertical"
                onPointerDown={(event) =>
                  startPanelResize("right-panel", event)
                }
              />
            )}
            <RightPanel
              ref={rightPanelRef}
              isCollapsed={isRightPanelCollapsed}
              isFullscreen={isRightPanelFullscreen}
              activeDirectory={activeDirectory}
              onSelectMainView={setActiveMainView}
              onToggleRightPanelFullscreen={() =>
                setIsRightPanelFullscreen((isFullscreen) => !isFullscreen)
              }
            />
          </div>
          {showSshWizard ? (
            <SshConnectWizard
              onConfirm={(sshUrl) => void handleSshWizardConfirm(sshUrl)}
              onCancel={handleSshWizardCancel}
            />
          ) : null}
          <ConfirmDialog
            open={showCloseConfirm}
            title={t("app.closeConfirmTitle")}
            message={t("app.closeConfirmMessage")}
            confirmLabel={t("app.closeConfirm")}
            cancelLabel={t("app.closeCancel")}
            extraLabel={t(
              isMacOS ? "app.closeMinimizeMac" : "app.closeMinimize",
            )}
            onExtra={handleMinimizeClose}
            onConfirm={handleConfirmClose}
            onCancel={handleCancelClose}
            variant="warning"
          >
            <label className="confirm-dialog-check">
              <input
                type="checkbox"
                checked={closeNeverAskAgain}
                onChange={(event) =>
                  setCloseNeverAskAgain(event.target.checked)
                }
              />
              <span>{t("app.closeNeverAskAgain")}</span>
            </label>
          </ConfirmDialog>
          {/* 应用锁：锁定态用毛玻璃遮罩盖住整个界面，仅影响查看 */}
          <AppLockOverlay />
          <ShortcutHelpOverlay />
        </div>
      </ChatConversationProvider>
    </KeyboardShortcutsProvider>
  );
};
