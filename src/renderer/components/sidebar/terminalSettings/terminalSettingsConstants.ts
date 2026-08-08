import type { TerminalSettings } from "../../../../preload";

export const TERMINAL_SETTING_NAME = "Terminal settings";
export const TERMINAL_SETTING_CODE = "terminal_settings";

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  shellPath: "",
  fontFamily: "",
  fontSize: 14,
  fontWeight: "normal",
  lineHeight: 1.2,
};

export const FONT_WEIGHT_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "bold", label: "Bold" },
  { value: "300", label: "Light" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
];
