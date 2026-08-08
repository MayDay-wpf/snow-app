import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  GitFork,
  Loader2,
  MessageSquareMore,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { ChatItemMenu, type ExportFormat } from "./ChatItemMenu";
import { formatTimeLabel, parseDbTimestamp } from "./chatTimeGroup";

type ChatItemProps = {
  conversation: ChatConversationRecord;
  isActive?: boolean;
  isAttentionRequired?: boolean;
  isStreaming?: boolean;
  isCompleted?: boolean;
  subAgentConversations?: ChatConversationRecord[];
  isSubAgentExpanded?: boolean;
  isMultiSelectMode?: boolean;
  isSelected?: boolean;
  onPin: () => void;
  onRename: (newTitle: string) => Promise<void>;
  onSetEmoji: (emoji: string) => Promise<void>;
  /** 确认删除；deleteImages=true 表示同时级联删除图库图片 */
  onDelete: (deleteImages: boolean) => void;
  onExport: (format: ExportFormat) => void;
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
  isSubAgentExpanded = false,
  isMultiSelectMode = false,
  isSelected = false,
  onPin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
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
  const isForked = conversation.forkedFromConversationId !== "";
  const hasEmoji = conversation.emoji.trim() !== "";
  const displayName =
    conversation.summary ||
    conversation.title ||
    t("sidebar.untitledChat", { defaultValue: "Untitled" });
  const showAttentionStatus = !isMultiSelectMode && isAttentionRequired;
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
    // 编辑/多选模式下不拦截右键，保留系统菜单（输入框复制粘贴等）
    if (isEditing || isMultiSelectMode) {
      return;
    }
    event.preventDefault();
    setContextMenuAnchor({ x: event.clientX, y: event.clientY });
  };

  const handleToggleExpand = (event: React.MouseEvent): void => {
    event.stopPropagation();
    onToggleSubAgentPanel?.();
  };

  const runningSubAgentCount = subAgentConversations.filter(
    (sub) => sub.subAgentStatus === "running"
  ).length;

  return (
    <div
      className={`chat-item${isMenuOpen ? " menu-open" : ""}${
        isActive ? " active" : ""
      }${isMultiSelectMode ? " multi-select" : ""}${
        isSelected ? " selected" : ""
      }`}
      key={conversation.conversationId}
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
              <span className="chat-item-time">{timeLabel}</span>
            </div>
          </>
        )}
      </div>
      {!isEditing && !isMultiSelectMode && (
        <span
          className="chat-item-menu-wrapper"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ChatItemMenu
            conversationId={conversation.conversationId}
            isPinned={isPinned}
            emoji={conversation.emoji}
            onPin={onPin}
            onRename={handleRenameStart}
            onSetEmoji={onSetEmoji}
            onDelete={onDelete}
            onExport={onExport}
            onEnterMultiSelect={onEnterMultiSelect}
            onOpenChange={setIsMenuOpen}
            contextMenuAnchor={contextMenuAnchor}
            onContextMenuClose={() => setContextMenuAnchor(null)}
          />
        </span>
      )}
    </div>
  );
}
