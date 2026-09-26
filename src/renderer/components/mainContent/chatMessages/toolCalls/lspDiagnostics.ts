import { readLspResultMeta, type LspResultWarning } from "./lspResultMeta";

export type DiagnosticItem = {
  severity?: string;
  message: string;
  source?: string;
  code?: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
};
export type BatchDiagnosticsFile = {
  filePath: string;
  language?: string;
  summary?: string;
  diagnostics: DiagnosticItem[];
  error?: string;
  status: "complete" | "partial" | "failed";
  warnings: LspResultWarning[];
  truncated: boolean;
};
export type LspDiagnosticsSummary = {
  fileCount: number;
  requestedCount?: number;
  duplicateCount?: number;
  completedFiles: number;
  partialFiles: number;
  failedFiles: number;
  errorCount: number;
  warningCount: number;
  countsFromReturnedDiagnostics: boolean;
};
export type LspDiagnosticsResult = {
  type: "diagnostics-batch";
  fileCount: number;
  files: BatchDiagnosticsFile[];
  summary: LspDiagnosticsSummary;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** Normalize legacy single-file responses and the ordered batch envelope without reordering or truncation. */
export function readLspDiagnostics(
  value: Record<string, unknown>,
  fallbackFilePath = "",
): LspDiagnosticsResult {
  const rawFiles = Array.isArray(value.files) ? value.files : [value];
  const files: BatchDiagnosticsFile[] = rawFiles.filter(record).map((file) => {
    const meta = readLspResultMeta(file);
    const diagnostics: DiagnosticItem[] = Array.isArray(file.diagnostics)
      ? file.diagnostics
          .filter(record)
          .flatMap((diagnostic): DiagnosticItem[] => {
            const message = text(diagnostic.message);
            if (message === undefined) return [];
            return [
              {
                message,
                severity: text(diagnostic.severity),
                source: text(diagnostic.source),
                code:
                  typeof diagnostic.code === "number"
                    ? String(diagnostic.code)
                    : text(diagnostic.code),
                line: count(diagnostic.line) ?? 0,
                column: count(diagnostic.column) ?? 0,
                endLine: count(diagnostic.endLine),
                endColumn: count(diagnostic.endColumn),
              },
            ];
          })
      : [];
    const error = text(file.error)?.trim() || undefined;
    // A legacy file with an explicit status is authoritative; missing status is derived from warnings/errors.
    const status =
      meta.status === "failed"
        ? "failed"
        : meta.status === "partial"
          ? "partial"
          : "complete";
    return {
      filePath: text(file.filePath) ?? fallbackFilePath,
      language: text(file.language),
      summary: text(file.summary),
      diagnostics,
      error,
      status,
      warnings: meta.warnings,
      truncated: meta.truncated,
    };
  });
  const summary = record(value.summary) ? value.summary : {};
  const diagnostics = files.flatMap((file) => file.diagnostics);
  const fileCount = count(value.fileCount) ?? files.length;
  return {
    type: "diagnostics-batch",
    fileCount,
    files,
    summary: {
      fileCount,
      requestedCount: count(value.requestedCount),
      duplicateCount: count(value.duplicateCount),
      completedFiles:
        count(summary.completedFiles) ??
        files.filter((file) => file.status === "complete").length,
      partialFiles:
        count(summary.partialFiles) ??
        files.filter((file) => file.status === "partial").length,
      failedFiles:
        count(summary.failedFiles) ??
        files.filter((file) => file.status === "failed").length,
      errorCount:
        count(summary.errorCount) ??
        diagnostics.filter((diagnostic) => diagnostic.severity === "error")
          .length,
      warningCount:
        count(summary.warningCount) ??
        diagnostics.filter((diagnostic) => diagnostic.severity === "warning")
          .length,
      countsFromReturnedDiagnostics:
        value.summaryCountsPartial === true ||
        files.some((file) => file.truncated) ||
        count(summary.errorCount) === undefined ||
        count(summary.warningCount) === undefined,
    },
  };
}
