import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  BackupCreateResult,
  BackupPlan,
  BackupScheduleSettings,
  BackupScheduleState,
  BackupSummary,
  BackupTaskProgress,
  CleanupCategoryId,
  CleanupDeleteResult,
  CleanupScanResult,
  DatabaseKind,
  DatabaseOptimizeResult,
  DatabaseRepairResult,
  OrphanProjectDeleteResult,
  OrphanProjectDeleteTarget,
  OrphanProjectScanResult,
  StorageLocationKind,
  StorageLocations,
  StorageMigrationProgress,
} from "../types/storage";

/** 存储位置（数据库 / 检查点 / 上传图片）API。 */
export const storageApi = {
  /** 读取各存储位置路径信息 */
  getStorageLocations: (): Promise<StorageLocations> =>
    ipcRenderer.invoke("storage:get-locations"),

  /** 在系统文件管理器中打开目录（跨平台）；失败时返回错误信息字符串，成功返回 null */
  openStorageDirectory: (dirPath: string): Promise<string | null> =>
    ipcRenderer.invoke("storage:open-directory", dirPath),

  /** 弹出目录选择对话框，返回选中目录路径或 null */
  selectStorageDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("storage:select-directory", dialogTitle),

  /** 设置 checkpoint / upload 自定义保存目录（传入空字符串重置为默认目录） */
  setStorageDir: (kind: StorageLocationKind, dir: string): Promise<void> =>
    ipcRenderer.invoke("storage:dir-set", kind, dir),

  /** 准备存储目录迁移：校验目标目录并写入迁移日志；返回待迁移文件数量（0 表示无需迁移） */
  prepareStorageMigration: (
    kind: StorageLocationKind,
    targetDir: string,
  ): Promise<number> =>
    ipcRenderer.invoke("storage:migrate-prepare", kind, targetDir),

  /** 复制下一批存储目录文件并返回迁移进度（copied/total/done） */
  migrateStorageChunk: (
    kind: StorageLocationKind,
  ): Promise<StorageMigrationProgress> =>
    ipcRenderer.invoke("storage:migrate-chunk", kind),

  /** 提交存储目录迁移：写入新目录设置并清理旧根目录文件 */
  commitStorageMigration: (kind: StorageLocationKind): Promise<void> =>
    ipcRenderer.invoke("storage:migrate-commit", kind),

  /** 回滚存储目录迁移：删除已复制到新目录的文件并移除日志（幂等） */
  rollbackStorageMigration: (kind: StorageLocationKind): Promise<void> =>
    ipcRenderer.invoke("storage:migrate-rollback", kind),

  /** 计算文件或目录的占用字节数（目录递归统计，用于展示存储占用） */
  getStoragePathSize: (path: string): Promise<number> =>
    ipcRenderer.invoke("storage:path-size", path),

  /** 修复数据库（runtime=运行库 / archive=归档库）：完整性检查、损坏恢复与压缩 */
  repairDatabase: (kind: DatabaseKind): Promise<DatabaseRepairResult> =>
    ipcRenderer.invoke("storage:repair-database", kind),

  /** 优化数据库磁盘占用（runtime=运行库 / archive=归档库）：VACUUM 回收空闲页并截断 WAL */
  optimizeDatabase: (kind: DatabaseKind): Promise<DatabaseOptimizeResult> =>
    ipcRenderer.invoke("storage:optimize-database", kind),

  /** 备份：预估一次本地目录备份的上传量（只读取与哈希，不写入目标目录） */
  backupLocalPlan: (targetDir: string): Promise<BackupPlan> =>
    ipcRenderer.invoke("storage:backup-plan", targetDir),

  /** 备份：创建一次本地目录备份；keep 为保留份数（1..50，默认 5） */
  backupLocalCreate: (
    targetDir: string,
    keep?: number,
  ): Promise<BackupCreateResult> =>
    ipcRenderer.invoke("storage:backup-create", targetDir, keep),

  /** 备份：列出目标目录中已有的备份，按创建时间倒序 */
  backupLocalList: (targetDir: string): Promise<BackupSummary[]> =>
    ipcRenderer.invoke("storage:backup-list", targetDir),

  /** 备份：从指定备份恢复 .snowapp（恢复完成后需重启应用） */
  backupLocalRestore: (targetDir: string, backupId: string): Promise<void> =>
    ipcRenderer.invoke("storage:backup-restore", targetDir, backupId),

  /** 备份：删除一份备份并回收不再被引用的数据块 */
  backupLocalDelete: (targetDir: string, backupId: string): Promise<void> =>
    ipcRenderer.invoke("storage:backup-delete", targetDir, backupId),

  /** 备份：返回备份根目录的绝对路径 */
  backupLocalRoot: (targetDir: string): Promise<string> =>
    ipcRenderer.invoke("storage:backup-root", targetDir),

  /** 备份 / 恢复任务的当前进度（读取 Rust 内存状态，供进度条轮询） */
  backupTaskProgress: (): Promise<BackupTaskProgress> =>
    ipcRenderer.invoke("storage:backup-progress"),

  /** 读取自动备份计划及其下次执行时间 */
  getBackupSchedule: (): Promise<BackupScheduleState> =>
    ipcRenderer.invoke("storage:backup-schedule-get"),

  /** 保存自动备份计划并重新安排下一次执行 */
  setBackupSchedule: (
    schedule: BackupScheduleSettings,
  ): Promise<BackupScheduleState> =>
    ipcRenderer.invoke("storage:backup-schedule-set", schedule),

  /** 订阅自动备份计划状态变化（主进程执行备份后推送） */
  onBackupScheduleChanged: (
    listener: (state: BackupScheduleState) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      state: BackupScheduleState,
    ): void => listener(state);
    ipcRenderer.on("storage:backup-schedule-changed", handler);
    return () =>
      ipcRenderer.removeListener("storage:backup-schedule-changed", handler);
  },

  /**
   * 扫描本地数据分类的占用（daysList 为需要一并统计的天数档位，如
   * [7, 15, 30, 90]；每个分类会返回各档位可清理的文件数与字节数）。
   */
  scanCleanup: (daysList: number[]): Promise<CleanupScanResult> =>
    ipcRenderer.invoke("storage:cleanup-scan", daysList),

  /**
   * 删除选中的清理分类数据（maxAgeDays 为 0 表示删除分类目录下的全部
   * 内容，否则只删除早于该天数的文件）。
   */
  deleteCleanupData: (
    categories: CleanupCategoryId[],
    maxAgeDays: number,
  ): Promise<CleanupDeleteResult> =>
    ipcRenderer.invoke("storage:cleanup-delete", categories, maxAgeDays),

  /** 扫描孤儿项目（已从项目列表移除但仍有残留数据的 directory_id） */
  scanOrphanProjects: (): Promise<OrphanProjectScanResult> =>
    ipcRenderer.invoke("storage:orphan-scan"),

  /** 删除孤儿项目的选中分类数据 */
  deleteOrphanProjectData: (
    targets: OrphanProjectDeleteTarget[],
  ): Promise<OrphanProjectDeleteResult> =>
    ipcRenderer.invoke("storage:orphan-delete", targets),
};
