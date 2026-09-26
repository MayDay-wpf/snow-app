import { $ } from "./dom";
import { t } from "./i18n";
import { showNotice } from "./notice";

type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "snowRemoteTheme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

let themePreference: ThemePreference = "system";

const isThemePreference = (
  value: string | null | undefined,
): value is ThemePreference =>
  value === "system" || value === "light" || value === "dark";

/** 应用外观偏好：解析 system → light/dark，并同步 meta theme-color 与选中态。 */
export const applyTheme = (preference: ThemePreference): void => {
  themePreference = preference;
  const resolved =
    preference === "system"
      ? systemTheme.matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // accent 的对比度适配依赖当前主题（见 applyAccentCssVariables），重算一次。
  applyAccentCssVariables();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", resolved === "dark" ? "#0e0f12" : "#f5f6f8");
  }
  document
    .querySelectorAll<HTMLElement>("[data-theme-choice]")
    .forEach((button) => {
      button.classList.toggle(
        "selected",
        button.dataset.themeChoice === preference,
      );
    });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 隐私模式下 localStorage 不可用；仅影响持久化，不影响当前会话。
  }
};

export const initTheme = (): void => {
  try {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(savedTheme)) themePreference = savedTheme;
  } catch {
    // 读取失败时保持默认（跟随系统）。
  }
  applyTheme(themePreference);
  systemTheme.addEventListener?.("change", () => {
    if (themePreference === "system") applyTheme("system");
  });
  $("themePanel").onclick = (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-theme-choice]",
    );
    if (!item) return;
    const preference = item.dataset.themeChoice;
    if (!isThemePreference(preference)) return;
    applyTheme(preference);
    showNotice(t("remote.notice.themeUpdated"));
  };
};

/**
 * 跟随桌面主题的强调色：Snow APP 当前生效的 --accent-color（#rrggbb）。
 * 应用到动作面板开关、会话 / 模式选中态等强调元素上；
 * 解析失败或值未变化时不做任何事（保持当前值）。
 */
let appliedAccentColor = "";

const parseHexColor = (value: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};

type Rgb = [number, number, number];

/** YIQ 亮度（0~255）：判断 accent 与当前主题背景的对比是否成立。 */
const brightnessOf = ([r, g, b]: Rgb): number =>
  r * 0.299 + g * 0.587 + b * 0.114;

const mixRgb = (from: Rgb, to: Rgb, t: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * t),
  Math.round(from[1] + (to[1] - from[1]) * t),
  Math.round(from[2] + (to[2] - from[2]) * t),
];

/** 浅色 / 暗色主题的前景色（--text），作为 accent 亮度混合的目标色。 */
const LIGHT_TEXT_RGB: Rgb = [23, 25, 29];
const DARK_TEXT_RGB: Rgb = [245, 247, 250];

/**
 * accent 与手机主题可能"错配"：桌面默认主题的 accent = text-primary，
 * 桌面暗色（近白 accent，如 #f5f7fa）同步到手机浅色模式后，开关等强调元素
 * 会几乎不可见；反向（近黑 accent + 暗色模式）同理。这里按手机当前主题做
 * 对比度适配，仅调整亮度、保留色相：
 * - 浅色：亮度 > 150 时向深色前景混合（上限 55%），避免白底上的浅色 accent；
 * - 暗色：亮度 < 95 时向浅色前景混合（上限 55%）。
 */
const adaptAccentForTheme = (rgb: Rgb, isLight: boolean): Rgb => {
  const brightness = brightnessOf(rgb);
  if (isLight && brightness > 150) {
    return mixRgb(
      rgb,
      LIGHT_TEXT_RGB,
      Math.min(
        0.55,
        (brightness - 150) / (brightness - brightnessOf(LIGHT_TEXT_RGB)),
      ),
    );
  }
  if (!isLight && brightness < 95) {
    return mixRgb(
      rgb,
      DARK_TEXT_RGB,
      Math.min(
        0.55,
        (95 - brightness) / (brightnessOf(DARK_TEXT_RGB) - brightness),
      ),
    );
  }
  return rgb;
};

/** 把按当前主题适配后的 accent 写入 CSS 变量（主题切换后需重新调用）。 */
const applyAccentCssVariables = (): void => {
  const parsed = parseHexColor(appliedAccentColor);
  if (!parsed) return;
  const [r, g, b] = adaptAccentForTheme(
    parsed,
    document.documentElement.dataset.theme === "light",
  );
  const root = document.documentElement;
  root.style.setProperty("--accent-color", `rgb(${r}, ${g}, ${b})`);
  root.style.setProperty("--accent-color-dim", `rgba(${r}, ${g}, ${b}, 0.08)`);
  root.style.setProperty("--accent-color-soft", `rgba(${r}, ${g}, ${b}, 0.22)`);
  root.style.setProperty(
    "--accent-color-border",
    `rgba(${r}, ${g}, ${b}, 0.45)`,
  );
};

export const applyAccentColor = (accent: string | undefined): void => {
  if (!accent || accent === appliedAccentColor) return;
  if (!parseHexColor(accent)) return;
  appliedAccentColor = accent;
  applyAccentCssVariables();
};
