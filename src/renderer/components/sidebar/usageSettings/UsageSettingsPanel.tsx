import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { DailyTrendChart } from "./DailyTrendChart";
import { ModelDonutChart } from "./ModelDonutChart";
import { UsageDateFilter } from "./UsageDateFilter";
import { useI18n } from "../../../i18n";
import type {
  DailyUsageBreakdown,
  ModelUsageBreakdown,
  UsageRecord,
  UsageRecordPage,
  UsageSummary,
} from "../../../../preload";
import type { UsageDatePreset, UsageSettingsPanelProps } from "./types";

const PAGE_SIZE = 20;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const formatDateForInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getMonthStart = (date: Date): Date => {
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

const getMonthEnd = (date: Date): Date => {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
};

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
      const yesterdayEnd = new Date(
        yesterday.getFullYear(),
        yesterday.getMonth(),
        yesterday.getDate(),
        23,
        59,
        59,
        999,
      );
      return { since: yesterday, until: yesterdayEnd };
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

const formatDateTime = (value: string): string => {
  if (!value) return "";
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatTokens = (value: number): string => {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000_000_000) {
    return `${(value / 1_000_000_000_000_000_000).toFixed(2)}Qi`;
  }
  if (abs >= 1_000_000_000_000_000) {
    return `${(value / 1_000_000_000_000_000).toFixed(2)}Q`;
  }
  if (abs >= 1_000_000_000_000) {
    return `${(value / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return String(value);
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function UsageSettingsPanel({
  onClose,
}: UsageSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [modelBreakdown, setModelBreakdown] = useState<ModelUsageBreakdown[]>(
    [],
  );
  const [dailyData, setDailyData] = useState<DailyUsageBreakdown[]>([]);
  // 趋势图数据：按当前筛选区间请求，与年度热力图（整年）区分开。
  const [trendData, setTrendData] = useState<DailyUsageBreakdown[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const now = useMemo(() => new Date(), []);
  const [datePreset, setDatePreset] = useState<UsageDatePreset>("last7days");
  const [sinceDate, setSinceDate] = useState<string>(() => {
    const range = getPresetRange("last7days", new Date());
    return formatDateForInput(range.since);
  });
  const [untilDate, setUntilDate] = useState<string>(() => {
    const range = getPresetRange("last7days", new Date());
    return formatDateForInput(range.until);
  });

  // 清理用量数据：独立起止日期，留空表示全部日期。
  const [clearSinceDate, setClearSinceDate] = useState("");
  const [clearUntilDate, setClearUntilDate] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const [pendingClear, setPendingClear] = useState(false);
  const [clearNotice, setClearNotice] = useState("");
  // 使用记录明细默认展开，用户可手动折叠。
  const [recordsOpen, setRecordsOpen] = useState(true);

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

  const loadRecords = useCallback(
    async (pageOffset: number) => {
      setIsLoading(true);
      setError("");
      try {
        const page: UsageRecordPage = await window.snow.listUsageRecords(
          "",
          "",
          PAGE_SIZE,
          pageOffset,
        );
        setRecords(page.items ?? []);
        setTotal(page.total ?? 0);
        setOffset(pageOffset);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.usageLoadError", {
                defaultValue: "Failed to load usage records.",
              }),
        );
      } finally {
        setIsLoading(false);
      }
    },
    [t],
  );

  const loadSummaryAndHeatmap = useCallback(async () => {
    try {
      const heatmapSince = formatDateForInput(
        new Date(now.getTime() - ONE_YEAR_MS),
      );
      const heatmapUntil = formatDateForInput(now);
      const [summaryResult, dailyResult, modelResult, trendResult] =
        await Promise.all([
          window.snow.getUsageSummary(sinceDateTime, untilDateTime),
          window.snow.getUsageDailyBreakdown(heatmapSince, heatmapUntil),
          window.snow.getUsageModelBreakdown(sinceDateTime, untilDateTime),
          window.snow.getUsageDailyBreakdown(sinceDateTime, untilDateTime),
        ]);
      setSummary(summaryResult);
      setDailyData(dailyResult ?? []);
      setModelBreakdown(modelResult ?? []);
      setTrendData(trendResult ?? []);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.usageLoadError", {
              defaultValue: "Failed to load usage statistics.",
            }),
      );
    }
  }, [sinceDateTime, untilDateTime, now, t]);

  const handleRefresh = useCallback(() => {
    void loadRecords(offset);
    void loadSummaryAndHeatmap();
  }, [loadRecords, loadSummaryAndHeatmap, offset]);

  const clearSinceDateTime = clearSinceDate ? `${clearSinceDate} 00:00:00` : "";
  const clearUntilDateTime = clearUntilDate ? `${clearUntilDate} 23:59:59` : "";

  const clearConfirmMessage = useMemo(() => {
    if (clearSinceDate && clearUntilDate) {
      return t("settings.usageClearConfirmRange", {
        defaultValue:
          "Usage records from {{since}} to {{until}} will be permanently deleted. This cannot be undone.",
        values: { since: clearSinceDate, until: clearUntilDate },
      });
    }
    if (clearSinceDate) {
      return t("settings.usageClearConfirmSince", {
        defaultValue:
          "Usage records since {{since}} will be permanently deleted. This cannot be undone.",
        values: { since: clearSinceDate },
      });
    }
    if (clearUntilDate) {
      return t("settings.usageClearConfirmUntil", {
        defaultValue:
          "Usage records before {{until}} will be permanently deleted. This cannot be undone.",
        values: { until: clearUntilDate },
      });
    }
    return t("settings.usageClearConfirmAll", {
      defaultValue:
        "All usage records will be permanently deleted. This cannot be undone.",
    });
  }, [clearSinceDate, clearUntilDate, t]);

  const handleClearRecords = useCallback(async () => {
    setIsClearing(true);
    setClearNotice("");
    setError("");
    try {
      const deleted = await window.snow.deleteUsageRecords(
        clearSinceDateTime,
        clearUntilDateTime,
      );
      setClearNotice(
        t("settings.usageClearDone", {
          defaultValue: "{{count}} usage records deleted.",
          values: { count: String(deleted) },
        }),
      );
      setPendingClear(false);
      await Promise.all([loadRecords(0), loadSummaryAndHeatmap()]);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.usageClearError", {
              defaultValue: "Failed to delete usage records.",
            }),
      );
    } finally {
      setIsClearing(false);
    }
  }, [
    clearSinceDateTime,
    clearUntilDateTime,
    loadRecords,
    loadSummaryAndHeatmap,
    t,
  ]);

  useEffect(() => {
    void loadRecords(0);
  }, [loadRecords]);

  useEffect(() => {
    void loadSummaryAndHeatmap();
  }, [loadSummaryAndHeatmap]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const heatmapCells = useMemo(() => {
    const map = new Map<string, DailyUsageBreakdown>();
    for (const item of dailyData) {
      map.set(item.date, item);
    }
    const cells: {
      date: string;
      value: number;
      data: DailyUsageBreakdown | null;
    }[] = [];
    // Heatmap always shows a full year range, independent of the date filter.
    const heatmapStart = new Date(now.getTime() - ONE_YEAR_MS);
    const heatmapEnd = now;
    const cursor = new Date(heatmapStart);
    while (cursor <= heatmapEnd) {
      const dateStr = formatDateForInput(cursor);
      const data = map.get(dateStr) ?? null;
      cells.push({
        date: dateStr,
        value: data?.totalTokens ?? 0,
        data,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return cells;
  }, [dailyData, now]);

  const maxHeatmapValue = useMemo(() => {
    let max = 0;
    for (const cell of heatmapCells) {
      if (cell.value > max) max = cell.value;
    }
    return max;
  }, [heatmapCells]);

  const heatmapColumns = useMemo(() => {
    const columns: {
      date: string;
      value: number;
      data: DailyUsageBreakdown | null;
    }[][] = [];
    let currentColumn: {
      date: string;
      value: number;
      data: DailyUsageBreakdown | null;
    }[] = [];
    let prevDay: number | null = null;
    for (const cell of heatmapCells) {
      const day = new Date(cell.date + "T00:00:00").getDay();
      if (prevDay !== null && day <= prevDay) {
        while (currentColumn.length < 7) {
          currentColumn.push({ date: "", value: 0, data: null });
        }
        columns.push(currentColumn);
        currentColumn = [];
      }
      while (currentColumn.length < day) {
        currentColumn.push({ date: "", value: 0, data: null });
      }
      currentColumn.push(cell);
      prevDay = day;
    }
    if (currentColumn.length > 0) {
      while (currentColumn.length < 7) {
        currentColumn.push({ date: "", value: 0, data: null });
      }
      columns.push(currentColumn);
    }
    return columns;
  }, [heatmapCells]);

  // Compute month labels positioned above the heatmap grid.
  // Each entry maps a month label to the column index where it starts.
  const monthLabels = useMemo(() => {
    if (heatmapColumns.length === 0) return [];
    const labels: { label: string; startCol: number; colSpan: number }[] = [];
    let prevMonth = -1;
    let spanStart = 0;
    for (let i = 0; i < heatmapColumns.length; i++) {
      const col = heatmapColumns[i];
      const firstRealCell = col.find((c) => c.date);
      if (!firstRealCell) continue;
      const month = new Date(firstRealCell.date + "T00:00:00").getMonth();
      if (prevMonth === -1) {
        prevMonth = month;
        spanStart = i;
      } else if (month !== prevMonth) {
        labels.push({
          label: MONTH_LABELS[prevMonth],
          startCol: spanStart,
          colSpan: i - spanStart,
        });
        prevMonth = month;
        spanStart = i;
      }
    }
    if (prevMonth !== -1) {
      labels.push({
        label: MONTH_LABELS[prevMonth],
        startCol: spanStart,
        colSpan: heatmapColumns.length - spanStart,
      });
    }
    return labels;
  }, [heatmapColumns]);

  const getHeatmapColor = (value: number): string => {
    // 0 tokens or no data at all: neutral gray. Any non-zero usage maps to a
    // green ramp (light -> dark) so the heatmap reads as a single hue gradient
    // instead of mixing in unrelated grays and blues.
    if (value === 0 || maxHeatmapValue === 0) return "var(--bg-tertiary)";
    const ratio = value / maxHeatmapValue;
    if (ratio >= 0.75) return "var(--accent-green)";
    if (ratio >= 0.5)
      return "color-mix(in srgb, var(--accent-green) 65%, var(--bg-tertiary))";
    if (ratio >= 0.25)
      return "color-mix(in srgb, var(--accent-green) 40%, var(--bg-tertiary))";
    return "color-mix(in srgb, var(--accent-green) 20%, var(--bg-tertiary))";
  };

  const formatTokensLocale = (value: number): string => formatTokens(value);

  // 状态值 → 国际化文案。未知状态原样返回，保证兼容新厂商的 finish_reason。
  const translateStatus = (status: string): string => {
    if (!status) return "-";
    const keyByStatus: Record<string, string> = {
      completed: "settings.usageStatusCompleted",
      error: "settings.usageStatusError",
      cancelled: "settings.usageStatusCancelled",
      incomplete: "settings.usageStatusIncomplete",
      failed: "settings.usageStatusFailed",
      tool_calls: "settings.usageStatusToolCalls",
      tool_use: "settings.usageStatusToolCalls",
      length: "settings.usageStatusLength",
      max_tokens: "settings.usageStatusMaxTokens",
      content_filter: "settings.usageStatusContentFilter",
      stop_sequence: "settings.usageStatusStopSequence",
    };
    const key = keyByStatus[status];
    if (!key) return status;
    return t(key, {
      defaultValue: status,
      values: { status },
    });
  };

  // Floating tooltip that follows the cursor. Position is applied directly to
  // the DOM node via a ref so high-frequency mousemove events do not trigger
  // React re-renders; only visibility and content use state.
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipContent, setTooltipContent] = useState<React.ReactNode>(null);

  const positionTooltip = (clientX: number, clientY: number) => {
    const node = tooltipRef.current;
    if (!node) return;
    const margin = 12;
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = clientX + margin;
    let top = clientY + margin;
    if (left + rect.width > vw - margin) {
      left = clientX - rect.width - margin;
    }
    if (top + rect.height > vh - margin) {
      top = clientY - rect.height - margin;
    }
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  };

  const showTooltip = (
    content: React.ReactNode,
    clientX: number,
    clientY: number,
  ) => {
    setTooltipContent(content);
    setTooltipVisible(true);
    // Position after the node becomes visible. requestAnimationFrame ensures
    // the ref'd node has non-zero dimensions for accurate boundary detection.
    requestAnimationFrame(() => positionTooltip(clientX, clientY));
  };

  const hideTooltip = () => {
    setTooltipVisible(false);
    setTooltipContent(null);
  };

  const renderHeatmapTooltip = (cell: {
    date: string;
    value: number;
    data: DailyUsageBreakdown | null;
  }): React.ReactNode => {
    if (!cell.data) {
      return (
        <div className="usage-floating-tooltip">
          <div className="usage-floating-tooltip-title">{cell.date}</div>
          <div className="usage-floating-tooltip-row">
            <span className="usage-floating-tooltip-label">
              {t("settings.usageTotalTokens", { defaultValue: "Total tokens" })}
            </span>
            <span className="usage-floating-tooltip-value">
              {formatTokensLocale(cell.value)}
            </span>
          </div>
        </div>
      );
    }
    const d = cell.data;
    const errorRate =
      d.totalRequests > 0
        ? `${((d.errorRequests / d.totalRequests) * 100).toFixed(1)}%`
        : "0%";
    return (
      <div className="usage-floating-tooltip">
        <div className="usage-floating-tooltip-title">{cell.date}</div>
        <div className="usage-floating-tooltip-row">
          <span className="usage-floating-tooltip-label">
            {t("settings.usageTotalTokens", { defaultValue: "Total tokens" })}
          </span>
          <span className="usage-floating-tooltip-value">
            {formatTokensLocale(d.totalTokens)}
          </span>
        </div>
        <div className="usage-floating-tooltip-row">
          <span className="usage-floating-tooltip-label">
            {t("settings.usageInputTokens", { defaultValue: "Input tokens" })}
          </span>
          <span className="usage-floating-tooltip-value">
            {formatTokensLocale(d.totalInputTokens)}
          </span>
        </div>
        <div className="usage-floating-tooltip-row">
          <span className="usage-floating-tooltip-label">
            {t("settings.usageOutputTokens", { defaultValue: "Output tokens" })}
          </span>
          <span className="usage-floating-tooltip-value">
            {formatTokensLocale(d.totalOutputTokens)}
          </span>
        </div>
        <div className="usage-floating-tooltip-row">
          <span className="usage-floating-tooltip-label">
            {t("settings.usageCacheCreation", { defaultValue: "Cache write" })}
          </span>
          <span className="usage-floating-tooltip-value">
            {formatTokensLocale(d.totalCacheCreationInputTokens)}
          </span>
        </div>
        <div className="usage-floating-tooltip-row">
          <span className="usage-floating-tooltip-label">
            {t("settings.usageCacheRead", { defaultValue: "Cache read" })}
          </span>
          <span className="usage-floating-tooltip-value">
            {formatTokensLocale(d.totalCacheReadInputTokens)}
          </span>
        </div>
        <div className="usage-floating-tooltip-divider" />
        <div className="usage-floating-tooltip-row">
          <span className="usage-floating-tooltip-label">
            {t("settings.usageTotalRequests", {
              defaultValue: "Total requests",
            })}
          </span>
          <span className="usage-floating-tooltip-value">
            {d.totalRequests.toLocaleString()}
          </span>
        </div>
        <div className="usage-floating-tooltip-row">
          <span className="usage-floating-tooltip-label">
            {t("settings.usageErrorRequests", {
              defaultValue: "Error requests",
            })}
          </span>
          <span className="usage-floating-tooltip-value">
            {d.errorRequests.toLocaleString()} ({errorRate})
          </span>
        </div>
      </div>
    );
  };

  const renderRecordTooltip = (record: UsageRecord): React.ReactNode => (
    <div className="usage-floating-tooltip">
      <div className="usage-floating-tooltip-title">
        {formatDateTime(record.createdAt)}
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColModel", { defaultValue: "Model" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {record.model || "-"}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColProfile", { defaultValue: "Profile" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {record.apiProfileName || "-"}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColInput", { defaultValue: "Input" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {formatTokensLocale(record.inputTokens)}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColOutput", { defaultValue: "Output" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {formatTokensLocale(record.outputTokens)}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColCacheWrite", { defaultValue: "Cache W" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {formatTokensLocale(record.cacheCreationInputTokens)}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColCacheRead", { defaultValue: "Cache R" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {formatTokensLocale(record.cacheReadInputTokens)}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColTotal", { defaultValue: "Total" })}
        </span>
        <span className="usage-floating-tooltip-value usage-floating-tooltip-total">
          {formatTokensLocale(record.totalTokens)}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageColStatus", { defaultValue: "Status" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {translateStatus(record.status)}
        </span>
      </div>
    </div>
  );

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.usageTitle", { defaultValue: "Usage statistics" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.usageSettingsInfo", {
              defaultValue:
                "Track token usage across all API calls, including input, output, and cache statistics.",
            })}
          </span>
        </div>
        <div className="api-settings-header-actions">
          <button
            className="icon-btn ghost"
            onClick={handleRefresh}
            type="button"
            disabled={isLoading}
            aria-label={t("settings.usageRefresh", {
              defaultValue: "Refresh usage data",
            })}
            title={t("settings.usageRefresh", {
              defaultValue: "Refresh usage data",
            })}
          >
            <RefreshCw
              size={15}
              strokeWidth={1.8}
              className={isLoading ? "spin" : ""}
            />
          </button>
          {onClose && (
            <button
              className="icon-btn ghost"
              onClick={onClose}
              type="button"
              aria-label={t("settings.usageClosePanel", {
                defaultValue: "Close usage statistics",
              })}
              title={t("settings.usageClosePanel", {
                defaultValue: "Close usage statistics",
              })}
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>

      <AutoDismissNotice
        message={error}
        tone="error"
        onDismiss={() => setError("")}
      />

      <AutoDismissNotice
        message={clearNotice}
        tone="success"
        onDismiss={() => setClearNotice("")}
      />

      <UsageDateFilter
        preset={datePreset}
        sinceDate={sinceDate}
        untilDate={untilDate}
        onPresetChange={handlePresetChange}
        onSinceDateChange={handleSinceDateChange}
        onUntilDateChange={handleUntilDateChange}
      />

      {summary && (
        <div className="usage-summary-cards">
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageCacheHitRate", {
                defaultValue: "Cache hit rate",
              })}
            </span>
            <span className="usage-summary-card-value">
              {summary.totalInputTokens > 0
                ? `${(
                    (summary.totalCacheReadInputTokens /
                      summary.totalInputTokens) *
                    100
                  ).toFixed(1)}%`
                : "0%"}
            </span>
          </div>
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageTotalTokens", { defaultValue: "Total tokens" })}
            </span>
            <span className="usage-summary-card-value">
              {formatTokensLocale(summary.totalTokens)}
            </span>
          </div>
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageInputTokens", { defaultValue: "Input tokens" })}
            </span>
            <span className="usage-summary-card-value">
              {formatTokensLocale(summary.totalInputTokens)}
            </span>
          </div>
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageOutputTokens", {
                defaultValue: "Output tokens",
              })}
            </span>
            <span className="usage-summary-card-value">
              {formatTokensLocale(summary.totalOutputTokens)}
            </span>
          </div>
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageCacheCreation", {
                defaultValue: "Cache write",
              })}
            </span>
            <span className="usage-summary-card-value">
              {formatTokensLocale(summary.totalCacheCreationInputTokens)}
            </span>
          </div>
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageCacheRead", { defaultValue: "Cache read" })}
            </span>
            <span className="usage-summary-card-value">
              {formatTokensLocale(summary.totalCacheReadInputTokens)}
            </span>
          </div>
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageTotalRequests", {
                defaultValue: "Total requests",
              })}
            </span>
            <span className="usage-summary-card-value">
              {summary.totalRequests.toLocaleString()}
            </span>
          </div>
          <div className="usage-summary-card">
            <span className="usage-summary-card-label">
              {t("settings.usageSuccessRate", { defaultValue: "Success rate" })}
            </span>
            <span className="usage-summary-card-value">
              {summary.totalRequests > 0
                ? `${(
                    (1 - summary.errorRequests / summary.totalRequests) *
                    100
                  ).toFixed(1)}%`
                : "100%"}
            </span>
            <span className="usage-summary-card-sub">
              {t("settings.usageErrorRequests", {
                defaultValue: "Error requests",
              })}
              : {summary.errorRequests.toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {(trendData.length > 0 || modelBreakdown.length > 0) && (
        <div className="usage-charts-grid">
          <div className="usage-chart-card">
            <div className="usage-chart-header">
              <strong>
                {t("settings.usageTrendTitle", {
                  defaultValue: "Daily trend",
                })}
              </strong>
            </div>
            <DailyTrendChart
              data={trendData}
              formatTokens={formatTokensLocale}
            />
          </div>
          <div className="usage-chart-card">
            <div className="usage-chart-header">
              <strong>
                {t("settings.usageDonutTitle", {
                  defaultValue: "Model share",
                })}
              </strong>
            </div>
            <ModelDonutChart
              data={modelBreakdown}
              formatTokens={formatTokensLocale}
            />
          </div>
        </div>
      )}

      {modelBreakdown.length > 0 && (
        <div className="usage-model-breakdown-section">
          <div className="usage-table-header">
            <strong>
              {t("settings.usageModelBreakdownTitle", {
                defaultValue: "Model usage",
              })}
            </strong>
            <span className="settings-item-description">
              {t("settings.usageModelBreakdownInfo", {
                defaultValue: "Token consumption grouped by model.",
              })}
            </span>
          </div>
          <div className="usage-table-wrapper">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>
                    {t("settings.usageColModel", { defaultValue: "Model" })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColRequests", {
                      defaultValue: "Requests",
                    })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColInput", { defaultValue: "Input" })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColOutput", { defaultValue: "Output" })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColCacheWrite", {
                      defaultValue: "Cache W",
                    })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColCacheRead", {
                      defaultValue: "Cache R",
                    })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColTotal", { defaultValue: "Total" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {modelBreakdown.map((item) => (
                  <tr key={item.model}>
                    <td className="usage-cell-model">{item.model || "-"}</td>
                    <td className="usage-cell-number">
                      {item.totalRequests.toLocaleString()}
                    </td>
                    <td className="usage-cell-number">
                      {formatTokens(item.totalInputTokens)}
                    </td>
                    <td className="usage-cell-number">
                      {formatTokens(item.totalOutputTokens)}
                    </td>
                    <td className="usage-cell-number">
                      {formatTokens(item.totalCacheCreationInputTokens)}
                    </td>
                    <td className="usage-cell-number">
                      {formatTokens(item.totalCacheReadInputTokens)}
                    </td>
                    <td className="usage-cell-number usage-cell-total">
                      {formatTokens(item.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="usage-heatmap-section">
        <div className="usage-heatmap-header">
          <strong>
            {t("settings.usageHeatmapTitle", {
              defaultValue: "Daily usage heatmap",
            })}
          </strong>
        </div>
        <div className="usage-heatmap-scroll">
          <div className="usage-heatmap-month-labels">
            {monthLabels.map((ml, i) => {
              const totalCols = heatmapColumns.length;
              const totalGaps = (totalCols - 1) * 2;
              return (
                <span
                  key={i}
                  className="usage-heatmap-month-label"
                  style={{
                    left: `calc((100% - ${totalGaps}px) * ${
                      ml.startCol / totalCols
                    } + ${ml.startCol * 2}px)`,
                    width: `calc((100% - ${totalGaps}px) * ${
                      ml.colSpan / totalCols
                    } + ${(ml.colSpan - 1) * 2}px)`,
                  }}
                >
                  {ml.label}
                </span>
              );
            })}
          </div>
          <div className="usage-heatmap-container">
            <div className="usage-heatmap-weekday-labels">
              {WEEKDAY_LABELS.map((label, i) => (
                <span
                  key={label}
                  className={`usage-heatmap-weekday-label ${
                    i % 2 === 0 ? "visible" : ""
                  }`}
                >
                  {label}
                </span>
              ))}
            </div>
            <div className="usage-heatmap-grid">
              {heatmapColumns.map((column, colIndex) => (
                <div key={colIndex} className="usage-heatmap-column">
                  {column.map((cell, rowIndex) =>
                    cell.date ? (
                      <div
                        key={`${colIndex}-${rowIndex}`}
                        className="usage-heatmap-cell"
                        style={{ backgroundColor: getHeatmapColor(cell.value) }}
                        onMouseEnter={(e) =>
                          showTooltip(
                            renderHeatmapTooltip(cell),
                            e.clientX,
                            e.clientY,
                          )
                        }
                        onMouseMove={(e) =>
                          positionTooltip(e.clientX, e.clientY)
                        }
                        onMouseLeave={hideTooltip}
                      />
                    ) : (
                      <div
                        key={`${colIndex}-${rowIndex}`}
                        className="usage-heatmap-cell empty"
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="usage-heatmap-legend">
          <span className="usage-heatmap-legend-label">
            {t("settings.usageLess", { defaultValue: "Less" })}
          </span>
          <div
            className="usage-heatmap-cell"
            style={{ backgroundColor: "var(--bg-tertiary)" }}
          />
          <div
            className="usage-heatmap-cell"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--accent-green) 20%, var(--bg-tertiary))",
            }}
          />
          <div
            className="usage-heatmap-cell"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--accent-green) 40%, var(--bg-tertiary))",
            }}
          />
          <div
            className="usage-heatmap-cell"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--accent-green) 65%, var(--bg-tertiary))",
            }}
          />
          <div
            className="usage-heatmap-cell"
            style={{ backgroundColor: "var(--accent-green)" }}
          />
          <span className="usage-heatmap-legend-label">
            {t("settings.usageMore", { defaultValue: "More" })}
          </span>
        </div>
      </div>

      <div className="usage-table-section">
        <div className="usage-clear-section">
          <div className="usage-table-header">
            <strong>
              {t("settings.usageClearTitle", {
                defaultValue: "Clear usage data",
              })}
            </strong>
            <span className="settings-item-description">
              {t("settings.usageClearInfo", {
                defaultValue:
                  "Delete usage records by date range to prevent unlimited growth.",
              })}
            </span>
          </div>
          <div className="usage-clear-bar">
            <input
              type="date"
              value={clearSinceDate}
              onChange={(e) => setClearSinceDate(e.target.value)}
              className="usage-date-input"
              aria-label={t("settings.usageSinceDate", {
                defaultValue: "Start date",
              })}
            />
            <span className="usage-date-separator">-</span>
            <input
              type="date"
              value={clearUntilDate}
              onChange={(e) => setClearUntilDate(e.target.value)}
              className="usage-date-input"
              aria-label={t("settings.usageUntilDate", {
                defaultValue: "End date",
              })}
            />
            <span className="usage-clear-hint">
              {t("settings.usageClearEmptyHint", {
                defaultValue: "Leave blank for all dates.",
              })}
            </span>
            <button
              className="usage-clear-btn"
              onClick={() => setPendingClear(true)}
              disabled={isClearing}
              type="button"
            >
              <Trash2 size={13} strokeWidth={1.8} />
              {t("settings.usageClearBtn", {
                defaultValue: "Delete records",
              })}
            </button>
          </div>
        </div>
        <div className="usage-table-header">
          <button
            type="button"
            className="usage-records-toggle"
            onClick={() => setRecordsOpen((v) => !v)}
            aria-expanded={recordsOpen}
            aria-label={t(
              recordsOpen
                ? "settings.usageHideRecords"
                : "settings.usageShowRecords",
              {
                defaultValue: recordsOpen
                  ? "Hide usage records"
                  : "Show usage records",
              },
            )}
          >
            <span className="usage-records-toggle-text">
              <strong>
                {t("settings.usageRecordsTitle", {
                  defaultValue: "Usage records",
                })}
              </strong>
              <span className="settings-item-description">
                {t("settings.usageRecordsInfo", {
                  defaultValue: "Detailed log of each API call.",
                })}
              </span>
            </span>
            <ChevronDown
              size={14}
              strokeWidth={1.8}
              className={`usage-records-chevron${recordsOpen ? " open" : ""}`}
            />
          </button>
        </div>
        {recordsOpen && (
          <div className="usage-table-wrapper">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>
                    {t("settings.usageColTime", { defaultValue: "Time" })}
                  </th>
                  <th>
                    {t("settings.usageColModel", { defaultValue: "Model" })}
                  </th>
                  <th>
                    {t("settings.usageColProfile", { defaultValue: "Profile" })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColInput", { defaultValue: "Input" })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColOutput", { defaultValue: "Output" })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColCacheWrite", {
                      defaultValue: "Cache W",
                    })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColCacheRead", {
                      defaultValue: "Cache R",
                    })}
                  </th>
                  <th className="usage-th-number">
                    {t("settings.usageColTotal", { defaultValue: "Total" })}
                  </th>
                  <th>
                    {t("settings.usageColStatus", { defaultValue: "Status" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={9} className="usage-table-loading">
                      {t("settings.usageLoading", {
                        defaultValue: "Loading...",
                      })}
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="usage-table-empty">
                      {t("settings.usageNoRecords", {
                        defaultValue: "No usage records found.",
                      })}
                    </td>
                  </tr>
                ) : (
                  records.map((record) => (
                    <tr
                      key={record.id}
                      onMouseEnter={(e) =>
                        showTooltip(
                          renderRecordTooltip(record),
                          e.clientX,
                          e.clientY,
                        )
                      }
                      onMouseMove={(e) => positionTooltip(e.clientX, e.clientY)}
                      onMouseLeave={hideTooltip}
                    >
                      <td className="usage-cell-time">
                        {formatDateTime(record.createdAt)}
                      </td>
                      <td className="usage-cell-model">
                        {record.model || "-"}
                      </td>
                      <td className="usage-cell-profile">
                        {record.apiProfileName || "-"}
                      </td>
                      <td className="usage-cell-number">
                        {formatTokens(record.inputTokens)}
                      </td>
                      <td className="usage-cell-number">
                        {formatTokens(record.outputTokens)}
                      </td>
                      <td className="usage-cell-number">
                        {formatTokens(record.cacheCreationInputTokens)}
                      </td>
                      <td className="usage-cell-number">
                        {formatTokens(record.cacheReadInputTokens)}
                      </td>
                      <td className="usage-cell-number usage-cell-total">
                        {formatTokens(record.totalTokens)}
                      </td>
                      <td className="usage-cell-status">
                        <span
                          className={`usage-status-badge ${
                            record.status === "error"
                              ? "error"
                              : record.status === "cancelled" ||
                                  record.status === "incomplete" ||
                                  record.status === "failed"
                                ? "warning"
                                : "success"
                          }`}
                          title={record.status || undefined}
                        >
                          {translateStatus(record.status)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {recordsOpen && total > PAGE_SIZE && (
          <div className="usage-pagination">
            <button
              className="usage-pagination-btn"
              onClick={() => void loadRecords(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || isLoading}
              type="button"
              aria-label={t("settings.usagePrevPage", {
                defaultValue: "Previous page",
              })}
            >
              <ChevronLeft size={16} strokeWidth={1.8} />
            </button>
            <span className="usage-pagination-info">
              {t("settings.usagePageInfo", {
                defaultValue: "Page {{current}} of {{total}}",
                values: { current: currentPage, total: totalPages },
              })}
            </span>
            <button
              className="usage-pagination-btn"
              onClick={() =>
                void loadRecords(
                  Math.min((totalPages - 1) * PAGE_SIZE, offset + PAGE_SIZE),
                )
              }
              disabled={currentPage >= totalPages || isLoading}
              type="button"
              aria-label={t("settings.usageNextPage", {
                defaultValue: "Next page",
              })}
            >
              <ChevronRight size={16} strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingClear}
        title={t("settings.usageClearConfirmTitle", {
          defaultValue: "Delete usage records?",
        })}
        message={clearConfirmMessage}
        confirmLabel={t("settings.usageClearBtn", {
          defaultValue: "Delete records",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void handleClearRecords()}
        onCancel={() => setPendingClear(false)}
      />

      {createPortal(
        <div
          ref={tooltipRef}
          className={`usage-floating-tooltip-root${
            tooltipVisible ? " visible" : ""
          }`}
          role="tooltip"
        >
          {tooltipContent}
        </div>,
        document.body,
      )}
    </div>
  );
}
