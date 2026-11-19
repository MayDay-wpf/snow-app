import { ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../../../i18n";
import { resolveLocalized } from "../../../../plugins/manifest";
import { usePluginStore } from "../../../../plugins/pluginStore";
import { useSharedPluginToolOwner } from "../../../../plugins/pluginToolIndex";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { describeToolRunHeader } from "../utils/toolActivitySummary";
import { useToolCardStyle } from "../../../../utils/toolCardStyle";
import { MessageTimestamp } from "./MessageTimestamp";
import {
  ENTER_MS,
  EntranceProvider,
  useEntrance,
  type EntranceClock,
} from "./EntranceScope";

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
  /** 有需要用户当场处理的卡片（提问 / 授权 / 共享确认）：强制展开。 */
  forceOpen?: boolean;
  /** The tool call nodes. */
  children: ReactNode;
};

/** 与 .tcg-collapse 的 grid 过渡时长一致。 */
const COLLAPSE_MS = 220;
/** 手动展开时逐个浮现的总时长（最大延迟 200ms + 入场 180ms）。 */
const STAGGER_MS = 400;

export const ToolCallGroup = ({
  count,
  toolCalls,
  timestamp,
  isRunning = false,
  hasError = false,
  forceOpen = false,
  children,
}: ToolCallGroupProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const isMinimal = useToolCardStyle() === "minimal";
  // 默认恒展开：没有自动收起，只有用户手动点击才会折叠（提问/授权等交互
  // 卡片等待处理时即使被手动收起也会重新展开）。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const isOpen = forceOpen || (userOpen ?? true);

  // 收起状态不挂载工具卡：极简模式下滚动历史时不必为每个折叠集合重建
  // 几十张卡片（滚动卡涩的主要来源）。展开中或仍在执行的集合保持挂载，
  // 收起动画播完后再卸载。
  const wantBody = isOpen || isRunning;
  const [bodyMounted, setBodyMounted] = useState(wantBody);
  useEffect(() => {
    if (wantBody) {
      setBodyMounted(true);
      return;
    }
    if (!bodyMounted) {
      return;
    }
    const timer = window.setTimeout(() => setBodyMounted(false), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [wantBody, bodyMounted]);

  // 与所在消息同批挂载时整组不再单独播入场。
  const { suppressed: skipEnter, clock } = useEntrance();
  // 手动展开：经典/简洁逐个浮现；极简由列表整体淡入，卡片不再单独入场。
  const [expandClock, setExpandClock] = useState<EntranceClock | null>(null);
  const [staggering, setStaggering] = useState(false);
  const staggerTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(staggerTimerRef.current), []);

  const handleToggle = (): void => {
    const next = !isOpen;
    setUserOpen(next);
    if (!next || bodyMounted) {
      return;
    }
    if (isMinimal) {
      setExpandClock({ until: performance.now() + ENTER_MS });
      return;
    }
    setStaggering(true);
    window.clearTimeout(staggerTimerRef.current);
    staggerTimerRef.current = window.setTimeout(
      () => setStaggering(false),
      STAGGER_MS,
    );
  };

  const childClock =
    expandClock && expandClock.until > clock.until ? expandClock : clock;
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

  // 极简模式标题行：执行中只显示最近一条工具的结果，结束后显示「摘要 · 结果」。
  const latestActivity = useMemo(
    () => (isMinimal && toolCalls ? describeToolRunHeader(toolCalls, t) : ""),
    [isMinimal, toolCalls, t],
  );

  const label = latestActivity
    ? latestActivity
    : isRunning
      ? t("toolCall.group.runningSteps", {
          defaultValue: "{{count}} steps",
          values: { count },
        })
      : t("toolCall.group.steps", {
          defaultValue: "{{count}} steps",
          values: { count },
        });

  // 标题文案就地更新（摘要常驻），不做淡入淡出，避免更新时整行像消失一下。
  return (
    <div
      className={`tcg${hasError ? " tcg--has-error" : ""}${
        skipEnter ? " tcg--no-enter" : ""
      }${staggering ? " is-staggering" : ""}`}
    >
      <button
        type="button"
        className="tcg-toggle"
        onClick={handleToggle}
        aria-expanded={isOpen}
      >
        <span className="tcg-label" title={label}>
          {label}
        </span>
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
      {/* 收起态不挂载工具卡（见 bodyMounted）；展开/收起仍走 grid-rows 过渡。 */}
      <div className={`tcg-collapse${isOpen ? " is-open" : ""}`}>
        <div className="tcg-list">
          <EntranceProvider value={childClock}>
            {bodyMounted || isOpen ? children : null}
          </EntranceProvider>
        </div>
      </div>
    </div>
  );
};
