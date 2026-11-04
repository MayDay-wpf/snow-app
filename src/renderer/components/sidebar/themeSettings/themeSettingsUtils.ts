import type {
  ColorGroup,
  ThemeBackground,
  ThemeBackgroundSource,
  ThemeCarouselOrder,
  ThemeChatStyle,
  ThemeLayoutStyle,
  ThemePalette,
  ThemeSettings,
  ThemeMode,
  ThemeStreamCursor,
  ThemeTypography,
} from "./types";
import {
  DEFAULT_THEME_PRESET_ID,
  getPresetById,
  resolvePresetId,
} from "./themePresets";
import { STREAM_CURSOR_LUCIDE_ICONS } from "./streamCursorIcons";
import { themeBgUrl } from "../../../utils/themeBgUrl";
import { setActiveBackground } from "./backgroundLayerStore";
import { DEFAULT_CHAT_STYLE, setActiveChatStyle } from "./chatStyleStore";
import { THEME_CACHE_KEY } from "./themeFontCache";

export { THEME_CACHE_KEY };

export const THEME_SETTING_NAME = "Theme settings";
export const THEME_SETTING_CODE = "theme_settings";

/**
 * 背景图不透明度上限。超过此值后前景内容可读性极差，因此滑块与归一化
 * 都以此值为上限。调整此值需同步：normalizeThemeBackground、
 * applyThemeCacheToDocument、ThemeBackgroundSection 滑块 max、
 * ThemeSettingsPanel 预览 useEffect。
 */
export const MAX_BACKGROUND_OPACITY = 0.6;

/** 背景图列表上限（与 Rust 端 BACKGROUND_IMAGE_LIMIT 保持一致）。 */
export const BACKGROUND_IMAGE_LIMIT = 30;

/** 轮播切换间隔（秒）范围与默认值，与 Rust 端常量保持一致。 */
export const CAROUSEL_INTERVAL_MIN_SECS = 10;
export const CAROUSEL_INTERVAL_MAX_SECS = 7200;
export const CAROUSEL_INTERVAL_DEFAULT_SECS = 300;

/** 宠物背景大小（相对视口高度的比例）范围与默认值。 */
export const PET_BACKGROUND_SCALE_MIN = 0.2;
export const PET_BACKGROUND_SCALE_MAX = 1.5;
export const PET_BACKGROUND_SCALE_DEFAULT = 0.6;

/** 界面字号范围与默认值。字号以 13px 为 100% 基准驱动整页缩放。 */
export const UI_FONT_SIZE_MIN = 10;
export const UI_FONT_SIZE_MAX = 18;
export const UI_FONT_SIZE_DEFAULT = 13;
export const FONT_WEIGHT_MIN = 100;
export const FONT_WEIGHT_MAX = 900;
export const FONT_WEIGHT_DEFAULT = 400;
export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 20;
export const CHAT_FONT_SIZE_DEFAULT = 15;
export const CHAT_LINE_HEIGHT_MIN = 1.2;
export const CHAT_LINE_HEIGHT_MAX = 2.4;
export const CHAT_LINE_HEIGHT_DEFAULT = 1.75;
export const CODE_FONT_SIZE_MIN = 10;
export const CODE_FONT_SIZE_MAX = 18;
export const CODE_FONT_SIZE_DEFAULT = 12.5;

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
  layoutStyle: "island",
  custom: {
    light: getPresetById(DEFAULT_THEME_PRESET_ID)?.light ?? emptyPalette(),
    dark: getPresetById(DEFAULT_THEME_PRESET_ID)?.dark ?? emptyPalette(),
  },
  background: {
    enabled: false,
    source: "image",
    imagePaths: [],
    petId: "",
    petScale: PET_BACKGROUND_SCALE_DEFAULT,
    opacity: 0.2,
    blur: 0,
    carouselEnabled: false,
    carouselIntervalSecs: CAROUSEL_INTERVAL_DEFAULT_SECS,
    carouselOrder: "sequential",
    currentImagePath: "",
  },
  fontFamily: "",
  streamCursor: {
    iconType: "dot",
    lucideName: "",
    svgPath: "",
    iconSize: 14,
  },
  typography: {
    fontSize: UI_FONT_SIZE_DEFAULT,
    fontWeight: FONT_WEIGHT_DEFAULT,
    chatFontSize: CHAT_FONT_SIZE_DEFAULT,
    chatLineHeight: CHAT_LINE_HEIGHT_DEFAULT,
    codeFontSize: CODE_FONT_SIZE_DEFAULT,
  },
  chatStyle: { ...DEFAULT_CHAT_STYLE },
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
  const sourceKind: ThemeBackgroundSource =
    source.source === "pet" ? "pet" : "image";
  // 图片列表：trim、去空、去重（保留首次出现）、截断到上限，与 Rust 端一致。
  const rawList = Array.isArray(source.imagePaths) ? source.imagePaths : [];
  const imagePaths: string[] = [];
  for (const item of rawList) {
    const trimmed = toText(item).trim();
    if (!trimmed || imagePaths.includes(trimmed)) {
      continue;
    }
    imagePaths.push(trimmed);
    if (imagePaths.length >= BACKGROUND_IMAGE_LIMIT) {
      break;
    }
  }
  // 旧数据迁移：旧版单图字段非空且列表为空时并入列表。
  const legacyImagePath = toText(source.imagePath).trim();
  if (imagePaths.length === 0 && legacyImagePath) {
    imagePaths.push(legacyImagePath);
  }
  const petId = toText(source.petId);
  const petScale = pickInRange(
    source.petScale,
    PET_BACKGROUND_SCALE_MIN,
    PET_BACKGROUND_SCALE_MAX,
    PET_BACKGROUND_SCALE_DEFAULT,
  );
  // 轮播间隔越界处理与 Rust 端一致：小于下限回退默认值，大于上限钳制到上限。
  const rawInterval =
    typeof source.carouselIntervalSecs === "number" &&
    Number.isFinite(source.carouselIntervalSecs)
      ? source.carouselIntervalSecs
      : CAROUSEL_INTERVAL_DEFAULT_SECS;
  const carouselIntervalSecs =
    rawInterval < CAROUSEL_INTERVAL_MIN_SECS
      ? CAROUSEL_INTERVAL_DEFAULT_SECS
      : Math.min(rawInterval, CAROUSEL_INTERVAL_MAX_SECS);
  const carouselOrder: ThemeCarouselOrder =
    source.carouselOrder === "random" ? "random" : "sequential";
  // 当前显示图必须属于图片列表，否则清空（回退到列表首张），与 Rust 端一致。
  const rawCurrentImagePath = toText(source.currentImagePath).trim();
  const currentImagePath = imagePaths.includes(rawCurrentImagePath)
    ? rawCurrentImagePath
    : "";
  // 当前来源缺少素材时视为未启用，与 Rust 端 normalize 保持一致。
  const hasContent =
    sourceKind === "pet" ? Boolean(petId) : imagePaths.length > 0;
  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled && hasContent
        : false,
    source: sourceKind,
    imagePaths,
    petId,
    petScale,
    opacity,
    blur,
    carouselEnabled: source.carouselEnabled === true,
    carouselIntervalSecs,
    carouselOrder,
    currentImagePath,
  };
}

/** 当前来源是否已有可用素材（图片列表非空 / 宠物已选择）。 */
export const hasBackgroundContent = (
  background: ThemeSettings["background"],
): boolean =>
  background.source === "pet"
    ? Boolean(background.petId)
    : background.imagePaths.length > 0;

/**
 * 将背景配置应用到 document。
 *
 * - image：写入全局快照供 ThemeBackgroundImageLayer 组件绘制（多图轮播 +
 *   交叉淡化），同时维护不透明度 / 模糊 / 宠物大小等 CSS 变量；
 * - pet：图片图层不参与，仅提供变量（由渲染层宠物画布绘制 idle 动画）。
 */
export function applyBackgroundToDocument(background: ThemeBackground): void {
  const root = document.documentElement;
  const isActive = background.enabled && hasBackgroundContent(background);
  // 通知全局背景图片图层（组件从快照读取图片列表与轮播参数并负责绘制）。
  setActiveBackground(isActive ? background : null);
  if (isActive) {
    const opacity = Math.max(
      0,
      Math.min(MAX_BACKGROUND_OPACITY, background.opacity),
    );
    const blur = Math.max(0, background.blur);
    // 旧版图片通过 --theme-bg-image 变量绘制，现已由图层组件接管，清理历史遗留值。
    root.style.removeProperty("--theme-bg-image");
    root.style.setProperty("--theme-bg-opacity", String(opacity));
    root.style.setProperty("--theme-bg-blur", `${blur}px`);
    root.style.setProperty("--theme-pet-scale", String(background.petScale));
    root.setAttribute("data-theme-bg", "on");
    return;
  }
  root.style.removeProperty("--theme-bg-image");
  root.style.removeProperty("--theme-bg-opacity");
  root.style.removeProperty("--theme-bg-blur");
  root.style.removeProperty("--theme-pet-scale");
  root.removeAttribute("data-theme-bg");
}

export function normalizeThemeStreamCursor(value: unknown): ThemeStreamCursor {
  const source = isRecord(value) ? value : {};
  const rawType = toText(source.iconType) || "dot";
  const iconType: ThemeStreamCursor["iconType"] =
    rawType === "lucide" ||
    rawType === "custom" ||
    rawType === "snowbot" ||
    rawType === "image" ||
    rawType === "canvas"
      ? rawType
      : "dot";
  const lucideName = toText(source.lucideName);
  const svgPath = toText(source.svgPath);
  const rawSize =
    typeof source.iconSize === "number" && Number.isFinite(source.iconSize)
      ? source.iconSize
      : 14;
  const iconSize = Math.max(8, Math.min(48, rawSize));
  // 根据类型清理无关字段，与 Rust 端 normalize 逻辑保持一致。
  if (iconType === "dot" || iconType === "snowbot") {
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
  // iconType === "custom" | "image" | "canvas"
  if (!svgPath) {
    return { iconType: "dot", lucideName: "", svgPath: "", iconSize };
  }
  return { iconType, lucideName: "", svgPath, iconSize };
}

const pickInRange = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : fallback;

export function normalizeThemeTypography(value: unknown): ThemeTypography {
  const source = isRecord(value) ? value : {};
  return {
    fontSize: pickInRange(
      source.fontSize,
      UI_FONT_SIZE_MIN,
      UI_FONT_SIZE_MAX,
      UI_FONT_SIZE_DEFAULT,
    ),
    fontWeight: pickInRange(
      source.fontWeight,
      FONT_WEIGHT_MIN,
      FONT_WEIGHT_MAX,
      FONT_WEIGHT_DEFAULT,
    ),
    chatFontSize: pickInRange(
      source.chatFontSize,
      CHAT_FONT_SIZE_MIN,
      CHAT_FONT_SIZE_MAX,
      CHAT_FONT_SIZE_DEFAULT,
    ),
    chatLineHeight: pickInRange(
      source.chatLineHeight,
      CHAT_LINE_HEIGHT_MIN,
      CHAT_LINE_HEIGHT_MAX,
      CHAT_LINE_HEIGHT_DEFAULT,
    ),
    codeFontSize: pickInRange(
      source.codeFontSize,
      CODE_FONT_SIZE_MIN,
      CODE_FONT_SIZE_MAX,
      CODE_FONT_SIZE_DEFAULT,
    ),
  };
}

export function normalizeThemeChatStyle(value: unknown): ThemeChatStyle {
  const source = isRecord(value) ? value : {};
  return {
    imMode: source.imMode === true,
    aiAvatarPath: toText(source.aiAvatarPath).trim(),
    userAvatarPath: toText(source.userAvatarPath).trim(),
  };
}

/** 聊天风格：根属性供样式切换，快照供消息列表渲染头像。 */
export function applyChatStyleToDocument(chatStyle: ThemeChatStyle): void {
  const root = document.documentElement;
  if (chatStyle.imMode) {
    root.setAttribute("data-chat-style", "im");
  } else {
    root.removeAttribute("data-chat-style");
  }
  setActiveChatStyle(chatStyle);
}

export function normalizeThemeSettings(value: unknown): ThemeSettings {
  const source = isRecord(value) ? value : {};
  const rawMode = toText(source.mode) || "system";
  const mode: ThemeMode =
    rawMode === "light" || rawMode === "dark" ? rawMode : "system";
  const rawPresetId = toText(source.presetId) || DEFAULT_THEME_PRESET_ID;
  const presetId = resolvePresetId(rawPresetId);
  const rawLayoutStyle = toText(source.layoutStyle);
  const layoutStyle: ThemeLayoutStyle =
    rawLayoutStyle === "layered" || rawLayoutStyle === "flush"
      ? rawLayoutStyle
      : rawLayoutStyle === "island"
        ? "island"
        : // 兼容临时单主题时期（presetId 为 minimal/layered）留下的旧数据/旧缓存。
          rawPresetId === "minimal" || rawPresetId === "layered"
          ? "layered"
          : "island";
  return {
    mode,
    presetId,
    layoutStyle,
    custom: normalizeCustomTheme(source.custom),
    background: normalizeThemeBackground(source.background),
    fontFamily: toText(source.fontFamily),
    streamCursor: normalizeThemeStreamCursor(source.streamCursor),
    typography: normalizeThemeTypography(source.typography),
    chatStyle: normalizeThemeChatStyle(source.chatStyle),
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
  (Object.keys(PALETTE_ROLE_TO_CSS_VAR) as (keyof ThemePalette)[]).forEach(
    (key) => {
      const cssVar = PALETTE_ROLE_TO_CSS_VAR[key];
      const value = palette[key];
      if (value) {
        root.style.setProperty(cssVar, value);
      } else {
        root.style.removeProperty(cssVar);
      }
    },
  );
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

/** Apply the global layout style so the layout style layer (island / layered) can react. */
export function applyLayoutStyleToDocument(style: ThemeLayoutStyle): void {
  document.documentElement.setAttribute("data-layout-style", style);
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
 * - dot / snowbot：清除 lucide 和自定义 SVG 相关属性
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

/** 当前生效的界面缩放因子，供 traffic light 坐标换算复用。 */
let currentUiZoomFactor = 1;

/**
 * 应用排版设置：界面字号通过 webFrame zoom 实现整页缩放（13px 为 100% 基准），
 * 字重 / 聊天正文字号 / 行高 / 代码字号写入 CSS 变量。
 */
export function applyTypographyToDocument(typography: ThemeTypography): void {
  const root = document.documentElement;
  root.style.setProperty("--app-font-weight", String(typography.fontWeight));
  root.style.setProperty(
    "--app-chat-font-size",
    `${typography.chatFontSize}px`,
  );
  root.style.setProperty(
    "--app-chat-line-height",
    String(typography.chatLineHeight),
  );
  root.style.setProperty(
    "--app-code-font-size",
    `${typography.codeFontSize}px`,
  );

  const factor = typography.fontSize / UI_FONT_SIZE_DEFAULT;
  // 缩放未变化时不重复调用 webFrame（避免无谓的整页重排）。
  const zoomChanged = factor !== currentUiZoomFactor;
  currentUiZoomFactor = factor;
  if (
    zoomChanged &&
    typeof window !== "undefined" &&
    typeof window.snow?.setUiZoomFactor === "function"
  ) {
    window.snow.setUiZoomFactor(factor);
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
  applyLayoutStyleToDocument(settings.layoutStyle);
  const palette = resolveActivePalette(settings, isDark);
  applyPaletteToDocument(palette);

  // 应用自定义字体和流式光标配置。
  applyFontFamilyToDocument(settings.fontFamily);
  applyStreamCursorToDocument(settings.streamCursor);
  applyTypographyToDocument(settings.typography);
  applyChatStyleToDocument(settings.chatStyle);

  // 同步背景图层快照与 CSS 变量，React 挂载后图片层立即生效。
  applyBackgroundToDocument(settings.background);

  return isDark ? "dark" : "light";
};

/** 「当前显示图变化」事件名：图层切换成功后派发，设置面板监听以同步表单。 */
export const THEME_BG_CURRENT_EVENT = "theme:bg-current-changed";

/**
 * theme:changed 的来源标记：背景「当前图」节流回写。
 * 该来源的广播仅代表 currentImagePath 变化（表单已通过
 * THEME_BG_CURRENT_EVENT 同步），监听方可跳过无谓的整表重载。
 */
export const THEME_CHANGED_SOURCE_BG_CURRENT = "bg-current";

/** 当前显示图写回后端的节流窗口（毫秒）。 */
const BACKGROUND_CURRENT_PERSIST_THROTTLE_MS = 3000;

let persistCurrentTimer: number | null = null;
let pendingCurrentPath: string | null = null;

/**
 * 记录「当前显示的背景图」并节流持久化，使下次启动从上次显示的图继续：
 * - 顺序模式：从该图往下继续播放；
 * - 随机模式：该图作为关闭轮播时的固定图（开始播放时仍会随机起播）；
 * - 关闭轮播 / 点选缩略图固定时，重启后仍显示它。
 *
 * 数据来源与写入均走 localStorage 主题缓存 + 全量 setThemeSettings，
 * 不依赖设置面板是否挂载；切换成功即调用，节流窗口内只回写最后一次。
 */
export function persistBackgroundCurrentImagePath(imagePath: string): void {
  if (!imagePath) {
    return;
  }
  pendingCurrentPath = imagePath;
  // 立即广播：让设置面板同步表单里的当前图（避免其保存时回退旧值）。
  window.dispatchEvent(
    new CustomEvent(THEME_BG_CURRENT_EVENT, { detail: imagePath }),
  );
  if (persistCurrentTimer !== null) {
    return;
  }
  persistCurrentTimer = window.setTimeout(() => {
    persistCurrentTimer = null;
    const path = pendingCurrentPath;
    pendingCurrentPath = null;
    if (!path) {
      return;
    }
    const cached = readThemeCache();
    if (!cached || cached.background.currentImagePath === path) {
      return;
    }
    const updated: ThemeSettings = {
      ...cached,
      background: { ...cached.background, currentImagePath: path },
    };
    writeThemeCache(updated);
    void window.snow
      .setThemeSettings(updated)
      .then(() => {
        // 先落库再广播，确保 theme:changed 监听方读到的是新值；附带来源标记，
        // 设置面板据此跳过整表重载（避免每次切换闪一次「加载中」禁用态）。
        window.dispatchEvent(
          new CustomEvent("theme:changed", {
            detail: { source: THEME_CHANGED_SOURCE_BG_CURRENT },
          }),
        );
      })
      .catch(() => {
        // 持久化失败不阻塞轮播；下一次切换会重试。
      });
  }, BACKGROUND_CURRENT_PERSIST_THROTTLE_MS);
}

const TRAFFIC_LIGHT_GROUP_HEIGHT = 16;
const DEFAULT_HEADER_CENTER_Y = 36;

export function syncMacTrafficLightPosition(): void {
  if (typeof window === "undefined" || !window.snow) {
    return;
  }
  // 取顶栏卡片中心而非 .top-bar 整体中心：层叠风格顶栏有上留白、下留白为 0，
  // 用整条顶栏居中会让红绿灯比图标偏上。
  // 独立面板窗口没有 .top-bar，改用其顶部操作栏（DetachedPanelTitleBar）。
  const anchor =
    document.querySelector<HTMLElement>(
      ".top-bar-main, .top-bar-left, .top-bar-right, .detached-panel-titlebar",
    ) ?? document.querySelector<HTMLElement>(".top-bar");
  const barRect = anchor?.getBoundingClientRect();
  const centerY =
    barRect && barRect.height > 0
      ? barRect.top + barRect.height / 2
      : DEFAULT_HEADER_CENTER_Y;
  // rect 为 CSS px，主进程窗口坐标需按当前界面缩放换算。
  const zoom = currentUiZoomFactor || 1;
  void window.snow
    .setThemeTrafficLightY(
      Math.round((centerY - TRAFFIC_LIGHT_GROUP_HEIGHT / 2) * zoom),
    )
    .catch(() => undefined);
}
