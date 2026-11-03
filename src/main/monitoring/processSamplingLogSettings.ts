/**
 * 进程采样日志设置（全局）。
 *
 * 以单个 JSON 存于 Rust system_settings 表（code = process_sampling_log）。
 */
import type { NativeBridge } from "../native/types";

export type ProcessSamplingLogSettings = {
  /** 是否定时记录采样日志（全局开关，默认关闭） */
  enabled: boolean;
  /** 采样间隔（秒） */
  intervalSecs: number;
};

export const SAMPLING_LOG_INTERVAL_MIN_SECS = 5;
export const SAMPLING_LOG_INTERVAL_MAX_SECS = 3600;
export const SAMPLING_LOG_INTERVAL_DEFAULT_SECS = 60;

const SETTING_NAME = "Process sampling log settings";
const SETTING_CODE = "process_sampling_log";

export const DEFAULT_SAMPLING_LOG_SETTINGS: ProcessSamplingLogSettings = {
  enabled: false,
  intervalSecs: SAMPLING_LOG_INTERVAL_DEFAULT_SECS,
};

/** 存储读取的宽松归一化：非法字段回落默认值，间隔取整并钳制到合法区间。 */
const normalizeSettings = (value: unknown): ProcessSamplingLogSettings => {
  const source =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const interval =
    typeof source.intervalSecs === "number" &&
    Number.isFinite(source.intervalSecs)
      ? Math.round(source.intervalSecs)
      : SAMPLING_LOG_INTERVAL_DEFAULT_SECS;
  return {
    enabled: source.enabled === true,
    intervalSecs: Math.min(
      SAMPLING_LOG_INTERVAL_MAX_SECS,
      Math.max(SAMPLING_LOG_INTERVAL_MIN_SECS, interval),
    ),
  };
};

/** IPC 写入的严格校验：不合法直接报错，由界面提示用户修正。 */
export const parseSamplingLogInput = (
  value: unknown,
): ProcessSamplingLogSettings => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Sampling log settings must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== "boolean") {
    throw new Error("Sampling log enabled flag must be a boolean");
  }
  const interval = raw.intervalSecs;
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < SAMPLING_LOG_INTERVAL_MIN_SECS ||
    interval > SAMPLING_LOG_INTERVAL_MAX_SECS
  ) {
    throw new Error(
      `Sampling interval must be an integer from ${SAMPLING_LOG_INTERVAL_MIN_SECS} to ${SAMPLING_LOG_INTERVAL_MAX_SECS} seconds`,
    );
  }
  return { enabled: raw.enabled, intervalSecs: interval };
};

export const loadSamplingLogSettings = async (
  native: NativeBridge,
): Promise<ProcessSamplingLogSettings> => {
  try {
    const raw = await native.getSystemSettingValue(SETTING_CODE);
    if (raw !== null && raw.trim()) {
      return normalizeSettings(JSON.parse(raw));
    }
  } catch {
    // 损坏或读取失败：回落默认值（关闭）
  }
  return { ...DEFAULT_SAMPLING_LOG_SETTINGS };
};

export const saveSamplingLogSettings = async (
  native: NativeBridge,
  settings: ProcessSamplingLogSettings,
): Promise<void> => {
  await native.setSystemSetting(
    SETTING_NAME,
    SETTING_CODE,
    JSON.stringify(normalizeSettings(settings)),
  );
};
