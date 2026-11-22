import { ChevronRight, CircleAlert } from "lucide-react";
import { useMemo } from "react";

import { useI18n } from "../../../../i18n";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import { getCompareDiffStats } from "../../../../utils/generateComparePatch";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { describeToolTarget } from "../utils/toolActivitySummary";
import { resolveToolDisplayName } from "../toolCalls/shared/toolDisplayName";

type MinimalSameRunHeaderProps = {
  toolCalls: readonly ToolCallInfo[];
  expanded: boolean;
  onToggle: () => void;
};

type DiffTotals = { additions: number; deletions: number };

const isCallRunning = (toolCall: ToolCallInfo): boolean =>
  toolCall.status === "running" ||
  toolCall.correction?.status === "running";

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
 * 极简模式的同名连续工具组标题行。
 *
 * 开合状态由列表层持有：收起时只有这一行，展开时行模型会为每个调用
 * 追加一条独立的工具行，避免整组作为一个不可测的巨块。
 */
export const MinimalSameRunHeader = ({
  toolCalls,
  expanded,
  onToggle,
}: MinimalSameRunHeaderProps): React.JSX.Element => {
  const { t } = useI18n();
  const groupName = resolveToolDisplayName(t, toolCalls[0].name);
  const latest = toolCalls[toolCalls.length - 1];
  const latestTarget = useMemo(() => describeToolTarget(latest), [latest]);
  const diffTotals = useMemo(
    () => summarizeEditDiff(toolCalls),
    [toolCalls],
  );
  const anyRunning = toolCalls.some(isCallRunning);
  const hasError = toolCalls.some((toolCall) => toolCall.status === "error");
  const toggleLabel = t(
    expanded ? "toolCall.sameRun.collapse" : "toolCall.sameRun.expand",
    {
      defaultValue: expanded ? "Collapse" : "Show {{count}} calls",
      values: { count: toolCalls.length },
    },
  );

  return (
    <div className={`tsr${expanded ? " is-open" : ""}`}>
      <button
        type="button"
        className={`tsr-head${anyRunning ? " is-running" : ""}${
          hasError ? " has-error" : ""
        }`}
        onClick={onToggle}
        aria-expanded={expanded}
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
        {!expanded && latestTarget ? (
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
    </div>
  );
};
