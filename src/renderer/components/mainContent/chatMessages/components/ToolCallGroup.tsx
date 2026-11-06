import { ChevronRight, CircleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../../../i18n";
import { resolveLocalized } from "../../../../plugins/manifest";
import { usePluginStore } from "../../../../plugins/pluginStore";
import { useSharedPluginToolOwner } from "../../../../plugins/pluginToolIndex";
import { PluginIcon } from "../../../common/PluginIcon";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { MessageTimestamp } from "./MessageTimestamp";

type ToolCallGroupProps = {
  /** Number of tool calls in this group. */
  count: number;
  /** Group 内工具调用列表，用于提取并展示调用的插件信息 */
  toolCalls?: ToolCallInfo[];
  timestamp?: string;
  /** Whether any tool in the group is still running. */
  isRunning?: boolean;
  /** Whether any tool encountered an error */
  hasError?: boolean;
  /** The tool call nodes. */
  children: ReactNode;
};

export const ToolCallGroup = ({
  count,
  toolCalls,
  timestamp,
  isRunning = false,
  hasError = false,
  children,
}: ToolCallGroupProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const [isOpen, setIsOpen] = useState(true);

  const toolNames = useMemo(
    () => toolCalls?.map((tc) => tc.name) ?? [],
    [toolCalls],
  );
  const ownerPluginId = useSharedPluginToolOwner(toolNames);
  const pluginsState = usePluginStore();
  const involvedPlugins = useMemo(() => {
    if (!ownerPluginId) return [];
    const plugin = pluginsState.plugins.find(
      (plugin) => plugin.pluginId === ownerPluginId,
    );
    return plugin ? [plugin] : [];
  }, [ownerPluginId, pluginsState.plugins]);

  const label = isRunning
    ? t("toolCall.group.runningSteps", {
        defaultValue: "{{count}} steps",
        values: { count },
      })
    : t("toolCall.group.steps", {
        defaultValue: "{{count}} steps",
        values: { count },
      });

  return (
    <div className={`tcg${hasError ? " tcg--has-error" : ""}`}>
      <button
        type="button"
        className="tcg-toggle"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
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
                <PluginIcon
                  icon={plugin.icon}
                  pluginId={plugin.pluginId}
                  size={11}
                  className="tcg-plugin-icon"
                />
                <span className="tcg-plugin-name">
                  {resolveLocalized(plugin.name, locale) || plugin.pluginId}
                </span>
              </span>
            ))}
          </span>
        )}
        {/* 自带一层容器，避免 Tooltip 的 wrapper 成为 toggle 的 flex 子项 */}
        <span className="tcg-time">
          <MessageTimestamp timestamp={timestamp} />
        </span>
        {hasError ? (
          <CircleAlert
            size={12}
            className="tcg-status-icon tcg-alert"
            aria-hidden="true"
          />
        ) : null}
        <ChevronRight
          className={`tcg-chevron${isOpen ? " tcg-chevron--open" : ""}`}
          size={12}
          aria-hidden="true"
        />
      </button>
      {/* 列表常挂载（收起时由 .tcg-collapse 折叠为 0 高度），
          这样展开/收起都能走 grid-rows 高度过渡动画，而非瞬间闪现。 */}
      <div className={`tcg-collapse${isOpen ? " is-open" : ""}`}>
        <div className="tcg-list">{children}</div>
      </div>
    </div>
  );
};
