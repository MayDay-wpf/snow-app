import { useMemo } from "react";
import { AlertCircle, Circle, Loader2 } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { decodeEscapedNewlines } from "./shared/formatters";
import { localizeToolError } from "./shared/toolErrorDisplay";

type SkillToolCallProps = {
  toolCall: ToolCallInfo;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extract the skill id from the tool arguments (e.g. "pdf", "helloagents/analyze"). */
const parseSkillId = (args: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed) || typeof parsed.skill !== "string") {
      return undefined;
    }
    const skillId = parsed.skill.trim();
    return skillId.length > 0 ? skillId : undefined;
  } catch {
    return undefined;
  }
};

/** 技能根目录来源标记（与 Rust 侧 load_available_skills 的四个根目录对应）。 */
const SKILL_ROOTS = [".snow/skills", ".agents/skills"] as const;

type SkillInfo = {
  /** 结果里的 "Skill Name:"（缺省时用 <command-message> 里的名字）。 */
  name: string;
  /** 技能根目录来源：.snow/skills | .agents/skills（无法判定时为空）。 */
  location: string;
  /** 宿主在 <skill-info> 中提供的真实技能来源。 */
  source: string;
  /** 结果里的 "Absolute Path:"。 */
  path: string;
  /** <tool-restrictions> 里列出的允许工具。 */
  allowedTools: string[];
};

const SKILL_COMMAND_RE =
  /<command-message>The "(.+?)" skill is loading<\/command-message>/;
const SKILL_NAME_RE = /Skill Name:\s*(.+)/;
const SKILL_PATH_RE = /Absolute Path:\s*(.+)/;
const SKILL_INFO_RE = /<skill-info>([\s\S]*?)<\/skill-info>\s*$/;
const SKILL_SOURCE_RE = /^Skill Source:[ \t]*(.+)$/m;
const SKILL_RESTRICTIONS_RE =
  /<tool-restrictions>([\s\S]*?)<\/tool-restrictions>/;

/**
 * 技能执行结果是纯文本（Rust 侧 returns_plain_text，见 tools/call.rs）：
 *   <command-message>The "x" skill is loading</command-message>
 *   <技能正文><tool-restrictions>允许工具</tool-restrictions>
 *   <skill-info>Skill Name / Absolute Path / 目录结构</skill-info>
 */
const parseSkillInfo = (text: string): SkillInfo | null => {
  const metadata = SKILL_INFO_RE.exec(text)?.[1] ?? "";
  const source = SKILL_SOURCE_RE.exec(metadata)?.[1]?.trim() ?? "";
  const name =
    SKILL_NAME_RE.exec(text)?.[1]?.trim() ??
    SKILL_COMMAND_RE.exec(text)?.[1]?.trim() ??
    "";
  const path = SKILL_PATH_RE.exec(text)?.[1]?.trim() ?? "";
  // 分隔符归一后匹配技能根目录（Windows 反斜杠与 POSIX 斜杠同形）。
  const normalized = path.replace(/\\/g, "/");
  const location =
    SKILL_ROOTS.find(
      (candidate) =>
        normalized.includes(`/${candidate}/`) ||
        normalized.endsWith(`/${candidate}`),
    ) ?? "";
  const restrictions = SKILL_RESTRICTIONS_RE.exec(text)?.[1] ?? "";
  const allowedTools = restrictions
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== "");

  if (!name && !path) {
    return null;
  }
  return { name, location, source, path, allowedTools };
};

type ParsedSkillResult =
  | { type: "skill"; info: SkillInfo; text: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseSkillResult = (result: string | undefined): ParsedSkillResult => {
  if (!result) {
    return { type: "empty" };
  }

  let text = result;
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed === "string") {
      text = parsed;
    } else if (isRecord(parsed)) {
      if (typeof parsed.error === "string") {
        return { type: "error", message: parsed.error };
      }
      text = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // 非 JSON：结果为纯文本
  }

  text = decodeEscapedNewlines(text).trim();
  const info = parseSkillInfo(text);
  return info ? { type: "skill", info, text } : { type: "raw", text };
};

export const SkillToolCall = ({
  toolCall,
}: SkillToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const skillId = useMemo(
    () => parseSkillId(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsed = useMemo(
    () => parseSkillResult(toolCall.result),
    [toolCall.result],
  );

  const isRunning = toolCall.status === "running";
  const effectiveStatus = parsed.type === "error" ? "error" : toolCall.status;
  const info = parsed.type === "skill" ? parsed.info : null;
  const displayName = info?.name || skillId;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      sourcePluginId={
        info?.source.startsWith("plugin:")
          ? info.source.slice("plugin:".length)
          : undefined
      }
      category="skill"
      displayName={displayName ? <code>{displayName}</code> : undefined}
      displayNameTitle={displayName}
      status={effectiveStatus}
      className="tool-call-skill"
    >
      <div className="tool-call-body tool-call-skill-body">
        <div className="tool-call-skill-meta">
          {skillId ? (
            <div className="tool-call-skill-meta-item">
              <span className="tool-call-skill-meta-label">
                {t("toolCall.skill.skillId")}
              </span>
              <code className="tool-call-skill-meta-code">{skillId}</code>
            </div>
          ) : null}
          {info?.name && info.name !== skillId ? (
            <div className="tool-call-skill-meta-item">
              <span className="tool-call-skill-meta-label">
                {t("toolCall.skill.skillName")}
              </span>
              <span className="tool-call-skill-meta-value">{info.name}</span>
            </div>
          ) : null}
          {info?.location ? (
            <div className="tool-call-skill-meta-item">
              <span className="tool-call-skill-meta-label">
                {t("toolCall.skill.location")}
              </span>
              <span className="tool-call-skill-root">{info.location}</span>
            </div>
          ) : null}
          {info?.path ? (
            <div className="tool-call-skill-meta-item">
              <span className="tool-call-skill-meta-label">
                {t("toolCall.skill.path")}
              </span>
              <code className="tool-call-skill-meta-code" title={info.path}>
                {info.path}
              </code>
            </div>
          ) : null}
          {info && info.allowedTools.length > 0 ? (
            <div className="tool-call-skill-meta-item">
              <span className="tool-call-skill-meta-label">
                {t("toolCall.skill.allowedTools")}
              </span>
              <span className="tool-call-skill-tools">
                {info.allowedTools.map((tool) => (
                  <code className="tool-call-skill-tool" key={tool}>
                    {tool}
                  </code>
                ))}
              </span>
            </div>
          ) : null}
        </div>

        {parsed.type === "skill" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.skill.content")}
            </span>
            <pre className="tool-call-section-pre tool-call-skill-content">
              {parsed.text}
            </pre>
          </section>
        ) : null}

        {parsed.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsed.message)}</span>
          </div>
        ) : null}

        {parsed.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <pre className="tool-call-section-pre">{parsed.text}</pre>
          </section>
        ) : null}

        {parsed.type === "empty" ? (
          <div
            className={`tool-call-skill-pending ${
              isRunning ? "tool-call-skill-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Circle size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.skill.running")
                : t("toolCall.skill.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
