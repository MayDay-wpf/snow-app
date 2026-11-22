import { ChevronRight, CircleAlert } from "lucide-react";
import { useMemo } from "react";

import { useI18n } from "../../../../i18n";
import { resolveLocalized } from "../../../../plugins/manifest";
import { usePluginStore } from "../../../../plugins/pluginStore";
import { useSharedPluginToolOwner } from "../../../../plugins/pluginToolIndex";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { describeToolRunHeader } from "../utils/toolActivitySummary";

type MinimalToolRunHeaderProps = {
  toolCalls: readonly ToolCallInfo[];
  expanded: boolean;
  onToggle: () => void;
};

/**
 * 极简模式的工具集合标题行。
 *
 * 与经典 / 简洁的 ToolCallGroup 分开：极简集合的展开状态由列表层持有，
 * 这里只渲染标题（摘要 · 最近结果），不携带可折叠的 body。实际工具行由
 * 行模型展开成独立行，单独测量与占位。
 */
export const MinimalToolRunHeader = ({
  toolCalls,
  expanded,
  onToggle,
}: MinimalToolRunHeaderProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const toolNames = useMemo(
    () => toolCalls.map((toolCall) => toolCall.name),
    [toolCalls],
  );
  const ownerPluginId = useSharedPluginToolOwner(toolNames);
  const pluginsState = usePluginStore();
  const involvedPlugins = useMemo(() => {
    if (!ownerPluginId) return [];
    const plugin = pluginsState.plugins.find(
      (entry) => entry.pluginId === ownerPluginId,
    );
    return plugin ? [plugin] : [];
  }, [ownerPluginId, pluginsState.plugins]);

  const label = describeToolRunHeader(toolCalls, t);
  const hasError = toolCalls.some((toolCall) => toolCall.status === "error");

  return (
    <div className="tcg minimal-tool-run-header">
      <button
        type="button"
        className="tcg-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        title={label}
      >
        <span className="tcg-label">{label}</span>
        {involvedPlugins.length > 0 && (
          <span className="tcg-plugins" aria-label="Plugins">
            {involvedPlugins.map((plugin) => (
              <span
                key={plugin.pluginId}
                className="tcg-plugin-chip"
                title={
                  plugin.description
                    ? `${plugin.pluginId}\n${resolveLocalized(plugin.description, locale) || ""}`.trim()
                    : plugin.pluginId
                }
              >
                <span className="tcg-plugin-name">
                  {resolveLocalized(plugin.name, locale) || plugin.pluginId}
                </span>
              </span>
            ))}
          </span>
        )}
        {hasError ? (
          <CircleAlert
            size={12}
            className="tcg-status-icon tcg-alert"
            aria-hidden="true"
          />
        ) : null}
        <ChevronRight
          className={`tcg-chevron${expanded ? " tcg-chevron--open" : ""}`}
          size={12}
          aria-hidden="true"
        />
      </button>
    </div>
  );
};
