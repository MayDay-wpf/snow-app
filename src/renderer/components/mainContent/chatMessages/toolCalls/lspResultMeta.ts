export type LspResultWarning = { language?: string; message: string };
export type LspResultMeta = {
  status: "complete" | "partial" | "failed" | "unknown";
  warnings: LspResultWarning[];
  languages: string[];
  workspaceRoot?: string;
  truncated: boolean;
  incomplete: boolean;
  unsupportedOperations: boolean;
  requiresExplicitCoordinates?: boolean;
  failedFiles: number;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read both the current result envelope and older persisted tool results. */
export function readLspResultMeta(value: unknown): LspResultMeta {
  const result = record(value) ? value : {};
  const warnings: LspResultWarning[] = Array.isArray(result.warnings)
    ? result.warnings.flatMap((warning): LspResultWarning[] => {
        if (typeof warning === "string") return [{ message: warning }];
        if (!record(warning)) return [];
        const message = warning.error ?? warning.message ?? warning.reason;
        return typeof message === "string"
          ? [
              {
                language:
                  typeof warning.language === "string"
                    ? warning.language
                    : undefined,
                message,
              },
            ]
          : [];
      })
    : [];
  const languages = Array.isArray(result.languages)
    ? result.languages.filter(
        (language): language is string => typeof language === "string",
      )
    : typeof result.language === "string" && result.language !== "multiple"
      ? [result.language]
      : [];
  const files = Array.isArray(result.files) ? result.files.filter(record) : [];
  const failedFiles = files.filter(
    (file) =>
      file.status === "failed" ||
      (file.status !== "partial" &&
        typeof file.error === "string" &&
        file.error.trim().length > 0),
  ).length;
  const truncated =
    result.truncated === true ||
    files.some((file) => file.truncated === true) ||
    (typeof result.total === "number" &&
      typeof result.count === "number" &&
      result.total > result.count);
  const incomplete =
    files.some(
      (file) =>
        file.partial === true ||
        file.incomplete === true ||
        file.status === "partial" ||
        (Array.isArray(file.warnings) && file.warnings.length > 0),
    ) ||
    result.incomplete === true ||
    result.isIncomplete === true ||
    result.partial === true ||
    result.status === "partial_symbol_search" ||
    result.status === "ambiguous_symbol";
  const unsupportedOperations = result.unsupportedOperations === true;
  const explicitStatus =
    result.status === "complete" ||
    result.status === "partial" ||
    result.status === "failed"
      ? result.status
      : undefined;
  const allLanguagesFailed =
    !explicitStatus &&
    result.status !== "partial_symbol_search" &&
    warnings.length > 0 &&
    Array.isArray(result.languages) &&
    languages.length === 0;
  const allFilesFailed = files.length > 0 && failedFiles === files.length;
  const hasError =
    typeof result.error === "string" && result.error.trim().length > 0;
  const partialApplication =
    result.partiallyApplied === true ||
    (hasError &&
      Array.isArray(result.appliedFiles) &&
      result.appliedFiles.length > 0);
  const status =
    explicitStatus === "failed"
      ? "failed"
      : explicitStatus === "partial" || partialApplication
        ? "partial"
        : hasError || allLanguagesFailed || allFilesFailed
          ? "failed"
          : warnings.length > 0 ||
              failedFiles > 0 ||
              truncated ||
              incomplete ||
              unsupportedOperations
            ? "partial"
            : (explicitStatus ?? (record(value) ? "complete" : "unknown"));
  for (const file of files) {
    if (typeof file.error === "string" && file.error.length > 0) {
      warnings.push({
        language: typeof file.language === "string" ? file.language : undefined,
        message: `${typeof file.filePath === "string" ? file.filePath + ": " : ""}${file.error}`,
      });
    }
  }
  return {
    status,
    warnings,
    languages,
    failedFiles,
    truncated,
    incomplete,
    unsupportedOperations,
    requiresExplicitCoordinates:
      result.requiresExplicitCoordinates === true ||
      result.status === "ambiguous_symbol",
    workspaceRoot:
      typeof result.workspaceRoot === "string"
        ? result.workspaceRoot
        : undefined,
  };
}
