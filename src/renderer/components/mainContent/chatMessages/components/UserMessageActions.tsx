import { useState } from "react";
import { Check, Copy, Loader2, Pencil, Undo2 } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { writeBackToChatInput } from "../../chatInput/chatInputDraftBridge";
import { copyEncodedContentToClipboard } from "../../chatInput/fileTagUtils";
import { Tooltip } from "../../../common/Tooltip";
import { MessageTimestamp } from "./MessageTimestamp";
type UserMessageActionsProps = {
  content: string;
  timestamp?: string;
  isStreaming: boolean;
  canRollback?: boolean;
  isRollbackPreparing?: boolean;
  onRollback: () => void;
};

export const UserMessageActions = ({
  content,
  timestamp,
  isStreaming,
  canRollback = true,
  isRollbackPreparing,
  onRollback,
}: UserMessageActionsProps): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const [editWritten, setEditWritten] = useState(false);

  const handleCopy = (): void => {
    const markCopied = (): void => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    };
    // 用户消息含 chip 编码，带上 chips MIME 才能粘贴回输入框时还原 chips
    if (copyEncodedContentToClipboard(content)) {
      markCopied();
      return;
    }
    navigator.clipboard.writeText(content).then(markCopied);
  };

  const handleEdit = (): void => {
    const written = writeBackToChatInput(content);
    if (written) {
      setEditWritten(true);
      window.setTimeout(() => setEditWritten(false), 2000);
    }
  };

  return (
    <div
      className="user-message-actions"
      aria-label={t("chat.userMessageActions", {
        defaultValue: "User message actions",
      })}
    >
      <MessageTimestamp timestamp={timestamp} className="user-message-time" />
      <Tooltip content={t("chat.copyUserMessage", { defaultValue: "Copy" })}>
        <button
          className="user-message-action-btn"
          type="button"
          aria-label={t("chat.copyUserMessage", { defaultValue: "Copy" })}
          onClick={handleCopy}
        >
          {copied ? (
            <Check size={15} strokeWidth={1.8} />
          ) : (
            <Copy size={15} strokeWidth={1.8} />
          )}
        </button>
      </Tooltip>
      <Tooltip
        content={
          editWritten
            ? t("chat.writtenToInput", {
                defaultValue: "Written back to input",
              })
            : t("chat.editInInput", { defaultValue: "Edit in input box" })
        }
      >
        <button
          className="user-message-action-btn"
          type="button"
          aria-label={t("chat.editInInput", {
            defaultValue: "Edit in input box",
          })}
          onClick={handleEdit}
        >
          {editWritten ? (
            <Check size={15} strokeWidth={1.8} />
          ) : (
            <Pencil size={15} strokeWidth={1.8} />
          )}
        </button>
      </Tooltip>
      {canRollback && !isStreaming ? (
        <Tooltip
          content={
            isRollbackPreparing
              ? t("chat.rollbackCheckingChanges", {
                  defaultValue: "Checking file changes…",
                })
              : t("chat.rollbackToThisMessage", {
                  defaultValue: "Rollback to this message",
                })
          }
        >
          <button
            className="user-message-action-btn"
            type="button"
            aria-label={t("chat.rollbackToThisMessage", {
              defaultValue: "Rollback to this message",
            })}
            disabled={isRollbackPreparing}
            onClick={onRollback}
          >
            {isRollbackPreparing ? (
              <Loader2 size={15} strokeWidth={1.8} className="spin" />
            ) : (
              <Undo2 size={15} strokeWidth={1.8} />
            )}
          </button>
        </Tooltip>
      ) : null}
      <div className="snow-client-slot" data-snow-slot="chat.message.actions" />
    </div>
  );
};
