import type { TerminalSettings } from "../../../../preload";
import { DEFAULT_TERMINAL_SETTINGS } from "./terminalSettingsConstants";
import type { TerminalSettingsForm } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const toNumber = (value: unknown, fallback: number): number => {
  const num =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(num) ? num : fallback;
};

export const normalizeTerminalSettings = (value: unknown): TerminalSettings => {
  const source = isRecord(value) ? value : {};

  return {
    shellPath: toText(source.shellPath).trim(),
    fontFamily: toText(source.fontFamily).trim(),
    fontSize: toNumber(source.fontSize, DEFAULT_TERMINAL_SETTINGS.fontSize),
    fontWeight:
      toText(source.fontWeight, DEFAULT_TERMINAL_SETTINGS.fontWeight).trim() ||
      DEFAULT_TERMINAL_SETTINGS.fontWeight,
    lineHeight: toNumber(
      source.lineHeight,
      DEFAULT_TERMINAL_SETTINGS.lineHeight
    ),
  };
};

export const readTerminalSettingsJson = (
  value: string | null
): TerminalSettings => {
  if (!value) {
    return DEFAULT_TERMINAL_SETTINGS;
  }

  try {
    return normalizeTerminalSettings(JSON.parse(value) as unknown);
  } catch {
    return DEFAULT_TERMINAL_SETTINGS;
  }
};

export const toTerminalForm = (
  settings: TerminalSettings
): TerminalSettingsForm => ({
  shellPath: settings.shellPath,
  fontFamily: settings.fontFamily,
  fontSize: String(settings.fontSize),
  fontWeight: settings.fontWeight,
  lineHeight: String(settings.lineHeight),
});

export const toTerminalSettings = (
  form: TerminalSettingsForm
): TerminalSettings => ({
  shellPath: form.shellPath.trim(),
  fontFamily: form.fontFamily.trim(),
  fontSize: toNumber(form.fontSize, DEFAULT_TERMINAL_SETTINGS.fontSize),
  fontWeight: form.fontWeight.trim() || DEFAULT_TERMINAL_SETTINGS.fontWeight,
  lineHeight: toNumber(form.lineHeight, DEFAULT_TERMINAL_SETTINGS.lineHeight),
});
