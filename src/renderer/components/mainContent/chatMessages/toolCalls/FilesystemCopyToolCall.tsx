import { useCallback, useMemo } from "react";
import { useI18n } from "../../../../i18n";
import { getCompareDiffStats } from "../../../../utils/generateComparePatch";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import {
  rightPanelEvents,
  type OpenFileDiffPreviewPayload,
} from "../../../rightPanel/rightPanelEvents";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { getFileName, pathsReferToSameFile } from "./shared/formatters";
import { MiniDiffViewer } from "./shared/MiniDiffViewer";
import { ToolCallNode } from "./shared/ToolCallNode";
import { HtmlFilePreviewButton } from "./shared/HtmlFilePreviewButton";
import { localizeToolError } from "./shared/toolErrorDisplay";

type FilesystemCopyToolCallProps = {
  toolCall: ToolCallInfo;
};

type CopyMode = "insert" | "replace" | "delete";
type InsertPosition = "before" | "after";

type ParsedCopyArgs = {
  /** 目标文件（粘贴目的地）。 */
  filePath: string;
  sourceFilePath: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
  targetLine?: number;
  targetEndLine?: number;
  mode: CopyMode;
  position: InsertPosition;
  /** true 表示剪切/移动：粘贴后源区间从源文件删除。 */
  deleteSource: boolean;
};

type ParsedCopyResult =
  | {
      type: "success";
      sourceFilePath: string;
      sourceLineStart?: number;
      sourceLineEnd?: number;
      copiedLines?: number;
      targetFilePath: string;
      mode: CopyMode;
      position?: InsertPosition;
      deleteSource: boolean;
      /** 仅 mode=delete 返回：被删掉的行数。 */
      removedLines?: number;
      matchedLineStart?: number;
      matchedLineEnd?: number;
      totalLines?: number;
      replacedContent: string;
      pastedContent: string;
      /** 仅跨文件剪切返回：源文件被删掉的行。 */
      removedContent: string;
      omittedLines: number;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readLine = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readMode = (value: unknown): CopyMode | undefined =>
  value === "insert" || value === "replace" || value === "delete"
    ? value
    : undefined;

const readPosition = (value: unknown): InsertPosition | undefined =>
  value === "before" || value === "after" ? value : undefined;

const parseArgs = (args: string): ParsedCopyArgs | null => {
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const filePath = readString(parsed.filePath);
    if (!filePath) {
      return null;
    }
    return {
      filePath,
      sourceFilePath: readString(parsed.sourceFilePath),
      sourceStartLine: readLine(parsed.sourceStartLine),
      sourceEndLine: readLine(parsed.sourceEndLine),
      targetLine: readLine(parsed.targetLine),
      targetEndLine: readLine(parsed.targetEndLine),
      mode: readMode(parsed.mode) ?? "insert",
      position: readPosition(parsed.position) ?? "before",
      deleteSource: parsed.deleteSource === true,
    };
  } catch {
    return null;
  }
};

/** 流式未闭合 JSON 兜底提前提取目标或源文件路径 */
const extractStreamingCopyPath = (
  args: string,
): { filePath?: string; sourceFilePath?: string } => {
  if (!args) return {};
  const targetMatch = args.match(/"filePath"\s*:\s*"([^"]+)"/);
  const sourceMatch = args.match(/"sourceFilePath"\s*:\s*"([^"]+)"/);
  return {
    filePath: targetMatch ? targetMatch[1].replace(/\\/g, "/") : undefined,
    sourceFilePath: sourceMatch
      ? sourceMatch[1].replace(/\\/g, "/")
      : undefined,
  };
};

const parseResult = (result: string | undefined): ParsedCopyResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed = JSON.parse(result);

    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.error === "string") {
        return { type: "error", message: parsed.error };
      }

      if (parsed.success === true) {
        return {
          type: "success",
          sourceFilePath: readString(parsed.sourceFilePath),
          sourceLineStart: readLine(parsed.sourceLineStart),
          sourceLineEnd: readLine(parsed.sourceLineEnd),
          copiedLines: readLine(parsed.copiedLines),
          // delete 模式只改一个文件，结果里用 filePath 而不是 targetFilePath。
          targetFilePath:
            readString(parsed.targetFilePath) || readString(parsed.filePath),
          mode: readMode(parsed.mode) ?? "insert",
          position: readPosition(parsed.position),
          deleteSource: parsed.deleteSource === true,
          removedLines: readLine(parsed.removedLines),
          matchedLineStart: readLine(parsed.matchedLineStart),
          matchedLineEnd: readLine(parsed.matchedLineEnd),
          totalLines: readLine(parsed.totalLines),
          replacedContent: readString(parsed.replacedContent),
          pastedContent: readString(parsed.pastedContent),
          removedContent: readString(parsed.removedContent),
          omittedLines: readLine(parsed.omittedLines) ?? 0,
        };
      }
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const formatLineRange = (start?: number, end?: number): string => {
  if (start === undefined) {
    return "";
  }
  if (end === undefined || end === start) {
    return `${start}`;
  }
  return `${start}-${end}`;
};

export const FilesystemCopyToolCall = ({
  toolCall,
}: FilesystemCopyToolCallProps): React.JSX.Element => {
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const hasError = parsedResult.type === "error";
  const success = parsedResult.type === "success" ? parsedResult : null;
  const args = parsedArgs;

  const mode = success?.mode ?? args?.mode ?? "insert";
  const position = success?.position ?? args?.position ?? "before";
  // delete 模式只删不粘，没有复制 / 剪切语义。
  const isDelete = mode === "delete";
  const isCut =
    !isDelete && (success?.deleteSource ?? args?.deleteSource ?? false);

  const streaming = useMemo(
    () => (args ? undefined : extractStreamingCopyPath(toolCall.arguments)),
    [args, toolCall.arguments],
  );
  const filePath =
    args?.filePath ?? success?.targetFilePath ?? streaming?.filePath ?? "copy";
  const fileName = getFileName(filePath);
  const sourceFilePath =
    success?.sourceFilePath ||
    args?.sourceFilePath ||
    streaming?.sourceFilePath ||
    "";
  const sourceFileName = sourceFilePath ? getFileName(sourceFilePath) : "";
  const sourceRange = formatLineRange(
    success?.sourceLineStart ?? args?.sourceStartLine,
    success?.sourceLineEnd ?? args?.sourceEndLine ?? args?.sourceStartLine,
  );
  // 源文件与目标文件是否同一个文件（同文件移动只改一次，删除侧 diff 落在同一文件）。
  const sameFile = pathsReferToSameFile(sourceFilePath, filePath);

  const replacement = success?.replacedContent ?? "";
  const pasted = success?.pastedContent ?? "";
  // 删除侧内容：delete 与剪切都会删掉一段行；同文件移动后端不回传
  // removedContent，此时被删掉的与粘贴进来的正是同一批行。
  const removalContent =
    isDelete || isCut ? success?.removedContent || pasted : "";
  const showDiff = !hasError && Boolean(pasted) && success !== null;
  const showRemovalDiff =
    !hasError && Boolean(removalContent) && success !== null;
  const removalFilePath = isDelete ? filePath : sourceFilePath || filePath;
  const removalFileName = getFileName(removalFilePath);

  const stats = useMemo(() => {
    if (!showDiff && !showRemovalDiff) {
      return null;
    }
    const target = showDiff ? getCompareDiffStats(replacement, pasted) : null;
    const removal = showRemovalDiff
      ? getCompareDiffStats(removalContent, "")
      : null;
    return {
      additions: (target?.additions ?? 0) + (removal?.additions ?? 0),
      deletions: (target?.deletions ?? 0) + (removal?.deletions ?? 0),
    };
  }, [showDiff, showRemovalDiff, replacement, pasted, removalContent]);

  const placementLabel = useMemo(() => {
    if (mode === "replace") {
      const range = formatLineRange(
        args?.targetLine,
        args?.targetEndLine && args.targetEndLine > (args.targetLine ?? 0)
          ? args.targetEndLine
          : args?.targetLine,
      );
      return range ? `replaced lines ${range}` : "replaced range";
    }
    if (args?.targetLine === undefined) {
      return "appended at end of file";
    }
    return position === "after"
      ? `inserted after line ${args.targetLine}`
      : `inserted before line ${args.targetLine}`;
  }, [mode, position, args]);

  const landedLabel = success
    ? (() => {
        // delete 模式没有粘贴落点，只报被删掉的区间。
        if (isDelete) {
          const removedRange = formatLineRange(
            success.sourceLineStart,
            success.sourceLineEnd,
          );
          const count =
            success.removedLines !== undefined
              ? ` (${success.removedLines} lines)`
              : "";
          return removedRange
            ? `deleted lines ${removedRange}${count}`
            : `deleted${count}`;
        }
        const range = formatLineRange(
          success.matchedLineStart,
          success.matchedLineEnd,
        );
        const lines =
          success.copiedLines !== undefined
            ? ` (${success.copiedLines} lines)`
            : "";
        if (!range) {
          return isCut ? `cut${lines}` : `pasted${lines}`;
        }
        return isCut
          ? `cut to lines ${range}${lines}`
          : `pasted at lines ${range}${lines}`;
      })()
    : "";

  const sourceNote = useMemo(() => {
    if (!isCut || !success) {
      return "";
    }
    if (sameFile) {
      return sourceRange
        ? `source lines ${sourceRange} removed from the same file`
        : "source lines removed from the same file";
    }
    const removed = formatLineRange(
      success.sourceLineStart,
      success.sourceLineEnd,
    );
    return removed
      ? `removed lines ${removed} from ${sourceFileName}`
      : `removed the source lines from ${sourceFileName}`;
  }, [isCut, success, sameFile, sourceRange, sourceFileName]);

  const { t } = useI18n();

  const handleOpenTargetInTab = useCallback(() => {
    if (!success) {
      return;
    }
    const payload: OpenFileDiffPreviewPayload = {
      fileName,
      filePath,
      oldContent: replacement,
      newContent: pasted,
      oldStartLine: success.matchedLineStart,
      newStartLine: success.matchedLineStart,
      changeType: mode === "replace" ? "modified" : "added",
    };
    rightPanelEvents.emit("open-file-diff-preview", payload);
  }, [success, fileName, filePath, replacement, pasted, mode]);

  const handleOpenSourceInTab = useCallback(() => {
    if (!success || !removalContent) {
      return;
    }
    const payload: OpenFileDiffPreviewPayload = {
      fileName: removalFileName,
      filePath: removalFilePath,
      oldContent: removalContent,
      newContent: "",
      oldStartLine: success.sourceLineStart,
      changeType: "modified",
    };
    rightPanelEvents.emit("open-file-diff-preview", payload);
  }, [success, removalContent, removalFilePath, removalFileName]);

  const effectiveStatus = hasError ? "error" : toolCall.status;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="copy"
      displayName={
        <>
          {getFileTypeIcon(fileName, false, false, {
            size: 13,
            className: "tcn-file-icon",
            "aria-hidden": true,
          })}
          {fileName}
        </>
      }
      displayNameTitle={filePath}
      displayNameDataPath={filePath}
      status={effectiveStatus}
      meta={
        <>
          {stats ? (
            <span className="tool-call-diff-stats">
              <span className="tool-call-diff-add">+{stats.additions}</span>
              <span className="tool-call-diff-del">-{stats.deletions}</span>
            </span>
          ) : null}
          <HtmlFilePreviewButton
            filePath={filePath}
            enabled={toolCall.status === "completed" && success !== null}
          />
        </>
      }
      className="tool-call-filesystem-copy"
      lazyBody
    >
      <div className="tool-call-body">
        <div className="tool-call-file-path" data-path={filePath}>
          {filePath}
        </div>
        {hasError ? (
          <div className="tool-call-error">
            <span>{localizeToolError(t, parsedResult.message)}</span>
          </div>
        ) : null}

        {sourceFilePath && !isDelete ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">
              {isCut ? "cut from" : "copy from"}
            </span>
            <span
              className="tool-call-meta-value"
              data-path={sourceFilePath}
              title={sourceFilePath}
            >
              {sourceRange
                ? `${sourceFileName}:${sourceRange}`
                : sourceFileName}
            </span>
          </div>
        ) : null}

        {isDelete ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">delete</span>
            <span className="tool-call-meta-value">
              {sourceRange ? `lines ${sourceRange}` : "lines"}
            </span>
          </div>
        ) : args ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">
              {mode === "replace" ? "replace" : "insert"}
            </span>
            <span className="tool-call-meta-value">{placementLabel}</span>
          </div>
        ) : null}

        {success ? (
          <div className="tool-call-success-row">
            {landedLabel}
            {sourceNote ? ` — ${sourceNote}` : ""}
          </div>
        ) : null}

        {success && success.omittedLines > 0 ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">elided</span>
            <span className="tool-call-meta-value">
              {success.omittedLines} lines
            </span>
          </div>
        ) : null}

        {showDiff && success ? (
          <MiniDiffViewer
            fileName={fileName}
            oldContent={replacement}
            newContent={pasted}
            startLine={success.matchedLineStart}
            onOpenInTab={handleOpenTargetInTab}
            openInTabLabel={t("rightPanel.openInNewTab")}
          />
        ) : null}

        {showRemovalDiff && success && !isDelete && !sameFile ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">removed</span>
            <span
              className="tool-call-meta-value"
              data-path={removalFilePath}
              title={removalFilePath}
            >
              {removalFileName}
            </span>
          </div>
        ) : null}
        {showRemovalDiff && success ? (
          <MiniDiffViewer
            fileName={removalFileName}
            oldContent={removalContent}
            newContent=""
            startLine={success.sourceLineStart}
            onOpenInTab={handleOpenSourceInTab}
            openInTabLabel={t("rightPanel.openInNewTab")}
          />
        ) : null}

        {parsedResult.type === "raw" ? (
          <pre className="tool-call-section-pre">{parsedResult.text}</pre>
        ) : null}

        {parsedResult.type === "empty" && !hasError ? (
          <div className="tool-call-pending">
            {parsedArgs ? (
              <pre className="tool-call-section-pre">
                {JSON.stringify(parsedArgs, null, 2)}
              </pre>
            ) : (
              <span className="tool-call-section-label">No arguments</span>
            )}
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
