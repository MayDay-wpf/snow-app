import { ArrowDown, Clock, Gauge, Pause, Play, Timer } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";

export type StreamMetricsProps = {
  /** Cumulative streamed tokens across every model iteration in the run. */
  tokenCount: number;
  /** Complete stream elapsed time accumulated across all run iterations. */
  elapsedMs: number;
  /** TTFT captured from the run's first model iteration. */
  ttftMs: number;
  /** Wall-clock timestamp (Date.now()) captured once when an agent loop
   *  starts, sourced from the active conversation session state. Drives the
   *  accumulating elapsed timer so it survives conversation switches between
   *  parallel streaming sessions. 0 when the loop is finished. */
  startedAt: number;
  /** Whether the agent loop is currently paused. */
  isPaused: boolean;
  /** Pause the agent loop (only valid while streaming and not already paused). */
  onPause: () => void;
  /** Resume a paused agent loop. */
  onResume: () => void;
};

const formatTokenCount = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
};

const formatTtft = (ms: number): string => {
  if (ms <= 0) return "--";
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
};

const formatTokPerSec = (tokens: number, elapsedMs: number): string => {
  if (elapsedMs <= 0 || tokens <= 0) return "--";
  const tps = (tokens / elapsedMs) * 1000;
  return tps >= 100 ? `${Math.round(tps)}` : tps.toFixed(1);
};

/**
 * 无新 token 到达超过该时长即视为输出卡住：tok/s 归 0 而非冻结在上一个值。
 * 流式期间正常 chunk 间隔远小于此阈值（指标 250ms 合并更新一次），
 * 不会误判正常慢速输出。
 */
const STALL_THRESHOLD_MS = 2000;

/**
 * Fixed streaming metrics bar displayed above the input box while the AI
 * is generating a response. Shows run-level token count, first-iteration
 * TTFT, cumulative stream speed, and wall-clock elapsed time.
 *
 * The elapsed timer is driven by `startedAt` — a wall-clock timestamp the
 * agent loop captures once when it begins and resets to 0 when it ends.
 * This is intentionally independent of `elapsedMs`, which contains the sum of
 * complete per-iteration stream durations used to calculate the run's tok/s.
 * Each parallel streaming conversation carries its own timer anchor, so
 * switching between them does not reset the displayed wall-clock duration.
 *
 * The pause/resume button is rendered on the left edge of the bar. It
 * allows the user to pause the agent loop before the next iteration
 * (i.e. before the next AI response) and resume it later. The button is
 * per-session because the pause controller is keyed by conversation id.
 */
export const StreamMetrics = memo(
  ({
    tokenCount,
    elapsedMs,
    ttftMs,
    startedAt,
    isPaused,
    onPause,
    onResume,
  }: StreamMetricsProps): React.JSX.Element => {
    const { t } = useI18n();
    const hasTtft = typeof ttftMs === "number" && ttftMs > 0;
    const isActive = typeof startedAt === "number" && startedAt > 0;

    // Derive the accumulated elapsed time purely from `startedAt`. The anchor
    // lives in session state, so switching conversations swaps it atomically
    // without any local ref bookkeeping. A 500ms interval keeps the display
    // ticking; it re-subscribes whenever the anchor changes (new send, switch).
    const [localElapsed, setLocalElapsed] = useState(0);

    useEffect(() => {
      if (!isActive) {
        setLocalElapsed(0);
        return;
      }

      setLocalElapsed(Date.now() - startedAt);
      const interval = setInterval(() => {
        setLocalElapsed(Date.now() - startedAt);
      }, 500);

      return () => clearInterval(interval);
    }, [isActive, startedAt]);

    const elapsedDisplay = formatDuration(localElapsed);

    // 卡住检测：token 累计数最后发生变化的时间戳。`elapsedMs` 只随后端
    // chunk 到达而推进，流卡住时 tok/s 会冻结在上一个值，与"当前没有
    // 速度"不符。token 数（或 run 锚点，覆盖切换会话/新 run 场景）一变
    // 就重置锚点，超时无变化即判定卡住，tok/s 归 0。
    const lastTokenChangeRef = useRef({ count: tokenCount, at: Date.now() });
    useEffect(() => {
      lastTokenChangeRef.current = { count: tokenCount, at: Date.now() };
    }, [tokenCount, startedAt]);

    const hasTokens = tokenCount > 0;
    const isStalled =
      isActive &&
      hasTokens &&
      Date.now() - lastTokenChangeRef.current.at >= STALL_THRESHOLD_MS;
    const tps =
      hasTokens && elapsedMs > 0
        ? isStalled
          ? "0"
          : formatTokPerSec(tokenCount, elapsedMs)
        : "--";
    const hasTps = tps !== "--";

    return (
      <span className="stream-metrics">
        <button
          type="button"
          className={`stream-metrics-pause-btn${isPaused ? " is-paused" : ""}`}
          aria-label={
            isPaused
              ? t("chat.streamMetrics.resume")
              : t("chat.streamMetrics.pause")
          }
          title={
            isPaused
              ? t("chat.streamMetrics.resume")
              : t("chat.streamMetrics.pause")
          }
          onClick={isPaused ? onResume : onPause}
        >
          {isPaused ? (
            <Play size={11} fill="currentColor" />
          ) : (
            <Pause size={11} fill="currentColor" />
          )}
        </button>
        <span className="stream-metrics-sep" />
        <span
          className={`stream-metrics-metric stream-metrics-elapsed${
            isActive ? " is-active" : ""
          }`}
          title={t("chat.streamMetrics.elapsedTitle")}
        >
          <Timer size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">{elapsedDisplay}</span>
        </span>
        <span className="stream-metrics-sep" />
        <span
          className="stream-metrics-metric stream-metrics-ttft"
          title={t("chat.streamMetrics.ttftTitle")}
        >
          <Clock size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">
            {hasTtft ? formatTtft(ttftMs) : "--"}
          </span>
        </span>
        <span className="stream-metrics-sep" />
        <span
          className={`stream-metrics-metric stream-metrics-tokens${
            hasTokens ? " is-active" : ""
          }`}
          title="tokens"
        >
          <ArrowDown size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">
            {hasTokens ? formatTokenCount(tokenCount) : "--"}
          </span>
          <span className="stream-metrics-label">tokens</span>
        </span>
        <span className="stream-metrics-sep" />
        <span
          className={`stream-metrics-metric stream-metrics-tps${
            hasTps ? " is-active" : ""
          }`}
          title="tok/s"
        >
          <Gauge size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">{tps}</span>
          <span className="stream-metrics-label">tok/s</span>
        </span>
      </span>
    );
  },
);

StreamMetrics.displayName = "StreamMetrics";
