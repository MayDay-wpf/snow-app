import {
  AlertTriangle,
  FileWarning,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { keyToDisplay } from "../../../../utils/shortcutUtils";
import { isEditableContentEmpty } from "../../chatInput/fileTagUtils";
import { RichContentInput } from "../../chatInput/RichContentInput";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { SensitiveCommandSeverityBadge } from "./shared/SensitiveCommandSeverityBadge";
import { SensitiveCommandContextNote } from "./shared/SensitiveCommandContextNote";

type SensitiveCommandMatch = {
  commandId: string;
  pattern: string;
  description: string;
  /** 规则在命令文本中的命中区间（UTF-16 偏移，由 Rust 匹配时给出）。 */
  ranges: Array<{ start: number; end: number }>;
};

/** 命令文本切片：labels 非空表示该片段命中了敏感规则（值为命中规则的说明）。 */
type CommandSegment = {
  text: string;
  labels: string[];
};

/**
 * 按各规则的命中区间把命令切成普通片段与高亮片段。多条规则的区间可能重叠，
 * 以所有区间端点为切分点，每个最小片段记录覆盖它的规则；相邻且命中规则相同的
 * 片段再合并，避免产生多余节点。
 */
const buildCommandSegments = (
  command: string,
  matches: SensitiveCommandMatch[],
): CommandSegment[] => {
  const length = command.length;
  const marks = matches.flatMap((match) =>
    match.ranges
      .map((range) => ({
        start: Math.max(0, Math.min(range.start, length)),
        end: Math.max(0, Math.min(range.end, length)),
        label: match.description || match.pattern,
      }))
      .filter((mark) => mark.end > mark.start),
  );
  if (marks.length === 0) {
    return [{ text: command, labels: [] }];
  }

  const points = Array.from(
    new Set([0, length, ...marks.flatMap((mark) => [mark.start, mark.end])]),
  ).sort((a, b) => a - b);

  const segments: CommandSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const labels = Array.from(
      new Set(
        marks
          .filter((mark) => mark.start <= start && mark.end >= end)
          .map((mark) => mark.label),
      ),
    );
    const text = command.slice(start, end);
    const previous = segments[segments.length - 1];
    if (previous && previous.labels.join("\n") === labels.join("\n")) {
      previous.text += text;
    } else {
      segments.push({ text, labels });
    }
  }
  return segments;
};

type SensitiveCommandDecision = {
  allow: boolean;
  reason: string;
  confidence: number;
  /** 风险等级 key；为空时不显示徽标。 */
  severity?: string;
  severityScore?: number;
  modelName: string;
  /** 会话上下文使用情况（开关关闭时为空）。 */
  contextMessages?: number;
  contextTruncated?: boolean;
  contextEmpty?: boolean;
  /** 偏好学习附带的历史选择条数。 */
  preferenceRecords?: number;
  /** 决策模型不可用 / 请求失败的原因（此时判定无效，已回退人工确认）。 */
  error?: string;
};

type SensitiveCommandConfirmDialogProps = {
  toolCalls: ToolCallInfo[];
  onApprove: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
};
const COMMAND_TOOL_NAMES = new Set(["bash-terminal-execute"]);

/** 内置判定（检查出错、脚本无法检查、修改敏感规则）的规则 ID 前缀，与 Rust 守卫一致。 */
const BUILTIN_RULE_PREFIX = "snow:";

const parseBashArgument = (
  toolCall: ToolCallInfo,
  key: "command" | "description",
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
  decision,
  isDenyReview,
  isSubmitting,
  onApprove,
  onReject,
}: {
  toolCall: ToolCallInfo;
  matches: SensitiveCommandMatch[];
  decision?: SensitiveCommandDecision;
  /** 决策模型托管判定拒绝、转人工复核：用户确认执行即覆盖该判定。 */
  isDenyReview: boolean;
  isSubmitting: boolean;
  onApprove: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [rejectionReason, setRejectionReason] = useState("");
  // 展示的是 Rust 守卫算出的操作主体（授权令牌绑定的就是这段文本）。
  const operationKind = toolCall.sensitiveOperation?.kind ?? "command";
  const command =
    toolCall.sensitiveOperation?.subject ??
    parseBashArgument(toolCall, "command") ??
    toolCall.arguments ??
    "";
  const description = parseBashArgument(toolCall, "description");
  const subjectLabel =
    operationKind === "protected"
      ? t("sensitiveCommand.subject.protected")
      : operationKind === "config"
        ? t("sensitiveCommand.subject.config")
        : t("sensitiveCommand.command");
  const showShellPrompt = COMMAND_TOOL_NAMES.has(toolCall.name);
  // 命中的敏感关键字在命令里高亮，长命令中也能一眼定位危险操作。
  const commandSegments = useMemo(
    () => buildCommandSegments(command, matches),
    [command, matches],
  );
  // 拒绝理由是富文本：空态下 contenteditable 会残留换行符，需按编辑区口径判空，
  // 否则「未填写理由」会被当成用户理由（不再回落到默认理由）。
  const trimmedReason = isEditableContentEmpty(rejectionReason)
    ? ""
    : rejectionReason.trim();

  /** 拒绝：理由为空时回落到默认理由（与「拒绝」按钮一致）。 */
  const handleReject = (): void => {
    if (isSubmitting) {
      return;
    }
    onReject(
      toolCall,
      trimmedReason || t("toolAuthorization.defaultRejectionReason"),
      trimmedReason.length > 0,
    );
  };

  /**
   * 拒绝理由输入框的 Ctrl/Cmd + Enter：填写了理由才生效，等同「拒绝」按钮，
   * 免去移动鼠标。
   */
  const handleReasonKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (
      event.key !== "Enter" ||
      !(event.ctrlKey || event.metaKey) ||
      event.nativeEvent.isComposing ||
      !trimmedReason
    ) {
      return;
    }
    event.preventDefault();
    handleReject();
  };

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

        <span className="tool-authorization-tool-label">{subjectLabel}</span>
        {operationKind === "protected" ? (
          <p className="sensitive-command-description">
            {t("sensitiveCommand.subject.protectedNotice")}
          </p>
        ) : null}
        <pre className="sensitive-command-command-pre">
          {showShellPrompt ? (
            <span className="tool-call-bash-prompt" aria-hidden="true">
              $
            </span>
          ) : null}
          <code>
            {commandSegments.map((segment, index) =>
              segment.labels.length > 0 ? (
                <mark
                  key={index}
                  className="sensitive-command-keyword"
                  title={segment.labels.join("\n")}
                >
                  {segment.text}
                </mark>
              ) : (
                <Fragment key={index}>{segment.text}</Fragment>
              ),
            )}
          </code>
        </pre>
      </div>

      <div className="sensitive-command-matches">
        <span className="tool-authorization-tool-label">
          {operationKind === "protected"
            ? t("sensitiveCommand.triggerReason")
            : t("sensitiveCommand.matchedRules")}
        </span>
        <ul className="sensitive-command-match-list">
          {matches.map((match, matchIndex) => {
            const isBuiltin = match.commandId.startsWith(BUILTIN_RULE_PREFIX);
            return (
              <li
                key={`${match.commandId}-${matchIndex}`}
                className="sensitive-command-match-entry"
              >
                <code className="sensitive-command-match-pattern">
                  {isBuiltin
                    ? t(
                        `sensitiveCommand.builtinRule.${match.commandId.slice(
                          BUILTIN_RULE_PREFIX.length,
                        )}`,
                        { defaultValue: match.commandId },
                      )
                    : match.pattern}
                </code>
                {match.description ? (
                  <span className="sensitive-command-match-desc">
                    {match.description}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {decision?.error ? (
        <div className="sensitive-command-decision is-unavailable">
          <span className="tool-authorization-tool-label">
            {t("sensitiveCommand.decisionLabel")}
          </span>
          <div className="sensitive-command-decision-body">
            <span className="sensitive-command-decision-verdict">
              <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
              <strong>{t("sensitiveCommand.decisionUnavailable")}</strong>
            </span>
            <span className="sensitive-command-decision-reason">
              {decision.error}
            </span>
            {decision.modelName ? (
              <span className="sensitive-command-decision-model">
                {t("sensitiveCommand.decisionModel", {
                  values: { name: decision.modelName },
                })}
              </span>
            ) : null}
          </div>
        </div>
      ) : decision ? (
        <div
          className={`sensitive-command-decision ${
            decision.allow ? "is-allow" : "is-confirm"
          }${isDenyReview ? " is-override" : ""}`}
        >
          <span className="tool-authorization-tool-label">
            {t("sensitiveCommand.decisionLabel")}
          </span>
          <div className="sensitive-command-decision-body">
            <span className="sensitive-command-decision-verdict">
              {decision.allow ? (
                <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
              ) : (
                <ShieldAlert size={13} strokeWidth={2} aria-hidden="true" />
              )}
              <strong>
                {decision.allow
                  ? t("sensitiveCommand.decisionAllow")
                  : isDenyReview
                    ? t("sensitiveCommand.decisionDeny")
                    : t("sensitiveCommand.decisionConfirm")}
              </strong>
              {decision.confidence > 0 ? (
                <small>
                  {t("sensitiveCommand.decisionConfidence", {
                    values: { value: Math.round(decision.confidence * 100) },
                  })}
                </small>
              ) : null}
              <SensitiveCommandSeverityBadge
                severity={decision.severity}
                severityScore={decision.severityScore}
              />
            </span>
            <span className="sensitive-command-decision-reason">
              {t(`sensitiveCommand.decision.reason.${decision.reason}`, {
                defaultValue: decision.reason,
              })}
            </span>
            {decision.modelName ? (
              <span className="sensitive-command-decision-model">
                {t("sensitiveCommand.decisionModel", {
                  values: { name: decision.modelName },
                })}
              </span>
            ) : null}
            <SensitiveCommandContextNote
              decision={decision}
              className="sensitive-command-decision-model"
            />
            {isDenyReview ? (
              <span className="sensitive-command-decision-override">
                <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
                {t("sensitiveCommand.decisionOverrideNotice")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="tool-authorization-rejection-reason">
        <span className="tool-authorization-tool-label">
          {t("toolAuthorization.rejectionReason")}
        </span>
        <RichContentInput
          className="tool-authorization-rejection-input"
          disabled={isSubmitting}
          placeholder={t("toolAuthorization.rejectionReasonPlaceholder")}
          ariaLabel={t("toolAuthorization.rejectionReason")}
          onChange={setRejectionReason}
          onKeyDown={handleReasonKeyDown}
        />
        <span className="tool-authorization-rejection-hint">
          {t("toolAuthorization.rejectionShortcutHint", {
            values: { keys: keyToDisplay("mod+enter") },
          })}
        </span>
      </div>

      <div className="tool-authorization-actions">
        <button
          className="tool-authorization-action tool-authorization-reject"
          disabled={isSubmitting}
          onClick={handleReject}
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

/** 拦截类型：命令命中、写入可执行配置、修改敏感规则本身是三类不同的拦截。 */
type SensitiveOperationKind = "command" | "config" | "protected";

/** 同一批待授权项的类型一致时按该类型展示文案，混合时回落到通用文案。 */
const resolveHeaderKind = (
  toolCalls: ToolCallInfo[],
): SensitiveOperationKind | "mixed" => {
  const kinds = new Set<SensitiveOperationKind>(
    toolCalls.map((toolCall) => toolCall.sensitiveOperation?.kind ?? "command"),
  );
  const unique = Array.from(kinds);
  return unique.length === 1 ? unique[0] : "mixed";
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

  const headerKind = resolveHeaderKind(toolCalls);
  const headerTitle = t(`sensitiveCommand.title.${headerKind}`, {
    defaultValue: t("sensitiveCommand.title"),
  });
  const headerMessage = t(`sensitiveCommand.message.${headerKind}`, {
    defaultValue: t("sensitiveCommand.message"),
  });

  return (
    <section
      className="tool-authorization-prompt sensitive-command-prompt"
      aria-label={headerTitle}
    >
      <div className="tool-authorization-prompt-heading">
        <span className="tool-authorization-prompt-icon" aria-hidden="true">
          {headerKind === "protected" ? (
            <ShieldBan size={14} />
          ) : headerKind === "config" ? (
            <FileWarning size={14} />
          ) : (
            <ShieldAlert size={14} />
          )}
        </span>
        <div className="tool-authorization-prompt-copy">
          <strong>{headerTitle}</strong>
          <p>{headerMessage}</p>
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
            ranges: match.ranges ?? [],
          }));
          // 决策模型辅助的判定（未启用辅助 / 请求失败时为空，只显示规则命中）。
          const decision: SensitiveCommandDecision | undefined =
            toolCall.sensitiveCommandDecision;
          // 托管拒绝转人工复核（「拒绝时仍让我确认」）：待授权项带托管标记
          // 且判定为有效拒绝。按钮顺序与默认焦点保持不变，偏向安全。
          const isDenyReview = Boolean(
            toolCall.sensitiveCommandDelegated &&
            decision &&
            !decision.allow &&
            !decision.error,
          );

          return (
            <SensitiveCommandItem
              key={id}
              toolCall={toolCall}
              matches={matches}
              decision={decision}
              isDenyReview={isDenyReview}
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
