import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Timer,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import { RangeSlider } from "../../common/RangeSlider";
import { UsageDateFilter } from "../usageSettings/UsageDateFilter";
import { getActiveLocale, useI18n } from "../../../i18n";
import {
  usePublishSettingsPageActions,
  type SettingsPageAction,
} from "../../TopBar/settingsPageActionsStore";
import type { AppLogPage, AppLogRecord } from "../../../../preload";
import type { UsageDatePreset } from "../usageSettings/types";

const PAGE_SIZE = 50;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// 请求日志开启时长（分钟）：默认 5，最小 1，最大 30。
const DURATION_MIN = 1;
const DURATION_MAX = 30;
const DURATION_PRESETS = [1, 5, 10, 15, 30];

// 系统日志保留期（天）：0 表示不清理；默认保留近 7 天。
const RETENTION_OPTIONS: { days: number; labelKey: string }[] = [
  { days: 7, labelKey: "settings.systemLogsRetention7Days" },
  { days: 30, labelKey: "settings.systemLogsRetention30Days" },
  { days: 90, labelKey: "settings.systemLogsRetention90Days" },
  { days: 0, labelKey: "settings.systemLogsRetentionNever" },
];
const DEFAULT_RETENTION_DAYS = 7;

const formatCountdown = (ms: number): string => {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}`;
};

type LogLevelFilter = "" | "DEBUG" | "INFO" | "WARN" | "ERROR";

/** 导出范围：当前筛选结果 / 按天拆分 / 已勾选条目。 */
type LogExportScope = "filtered" | "perDay" | "selection";

type LogExportFormat = "text" | "json";

const LEVEL_FILTERS: LogLevelFilter[] = ["", "DEBUG", "INFO", "WARN", "ERROR"];

const formatDateForInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getMonthStart = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const getMonthEnd = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);

const getPresetRange = (
  preset: UsageDatePreset,
  now: Date,
): { since: Date; until: Date } => {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  switch (preset) {
    case "today":
      return { since: startOfToday, until: now };
    case "yesterday": {
      const yesterday = new Date(startOfToday.getTime() - ONE_DAY_MS);
      return {
        since: yesterday,
        until: new Date(
          yesterday.getFullYear(),
          yesterday.getMonth(),
          yesterday.getDate(),
          23,
          59,
          59,
          999,
        ),
      };
    }
    case "last7days":
      return {
        since: new Date(startOfToday.getTime() - 6 * ONE_DAY_MS),
        until: now,
      };
    case "last30days":
      return {
        since: new Date(startOfToday.getTime() - 29 * ONE_DAY_MS),
        until: now,
      };
    case "thisMonth":
      return { since: getMonthStart(now), until: now };
    case "lastMonth": {
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return {
        since: getMonthStart(lastMonthDate),
        until: getMonthEnd(lastMonthDate),
      };
    }
    case "all":
      // 全部日期：不设边界，由调用方将 since/until 置空。
      return { since: now, until: now };
    case "custom":
    default:
      return { since: now, until: now };
  }
};

const formatTime = (value: string): string => {
  if (!value) return "";
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(getActiveLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const formatDate = (value: string): string => {
  if (!value) return "";
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(getActiveLocale(), {
    month: "short",
    day: "numeric",
  });
};

const levelClass = (level: string): string => {
  switch (level) {
    case "DEBUG":
      return "debug";
    case "INFO":
      return "info";
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return "info";
  }
};

const hasDetail = (record: AppLogRecord): boolean =>
  Boolean(
    record.input ||
    record.output ||
    record.duration ||
    record.context ||
    record.error,
  );

export function SystemLogsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [records, setRecords] = useState<AppLogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>("");
  /** 模块筛选（空 = 全部模块），可选项来自日志里实际出现过的模块。 */
  const [moduleFilter, setModuleFilter] = useState("");
  const [modules, setModules] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showClearLogsConfirm, setShowClearLogsConfirm] = useState(false);
  const [isClearingLogs, setIsClearingLogs] = useState(false);

  const [requestLoggingEnabled, setRequestLoggingEnabled] = useState(false);
  const [showRequestLoggingDialog, setShowRequestLoggingDialog] =
    useState(false);
  const [durationMinutes, setDurationMinutes] = useState(5);
  const [loggingExpiresAt, setLoggingExpiresAt] = useState<number | null>(null);
  const [retentionDays, setRetentionDays] = useState(DEFAULT_RETENTION_DAYS);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [copiedRowLabel, setCopiedRowLabel] = useState<string | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);

  /** 勾选用于自定义选择的日志 id（随列表刷新清空）。 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showClearSelectionConfirm, setShowClearSelectionConfirm] =
    useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportScope, setExportScope] = useState<LogExportScope>("filtered");
  const [exportFormat, setExportFormat] = useState<LogExportFormat>("text");
  const [isExporting, setIsExporting] = useState(false);

  const [datePreset, setDatePreset] = useState<UsageDatePreset>("today");
  const [sinceDate, setSinceDate] = useState<string>(() =>
    formatDateForInput(getPresetRange("today", new Date()).since),
  );
  const [untilDate, setUntilDate] = useState<string>(() =>
    formatDateForInput(getPresetRange("today", new Date()).until),
  );

  const handlePresetChange = useCallback((preset: UsageDatePreset) => {
    setDatePreset(preset);
    if (preset === "all") {
      // 全部日期：清空日期边界，Rust 端空字符串跳过过滤。
      setSinceDate("");
      setUntilDate("");
    } else if (preset !== "custom") {
      const range = getPresetRange(preset, new Date());
      setSinceDate(formatDateForInput(range.since));
      setUntilDate(formatDateForInput(range.until));
    }
  }, []);

  const handleSinceDateChange = useCallback((value: string) => {
    setSinceDate(value);
    setDatePreset("custom");
  }, []);

  const handleUntilDateChange = useCallback((value: string) => {
    setUntilDate(value);
    setDatePreset("custom");
  }, []);

  const sinceDateTime = useMemo(
    () => (sinceDate ? `${sinceDate} 00:00:00` : ""),
    [sinceDate],
  );
  const untilDateTime = useMemo(
    () => (untilDate ? `${untilDate} 23:59:59` : ""),
    [untilDate],
  );

  const loadLogs = useCallback(
    async (pageOffset: number, level: LogLevelFilter) => {
      setIsLoading(true);
      setError("");
      try {
        const [page, moduleNames]: [AppLogPage, string[]] = await Promise.all([
          window.snow.listAppLogs(
            level,
            moduleFilter,
            sinceDateTime,
            untilDateTime,
            PAGE_SIZE,
            pageOffset,
          ),
          window.snow.listAppLogModules(),
        ]);
        setRecords(page.items ?? []);
        setTotal(page.total ?? 0);
        setOffset(pageOffset);
        setModules(moduleNames);
        setExpandedIds(new Set());
        setSelectedIds(new Set());
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.systemLogsLoadError", {
                defaultValue: "Failed to load system logs.",
              }),
        );
      } finally {
        setIsLoading(false);
      }
    },
    [moduleFilter, sinceDateTime, untilDateTime, t],
  );

  useEffect(() => {
    void loadLogs(0, levelFilter);
  }, [loadLogs, levelFilter]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  // 挂载时读取开关与过期时间；过期的遗留状态（开着但无有效过期时间）立即复位。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [enabled, expiry] = await Promise.all([
          window.snow.getRequestLogging(),
          window.snow.getRequestLoggingExpiry(),
        ]);
        if (cancelled) return;
        const now = Date.now();
        setNowMs(now);
        if (enabled && (expiry <= 0 || expiry <= now)) {
          setRequestLoggingEnabled(false);
          setLoggingExpiresAt(null);
          void window.snow.setRequestLogging(false).catch(() => undefined);
          void window.snow.setRequestLoggingExpiry(0).catch(() => undefined);
          return;
        }
        setRequestLoggingEnabled(enabled);
        setLoggingExpiresAt(enabled && expiry > 0 ? expiry : null);
      } catch {
        /* 读取失败保持默认关闭状态 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 挂载时读取日志保留期设置；读取失败保持默认（近 7 天）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const days = await window.snow.getAppLogsRetentionDays();
        if (!cancelled && Number.isFinite(days)) {
          setRetentionDays(Math.max(0, Math.trunc(days)));
        }
      } catch {
        /* 读取失败保持默认保留期 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const disableRequestLogging = useCallback(
    async (expired: boolean) => {
      setRequestLoggingEnabled(false);
      setLoggingExpiresAt(null);
      try {
        await window.snow.setRequestLogging(false);
        await window.snow.setRequestLoggingExpiry(0);
        setNotice(
          expired
            ? t("settings.systemLogsRequestLoggingExpired", {
                defaultValue: "Request logging auto-disabled (timer expired).",
              })
            : t("settings.systemLogsRequestLoggingDisabled", {
                defaultValue: "Request logging disabled.",
              }),
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.systemLogsRequestLoggingError", {
                defaultValue: "Failed to toggle request logging.",
              }),
        );
      }
    },
    [t],
  );

  // 倒计时：每秒刷新显示；到点自动关闭（即使 Rust 后端也会强制停写，这里负责 UI 复位）。
  useEffect(() => {
    if (!requestLoggingEnabled || loggingExpiresAt === null) return;
    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      if (now >= loggingExpiresAt) {
        void disableRequestLogging(true);
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [requestLoggingEnabled, loggingExpiresAt, disableRequestLogging]);

  const handleRequestLoggingToggle = useCallback(() => {
    if (requestLoggingEnabled) {
      void disableRequestLogging(false);
      return;
    }
    setShowRequestLoggingDialog(true);
  }, [requestLoggingEnabled, disableRequestLogging]);

  const confirmRequestLogging = useCallback(async () => {
    setShowRequestLoggingDialog(false);
    const expiresAt = Date.now() + durationMinutes * 60_000;
    setRequestLoggingEnabled(true);
    setLoggingExpiresAt(expiresAt);
    setNowMs(Date.now());
    try {
      // 先写过期时间再开开关，避免“开关已开但还没有过期时间”的空窗。
      await window.snow.setRequestLoggingExpiry(expiresAt);
      await window.snow.setRequestLogging(true);
      setNotice(
        t("settings.systemLogsRequestLoggingEnabled", {
          defaultValue: "Request logging enabled.",
        }),
      );
    } catch (e) {
      setRequestLoggingEnabled(false);
      setLoggingExpiresAt(null);
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemLogsRequestLoggingError", {
              defaultValue: "Failed to toggle request logging.",
            }),
      );
    }
  }, [durationMinutes, t]);

  const retentionOptions = useMemo(
    () =>
      RETENTION_OPTIONS.map((option) => ({
        value: String(option.days),
        label: t(option.labelKey),
      })),
    [t],
  );

  const handleRetentionChange = useCallback(
    async (days: number) => {
      const previousDays = retentionDays;
      if (days === previousDays) return;
      setRetentionDays(days);
      try {
        await window.snow.setAppLogsRetentionDays(days);
        const deleted = await window.snow.pruneAppLogs();
        setNotice(
          deleted > 0
            ? t("settings.systemLogsRetentionPruned", {
                defaultValue:
                  "Log retention updated. {{count}} expired entries deleted.",
                values: { count: deleted.toLocaleString() },
              })
            : t("settings.systemLogsRetentionUpdated", {
                defaultValue: "Log retention updated.",
              }),
        );
        void loadLogs(0, levelFilter);
      } catch (e) {
        setRetentionDays(previousDays);
        setError(
          e instanceof Error
            ? e.message
            : t("settings.systemLogsRetentionError", {
                defaultValue: "Failed to update log retention.",
              }),
        );
      }
    },
    [retentionDays, levelFilter, loadLogs, t],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const handleLevelFilter = useCallback((level: LogLevelFilter) => {
    setLevelFilter(level);
  }, []);

  // 当前选中的模块在清空日志后可能不再出现，仍保留为可选项，避免选择被静默改掉。
  const moduleOptions = useMemo(() => {
    const names =
      moduleFilter && !modules.includes(moduleFilter)
        ? [moduleFilter, ...modules]
        : modules;
    return [
      { value: "", label: t("settings.systemLogsModuleAll") },
      ...names.map((name) => ({ value: name, label: name })),
    ];
  }, [moduleFilter, modules, t]);

  const handleRefresh = useCallback(() => {
    void loadLogs(offset, levelFilter);
  }, [loadLogs, offset, levelFilter]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleCopyText = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    setCopiedRowLabel(label);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedRowLabel(null);
      copyResetTimerRef.current = null;
    }, 2000);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allPageSelected =
    records.length > 0 && records.every((record) => selectedIds.has(record.id));

  // 全选 / 取消全选本页（选择会随翻页或刷新清空）。
  const toggleSelectPage = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const everySelected = records.every((record) => next.has(record.id));
      for (const record of records) {
        if (everySelected) {
          next.delete(record.id);
        } else {
          next.add(record.id);
        }
      }
      return next;
    });
  }, [records]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const runExport = useCallback(
    async (scope: LogExportScope, format: LogExportFormat, ids: string[]) => {
      setIsExporting(true);
      setError("");
      try {
        // 自定义选择优先按 id 导出，其余范围沿用当前筛选条件。
        const useFilter = scope !== "selection";
        const result = await window.snow.exportAppLogs(
          useFilter ? levelFilter : "",
          useFilter ? moduleFilter : "",
          useFilter ? sinceDateTime : "",
          useFilter ? untilDateTime : "",
          ids,
          format,
          scope === "perDay",
        );
        if (result.canceled) return;
        if (result.count === 0) {
          setNotice(
            t("settings.systemLogsExportEmpty", {
              defaultValue: "No log entries match the current filters.",
            }),
          );
          return;
        }
        setNotice(
          t("settings.systemLogsExportSuccess", {
            defaultValue: "Exported {{count}} entries to {{path}}",
            values: {
              count: result.count.toLocaleString(),
              path:
                result.files.length > 1
                  ? `${result.files[0]} (+${result.files.length - 1})`
                  : result.files[0],
            },
          }),
        );
        if (scope === "selection") {
          setSelectedIds(new Set());
        }
        setShowExportDialog(false);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.systemLogsExportError", {
                defaultValue: "Failed to export system logs.",
              }),
        );
      } finally {
        setIsExporting(false);
      }
    },
    [levelFilter, moduleFilter, sinceDateTime, untilDateTime, t],
  );

  const handleExportConfirm = useCallback(() => {
    const ids = exportScope === "selection" ? Array.from(selectedIds) : [];
    void runExport(exportScope, exportFormat, ids);
  }, [exportScope, exportFormat, selectedIds, runExport]);

  // 单条导出：直接导出该条日志（当前格式）。
  const handleExportEntry = useCallback(
    (record: AppLogRecord) => {
      void runExport("selection", exportFormat, [record.id]);
    },
    [exportFormat, runExport],
  );

  const confirmClearLogs = useCallback(async () => {
    setIsClearingLogs(true);
    try {
      await window.snow.clearAppLogs();
      setNotice(
        t("settings.systemLogsCleared", {
          defaultValue: "System logs cleared.",
        }),
      );
      void loadLogs(0, levelFilter);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemLogsClearError", {
              defaultValue: "Failed to clear system logs.",
            }),
      );
    } finally {
      setIsClearingLogs(false);
      setShowClearLogsConfirm(false);
    }
  }, [levelFilter, loadLogs, t]);

  usePublishSettingsPageActions(
    "system-logs",
    useMemo<SettingsPageAction[]>(
      () => [
        {
          id: "export",
          label: t("settings.systemLogsExport", {
            defaultValue: "Export logs",
          }),
          icon: Upload,
          disabled: total === 0 || isExporting,
          spinning: isExporting,
          onClick: () => {
            // 已有勾选时默认导出所选条目，否则导出当前筛选结果。
            setExportScope(selectedIds.size > 0 ? "selection" : "filtered");
            setShowExportDialog(true);
          },
        },
        {
          id: "refresh",
          label: t("settings.systemLogsRefresh", {
            defaultValue: "Refresh logs",
          }),
          icon: RefreshCw,
          disabled: isLoading,
          spinning: isLoading,
          onClick: handleRefresh,
        },
        {
          id: "clear",
          label: t("settings.systemLogsClear", { defaultValue: "Clear logs" }),
          icon: Trash2,
          disabled: total === 0,
          onClick: () => setShowClearLogsConfirm(true),
        },
      ],
      [t, isLoading, handleRefresh, total, isExporting, selectedIds],
    ),
  );

  const detailRows = useCallback(
    (record: AppLogRecord): { label: string; value: string }[] => {
      const rows: { label: string; value: string }[] = [];
      if (record.input) {
        rows.push({
          label: t("settings.systemLogsDetailInput", { defaultValue: "Input" }),
          value: record.input,
        });
      }
      if (record.output) {
        rows.push({
          label: t("settings.systemLogsDetailOutput", {
            defaultValue: "Output",
          }),
          value: record.output,
        });
      }
      if (record.duration) {
        rows.push({
          label: t("settings.systemLogsDetailDuration", {
            defaultValue: "Duration",
          }),
          value: record.duration,
        });
      }
      if (record.context) {
        rows.push({
          label: t("settings.systemLogsDetailContext", {
            defaultValue: "Context",
          }),
          value: record.context,
        });
      }
      if (record.error) {
        rows.push({
          label: t("settings.systemLogsDetailError", { defaultValue: "Error" }),
          value: record.error,
        });
      }
      return rows;
    },
    [t],
  );

  return (
    <div className="api-settings-page system-logs-page" role="region">
      <AutoDismissNotice
        message={error}
        tone="error"
        onDismiss={() => setError("")}
      />
      <AutoDismissNotice
        message={notice}
        tone="success"
        onDismiss={() => setNotice("")}
      />

      <div className="system-logs-filter-row">
        <div className="system-logs-level-chips" role="tablist">
          {LEVEL_FILTERS.map((level) => (
            <button
              key={level || "all"}
              type="button"
              role="tab"
              aria-selected={levelFilter === level}
              className={`system-logs-level-chip${
                levelFilter === level ? " active" : ""
              }${level ? ` ${levelClass(level)}` : ""}`}
              onClick={() => handleLevelFilter(level)}
            >
              {level ||
                t("settings.systemLogsLevelAll", { defaultValue: "All" })}
            </button>
          ))}
        </div>
        <div className="system-logs-module-filter">
          <CustomSelect
            value={moduleFilter}
            ariaLabel={t("settings.systemLogsModuleFilter")}
            options={moduleOptions}
            onChange={setModuleFilter}
          />
        </div>
      </div>

      <UsageDateFilter
        preset={datePreset}
        sinceDate={sinceDate}
        untilDate={untilDate}
        onPresetChange={handlePresetChange}
        onSinceDateChange={handleSinceDateChange}
        onUntilDateChange={handleUntilDateChange}
      />

      <div className="system-logs-request-logging-row">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={requestLoggingEnabled}
            onChange={handleRequestLoggingToggle}
          />
          <span className="toggle-slider" />
          <span className="system-logs-request-logging-label">
            {t("settings.systemLogsRequestLogging", {
              defaultValue: "Request logging",
            })}
          </span>
        </label>
        {requestLoggingEnabled && loggingExpiresAt !== null && (
          <span
            className="system-logs-countdown-badge"
            title={t("settings.systemLogsRequestLoggingCountdownTitle", {
              defaultValue:
                "Request logging will auto-disable when the timer ends.",
            })}
          >
            <Timer size={12} strokeWidth={1.9} />
            <span className="system-logs-countdown-time">
              {formatCountdown(Math.max(0, loggingExpiresAt - nowMs))}
            </span>
          </span>
        )}
        <span className="settings-item-description">
          {t("settings.systemLogsRequestLoggingDescription", {
            defaultValue:
              "Record the full raw request JSON of every API call. Very high disk usage.",
          })}
        </span>
      </div>

      <div className="system-logs-filter-row">
        <span className="system-logs-request-logging-label">
          {t("settings.systemLogsRetention", { defaultValue: "Log retention" })}
        </span>
        <div className="system-logs-retention-select">
          <CustomSelect
            value={String(retentionDays)}
            options={retentionOptions}
            onChange={(value) => void handleRetentionChange(Number(value))}
          />
        </div>
        <span className="settings-item-description">
          {t("settings.systemLogsRetentionDescription", {
            defaultValue:
              "Logs older than the retention window are deleted automatically.",
          })}
        </span>
      </div>

      <Modal
        open={showRequestLoggingDialog}
        title={t("settings.systemLogsRequestLoggingDialogTitle", {
          defaultValue: "Enable request logging?",
        })}
        description={t("settings.systemLogsRequestLoggingWarning", {
          defaultValue:
            "Request logging records the full raw request JSON of every API call. This has very high disk usage and is not recommended for non-expert users.",
        })}
        closeLabel={t("settings.systemLogsRequestLoggingCancel", {
          defaultValue: "Cancel",
        })}
        onClose={() => setShowRequestLoggingDialog(false)}
        className="request-logging-modal"
        footer={
          <>
            <button
              type="button"
              className="confirm-dialog-btn cancel"
              onClick={() => setShowRequestLoggingDialog(false)}
            >
              {t("settings.systemLogsRequestLoggingCancel", {
                defaultValue: "Cancel",
              })}
            </button>
            <button
              type="button"
              className="confirm-dialog-btn confirm"
              onClick={() => void confirmRequestLogging()}
            >
              {t("settings.systemLogsRequestLoggingConfirm", {
                defaultValue: "Enable",
              })}
            </button>
          </>
        }
      >
        <div className="request-logging-duration">
          <div className="request-logging-duration-head">
            <span className="request-logging-duration-label">
              {t("settings.systemLogsRequestLoggingDuration", {
                defaultValue: "Auto-disable after",
              })}
            </span>
            <span className="request-logging-duration-value">
              {durationMinutes}
              <em>
                {t("settings.systemLogsRequestLoggingMinutes", {
                  defaultValue: "min",
                })}
              </em>
            </span>
          </div>
          <div className="request-logging-duration-presets">
            {DURATION_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`request-logging-duration-preset${
                  durationMinutes === preset ? " active" : ""
                }`}
                onClick={() => setDurationMinutes(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <RangeSlider
            className="request-logging-duration-slider"
            min={DURATION_MIN}
            max={DURATION_MAX}
            step={1}
            value={durationMinutes}
            onChange={(value) => setDurationMinutes(value)}
            ariaLabel={t("settings.systemLogsRequestLoggingDuration", {
              defaultValue: "Auto-disable after",
            })}
          />
          <div className="request-logging-duration-scale">
            <span>{DURATION_MIN}</span>
            <span>{DURATION_MAX}</span>
          </div>
          <p className="request-logging-duration-hint">
            {t("settings.systemLogsRequestLoggingAutoOffHint", {
              defaultValue:
                "Logging stops automatically when the timer ends — no need to turn it off manually.",
            })}
          </p>
        </div>
      </Modal>

      <Modal
        open={showExportDialog}
        title={t("settings.systemLogsExportDialogTitle", {
          defaultValue: "Export logs",
        })}
        description={t("settings.systemLogsExportDialogDescription", {
          defaultValue: "Choose what to export and the file format.",
        })}
        closeLabel={t("settings.systemLogsExportCancel", {
          defaultValue: "Cancel",
        })}
        onClose={() => {
          if (!isExporting) setShowExportDialog(false);
        }}
        className="system-logs-export-modal"
        footer={
          <>
            <button
              type="button"
              className="confirm-dialog-btn cancel"
              disabled={isExporting}
              onClick={() => setShowExportDialog(false)}
            >
              {t("settings.systemLogsExportCancel", {
                defaultValue: "Cancel",
              })}
            </button>
            <button
              type="button"
              className="confirm-dialog-btn primary"
              disabled={
                isExporting ||
                (exportScope === "selection" && selectedIds.size === 0)
              }
              onClick={handleExportConfirm}
            >
              {isExporting
                ? t("settings.systemLogsExportRunning", {
                    defaultValue: "Exporting...",
                  })
                : t("settings.systemLogsExportConfirm", {
                    defaultValue: "Export",
                  })}
            </button>
          </>
        }
      >
        <div className="system-logs-export-body">
          <div className="system-logs-export-group">
            <span className="system-logs-export-label">
              {t("settings.systemLogsExportScope", {
                defaultValue: "What to export",
              })}
            </span>
            <div className="system-logs-export-options" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={exportScope === "filtered"}
                className={`system-logs-export-option${
                  exportScope === "filtered" ? " active" : ""
                }`}
                onClick={() => setExportScope("filtered")}
              >
                {t("settings.systemLogsExportScopeFiltered", {
                  defaultValue: "Current filter ({{count}} entries)",
                  values: { count: total.toLocaleString() },
                })}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={exportScope === "perDay"}
                className={`system-logs-export-option${
                  exportScope === "perDay" ? " active" : ""
                }`}
                onClick={() => setExportScope("perDay")}
              >
                {t("settings.systemLogsExportScopePerDay", {
                  defaultValue: "Split by day",
                })}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={exportScope === "selection"}
                className={`system-logs-export-option${
                  exportScope === "selection" ? " active" : ""
                }`}
                disabled={selectedIds.size === 0}
                onClick={() => setExportScope("selection")}
              >
                {t("settings.systemLogsExportScopeSelection", {
                  defaultValue: "Selected entries ({{count}})",
                  values: { count: selectedIds.size },
                })}
              </button>
            </div>
          </div>

          <div className="system-logs-export-group">
            <span className="system-logs-export-label">
              {t("settings.systemLogsExportFormat", {
                defaultValue: "File format",
              })}
            </span>
            <div className="system-logs-export-options" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={exportFormat === "text"}
                className={`system-logs-export-option${
                  exportFormat === "text" ? " active" : ""
                }`}
                onClick={() => setExportFormat("text")}
              >
                {t("settings.systemLogsExportFormatText", {
                  defaultValue: "Plain text (.log)",
                })}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={exportFormat === "json"}
                className={`system-logs-export-option${
                  exportFormat === "json" ? " active" : ""
                }`}
                onClick={() => setExportFormat("json")}
              >
                {t("settings.systemLogsExportFormatJson", {
                  defaultValue: "JSON (.json)",
                })}
              </button>
            </div>
          </div>

          {exportScope !== "filtered" && (
            <p className="system-logs-export-hint">
              {exportScope === "perDay"
                ? t("settings.systemLogsExportPerDayHint", {
                    defaultValue:
                      "Each day is written as a separate file into the folder you pick.",
                  })
                : t("settings.systemLogsExportSelectionHint", {
                    defaultValue: "Only the entries you selected are exported.",
                  })}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={showClearSelectionConfirm}
        title={t("settings.systemLogsClearSelectionTitle", {
          defaultValue: "Clear selection",
        })}
        message={t("settings.systemLogsClearSelectionConfirm", {
          defaultValue: "Deselect the {{count}} selected entries?",
          values: { count: selectedIds.size.toLocaleString() },
        })}
        confirmLabel={t("settings.systemLogsClearSelection", {
          defaultValue: "Clear",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => {
          clearSelection();
          setShowClearSelectionConfirm(false);
        }}
        onCancel={() => setShowClearSelectionConfirm(false)}
      />

      <ConfirmDialog
        open={showClearLogsConfirm}
        title={t("settings.systemLogsClearConfirmTitle", {
          defaultValue: "Clear system logs",
        })}
        message={t("settings.systemLogsClearConfirmMessage", {
          defaultValue:
            "Permanently delete all system logs? This cannot be undone.",
        })}
        confirmLabel={t("settings.systemLogsClear", {
          defaultValue: "Clear logs",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        isConfirming={isClearingLogs}
        onConfirm={() => void confirmClearLogs()}
        onCancel={() => {
          if (!isClearingLogs) {
            setShowClearLogsConfirm(false);
          }
        }}
      />

      <div className="system-logs-stream-section">
        <div className="system-logs-stream-meta">
          <div className="system-logs-selection-bar">
            <label className="system-logs-select-page">
              <input
                type="checkbox"
                checked={allPageSelected}
                disabled={records.length === 0}
                onChange={toggleSelectPage}
                aria-label={t("settings.systemLogsSelectPage", {
                  defaultValue: "Select page",
                })}
              />
              <span>
                {t("settings.systemLogsSelectPage", {
                  defaultValue: "Select page",
                })}
              </span>
            </label>
            {selectedIds.size > 0 && (
              <>
                <span className="system-logs-selected-count">
                  {t("settings.systemLogsSelectedCount", {
                    defaultValue: "{{count}} selected",
                    values: { count: selectedIds.size.toLocaleString() },
                  })}
                </span>
                <button
                  type="button"
                  className="system-logs-clear-selection"
                  onClick={() => setShowClearSelectionConfirm(true)}
                >
                  <X size={11} strokeWidth={2.4} />
                  {t("settings.systemLogsClearSelection", {
                    defaultValue: "Clear",
                  })}
                </button>
              </>
            )}
          </div>
          <span className="settings-item-description">
            {t("settings.systemLogsTotalInfo", {
              defaultValue: "{{count}} entries",
              values: { count: total.toLocaleString() },
            })}
          </span>
        </div>

        <div className="system-logs-stream" aria-busy={isLoading}>
          {isLoading ? (
            <div className="system-logs-state">
              {t("settings.systemLogsLoading", { defaultValue: "Loading..." })}
            </div>
          ) : records.length === 0 ? (
            <div className="system-logs-state">
              {t("settings.systemLogsEmpty", {
                defaultValue: "No log entries for the current filters.",
              })}
            </div>
          ) : (
            records.map((record) => {
              const expanded = expandedIds.has(record.id);
              const detail = hasDetail(record);
              const rows = detailRows(record);
              return (
                <div
                  key={record.id}
                  className={`system-logs-entry${expanded ? " expanded" : ""}${
                    selectedIds.has(record.id) ? " selected" : ""
                  }`}
                >
                  <div className="system-logs-entry-row">
                    <input
                      type="checkbox"
                      className="system-logs-entry-checkbox"
                      checked={selectedIds.has(record.id)}
                      onChange={() => toggleSelect(record.id)}
                      aria-label={t("settings.systemLogsSelectEntry", {
                        defaultValue: "Select this entry",
                      })}
                    />
                    <button
                      type="button"
                      className="system-logs-entry-head"
                      onClick={() => detail && toggleExpand(record.id)}
                      aria-expanded={detail ? expanded : undefined}
                    >
                      <span className="system-logs-entry-time">
                        <span className="system-logs-entry-date">
                          {formatDate(record.createdAt)}
                        </span>
                        <span className="system-logs-entry-clock">
                          {formatTime(record.createdAt)}
                        </span>
                      </span>
                      <span
                        className={`system-logs-level-badge ${levelClass(
                          record.level,
                        )}`}
                      >
                        {record.level}
                      </span>
                      <span
                        className={`system-logs-source-tag ${
                          record.source === "renderer" ? "renderer" : "main"
                        }`}
                      >
                        {record.source}
                      </span>
                      <span
                        className="system-logs-entry-location"
                        title={`${record.module}:${record.func}${
                          record.line !== undefined && record.line !== null
                            ? `:${record.line}`
                            : ""
                        }`}
                      >
                        {record.module}
                        {record.func ? `.${record.func}` : ""}
                      </span>
                      <span className="system-logs-entry-message">
                        {record.message || "-"}
                      </span>
                      {detail && (
                        <ChevronDown
                          size={14}
                          strokeWidth={1.8}
                          className="system-logs-entry-chevron"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      className="system-logs-entry-export"
                      disabled={isExporting}
                      onClick={() => handleExportEntry(record)}
                      aria-label={t("settings.systemLogsExportEntry", {
                        defaultValue: "Export this entry",
                      })}
                      title={t("settings.systemLogsExportEntry", {
                        defaultValue: "Export this entry",
                      })}
                    >
                      <Upload size={13} strokeWidth={1.8} />
                    </button>
                  </div>
                  {detail && expanded && (
                    <div className="system-logs-entry-detail">
                      {rows.map((row) => (
                        <div key={row.label} className="system-logs-detail-row">
                          <div className="system-logs-detail-label-row">
                            <span className="system-logs-detail-label">
                              {row.label}
                            </span>
                            <button
                              type="button"
                              className={`system-logs-detail-copy-btn${
                                copiedRowLabel === row.label ? " copied" : ""
                              }`}
                              onClick={() =>
                                handleCopyText(row.value, row.label)
                              }
                              aria-label={t("settings.systemLogsCopy", {
                                defaultValue: "Copy",
                              })}
                              title={t("settings.systemLogsCopy", {
                                defaultValue: "Copy",
                              })}
                            >
                              {copiedRowLabel === row.label ? (
                                <Check size={12} strokeWidth={1.8} />
                              ) : (
                                <Copy size={12} strokeWidth={1.8} />
                              )}
                            </button>
                          </div>
                          <span className="system-logs-detail-value">
                            {row.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {total > PAGE_SIZE && (
          <div className="usage-pagination">
            <button
              className="usage-pagination-btn"
              onClick={() =>
                void loadLogs(Math.max(0, offset - PAGE_SIZE), levelFilter)
              }
              disabled={offset === 0 || isLoading}
              type="button"
              aria-label={t("settings.systemLogsPrevPage", {
                defaultValue: "Previous page",
              })}
            >
              <ChevronLeft size={16} strokeWidth={1.8} />
            </button>
            <span className="usage-pagination-info">
              {t("settings.systemLogsPageInfo", {
                defaultValue: "Page {{current}} of {{total}}",
                values: { current: currentPage, total: totalPages },
              })}
            </span>
            <button
              className="usage-pagination-btn"
              onClick={() =>
                void loadLogs(
                  Math.min((totalPages - 1) * PAGE_SIZE, offset + PAGE_SIZE),
                  levelFilter,
                )
              }
              disabled={currentPage >= totalPages || isLoading}
              type="button"
              aria-label={t("settings.systemLogsNextPage", {
                defaultValue: "Next page",
              })}
            >
              <ChevronRight size={16} strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
