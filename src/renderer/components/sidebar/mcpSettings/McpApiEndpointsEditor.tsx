import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { McpApiTestResult } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import {
  API_BODY_TYPES,
  API_METHODS,
  API_PARAM_LOCATIONS,
  API_PARAM_TYPES,
  apiSpecToJson,
  buildBodyTemplate,
  buildTestArguments,
  createApiEndpoint,
  createApiPair,
  createApiParam,
  isAutoBodyTemplate,
  isTemplateBodyType,
} from "./mcpApiUtils";
import { McpKeyValueEditor } from "./McpKeyValueEditor";
import { pairsToJson } from "./mcpSettingsUtils";
import type {
  McpApiEndpointDraft,
  McpApiParamDraft,
  McpApiSpecDraft,
  McpKeyValuePair,
  McpServerDraft,
} from "./types";

type Translate = ReturnType<typeof useI18n>["t"];

const updatePairs = (
  pairs: McpKeyValuePair[],
  pairId: string,
  field: "key" | "value",
  value: string,
): McpKeyValuePair[] =>
  pairs.map((pair) =>
    pair.id === pairId ? { ...pair, [field]: value } : pair,
  );

const bodyTypeLabel = (bodyType: string, t: Translate): string => {
  switch (bodyType) {
    case "json":
      return "JSON";
    case "form":
      return "x-www-form-urlencoded";
    case "multipart":
      return "multipart/form-data";
    case "raw":
      return t("settings.mcpApiBodyRaw", { defaultValue: "Raw text" });
    default:
      return t("settings.mcpApiBodyNone", { defaultValue: "None" });
  }
};

const locationLabel = (location: string, t: Translate): string => {
  switch (location) {
    case "path":
      return t("settings.mcpApiLocationPath", { defaultValue: "Path" });
    case "header":
      return t("settings.mcpApiLocationHeader", { defaultValue: "Header" });
    case "body":
      return t("settings.mcpApiLocationBody", { defaultValue: "Body" });
    default:
      return t("settings.mcpApiLocationQuery", { defaultValue: "Query" });
  }
};

type McpApiEndpointsEditorProps = {
  draft: McpServerDraft;
  isBusy: boolean;
  onChange: (api: McpApiSpecDraft) => void;
};

/** 自定义 API：公共 Cookie + 接口列表（每个接口生成一个工具）。 */
export function McpApiEndpointsEditor({
  draft,
  isBusy,
  onChange,
}: McpApiEndpointsEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const api = draft.api;
  const [expandedId, setExpandedId] = useState<string | null>(
    () => api.endpoints[0]?.id ?? null,
  );

  const patchEndpoint = (
    endpointId: string,
    patch: Partial<McpApiEndpointDraft>,
  ): void => {
    onChange({
      ...api,
      endpoints: api.endpoints.map((endpoint) =>
        endpoint.id === endpointId ? { ...endpoint, ...patch } : endpoint,
      ),
    });
  };

  const addEndpoint = (): void => {
    const endpoint = createApiEndpoint();
    onChange({ ...api, endpoints: [...api.endpoints, endpoint] });
    setExpandedId(endpoint.id);
  };

  const removeEndpoint = (endpointId: string): void => {
    onChange({
      ...api,
      endpoints: api.endpoints.filter((endpoint) => endpoint.id !== endpointId),
    });
  };

  return (
    <>
      <McpKeyValueEditor
        title={t("settings.mcpApiCookies", { defaultValue: "Cookies" })}
        pairs={api.cookies}
        isBusy={isBusy}
        namePlaceholder="session_id"
        valuePlaceholder="value"
        onUpdatePair={(pairId, field, value) =>
          onChange({
            ...api,
            cookies: updatePairs(api.cookies, pairId, field, value),
          })
        }
        onAddPair={() =>
          onChange({ ...api, cookies: [...api.cookies, createApiPair()] })
        }
        onRemovePair={(pairId) =>
          onChange({
            ...api,
            cookies: api.cookies.filter((pair) => pair.id !== pairId),
          })
        }
      />

      <div className="mcp-api-section">
        <div className="mcp-api-section-header">
          <strong className="api-settings-form-section-title">
            {t("settings.mcpApiEndpoints", { defaultValue: "API endpoints" })}
            <ApiSettingsHintIcon
              hint={t("settings.mcpApiPlaceholderHint", {
                defaultValue:
                  "Each endpoint becomes one tool. Reference parameters with {{name}} in the path, headers, cookies and body template.",
              })}
            />
          </strong>
        </div>

        {api.endpoints.length === 0 ? (
          <div className="system-prompt-empty compact">
            {t("settings.mcpApiNoEndpoints", {
              defaultValue: "No endpoints yet",
            })}
          </div>
        ) : (
          api.endpoints.map((endpoint, index) => (
            <McpApiEndpointCard
              key={endpoint.id}
              draft={draft}
              endpoint={endpoint}
              index={index}
              isBusy={isBusy}
              expanded={expandedId === endpoint.id}
              onToggle={() =>
                setExpandedId((current) =>
                  current === endpoint.id ? null : endpoint.id,
                )
              }
              onPatch={(patch) => patchEndpoint(endpoint.id, patch)}
              onRemove={() => removeEndpoint(endpoint.id)}
            />
          ))
        )}

        <button
          className="mcp-list-add-btn"
          onClick={addEndpoint}
          type="button"
          disabled={isBusy}
        >
          <Plus size={14} />
          <span>
            {t("settings.mcpApiAddEndpoint", { defaultValue: "Add endpoint" })}
          </span>
        </button>
      </div>
    </>
  );
}

type McpApiEndpointCardProps = {
  draft: McpServerDraft;
  endpoint: McpApiEndpointDraft;
  index: number;
  isBusy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<McpApiEndpointDraft>) => void;
  onRemove: () => void;
};

function McpApiEndpointCard({
  draft,
  endpoint,
  index,
  isBusy,
  expanded,
  onToggle,
  onPatch: commitPatch,
  onRemove,
}: McpApiEndpointCardProps): React.JSX.Element {
  const { t } = useI18n();
  const hasTemplate = isTemplateBodyType(endpoint.bodyType);

  // 参数或请求体类型变化时，未手动改过的模板随之重新生成
  const onPatch = (patch: Partial<McpApiEndpointDraft>): void => {
    if (
      ("params" in patch || "bodyType" in patch) &&
      !("bodyTemplate" in patch) &&
      isAutoBodyTemplate(endpoint)
    ) {
      const next = { ...endpoint, ...patch };
      commitPatch({
        ...patch,
        bodyTemplate: buildBodyTemplate(next.params, next.bodyType),
      });
      return;
    }
    commitPatch(patch);
  };

  const patchParam = (
    paramId: string,
    patch: Partial<McpApiParamDraft>,
  ): void => {
    onPatch({
      params: endpoint.params.map((param) =>
        param.id === paramId ? { ...param, ...patch } : param,
      ),
    });
  };

  return (
    <div className={`mcp-api-endpoint${expanded ? " expanded" : ""}`}>
      <div className="mcp-api-endpoint-header">
        <button
          type="button"
          className="mcp-api-endpoint-toggle"
          onClick={onToggle}
        >
          {expanded ? (
            <ChevronDown size={14} strokeWidth={1.9} />
          ) : (
            <ChevronRight size={14} strokeWidth={1.9} />
          )}
          <span
            className={`mcp-api-method method-${endpoint.method.toLowerCase()}`}
          >
            {endpoint.method}
          </span>
          <strong>
            {endpoint.name.trim() ||
              t("settings.mcpApiUnnamedEndpoint", {
                defaultValue: "Endpoint #{{index}}",
                values: { index: index + 1 },
              })}
          </strong>
          <span className="mcp-api-endpoint-path">{endpoint.path || "/"}</span>
        </button>
        <button
          className="icon-btn ghost danger"
          onClick={onRemove}
          type="button"
          title={t("settings.remove", { defaultValue: "Remove" })}
          aria-label={t("settings.remove", { defaultValue: "Remove" })}
          disabled={isBusy}
        >
          <Trash2 size={14} strokeWidth={1.9} />
        </button>
      </div>

      {expanded && (
        <div className="mcp-api-endpoint-body">
          <div className="api-settings-form-grid">
            <label className="api-settings-field">
              <span>
                {t("settings.mcpApiToolName", { defaultValue: "Tool name" })}
              </span>
              <input
                value={endpoint.name}
                onChange={(event) => onPatch({ name: event.target.value })}
                placeholder="get_user"
                disabled={isBusy}
              />
            </label>
            <div className="api-settings-field">
              <span>
                {t("settings.mcpApiMethod", { defaultValue: "Method" })}
              </span>
              <CustomSelect
                value={endpoint.method}
                options={API_METHODS.map((method) => ({
                  value: method,
                  label: method,
                }))}
                onChange={(value) => onPatch({ method: value })}
                disabled={isBusy}
              />
            </div>
            <label className="api-settings-field wide">
              <span>{t("settings.mcpApiPath", { defaultValue: "Path" })}</span>
              <input
                value={endpoint.path}
                onChange={(event) => onPatch({ path: event.target.value })}
                placeholder="/users/{{id}}"
                disabled={isBusy}
              />
            </label>
            <label className="api-settings-field wide">
              <span>
                {t("settings.mcpApiDescription", {
                  defaultValue: "Description (shown to the model)",
                })}
              </span>
              <textarea
                className="mcp-api-textarea compact"
                value={endpoint.description}
                onChange={(event) =>
                  onPatch({ description: event.target.value })
                }
                placeholder={t("settings.mcpApiDescriptionPlaceholder", {
                  defaultValue: "What this endpoint does and when to use it",
                })}
                disabled={isBusy}
              />
            </label>
          </div>

          <div className="mcp-api-subsection">
            <strong className="api-settings-form-section-title">
              {t("settings.mcpApiParams", { defaultValue: "Parameters" })}
            </strong>
            {endpoint.params.length === 0 ? (
              <div className="system-prompt-empty compact">
                {t("settings.mcpApiNoParams", {
                  defaultValue: "No parameters",
                })}
              </div>
            ) : (
              <div className="mcp-api-param-list">
                {endpoint.params.map((param) => (
                  <div className="mcp-api-param-row" key={param.id}>
                    <input
                      value={param.name}
                      onChange={(event) =>
                        patchParam(param.id, { name: event.target.value })
                      }
                      placeholder={t("settings.mcpApiParamName", {
                        defaultValue: "Name",
                      })}
                      disabled={isBusy}
                    />
                    <CustomSelect
                      value={param.type}
                      options={API_PARAM_TYPES.map((type) => ({
                        value: type,
                        label: type,
                      }))}
                      onChange={(value) =>
                        patchParam(param.id, { type: value })
                      }
                      disabled={isBusy}
                    />
                    <CustomSelect
                      value={param.location}
                      options={API_PARAM_LOCATIONS.map((location) => ({
                        value: location,
                        label: locationLabel(location, t),
                      }))}
                      onChange={(value) =>
                        patchParam(param.id, { location: value })
                      }
                      disabled={isBusy}
                    />
                    <label className="mcp-api-param-required">
                      <input
                        type="checkbox"
                        checked={param.required}
                        onChange={(event) =>
                          patchParam(param.id, {
                            required: event.target.checked,
                          })
                        }
                        disabled={isBusy}
                      />
                      <span>
                        {t("settings.mcpApiParamRequired", {
                          defaultValue: "Required",
                        })}
                      </span>
                    </label>
                    <input
                      value={param.defaultValue}
                      onChange={(event) =>
                        patchParam(param.id, {
                          defaultValue: event.target.value,
                        })
                      }
                      placeholder={t("settings.mcpApiParamDefault", {
                        defaultValue: "Default",
                      })}
                      disabled={isBusy}
                    />
                    <input
                      className="mcp-api-param-description"
                      value={param.description}
                      onChange={(event) =>
                        patchParam(param.id, {
                          description: event.target.value,
                        })
                      }
                      placeholder={t("settings.mcpApiParamDescription", {
                        defaultValue: "Description",
                      })}
                      disabled={isBusy}
                    />
                    <button
                      className="icon-btn ghost danger"
                      onClick={() =>
                        onPatch({
                          params: endpoint.params.filter(
                            (item) => item.id !== param.id,
                          ),
                        })
                      }
                      type="button"
                      title={t("settings.remove", { defaultValue: "Remove" })}
                      aria-label={t("settings.remove", {
                        defaultValue: "Remove",
                      })}
                      disabled={isBusy}
                    >
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              className="mcp-list-add-btn"
              onClick={() =>
                onPatch({ params: [...endpoint.params, createApiParam()] })
              }
              type="button"
              disabled={isBusy}
            >
              <Plus size={14} />
              <span>
                {t("settings.mcpApiAddParam", {
                  defaultValue: "Add parameter",
                })}
              </span>
            </button>
          </div>

          <McpKeyValueEditor
            title={t("settings.mcpApiEndpointHeaders", {
              defaultValue: "Endpoint headers",
            })}
            pairs={endpoint.headers}
            isBusy={isBusy}
            namePlaceholder="Accept"
            valuePlaceholder="application/json"
            onUpdatePair={(pairId, field, value) =>
              onPatch({
                headers: updatePairs(endpoint.headers, pairId, field, value),
              })
            }
            onAddPair={() =>
              onPatch({ headers: [...endpoint.headers, createApiPair()] })
            }
            onRemovePair={(pairId) =>
              onPatch({
                headers: endpoint.headers.filter((pair) => pair.id !== pairId),
              })
            }
          />

          <div className="mcp-api-subsection">
            <div className="api-settings-form-grid">
              <div className="api-settings-field">
                <span>
                  {t("settings.mcpApiBodyType", { defaultValue: "Body" })}
                  {endpoint.bodyType === "multipart" ? (
                    <ApiSettingsHintIcon
                      hint={t("settings.mcpApiMultipartHint", {
                        defaultValue:
                          "Parameters located in Body are sent as text form fields.",
                      })}
                    />
                  ) : null}
                </span>
                <CustomSelect
                  value={endpoint.bodyType}
                  options={API_BODY_TYPES.map((bodyType) => ({
                    value: bodyType,
                    label: bodyTypeLabel(bodyType, t),
                  }))}
                  onChange={(value) => onPatch({ bodyType: value })}
                  disabled={isBusy}
                />
              </div>
              {endpoint.bodyType === "raw" && (
                <label className="api-settings-field">
                  <span>Content-Type</span>
                  <input
                    value={endpoint.rawContentType}
                    onChange={(event) =>
                      onPatch({ rawContentType: event.target.value })
                    }
                    placeholder="text/plain"
                    disabled={isBusy}
                  />
                </label>
              )}
            </div>
            {hasTemplate && (
              <>
                <div className="mcp-api-body-toolbar">
                  <span className="mcp-api-hint">
                    {endpoint.bodyType === "raw"
                      ? t("settings.mcpApiRawTemplateHint", {
                          defaultValue:
                            "The template is sent as-is after placeholders are replaced.",
                        })
                      : t("settings.mcpApiBodyTemplateHint", {
                          defaultValue:
                            'Generated from parameters located in Body and kept in sync until you edit it. In JSON templates, "{{name}}" keeps the original value type; fields whose parameter has no value are omitted.',
                        })}
                  </span>
                  <button
                    className="api-settings-form-btn secondary compact"
                    type="button"
                    onClick={() =>
                      onPatch({
                        bodyTemplate: buildBodyTemplate(
                          endpoint.params,
                          endpoint.bodyType,
                        ),
                      })
                    }
                    disabled={isBusy}
                  >
                    <RefreshCw size={13} strokeWidth={1.9} />
                    <span>
                      {t("settings.mcpApiRegenerateBody", {
                        defaultValue: "Regenerate from parameters",
                      })}
                    </span>
                  </button>
                </div>
                <textarea
                  className="mcp-api-textarea code"
                  value={endpoint.bodyTemplate}
                  onChange={(event) =>
                    onPatch({ bodyTemplate: event.target.value })
                  }
                  placeholder={
                    endpoint.bodyType === "json"
                      ? '{\n  "id": "{{id}}",\n  "limit": {{limit}}\n}'
                      : endpoint.bodyType === "form"
                        ? "q={{keyword}}&page=1"
                        : "{{content}}"
                  }
                  spellCheck={false}
                  disabled={isBusy}
                />
              </>
            )}
          </div>

          <McpApiTestPanel draft={draft} endpoint={endpoint} index={index} />
        </div>
      )}
    </div>
  );
}

type McpApiTestPanelProps = {
  draft: McpServerDraft;
  endpoint: McpApiEndpointDraft;
  index: number;
};

type ResultTab = "body" | "headers" | "request";

/** 接口调试：按当前草稿直接发送请求。 */
function McpApiTestPanel({
  draft,
  endpoint,
  index,
}: McpApiTestPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [isTesting, setIsTesting] = useState(false);
  const [inputError, setInputError] = useState("");
  const [result, setResult] = useState<McpApiTestResult | null>(null);
  const [tab, setTab] = useState<ResultTab>("body");
  const namedParams = endpoint.params.filter((param) => param.name.trim());

  const runTest = async (): Promise<void> => {
    const built = buildTestArguments(namedParams, inputs);
    if ("error" in built) {
      setInputError(
        t("settings.mcpApiTestInvalidValue", {
          defaultValue: 'Invalid value for parameter "{{name}}".',
          values: { name: built.error },
        }),
      );
      return;
    }
    setInputError("");
    setIsTesting(true);
    try {
      const timeoutMs = Number(draft.timeoutMs);
      const response = await window.snow.testMcpApiEndpoint({
        baseUrl: draft.url.trim(),
        headersJson: pairsToJson(draft.headers),
        specJson: apiSpecToJson(draft.api),
        endpointIndex: index,
        argumentsJson: JSON.stringify(built.args),
        ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
      });
      setResult(response);
      setTab(response.status ? "body" : "request");
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTesting(false);
    }
  };

  const statusClass = result?.status ? (result.ok ? "ok" : "error") : "failed";

  return (
    <div className="mcp-api-test">
      <div className="mcp-api-test-header">
        <strong>
          {t("settings.mcpApiTestTitle", { defaultValue: "Debug request" })}
        </strong>
        <button
          className="api-settings-form-btn secondary compact"
          type="button"
          onClick={() => void runTest()}
          disabled={isTesting}
        >
          {isTesting ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Send size={14} strokeWidth={1.9} />
          )}
          <span>{t("settings.mcpApiTestSend", { defaultValue: "Send" })}</span>
        </button>
      </div>

      {namedParams.length > 0 && (
        <div className="mcp-api-test-inputs">
          {namedParams.map((param) => (
            <label className="api-settings-field" key={param.id}>
              <span>
                {param.name}
                {param.required && <em className="mcp-api-required">*</em>}
                <small>{param.type}</small>
              </span>
              {param.type === "boolean" ? (
                <CustomSelect
                  value={inputs[param.id] ?? ""}
                  options={[
                    { value: "", label: "-" },
                    { value: "true", label: "true" },
                    { value: "false", label: "false" },
                  ]}
                  onChange={(value) =>
                    setInputs((previous) => ({
                      ...previous,
                      [param.id]: value,
                    }))
                  }
                />
              ) : (
                <input
                  value={inputs[param.id] ?? ""}
                  onChange={(event) =>
                    setInputs((previous) => ({
                      ...previous,
                      [param.id]: event.target.value,
                    }))
                  }
                  placeholder={param.defaultValue || param.description}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {inputError && (
        <div className="mcp-api-test-error">
          <CircleAlert size={13} strokeWidth={1.9} />
          <span>{inputError}</span>
        </div>
      )}

      {result && (
        <div className="mcp-api-test-result">
          <div className="mcp-api-test-summary">
            <span className={`mcp-api-test-status ${statusClass}`}>
              {result.status
                ? `${result.status} ${result.statusText}`.trim()
                : t("settings.mcpApiTestFailed", {
                    defaultValue: "Request failed",
                  })}
            </span>
            <span className="mcp-api-test-meta">{result.elapsedMs} ms</span>
            {result.url && (
              <span className="mcp-api-test-url" title={result.url}>
                {result.method} {result.url}
              </span>
            )}
          </div>
          {result.error && (
            <div className="mcp-api-test-error">
              <CircleAlert size={13} strokeWidth={1.9} />
              <span>{result.error}</span>
            </div>
          )}
          <div className="mcp-api-test-tabs">
            {(["body", "headers", "request"] as ResultTab[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`mcp-api-test-tab${tab === item ? " active" : ""}`}
                onClick={() => setTab(item)}
              >
                {item === "body"
                  ? t("settings.mcpApiTestBody", { defaultValue: "Response" })
                  : item === "headers"
                    ? t("settings.mcpApiTestHeaders", {
                        defaultValue: "Response headers",
                      })
                    : t("settings.mcpApiTestRequest", {
                        defaultValue: "Request",
                      })}
              </button>
            ))}
          </div>
          <pre className="mcp-api-test-output">
            {tab === "body"
              ? result.body || "-"
              : tab === "headers"
                ? result.responseHeaders
                    .map((header) => `${header.name}: ${header.value}`)
                    .join("\n") || "-"
                : [
                    `${result.method} ${result.url}`,
                    ...result.requestHeaders.map(
                      (header) => `${header.name}: ${header.value}`,
                    ),
                    ...(result.requestBody ? ["", result.requestBody] : []),
                  ].join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
