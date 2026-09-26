export type LspRenameSafety = {
  hasPreview: boolean;
  previewExpiresAt?: number;
  appliedFiles: string[];
  partiallyApplied: boolean;
  error?: string;
  failedFile?: string;
  failedFileMayBeModified: boolean;
  requiresNewPreview: boolean;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preview identifiers are capabilities, never presentation data. Mask them before any UI parsing or fallback. */
export function sanitizeLspResult(value: unknown): unknown {
  const tokens = new Set<string>();
  const collect = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(collect);
      return;
    }
    if (!record(item)) return;
    if (typeof item.previewId === "string" && item.previewId.trim())
      tokens.add(item.previewId);
    Object.values(item).forEach(collect);
  };
  collect(value);
  const clean = (item: unknown): unknown => {
    if (typeof item === "string") {
      let text = item;
      for (const token of tokens) text = text.split(token).join("[redacted]");
      return text;
    }
    if (Array.isArray(item)) return item.map(clean);
    if (record(item))
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, clean(child)]),
      );
    return item;
  };
  return tokens.size > 0 ? clean(value) : value;
}

export function readLspRenameSafety(
  value: Record<string, unknown>,
): LspRenameSafety {
  return {
    hasPreview:
      typeof value.previewId === "string" && value.previewId.trim().length > 0,
    previewExpiresAt:
      typeof value.previewExpiresAt === "number" &&
      Number.isFinite(value.previewExpiresAt)
        ? value.previewExpiresAt
        : undefined,
    appliedFiles: Array.isArray(value.appliedFiles)
      ? value.appliedFiles.filter(
          (file): file is string => typeof file === "string",
        )
      : [],
    partiallyApplied: value.partiallyApplied === true,
    error:
      typeof value.error === "string" && value.error.trim()
        ? value.error
        : undefined,
    failedFile:
      typeof value.failedFile === "string" ? value.failedFile : undefined,
    failedFileMayBeModified: value.failedFileMayBeModified === true,
    requiresNewPreview: value.requiresNewPreview === true,
  };
}
