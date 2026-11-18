export const AUTO_COMPRESS_THRESHOLD_MIN_PERCENT = 30;
export const AUTO_COMPRESS_THRESHOLD_MAX_PERCENT = 100;
export const AUTO_COMPRESS_THRESHOLD_STEP_PERCENT = 1;
export const DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT = 80;
/** 阈值不高于该百分比时才允许开启异步压缩（需要给压缩期间的上下文增长留余量）。 */
export const ASYNC_COMPRESS_MAX_THRESHOLD_PERCENT = 50;

const parseInteger = (
  value: string | number | null | undefined,
): number | null => {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const normalizeAutoCompressThresholdPercent = (
  value: string | number | null | undefined,
): number => {
  const parsed = parseInteger(value) ?? DEFAULT_AUTO_COMPRESS_THRESHOLD_PERCENT;

  return Math.min(
    AUTO_COMPRESS_THRESHOLD_MAX_PERCENT,
    Math.max(AUTO_COMPRESS_THRESHOLD_MIN_PERCENT, parsed),
  );
};

export const calculateAutoCompressThresholdTokens = (
  maxContextTokens: string | number | null | undefined,
  thresholdPercent: string | number | null | undefined,
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
  thresholdTokens: number | null | undefined,
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
      Math.round((thresholdTokens / maxContextTokens) * 100),
    ),
  );
};
