import {
  Folder,
  FolderOpen,
  GripVertical,
  Server,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";

import { useI18n } from "../../../i18n";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { WorkspaceDirectoryMenu } from "./WorkspaceDirectoryMenu";

type WorkspaceDirectoryRowProps = {
  directory: WorkspaceDirectoryRecord;
  index: number;
  totalCount: number;
  activeDirectoryId?: string;
  isActionLocked: boolean;
  draggedDirectoryId: string | null;
  dragOverDirectoryId: string | null;
  /** 行内重命名编辑态（由列表层单例管理，保证同时只编辑一行） */
  isEditing: boolean;
  /** 该项目的跨项目通知会话数（>0 时显示徽标） */
  notificationCount?: number;
  editingValue: string;
  onEditingValueChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onActivate: (directoryId: string) => void;
  onDelete: (directoryId: string) => void;
  onDragEnd: () => void;
  onDragOver: (directoryId: string) => void;
  onDragStart: (directoryId: string) => void;
  onDrop: (directoryId: string) => void;
  onRenameStart: (directory: WorkspaceDirectoryRecord) => void;
  onShowDetails?: (directoryId: string) => void;
};

const getDirectoryIcon = (
  directory: WorkspaceDirectoryRecord
): React.JSX.Element => {
  if (directory.isActive) {
    return <FolderOpen className="list-icon" size={15} />;
  }

  if (directory.kind === "ssh") {
    return <Server className="list-icon" size={15} />;
  }

  return <Folder className="list-icon" size={15} />;
};

/**
 * 单条目录行：按钮菜单与右键菜单状态都在本组件内独立管理
 * （与 ChatItem 的右键交互模式一致），避免多行共享锚点导致
 * 一行菜单关闭时把其它行的右键菜单一并清掉。
 */
export function WorkspaceDirectoryRow({
  directory,
  index,
  totalCount,
  activeDirectoryId,
  isActionLocked,
  draggedDirectoryId,
  dragOverDirectoryId,
  isEditing,
  notificationCount,
  editingValue,
  onEditingValueChange,
  onRenameSubmit,
  onRenameCancel,
  onActivate,
  onDelete,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onRenameStart,
  onShowDetails,
}: WorkspaceDirectoryRowProps): React.JSX.Element {
  const { t } = useI18n();
  // 三点按钮菜单是否打开（用于行高亮样式）
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // 右键菜单锚点（光标位置），右键时打开、失焦时清空
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  const isDragging = draggedDirectoryId === directory.directoryId;
  const isDragOver = dragOverDirectoryId === directory.directoryId;
  const isActive = directory.directoryId === activeDirectoryId;

  const handleDragStart = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string
  ): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", directoryId);
    onDragStart(directoryId);
  };

  const handleDragOver = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string
  ): void => {
    if (isActionLocked || draggedDirectoryId === directoryId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onDragOver(directoryId);
  };

  const handleDrop = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string
  ): void => {
    event.preventDefault();
    onDrop(directoryId);
  };

  // 右键 == 三点按钮菜单：在光标位置弹出同一份操作菜单
  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    // 编辑态不拦截右键，保留系统菜单（输入框复制粘贴等）
    if (isEditing) {
      return;
    }
    event.preventDefault();
    setIsMenuOpen(true);
    setContextMenuAnchor({ x: event.clientX, y: event.clientY });
  };

  return (
    <div
      className={`workspace-directory-row${
        isDragging ? " dragging" : ""
      }${isDragOver ? " drag-over" : ""}${
        isMenuOpen ? " menu-open" : ""
      }${isEditing ? " editing" : ""}`}
      draggable={!isActionLocked && !isEditing}
      key={directory.directoryId}
      onContextMenu={handleContextMenu}
      onDragEnd={onDragEnd}
      onDragOver={(event) => handleDragOver(event, directory.directoryId)}
      onDragStart={(event) => handleDragStart(event, directory.directoryId)}
      onDrop={(event) => handleDrop(event, directory.directoryId)}
    >
      {isEditing ? (
        <div className="list-item">
          <span className="workspace-directory-guide" aria-hidden="true">
            <span className="workspace-directory-guide-dot" />
          </span>
          <span
            aria-label={t("sidebar.dragDirectory", {
              defaultValue: "Drag to reorder",
            })}
            className="workspace-directory-drag-handle"
            role="img"
          >
            <GripVertical size={13} />
          </span>
          {getDirectoryIcon(directory)}
          <input
            ref={editInputRef}
            className="workspace-directory-rename-input"
            type="text"
            value={editingValue}
            onChange={(event) => onEditingValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onRenameSubmit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onRenameCancel();
              }
            }}
            onBlur={onRenameSubmit}
            placeholder={t("sidebar.directoryRenamePlaceholder", {
              defaultValue: "Enter new name",
            })}
          />
        </div>
      ) : (
        <button
          className={`list-item${isActive ? " active" : ""}`}
          disabled={isActionLocked}
          onClick={() => onActivate(directory.directoryId)}
          onDoubleClick={() => onShowDetails?.(directory.directoryId)}
          title={directory.path}
          type="button"
        >
          <span className="workspace-directory-guide" aria-hidden="true">
            <span className="workspace-directory-guide-dot" />
          </span>
          <span
            aria-label={t("sidebar.dragDirectory", {
              defaultValue: "Drag to reorder",
            })}
            className="workspace-directory-drag-handle"
            role="img"
          >
            <GripVertical size={13} />
          </span>
          {getDirectoryIcon(directory)}
          <span className="list-label">{directory.name}</span>
          <span className="list-meta">
            {directory.kind === "ssh"
              ? t("sidebar.directoryKindSsh", {
                  defaultValue: "SSH",
                })
              : t("sidebar.directoryKindLocal", {
                  defaultValue: "Local",
                })}
          </span>
          {notificationCount ? (
            <span
              className="workspace-directory-notification-badge"
              title={t("sidebar.directoryNotificationBadgeTitle", {
                values: { count: notificationCount },
                defaultValue: "{{count}} notification(s) in this project",
              })}
            >
              {notificationCount}
            </span>
          ) : null}
          <span className="workspace-directory-index">
            {index + 1}/{totalCount}
          </span>
        </button>
      )}
      <WorkspaceDirectoryMenu
        canDelete={directory.source !== "builtin"}
        contextMenuAnchor={contextMenuAnchor}
        directoryPath={directory.path}
        disabled={isActionLocked}
        isActive={isActive}
        kind={directory.kind}
        onActivate={() => onActivate(directory.directoryId)}
        onContextMenuClose={() => setContextMenuAnchor(null)}
        onDelete={() => onDelete(directory.directoryId)}
        onOpenChange={setIsMenuOpen}
        onRename={() => onRenameStart(directory)}
        onShowDetails={
          onShowDetails ? () => onShowDetails(directory.directoryId) : undefined
        }
      />
    </div>
  );
}
