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
 * 2. 注册 6 个快捷键动作的处理器：
 *    - cancelSession：直接调用 handleAbort
 *    - 其余 5 个：通过 shortcutEvents 事件总线分发到各目标组件
 *
 * 注册通过 registerHandler 完成，handler 使用 ref 保持最新值。
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

    return () => {
      unsubCancel();
      unsubSearch();
      unsubMemo();
      unsubTodo();
      unsubCycle();
      unsubExplorer();
      unsubCycleApiProfile();
    };
  }, [registerHandler]);

  // 启动快捷键引擎的 document keydown 监听
  useKeyboardShortcuts();

  return null;
};

export const App = (): React.JSX.Element => {
  const rightPanelRef = useRef<RightPanelRef>(null);
  const [activeMainView, setActiveMainView] = useState<MainContentView>("chat");
  const [activeDirectory, setActiveDirectory] =
    useState<WorkspaceDirectoryRecord | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);
  const [isRightPanelFullscreen, setIsRightPanelFullscreen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [rightPanelWidth, setRightPanelWidth] = useState(
    RIGHT_PANEL_DEFAULT_WIDTH
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

  // 监听右侧面板的展开请求：工具调用组件打开 diff 预览时，
  // 若面板处于折叠状态则自动展开，保证用户能看到新 tab。
  useEffect(() => {
    return rightPanelEvents.on("request-expand", () => {
      if (isRightPanelCollapsed) {
        setIsRightPanelCollapsed(false);
      }
    });
  }, [isRightPanelCollapsed]);

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

  const handleOpenTerminal = useCallback(() => {
    const rawPath = activeDirectory?.path ?? "";
    // Pass the full path (including ssh://) to ptyManager.
    // ptyManager detects ssh:// and spawns an SSH session instead of a local shell.
    const cwd = rawPath;
    if (isRightPanelCollapsed) {
      setIsRightPanelCollapsed(false);
    }
    // Defer to ensure panel is visible before fitting terminal
    requestAnimationFrame(() => {
      rightPanelRef.current?.openTerminal(cwd);
    });
  }, [activeDirectory, isRightPanelCollapsed]);

  const handleOpenBrowser = useCallback(() => {
    if (isRightPanelCollapsed) {
      setIsRightPanelCollapsed(false);
    }
    requestAnimationFrame(() => {
      rightPanelRef.current?.openBrowser();
    });
  }, [isRightPanelCollapsed]);

  const handleOpenCodebase = useCallback(
    (projectId: string, projectName: string) => {
      if (isRightPanelCollapsed) {
        setIsRightPanelCollapsed(false);
      }
      requestAnimationFrame(() => {
        rightPanelRef.current?.openCodebase(projectId, projectName);
      });
    },
    [isRightPanelCollapsed]
  );

  const handleOpenFile = useCallback(
    (
      filePath: string,
      fileName: string,
      isSsh?: boolean,
      sshSessionId?: string | null,
      focusLine?: number,
      sshWorkspaceRoot?: string,
      sshWorkspaceId?: string
    ) => {
      if (isRightPanelCollapsed) {
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
          sshWorkspaceId
        );
      });
    },
    [isRightPanelCollapsed]
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
    []
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
      target === "sidebar" ? availableWidth * 0.3 : availableWidth * 0.45;
    const absoluteMax =
      target === "sidebar"
        ? Math.max(SIDEBAR_MAX_WIDTH, ratioMax)
        : Math.max(RIGHT_PANEL_MAX_WIDTH, ratioMax);

    return Math.max(minWidth, Math.min(absoluteMax, mainSafeMax));
  };

  const startPanelResize = (
    target: ResizeTarget,
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = target === "sidebar" ? sidebarWidth : rightPanelWidth;

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

      if (target === "sidebar") {
        setSidebarWidth(clampedWidth);
      } else {
        setRightPanelWidth(clampedWidth);
      }
    };

    const stopResize = (): void => {
      setActiveResizeTarget(null);
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
        <ShortcutHandlerBridge />
        <div className={shellClasses} style={panelSizeStyle}>
          {isWindows && <WindowControls />}
          <TopBar
            isSidebarCollapsed={isSidebarCollapsed}
            isRightPanelCollapsed={isRightPanelCollapsed}
            activeDirectory={activeDirectory}
            onToggleSidebar={() =>
              setIsSidebarCollapsed((isCollapsed) => !isCollapsed)
            }
            onToggleRightPanel={() =>
              setIsRightPanelCollapsed((isCollapsed) => !isCollapsed)
            }
            isRightPanelFullscreen={isRightPanelFullscreen}
            onToggleRightPanelFullscreen={() =>
              setIsRightPanelFullscreen((isFullscreen) => !isFullscreen)
            }
            onOpenTerminal={handleOpenTerminal}
            onOpenBrowser={handleOpenBrowser}
            onOpenCodebase={handleOpenCodebase}
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
              isMacOS ? "app.closeMinimizeMac" : "app.closeMinimize"
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
