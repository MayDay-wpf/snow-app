import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { WorkspaceDirectoryRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { useSshConnectionStatus } from "../../../../ssh/sshConnectionStore";
import { Tooltip } from "../../../common/Tooltip";
import { SidebarCollapse } from "../SidebarCollapse";
import { SshConnectionBadge } from "../SshConnectionBadge";
import { WorkspaceDirectoryMenu } from "../WorkspaceDirectoryMenu";
import { getDirectoryIcon } from "../WorkspaceDirectoryRow";
import type { DirectoryDragDropController } from "../projects/useDirectoryDragDrop";
import { TreeProjectChats } from "./TreeProjectChats";

type TreeProjectNodeProps = {
  directory: WorkspaceDirectoryRecord;
  displayName?: string;
  activeDirectoryId?: string;
  activeConversationId?: string;
  hasActiveSession: boolean;
  notificationCount: number;
  collectionId?: string;
  collectionColor?: string;
  collectionName?: string;
  memberLinked?: boolean;
  isExpanded: boolean;
  isActionLocked: boolean;
  dropIndicatorSide: "top" | "bottom" | null;
  dragAndDrop: DirectoryDragDropController;
  onDirectoryDrop?: (directoryId: string, dataTransfer: DataTransfer) => void;
  sectionListRef: RefObject<HTMLDivElement | null>;
  onActivate: (directoryId: string) => void;
  onToggle: (directoryId: string) => void;
  onDelete: (directoryId: string) => void;
  onRename: (directoryId: string, newName: string) => Promise<void>;
  onLinkProjects?: (directoryId: string) => void;
  onShowDetails?: (directoryId: string) => void;
  onShowRelinkHistory?: (directoryId: string) => void;
  onToggleMemberLinked?: (
    collectionId: string,
    directoryId: string,
    linked: boolean,
  ) => void;
  onRemoveFromCollection?: (collectionId: string, directoryId: string) => void;
};

export function TreeProjectNode({
  directory,
  displayName,
  activeDirectoryId,
  activeConversationId,
  hasActiveSession,
  notificationCount,
  collectionId,
  collectionColor,
  collectionName,
  memberLinked = false,
  isExpanded,
  isActionLocked,
  dropIndicatorSide,
  dragAndDrop,
  onDirectoryDrop,
  sectionListRef,
  onActivate,
  onToggle,
  onDelete,
  onRename,
  onLinkProjects,
  onShowDetails,
  onShowRelinkHistory,
  onToggleMemberLinked,
  onRemoveFromCollection,
}: TreeProjectNodeProps): React.JSX.Element {
  const { t } = useI18n();
  const directoryId = directory.directoryId;
  const isActive = directoryId === activeDirectoryId;
  // 非 SSH 目录返回 null，不渲染徽标
  const sshStatus = useSshConnectionStatus(directory);

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editingValue, setEditingValue] = useState("");
  // 会话列表按需挂载：展开时才挂载并加载该项目的会话，收起动画结束后卸载释放。
  // 否则「打开过一次的项目」会在整个应用生命周期里一直持有整份会话列表。
  const [hasMountedChats, setHasMountedChats] = useState(isExpanded);

  if (isExpanded && !hasMountedChats) {
    setHasMountedChats(true);
  }

  const handleChatsCollapseEnd = (): void => {
    if (!isExpanded) {
      setHasMountedChats(false);
    }
  };

  const editInputRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  const isDragging = dragAndDrop.draggedDirectoryId === directoryId;
  const isDragOver = dragAndDrop.dragOverDirectoryId === directoryId;
  const isDraggable = !isActionLocked && !isEditing;
  // 行尾状态指示占用右侧空间，菜单按钮需让位到其左侧
  const hasSessionDot = hasActiveSession;
  const hasNotificationBadge = notificationCount > 0;

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>): void => {
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", directoryId);
    dragAndDrop.handleDirectoryDragStart(directoryId);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (
      isActionLocked ||
      !dragAndDrop.draggedDirectoryId ||
      dragAndDrop.draggedDirectoryId === directoryId
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    dragAndDrop.handleDirectoryDragOver(directoryId);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (onDirectoryDrop) {
      onDirectoryDrop(directoryId, event.dataTransfer);
      return;
    }
    dragAndDrop.handleDirectoryDrop(directoryId, event.dataTransfer);
  };

  const handleRowClick = (): void => {
    if (!isActive) {
      onActivate(directoryId);
      if (!isExpanded) {
        onToggle(directoryId);
      }
      return;
    }
    onToggle(directoryId);
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (isEditing) {
      return;
    }
    event.preventDefault();
    setIsMenuOpen(true);
    setContextMenuAnchor({ x: event.clientX, y: event.clientY });
  };

  const handleRenameStart = (): void => {
    isSubmittingRef.current = false;
    cancelledRef.current = false;
    setEditingValue(directory.name);
    setIsEditing(true);
  };

  const handleRenameSubmit = (): void => {
    if (isSubmittingRef.current || cancelledRef.current || !isEditing) {
      return;
    }
    const trimmed = editingValue.trim();
    if (!trimmed || trimmed === directory.name) {
      setIsEditing(false);
      setEditingValue("");
      return;
    }

    isSubmittingRef.current = true;
    void (async (): Promise<void> => {
      try {
        await onRename(directoryId, trimmed);
      } catch {
        void 0;
      } finally {
        isSubmittingRef.current = false;
        setIsEditing(false);
        setEditingValue("");
      }
    })();
  };

  const handleRenameCancel = (): void => {
    cancelledRef.current = true;
    setIsEditing(false);
    setEditingValue("");
  };

  return (
    <div className={`tree-project-node${isExpanded ? " expanded" : ""}`}>
      <div
        className={`tree-project-row-wrap workspace-directory-row${
          isActive ? " active" : ""
        }${isMenuOpen ? " menu-open" : ""}${isEditing ? " editing" : ""}${
          isDragging ? " dragging" : ""
        }${isDragOver ? " drag-over" : ""}${
          hasSessionDot ? " has-status-dot" : ""
        }${hasNotificationBadge ? " has-notification-badge" : ""}`}
        draggable={isDraggable}
        onContextMenu={handleContextMenu}
        onDragEnd={dragAndDrop.handleDirectoryDragEnd}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
        onDrop={handleDrop}
      >
        {isEditing ? (
          <div className="list-item tree-project-row-edit">
            {getDirectoryIcon(directory)}
            <input
              ref={editInputRef}
              className="workspace-directory-rename-input"
              type="text"
              value={editingValue}
              onChange={(event) => setEditingValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleRenameSubmit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  handleRenameCancel();
                }
              }}
              onBlur={handleRenameSubmit}
              placeholder={t("sidebar.directoryRenamePlaceholder", {
                defaultValue: "Enter new name",
              })}
            />
          </div>
        ) : (
          <>
            <Tooltip
              content={t("sidebar.treeToggleProject", {
                defaultValue: "Expand/collapse project",
              })}
              placement="top"
            >
              <button
                aria-label={t("sidebar.treeToggleProject", {
                  defaultValue: "Expand/collapse project",
                })}
                className="tree-chevron-btn"
                onClick={() => onToggle(directoryId)}
                type="button"
              >
                <ChevronRight
                  className={isExpanded ? "tree-chevron--open" : ""}
                  size={12}
                />
              </button>
            </Tooltip>
            <button
              className="tree-project-row"
              onClick={handleRowClick}
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
              <span className="list-label">
                {displayName ?? directory.name}
              </span>
              {sshStatus ? <SshConnectionBadge status={sshStatus} /> : null}
              {hasActiveSession ? (
                <span
                  className="tree-project-session-dot"
                  title={t("sidebar.treeRunningSession", {
                    defaultValue: "A session is running in this project",
                  })}
                />
              ) : null}
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
          </>
        )}
        {!isEditing ? (
          <WorkspaceDirectoryMenu
            canDelete={directory.source !== "builtin" && !hasActiveSession}
            contextMenuAnchor={contextMenuAnchor}
            directoryId={directoryId}
            directoryName={directory.name}
            directoryPath={directory.path}
            disabled={isActionLocked}
            isActive={isActive}
            kind={directory.kind}
            memberLinked={memberLinked}
            onActivate={() => onActivate(directoryId)}
            onContextMenuClose={() => setContextMenuAnchor(null)}
            onDelete={() => onDelete(directoryId)}
            onLinkProjects={
              onLinkProjects ? () => onLinkProjects(directoryId) : undefined
            }
            onOpenChange={setIsMenuOpen}
            onRemoveFromCollection={
              collectionId && onRemoveFromCollection
                ? () => onRemoveFromCollection(collectionId, directoryId)
                : undefined
            }
            onRename={handleRenameStart}
            onShowDetails={
              onShowDetails ? () => onShowDetails(directoryId) : undefined
            }
            onShowRelinkHistory={
              onShowRelinkHistory
                ? () => onShowRelinkHistory(directoryId)
                : undefined
            }
            onToggleMemberLinked={
              collectionId && onToggleMemberLinked
                ? () =>
                    onToggleMemberLinked(
                      collectionId,
                      directoryId,
                      !memberLinked,
                    )
                : undefined
            }
          />
        ) : null}
        {!isEditing && isDragOver && dropIndicatorSide ? (
          <span
            aria-hidden="true"
            className={`workspace-directory-drop-line ${dropIndicatorSide}`}
          />
        ) : null}
      </div>
      <SidebarCollapse
        onTransitionEnd={handleChatsCollapseEnd}
        open={isExpanded}
      >
        {hasMountedChats ? (
          <div className="tree-project-chats">
            <TreeProjectChats
              activeConversationId={activeConversationId}
              activeDirectoryId={activeDirectoryId}
              directoryId={directoryId}
              sectionListRef={sectionListRef}
            />
          </div>
        ) : null}
      </SidebarCollapse>
    </div>
  );
}
