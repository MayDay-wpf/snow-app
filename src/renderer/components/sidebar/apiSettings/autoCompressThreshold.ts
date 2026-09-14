export const AUTO_COMPRESS_THRESHOLD_MIN_PERCENT = 1;
export const AUTO_COMPRESS_THRESHOLD_MAX_PERCENT = 100;
export const AUTO_COMPRESS_THRESHOLD_STEP_PERCENT = 1;
export const DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT = 80;

const parseInteger = (
  value: string | number | null | undefined
): number | null => {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const normalizeAutoCompressThresholdPercent = (
  value: string | number | null | undefined
): number => {
  const parsed = parseInteger(value) ?? DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT;

  return Math.min(
    AUTO_COMPRESS_THRESHOLD_MAX_PERCENT,
    Math.max(AUTO_COMPRESS_THRESHOLD_MIN_PERCENT, parsed)
  );
};

export const calculateAutoCompressThresholdTokens = (
  maxContextTokens: string | number | null | undefined,
  thresholdPercent: string | number | null | undefined
): number | null => {
  const maxContext = parseInteger(maxContextTokens);

  if (maxContext == null || maxContext <= 0) {
    return null;
  }

  const percent = normalizeAutoCompressThresholdPercent(thresholdPercent);
  return Math.max(1, Math.round((maxContext * percent) / 100));
};

export const calculateAutoCompressThresholdPercent = (
  maxContextTokens: number | null | undefined,
  thresholdTokens: number | null | undefined
): string => {
  if (thresholdTokens == null || thresholdTokens <= 0) {
    return String(DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT);
  }

  if (thresholdTokens <= AUTO_COMPRESS_THRESHOLD_MAX_PERCENT) {
    return String(normalizeAutoCompressThresholdPercent(thresholdTokens));
  }

  if (maxContextTokens == null || maxContextTokens <= 0) {
    return String(DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT);
  }

  return String(
    normalizeAutoCompressThresholdPercent(
      Math.round((thresholdTokens / maxContextTokens) * 100)
    )
  );
};

/**
 * Fixed safety margin (tokens) the Rust pre-send guard subtracts from the
 * context window. Mirrors `CONTEXT_GUARD_SAFETY_MARGIN_TOKENS` in
 * native/src/api/conversation/context.rs — keep both in sync.
 */
export const CONTEXT_GUARD_SAFETY_MARGIN_TOKENS = 8_192;

/**
 * The guard's hard line in tokens: the largest request the backend will send
 * upstream. Mirrors `enforce_context_token_budget` (context.rs):
 * `maxContextTokens − max_tokens − max(maxContextTokens / 20, 8192)`.
 *
 * Returns null when the guard is disabled (no/invalid context window, or a
 * self-contradictory profile where output already consumes the whole window).
 */
export const calculateContextGuardHardLine = (
  maxContextTokens: string | number | null | undefined,
  maxTokens: string | number | null | undefined
): number | null => {
  const maxContext = parseInteger(maxContextTokens);

  if (maxContext == null || maxContext <= 0) {
    return null;
  }

  const outputReserve = Math.max(parseInteger(maxTokens) ?? 0, 0);
  const margin = Math.max(
    Math.floor(maxContext / 20),
    CONTEXT_GUARD_SAFETY_MARGIN_TOKENS
  );
  const hardLine = maxContext - outputReserve - margin;

  return hardLine > 0 ? hardLine : null;
};

/**
 * Detect a self-contradictory profile: an auto-compaction threshold that sits
 * ABOVE the guard's hard line never fires, because the guard rejects the
 * request first. Every request in `[hardLine, threshold)` fails with a
 * context-window error even though auto-compression was supposed to prevent
 * exactly that, leaving a manual "/compact" as the only way out.
 *
 * Returns the offending numbers so callers can explain the conflict, or null
 * when the profile is consistent (or auto-compression is off).
 */
export const detectAutoCompressConflict = (
  maxContextTokens: string | number | null | undefined,
  maxTokens: string | number | null | undefined,
  thresholdTokens: number | null | undefined
): { hardLine: number; threshold: number } | null => {
  const hardLine = calculateContextGuardHardLine(maxContextTokens, maxTokens);

  if (hardLine == null || thresholdTokens == null || thresholdTokens <= 0) {
    return null;
  }

  return thresholdTokens > hardLine
    ? { hardLine, threshold: thresholdTokens }
    : null;
};
