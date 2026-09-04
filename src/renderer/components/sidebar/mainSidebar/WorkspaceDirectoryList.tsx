import { ChevronRight, Library, Loader2, Pencil, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";

import { useI18n } from "../../../i18n";
import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import type { ConversationDragPayload } from "./conversationDrag";
import { WorkspaceDirectoryRow } from "./WorkspaceDirectoryRow";

type WorkspaceDirectoryListProps = {
  activeDirectoryId?: string;
  /** 项目合集列表（渲染在项目列表上方，支持拖拽项目加入） */
  collections: ProjectCollectionRecord[];
  directoryListRef: RefObject<HTMLDivElement | null>;
  draggedDirectoryId: string | null;
  /** 当前拖拽悬停的合集 id（显示 add 光标） */
  dragOverCollectionId: string | null;
  dragOverDirectoryId: string | null;
  /** 已展开的合集 id 集合（成员项目可见） */
  expandedCollectionIds: Set<string>;
  hasMoreDirectories: boolean;
  isActionLocked: boolean;
  isLoadingDirectories: boolean;
  loadMoreRef: RefObject<HTMLDivElement | null>;
  /** 各项目通知计数（directoryId → 通知会话数），用于条目徽标 */
  notificationCountByDirectory?: Record<string, number>;
  onActivate: (directoryId: string) => void;
  onCollectionDragOver: (collectionId: string) => void;
  onCollectionDrop: (collectionId: string, directoryId: string) => void;
  onDelete: (directoryId: string) => void;
  onDeleteCollection: (collection: ProjectCollectionRecord) => void;
  onDragEnd: () => void;
  onDragOver: (directoryId: string) => void;
  onDragStart: (directoryId: string) => void;
  onDrop: (directoryId: string) => void;
  onRemoveFromCollection: (collectionId: string, directoryId: string) => void;
  /** 重命名目录显示名；返回 Promise 时提交期间保持编辑态直到完成 */
  onRename?: (directoryId: string, newName: string) => void | Promise<void>;
  /** 修改项目文件夹（重定向到新路径并迁移历史数据） */
  onUpdateFolderStart?: (directory: WorkspaceDirectoryRecord) => void;
  /** 会话拖入项目行时触发（跨项目迁移确认流程） */
  onDropConversation?: (
    payload: ConversationDragPayload,
    targetDirectoryId: string,
  ) => void;
  onRenameCollection: (collection: ProjectCollectionRecord) => void;
  onShowDetails?: (directoryId: string) => void;
  onToggleCollection: (collectionId: string) => void;
  totalCount: number;
  visibleDirectories: WorkspaceDirectoryRecord[];
  workspaceDirectories: WorkspaceDirectoryRecord[];
};

export function WorkspaceDirectoryList({
  activeDirectoryId,
  collections,
  directoryListRef,
  draggedDirectoryId,
  dragOverCollectionId,
  dragOverDirectoryId,
  expandedCollectionIds,
  hasMoreDirectories,
  isActionLocked,
  isLoadingDirectories,
  loadMoreRef,
  notificationCountByDirectory,
  onActivate,
  onCollectionDragOver,
  onCollectionDrop,
  onDelete,
  onDeleteCollection,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onRemoveFromCollection,
  onRename,
  onUpdateFolderStart,
  onDropConversation,
  onRenameCollection,
  onShowDetails,
  onToggleCollection,
  totalCount,
  visibleDirectories,
  workspaceDirectories,
}: WorkspaceDirectoryListProps): React.JSX.Element {
  const { t } = useI18n();
  // 行内重命名编辑态：单例管理，保证同时只编辑一行
  const [editingDirectoryId, setEditingDirectoryId] = useState<string | null>(
    null,
  );
  const [editingValue, setEditingValue] = useState("");
  // 防重复提交：Enter 触发提交后 input 失焦会再次触发 onBlur
  const isSubmittingRef = useRef(false);

  const handleRenameStart = (directory: WorkspaceDirectoryRecord): void => {
    isSubmittingRef.current = false;
    setEditingValue(directory.name);
    setEditingDirectoryId(directory.directoryId);
  };

  const handleRenameSubmit = (): void => {
    if (isSubmittingRef.current || !editingDirectoryId) {
      return;
    }
    const directory = workspaceDirectories.find(
      (item) => item.directoryId === editingDirectoryId,
    );
    if (!directory) {
      setEditingDirectoryId(null);
      setEditingValue("");
      return;
    }

    const trimmed = editingValue.trim();
    if (!trimmed || trimmed === directory.name) {
      setEditingDirectoryId(null);
      setEditingValue("");
      return;
    }

    isSubmittingRef.current = true;
    void (async (): Promise<void> => {
      try {
        await onRename?.(directory.directoryId, trimmed);
      } finally {
        isSubmittingRef.current = false;
        setEditingDirectoryId(null);
        setEditingValue("");
      }
    })();
  };

  const handleRenameCancel = (): void => {
    isSubmittingRef.current = false;
    setEditingDirectoryId(null);
    setEditingValue("");
  };

  // 拖拽到合集行 = 加入合集：显示 add（copy）光标，与项目行间的排序横线区分
  const handleCollectionDragOver = (
    event: DragEvent<HTMLDivElement>,
    collectionId: string,
  ): void => {
    if (isActionLocked || !draggedDirectoryId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    onCollectionDragOver(collectionId);
  };

  // 拖拽排序插入位置：与 handleDirectoryDrop 的语义保持一致——向上拖
  // （源在目标下方）插到目标行之前 → 顶部横线；向下拖插到目标行之后 → 底部横线。
  const dropIndicatorSide = useMemo(() => {
    if (!draggedDirectoryId || !dragOverDirectoryId) {
      return null;
    }
    if (draggedDirectoryId === dragOverDirectoryId) {
      return null;
    }
    const sourceIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === draggedDirectoryId,
    );
    const targetIndex = workspaceDirectories.findIndex(
      (directory) => directory.directoryId === dragOverDirectoryId,
    );
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }
    return sourceIndex < targetIndex ? "bottom" : "top";
  }, [draggedDirectoryId, dragOverDirectoryId, workspaceDirectories]);

  const handleCollectionDrop = (
    event: DragEvent<HTMLDivElement>,
    collectionId: string,
  ): void => {
    event.preventDefault();
    // React 状态可能未及时同步：优先用 state，缺失时从 dataTransfer 兜底
    const draggedId =
      draggedDirectoryId || event.dataTransfer.getData("text/plain") || null;
    if (!draggedId) {
      return;
    }
    onCollectionDrop(collectionId, draggedId);
  };

  const renderCollectionMembers = (
    collection: ProjectCollectionRecord,
  ): React.JSX.Element | null => {
    if (!expandedCollectionIds.has(collection.collectionId)) {
      return null;
    }

    const memberDirectories = collection.memberDirectoryIds
      .map((directoryId) =>
        workspaceDirectories.find((item) => item.directoryId === directoryId),
      )
      .filter((item): item is WorkspaceDirectoryRecord => Boolean(item));

    if (memberDirectories.length === 0) {
      return (
        <div className="project-collection-empty">
          {t("sidebar.collectionEmpty", {
            defaultValue: "No projects yet — drag one here to add it",
          })}
        </div>
      );
    }

    return (
      <div className="project-collection-members">
        {memberDirectories.map((directory) => (
          <WorkspaceDirectoryRow
            activeDirectoryId={activeDirectoryId}
            directory={directory}
            draggedDirectoryId={draggedDirectoryId}
            dragOverDirectoryId={dragOverDirectoryId}
            dropIndicatorSide={dropIndicatorSide}
            editingValue={editingValue}
            index={0}
            isActionLocked={isActionLocked}
            isEditing={false}
            key={directory.directoryId}
            notificationCount={
              notificationCountByDirectory?.[directory.directoryId] ?? 0
            }
            onActivate={onActivate}
            onDelete={onDelete}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDragStart={onDragStart}
            onDrop={onDrop}
            onEditingValueChange={setEditingValue}
            onRemoveFromCollection={() =>
              onRemoveFromCollection(
                collection.collectionId,
                directory.directoryId,
              )
            }
            onRenameCancel={handleRenameCancel}
            onRenameSubmit={handleRenameSubmit}
            onShowDetails={onShowDetails}
            onUpdateFolderStart={onUpdateFolderStart}
            onDropConversation={onDropConversation}
            showIndex={false}
            totalCount={0}
            draggable={false}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      className="section-list workspace-directory-list"
      ref={directoryListRef}
    >
      {collections.length > 0 ? (
        <div className="project-collections">
          {collections.map((collection) => {
            const isExpanded = expandedCollectionIds.has(
              collection.collectionId,
            );
            const isDragOver = dragOverCollectionId === collection.collectionId;
            return (
              <div
                className={`project-collection-group${
                  isExpanded ? " expanded" : ""
                }`}
                key={collection.collectionId}
              >
                <div
                  className={`project-collection-row${
                    isDragOver ? " drag-over" : ""
                  }`}
                  onDragOver={(event) =>
                    handleCollectionDragOver(event, collection.collectionId)
                  }
                  onDrop={(event) =>
                    handleCollectionDrop(event, collection.collectionId)
                  }
                >
                  <button
                    className="project-collection-toggle"
                    disabled={isActionLocked}
                    onClick={() => onToggleCollection(collection.collectionId)}
                    title={collection.name}
                    type="button"
                  >
                    <ChevronRight
                      className={
                        isExpanded ? "project-collection-chevron--open" : ""
                      }
                      size={12}
                    />
                    <Library className="list-icon" size={15} />
                    <span className="list-label">{collection.name}</span>
                    <span
                      className="project-collection-badge"
                      title={t("sidebar.collectionMemberCount", {
                        values: { count: collection.memberDirectoryIds.length },
                        defaultValue: "{{count}} project(s)",
                      })}
                    >
                      {collection.memberDirectoryIds.length}
                    </span>
                  </button>
                  <span className="project-collection-actions">
                    <button
                      aria-label={t("sidebar.renameCollection", {
                        defaultValue: "Rename collection",
                      })}
                      className="icon-btn ghost"
                      disabled={isActionLocked}
                      onClick={() => onRenameCollection(collection)}
                      title={t("sidebar.renameCollection", {
                        defaultValue: "Rename collection",
                      })}
                      type="button"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      aria-label={t("sidebar.deleteCollection", {
                        defaultValue: "Delete collection",
                      })}
                      className="icon-btn ghost"
                      disabled={isActionLocked}
                      onClick={() => onDeleteCollection(collection)}
                      title={t("sidebar.deleteCollection", {
                        defaultValue: "Delete collection",
                      })}
                      type="button"
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
                {renderCollectionMembers(collection)}
              </div>
            );
          })}
        </div>
      ) : null}
      {isLoadingDirectories ? (
        <span className="empty-text">
          {t("sidebar.loadingDirectories", {
            defaultValue: "Loading directories...",
          })}
        </span>
      ) : workspaceDirectories.length === 0 ? (
        <span className="empty-text">
          {t("sidebar.noDirectories", {
            defaultValue: "No directories",
          })}
        </span>
      ) : (
        <>
          {visibleDirectories.map((directory, index) => (
            <WorkspaceDirectoryRow
              activeDirectoryId={activeDirectoryId}
              directory={directory}
              draggedDirectoryId={draggedDirectoryId}
              dragOverDirectoryId={dragOverDirectoryId}
              dropIndicatorSide={dropIndicatorSide}
              editingValue={editingValue}
              index={index}
              isActionLocked={isActionLocked}
              isEditing={editingDirectoryId === directory.directoryId}
              key={directory.directoryId}
              notificationCount={
                notificationCountByDirectory?.[directory.directoryId] ?? 0
              }
              onActivate={onActivate}
              onDelete={onDelete}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver}
              onDragStart={onDragStart}
              onDrop={onDrop}
              onEditingValueChange={setEditingValue}
              onRenameCancel={handleRenameCancel}
              onRenameStart={handleRenameStart}
              onRenameSubmit={handleRenameSubmit}
              onShowDetails={onShowDetails}
              onUpdateFolderStart={onUpdateFolderStart}
              onDropConversation={onDropConversation}
              totalCount={totalCount}
            />
          ))}
          {hasMoreDirectories ? (
            <div
              aria-hidden="true"
              className="workspace-directory-load-more"
              ref={loadMoreRef}
            >
              <Loader2 className="spin" size={13} />
              <span>
                {t("sidebar.loadingMoreDirectories", {
                  defaultValue: "Loading more...",
                })}
              </span>
            </div>
          ) : (
            <div className="workspace-directory-end-line">
              <span>
                {t("sidebar.allDirectoriesLoaded", {
                  defaultValue: "All directories loaded",
                })}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
