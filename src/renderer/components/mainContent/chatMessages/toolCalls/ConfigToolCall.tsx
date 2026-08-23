import { useMemo, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, FileX2, ListChecks } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { decodeEscapedNewlines, JsonTreeView } from "./shared/JsonTreeView";

type ConfigToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedResult =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const parseArgs = (args: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedResult => {
  if (!result) {
    return { type: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }
    return { type: "success", data: parsed };
  } catch {
    return { type: "raw", text: result };
  }
};

/** 从 list 返回中提取条目数组（keys / items / scopes）。 */
const extractEntries = (data: Record<string, unknown>): unknown[] => {
  if (Array.isArray(data.keys)) return data.keys;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.scopes)) return data.scopes;
  return [];
};

const extractConfigValue = (
  data: Record<string, unknown>
): { present: boolean; value: unknown } => {
  if ("value" in data) {
    return { present: true, value: data.value };
  }
  if ("content" in data) {
    return { present: true, value: data.content };
  }
  return { present: false, value: undefined };
};

/** get / set 成功后对 value 字段的美化展示（字符串转义解码见 shared/JsonTreeView）。 */
const ValuePreview = ({ value }: { value: unknown }): React.JSX.Element | null => {
  const { t } = useI18n();
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return (
      <section className="tool-call-section">
        <span className="tool-call-section-label">
          {t("toolCall.common.result")}
        </span>
        <JsonTreeView data={value} />
      </section>
    );
  }
  const text = decodeEscapedNewlines(value);
  if (text.length <= 120 && !text.includes("\n")) {
    return (
      <section className="tool-call-section">
        <span className="tool-call-section-label">
          {t("toolCall.common.result")}
        </span>
        <code className="tool-call-config-value-inline">{text}</code>
      </section>
    );
  }
  return (
    <section className="tool-call-section">
      <div className="tool-call-section-head">
        <span className="tool-call-section-label">
          {t("toolCall.common.result")}
        </span>
        <span className="tool-call-config-value-badge">
          {t("toolCall.common.charCount", {
            values: { count: text.length.toLocaleString() },
          })}
        </span>
      </div>
      <pre className="tool-call-section-pre tool-call-config-value-text">
        {text}
      </pre>
    </section>
  );
};

/**
 * 提取条目数组里每项的 key / name / hookType 等标识字段。
 * scope 放最后：多为 "project" / "global" 之类低辨识度值，避免标签重复。
 */
const entryLabel = (entry: unknown): string | undefined => {
  if (!isRecord(entry)) {
    return undefined;
  }
  return (
    asString(entry.key) ??
    asString(entry.name) ??
    asString(entry.agentId) ??
    asString(entry.skillId) ??
    asString(entry.hookType) ??
    asString(entry.fileName) ??
    asString(entry.scope) ??
    undefined
  );
};

export const ConfigToolCall = ({
  toolCall,
}: ConfigToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = toolCall.name.startsWith("config-")
    ? toolCall.name.slice("config-".length)
    : toolCall.name;

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const scope = asString(parsedArgs?.scope);
  const key = asString(parsedArgs?.key);
  const effectiveStatus =
    parsedResult.type === "error" ? "error" : toolCall.status;

  /* 折叠态头部摘要：config-list 显示 scope，其余显示 scope/key。 */
  const displayName =
    operation === "list"
      ? (scope ?? t("toolCall.config.allScopes"))
      : scope
      ? key
        ? `${scope}/${key}`
        : scope
      : key;

  /* 折叠态 meta 摘要。 */
  let meta: ReactNode = null;
  if (parsedResult.type === "success") {
    const data = parsedResult.data;
    if (operation === "list") {
      const entries = extractEntries(data);
      if (entries.length > 0) {
        meta = (
          <span className="tool-call-config-meta tool-call-config-meta-ok">
            <ListChecks size={10} aria-hidden="true" />
            {t("toolCall.config.entryCount", { values: { count: entries.length } })}
          </span>
        );
      }
    } else if (operation === "get") {
      const { present, value } = extractConfigValue(data);
      meta =
        !present || value === null || data.exists === false ? (
          <span className="tool-call-config-meta tool-call-config-meta-missing">
            {t("toolCall.config.notConfigured")}
          </span>
        ) : (
          <span className="tool-call-config-meta tool-call-config-meta-ok">
            <CheckCircle2 size={10} aria-hidden="true" />
            {typeof value}
          </span>
        );
    } else if (operation === "set") {
      meta = (
        <span className="tool-call-config-meta tool-call-config-meta-ok">
          <CheckCircle2 size={10} aria-hidden="true" />
          {t("toolCall.config.saved")}
        </span>
      );
    } else if (operation === "delete") {
      meta =
        data.deleted === true ? (
          <span className="tool-call-config-meta tool-call-config-meta-ok">
            <CheckCircle2 size={10} aria-hidden="true" />
            {t("toolCall.config.deleted")}
          </span>
        ) : (
          <span className="tool-call-config-meta tool-call-config-meta-missing">
            <FileX2 size={10} aria-hidden="true" />
            {t("toolCall.config.notFound")}
          </span>
        );
    }
  }

  /* list 成功时渲染条目标识列表。 */
  const entries =
    parsedResult.type === "success" && operation === "list"
      ? extractEntries(parsedResult.data)
          .map(entryLabel)
          .filter((label): label is string => label !== undefined)
      : [];

  const resultText =
    parsedResult.type === "raw"
      ? parsedResult.text
      : "";
  const configValue =
    parsedResult.type === "success" &&
    (operation === "set" || operation === "get")
      ? extractConfigValue(parsedResult.data)
      : null;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      displayName={displayName}
      displayNameTitle={toolCall.arguments}
      status={effectiveStatus}
      meta={meta}
      className="tool-call-config"
    >
      <div className="tool-call-body tool-call-config-body">
        {scope || key ? (
          <div className="tool-call-config-path">
            {scope ? <code>{scope}</code> : null}
            {scope && key ? (
              <span className="tool-call-config-path-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {key ? <code>{key}</code> : null}
          </div>
        ) : null}

        {entries.length > 0 ? (
          <div className="tool-call-config-keys">
            {entries.map((label) => (
              <span key={label} className="tool-call-config-key">
                {label}
              </span>
            ))}
          </div>
        ) : null}

        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {configValue?.present ? (
          <ValuePreview value={configValue.value} />
        ) : parsedResult.type === "success" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <JsonTreeView data={parsedResult.data} />
          </section>
        ) : resultText ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <pre className="tool-call-section-pre">{resultText}</pre>
          </section>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
