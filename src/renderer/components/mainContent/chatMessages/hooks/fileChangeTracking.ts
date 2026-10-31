import type {
  ChatMessageRecord,
  FileChangeDiff,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type {
  FileChangeRecord,
  FileChangeCoverageRecord,
} from "../utils/conversationTypes";
import { parseToolCalls } from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import { pathsReferToSameFile } from "../toolCalls/shared/formatters";
import { generateComparePatch } from "../../../../utils/generateComparePatch";

/** Tools whose successful execution counts as a file modification. */
const FILE_MODIFYING_TOOLS = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
  "filesystem-copy",
]);

/**
 * 随会话缓存 TTL 释放过文件变更统计（含 diff 补丁）的会话。重新打开并从
 * 数据库完整重建之前，期间的实时记录只是增量，不能把会话标记为已完整加载。
 */
const releasedFileChangeIds = new Set<string>();

export const releaseFileChangeHydration = (conversationId: string): void => {
  releasedFileChangeIds.add(conversationId);
};

export const isFileChangeHydrationReleased = (
  conversationId: string,
): boolean => releasedFileChangeIds.has(conversationId);

/** 从数据库重建完成：恢复「实时记录即视为已加载」的常规语义。 */
export const settleFileChangeHydration = (conversationId: string): void => {
  releasedFileChangeIds.delete(conversationId);
};

/** 单次工具调用产生的文件变更（归属与时间戳由调用方补齐）。 */
type ExtractedFileMutation = Pick<
  FileChangeRecord,
  "filePath" | "fileKey" | "source" | "root" | "kind" | "diff"
>;

type ExtractedCoverage = Omit<
  FileChangeCoverageRecord,
  "timestamp" | "agent" | "subAgentName"
>;
type FileTrackingEnvelope = ExtractedCoverage & {
  version: 1;
  files: Array<{
    filePath: string;
    fileKey: string;
    kind: FileChangeRecord["kind"];
  }>;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  !value.includes("\u0000") &&
  /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);

/** Parse only a complete JSON payload, never repair truncated responses. */
const parseTrackingResult = (
  text: string,
): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(stripHookSuffix(text));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};
const readTrackingEnvelope = (
  toolName: string,
  result: Record<string, unknown> | undefined,
): FileTrackingEnvelope | undefined => {
  if (
    !FILE_MODIFYING_TOOLS.has(toolName) &&
    toolName !== "bash-terminal-execute"
  )
    return undefined;
  let value = result?.fileTracking;
  let wrappedError = false;
  // Native throws may be preserved as a complete JSON string in result.error.
  // Inspect exactly one wrapper, only when there is no top-level envelope;
  // never search fragments, strip inner suffixes or repair truncated JSON.
  if (
    result &&
    !("fileTracking" in result) &&
    typeof result.error === "string"
  ) {
    try {
      const inner: unknown = JSON.parse(result.error);
      if (isRecord(inner) && "fileTracking" in inner) {
        value = inner.fileTracking;
        wrappedError = true;
      }
    } catch {
      /* Keep the original error and unavailable evidence. */
    }
  }
  const source =
    toolName === "bash-terminal-execute" ? "terminal" : "filesystem";
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.source !== source ||
    !(value.root === null || isAbsolutePath(value.root)) ||
    !(
      value.coverage === "scoped" ||
      value.coverage === "partial" ||
      value.coverage === "unavailable"
    ) ||
    (source === "terminal" && value.coverage === "scoped") ||
    !Array.isArray(value.reasons) ||
    !value.reasons.every((reason) => typeof reason === "string") ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) =>
        isRecord(file) &&
        isAbsolutePath(file.filePath) &&
        typeof file.fileKey === "string" &&
        file.fileKey.trim().length > 0 &&
        !file.fileKey.includes("\u0000") &&
        (file.kind === "create" ||
          file.kind === "edit" ||
          file.kind === "delete"),
    ) ||
    (value.coverage === "unavailable" && value.files.length > 0) ||
    (source === "filesystem" &&
      value.files.length > 0 &&
      (wrappedError ||
        result?.success !== true ||
        (result && "error" in result)))
  )
    return undefined;
  return value as unknown as FileTrackingEnvelope;
};

export function extractFileChangeCoverageFromTool(
  toolName: string,
  resultJson: string,
): ExtractedCoverage | undefined {
  const result = parseTrackingResult(resultJson);
  const envelope = readTrackingEnvelope(toolName, result);
  if (envelope) {
    const { source, root, coverage, reasons } = envelope;
    return { source, root, coverage, reasons };
  }
  if (
    toolName === "bash-terminal-execute" ||
    (FILE_MODIFYING_TOOLS.has(toolName) &&
      result &&
      ("fileTracking" in result || result.success === true))
  ) {
    return {
      source: toolName === "bash-terminal-execute" ? "terminal" : "filesystem",
      root: null,
      coverage: "unavailable",
      reasons: [
        result && "fileTracking" in result
          ? "invalid_file_tracking"
          : "missing_file_tracking",
      ],
    };
  }
  return undefined;
}

/**
 * Build the diff patch for a successful file-modifying tool call so the
 * file-changes panel can show what actually changed:
 *   - filesystem-create: full file content (empty file -> content)
 *   - filesystem-replace_edit: the searchContent -> replaceContent
 *     replacement region with context lines
 *   - filesystem-copy: the pasted region (replacedContent -> pastedContent),
 *     read from the tool result because the arguments only carry line numbers
 * Every payload is persisted together with the call (arguments or result),
 * so the same patch can be rebuilt after a restart.
 */
const buildFileChangeDiff = (
  filePath: string,
  oldContent: string,
  newContent: string,
): FileChangeDiff | undefined => {
  if (!oldContent && !newContent) {
    return undefined;
  }
  try {
    const patch = generateComparePatch(filePath, oldContent, newContent);
    return patch ? { patch } : undefined;
  } catch {
    return undefined;
  }
};

const readText = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

/**
 * 复制/剪切的文件变更：跨文件剪切会同时改写源文件与目标文件，因此产出两条
 * 记录（目标文件的粘贴区域 + 源文件的删除区域）；同文件移动只有一条记录。
 */
const buildCopyFileChanges = (
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  filePath: string,
): ExtractedFileMutation[] => {
  const changes: ExtractedFileMutation[] = [
    {
      filePath,
      kind: "edit",
      diff: buildFileChangeDiff(
        filePath,
        readText(result, "replacedContent"),
        readText(result, "pastedContent"),
      ),
    },
  ];

  const sourceFilePath =
    readText(result, "sourceFilePath") || readText(args, "sourceFilePath");
  const removedContent = readText(result, "removedContent");
  if (
    result.deleteSource === true &&
    removedContent &&
    sourceFilePath &&
    !pathsReferToSameFile(sourceFilePath, filePath)
  ) {
    changes.push({
      filePath: sourceFilePath,
      kind: "edit",
      diff: buildFileChangeDiff(sourceFilePath, removedContent, ""),
    });
  }

  return changes;
};

/** Consume v1 evidence even for non-zero terminal exits. Legacy file tools
 * retain their old non-canonical paths; invalid v1 never falls back. */
export function extractFileChangesFromTool(
  toolName: string,
  argsJson: string,
  resultJson: string,
): ExtractedFileMutation[] {
  const result = parseTrackingResult(resultJson);
  const envelope = readTrackingEnvelope(toolName, result);
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (isRecord(parsed)) args = parsed;
  } catch {
    /* Evidence does not depend on arguments. */
  }
  if (envelope) {
    const target =
      readText(result!, "targetFilePath") ||
      readText(result!, "filePath") ||
      readText(result!, "path");
    const source = readText(result!, "sourceFilePath");
    return envelope.files.map((file) => {
      let diff: FileChangeDiff | undefined;
      if (envelope.source === "filesystem") {
        if (toolName === "filesystem-create") {
          diff = buildFileChangeDiff(
            file.filePath,
            "",
            readText(args, "content"),
          );
        } else if (toolName === "filesystem-replace_edit") {
          diff = buildFileChangeDiff(
            file.filePath,
            readText(args, "searchContent"),
            readText(args, "replaceContent"),
          );
        } else if (target && pathsReferToSameFile(file.filePath, target)) {
          diff = buildFileChangeDiff(
            file.filePath,
            readText(result!, "replacedContent"),
            readText(result!, "pastedContent"),
          );
        } else if (source && pathsReferToSameFile(file.filePath, source)) {
          diff = buildFileChangeDiff(
            file.filePath,
            readText(result!, "removedContent"),
            "",
          );
        }
      }
      return { ...file, source: envelope.source, root: envelope.root, diff };
    });
  }
  if (
    !FILE_MODIFYING_TOOLS.has(toolName) ||
    !result ||
    "fileTracking" in result ||
    "error" in result ||
    result.success !== true
  )
    return [];
  const filePath = readText(args, "filePath").trim();
  if (!filePath) return [];
  if (toolName === "filesystem-copy")
    return buildCopyFileChanges(args, result, filePath);
  return [
    {
      filePath,
      kind: toolName === "filesystem-create" ? "create" : "edit",
      diff: buildFileChangeDiff(
        filePath,
        toolName === "filesystem-create" ? "" : readText(args, "searchContent"),
        readText(
          args,
          toolName === "filesystem-create" ? "content" : "replaceContent",
        ),
      ),
    },
  ];
}

/**
 * Collect the file-change records for a conversation. Main-agent changes are
 * stored under the conversation's own key (agent: "main"); sub-agent changes
 * are stored under both the sub-agent's key and the parent conversation's key
 * (agent: "sub", tagged with the sub-agent name) at record time — so a single
 * lookup here yields the full picture for display.
 *
 * Repeated edits to the same file are normalized to a single entry: only the
 * latest change (highest timestamp) survives, carrying the final diff, so the
 * stats list never shows multiple rows for one file path. Records are
 * returned in chronological order of their last modification.
 */
export function collectConversationFileChanges(
  fileChangeStats: Record<string, FileChangeRecord[]>,
  conversationId: string,
): FileChangeRecord[] {
  const changes = fileChangeStats[conversationId] ?? [];
  const latestByPath = new Map<string, FileChangeRecord>();
  for (const change of changes) {
    const existing = latestByPath.get(change.fileKey ?? change.filePath);
    if (!existing || change.timestamp >= existing.timestamp) {
      latestByPath.set(change.fileKey ?? change.filePath, change);
    }
  }
  return [...latestByPath.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
}

/** Count of unique file paths in a list of change records. */
export function countUniqueFiles(changes: FileChangeRecord[]): number {
  return new Set(changes.map((change) => change.fileKey ?? change.filePath))
    .size;
}

export type FileChangeLineStats = {
  additions: number;
  deletions: number;
};

/**
 * Sum added and deleted lines: checkpoint records carry precomputed stats;
 * tool records are counted from their unified diffs (the first two lines are
 * diff headers and are intentionally excluded).
 */
export function countFileChangeLines(
  changes: FileChangeRecord[],
): FileChangeLineStats {
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    if (change.lineStats) {
      additions += change.lineStats.additions;
      deletions += change.lineStats.deletions;
      continue;
    }
    if (!change.diff?.patch || change.diff.isBinary) {
      continue;
    }

    const lines = change.diff.patch.split("\n").slice(2);
    for (const line of lines) {
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return { additions, deletions };
}

/** A file change extracted from persisted history, without agent attribution
 *  (the caller decides whether it belongs to the main agent or a sub-agent). */
export type ExtractedFileChange = Pick<
  FileChangeRecord,
  "filePath" | "fileKey" | "source" | "root" | "kind" | "timestamp" | "diff"
>;

/**
 * Strip hook-appended sections from a persisted tool result so the raw
 * success JSON (which lives before the "[Hook Context]" marker) can be
 * parsed. Mirrors how toolExecution.ts appends hook context at runtime.
 */
const stripHookSuffix = (result: string): string =>
  result.split("\n\n[Hook Context]")[0] ?? result;

/**
 * Rebuild file-change records from persisted history records. The database
 * stores each assistant message's tool calls in `toolCallsJson` and each
 * tool result as `[Tool: name#callId]\n<result>` segments inside tool-message
 * content — the same pairing logic `buildConversationMessages` uses for the
 * live message list, so this reconstruction matches what the runtime stats
 * would have recorded.
 *
 * Timestamps come from the message's persisted `createdAt` so re-running this
 * extraction (e.g. after switching conversations) yields stable keys that the
 * merge step can de-duplicate against.
 */
export function extractFileTrackingFromRecords(records: ChatMessageRecord[]): {
  changes: ExtractedFileChange[];
  coverage: Array<ExtractedCoverage & { timestamp: number }>;
} {
  const toolResultQueues = new Map<string, string[]>();
  for (const record of records) {
    if (record.role !== "tool" || !record.content) continue;
    // Split only at an actual tool header, not at blank lines in a result/hook.
    for (const segment of record.content.split(/\n\n(?=\[Tool: [^\n]+\]\n)/)) {
      const match = segment.match(/^\[Tool:\s*(.+?)\]\n([\s\S]*)$/);
      if (!match) continue;
      const queue = toolResultQueues.get(match[1]) ?? [];
      queue.push(match[2]);
      toolResultQueues.set(match[1], queue);
    }
  }
  const consumeToolResult = (toolCall: ToolCallInfo): string | undefined => {
    const identifiers = toolCall.callId
      ? [`${toolCall.name}#${toolCall.callId}`, toolCall.name]
      : [toolCall.name];
    for (const identifier of identifiers) {
      const queue = toolResultQueues.get(identifier);
      if (queue?.length) return queue.shift();
    }
    return undefined;
  };
  const changes: ExtractedFileChange[] = [];
  const coverage: Array<ExtractedCoverage & { timestamp: number }> = [];
  for (const record of records) {
    if (record.role !== "assistant") continue;
    const complete = resolveResponseDisposition(record).kind === "complete";
    for (const toolCall of parseToolCalls(record.toolCallsJson)) {
      const result = consumeToolResult(toolCall);
      if (result === undefined) continue;
      // An incomplete assistant is not evidence of execution. Only a valid
      // paired v1 result proves side effects independently of response status.
      if (
        !complete &&
        !readTrackingEnvelope(toolCall.name, parseTrackingResult(result))
      )
        continue;
      const parsedTimestamp = Date.parse(record.createdAt);
      const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
      const evidence = extractFileChangeCoverageFromTool(toolCall.name, result);
      if (evidence) coverage.push({ ...evidence, timestamp });
      for (const change of extractFileChangesFromTool(
        toolCall.name,
        toolCall.arguments,
        result,
      )) {
        changes.push({ ...change, timestamp });
      }
    }
  }
  return { changes, coverage };
}

export function extractFileChangesFromRecords(
  records: ChatMessageRecord[],
): ExtractedFileChange[] {
  return extractFileTrackingFromRecords(records).changes;
}
