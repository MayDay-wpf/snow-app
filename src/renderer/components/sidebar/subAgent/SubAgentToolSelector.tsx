import { ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../i18n";
import { resolveToolDisplayName } from "../../mainContent/chatMessages/toolCalls/shared/toolDisplayName";
import { McpSearchInput, matchesMcpQuery } from "../mcpSettings/McpSearchInput";
import { usesAllTools } from "./subAgentUtils";
import type { SubAgentToolOption } from "./types";

type SubAgentToolSelectorProps = {
  toolOptions: SubAgentToolOption[];
  toolNames: string[];
  isBusy: boolean;
  onChange: (toolNames: string[]) => void;
};

export function SubAgentToolSelector({
  toolOptions,
  toolNames,
  isBusy,
  onChange,
}: SubAgentToolSelectorProps): React.JSX.Element {
  const { t } = useI18n();
  const [toolQuery, setToolQuery] = useState("");
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedSearchServerIds, setCollapsedSearchServerIds] = useState<
    Set<string>
  >(() => new Set());
  const isSearching = toolQuery.trim().length > 0;
  const selectedToolNames = new Set(
    usesAllTools(toolNames) ? toolOptions.map((tool) => tool.name) : toolNames,
  );
  const groups = new Map<
    string,
    { serverId: string; serverName: string; tools: SubAgentToolOption[] }
  >();
  for (const tool of toolOptions) {
    const group = groups.get(tool.serverId);
    if (group) {
      group.tools.push(tool);
    } else {
      groups.set(tool.serverId, {
        serverId: tool.serverId,
        serverName: tool.serverName,
        tools: [tool],
      });
    }
  }
  const visibleGroups = Array.from(groups.values())
    .map((group) => ({
      ...group,
      visibleTools: group.tools.filter((tool) =>
        matchesMcpQuery(
          toolQuery,
          resolveToolDisplayName(t, tool.name),
          tool.serverName,
          tool.description,
        ),
      ),
    }))
    .filter((group) => group.visibleTools.length > 0);

  const setToolsSelected = (
    tools: readonly SubAgentToolOption[],
    enabled: boolean,
  ): void => {
    const selected = new Set(selectedToolNames);
    for (const tool of tools) {
      if (enabled) {
        selected.add(tool.name);
      } else {
        selected.delete(tool.name);
      }
    }
    onChange(Array.from(selected));
  };

  const toggleExpanded = (serverId: string): void => {
    const update = (previous: Set<string>): Set<string> => {
      const next = new Set(previous);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    };
    if (isSearching) {
      setCollapsedSearchServerIds(update);
    } else {
      setExpandedServerIds(update);
    }
  };

  return (
    <div className="sub-agent-tool-selector">
      <McpSearchInput
        value={toolQuery}
        onChange={(value) => {
          setToolQuery(value);
          setCollapsedSearchServerIds(new Set());
        }}
        placeholder={t("settings.subAgentToolSearchPlaceholder")}
      />
      {visibleGroups.length === 0 ? (
        <div className="sub-agent-tool-state">
          <span>{t("settings.subAgentToolSearchEmpty")}</span>
        </div>
      ) : (
        <div className="sub-agent-tool-selector-groups">
          {visibleGroups.map((group) => {
            const isExpanded = isSearching
              ? !collapsedSearchServerIds.has(group.serverId)
              : expandedServerIds.has(group.serverId);
            const selectedCount = group.tools.filter((tool) =>
              selectedToolNames.has(tool.name),
            ).length;
            const visibleSelectedCount = group.visibleTools.filter((tool) =>
              selectedToolNames.has(tool.name),
            ).length;
            const allVisibleSelected =
              visibleSelectedCount === group.visibleTools.length;
            const bulkLabel = isSearching
              ? allVisibleSelected
                ? t("settings.subAgentToolDeselectMatches")
                : t("settings.subAgentToolSelectMatches")
              : allVisibleSelected
                ? t("sidebar.chatMultiSelectDeselectAll")
                : t("common.selectAll");
            return (
              <div
                className="sub-agent-tool-selector-group"
                key={group.serverId}
              >
                <div className="sub-agent-tool-selector-header">
                  <button
                    type="button"
                    className="sub-agent-tool-selector-expand"
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpanded(group.serverId)}
                    title={group.serverName}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                    <strong>{group.serverName}</strong>
                    <span className="sub-agent-tool-selector-count">
                      {t("settings.subAgentToolSelectedCount", {
                        values: {
                          selected: selectedCount,
                          total: group.tools.length,
                        },
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="api-settings-form-btn secondary compact"
                    disabled={isBusy}
                    aria-label={`${group.serverName}: ${bulkLabel}`}
                    aria-pressed={
                      allVisibleSelected
                        ? true
                        : visibleSelectedCount > 0
                          ? "mixed"
                          : false
                    }
                    onClick={() =>
                      setToolsSelected(group.visibleTools, !allVisibleSelected)
                    }
                  >
                    {bulkLabel}
                  </button>
                </div>
                {isExpanded ? (
                  <div className="sub-agent-tool-selector-tools">
                    {group.visibleTools.map((tool) => (
                      <label
                        className="sub-agent-tool-option toggle-switch"
                        key={tool.name}
                      >
                        <input
                          type="checkbox"
                          checked={selectedToolNames.has(tool.name)}
                          disabled={isBusy}
                          aria-label={resolveToolDisplayName(t, tool.name)}
                          onChange={(event) =>
                            setToolsSelected([tool], event.target.checked)
                          }
                        />
                        <span className="toggle-slider" />
                        <Wrench size={14} aria-hidden="true" />
                        <span className="sub-agent-tool-option-content">
                          <span className="sub-agent-tool-option-title">
                            <strong>
                              {resolveToolDisplayName(t, tool.name)}
                            </strong>
                            {tool.projectDisabled ? (
                              <span
                                className="sub-agent-tool-badge"
                                title={t(
                                  "settings.subAgentToolProjectDisabledTitle",
                                )}
                              >
                                {t("settings.subAgentToolProjectDisabledBadge")}
                              </span>
                            ) : null}
                          </span>
                          {tool.description ? (
                            <small title={tool.description}>
                              {tool.description}
                            </small>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
