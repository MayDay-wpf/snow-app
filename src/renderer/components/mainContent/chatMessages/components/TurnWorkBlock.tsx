import { ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../../../i18n";
import { formatWorkDuration } from "../utils/toolActivitySummary";

/** 与 tool-card-minimal.css 中的 grid 折叠过渡时长保持一致。 */
const COLLAPSE_MS = 320;

type TurnWorkPhase = "open" | "closing" | "closed";

type TurnWorkBlockProps = {
  /** 本轮仍在生成：保持展开，标题显示进行中。 */
  live: boolean;
  /** 本轮耗时（ms），缺失时改显示步骤数。 */
  durationMs: number | null;
  /** 被折叠的中间响应条数。 */
  stepCount: number;
  /** 中间过程的工具调用总数。 */
  toolCount: number;
  hasError: boolean;
  /** 是否展开（进行中/待授权/用户手动展开）。 */
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
};

/**
 * 极简模式下每轮中间过程的折叠块（参考 Codex App 的 "Worked for ..."）。
 *
 * 标题行在生成过程中始终存在，生成结束时只把下方内容以高度过渡收起，
 * 避免整块内容瞬间消失造成的布局跳跃；收起完成后再卸载内容。
 */
export const TurnWorkBlock = ({
  live,
  durationMs,
  stepCount,
  toolCount,
  hasError,
  expanded,
  onToggle,
  children,
}: TurnWorkBlockProps): React.JSX.Element => {
  const { t } = useI18n();
  const [phase, setPhase] = useState<TurnWorkPhase>(
    expanded ? "open" : "closed",
  );
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  useEffect(() => {
    clearCloseTimer();
    if (expanded) {
      setPhase("open");
      return;
    }
    // 只有从展开状态收起才播放过渡；历史上已折叠的轮次首帧直接折叠。
    setPhase((prev) => (prev === "open" ? "closing" : "closed"));
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPhase("closed");
    }, COLLAPSE_MS);
    return clearCloseTimer;
  }, [expanded]);

  const label = live
    ? t("chat.turnWork.working", { defaultValue: "Working…" })
    : durationMs !== null
      ? t("chat.turnWork.workedFor", {
          defaultValue: "Worked for {{duration}}",
          values: { duration: formatWorkDuration(durationMs) },
        })
      : t("chat.turnWork.steps", {
          defaultValue: "Worked through {{count}} steps",
          values: { count: stepCount },
        });

  return (
    <section
      className={`turn-work${live ? " is-live" : ""}${
        phase === "open" ? " is-open" : ""
      }`}
    >
      <div className="turn-work-header">
        <button
          type="button"
          className="turn-work-toggle"
          onClick={onToggle}
          aria-expanded={phase === "open"}
        >
          <span className="turn-work-label">{label}</span>
          {toolCount > 0 ? (
            <span className="turn-work-meta">
              {t("chat.turnWork.tools", {
                defaultValue: "{{count}} tools",
                values: { count: toolCount },
              })}
            </span>
          ) : null}
          {hasError ? (
            <CircleAlert
              size={12}
              className="turn-work-alert"
              aria-hidden="true"
            />
          ) : null}
          <ChevronRight
            className="turn-work-chevron"
            size={13}
            aria-hidden="true"
          />
        </button>
        <span className="turn-work-line" aria-hidden="true" />
      </div>
      <div
        className={`turn-work-body${phase === "open" ? "" : " is-collapsed"}`}
      >
        <div className="turn-work-body-inner">
          {phase === "closed" ? null : children}
        </div>
      </div>
    </section>
  );
};
