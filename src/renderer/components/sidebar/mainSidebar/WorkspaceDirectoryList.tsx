import {
  ChevronRight,
  FolderPlus,
  Library,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";

import { useI18n } from "../../../i18n";
import { ContextMenu } from "../../common/ContextMenu";
import type {
  ProjectCollectionRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { SidebarCollapse } from "./SidebarCollapse";
import { buildDirectoryDisplayNames } from "./directoryDisplayName";
import {
  isProjectCollectionDrag,
  PROJECT_COLLECTION_DRAG_TYPE,
} from "./projects/projectCollectionDrag";
import { WorkspaceDirectoryRow } from "./WorkspaceDirectoryRow";

type WorkspaceDirectoryListProps = {
  activeDirectoryId?: string;
  activeSessionDirectoryIds?: Set<string>;
  /** 项目合集列表（渲染在项目列表上方，支持拖拽项目加入） */
  collections: ProjectCollectionRecord[];
  directoryListRef: RefObject<HTMLDivElement | null>;
  draggedDirectoryId: string | null;
  /** 正在拖拽的合集 id（合集行之间的排序） */
  draggedCollectionId: string | null;
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
  /** 右键合集「添加项目」：进入带目标合集的添加流程（新项目自动加入该合集） */
  onAddProjectToCollection: (collection: ProjectCollectionRecord) => void;
  onCollectionDragOver: (collectionId: string) => void;
  onCollectionDrop: (collectionId: string, directoryId: string) => void;
  /** 合集行开始拖拽（合集排序） */
  onCollectionDragStart: (collectionId: string) => void;
  /** 合集行之间的 drop：重排合集本身 */
  onCollectionReorderDrop: (
    collectionId: string,
    dataTransfer: DataTransfer,
  ) => void;
  /** 合集成员行之间的 drop：同合集=成员重排；跨合集/顶层=移动进该合集的指定位置 */
  onCollectionMemberDrop: (
    collectionId: string,
    directoryId: string,
    dataTransfer: DataTransfer,
  ) => void;
  onDelete: (directoryId: string) => void;
  onDeleteCollection: (collection: ProjectCollectionRecord) => void;
  onDragEnd: () => void;
  onDragOver: (directoryId: string) => void;
  onDragStart: (directoryId: string) => void;
  onDrop: (directoryId: string, dataTransfer: DataTransfer) => void;
  /** 拖到顶层列表空白区域（非行、非合集）：合集成员移出合集回到顶层 */
  onDropOutside: (directoryId: string) => void;
  /** 打开「关联项目…」弹窗：把该目录与其它目录关联成一个统一项目 */
  onLinkProjects: (directoryId: string) => void;
  /** 切换成员是否参与关联：断连后该目录仍留在合集里 */
  onToggleMemberLinked: (
    collectionId: string,
    directoryId: string,
    linked: boolean,
  ) => void;
  onRemoveFromCollection: (collectionId: string, directoryId: string) => void;
  /** 重命名目录显示名；返回 Promise 时提交期间保持编辑态直到完成 */
  onRename?: (directoryId: string, newName: string) => void | Promise<void>;
  /** 编辑远程目录的连接信息（登录信息 / 端口 / 远程目录） */
  onEditConnection?: (directory: WorkspaceDirectoryRecord) => void;
  onRenameCollection: (collection: ProjectCollectionRecord) => void;
  onShowDetails?: (directoryId: string) => void;
  /** 查看该项目的迁移记录（含撤销入口） */
  onShowRelinkHistory?: (directoryId: string) => void;
  onToggleCollection: (collectionId: string) => void;
  visibleDirectories: WorkspaceDirectoryRecord[];
  workspaceDirectories: WorkspaceDirectoryRecord[];
};

export function WorkspaceDirectoryList({
  activeDirectoryId,
  activeSessionDirectoryIds,
  collections,
  directoryListRef,
  draggedDirectoryId,
  draggedCollectionId,
  dragOverCollectionId,
  dragOverDirectoryId,
  expandedCollectionIds,
  hasMoreDirectories,
  isActionLocked,
  isLoadingDirectories,
  loadMoreRef,
  notificationCountByDirectory,
  onActivate,
  onAddProjectToCollection,
  onCollectionDragOver,
  onCollectionDrop,
  onCollectionDragStart,
  onCollectionReorderDrop,
  onCollectionMemberDrop,
  onDelete,
  onDeleteCollection,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onDropOutside,
  onLinkProjects,
  onToggleMemberLinked,
  onRemoveFromCollection,
  onRename,
  onEditConnection,
  onRenameCollection,
  onShowDetails,
  onShowRelinkHistory,
  onToggleCollection,
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
  // 合集行右键菜单锚点（光标位置），同一时间只打开一个合集菜单
  const [collectionMenuAnchor, setCollectionMenuAnchor] = useState<{
    collectionId: string;
    x: number;
    y: number;
  } | null>(null);

  const displayNames = useMemo(
    () => buildDirectoryDisplayNames(workspaceDirectories),
    [workspaceDirectories],
  );

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

  // 拖拽到合集行：项目 = 加入合集（copy）；合集 = 合集之间的排序（move），
  // 两者靠 DataTransfer 区分，避免把合集拖拽当成成员收纳。
  const isCollectionDragActive = (dataTransfer: DataTransfer): boolean =>
    Boolean(draggedCollectionId) || isProjectCollectionDrag(dataTransfer);

  const handleCollectionDragOver = (
    event: DragEvent<HTMLDivElement>,
    collectionId: string,
  ): void => {
    if (isActionLocked) {
      return;
    }
    if (isCollectionDragActive(event.dataTransfer)) {
      if (draggedCollectionId === collectionId) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      onCollectionDragOver(collectionId);
      return;
    }
    if (!draggedDirectoryId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    onCollectionDragOver(collectionId);
  };

  // 合集排序插入指示线：向下拖（源在前）显示目标行底部横线，向上拖显示顶部
  const collectionDropIndicatorSide = useMemo(() => {
    if (!draggedCollectionId || !dragOverCollectionId) {
      return null;
    }
    if (draggedCollectionId === dragOverCollectionId) {
      return null;
    }
    const sourceIndex = collections.findIndex(
      (collection) => collection.collectionId === draggedCollectionId,
    );
    const targetIndex = collections.findIndex(
      (collection) => collection.collectionId === dragOverCollectionId,
    );
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }
    return sourceIndex < targetIndex ? "bottom" : "top";
  }, [collections, draggedCollectionId, dragOverCollectionId]);

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

  // 所有合集成员 id 的并集：用于顶层列表空白区域的「移出合集」兜底 drop。
  const allCollectionMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const collection of collections) {
      for (const id of collection.memberDirectoryIds) {
        ids.add(id);
      }
    }
    return ids;
  }, [collections]);

  // 合集成员行的插入指示线：基于该合集内的成员顺序计算（顶层行的
  // dropIndicatorSide 用全量列表索引，对合成员行不适用）。外部来源
  // （顶层或其它合集的项目）统一指示插到目标行之前（top）。
  const getCollectionMemberDropSide = (
    collection: ProjectCollectionRecord,
    directoryId: string,
  ): "top" | "bottom" | null => {
    if (!draggedDirectoryId || dragOverDirectoryId !== directoryId) {
      return null;
    }
    if (draggedDirectoryId === directoryId) {
      return null;
    }
    const memberIds = collection.memberDirectoryIds;
    const sourceIndex = memberIds.indexOf(draggedDirectoryId);
    const targetIndex = memberIds.indexOf(directoryId);
    if (targetIndex < 0) {
      return null;
    }
    if (sourceIndex < 0) {
      return "top";
    }
    return sourceIndex < targetIndex ? "bottom" : "top";
  };

  const handleCollectionDrop = (
    event: DragEvent<HTMLDivElement>,
    collectionId: string,
  ): void => {
    event.preventDefault();
    if (isCollectionDragActive(event.dataTransfer)) {
      onCollectionReorderDrop(collectionId, event.dataTransfer);
      return;
    }
    // React 状态可能未及时同步：优先用 state，缺失时从 dataTransfer 兜底
    const draggedId =
      draggedDirectoryId || event.dataTransfer.getData("text/plain") || null;
    if (!draggedId) {
      return;
    }
    onCollectionDrop(collectionId, draggedId);
  };

  // 列表根节点的兜底落点：项目行/合集行的 dragover 都已 preventDefault，
  // 这里只接住行与行之间的空白区域——把合集成员拖到顶层列表空白处 = 移出合集。
  const handleListRootDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) {
      return;
    }
    if (
      !draggedDirectoryId ||
      !allCollectionMemberIds.has(draggedDirectoryId)
    ) {
      return;
    }
    // 落在合集区域内的空白处不视为「移出合集」
    if (
      (event.target as Element | null)?.closest?.(".project-collection-group")
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleListRootDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) {
      return;
    }
    const draggedId =
      draggedDirectoryId || event.dataTransfer.getData("text/plain") || null;
    if (!draggedId || !allCollectionMemberIds.has(draggedId)) {
      return;
    }
    if (
      (event.target as Element | null)?.closest?.(".project-collection-group")
    ) {
      return;
    }
    event.preventDefault();
    onDropOutside(draggedId);
  };

  const renderCollectionMembers = (
    collection: ProjectCollectionRecord,
  ): React.JSX.Element => {
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
            collectionColor={collection.color}
            collectionName={collection.name}
            memberLinked={collection.linkedDirectoryIds.includes(
              directory.directoryId,
            )}
            directory={directory}
            displayName={displayNames.get(directory.directoryId)}
            draggedDirectoryId={draggedDirectoryId}
            dragOverDirectoryId={dragOverDirectoryId}
            dropIndicatorSide={getCollectionMemberDropSide(
              collection,
              directory.directoryId,
            )}
            editingValue={editingValue}
            hasActiveSession={
              activeSessionDirectoryIds?.has(directory.directoryId) ?? false
            }
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
            onDrop={(directoryId, dataTransfer) =>
              onCollectionMemberDrop(
                collection.collectionId,
                directoryId,
                dataTransfer,
              )
            }
            onEditingValueChange={setEditingValue}
            onToggleMemberLinked={() =>
              onToggleMemberLinked(
                collection.collectionId,
                directory.directoryId,
                !collection.linkedDirectoryIds.includes(directory.directoryId),
              )
            }
            onRemoveFromCollection={() =>
              onRemoveFromCollection(
                collection.collectionId,
                directory.directoryId,
              )
            }
            onRenameCancel={handleRenameCancel}
            onRenameSubmit={handleRenameSubmit}
            onEditConnection={onEditConnection}
            onShowDetails={onShowDetails}
            onShowRelinkHistory={onShowRelinkHistory}
          />
        ))}
      </div>
    );
  };

  // 右键菜单的目标合集：按 id 实时查表，避免缓存的对象过期
  const collectionMenuTarget = collectionMenuAnchor
    ? (collections.find(
        (collection) =>
          collection.collectionId === collectionMenuAnchor.collectionId,
      ) ?? null)
    : null;

  return (
    <div
      className="section-list workspace-directory-list"
      onDragOver={handleListRootDragOver}
      onDrop={handleListRootDrop}
      ref={directoryListRef}
    >
      <div className="workspace-directory-list-inner">
        {collections.length > 0 ? (
          <div className="project-collections">
            {collections.map((collection) => {
              const isExpanded = expandedCollectionIds.has(
                collection.collectionId,
              );
              const isDragOver =
                dragOverCollectionId === collection.collectionId;
              // 合集拖拽悬停：显示插入横线，不显示「加入合集」的整行高亮
              const isCollectionDragHover =
                Boolean(draggedCollectionId) && isDragOver;
              return (
                <div
                  className={`project-collection-group${
                    isExpanded ? " expanded" : ""
                  }`}
                  key={collection.collectionId}
                >
                  <div
                    className={`project-collection-row${
                      isDragOver && !isCollectionDragHover ? " drag-over" : ""
                    }${
                      draggedCollectionId === collection.collectionId
                        ? " dragging"
                        : ""
                    }`}
                    draggable={!isActionLocked}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setCollectionMenuAnchor({
                        collectionId: collection.collectionId,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    onDragEnd={onDragEnd}
                    onDragOver={(event) =>
                      handleCollectionDragOver(event, collection.collectionId)
                    }
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        PROJECT_COLLECTION_DRAG_TYPE,
                        collection.collectionId,
                      );
                      onCollectionDragStart(collection.collectionId);
                    }}
                    onDrop={(event) =>
                      handleCollectionDrop(event, collection.collectionId)
                    }
                  >
                    <button
                      className="project-collection-toggle"
                      disabled={isActionLocked}
                      onClick={() =>
                        onToggleCollection(collection.collectionId)
                      }
                      title={collection.name}
                      type="button"
                    >
                      <ChevronRight
                        className={
                          isExpanded ? "project-collection-chevron--open" : ""
                        }
                        size={12}
                      />
                      <Library
                        className="list-icon list-icon--collection"
                        size={15}
                      />
                      <span
                        aria-hidden="true"
                        className="project-collection-dot"
                        style={{ background: collection.color }}
                      />
                      <span className="list-label">{collection.name}</span>
                      <span
                        className="project-collection-badge"
                        title={t("sidebar.collectionMemberCount", {
                          values: {
                            count: collection.memberDirectoryIds.length,
                            linked: collection.linkedDirectoryIds.length,
                          },
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
                        className="icon-btn ghost project-collection-delete-btn"
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
                    {isCollectionDragHover && collectionDropIndicatorSide ? (
                      <span
                        aria-hidden="true"
                        className={`workspace-directory-drop-line ${collectionDropIndicatorSide}`}
                      />
                    ) : null}
                  </div>
                  <SidebarCollapse open={isExpanded}>
                    {renderCollectionMembers(collection)}
                  </SidebarCollapse>
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
            {visibleDirectories.map((directory) => (
              <WorkspaceDirectoryRow
                activeDirectoryId={activeDirectoryId}
                directory={directory}
                displayName={displayNames.get(directory.directoryId)}
                draggedDirectoryId={draggedDirectoryId}
                dragOverDirectoryId={dragOverDirectoryId}
                dropIndicatorSide={dropIndicatorSide}
                editingValue={editingValue}
                hasActiveSession={
                  activeSessionDirectoryIds?.has(directory.directoryId) ?? false
                }
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
                onLinkProjects={() => onLinkProjects(directory.directoryId)}
                onRenameCancel={handleRenameCancel}
                onRenameStart={handleRenameStart}
                onRenameSubmit={handleRenameSubmit}
                onEditConnection={onEditConnection}
                onShowDetails={onShowDetails}
                onShowRelinkHistory={onShowRelinkHistory}
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
      {collectionMenuAnchor && collectionMenuTarget ? (
        <ContextMenu
          items={[
            {
              id: "add-project-to-collection",
              label: t("sidebar.addProject", { defaultValue: "Add project" }),
              icon: <FolderPlus size={13} />,
              disabled: isActionLocked,
              onClick: () => {
                setCollectionMenuAnchor(null);
                onAddProjectToCollection(collectionMenuTarget);
              },
            },
            {
              id: "rename-collection",
              label: t("sidebar.renameCollection", {
                defaultValue: "Rename collection",
              }),
              icon: <Pencil size={13} />,
              separator: true,
              disabled: isActionLocked,
              onClick: () => {
                setCollectionMenuAnchor(null);
                onRenameCollection(collectionMenuTarget);
              },
            },
            {
              id: "delete-collection",
              label: t("sidebar.deleteCollection", {
                defaultValue: "Delete collection",
              }),
              icon: <Trash2 size={13} />,
              danger: true,
              disabled: isActionLocked,
              onClick: () => {
                setCollectionMenuAnchor(null);
                onDeleteCollection(collectionMenuTarget);
              },
            },
          ]}
          onClose={() => setCollectionMenuAnchor(null)}
          x={collectionMenuAnchor.x}
          y={collectionMenuAnchor.y}
        />
      ) : null}
    </div>
  );
}
