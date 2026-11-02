import { Eye, FileCode, GitFork } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { Tooltip } from "../../../common/Tooltip";
import { MessageCopyButton } from "./MessageCopyButton";

export type AiResponseActionsProps = {
  content: string;
  conversationId: string;
  responseId?: string;
  showRawMarkdown: boolean;
  onToggleRawMarkdown: () => void;
  onFork: (conversationId: string, upToResponseId: string) => void;
};

export const AiResponseActions = ({
  content,
  conversationId,
  responseId,
  showRawMarkdown,
  onToggleRawMarkdown,
  onFork,
}: AiResponseActionsProps): React.JSX.Element => {
  const { t } = useI18n();

  const handleFork = (): void => {
    onFork(conversationId, responseId ?? "");
  };

  return (
    <div
      className="ai-response-actions"
      aria-label={t("chat.aiResponseActions", {
        defaultValue: "AI response actions",
      })}
    >
      <Tooltip
        content={
          showRawMarkdown
            ? t("chat.showRenderedView", { defaultValue: "Show rendered view" })
            : t("chat.showRawMarkdown", { defaultValue: "Show raw Markdown" })
        }
      >
        <button
          className={`ai-response-action-btn${showRawMarkdown ? " is-open" : ""}`}
          type="button"
          aria-label={
            showRawMarkdown
              ? t("chat.showRenderedView", {
                  defaultValue: "Show rendered view",
                })
              : t("chat.showRawMarkdown", { defaultValue: "Show raw Markdown" })
          }
          aria-pressed={showRawMarkdown}
          onClick={onToggleRawMarkdown}
        >
          {showRawMarkdown ? (
            <Eye size={15} strokeWidth={1.8} />
          ) : (
            <FileCode size={15} strokeWidth={1.8} />
          )}
        </button>
      </Tooltip>
      <Tooltip content={t("chat.copyResponse", { defaultValue: "Copy" })}>
        <MessageCopyButton
          content={content}
          className="ai-response-action-btn"
        />
      </Tooltip>
      <Tooltip content={t("chat.forkConversation", { defaultValue: "Fork" })}>
        <button
          className="ai-response-action-btn"
          type="button"
          aria-label={t("chat.forkConversation", { defaultValue: "Fork" })}
          onClick={handleFork}
        >
          <GitFork size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <div className="snow-client-slot" data-snow-slot="chat.message.actions" />
    </div>
  );
};
