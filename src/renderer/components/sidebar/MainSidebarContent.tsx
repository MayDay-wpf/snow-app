import {
  Brain,
  CalendarClock,
  Download,
  LoaderCircle,
  NotebookText,
  Puzzle,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { pluginStore, usePluginStore } from "../../plugins/pluginStore";
import { runtimeSnapshot } from "../../plugins/runtimeSnapshot";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { shortcutEvents } from "../shortcutEvents";
import { APP_CONTROL_MEMO_CREATED_EVENT } from "../../hooks/useAppControl";
import { useShortcutLabel } from "../../hooks/useShortcutLabel";
import { ShortcutHint } from "../ShortcutHint";
import { useScheduledTasks } from "../../hooks/useScheduledTasks";
import { isFeaturePageView, type FeaturePageView } from "../featurePages";
import { ChatsSection } from "./mainSidebar/ChatsSection";
import { ProjectsSection } from "./mainSidebar/ProjectsSection";
import { TeamEntry } from "./mainSidebar/TeamEntry";
import {
  TEAM_ENABLED_CHANGED_EVENT,
  useTeamSummary,
} from "../mainContent/team/useTeamData";
import { useCrossProjectNotifications } from "./mainSidebar/useCrossProjectNotifications";
import { GlobalSearchModal } from "./GlobalSearchModal";
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
};

export function MainSidebarContent({
  activeMainView,
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
  onSwitchContent,
  onSwitchToExplorer,
  onOpenSshWizard,
}: SidebarContentProps): React.JSX.Element {
  const { t } = useI18n();
  const { handleSelectConversation, handleNewChat } =
    useChatConversationContext();
  const shortcutLabel = useShortcutLabel("newChat");
  const [isSwitchingDirectory, setIsSwitchingDirectory] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [isChatsCollapsed, setIsChatsCollapsed] = useState(false);
  const [pendingMemoCount, setPendingMemoCount] = useState(0);
  const [memoryCount, setMemoryCount] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(
    INITIAL_UPDATE_STATUS,
  );

  const activeDirectoryId = activeDirectory?.directoryId ?? "";

  const pluginState = usePluginStore();

  useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);

  // 团队协作入口：仅在当前目录为 Git 仓库且团队协作开关开启时展示
  // （identity.isRepo 由 Rust 判定，开关关闭时恒为 false）
  const [teamRefreshKey, setTeamRefreshKey] = useState(0);
  const { identity: teamIdentity, pendingCount: teamPendingCount } =
    useTeamSummary(activeDirectory?.path ?? "", teamRefreshKey);

  // 团队协作开关变化（通用设置面板）：立即重新解析身份，入口即时显隐
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

  // 订阅 AI 记忆写工具的变更广播：memory-save/update/delete 成功后，
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

  // 新建会话前收回独立页面：新会话在聊天视图里创建，页面不应继续占用主区域。
  const handleNewChatFromSidebar = useCallback((): void => {
    if (isFeaturePageView(activeMainView)) {
      onSelectMainView("chat");
    }
    handleNewChat();
  }, [activeMainView, handleNewChat, onSelectMainView]);

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
      unsubMemory();
      unsubScheduledTasks();
      unsubPlugins();
    };
  }, [activeDirectoryId, toggleFeaturePage, handleNewChatFromSidebar]);

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
      {/* 团队协作入口（基于 Git 的身份系统，置于侧边栏顶部）；非 Git 目录不显示 */}
      {teamIdentity?.isRepo ? (
        <div className="sidebar-team-entry">
          <TeamEntry
            repoPath={activeDirectory?.path ?? ""}
            identity={teamIdentity}
            pendingCount={teamPendingCount}
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
          <Search size={16} strokeWidth={1.8} />
          <span>
            {t("sidebar.search", {
              defaultValue: "Search",
            })}
          </span>
          <ShortcutHint action="openSearch" />
        </button>
        <button
          className="nav-item sidebar-new-chat-btn"
          onClick={handleNewChatFromSidebar}
          title={`${t("sidebar.newChat", { defaultValue: "New Chat" })} (${shortcutLabel})`}
          type="button"
        >
          <SquarePen size={16} strokeWidth={1.8} />
          <span>{t("sidebar.newChat", { defaultValue: "New Chat" })}</span>
          <ShortcutHint action="newChat" />
        </button>
        <button
          className={`nav-item sidebar-memo-btn${
            activeMainView === "memo" ? " active" : ""
          }`}
          disabled={!activeDirectoryId}
          onClick={() => toggleFeaturePage("memo")}
          title={t("memo.sidebarEntry", { defaultValue: "Memos" })}
          type="button"
        >
          <NotebookText size={16} strokeWidth={1.8} />
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
          title={t("memory.sidebarEntry", { defaultValue: "Project Memory" })}
          type="button"
        >
          <Brain size={16} strokeWidth={1.8} />
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
          <CalendarClock size={16} strokeWidth={1.8} />
          <span>
            {t("scheduledTask.sidebarEntry", {
              defaultValue: "Scheduled Tasks",
            })}
          </span>
          {scheduledTasks.length > 0 && (
            <span className="sidebar-memo-badge">{scheduledTasks.length}</span>
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
          <Puzzle size={16} strokeWidth={1.8} />
          <span>{t("plugins.sidebarEntry", { defaultValue: "Plugins" })}</span>
          {pluginState.plugins.length > 0 && (
            <span className="sidebar-memory-badge">
              {pluginState.plugins.length}
            </span>
          )}
        </button>
        <div
          className="snow-client-slot"
          data-snow-slot="sidebar.nav.actions"
        />
      </div>
      <ProjectsSection
        activeDirectory={activeDirectory}
        activeSessionDirectoryIds={activeSessionDirectoryIds}
        notificationGroups={crossProjectNotifications}
        onActiveDirectoryChange={onActiveDirectoryChange}
        onSwitchingDirectoryChange={setIsSwitchingDirectory}
        onSwitchContent={onSwitchContent}
        onSwitchToExplorer={onSwitchToExplorer}
        onOpenSshWizard={onOpenSshWizard}
        isChatsCollapsed={isChatsCollapsed}
      />
      <ChatsSection
        activeDirectory={activeDirectory}
        crossProjectNotifications={crossProjectNotifications}
        isSwitchingDirectory={isSwitchingDirectory}
        onCollapsedChange={setIsChatsCollapsed}
      />

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
            <ShortcutHint action="openSettings" />
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
        </div>
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
    </>
  );
}
