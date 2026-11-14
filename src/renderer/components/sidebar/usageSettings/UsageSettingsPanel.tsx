import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { ModelBrandIcon } from "../../common/ModelBrandIcon";
import { DailyTrendChart } from "./DailyTrendChart";
import { ModelDonutChart } from "./ModelDonutChart";
import { Sparkline } from "./Sparkline";
import { heatColor, UsageHourGrid } from "./UsageHourGrid";
import { translateRequestMethod } from "./requestMethod";
import { UsageDateFilter } from "./UsageDateFilter";
import { getActiveLocale, useI18n } from "../../../i18n";
import {
  usePublishSettingsPageActions,
  type SettingsPageAction,
} from "../../TopBar/settingsPageActionsStore";
import type {
  DailyUsageBreakdown,
  HourlyUsageCell,
  ModelUsageBreakdown,
  UsageActivity,
  UsageProfileInfo,
  UsageRecord,
  UsageRecordPage,
  UsageSummary,
} from "../../../../preload";
import type { UsageDatePreset } from "./types";

const PAGE_SIZE = 20;
const ALL_PROFILES = "";
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
  return date.toLocaleString(getActiveLocale());
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

type HeatmapCell = {
  date: string;
  value: number;
  data: DailyUsageBreakdown | null;
};

export function UsageSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [modelBreakdown, setModelBreakdown] = useState<ModelUsageBreakdown[]>(
    [],
  );
  // 配置（档案）筛选：空字符串表示全部配置。
  const [profileFilter, setProfileFilter] = useState<string>(ALL_PROFILES);
  const [profiles, setProfiles] = useState<UsageProfileInfo[]>([]);
  const [dailyData, setDailyData] = useState<DailyUsageBreakdown[]>([]);
  // 趋势图数据：按当前筛选区间请求，与年度热力图（整年）区分开。
  const [trendData, setTrendData] = useState<DailyUsageBreakdown[]>([]);
  // 年度活跃度：统计行 + 按小时网格
  const [activity, setActivity] = useState<UsageActivity | null>(null);
  const [heatmapMode, setHeatmapMode] = useState<"day" | "hour">("day");
  // 悬停某天时按需拉取的模型分布缓存
  const dayModelCacheRef = useRef(new Map<string, ModelUsageBreakdown[]>());
  const hoveredDateRef = useRef("");
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
          profileFilter,
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
    [profileFilter, t],
  );

  const loadProfileNames = useCallback(async () => {
    try {
      const list = await window.snow.listUsageProfiles();
      setProfiles(list ?? []);
    } catch {
      setProfiles([]);
    }
  }, []);

  const loadSummaryAndHeatmap = useCallback(async () => {
    try {
      const heatmapSince = formatDateForInput(
        new Date(now.getTime() - ONE_YEAR_MS),
      );
      const heatmapUntil = formatDateForInput(now);
      const [
        summaryResult,
        dailyResult,
        modelResult,
        trendResult,
        activityResult,
      ] = await Promise.all([
        window.snow.getUsageSummary(
          sinceDateTime,
          untilDateTime,
          profileFilter,
        ),
        window.snow.getUsageDailyBreakdown(
          heatmapSince,
          heatmapUntil,
          profileFilter,
        ),
        window.snow.getUsageModelBreakdown(
          sinceDateTime,
          untilDateTime,
          profileFilter,
        ),
        window.snow.getUsageDailyBreakdown(
          sinceDateTime,
          untilDateTime,
          profileFilter,
        ),
        window.snow.getUsageActivity(heatmapSince, heatmapUntil, profileFilter),
      ]);
      dayModelCacheRef.current.clear();
      setSummary(summaryResult);
      setDailyData(dailyResult ?? []);
      setModelBreakdown(modelResult ?? []);
      setTrendData(trendResult ?? []);
      setActivity(activityResult ?? null);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.usageLoadError", {
              defaultValue: "Failed to load usage statistics.",
            }),
      );
    }
  }, [sinceDateTime, untilDateTime, profileFilter, now, t]);

  const handleRefresh = useCallback(() => {
    void loadRecords(offset);
    void loadSummaryAndHeatmap();
    void loadProfileNames();
  }, [loadRecords, loadSummaryAndHeatmap, loadProfileNames, offset]);

  usePublishSettingsPageActions(
    "usage-settings",
    useMemo<SettingsPageAction[]>(
      () => [
        {
          id: "refresh",
          label: t("settings.usageRefresh", {
            defaultValue: "Refresh usage data",
          }),
          icon: RefreshCw,
          disabled: isLoading,
          spinning: isLoading,
          onClick: handleRefresh,
        },
      ],
      [t, isLoading, handleRefresh],
    ),
  );

  const handleProfileFilterChange = useCallback((value: string) => {
    setProfileFilter(value);
    setOffset(0);
  }, []);

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
      await Promise.all([
        loadRecords(0),
        loadSummaryAndHeatmap(),
        loadProfileNames(),
      ]);
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
    loadProfileNames,
    t,
  ]);

  useEffect(() => {
    void loadRecords(0);
  }, [loadRecords]);

  useEffect(() => {
    void loadSummaryAndHeatmap();
  }, [loadSummaryAndHeatmap]);

  useEffect(() => {
    void loadProfileNames();
  }, [loadProfileNames]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // 趋势图按筛选区间逐日补零：后端只返回有记录的日期，
  // 缺失日期填 0，避免时间轴跳过无数据的天。"all" 模式无边界时用首尾日期。
  const filledTrendData = useMemo<DailyUsageBreakdown[]>(() => {
    if (trendData.length === 0) return trendData;
    const startStr = sinceDate || trendData[0].date;
    const endStr = untilDate || trendData[trendData.length - 1].date;
    const start = new Date(`${startStr}T00:00:00`);
    const end = new Date(`${endStr}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return trendData;
    }
    const dayCount =
      Math.floor((end.getTime() - start.getTime()) / ONE_DAY_MS) + 1;
    // 超过 10 年视为异常区间，直接返回原数据。
    if (dayCount <= 0 || dayCount > 3650) return trendData;
    const map = new Map<string, DailyUsageBreakdown>();
    for (const item of trendData) map.set(item.date, item);
    const filled: DailyUsageBreakdown[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const dateStr = formatDateForInput(cursor);
      filled.push(
        map.get(dateStr) ?? {
          date: dateStr,
          totalRequests: 0,
          errorRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationInputTokens: 0,
          totalCacheReadInputTokens: 0,
          totalTokens: 0,
        },
      );
      cursor.setDate(cursor.getDate() + 1);
    }
    return filled;
  }, [trendData, sinceDate, untilDate]);

  // 指标卡：数值 + 副行 + 区间内逐日迷你趋势
  const kpiCards = useMemo(() => {
    if (!summary) return [];
    const days = Math.max(1, filledTrendData.length);
    const perDay = (value: number) =>
      t("settings.usagePerDay", {
        defaultValue: "≈ {{value}} a day",
        values: { value: formatTokens(Math.round(value / days)) },
      });
    const pct = (num: number, den: number) =>
      den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "0%";
    const series = (pick: (d: DailyUsageBreakdown) => number) =>
      filledTrendData.map(pick);
    const successRate =
      summary.totalRequests > 0
        ? `${((1 - summary.errorRequests / summary.totalRequests) * 100).toFixed(1)}%`
        : "100%";
    return [
      {
        id: "total",
        label: t("settings.usageTotalTokens", { defaultValue: "Total tokens" }),
        value: formatTokens(summary.totalTokens),
        sub: perDay(summary.totalTokens),
        series: series((d) => d.totalTokens),
        color: "var(--accent-green)",
      },
      {
        id: "input",
        label: t("settings.usageInputTokens", { defaultValue: "Input tokens" }),
        value: formatTokens(summary.totalInputTokens),
        sub: `${t("settings.usageCacheCreation", { defaultValue: "Cache write" })} ${formatTokens(summary.totalCacheCreationInputTokens)}`,
        series: series((d) => d.totalInputTokens),
        color: "var(--accent-blue)",
      },
      {
        id: "output",
        label: t("settings.usageOutputTokens", {
          defaultValue: "Output tokens",
        }),
        value: formatTokens(summary.totalOutputTokens),
        sub: perDay(summary.totalOutputTokens),
        series: series((d) => d.totalOutputTokens),
        color: "var(--accent-orange, #d97757)",
      },
      {
        id: "cache",
        label: t("settings.usageCacheHitRate", {
          defaultValue: "Cache hit rate",
        }),
        value: pct(summary.totalCacheReadInputTokens, summary.totalInputTokens),
        sub: t("settings.usageCacheReadSub", {
          defaultValue: "{{value}} read from cache",
          values: { value: formatTokens(summary.totalCacheReadInputTokens) },
        }),
        series: series((d) =>
          d.totalInputTokens > 0
            ? d.totalCacheReadInputTokens / d.totalInputTokens
            : 0,
        ),
        color: "#14b8a6",
      },
      {
        id: "requests",
        label: t("settings.usageTotalRequests", {
          defaultValue: "Total requests",
        }),
        value: summary.totalRequests.toLocaleString(),
        sub: t("settings.usageSuccessSub", {
          defaultValue: "{{rate}} success · {{errors}} errors",
          values: {
            rate: successRate,
            errors: summary.errorRequests.toLocaleString(),
          },
        }),
        series: series((d) => d.totalRequests),
        color: "var(--text-muted)",
      },
    ];
  }, [summary, filledTrendData, t]);

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

  // 热力图下方的年度活跃度统计（Rust 端计算）
  const activityFacts = useMemo(() => {
    if (!activity) return [];
    const formatDay = (value: string) => {
      const date = new Date(`${value}T00:00:00`);
      return Number.isNaN(date.getTime())
        ? value
        : date.toLocaleDateString(getActiveLocale(), {
            month: "short",
            day: "numeric",
            weekday: "short",
          });
    };
    return [
      {
        id: "active",
        label: t("settings.usageActiveDays", { defaultValue: "Active days" }),
        value: `${activity.activeDays} / ${heatmapCells.length}`,
        sub: t("settings.usageActiveDaysSub", {
          defaultValue: "Days with any tokens",
        }),
      },
      {
        id: "average",
        label: t("settings.usageActiveDayAvg", {
          defaultValue: "An active day",
        }),
        value: formatTokens(activity.averageActiveDayTokens),
        sub: t("settings.usageActiveDayAvgSub", {
          defaultValue: "Tokens on average",
        }),
      },
      {
        id: "busiest",
        label: t("settings.usageBusiestDay", { defaultValue: "Busiest day" }),
        value: activity.busiestDay
          ? formatTokens(activity.busiestDayTokens)
          : "-",
        sub: activity.busiestDay ? formatDay(activity.busiestDay) : "",
      },
      {
        id: "streak",
        label: t("settings.usageStreak", { defaultValue: "Streak" }),
        value: t("settings.usageDays", {
          defaultValue: "{{count}} days",
          values: { count: String(activity.currentStreak) },
        }),
        sub: t("settings.usageLongestStreak", {
          defaultValue: "Longest {{count}} days",
          values: { count: String(activity.longestStreak) },
        }),
      },
    ];
  }, [activity, heatmapCells.length, t]);

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

  const getHeatmapColor = (value: number): string =>
    heatColor(value, maxHeatmapValue);

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

  const renderHeatmapTooltip = (
    cell: HeatmapCell,
    models: ModelUsageBreakdown[] | null,
  ): React.ReactNode => {
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
        <div className="usage-floating-tooltip-divider" />
        {models === null ? (
          <div className="usage-floating-tooltip-hint">
            {t("settings.usageLoading", { defaultValue: "Loading..." })}
          </div>
        ) : (
          models.slice(0, 3).map((m) => (
            <div
              key={`${m.model}-${m.requestMethod}`}
              className="usage-floating-tooltip-row"
            >
              <span className="usage-floating-tooltip-label usage-floating-tooltip-model">
                {m.model || "-"}
              </span>
              <span className="usage-floating-tooltip-value">
                {formatTokensLocale(m.totalTokens)}
              </span>
            </div>
          ))
        )}
        <div className="usage-floating-tooltip-hint">
          {t("settings.usageHeatmapClickHint", {
            defaultValue: "Click to look at this day alone",
          })}
        </div>
      </div>
    );
  };

  // 悬停先显示当天汇总，模型分布按需拉取后再刷新
  const handleHeatmapEnter = (cell: HeatmapCell, x: number, y: number) => {
    hoveredDateRef.current = cell.date;
    if (!cell.data) {
      showTooltip(renderHeatmapTooltip(cell, []), x, y);
      return;
    }
    const cached = dayModelCacheRef.current.get(cell.date);
    showTooltip(renderHeatmapTooltip(cell, cached ?? null), x, y);
    if (cached) return;
    const profile = profileFilter;
    void window.snow
      .getUsageModelBreakdown(
        `${cell.date} 00:00:00`,
        `${cell.date} 23:59:59`,
        profile,
      )
      .then((rows) => {
        const list = rows ?? [];
        dayModelCacheRef.current.set(cell.date, list);
        if (hoveredDateRef.current === cell.date) {
          setTooltipContent(renderHeatmapTooltip(cell, list));
        }
      })
      .catch(() => {
        if (hoveredDateRef.current === cell.date) {
          setTooltipContent(renderHeatmapTooltip(cell, []));
        }
      });
  };

  const handleHeatmapLeave = () => {
    hoveredDateRef.current = "";
    hideTooltip();
  };

  // 点击某天：筛选区间收窄到当天，再次点击恢复近 7 天
  const handleHeatmapClick = (cell: HeatmapCell) => {
    if (!cell.date) return;
    if (sinceDate === cell.date && untilDate === cell.date) {
      handlePresetChange("last7days");
      return;
    }
    setSinceDate(cell.date);
    setUntilDate(cell.date);
    setDatePreset("custom");
  };

  const renderHourTooltip = (cell: HourlyUsageCell): React.ReactNode => (
    <div className="usage-floating-tooltip">
      <div className="usage-floating-tooltip-title">
        {`${WEEKDAY_LABELS[cell.weekday]} ${String(cell.hour).padStart(2, "0")}:00 - ${String(cell.hour).padStart(2, "0")}:59`}
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageTotalTokens", { defaultValue: "Total tokens" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {formatTokensLocale(cell.totalTokens)}
        </span>
      </div>
      <div className="usage-floating-tooltip-row">
        <span className="usage-floating-tooltip-label">
          {t("settings.usageTotalRequests", { defaultValue: "Total requests" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {cell.totalRequests.toLocaleString()}
        </span>
      </div>
    </div>
  );

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
          {t("settings.usageColType", { defaultValue: "Type" })}
        </span>
        <span className="usage-floating-tooltip-value">
          {translateRequestMethod(record.requestMethod, t)}
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
        profile={{
          profiles,
          value: profileFilter,
          onChange: handleProfileFilterChange,
        }}
        onPresetChange={handlePresetChange}
        onSinceDateChange={handleSinceDateChange}
        onUntilDateChange={handleUntilDateChange}
      />

      {summary && (
        <div className="usage-summary-cards">
          {kpiCards.map((card) => (
            <div key={card.id} className="usage-summary-card">
              <span className="usage-summary-card-label">{card.label}</span>
              <span className="usage-summary-card-value">{card.value}</span>
              <span className="usage-summary-card-sub">{card.sub}</span>
              <Sparkline values={card.series} color={card.color} />
            </div>
          ))}
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
              data={filledTrendData}
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

      <div className="usage-heatmap-section">
        <div className="usage-heatmap-header">
          <div className="usage-heatmap-title">
            <strong>
              {t("settings.usageHeatmapTitle", {
                defaultValue: "Daily usage heatmap",
              })}
            </strong>
            <span className="settings-item-description">
              {heatmapMode === "day"
                ? t("settings.usageHeatmapDayInfo", {
                    defaultValue:
                      "Tokens per day · hover a day for its models, click it to look at it alone",
                  })
                : t("settings.usageHeatmapHourInfo", {
                    defaultValue:
                      "Tokens by weekday and hour over the last year",
                  })}
            </span>
          </div>
          <div className="segmented-tabs" role="tablist">
            {(["day", "hour"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={heatmapMode === mode}
                className={`segmented-tab${heatmapMode === mode ? " active" : ""}`}
                onClick={() => setHeatmapMode(mode)}
              >
                <span>
                  {mode === "day"
                    ? t("settings.usageByDay", { defaultValue: "By day" })
                    : t("settings.usageByHour", { defaultValue: "By hour" })}
                </span>
              </button>
            ))}
          </div>
        </div>
        {heatmapMode === "hour" ? (
          <UsageHourGrid
            cells={activity?.hourly ?? []}
            weekdayLabels={WEEKDAY_LABELS}
            onHover={(cell, x, y) => showTooltip(renderHourTooltip(cell), x, y)}
            onMove={positionTooltip}
            onLeave={hideTooltip}
          />
        ) : (
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
                          className={`usage-heatmap-cell clickable${
                            sinceDate === cell.date && untilDate === cell.date
                              ? " selected"
                              : ""
                          }`}
                          style={{
                            backgroundColor: getHeatmapColor(cell.value),
                          }}
                          onMouseEnter={(e) =>
                            handleHeatmapEnter(cell, e.clientX, e.clientY)
                          }
                          onMouseMove={(e) =>
                            positionTooltip(e.clientX, e.clientY)
                          }
                          onMouseLeave={handleHeatmapLeave}
                          onClick={() => handleHeatmapClick(cell)}
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
        )}
        <div className="usage-heatmap-legend">
          {activity?.firstDay ? (
            <span className="usage-heatmap-since">
              {t("settings.usageRecordedSince", {
                defaultValue: "Recorded since {{date}}",
                values: { date: activity.firstDay },
              })}
            </span>
          ) : null}
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
        {activity && (
          <div className="usage-activity-facts">
            {activityFacts.map((fact) => (
              <div key={fact.id} className="usage-activity-fact">
                <span className="usage-activity-fact-label">{fact.label}</span>
                <span className="usage-activity-fact-value">{fact.value}</span>
                <span className="usage-activity-fact-sub">{fact.sub}</span>
              </div>
            ))}
          </div>
        )}
      </div>

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
                  <th>
                    {t("settings.usageColType", { defaultValue: "Type" })}
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
                  <tr key={`${item.model}-${item.requestMethod}`}>
                    <td className="usage-cell-model">
                      <span className="usage-cell-with-icon">
                        <ModelBrandIcon model={item.model} size={14} />
                        <span className="usage-cell-label">
                          {item.model || "-"}
                        </span>
                      </span>
                    </td>
                    <td className="usage-cell-method">
                      {translateRequestMethod(item.requestMethod, t)}
                    </td>
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
                    {t("settings.usageColType", { defaultValue: "Type" })}
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
                    <td colSpan={10} className="usage-table-loading">
                      {t("settings.usageLoading", {
                        defaultValue: "Loading...",
                      })}
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="usage-table-empty">
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
                        <span className="usage-cell-with-icon">
                          <ModelBrandIcon model={record.model} size={14} />
                          <span className="usage-cell-label">
                            {record.model || "-"}
                          </span>
                        </span>
                      </td>
                      <td className="usage-cell-method">
                        {translateRequestMethod(record.requestMethod, t)}
                      </td>
                      <td className="usage-cell-profile">
                        <span className="usage-cell-with-icon">
                          <Layers
                            size={13}
                            strokeWidth={1.8}
                            className="usage-cell-icon-muted"
                          />
                          <span className="usage-cell-label">
                            {record.apiProfileName || "-"}
                          </span>
                        </span>
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
