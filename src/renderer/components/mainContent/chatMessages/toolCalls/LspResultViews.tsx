import { useEffect, useState } from "react";
import { AlertCircle, ChevronRight, FileCode, ListTree } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { DocumentSymbolNode } from "./LspToolCall";
import type {
  BatchDiagnosticsFile,
  LspDiagnosticsSummary,
} from "./lspDiagnostics";
import type { LspRenameSafety } from "./lspRenameSafety";
import type { LspResultMeta } from "./lspResultMeta";

export function LspResultNotice({
  meta,
}: {
  meta: LspResultMeta;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section className="tool-call-lsp-result-notice" aria-live="polite">
      {meta.status === "failed" && (
        <p role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          {t("toolCall.lsp.resultStatus.failed")}
        </p>
      )}
      {meta.status === "partial" && (
        <p>
          <AlertCircle size={13} aria-hidden="true" />
          {t("toolCall.lsp.resultStatus.partial")}
        </p>
      )}
      {meta.unsupportedOperations && (
        <p role="alert">{t("toolCall.lsp.unsupportedOperations")}</p>
      )}
      {meta.truncated && <p>{t("toolCall.lsp.resultTruncated")}</p>}
      {meta.incomplete && <p>{t("toolCall.lsp.resultIncomplete")}</p>}
      {meta.requiresExplicitCoordinates && (
        <p>{t("toolCall.lsp.requiresCoordinates")}</p>
      )}
      {meta.languages.length > 0 && (
        <p>
          {t("toolCall.lsp.checkedLanguages")}: {meta.languages.join(", ")}
        </p>
      )}
      {meta.workspaceRoot && (
        <p>
          {t("toolCall.lsp.workspaceRoot")}: <code>{meta.workspaceRoot}</code>
        </p>
      )}
      {meta.failedFiles > 0 && (
        <p>
          {t("toolCall.lsp.failedFiles", {
            values: { count: meta.failedFiles },
          })}
        </p>
      )}
      {meta.warnings.length > 0 && (
        <ul>
          {meta.warnings.map((warning, index) => (
            <li key={`${warning.language ?? ""}:${index}`}>
              {warning.language && <strong>{warning.language}: </strong>}
              {warning.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const PAGE_SIZE = 80;

/** Branch children are instantiated only after expansion, including nested levels. */
function SymbolBranch({
  node,
  path,
}: {
  node: DocumentSymbolNode;
  path: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const location = node.selection?.start ?? node.range.start;
  const content = (
    <>
      <ListTree size={12} aria-hidden="true" />
      <code>{node.name}</code>
      <span className="tool-call-lsp-kind-badge">{node.kind}</span>
      <span>
        {location.line}:{location.column}
      </span>
      {node.detail && <span>{node.detail}</span>}
    </>
  );
  if (!node.children?.length)
    return <div className="tool-call-lsp-tree-leaf">{content}</div>;
  return (
    <details
      className="tool-call-lsp-tree-branch"
      open={open}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <ChevronRight size={12} aria-hidden="true" />
        {content}
        <span>({node.children.length})</span>
      </summary>
      {open && <LspSymbolTree nodes={node.children} parentPath={path} />}
    </details>
  );
}

export function LspSymbolTree({
  nodes,
  parentPath = "",
}: {
  nodes: DocumentSymbolNode[];
  parentPath?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [shown, setShown] = useState(PAGE_SIZE);
  return (
    <div className="tool-call-lsp-symbol-tree">
      {nodes.slice(0, shown).map((node, index) => {
        const path = `${parentPath}/${node.name}:${node.range.start.line}:${node.range.start.column}:${index}`;
        return <SymbolBranch key={path} node={node} path={path} />;
      })}
      {shown < nodes.length && (
        <button
          type="button"
          className="tool-call-lsp-show-more"
          onClick={() => setShown((count) => count + PAGE_SIZE)}
        >
          {t("toolCall.lsp.showMore", {
            values: { count: nodes.length - shown },
          })}
        </button>
      )}
    </div>
  );
}

function DiagnosticFile({
  file,
  defaultOpen,
}: {
  file: BatchDiagnosticsFile;
  defaultOpen: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState(PAGE_SIZE);
  const diagnostics = file.diagnostics;
  return (
    <details
      className={`tool-call-lsp-diag-file lsp-diagnostic-${file.status}`}
      open={open}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary className="tool-call-lsp-diag-file-header">
        <ChevronRight size={12} aria-hidden="true" />
        <FileCode size={12} aria-hidden="true" />
        <span className="tool-call-lsp-diag-file-name" title={file.filePath}>
          {file.filePath || t("toolCall.lsp.filePath")}
        </span>
        <span className="lsp-diagnostic-file-status">
          {t(`toolCall.lsp.fileStatus.${file.status}`)}
        </span>
        {file.truncated && (
          <span className="lsp-diagnostic-warning-badge">
            {t("toolCall.lsp.resultTruncated")}
          </span>
        )}
        {file.warnings.length > 0 && (
          <span className="lsp-diagnostic-warning-badge">
            {t("toolCall.lsp.fileWarnings", {
              values: { count: file.warnings.length },
            })}
          </span>
        )}
        <span className="tool-call-lsp-diag-file-summary">
          {file.summary ??
            t("toolCall.lsp.diagnosticsCount", {
              values: { count: diagnostics.length },
            })}
        </span>
      </summary>
      {file.error && (
        <p className="tool-call-error" role="alert">
          {file.error}
        </p>
      )}
      {file.status === "failed" && !file.error && (
        <p className="tool-call-error">{t("toolCall.lsp.failedEmpty")}</p>
      )}
      {file.truncated && (
        <p className="tool-call-lsp-file-notice">
          {t("toolCall.lsp.resultTruncated")}
        </p>
      )}
      {file.warnings.length > 0 && (
        <p className="tool-call-lsp-file-notice">
          {t("toolCall.lsp.fileWarnings", {
            values: { count: file.warnings.length },
          })}
        </p>
      )}
      {open && (
        <div className="tool-call-lsp-diag-list">
          {file.warnings.length > 0 && (
            <ul>
              {file.warnings.map((warning, index) => (
                <li key={index}>
                  {warning.language && `${warning.language}: `}
                  {warning.message}
                </li>
              ))}
            </ul>
          )}
          {diagnostics.slice(0, shown).map((diagnostic, index) => (
            <div
              key={`${diagnostic.line}:${diagnostic.column}:${index}`}
              className={`tool-call-lsp-diag-item severity-${diagnostic.severity ?? "unknown"}`}
            >
              <span className="tool-call-lsp-diag-sev">
                {diagnostic.severity ?? "?"}
              </span>
              <span className="tool-call-lsp-diag-loc">
                {diagnostic.line > 0
                  ? `${diagnostic.line}:${diagnostic.column}`
                  : "—"}
              </span>
              <span className="tool-call-lsp-diag-message">
                {diagnostic.message}
              </span>
              <span className="tool-call-lsp-diag-source">
                {diagnostic.source} {diagnostic.code}
              </span>
            </div>
          ))}
          {file.status !== "failed" && diagnostics.length === 0 && (
            <p>
              {t(
                file.status === "complete"
                  ? "toolCall.lsp.noDiagnostics"
                  : "toolCall.lsp.incompleteEmpty",
              )}
            </p>
          )}
          {shown < diagnostics.length && (
            <button
              type="button"
              className="tool-call-lsp-show-more"
              onClick={() => setShown((count) => count + PAGE_SIZE)}
            >
              {t("toolCall.lsp.showMore", {
                values: { count: diagnostics.length - shown },
              })}
            </button>
          )}
        </div>
      )}
    </details>
  );
}

export function LspDiagnosticsSummaryView({
  summary,
  compact = false,
}: {
  summary: LspDiagnosticsSummary;
  compact?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <span className={`lsp-diagnostics-summary${compact ? " is-compact" : ""}`}>
      <span>
        {t("toolCall.lsp.batchCount", { values: { count: summary.fileCount } })}
      </span>
      <span>
        {t("toolCall.lsp.batchStatusCounts", {
          values: {
            completed: summary.completedFiles,
            partial: summary.partialFiles,
            failed: summary.failedFiles,
          },
        })}
      </span>
      <span>
        {t("toolCall.lsp.batchDiagnosticCounts", {
          values: {
            errors: summary.errorCount,
            warnings: summary.warningCount,
          },
        })}
      </span>
      {!compact && summary.requestedCount !== undefined && (
        <span>
          {t("toolCall.lsp.requestedFiles", {
            values: { count: summary.requestedCount },
          })}
        </span>
      )}
      {!compact &&
        summary.duplicateCount !== undefined &&
        summary.duplicateCount > 0 && (
          <span>
            {t("toolCall.lsp.duplicateFiles", {
              values: { count: summary.duplicateCount },
            })}
          </span>
        )}
      {!compact && summary.countsFromReturnedDiagnostics && (
        <span>{t("toolCall.lsp.returnedDiagnosticsCounts")}</span>
      )}
    </span>
  );
}

export function LspDiagnosticsFiles({
  files,
  summary,
  complete,
}: {
  files: BatchDiagnosticsFile[];
  summary: LspDiagnosticsSummary;
  complete: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [shown, setShown] = useState(PAGE_SIZE);
  return (
    <div className="tool-call-lsp-diag-batch">
      <LspDiagnosticsSummaryView summary={summary} />
      {files.slice(0, shown).map((file, index) => (
        <DiagnosticFile
          key={`${file.filePath}:${index}`}
          file={file}
          defaultOpen={files.length === 1}
        />
      ))}
      {files.length === 0 && (
        <p>
          {t(
            complete
              ? "toolCall.lsp.noDiagnostics"
              : "toolCall.lsp.incompleteEmpty",
          )}
        </p>
      )}
      {shown < files.length && (
        <button
          type="button"
          className="tool-call-lsp-show-more"
          onClick={() => setShown((count) => count + PAGE_SIZE)}
        >
          {t("toolCall.lsp.showMore", {
            values: { count: files.length - shown },
          })}
        </button>
      )}
    </div>
  );
}

/** Only availability/expiry is presented; the capability itself never becomes a DOM value. */
export function LspRenameNotice({
  safety,
  applied,
  dryRun,
  blocked,
}: {
  safety: LspRenameSafety;
  applied: boolean;
  dryRun: boolean;
  blocked: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!safety.previewExpiresAt) return;
    const remaining = safety.previewExpiresAt - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(
      () => refresh((value) => value + 1),
      Math.min(remaining + 1, 2147483647),
    );
    return () => clearTimeout(timer);
  }, [safety.previewExpiresAt]);
  const expires = safety.previewExpiresAt;
  const expired = expires !== undefined && expires <= Date.now();
  const previewKey =
    blocked || !safety.hasPreview || safety.requiresNewPreview
      ? "toolCall.lsp.previewUnavailable"
      : expired
        ? "toolCall.lsp.previewExpired"
        : expires === undefined
          ? "toolCall.lsp.previewExpiryUnknown"
          : "toolCall.lsp.previewReady";
  return (
    <section className="tool-call-lsp-rename-safety" aria-live="polite">
      {!applied && dryRun && <p>{t(previewKey)}</p>}
      {!applied && dryRun && safety.hasPreview && expires !== undefined && (
        <p>
          {t("toolCall.lsp.previewExpires", {
            values: { time: new Date(expires).toLocaleString() },
          })}
        </p>
      )}
      {safety.partiallyApplied && (
        <p role="alert">{t("toolCall.lsp.renamePartialApplied")}</p>
      )}
      {safety.error && (
        <p className="tool-call-error" role="alert">
          {safety.error}
        </p>
      )}
      {safety.failedFile && (
        <p>
          {t("toolCall.lsp.renameFailedFile")}: <code>{safety.failedFile}</code>
        </p>
      )}
      {safety.failedFileMayBeModified && (
        <p role="alert">{t("toolCall.lsp.renameFailedFileMayBeModified")}</p>
      )}
      {safety.appliedFiles.length > 0 && (
        <div>
          <p>
            {t("toolCall.lsp.renameAppliedFiles", {
              values: { count: safety.appliedFiles.length },
            })}
          </p>
          <ul>
            {safety.appliedFiles.map((file, index) => (
              <li key={`${file}:${index}`}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {safety.requiresNewPreview && (
        <p>{t("toolCall.lsp.renameRequiresPreview")}</p>
      )}
    </section>
  );
}
