import {
  Archive,
  ArchiveRestore,
  FolderDown,
  LayoutGrid,
  Loader2,
  Plus,
  Rows3,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { WorkspaceDirectoryRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { AutoDismissNotice } from "../../../AutoDismissNotice";
import { Tooltip } from "../../../common/Tooltip";
import { useChatConversationContext } from "../../../mainContent/chatMessages";
import { ArchivedChatHeader } from "../chats/ArchivedChatHeader";
import { ArchivedChatList } from "../chats/ArchivedChatList";
import { ChatImportProgress } from "../chats/ChatImportProgress";
import { ChatsSectionDialogs } from "../chats/ChatsSectionDialogs";
import { useArchivedConversations } from "../chats/useArchivedConversations";
import { useChatImport } from "../chats/useChatImport";
import { buildDirectoryDisplayNames } from "../directoryDisplayName";
import { CloneTaskList } from "../projects/CloneTaskList";
import { ProjectsDialogs } from "../projects/ProjectsDialogs";
import { useDirectoryPagination } from "../projects/useDirectoryPagination";
import { useProjectsWorkspace } from "../projects/useProjectsWorkspace";
import { useSidebarDisplayMode } from "../sidebarDisplayMode";
import type { CrossProjectNotificationGroup } from "../useCrossProjectNotifications";
import { TreeCollectionNode } from "./TreeCollectionNode";
import { TreeProjectNode } from "./TreeProjectNode";

const noop = (): void => undefined;
const noopBoolean = (_value: boolean): void => undefined;

type SidebarProjectTreeProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  activeSessionDirectoryIds?: Set<string>;
  notificationGroups?: CrossProjectNotificationGroup[];
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSwitchToExplorer?: (directoryId: string) => void;
  onOpenSshWizard?: () => void;
  /** 编辑远程目录的连接信息（登录信息 / 端口 / 远程目录） */
  onEditSshConnection?: (directory: WorkspaceDirectoryRecord) => void;
  onSwitchingDirectoryChange: (isSwitchingDirectory: boolean) => void;
};

export function SidebarProjectTree({
  activeDirectory: externalActiveDirectory,
  activeSessionDirectoryIds,
  notificationGroups,
  onActiveDirectoryChange,
  onSwitchToExplorer,
  onOpenSshWizard,
  onEditSshConnection,
  onSwitchingDirectoryChange,
}: SidebarProjectTreeProps): React.JSX.Element {
  const { t } = useI18n();
  const { toggleMode } = useSidebarDisplayMode();
  const { activeConversationId, refreshConversations } =
    useChatConversationContext();

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
    isSwitchingDirectory,
    isActionLocked,
    isAddDialogsOpen,
    directoryError,
    collections,
    collectionMemberIds,
    expandedCollectionIds,
    addFlow,
    dragAndDrop,
    topLevelDirectories,
    handleActivateDirectory,
    handleDeleteDirectory,
    handleRenameDirectory,
    handleShowRelinkHistory,
    handleToggleCollectionExpanded,
    setIsProjectGridOpen,
    setDeleteCollectionTarget,
    setMemberLinked,
    removeProjectFromCollection,
    openLinkProjects,
  } = workspace;

  const activeDirectoryId = activeDirectory?.directoryId ?? "";

  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!activeDirectoryId) {
      return;
    }
    setExpandedDirectoryIds((prev) =>
      prev.has(activeDirectoryId) ? prev : new Set(prev).add(activeDirectoryId),
    );
  }, [activeDirectoryId]);

  const pagination = useDirectoryPagination({
    topLevelDirectories,
    isProjectsCollapsed: false,
    isChatsCollapsed: false,
  });
  const {
    directoryListRef,
    directoryLoadMoreRef,
    visibleDirectories,
    hasMoreDirectories,
  } = pagination;

  const displayNames = useMemo(
    () => buildDirectoryDisplayNames(workspaceDirectories),
    [workspaceDirectories],
  );

  const notificationCountByDirectory = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of notificationGroups ?? []) {
      counts[group.directoryId] = group.notifications.length;
    }
    return counts;
  }, [notificationGroups]);

  const handleToggleDirectory = useCallback((directoryId: string): void => {
    setExpandedDirectoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(directoryId)) {
        next.delete(directoryId);
      } else {
        next.add(directoryId);
      }
      return next;
    });
  }, []);

  const handleActivate = useCallback(
    (directoryId: string): void => {
      void handleActivateDirectory(directoryId);
    },
    [handleActivateDirectory],
  );

  const handleShowDetails = useCallback(
    (directoryId: string): void => {
      onSwitchToExplorer?.(directoryId);
    },
    [onSwitchToExplorer],
  );

  // 顶层项目行的插入指示线：按全量工作区顺序计算（与列表模式一致）
  const getTopLevelDropSide = (
    directoryId: string,
  ): "top" | "bottom" | null => {
    const draggedId = dragAndDrop.draggedDirectoryId;
    if (!draggedId || dragAndDrop.dragOverDirectoryId !== directoryId) {
      return null;
    }
    if (draggedId === directoryId) {
      return null;
    }
    const sourceIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === draggedId,
    );
    const targetIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === directoryId,
    );
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }
    return sourceIndex < targetIndex ? "bottom" : "top";
  };

  // 合集行排序插入指示线：按合集列表顺序计算（与列表模式一致）
  const getCollectionDropSide = (
    collectionId: string,
  ): "top" | "bottom" | null => {
    const draggedId = dragAndDrop.draggedCollectionId;
    if (
      !draggedId ||
      draggedId === collectionId ||
      dragAndDrop.dragOverCollectionId !== collectionId
    ) {
      return null;
    }
    const sourceIndex = collections.findIndex(
      (collection) => collection.collectionId === draggedId,
    );
    const targetIndex = collections.findIndex(
      (collection) => collection.collectionId === collectionId,
    );
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }
    return sourceIndex < targetIndex ? "bottom" : "top";
  };

  // 树列表空白区域兜底：拖到非行、非合集区域 = 合集成员移出合集
  const handleTreeListDragOver = (
    event: React.DragEvent<HTMLDivElement>,
  ): void => {
    if (event.defaultPrevented) {
      return;
    }
    const draggedId = dragAndDrop.draggedDirectoryId;
    if (!draggedId || !collectionMemberIds.has(draggedId)) {
      return;
    }
    if (
      (event.target as Element | null)?.closest?.(".tree-collection-members")
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleTreeListDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) {
      return;
    }
    const draggedId =
      dragAndDrop.draggedDirectoryId ||
      event.dataTransfer.getData("text/plain") ||
      null;
    if (!draggedId || !collectionMemberIds.has(draggedId)) {
      return;
    }
    if (
      (event.target as Element | null)?.closest?.(".tree-collection-members")
    ) {
      return;
    }
    event.preventDefault();
    dragAndDrop.handleDropOutside(draggedId);
  };

  const chatImport = useChatImport({
    directoryId: activeDirectoryId,
    refreshConversations,
  });

  const archived = useArchivedConversations({
    directoryId: activeDirectoryId,
    isCollapsed: false,
    sectionListRef: directoryListRef,
    refreshConversations,
    onExitChatMultiSelect: noop,
  });

  const isBusy = isSavingDirectory || isSwitchingDirectory;

  return (
    <div
      className={`sidebar-section sidebar-tree-section${
        isSwitchingDirectory ? " is-switching" : ""
      }`}
    >
      <div className="section-header">
        <div className="section-heading-group">
          <span className="section-title">
            {archived.isArchiveMode
              ? t("sidebar.archivedChats", { defaultValue: "Archived" })
              : t("sidebar.projects", { defaultValue: "Projects" })}
          </span>
          {archived.isArchiveMode && archived.archivedTotal > 0 ? (
            <span className="chats-archive-count">
              {archived.archivedTotal}
            </span>
          ) : null}
          <Tooltip
            content={t("sidebar.switchToSplitView", {
              defaultValue: "List view",
            })}
            placement="top"
          >
            <button
              aria-label={t("sidebar.switchToSplitView", {
                defaultValue: "List view",
              })}
              className="icon-btn ghost"
              onClick={toggleMode}
              type="button"
            >
              <Rows3 size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="section-actions">
          {isBusy ? (
            <span aria-hidden="true" className="section-actions-spinner">
              <Loader2 className="spin" size={14} />
            </span>
          ) : null}
          {!archived.isArchiveMode ? (
            <Tooltip
              content={t("sidebar.chatImportConversations", {
                defaultValue: "Import conversations",
              })}
              placement="top"
            >
              <button
                aria-label={t("sidebar.chatImportConversations", {
                  defaultValue: "Import conversations",
                })}
                className="icon-btn ghost chats-import-toggle"
                disabled={chatImport.isImporting || !activeDirectoryId}
                onClick={() => void chatImport.handleImportConversations()}
                type="button"
              >
                {chatImport.isImporting ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <FolderDown size={14} />
                )}
              </button>
            </Tooltip>
          ) : null}
          <Tooltip
            content={
              archived.isArchiveMode
                ? t("sidebar.archivedChatsToggleBack", {
                    defaultValue: "Back to chats",
                  })
                : t("sidebar.archivedChatsToggle", {
                    defaultValue: "View archived chats",
                  })
            }
            placement="top"
          >
            <button
              aria-label={
                archived.isArchiveMode
                  ? t("sidebar.archivedChatsToggleBack", {
                      defaultValue: "Back to chats",
                    })
                  : t("sidebar.archivedChatsToggle", {
                      defaultValue: "View archived chats",
                    })
              }
              aria-pressed={archived.isArchiveMode}
              className={`icon-btn ghost chats-archive-toggle${
                archived.isArchiveMode ? " active" : ""
              }`}
              disabled={!activeDirectoryId}
              onClick={archived.toggleArchiveMode}
              type="button"
            >
              {archived.isArchiveMode ? (
                <ArchiveRestore size={14} />
              ) : (
                <Archive size={14} />
              )}
            </button>
          </Tooltip>
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
              disabled={isActionLocked}
              onClick={() => setIsProjectGridOpen(true)}
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
        </div>
      </div>

      <ProjectsDialogs workspace={workspace} />

      <ChatImportProgress progress={chatImport.progress} />
      <AutoDismissNotice
        durationMs={3000}
        message={chatImport.notice?.message ?? ""}
        onDismiss={chatImport.dismissNotice}
        tone={chatImport.notice?.tone ?? "success"}
      />
      <ChatsSectionDialogs
        archivedDeleteTargetIds={archived.archivedDeleteTargetIds}
        batchDeleteImages={false}
        batchDeleteMemories={false}
        batchImagesCount={null}
        batchMemoriesCount={null}
        isBatchDeleting={false}
        isDeletingArchived={archived.deletingArchivedIds.size > 0}
        onArchivedDeleteCancel={() => archived.setArchivedDeleteTargetIds(null)}
        onArchivedDeleteConfirm={() =>
          void archived.handleArchivedDeleteConfirm()
        }
        onBatchCancel={noop}
        onBatchConfirm={noop}
        onBatchImagesChange={noopBoolean}
        onBatchMemoriesChange={noopBoolean}
        selectedCount={0}
        showBatchConfirm={false}
      />

      {archived.isArchiveMode ? (
        <ArchivedChatHeader
          allSelected={
            archived.archivedSelectedIds.size ===
              archived.archivedConversations.length &&
            archived.archivedConversations.length > 0
          }
          archivedCount={archived.archivedConversations.length}
          hasKeyword={archived.archivedSearchInput.trim().length > 0}
          isDeleting={archived.deletingArchivedIds.size > 0}
          isMultiSelect={archived.isArchivedMultiSelect}
          isRestoring={archived.restoringIds.size > 0}
          onBatchDelete={archived.handleBatchDeleteArchived}
          onBatchRestore={() => void archived.handleBatchRestore()}
          onChangeSearch={archived.setArchivedSearchInput}
          onDeselectAll={archived.handleArchivedDeselectAll}
          onEnterMultiSelect={archived.enterArchivedMultiSelect}
          onExitMultiSelect={archived.handleExitArchivedMultiSelect}
          onSelectAll={archived.handleArchivedSelectAll}
          searchInput={archived.archivedSearchInput}
          selectedCount={archived.archivedSelectedIds.size}
        />
      ) : null}
      <div
        className="section-list sidebar-tree-list"
        ref={directoryListRef}
        onDragOver={handleTreeListDragOver}
        onDrop={handleTreeListDrop}
      >
        {archived.isArchiveMode ? (
          <ArchivedChatList
            archivedConversations={archived.archivedConversations}
            archivedError={archived.archivedError}
            archivedSearchInput={archived.archivedSearchInput}
            archivedSelectedIds={archived.archivedSelectedIds}
            deletingArchivedIds={archived.deletingArchivedIds}
            directoryId={activeDirectoryId}
            hasMoreArchived={archived.hasMoreArchived}
            isArchivedLoading={archived.isArchivedLoading}
            isArchivedLoadingMore={archived.isArchivedLoadingMore}
            isArchivedMultiSelect={archived.isArchivedMultiSelect}
            isSwitchingDirectory={isSwitchingDirectory}
            loadMoreRef={archived.archivedLoadMoreRef}
            onDelete={archived.handleDeleteArchived}
            onRestore={(conversation) =>
              void archived.handleRestore(conversation)
            }
            onToggleSelect={archived.handleArchivedToggleSelect}
            restoringIds={archived.restoringIds}
          />
        ) : isLoadingDirectories ? (
          <span className="empty-text loading">
            <Loader2 className="spin" size={13} />
            {t("sidebar.loadingDirectories", {
              defaultValue: "Loading directories...",
            })}
          </span>
        ) : workspaceDirectories.length === 0 ? (
          <span className="empty-text">
            {t("sidebar.noDirectories", { defaultValue: "No directories" })}
          </span>
        ) : (
          <>
            {collections.map((collection) => {
              const memberDirectories = collection.memberDirectoryIds
                .map((directoryId) =>
                  workspaceDirectories.find(
                    (item) => item.directoryId === directoryId,
                  ),
                )
                .filter((item): item is WorkspaceDirectoryRecord =>
                  Boolean(item),
                );
              return (
                <TreeCollectionNode
                  activeConversationId={activeConversationId}
                  activeDirectoryId={activeDirectoryId}
                  activeSessionDirectoryIds={activeSessionDirectoryIds}
                  collection={collection}
                  displayNames={displayNames}
                  dragAndDrop={dragAndDrop}
                  dropIndicatorSide={getCollectionDropSide(
                    collection.collectionId,
                  )}
                  expandedDirectoryIds={expandedDirectoryIds}
                  isActionLocked={isActionLocked}
                  isExpanded={expandedCollectionIds.has(
                    collection.collectionId,
                  )}
                  key={collection.collectionId}
                  memberDirectories={memberDirectories}
                  notificationCountByDirectory={notificationCountByDirectory}
                  onActivateDirectory={handleActivate}
                  onAddProjectToCollection={
                    addFlow.handleCollectionAddProjectOpen
                  }
                  onDeleteCollection={setDeleteCollectionTarget}
                  onDeleteDirectory={(directoryId) =>
                    void handleDeleteDirectory(directoryId)
                  }
                  onRemoveFromCollection={(collectionId, directoryId) =>
                    void removeProjectFromCollection(collectionId, directoryId)
                  }
                  onRenameCollection={addFlow.handleRenameCollectionOpen}
                  onRenameDirectory={handleRenameDirectory}
                  onEditConnection={onEditSshConnection}
                  onShowDetails={handleShowDetails}
                  onShowRelinkHistory={handleShowRelinkHistory}
                  onToggleCollection={handleToggleCollectionExpanded}
                  onToggleDirectory={handleToggleDirectory}
                  onToggleMemberLinked={(collectionId, directoryId, linked) =>
                    void setMemberLinked(collectionId, directoryId, linked)
                  }
                  sectionListRef={directoryListRef}
                />
              );
            })}
            {visibleDirectories.map((directory) => (
              <TreeProjectNode
                activeConversationId={activeConversationId}
                activeDirectoryId={activeDirectoryId}
                directory={directory}
                displayName={displayNames.get(directory.directoryId)}
                dragAndDrop={dragAndDrop}
                dropIndicatorSide={getTopLevelDropSide(directory.directoryId)}
                hasActiveSession={
                  activeSessionDirectoryIds?.has(directory.directoryId) ?? false
                }
                isActionLocked={isActionLocked}
                isExpanded={expandedDirectoryIds.has(directory.directoryId)}
                key={directory.directoryId}
                notificationCount={
                  notificationCountByDirectory[directory.directoryId] ?? 0
                }
                onActivate={handleActivate}
                onDelete={(directoryId) =>
                  void handleDeleteDirectory(directoryId)
                }
                onLinkProjects={openLinkProjects}
                onRename={handleRenameDirectory}
                onEditConnection={onEditSshConnection}
                onShowDetails={handleShowDetails}
                onShowRelinkHistory={handleShowRelinkHistory}
                onToggle={handleToggleDirectory}
                sectionListRef={directoryListRef}
              />
            ))}
            {hasMoreDirectories ? (
              <div
                aria-hidden="true"
                className="workspace-directory-load-more"
                ref={directoryLoadMoreRef}
              >
                <Loader2 className="spin" size={13} />
                <span>
                  {t("sidebar.loadingMoreDirectories", {
                    defaultValue: "Loading more...",
                  })}
                </span>
              </div>
            ) : null}
          </>
        )}
        <CloneTaskList
          onAbort={(streamId) => void addFlow.handleAbortCloneTask(streamId)}
          onRemove={addFlow.handleRemoveCloneTask}
          tasks={addFlow.cloneTasks}
        />
        {directoryError && !isAddDialogsOpen ? (
          <span className="workspace-directory-error">{directoryError}</span>
        ) : null}
      </div>
    </div>
  );
}
