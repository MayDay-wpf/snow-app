import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { hasPendingUserInteraction } from "../utils/toolCallInteraction";

type SameToolRunProps = {
  /** 同名连续工具调用（按时间顺序）。 */
  toolCalls: ToolCallInfo[];
  renderItem: (toolCall: ToolCallInfo) => ReactNode;
};

/** 与 .tsr-collapse 的过渡时长一致。 */
const COLLAPSE_MS = 220;

const isCallRunning = (tc: ToolCallInfo): boolean =>
  tc.status === "running" || tc.correction?.status === "running";

/**
 * 极简模式：连续同名工具合并为一行，标题即最新一次调用，默认收起。
 * 用户手动开合后保持其选择，新工具到达不会强制收起。
 */
export const SameToolRun = ({
  toolCalls,
  renderItem,
}: SameToolRunProps): React.JSX.Element => {
  const { t } = useI18n();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const latest = toolCalls[toolCalls.length - 1];
  const earlier = useMemo(() => toolCalls.slice(0, -1), [toolCalls]);
  const hasEarlier = earlier.length > 0;

  const earlierInteractive = useMemo(
    () => hasPendingUserInteraction(earlier),
    [earlier],
  );
  const earlierRunning = earlier.some(isCallRunning);
  const earlierError = earlier.some((tc) => tc.status === "error");
  const isOpen = hasEarlier && (earlierInteractive || (userOpen ?? false));

  // 收起态不挂载历史卡片；仍在执行的保持挂载（流式/本地收口需要）。
  const wantBody = isOpen || earlierRunning;
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

  if (!hasEarlier) {
    return <div className="tsr">{renderItem(latest)}</div>;
  }

  const toggleLabel = t(
    isOpen ? "toolCall.sameRun.collapse" : "toolCall.sameRun.expand",
    {
      defaultValue: isOpen ? "Collapse" : "Show {{count}} calls",
      values: { count: toolCalls.length },
    },
  );

  return (
    <div className={`tsr${isOpen ? " is-open" : ""}`}>
      <div className="tsr-head">
        <div className="tsr-latest" key={latest.interactionId}>
          {renderItem(latest)}
        </div>
        <button
          type="button"
          className={`tsr-toggle${earlierRunning ? " is-running" : ""}${
            earlierError ? " has-error" : ""
          }`}
          onClick={() => setUserOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <span className="tsr-count">{toolCalls.length}</span>
          <ChevronRight className="tsr-chevron" size={12} aria-hidden="true" />
        </button>
      </div>
      <div className={`tsr-collapse${isOpen ? " is-open" : ""}`}>
        <div className="tsr-list">
          {bodyMounted || isOpen
            ? earlier.map((tc) => (
                <div className="tsr-item" key={tc.interactionId}>
                  {renderItem(tc)}
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  );
};
