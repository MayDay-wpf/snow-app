import { getCompareDiffStats } from "../../../../utils/generateComparePatch";
import type { ToolCallInfo } from "./conversationTypes";

export type EditDiffTotals = { additions: number; deletions: number };

/** 工具调用是不可变快照：diff 结果按对象缓存，流式重渲染时不必反复解析与重算。 */
const diffCache = new WeakMap<ToolCallInfo, EditDiffTotals | null>();

const editDiffOf = (toolCall: ToolCallInfo): EditDiffTotals | null => {
  const cached = diffCache.get(toolCall);
  if (cached !== undefined) return cached;
  let result: EditDiffTotals | null = null;
  try {
    const args = JSON.parse(toolCall.arguments) as {
      searchContent?: unknown;
      replaceContent?: unknown;
    } | null;
    if (
      args &&
      typeof args.searchContent === "string" &&
      typeof args.replaceContent === "string"
    ) {
      result = getCompareDiffStats(args.searchContent, args.replaceContent);
    }
  } catch {
    result = null;
  }
  diffCache.set(toolCall, result);
  return result;
};

/** 同名 replace_edit 组的增删汇总；组内含其他工具或参数不可信时返回 null。 */
export const summarizeSameRunEditDiff = (
  toolCalls: readonly ToolCallInfo[],
): EditDiffTotals | null => {
  let totals: EditDiffTotals | null = null;
  for (const toolCall of toolCalls) {
    if (toolCall.name !== "filesystem-replace_edit") {
      return null;
    }
    const stats = editDiffOf(toolCall);
    if (!stats) {
      return null;
    }
    totals ??= { additions: 0, deletions: 0 };
    totals.additions += stats.additions;
    totals.deletions += stats.deletions;
  }
  return totals;
};
