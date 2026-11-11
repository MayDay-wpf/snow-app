import { Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";

import { useI18n } from "../../../i18n";
import { useSshConnectionStatus } from "../../../ssh/sshConnectionStore";
import { getFileTypeIcon } from "../../../utils/fileIcons";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { DirectoryPathBadge } from "./DirectoryPathBadge";
import { SshConnectionBadge } from "./SshConnectionBadge";
import { WorkspaceDirectoryMenu } from "./WorkspaceDirectoryMenu";

type WorkspaceDirectoryRowProps = {
  directory: WorkspaceDirectoryRecord;
  displayName?: string;
  activeDirectoryId?: string;
  isActionLocked: boolean;
  draggedDirectoryId: string | null;
  dragOverDirectoryId: string | null;
  /** 拖拽排序插入指示线位置：目标行顶部/底部（null 不显示） */
  dropIndicatorSide?: "top" | "bottom" | null;
  /** 行内重命名编辑态（由列表层单例管理，保证同时只编辑一行） */
  isEditing: boolean;
  hasActiveSession?: boolean;
  /** 该项目的跨项目通知会话数（>0 时显示徽标） */
  notificationCount?: number;
  /** 是否可拖拽（默认 true） */
  draggable?: boolean;
  /** 关联项目组统一颜色：参与关联的成员行渲染同色圆点标识 */
  collectionColor?: string;
  /** 关联项目组名称（圆点悬停提示） */
  collectionName?: string;
  /** 该成员是否参与关联（断连成员仍在合集里，但不显示圆点） */
  memberLinked?: boolean;
  /** 与其它目录关联成一个统一项目（非成员行入口） */
  onLinkProjects?: () => void;
  /** 切换该成员是否参与关联 */
  onToggleMemberLinked?: () => void;
  /** 从所属合集移除（合集成员行专用，非成员行不传） */
  onRemoveFromCollection?: () => void;
  editingValue: string;
  onEditingValueChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onActivate: (directoryId: string) => void;
  onDelete: (directoryId: string) => void;
  onDragEnd: () => void;
  onDragOver: (directoryId: string) => void;
  onDragStart: (directoryId: string) => void;
  onDrop: (directoryId: string, dataTransfer: DataTransfer) => void;
  onRenameStart?: (directory: WorkspaceDirectoryRecord) => void;
  /** 编辑远程目录的连接信息（仅 SSH 目录显示） */
  onEditConnection?: (directory: WorkspaceDirectoryRecord) => void;
  onShowDetails?: (directoryId: string) => void;
  /** 查看该项目的迁移记录（含撤销入口） */
  onShowRelinkHistory?: (directoryId: string) => void;
};

export const getDirectoryIcon = (
  directory: WorkspaceDirectoryRecord,
): React.JSX.Element => {
  // SSH 目录始终用 Server 图标：图标表达类型，激活态由行高亮样式承担
  if (directory.kind === "ssh") {
    return <Server className="list-icon list-icon--ssh" size={15} />;
  }

  // 本地文件夹配色复用资源管理器（utils/fileIcons）
  return getFileTypeIcon(directory.name, true, directory.isActive, {
    className: "list-icon",
    size: 15,
  });
};

/**
 * 单条目录行：按钮菜单与右键菜单状态都在本组件内独立管理
 * （与 ChatItem 的右键交互模式一致），避免多行共享锚点导致
 * 一行菜单关闭时把其它行的右键菜单一并清掉。
 */
export function WorkspaceDirectoryRow({
  directory,
  displayName,
  activeDirectoryId,
  isActionLocked,
  draggedDirectoryId,
  dragOverDirectoryId,
  dropIndicatorSide,
  isEditing,
  hasActiveSession,
  notificationCount,
  draggable = true,
  collectionColor,
  collectionName,
  memberLinked = false,
  onLinkProjects,
  onToggleMemberLinked,
  onRemoveFromCollection,
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
  onEditConnection,
  onShowDetails,
  onShowRelinkHistory,
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
  // 非 SSH 目录返回 null，不渲染徽标
  const sshStatus = useSshConnectionStatus(directory);

  const handleDragStart = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string,
  ): void => {
    // copyMove：项目行间排序用 move，拖入合集用 copy（add 光标），
    // 仅允许 move 时 dragover 中的 dropEffect="copy" 会被浏览器忽略。
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", directoryId);
    onDragStart(directoryId);
  };

  const handleDragOver = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string,
  ): void => {
    if (
      isActionLocked ||
      !draggedDirectoryId ||
      draggedDirectoryId === directoryId
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onDragOver(directoryId);
  };

  const handleDrop = (
    event: DragEvent<HTMLDivElement>,
    directoryId: string,
  ): void => {
    event.preventDefault();
    onDrop(directoryId, event.dataTransfer);
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
      draggable={draggable && !isActionLocked && !isEditing}
      key={directory.directoryId}
      onContextMenu={handleContextMenu}
      onDragEnd={onDragEnd}
      onDragOver={(event) => handleDragOver(event, directory.directoryId)}
      onDragStart={(event) => handleDragStart(event, directory.directoryId)}
      onDrop={(event) => handleDrop(event, directory.directoryId)}
    >
      {isEditing ? (
        <div className="list-item">
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
          {collectionColor && memberLinked ? (
            <span
              aria-hidden="true"
              className="workspace-directory-collection-dot"
              style={{ background: collectionColor }}
              title={t("sidebar.collectionDotTitle", {
                values: { name: collectionName ?? "" },
                defaultValue: "Linked project group: {{name}}",
              })}
            />
          ) : null}
          {getDirectoryIcon(directory)}
          <span className="list-label">{displayName ?? directory.name}</span>
          {sshStatus ? <SshConnectionBadge status={sshStatus} /> : null}
          <DirectoryPathBadge directory={directory} />
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
        </button>
      )}
      <WorkspaceDirectoryMenu
        canDelete={directory.source !== "builtin" && !hasActiveSession}
        contextMenuAnchor={contextMenuAnchor}
        directoryId={directory.directoryId}
        directoryName={directory.name}
        directoryPath={directory.path}
        disabled={isActionLocked}
        isActive={isActive}
        kind={directory.kind}
        onActivate={() => onActivate(directory.directoryId)}
        onContextMenuClose={() => setContextMenuAnchor(null)}
        onDelete={() => onDelete(directory.directoryId)}
        memberLinked={memberLinked}
        onLinkProjects={onLinkProjects ? () => onLinkProjects() : undefined}
        onToggleMemberLinked={
          onToggleMemberLinked ? () => onToggleMemberLinked() : undefined
        }
        onOpenChange={setIsMenuOpen}
        onRemoveFromCollection={
          onRemoveFromCollection ? onRemoveFromCollection : undefined
        }
        onRename={onRenameStart ? () => onRenameStart(directory) : undefined}
        onEditConnection={
          onEditConnection ? () => onEditConnection(directory) : undefined
        }
        onShowDetails={
          onShowDetails ? () => onShowDetails(directory.directoryId) : undefined
        }
        onShowRelinkHistory={
          onShowRelinkHistory
            ? () => onShowRelinkHistory(directory.directoryId)
            : undefined
        }
      />
      {!isEditing && isDragOver && dropIndicatorSide ? (
        <span
          aria-hidden="true"
          className={`workspace-directory-drop-line ${dropIndicatorSide}`}
        />
      ) : null}
    </div>
  );
}
