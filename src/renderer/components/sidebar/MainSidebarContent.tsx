import {
  AppWindow,
  BookOpen,
  ChevronDown,
  CircleArrowUp,
  CircleHelp,
  Download,
  Ellipsis,
  Keyboard,
  LoaderCircle,
  ScrollText,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { AnimatedMemoIcon } from "../icons/AnimatedMemoIcon";
import { AnimatedNewChatIcon } from "../icons/AnimatedNewChatIcon";
import { AnimatedPluginsIcon } from "../icons/AnimatedPluginsIcon";
import { AnimatedProjectMemoryIcon } from "../icons/AnimatedProjectMemoryIcon";
import { AnimatedScheduledTasksIcon } from "../icons/AnimatedScheduledTasksIcon";
import { AnimatedSearchIcon } from "../icons/AnimatedSearchIcon";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { hasMarketUpdate, isMarketEntryTooNew } from "../../plugins/market";
import {
  findMarketEntry,
  marketStore,
  useMarketStore,
} from "../../plugins/marketStore";
import { runtimeSnapshot } from "../../plugins/runtimeSnapshot";
import {
  clientScriptStore,
  useClientScriptStore,
} from "../../userscripts/clientScriptStore";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { HelpSkillDisabledDialog } from "../common/HelpSkillDisabledDialog";
import { Tooltip } from "../common/Tooltip";
import {
  isHelpSkillDisabled,
  markHelpGuideUsed,
} from "../../constants/helpGuide";
import { shortcutEvents } from "../shortcutEvents";
import { APP_CONTROL_MEMO_CREATED_EVENT } from "../../hooks/useAppControl";
import { useShortcutLabel } from "../../hooks/useShortcutLabel";
import { useKeyboardShortcutsSettings } from "../KeyboardShortcutsProvider";
import { ShortcutHint } from "../ShortcutHint";
import { useScheduledTasks } from "../../hooks/useScheduledTasks";
import { useSshWorkspaceGate } from "../../ssh/sshConnectionStore";
import { getSshConnectionStatusLabel } from "../../ssh/sshConnectionStatus";
import { isFeaturePageView, type FeaturePageView } from "../featurePages";
import { emitNewChatRequested } from "../newChatEvents";
import { SETTINGS_VIEW_IDS } from "./settingsItems";
import { ChatsSection } from "./mainSidebar/ChatsSection";
import { openNewChatInNewWindow } from "./mainSidebar/openConversationInNewWindow";
import { ProjectsSection } from "./mainSidebar/ProjectsSection";
import { useSidebarDisplayMode } from "./mainSidebar/sidebarDisplayMode";
import { SidebarProjectTree } from "./mainSidebar/tree/SidebarProjectTree";
import { TeamEntry } from "./mainSidebar/TeamEntry";
import {
  TEAM_ENABLED_CHANGED_EVENT,
  useTeamSummary,
} from "../mainContent/team/useTeamData";
import { useCrossProjectNotifications } from "./mainSidebar/useCrossProjectNotifications";
import { GlobalSearchModal } from "./GlobalSearchModal";
import { requestGeneralSettingsTab } from "./generalSettingsNavigation";
import { MEMOS_CHANGED_EVENT } from "./memoEvents";
import { OPEN_PROJECT_MEMORY_PANEL_EVENT } from "./projectMemoryNavigation";
import { UpdateDialog, OPEN_UPDATE_DIALOG_EVENT } from "./UpdateDialog";
import type { SidebarContentProps } from "./types";
import type {
  ConversationSearchResult,
  UpdateStatus,
  WorkspaceDirectoryRecord,
} from "../../../preload";

const INITIAL_UPDATE_STATUS: UpdateStatus = {
  available: false,
  version: null,
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null,
  releaseNotes: null,
  releaseNotesZh: null,
  releaseNotesZhTw: null,
};

export function MainSidebarContent({
  activeMainView,
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
  onSwitchContent,
  onSwitchToExplorer,
  onOpenSshWizard,
  onEditSshConnection,
}: SidebarContentProps): React.JSX.Element {
  const { t } = useI18n();
  const { mode: sidebarDisplayMode } = useSidebarDisplayMode();
  const {
    handleSelectConversation,
    handleNewChat,
    activeConversationId,
    prefillComposer,
  } = useChatConversationContext();
  const shortcutLabel = useShortcutLabel("newChat");
  const [isSwitchingDirectory, setIsSwitchingDirectory] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [isChatsCollapsed, setIsChatsCollapsed] = useState(false);
  const [isMoreExpanded, setIsMoreExpanded] = useState(false);
  const [pendingMemoCount, setPendingMemoCount] = useState(0);
  const [memoryCount, setMemoryCount] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(
    INITIAL_UPDATE_STATUS,
  );

  const activeDirectoryId = activeDirectory?.directoryId ?? "";
  // 活动 SSH 项目的连接门禁：未连接时新建会话入口只触发显式重连
  const sshGate = useSshWorkspaceGate(activeDirectory);
  const sshGateLabel = sshGate.status
    ? getSshConnectionStatusLabel(t, sshGate.status)
    : "";

  const handleNewChatInNewWindow = useCallback((): void => {
    openNewChatInNewWindow(
      activeDirectory ?? null,
      t("sidebar.newChat", { defaultValue: "New Chat" }),
    ).catch((error: unknown) => {
      console.error("Failed to open new chat in new window", error);
    });
  }, [activeDirectory, t]);

  const pluginState = usePluginStore();
  const clientScriptState = useClientScriptStore();
  const enabledPluginCount =
    pluginState.plugins.filter((item) => item.enabled).length +
    clientScriptState.scripts.filter((item) => item.enabled).length;

  // 插件市场更新提示：已安装的面板插件 / 脚本插件在市场中存在更高版本时，
  // 在插件入口（或收起的「更多」入口）显示向上箭头，用户无需进入页面即可感知。
  const marketState = useMarketStore();
  const pluginUpdateCount = useMemo(() => {
    let count = 0;
    const check = (id: string, version: string, kind: "plugin" | "script") => {
      const entry = findMarketEntry(marketState.entries, id, kind);
      if (
        entry &&
        hasMarketUpdate(version, entry.version) &&
        !isMarketEntryTooNew(entry, marketState.appVersion)
      ) {
        count += 1;
      }
    };
    pluginState.plugins.forEach((item) =>
      check(item.pluginId, item.version, "plugin"),
    );
    clientScriptState.scripts.forEach((item) =>
      check(item.scriptId, item.version, "script"),
    );
    return count;
  }, [
    pluginState.plugins,
    clientScriptState.scripts,
    marketState.entries,
    marketState.appVersion,
  ]);

  useEffect(() => {
    void pluginStore.ensureLoaded();
    void clientScriptStore.ensureLoaded();
    void marketStore.ensureLoaded();
  }, []);

  // 团队协作入口：当前项目已关联团队（且团队协作开关开启）时展示；
  // 徽标汇总未读动态 / 我的任务 / 待我评审 / 加入申请，直接显示累计数量。
  const [teamRefreshKey, setTeamRefreshKey] = useState(0);
  const {
    team: teamInfo,
    enabled: teamEnabled,
    totalCount: teamTotalCount,
  } = useTeamSummary(
    activeDirectory?.directoryId ?? "",
    activeDirectory?.path ?? "",
    teamRefreshKey,
  );

  // 团队协作开关变化（通用设置面板）：立即重新解析，入口即时显隐
  useEffect(() => {
    const handler = () => setTeamRefreshKey((key) => key + 1);
    window.addEventListener(TEAM_ENABLED_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(TEAM_ENABLED_CHANGED_EVENT, handler);
    };
  }, []);

  // 跨项目通知：聚合其他项目运行中/需关注/已完成的会话，供项目列表
  // 徽标与对话区域「跨项目通知」区块共同消费（单次查询、共享数据）。
  const { groups: crossProjectNotifications, activeSessionDirectoryIds } =
    useCrossProjectNotifications(activeDirectoryId);

  useEffect(() => {
    runtimeSnapshot.patch({
      activeSessionDirectoryIds: Array.from(activeSessionDirectoryIds),
    });
  }, [activeSessionDirectoryIds]);

  // Scheduled tasks: the hook registers buildFromContent as the AI Loop
  // executor and subscribes to the in-memory store. Mounted here (always
  // rendered inside ChatConversationProvider) so the executor is available
  // for the whole app lifetime. Tasks only live while the process is alive.
  // Project isolation: tasks are scoped to the active directory, mirroring
  // the memo project-isolation model.
  const { tasks: scheduledTasks } = useScheduledTasks(
    activeDirectoryId,
    activeDirectory?.path ?? "",
  );
  // 徽标只统计仍会执行的任务，已完成的单次任务不计入
  const activeScheduledTaskCount = useMemo(
    () => scheduledTasks.filter((task) => task.status !== "completed").length,
    [scheduledTasks],
  );

  // Load the pending memo count for the sidebar badge. Sidebar badges come with
  // the first screen; the memo page itself loads its own list only when opened.
  // Refreshed on mount, whenever the active project changes (memos are scoped per
  // directory) and whenever the memo page reports a change.
  const refreshPendingMemoCount = useCallback(() => {
    if (!activeDirectoryId) {
      setPendingMemoCount(0);
      return;
    }
    window.snow
      .getMemoCountSummary(activeDirectoryId)
      .then((summary) => setPendingMemoCount(summary.pending))
      .catch(() => undefined);
  }, [activeDirectoryId]);

  useEffect(() => {
    refreshPendingMemoCount();
  }, [refreshPendingMemoCount]);

  useEffect(() => {
    const handler = () => {
      refreshPendingMemoCount();
    };
    window.addEventListener(APP_CONTROL_MEMO_CREATED_EVENT, handler);
    window.addEventListener(MEMOS_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(APP_CONTROL_MEMO_CREATED_EVENT, handler);
      window.removeEventListener(MEMOS_CHANGED_EVENT, handler);
    };
  }, [refreshPendingMemoCount]);

  // 加载当前项目的记忆总条数，用于侧边栏徽标：挂载、切换项目时刷新
  // （AI 记忆写工具成功后主进程会广播，命中当前项目时同样刷新）。
  const refreshMemoryCount = useCallback(() => {
    if (!activeDirectoryId) {
      setMemoryCount(0);
      return;
    }
    window.snow
      .getProjectMemoryStats(activeDirectoryId)
      .then((stats) => setMemoryCount(stats.total))
      .catch(() => undefined);
  }, [activeDirectoryId]);

  useEffect(() => {
    refreshMemoryCount();
  }, [refreshMemoryCount]);

  // /memory 面板「在项目记忆中定位」：切到项目记忆页面，
  // 检索词由记忆页面自行从导航模块取走（事件先于页面挂载到达也不丢失）。
  useEffect(() => {
    const handler = () => {
      onSelectMainView("memory");
    };
    window.addEventListener(OPEN_PROJECT_MEMORY_PANEL_EVENT, handler);
    return () => {
      window.removeEventListener(OPEN_PROJECT_MEMORY_PANEL_EVENT, handler);
    };
  }, [onSelectMainView]);

  // 订阅 AI 记忆写工具的变更广播：memory-manage 的写动作成功后，
  // 主进程带项目 ID 广播，命中当前项目时刷新徽标。
  useEffect(() => {
    const unsubscribe = window.snow.onMemoriesChanged((directoryId) => {
      if (!directoryId || directoryId === activeDirectoryId) {
        refreshMemoryCount();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [activeDirectoryId, refreshMemoryCount]);

  // 订阅自动更新状态：autoUpdater 在启动后自动检测更新，发现新版本时
  // 通过 onUpdateStatusChanged 推送，此处据此在设置按钮旁显示更新入口。
  useEffect(() => {
    window.snow
      .getUpdateStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    const unsubscribe = window.snow.onUpdateStatusChanged((status) => {
      setUpdateStatus(status);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // 订阅更新弹窗打开请求：设置面板等入口 dispatch 事件后此处打开弹窗
  useEffect(() => {
    const handler = () => {
      setIsUpdateDialogOpen(true);
    };
    window.addEventListener(OPEN_UPDATE_DIALOG_EVENT, handler);
    return () => {
      window.removeEventListener(OPEN_UPDATE_DIALOG_EVENT, handler);
    };
  }, []);

  // 独立页面（备忘录 / 项目记忆 / 定时任务 / 插件）的开关：再次点击同一入口
  // 收回聊天视图；当前是设置等其他视图时也可直接切换过去。
  const toggleFeaturePage = useCallback(
    (view: FeaturePageView): void => {
      onSelectMainView(activeMainView === view ? "chat" : view);
    },
    [activeMainView, onSelectMainView],
  );

  // 独立页面入口收纳在「更多」折叠区内：页面打开时自动展开，
  // 保证当前页面的入口可见、选中态可被看到。
  useEffect(() => {
    if (isFeaturePageView(activeMainView) && activeMainView !== "repo-wiki") {
      setIsMoreExpanded(true);
    }
  }, [activeMainView]);

  // 新建会话前收回独立页面与设置页：新会话在聊天视图里创建，页面不应继续占用主区域。
  // 侧栏回到主内容由 Sidebar 监听新建会话事件统一处理。
  const handleNewChatFromSidebar = useCallback((): void => {
    // SSH 项目未连接：拦下入口（不创建 pending 会话），点击即显式重连
    if (sshGate.blocked) {
      sshGate.requestConnection();
      return;
    }
    if (
      isFeaturePageView(activeMainView) ||
      SETTINGS_VIEW_IDS.has(activeMainView)
    ) {
      onSelectMainView("chat");
    }
    emitNewChatRequested();
    handleNewChat();
  }, [
    activeMainView,
    handleNewChat,
    onSelectMainView,
    sshGate.blocked,
    sshGate.requestConnection,
  ]);

  const [isHelpSkillDialogOpen, setIsHelpSkillDialogOpen] = useState(false);

  // 「使用指南」：新建会话并预填提问（不自动发送）；非聊天视图先切回聊天。
  const handleOpenUserGuide = useCallback((): void => {
    void isHelpSkillDisabled(activeDirectoryId || undefined).then(
      (disabled) => {
        if (disabled) {
          setIsHelpSkillDialogOpen(true);
          return;
        }
        if (activeMainView !== "chat") {
          onSelectMainView("chat");
        }
        markHelpGuideUsed();
        prefillComposer(t("chatCommand.helpPromptGeneral"), { newChat: true });
      },
    );
  }, [activeDirectoryId, activeMainView, onSelectMainView, prefillComposer, t]);

  // 「使用指南」浮层菜单：菜单挂在页脚（页脚行 overflow: hidden 会裁掉绝对定位子元素），
  // 按钮与菜单分处两处，点击外部判定同时排除二者。
  const [isHelpMenuOpen, setIsHelpMenuOpen] = useState(false);
  const helpMenuRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const { registerScopedHandler } = useKeyboardShortcutsSettings();

  useEffect(() => {
    if (!isHelpMenuOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        helpMenuRef.current?.contains(target) ||
        helpButtonRef.current?.contains(target)
      ) {
        return;
      }
      setIsHelpMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isHelpMenuOpen]);

  // 菜单打开期间接管 cancelSession（默认 ESC）：只关闭菜单，
  // 绝不冒泡到全局「中断会话」处理器误停 AI 会话。
  useEffect(() => {
    if (!isHelpMenuOpen) {
      return undefined;
    }
    return registerScopedHandler(
      "cancelSession",
      () => setIsHelpMenuOpen(false),
      () => true,
    );
  }, [isHelpMenuOpen, registerScopedHandler]);

  /** 打开使用指南（原有行为），并收起菜单。 */
  const handleOpenUserGuideFromMenu = useCallback((): void => {
    setIsHelpMenuOpen(false);
    handleOpenUserGuide();
  }, [handleOpenUserGuide]);

  /** 打开快捷键帮助浮层（与 mod+/ 快捷键同一事件）。 */
  const handleOpenShortcutHelp = useCallback((): void => {
    setIsHelpMenuOpen(false);
    shortcutEvents.emit("show-shortcut-help");
  }, []);

  /** 打开更新日志：切到设置内容页的「通用设置 - 更新日志」tab。 */
  const handleOpenChangelog = useCallback((): void => {
    setIsHelpMenuOpen(false);
    requestGeneralSettingsTab("changelog");
    onSelectMainView("general-settings");
    onSwitchContent("settings");
  }, [onSelectMainView, onSwitchContent]);

  // 订阅快捷键事件：Ctrl/Cmd+F 切换搜索面板，Ctrl/Cmd+B 切换备忘录页面。
  // 快捷键引擎通过 shortcutEvents 总线触发，页面切换状态由父级持有。
  useEffect(() => {
    const unsubSearch = shortcutEvents.on("toggle-search", () => {
      setIsSearchOpen((prev) => !prev);
    });
    const unsubMemo = shortcutEvents.on("toggle-memo", () => {
      if (!activeDirectoryId) return;
      toggleFeaturePage("memo");
    });
    const unsubNewChat = shortcutEvents.on("new-chat", () => {
      handleNewChatFromSidebar();
    });
    const unsubNewChatInNewWindow = shortcutEvents.on(
      "new-chat-in-new-window",
      () => {
        handleNewChatInNewWindow();
      },
    );
    const unsubMemory = shortcutEvents.on("toggle-project-memory", () => {
      if (!activeDirectoryId) return;
      toggleFeaturePage("memory");
    });
    const unsubScheduledTasks = shortcutEvents.on(
      "toggle-scheduled-tasks",
      () => {
        toggleFeaturePage("scheduled-tasks");
      },
    );
    const unsubPlugins = shortcutEvents.on("toggle-plugins", () => {
      toggleFeaturePage("plugins");
    });
    return () => {
      unsubSearch();
      unsubMemo();
      unsubNewChat();
      unsubNewChatInNewWindow();
      unsubMemory();
      unsubScheduledTasks();
      unsubPlugins();
    };
  }, [
    activeDirectoryId,
    toggleFeaturePage,
    handleNewChatFromSidebar,
    handleNewChatInNewWindow,
  ]);

  const handleSearchSelectConversation = (
    conversation: ConversationSearchResult,
  ): void => {
    void handleSelectConversation(
      conversation.conversationId,
      conversation.summary || conversation.title,
      {
        inputTokens: conversation.inputTokens,
        outputTokens: conversation.outputTokens,
        cacheCreationInputTokens: conversation.cacheCreationInputTokens,
        cacheReadInputTokens: conversation.cacheReadInputTokens,
      },
      conversation.directoryId,
    );
  };

  const handleSearchSelectDirectory = useCallback(
    (directory: WorkspaceDirectoryRecord): void => {
      onActiveDirectoryChange?.(directory);
      onSwitchContent?.("main");
    },
    [onActiveDirectoryChange, onSwitchContent],
  );

  return (
    <>
      {/* 团队协作入口（数据库 + WebSocket，置于侧边栏顶部）：开关开启且已打开项目即展示，
          未关联团队时进入面板即可创建或加入 */}
      {teamEnabled && activeDirectory ? (
        <div className="sidebar-team-entry">
          <TeamEntry
            team={teamInfo}
            badgeCount={teamTotalCount}
            onClick={() => {
              onSwitchContent?.("main");
              onSelectMainView?.("team");
            }}
          />
        </div>
      ) : null}
      <div className="sidebar-search-bar" data-snow-anchor="sidebar.nav">
        <button
          className="nav-item sidebar-search-btn"
          onClick={() => setIsSearchOpen(true)}
          type="button"
        >
          <AnimatedSearchIcon size={16} strokeWidth={1.8} />
          <span>
            {t("sidebar.search", {
              defaultValue: "Search",
            })}
          </span>
          <ShortcutHint action="openSearch" />
        </button>
        <div className="sidebar-new-chat-row">
          <button
            className="nav-item sidebar-new-chat-btn"
            aria-disabled={sshGate.blocked}
            onClick={handleNewChatFromSidebar}
            title={
              sshGate.blocked
                ? sshGateLabel
                : `${t("sidebar.newChat", { defaultValue: "New Chat" })} (${shortcutLabel})`
            }
            type="button"
          >
            <AnimatedNewChatIcon size={16} strokeWidth={1.8} />
            <span>{t("sidebar.newChat", { defaultValue: "New Chat" })}</span>
            <ShortcutHint
              action="newChat"
              className="sidebar-new-chat-shortcut"
            />
          </button>
          <button
            className="sidebar-new-chat-window-btn"
            onClick={handleNewChatInNewWindow}
            title={t("rightPanel.openInNewWindow", {
              defaultValue: "Open in new window",
            })}
            aria-label={t("rightPanel.openInNewWindow", {
              defaultValue: "Open in new window",
            })}
            type="button"
          >
            <AppWindow size={14} strokeWidth={1.8} />
          </button>
        </div>
        <div className="sidebar-more-row">
          <button
            className={`nav-item sidebar-more-btn${
              isMoreExpanded ? " expanded" : ""
            }${
              isFeaturePageView(activeMainView) &&
              activeMainView !== "repo-wiki"
                ? " active"
                : ""
            }`}
            aria-expanded={isMoreExpanded}
            onClick={() => setIsMoreExpanded((prev) => !prev)}
            title={t("sidebar.more", { defaultValue: "More" })}
            type="button"
          >
            <Ellipsis size={16} strokeWidth={1.8} />
            <span>{t("sidebar.more", { defaultValue: "More" })}</span>
            <ChevronDown
              className="sidebar-more-chevron"
              size={14}
              strokeWidth={1.8}
            />
          </button>
          {/* 插件更新提示常亮：不参与悬停淡入，有更新即常显，点击直达插件页 */}
          {!isMoreExpanded && pluginUpdateCount > 0 && (
            <span className="sidebar-more-update">
              <Tooltip
                content={t("plugins.updateAvailable", {
                  values: { count: pluginUpdateCount },
                  defaultValue: "{{count}} plugin updates available",
                })}
              >
                <button
                  className="sidebar-more-update-btn"
                  onClick={() => onSelectMainView("plugins")}
                  type="button"
                >
                  <CircleArrowUp size={14} strokeWidth={2} />
                </button>
              </Tooltip>
            </span>
          )}
          {/* 收起时数值徽章常驻显示：悬停可见含义，点击直达对应面板 */}
          {!isMoreExpanded &&
            (pendingMemoCount > 0 ||
              memoryCount > 0 ||
              activeScheduledTaskCount > 0 ||
              enabledPluginCount > 0) && (
              <span
                className={`sidebar-more-summary${
                  pluginUpdateCount > 0 ? " is-shifted" : ""
                }`}
              >
                {pendingMemoCount > 0 && (
                  <Tooltip
                    content={t("sidebar.morePendingMemos", {
                      values: { count: pendingMemoCount },
                      defaultValue: "{{count}} pending memos",
                    })}
                  >
                    <button
                      className="sidebar-more-badge is-pending"
                      onClick={() => onSelectMainView("memo")}
                      type="button"
                    >
                      {pendingMemoCount}
                    </button>
                  </Tooltip>
                )}
                {memoryCount > 0 && (
                  <Tooltip
                    content={t("sidebar.moreMemories", {
                      values: { count: memoryCount },
                      defaultValue: "{{count}} project memory entries",
                    })}
                  >
                    <button
                      className="sidebar-more-badge"
                      onClick={() => onSelectMainView("memory")}
                      type="button"
                    >
                      {memoryCount}
                    </button>
                  </Tooltip>
                )}
                {activeScheduledTaskCount > 0 && (
                  <Tooltip
                    content={t("sidebar.moreScheduledTasks", {
                      values: { count: activeScheduledTaskCount },
                      defaultValue: "{{count}} active scheduled tasks",
                    })}
                  >
                    <button
                      className="sidebar-more-badge is-tasks"
                      onClick={() => onSelectMainView("scheduled-tasks")}
                      type="button"
                    >
                      {activeScheduledTaskCount}
                    </button>
                  </Tooltip>
                )}
                {enabledPluginCount > 0 && (
                  <Tooltip
                    content={t("sidebar.morePlugins", {
                      values: { count: enabledPluginCount },
                      defaultValue: "{{count}} enabled plugins / scripts",
                    })}
                  >
                    <button
                      className="sidebar-more-badge is-plugins"
                      onClick={() => onSelectMainView("plugins")}
                      type="button"
                    >
                      {enabledPluginCount}
                    </button>
                  </Tooltip>
                )}
              </span>
            )}
        </div>
        <div
          aria-hidden={!isMoreExpanded}
          className={`sidebar-more-items${isMoreExpanded ? " expanded" : ""}`}
        >
          <div className="sidebar-more-items-inner">
            <button
              className={`nav-item sidebar-memo-btn${
                activeMainView === "memo" ? " active" : ""
              }`}
              disabled={!activeDirectoryId}
              onClick={() => toggleFeaturePage("memo")}
              title={t("memo.sidebarEntry", { defaultValue: "Memos" })}
              type="button"
            >
              <AnimatedMemoIcon size={16} strokeWidth={1.8} />
              <span>{t("memo.sidebarEntry", { defaultValue: "Memos" })}</span>
              {pendingMemoCount > 0 && (
                <span className="sidebar-memo-badge">{pendingMemoCount}</span>
              )}
            </button>
            <button
              className={`nav-item sidebar-memory-btn${
                activeMainView === "memory" ? " active" : ""
              }`}
              disabled={!activeDirectoryId}
              onClick={() => toggleFeaturePage("memory")}
              title={t("memory.sidebarEntry", {
                defaultValue: "Project Memory",
              })}
              type="button"
            >
              <AnimatedProjectMemoryIcon size={16} strokeWidth={1.8} />
              <span>
                {t("memory.sidebarEntry", { defaultValue: "Project Memory" })}
              </span>
              {memoryCount > 0 && (
                <span className="sidebar-memory-badge">{memoryCount}</span>
              )}
            </button>
            <button
              className={`nav-item sidebar-scheduled-tasks-btn${
                activeMainView === "scheduled-tasks" ? " active" : ""
              }`}
              onClick={() => toggleFeaturePage("scheduled-tasks")}
              title={t("scheduledTask.sidebarEntry", {
                defaultValue: "Scheduled Tasks",
              })}
              type="button"
            >
              <AnimatedScheduledTasksIcon size={16} strokeWidth={1.8} />
              <span>
                {t("scheduledTask.sidebarEntry", {
                  defaultValue: "Scheduled Tasks",
                })}
              </span>
              {activeScheduledTaskCount > 0 && (
                <span className="sidebar-memo-badge">
                  {activeScheduledTaskCount}
                </span>
              )}
            </button>
            <button
              className={`nav-item sidebar-plugins-btn${
                activeMainView === "plugins" ? " active" : ""
              }`}
              onClick={() => toggleFeaturePage("plugins")}
              title={t("plugins.sidebarEntry", { defaultValue: "Plugins" })}
              type="button"
            >
              <AnimatedPluginsIcon size={16} strokeWidth={1.8} />
              <span>
                {t("plugins.sidebarEntry", { defaultValue: "Plugins" })}
              </span>
              {pluginUpdateCount > 0 && (
                <span
                  className="sidebar-update-icon"
                  title={t("plugins.updateAvailable", {
                    values: { count: pluginUpdateCount },
                    defaultValue: "{{count}} plugin updates available",
                  })}
                >
                  <CircleArrowUp size={14} strokeWidth={2} />
                </span>
              )}
              {enabledPluginCount > 0 && (
                <span className="sidebar-memory-badge">
                  {enabledPluginCount}
                </span>
              )}
            </button>
          </div>
        </div>
        <div
          className="snow-client-slot"
          data-snow-slot="sidebar.nav.actions"
        />
      </div>
      {sidebarDisplayMode === "tree" ? (
        <SidebarProjectTree
          activeDirectory={activeDirectory}
          activeSessionDirectoryIds={activeSessionDirectoryIds}
          notificationGroups={crossProjectNotifications}
          onActiveDirectoryChange={onActiveDirectoryChange}
          onEditSshConnection={onEditSshConnection}
          onOpenSshWizard={onOpenSshWizard}
          onSwitchToExplorer={onSwitchToExplorer}
          onSwitchingDirectoryChange={setIsSwitchingDirectory}
        />
      ) : (
        <>
          <ProjectsSection
            activeDirectory={activeDirectory}
            activeConversationId={activeConversationId}
            activeSessionDirectoryIds={activeSessionDirectoryIds}
            notificationGroups={crossProjectNotifications}
            onActiveDirectoryChange={onActiveDirectoryChange}
            onSwitchingDirectoryChange={setIsSwitchingDirectory}
            onSwitchContent={onSwitchContent}
            onSwitchToExplorer={onSwitchToExplorer}
            onEditSshConnection={onEditSshConnection}
            onOpenSshWizard={onOpenSshWizard}
            isChatsCollapsed={isChatsCollapsed}
          />
          <ChatsSection
            activeDirectory={activeDirectory}
            crossProjectNotifications={crossProjectNotifications}
            isSwitchingDirectory={isSwitchingDirectory}
            onCollapsedChange={setIsChatsCollapsed}
          />
        </>
      )}

      <div className="sidebar-footer" data-snow-anchor="sidebar.footer">
        <div
          className="snow-client-slot"
          data-snow-slot="sidebar.footer.actions"
        />
        <div className="sidebar-footer-row">
          <button
            className="nav-item"
            onClick={() => onSwitchContent("settings")}
            type="button"
          >
            <Settings size={18} strokeWidth={1.8} />
            <span>{t("sidebar.settings", { defaultValue: "Settings" })}</span>
          </button>

          {/* 自动检测到新版本时显示更新入口，点击打开更新弹窗 */}
          {updateStatus.available &&
            !updateStatus.downloading &&
            !updateStatus.downloaded && (
              <button
                className="nav-item update-ready-btn"
                onClick={() => setIsUpdateDialogOpen(true)}
                type="button"
                title={t("settings.newVersionAvailable", {
                  values: { version: updateStatus.version ?? "" },
                  defaultValue: `Update to ${updateStatus.version ?? ""}`,
                })}
              >
                <Download size={16} strokeWidth={1.8} />
                <span>
                  {t("settings.update", {
                    defaultValue: "Update",
                  })}
                </span>
              </button>
            )}

          {/* 下载中：点击可重新打开弹窗查看进度 */}
          {updateStatus.available && updateStatus.downloading && (
            <button
              className="nav-item update-downloading"
              type="button"
              onClick={() => setIsUpdateDialogOpen(true)}
              title={t("settings.updateDownloading", {
                values: { percent: updateStatus.progress },
                defaultValue: `Downloading ${updateStatus.progress}%`,
              })}
            >
              <LoaderCircle size={16} strokeWidth={1.8} />
              <span>{updateStatus.progress}%</span>
            </button>
          )}

          {/* 下载完成 → 直接重启安装（无需再确认） */}
          {updateStatus.downloaded && (
            <button
              className="nav-item update-ready-btn"
              onClick={() => void window.snow.installUpdate()}
              type="button"
              title={t("settings.updateReady", {
                defaultValue: "Restart to update",
              })}
            >
              <Download size={16} strokeWidth={1.8} />
              <span>
                {t("settings.updateReady", {
                  defaultValue: "Restart to update",
                })}
              </span>
            </button>
          )}

          <Tooltip
            content={t("sidebar.userGuide", { defaultValue: "User guide" })}
            placement="top"
          >
            <button
              ref={helpButtonRef}
              aria-label={t("sidebar.userGuide", {
                defaultValue: "User guide",
              })}
              aria-expanded={isHelpMenuOpen}
              aria-haspopup="menu"
              className="nav-item sidebar-user-guide-btn"
              onClick={() => setIsHelpMenuOpen((prev) => !prev)}
              type="button"
            >
              <CircleHelp size={18} strokeWidth={1.8} />
            </button>
          </Tooltip>
        </div>
        {/* 使用指南浮层菜单：用户指南 / 快捷键指南 / 更新日志 */}
        {isHelpMenuOpen && (
          <div
            ref={helpMenuRef}
            className="sidebar-help-menu"
            role="menu"
            aria-label={t("sidebar.userGuide", { defaultValue: "User guide" })}
          >
            <button
              className="sidebar-help-menu-item"
              role="menuitem"
              onClick={handleOpenUserGuideFromMenu}
              type="button"
            >
              <BookOpen size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="sidebar-help-menu-label">
                {t("sidebar.userGuide", { defaultValue: "User guide" })}
              </span>
            </button>
            <button
              className="sidebar-help-menu-item"
              role="menuitem"
              onClick={handleOpenShortcutHelp}
              type="button"
            >
              <Keyboard size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="sidebar-help-menu-label">
                {t("sidebar.shortcutGuide", {
                  defaultValue: "Keyboard shortcuts",
                })}
              </span>
              <ShortcutHint action="showShortcutHelp" />
            </button>
            <button
              className="sidebar-help-menu-item"
              role="menuitem"
              onClick={handleOpenChangelog}
              type="button"
            >
              <ScrollText size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="sidebar-help-menu-label">
                {t("settings.changelogTab", { defaultValue: "Changelog" })}
              </span>
            </button>
          </div>
        )}
      </div>
      <GlobalSearchModal
        open={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectConversation={handleSearchSelectConversation}
        onSelectDirectory={handleSearchSelectDirectory}
      />
      <UpdateDialog
        open={isUpdateDialogOpen}
        onClose={() => setIsUpdateDialogOpen(false)}
      />
      <HelpSkillDisabledDialog
        open={isHelpSkillDialogOpen}
        onClose={() => setIsHelpSkillDialogOpen(false)}
      />
    </>
  );
}
