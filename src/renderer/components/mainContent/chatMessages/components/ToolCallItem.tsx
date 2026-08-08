import { memo } from "react";
import type { ToolCallInfo } from "../utils/conversationTypes";
import type { HookExecutionRecord } from "../utils/conversationTypes";
import {
  AskUserQuestionToolCall,
  PlanModeApprovalToolCall,
  BashToolCall,
  FilesystemReadToolCall,
  FilesystemEditToolCall,
  FilesystemCreateToolCall,
  TodoToolCall,
  GrepToolCall,
  SubAgentToolCall,
  CodebaseToolCall,
  CodeLensToolCall,
  WebSearchToolCall,
  ImageGenToolCall,
  BrowserToolCall,
  TerminalToolCall,
  SkillToolCall,
  ConfigToolCall,
  AppControlToolCall,
  DbxToolCall,
} from "../toolCalls";
import { ToolCallNode } from "../toolCalls/shared/ToolCallNode";
import { useI18n } from "../../../../i18n";

type ToolCallItemProps = {
  toolCall: ToolCallInfo;
  /** Hook execution records bound to this tool call (matched by
   *  toolCallInteractionId).  Forwarded to the sub-agent card renderer;
   *  other tool renderers ignore it. */
  hookExecutions?: HookExecutionRecord[];
};

/** Pretty-print JSON arguments if possible, otherwise return raw string. */
const formatArguments = (args: string): string => {
  if (!args || args === "{}") {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Detect whether the tool result JSON carries an error. */
const hasResultError = (result: string | undefined): boolean => {
  if (!result) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return false;
    }
    return typeof parsed.error === "string";
  } catch {
    return false;
  }
};

/** 按信息量优先级提取参数中的摘要字段，用于折叠态 header 展示。 */
const SUMMARY_KEYS = [
  "filePath",
  "path",
  "url",
  "query",
  "expression",
  "pattern",
  "command",
  "selector",
  "text",
  "name",
  "tool",
  "key",
  "prompt",
  "message",
  "content",
  "host",
  "server",
  "database",
  "db",
  "connection",
  "connectionName",
  "connection_name",
  "channel",
  "agentId",
  "agent_id",
  "skillId",
  "skill_id",
  "scope",
  "fileName",
  "file",
  "domain",
  "endpoint",
  "baseUrl",
  "model",
  "instanceId",
  "instance_id",
  "taskId",
  "task_id",
  "table",
  "action",
] as const;

const truncateSummary = (value: string, max = 56): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const getArgsSummary = (args: string): string | undefined => {
  if (!args || args === "{}") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) {
      return undefined;
    }
    // 1. 直接字符串字段。
    for (const key of SUMMARY_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim() !== "") {
        return truncateSummary(value.trim());
      }
    }
    // 2. host/server + port 组合（外部 MCP 服务器工具常见）。
    const hostValue = parsed.host ?? parsed.server;
    const portValue = parsed.port;
    if (typeof hostValue === "string" && hostValue.trim() !== "") {
      if (typeof portValue === "number" && Number.isFinite(portValue)) {
        return truncateSummary(`${hostValue.trim()}:${portValue}`);
      }
      return truncateSummary(hostValue.trim());
    }
    // 3. 数组字段取第一项。
    for (const key of SUMMARY_KEYS) {
      const value = parsed[key];
      if (Array.isArray(value)) {
        const first = value.find(
          (item): item is string => typeof item === "string"
        );
        if (first && first.trim() !== "") {
          return truncateSummary(first.trim());
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/** 解码转义存储的 `\n` / `\r\n` 为真实换行（仅当字符串不含真实换行时）。 */
const decodeEscapedNewlines = (text: string): string => {
  if (text.includes("\n") || !text.includes("\\n")) {
    return text;
  }
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
};

/** 常见的长文本字段名（按优先级）。外部 MCP 结果常把正文放在这些字段里。 */
const LONG_TEXT_KEYS = [
  "content",
  "text",
  "value",
  "markdown",
  "result",
  "output",
  "html",
  "description",
  "summary",
  "message",
  "body",
  "data",
] as const;

/** 从结果对象中提取长文本字段（含转义换行/真实换行或超过 160 字符）。 */
const extractLongText = (data: Record<string, unknown>): string | null => {
  for (const key of LONG_TEXT_KEYS) {
    const value = data[key];
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      (value.includes("\\n") || value.includes("\n") || value.length > 160)
    ) {
      return decodeEscapedNewlines(value);
    }
  }
  return null;
};

/** 通用兜底的结果渲染：JSON 美化 + 长文本字段提取，避免外部 MCP 结果一坨转义文本。 */
const ResultSection = ({ raw }: { raw: string }): React.JSX.Element => {
  const { t } = useI18n();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return (
      <div className="tool-call-section">
        <span className="tool-call-section-label">
          {t("toolCall.common.result")}
        </span>
        <pre className="tool-call-section-pre">{raw}</pre>
      </div>
    );
  }
  if (typeof parsed === "string") {
    return (
      <div className="tool-call-section">
        <span className="tool-call-section-label">
          {t("toolCall.common.result")}
        </span>
        <pre className="tool-call-section-pre">{decodeEscapedNewlines(parsed)}</pre>
      </div>
    );
  }
  if (isRecord(parsed)) {
    const longText = extractLongText(parsed);
    if (longText !== null) {
      return (
        <div className="tool-call-section">
          <div className="tool-call-section-head">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <span className="tool-call-config-value-badge">
              {t("toolCall.common.charCount", {
                values: { count: longText.length.toLocaleString() },
              })}
            </span>
          </div>
          <pre className="tool-call-section-pre tool-call-config-value-text">
            {longText}
          </pre>
        </div>
      );
    }
  }
  return (
    <div className="tool-call-section">
      <span className="tool-call-section-label">
        {t("toolCall.common.result")}
      </span>
      <pre className="tool-call-section-pre">{JSON.stringify(parsed, null, 2)}</pre>
    </div>
  );
};

export const ToolCallItem = memo(
  ({ toolCall, hookExecutions }: ToolCallItemProps): React.JSX.Element => {
    const { t } = useI18n();
    // Delegate to specialized renderers based on tool name
    if (toolCall.name === "user-interaction-askUserQuestion") {
      return <AskUserQuestionToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "app-control-requestApproval") {
      return <PlanModeApprovalToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-read") {
      return <FilesystemReadToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-replace_edit") {
      return <FilesystemEditToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-create") {
      return <FilesystemCreateToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "bash-terminal-execute") {
      return <BashToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "todo-todo-manage") {
      return <TodoToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "grep-search") {
      return <GrepToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "sub-agents-activate") {
      return (
        <SubAgentToolCall
          toolCall={toolCall}
          hookExecutions={hookExecutions}
        />
      );
    }

    if (toolCall.name === "codebase-search") {
      return <CodebaseToolCall toolCall={toolCall} />;
    }

    if (
      toolCall.name === "codelens-find_definition" ||
      toolCall.name === "codelens-find_references" ||
      toolCall.name === "codelens-file_outline"
    ) {
      return <CodeLensToolCall toolCall={toolCall} />;
    }

    if (
      toolCall.name === "websearch-websearch-search" ||
      toolCall.name === "websearch-websearch-fetch"
    ) {
      return <WebSearchToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "imagegen-generate") {
      return <ImageGenToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("browser-")) {
      return <BrowserToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("terminal-")) {
      return <TerminalToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "skills-skill-execute") {
      return <SkillToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("config-")) {
      return <ConfigToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("app-control-")) {
      return <AppControlToolCall toolCall={toolCall} />;
    }

    if (
      toolCall.name.startsWith("dbx-") ||
      toolCall.name.startsWith("dbx_")
    ) {
      // 外部 MCP（DBX 桌面数据库应用）统一渲染，见 DbxToolCall 头部注释。
      // 注意：外部 MCP 工具名可能被规范化为下划线风格（dbx_execute_query），
      // 因此同时兼容连字符与下划线两种前缀。
      return <DbxToolCall toolCall={toolCall} />;
    }

    // —— 以下为通用兜底渲染 ——
    // 未匹配到任何专用渲染器的工具（通常是外部 MCP 或第三方扩展的工具）：
    // 折叠态 header 显示参数摘要（getArgsSummary），展开后展示参数与结果 JSON，
    // 保持与专用工具一致的 ToolCallNode 风格。
    const effectiveStatus = hasResultError(toolCall.result)
      ? "error"
      : toolCall.status;
    const formattedArgs = formatArguments(toolCall.arguments);
    const argsSummary = getArgsSummary(toolCall.arguments);
    const hasBody = Boolean(formattedArgs || toolCall.result);

    return (
      <ToolCallNode
        toolName={toolCall.name}
        status={effectiveStatus}
        displayName={argsSummary}
        displayNameTitle={toolCall.arguments}
      >
        {hasBody ? (
          <>
            {formattedArgs ? (
              <div className="tool-call-section">
                <span className="tool-call-section-label">
                  {t("toolCall.common.arguments")}
                </span>
                <pre className="tool-call-section-pre">{formattedArgs}</pre>
              </div>
            ) : null}
            {toolCall.result ? (
              <ResultSection raw={toolCall.result} />
            ) : null}
          </>
        ) : null}
      </ToolCallNode>
    );
  }
);

ToolCallItem.displayName = "ToolCallItem";
