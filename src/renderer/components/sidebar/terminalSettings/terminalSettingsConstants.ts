import type { TerminalSettings } from "../../../../preload";

export const TERMINAL_SETTING_NAME = "Terminal settings";
export const TERMINAL_SETTING_CODE = "terminal_settings";

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  shellPath: "",
  fontFamily: "",
  fontSize: 14,
  fontWeight: "normal",
  lineHeight: 1.2,
  // GPU 渲染默认关闭：WebGL 上下文按需创建，遇远程桌面/驱动禁用等
  // 环境问题可一键关闭回到稳定的 DOM 渲染器。
  gpuRendering: false,
};

export const FONT_WEIGHT_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "bold", label: "Bold" },
  { value: "300", label: "Light" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
];
