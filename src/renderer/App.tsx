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
import { WindowControls } from "./components/WindowControls";
import { NotificationNavigationBridge } from "./components/NotificationNavigationBridge";
import {
  ChatConversationProvider,
  useChatConversationContext,
} from "./components/mainContent/chatMessages";
import type { MainContentView } from "./components/mainContent/types";
import { SshConnectWizard } from "./components/sidebar/mainSidebar/SshConnectWizard";
import { ConfirmDialog } from "./components/common/ConfirmDialog";
import { rightPanelEvents } from "./components/rightPanel/rightPanelEvents";
import {
  KeyboardShortcutsProvider,
  useKeyboardShortcutsSettings,
} from "./components/KeyboardShortcutsProvider";
import { shortcutEvents } from "./components/shortcutEvents";
import { useAppControl } from "./hooks/useAppControl";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useI18n } from "./i18n";
import { useTheme } from "./hooks/useTheme";
import type { WorkspaceDirectoryRecord } from "../preload";

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 248;
const RIGHT_PANEL_MIN_WIDTH = 280;
const RIGHT_PANEL_MAX_WIDTH = 640;
const RIGHT_PANEL_DEFAULT_WIDTH = 380;
const MAIN_CONTENT_MIN_WIDTH = 420;
// 窗口内容宽度 ≤ 此值时视为手机尺寸：自动收起两侧面板，聊天区独占窗口。
const MOBILE_BREAKPOINT = 720;
const PANEL_RESIZER_WIDTH = 10;
// 自动展开的滞回余量：拉宽到收起阈值以上再多出此宽度才恢复展开，
// 避免用户在阈值附近来回拖动时面板反复收起/展开。
const AUTO_EXPAND_MARGIN = 80;
const APP_LAYOUT_HORIZONTAL_PADDING = 20;
const APP_LAYOUT_GAP_TOTAL = 20;

type ResizeTarget = "sidebar" | "right-panel";

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
 *    - cancelSession：直接调用 handleAbort
 *    - openSearch / openMemo / openTodo / cycleProject /
 *      openProjectExplorer / cycleApiProfile：通过 shortcutEvents
 *      事件总线分发到各目标组件
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

  useEffect(() => {
    const unsubCancel = registerHandler("cancelSession", () => {
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
    const unsubCycleApiProfile = registerHandler("cycleApiProfile", () => {
      shortcutEvents.emit("open-api-profile-menu");
    });
    const unsubTogglePet = registerHandler("togglePet", () => {
      // 切换宠物启停：读取当前设置并取反，主进程 pets:set-enabled
      // 负责创建/收起宠物窗口。
      void window.snow.getPetSettings().then((petSettings) => {
        void window.snow.setPetEnabled(!petSettings.enabled);
      });
    });

    return () => {
      unsubCancel();
      unsubSearch();
      unsubMemo();
      unsubTodo();
      unsubCycle();
      unsubExplorer();
      unsubCycleApiProfile();
      unsubTogglePet();
    };
  }, [registerHandler]);

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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);
  const [isRightPanelFullscreen, setIsRightPanelFullscreen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [rightPanelWidth, setRightPanelWidth] = useState(
    RIGHT_PANEL_DEFAULT_WIDTH,
  );
  const [activeResizeTarget, setActiveResizeTarget] =
    useState<ResizeTarget | null>(null);
  const [showSshWizard, setShowSshWizard] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const isWindows = navigator.userAgent.includes("Win");
  const isMacOS = navigator.userAgent.includes("Mac");
  const { t } = useI18n();
  useTheme();
  useAppControl({ activeDirectory, setActiveMainView });

  // 监听主进程的关闭请求：所有关闭路径（标题栏按钮、Alt+F4、任务栏）
  // 都会在主进程被拦截并回推 window:close-requested，此处弹出二次确认。
  useEffect(() => {
    const dispose = window.snow.onCloseRequested(() => {
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

  // 窗口缩窄时按缩窄方向自动收起对应侧面板，拉宽到足够宽度时自动恢复：
  // 从左边缩窄 → 收起侧栏；从右边缩窄 → 收起右面板。
  // 宽度 ≤ MOBILE_BREAKPOINT 视为手机尺寸，两侧面板全部收起，聊天区独占窗口。
  useEffect(() => {
    return window.snow.onWindowResizeEdgeChanged(({ edge, contentWidth }) => {
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
        // 避免两个面板同时恢复后超出窗口宽度。
        const auto = autoCollapsedRef.current;
        let nextSidebarCollapsed = isSidebarCollapsed;
        let nextRightCollapsed = isRightPanelCollapsed;
        if (auto.sidebar && isSidebarCollapsed) {
          const otherPanelWidth = isRightPanelCollapsed ? 0 : rightPanelWidth;
          const need =
            SIDEBAR_MIN_WIDTH +
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
            RIGHT_PANEL_MIN_WIDTH +
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
      if (edge === "left" && !isSidebarCollapsed) {
        const otherPanelWidth = isRightPanelCollapsed ? 0 : rightPanelWidth;
        if (
          contentWidth <
          SIDEBAR_MIN_WIDTH + MAIN_CONTENT_MIN_WIDTH + otherPanelWidth + chrome
        ) {
          autoCollapsedRef.current.sidebar = true;
          setIsSidebarCollapsed(true);
        }
      } else if (edge === "right" && !isRightPanelCollapsed) {
        const otherPanelWidth = isSidebarCollapsed ? 0 : sidebarWidth;
        if (
          contentWidth <
          RIGHT_PANEL_MIN_WIDTH +
            MAIN_CONTENT_MIN_WIDTH +
            otherPanelWidth +
            chrome
        ) {
          autoCollapsedRef.current.rightPanel = true;
          setIsRightPanelCollapsed(true);
        }
      }
    });
  }, [
    isSidebarCollapsed,
    isRightPanelCollapsed,
    sidebarWidth,
    rightPanelWidth,
  ]);

  // 启动时若窗口已是手机宽度，直接以两侧收起布局呈现，避免初始布局溢出；
  // 收起属自动行为，记录标记以便拉宽后恢复默认布局。
  useEffect(() => {
    if (window.innerWidth <= MOBILE_BREAKPOINT) {
      autoCollapsedRef.current.sidebar = true;
      autoCollapsedRef.current.rightPanel = true;
      setIsSidebarCollapsed(true);
      setIsRightPanelCollapsed(true);
    }
  }, []);

  const handleConfirmClose = useCallback((): void => {
    setShowCloseConfirm(false);
    void window.snow.confirmCloseWindow();
  }, []);

  const handleCancelClose = useCallback((): void => {
    setShowCloseConfirm(false);
  }, []);

  // 关闭提醒中的"最小化"选项：隐藏窗口到托盘（Windows/Linux），
  // macOS 则移除 Dock 图标、仅保留菜单栏托盘。会话/任务保持后台运行。
  const handleMinimizeClose = useCallback((): void => {
    setShowCloseConfirm(false);
    void window.snow.hideWindowToTray();
  }, []);

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

  const handleOpenSshWizard = useCallback((): void => {
    setShowSshWizard(true);
  }, []);

  const handleSshWizardConfirm = useCallback(
    async (sshUrl: string): Promise<void> => {
      setShowSshWizard(false);
      const trimmedPath = sshUrl.trim();
      const name = trimmedPath.replace(/^ssh:\/\//, "") || trimmedPath;
      await window.snow.upsertWorkspaceDirectory({
        directoryId: `ssh:${trimmedPath}`,
        name,
        path: trimmedPath,
        kind: "ssh",
        isActive: true,
        sortOrder: 0,
        source: "manual",
      });
    },
    [],
  );

  const handleSshWizardCancel = useCallback((): void => {
    setShowSshWizard(false);
  }, []);

  const shellClasses = [
    "app-shell",
    isWindows ? "is-windows" : "",
    isSidebarCollapsed ? "sidebar-collapsed" : "",
    isRightPanelCollapsed ? "right-panel-collapsed" : "",
    isRightPanelFullscreen ? "right-panel-fullscreen" : "",
    activeResizeTarget ? "is-resizing" : "",
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

    const startX = event.clientX;
    const startWidth = target === "sidebar" ? sidebarWidth : rightPanelWidth;
    // 拖动期间的最新宽度，结束后一次性提交到 React state。
    let latestWidth = startWidth;

    setActiveResizeTarget(target);
    event.currentTarget.setPointerCapture(event.pointerId);

    const handlePointerMove = (pointerEvent: PointerEvent): void => {
      const deltaX = pointerEvent.clientX - startX;
      const nextWidth =
        target === "sidebar" ? startWidth + deltaX : startWidth - deltaX;
      const minWidth =
        target === "sidebar" ? SIDEBAR_MIN_WIDTH : RIGHT_PANEL_MIN_WIDTH;
      const maxWidth = getMaxPanelWidth(target);
      const clampedWidth = Math.round(clamp(nextWidth, minWidth, maxWidth));
      latestWidth = clampedWidth;

      // 拖动期间直接更新 app-shell 上的 CSS 变量，浏览器原生完成布局，
      // 不经过 React 状态 → 右侧面板（含 GitDiffView 等高开销组件）不重渲染，
      // 避免拖动卡顿。最终宽度在 pointerup 时再同步回 React state。
      const shellElement = appShellRef.current;
      if (shellElement) {
        shellElement.style.setProperty(
          target === "sidebar" ? "--sidebar-width" : "--right-panel-width",
          `${clampedWidth}px`,
        );
      }
    };

    const stopResize = (): void => {
      setActiveResizeTarget(null);
      // 提交最终宽度：与拖动期间手动写入的 CSS 变量值一致，React 渲染后无缝接管。
      if (target === "sidebar") {
        setSidebarWidth(latestWidth);
      } else {
        setRightPanelWidth(latestWidth);
      }
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", stopResize);
      document.removeEventListener("pointercancel", stopResize);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", stopResize);
    document.addEventListener("pointercancel", stopResize);
  };

  return (
    <KeyboardShortcutsProvider>
      <ChatConversationProvider
        directoryId={activeDirectory?.directoryId}
        directoryPath={activeDirectory?.path}
      >
        <NotificationNavigationBridge
          activeDirectory={activeDirectory}
          onActiveDirectoryChange={setActiveDirectory}
          onSelectMainView={setActiveMainView}
        />
        <ShortcutHandlerBridge />
        <div ref={appShellRef} className={shellClasses} style={panelSizeStyle}>
          {isWindows && <WindowControls />}
          <TopBar
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
            onOpenTerminal={handleOpenTerminal}
            onOpenBrowser={handleOpenBrowser}
            onOpenCodebase={handleOpenCodebase}
            onOpenDrawing={handleOpenDrawing}
          />
          <div className="app-layout">
            <Sidebar
              activeDirectory={activeDirectory}
              activeMainView={activeMainView}
              isCollapsed={isSidebarCollapsed}
              isResizing={activeResizeTarget !== null}
              onActiveDirectoryChange={setActiveDirectory}
              onSelectMainView={setActiveMainView}
              onOpenSshWizard={handleOpenSshWizard}
              onOpenTerminal={handleOpenTerminal}
              onOpenFile={handleOpenFile}
            />
            {!isSidebarCollapsed && (
              <div
                className={`panel-resizer sidebar-resizer layout-resizer${
                  activeResizeTarget === "sidebar" ? " is-active" : ""
                }`}
                role="separator"
                aria-label="Resize sidebar"
                aria-orientation="vertical"
                onPointerDown={(event) => startPanelResize("sidebar", event)}
              />
            )}
            <MainContent
              activeDirectory={activeDirectory}
              activeView={activeMainView}
              isResizing={activeResizeTarget !== null}
              onSelectView={setActiveMainView}
            />
            {!isRightPanelCollapsed && (
              <div
                className={`panel-resizer right-panel-resizer layout-resizer${
                  activeResizeTarget === "right-panel" ? " is-active" : ""
                }`}
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
              isResizing={activeResizeTarget !== null}
              activeDirectory={activeDirectory}
              onSelectMainView={setActiveMainView}
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
          />
        </div>
      </ChatConversationProvider>
    </KeyboardShortcutsProvider>
  );
};
