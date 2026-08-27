import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  GitFork,
  Loader2,
  MessageSquareMore,
  Pause,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { ChatItemMenu, type ExportFormat } from "./ChatItemMenu";
import {
  beginConversationDrag,
  endConversationDrag,
  type ConversationDragPayload,
} from "./conversationDrag";
import { setChatDragData } from "./chatDrag";
import { formatTimeLabel, parseDbTimestamp } from "./chatTimeGroup";

type ChatItemProps = {
  conversation: ChatConversationRecord;
  isActive?: boolean;
  isAttentionRequired?: boolean;
  isStreaming?: boolean;
  /** 流式会话被用户暂停（agent loop 阻塞等待恢复），图标切换为静态暂停态 */
  isPaused?: boolean;
  isCompleted?: boolean;
  subAgentConversations?: ChatConversationRecord[];
  /** 子代理中待用户确认（提问/工具授权）的会话 id 集合 */
  subAgentAttentionRequiredIds?: Set<string>;
  isSubAgentExpanded?: boolean;
  isMultiSelectMode?: boolean;
  isSelected?: boolean;
  /** 允许作为拖拽源（拖到置顶区/普通列表区切换置顶状态） */
  isDraggable?: boolean;
  onPin: () => void;
  onRename: (newTitle: string) => Promise<void>;
  onSetEmoji: (emoji: string) => Promise<void>;
  /** 确认删除；deleteImages=true 表示同时级联删除图库图片 */
  onDelete: (deleteImages: boolean) => void;
  onExport: (format: ExportFormat) => void;
  /** 创建分支会话（复制整个会话到新的分支） */
  onFork?: () => void;
  /** 归档会话（置顶会话不传入，不提供归档入口） */
  onArchive?: () => void;
  /** 归档进行中（含 VACUUM 收缩文件阶段）：菜单按钮显示 loading，防止重复操作 */
  isArchiving?: boolean;
  /** 删除进行中（含 VACUUM 收缩文件阶段）：菜单按钮显示 loading，防止重复操作 */
  isDeleting?: boolean;
  onEnterMultiSelect?: () => void;
  onToggleSelect?: () => void;
  onSelect?: () => void;
  onToggleSubAgentPanel?: () => void;
};

export function ChatItem({
  conversation,
  isActive = false,
  isAttentionRequired = false,
  isStreaming = false,
  isPaused = false,
  isCompleted = false,
  subAgentConversations = [],
  subAgentAttentionRequiredIds = new Set<string>(),
  isSubAgentExpanded = false,
  isMultiSelectMode = false,
  isSelected = false,
  isDraggable = false,
  onPin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
  onFork,
  onArchive,
  isArchiving = false,
  isDeleting = false,
  onEnterMultiSelect,
  onToggleSelect,
  onSelect,
  onToggleSubAgentPanel,
}: ChatItemProps): React.JSX.Element {
  const { t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [editingValue, setEditingValue] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);
  const cancelledRef = useRef(false);
  const [isDragSource, setIsDragSource] = useState(false);

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  const hasSubAgents = subAgentConversations.length > 0;

  const handleRenameStart = (): void => {
    setEditingValue(conversation.summary || conversation.title || "");
    isSubmittingRef.current = false;
    cancelledRef.current = false;
    setIsEditing(true);
  };

  const handleRenameSubmit = async (): Promise<void> => {
    if (isSubmittingRef.current || cancelledRef.current) {
      return;
    }
    isSubmittingRef.current = true;

    const trimmed = editingValue.trim();
    const original = conversation.summary || conversation.title || "";

    if (!trimmed) {
      setEditingValue(original);
      setIsEditing(false);
      isSubmittingRef.current = false;
      return;
    }

    if (trimmed === original) {
      setIsEditing(false);
      isSubmittingRef.current = false;
      return;
    }

    try {
      await onRename(trimmed);
    } finally {
      setIsEditing(false);
      isSubmittingRef.current = false;
    }
  };

  const handleRenameCancel = (): void => {
    cancelledRef.current = true;
    setIsEditing(false);
  };

  const handleRenameKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    // 输入法组合输入中（如中文候选区上屏的 Enter）不触发保存/取消
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void handleRenameSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleRenameCancel();
    }
  };

  const isPinned = conversation.status === "pin";
  // 运行中的会话（流式输出中或等待输入）不提供操作菜单，
  // 避免运行中的会话被删除造成数据混乱；子代理待确认同样暂停了整体流程
  const hasAttentionRequiredSubAgent = subAgentConversations.some((sub) =>
    subAgentAttentionRequiredIds.has(sub.conversationId),
  );
  const isRunning =
    isStreaming || isAttentionRequired || hasAttentionRequiredSubAgent;
  const isForked = conversation.forkedFromConversationId !== "";
  const hasEmoji = conversation.emoji.trim() !== "";
  const displayName =
    conversation.summary ||
    conversation.title ||
    t("sidebar.untitledChat", { defaultValue: "Untitled" });
  const showAttentionStatus =
    !isMultiSelectMode && (isAttentionRequired || hasAttentionRequiredSubAgent);
  const showStreamingStatus =
    !isMultiSelectMode && !showAttentionStatus && isStreaming;
  const showCompletedStatus =
    !isMultiSelectMode &&
    !showAttentionStatus &&
    !showStreamingStatus &&
    isCompleted;
  const showDefaultIcon =
    !showAttentionStatus && !showStreamingStatus && !showCompletedStatus;
  const statusLabel = showAttentionStatus
    ? t("sidebar.chatStatusNeedsAction", { defaultValue: "Needs action" })
    : showCompletedStatus
      ? t("sidebar.chatStatusCompleted", { defaultValue: "Completed" })
      : null;
  const statusDescription = showAttentionStatus
    ? t("sidebar.chatStatusWaitingForReviewOrInput", {
        defaultValue: "Waiting for review or input",
      })
    : (statusLabel ?? "");

  const now = new Date();
  const parsedDate = parseDbTimestamp(conversation.updatedAt);
  const rawTimeLabel = formatTimeLabel(parsedDate, now, t);
  const timeLabel =
    rawTimeLabel === "yesterday"
      ? t("sidebar.chatTimeYesterday", { defaultValue: "Yesterday" })
      : rawTimeLabel;

  const handleSelectClick = (): void => {
    if (isEditing) {
      return;
    }
    if (isMultiSelectMode) {
      onToggleSelect?.();
      return;
    }
    onSelect?.();
  };

  // 右键 == 三点按钮菜单：在光标位置弹出同一份操作菜单
  const handleContextMenu = (event: React.MouseEvent): void => {
    // 编辑/多选/运行中模式下不拦截右键，保留系统菜单（输入框复制粘贴等）
    if (isEditing || isMultiSelectMode || isRunning) {
      return;
    }
    event.preventDefault();
    setContextMenuAnchor({ x: event.clientX, y: event.clientY });
  };

  // ===== 会话拖拽源（双协议）：拖到聊天输入框 = 注入为目标会话的开头上下文；
  // 拖到置顶区/普通列表区 = 切换置顶状态（上游 chatDrag 协议）=====
  // 编辑/多选/运行中的会话不可拖拽，避免与重命名、勾选及运行状态冲突
  //（isDraggable 由调用方控制：PENDING 会话等不作为拖拽源）
  const canDrag = isDraggable && !isEditing && !isMultiSelectMode && !isRunning;

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!canDrag) {
      event.preventDefault();
      return;
    }
    // 同时写入两种 MIME 协议，两个 drop 端（输入框 / 列表区）都能识别；
    // copyMove 同时兼容输入框的 copy 和侧边栏分组的 move。
    const payload: ConversationDragPayload = {
      conversationId: conversation.conversationId,
      directoryId: conversation.directoryId,
      title: displayName,
      emoji: conversation.emoji,
    };
    beginConversationDrag(event.dataTransfer, payload);
    setChatDragData(event, {
      conversationId: conversation.conversationId,
      status: conversation.status,
    });
    setIsDragSource(true);
  };

  const handleDragEnd = (): void => {
    endConversationDrag();
    setIsDragSource(false);
  };

  const handleToggleExpand = (event: React.MouseEvent): void => {
    event.stopPropagation();
    onToggleSubAgentPanel?.();
  };

  const attentionRequiredSubAgentCount = subAgentConversations.filter((sub) =>
    subAgentAttentionRequiredIds.has(sub.conversationId),
  ).length;
  const runningSubAgentCount = subAgentConversations.filter(
    (sub) =>
      sub.subAgentStatus === "running" &&
      !subAgentAttentionRequiredIds.has(sub.conversationId),
  ).length;

  return (
    <div
      className={`chat-item${isMenuOpen ? " menu-open" : ""}${
        isActive ? " active" : ""
      }${isMultiSelectMode ? " multi-select" : ""}${
        isSelected ? " selected" : ""
      }${isDragSource ? " dragging" : ""}`}
      key={conversation.conversationId}
      draggable={canDrag}
      onDragStart={canDrag ? handleDragStart : undefined}
      onDragEnd={handleDragEnd}
      onClick={handleSelectClick}
      onContextMenu={handleContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (isEditing) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (isMultiSelectMode) {
            onToggleSelect?.();
          } else if (onSelect) {
            onSelect();
          }
        }
      }}
    >
      {isMultiSelectMode ? (
        <span
          className={`chat-item-checkbox${isSelected ? " checked" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect?.();
          }}
          role="checkbox"
          aria-checked={isSelected}
          tabIndex={-1}
        >
          {isSelected ? <Check size={12} strokeWidth={3} /> : null}
        </span>
      ) : (
        <span
          className={`chat-item-icon${
            showAttentionStatus
              ? " attention-required"
              : showStreamingStatus
                ? isPaused
                  ? " streaming paused"
                  : " streaming"
                : showCompletedStatus
                  ? " completed"
                  : ""
          }${showDefaultIcon && isForked ? " forked" : ""}${
            showDefaultIcon && hasSubAgents ? " has-sub-agents" : ""
          }${showDefaultIcon && hasEmoji ? " has-emoji" : ""}`}
          onClick={(event) => {
            // 图标不再承载交互，点击仅阻止选中会话；修改入口在右键菜单中
            event.stopPropagation();
          }}
        >
          {showAttentionStatus ? (
            <CircleAlert size={12} aria-hidden="true" />
          ) : showStreamingStatus ? (
            isPaused ? (
              <Pause size={11} aria-hidden="true" />
            ) : (
              <Loader2 size={11} className="spin" aria-hidden="true" />
            )
          ) : showCompletedStatus ? (
            <CheckCircle2 size={12} aria-hidden="true" />
          ) : hasEmoji ? (
            <span className="chat-item-emoji">{conversation.emoji}</span>
          ) : isForked ? (
            <GitFork size={11} />
          ) : (
            <MessageSquareMore size={11} />
          )}
        </span>
      )}
      <div className="chat-item-content">
        {isEditing ? (
          <input
            ref={editInputRef}
            className="chat-item-rename-input"
            type="text"
            value={editingValue}
            onChange={(event) => setEditingValue(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => void handleRenameSubmit()}
            placeholder={t("sidebar.chatRenamePlaceholder", {
              defaultValue: "Enter new name",
            })}
          />
        ) : (
          <>
            <div className="chat-item-title-row">
              {hasSubAgents && (
                <span
                  className="chat-item-expand-toggle"
                  onClick={handleToggleExpand}
                  role="button"
                  tabIndex={-1}
                >
                  <ChevronRight
                    size={12}
                    className={isSubAgentExpanded ? "expanded" : ""}
                  />
                </span>
              )}
              <span
                className="chat-item-title"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  handleRenameStart();
                }}
              >
                {displayName}
              </span>
              {statusLabel && (
                <span
                  className={`chat-item-status-label ${
                    showAttentionStatus ? "attention-required" : "completed"
                  }`}
                  title={statusDescription}
                  aria-label={statusDescription}
                >
                  {statusLabel}
                </span>
              )}
              {hasSubAgents && runningSubAgentCount > 0 && (
                <span className="chat-item-sub-agent-count">
                  {runningSubAgentCount}
                </span>
              )}
              {hasSubAgents && attentionRequiredSubAgentCount > 0 && (
                <span
                  className="chat-item-sub-agent-count attention"
                  title={statusDescription}
                  aria-label={statusDescription}
                >
                  {attentionRequiredSubAgentCount}
                </span>
              )}
              <span className="chat-item-time">{timeLabel}</span>
            </div>
          </>
        )}
      </div>
      {!isEditing && !isMultiSelectMode && !isRunning && (
        <span
          className="chat-item-menu-wrapper"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {isArchiving ? (
            <Loader2
              size={14}
              className="spin"
              aria-label={t("sidebar.chatActionArchiving", {
                defaultValue: "Archiving...",
              })}
            />
          ) : (
            <ChatItemMenu
              conversationId={conversation.conversationId}
              isPinned={isPinned}
              emoji={conversation.emoji}
              onPin={onPin}
              onRename={handleRenameStart}
              onSetEmoji={onSetEmoji}
              onDelete={onDelete}
              isDeleting={isDeleting}
              onExport={onExport}
              onFork={onFork}
              onArchive={onArchive}
              onEnterMultiSelect={onEnterMultiSelect}
              onOpenChange={setIsMenuOpen}
              contextMenuAnchor={contextMenuAnchor}
              onContextMenuClose={() => setContextMenuAnchor(null)}
            />
          )}
        </span>
      )}
    </div>
  );
}
