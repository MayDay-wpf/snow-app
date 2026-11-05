import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  BackupCreateResult,
  BackupPlan,
  BackupSummary,
  BackupTaskProgress,
  CleanupCategoryId,
  CleanupDeleteResult,
  CleanupScanResult,
  DatabaseKind,
  DatabaseOptimizeResult,
  DatabaseRepairResult,
  NativeBridge,
  OrphanProjectCategoryId,
  OrphanProjectDeleteResult,
  OrphanProjectDeleteTarget,
  OrphanProjectScanResult,
  StorageLocationKind,
  StorageMigrationProgress,
} from "../../native/types";

import type { BackupScheduleState } from "../../../shared/backupSchedule";
import {
  getBackupScheduleState,
  setBackupSchedule,
} from "../../app/backupScheduler";

const isStorageLocationKind = (value: unknown): value is StorageLocationKind =>
  value === "checkpoint" || value === "upload";

/** 数据清理分类 id（与 Rust 侧 cleanup 服务保持一致） */
const CLEANUP_CATEGORY_IDS: readonly CleanupCategoryId[] = [
  "checkpoints",
  "upload",
  "imageLibrary",
  "backgrounds",
  "pets",
  "browserState",
  "appLogs",
];

const isCleanupCategoryId = (value: unknown): value is CleanupCategoryId =>
  typeof value === "string" &&
  (CLEANUP_CATEGORY_IDS as readonly string[]).includes(value);

/** 孤儿项目数据分类 id（与 Rust 侧 orphan_projects 服务保持一致） */
const ORPHAN_CATEGORY_IDS: readonly OrphanProjectCategoryId[] = [
  "conversations",
  "archives",
  "snapshots",
  "memories",
  "memos",
  "scheduledTasks",
  "reviews",
  "metadata",
];

const isOrphanCategoryId = (value: unknown): value is OrphanProjectCategoryId =>
  typeof value === "string" &&
  (ORPHAN_CATEGORY_IDS as readonly string[]).includes(value);

/** 备份目标目录：必须是非空字符串 */
const requireBackupDirectory = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Backup directory is required");
  }
  return value.trim();
};

/** 备份 id：字符集由 Rust 侧校验，这里只拦空值 */
const requireBackupId = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Backup id is required");
  }
  return value.trim();
};

/** 保留份数：非数字时交给 Rust 侧使用默认值 */
const normalizeBackupKeep = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
};

/**
 * 存储位置（数据库 / 检查点 / 上传图片）IPC。
 *
 * - `storage:get-locations`：读取各存储位置路径（数据库文件、检查点根、
 *   上传根与自定义目录设置）
 * - `storage:open-directory`：在系统文件管理器中打开目录（跨平台：
 *   Windows 资源管理器 / macOS Finder / Linux 文件管理器）
 * - `storage:select-directory`：弹出目录选择对话框
 * - `storage:dir-set`：设置 checkpoint / upload 自定义目录
 * - `storage:migrate-prepare / -chunk / -commit / -rollback`：更换目录时的
 *   迁移流程（与图库迁移一致的 prepare → 分批复制 → commit / rollback）
 * - `storage:cleanup-scan`：扫描本地数据分类的占用与各时间档位可清理量
 * - `storage:cleanup-delete`：删除选中的清理分类数据（Rust 侧执行）
 */
export const registerStorageHandlers = (native: NativeBridge): void => {
  ipcMain.handle("storage:get-locations", async (): Promise<unknown> => {
    const [storageInfo, checkpointDir, uploadDir, checkpointRoot, uploadRoot] =
      await Promise.all([
        native.initializeAppStorage(),
        native.getCheckpointDir(),
        native.getUploadDir(),
        native.getCheckpointRoot(),
        native.getUploadRoot(),
      ]);
    return {
      databasePath: storageInfo.databasePath,
      archiveDbPath: storageInfo.archiveDatabasePath,
      checkpointDir,
      uploadDir,
      checkpointRoot,
      uploadRoot,
    };
  });

  ipcMain.handle(
    "storage:open-directory",
    async (_event, dirPath: unknown): Promise<string | null> => {
      if (typeof dirPath !== "string" || dirPath.trim() === "") {
        throw new Error("Directory path is required");
      }
      // shell.openPath 跨平台：Windows 资源管理器 / macOS Finder /
      // Linux 文件管理器；失败时返回错误信息字符串，成功返回空字符串。
      const errorMessage = await shell.openPath(dirPath.trim());
      return errorMessage || null;
    },
  );

  ipcMain.handle(
    "storage:select-directory",
    async (event, dialogTitle: unknown): Promise<string | null> => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select directory";
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openDirectory", "createDirectory"],
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle(
    "storage:dir-set",
    async (_event, kind: unknown, dir: unknown): Promise<void> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      if (typeof dir !== "string") {
        throw new Error("Invalid storage directory");
      }
      if (kind === "checkpoint") {
        await native.setCheckpointDir(dir.trim());
      } else {
        await native.setUploadDir(dir.trim());
      }
    },
  );

  ipcMain.handle(
    "storage:migrate-prepare",
    async (_event, kind: unknown, targetDir: unknown): Promise<number> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      if (typeof targetDir !== "string") {
        throw new Error("Invalid storage target directory");
      }
      return native.prepareStorageMigration(kind, targetDir.trim());
    },
  );

  ipcMain.handle(
    "storage:migrate-chunk",
    async (_event, kind: unknown): Promise<StorageMigrationProgress> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      return native.migrateStorageChunk(kind);
    },
  );

  ipcMain.handle(
    "storage:migrate-commit",
    async (_event, kind: unknown): Promise<void> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      await native.commitStorageMigration(kind);
    },
  );

  ipcMain.handle(
    "storage:migrate-rollback",
    async (_event, kind: unknown): Promise<void> => {
      if (!isStorageLocationKind(kind)) {
        throw new Error("Invalid storage location kind");
      }
      await native.rollbackStorageMigration(kind);
    },
  );

  ipcMain.handle(
    "storage:path-size",
    async (_event, path: unknown): Promise<number> => {
      if (typeof path !== "string" || path.trim() === "") {
        throw new Error("Path is required");
      }
      return native.getPathSize(path.trim());
    },
  );

  ipcMain.handle(
    "storage:repair-database",
    async (_event, kind: unknown): Promise<DatabaseRepairResult> => {
      if (kind !== "runtime" && kind !== "archive") {
        throw new Error("Invalid database kind");
      }
      // Rust 端在 spawn_blocking 中执行完整性检查 / 恢复 / 压缩，
      // 不会阻塞主进程；参数校验后直接转发。
      return native.repairDatabase(kind as DatabaseKind);
    },
  );

  ipcMain.handle(
    "storage:optimize-database",
    async (_event, kind: unknown): Promise<DatabaseOptimizeResult> => {
      if (kind !== "runtime" && kind !== "archive") {
        throw new Error("Invalid database kind");
      }
      // Rust 端在 spawn_blocking 中执行 VACUUM + WAL 截断，
      // 不会阻塞主进程；参数校验后直接转发。
      return native.optimizeDatabase(kind as DatabaseKind);
    },
  );

  ipcMain.handle(
    "storage:backup-plan",
    async (_event, targetDir: unknown): Promise<BackupPlan> =>
      native.backupLocalPlan(requireBackupDirectory(targetDir)),
  );

  ipcMain.handle(
    "storage:backup-create",
    async (
      _event,
      targetDir: unknown,
      keep: unknown,
    ): Promise<BackupCreateResult> =>
      native.backupLocalCreate(
        requireBackupDirectory(targetDir),
        normalizeBackupKeep(keep),
      ),
  );

  ipcMain.handle(
    "storage:backup-list",
    async (_event, targetDir: unknown): Promise<BackupSummary[]> =>
      native.backupLocalList(requireBackupDirectory(targetDir)),
  );

  ipcMain.handle(
    "storage:backup-restore",
    async (_event, targetDir: unknown, backupId: unknown): Promise<void> => {
      await native.backupLocalRestore(
        requireBackupDirectory(targetDir),
        requireBackupId(backupId),
      );
    },
  );

  ipcMain.handle(
    "storage:backup-delete",
    async (_event, targetDir: unknown, backupId: unknown): Promise<void> => {
      await native.backupLocalDelete(
        requireBackupDirectory(targetDir),
        requireBackupId(backupId),
      );
    },
  );

  ipcMain.handle(
    "storage:backup-root",
    async (_event, targetDir: unknown): Promise<string> =>
      native.backupLocalRoot(requireBackupDirectory(targetDir)),
  );

  ipcMain.handle(
    "storage:backup-progress",
    async (): Promise<BackupTaskProgress> => native.backupTaskProgress(),
  );

  ipcMain.handle("storage:backup-schedule-get", (): BackupScheduleState =>
    getBackupScheduleState(),
  );

  ipcMain.handle(
    "storage:backup-schedule-set",
    async (_event, schedule: unknown): Promise<BackupScheduleState> =>
      setBackupSchedule(native, schedule),
  );

  ipcMain.handle(
    "storage:cleanup-scan",
    async (_event, daysList: unknown): Promise<CleanupScanResult> => {
      // Rust 端在 spawn_blocking 中遍历磁盘统计占用，不阻塞主进程。
      const days = Array.isArray(daysList)
        ? daysList
            .filter(
              (value): value is number =>
                typeof value === "number" &&
                Number.isFinite(value) &&
                value > 0,
            )
            .map((value) => Math.floor(value))
        : [];
      return native.scanCleanup(days);
    },
  );

  ipcMain.handle(
    "storage:cleanup-delete",
    async (
      _event,
      categories: unknown,
      maxAgeDays: unknown,
    ): Promise<CleanupDeleteResult> => {
      const selected = Array.isArray(categories)
        ? categories.filter(isCleanupCategoryId)
        : [];
      if (selected.length === 0) {
        throw new Error("No valid cleanup category selected");
      }
      // maxAgeDays = 0 表示不限制时间（删除分类目录下的全部内容）
      const days =
        typeof maxAgeDays === "number" &&
        Number.isFinite(maxAgeDays) &&
        maxAgeDays > 0
          ? Math.floor(maxAgeDays)
          : 0;
      return native.deleteCleanupData(selected, days);
    },
  );

  ipcMain.handle(
    "storage:orphan-scan",
    async (): Promise<OrphanProjectScanResult> => native.scanOrphanProjects(),
  );

  ipcMain.handle(
    "storage:orphan-delete",
    async (_event, targets: unknown): Promise<OrphanProjectDeleteResult> => {
      const selected: OrphanProjectDeleteTarget[] = Array.isArray(targets)
        ? targets.flatMap((target): OrphanProjectDeleteTarget[] => {
            if (!target || typeof target !== "object") {
              return [];
            }
            const { directoryId, categories } = target as Record<
              string,
              unknown
            >;
            if (typeof directoryId !== "string" || !directoryId.trim()) {
              return [];
            }
            const valid = Array.isArray(categories)
              ? categories.filter(isOrphanCategoryId)
              : [];
            return valid.length > 0 ? [{ directoryId, categories: valid }] : [];
          })
        : [];
      if (selected.length === 0) {
        throw new Error("No orphan project data selected");
      }
      return native.deleteOrphanProjectData(selected);
    },
  );
};
