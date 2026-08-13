/**
 * 会话上下文附件「输入框上方提示条」(统一组件)。
 *
 * 空会话(新会话)与已有会话拖拽附加历史会话后,统一在此组件中展示
 * (均支持多个附件):
 * - 已有会话:显示已挂载的附件(数据库引用,可点击跳转源会话、× 移除),
 *   并异步显示每个附件的注入字符数(与注入共用 Rust 渲染函数,所见即所得);
 * - 空会话:显示待挂载的附件(pending,发送首条消息后由 useAgentLoop 自动
 *   挂载,可逐个取消),同样展示渲染字符数与"发送后生效"提示。
 *
 * 两套状态共用同一视觉风格,替代了原来的「消息流顶部引用条
 * (ConversationContextBar) + 输入框上方待附带条」两套组件。
 * 消息流开头的折叠预览块(ConversationContextFold)不受影响。
 */

import { Link2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import { conversationContextEvents } from "../../sidebar/mainSidebar/conversationContextEvents";
import type { ConversationDragPayload } from "../../sidebar/mainSidebar/conversationContextEvents";
import { useConversationContextAttachments } from "./useConversationContextAttachments";

type ConversationAttachmentBarProps = {
  /** 当前会话 ID;空会话(null)时仅展示 pending 附件 */
  conversationId: string | null;
  /** 空会话拖入的待挂载附件列表(发送首条消息后挂载) */
  pendingAttachments: ConversationDragPayload[];
  /** 各待挂载附件的渲染字符数(异步计算,未就绪缺省) */
  pendingCharsById: Record<string, number>;
  /** 取消一个待挂载附件 */
  onRemovePending: (conversationId: string) => void;
  /** 跳转到被附加的源会话 */
  onOpenConversation: (conversationId: string) => void;
};

export const ConversationAttachmentBar = ({
  conversationId,
  pendingAttachments,
  pendingCharsById,
  onRemovePending,
  onOpenConversation,
}: ConversationAttachmentBarProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const { attachments } = useConversationContextAttachments(conversationId);

  // 已挂载附件的注入字符数（与注入共用 renderAttachmentContext，所见即所得）。
  const [charsById, setCharsById] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    setCharsById({});
    for (const attachment of attachments) {
      void window.snow
        .renderAttachmentContext(attachment.sourceConversationId)
        .then((rendered) => {
          if (!cancelled) {
            setCharsById((prev) => ({
              ...prev,
              [attachment.sourceConversationId]: rendered.length,
            }));
          }
        })
        .catch(() => {
          // 渲染失败不展示字符数
        });
    }
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  const hasPending = pendingAttachments.length > 0 && !conversationId;
  if (attachments.length === 0 && !hasPending) {
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

  const renderChars = (conversationId: string): React.JSX.Element | null => {
    const chars = charsById[conversationId];
    if (chars === undefined) {
      return null;
    }
    return (
      <span className="conversation-attachment-chip-chars">
        {t("conversationContext.pendingAttachChars", {
          defaultValue: "约 {{count}} 字符",
          values: { count: chars.toLocaleString() },
        })}
      </span>
    );
  };

  return (
    <div
      className="conversation-attachment-bar"
      role="region"
      aria-label={t("conversationContext.barLabel", {
        defaultValue: "附带的历史会话",
      })}
    >
      <span className="conversation-attachment-bar-label">
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
            className="conversation-attachment-chip"
          >
            <button
              type="button"
              className="conversation-attachment-chip-open"
              onClick={() => onOpenConversation(attachment.sourceConversationId)}
              title={title}
            >
              {attachment.emoji ? (
                <span className="conversation-attachment-chip-emoji">
                  {attachment.emoji}
                </span>
              ) : null}
              <span className="conversation-attachment-chip-title">{title}</span>
            </button>
            {renderChars(attachment.sourceConversationId)}
            <button
              type="button"
              className="conversation-attachment-chip-remove"
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
      {hasPending
        ? pendingAttachments.map((pendingAttachment) => {
            const title =
              pendingAttachment.title ||
              t("sidebar.untitledChat", { defaultValue: "Untitled" });
            return (
              <span
                key={pendingAttachment.conversationId}
                className="conversation-attachment-chip is-pending"
              >
                {pendingAttachment.emoji ? (
                  <span className="conversation-attachment-chip-emoji">
                    {pendingAttachment.emoji}
                  </span>
                ) : null}
                <span className="conversation-attachment-chip-title">
                  {title}
                </span>
                {pendingCharsById[pendingAttachment.conversationId] !==
                undefined ? (
                  <span className="conversation-attachment-chip-chars">
                    {t("conversationContext.pendingAttachChars", {
                      defaultValue: "约 {{count}} 字符",
                      values: {
                        count: pendingCharsById[
                          pendingAttachment.conversationId
                        ].toLocaleString(),
                      },
                    })}
                  </span>
                ) : null}
                <span className="conversation-attachment-chip-hint">
                  {t("conversationContext.pendingAttachHint", {
                    defaultValue: "将作为开头上下文随首条消息发送",
                  })}
                </span>
                <button
                  type="button"
                  className="conversation-attachment-chip-remove"
                  onClick={() =>
                    onRemovePending(pendingAttachment.conversationId)
                  }
                  aria-label={t("conversationContext.pendingAttachRemove", {
                    defaultValue: "取消附带",
                  })}
                  title={t("conversationContext.pendingAttachRemove", {
                    defaultValue: "取消附带",
                  })}
                >
                  <X size={12} strokeWidth={2} aria-hidden="true" />
                </button>
              </span>
            );
          })
        : null}
    </div>
  );
};
