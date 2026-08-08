import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useI18n } from "../../../i18n";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { WorkspaceDirectoryRow } from "./WorkspaceDirectoryRow";

type WorkspaceDirectoryListProps = {
  activeDirectoryId?: string;
  directoryListRef: RefObject<HTMLDivElement | null>;
  draggedDirectoryId: string | null;
  dragOverDirectoryId: string | null;
  hasMoreDirectories: boolean;
  isActionLocked: boolean;
  isLoadingDirectories: boolean;
  loadMoreRef: RefObject<HTMLDivElement | null>;
  /** 各项目通知计数（directoryId → 通知会话数），用于条目徽标 */
  notificationCountByDirectory?: Record<string, number>;
  onActivate: (directoryId: string) => void;
  onDelete: (directoryId: string) => void;
  onDragEnd: () => void;
  onDragOver: (directoryId: string) => void;
  onDragStart: (directoryId: string) => void;
  onDrop: (directoryId: string) => void;
  /** 重命名目录显示名；返回 Promise 时提交期间保持编辑态直到完成 */
  onRename?: (directoryId: string, newName: string) => void | Promise<void>;
  onShowDetails?: (directoryId: string) => void;
  totalCount: number;
  visibleDirectories: WorkspaceDirectoryRecord[];
  workspaceDirectories: WorkspaceDirectoryRecord[];
};

export function WorkspaceDirectoryList({
  activeDirectoryId,
  directoryListRef,
  draggedDirectoryId,
  dragOverDirectoryId,
  hasMoreDirectories,
  isActionLocked,
  isLoadingDirectories,
  loadMoreRef,
  notificationCountByDirectory,
  onActivate,
  onDelete,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onRename,
  onShowDetails,
  totalCount,
  visibleDirectories,
  workspaceDirectories,
}: WorkspaceDirectoryListProps): React.JSX.Element {
  const { t } = useI18n();
  // 行内重命名编辑态：单例管理，保证同时只编辑一行
  const [editingDirectoryId, setEditingDirectoryId] = useState<string | null>(
    null
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
      (item) => item.directoryId === editingDirectoryId
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

  return (
    <div
      className="section-list workspace-directory-list"
      ref={directoryListRef}
    >
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
