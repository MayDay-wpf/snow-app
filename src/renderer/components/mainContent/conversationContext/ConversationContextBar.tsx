/**
 * 会话上下文附件「顶部引用条」：显示当前会话挂载的历史会话，
 * 支持点击跳转到被附会话、× 逐个移除。
 */

import { Link2, X } from "lucide-react";

import { useI18n } from "../../../i18n";
import { conversationContextEvents } from "../../sidebar/mainSidebar/conversationContextEvents";
import { useConversationContextAttachments } from "./useConversationContextAttachments";

type ConversationContextBarProps = {
  conversationId: string | null;
  onOpenConversation: (conversationId: string) => void;
};

export const ConversationContextBar = ({
  conversationId,
  onOpenConversation,
}: ConversationContextBarProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const { attachments } = useConversationContextAttachments(conversationId);

  if (!conversationId || attachments.length === 0) {
    return null;
  }

  const handleRemove = async (sourceId: string): Promise<void> => {
    if (!conversationId) {
      return;
    }
    try {
      await window.snow.removeContextAttachment(conversationId, sourceId);
      conversationContextEvents.emit("attachments-changed", conversationId);
    } catch (error) {
      console.warn("[conversation-context] remove attachment failed", error);
    }
  };

  return (
    <div
      className="conversation-context-bar"
      role="region"
      aria-label={t("conversationContext.barLabel", {
        defaultValue: "附带的历史会话",
      })}
    >
      <span className="conversation-context-bar-label">
        <Link2 size={12} aria-hidden="true" />
        <span>
          {t("conversationContext.barLabel", {
            defaultValue: "附带的历史会话",
          })}
        </span>
      </span>
      {attachments.map((attachment) => {
        const title =
          attachment.title.trim() ||
          t("sidebar.untitledChat", { defaultValue: "Untitled" });
        return (
          <span
            key={attachment.sourceConversationId}
            className="conversation-context-chip"
          >
            <button
              type="button"
              className="conversation-context-chip-open"
              onClick={() => onOpenConversation(attachment.sourceConversationId)}
              title={title}
            >
              {attachment.emoji ? (
                <span className="conversation-context-chip-emoji">
                  {attachment.emoji}
                </span>
              ) : null}
              <span className="conversation-context-chip-title">{title}</span>
            </button>
            <button
              type="button"
              className="conversation-context-chip-remove"
              onClick={() => void handleRemove(attachment.sourceConversationId)}
              aria-label={t("conversationContext.removeAttachment", {
                defaultValue: "移除附带的会话",
              })}
              title={t("conversationContext.removeAttachment", {
                defaultValue: "移除附带的会话",
              })}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
};
