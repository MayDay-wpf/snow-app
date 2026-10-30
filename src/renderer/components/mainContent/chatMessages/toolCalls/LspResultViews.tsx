import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  Code,
  Code2,
  Copy,
  Crosshair,
  FileCode,
  FolderGit2,
  Hash,
  Info,
  Languages,
  ListTree,
  ScanSearch,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { formatDisplayPath } from "../../../../utils/formatDisplayPath";
import type {
  DocumentSymbolNode,
  SymbolFileResult,
  WorkspaceSymbolItem,
} from "./LspToolCall";
import type {
  BatchDiagnosticsFile,
  LspDiagnosticsSummary,
} from "./lspDiagnostics";
import type { LspRenameSafety } from "./lspRenameSafety";
import type { LspResultMeta } from "./lspResultMeta";

/** 清洗 Windows 设备扩展长路径前缀 \\?\ */
export const cleanWorkspacePath = (rawPath?: string): string =>
  rawPath ? formatDisplayPath(rawPath) : "";

export function LspResultNotice({
  meta,
}: {
  meta: LspResultMeta;
}): React.JSX.Element | null {
  const { t } = useI18n();

  const hasNotice =
    meta.status === "failed" ||
    meta.status === "partial" ||
    meta.unsupportedOperations ||
    meta.truncated ||
    meta.incomplete ||
    meta.requiresExplicitCoordinates ||
    meta.failedFiles > 0 ||
    meta.warnings.length > 0;

  if (!hasNotice && meta.languages.length === 0 && !meta.workspaceRoot) {
    return null;
  }

  const isFailed = meta.status === "failed" || meta.failedFiles > 0;
  const isWarning =
    !isFailed &&
    (meta.status === "partial" ||
      meta.truncated ||
      meta.incomplete ||
      meta.warnings.length > 0);

  const variantClass = isFailed
    ? "is-failed"
    : isWarning
      ? "is-warning"
      : "is-info";

  const cleanWorkspace = cleanWorkspacePath(meta.workspaceRoot);

  return (
    <section
      className={`tool-call-lsp-result-notice ${variantClass}`}
      aria-live="polite"
    >
      {/* 状态标头 */}
      <div className="tool-call-lsp-notice-header">
        <div className="tool-call-lsp-notice-title-wrap">
          {isFailed ? (
            <AlertCircle
              size={13}
              className="tool-call-lsp-notice-icon is-failed"
              aria-hidden="true"
            />
          ) : isWarning ? (
            <AlertTriangle
              size={13}
              className="tool-call-lsp-notice-icon is-warning"
              aria-hidden="true"
            />
          ) : (
            <Info
              size={13}
              className="tool-call-lsp-notice-icon is-info"
              aria-hidden="true"
            />
          )}
          <span className="tool-call-lsp-notice-title">
            {meta.status === "failed"
              ? t("toolCall.lsp.resultStatus.failed")
              : meta.status === "partial"
                ? t("toolCall.lsp.resultStatus.partial")
                : t("toolCall.lsp.result")}
          </span>
        </div>

        <div className="tool-call-lsp-notice-status-pills">
          {meta.truncated && (
            <span className="tool-call-lsp-notice-pill is-warning">
              {t("toolCall.lsp.truncated", {
                values: { count: "" },
                defaultValue: "结果截断",
              })
                .replace(/[{}]/g, "")
                .trim() || "结果截断"}
            </span>
          )}
          {meta.incomplete && (
            <span className="tool-call-lsp-notice-pill is-warning">
              {t("toolCall.lsp.incomplete", { defaultValue: "分析未完全" })}
            </span>
          )}
        </div>
      </div>

      {/* 描述与说明 */}
      {(meta.truncated ||
        meta.incomplete ||
        meta.unsupportedOperations ||
        meta.requiresExplicitCoordinates ||
        meta.failedFiles > 0) && (
        <div className="tool-call-lsp-notice-body">
          {meta.truncated && (
            <p className="tool-call-lsp-notice-desc">
              {t("toolCall.lsp.resultTruncated")}
            </p>
          )}
          {meta.incomplete && (
            <p className="tool-call-lsp-notice-desc">
              {t("toolCall.lsp.resultIncomplete")}
            </p>
          )}
          {meta.unsupportedOperations && (
            <p className="tool-call-lsp-notice-desc is-alert" role="alert">
              {t("toolCall.lsp.unsupportedOperations")}
            </p>
          )}
          {meta.requiresExplicitCoordinates && (
            <p className="tool-call-lsp-notice-desc">
              {t("toolCall.lsp.requiresCoordinates")}
            </p>
          )}
          {meta.failedFiles > 0 && (
            <p className="tool-call-lsp-notice-desc is-alert">
              {t("toolCall.lsp.failedFiles", {
                values: { count: meta.failedFiles },
              })}
            </p>
          )}
        </div>
      )}

      {/* 作用域与技术栈标签 */}
      {(meta.languages.length > 0 || cleanWorkspace) && (
        <div className="tool-call-lsp-notice-meta-bar">
          {meta.languages.length > 0 && (
            <div
              className="tool-call-lsp-meta-tag"
              title={`${t("toolCall.lsp.checkedLanguages")}: ${meta.languages.join(", ")}`}
            >
              <Languages size={11} aria-hidden="true" />
              <span className="tool-call-lsp-meta-tag-label">
                {t("toolCall.lsp.checkedLanguages")}:
              </span>
              <span className="tool-call-lsp-meta-tag-val">
                {meta.languages.join(", ")}
              </span>
            </div>
          )}
          {cleanWorkspace && (
            <div
              className="tool-call-lsp-meta-tag"
              title={`${t("toolCall.lsp.workspaceRoot")}: ${cleanWorkspace}`}
            >
              <FolderGit2 size={11} aria-hidden="true" />
              <span className="tool-call-lsp-meta-tag-label">
                {t("toolCall.lsp.workspaceRoot")}:
              </span>
              <code className="tool-call-lsp-meta-tag-code">
                {cleanWorkspace}
              </code>
            </div>
          )}
        </div>
      )}

      {/* 告警信息列表 */}
      {meta.warnings.length > 0 && (
        <div className="tool-call-lsp-notice-warnings-box">
          <div className="tool-call-lsp-notice-warnings-header">
            <AlertTriangle size={11} aria-hidden="true" />
            <span>告警信息 ({meta.warnings.length})</span>
          </div>
          <div className="tool-call-lsp-notice-warnings-list">
            {meta.warnings.map((warning, index) => (
              <div
                key={`${warning.language ?? ""}:${index}`}
                className="tool-call-lsp-notice-warning-row"
              >
                {warning.language && (
                  <span className="tool-call-lsp-notice-warning-lang">
                    {warning.language}
                  </span>
                )}
                <span className="tool-call-lsp-notice-warning-text">
                  {warning.message}
                </span>
              </div>
            ))}
          </div>
        </div>
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
  const { locale, t } = useI18n();
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
            values: { time: new Date(expires).toLocaleString(locale) },
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

// ---------------------------------------------------------------------------
// 现代增强型 LSP 视图组件：Hover, References, Goto
// ---------------------------------------------------------------------------

export type HoverItem = {
  target?: {
    filePath?: string;
    line?: number;
    column?: number;
    symbol?: string;
  };
  language?: string;
  contents: string;
  range?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  status?: string;
  error?: string;
};

export type ReferenceLocation = {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  context?: string;
};

export type ReferenceGroup = {
  target?: {
    filePath?: string;
    line?: number;
    column?: number;
    symbol?: string;
  };
  language?: string;
  symbol?: string;
  count: number;
  references: ReferenceLocation[];
  status?: string;
  error?: string;
};

export type DefinitionItem = {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
};

export type GotoGroup = {
  target?: {
    filePath?: string;
    line?: number;
    column?: number;
    symbol?: string;
    kind?: string;
  };
  language?: string;
  count: number;
  definitions: DefinitionItem[];
  status?: string;
  error?: string;
};

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/**
 * 解析并结构化 LSP Hover Markdown 内容：
 * 分离顶层的代码块定义（如 ```go ... ```）与文档注释说明文本。
 */
export const parseHoverContents = (
  raw: string,
): {
  codeSnippet?: { language: string; code: string };
  documentation?: string;
} => {
  if (!raw || typeof raw !== "string") return {};

  // 还原可能的转义序列
  let normalized = raw;
  if (!normalized.includes("\n") && normalized.includes("\\n")) {
    normalized = normalized
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }

  // 尝试匹配开头的代码围栏 ```lang\n...```
  const fenceMatch = normalized.match(/^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const language = fenceMatch[1] || "";
    const code = fenceMatch[2].trim();
    const remaining = normalized.slice(fenceMatch[0].length).trim();
    // 清理 markdown 分界线 "---" 或多余换行
    const documentation = remaining
      .replace(/^---\s*/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return {
      codeSnippet: { language, code },
      documentation: documentation || undefined,
    };
  }

  // 没有显式围栏时，按纯文本返回
  return { documentation: normalized.trim() };
};

/** 单个 Hover 项渲染卡片 */
export function LspHoverCard({
  item,
  index,
  total: _total,
}: {
  item: HoverItem;
  index: number;
  total: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const parsed = parseHoverContents(item.contents);

  const targetSymbol =
    item.target?.symbol ||
    (item.contents
      ? item.contents.match(
          /\b([A-Za-z0-9_]+)\s+struct\b|\bfunc\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)/,
        )?.[1]
      : undefined);
  const targetFile = item.target?.filePath
    ? getFileName(item.target.filePath)
    : "";
  const locationText =
    item.target?.line !== undefined && item.target?.column !== undefined
      ? `${item.target.line}:${item.target.column}`
      : item.range
        ? `${item.range.start.line}:${item.range.start.column}`
        : "";

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = parsed.codeSnippet?.code || item.contents;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="tool-call-lsp-hover-card">
      <div className="tool-call-lsp-hover-header">
        <div className="tool-call-lsp-hover-target">
          <Code
            size={12}
            className="tool-call-lsp-hover-icon"
            aria-hidden="true"
          />
          {targetSymbol ? (
            <code className="tool-call-lsp-hover-symbol">{targetSymbol}</code>
          ) : (
            <span className="tool-call-lsp-hover-item-index">#{index + 1}</span>
          )}
          {targetFile && (
            <span
              className="tool-call-lsp-hover-file"
              title={item.target?.filePath}
            >
              {targetFile}
            </span>
          )}
          {locationText && (
            <span className="tool-call-lsp-hover-loc">
              <Hash size={9} aria-hidden="true" />
              {locationText}
            </span>
          )}
        </div>

        <div className="tool-call-lsp-hover-actions">
          {item.language && (
            <span className="tool-call-lsp-lang-badge">{item.language}</span>
          )}
          <button
            type="button"
            className="tool-call-lsp-copy-btn"
            onClick={handleCopy}
            title={
              copied
                ? t("toolCall.lsp.copied", { defaultValue: "已复制" })
                : t("toolCall.lsp.copySignature", { defaultValue: "复制代码" })
            }
          >
            {copied ? (
              <Check size={11} className="copy-ok" />
            ) : (
              <Copy size={11} />
            )}
          </button>
        </div>
      </div>

      {item.error ? (
        <div className="tool-call-error" style={{ margin: "4px 8px 8px" }}>
          <AlertCircle size={12} aria-hidden="true" />
          <span>{item.error}</span>
        </div>
      ) : (
        <div className="tool-call-lsp-hover-content">
          {parsed.codeSnippet && (
            <div className="tool-call-lsp-hover-snippet-wrapper">
              <pre className="tool-call-lsp-hover-snippet">
                <code>{parsed.codeSnippet.code}</code>
              </pre>
            </div>
          )}

          {parsed.documentation && (
            <div className="tool-call-lsp-hover-doc">
              {parsed.documentation.split("\n\n").map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          )}

          {!parsed.codeSnippet && !parsed.documentation && (
            <pre
              className="tool-call-section-pre"
              style={{ whiteSpace: "pre-wrap" }}
            >
              {item.contents}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 完整 Hover 列表视图（支持批量与单项） */
export function LspHoverListView({
  items,
}: {
  items: HoverItem[];
}): React.JSX.Element {
  const { t } = useI18n();

  if (items.length === 0) {
    return (
      <div className="tool-call-codelens-no-results">
        <AlertCircle size={14} aria-hidden="true" />
        <span>{t("toolCall.lsp.completedEmpty")}</span>
      </div>
    );
  }

  return (
    <div className="tool-call-lsp-hover-list">
      {items.map((item, idx) => (
        <LspHoverCard
          key={`${item.target?.filePath ?? ""}-${item.target?.symbol ?? ""}-${idx}`}
          item={item}
          index={idx}
          total={items.length}
        />
      ))}
    </div>
  );
}

/** 现代结构化 References 视图（按文件清晰分组展示代码行上下文） */
export function LspReferencesListView({
  references,
  groups: _groups,
}: {
  references: ReferenceLocation[];
  groups?: ReferenceGroup[];
}): React.JSX.Element {
  const { t } = useI18n();

  // 优先按文件路径归类分组
  const fileGroups = useState(() => {
    const map = new Map<string, ReferenceLocation[]>();
    for (const ref of references) {
      const list = map.get(ref.filePath) || [];
      list.push(ref);
      map.set(ref.filePath, list);
    }
    return Array.from(map.entries()).map(([filePath, refs]) => ({
      filePath,
      references: refs,
    }));
  })[0];

  if (references.length === 0) {
    return (
      <div className="tool-call-codelens-no-results">
        <AlertCircle size={14} aria-hidden="true" />
        <span>{t("toolCall.lsp.noReferences")}</span>
      </div>
    );
  }

  return (
    <div className="tool-call-lsp-ref-container">
      {fileGroups.map((group, groupIdx) => (
        <div
          key={`${group.filePath}-${groupIdx}`}
          className="tool-call-lsp-ref-file-group"
        >
          <div className="tool-call-lsp-ref-file-header" title={group.filePath}>
            <FileCode size={12} aria-hidden="true" />
            <span className="tool-call-lsp-ref-file-name">
              {getFileName(group.filePath)}
            </span>
            <span className="tool-call-lsp-ref-file-path">
              {group.filePath}
            </span>
            <span className="tool-call-lsp-ref-file-badge">
              {t("toolCall.lsp.referencesCount", {
                values: { count: group.references.length },
              })}
            </span>
          </div>

          <div className="tool-call-lsp-ref-rows">
            {group.references.map((ref, refIdx) => (
              <div
                key={`${ref.line}:${ref.column}:${refIdx}`}
                className="tool-call-lsp-ref-row"
              >
                <span className="tool-call-lsp-ref-loc-badge">
                  <Hash size={9} aria-hidden="true" />
                  {ref.line}:{ref.column}
                </span>
                {ref.context ? (
                  <code
                    className="tool-call-lsp-ref-context"
                    title={ref.context}
                  >
                    {ref.context}
                  </code>
                ) : (
                  <span className="tool-call-lsp-ref-empty-context">
                    {t("toolCall.lsp.position")} {ref.line}:{ref.column}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 现代结构化 Goto 视图（定义 / 类型定义 / 实现） */
export function LspGotoListView({
  definitions,
  groups: _groups,
}: {
  definitions: DefinitionItem[];
  groups?: GotoGroup[];
}): React.JSX.Element {
  const { t } = useI18n();

  if (definitions.length === 0) {
    return (
      <div className="tool-call-codelens-no-results">
        <AlertCircle size={14} aria-hidden="true" />
        <span>{t("toolCall.lsp.noDefinitions")}</span>
      </div>
    );
  }

  return (
    <div className="tool-call-lsp-def-list">
      {definitions.map((def, idx) => (
        <div
          key={`${def.filePath}-${def.line}-${def.column}-${idx}`}
          className="tool-call-lsp-def-item"
        >
          <div className="tool-call-lsp-def-header" title={def.filePath}>
            <Crosshair size={11} aria-hidden="true" />
            <span className="tool-call-lsp-def-name">
              {getFileName(def.filePath)}
            </span>
            <span className="tool-call-lsp-def-path">{def.filePath}</span>
            <span className="tool-call-codelens-ref-file-count">
              <Hash size={9} aria-hidden="true" />
              {def.line}:{def.column}
              {def.endLine !== undefined && def.endColumn !== undefined
                ? ` → ${def.endLine}:${def.endColumn}`
                : ""}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SymbolFileItem({
  file,
  isOpen,
  onToggle,
}: {
  file: SymbolFileResult;
  isOpen: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopyPath = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!file.filePath) return;
      navigator.clipboard.writeText(file.filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [file.filePath],
  );

  return (
    <div
      className={`tool-call-lsp-symbol-file-group ${
        isOpen ? "is-open" : "is-closed"
      } status-${file.status || "complete"}`}
    >
      <div
        className="tool-call-lsp-symbol-file-header"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        title={file.filePath}
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`tool-call-lsp-symbol-file-arrow ${isOpen ? "open" : ""}`}
        />
        <FileCode
          size={13}
          aria-hidden="true"
          className="tool-call-lsp-symbol-file-icon"
        />
        <span className="tool-call-lsp-symbol-file-name">
          {getFileName(file.filePath) || t("toolCall.lsp.filePath")}
        </span>
        {file.filePath && (
          <span className="tool-call-lsp-symbol-file-path">
            {file.filePath}
          </span>
        )}
        {file.filePath && (
          <button
            type="button"
            className="tool-call-lsp-file-copy-btn"
            onClick={handleCopyPath}
            title={
              copied
                ? t("toolCall.lsp.copied", { defaultValue: "已复制" })
                : t("common.copyPath", { defaultValue: "复制路径" })
            }
          >
            {copied ? (
              <Check size={11} className="copy-ok" />
            ) : (
              <Copy size={11} />
            )}
          </button>
        )}
        <div className="tool-call-lsp-symbol-file-meta-right">
          {file.language && (
            <span className="tool-call-lsp-lang-badge">
              <Languages size={10} aria-hidden="true" />
              {file.language}
            </span>
          )}
          <span className="tool-call-lsp-symbol-file-count-badge">
            {t("toolCall.lsp.symbolsCount", {
              values: { shown: file.count, total: file.count },
              defaultValue: `${file.count} 个符号`,
            })}
          </span>
          {file.status && file.status !== "complete" && (
            <span
              className={`lsp-diagnostic-file-status status-${file.status}`}
            >
              {t(`toolCall.lsp.fileStatus.${file.status}`, {
                defaultValue: file.status,
              })}
            </span>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="tool-call-lsp-symbol-file-content">
          {file.error ? (
            <div className="tool-call-error" style={{ margin: "6px 8px" }}>
              <AlertCircle size={12} aria-hidden="true" />
              <span>{file.error}</span>
            </div>
          ) : file.symbols.length > 0 ? (
            <LspSymbolTree nodes={file.symbols} />
          ) : (
            <div className="tool-call-lsp-symbol-file-empty">
              <span>
                {t("toolCall.lsp.noSymbols", {
                  defaultValue: "该文件未解析到符号定义",
                })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 现代结构化 LSP 文件符号大纲多文件批处理视图 (LspBatchSymbolsView)
 * 支持单文件/多文件统一展示、按文件折叠展开、快捷复制路径、语言与符号微标
 */
export function LspBatchSymbolsView({
  files,
  summary,
}: {
  files: SymbolFileResult[];
  summary?: {
    completedFiles?: number;
    partialFiles?: number;
    failedFiles?: number;
    symbolCount?: number;
  };
}): React.JSX.Element {
  const { t } = useI18n();
  // 展开状态管理：默认展开第 1 个文件
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    files.forEach((f, idx) => {
      initial[f.filePath || String(idx)] = idx === 0;
    });
    return initial;
  });

  const allOpen = useMemo(() => {
    return (
      files.length > 0 &&
      files.every((f, idx) => openMap[f.filePath || String(idx)])
    );
  }, [files, openMap]);

  const toggleAll = useCallback(() => {
    const nextState = !allOpen;
    const updated: Record<string, boolean> = {};
    files.forEach((f, idx) => {
      updated[f.filePath || String(idx)] = nextState;
    });
    setOpenMap(updated);
  }, [allOpen, files]);

  const toggleFile = useCallback((key: string) => {
    setOpenMap((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  if (files.length === 0) {
    return (
      <div className="tool-call-codelens-no-results">
        <AlertCircle size={14} aria-hidden="true" />
        <span>{t("toolCall.lsp.noSymbols")}</span>
      </div>
    );
  }

  const totalSymbolCount =
    summary?.symbolCount ?? files.reduce((acc, f) => acc + f.count, 0);

  return (
    <div className="tool-call-lsp-symbols-batch">
      {files.length > 1 && (
        <div className="tool-call-lsp-symbols-batch-toolbar">
          <span className="tool-call-lsp-symbols-batch-summary">
            {t("toolCall.lsp.batchSymbolsCount", {
              values: {
                files: files.length,
                count: totalSymbolCount,
              },
              defaultValue: `${files.length} 文件 · ${totalSymbolCount} 符号`,
            })}
          </span>
          <button
            type="button"
            className="tool-call-lsp-symbols-toggle-all-btn"
            onClick={toggleAll}
          >
            {allOpen
              ? t("toolCall.lsp.collapseAll", { defaultValue: "全部折叠" })
              : t("toolCall.lsp.expandAll", { defaultValue: "全部展开" })}
          </button>
        </div>
      )}

      <div className="tool-call-lsp-symbols-batch-list">
        {files.map((file, idx) => {
          const key = file.filePath || String(idx);
          const isOpen = openMap[key] ?? idx === 0;
          return (
            <SymbolFileItem
              key={`${file.filePath}:${idx}`}
              file={file}
              isOpen={isOpen}
              onToggle={() => toggleFile(key)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 拆解符号名称：分离前置包/模块路径与核心符号标识 */
export function splitSymbolName(fullName: string): {
  scope?: string;
  name: string;
} {
  if (!fullName) return { name: "" };
  const lastSlash = fullName.lastIndexOf("/");
  if (lastSlash >= 0) {
    return {
      scope: fullName.slice(0, lastSlash),
      name: fullName.slice(lastSlash + 1),
    };
  }
  return { name: fullName };
}

function getSymbolKindCategory(
  kind?: string,
): "function" | "type" | "interface" | "constant" | "variable" | "default" {
  if (!kind) return "default";
  const k = kind.toLowerCase();
  if (k.includes("func") || k.includes("method") || k.includes("construct"))
    return "function";
  if (
    k.includes("struct") ||
    k.includes("class") ||
    k.includes("type") ||
    k.includes("enum")
  )
    return "type";
  if (k.includes("interface") || k.includes("trait")) return "interface";
  if (k.includes("const")) return "constant";
  if (k.includes("var") || k.includes("field") || k.includes("prop"))
    return "variable";
  return "default";
}

function WorkspaceSymbolRow({
  symbol,
  query: _query,
}: {
  symbol: WorkspaceSymbolItem;
  query?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const parsedName = useMemo(() => splitSymbolName(symbol.name), [symbol.name]);
  const category = useMemo(
    () => getSymbolKindCategory(symbol.kind),
    [symbol.kind],
  );

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!symbol.filePath) return;
    const loc =
      symbol.line !== undefined && symbol.line > 0
        ? `:${symbol.line}:${symbol.column ?? 0}`
        : "";
    navigator.clipboard.writeText(`${symbol.filePath}${loc}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const fileName = symbol.filePath ? getFileName(symbol.filePath) : "";
  const locationText =
    symbol.line !== undefined && symbol.line > 0
      ? `:${symbol.line}:${symbol.column ?? 0}`
      : "";

  return (
    <div className={`tool-call-lsp-symbol-item kind-${category}`}>
      <div className="tool-call-lsp-symbol-left">
        <span
          className={`tool-call-lsp-symbol-kind-icon kind-${category}`}
          aria-hidden="true"
        >
          {category === "function" ? (
            <Code2 size={12} />
          ) : category === "type" ? (
            <Boxes size={12} />
          ) : category === "constant" ? (
            <Hash size={12} />
          ) : (
            <ScanSearch size={12} />
          )}
        </span>

        <div className="tool-call-lsp-symbol-identity" title={symbol.name}>
          {parsedName.scope && (
            <span className="tool-call-lsp-symbol-scope">
              {parsedName.scope}/
            </span>
          )}
          <span className="tool-call-lsp-symbol-core-name">
            {parsedName.name}
          </span>
        </div>

        {symbol.kind && (
          <span className={`tool-call-lsp-kind-badge kind-${category}`}>
            {symbol.kind}
          </span>
        )}

        {symbol.detail && symbol.detail !== symbol.name && (
          <span className="tool-call-lsp-symbol-detail" title={symbol.detail}>
            {symbol.detail}
          </span>
        )}
      </div>

      {symbol.filePath && (
        <div className="tool-call-lsp-symbol-right">
          <div
            className="tool-call-lsp-symbol-file-loc"
            title={`${symbol.filePath}${locationText}`}
          >
            <FileCode
              size={11}
              className="tool-call-lsp-symbol-file-icon"
              aria-hidden="true"
            />
            <span className="tool-call-lsp-symbol-file-name">{fileName}</span>
            {locationText && (
              <span className="tool-call-lsp-symbol-loc">{locationText}</span>
            )}
          </div>
          <button
            type="button"
            className="tool-call-lsp-symbol-copy-btn"
            onClick={handleCopyPath}
            title={
              copied
                ? t("toolCall.lsp.copied", { defaultValue: "已复制" })
                : t("common.copyPath", { defaultValue: "复制路径" })
            }
          >
            {copied ? (
              <Check size={11} className="copy-ok" />
            ) : (
              <Copy size={11} />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export function LspWorkspaceSymbolsListView({
  symbols,
  query,
  total,
  count: _count,
  status,
}: {
  symbols: WorkspaceSymbolItem[];
  query?: string;
  total?: number;
  count?: number;
  status?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [copiedAll, setCopiedAll] = useState(false);

  const displayTotal = total ?? symbols.length;
  const isTruncated = displayTotal > symbols.length;

  const handleCopyAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    const listText = symbols
      .map((s) => {
        const loc = s.filePath
          ? ` ${s.filePath}${s.line !== undefined && s.line > 0 ? `:${s.line}:${s.column ?? 0}` : ""}`
          : "";
        return `${s.name}${s.kind ? ` [${s.kind}]` : ""}${loc}`;
      })
      .join("\n");
    navigator.clipboard.writeText(listText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };

  if (symbols.length === 0) {
    return (
      <div className="tool-call-codelens-no-results">
        <XCircle size={14} aria-hidden="true" />
        <span>
          {t(
            status === "partial"
              ? "toolCall.lsp.incompleteEmpty"
              : "toolCall.lsp.noSymbols",
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="tool-call-lsp-workspace-symbols">
      <div className="tool-call-lsp-ws-toolbar">
        <div className="tool-call-lsp-ws-toolbar-left">
          <ScanSearch
            size={12}
            className="tool-call-lsp-ws-toolbar-icon"
            aria-hidden="true"
          />
          <span className="tool-call-lsp-ws-toolbar-count">
            {isTruncated
              ? t("toolCall.lsp.symbolsCount", {
                  values: { shown: symbols.length, total: displayTotal },
                  defaultValue: `${symbols.length}/${displayTotal} 个符号`,
                })
              : t("toolCall.lsp.symbolsCount", {
                  values: { shown: symbols.length, total: symbols.length },
                  defaultValue: `${symbols.length} 个符号`,
                })}
          </span>
          {query && (
            <span className="tool-call-lsp-ws-query-pill" title={query}>
              <span className="tool-call-lsp-ws-query-pill-label">
                {t("toolCall.lsp.query")}:
              </span>
              <code className="tool-call-lsp-ws-query-pill-val">{query}</code>
            </span>
          )}
        </div>
        <button
          type="button"
          className="tool-call-lsp-ws-copy-all-btn"
          onClick={handleCopyAll}
          title={
            copiedAll
              ? t("toolCall.lsp.copied", { defaultValue: "已复制" })
              : t("toolCall.lsp.copyList", { defaultValue: "复制清单" })
          }
        >
          {copiedAll ? (
            <>
              <Check size={11} className="copy-ok" />
              <span>
                {t("toolCall.lsp.copied", { defaultValue: "已复制" })}
              </span>
            </>
          ) : (
            <>
              <Copy size={11} />
              <span>
                {t("toolCall.lsp.copyList", { defaultValue: "复制清单" })}
              </span>
            </>
          )}
        </button>
      </div>

      <div className="tool-call-lsp-symbol-list">
        {symbols.map((symbol, idx) => (
          <WorkspaceSymbolRow
            key={`${symbol.name}-${symbol.filePath ?? ""}-${symbol.line ?? 0}-${idx}`}
            symbol={symbol}
            query={query}
          />
        ))}
      </div>
    </div>
  );
}
