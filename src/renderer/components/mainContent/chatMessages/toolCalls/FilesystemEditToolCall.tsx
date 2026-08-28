import { useCallback, useMemo } from "react";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { getFileName } from "./shared/formatters";
import { MiniDiffViewer } from "./shared/MiniDiffViewer";
import { getCompareDiffStats } from "../../../../utils/generateComparePatch";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import {
  rightPanelEvents,
  type OpenFileDiffPreviewPayload,
} from "../../../rightPanel/rightPanelEvents";
import { useI18n } from "../../../../i18n";

type FilesystemEditToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedEditArgs = {
  filePath: string;
  searchContent: string;
  replaceContent: string;
  occurrence?: number;
};

type ParsedEditResult =
  | {
      type: "success";
      matchIndex: number;
      totalMatches: number;
      occurrence: number;
      matchedLineStart?: number;
      matchedLineEnd?: number;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseArgs = (args: string): ParsedEditArgs | null => {
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const filePath = typeof parsed.filePath === "string" ? parsed.filePath : "";
    if (!filePath) {
      return null;
    }
    return {
      filePath,
      searchContent:
        typeof parsed.searchContent === "string" ? parsed.searchContent : "",
      replaceContent:
        typeof parsed.replaceContent === "string" ? parsed.replaceContent : "",
      occurrence:
        typeof parsed.occurrence === "number" ? parsed.occurrence : undefined,
    };
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedEditResult => {
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
          matchIndex:
            typeof parsed.matchIndex === "number" ? parsed.matchIndex : 0,
          totalMatches:
            typeof parsed.totalMatches === "number" ? parsed.totalMatches : 1,
          occurrence:
            typeof parsed.occurrence === "number" ? parsed.occurrence : 1,
          matchedLineStart:
            typeof parsed.matchedLineStart === "number"
              ? parsed.matchedLineStart
              : undefined,
          matchedLineEnd:
            typeof parsed.matchedLineEnd === "number"
              ? parsed.matchedLineEnd
              : undefined,
        };
      }
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

export const FilesystemEditToolCall = ({
  toolCall,
}: FilesystemEditToolCallProps): React.JSX.Element => {
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const hasError = parsedResult.type === "error";

  const showDiff =
    !hasError &&
    Boolean(parsedArgs?.searchContent) &&
    Boolean(parsedArgs?.replaceContent);

  const stats = useMemo(() => {
    if (!showDiff || !parsedArgs) return null;
    return getCompareDiffStats(
      parsedArgs.searchContent,
      parsedArgs.replaceContent,
    );
  }, [showDiff, parsedArgs]);

  const filePath = parsedArgs?.filePath ?? "edit";
  const fileName = getFileName(filePath);

  const effectiveStatus = hasError ? "error" : toolCall.status;

  const { t } = useI18n();

  const handleOpenInTab = useCallback(() => {
    if (!parsedArgs) {
      return;
    }
    const payload: OpenFileDiffPreviewPayload = {
      fileName,
      filePath,
      oldContent: parsedArgs.searchContent,
      newContent: parsedArgs.replaceContent,
      oldStartLine:
        parsedResult.type === "success"
          ? parsedResult.matchedLineStart
          : undefined,
      newStartLine:
        parsedResult.type === "success"
          ? parsedResult.matchedLineStart
          : undefined,
      changeType: "modified",
    };
    rightPanelEvents.emit("open-file-diff-preview", payload);
  }, [parsedArgs, parsedResult, fileName, filePath]);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="edit"
      displayName={
        <>
          {getFileTypeIcon(fileName, false, false, {
            size: 13,
            "aria-hidden": true,
          })}
          {fileName}
        </>
      }
      displayNameTitle={filePath}
      displayNameDataPath={filePath}
      status={effectiveStatus}
      meta={
        stats ? (
          <span className="tool-call-diff-stats">
            <span className="tool-call-diff-add">+{stats.additions}</span>
            <span className="tool-call-diff-del">-{stats.deletions}</span>
          </span>
        ) : null
      }
      className="tool-call-filesystem-edit"
      lazyBody
    >
      <div className="tool-call-body">
        <div className="tool-call-file-path" data-path={filePath}>
          {filePath}
        </div>
        {hasError ? (
          <div className="tool-call-error">
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {parsedArgs?.occurrence ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">occurrence</span>
            <span className="tool-call-meta-value">
              {parsedArgs.occurrence}
            </span>
          </div>
        ) : null}

        {parsedResult.type === "success" ? (
          <div className="tool-call-success-row">
            {parsedResult.matchedLineStart != null
              ? `matched at line ${parsedResult.matchedLineStart}${
                  parsedResult.matchedLineEnd != null &&
                  parsedResult.matchedLineEnd !== parsedResult.matchedLineStart
                    ? `-${parsedResult.matchedLineEnd}`
                    : ""
                }`
              : `matched at index ${parsedResult.matchIndex}`}
            {parsedResult.totalMatches > 1
              ? ` (${parsedResult.occurrence}/${parsedResult.totalMatches})`
              : ""}
          </div>
        ) : null}

        {showDiff && parsedArgs ? (
          <MiniDiffViewer
            fileName={fileName}
            oldContent={parsedArgs.searchContent}
            newContent={parsedArgs.replaceContent}
            startLine={
              parsedResult.type === "success"
                ? parsedResult.matchedLineStart
                : undefined
            }
            onOpenInTab={handleOpenInTab}
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
