import {
  Archive,
  Bot,
  CircleCheck,
  Database,
  DatabaseBackup,
  Download,
  FileText,
  Filter,
  FolderCog,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Images,
  Info,
  LoaderCircle,
  LockKeyhole,
  MemoryStick,
  Recycle,
  RefreshCw,
  RotateCcw,
  Scale,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localeLabels, useI18n, type Locale } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { AppLockSettingsSection } from "./AppLockSettingsSection";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CustomSelect } from "../common/CustomSelect";
import { OPEN_UPDATE_DIALOG_EVENT } from "./UpdateDialog";
import {
  TEAM_ENABLED_CHANGED_EVENT,
  TEAM_ENABLED_SETTING,
} from "../mainContent/team/useTeamData";
import {
  CLOSE_BEHAVIOR_SETTING_CODE,
  CLOSE_BEHAVIOR_SETTING_NAME,
  normalizeCloseBehavior,
  type CloseBehavior,
} from "../../constants/closeBehavior";
import type {
  CleanupCategoryId,
  CleanupCategoryStats,
  CleanupScanResult,
  DatabaseKind,
  StorageLocationKind,
  StorageLocations,
  UpdateStatus,
} from "../../../preload";

const INITIAL_UPDATE_STATUS: UpdateStatus = {
  available: false,
  version: null,
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null,
  releaseNotes: null,
  releaseNotesZh: null,
};

// 手动检查后的提示类型
type CheckHint = "up-to-date" | "error" | null;

// 可迁移的存储位置（checkpoint / upload）
const STORAGE_KINDS: StorageLocationKind[] = ["checkpoint", "upload"];

// 数据清理：分类展示顺序（与 Rust 侧 cleanup 服务保持一致）
const CLEANUP_CATEGORY_IDS: CleanupCategoryId[] = [
  "checkpoints",
  "upload",
  "imageLibrary",
  "backgrounds",
  "pets",
  "browserState",
  "appLogs",
];

/** 数据清理：分类的文案 key（标题 / 说明） */
const CLEANUP_CATEGORY_TEXT: Record<
  CleanupCategoryId,
  { label: string; description: string }
> = {
  checkpoints: {
    label: "settings.cleanupCategoryCheckpoints",
    description: "settings.cleanupCategoryCheckpointsInfo",
  },
  upload: {
    label: "settings.cleanupCategoryUpload",
    description: "settings.cleanupCategoryUploadInfo",
  },
  imageLibrary: {
    label: "settings.cleanupCategoryImageLibrary",
    description: "settings.cleanupCategoryImageLibraryInfo",
  },
  backgrounds: {
    label: "settings.cleanupCategoryBackgrounds",
    description: "settings.cleanupCategoryBackgroundsInfo",
  },
  pets: {
    label: "settings.cleanupCategoryPets",
    description: "settings.cleanupCategoryPetsInfo",
  },
  browserState: {
    label: "settings.cleanupCategoryBrowserState",
    description: "settings.cleanupCategoryBrowserStateInfo",
  },
  appLogs: {
    label: "settings.cleanupCategoryAppLogs",
    description: "settings.cleanupCategoryAppLogsInfo",
  },
};

/** 数据清理：可选的「早于 N 天」档位 */
const CLEANUP_DAY_OPTIONS = [7, 15, 30, 90];
/** 数据清理：不限制时间的档位值 */
const CLEANUP_AGE_ALL = "0";

/** 许可协议原文（MIT，与仓库 LICENSE 保持一致，不翻译） */
const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 MayMay

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** 隐私说明条目：图标 + 标题 / 说明文案 key */
const ABOUT_PRIVACY_ITEMS = [
  {
    icon: HardDrive,
    titleKey: "settings.aboutPrivacyLocalTitle",
    bodyKey: "settings.aboutPrivacyLocal",
  },
  {
    icon: Server,
    titleKey: "settings.aboutPrivacyNetworkTitle",
    bodyKey: "settings.aboutPrivacyNetwork",
  },
  {
    icon: LockKeyhole,
    titleKey: "settings.aboutPrivacyCredentialsTitle",
    bodyKey: "settings.aboutPrivacyCredentials",
  },
  {
    icon: ShieldCheck,
    titleKey: "settings.aboutPrivacyAppLockTitle",
    bodyKey: "settings.aboutPrivacyAppLock",
  },
  {
    icon: Filter,
    titleKey: "settings.aboutPrivacyFilterTitle",
    bodyKey: "settings.aboutPrivacyFilter",
  },
  {
    icon: Trash2,
    titleKey: "settings.aboutPrivacyControlTitle",
    bodyKey: "settings.aboutPrivacyControl",
  },
];

/** 免责声明条目：图标 + 标题 / 说明文案 key */
const ABOUT_DISCLAIMER_ITEMS = [
  {
    icon: Scale,
    titleKey: "settings.aboutDisclaimerAsIsTitle",
    bodyKey: "settings.aboutDisclaimerAsIs",
  },
  {
    icon: Bot,
    titleKey: "settings.aboutDisclaimerAiTitle",
    bodyKey: "settings.aboutDisclaimerAi",
  },
  {
    icon: Terminal,
    titleKey: "settings.aboutDisclaimerToolsTitle",
    bodyKey: "settings.aboutDisclaimerTools",
  },
  {
    icon: DatabaseBackup,
    titleKey: "settings.aboutDisclaimerBackupTitle",
    bodyKey: "settings.aboutDisclaimerBackup",
  },
  {
    icon: Server,
    titleKey: "settings.aboutDisclaimerThirdPartyTitle",
    bodyKey: "settings.aboutDisclaimerThirdParty",
  },
];

// 会话上下文注入预算（与 Rust native 侧 context_attachments.rs 保持一致）
const ATTACH_CONTEXT_SINGLE_BUDGET_SETTING =
  "attach_context_single_budget_chars";
const ATTACH_CONTEXT_TOTAL_BUDGET_SETTING = "attach_context_total_budget_chars";
const ATTACH_CONTEXT_SINGLE_BUDGET_DEFAULT = 40000;
const ATTACH_CONTEXT_TOTAL_BUDGET_DEFAULT = 60000;
const ATTACH_CONTEXT_BUDGET_MIN = 1000;
const ATTACH_CONTEXT_BUDGET_MAX = 200000;

/** 待确认迁移的目标目录 */
type PendingMigration = {
  kind: StorageLocationKind;
  target: string;
  dirLabel: string;
};

/** 迁移进度状态 */
type MigrationState = {
  kind: StorageLocationKind;
  copied: number;
  total: number;
};

/** 待确认的图库目录迁移目标 */
type ImageLibraryPendingMigration = {
  target: string;
  dirLabel: string;
};

/** 图库目录迁移进度状态 */
type ImageLibraryMigrationState = {
  copied: number;
  total: number;
};

type GeneralSettingsPanelProps = {
  onClose?: () => void;
};

type GeneralSettingsTab = "general" | "storage" | "privacy" | "about";

/** 取文件路径的父目录（跨平台字符串处理，避免在渲染层引入 node:path）。 */
const parentDirOf = (filePath: string): string =>
  filePath.replace(/[\\\\/][^\\\\/]*$/, "") || filePath;

/** 将字节数格式化为可读大小（B / KB / MB / GB / TB）。 */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

export function GeneralSettingsPanel({
  onClose,
}: GeneralSettingsPanelProps): React.JSX.Element {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const [activeTab, setActiveTab] = useState<GeneralSettingsTab>("general");
  const [appVersion, setAppVersion] = useState<string>("");
  const [isChecking, setIsChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(
    INITIAL_UPDATE_STATUS,
  );
  const [checkHint, setCheckHint] = useState<CheckHint>(null);

  // 存储位置
  const [locations, setLocations] = useState<StorageLocations | null>(null);
  /** 各存储路径的占用字节数（按路径索引；-1 表示读取失败） */
  const [pathSizes, setPathSizes] = useState<Record<string, number>>({});
  const [storageBusy, setStorageBusy] = useState<StorageLocationKind | null>(
    null,
  );
  const [pendingMigration, setPendingMigration] =
    useState<PendingMigration | null>(null);
  const [migration, setMigration] = useState<MigrationState | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [storageError, setStorageError] = useState("");
  // 资源占用（进入设置页时查询一次，不做后台轮询）
  const [memoryBytes, setMemoryBytes] = useState<number | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  /** 待确认修复的数据库（null 表示无） */
  const [pendingRepair, setPendingRepair] = useState<DatabaseKind | null>(null);
  /** 正在修复的数据库（非 null 表示修复进行中） */
  const [repairingDb, setRepairingDb] = useState<DatabaseKind | null>(null);
  /** 最近一次修复成功的提示（空字符串表示无） */
  const [repairHint, setRepairHint] = useState("");
  /** 磁盘空间优化进行中（依次 VACUUM 运行库与归档库） */
  const [isOptimizing, setIsOptimizing] = useState(false);
  /** 最近一次优化占用的提示（空字符串表示无） */
  const [optimizeHint, setOptimizeHint] = useState("");
  /** 正在清空应用缓存（清完会重新加载界面） */
  const [isClearingCache, setIsClearingCache] = useState(false);
  /** 待确认清空应用缓存（true 表示弹窗打开） */
  const [pendingClearCache, setPendingClearCache] = useState(false);

  // 数据清理（扫描各分类占用后由用户勾选删除）
  /** 扫描结果（null 表示尚未扫描） */
  const [cleanupScan, setCleanupScan] = useState<CleanupScanResult | null>(
    null,
  );
  /** 扫描进行中 */
  const [cleanupScanning, setCleanupScanning] = useState(false);
  /** 勾选待清理的分类 */
  const [cleanupSelected, setCleanupSelected] = useState<CleanupCategoryId[]>(
    [],
  );
  /** 时间档位（CLEANUP_AGE_ALL 表示不限制时间） */
  const [cleanupAgeDays, setCleanupAgeDays] = useState(CLEANUP_AGE_ALL);
  /** 待确认清理（true 表示弹窗打开） */
  const [pendingCleanup, setPendingCleanup] = useState(false);
  /** 清理进行中 */
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  /** 最近一次清理完成的提示（空字符串表示无） */
  const [cleanupHint, setCleanupHint] = useState("");
  /** 用户请求取消迁移（chunk 循环之间检查） */
  const migrationCancelledRef = useRef(false);
  /** 组件卸载时若迁移仍进行中，触发回滚 */
  const migrationActiveRef = useRef(false);
  const pendingMigrationRef = useRef<PendingMigration | null>(null);

  // 会话上下文注入预算（单附件 / 全部附件合计，字符数）
  const [attachSingleBudget, setAttachSingleBudget] = useState<string>(
    String(ATTACH_CONTEXT_SINGLE_BUDGET_DEFAULT),
  );
  const [attachTotalBudget, setAttachTotalBudget] = useState<string>(
    String(ATTACH_CONTEXT_TOTAL_BUDGET_DEFAULT),
  );
  const [attachBudgetSaved, setAttachBudgetSaved] = useState(false);
  const attachBudgetSavedTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  // 团队协作启停开关（默认关闭；写入 system_settings，Rust 侧据此放行）
  const [teamEnabled, setTeamEnabled] = useState(false);

  useEffect(() => {
    window.snow
      .getSystemSettingValue(TEAM_ENABLED_SETTING)
      .then((value) => setTeamEnabled(value === "1"))
      .catch(() => undefined);
  }, []);

  /** 切换团队协作开关：写系统设置后派发事件，侧边栏据此即时刷新入口。 */
  const handleTeamEnabledChange = (checked: boolean): void => {
    setTeamEnabled(checked);
    void window.snow
      .setSystemSetting("团队协作", TEAM_ENABLED_SETTING, checked ? "1" : "0")
      .then(() => {
        window.dispatchEvent(new CustomEvent(TEAM_ENABLED_CHANGED_EVENT));
      })
      .catch(() => undefined);
  };

  // 关闭 Snow App 时的行为（ask / exit / minimize，默认 ask）
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>("ask");
  const isMacPlatform = navigator.userAgent.includes("Mac");

  useEffect(() => {
    window.snow
      .getSystemSettingValue(CLOSE_BEHAVIOR_SETTING_CODE)
      .then((value) => setCloseBehavior(normalizeCloseBehavior(value)))
      .catch(() => undefined);
  }, []);

  /** 切换关闭行为：写入 system_settings，主进程 close 拦截据此自动执行。 */
  const handleCloseBehaviorChange = (value: string): void => {
    const next = normalizeCloseBehavior(value);
    setCloseBehavior(next);
    void window.snow
      .setSystemSetting(
        CLOSE_BEHAVIOR_SETTING_NAME,
        CLOSE_BEHAVIOR_SETTING_CODE,
        next,
      )
      .catch(() => undefined);
  };

  useEffect(() => {
    void (async () => {
      const [single, total] = await Promise.all([
        window.snow.getSystemSettingValue(ATTACH_CONTEXT_SINGLE_BUDGET_SETTING),
        window.snow.getSystemSettingValue(ATTACH_CONTEXT_TOTAL_BUDGET_SETTING),
      ]);
      setAttachSingleBudget(
        single ?? String(ATTACH_CONTEXT_SINGLE_BUDGET_DEFAULT),
      );
      setAttachTotalBudget(
        total ?? String(ATTACH_CONTEXT_TOTAL_BUDGET_DEFAULT),
      );
    })().catch(() => undefined);
    return () => {
      if (attachBudgetSavedTimerRef.current) {
        clearTimeout(attachBudgetSavedTimerRef.current);
        attachBudgetSavedTimerRef.current = null;
      }
    };
  }, []);

  /** 保存单个预算设置；非法（非数字 / 低于下限）不保存，超上限截断。 */
  const saveAttachBudget = (code: string, raw: string): void => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < ATTACH_CONTEXT_BUDGET_MIN) {
      return;
    }
    const clamped = Math.min(parsed, ATTACH_CONTEXT_BUDGET_MAX);
    const normalized = String(clamped);
    if (code === ATTACH_CONTEXT_SINGLE_BUDGET_SETTING) {
      setAttachSingleBudget(normalized);
    } else {
      setAttachTotalBudget(normalized);
    }
    void window.snow
      .setSystemSetting("会话上下文注入预算", code, normalized)
      .then(() => {
        setAttachBudgetSaved(true);
        if (attachBudgetSavedTimerRef.current) {
          clearTimeout(attachBudgetSavedTimerRef.current);
        }
        attachBudgetSavedTimerRef.current = setTimeout(() => {
          setAttachBudgetSaved(false);
          attachBudgetSavedTimerRef.current = null;
        }, 2000);
      })
      .catch(() => undefined);
  };

  /** 恢复默认预算并写入设置。 */
  const resetAttachBudgets = (): void => {
    setAttachSingleBudget(String(ATTACH_CONTEXT_SINGLE_BUDGET_DEFAULT));
    setAttachTotalBudget(String(ATTACH_CONTEXT_TOTAL_BUDGET_DEFAULT));
    void window.snow
      .setSystemSetting(
        "会话上下文注入预算",
        ATTACH_CONTEXT_SINGLE_BUDGET_SETTING,
        String(ATTACH_CONTEXT_SINGLE_BUDGET_DEFAULT),
      )
      .then(() =>
        window.snow.setSystemSetting(
          "会话上下文注入预算",
          ATTACH_CONTEXT_TOTAL_BUDGET_SETTING,
          String(ATTACH_CONTEXT_TOTAL_BUDGET_DEFAULT),
        ),
      )
      .then(() => {
        setAttachBudgetSaved(true);
        if (attachBudgetSavedTimerRef.current) {
          clearTimeout(attachBudgetSavedTimerRef.current);
        }
        attachBudgetSavedTimerRef.current = setTimeout(() => {
          setAttachBudgetSaved(false);
          attachBudgetSavedTimerRef.current = null;
        }, 2000);
      })
      .catch(() => undefined);
  };

  // 图片库存储位置（独立于 checkpoint / upload 的迁移流程）
  const [imageLibraryRoot, setImageLibraryRoot] = useState("");
  /** 图库自定义保存目录（非空表示已自定义） */
  const [imageLibraryCustomDir, setImageLibraryCustomDir] = useState("");
  const [imageLibraryBusy, setImageLibraryBusy] = useState(false);
  /** 待确认的图库目录迁移目标（null 表示无） */
  const [imageLibraryPendingMigration, setImageLibraryPendingMigration] =
    useState<ImageLibraryPendingMigration | null>(null);
  /** 图库目录迁移进度（null 表示未在迁移） */
  const [imageLibraryMigration, setImageLibraryMigration] =
    useState<ImageLibraryMigrationState | null>(null);
  const [imageLibraryRollingBack, setImageLibraryRollingBack] = useState(false);
  /** 用户请求取消图库迁移（chunk 循环之间检查） */
  const imageLibraryCancelledRef = useRef(false);
  /** 组件卸载时若图库迁移仍进行中，触发回滚 */
  const imageLibraryActiveRef = useRef(false);
  const imageLibraryPendingMigrationRef =
    useRef<ImageLibraryPendingMigration | null>(null);

  useEffect(() => {
    window.snow
      .getAppVersion()
      .then((version) => setAppVersion(version))
      .catch(() => undefined);
    window.snow
      .getUpdateStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    const unsubscribe = window.snow.onUpdateStatusChanged((status) => {
      setUpdateStatus(status);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const handleCheckForUpdates = (): void => {
    if (isChecking || updateStatus.downloading) {
      return;
    }
    setIsChecking(true);
    setCheckHint(null);
    window.snow
      .checkForUpdates()
      .then((result) => {
        if (result.available) {
          // 发现新版本，更新按钮会自动出现，无需额外提示
          return;
        }
        setCheckHint(result.error ? "error" : "up-to-date");
      })
      .catch(() => {
        setCheckHint("error");
      })
      .finally(() => {
        setIsChecking(false);
      });
  };

  /** 打开更新弹窗：弹窗实例常驻侧边栏，此处仅派发打开事件。 */
  const handleOpenUpdateDialog = (): void => {
    window.dispatchEvent(new CustomEvent(OPEN_UPDATE_DIALOG_EVENT));
  };

  /** 统计数据库文件与检查点 / 上传根目录 / 图库根目录的占用大小。 */
  const refreshPathSizes = useCallback(
    async (value: StorageLocations, libRoot: string): Promise<void> => {
      const targets = [
        value.databasePath,
        value.archiveDbPath,
        value.checkpointRoot,
        value.uploadRoot,
        libRoot,
      ].filter(Boolean);
      const entries = await Promise.all(
        targets.map(async (target) => {
          try {
            const bytes = await window.snow.getStoragePathSize(target);
            return [target, bytes] as const;
          } catch {
            return [target, -1] as const;
          }
        }),
      );
      setPathSizes(Object.fromEntries(entries));
    },
    [],
  );

  /** 查询当前进程内存占用；仅在面板打开或用户手动刷新时调用。 */
  const fetchMemory = useCallback(async (): Promise<void> => {
    setMemoryLoading(true);
    try {
      const bytes = await window.snow.getProcessMemoryBytes();
      setMemoryBytes(bytes);
    } catch {
      setMemoryBytes(-1);
    } finally {
      setMemoryLoading(false);
    }
  }, []);

  // 仅在面板打开时拉取一次资源占用
  useEffect(() => {
    void fetchMemory();
  }, [fetchMemory]);

  const loadLocations = useCallback(async (): Promise<void> => {
    try {
      const [value, libRoot, libDir] = await Promise.all([
        window.snow.getStorageLocations(),
        window.snow.getImageLibraryRoot().catch(() => ""),
        window.snow.getImageLibraryDir().catch(() => ""),
      ]);
      setLocations(value);
      setImageLibraryRoot(libRoot);
      setImageLibraryCustomDir(libDir);
      void refreshPathSizes(value, libRoot);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }, [refreshPathSizes]);

  useEffect(() => {
    void loadLocations();
  }, [loadLocations]);

  // 迁移进行中关闭面板：触发回滚，避免遗留未完成的迁移日志
  useEffect(() => {
    return () => {
      if (migrationActiveRef.current) {
        const pending = pendingMigrationRef.current;
        if (pending) {
          void window.snow
            .rollbackStorageMigration(pending.kind)
            .catch(() => undefined);
        }
      }
      if (imageLibraryActiveRef.current) {
        void window.snow.rollbackImageLibraryMigration().catch(() => undefined);
      }
    };
  }, []);

  const isMigrating = migration !== null || rollingBack;
  const isImageLibraryBusy =
    imageLibraryMigration !== null ||
    imageLibraryRollingBack ||
    imageLibraryBusy;

  const handleOpenDir = async (dirPath: string): Promise<void> => {
    const errorMessage = await window.snow.openStorageDirectory(dirPath);
    if (errorMessage) {
      setStorageError(errorMessage);
    }
  };

  const handleChangeDir = async (kind: StorageLocationKind): Promise<void> => {
    const selected = await window.snow.selectStorageDirectory(
      kind === "checkpoint"
        ? t("settings.storageSelectCheckpointDir", {
            defaultValue: "Select checkpoint folder",
          })
        : t("settings.storageSelectUploadDir", {
            defaultValue: "Select upload folder",
          }),
    );
    if (!selected) {
      return;
    }
    setPendingMigration({ kind, target: selected, dirLabel: selected });
  };

  const handleResetDir = (kind: StorageLocationKind): void => {
    setPendingMigration({
      kind,
      target: "",
      dirLabel: t("settings.storageDefaultDir", {
        defaultValue: "Default location",
      }),
    });
  };

  /** 确认迁移：prepare → 分批复制 → commit；取消则回滚。 */
  const confirmMigration = async (): Promise<void> => {
    const pending = pendingMigration;
    if (!pending) {
      return;
    }
    setPendingMigration(null);
    pendingMigrationRef.current = pending;
    migrationCancelledRef.current = false;
    migrationActiveRef.current = true;
    setStorageBusy(pending.kind);
    setStorageError("");
    try {
      const total = await window.snow.prepareStorageMigration(
        pending.kind,
        pending.target,
      );
      if (total === 0) {
        // 无需迁移（目标与当前相同或目录为空）：直接切换
        await window.snow.setStorageDir(pending.kind, pending.target);
        await loadLocations();
        return;
      }
      setMigration({ kind: pending.kind, copied: 0, total });
      let done = false;
      while (!done) {
        if (migrationCancelledRef.current) {
          break;
        }
        const progress = await window.snow.migrateStorageChunk(pending.kind);
        setMigration({
          kind: pending.kind,
          copied: progress.copied,
          total: progress.total,
        });
        done = progress.done;
      }
      if (migrationCancelledRef.current) {
        // 用户取消：删除已复制文件，保持旧目录
        setRollingBack(true);
        await window.snow.rollbackStorageMigration(pending.kind);
        return;
      }
      await window.snow.commitStorageMigration(pending.kind);
      await loadLocations();
    } catch (migrationError) {
      // 出错自动回滚，保持旧目录
      try {
        await window.snow.rollbackStorageMigration(pending.kind);
      } catch {
        // 回滚失败不阻断错误提示
      }
      setStorageError(
        migrationError instanceof Error
          ? migrationError.message
          : String(migrationError),
      );
    } finally {
      setRollingBack(false);
      setMigration(null);
      migrationActiveRef.current = false;
      pendingMigrationRef.current = null;
      setStorageBusy(null);
    }
  };

  const cancelMigration = (): void => {
    migrationCancelledRef.current = true;
  };

  /** 选择图库新目录（确认后统一走迁移流程，无需迁移时直接切换） */
  const handleImageLibraryChangeDir = async (): Promise<void> => {
    const selected = await window.snow.selectImageDirectory(
      t("settings.storageSelectImageLibraryDir", {
        defaultValue: "Select image library folder",
      }),
    );
    if (!selected) {
      return;
    }
    setImageLibraryPendingMigration({ target: selected, dirLabel: selected });
  };

  /** 重置图库为默认目录（确认后统一走迁移流程） */
  const handleImageLibraryResetDir = (): void => {
    setImageLibraryPendingMigration({
      target: "",
      dirLabel: t("settings.storageDefaultDir", {
        defaultValue: "Default location",
      }),
    });
  };

  /** 确认图库迁移：prepare → 分批复制 → commit；取消则回滚。 */
  const confirmImageLibraryMigration = async (): Promise<void> => {
    const pending = imageLibraryPendingMigration;
    if (!pending) {
      return;
    }
    setImageLibraryPendingMigration(null);
    imageLibraryPendingMigrationRef.current = pending;
    imageLibraryCancelledRef.current = false;
    imageLibraryActiveRef.current = true;
    setImageLibraryBusy(true);
    setStorageError("");
    try {
      const total = await window.snow.prepareImageLibraryMigration(
        pending.target,
      );
      if (total === 0) {
        // 无需迁移（目标与当前相同或图库为空）：直接切换
        await window.snow.setImageLibraryDir(pending.target);
        await loadLocations();
        return;
      }
      setImageLibraryMigration({ total, copied: 0 });
      let done = false;
      while (!done) {
        if (imageLibraryCancelledRef.current) {
          break;
        }
        const progress = await window.snow.migrateImageLibraryChunk();
        setImageLibraryMigration({
          total: progress.total,
          copied: progress.copied,
        });
        done = progress.done;
      }
      if (imageLibraryCancelledRef.current) {
        // 用户取消：删除已复制文件，保持旧目录
        setImageLibraryRollingBack(true);
        await window.snow.rollbackImageLibraryMigration();
        return;
      }
      await window.snow.commitImageLibraryMigration();
      await loadLocations();
    } catch (migrationError) {
      // 出错自动回滚，保持旧目录
      try {
        await window.snow.rollbackImageLibraryMigration();
      } catch {
        // 回滚失败不阻断错误提示
      }
      setStorageError(
        migrationError instanceof Error
          ? migrationError.message
          : String(migrationError),
      );
    } finally {
      setImageLibraryRollingBack(false);
      setImageLibraryMigration(null);
      imageLibraryActiveRef.current = false;
      imageLibraryPendingMigrationRef.current = null;
      setImageLibraryBusy(false);
    }
  };

  const cancelImageLibraryMigration = (): void => {
    imageLibraryCancelledRef.current = true;
  };

  /** 执行数据库修复：完整性检查 → 损坏则恢复，完好则压缩优化。 */
  const handleRepairDatabase = async (kind: DatabaseKind): Promise<void> => {
    if (repairingDb) {
      return;
    }
    setRepairingDb(kind);
    setStorageError("");
    setRepairHint("");
    try {
      const result = await window.snow.repairDatabase(kind);
      setRepairHint(
        result.repaired
          ? t("settings.storageRepairRecovered", {
              defaultValue: "Database was damaged and has been repaired.",
            })
          : t("settings.storageRepairOk", {
              defaultValue: "Database is healthy and has been optimized.",
            }),
      );
      // 修复可能改变数据库文件大小，刷新占用统计
      if (locations) {
        void refreshPathSizes(locations, imageLibraryRoot);
      }
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairingDb(null);
    }
  };

  /** 优化磁盘与内存占用：VACUUM 回收磁盘空间，并整理本进程内存。 */
  const handleOptimizeUsage = async (): Promise<void> => {
    if (isOptimizing) {
      return;
    }
    setIsOptimizing(true);
    setStorageError("");
    setRepairHint("");
    setOptimizeHint("");
    try {
      // 两个库文件相互独立；串行执行避免同时压缩造成磁盘 IO 峰值
      const runtimeResult = await window.snow.optimizeDatabase("runtime");
      const archiveResult = await window.snow.optimizeDatabase("archive");
      const freedBytes = runtimeResult.bytesFreed + archiveResult.bytesFreed;
      // 内存整理仅 Windows 支持，其它平台快速失败：不影响磁盘优化结果
      let freedMemoryBytes = 0;
      try {
        const memoryResult = await window.snow.optimizeMemory();
        freedMemoryBytes = Math.max(
          0,
          memoryResult.bytesBefore - memoryResult.bytesAfter,
        );
      } catch {
        // Ignore: 内存整理失败时仅提示磁盘释放量
      }
      setOptimizeHint(
        freedMemoryBytes > 0
          ? t("settings.resourceOptimizeDone", {
              values: {
                disk: formatBytes(freedBytes),
                memory: formatBytes(freedMemoryBytes),
              },
              defaultValue:
                `Done. Reclaimed ${formatBytes(freedBytes)} on disk and ` +
                `${formatBytes(freedMemoryBytes)} of memory`,
            })
          : t("settings.resourceOptimizeDoneDiskOnly", {
              values: { disk: formatBytes(Math.max(0, freedBytes)) },
              defaultValue: `Done. Reclaimed ${formatBytes(freedBytes)} on disk`,
            }),
      );
      // VACUUM 与内存整理都会改变占用数字，刷新统计
      void fetchMemory();
      if (locations) {
        void refreshPathSizes(locations, imageLibraryRoot);
      }
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsOptimizing(false);
    }
  };

  /** 清空应用缓存（HTTP / 代码缓存）并重新加载界面；登录态与本地数据不受影响。 */
  const handleClearCacheAndReload = async (): Promise<void> => {
    if (isClearingCache) {
      return;
    }
    setIsClearingCache(true);
    setStorageError("");
    setRepairHint("");
    setOptimizeHint("");
    try {
      await window.snow.clearAppCacheAndReload();
      // 成功后主进程会重新加载页面，无需复位状态
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setIsClearingCache(false);
    }
  };

  /** 扫描本地数据占用：进入「存储与资源」页与手动刷新时调用（Rust 侧单次遍历）。 */
  const runCleanupScan = useCallback(async (): Promise<void> => {
    setCleanupScanning(true);
    try {
      const result = await window.snow.scanCleanup(CLEANUP_DAY_OPTIONS);
      setCleanupScan(result);
      // 清掉已无数据的分类勾选，避免出现「选中但删不出东西」
      setCleanupSelected((prev) =>
        prev.filter((id) =>
          result.categories.some(
            (category) => category.id === id && category.files > 0,
          ),
        ),
      );
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setCleanupScanning(false);
    }
  }, []);

  // 切到「存储与资源」页时扫描一次（每次切回都会重新扫描，保证数字新鲜）
  useEffect(() => {
    if (activeTab === "storage") {
      void runCleanupScan();
    }
  }, [activeTab, runCleanupScan]);

  /** 勾选 / 取消勾选某个清理分类。 */
  const toggleCleanupCategory = (id: CleanupCategoryId): void => {
    setCleanupSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  /** 已扫描出数据的分类 id（决定全选按钮可用性与空状态）。 */
  const cleanupAvailableIds = (cleanupScan?.categories ?? [])
    .filter((category) => category.files > 0)
    .map((category) => category.id);

  /** 一键全选 / 取消全选有数据的分类。 */
  const toggleCleanupSelectAll = (): void => {
    setCleanupSelected((prev) =>
      prev.length === cleanupAvailableIds.length ? [] : cleanupAvailableIds,
    );
  };

  /** 本次实际会删除的数据量：勾选分类 ∩ 时间档位。 */
  const cleanupPlan = useMemo(() => {
    const days = Number.parseInt(cleanupAgeDays, 10);
    const limited = Number.isFinite(days) && days > 0;
    return (cleanupScan?.categories ?? [])
      .filter((category) => cleanupSelected.includes(category.id))
      .reduce(
        (plan, category) => {
          const target = limited
            ? (category.ageBuckets.find((bucket) => bucket.days === days) ?? {
                files: 0,
                bytes: 0,
              })
            : category;
          plan.files += target.files;
          plan.bytes += target.bytes;
          return plan;
        },
        { files: 0, bytes: 0 },
      );
  }, [cleanupAgeDays, cleanupScan, cleanupSelected]);

  /** 时间档位的展示文案（确认弹窗与提示共用）。 */
  const cleanupAgeLabel =
    cleanupAgeDays === CLEANUP_AGE_ALL
      ? t("settings.cleanupAgeAll", { defaultValue: "Any time" })
      : t("settings.cleanupAgeOlderThan", {
          values: { days: cleanupAgeDays },
          defaultValue: `Older than ${cleanupAgeDays} days`,
        });

  /** 执行清理：删除勾选分类中早于所选档位的数据（不限时间档位则删除全部）。 */
  const confirmCleanup = async (): Promise<void> => {
    if (cleanupSelected.length === 0 || isCleaningUp) {
      return;
    }
    const days = Number.parseInt(cleanupAgeDays, 10);
    const maxAgeDays = Number.isFinite(days) && days > 0 ? days : 0;
    setPendingCleanup(false);
    setIsCleaningUp(true);
    setStorageError("");
    setRepairHint("");
    setOptimizeHint("");
    setCleanupHint("");
    try {
      const result = await window.snow.deleteCleanupData(
        cleanupSelected,
        maxAgeDays,
      );
      setCleanupSelected([]);
      setCleanupHint(
        result.errors.length > 0
          ? t("settings.cleanupDoneWithErrors", {
              values: {
                files: result.deletedFiles,
                size: formatBytes(result.deletedBytes),
                errors: result.errors.length,
              },
              defaultValue:
                `Deleted ${result.deletedFiles} file(s) and freed ` +
                `${formatBytes(result.deletedBytes)}; ` +
                `${result.errors.length} item(s) failed`,
            })
          : t("settings.cleanupDone", {
              values: {
                files: result.deletedFiles,
                size: formatBytes(result.deletedBytes),
              },
              defaultValue:
                `Deleted ${result.deletedFiles} file(s) and freed ` +
                `${formatBytes(result.deletedBytes)}`,
            }),
      );
      await runCleanupScan();
      if (locations) {
        void refreshPathSizes(locations, imageLibraryRoot);
      }
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCleaningUp(false);
    }
  };

  /** 渲染某个数据库的「修复」按钮（kind 区分运行库 / 归档库）。 */
  const renderRepairButton = (kind: DatabaseKind): React.JSX.Element => {
    const isRepairing = repairingDb === kind;
    return (
      <button
        type="button"
        className="general-storage-action"
        onClick={() => setPendingRepair(kind)}
        disabled={!locations || isMigrating || repairingDb !== null}
        title={t("settings.storageRepairDb", {
          defaultValue: "Repair database",
        })}
      >
        {isRepairing ? (
          <LoaderCircle
            size={11}
            strokeWidth={1.8}
            className="tool-call-icon-spinning"
            aria-hidden="true"
          />
        ) : (
          <Wrench size={11} strokeWidth={1.8} aria-hidden="true" />
        )}
        <span>
          {isRepairing
            ? t("settings.storageRepairing", { defaultValue: "Repairing..." })
            : t("settings.storageRepairDb", {
                defaultValue: "Repair database",
              })}
        </span>
      </button>
    );
  };

  /** 渲染单个可清理分类的勾选行（勾选状态、文件数与占用大小）。 */
  const renderCleanupCategoryRow = (
    category: CleanupCategoryStats,
  ): React.JSX.Element => {
    const text = CLEANUP_CATEGORY_TEXT[category.id];
    const isEmpty = category.files === 0;
    const checked = cleanupSelected.includes(category.id);
    const label = t(text.label, { defaultValue: category.id });
    return (
      <div className="general-storage-row" key={category.id}>
        <div className="general-storage-info">
          <label className="cleanup-category-check" title={label}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggleCleanupCategory(category.id)}
              disabled={isEmpty || isCleaningUp || cleanupScanning}
            />
            <span className="cleanup-category-box" aria-hidden="true" />
          </label>
          <div className="general-storage-text">
            <span className="general-storage-label">{label}</span>
            <span className="settings-item-description">
              {t(text.description, { defaultValue: "" })}
            </span>
          </div>
        </div>
        <div className="general-storage-actions">
          <span className="general-storage-size">
            {isEmpty
              ? t("settings.cleanupCategoryEmpty", { defaultValue: "Empty" })
              : t("settings.cleanupCategorySize", {
                  values: {
                    files: category.files,
                    size: formatBytes(category.bytes),
                  },
                  defaultValue: "{{files}} files · {{size}}",
                })}
          </span>
        </div>
      </div>
    );
  };

  /** 数据盘占用合计（各存储路径之和，忽略读取失败的项） */
  const dataDiskBytes = Object.values(pathSizes)
    .filter((bytes) => bytes >= 0)
    .reduce((sum, bytes) => sum + bytes, 0);

  /** 手动刷新资源占用：重新查询内存并重新统计各路径占用。 */
  const handleRefreshResources = (): void => {
    if (memoryLoading) {
      return;
    }
    void fetchMemory();
    if (locations) {
      void refreshPathSizes(locations, imageLibraryRoot);
    }
  };

  /** 渲染某存储路径的占用大小（未加载或读取失败时不显示）。 */
  const renderSize = (path: string | undefined): React.JSX.Element | null => {
    if (!path) {
      return null;
    }
    const size = pathSizes[path] ?? -1;
    if (size < 0) {
      return null;
    }
    return (
      <span className="general-storage-size">
        {t("settings.storageSize", {
          values: { size: formatBytes(size) },
          defaultValue: "Used: {{size}}",
        })}
      </span>
    );
  };

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.generalSettings", {
              defaultValue: "General settings",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.generalSettingsInfo", {
              defaultValue: "Language, version and update management.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.generalSettingsClosePanel", {
              defaultValue: "Close general settings",
            })}
            title={t("settings.generalSettingsClosePanel", {
              defaultValue: "Close general settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="import-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "general"}
          className={`import-settings-tab ${
            activeTab === "general" ? "active" : ""
          }`}
          onClick={() => setActiveTab("general")}
        >
          {t("settings.generalSettings", {
            defaultValue: "General settings",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "storage"}
          className={`import-settings-tab ${
            activeTab === "storage" ? "active" : ""
          }`}
          onClick={() => setActiveTab("storage")}
        >
          <HardDrive size={13} strokeWidth={1.8} />
          {t("settings.storageTab", {
            defaultValue: "Storage & resources",
          })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "privacy"}
          className={`import-settings-tab ${
            activeTab === "privacy" ? "active" : ""
          }`}
          onClick={() => setActiveTab("privacy")}
        >
          <LockKeyhole size={13} strokeWidth={1.8} />
          {t("settings.privacyTab", { defaultValue: "Privacy" })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "about"}
          className={`import-settings-tab ${
            activeTab === "about" ? "active" : ""
          }`}
          onClick={() => setActiveTab("about")}
        >
          <Info size={13} strokeWidth={1.8} />
          {t("settings.about", { defaultValue: "About" })}
        </button>
      </div>

      <AutoDismissNotice
        message={
          storageError ||
          repairHint ||
          optimizeHint ||
          cleanupHint ||
          (checkHint === "up-to-date"
            ? t("settings.upToDate", { defaultValue: "You're up to date" })
            : checkHint === "error"
              ? t("settings.updateCheckFailed", {
                  defaultValue: "Update check failed",
                })
              : "")
        }
        tone={storageError || checkHint === "error" ? "error" : "success"}
        onDismiss={() => {
          setStorageError("");
          setRepairHint("");
          setOptimizeHint("");
          setCleanupHint("");
          setCheckHint(null);
        }}
      />

      {activeTab === "privacy" && <AppLockSettingsSection />}

      {activeTab === "general" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.languageSettings", { defaultValue: "Language" })}
            </strong>
            <span>
              {t("settings.languageSettingsInfo", {
                defaultValue: "Choose the display language for Snow App.",
              })}
            </span>
          </div>

          <div className="api-settings-form-body">
            <div className="settings-language-options">
              {supportedLocales.map((supportedLocale) => (
                <button
                  key={supportedLocale}
                  className={`settings-language-option ${
                    locale === supportedLocale ? "active" : ""
                  }`}
                  onClick={() => setLocale(supportedLocale as Locale)}
                  type="button"
                >
                  {localeLabels[supportedLocale]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === "general" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.closeBehavior", {
                defaultValue: "关闭 Snow APP 时",
              })}
            </strong>
            <span>
              {t("settings.closeBehaviorInfo", {
                defaultValue: "选择关闭应用窗口时的行为。",
              })}
            </span>
          </div>

          <div className="api-settings-form-body">
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.closeBehaviorAction", {
                  defaultValue: "关闭行为",
                })}
              </span>
              <div className="settings-close-behavior-select">
                <CustomSelect
                  value={closeBehavior}
                  options={[
                    {
                      value: "ask",
                      label: t("settings.closeBehaviorAsk", {
                        defaultValue: "每次询问",
                      }),
                    },
                    {
                      value: "exit",
                      label: t("settings.closeBehaviorExit", {
                        defaultValue: "退出应用",
                      }),
                    },
                    {
                      value: "minimize",
                      label: t(
                        isMacPlatform
                          ? "app.closeMinimizeMac"
                          : "app.closeMinimize",
                        { defaultValue: "最小化到托盘" },
                      ),
                    },
                  ]}
                  onChange={handleCloseBehaviorChange}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "storage" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.resourceUsage", {
                defaultValue: "Resource usage",
              })}
            </strong>
            <span>
              {t("settings.resourceUsageInfo", {
                defaultValue: "App process memory and local data usage.",
              })}
            </span>
          </div>

          <div className="api-settings-form-body">
            {/* 内存占用：进入面板时查询一次，支持手动刷新，不做后台轮询 */}
            <div className="general-storage-row">
              <div className="general-storage-info">
                <MemoryStick
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.resourceMemory", {
                      defaultValue: "Memory usage",
                    })}
                  </span>
                  <span className="general-storage-size">
                    {memoryBytes !== null && memoryBytes >= 0
                      ? formatBytes(memoryBytes)
                      : "—"}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={handleRefreshResources}
                  disabled={memoryLoading || isMigrating}
                  title={t("settings.resourceRefresh", {
                    defaultValue: "Refresh",
                  })}
                >
                  {memoryLoading ? (
                    <LoaderCircle
                      size={11}
                      strokeWidth={1.8}
                      className="tool-call-icon-spinning"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw size={11} aria-hidden="true" />
                  )}
                  <span>
                    {t("settings.resourceRefresh", {
                      defaultValue: "Refresh",
                    })}
                  </span>
                </button>
              </div>
            </div>

            {/* 数据盘占用：下方各存储路径之和，随存储统计自动更新 */}
            <div className="general-storage-row">
              <div className="general-storage-info">
                <HardDrive
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.resourceDataDisk", {
                      defaultValue: "Data on disk",
                    })}
                  </span>
                  <span className="general-storage-size">
                    {dataDiskBytes > 0 ? formatBytes(dataDiskBytes) : "—"}
                  </span>
                </div>
              </div>
            </div>

            {/* 磁盘空间优化：手动触发 VACUUM 回收已删除数据的空闲页 */}
            <div className="general-storage-row">
              <div className="general-storage-info">
                <Recycle
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.resourceOptimize", {
                      defaultValue: "Optimize disk usage",
                    })}
                  </span>
                  <span className="settings-item-description">
                    {t("settings.resourceOptimizeInfo", {
                      defaultValue:
                        "Rebuild database files to reclaim disk space and compact process memory.",
                    })}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() => void handleOptimizeUsage()}
                  disabled={isOptimizing || isMigrating || isImageLibraryBusy}
                  title={t("settings.resourceOptimizeInfo", {
                    defaultValue:
                      "Rebuild database files to reclaim disk space and compact process memory.",
                  })}
                >
                  {isOptimizing ? (
                    <LoaderCircle
                      size={11}
                      strokeWidth={1.8}
                      className="tool-call-icon-spinning"
                      aria-hidden="true"
                    />
                  ) : (
                    <Recycle size={11} strokeWidth={1.8} aria-hidden="true" />
                  )}
                  <span>
                    {isOptimizing
                      ? t("settings.resourceOptimizeWorking", {
                          defaultValue: "Optimizing...",
                        })
                      : t("settings.resourceOptimize", {
                          defaultValue: "Optimize disk usage",
                        })}
                  </span>
                </button>
              </div>
            </div>

            {/* 清空应用缓存：清掉 HTTP / 代码缓存后强制重新加载界面 */}
            <div className="general-storage-row">
              <div className="general-storage-info">
                <Trash2
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.resourceClearCache", {
                      defaultValue: "Clear app cache",
                    })}
                  </span>
                  <span className="settings-item-description">
                    {t("settings.resourceClearCacheInfo", {
                      defaultValue:
                        "Clear cached app resources and reload the interface. Sign-in state and local data are kept.",
                    })}
                  </span>
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() => setPendingClearCache(true)}
                  disabled={
                    isClearingCache ||
                    isOptimizing ||
                    isMigrating ||
                    isImageLibraryBusy
                  }
                  title={t("settings.resourceClearCacheInfo", {
                    defaultValue:
                      "Clear cached app resources and reload the interface. Sign-in state and local data are kept.",
                  })}
                >
                  {isClearingCache ? (
                    <LoaderCircle
                      size={11}
                      strokeWidth={1.8}
                      className="tool-call-icon-spinning"
                      aria-hidden="true"
                    />
                  ) : (
                    <Trash2 size={11} strokeWidth={1.8} aria-hidden="true" />
                  )}
                  <span>
                    {isClearingCache
                      ? t("settings.resourceClearCacheWorking", {
                          defaultValue: "Clearing...",
                        })
                      : t("settings.resourceClearCache", {
                          defaultValue: "Clear app cache",
                        })}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 数据清理：扫描各分类占用，按分类 + 时间档位选择性删除 */}
      {activeTab === "storage" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.cleanupTitle", { defaultValue: "Data cleanup" })}
            </strong>
            <span>
              {t("settings.cleanupInfo", {
                defaultValue:
                  "Scan local data by category, then delete only the items you select.",
              })}
              {cleanupScan !== null
                ? ` · ${t("settings.cleanupTotal", {
                    values: { size: formatBytes(cleanupScan.totalBytes) },
                    defaultValue: `Total ${formatBytes(cleanupScan.totalBytes)}`,
                  })}`
                : ""}
            </span>
          </div>

          <div className="api-settings-form-body">
            {/* 首次扫描中：占位提示（已有结果时保留旧数据，避免闪烁） */}
            {cleanupScan === null && cleanupScanning && (
              <div className="general-storage-row">
                <div className="general-storage-info">
                  <LoaderCircle
                    size={14}
                    strokeWidth={1.8}
                    className="general-storage-icon tool-call-icon-spinning"
                    aria-hidden="true"
                  />
                  <div className="general-storage-text">
                    <span className="general-storage-label">
                      {t("settings.cleanupScanning", {
                        defaultValue: "Scanning...",
                      })}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {cleanupScan !== null && (
              <>
                {/* 分类列表：勾选参与清理的分类 */}
                {CLEANUP_CATEGORY_IDS.map((id) => {
                  const category = cleanupScan.categories.find(
                    (item) => item.id === id,
                  );
                  return category ? renderCleanupCategoryRow(category) : null;
                })}

                {cleanupAvailableIds.length === 0 && (
                  <div className="general-storage-row">
                    <div className="general-storage-info">
                      <div className="general-storage-text">
                        <span className="settings-item-description">
                          {t("settings.cleanupNoData", {
                            defaultValue: "No local data to clean up.",
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* 时间档位：只删除早于该档位修改的文件 */}
                <div className="settings-about-row">
                  <span className="settings-item-description">
                    {t("settings.cleanupAgeFilter", {
                      defaultValue: "Time range",
                    })}
                  </span>
                  <div className="settings-close-behavior-select">
                    <CustomSelect
                      value={cleanupAgeDays}
                      options={[
                        {
                          value: CLEANUP_AGE_ALL,
                          label: t("settings.cleanupAgeAll", {
                            defaultValue: "Any time",
                          }),
                        },
                        ...CLEANUP_DAY_OPTIONS.map((days) => ({
                          value: String(days),
                          label: t("settings.cleanupAgeOlderThan", {
                            values: { days },
                            defaultValue: `Older than ${days} days`,
                          }),
                        })),
                      ]}
                      onChange={setCleanupAgeDays}
                      disabled={isCleaningUp || cleanupScanning}
                    />
                  </div>
                </div>

                {/* 选中汇总 + 全选 / 清理 / 重新扫描 */}
                <div className="general-storage-row">
                  <div className="general-storage-info">
                    <Trash2
                      size={14}
                      strokeWidth={1.8}
                      className="general-storage-icon"
                      aria-hidden="true"
                    />
                    <div className="general-storage-text">
                      <span className="general-storage-label">
                        {t("settings.cleanupSelected", {
                          values: { count: cleanupSelected.length },
                          defaultValue: "{{count}} selected",
                        })}
                        {` · ${cleanupAgeLabel}`}
                      </span>
                      <span className="settings-item-description">
                        {cleanupSelected.length > 0 && cleanupPlan.files > 0
                          ? t("settings.cleanupWillFree", {
                              values: {
                                files: cleanupPlan.files,
                                size: formatBytes(cleanupPlan.bytes),
                              },
                              defaultValue:
                                "Will delete {{files}} file(s) and free {{size}}",
                            })
                          : t("settings.cleanupSelectHint", {
                              defaultValue:
                                "Select the categories you want to clean up.",
                            })}
                      </span>
                    </div>
                  </div>
                  <div className="general-storage-actions">
                    <button
                      type="button"
                      className="general-storage-action"
                      onClick={toggleCleanupSelectAll}
                      disabled={
                        cleanupScanning ||
                        isCleaningUp ||
                        cleanupAvailableIds.length === 0
                      }
                      title={t("settings.cleanupSelectAll", {
                        defaultValue: "Select all",
                      })}
                    >
                      <span>
                        {cleanupAvailableIds.length > 0 &&
                        cleanupSelected.length === cleanupAvailableIds.length
                          ? t("settings.cleanupSelectNone", {
                              defaultValue: "Clear selection",
                            })
                          : t("settings.cleanupSelectAll", {
                              defaultValue: "Select all",
                            })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="general-storage-action danger"
                      onClick={() => setPendingCleanup(true)}
                      disabled={
                        cleanupSelected.length === 0 ||
                        cleanupPlan.files === 0 ||
                        isCleaningUp
                      }
                      title={t("settings.cleanupDelete", {
                        defaultValue: "Delete selected",
                      })}
                    >
                      {isCleaningUp ? (
                        <LoaderCircle
                          size={11}
                          strokeWidth={1.8}
                          className="tool-call-icon-spinning"
                          aria-hidden="true"
                        />
                      ) : (
                        <Trash2
                          size={11}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {isCleaningUp
                          ? t("settings.cleanupDeleting", {
                              defaultValue: "Cleaning...",
                            })
                          : t("settings.cleanupDelete", {
                              defaultValue: "Delete selected",
                            })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="general-storage-action"
                      onClick={() => void runCleanupScan()}
                      disabled={cleanupScanning || isCleaningUp}
                      title={t("settings.cleanupRescan", {
                        defaultValue: "Rescan",
                      })}
                    >
                      {cleanupScanning ? (
                        <LoaderCircle
                          size={11}
                          strokeWidth={1.8}
                          className="tool-call-icon-spinning"
                          aria-hidden="true"
                        />
                      ) : (
                        <RefreshCw
                          size={11}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {t("settings.cleanupRescan", {
                          defaultValue: "Rescan",
                        })}
                      </span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {activeTab === "general" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.teamCollaboration", {
                defaultValue: "团队协作",
              })}
            </strong>
            <span>
              {t("settings.teamCollaborationInfo", {
                defaultValue:
                  "基于 Git 的共享数据平面：团队成员共同维护任务、评审与笔记，无需后端服务。默认关闭。",
              })}
            </span>
          </div>

          <div className="api-settings-form-body">
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.teamCollaborationEnabled", {
                  defaultValue: "启用团队协作",
                })}
              </span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={teamEnabled}
                  onChange={(event) =>
                    handleTeamEnabledChange(event.target.checked)
                  }
                  hidden
                />
                <span className="toggle-slider" aria-hidden="true" />
                <span>
                  {teamEnabled
                    ? t("settings.enabled", { defaultValue: "已启用" })
                    : t("settings.disabled", { defaultValue: "已关闭" })}
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      {activeTab === "storage" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.storageLocations", {
                defaultValue: "Storage locations",
              })}
            </strong>
            <span>
              {t("settings.storageLocationsInfo", {
                defaultValue:
                  "Where Snow App stores its database, checkpoints and uploaded images.",
              })}
            </span>
          </div>

          <div className="api-settings-form-body">
            {/* 运行数据库位置 */}
            <div className="general-storage-row">
              <div className="general-storage-info">
                <Database
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.storageRuntimeDatabase", {
                      defaultValue: "Runtime database",
                    })}
                  </span>
                  <span
                    className="general-storage-path"
                    title={locations?.databasePath}
                  >
                    {locations?.databasePath ?? "—"}
                  </span>
                  {renderSize(locations?.databasePath)}
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() =>
                    locations &&
                    void handleOpenDir(parentDirOf(locations.databasePath))
                  }
                  disabled={!locations || isMigrating}
                  title={t("settings.storageOpenDir", {
                    defaultValue: "Open folder",
                  })}
                >
                  <FolderOpen size={11} aria-hidden="true" />
                  <span>
                    {t("settings.storageOpenDir", {
                      defaultValue: "Open folder",
                    })}
                  </span>
                </button>
                {renderRepairButton("runtime")}
              </div>
            </div>

            {/* 归档数据库位置（archive.db，存放归档会话） */}
            <div className="general-storage-row">
              <div className="general-storage-info">
                <DatabaseBackup
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.storageArchiveDatabase", {
                      defaultValue: "Archive database",
                    })}
                  </span>
                  <span
                    className="general-storage-path"
                    title={locations?.archiveDbPath}
                  >
                    {locations?.archiveDbPath ?? "—"}
                  </span>
                  {renderSize(locations?.archiveDbPath)}
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() =>
                    locations &&
                    void handleOpenDir(parentDirOf(locations.archiveDbPath))
                  }
                  disabled={!locations || isMigrating}
                  title={t("settings.storageOpenDir", {
                    defaultValue: "Open folder",
                  })}
                >
                  <FolderOpen size={11} aria-hidden="true" />
                  <span>
                    {t("settings.storageOpenDir", {
                      defaultValue: "Open folder",
                    })}
                  </span>
                </button>
                {renderRepairButton("archive")}
              </div>
            </div>

            {/* 检查点 / 上传图片位置 */}
            {STORAGE_KINDS.map((kind) => {
              const isCheckpoint = kind === "checkpoint";
              const root = isCheckpoint
                ? locations?.checkpointRoot
                : locations?.uploadRoot;
              const customDir = isCheckpoint
                ? locations?.checkpointDir
                : locations?.uploadDir;
              const isCustom = (customDir ?? "") !== "";

              return (
                <div key={kind} className="general-storage-row">
                  <div className="general-storage-info">
                    {isCheckpoint ? (
                      <Archive
                        size={14}
                        strokeWidth={1.8}
                        className="general-storage-icon"
                        aria-hidden="true"
                      />
                    ) : (
                      <ImageIcon
                        size={14}
                        strokeWidth={1.8}
                        className="general-storage-icon"
                        aria-hidden="true"
                      />
                    )}
                    <div className="general-storage-text">
                      <span className="general-storage-label">
                        {isCheckpoint
                          ? t("settings.storageCheckpoint", {
                              defaultValue: "Checkpoints",
                            })
                          : t("settings.storageUpload", {
                              defaultValue: "Uploaded images",
                            })}
                      </span>
                      <span className="general-storage-path" title={root}>
                        {root ?? "—"}
                      </span>
                      {renderSize(root)}
                    </div>
                  </div>
                  <div className="general-storage-actions">
                    <button
                      type="button"
                      className="general-storage-action"
                      onClick={() => root && void handleOpenDir(root)}
                      disabled={!root || isMigrating}
                      title={t("settings.storageOpenDir", {
                        defaultValue: "Open folder",
                      })}
                    >
                      <FolderOpen size={11} aria-hidden="true" />
                      <span>
                        {t("settings.storageOpenDir", {
                          defaultValue: "Open folder",
                        })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="general-storage-action"
                      onClick={() => void handleChangeDir(kind)}
                      disabled={!root || isMigrating}
                      title={t("settings.storageChangeDir", {
                        defaultValue: "Change folder",
                      })}
                    >
                      <FolderCog size={11} aria-hidden="true" />
                      <span>
                        {t("settings.storageChangeDir", {
                          defaultValue: "Change folder",
                        })}
                      </span>
                    </button>
                    {isCustom && (
                      <button
                        type="button"
                        className="general-storage-action"
                        onClick={() => handleResetDir(kind)}
                        disabled={isMigrating}
                        title={t("settings.storageResetDir", {
                          defaultValue: "Use default",
                        })}
                      >
                        <X size={11} aria-hidden="true" />
                        <span>
                          {t("settings.storageResetDir", {
                            defaultValue: "Use default",
                          })}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* 迁移进度 */}
            {migration && (
              <div className="general-storage-migrate-bar" role="status">
                <div className="general-storage-migrate-info">
                  <LoaderCircle
                    size={12}
                    strokeWidth={1.8}
                    className="tool-call-icon-spinning"
                    aria-hidden="true"
                  />
                  <span>
                    {rollingBack
                      ? t("settings.storageMigrateRollingBack", {
                          defaultValue: "Rolling back...",
                        })
                      : t("settings.storageMigrateProgress", {
                          values: {
                            current: migration.copied,
                            total: migration.total,
                          },
                          defaultValue: `Migrating ${migration.copied}/${migration.total}`,
                        })}
                  </span>
                  {!rollingBack && (
                    <button
                      type="button"
                      className="general-storage-migrate-cancel"
                      onClick={cancelMigration}
                    >
                      {t("settings.cancel", { defaultValue: "Cancel" })}
                    </button>
                  )}
                </div>
                <div className="general-storage-migrate-progress-bar">
                  <div
                    className="general-storage-migrate-progress-fill"
                    style={{
                      width: `${
                        migration.total > 0
                          ? Math.min(
                              100,
                              Math.round(
                                (migration.copied / migration.total) * 100,
                              ),
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* 图片库存储位置 */}
            <div className="general-storage-row">
              <div className="general-storage-info">
                <Images
                  size={14}
                  strokeWidth={1.8}
                  className="general-storage-icon"
                  aria-hidden="true"
                />
                <div className="general-storage-text">
                  <span className="general-storage-label">
                    {t("settings.storageImageLibrary", {
                      defaultValue: "Image library",
                    })}
                  </span>
                  <span
                    className="general-storage-path"
                    title={imageLibraryRoot}
                  >
                    {imageLibraryRoot || "—"}
                  </span>
                  {renderSize(imageLibraryRoot)}
                </div>
              </div>
              <div className="general-storage-actions">
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() =>
                    imageLibraryRoot && void handleOpenDir(imageLibraryRoot)
                  }
                  disabled={!imageLibraryRoot || isImageLibraryBusy}
                  title={t("settings.storageOpenDir", {
                    defaultValue: "Open folder",
                  })}
                >
                  <FolderOpen size={11} aria-hidden="true" />
                  <span>
                    {t("settings.storageOpenDir", {
                      defaultValue: "Open folder",
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  className="general-storage-action"
                  onClick={() => void handleImageLibraryChangeDir()}
                  disabled={!imageLibraryRoot || isImageLibraryBusy}
                  title={t("settings.storageChangeDir", {
                    defaultValue: "Change folder",
                  })}
                >
                  <FolderCog size={11} aria-hidden="true" />
                  <span>
                    {t("settings.storageChangeDir", {
                      defaultValue: "Change folder",
                    })}
                  </span>
                </button>
                {imageLibraryCustomDir && (
                  <button
                    type="button"
                    className="general-storage-action"
                    onClick={handleImageLibraryResetDir}
                    disabled={isImageLibraryBusy}
                    title={t("settings.storageResetDir", {
                      defaultValue: "Use default",
                    })}
                  >
                    <X size={11} aria-hidden="true" />
                    <span>
                      {t("settings.storageResetDir", {
                        defaultValue: "Use default",
                      })}
                    </span>
                  </button>
                )}
              </div>
            </div>

            {/* 图库迁移进度 */}
            {imageLibraryMigration && (
              <div className="general-storage-migrate-bar" role="status">
                <div className="general-storage-migrate-info">
                  <LoaderCircle
                    size={12}
                    strokeWidth={1.8}
                    className="tool-call-icon-spinning"
                    aria-hidden="true"
                  />
                  <span>
                    {imageLibraryRollingBack
                      ? t("settings.imageLibraryMigrateRollingBack")
                      : t("settings.imageLibraryMigrateProgress", {
                          values: {
                            current: imageLibraryMigration.copied,
                            total: imageLibraryMigration.total,
                          },
                        })}
                  </span>
                  {!imageLibraryRollingBack && (
                    <button
                      type="button"
                      className="general-storage-migrate-cancel"
                      onClick={cancelImageLibraryMigration}
                    >
                      {t("settings.cancel", { defaultValue: "Cancel" })}
                    </button>
                  )}
                </div>
                <div className="general-storage-migrate-progress-bar">
                  <div
                    className="general-storage-migrate-progress-fill"
                    style={{
                      width: `${
                        imageLibraryMigration.total > 0
                          ? Math.min(
                              100,
                              Math.round(
                                (imageLibraryMigration.copied /
                                  imageLibraryMigration.total) *
                                  100,
                              ),
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "general" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>
              {t("settings.attachContextTitle", {
                defaultValue: "会话上下文注入",
              })}
            </strong>
            <span>
              {t("settings.attachContextInfo", {
                defaultValue:
                  "拖拽历史会话到输入框，可将其注入为当前会话的开头上下文。注入前会自动清洗（剔除思考链与工具执行细节）并按预算裁剪，保护上下文窗口。",
              })}
            </span>
          </div>

          <div className="api-settings-form-body">
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.attachContextSingleBudget", {
                  defaultValue: "单附件预算（字符）",
                })}
              </span>
              <input
                className="settings-number-input"
                type="number"
                min={ATTACH_CONTEXT_BUDGET_MIN}
                max={ATTACH_CONTEXT_BUDGET_MAX}
                step={1000}
                value={attachSingleBudget}
                onChange={(event) => setAttachSingleBudget(event.target.value)}
                onBlur={() =>
                  saveAttachBudget(
                    ATTACH_CONTEXT_SINGLE_BUDGET_SETTING,
                    attachSingleBudget,
                  )
                }
                title={t("settings.attachContextBudgetHint", {
                  defaultValue: "范围 1000-200000，超出自动截断。",
                })}
              />
            </div>
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.attachContextTotalBudget", {
                  defaultValue: "全部附件合计预算（字符）",
                })}
              </span>
              <input
                className="settings-number-input"
                type="number"
                min={ATTACH_CONTEXT_BUDGET_MIN}
                max={ATTACH_CONTEXT_BUDGET_MAX}
                step={1000}
                value={attachTotalBudget}
                onChange={(event) => setAttachTotalBudget(event.target.value)}
                onBlur={() =>
                  saveAttachBudget(
                    ATTACH_CONTEXT_TOTAL_BUDGET_SETTING,
                    attachTotalBudget,
                  )
                }
                title={t("settings.attachContextBudgetHint", {
                  defaultValue: "范围 1000-200000，超出自动截断。",
                })}
              />
            </div>
            <div className="settings-update-actions">
              <div className="settings-attach-budget-actions">
                <button
                  className="nav-item"
                  onClick={resetAttachBudgets}
                  type="button"
                >
                  <RotateCcw size={14} strokeWidth={1.8} />
                  <span>
                    {t("settings.attachContextReset", {
                      defaultValue: "恢复默认",
                    })}
                  </span>
                </button>
                {attachBudgetSaved && (
                  <span className="settings-update-hint">
                    {t("settings.attachContextSaved", {
                      defaultValue: "已保存",
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "about" && (
        <div className="api-settings-manual-form">
          <div className="api-settings-manual-header">
            <strong>{t("settings.about", { defaultValue: "About" })}</strong>
            <span>
              {t("settings.aboutInfo", {
                defaultValue: "Version and update management for Snow App.",
              })}
            </span>
          </div>

          <div className="api-settings-form-body">
            <div className="settings-about-row">
              <span className="settings-item-description">
                {t("settings.version", { defaultValue: "Version" })}
              </span>
              {appVersion && (
                <span className="sidebar-version-badge">v{appVersion}</span>
              )}
              {/* 检查更新按钮 - 行内右侧，始终可见 */}
              <button
                className={`nav-item check-update-btn ${
                  isChecking ? "checking" : ""
                }`}
                onClick={handleCheckForUpdates}
                type="button"
                disabled={isChecking || updateStatus.downloading}
              >
                <RefreshCw size={14} strokeWidth={1.8} />
                <span>
                  {isChecking
                    ? t("settings.checkingUpdate", {
                        defaultValue: "Checking for updates...",
                      })
                    : t("settings.checkUpdate", {
                        defaultValue: "Check for updates",
                      })}
                </span>
              </button>
            </div>

            <div className="settings-update-actions">
              {/* 发现新版本 → 打开更新弹窗（展示发行说明与下载进度） */}
              {updateStatus.available &&
                !updateStatus.downloading &&
                !updateStatus.downloaded && (
                  <button
                    className="nav-item update-ready-btn"
                    onClick={handleOpenUpdateDialog}
                    type="button"
                  >
                    <Download size={16} strokeWidth={1.8} />
                    <span>
                      {t("settings.newVersionAvailable", {
                        values: { version: updateStatus.version ?? "" },
                        defaultValue: `Update to ${updateStatus.version ?? ""}`,
                      })}
                    </span>
                  </button>
                )}

              {/* 下载中：点击重新打开弹窗查看进度 */}
              {updateStatus.available && updateStatus.downloading && (
                <button
                  className="nav-item update-downloading"
                  onClick={handleOpenUpdateDialog}
                  type="button"
                >
                  <LoaderCircle size={16} strokeWidth={1.8} />
                  <span>
                    {t("settings.updateDownloading", {
                      values: { percent: updateStatus.progress },
                      defaultValue: `Downloading ${updateStatus.progress}%`,
                    })}
                  </span>
                </button>
              )}

              {/* 下载完成 → 直接重启安装（无需再确认） */}
              {updateStatus.downloaded && (
                <button
                  className="nav-item update-ready-btn"
                  onClick={() => void window.snow.installUpdate()}
                  type="button"
                >
                  <Download size={16} strokeWidth={1.8} />
                  <span>
                    {t("settings.updateReady", {
                      defaultValue: "Restart to update",
                    })}
                  </span>
                </button>
              )}
            </div>

            <div className="api-settings-form-section">
              <div className="api-settings-manual-header">
                <strong>
                  {t("settings.aboutLicense", { defaultValue: "开源协议" })}
                </strong>
                <span>
                  {t("settings.aboutLicenseInfo", {
                    defaultValue: "Snow App 以 MIT 许可发布。",
                  })}
                </span>
              </div>

              <div className="general-storage-row">
                <div className="general-storage-info">
                  <FileText
                    size={14}
                    strokeWidth={1.8}
                    className="general-storage-icon"
                    aria-hidden="true"
                  />
                  <div className="general-storage-text">
                    <span className="general-storage-label">MIT License</span>
                    <span className="settings-item-description">
                      {t("settings.aboutLicenseCopyright", {
                        defaultValue: "Copyright (c) 2026 MayMay",
                      })}
                    </span>
                  </div>
                </div>
              </div>

              <div className="about-legal-details">
                <details>
                  <summary>
                    {t("settings.aboutLicenseFull", {
                      defaultValue: "查看许可协议全文",
                    })}
                  </summary>
                  <pre className="about-legal-text">{MIT_LICENSE_TEXT}</pre>
                </details>
              </div>
            </div>

            <div className="api-settings-form-section">
              <div className="api-settings-manual-header">
                <strong>
                  {t("settings.aboutPrivacy", { defaultValue: "隐私说明" })}
                </strong>
                <span>
                  {t("settings.aboutPrivacyInfo", {
                    defaultValue: "Snow App 在本机如何处理你的数据。",
                  })}
                </span>
              </div>

              {ABOUT_PRIVACY_ITEMS.map(({ icon: Icon, titleKey, bodyKey }) => (
                <div className="general-storage-row" key={titleKey}>
                  <div className="general-storage-info">
                    <Icon
                      size={14}
                      strokeWidth={1.8}
                      className="general-storage-icon"
                      aria-hidden="true"
                    />
                    <div className="general-storage-text">
                      <span className="general-storage-label">
                        {t(titleKey)}
                      </span>
                      <span className="settings-item-description">
                        {t(bodyKey)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="api-settings-form-section">
              <div className="api-settings-manual-header">
                <strong>
                  {t("settings.aboutDisclaimer", { defaultValue: "免责声明" })}
                </strong>
                <span>
                  {t("settings.aboutDisclaimerInfo", {
                    defaultValue:
                      "Snow App 按「原样」提供，请在理解风险的前提下使用。",
                  })}
                </span>
              </div>

              {ABOUT_DISCLAIMER_ITEMS.map(
                ({ icon: Icon, titleKey, bodyKey }) => (
                  <div className="general-storage-row" key={titleKey}>
                    <div className="general-storage-info">
                      <Icon
                        size={14}
                        strokeWidth={1.8}
                        className="general-storage-icon"
                        aria-hidden="true"
                      />
                      <div className="general-storage-text">
                        <span className="general-storage-label">
                          {t(titleKey)}
                        </span>
                        <span className="settings-item-description">
                          {t(bodyKey)}
                        </span>
                      </div>
                    </div>
                  </div>
                ),
              )}

              <div className="general-storage-row">
                <div className="general-storage-info">
                  <CircleCheck
                    size={14}
                    strokeWidth={1.8}
                    className="general-storage-icon"
                    aria-hidden="true"
                  />
                  <div className="general-storage-text">
                    <span className="general-storage-label">
                      {t("settings.aboutAgreement", {
                        defaultValue: "使用即同意",
                      })}
                    </span>
                    <span className="settings-item-description">
                      {t("settings.aboutAgreementInfo", {
                        defaultValue:
                          "继续使用 Snow App，即表示你已阅读并同意上述开源协议、隐私说明与免责声明。",
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingMigration !== null}
        title={t("settings.storageMigrateTitle", {
          defaultValue: "Migrate data",
        })}
        message={t("settings.storageMigrateConfirm", {
          values: { dir: pendingMigration?.dirLabel ?? "" },
          defaultValue:
            "Existing files will be moved to:\n{{dir}}\n\nContinue?",
        })}
        confirmLabel={t("settings.storageMigrateConfirmBtn", {
          defaultValue: "Migrate",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmMigration()}
        onCancel={() => setPendingMigration(null)}
      />

      <ConfirmDialog
        open={imageLibraryPendingMigration !== null}
        title={t("settings.imageLibraryMigrateTitle", {
          defaultValue: "Migrate images",
        })}
        message={t("settings.imageLibraryMigrateConfirm", {
          values: { dir: imageLibraryPendingMigration?.dirLabel ?? "" },
          defaultValue:
            "Images in the library will be moved to:\n{{dir}}\n\nContinue?",
        })}
        confirmLabel={t("settings.imageLibraryMigrateStart", {
          defaultValue: "Start migration",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmImageLibraryMigration()}
        onCancel={() => setImageLibraryPendingMigration(null)}
      />

      <ConfirmDialog
        open={pendingRepair !== null}
        title={t("settings.storageRepairTitle", {
          defaultValue: "Repair database",
        })}
        message={t("settings.storageRepairConfirm", {
          defaultValue:
            "Run an integrity check on the database and repair it automatically if damaged. A backup of a damaged database is kept automatically. It is recommended to finish active conversations first. Continue?",
        })}
        confirmLabel={t("settings.storageRepairConfirmBtn", {
          defaultValue: "Repair",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => {
          const kind = pendingRepair;
          setPendingRepair(null);
          if (kind) {
            void handleRepairDatabase(kind);
          }
        }}
        onCancel={() => setPendingRepair(null)}
      />

      <ConfirmDialog
        open={pendingClearCache}
        title={t("settings.resourceClearCacheTitle", {
          defaultValue: "Clear app cache",
        })}
        message={t("settings.resourceClearCacheConfirm", {
          defaultValue:
            "Cached app resources will be cleared and the interface will reload. Sign-in state and local data are kept. Continue?",
        })}
        confirmLabel={t("settings.resourceClearCacheConfirmBtn", {
          defaultValue: "Clear and reload",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => {
          setPendingClearCache(false);
          void handleClearCacheAndReload();
        }}
        onCancel={() => setPendingClearCache(false)}
      />

      <ConfirmDialog
        open={pendingCleanup}
        variant="danger"
        title={t("settings.cleanupConfirmTitle", {
          defaultValue: "Delete selected data",
        })}
        message={t("settings.cleanupConfirmMessage", {
          values: {
            count: cleanupSelected.length,
            files: cleanupPlan.files,
            size: formatBytes(cleanupPlan.bytes),
            range: cleanupAgeLabel,
          },
          defaultValue:
            "This permanently deletes {{files}} file(s) ({{size}}) from " +
            "{{count}} selected category(ies) — {{range}}. This cannot be undone.",
        })}
        confirmLabel={t("settings.cleanupConfirmBtn", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        isConfirming={isCleaningUp}
        onConfirm={() => void confirmCleanup()}
        onCancel={() => setPendingCleanup(false)}
      />
    </div>
  );
}
