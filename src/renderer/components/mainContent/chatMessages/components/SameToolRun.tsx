import { ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../../../i18n";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { hasPendingUserInteraction } from "../utils/toolCallInteraction";
import { describeToolTarget } from "../utils/toolActivitySummary";
import { resolveToolDisplayName } from "../toolCalls/shared/toolDisplayName";
import { getCompareDiffStats } from "../../../../utils/generateComparePatch";
import {
  EntranceProvider,
  SUPPRESSED_ENTRANCE,
  useEntranceClock,
} from "./EntranceScope";

type SameToolRunProps = {
  /** 同名连续工具调用（按时间顺序）。 */
  toolCalls: ToolCallInfo[];
  renderItem: (toolCall: ToolCallInfo) => ReactNode;
};

/** 与 .tsr-collapse 的过渡时长一致。 */
const COLLAPSE_MS = 220;

const isCallRunning = (tc: ToolCallInfo): boolean =>
  tc.status === "running" || tc.correction?.status === "running";

type DiffTotals = { additions: number; deletions: number };

/** replace_edit 的增删汇总；组内含其他工具或参数不可信时不汇总。 */
const summarizeEditDiff = (
  toolCalls: readonly ToolCallInfo[],
): DiffTotals | null => {
  let totals: DiffTotals | null = null;
  for (const toolCall of toolCalls) {
    if (toolCall.name !== "filesystem-replace_edit") {
      return null;
    }
    let args: { searchContent?: unknown; replaceContent?: unknown } | null;
    try {
      args = JSON.parse(toolCall.arguments) as typeof args;
    } catch {
      return null;
    }
    if (
      !args ||
      typeof args.searchContent !== "string" ||
      typeof args.replaceContent !== "string"
    ) {
      return null;
    }
    const stats = getCompareDiffStats(args.searchContent, args.replaceContent);
    totals ??= { additions: 0, deletions: 0 };
    totals.additions += stats.additions;
    totals.deletions += stats.deletions;
  }
  return totals;
};

/**
 * 极简模式：连续同名工具收为一组。
 * 组摘要行只是分组标签、不属于任何一次调用；展开后全部调用按时间正序
 * 平铺为同级行，不做缩进与树形连线。
 */
export const SameToolRun = ({
  toolCalls,
  renderItem,
}: SameToolRunProps): React.JSX.Element => {
  const { t } = useI18n();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const merged = toolCalls.length > 1;
  // 默认收起；用户手动开合后保持其选择。展开态新调用追加到末尾。
  const isOpen =
    merged && (hasPendingUserInteraction(toolCalls) || (userOpen ?? false));

  // 只有用户自己点过开合才播收起过渡；自动收纳（组刚形成）直接切换——
  // 用户没操作却看到列表被动画抽走，观感上就是界面抖了一下。
  const animated = userOpen !== null;

  const anyRunning = toolCalls.some(isCallRunning);
  const hasError = toolCalls.some((tc) => tc.status === "error");

  // 收起态不挂载卡片；仍在执行的保持挂载（流式 / 本地收口需要）。
  const wantBody = isOpen || !merged || anyRunning;
  const [bodyMounted, setBodyMounted] = useState(wantBody);
  useEffect(() => {
    if (wantBody) {
      setBodyMounted(true);
      return;
    }
    if (!bodyMounted) {
      return;
    }
    if (!animated) {
      setBodyMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setBodyMounted(false), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [wantBody, bodyMounted, animated]);

  const groupName = resolveToolDisplayName(t, toolCalls[0].name);
  const latest = toolCalls[toolCalls.length - 1];
  const latestTarget = useMemo(() => describeToolTarget(latest), [latest]);
  const diffTotals = useMemo(
    () => (merged ? summarizeEditDiff(toolCalls) : null),
    [merged, toolCalls],
  );
  const parentClock = useEntranceClock();
  const toggleLabel = t(
    isOpen ? "toolCall.sameRun.collapse" : "toolCall.sameRun.expand",
    {
      defaultValue: isOpen ? "Collapse" : "Show {{count}} calls",
      values: { count: toolCalls.length },
    },
  );

  return (
    <div
      className={`tsr${isOpen ? " is-open" : ""}${merged ? "" : " is-solo"}${
        animated ? "" : " is-static"
      }`}
    >
      {merged ? (
        <button
          type="button"
          className={`tsr-head${anyRunning ? " is-running" : ""}${
            hasError ? " has-error" : ""
          }`}
          onClick={() => setUserOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-label={toggleLabel}
        >
          <span className="tsr-name">{groupName}</span>
          <span className="tsr-count">×{toolCalls.length}</span>
          {diffTotals ? (
            <span className="tool-call-diff-stats tsr-diff">
              <span className="tool-call-diff-add">
                +{diffTotals.additions}
              </span>
              <span className="tool-call-diff-del">
                -{diffTotals.deletions}
              </span>
            </span>
          ) : null}
          {!isOpen && latestTarget ? (
            <span className="tsr-latest-target">
              {latestTarget.filePath ? (
                <span className="tsr-latest-target-icon" aria-hidden="true">
                  {getFileTypeIcon(latestTarget.filePath, false, false, {
                    size: 13,
                  })}
                </span>
              ) : null}
              <span className="tsr-latest-target-text">
                {latestTarget.text}
              </span>
            </span>
          ) : null}
          {hasError ? (
            <CircleAlert className="tsr-alert" size={12} aria-hidden="true" />
          ) : null}
          <ChevronRight className="tsr-chevron" size={12} aria-hidden="true" />
        </button>
      ) : null}
      <div className={`tsr-collapse${isOpen || !merged ? " is-open" : ""}`}>
        <div className="tsr-list">
          <EntranceProvider value={merged ? SUPPRESSED_ENTRANCE : parentClock}>
            {bodyMounted || isOpen
              ? toolCalls.map((toolCall) => (
                  <div className="tsr-item" key={toolCall.interactionId}>
                    {renderItem(toolCall)}
                  </div>
                ))
              : null}
          </EntranceProvider>
        </div>
      </div>
    </div>
  );
};
