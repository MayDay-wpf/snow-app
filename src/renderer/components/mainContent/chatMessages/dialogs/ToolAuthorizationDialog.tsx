import { FilePen, FilePlus, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import { getCompareDiffStats } from "../../../../utils/generateComparePatch";
import { keyToDisplay } from "../../../../utils/shortcutUtils";
import { isEditableContentEmpty } from "../../chatInput/fileTagUtils";
import { RichContentInput } from "../../chatInput/RichContentInput";
import { getFileName } from "../toolCalls/shared/formatters";
import { MiniDiffViewer } from "../toolCalls/shared/MiniDiffViewer";
import type { ToolCallInfo } from "../utils/conversationTypes";

type ToolAuthorizationDialogProps = {
  toolCalls: ToolCallInfo[];
  onApprove: (toolCall: ToolCallInfo) => void;
  onApproveAlways: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
};

type FileMutationKind = "edit" | "create";

type FileMutationPreview = {
  kind: FileMutationKind;
  filePath: string;
  fileName: string;
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
  occurrence?: number;
  overwrite?: boolean;
};

const FILE_EDIT_TOOL = "filesystem-replace_edit";
const FILE_CREATE_TOOL = "filesystem-create";

const isFileMutationTool = (toolName: string): boolean =>
  toolName === FILE_EDIT_TOOL || toolName === FILE_CREATE_TOOL;

const parseFileMutationPreview = (
  toolCall: ToolCallInfo,
): FileMutationPreview | null => {
  if (!isFileMutationTool(toolCall.name)) {
    return null;
  }

  try {
    const parsed = JSON.parse(toolCall.arguments || "{}") as Record<
      string,
      unknown
    >;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const filePath =
      typeof parsed.filePath === "string" ? parsed.filePath.trim() : "";
    if (!filePath) {
      return null;
    }

    if (toolCall.name === FILE_EDIT_TOOL) {
      const searchContent =
        typeof parsed.searchContent === "string" ? parsed.searchContent : "";
      const replaceContent =
        typeof parsed.replaceContent === "string" ? parsed.replaceContent : "";
      const occurrence =
        typeof parsed.occurrence === "number" ? parsed.occurrence : undefined;
      const { additions, deletions } = getCompareDiffStats(
        searchContent,
        replaceContent,
      );

      return {
        kind: "edit",
        filePath,
        fileName: getFileName(filePath),
        oldContent: searchContent,
        newContent: replaceContent,
        additions,
        deletions,
        occurrence,
      };
    }

    const content = typeof parsed.content === "string" ? parsed.content : "";
    const overwrite =
      typeof parsed.overwrite === "boolean" ? parsed.overwrite : undefined;
    const additions = content ? content.split("\n").length : 0;

    return {
      kind: "create",
      filePath,
      fileName: getFileName(filePath),
      oldContent: "",
      newContent: content,
      additions,
      deletions: 0,
      overwrite,
    };
  } catch {
    return null;
  }
};

const FileMutationAuthorizationPreview = ({
  preview,
}: {
  preview: FileMutationPreview;
}): React.JSX.Element => {
  const { t } = useI18n();
  const KindIcon = preview.kind === "edit" ? FilePen : FilePlus;

  return (
    <div className="tool-authorization-file-preview">
      <div className="tool-authorization-file-meta">
        <span className="tool-authorization-file-kind" data-kind={preview.kind}>
          <KindIcon size={12} aria-hidden="true" />
          <span>
            {preview.kind === "edit"
              ? t("toolAuthorization.fileEdit")
              : t("toolAuthorization.fileCreate")}
          </span>
        </span>
        <div className="tool-authorization-file-path-row">
          {getFileTypeIcon(preview.fileName, false, false, {
            size: 14,
            "aria-hidden": true,
          })}
          <code
            className="tool-authorization-file-path"
            title={preview.filePath}
          >
            {preview.fileName}
          </code>
          {preview.additions > 0 || preview.deletions > 0 ? (
            <span className="tool-call-diff-stats">
              {preview.additions > 0 ? (
                <span className="tool-call-diff-add">+{preview.additions}</span>
              ) : null}
              {preview.deletions > 0 ? (
                <span className="tool-call-diff-del">-{preview.deletions}</span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div
          className="tool-authorization-file-full-path"
          title={preview.filePath}
        >
          {preview.filePath}
        </div>
        {preview.occurrence ? (
          <div className="tool-authorization-file-extra">
            {t("toolAuthorization.occurrence", {
              values: { value: String(preview.occurrence) },
            })}
          </div>
        ) : null}
        {preview.overwrite ? (
          <div className="tool-authorization-file-extra">
            {t("toolAuthorization.overwrite")}
          </div>
        ) : null}
      </div>

      {preview.oldContent || preview.newContent ? (
        <MiniDiffViewer
          fileName={preview.fileName}
          oldContent={preview.oldContent}
          newContent={preview.newContent}
        />
      ) : (
        <div className="tool-authorization-file-empty">
          {t("toolAuthorization.noDiff")}
        </div>
      )}
    </div>
  );
};

const AuthorizationToolItem = ({
  toolCall,
  isSubmitting,
  onApprove,
  onApproveAlways,
  onReject,
}: {
  toolCall: ToolCallInfo;
  isSubmitting: boolean;
  onApprove: (toolCall: ToolCallInfo) => void;
  onApproveAlways: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [rejectionReason, setRejectionReason] = useState("");
  const authorizationId =
    toolCall.authorizationId ??
    `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`;
  const filePreview = useMemo(
    () => parseFileMutationPreview(toolCall),
    [toolCall],
  );
  const isFileMutation = filePreview !== null;
  // 拒绝理由是富文本：空态下 contenteditable 会残留换行符，需按编辑区口径判空，
  // 否则「未填写理由」会被当成用户理由（不再回落到默认理由）。
  const trimmedReason = isEditableContentEmpty(rejectionReason)
    ? ""
    : rejectionReason.trim();

  /** 拒绝：理由为空时回落到默认理由（与「拒绝」按钮一致）。 */
  const handleReject = (): void => {
    if (isSubmitting) {
      return;
    }
    onReject(
      toolCall,
      trimmedReason || t("toolAuthorization.defaultRejectionReason"),
      trimmedReason.length > 0,
    );
  };

  /**
   * 拒绝理由输入框的 Ctrl/Cmd + Enter：填写了理由才生效，等同「拒绝」按钮，
   * 免去移动鼠标。
   */
  const handleReasonKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (
      event.key !== "Enter" ||
      !(event.ctrlKey || event.metaKey) ||
      event.nativeEvent.isComposing ||
      !trimmedReason
    ) {
      return;
    }
    event.preventDefault();
    handleReject();
  };

  return (
    <article className="tool-authorization-prompt-item" key={authorizationId}>
      {isFileMutation && filePreview ? (
        <FileMutationAuthorizationPreview preview={filePreview} />
      ) : (
        <>
          <div className="tool-authorization-tool-row">
            <span className="tool-authorization-tool-label">
              {t("toolAuthorization.toolName")}
            </span>
            <code className="tool-authorization-tool-name">
              {toolCall.name}
            </code>
          </div>
          <div className="tool-authorization-args">
            <span className="tool-authorization-tool-label">
              {t("toolAuthorization.arguments")}
            </span>
            <pre>{toolCall.arguments || "{}"}</pre>
          </div>
        </>
      )}
      <div className="tool-authorization-rejection-reason">
        <span className="tool-authorization-tool-label">
          {t("toolAuthorization.rejectionReason")}
        </span>
        <RichContentInput
          className="tool-authorization-rejection-input"
          disabled={isSubmitting}
          placeholder={t("toolAuthorization.rejectionReasonPlaceholder")}
          ariaLabel={t("toolAuthorization.rejectionReason")}
          onChange={setRejectionReason}
          onKeyDown={handleReasonKeyDown}
        />
        <span className="tool-authorization-rejection-hint">
          {t("toolAuthorization.rejectionShortcutHint", {
            values: { keys: keyToDisplay("mod+enter") },
          })}
        </span>
      </div>
      <div className="tool-authorization-actions">
        <button
          className="tool-authorization-action tool-authorization-reject"
          disabled={isSubmitting}
          onClick={handleReject}
          type="button"
        >
          {t("toolAuthorization.reject")}
        </button>
        <button
          className="tool-authorization-action tool-authorization-approve"
          disabled={isSubmitting}
          onClick={() => {
            onApprove(toolCall);
          }}
          type="button"
        >
          {t("toolAuthorization.approve")}
        </button>
        <button
          className="tool-authorization-action tool-authorization-approve-always"
          disabled={isSubmitting}
          onClick={() => {
            onApproveAlways(toolCall);
          }}
          type="button"
        >
          {t("toolAuthorization.approveAlways")}
        </button>
      </div>
    </article>
  );
};

export const ToolAuthorizationDialog = ({
  toolCalls,
  onApprove,
  onApproveAlways,
  onReject,
}: ToolAuthorizationDialogProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const [submittingAuthorizationId, setSubmittingAuthorizationId] = useState<
    string | null
  >(null);

  if (toolCalls.length === 0) {
    return null;
  }

  const hasFileMutation = toolCalls.some((toolCall) =>
    isFileMutationTool(toolCall.name),
  );
  const onlyFileMutations = toolCalls.every((toolCall) =>
    isFileMutationTool(toolCall.name),
  );

  const title = onlyFileMutations
    ? t("toolAuthorization.fileTitle")
    : t("toolAuthorization.title");
  const message = onlyFileMutations
    ? t("toolAuthorization.fileMessage")
    : hasFileMutation
      ? t("toolAuthorization.mixedMessage")
      : t("toolAuthorization.message");

  return (
    <section className="tool-authorization-prompt" aria-label={title}>
      <div className="tool-authorization-prompt-heading">
        <span className="tool-authorization-prompt-icon" aria-hidden="true">
          <ShieldAlert size={14} />
        </span>
        <div className="tool-authorization-prompt-copy">
          <strong>{title}</strong>
          <p>{message}</p>
        </div>
      </div>
      <div className="tool-authorization-prompt-list">
        {toolCalls.map((toolCall) => {
          const authorizationId =
            toolCall.authorizationId ??
            `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`;
          const isSubmitting = submittingAuthorizationId === authorizationId;

          return (
            <AuthorizationToolItem
              key={authorizationId}
              toolCall={toolCall}
              isSubmitting={isSubmitting}
              onApprove={(item) => {
                setSubmittingAuthorizationId(
                  item.authorizationId ?? authorizationId,
                );
                onApprove(item);
              }}
              onApproveAlways={(item) => {
                setSubmittingAuthorizationId(
                  item.authorizationId ?? authorizationId,
                );
                onApproveAlways(item);
              }}
              onReject={(item, reason, userProvidedReason) => {
                setSubmittingAuthorizationId(
                  item.authorizationId ?? authorizationId,
                );
                onReject(item, reason, userProvidedReason);
              }}
            />
          );
        })}
      </div>
    </section>
  );
};
