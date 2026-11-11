import {
  ChevronRight,
  LayoutGrid,
  ListTree,
  Loader2,
  Plus,
} from "lucide-react";
import { useMemo } from "react";

import { useI18n } from "../../../i18n";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { Tooltip } from "../../common/Tooltip";
import { CloneTaskList } from "./projects/CloneTaskList";
import { ProjectsDialogs } from "./projects/ProjectsDialogs";
import { SidebarCollapse } from "./SidebarCollapse";
import { WorkspaceDirectoryList } from "./WorkspaceDirectoryList";
import { useDirectoryPagination } from "./projects/useDirectoryPagination";
import { useProjectsSectionLayout } from "./projects/useProjectsSectionLayout";
import { useProjectsWorkspace } from "./projects/useProjectsWorkspace";
import { useSidebarDisplayMode } from "./sidebarDisplayMode";
import type { CrossProjectNotificationGroup } from "./useCrossProjectNotifications";

type ProjectsSectionProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** 当前活动会话 id：切换会话（含跨项目运行中会话）时重新展开所在合集 */
  activeConversationId?: string;
  activeSessionDirectoryIds?: Set<string>;
  /** 跨项目通知（其他项目的运行中/需关注/已完成会话分组），用于项目条目徽标 */
  notificationGroups?: CrossProjectNotificationGroup[];
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSwitchingDirectoryChange: (isSwitchingDirectory: boolean) => void;
  onSwitchContent?: (content: "main" | "explorer") => void;
  onSwitchToExplorer?: (directoryId: string) => void;
  onOpenSshWizard?: () => void;
  /** 编辑远程目录的连接信息（登录信息 / 端口 / 远程目录） */
  onEditSshConnection?: (directory: WorkspaceDirectoryRecord) => void;
  /** 会话区域是否已收起：收起时项目列表撑满剩余高度 */
  isChatsCollapsed: boolean;
};

export function ProjectsSection({
  activeDirectory: externalActiveDirectory,
  activeSessionDirectoryIds,
  notificationGroups,
  onActiveDirectoryChange,
  onSwitchingDirectoryChange,
  onSwitchToExplorer,
  onOpenSshWizard,
  onEditSshConnection,
  isChatsCollapsed,
}: ProjectsSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const { toggleMode } = useSidebarDisplayMode();

  const workspace = useProjectsWorkspace({
    externalActiveDirectory,
    onActiveDirectoryChange,
    onSwitchingDirectoryChange,
    onOpenSshWizard,
  });
  const {
    workspaceDirectories,
    activeDirectory,
    isLoadingDirectories,
    isSavingDirectory,
    isActionLocked,
    isAddDialogsOpen,
    directoryError,
    collections,
    expandedCollectionIds,
    addFlow,
    dragAndDrop,
    topLevelDirectories,
    handleActivateDirectory,
    handleDeleteDirectory,
    handleRenameDirectory,
    handleShowRelinkHistory,
    handleToggleCollectionExpanded,
    setDeleteCollectionTarget,
    setMemberLinked,
    removeProjectFromCollection,
    openLinkProjects,
  } = workspace;

  const layout = useProjectsSectionLayout({
    isChatsCollapsed,
    workspaceDirectories,
    activeDirectory,
    isActionLocked,
    onActivateDirectory: (directoryId) => {
      void handleActivateDirectory(directoryId);
    },
    onCollapseChange: addFlow.closeAddMenu,
  });
  const { sectionRef, isProjectsCollapsed, toggleProjectsCollapsed } = layout;

  const pagination = useDirectoryPagination({
    topLevelDirectories,
    isProjectsCollapsed,
    isChatsCollapsed,
  });
  const {
    directoryListRef,
    directoryLoadMoreRef,
    visibleDirectories,
    hasMoreDirectories,
  } = pagination;

  // 各项目通知计数：directoryId → 通知会话数（需关注/运行中/已完成）。
  // 当前项目的动态由对话列表展示，不参与徽标（hook 已排除）。
  const notificationCountByDirectory = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of notificationGroups ?? []) {
      counts[group.directoryId] = group.notifications.length;
    }
    return counts;
  }, [notificationGroups]);

  const handleShowDetails = (directoryId: string): void => {
    const directory = workspaceDirectories.find(
      (d) => d.directoryId === directoryId,
    );

    if (!directory) {
      return;
    }

    onSwitchToExplorer?.(directory.directoryId);
  };

  return (
    <div
      className={`sidebar-section projects-section${
        isProjectsCollapsed ? " collapsed" : ""
      }${isChatsCollapsed ? " chats-collapsed" : ""}`}
      ref={sectionRef}
    >
      <div className="section-header">
        <div className="section-heading-group">
          <button
            aria-expanded={!isProjectsCollapsed}
            className="section-toggle-btn"
            onClick={toggleProjectsCollapsed}
            type="button"
          >
            <ChevronRight
              className={
                isProjectsCollapsed ? "" : "section-toggle-chevron--open"
              }
              size={12}
            />
            <span className="section-title">
              {t("sidebar.projects", { defaultValue: "Projects" })}
            </span>
          </button>
          <Tooltip
            content={t("sidebar.switchToTreeView", {
              defaultValue: "Tree view",
            })}
            placement="top"
          >
            <button
              aria-label={t("sidebar.switchToTreeView", {
                defaultValue: "Tree view",
              })}
              className="icon-btn ghost"
              onClick={toggleMode}
              type="button"
            >
              <ListTree size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="section-actions">
          {isLoadingDirectories || isSavingDirectory ? (
            <span aria-hidden="true" className="section-actions-spinner">
              <Loader2 className="spin" size={14} />
            </span>
          ) : (
            <>
              <Tooltip
                content={t("sidebar.openProjectGrid", {
                  defaultValue: "Project grid",
                })}
                placement="top"
              >
                <button
                  aria-label={t("sidebar.openProjectGrid", {
                    defaultValue: "Project grid",
                  })}
                  className="icon-btn ghost"
                  onClick={() => workspace.setIsProjectGridOpen(true)}
                  type="button"
                >
                  <LayoutGrid size={14} />
                </button>
              </Tooltip>
              <Tooltip
                content={t("sidebar.addDirectoryScheme", {
                  defaultValue: "Add directory",
                })}
                placement="top"
              >
                <button
                  aria-expanded={addFlow.isAddMenuOpen}
                  aria-haspopup="dialog"
                  aria-label={t("sidebar.addDirectoryScheme", {
                    defaultValue: "Add directory",
                  })}
                  className="icon-btn ghost"
                  onClick={addFlow.openAddMenu}
                  type="button"
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      <ProjectsDialogs workspace={workspace} />

      <SidebarCollapse open={!isProjectsCollapsed}>
        <div className="workspace-directory-card">
          <span className="workspace-directory-label">
            {t("sidebar.activeDirectory", {
              defaultValue: "Active directory",
            })}
          </span>
          <WorkspaceDirectoryList
            activeDirectoryId={activeDirectory?.directoryId}
            activeSessionDirectoryIds={activeSessionDirectoryIds}
            collections={collections}
            directoryListRef={directoryListRef}
            draggedCollectionId={dragAndDrop.draggedCollectionId}
            draggedDirectoryId={dragAndDrop.draggedDirectoryId}
            dragOverCollectionId={dragAndDrop.dragOverCollectionId}
            dragOverDirectoryId={dragAndDrop.dragOverDirectoryId}
            expandedCollectionIds={expandedCollectionIds}
            hasMoreDirectories={hasMoreDirectories}
            isActionLocked={isActionLocked}
            isLoadingDirectories={isLoadingDirectories}
            loadMoreRef={directoryLoadMoreRef}
            notificationCountByDirectory={notificationCountByDirectory}
            onActivate={(directoryId) =>
              void handleActivateDirectory(directoryId)
            }
            onAddProjectToCollection={addFlow.handleCollectionAddProjectOpen}
            onCollectionDragOver={dragAndDrop.handleCollectionDragOver}
            onCollectionDragStart={dragAndDrop.handleCollectionDragStart}
            onCollectionDrop={dragAndDrop.handleCollectionDrop}
            onCollectionMemberDrop={dragAndDrop.handleCollectionMemberDrop}
            onCollectionReorderDrop={dragAndDrop.handleCollectionReorderDrop}
            onDelete={(directoryId) => void handleDeleteDirectory(directoryId)}
            onDeleteCollection={setDeleteCollectionTarget}
            onDragEnd={dragAndDrop.handleDirectoryDragEnd}
            onDragOver={dragAndDrop.handleDirectoryDragOver}
            onDragStart={dragAndDrop.handleDirectoryDragStart}
            onDrop={dragAndDrop.handleDirectoryDrop}
            onDropOutside={dragAndDrop.handleDropOutside}
            onLinkProjects={openLinkProjects}
            onToggleMemberLinked={(collectionId, directoryId, linked) =>
              void setMemberLinked(collectionId, directoryId, linked)
            }
            onRemoveFromCollection={(collectionId, directoryId) =>
              void removeProjectFromCollection(collectionId, directoryId)
            }
            onRename={handleRenameDirectory}
            onEditConnection={onEditSshConnection}
            onRenameCollection={addFlow.handleRenameCollectionOpen}
            onShowDetails={handleShowDetails}
            onShowRelinkHistory={handleShowRelinkHistory}
            onToggleCollection={handleToggleCollectionExpanded}
            visibleDirectories={visibleDirectories}
            workspaceDirectories={workspaceDirectories}
          />
          <CloneTaskList
            onAbort={(streamId) => void addFlow.handleAbortCloneTask(streamId)}
            onRemove={addFlow.handleRemoveCloneTask}
            tasks={addFlow.cloneTasks}
          />
          {directoryError && !isAddDialogsOpen ? (
            <span className="workspace-directory-error">{directoryError}</span>
          ) : null}
        </div>
      </SidebarCollapse>
    </div>
  );
}
