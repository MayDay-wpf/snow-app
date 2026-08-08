import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";

type SensitiveCommandMatch = {
  commandId: string;
  pattern: string;
  description: string;
};

type SensitiveCommandConfirmDialogProps = {
  toolCalls: ToolCallInfo[];
  onApprove: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean
  ) => void;
};

const COMMAND_TOOL_NAMES = new Set([
  "bash-terminal-execute",
  "remote-job-start",
]);

const parseBashArgument = (
  toolCall: ToolCallInfo,
  key: "command" | "description"
): string | null => {
  if (!COMMAND_TOOL_NAMES.has(toolCall.name)) {
    return null;
  }

  try {
    const parsed = JSON.parse(toolCall.arguments || "{}") as Record<
      string,
      unknown
    >;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed[key] === "string"
    ) {
      return parsed[key] as string;
    }
  } catch {
    // fall through
  }

  return null;
};

const SensitiveCommandItem = ({
  toolCall,
  matches,
  isSubmitting,
  onApprove,
  onReject,
}: {
  toolCall: ToolCallInfo;
  matches: SensitiveCommandMatch[];
  isSubmitting: boolean;
  onApprove: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean
  ) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [rejectionReason, setRejectionReason] = useState("");
  const command =
    parseBashArgument(toolCall, "command") ?? toolCall.arguments ?? "";
  const description = parseBashArgument(toolCall, "description");

  return (
    <article className="tool-authorization-prompt-item sensitive-command-item">
      <div className="tool-authorization-tool-row">
        <span className="tool-authorization-tool-label">
          {t("toolAuthorization.toolName")}
        </span>
        <code className="tool-authorization-tool-name">{toolCall.name}</code>
      </div>

      <div className="tool-authorization-args">
        {description ? (
          <div className="sensitive-command-description">
            <span className="tool-authorization-tool-label">
              {t("sensitiveCommand.description")}
            </span>
            <p>{description}</p>
          </div>
        ) : null}

        <span className="tool-authorization-tool-label">
          {t("sensitiveCommand.command")}
        </span>
        <pre className="sensitive-command-command-pre">
          <span className="tool-call-bash-prompt" aria-hidden="true">
            $
          </span>
          <code>{command}</code>
        </pre>
      </div>

      <div className="sensitive-command-matches">
        <span className="tool-authorization-tool-label">
          {t("sensitiveCommand.matchedRules")}
        </span>
        <ul className="sensitive-command-match-list">
          {matches.map((match) => (
            <li key={match.commandId} className="sensitive-command-match-entry">
              <code className="sensitive-command-match-pattern">
                {match.pattern}
              </code>
              {match.description ? (
                <span className="sensitive-command-match-desc">
                  {match.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <label className="tool-authorization-rejection-reason">
        <span className="tool-authorization-tool-label">
          {t("toolAuthorization.rejectionReason")}
        </span>
        <textarea
          disabled={isSubmitting}
          onChange={(event) => setRejectionReason(event.target.value)}
          placeholder={t("toolAuthorization.rejectionReasonPlaceholder")}
          rows={2}
          value={rejectionReason}
        />
      </label>

      <div className="tool-authorization-actions">
        <button
          className="tool-authorization-action tool-authorization-reject"
          disabled={isSubmitting}
          onClick={() => {
            const trimmedReason = rejectionReason.trim();
            onReject(
              toolCall,
              trimmedReason ||
                t("toolAuthorization.defaultRejectionReason"),
              trimmedReason.length > 0
            );
          }}
          type="button"
        >
          {t("toolAuthorization.reject")}
        </button>
        <button
          className="tool-authorization-action tool-authorization-approve"
          disabled={isSubmitting}
          onClick={() => onApprove(toolCall)}
          type="button"
        >
          {t("sensitiveCommand.confirmExecution")}
        </button>
      </div>
    </article>
  );
};

export const SensitiveCommandConfirmDialog = ({
  toolCalls,
  onApprove,
  onReject,
}: SensitiveCommandConfirmDialogProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <section
      className="tool-authorization-prompt sensitive-command-prompt"
      aria-label={t("sensitiveCommand.title")}
    >
      <div className="tool-authorization-prompt-heading">
        <span className="tool-authorization-prompt-icon" aria-hidden="true">
          <ShieldAlert size={14} />
        </span>
        <div className="tool-authorization-prompt-copy">
          <strong>{t("sensitiveCommand.title")}</strong>
          <p>{t("sensitiveCommand.message")}</p>
        </div>
      </div>
      <div className="tool-authorization-prompt-list">
        {toolCalls.map((toolCall) => {
          const id =
            toolCall.authorizationId ??
            `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`;
          const matches: SensitiveCommandMatch[] = (
            toolCall.sensitiveCommandMatches ?? []
          ).map((match) => ({
            commandId: match.commandId,
            pattern: match.pattern,
            description: match.description,
          }));

          return (
            <SensitiveCommandItem
              key={id}
              toolCall={toolCall}
              matches={matches}
              isSubmitting={submittingId === id}
              onApprove={(item) => {
                setSubmittingId(id);
                onApprove(item);
              }}
              onReject={(item, reason, userProvidedReason) => {
                setSubmittingId(id);
                onReject(item, reason, userProvidedReason);
              }}
            />
          );
        })}
      </div>
    </section>
  );
};
