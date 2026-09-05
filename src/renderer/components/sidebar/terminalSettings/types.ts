import type { TerminalSettings, DetectedTerminal } from "../../../../preload";

export type TerminalSettingsPanelProps = {
  onClose?: () => void;
};

export type TerminalSettingsForm = {
  shellPath: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  /** GPU 渲染开关是即时生效控件，保持 boolean 而非字符串。 */
  gpuRendering: boolean;
};

export type TerminalSettingsValue = TerminalSettings;

export type DetectedTerminalOption = DetectedTerminal;
