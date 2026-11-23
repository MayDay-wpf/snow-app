import {
  applyTypographyToDocument,
  normalizeThemeSettings,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  writeThemeCache,
} from "../components/sidebar/themeSettings/themeSettingsUtils";
import type { ThemeSettings } from "../components/sidebar/themeSettings/types";

const clampFontSize = (value: number): number =>
  Math.min(Math.max(value, UI_FONT_SIZE_MIN), UI_FONT_SIZE_MAX);

// 快捷键连续触发时串行化读-改-写，避免并发保存导致调整丢失。
let uiFontSizeQueue: Promise<void> = Promise.resolve();

const enqueueUiFontSizeTask = (task: () => Promise<void>): void => {
  uiFontSizeQueue = uiFontSizeQueue.then(task).catch(() => undefined);
};

const applyUiFontSize = async (
  resolveNext: (current: number) => number,
): Promise<void> => {
  const raw = await window.snow.getThemeSettings();
  const settings = normalizeThemeSettings(raw);
  const next = resolveNext(settings.typography.fontSize);
  if (next === settings.typography.fontSize) {
    return;
  }
  const nextSettings: ThemeSettings = {
    ...settings,
    typography: { ...settings.typography, fontSize: next },
  };
  applyTypographyToDocument(nextSettings.typography);
  writeThemeCache(nextSettings);
  // 先落库再广播，确保 theme:changed 监听方（useTheme 等）读到的是新值。
  await window.snow.setThemeSettings(nextSettings);
  window.dispatchEvent(new CustomEvent("theme:changed"));
};

/** 按步进调整界面字号（正为放大、负为缩小），并持久化。 */
export const adjustUiFontSize = (delta: number): void => {
  if (!Number.isFinite(delta) || delta === 0) {
    return;
  }
  enqueueUiFontSizeTask(() =>
    applyUiFontSize((current) => clampFontSize(current + delta)),
  );
};

/** 重置界面字号到默认值（13px = 100%），并持久化。 */
export const resetUiFontSize = (): void => {
  enqueueUiFontSizeTask(() => applyUiFontSize(() => UI_FONT_SIZE_DEFAULT));
};

/** 监听窗口 DPI 变化并刷新缩放因子。 */
export const initDpiChangeListener = (): (() => void) => {
  if (typeof window.snow?.onWindowDisplayScaleChanged !== "function") {
    return () => {};
  }

  const dispose = window.snow.onWindowDisplayScaleChanged((info) => {
    if (typeof window.snow?.setUiZoomFactor === "function") {
      const scaleFactor = info?.scaleFactor ?? window.devicePixelRatio ?? 1;
      window.snow.setUiZoomFactor(scaleFactor);
    }
  });

  return dispose;
};
