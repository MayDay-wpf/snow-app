/**
 * 会话上下文附件「消息流开头折叠块」：显示当前会话附带的 N 个历史会话，
 * 展开后加载注入预览文本（与真实注入共用 Rust 渲染函数，所见即所得）。
 */

import { ChevronRight, History } from "lucide-react";
import { useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import { useConversationContextAttachments } from "./useConversationContextAttachments";

type ConversationContextFoldProps = {
  conversationId: string | null;
};

export const ConversationContextFold = ({
  conversationId,
}: ConversationContextFoldProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const { attachments } = useConversationContextAttachments(conversationId);
  const [expanded, setExpanded] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);

  useEffect(() => {
    if (!expanded || !conversationId || attachments.length === 0) {
      return;
    }
    let cancelled = false;
    setIsLoadingPreviews(true);
    void (async () => {
      const next: Record<string, string> = {};
      for (const attachment of attachments) {
        try {
          next[attachment.sourceConversationId] =
            await window.snow.renderAttachmentContext(
              attachment.sourceConversationId
            );
        } catch (error) {
          console.warn(
            "[conversation-context] render preview failed",
            error
          );
        }
      }
      if (!cancelled) {
        setPreviews(next);
        setIsLoadingPreviews(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, conversationId, attachments]);

  if (!conversationId || attachments.length === 0) {
    return null;
  }

  const foldLabel = t("conversationContext.foldLabel", {
    values: { count: attachments.length },
    defaultValue: "附带的 {{count}} 个历史会话",
  });

  return (
    <div className="conversation-context-fold">
      <button
        type="button"
        className="conversation-context-fold-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <History size={12} aria-hidden="true" />
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={expanded ? "expanded" : ""}
        />
        <span>{foldLabel}</span>
      </button>
      {expanded ? (
        <div className="conversation-context-fold-body">
          {isLoadingPreviews ? (
            <span className="conversation-context-fold-loading">
              {t("conversationContext.foldLoading", {
                defaultValue: "加载中…",
              })}
            </span>
          ) : (
            attachments.map((attachment) => {
              const title =
                attachment.title.trim() ||
                t("sidebar.untitledChat", { defaultValue: "Untitled" });
              const preview = previews[attachment.sourceConversationId] ?? "";
              return (
                <div
                  key={attachment.sourceConversationId}
                  className="conversation-context-fold-item"
                >
                  <div className="conversation-context-fold-item-title">
                    {attachment.emoji ? (
                      <span className="conversation-context-fold-item-emoji">
                        {attachment.emoji}
                      </span>
                    ) : null}
                    <span>{title}</span>
                  </div>
                  <pre className="conversation-context-fold-item-preview">
                    {preview || "…"}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
};
