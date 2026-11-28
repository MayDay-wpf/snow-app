import { ArchiveRestore, Check, Loader2, Trash2 } from "lucide-react";

import { useI18n } from "../../../i18n";
import type { ChatConversationRecord } from "../../../../preload";
import { formatTimeLabel, parseDbTimestamp } from "./chatTimeGroup";

type ArchivedChatItemProps = {
  conversation: ChatConversationRecord;
  isMultiSelectMode?: boolean;
  isSelected?: boolean;
  /** 还原进行中（含 VACUUM 收缩归档库阶段）：禁用操作并显示 loading */
  isRestoring?: boolean;
  /** 永久删除进行中（含 VACUUM 收缩归档库阶段）：禁用操作并显示 loading */
  isDeleting?: boolean;
  onToggleSelect?: () => void;
  /** 还原归档会话回运行库 */
  onRestore: () => void;
  /** 永久删除归档会话 */
  onDelete: () => void;
};

/**
 * 归档会话条目：归档会话不允许直接打开使用，必须还原后才能继续对话，
 * 因此点击条目本身不触发任何会话打开操作，仅提供「还原 / 删除」操作。
 */
export function ArchivedChatItem({
  conversation,
  isMultiSelectMode = false,
  isSelected = false,
  isRestoring = false,
  isDeleting = false,
  onToggleSelect,
  onRestore,
  onDelete,
}: ArchivedChatItemProps): React.JSX.Element {
  const { t } = useI18n();

  const displayName =
    conversation.summary ||
    conversation.title ||
    t("sidebar.untitledChat", { defaultValue: "Untitled" });

  const now = new Date();
  const parsedDate = parseDbTimestamp(conversation.updatedAt);
  const rawTimeLabel = formatTimeLabel(parsedDate, now, t);
  const timeLabel =
    rawTimeLabel === "yesterday"
      ? t("sidebar.chatTimeYesterday", { defaultValue: "Yesterday" })
      : rawTimeLabel;

  const handleClick = (): void => {
    if (isRestoring || isDeleting) {
      return;
    }
    if (isMultiSelectMode) {
      onToggleSelect?.();
    }
    // 非多选模式：归档会话不可直接使用，点击不打开会话
  };

  return (
    <div
      className={`chat-item archived${
        isMultiSelectMode ? " multi-select" : ""
      }${isSelected ? " selected" : ""}`}
      key={conversation.conversationId}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleClick();
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
      ) : null}
      <div className="chat-item-content">
        <div className="chat-item-title-row">
          <span className="chat-item-title">
            <span className="chat-item-title-text">{displayName}</span>
          </span>
          <span className="chat-item-time">{timeLabel}</span>
        </div>
      </div>
      {!isMultiSelectMode && (
        <span className="archived-chat-item-actions">
          <button
            type="button"
            className="archived-chat-item-action"
            onClick={(event) => {
              event.stopPropagation();
              onRestore();
            }}
            disabled={isRestoring || isDeleting}
            title={t("sidebar.chatActionRestore", {
              defaultValue: "Restore",
            })}
            aria-label={t("sidebar.chatActionRestore", {
              defaultValue: "Restore",
            })}
          >
            {isRestoring ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <ArchiveRestore size={13} />
            )}
          </button>
          <button
            type="button"
            className="archived-chat-item-action danger"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            disabled={isRestoring || isDeleting}
            title={t("sidebar.chatActionDelete", { defaultValue: "Delete" })}
            aria-label={t("sidebar.chatActionDelete", {
              defaultValue: "Delete",
            })}
          >
            {isDeleting ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Trash2 size={13} />
            )}
          </button>
        </span>
      )}
    </div>
  );
}
