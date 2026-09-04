import {
  Brain,
  FilePen,
  MessageSquare,
  Pause,
  Sparkles,
  Square,
  Timer,
  Wrench,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { formatTokens } from "../../utils/formatTokens";
import { useChatConversationContext } from "./chatMessages";
import { collectConversationFileChanges } from "./chatMessages/hooks/fileChangeTracking";

type ChatFloatIslandProps = {
  /** 点击胶囊重新展开悬浮会话卡片 */
  onReopen: () => void;
};

type TickerTone =
  | "thinking"
  | "responding"
  | "tool"
  | "files"
  | "tokens"
  | "elapsed"
  | "aborting"
  | "paused";

type TickerItem = {
  key: string;
  tone: TickerTone;
  icon: ReactNode;
  text: string;
};

// 可视区宽度量化档位与上限：小幅数值变化不跨档，宽度不会高频抖动
const VIEWPORT_WIDTH_STEP = 12;
const VIEWPORT_MAX_WIDTH = 260;
// 垂直轮播：单项行高（需与样式保持一致）、每项停留间隔
const ITEM_HEIGHT_PX = 16;
const CYCLE_INTERVAL_MS = 2400;

const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
};

const fileBasename = (path: string): string => {
  const trimmed = path.replace(/[/\\]+$/, "");
  const separatorIndex = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
};

/**
 * 灵动岛胶囊：右侧面板全屏且悬浮会话卡片被关闭后常驻底部。
 * 空闲态仅一枚图标；流式期间按最宽状态项取档展开为固定单行，
 * 多项状态（思考、工具、文件变更、token、耗时）在行内上下轮播。
 * 状态数据直接取自会话上下文，与悬浮卡片展示的是同一会话。
 */
export const ChatFloatIsland = ({
  onReopen,
}: ChatFloatIslandProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    messages,
    activeConversationId,
    isStreaming,
    isAborting,
    isPaused,
    streamTokenCount,
    streamStartedAt,
    runTokenUsage,
    fileChangeStats,
  } = useChatConversationContext();

  // 流式期间按 streamStartedAt 锚点推进本地耗时（同 StreamMetrics 方案）
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!isStreaming || streamStartedAt <= 0) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - streamStartedAt);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - streamStartedAt);
    }, 500);
    return () => window.clearInterval(timer);
  }, [isStreaming, streamStartedAt]);

  // 最新一条 assistant 消息：思考状态与思考 token 的载体
  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") {
        return messages[i];
      }
    }
    return null;
  }, [messages]);
  const isThinkingLive = Boolean(
    isStreaming && lastAssistant?.isThinkingActive,
  );
  const thinkingTokens = lastAssistant?.thinkingTokenCount ?? 0;

  // 正在执行的工具：从最新消息向前找最近一条 pending/running 调用
  const activeToolCall = useMemo(() => {
    if (!isStreaming) {
      return null;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "assistant" || !message.toolCalls) {
        continue;
      }
      for (let j = message.toolCalls.length - 1; j >= 0; j -= 1) {
        const status = message.toolCalls[j].status;
        if (status === "running" || status === "pending") {
          return message.toolCalls[j];
        }
      }
    }
    return null;
  }, [isStreaming, messages]);

  // 本会话文件变更（含子代理）
  const fileChanges = useMemo(
    () =>
      activeConversationId
        ? collectConversationFileChanges(fileChangeStats, activeConversationId)
        : [],
    [activeConversationId, fileChangeStats],
  );
  // 仅统计本次流式期间的变化：历史轮次的变更不属于当前状态
  const streamFileChanges = useMemo(
    () =>
      streamStartedAt > 0
        ? fileChanges.filter((change) => change.timestamp >= streamStartedAt)
        : [],
    [fileChanges, streamStartedAt],
  );
  const latestStreamFileChange = useMemo(
    () =>
      streamFileChanges.length > 0
        ? streamFileChanges.reduce((latest, item) =>
            item.timestamp >= latest.timestamp ? item : latest,
          )
        : null,
    [streamFileChanges],
  );
  // run 累计用量 + 当前迭代流式探针，近似本次运行的总 token 消耗
  const runTokenTotal = runTokenUsage
    ? runTokenUsage.inputTokens +
      runTokenUsage.outputTokens +
      runTokenUsage.cacheCreationInputTokens +
      runTokenUsage.cacheReadInputTokens
    : 0;
  const liveTokenTotal = runTokenTotal + streamTokenCount;

  // 单行状态项：思考/工具优先，无则显示"生成中"兜底，随后是文件、token、耗时
  const tickerItems = useMemo<TickerItem[]>(() => {
    if (!isStreaming) {
      return [];
    }
    const items: TickerItem[] = [];
    if (isAborting) {
      items.push({
        key: "aborting",
        tone: "aborting",
        icon: <Square size={12} aria-hidden="true" />,
        text: t("chat.float.island.aborting"),
      });
    } else if (isPaused) {
      items.push({
        key: "paused",
        tone: "paused",
        icon: <Pause size={12} aria-hidden="true" />,
        text: t("chat.float.island.paused"),
      });
    }
    if (isThinkingLive) {
      items.push({
        key: "thinking",
        tone: "thinking",
        icon: <Brain size={12} aria-hidden="true" />,
        text:
          thinkingTokens > 0
            ? `${t("chat.float.island.thinking")} · ${formatTokens(thinkingTokens)}`
            : t("chat.float.island.thinking"),
      });
    }
    if (activeToolCall) {
      items.push({
        key: "tool",
        tone: "tool",
        icon: <Wrench size={12} aria-hidden="true" />,
        text: t("chat.float.island.tool", {
          values: { name: activeToolCall.name },
        }),
      });
    }
    if (!isThinkingLive && !activeToolCall && !isAborting && !isPaused) {
      items.push({
        key: "responding",
        tone: "responding",
        icon: <Sparkles size={12} aria-hidden="true" />,
        text: t("chat.float.island.responding"),
      });
    }
    if (streamFileChanges.length > 0) {
      items.push({
        key: "files",
        tone: "files",
        icon: <FilePen size={12} aria-hidden="true" />,
        text: t("chat.float.island.filesChanged", {
          values: { count: streamFileChanges.length },
        }),
      });
      if (latestStreamFileChange) {
        items.push({
          key: "file",
          tone: "files",
          icon: <FilePen size={12} aria-hidden="true" />,
          text: fileBasename(latestStreamFileChange.filePath),
        });
      }
    }
    if (liveTokenTotal > 0) {
      items.push({
        key: "tokens",
        tone: "tokens",
        icon: <Zap size={12} aria-hidden="true" />,
        text: t("chat.float.island.tokens", {
          values: { count: formatTokens(liveTokenTotal) },
        }),
      });
    }
    if (elapsedMs > 0) {
      items.push({
        key: "elapsed",
        tone: "elapsed",
        icon: <Timer size={12} aria-hidden="true" />,
        text: formatElapsed(elapsedMs),
      });
    }
    if (items.length === 0) {
      items.push({
        key: "responding",
        tone: "responding",
        icon: <Sparkles size={12} aria-hidden="true" />,
        text: t("chat.float.island.responding"),
      });
    }
    return items;
  }, [
    isStreaming,
    isAborting,
    isPaused,
    isThinkingLive,
    thinkingTokens,
    activeToolCall,
    streamFileChanges,
    latestStreamFileChange,
    liveTokenTotal,
    elapsedMs,
    t,
  ]);

  // 状态项键序列：仅在增删项时变化，纯数值文本更新不触发重置
  const cycleKey = tickerItems.map((item) => item.key).join("|");
  const itemCount = tickerItems.length;
  const isCycling = itemCount > 1;
  const prefersReducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  // 轮播步进放 ref：数值文本更新不会重建定时器
  const cycleStepRef = useRef({ index: 0, direction: 1 });
  const [cycleIndex, setCycleIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  // 可视区宽度按最宽状态项实测取档；停止流式时收回到 0
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    if (!isStreaming) {
      setViewportWidth(0);
      return;
    }
    const track = trackRef.current;
    if (!track) {
      return;
    }
    const measure = () => {
      const widest = track.scrollWidth;
      const target = Math.min(
        Math.ceil(widest / VIEWPORT_WIDTH_STEP) * VIEWPORT_WIDTH_STEP,
        VIEWPORT_MAX_WIDTH,
      );
      // 流式期间宽度只增不减：工具名/状态项变化不会反复伸缩造成抽搐
      setViewportWidth((prev) => Math.max(prev, target));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [isStreaming, cycleKey]);

  // 项集合变化不跳回首项：仅把索引收敛到有效范围，避免轮播跳动
  useEffect(() => {
    const maxIndex = Math.max(itemCount - 1, 0);
    cycleStepRef.current.index = Math.min(cycleStepRef.current.index, maxIndex);
    cycleStepRef.current.direction = 1;
    setCycleIndex((index) => Math.min(index, maxIndex));
  }, [cycleKey, itemCount]);

  // 垂直轮播：逐项往返滚动，悬停暂停；单项或偏好减少动效时静态展示
  useEffect(() => {
    if (!isStreaming || !isCycling || isHovered || prefersReducedMotion) {
      return;
    }
    const timer = window.setInterval(() => {
      const step = cycleStepRef.current;
      let next = step.index + step.direction;
      if (next >= itemCount) {
        step.direction = -1;
        next = step.index - 1;
      } else if (next < 0) {
        step.direction = 1;
        next = step.index + 1;
      }
      step.index = next;
      setCycleIndex(next);
    }, CYCLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    isStreaming,
    isCycling,
    isHovered,
    cycleKey,
    itemCount,
    prefersReducedMotion,
  ]);

  const renderItem = (item: TickerItem): React.JSX.Element => (
    <span className={`chat-float-island-item is-${item.tone}`} key={item.key}>
      {item.icon}
      <span className="chat-float-island-item-text">{item.text}</span>
    </span>
  );

  return (
    <button
      type="button"
      className={`chat-float-island${isStreaming ? " is-live" : ""}`}
      onClick={onReopen}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      aria-label={t("chat.float.reopen")}
      title={t("chat.float.reopen")}
    >
      <span className="chat-float-island-icon">
        <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="chat-float-island-body">
        {isStreaming ? (
          <span className="chat-float-dot is-streaming" aria-hidden="true" />
        ) : null}
        <span
          className={`chat-float-island-viewport${isCycling ? " is-cycling" : ""}`}
          ref={viewportRef}
          style={
            {
              width: viewportWidth,
              "--island-max-width": `${VIEWPORT_MAX_WIDTH}px`,
            } as React.CSSProperties
          }
        >
          <span
            className="chat-float-island-track"
            ref={trackRef}
            style={{
              transform: `translateY(${-cycleIndex * ITEM_HEIGHT_PX}px)`,
            }}
          >
            {tickerItems.map(renderItem)}
          </span>
        </span>
      </span>
    </button>
  );
};
