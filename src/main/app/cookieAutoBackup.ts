import { app, safeStorage, session } from "electron";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { snowLog } from "../../utils/snowLogger";
import {
  collectSessionCookies,
  FILE_VERSION,
  readEncryptedStateFile,
  restoreSessionCookies,
  STATE_DIR,
  writeEncryptedStateFile,
  type StorageStateFile,
} from "../ipc/handlers/browserStorageState";

/**
 * 内置浏览器 Cookie 自动备份与丢失自愈。
 *
 * 背景：macOS Keychain "Chromium Safe Storage" 条目被其他 Electron 应用重建后
 * 密钥漂移，Chromium 解密旧 Cookie 失败会静默清空整库（Electron 无法自定义该
 * 密钥）。此处用「safeStorage 加密全量快照 + 启动丢失检测自动恢复」兜底，与
 * 手动登录态快照共享同一加密格式，落盘 ~/.snowapp/browser-state/auto-cookies。
 */

const AUTO_BACKUP_FILE = "auto-cookies";

/** 周期快照间隔：changed 事件仅置 dirty，到点且 dirty 才全量快照。 */
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
/** 备份少于该条数不参与丢失判定（小库误判无恢复价值）。 */
const MIN_BACKUP_COOKIES = 10;
/** 备份超龄不恢复：过期 Cookie 已无意义，且自然到期也会让当前数量骤减。 */
const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 当前 Cookie 数量 ≤ 备份的该比例视为丢失（容忍网站侧自然过期）。 */
const LOSS_RATIO = 0.2;

let snapshotTimer: NodeJS.Timeout | null = null;
let dirty = false;
let initialized = false;

const autoBackupPath = (): string => join(STATE_DIR, AUTO_BACKUP_FILE);

/** 读备份（不存在/损坏返回 null，不中断启动流程）。 */
const readAutoBackup = (): StorageStateFile | null => {
  if (!existsSync(autoBackupPath())) {
    return null;
  }
  try {
    return readEncryptedStateFile(autoBackupPath());
  } catch {
    return null;
  }
};

const isFreshBackup = (state: StorageStateFile): boolean => {
  const capturedMs = Date.parse(state.capturedAt);
  return (
    Number.isFinite(capturedMs) && Date.now() - capturedMs <= BACKUP_MAX_AGE_MS
  );
};

/** 疑似运行中被清空时保留备份（跳过覆盖），留待下次启动检测恢复。 */
const isSuspiciousWipe = (currentCount: number): boolean => {
  const prev = readAutoBackup();
  if (!prev || !isFreshBackup(prev)) {
    return false;
  }
  return (
    prev.cookies.length >= MIN_BACKUP_COOKIES &&
    currentCount < Math.floor(prev.cookies.length * LOSS_RATIO)
  );
};

const takeSnapshot = async (): Promise<void> => {
  const cookies = await collectSessionCookies(session.defaultSession);
  if (cookies.length === 0) {
    // 空库不落盘，防止异常清空后被空快照覆盖有效备份。
    return;
  }
  if (isSuspiciousWipe(cookies.length)) {
    return;
  }
  writeEncryptedStateFile(autoBackupPath(), {
    version: FILE_VERSION,
    capturedAt: new Date().toISOString(),
    capturedUrl: "",
    cookies,
    // 自动备份只保护 Cookie：localStorage 不经 Keychain 加密，无此丢失路径。
    localStorage: [],
  });
};

/** 启动丢失检测：当前 Cookie 骤减（典型为 Keychain 漂移被静默清库）则恢复。 */
const checkAndRestore = async (): Promise<void> => {
  const backup = readAutoBackup();
  if (!backup || !isFreshBackup(backup)) {
    return;
  }
  if (backup.cookies.length < MIN_BACKUP_COOKIES) {
    return;
  }
  const current = await session.defaultSession.cookies.get({});
  if (current.length > Math.floor(backup.cookies.length * LOSS_RATIO)) {
    return;
  }
  const result = await restoreSessionCookies(
    session.defaultSession,
    backup.cookies,
  );
  snowLog.warn({
    module: "app/cookieAutoBackup",
    func: "checkAndRestore",
    message: "Cookie loss detected on startup, restored from auto backup",
    context: `backup=${backup.cookies.length} current=${current.length} restored=${result.restored} failures=${result.failures}`,
  });
};

/** 用户显式清除 Cookie 时删除备份，避免下次启动自作聪明恢复。 */
export const deleteCookieAutoBackup = (): void => {
  try {
    unlinkSync(autoBackupPath());
  } catch {
    // 备份不存在即达到目的。
  }
};

/** 执行一次全量快照（失败仅记日志，不打断调用方）。 */
const runSnapshot = (): void => {
  void takeSnapshot().catch((error) => {
    snowLog.error({
      module: "app/cookieAutoBackup",
      func: "takeSnapshot",
      message: "Failed to snapshot cookies",
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

export const initCookieAutoBackup = (): void => {
  if (initialized) {
    return;
  }
  initialized = true;
  if (!safeStorage.isEncryptionAvailable()) {
    snowLog.warn({
      module: "app/cookieAutoBackup",
      func: "initCookieAutoBackup",
      message: "safeStorage unavailable, cookie auto backup disabled",
    });
    return;
  }
  // 恢复先行，完成后再开启周期快照，避免恢复前的新快照覆盖有效备份。
  void checkAndRestore()
    .catch((error) => {
      snowLog.error({
        module: "app/cookieAutoBackup",
        func: "checkAndRestore",
        message: "Failed to check/restore cookies from auto backup",
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      // 启动基线快照：不依赖 changed 事件，冷启动无 cookie 变化也要有保护，
      // 新版首次运行立即生成备份文件。
      runSnapshot();
      session.defaultSession.cookies.on("changed", () => {
        dirty = true;
      });
      snapshotTimer = setInterval(() => {
        if (!dirty) {
          return;
        }
        dirty = false;
        runSnapshot();
      }, SNAPSHOT_INTERVAL_MS);
    });

  app.on("before-quit", () => {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
    // best-effort 退出快照：退出窗口极短，主保护依赖周期快照。
    runSnapshot();
  });
};
