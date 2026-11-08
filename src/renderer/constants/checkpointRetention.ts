// 检查点相关设置（与 Rust checkpoint/gc.rs、mcp/tools/mod.rs 保持一致）

// 检查点启停开关：默认启用；关闭后会话不再创建文件快照，回滚只能恢复会话消息
export const CHECKPOINT_ENABLED_SETTING = "checkpoint_enabled";

export const CHECKPOINT_ENABLED_SETTING_NAME = "检查点";

export const normalizeCheckpointEnabled = (raw: string | null): boolean => {
  const value = (raw ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false");
};

export const CHECKPOINT_ORPHAN_RETENTION_SETTING =
  "checkpoint_orphan_retention_days";

export const CHECKPOINT_ORPHAN_RETENTION_SETTING_NAME = "检查点快照保留";

export const CHECKPOINT_ORPHAN_RETENTION_DEFAULT_DAYS = 7;

export const CHECKPOINT_ORPHAN_RETENTION_MIN_DAYS = 1;

export const CHECKPOINT_ORPHAN_RETENTION_MAX_DAYS = 365;

export const normalizeCheckpointOrphanRetentionDays = (
  raw: string | null,
): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return CHECKPOINT_ORPHAN_RETENTION_DEFAULT_DAYS;
  }
  return Math.min(
    CHECKPOINT_ORPHAN_RETENTION_MAX_DAYS,
    Math.max(CHECKPOINT_ORPHAN_RETENTION_MIN_DAYS, parsed),
  );
};

// 远程（SSH）检查点扫描超时：超过该时长中止扫描并跳过本次快照
export const CHECKPOINT_REMOTE_SCAN_TIMEOUT_SETTING =
  "checkpoint_remote_scan_timeout_secs";

export const CHECKPOINT_REMOTE_SCAN_TIMEOUT_SETTING_NAME = "检查点远程扫描超时";

export const CHECKPOINT_REMOTE_SCAN_TIMEOUT_DEFAULT_SECS = 30;

export const CHECKPOINT_REMOTE_SCAN_TIMEOUT_MIN_SECS = 5;

export const CHECKPOINT_REMOTE_SCAN_TIMEOUT_MAX_SECS = 600;

export const normalizeCheckpointRemoteScanTimeoutSecs = (
  raw: string | null,
): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return CHECKPOINT_REMOTE_SCAN_TIMEOUT_DEFAULT_SECS;
  }
  return Math.min(
    CHECKPOINT_REMOTE_SCAN_TIMEOUT_MAX_SECS,
    Math.max(CHECKPOINT_REMOTE_SCAN_TIMEOUT_MIN_SECS, parsed),
  );
};
