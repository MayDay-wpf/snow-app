import {
  Bug,
  Copy,
  Database,
  FolderOpen,
  FolderTree,
  Globe,
  Maximize2,
  Minimize2,
  Paintbrush,
  Pin,
  SidebarClose,
  SidebarOpen,
  SquarePen,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../preload";
import { useI18n } from "../i18n";
import { useChatConversationContext } from "./mainContent/chatMessages";
import { OPEN_PROJECT_CODEBASE_PANEL_EVENT } from "./mainContent/chatInput/ProjectCodebasePanel";
import { CodebaseSyncIndicator } from "./TopBar/CodebaseSyncIndicator";
import { SettingsPageTopBarActions } from "./TopBar/SettingsPageTopBarActions";
import { TeamTopBarActions } from "./TopBar/TeamTopBarActions";
import { TodoPanelButton } from "./TopBar/TodoPanelButton";
import { TopBarBranchSelector } from "./TopBar/TopBarBranchSelector";
import { codebaseSyncStore } from "./TopBar/codebaseSyncStore";
import { useTeamTopBarSnapshot } from "./TopBar/teamTopBarStore";
import { ContextMenu, type ContextMenuItem } from "./common/ContextMenu";
import { PlusMenuButton, type PlusMenuItem } from "./common/PlusMenuButton";
import { explorerPlacementStore } from "./common/explorerPlacementStore";
import { PluginIcon } from "./common/PluginIcon";
import { SnowLogo } from "./common/SnowLogo";
import { Gauge, Puzzle } from "lucide-react";
import { resolveLocalized } from "../plugins/manifest";
import { pluginStore, usePluginStore } from "../plugins/pluginStore";
import { WindowControlsButtons } from "./WindowControls";
import { useCodebaseWatcher } from "../hooks/useCodebaseWatcher";
import { FEATURE_PAGE_TITLES, isFeaturePageView } from "./featurePages";
import { emitNewChatRequested } from "./newChatEvents";
import { getSettingsPageMeta } from "./settingsPages";
import { SETTINGS_VIEW_IDS } from "./sidebar/settingsItems";
import type { MainContentView } from "./mainContent/types";
import { hasCustomWindowFrame } from "../utils/platform";
import { useSshWorkspaceGate } from "../ssh/sshConnectionStore";
import { getSshConnectionStatusLabel } from "../ssh/sshConnectionStatus";

type TopBarProps = {
  activeView: MainContentView;
  isSidebarCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  isRightPanelFullscreen: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  onToggleRightPanelFullscreen: () => void;
  onSelectView: (view: MainContentView) => void;
  onOpenTerminal?: () => void;
  onOpenBrowser?: () => void;
  onOpenCodebase?: (projectId: string, projectName: string) => void;
  onOpenProjectExplorer?: (directoryId: string) => void;
  onOpenDrawing?: () => void;
  onOpenTaskManager?: () => void;
  onOpenPluginPanel?: (pluginId: string, panelId: string) => void;
};

export const TopBar = ({
  activeView,
  isSidebarCollapsed,
  isRightPanelCollapsed,
  isRightPanelFullscreen,
  activeDirectory,
  onToggleSidebar,
  onToggleRightPanel,
  onToggleRightPanelFullscreen,
  onSelectView,
  onOpenTerminal,
  onOpenBrowser,
  onOpenCodebase,
  onOpenProjectExplorer,
  onOpenDrawing,
  onOpenTaskManager,
  onOpenPluginPanel,
}: TopBarProps): React.JSX.Element => {
  const hasCustomFrame = hasCustomWindowFrame();
  const isMacOS = navigator.userAgent.includes("Mac");
  const { t, locale } = useI18n();
  // 活动 SSH 项目未连接时，顶栏新建会话入口只触发显式重连
  const sshGate = useSshWorkspaceGate(activeDirectory);
  const sshGateLabel = sshGate.status
    ? getSshConnectionStatusLabel(t, sshGate.status)
    : "";
  // 资源管理器显示位置偏好：仅“右侧面板”方案下提供 Plus 菜单入口。
  const [explorerPlacement, setExplorerPlacement] = useState(() =>
    explorerPlacementStore.get(),
  );
  useEffect(() => explorerPlacementStore.subscribe(setExplorerPlacement), []);
  const pluginState = usePluginStore();
  // 团队协作视图的顶栏数据（由 TeamPanel 发布，详见 teamTopBarStore）
  const teamTopBar = useTeamTopBarSnapshot();
  const pluginPanels = pluginState.plugins.flatMap((plugin) =>
    plugin.enabled
      ? plugin.panels.map((_, panelIndex) => ({ plugin, panelIndex }))
      : [],
  );
  const {
    handleNewChat,
    summary,
    conversationDirectoryId,
    activeConversationId,
    messages,
    isStreaming,
    subAgentSessionEvents,
    upsertedConversation,
  } = useChatConversationContext();
  const [conversationDirectoryName, setConversationDirectoryName] = useState<
    string | undefined
  >(undefined);
  // Sub-agent conversation meta (persisted record) for the active conversation
  // plus the title of the parent conversation it was launched from. Used to
  // render the header as the sub-agent's stage name instead of the project
  // name when viewing a read-only sub-agent conversation.
  const [activeConversationMeta, setActiveConversationMeta] = useState<{
    conversationType: string;
    title: string;
    subAgentName: string;
    parentConversationId: string;
  } | null>(null);
  const [parentConversationTitle, setParentConversationTitle] = useState("");
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [isTodoPanelOpen, setIsTodoPanelOpen] = useState(false);
  const [isTodoPanelPinned, setIsTodoPanelPinned] = useState(false);
  // 窗口置顶（图钉）：挂载时从主进程同步真实状态。
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  // macOS 原生全屏：系统会隐藏红绿灯按钮，左侧改渲染 LOGO 填补空缺。
  const [isNativeFullScreen, setIsNativeFullScreen] = useState(false);
  // 项目标签右键菜单：记录触发位置。
  const [branchContextMenu, setBranchContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [codebaseEnabled, setCodebaseEnabled] = useState(false);
  const [codebaseIndexed, setCodebaseIndexed] = useState(false);
  // Error message of the last failed embedding for the active project.
  // Shown as a red error state on the codebase sync indicator (see #16/#17).
  const [codebaseEmbedError, setCodebaseEmbedError] = useState<string | null>(
    null,
  );
  // Track which projectId the codebaseEnabled state corresponds to. This is
  // used to detect stale enabled values during project switches — when the
  // active project changes, codebaseEnabled may still hold the previous
  // project's value for one render cycle (React state updates are async).
  // By comparing enabledProjectIdRef with activeProjectId, we can force
  // enabled=false until the new project's scope is confirmed.
  const enabledProjectIdRef = useRef<string | undefined>(undefined);
  // Guards against stale index-stats responses: every project switch (or
  // effect re-run) bumps the generation, so in-flight responses from the
  // previous project are discarded.
  const statsGenerationRef = useRef(0);

  // Resolve the active project id / path for the codebase watcher. Follow the
  // active workspace directory (the "current project" the user sees in the
  // sidebar) so that switching projects immediately re-evaluates the codebase
  // state: projects without a codebase must not keep showing the indicator,
  // and a stale conversation-bound project must not keep the watcher pinned
  // to the previous project. Fall back to the conversation's directory only
  // when no workspace directory is active.
  const activeProjectId =
    activeDirectory?.directoryId ?? conversationDirectoryId;
  const activeProjectPath = activeDirectory?.path;

  // Load the codebase scope settings for the active project to determine
  // whether the watcher should be active.
  //
  // When the active project changes, we immediately reset codebaseEnabled to
  // false and clear enabledProjectIdRef BEFORE the async fetch resolves. This
  // prevents the useCodebaseWatcher from briefly starting a watcher for the
  // new project using the stale `true` value from the previous project.
  useEffect(() => {
    if (!activeProjectId) {
      setCodebaseEnabled(false);
      setCodebaseEmbedError(null);
      enabledProjectIdRef.current = undefined;
      return;
    }

    // Reset to false immediately so the watcher stops while we fetch the
    // new project's scope. Also clear the ref so that even if the state
    // update hasn't flushed yet, the derived `effectiveEnabled` below
    // will be false.
    setCodebaseEnabled(false);
    setCodebaseEmbedError(null);
    enabledProjectIdRef.current = undefined;

    let cancelled = false;
    void window.snow
      .getCodebaseProjectScopeSettings(activeProjectId)
      .then((scope) => {
        if (!cancelled) {
          enabledProjectIdRef.current = activeProjectId;
          setCodebaseEnabled(scope.enabled ?? false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          enabledProjectIdRef.current = activeProjectId;
          setCodebaseEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  // Listen for codebase scope changes broadcast by the backend (e.g. when
  // the user toggles the enabled switch in ProjectCodebasePanel). This keeps
  // the TopBar indicator in sync without requiring a manual refresh.
  useEffect(() => {
    const dispose = window.snow.onCodebaseScopeChanged((payload) => {
      if (payload.key === "enabled" && payload.projectId === activeProjectId) {
        enabledProjectIdRef.current = activeProjectId;
        setCodebaseEnabled(payload.enabled);
      }
    });
    return () => {
      dispose();
    };
  }, [activeProjectId]);

  // Derive the effective enabled state: only treat codebaseEnabled as true
  // if it was confirmed for the currently active project. This guards against
  // the React state batch-update race where activeProjectId changes but
  // codebaseEnabled still holds the previous project's value.
  const effectiveEnabled =
    codebaseEnabled && enabledProjectIdRef.current === activeProjectId;

  // Load the index stats for the active project and update `codebaseIndexed`.
  // Generation-guarded so a slow response for a previously active project
  // never overwrites the current project's state.
  const loadCodebaseIndexed = useCallback((): void => {
    if (!activeProjectId) {
      setCodebaseIndexed(false);
      return;
    }
    const generation = statsGenerationRef.current;
    void window.snow
      .getCodebaseIndexStats(activeProjectId)
      .then((stats) => {
        if (statsGenerationRef.current === generation) {
          setCodebaseIndexed(stats.isIndexed);
        }
      })
      .catch(() => {
        if (statsGenerationRef.current === generation) {
          setCodebaseIndexed(false);
        }
      });
  }, [activeProjectId]);

  const { syncStatus, watchedProjectId } = useCodebaseWatcher({
    projectId: activeProjectId,
    projectPath: activeProjectPath,
    enabled: effectiveEnabled,
    // Fallback refresh: whenever an incremental sync finishes for the watched
    // project, re-read the index stats. This guarantees the indicator moves
    // off the "syncing" state even if a broadcast progress event was missed.
    onSyncFinished: loadCodebaseIndexed,
  });

  // 发布同步状态快照：右面板全屏时 TopBar 中部隐藏，悬浮聊天头部订阅展示；
  // Windows 下 RightPanel 的 Plus 菜单也据此判断是否提供“代码库”项。
  useEffect(() => {
    codebaseSyncStore.set({
      syncStatus,
      watchedProjectId,
      activeProjectId,
      isIndexed: codebaseIndexed,
      enabled: effectiveEnabled,
      embedError: codebaseEmbedError,
    });
  }, [
    syncStatus,
    watchedProjectId,
    activeProjectId,
    codebaseIndexed,
    effectiveEnabled,
    codebaseEmbedError,
  ]);

  // Load index stats to determine whether the codebase has been indexed.
  // The indicator uses this to distinguish "watching with an existing index"
  // (green dot) from "enabled but never embedded" (amber pulsing dot).
  // Reload when the project changes or when a sync/embed completes.
  useEffect(() => {
    if (!activeProjectId) {
      setCodebaseIndexed(false);
      return;
    }

    // Bump the generation so any in-flight stats response from a previous
    // project/effect run is discarded.
    statsGenerationRef.current += 1;

    loadCodebaseIndexed();

    // Refresh stats after a sync completes (done / no_changes) so the
    // indicator updates from "pending" to "watching" once the first embed
    // finishes, or stays current after incremental syncs.
    const disposeSync = window.snow.onCodebaseSyncProgress(
      (progress, changedProjectId) => {
        if (
          changedProjectId === activeProjectId &&
          (progress.phase === "done" || progress.phase === "no_changes")
        ) {
          loadCodebaseIndexed();
        }
      },
    );

    // Refresh stats when the initial (full) embedding finishes. The embed
    // progress broadcast ("done" phase) is the only signal the TopBar
    // receives for a first-time embedding — the incremental sync channel
    // (`codebase:sync:progress`) is not emitted for it. Without this, the
    // indicator stays amber ("enabled but never embedded") until the user
    // switches projects and back, which re-runs the stats load.
    // The same broadcast also drives the indicator's error state: an "error"
    // phase turns the dot red (with the message as tooltip), and a "done"
    // phase clears any previous error (see #16/#17).
    const disposeEmbed = window.snow.onCodebaseEmbedProgress(
      (progress, changedProjectId) => {
        if (changedProjectId !== activeProjectId) {
          return;
        }
        if (progress.phase === "done") {
          setCodebaseEmbedError(null);
          loadCodebaseIndexed();
        } else if (progress.phase === "error") {
          setCodebaseEmbedError(progress.error || null);
        }
      },
    );

    return () => {
      statsGenerationRef.current += 1;
      disposeSync();
      disposeEmbed();
    };
  }, [activeProjectId, loadCodebaseIndexed]);

  useEffect(() => {
    if (!conversationDirectoryId) {
      setConversationDirectoryName(undefined);
      return;
    }

    if (conversationDirectoryId === activeDirectory?.directoryId) {
      setConversationDirectoryName(activeDirectory.name);
      return;
    }

    let cancelled = false;

    void window.snow
      .listWorkspaceDirectories()
      .then((directories) => {
        if (cancelled) {
          return;
        }
        const matched = directories.find(
          (directory) => directory.directoryId === conversationDirectoryId,
        );
        setConversationDirectoryName(matched?.name);
      })
      .catch(() => {
        // Silent fail
      });

    return () => {
      cancelled = true;
    };
  }, [conversationDirectoryId, activeDirectory]);

  // Fetch the active conversation's persisted meta (conversation type, sub-agent
  // fields, parent id) and, when it is a sub-agent conversation, the parent
  // conversation's identity so the header can show where the run came from.
  // The parent is displayed by its AI-generated summary when available —
  // the raw title is just the (possibly file-tag-laden) first user message —
  // falling back to the title only while no summary exists yet.
  useEffect(() => {
    if (!activeConversationId) {
      setActiveConversationMeta(null);
      setParentConversationTitle("");
      return;
    }

    let cancelled = false;
    void window.snow
      .getChatConversation(activeConversationId)
      .then((record) => {
        if (cancelled || !record) {
          return null;
        }
        setActiveConversationMeta({
          conversationType: record.conversationType,
          title: record.title,
          subAgentName: record.subAgentName,
          parentConversationId: record.parentConversationId,
        });
        return record.parentConversationId
          ? window.snow.getChatConversation(record.parentConversationId)
          : null;
      })
      .then((parentRecord) => {
        if (cancelled) {
          return;
        }
        setParentConversationTitle(
          parentRecord?.summary || parentRecord?.title || "",
        );
      })
      .catch(() => {
        // Best effort — the header falls back to the project name.
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  const parentConversationId =
    activeConversationMeta?.parentConversationId ?? "";
  // The parent's summary is generated asynchronously by the backend right
  // after its first user message. When the sub-agent view is opened during
  // that window the fetch above only sees an empty summary (title fallback);
  // the sidebar upsert channel broadcasts the refreshed record once the
  // summary is persisted, so watch it and swap the subtitle in place.
  useEffect(() => {
    const record = upsertedConversation?.record;
    if (
      !record ||
      !parentConversationId ||
      record.conversationId !== parentConversationId ||
      !record.summary
    ) {
      return;
    }
    setParentConversationTitle(record.summary);
  }, [upsertedConversation, parentConversationId]);

  // 挂载时从主进程读取置顶状态，保证按钮与真实窗口状态一致。
  useEffect(() => {
    let cancelled = false;
    void window.snow
      .isWindowAlwaysOnTop()
      .then((pinned) => {
        if (!cancelled) {
          setIsAlwaysOnTop(pinned);
        }
      })
      .catch(() => {
        // 查询失败保持默认关闭态。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 原生全屏状态：挂载时同步一次，之后由主进程在全屏切换时推送。
  useEffect(() => {
    if (!isMacOS) {
      return;
    }
    let cancelled = false;
    void window.snow
      .isWindowFullScreen()
      .then((fullScreen) => {
        if (!cancelled) {
          setIsNativeFullScreen(fullScreen);
        }
      })
      .catch(() => {
        // 查询失败保持非全屏态。
      });
    const dispose = window.snow.onWindowFullScreenChanged(
      setIsNativeFullScreen,
    );
    return () => {
      cancelled = true;
      dispose();
    };
  }, [isMacOS]);

  const toggleAlwaysOnTop = (): void => {
    const next = !isAlwaysOnTop;
    setIsAlwaysOnTop(next);
    void window.snow
      .setWindowAlwaysOnTop(next)
      .then((confirmed) => {
        setIsAlwaysOnTop(confirmed);
      })
      .catch(() => {
        // 设置失败回滚到原状态。
        setIsAlwaysOnTop(!next);
      });
  };

  const SidebarToggleIcon = isSidebarCollapsed ? SidebarOpen : SidebarClose;
  const sidebarToggleLabel = isSidebarCollapsed
    ? t("topBar.expandSidebar", { defaultValue: "Expand sidebar" })
    : t("topBar.collapseSidebar", { defaultValue: "Collapse sidebar" });
  const RightPanelToggleIcon = isRightPanelCollapsed
    ? SidebarClose
    : SidebarOpen;
  const rightPanelToggleLabel = isRightPanelCollapsed
    ? t("topBar.expandRightPanel", { defaultValue: "Expand right panel" })
    : t("topBar.collapseRightPanel", { defaultValue: "Collapse right panel" });
  const FullscreenToggleIcon = isRightPanelFullscreen ? Minimize2 : Maximize2;
  const fullscreenToggleLabel = isRightPanelFullscreen
    ? t("topBar.exitFullscreenRightPanel", {
        defaultValue: "Exit right panel fullscreen",
      })
    : t("topBar.fullscreenRightPanel", {
        defaultValue: "Right panel fullscreen",
      });
  const alwaysOnTopLabel = isAlwaysOnTop
    ? t("topBar.disableAlwaysOnTop", { defaultValue: "Disable Always on Top" })
    : t("topBar.alwaysOnTop", { defaultValue: "Always on Top" });
  const newChatLabel = t("topBar.newChat", { defaultValue: "New chat" });

  const displayDirectoryName = conversationDirectoryId
    ? conversationDirectoryName
    : activeDirectory?.name;

  const isTeamView = activeView === "team";

  // Sub-agent conversations: the header shows the activation summary as the
  // title and the launching parent conversation as the subtitle — the project
  // name alone says nothing about what the run was doing.
  const liveSubAgentEvent = activeConversationId
    ? subAgentSessionEvents[activeConversationId]
    : undefined;
  const isSubAgentConversation =
    Boolean(liveSubAgentEvent) ||
    activeConversationMeta?.conversationType === "sub_agent";
  const subAgentDisplayName =
    liveSubAgentEvent?.agentName ?? activeConversationMeta?.subAgentName ?? "";

  const fallbackChatTitle = t("chat.float.untitled", {
    defaultValue: "New chat",
  });

  // 团队协作视图：标题与副标题取自 TeamPanel 发布的团队数据（团队名 + 远端地址），
  // 数据未就绪时退回项目名与功能名，与备忘录等独立页面的顶栏标题保持一致。
  const headerTitle = isTeamView
    ? teamTopBar?.teamName ||
      displayDirectoryName ||
      t("team.setup.title", { defaultValue: "团队协作" })
    : isSubAgentConversation
      ? activeConversationMeta?.title ||
        summary ||
        displayDirectoryName ||
        fallbackChatTitle
      : summary || displayDirectoryName || fallbackChatTitle;
  const headerSubtitle = isTeamView
    ? teamTopBar
      ? teamTopBar.endpoint ||
        t("team.header.noEndpoint", {
          defaultValue: "团队服务未启动",
        })
      : ""
    : isSubAgentConversation
      ? parentConversationTitle
        ? t("chat.subAgentInfo.launchedBy", {
            defaultValue: 'Launched by parent "{{title}}"',
            values: { title: parentConversationTitle },
          })
        : subAgentDisplayName
      : displayDirectoryName || "";

  // 独立页面（备忘录 / 项目记忆 / 定时任务 / 插件）：标题与关闭按钮由 TopBar 承担，
  // 中部让位给页面本身，不再展示待办面板与代码库同步指示器。
  const featurePage = isFeaturePageView(activeView)
    ? FEATURE_PAGE_TITLES[activeView]
    : null;
  const featurePageTitle = featurePage
    ? t(featurePage.key, { defaultValue: featurePage.defaultValue })
    : "";

  // 设置页同样把标题与关闭按钮交给 TopBar：标题取原面板头部文案，描述作为副标题。
  const settingsPage = getSettingsPageMeta(activeView);
  const settingsPageTitle = settingsPage
    ? t(settingsPage.title.key, {
        defaultValue: settingsPage.title.defaultValue,
      })
    : "";
  const settingsPageDescription = settingsPage
    ? t(settingsPage.description.key, {
        defaultValue: settingsPage.description.defaultValue,
      })
    : "";

  const pageTitle = featurePage
    ? featurePageTitle
    : settingsPage
      ? settingsPageTitle
      : headerTitle;
  const pageSubtitle = featurePage
    ? ""
    : settingsPage
      ? settingsPageDescription
      : headerSubtitle;

  // 代码库功能已开启且当前项目嵌入完毕后，才在 Plus 菜单中提供“代码库”项。
  const canOpenCodebase =
    effectiveEnabled && codebaseIndexed && activeProjectId;

  // 项目标签右键菜单：快速在当前项目打开终端/浏览器/代码库，
  // 以及复制路径、在文件管理器中显示（SSH 远程工作区不可用）。
  const projectPath = activeDirectory?.path ?? "";
  const isSshProject =
    activeDirectory?.kind === "ssh" || projectPath.startsWith("ssh://");
  const branchContextMenuItems: ContextMenuItem[] = [
    {
      id: "terminal",
      label: t("topBar.plusMenu.terminal", { defaultValue: "Terminal" }),
      icon: <Terminal size={13} strokeWidth={1.8} />,
      onClick: () => {
        setBranchContextMenu(null);
        onOpenTerminal?.();
      },
    },
    {
      id: "browser",
      label: t("topBar.plusMenu.browser", { defaultValue: "Browser" }),
      icon: <Globe size={13} strokeWidth={1.8} />,
      onClick: () => {
        setBranchContextMenu(null);
        onOpenBrowser?.();
      },
    },
    {
      id: "drawing",
      label: t("topBar.plusMenu.drawing", { defaultValue: "Drawing" }),
      icon: <Paintbrush size={13} strokeWidth={1.8} />,
      onClick: () => {
        setBranchContextMenu(null);
        onOpenDrawing?.();
      },
    },
    ...(canOpenCodebase && activeProjectId
      ? [
          {
            id: "codebase",
            label: t("topBar.plusMenu.codebase"),
            icon: <Database size={13} strokeWidth={1.8} />,
            onClick: () => {
              setBranchContextMenu(null);
              onOpenCodebase?.(
                activeProjectId,
                activeDirectory?.name ?? activeProjectId,
              );
            },
          },
        ]
      : []),
    {
      id: "tasks",
      label: t("topBar.plusMenu.tasks", { defaultValue: "Task manager" }),
      icon: <Gauge size={13} strokeWidth={1.8} />,
      onClick: () => {
        setBranchContextMenu(null);
        onOpenTaskManager?.();
      },
    },
    {
      id: "copy-path",
      separator: true,
      label: t("topBar.copyProjectPath", {
        defaultValue: "Copy Project Path",
      }),
      icon: <Copy size={13} strokeWidth={1.8} />,
      disabled: !projectPath || isSshProject,
      onClick: () => {
        setBranchContextMenu(null);
        void window.snow.writeClipboardText(projectPath).catch(() => {
          // 剪贴板写入失败时静默忽略。
        });
      },
    },
    {
      id: "reveal",
      label: t("topBar.revealInExplorer", {
        defaultValue: "Show in Explorer",
      }),
      icon: <FolderOpen size={13} strokeWidth={1.8} />,
      disabled: !projectPath || isSshProject,
      onClick: () => {
        setBranchContextMenu(null);
        void window.snow.showItemInFolder(projectPath).catch(() => {
          // 打开文件管理器失败时静默忽略。
        });
      },
    },
  ];

  const plusMenuItems: PlusMenuItem[] = [
    {
      id: "terminal",
      label: t("topBar.plusMenu.terminal", { defaultValue: "Terminal" }),
      icon: Terminal,
    },
    {
      id: "browser",
      label: t("topBar.plusMenu.browser", { defaultValue: "Browser" }),
      icon: Globe,
    },
    {
      id: "drawing",
      label: t("topBar.plusMenu.drawing", { defaultValue: "Drawing" }),
      icon: Paintbrush,
    },
    ...(explorerPlacement === "right-panel"
      ? [
          {
            id: "explorer" as const,
            label: t("topBar.plusMenu.explorer", { defaultValue: "Explorer" }),
            icon: FolderTree,
          },
        ]
      : []),
    ...(canOpenCodebase
      ? [
          {
            id: "codebase" as const,
            label: t("topBar.plusMenu.codebase"),
            icon: Database,
          },
        ]
      : []),
    {
      id: "tasks",
      label: t("topBar.plusMenu.tasks", { defaultValue: "Task manager" }),
      icon: Gauge,
    },
    {
      id: "devtools",
      label: t("topBar.plusMenu.devtools", {
        defaultValue: "Developer tools",
      }),
      icon: Bug,
    },
    ...pluginPanels.map(({ plugin, panelIndex }) => {
      const panel = plugin.panels[panelIndex];
      const panelTitle = resolveLocalized(panel.title, locale);
      return {
        id: `plugin:${plugin.pluginId}:${panel.id}`,
        label: panelTitle,
        title: `${resolveLocalized(plugin.name, locale)} · ${panelTitle}`,
        icon: Puzzle,
        section: "plugins",
        sectionLabel: t("rightPanel.tabContextGroupPlugins", {
          defaultValue: "Plugins",
        }),
        iconNode: (
          <PluginIcon
            pluginId={plugin.pluginId}
            icon={panel.icon || plugin.icon}
            size={13}
          />
        ),
      } satisfies PlusMenuItem;
    }),
  ];

  const handlePlusMenuAction = (actionId: string): void => {
    if (actionId.startsWith("plugin:")) {
      const [, pluginId, panelId] = actionId.split(":");
      if (pluginId && panelId) {
        onOpenPluginPanel?.(pluginId, panelId);
      }
      return;
    }
    if (actionId === "terminal") {
      onOpenTerminal?.();
    } else if (actionId === "browser") {
      onOpenBrowser?.();
    } else if (actionId === "drawing") {
      onOpenDrawing?.();
    } else if (actionId === "tasks") {
      onOpenTaskManager?.();
    } else if (actionId === "devtools") {
      void window.snow.toggleDevTools();
    } else if (actionId === "explorer") {
      onOpenProjectExplorer?.(activeProjectId ?? "");
    } else if (actionId === "codebase" && activeProjectId) {
      onOpenCodebase?.(
        activeProjectId,
        activeDirectory?.name ?? activeProjectId,
      );
    }
  };

  // macOS 原生全屏时红绿灯被系统隐藏，复用无边框平台（Windows / Linux）的 LOGO
  // 方案填补左侧空缺。
  const topBarLogo =
    hasCustomFrame || isNativeFullScreen ? (
      <SnowLogo className="top-bar-logo" />
    ) : null;

  const sidebarActions = (
    <div
      className="top-bar-sidebar-actions"
      aria-label={t("topBar.sidebarActions", {
        defaultValue: "Sidebar actions",
      })}
    >
      <button
        className="icon-btn sidebar-toggle-btn"
        type="button"
        aria-label={sidebarToggleLabel}
        title={sidebarToggleLabel}
        onClick={onToggleSidebar}
      >
        <SidebarToggleIcon size={16} strokeWidth={1.8} />
      </button>
      <button
        className={`icon-btn always-on-top-btn${isAlwaysOnTop ? " active" : ""}`}
        type="button"
        aria-label={alwaysOnTopLabel}
        title={alwaysOnTopLabel}
        onClick={toggleAlwaysOnTop}
      >
        <Pin size={16} strokeWidth={1.8} />
      </button>
      <button
        className="icon-btn new-chat-btn"
        type="button"
        aria-label={newChatLabel}
        aria-disabled={sshGate.blocked}
        title={sshGate.blocked ? sshGateLabel : newChatLabel}
        onClick={() => {
          // SSH 项目未连接：拦下入口，点击即显式重连
          if (sshGate.blocked) {
            sshGate.requestConnection();
            return;
          }
          // 新建会话时收回独立页面（备忘录 / 记忆 / 定时任务 / 插件）、
          // 团队协作视图与设置页，让新会话在聊天视图里立即可见。
          if (
            isFeaturePageView(activeView) ||
            isTeamView ||
            SETTINGS_VIEW_IDS.has(activeView)
          ) {
            onSelectView("chat");
          }
          // 同时通知侧栏收回设置内容（与设置页是否打开无关）。
          emitNewChatRequested();
          handleNewChat();
        }}
      >
        <SquarePen size={16} strokeWidth={1.8} />
      </button>
    </div>
  );

  const isRightCardMerged = isRightPanelCollapsed && !isRightPanelFullscreen;

  // 右侧区域（项目标签 + 新建/面板/全屏按钮）任意位置右键：提供针对当前项目的
  // 快捷操作。容器需脱离窗口 drag 区域，否则空白处右键不会触发 contextmenu。
  const openBranchContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    setBranchContextMenu({ x: event.clientX, y: event.clientY });
  };

  const branchInfo = (
    <div className="top-bar-branch-info">
      <TopBarBranchSelector
        repoPath={activeDirectory?.path ?? null}
        directoryId={activeDirectory?.directoryId}
        fallbackName={activeDirectory?.name}
        showChangesTab={isRightPanelCollapsed && !isRightPanelFullscreen}
      />
    </div>
  );

  const rightCardActions = (
    <div className="top-bar-right-actions">
      <div className="snow-client-slot" data-snow-slot="topbar.actions" />
      {!hasCustomFrame && !isRightPanelCollapsed && (
        <PlusMenuButton
          items={plusMenuItems}
          onAction={handlePlusMenuAction}
          onOpenChange={setIsPlusMenuOpen}
        />
      )}
      {!isRightPanelFullscreen && (
        <button
          className="icon-btn ghost right-panel-toggle-btn"
          type="button"
          aria-label={rightPanelToggleLabel}
          title={rightPanelToggleLabel}
          onClick={onToggleRightPanel}
        >
          <RightPanelToggleIcon size={16} strokeWidth={1.8} />
        </button>
      )}
      {/* 右面板收起时面板内的 Plus 菜单不可见：在「展开面板」按钮右侧补一个
          Plus 菜单，选中一项即新建对应 tab 并展开面板。 */}
      {isRightPanelCollapsed && !isRightPanelFullscreen && (
        <PlusMenuButton
          items={plusMenuItems}
          onAction={handlePlusMenuAction}
          onOpenChange={setIsPlusMenuOpen}
        />
      )}
      {!hasCustomFrame && (
        <button
          className="icon-btn ghost right-panel-fullscreen-btn"
          type="button"
          aria-label={fullscreenToggleLabel}
          title={fullscreenToggleLabel}
          onClick={onToggleRightPanelFullscreen}
        >
          <FullscreenToggleIcon size={16} strokeWidth={1.8} />
        </button>
      )}
      {hasCustomFrame && <WindowControlsButtons />}
    </div>
  );

  const isTodoPanelInteractive = isTodoPanelOpen && !isTodoPanelPinned;

  return (
    <header
      className={`top-bar${isSidebarCollapsed ? " sidebar-collapsed" : ""}${
        isRightPanelCollapsed ? " right-panel-collapsed" : ""
      }${isPlusMenuOpen ? " plus-menu-open" : ""}${
        isTodoPanelOpen ? " todo-panel-open" : ""
      }${isTodoPanelInteractive ? " todo-panel-interactive" : ""}${
        isNativeFullScreen ? " is-native-fullscreen" : ""
      }`}
      data-snow-anchor="topbar"
    >
      {isSidebarCollapsed ? null : (
        <div className="top-bar-left">
          {topBarLogo}
          {sidebarActions}
        </div>
      )}

      <div className="top-bar-main">
        {isSidebarCollapsed ? (
          <div className="top-bar-main-leading">
            {topBarLogo}
            {sidebarActions}
          </div>
        ) : null}
        <div
          className={`header-title-group${settingsPage ? " is-settings-page" : ""}${isTeamView ? " is-team-page" : ""}`}
        >
          <h2
            className="header-title"
            title={typeof pageTitle === "string" ? pageTitle : undefined}
          >
            {pageTitle}
          </h2>
          {pageSubtitle ? (
            <span
              className="header-subtitle"
              title={
                typeof pageSubtitle === "string" ? pageSubtitle : undefined
              }
            >
              {pageSubtitle}
            </span>
          ) : null}
        </div>
        {featurePage ? (
          <button
            className="icon-btn ghost feature-page-close-btn"
            type="button"
            aria-label={t("common.close", { defaultValue: "Close" })}
            title={t("common.close", { defaultValue: "Close" })}
            onClick={() => onSelectView("chat")}
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        ) : settingsPage ? (
          <SettingsPageTopBarActions
            view={activeView}
            onClose={() => onSelectView("chat")}
          />
        ) : isTeamView ? (
          <TeamTopBarActions onClose={() => onSelectView("chat")} />
        ) : (
          <>
            <TodoPanelButton
              messages={messages}
              conversationId={activeConversationId}
              projectId={
                conversationDirectoryId ?? activeDirectory?.directoryId
              }
              isRunning={isStreaming}
              onOpenChange={setIsTodoPanelOpen}
              onPinnedChange={setIsTodoPanelPinned}
            />
            <CodebaseSyncIndicator
              syncStatus={syncStatus}
              watchedProjectId={watchedProjectId}
              activeProjectId={activeProjectId}
              isIndexed={codebaseIndexed}
              embedError={codebaseEmbedError}
              onClick={() => {
                // 同步指示器点击 → 打开代码库管理弹窗（ChatInputView 监听该事件）。
                window.dispatchEvent(
                  new CustomEvent(OPEN_PROJECT_CODEBASE_PANEL_EVENT),
                );
              }}
            />
          </>
        )}
        {isRightCardMerged ? (
          <div
            className="top-bar-main-trailing"
            onContextMenu={openBranchContextMenu}
          >
            {branchInfo}
            {rightCardActions}
          </div>
        ) : null}
      </div>

      {isRightCardMerged ? null : (
        <div className="top-bar-right" onContextMenu={openBranchContextMenu}>
          {branchInfo}
          {rightCardActions}
        </div>
      )}
      {branchContextMenu && (
        <ContextMenu
          x={branchContextMenu.x}
          y={branchContextMenu.y}
          items={branchContextMenuItems}
          onClose={() => setBranchContextMenu(null)}
        />
      )}
    </header>
  );
};
