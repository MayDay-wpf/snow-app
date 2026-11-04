/**
 * 主题字体快照：从 localStorage 的主题缓存同步读取字体族与字重。
 *
 * 供入口层（启动首帧 / 宠物窗口）在 React 与后端 IPC 就绪前应用，
 * 保证所有窗口共用同一字体链路；主题变更由 storage 事件跨窗口同步。
 */

export const THEME_CACHE_KEY = "snow:theme-cache-v1";

type ThemeCacheShape = {
  settings?: {
    fontFamily?: unknown;
    typography?: { fontWeight?: unknown };
  };
};

export type CachedThemeFont = {
  fontFamily: string;
  fontWeight: number;
};

const readStorage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** 读取缓存的字体设置；无缓存或解析失败返回 null。 */
export const readCachedThemeFont = (): CachedThemeFont | null => {
  const storage = readStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(THEME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ThemeCacheShape;
    const settings = parsed?.settings;
    if (!settings) return null;
    const fontFamily =
      typeof settings.fontFamily === "string" ? settings.fontFamily.trim() : "";
    const weight = settings.typography?.fontWeight;
    const fontWeight =
      typeof weight === "number" && Number.isFinite(weight) ? weight : 400;
    return { fontFamily, fontWeight };
  } catch {
    return null;
  }
};

/** 把缓存的字体设置写入根元素变量（空字体时回退主题默认栈）。 */
export const applyCachedThemeFontToDocument = (): void => {
  const font = readCachedThemeFont();
  if (!font || typeof document === "undefined") return;
  const root = document.documentElement;
  if (font.fontFamily) {
    root.style.setProperty("--app-font-family", font.fontFamily);
  } else {
    root.style.removeProperty("--app-font-family");
  }
  root.style.setProperty("--app-font-weight", String(font.fontWeight));
};

/** 监听跨窗口的主题缓存写入（同源窗口共享 localStorage）。 */
export const watchCachedThemeFont = (onChange: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  const handler = (event: StorageEvent): void => {
    if (event.key === THEME_CACHE_KEY) onChange();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
};
