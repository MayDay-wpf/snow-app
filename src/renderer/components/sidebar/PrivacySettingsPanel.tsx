import {
  AlertCircle,
  ExternalLink,
  FilePenLine,
  KeyRound,
  Loader2,
  Regex,
  RotateCcw,
  ScanEye,
  Search,
  Wrench,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { useI18n } from "../../i18n";
import { CustomSelect } from "../common/CustomSelect";
import { useDebouncedAutoSave } from "../../hooks/useDebouncedAutoSave";
import { formatMcpError } from "./mcpSettings/mcpErrorMessages";
import {
  PrivacyToggleList,
  type PrivacyToggleGroup,
} from "./privacy/PrivacyToggleList";
import { PrivacyCustomRulesModal } from "./privacy/PrivacyCustomRulesModal";
import type {
  PrivacyApiConfig,
  PrivacyCustomRule,
  PrivacyRuleInfo,
  PrivacySettings,
  WorkspaceDirectoryRecord,
} from "../../../preload";

const PRIVACY_TOOL_LEGACY_MAP: Record<string, string> = {
  mcp__filesystem__read: "filesystem-read",
  mcp__grep__search: "grep-search",
  "mcp__bash__terminal-execute": "bash-terminal-execute",
  mcp__codebase__search: "codebase-search",
  "mcp__websearch__websearch-search": "websearch-websearch-search",
  "mcp__websearch__websearch-fetch": "websearch-websearch-fetch",
};

const migratePrivacyToolName = (tool: string): string =>
  PRIVACY_TOOL_LEGACY_MAP[tool] ?? tool;

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  enabled: false,
  mode: "local",
  api: {
    url: "",
    apiKey: "",
    model: "openai/privacy-filter",
  },
  toolResults: {
    tools: ["filesystem-read", "grep-search", "bash-terminal-execute"],
  },
  disabledRules: [],
  customRules: [],
};

type PrivacyTab = "tools" | "rules";

const PREVIEW_DEBOUNCE_MS = 300;
const CUSTOM_GROUP_ID = "__custom__";

const PRIVACY_MODE_OPTIONS = [
  { value: "local", labelKey: "settings.privacyModeLocal" },
  { value: "api", labelKey: "settings.privacyModeApi" },
];

const RULE_GROUP_LABELS: Record<string, string> = {
  apiKey: "API keys",
  credential: "Credentials",
  personal: "Personal information",
};

type ToolCatalogServer = {
  id: string;
  name: string;
  tools: { name: string; description: string }[];
};

const SAVE_DEBOUNCE_MS = 600;

/** 自建隐私过滤 API 的参考部署项目 */
const PRIVACY_FILTER_API_REPO_URL =
  "https://github.com/MayDay-wpf/privacy-filter-api";

/**
 * 计算待保存的隐私设置值。
 * 返回 null 表示无需保存（加载中 / 与上次保存一致）。
 */
function computePrivacySaveValue(
  form: PrivacySettings,
  lastSaved: PrivacySettings,
  isLoading: boolean,
): PrivacySettings | null {
  if (isLoading) {
    return null;
  }
  if (JSON.stringify(form) === JSON.stringify(lastSaved)) {
    return null;
  }
  return form;
}

type PrivacySettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

export function PrivacySettingsPanel({
  activeDirectory,
}: PrivacySettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<PrivacySettings>(DEFAULT_PRIVACY_SETTINGS);
  const [lastSaved, setLastSaved] = useState<PrivacySettings>(
    DEFAULT_PRIVACY_SETTINGS,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [rules, setRules] = useState<PrivacyRuleInfo[]>([]);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogServer[]>([]);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [toolQuery, setToolQuery] = useState("");
  const [activeTab, setActiveTab] = useState<PrivacyTab>("tools");
  const [isRulesEditorOpen, setIsRulesEditorOpen] = useState(false);
  const [previewSample, setPreviewSample] = useState("");
  const [previewOutput, setPreviewOutput] = useState("");
  const [previewError, setPreviewError] = useState("");
  const isMountedRef = useRef(true);
  const catalogGenerationRef = useRef(0);
  const projectId = activeDirectory?.directoryId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [value, ruleCatalog] = await Promise.all([
        window.snow.getPrivacySettings(),
        window.snow.listPrivacyRules(),
      ]);
      const normalized = normalizePrivacySettings(value);
      setRules(ruleCatalog);
      setForm(normalized);
      setLastSaved(normalized);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.privacyLoadError", {
              defaultValue: "Failed to load privacy settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // 工具目录：有项目时含项目级 MCP 服务器，否则用全局目录。
  const loadToolCatalog = useCallback(async () => {
    const generation = catalogGenerationRef.current + 1;
    catalogGenerationRef.current = generation;
    setIsCatalogLoading(true);
    setCatalogError("");
    try {
      const servers = projectId
        ? await window.snow.listMcpProjectServers(projectId)
        : await window.snow.listMcpGlobalServers();
      const seen = new Set<string>();
      const catalog: ToolCatalogServer[] = [];
      for (const server of servers) {
        const tools = server.tools
          .filter((tool) => !seen.has(tool.name))
          .map((tool) => {
            seen.add(tool.name);
            return { name: tool.name, description: tool.description };
          });
        if (tools.length > 0) {
          catalog.push({ id: server.id, name: server.name, tools });
        }
      }
      if (catalogGenerationRef.current === generation) {
        setToolCatalog(catalog);
      }
    } catch (catalogLoadError) {
      if (catalogGenerationRef.current === generation) {
        setCatalogError(formatMcpError(catalogLoadError, t));
      }
    } finally {
      if (catalogGenerationRef.current === generation) {
        setIsCatalogLoading(false);
      }
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadToolCatalog();
  }, [loadToolCatalog]);

  const isBusy = isLoading || isSaving;
  // 总开关关闭时，过滤模式 / 工具 / 规则等配置都不参与脱敏，统一禁用避免误以为仍生效。
  const isConfigDisabled = isBusy || !form.enabled;

  const modeOptions = useMemo(
    () =>
      PRIVACY_MODE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, {
          defaultValue: option.value === "local" ? "Local rules" : "Online API",
        }),
      })),
    [t],
  );

  const ruleGroups = useMemo<PrivacyToggleGroup[]>(() => {
    const disabled = new Set(form.disabledRules ?? []);
    const groups = new Map<string, PrivacyToggleGroup>();
    for (const rule of rules) {
      let group = groups.get(rule.group);
      if (!group) {
        group = {
          id: rule.group,
          title: t(`settings.privacyRuleGroup.${rule.group}`, {
            defaultValue: RULE_GROUP_LABELS[rule.group] ?? rule.group,
          }),
          items: [],
        };
        groups.set(rule.group, group);
      }
      group.items.push({
        id: rule.id,
        title: t(`settings.privacyRule.${rule.id}`, {
          defaultValue: rule.label,
        }),
        subtitle: rule.example,
        checked: !disabled.has(rule.id),
      });
    }
    return Array.from(groups.values());
  }, [rules, form.disabledRules, t]);

  const customRules = useMemo(() => form.customRules ?? [], [form.customRules]);

  const customGroups = useMemo<PrivacyToggleGroup[]>(
    () =>
      customRules.length === 0
        ? []
        : [
            {
              id: CUSTOM_GROUP_ID,
              title: t("settings.privacyCustomGroup", {
                defaultValue: "Custom rules",
              }),
              items: customRules.map((rule) => ({
                id: rule.id,
                title: rule.name,
                subtitle: formatCustomRuleSubtitle(rule),
                checked: rule.enabled,
              })),
            },
          ],
    [customRules, t],
  );

  // 测试框：按当前表单（含未保存修改）在 Rust 侧预览脱敏结果。
  // 总开关关闭时脱敏整体不生效，这里也不再预览，避免产生“仍在脱敏”的错觉。
  useEffect(() => {
    if (!previewSample || !form.enabled) {
      setPreviewOutput("");
      setPreviewError("");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.snow
        .previewPrivacyMask(
          previewSample,
          form.disabledRules ?? [],
          form.customRules ?? [],
        )
        .then((masked) => {
          if (!cancelled) {
            setPreviewOutput(masked);
            setPreviewError("");
          }
        })
        .catch((previewLoadError: unknown) => {
          if (!cancelled) {
            setPreviewError(
              previewLoadError instanceof Error
                ? previewLoadError.message
                : String(previewLoadError),
            );
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [previewSample, form.enabled, form.disabledRules, form.customRules]);

  const toolGroups = useMemo<PrivacyToggleGroup[]>(() => {
    const selected = new Set(form.toolResults.tools);
    const query = toolQuery.trim().toLowerCase();
    const matches = (...values: string[]): boolean =>
      !query || values.some((value) => value.toLowerCase().includes(query));
    const known = new Set<string>();
    const groups: PrivacyToggleGroup[] = [];
    for (const server of toolCatalog) {
      const items = server.tools
        .filter((tool) => {
          known.add(tool.name);
          return matches(tool.name, tool.description, server.name);
        })
        .map((tool) => ({
          id: tool.name,
          title: tool.name,
          subtitle: tool.description,
          checked: selected.has(tool.name),
        }));
      if (items.length > 0) {
        groups.push({ id: server.id, title: server.name, items });
      }
    }
    // 已保存但当前目录中不存在的工具，保留以便关闭。
    const orphanItems = form.toolResults.tools
      .filter((name) => !known.has(name) && matches(name))
      .map((name) => ({ id: name, title: name, checked: true }));
    if (orphanItems.length > 0 && !isCatalogLoading) {
      groups.push({
        id: "__unavailable__",
        title: t("settings.privacyToolsUnavailableGroup", {
          defaultValue: "Not in current tool catalog",
        }),
        items: orphanItems,
      });
    }
    return groups;
  }, [toolCatalog, form.toolResults.tools, toolQuery, isCatalogLoading, t]);

  const updateEnabled = (enabled: boolean): void => {
    setForm((previous: PrivacySettings) => ({ ...previous, enabled }));
  };

  const updateMode = (mode: string): void => {
    setForm((previous: PrivacySettings) => ({ ...previous, mode }));
  };

  const updateApiField =
    (field: keyof PrivacyApiConfig) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = event.target.value;
      setForm((previous: PrivacySettings) => ({
        ...previous,
        api: { ...previous.api, [field]: value },
      }));
    };

  const setToolsChecked = (names: string[], checked: boolean): void => {
    setForm((previous: PrivacySettings) => {
      const tools = new Set(previous.toolResults.tools);
      for (const name of names) {
        if (checked) {
          tools.add(name);
        } else {
          tools.delete(name);
        }
      }
      return { ...previous, toolResults: { tools: Array.from(tools) } };
    });
  };

  // 规则以「关闭名单」存储：勾选 = 从 disabledRules 移除。
  const setRulesChecked = (ids: string[], checked: boolean): void => {
    setForm((previous: PrivacySettings) => {
      const disabled = new Set(previous.disabledRules ?? []);
      for (const id of ids) {
        if (checked) {
          disabled.delete(id);
        } else {
          disabled.add(id);
        }
      }
      return { ...previous, disabledRules: Array.from(disabled) };
    });
  };

  const setCustomRulesChecked = (ids: string[], checked: boolean): void => {
    const targets = new Set(ids);
    setForm((previous: PrivacySettings) => ({
      ...previous,
      customRules: (previous.customRules ?? []).map((rule) =>
        targets.has(rule.id) ? { ...rule, enabled: checked } : rule,
      ),
    }));
  };

  // 编辑器保存已由 Rust 落库，这里同步表单与基线，避免自动保存重复写入。
  const handleCustomRulesSaved = (saved: PrivacyCustomRule[]): void => {
    setForm((previous: PrivacySettings) => ({
      ...previous,
      customRules: saved,
    }));
    setLastSaved((previous: PrivacySettings) => ({
      ...previous,
      customRules: saved,
    }));
    setIsRulesEditorOpen(false);
    setStatus(
      t("settings.privacyCustomSaved", {
        defaultValue: "Custom rules saved.",
      }),
    );
  };

  const saveSettings = useCallback(
    async (settings: PrivacySettings) => {
      setIsSaving(true);
      setError("");
      try {
        const normalized = normalizePrivacySettings(settings);
        await window.snow.setPrivacySettings(normalized);
        if (isMountedRef.current) {
          setForm(normalized);
          setLastSaved(normalized);
          setStatus(
            t("settings.privacySaveSuccess", {
              defaultValue: "Privacy settings saved.",
            }),
          );
        }
      } catch (e) {
        if (isMountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.privacySaveError", {
                  defaultValue: "Failed to save privacy settings",
                }),
          );
        }
      } finally {
        if (isMountedRef.current) {
          setIsSaving(false);
        }
      }
    },
    [t],
  );

  // 修改即保存：表单变化后 debounce 保存，卸载时立即冲刷避免丢失。
  const saveValue = useMemo(
    () => computePrivacySaveValue(form, lastSaved, isLoading),
    [form, lastSaved, isLoading],
  );
  useDebouncedAutoSave(saveValue, saveSettings, SAVE_DEBOUNCE_MS);

  const handleReset = (): void => {
    // 重置不清空用户自定义规则。
    const next = { ...DEFAULT_PRIVACY_SETTINGS, customRules: form.customRules };
    setForm(next);
    setError("");
    setStatus("");
    // 立即持久化默认隐私设置，避免 debounce 窗口内退出导致保存丢失。
    void saveSettings(next);
  };

  return (
    <div className="api-settings-page" role="region">
      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div className="import-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "tools"}
          className={`import-settings-tab ${activeTab === "tools" ? "active" : ""}`}
          onClick={() => setActiveTab("tools")}
        >
          <Wrench size={13} strokeWidth={1.8} />
          {t("settings.privacyTabTools", { defaultValue: "Tool filtering" })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "rules"}
          className={`import-settings-tab ${activeTab === "rules" ? "active" : ""}`}
          onClick={() => setActiveTab("rules")}
        >
          <KeyRound size={13} strokeWidth={1.8} />
          {t("settings.privacyTabRules", { defaultValue: "Masking rules" })}
        </button>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {activeTab === "tools"
              ? t("settings.privacyManualTitle", {
                  defaultValue: "Filter configuration",
                })
              : t("settings.privacyRulesTitle", {
                  defaultValue: "Masking rules",
                })}
          </strong>
          <span>
            {activeTab === "tools"
              ? t("settings.privacyManualInfo", {
                  defaultValue:
                    "These values are stored locally and used to redact tool results before they are sent to the model.",
                })
              : t("settings.privacyRulesTabInfo", {
                  defaultValue:
                    "Toggle built-in rules and manage your own regex rules. Custom rules also apply after the online API.",
                })}
          </span>
        </div>

        <div className="api-settings-form-body">
          {!form.enabled ? (
            <div className="privacy-disabled-hint">
              {t("settings.privacyDisabledHint", {
                defaultValue:
                  "Privacy filtering is off. The filter mode, tool selection and rules below stay inactive until you turn it on.",
              })}
            </div>
          ) : null}
          {activeTab === "tools" ? (
            <>
              <div className="api-settings-form-section">
                <div className="api-settings-form-section-header">
                  <strong className="api-settings-form-section-title">
                    {t("settings.privacyEnable", {
                      defaultValue: "Enable privacy filter",
                    })}
                  </strong>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => updateEnabled(event.target.checked)}
                      disabled={isBusy}
                      hidden
                    />
                    <span className="toggle-slider" />
                    <span>
                      {form.enabled
                        ? t("settings.enabled", { defaultValue: "Enabled" })
                        : t("settings.disabled", {
                            defaultValue: "Disabled",
                          })}
                    </span>
                  </label>
                </div>
                <span className="settings-item-description">
                  {t("settings.privacyEnableInfo", {
                    defaultValue:
                      "Redact sensitive data (API keys, tokens, IDs, cards) from selected tool results before sending to the model.",
                  })}
                </span>
              </div>

              <div className="api-settings-form-section">
                <div className="api-settings-form-section-header">
                  <strong className="api-settings-form-section-title">
                    {t("settings.privacyMode", {
                      defaultValue: "Filter mode",
                    })}
                  </strong>
                </div>
                <div className="api-settings-form-grid">
                  <CustomSelect
                    value={form.mode}
                    options={modeOptions}
                    onChange={updateMode}
                    disabled={isConfigDisabled}
                  />
                </div>
                <span className="settings-item-description">
                  {form.mode === "api"
                    ? t("settings.privacyModeApiInfo", {
                        defaultValue:
                          "Send tool results to a configured privacy filter API for redaction.",
                      })
                    : t("settings.privacyModeLocalInfo", {
                        defaultValue:
                          "Use built-in Rust regex rules for redaction. No external service required.",
                      })}
                </span>
              </div>

              {form.mode === "api" && (
                <div className="api-settings-form-section">
                  <div className="api-settings-form-section-header">
                    <strong className="api-settings-form-section-title">
                      {t("settings.privacyApiConfig", {
                        defaultValue: "API configuration",
                      })}
                    </strong>
                  </div>
                  <span className="settings-item-description">
                    {t("settings.privacyApiConfigInfo", {
                      defaultValue:
                        "Configure the online privacy filter API endpoint.",
                    })}
                  </span>
                  <span className="privacy-api-reference">
                    {t("settings.privacyApiDeployHint", {
                      defaultValue:
                        "No endpoint yet? Self-host it with this reference project:",
                    })}
                    <button
                      type="button"
                      className="privacy-api-reference-link"
                      title={PRIVACY_FILTER_API_REPO_URL}
                      onClick={() =>
                        window.open(PRIVACY_FILTER_API_REPO_URL, "_blank")
                      }
                    >
                      {PRIVACY_FILTER_API_REPO_URL.replace(
                        "https://github.com/",
                        "",
                      )}
                      <ExternalLink
                        size={12}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </button>
                  </span>
                  <div className="api-settings-form-grid">
                    <label className="api-settings-field wide">
                      <span>
                        {t("settings.privacyUrlLabel", {
                          defaultValue: "URL",
                        })}
                      </span>
                      <input
                        value={form.api.url}
                        onChange={updateApiField("url")}
                        placeholder={t("settings.privacyUrlPlaceholder", {
                          defaultValue: "https://example.com/privacy-filter",
                        })}
                        disabled={isConfigDisabled}
                      />
                    </label>
                    <label className="api-settings-field wide">
                      <span>
                        {t("settings.privacyApiKeyLabel", {
                          defaultValue: "API key (optional)",
                        })}
                      </span>
                      <input
                        value={form.api.apiKey}
                        onChange={updateApiField("apiKey")}
                        placeholder={t("settings.privacyApiKeyPlaceholder", {
                          defaultValue: "Leave empty if not required",
                        })}
                        type="password"
                        disabled={isConfigDisabled}
                      />
                    </label>
                    <label className="api-settings-field wide">
                      <span>
                        {t("settings.privacyModelLabel", {
                          defaultValue: "Model",
                        })}
                      </span>
                      <input
                        value={form.api.model}
                        onChange={updateApiField("model")}
                        placeholder={t("settings.privacyModelPlaceholder", {
                          defaultValue: "openai/privacy-filter",
                        })}
                        disabled={isConfigDisabled}
                      />
                    </label>
                  </div>
                </div>
              )}

              <div className="api-settings-form-section">
                <div className="api-settings-form-section-header">
                  <strong className="api-settings-form-section-title">
                    {t("settings.privacyToolResults", {
                      defaultValue: "Tool results to filter",
                    })}
                  </strong>
                  <span className="privacy-option-count">
                    {t("settings.privacyToolsSelected", {
                      defaultValue: "{{count}} selected",
                      values: { count: form.toolResults.tools.length },
                    })}
                  </span>
                </div>
                <span className="settings-item-description">
                  {t("settings.privacyToolResultsInfo", {
                    defaultValue:
                      "Select which tool results should be redacted before reaching the model.",
                  })}
                </span>
                <label className="privacy-tool-search">
                  <Search size={14} />
                  <input
                    value={toolQuery}
                    onChange={(event) => setToolQuery(event.target.value)}
                    placeholder={t("settings.privacyToolSearchPlaceholder", {
                      defaultValue: "Search tools by name or description",
                    })}
                  />
                </label>
                {catalogError ? (
                  <div className="sub-agent-tool-state is-error">
                    <AlertCircle size={15} />
                    <span>{catalogError}</span>
                  </div>
                ) : null}
                {isCatalogLoading ? (
                  <div className="sub-agent-tool-state">
                    <Loader2 className="spin" size={15} />
                    <span>
                      {t("settings.subAgentToolsLoading", {
                        defaultValue: "Loading MCP tools...",
                      })}
                    </span>
                  </div>
                ) : toolGroups.length === 0 ? (
                  <div className="sub-agent-tool-state">
                    <span>
                      {t("settings.privacyToolsEmpty", {
                        defaultValue: "No matching MCP tools.",
                      })}
                    </span>
                  </div>
                ) : (
                  <PrivacyToggleList
                    groups={toolGroups}
                    icon={Wrench}
                    disabled={isConfigDisabled}
                    defaultCollapsed={!toolQuery.trim()}
                    onToggle={(id, checked) => setToolsChecked([id], checked)}
                    onToggleGroup={setToolsChecked}
                  />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="api-settings-form-section">
                <div className="api-settings-form-section-header">
                  <strong className="api-settings-form-section-title">
                    {t("settings.privacyRules", {
                      defaultValue: "Local masking rules",
                    })}
                  </strong>
                </div>
                <span className="settings-item-description">
                  {t("settings.privacyRulesInfo", {
                    defaultValue:
                      "Choose which kinds of sensitive data the local rules redact. Also applies when the online API falls back to local rules.",
                  })}
                </span>
                {ruleGroups.length > 0 ? (
                  <PrivacyToggleList
                    groups={ruleGroups}
                    icon={KeyRound}
                    disabled={isConfigDisabled}
                    onToggle={(id, checked) => setRulesChecked([id], checked)}
                    onToggleGroup={setRulesChecked}
                  />
                ) : (
                  <div className="sub-agent-tool-state">
                    <Loader2 className="spin" size={15} />
                    <span>
                      {t("settings.privacyLoading", {
                        defaultValue: "Loading privacy settings...",
                      })}
                    </span>
                  </div>
                )}
              </div>

              <div className="api-settings-form-section">
                <div className="api-settings-form-section-header">
                  <strong className="api-settings-form-section-title">
                    {t("settings.privacyCustomRules", {
                      defaultValue: "Custom rules",
                    })}
                  </strong>
                  <button
                    className="api-settings-action-btn secondary"
                    onClick={() => setIsRulesEditorOpen(true)}
                    type="button"
                    disabled={isConfigDisabled}
                  >
                    <FilePenLine size={15} strokeWidth={1.9} />
                    <span>
                      {t("settings.privacyCustomEdit", {
                        defaultValue: "Edit rules",
                      })}
                    </span>
                  </button>
                </div>
                <span className="settings-item-description">
                  {t("settings.privacyCustomRulesInfo", {
                    defaultValue:
                      "Define your own regex rules to mask project-specific data such as internal hosts or employee IDs. You can also ask the AI to write them via the config tool.",
                  })}
                </span>
                {customGroups.length > 0 ? (
                  <PrivacyToggleList
                    groups={customGroups}
                    icon={Regex}
                    disabled={isConfigDisabled}
                    onToggle={(id, checked) =>
                      setCustomRulesChecked([id], checked)
                    }
                    onToggleGroup={setCustomRulesChecked}
                  />
                ) : (
                  <div className="sub-agent-tool-state">
                    <span>
                      {t("settings.privacyCustomEmpty", {
                        defaultValue:
                          'No custom rules yet. Click "Edit rules" to add some.',
                      })}
                    </span>
                  </div>
                )}
              </div>

              <div className="api-settings-form-section">
                <div className="api-settings-form-section-header">
                  <strong className="api-settings-form-section-title">
                    {t("settings.privacyPreview", {
                      defaultValue: "Test masking",
                    })}
                  </strong>
                </div>
                <span className="settings-item-description">
                  {t("settings.privacyPreviewInfo", {
                    defaultValue:
                      "Paste sample text to preview the local rules (built-in and custom) using the current switches.",
                  })}
                </span>
                <textarea
                  className="privacy-preview-input"
                  value={previewSample}
                  onChange={(event) => setPreviewSample(event.target.value)}
                  placeholder={t("settings.privacyPreviewPlaceholder", {
                    defaultValue: "Paste text containing sensitive data...",
                  })}
                  rows={4}
                  spellCheck={false}
                  disabled={isConfigDisabled}
                />
                {previewError ? (
                  <div className="sub-agent-tool-state is-error">
                    <AlertCircle size={15} />
                    <span>{previewError}</span>
                  </div>
                ) : previewSample ? (
                  <div className="privacy-preview-output">
                    <ScanEye size={14} />
                    <pre>{previewOutput}</pre>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>

        <div className="api-settings-form-actions">
          <button
            className="api-settings-form-btn secondary"
            onClick={handleReset}
            type="button"
            disabled={isBusy}
          >
            <RotateCcw size={15} strokeWidth={1.9} />
            <span>{t("settings.reset", { defaultValue: "Reset" })}</span>
          </button>
        </div>
      </div>

      {isRulesEditorOpen ? (
        <PrivacyCustomRulesModal
          rules={customRules}
          onClose={() => setIsRulesEditorOpen(false)}
          onSaved={handleCustomRulesSaved}
        />
      ) : null}
    </div>
  );
}

const formatCustomRuleSubtitle = (rule: PrivacyCustomRule): string => {
  const target = rule.group > 0 ? ` [#${rule.group}]` : "";
  const replacement = rule.replacement ? ` -> ${rule.replacement}` : "";
  return `${rule.pattern}${target}${replacement}`;
};

const toCustomRules = (value: unknown): PrivacyCustomRule[] =>
  Array.isArray(value)
    ? value.filter(isRecord).map((item) => ({
        id: toText(item.id),
        name: toText(item.name),
        pattern: toText(item.pattern),
        group: typeof item.group === "number" ? item.group : 0,
        replacement: toText(item.replacement),
        enabled: item.enabled !== false,
      }))
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const toNameList = (value: unknown, migrate?: (name: string) => string) =>
  Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .map((item) =>
              typeof item === "string"
                ? (migrate ?? ((name: string) => name))(item.trim())
                : "",
            )
            .filter((item) => item.length > 0),
        ),
      )
    : null;

const normalizePrivacySettings = (value: unknown): PrivacySettings => {
  const source = isRecord(value) ? value : {};
  const apiSource = isRecord(source.api) ? source.api : {};
  const toolResultsSource = isRecord(source.toolResults)
    ? source.toolResults
    : {};

  const tools =
    toNameList(toolResultsSource.tools, migratePrivacyToolName) ??
    DEFAULT_PRIVACY_SETTINGS.toolResults.tools;
  const disabledRules = toNameList(source.disabledRules) ?? [];

  const mode = toText(source.mode).trim() || DEFAULT_PRIVACY_SETTINGS.mode;

  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_PRIVACY_SETTINGS.enabled,
    mode,
    api: {
      url: toText(apiSource.url).trim(),
      apiKey: toText(apiSource.apiKey).trim(),
      model:
        toText(apiSource.model).trim() || DEFAULT_PRIVACY_SETTINGS.api.model,
    },
    toolResults: { tools },
    disabledRules,
    customRules: toCustomRules(source.customRules),
  };
};
