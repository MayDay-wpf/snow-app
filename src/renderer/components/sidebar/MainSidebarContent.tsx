import {
  CalendarClock,
  Download,
  LoaderCircle,
  NotebookText,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { shortcutEvents } from "../shortcutEvents";
import { APP_CONTROL_MEMO_CREATED_EVENT } from "../../hooks/useAppControl";
import { useScheduledTasks } from "../../hooks/useScheduledTasks";
import type { MainContentView } from "../mainContent/types";
import { ChatsSection } from "./mainSidebar/ChatsSection";
import { PinnedSection } from "./mainSidebar/PinnedSection";
import { ProjectsSection } from "./mainSidebar/ProjectsSection";
import { TeamEntry } from "./mainSidebar/TeamEntry";
import {
  TEAM_ENABLED_CHANGED_EVENT,
  useTeamSummary,
} from "../mainContent/team/useTeamData";
import { useCrossProjectNotifications } from "./mainSidebar/useCrossProjectNotifications";
import { GlobalSearchModal } from "./GlobalSearchModal";
import { MemoModal } from "./MemoModal";
import { ScheduledTasksModal } from "./ScheduledTasksModal";
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
  const [isSwitchingDirectory, setIsSwitchingDirectory] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isMemoOpen, setIsMemoOpen] = useState(false);
  const [isScheduledTasksOpen, setIsScheduledTasksOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [isChatsCollapsed, setIsChatsCollapsed] = useState(false);
  const [pendingMemoCount, setPendingMemoCount] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(
    INITIAL_UPDATE_STATUS,
  );

  const activeDirectoryId = activeDirectory?.directoryId ?? "";

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
  const crossProjectNotifications =
    useCrossProjectNotifications(activeDirectoryId);

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

  // Load the pending memo count for the sidebar badge. It is refreshed
  // whenever the memo modal closes (the modal calls onPendingCountChange
  // while open) and once on mount, and whenever the active project changes
  // since memos are scoped per directory.
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
    return () => {
      window.removeEventListener(APP_CONTROL_MEMO_CREATED_EVENT, handler);
    };
  }, [refreshPendingMemoCount]);

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

  // 订阅快捷键事件：Ctrl/Cmd+F 切换搜索 modal，Ctrl/Cmd+B 切换备忘录 modal。
  // 快捷键引擎通过 shortcutEvents 总线触发，此组件持有 modal open 状态。
  useEffect(() => {
    const unsubSearch = shortcutEvents.on("toggle-search", () => {
      setIsSearchOpen((prev) => !prev);
    });
    const unsubMemo = shortcutEvents.on("toggle-memo", () => {
      setIsMemoOpen((prev) => !prev);
    });
    return () => {
      unsubSearch();
      unsubMemo();
    };
  }, []);

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

  const handleSearchSelectSetting = useCallback(
    (view: MainContentView): void => {
      onSwitchContent?.("settings");
      onSelectMainView(view);
    },
    [onSwitchContent, onSelectMainView],
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
      <div className="sidebar-search-bar">
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
        </button>
        <button
          className="nav-item sidebar-new-chat-btn"
          onClick={() => handleNewChat()}
          title={t("sidebar.newChat", { defaultValue: "New Chat" })}
          type="button"
        >
          <SquarePen size={16} strokeWidth={1.8} />
          <span>{t("sidebar.newChat", { defaultValue: "New Chat" })}</span>
        </button>
        <button
          className="nav-item sidebar-memo-btn"
          disabled={!activeDirectoryId}
          onClick={() => setIsMemoOpen(true)}
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
          className="nav-item sidebar-scheduled-tasks-btn"
          onClick={() => setIsScheduledTasksOpen(true)}
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
      </div>
      <PinnedSection
        activeDirectory={activeDirectory}
        isSwitchingDirectory={isSwitchingDirectory}
      />
      <ProjectsSection
        activeDirectory={activeDirectory}
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

      <div className="sidebar-footer">
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
        </div>
      </div>
      <GlobalSearchModal
        open={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectConversation={handleSearchSelectConversation}
        onSelectDirectory={handleSearchSelectDirectory}
        onSelectSetting={handleSearchSelectSetting}
      />
      <MemoModal
        directoryId={activeDirectoryId}
        open={isMemoOpen}
        onClose={() => {
          setIsMemoOpen(false);
          refreshPendingMemoCount();
        }}
        onPendingCountChange={setPendingMemoCount}
      />
      <ScheduledTasksModal
        directoryId={activeDirectoryId}
        directoryPath={activeDirectory?.path ?? ""}
        open={isScheduledTasksOpen}
        onClose={() => setIsScheduledTasksOpen(false)}
      />
      <UpdateDialog
        open={isUpdateDialogOpen}
        onClose={() => setIsUpdateDialogOpen(false)}
      />
    </>
  );
}
