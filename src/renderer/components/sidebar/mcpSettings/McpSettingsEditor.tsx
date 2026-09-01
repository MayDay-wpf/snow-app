import hljs from "highlight.js";
import {
  CircleAlert,
  CircleCheck,
  Loader2,
  Save,
  Search,
  Wrench,
  X,
} from "lucide-react";
import Editor from "react-simple-code-editor";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { CustomSelect } from "../../common/CustomSelect";
import { McpKeyValueEditor } from "./McpKeyValueEditor";
import { McpStringListEditor } from "./McpStringListEditor";
import {
  draftToJson,
  formatJsonParseError,
  formatMcpJsonText,
  parseDraftJson,
} from "./mcpSettingsUtils";
import type { McpServerDraft, McpServerTool } from "./types";

const TRANSPORT_OPTIONS = [
  { value: "stdio", label: "stdio" },
  { value: "http", label: "http" },
];

/** JSON 语法高亮（hljs 已负责 HTML 转义；容错失败时手动转义兜底）。 */
const highlightJson = (code: string): string => {
  try {
    return hljs.highlight(code, { language: "json", ignoreIllegals: true })
      .value;
  } catch {
    return code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
};

/** 编辑器实例唯一（面板内单条服务器编辑），固定 id 即可，供光标定位查询。 */
const JSON_EDITOR_TEXTAREA_ID = "mcp-editor-json-textarea";

const formatInputSchema = (inputSchemaJson: string): string => {
  try {
    return JSON.stringify(JSON.parse(inputSchemaJson), null, 2);
  } catch {
    return inputSchemaJson || "{}";
  }
};

type JsonValidationStatus =
  { kind: "empty" } | { kind: "valid" } | { kind: "invalid"; message: string };

type McpSettingsEditorProps = {
  draft: McpServerDraft;
  isBusy: boolean;
  isSaving: boolean;
  tools?: McpServerTool[];
  isFetchingTools?: boolean;
  onFetchTools?: () => void;
  onDraftChange: (patch: Partial<McpServerDraft>) => void;
  onUpdatePair: (
    field: "env" | "headers",
    pairId: string,
    fieldName: "key" | "value",
    value: string,
  ) => void;
  onAddPair: (field: "env" | "headers") => void;
  onRemovePair: (field: "env" | "headers", pairId: string) => void;
  onUpdateArg: (argId: string, value: string) => void;
  onAddArg: () => void;
  onRemoveArg: (argId: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function McpSettingsEditor({
  draft,
  isBusy,
  isSaving,
  tools,
  isFetchingTools,
  onFetchTools,
  onDraftChange,
  onUpdatePair,
  onAddPair,
  onRemovePair,
  onUpdateArg,
  onAddArg,
  onRemoveArg,
  onCancel,
  onSave,
}: McpSettingsEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const isHttp = draft.transportType === "http";
  const [toolFilter, setToolFilter] = useState("");
  const [editMode, setEditMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState(() => draftToJson(draft));
  const [jsonError, setJsonError] = useState("");
  // 粘贴整体替换后待将光标移到文本末尾的标记
  const pasteCaretToEndRef = useRef(false);

  const filteredTools = useMemo(() => {
    if (!tools) return undefined;
    const trimmed = toolFilter.trim().toLowerCase();
    if (!trimmed) return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(trimmed) ||
        (tool.description || "").toLowerCase().includes(trimmed),
    );
  }, [tools, toolFilter]);

  // 与保存行为保持一致的实时校验：能被容错解析为服务器配置即视为有效
  const jsonStatus = useMemo<JsonValidationStatus>(() => {
    if (!jsonText.trim()) {
      return { kind: "empty" };
    }
    try {
      parseDraftJson(jsonText, draft);
      return { kind: "valid" };
    } catch (error) {
      return { kind: "invalid", message: formatJsonParseError(error) };
    }
  }, [jsonText, draft]);

  const switchToJson = (): void => {
    setJsonText(draftToJson(draft));
    setJsonError("");
    setEditMode("json");
  };

  const switchToForm = (): void => {
    // JSON 内容不完整或缺少必填字段时不应阻断切换：能解析则应用，
    // 否则保留当前表单数据，必填校验统一在保存时进行。
    try {
      const parsed = parseDraftJson(jsonText, draft);
      onDraftChange(parsed);
    } catch {
      // 忽略无法解析的 JSON 编辑内容，保留当前表单数据
    }
    setJsonError("");
    setEditMode("form");
  };

  const handleJsonTextChange = (value: string): void => {
    setJsonText(value);
    setJsonError("");
  };

  // 粘贴自动格式化：粘贴的内容若能容错解析为配置对象（自动剥离 markdown 围栏、
  // 注释、尾随逗号、前后杂文字），则格式化后整体替换编辑器内容；
  // 片段或无法解析时保持浏览器默认的插入行为，不打扰正常编辑。
  const handleJsonPaste = (
    event: React.ClipboardEvent<HTMLDivElement>,
  ): void => {
    const pasted = event.clipboardData.getData("text/plain");
    if (!pasted.trim()) {
      return;
    }
    const formatted = formatMcpJsonText(pasted);
    if (formatted === null) {
      return;
    }
    event.preventDefault();
    pasteCaretToEndRef.current = true;
    setJsonText(formatted);
    setJsonError("");
  };

  // 整体替换后把光标移到文本末尾（库会恢复替换前的旧光标位置）
  useEffect(() => {
    if (!pasteCaretToEndRef.current) {
      return;
    }
    pasteCaretToEndRef.current = false;
    const textarea = document.getElementById(
      JSON_EDITOR_TEXTAREA_ID,
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
  }, [jsonText]);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (editMode === "json") {
      try {
        const parsed = parseDraftJson(jsonText, draft);
        onDraftChange(parsed);
        setJsonError("");
      } catch (error) {
        setJsonError(
          formatJsonParseError(error) ||
            t("settings.mcpJsonInvalid", {
              defaultValue: "Invalid JSON",
            }),
        );
        return;
      }
    }
    onSave();
  };

  return (
    <form
      id="mcp-settings-editor-form"
      className="api-settings-form-section mcp-settings-editor-form"
      onSubmit={handleSubmit}
    >
      <div className="mcp-editor-mode-switch">
        <button
          type="button"
          className={`mcp-editor-mode-btn ${editMode === "form" ? "active" : ""}`}
          onClick={() => {
            if (editMode === "json") {
              switchToForm();
            }
          }}
          disabled={isBusy}
        >
          {t("settings.mcpEditForm", { defaultValue: "Form" })}
        </button>
        <button
          type="button"
          className={`mcp-editor-mode-btn ${editMode === "json" ? "active" : ""}`}
          onClick={switchToJson}
          disabled={isBusy}
        >
          JSON
        </button>
      </div>

      {editMode === "json" ? (
        <div className="mcp-editor-json-section">
          <div
            className={`mcp-editor-json-code${isBusy ? " is-disabled" : ""}`}
          >
            <Editor
              value={jsonText}
              onValueChange={handleJsonTextChange}
              highlight={highlightJson}
              onPaste={handleJsonPaste}
              tabSize={2}
              insertSpaces
              disabled={isBusy}
              padding={12}
              style={{ minHeight: 240 }}
              textareaId={JSON_EDITOR_TEXTAREA_ID}
              textareaClassName="mcp-editor-json-input"
              preClassName="hljs"
              aria-label={t("settings.mcpJsonEditorLabel", {
                defaultValue: "MCP server JSON configuration",
              })}
            />
          </div>
          <div className="mcp-editor-json-toolbar">
            {jsonStatus.kind === "valid" && (
              <span className="mcp-editor-json-status valid">
                <CircleCheck size={13} strokeWidth={1.9} />
                {t("settings.mcpJsonValid", { defaultValue: "Valid JSON" })}
              </span>
            )}
            {jsonStatus.kind === "invalid" && (
              <span
                className="mcp-editor-json-status invalid"
                title={jsonStatus.message}
              >
                <CircleAlert size={13} strokeWidth={1.9} />
                <span>{jsonStatus.message}</span>
              </span>
            )}
          </div>
          <AutoDismissNotice
            message={jsonError}
            tone="error"
            onDismiss={() => setJsonError("")}
          />
          <div className="mcp-editor-json-hint">
            {t("settings.mcpJsonHint", {
              defaultValue:
                'Edit the server configuration as JSON, e.g. {"context7": {"url": "https://mcp.context7.com/mcp"}}. Pasted configs with markdown fences, mcpServers/servers wrappers, comments, trailing commas or full-width spaces are tolerated. type (http/stdio) is inferred from url or command when omitted.',
            })}
          </div>
        </div>
      ) : (
        <></>
      )}

      {editMode === "form" && (
        <>
          <div className="api-settings-form-grid">
            <label className="api-settings-field">
              <span>
                {t("settings.mcpServerName", { defaultValue: "Server name" })}
              </span>
              <input
                value={draft.name}
                onChange={(event) =>
                  onDraftChange({ name: event.target.value })
                }
                placeholder={t("settings.mcpServerNamePlaceholder", {
                  defaultValue: "e.g. filesystem",
                })}
                disabled={isBusy}
              />
            </label>
            <div className="api-settings-field">
              <span>
                {t("settings.mcpTransportType", { defaultValue: "Transport" })}
              </span>
              <CustomSelect
                value={draft.transportType}
                options={TRANSPORT_OPTIONS}
                onChange={(value) => onDraftChange({ transportType: value })}
                disabled={isBusy}
              />
            </div>
            <label className="api-settings-field">
              <span>
                {t("settings.mcpTimeoutMs", { defaultValue: "Timeout (ms)" })}
              </span>
              <input
                value={draft.timeoutMs}
                onChange={(event) =>
                  onDraftChange({ timeoutMs: event.target.value })
                }
                placeholder="300000"
                disabled={isBusy}
              />
            </label>
            <label className="api-settings-field wide">
              <span>
                {isHttp
                  ? t("settings.mcpUrl", { defaultValue: "URL" })
                  : t("settings.mcpCommand", { defaultValue: "Command" })}
              </span>
              <input
                value={isHttp ? draft.url : draft.command}
                onChange={(event) =>
                  onDraftChange(
                    isHttp
                      ? { url: event.target.value }
                      : { command: event.target.value },
                  )
                }
                placeholder={isHttp ? "https://example.com/mcp" : "npx"}
                disabled={isBusy}
              />
            </label>
            <label className="toggle-switch mcp-enabled-switch">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  onDraftChange({ enabled: event.target.checked })
                }
                disabled={isBusy}
              />
              <span className="toggle-slider" />
              <span>
                {t("settings.mcpServerEnabled", {
                  defaultValue: "Enable server",
                })}
              </span>
            </label>
          </div>

          {!isHttp && (
            <McpStringListEditor
              title={t("settings.mcpArgs", { defaultValue: "Args" })}
              items={draft.args}
              isBusy={isBusy}
              itemLabel={t("settings.mcpArgValue", {
                defaultValue: "Argument",
              })}
              valuePlaceholder="@modelcontextprotocol/server-filesystem"
              emptyMessage={t("settings.mcpNoArgs", {
                defaultValue: "No arguments",
              })}
              onUpdateItem={onUpdateArg}
              onAddItem={onAddArg}
              onRemoveItem={onRemoveArg}
            />
          )}

          <McpKeyValueEditor
            title={t("settings.mcpEnvironment", {
              defaultValue: "Environment",
            })}
            pairs={draft.env}
            isBusy={isBusy}
            namePlaceholder="API_KEY"
            valuePlaceholder="value"
            onUpdatePair={(pairId, field, value) =>
              onUpdatePair("env", pairId, field, value)
            }
            onAddPair={() => onAddPair("env")}
            onRemovePair={(pairId) => onRemovePair("env", pairId)}
          />

          <McpKeyValueEditor
            title={t("settings.mcpHeaders", { defaultValue: "Headers" })}
            pairs={draft.headers}
            isBusy={isBusy}
            namePlaceholder="Authorization"
            valuePlaceholder="Bearer token"
            onUpdatePair={(pairId, field, value) =>
              onUpdatePair("headers", pairId, field, value)
            }
            onAddPair={() => onAddPair("headers")}
            onRemovePair={(pairId) => onRemovePair("headers", pairId)}
          />

          <div className="mcp-tool-details-section">
            <div className="mcp-tool-details-header">
              <div>
                <strong>
                  {t("settings.mcpToolDetailsTitle", {
                    defaultValue: "Server tools",
                  })}
                </strong>
                <span>
                  {tools
                    ? t("settings.mcpToolDetailsCount", {
                        defaultValue: "{{count}} tool(s) fetched",
                        values: { count: tools.length },
                      })
                    : t("settings.mcpToolDetailsNotFetched", {
                        defaultValue: "Tool list has not been fetched",
                      })}
                </span>
              </div>
              <button
                className="api-settings-form-btn secondary compact"
                onClick={onFetchTools}
                type="button"
                disabled={
                  isBusy || isFetchingTools || !draft.serverId || !draft.enabled
                }
                title={
                  draft.serverId
                    ? t("settings.mcpFetchTools", {
                        defaultValue: "Fetch tools",
                      })
                    : t("settings.mcpSaveBeforeFetchTools", {
                        defaultValue: "Save this server before fetching tools",
                      })
                }
              >
                {isFetchingTools ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Wrench size={14} strokeWidth={1.9} />
                )}
                <span>
                  {t("settings.mcpFetchTools", { defaultValue: "Fetch tools" })}
                </span>
              </button>
            </div>

            {tools && tools.length > 0 && (
              <div className="mcp-tool-details-search">
                <Search size={12} strokeWidth={1.9} />
                <input
                  type="text"
                  value={toolFilter}
                  onChange={(event) => setToolFilter(event.target.value)}
                  placeholder={t("settings.mcpToolFilterPlaceholder", {
                    defaultValue: "Filter tools by name or description",
                  })}
                />
                {toolFilter && (
                  <button
                    type="button"
                    className="mcp-tool-details-search-clear"
                    onClick={() => setToolFilter("")}
                    title={t("settings.mcpToolFilterClear", {
                      defaultValue: "Clear filter",
                    })}
                  >
                    <X size={12} strokeWidth={1.9} />
                  </button>
                )}
              </div>
            )}

            {filteredTools &&
              (filteredTools.length === 0 ? (
                <div className="mcp-tool-details-empty">
                  {toolFilter
                    ? t("settings.mcpToolFilterEmpty", {
                        defaultValue: "No tools match the current filter.",
                      })
                    : t("settings.mcpToolDetailsEmpty", {
                        defaultValue: "This server did not return any tools.",
                      })}
                </div>
              ) : (
                <div className="mcp-tool-details-list">
                  {filteredTools.map((tool) => (
                    <details className="mcp-tool-detail-item" key={tool.name}>
                      <summary>
                        <strong>{tool.name}</strong>
                        <span>{tool.description || "-"}</span>
                      </summary>
                      <div className="mcp-tool-detail-content">
                        <span>
                          {t("settings.mcpToolInputSchema", {
                            defaultValue: "Input schema",
                          })}
                        </span>
                        <pre>{formatInputSchema(tool.inputSchemaJson)}</pre>
                      </div>
                    </details>
                  ))}
                </div>
              ))}
          </div>
        </>
      )}
    </form>
  );
}

type McpSettingsEditorActionsProps = {
  isBusy: boolean;
  isSaving: boolean;
  onCancel: () => void;
};

export function McpSettingsEditorActions({
  isBusy,
  isSaving,
  onCancel,
}: McpSettingsEditorActionsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <button
        className="api-settings-form-btn secondary"
        onClick={onCancel}
        type="button"
        disabled={isBusy}
      >
        <X size={15} strokeWidth={1.9} />
        <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
      </button>
      <button
        className="api-settings-form-btn primary"
        type="submit"
        form="mcp-settings-editor-form"
        disabled={isBusy}
      >
        {isSaving ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Save size={15} strokeWidth={1.9} />
        )}
        <span>
          {t("settings.saveMcpServer", { defaultValue: "Save server" })}
        </span>
      </button>
    </>
  );
}
