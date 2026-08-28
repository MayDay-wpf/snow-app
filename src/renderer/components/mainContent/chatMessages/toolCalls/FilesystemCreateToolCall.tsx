import { useCallback, useMemo } from "react";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { getFileName } from "./shared/formatters";
import { MiniDiffViewer } from "./shared/MiniDiffViewer";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import {
  rightPanelEvents,
  type OpenFileDiffPreviewPayload,
} from "../../../rightPanel/rightPanelEvents";
import { useI18n } from "../../../../i18n";

type FilesystemCreateToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedCreateArgs = {
  filePath: string;
  content: string;
  overwrite?: boolean;
};

type ParsedCreateResult =
  | { type: "success"; path: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseArgs = (args: string): ParsedCreateArgs | null => {
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
      content: typeof parsed.content === "string" ? parsed.content : "",
      overwrite:
        typeof parsed.overwrite === "boolean" ? parsed.overwrite : undefined,
    };
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedCreateResult => {
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
          path: typeof parsed.path === "string" ? parsed.path : "",
        };
      }
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

export const FilesystemCreateToolCall = ({
  toolCall,
}: FilesystemCreateToolCallProps): React.JSX.Element => {
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const hasError = parsedResult.type === "error";

  const filePath = parsedArgs?.filePath ?? "create";
  const fileName = getFileName(filePath);

  const effectiveStatus = hasError ? "error" : toolCall.status;

  const lineCount = useMemo(() => {
    if (hasError) return 0;
    if (!parsedArgs?.content) return 0;
    return parsedArgs.content.split("\n").length;
  }, [parsedArgs, hasError]);

  const { t } = useI18n();

  const handleOpenInTab = useCallback(() => {
    if (!parsedArgs) {
      return;
    }
    const payload: OpenFileDiffPreviewPayload = {
      fileName,
      filePath,
      oldContent: "",
      newContent: parsedArgs.content,
      changeType: "added",
    };
    rightPanelEvents.emit("open-file-diff-preview", payload);
  }, [parsedArgs, fileName, filePath]);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="create"
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
        lineCount > 0 ? (
          <span className="tool-call-diff-stats">
            <span className="tool-call-diff-add">+{lineCount}</span>
          </span>
        ) : null
      }
      className="tool-call-filesystem-create"
      lazyBody
    >
      <div className="tool-call-body">
        {parsedResult.type === "success" ? (
          <div
            className="tool-call-success-row"
            data-path={parsedResult.path || filePath}
          >
            created {parsedResult.path || filePath}
          </div>
        ) : (
          <div className="tool-call-file-path" data-path={filePath}>
            {filePath}
          </div>
        )}
        {hasError ? (
          <div className="tool-call-error">
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {parsedArgs?.overwrite ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">overwrite</span>
            <span className="tool-call-meta-value">true</span>
          </div>
        ) : null}

        {!hasError && parsedArgs?.content ? (
          <MiniDiffViewer
            fileName={fileName}
            oldContent=""
            newContent={parsedArgs.content}
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
