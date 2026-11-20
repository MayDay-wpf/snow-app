/** Token 数值的紧凑单位换算：K / M / B / T / Q / Qi。 */
export const formatTokens = (value: number, locale?: string): string => {
  if (value < 1000) {
    return value.toLocaleString(locale);
  }
  const units: Array<[number, string]> = [
    [1_000_000_000_000_000_000, "Qi"],
    [1_000_000_000_000_000, "Q"],
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [threshold, suffix] of units) {
    if (value >= threshold) {
      const scaled = value / threshold;
      const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(decimals)}${suffix}`;
    }
  }
  return value.toLocaleString(locale);
};

/** 模型上下文窗口的徽章文案：1,048,576 -> 1M，1,050,000 -> 1.1M，128,000 -> 128K。 */
export const formatContextWindow = (value: number): string => {
  if (value >= 1_000_000) {
    const scaled = (value / 1_000_000).toFixed(1);
    return `${scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
};
