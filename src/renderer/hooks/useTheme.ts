import { useCallback, useEffect, useState } from "react";
import {
  applyBackgroundToDocument,
  applyChatStyleToDocument,
  applyFontFamilyToDocument,
  applyLayoutStyleToDocument,
  applyPaletteToDocument,
  applyRadiusToDocument,
  applyThemePresetToDocument,
  applyStreamCursorToDocument,
  applyThemeModeToDocument,
  applyTypographyToDocument,
  DEFAULT_THEME_SETTINGS,
  normalizeThemeSettings,
  resolveActivePalette,
  syncMacTrafficLightPosition,
  writeThemeCache,
} from "../components/sidebar/themeSettings/themeSettingsUtils";
import type { ThemeSettings } from "../components/sidebar/themeSettings/types";

/**
 * 全局主题应用 Hook。
 *
 * 职责：
 * 1. 启动时从 Rust 后端读取持久化的 ThemeSettings。
 * 2. 根据 mode + presetId/custom 解析当前生效的调色板（亮/暗）。
 * 3. 将调色板注入到 document.documentElement 的 CSS 变量上。
 * 4. 监听系统 prefers-color-scheme 变化（mode === "system" 时）。
 * 5. 将当前生效的 bgPrimary 同步到主进程，使窗口背景色一致。
 * 6. 暴露 reloadTheme 方法，供设置面板保存后调用以即时刷新。
 */
export const useTheme = (): {
  themeSettings: ThemeSettings;
  reloadTheme: () => Promise<void>;
} => {
  const [themeSettings, setThemeSettings] = useState<ThemeSettings>(
    DEFAULT_THEME_SETTINGS,
  );

  const applyTheme = useCallback(
    (settings: ThemeSettings, systemDark: boolean): void => {
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
      applyRadiusToDocument(settings.radius);
      applyChatStyleToDocument(settings.chatStyle);

      // 将主题快照写入 localStorage，供下次启动时在 React 渲染前同步应用，
      // 消除从 Rust 后端异步加载主题期间的白屏闪烁。
      writeThemeCache(settings);

      // 同步窗口背景色到主进程，消除切换时的白闪。
      const bg = palette.bgPrimary;
      if (bg && typeof window !== "undefined" && window.snow) {
        void window.snow.setThemeBackgroundColor(bg).catch(() => {
          // 忽略同步失败，不影响主题应用。
        });
      }

      syncMacTrafficLightPosition();

      // 应用背景图层 CSS 变量（图片背景 / 宠物背景由各自渲染层消费）。
      applyBackgroundToDocument(settings.background);
    },
    [],
  );

  const reloadTheme = useCallback(async (): Promise<void> => {
    try {
      const raw = await window.snow.getThemeSettings();
      const normalized = normalizeThemeSettings(raw);
      setThemeSettings(normalized);
      const systemDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
      applyTheme(normalized, systemDark);
    } catch (error) {
      console.warn("Failed to load theme settings:", error);
    }
  }, [applyTheme]);

  useEffect(() => {
    void reloadTheme();
  }, [reloadTheme]);

  // 监听 ThemeSettingsPanel 保存后派发的 theme:changed 事件，
  // 使全局状态与持久化数据同步，避免 Panel 卸载后旧状态被系统暗色变化覆盖。
  useEffect(() => {
    const handleThemeChanged = (): void => {
      void reloadTheme();
    };
    window.addEventListener("theme:changed", handleThemeChanged);
    return () => {
      window.removeEventListener("theme:changed", handleThemeChanged);
    };
  }, [reloadTheme]);

  // AI 经 config 工具改了主题：先重载并写缓存，再派发 theme:changed 让各订阅方同步。
  useEffect(() => {
    if (typeof window.snow?.onThemeSettingsChanged !== "function") {
      return;
    }
    return window.snow.onThemeSettingsChanged(() => {
      void reloadTheme().then(() => {
        window.dispatchEvent(new CustomEvent("theme:changed"));
      });
    });
  }, [reloadTheme]);

  // 监听系统暗色模式变化（仅 mode === "system" 时需要重新应用）。
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent): void => {
      if (themeSettings.mode === "system") {
        applyTheme(themeSettings, event.matches);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [themeSettings, applyTheme]);

  return { themeSettings, reloadTheme };
};
