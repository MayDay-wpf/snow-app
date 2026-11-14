import type { UsageProfileInfo } from "../../../../preload";

export type UsageDatePreset =
  | "today"
  | "yesterday"
  | "last7days"
  | "last30days"
  | "thisMonth"
  | "lastMonth"
  | "all"
  | "custom";

/** 配置筛选控件：仅用量统计页需要，系统日志等页面不传。 */
export type UsageProfileFilterControl = {
  profiles: UsageProfileInfo[];
  value: string;
  onChange: (value: string) => void;
};

export type UsageDateFilterProps = {
  preset: UsageDatePreset;
  sinceDate: string;
  untilDate: string;
  profile?: UsageProfileFilterControl;
  onPresetChange: (preset: UsageDatePreset) => void;
  onSinceDateChange: (value: string) => void;
  onUntilDateChange: (value: string) => void;
};
