import type {
  ColorGroup,
  ThemePalette,
  ThemeSettings,
  ThemeMode,
  ThemeStreamCursor,
} from "./types";
import {
  DEFAULT_THEME_PRESET_ID,
  getPresetById,
  resolvePresetId,
} from "./themePresets";
import { STREAM_CURSOR_LUCIDE_ICONS } from "./streamCursorIcons";
import { themeBgUrl } from "../../../utils/themeBgUrl";

export const THEME_SETTING_NAME = "Theme settings";
export const THEME_SETTING_CODE = "theme_settings";

/**
 * 背景图不透明度上限。超过此值后前景内容可读性极差，因此滑块与归一化
 * 都以此值为上限。调整此值需同步：normalizeThemeBackground、
 * applyThemeCacheToDocument、ThemeBackgroundSection 滑块 max、
 * ThemeSettingsPanel 预览 useEffect。
 */
export const MAX_BACKGROUND_OPACITY = 0.6;

export const PALETTE_ROLE_TO_CSS_VAR: Record<keyof ThemePalette, string> = {
  bgPrimary: "--bg-primary",
  bgSecondary: "--bg-secondary",
  bgTertiary: "--bg-tertiary",
  bgHover: "--bg-hover",
  bgActive: "--bg-active",
  chromeBg: "--chrome-bg",
  appBg: "--app-bg",
  borderColor: "--border-color",
  borderLight: "--border-light",
  borderSubtle: "--border-subtle",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textTertiary: "--text-tertiary",
  textMuted: "--text-muted",
  accentGreen: "--accent-green",
  accentGreenBg: "--accent-green-bg",
  accentGreenText: "--accent-green-text",
  accentRed: "--accent-red",
  accentRedBg: "--accent-red-bg",
  accentRedText: "--accent-red-text",
  accentBlue: "--accent-blue",
  accentBlueBg: "--accent-blue-bg",
  accentBlueText: "--accent-blue-text",
  accentColor: "--accent-color",
  onSolid: "--on-solid",
  selectionBg: "--selection-bg",
  focusRing: "--focus-ring",
};

export const COLOR_GROUPS: ColorGroup[] = [
  {
    titleKey: "settings.themeGroupBackground",
    defaultTitle: "Background",
    roles: [
      {
        role: "bgPrimary",
        labelKey: "settings.themeColorBgPrimary",
        defaultLabel: "Primary background",
      },
      {
        role: "bgSecondary",
        labelKey: "settings.themeColorBgSecondary",
        defaultLabel: "Secondary background",
      },
      {
        role: "bgTertiary",
        labelKey: "settings.themeColorBgTertiary",
        defaultLabel: "Tertiary background",
      },
      {
        role: "bgHover",
        labelKey: "settings.themeColorBgHover",
        defaultLabel: "Hover background",
      },
      {
        role: "bgActive",
        labelKey: "settings.themeColorBgActive",
        defaultLabel: "Active background",
      },
      {
        role: "chromeBg",
        labelKey: "settings.themeColorChromeBg",
        defaultLabel: "Chrome background",
      },
      {
        role: "appBg",
        labelKey: "settings.themeColorAppBg",
        defaultLabel: "App background",
      },
    ],
  },
  {
    titleKey: "settings.themeGroupText",
    defaultTitle: "Text",
    roles: [
      {
        role: "textPrimary",
        labelKey: "settings.themeColorTextPrimary",
        defaultLabel: "Primary text",
      },
      {
        role: "textSecondary",
        labelKey: "settings.themeColorTextSecondary",
        defaultLabel: "Secondary text",
      },
      {
        role: "textTertiary",
        labelKey: "settings.themeColorTextTertiary",
        defaultLabel: "Tertiary text",
      },
      {
        role: "textMuted",
        labelKey: "settings.themeColorTextMuted",
        defaultLabel: "Muted text",
      },
      {
        role: "onSolid",
        labelKey: "settings.themeColorOnSolid",
        defaultLabel: "On solid",
      },
    ],
  },
  {
    titleKey: "settings.themeGroupBorder",
    defaultTitle: "Border",
    roles: [
      {
        role: "borderColor",
        labelKey: "settings.themeColorBorder",
        defaultLabel: "Border",
      },
      {
        role: "borderLight",
        labelKey: "settings.themeColorBorderLight",
        defaultLabel: "Light border",
      },
      {
        role: "borderSubtle",
        labelKey: "settings.themeColorBorderSubtle",
        defaultLabel: "Subtle border",
      },
    ],
  },
  {
    titleKey: "settings.themeGroupAccent",
    defaultTitle: "Accent colors",
    roles: [
      {
        role: "accentGreen",
        labelKey: "settings.themeColorAccentGreen",
        defaultLabel: "Green",
      },
      {
        role: "accentGreenBg",
        labelKey: "settings.themeColorAccentGreenBg",
        defaultLabel: "Green background",
      },
      {
        role: "accentGreenText",
        labelKey: "settings.themeColorAccentGreenText",
        defaultLabel: "Green text",
      },
      {
        role: "accentRed",
        labelKey: "settings.themeColorAccentRed",
        defaultLabel: "Red",
      },
      {
        role: "accentRedBg",
        labelKey: "settings.themeColorAccentRedBg",
        defaultLabel: "Red background",
      },
      {
        role: "accentRedText",
        labelKey: "settings.themeColorAccentRedText",
        defaultLabel: "Red text",
      },
      {
        role: "accentBlue",
        labelKey: "settings.themeColorAccentBlue",
        defaultLabel: "Blue",
      },
      {
        role: "accentBlueBg",
        labelKey: "settings.themeColorAccentBlueBg",
        defaultLabel: "Blue background",
      },
      {
        role: "accentBlueText",
        labelKey: "settings.themeColorAccentBlueText",
        defaultLabel: "Blue text",
      },
      {
        role: "accentColor",
        labelKey: "settings.themeColorAccentColor",
        defaultLabel: "Accent color",
      },
    ],
  },
  {
    titleKey: "settings.themeGroupOther",
    defaultTitle: "Other",
    roles: [
      {
        role: "selectionBg",
        labelKey: "settings.themeColorSelectionBg",
        defaultLabel: "Selection background",
      },
      {
        role: "focusRing",
        labelKey: "settings.themeColorFocusRing",
        defaultLabel: "Focus ring",
      },
    ],
  },
];

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: "system",
  presetId: DEFAULT_THEME_PRESET_ID,
  custom: {
    light: getPresetById(DEFAULT_THEME_PRESET_ID)?.light ?? emptyPalette(),
    dark: getPresetById(DEFAULT_THEME_PRESET_ID)?.dark ?? emptyPalette(),
  },
  background: {
    enabled: false,
    imagePath: "",
    opacity: 0.2,
    blur: 0,
  },
  fontFamily: "",
  streamCursor: {
    iconType: "dot",
    lucideName: "",
    svgPath: "",
    iconSize: 14,
  },
};

export function emptyPalette(): ThemePalette {
  return {
    bgPrimary: "",
    bgSecondary: "",
    bgTertiary: "",
    bgHover: "",
    bgActive: "",
    chromeBg: "",
    appBg: "",
    borderColor: "",
    borderLight: "",
    borderSubtle: "",
    textPrimary: "",
    textSecondary: "",
    textTertiary: "",
    textMuted: "",
    accentGreen: "",
    accentGreenBg: "",
    accentGreenText: "",
    accentRed: "",
    accentRedBg: "",
    accentRedText: "",
    accentBlue: "",
    accentBlueBg: "",
    accentBlueText: "",
    accentColor: "",
    onSolid: "",
    selectionBg: "",
    focusRing: "",
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export function normalizePalette(value: unknown): ThemePalette {
  const source = isRecord(value) ? value : {};
  const palette = emptyPalette();
  (Object.keys(palette) as (keyof ThemePalette)[]).forEach((key) => {
    palette[key] = toText(source[key]);
  });
  return palette;
}

export function normalizeCustomTheme(value: unknown): ThemeSettings["custom"] {
  const source = isRecord(value) ? value : {};
  return {
    light: normalizePalette(source.light),
    dark: normalizePalette(source.dark),
  };
}

export function normalizeThemeBackground(
  value: unknown,
): ThemeSettings["background"] {
  const source = isRecord(value) ? value : {};
  const opacity =
    typeof source.opacity === "number" && Number.isFinite(source.opacity)
      ? Math.max(0, Math.min(MAX_BACKGROUND_OPACITY, source.opacity))
      : DEFAULT_THEME_SETTINGS.background.opacity;
  const blur =
    typeof source.blur === "number" && Number.isFinite(source.blur)
      ? Math.max(0, Math.min(100, source.blur))
      : 0;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : false,
    imagePath: toText(source.imagePath),
    opacity,
    blur,
  };
}

export function normalizeThemeStreamCursor(value: unknown): ThemeStreamCursor {
  const source = isRecord(value) ? value : {};
  const rawType = toText(source.iconType) || "dot";
  const iconType: ThemeStreamCursor["iconType"] =
    rawType === "lucide" || rawType === "custom" ? rawType : "dot";
  const lucideName = toText(source.lucideName);
  const svgPath = toText(source.svgPath);
  const rawSize =
    typeof source.iconSize === "number" && Number.isFinite(source.iconSize)
      ? source.iconSize
      : 14;
  const iconSize = Math.max(8, Math.min(48, rawSize));
  // 根据类型清理无关字段，与 Rust 端 normalize 逻辑保持一致。
  if (iconType === "dot") {
    return { iconType, lucideName: "", svgPath: "", iconSize };
  }
  if (iconType === "lucide") {
    const isValidName = STREAM_CURSOR_LUCIDE_ICONS.some(
      (item) => item.name === lucideName,
    );
    if (!lucideName || !isValidName) {
      return { iconType: "dot", lucideName: "", svgPath: "", iconSize };
    }
    return { iconType, lucideName, svgPath: "", iconSize };
  }
  // iconType === "custom"
  if (!svgPath) {
    return { iconType: "dot", lucideName: "", svgPath: "", iconSize };
  }
  return { iconType, lucideName: "", svgPath, iconSize };
}

export function normalizeThemeSettings(value: unknown): ThemeSettings {
  const source = isRecord(value) ? value : {};
  const rawMode = toText(source.mode) || "system";
  const mode: ThemeMode =
    rawMode === "light" || rawMode === "dark" ? rawMode : "system";
  const presetId = toText(source.presetId) || DEFAULT_THEME_PRESET_ID;
  return {
    mode,
    presetId,
    custom: normalizeCustomTheme(source.custom),
    background: normalizeThemeBackground(source.background),
    fontFamily: toText(source.fontFamily),
    streamCursor: normalizeThemeStreamCursor(source.streamCursor),
  };
}

export function resolveActivePalette(
  settings: ThemeSettings,
  isDark: boolean,
): ThemePalette {
  const useCustom = settings.presetId === "custom";
  if (useCustom) {
    return isDark ? settings.custom.dark : settings.custom.light;
  }
  const preset = getPresetById(settings.presetId);
  if (preset) {
    return isDark ? preset.dark : preset.light;
  }
  const fallback = getPresetById(DEFAULT_THEME_PRESET_ID);
  return isDark
    ? (fallback?.dark ?? settings.custom.dark)
    : (fallback?.light ?? settings.custom.light);
}

export function applyPaletteToDocument(palette: ThemePalette): void {
  const root = document.documentElement;
  (Object.keys(palette) as (keyof ThemePalette)[]).forEach((key) => {
    const cssVar = PALETTE_ROLE_TO_CSS_VAR[key];
    const value = palette[key];
    if (cssVar && value) {
      root.style.setProperty(cssVar, value);
    }
  });
}

export function applyThemeModeToDocument(mode: ThemeMode): "light" | "dark" {
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effective: "light" | "dark" =
    mode === "system" ? (prefersDark ? "dark" : "light") : mode;
  document.documentElement.setAttribute("data-theme", effective);
  document.documentElement.style.setProperty("color-scheme", effective);
  return effective;
}

/** Apply the active preset id so preset-specific typography and surface styling can react. */
export function applyThemePresetToDocument(presetId: string): void {
  const root = document.documentElement;
  const normalizedPresetId = resolvePresetId(
    presetId.trim() || DEFAULT_THEME_PRESET_ID,
  );
  root.setAttribute("data-theme-preset", normalizedPresetId);
}

/**
 * 将自定义字体应用到 document 根元素。传入空字符串时移除自定义字体，
 * 回退到 CSS 中定义的默认字体栈。
 */
export function applyFontFamilyToDocument(fontFamily: string): void {
  const root = document.documentElement;
  const trimmed = fontFamily.trim();
  if (trimmed) {
    root.style.setProperty("--app-font-family", trimmed);
  } else {
    root.style.removeProperty("--app-font-family");
  }
}

/**
 * 将流式光标配置应用到 document 根元素。
 * - dot：清除 lucide 和自定义 SVG 相关属性
 * - lucide：设置 data-stream-cursor="lucide" 和 data-stream-cursor-lucide 属性
 * - custom：设置 data-stream-cursor="custom" 和 --stream-cursor-svg CSS 变量
 */
export function applyStreamCursorToDocument(cursor: ThemeStreamCursor): void {
  const root = document.documentElement;
  root.removeAttribute("data-stream-cursor");
  root.removeAttribute("data-stream-cursor-lucide");
  root.style.removeProperty("--stream-cursor-svg");
  root.style.setProperty("--stream-cursor-size", `${cursor.iconSize}px`);

  if (cursor.iconType === "lucide" && cursor.lucideName) {
    root.setAttribute("data-stream-cursor", "lucide");
    root.setAttribute("data-stream-cursor-lucide", cursor.lucideName);
  } else if (cursor.iconType === "custom" && cursor.svgPath) {
    root.setAttribute("data-stream-cursor", "custom");
    root.style.setProperty(
      "--stream-cursor-svg",
      `url("${themeBgUrl(cursor.svgPath)}")`,
    );
  }
}

export function isValidHex(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed);
}

/* ============================================================
 * 主题启动缓存（localStorage）
 *
 * 主题持久化在 Rust 后端，渲染进程启动时需通过 IPC 异步读取，
 * 期间 CSS 变量保持默认浅色，会导致深色用户看到短暂白闪。
 * 这里在 localStorage 中缓存最近一次应用过的主题快照，供
 * main.tsx 在加载 React 之前同步应用，消除启动闪烁。
 * ============================================================ */

const THEME_CACHE_KEY = "snow:theme-cache-v1";

type ThemeCacheSnapshot = {
  settings: ThemeSettings;
  /** 应用快照时的系统暗色判定，仅用于调试，不参与恢复逻辑。 */
  systemDark?: boolean;
};

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
};

/** 读取 localStorage 中的主题快照；不存在或解析失败时返回 null。 */
export const readThemeCache = (): ThemeSettings | null => {
  const storage = safeLocalStorage();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(THEME_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as ThemeCacheSnapshot;
    if (!parsed || typeof parsed !== "object" || !parsed.settings) {
      return null;
    }
    return normalizeThemeSettings(parsed.settings);
  } catch {
    return null;
  }
};

/** 将主题快照写入 localStorage，供下次启动使用。写入失败静默忽略。 */
export const writeThemeCache = (settings: ThemeSettings): void => {
  const storage = safeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    const snapshot: ThemeCacheSnapshot = { settings };
    storage.setItem(THEME_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // 忽略写入失败（如配额超限或隐私模式）。
  }
};

/**
 * 在 React 渲染之前同步应用缓存的主题快照到 document。
 *
 * 该函数刻意保持同步且不抛错，确保即使缓存缺失或损坏也不会阻塞启动。
 * 调用方应在 main.tsx 的模块顶层（createRoot 之前）调用一次。
 *
 * 返回应用后的 effective mode（"light" | "dark"），便于调用方记录。
 */
export const applyThemeCacheToDocument = (): "light" | "dark" | null => {
  if (typeof document === "undefined") {
    return null;
  }
  const settings = readThemeCache();
  if (!settings) {
    return null;
  }

  const systemDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark =
    settings.mode === "system" ? systemDark : settings.mode === "dark";

  applyThemeModeToDocument(settings.mode);
  applyThemePresetToDocument(settings.presetId);
  const palette = resolveActivePalette(settings, isDark);
  applyPaletteToDocument(palette);

  // 应用自定义字体和流式光标配置。
  applyFontFamilyToDocument(settings.fontFamily);
  applyStreamCursorToDocument(settings.streamCursor);

  // 同步背景图层 CSS 变量，避免启动时背景图延迟出现。
  const bg = settings.background;
  const root = document.documentElement;
  if (bg.enabled && bg.imagePath) {
    const opacity = Math.max(0, Math.min(MAX_BACKGROUND_OPACITY, bg.opacity));
    const blur = Math.max(0, bg.blur);
    root.style.setProperty(
      "--theme-bg-image",
      `url("${themeBgUrl(bg.imagePath)}")`,
    );
    root.style.setProperty("--theme-bg-opacity", String(opacity));
    root.style.setProperty("--theme-bg-blur", `${blur}px`);
    root.setAttribute("data-theme-bg", "on");
  }

  return isDark ? "dark" : "light";
};
