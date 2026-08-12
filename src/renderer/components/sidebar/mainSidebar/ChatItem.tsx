import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  GitFork,
  Loader2,
  MessageSquareMore,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { ChatItemMenu, type ExportFormat } from "./ChatItemMenu";
import {
  CONVERSATION_DRAG_MIME,
  conversationContextEvents,
  readConversationDragPayload,
  type ConversationDragPayload,
} from "./conversationContextEvents";
import { formatTimeLabel, parseDbTimestamp } from "./chatTimeGroup";

type ChatItemProps = {
  conversation: ChatConversationRecord;
  isActive?: boolean;
  isAttentionRequired?: boolean;
  isStreaming?: boolean;
  isCompleted?: boolean;
  subAgentConversations?: ChatConversationRecord[];
  /** 子代理中待用户确认（提问/工具授权）的会话 id 集合 */
  subAgentAttentionRequiredIds?: Set<string>;
  isSubAgentExpanded?: boolean;
  isMultiSelectMode?: boolean;
  isSelected?: boolean;
  onPin: () => void;
  onRename: (newTitle: string) => Promise<void>;
  onSetEmoji: (emoji: string) => Promise<void>;
  /** 确认删除；deleteImages=true 表示同时级联删除图库图片 */
  onDelete: (deleteImages: boolean) => void;
  onExport: (format: ExportFormat) => void;
  /** 归档会话（置顶会话不传入，不提供归档入口） */
  onArchive?: () => void;
  /** 归档进行中（含 VACUUM 收缩文件阶段）：菜单按钮显示 loading，防止重复操作 */
  isArchiving?: boolean;
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
  isCompleted = false,
  subAgentConversations = [],
  subAgentAttentionRequiredIds = new Set<string>(),
  isSubAgentExpanded = false,
  isMultiSelectMode = false,
  isSelected = false,
  onPin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
  onArchive,
  isArchiving = false,
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
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [dragFeedback, setDragFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    event: React.KeyboardEvent<HTMLInputElement>
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
  const hasAttentionRequiredSubAgent =
    subAgentConversations.some((sub) =>
      subAgentAttentionRequiredIds.has(sub.conversationId)
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
    : statusLabel ?? "";

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

  // ===== 会话拖拽：把本会话附加到另一会话开头作为上下文 =====
  const canDrag = !isEditing && !isMultiSelectMode && !isRunning;

  const showDragFeedback = (feedback: {
    type: "success" | "error";
    text: string;
  }): void => {
    setDragFeedback(feedback);
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = setTimeout(() => {
      setDragFeedback(null);
      feedbackTimerRef.current = null;
    }, 3000);
  };

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!canDrag) {
      event.preventDefault();
      return;
    }
    const payload: ConversationDragPayload = {
      conversationId: conversation.conversationId,
      directoryId: conversation.directoryId,
      title: displayName,
      emoji: conversation.emoji,
    };
    event.dataTransfer.setData(CONVERSATION_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
    setIsDragSource(true);
  };

  const handleDragEnd = (): void => {
    setIsDragSource(false);
    setIsDropTarget(false);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (isEditing || isMultiSelectMode || isRunning) {
      return;
    }
    const payload = readConversationDragPayload(event.dataTransfer);
    if (
      !payload ||
      payload.conversationId === conversation.conversationId ||
      payload.directoryId !== conversation.directoryId
    ) {
      // 跨项目 / 自引用 / 非会话拖拽：不 preventDefault → 显示禁止光标
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDropTarget(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    // 仅当离开当前元素（不含进入子元素）时清除；relatedTarget 为 null
    // 表示拖出窗口/列表边界，同样清除，避免 drop-target 样式残留
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDropTarget(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    setIsDropTarget(false);
    if (isEditing || isMultiSelectMode || isRunning) {
      return;
    }
    const payload = readConversationDragPayload(event.dataTransfer);
    if (
      !payload ||
      payload.conversationId === conversation.conversationId ||
      payload.directoryId !== conversation.directoryId
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      try {
        await window.snow.addContextAttachment(
          conversation.conversationId,
          payload.conversationId
        );
        conversationContextEvents.emit(
          "attachments-changed",
          conversation.conversationId
        );
        showDragFeedback({
          type: "success",
          text: t("conversationContext.attachSuccess", {
            defaultValue: "已附加为上下文",
          }),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        showDragFeedback({ type: "error", text: message });
      }
    })();
  };

  const handleToggleExpand = (event: React.MouseEvent): void => {
    event.stopPropagation();
    onToggleSubAgentPanel?.();
  };

  const attentionRequiredSubAgentCount = subAgentConversations.filter((sub) =>
    subAgentAttentionRequiredIds.has(sub.conversationId)
  ).length;
  const runningSubAgentCount = subAgentConversations.filter(
    (sub) =>
      sub.subAgentStatus === "running" &&
      !subAgentAttentionRequiredIds.has(sub.conversationId)
  ).length;

  return (
    <div
      className={`chat-item${isMenuOpen ? " menu-open" : ""}${
        isActive ? " active" : ""
      }${isMultiSelectMode ? " multi-select" : ""}${
        isSelected ? " selected" : ""
      }${isDragSource ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}
      key={conversation.conversationId}
      onClick={handleSelectClick}
      onContextMenu={handleContextMenu}
      draggable={canDrag}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
              ? " streaming"
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
            <Loader2 size={11} className="spin" aria-hidden="true" />
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
              onExport={onExport}
              onArchive={onArchive}
              onEnterMultiSelect={onEnterMultiSelect}
              onOpenChange={setIsMenuOpen}
              contextMenuAnchor={contextMenuAnchor}
              onContextMenuClose={() => setContextMenuAnchor(null)}
            />
          )}
        </span>
      )}
      {dragFeedback && (
        <span
          className={`chat-item-drag-feedback ${
            dragFeedback.type === "success" ? "success" : "error"
          }`}
          role="status"
          aria-live="polite"
        >
          {dragFeedback.type === "success" ? (
            <CheckCircle2 size={12} aria-hidden="true" />
          ) : (
            <XCircle size={12} aria-hidden="true" />
          )}
          <span className="chat-item-drag-feedback-text">
            {dragFeedback.text}
          </span>
        </span>
      )}
    </div>
  );
}
