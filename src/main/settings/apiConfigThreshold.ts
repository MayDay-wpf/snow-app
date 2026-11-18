import { toIntegerOrNull } from "../utils/value";

const MIN_AUTO_COMPRESS_THRESHOLD_PERCENT = 30;
const MAX_AUTO_COMPRESS_THRESHOLD_PERCENT = 100;

const clampAutoCompressThresholdPercent = (value: number): number =>
  Math.min(
    MAX_AUTO_COMPRESS_THRESHOLD_PERCENT,
    Math.max(MIN_AUTO_COMPRESS_THRESHOLD_PERCENT, value),
  );

const toPercentOrNull = (value: unknown): number | null => {
  const percent = toIntegerOrNull(value);

  if (percent == null) {
    return null;
  }

  return clampAutoCompressThresholdPercent(percent);
};

const calculateThresholdTokensFromPercent = (
  percent: number,
  maxContextTokens: number,
): number => Math.max(1, Math.round((maxContextTokens * percent) / 100));

export const resolveAutoCompressThreshold = (
  thresholdTokens: unknown,
  thresholdPercent: unknown,
  maxContextTokens: number | null,
): number | null => {
  const explicitPercent = toPercentOrNull(thresholdPercent);

  if (
    explicitPercent != null &&
    maxContextTokens != null &&
    maxContextTokens > 0
  ) {
    return calculateThresholdTokensFromPercent(
      explicitPercent,
      maxContextTokens,
    );
  }

  const legacyThreshold = toIntegerOrNull(thresholdTokens);

  if (legacyThreshold == null) {
    return null;
  }

  if (
    legacyThreshold <= MAX_AUTO_COMPRESS_THRESHOLD_PERCENT &&
    maxContextTokens != null &&
    maxContextTokens > 0
  ) {
    return calculateThresholdTokensFromPercent(
      clampAutoCompressThresholdPercent(legacyThreshold),
      maxContextTokens,
    );
  }

  return legacyThreshold;
};
