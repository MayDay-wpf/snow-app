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
};

export type TerminalSettingsValue = TerminalSettings;

export type DetectedTerminalOption = DetectedTerminal;
