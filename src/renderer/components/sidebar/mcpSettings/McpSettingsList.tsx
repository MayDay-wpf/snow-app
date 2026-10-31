import {
  ChevronRight,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../i18n";
import { resolveToolDisplayName } from "../../mainContent/chatMessages/toolCalls/shared/toolDisplayName";
import type { McpServerTool } from "./types";

export type McpSettingsListItem = {
  serverId: string;
  name: string;
  enabled: boolean;
  globalEnabled: boolean;
  detail: string;
  canManage: boolean;
};

const formatToolSchema = (inputSchemaJson: string): string => {
  try {
    return JSON.stringify(JSON.parse(inputSchemaJson), null, 2);
  } catch {
    return inputSchemaJson || "{}";
  }
};

type McpSettingsListProps = {
  servers: McpSettingsListItem[];
  isBusy: boolean;
  listTitle: string;
  emptyMessage: string;
  toolsByServerId: Readonly<Record<string, readonly McpServerTool[]>>;
  fetchingToolServerIds: ReadonlySet<string>;
  onToggleEnabled: (server: McpSettingsListItem) => void;
  onFetchTools: (server: McpSettingsListItem) => void;
  onToggleTool: (
    server: McpSettingsListItem,
    tool: McpServerTool,
    enabled: boolean,
  ) => void;
  onToggleAllTools: (server: McpSettingsListItem, enabled: boolean) => void;
  onEdit: (server: McpSettingsListItem) => void;
  onDelete: (server: McpSettingsListItem) => void;
};

export function McpSettingsList({
  servers,
  isBusy,
  listTitle,
  emptyMessage,
  toolsByServerId,
  fetchingToolServerIds,
  onToggleEnabled,
  onFetchTools,
  onToggleTool,
  onToggleAllTools,
  onEdit,
  onDelete,
}: McpSettingsListProps): React.JSX.Element {
  const { t } = useI18n();
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [toolFilters, setToolFilters] = useState<Record<string, string>>({});
  const [expandedToolNames, setExpandedToolNames] = useState<
    Record<string, Set<string>>
  >(() => ({}));

  const toggleServerExpanded = (server: McpSettingsListItem): void => {
    setExpandedServerIds((previous) => {
      const next = new Set(previous);
      if (next.has(server.serverId)) {
        next.delete(server.serverId);
      } else {
        next.add(server.serverId);
      }
      return next;
    });
  };

  const setToolFilter = (serverId: string, value: string): void => {
    setToolFilters((previous) => ({ ...previous, [serverId]: value }));
  };

  const toggleToolExpanded = (serverId: string, toolName: string): void => {
    setExpandedToolNames((previous) => {
      const current = previous[serverId] ?? new Set<string>();
      const next = new Set(current);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return { ...previous, [serverId]: next };
    });
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">{listTitle}</strong>
      </div>

      <div className="system-prompt-list mcp-server-list">
        {servers.length === 0 ? (
          <div className="system-prompt-empty">{emptyMessage}</div>
        ) : (
          servers.map((server) => {
            const globallyUnavailable = !server.globalEnabled;
            const activeLabel = globallyUnavailable
              ? t("settings.mcpGloballyDisabled", {
                  defaultValue: "Disabled in global scope",
                })
              : server.enabled
                ? t("settings.mcpDisableServer", { defaultValue: "Disable" })
                : t("settings.mcpEnableServer", { defaultValue: "Enable" });
            const activeStateLabel = globallyUnavailable
              ? t("settings.mcpGlobalDisabledShort", {
                  defaultValue: "Global off",
                })
              : server.enabled
                ? t("settings.active", { defaultValue: "Active" })
                : t("settings.inactive", { defaultValue: "Inactive" });
            const isFetchingTools = fetchingToolServerIds.has(server.serverId);
            const tools = toolsByServerId[server.serverId];
            const toolCount = tools?.length;
            const isExpanded = expandedServerIds.has(server.serverId);
            const toolFilter = toolFilters[server.serverId] ?? "";
            const normalizedFilter = toolFilter.trim().toLowerCase();
            const filteredTools = (tools ?? []).filter(
              (tool) =>
                !normalizedFilter ||
                resolveToolDisplayName(t, tool.name)
                  .toLowerCase()
                  .includes(normalizedFilter) ||
                tool.description.toLowerCase().includes(normalizedFilter),
            );
            const fetchToolsLabel = t("settings.mcpFetchTools", {
              defaultValue: "Fetch tools",
            });

            return (
              <div
                key={server.serverId}
                className={`system-prompt-item ${
                  server.enabled && server.globalEnabled ? "active" : ""
                }`}
              >
                <div className="system-prompt-item-main">
                  <label
                    className="toggle-switch system-prompt-switch"
                    aria-label={activeLabel}
                    title={activeLabel}
                  >
                    <input
                      type="checkbox"
                      checked={server.enabled && !globallyUnavailable}
                      onChange={() => onToggleEnabled(server)}
                      disabled={isBusy || globallyUnavailable}
                      hidden
                    />
                    <span className="toggle-slider" />
                    <span>{activeStateLabel}</span>
                  </label>
                  <div className="system-prompt-item-info">
                    <strong>{server.name}</strong>
                    <span title={server.detail}>{server.detail || "-"}</span>
                  </div>
                </div>
                <div className="system-prompt-item-actions">
                  <button
                    className="mcp-tools-count-button"
                    onClick={() => {
                      if (tools === undefined) {
                        onFetchTools(server);
                      }
                      toggleServerExpanded(server);
                    }}
                    type="button"
                    aria-label={fetchToolsLabel}
                    title={fetchToolsLabel}
                    disabled={isBusy || isFetchingTools}
                  >
                    {isFetchingTools ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <Wrench size={13} strokeWidth={1.9} />
                    )}
                    <span>{toolCount ?? "-"}</span>
                  </button>
                  {server.canManage && (
                    <>
                      <button
                        className="icon-btn ghost"
                        onClick={() => onEdit(server)}
                        type="button"
                        aria-label={t("settings.edit", {
                          defaultValue: "Edit",
                        })}
                        title={t("settings.edit", { defaultValue: "Edit" })}
                        disabled={isBusy}
                      >
                        <Pencil size={14} strokeWidth={1.9} />
                      </button>
                      <button
                        className="icon-btn ghost danger"
                        onClick={() => onDelete(server)}
                        type="button"
                        aria-label={t("settings.delete", {
                          defaultValue: "Delete",
                        })}
                        title={t("settings.delete", { defaultValue: "Delete" })}
                        disabled={isBusy}
                      >
                        <Trash2 size={14} strokeWidth={1.9} />
                      </button>
                    </>
                  )}
                </div>

                {isExpanded && (
                  <div className="mcp-server-expanded">
                    <div className="mcp-server-expanded-header">
                      <div className="mcp-tool-details-search">
                        <Search size={12} strokeWidth={1.9} />
                        <input
                          type="text"
                          value={toolFilter}
                          onChange={(event) =>
                            setToolFilter(server.serverId, event.target.value)
                          }
                          placeholder={t("settings.mcpToolFilterPlaceholder", {
                            defaultValue: "Filter tools by name or description",
                          })}
                        />
                        {toolFilter && (
                          <button
                            type="button"
                            className="mcp-tool-details-search-clear"
                            onClick={() => setToolFilter(server.serverId, "")}
                            title={t("settings.mcpToolFilterClear", {
                              defaultValue: "Clear filter",
                            })}
                          >
                            <X size={12} strokeWidth={1.9} />
                          </button>
                        )}
                      </div>
                      <div className="mcp-server-expanded-bulk">
                        <button
                          type="button"
                          className="api-settings-form-btn secondary compact"
                          onClick={() => onToggleAllTools(server, true)}
                          disabled={
                            isBusy || !server.enabled || globallyUnavailable
                          }
                        >
                          {t("settings.mcpToolsEnableAll", {
                            defaultValue: "Enable all",
                          })}
                        </button>
                        <button
                          type="button"
                          className="api-settings-form-btn secondary compact"
                          onClick={() => onToggleAllTools(server, false)}
                          disabled={
                            isBusy || !server.enabled || globallyUnavailable
                          }
                        >
                          {t("settings.mcpToolsDisableAll", {
                            defaultValue: "Disable all",
                          })}
                        </button>
                      </div>
                    </div>

                    {isFetchingTools ? (
                      <div className="mcp-server-expanded-state">
                        <Loader2 size={14} className="spin" />
                      </div>
                    ) : !tools || tools.length === 0 ? (
                      <div className="mcp-tool-details-empty">
                        {t("settings.mcpToolDetailsEmpty", {
                          defaultValue: "This server did not return any tools.",
                        })}
                      </div>
                    ) : filteredTools.length === 0 ? (
                      <div className="mcp-tool-details-empty">
                        {t("settings.mcpToolFilterEmpty", {
                          defaultValue: "No tools match the current filter.",
                        })}
                      </div>
                    ) : (
                      <div className="mcp-server-expanded-tools">
                        {filteredTools.map((tool) => {
                          const isToolExpanded =
                            expandedToolNames[server.serverId]?.has(
                              tool.name,
                            ) ?? false;
                          const toolGloballyDisabled =
                            tool.globalEnabled === false;
                          const toolToggleLabel = toolGloballyDisabled
                            ? t("settings.mcpToolGlobalDisabled", {
                                defaultValue:
                                  "Disabled in global settings; the project toggle cannot override it.",
                              })
                            : tool.enabled
                              ? t("settings.mcpToolDisable", {
                                  defaultValue: "Disable tool",
                                })
                              : t("settings.mcpToolEnable", {
                                  defaultValue: "Enable tool",
                                });
                          const detailsLabel = isToolExpanded
                            ? t("settings.mcpToolDetailsCollapse", {
                                defaultValue: "Collapse details",
                              })
                            : t("settings.mcpToolDetailsExpand", {
                                defaultValue: "View tool details",
                              });
                          return (
                            <div className="mcp-tool-row" key={tool.name}>
                              <button
                                type="button"
                                className="mcp-tool-row-main"
                                aria-expanded={isToolExpanded}
                                aria-label={detailsLabel}
                                title={detailsLabel}
                                onClick={() =>
                                  toggleToolExpanded(server.serverId, tool.name)
                                }
                              >
                                <Wrench size={14} strokeWidth={1.9} />
                                <div className="mcp-tool-row-content">
                                  <strong>
                                    {resolveToolDisplayName(t, tool.name)}
                                  </strong>
                                  <span>{tool.description || "-"}</span>
                                </div>
                                <ChevronRight
                                  size={13}
                                  strokeWidth={1.9}
                                  className="mcp-tool-row-chevron"
                                />
                              </button>
                              <label
                                className="toggle-switch"
                                aria-label={toolToggleLabel}
                                title={toolToggleLabel}
                              >
                                <input
                                  type="checkbox"
                                  checked={tool.enabled}
                                  disabled={
                                    isBusy ||
                                    !server.globalEnabled ||
                                    !server.enabled ||
                                    toolGloballyDisabled
                                  }
                                  hidden
                                  onChange={(event) =>
                                    onToggleTool(
                                      server,
                                      tool,
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-slider" />
                              </label>
                              {isToolExpanded && (
                                <div className="mcp-tool-row-details">
                                  {tool.description ? (
                                    <p>{tool.description}</p>
                                  ) : null}
                                  <div className="mcp-tool-row-schema">
                                    <span>
                                      {t("settings.mcpToolSchemaTitle", {
                                        defaultValue: "Input schema",
                                      })}
                                    </span>
                                    <pre>
                                      {formatToolSchema(tool.inputSchemaJson)}
                                    </pre>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
