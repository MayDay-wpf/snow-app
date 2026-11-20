import { Pencil, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { CustomSelect } from "../common/CustomSelect";
import { Modal } from "../common/Modal";
import { ApiSettingsHintIcon } from "./apiSettings/ApiSettingsFieldLabel";
import { useI18n } from "../../i18n";
import { useDebouncedAutoSave } from "../../hooks/useDebouncedAutoSave";
import { getPresetById } from "./themeSettings/themePresets";
import {
  BACKGROUND_IMAGE_LIMIT,
  applyBackgroundToDocument,
  applyChatStyleToDocument,
  applyFontFamilyToDocument,
  applyLayoutStyleToDocument,
  applyPaletteToDocument,
  applyThemePresetToDocument,
  applyStreamCursorToDocument,
  applyThemeModeToDocument,
  applyTypographyToDocument,
  DEFAULT_THEME_SETTINGS,
  EMPTY_CHARACTER_CARD,
  normalizeThemeCharacterCard,
  normalizeThemeSettings,
  readThemeCache,
  resolveActivePalette,
  syncMacTrafficLightPosition,
  THEME_BG_CURRENT_EVENT,
  THEME_CHANGED_SOURCE_BG_CURRENT,
  writeThemeCache,
} from "./themeSettings/themeSettingsUtils";
import type {
  ThemeBackground,
  ThemeCharacterCard,
  ThemeLayoutStyle,
  ThemeMode,
  ThemePalette,
  ThemeSettings,
  ThemeStreamCursor,
  ThemeTypography,
} from "./themeSettings/types";
import type { PetManifest } from "../../../preload/types/pets";
import { THEME_BG_PREVIEW_EVENT } from "../pet/ThemeBackgroundPetLayer";
import { ThemeAiColorModal } from "./themeSettings/ThemeAiColorModal";
import { ThemeBackgroundHistoryModal } from "./themeSettings/ThemeBackgroundHistoryModal";
import { ThemeBackgroundSection } from "./themeSettings/ThemeBackgroundSection";
import { ThemeCharacterCardModal } from "./themeSettings/ThemeCharacterCardModal";
import { ThemeColorEditor } from "./themeSettings/ThemeColorEditor";
import { ThemeFontSection } from "./themeSettings/ThemeFontSection";
import { ThemeTypographySection } from "./themeSettings/ThemeTypographySection";
import { ThemeModeSelector } from "./themeSettings/ThemeModeSelector";
import { ThemeLayoutStyleSelector } from "./themeSettings/ThemeLayoutStyleSelector";
import { ThemeTranscriptStyleSelector } from "./themeSettings/ThemeTranscriptStyleSelector";
import { TOOL_CARD_STYLE_SHORTCUT_KEY } from "../../utils/toolCardStyle";
import { ThemePresetGrid } from "./themeSettings/ThemePresetGrid";
import { ThemePreview } from "./themeSettings/ThemePreview";
import {
  ThemeStreamCursorSection,
  type StreamCursorAssetKind,
} from "./themeSettings/ThemeStreamCursorSection";
import {
  ThemeChatStyleSection,
  type ChatAvatarRole,
} from "./themeSettings/ThemeChatStyleSection";

type EditorTab = "light" | "dark";

// 自动保存 debounce 延时。滑块拖动期间 ThemeBackgroundSection 已做本地 state
// 隔离（120ms 提交），这里再加一层较长的保存 debounce，避免连续微调时频繁触发
// IPC 持久化与 localStorage 写入。600ms 偏短，拖动稍快就会在拖动途中触发保存；
// 1000ms 在交互流畅度与"改完即存"体感之间取得平衡。
const SAVE_DEBOUNCE_MS = 1000;

/**
 * 计算待保存的主题设置值。
 * 返回 null 表示无需保存（加载中 / 与上次保存一致）。
 */
function computeThemeSaveValue(
  form: ThemeSettings,
  lastSaved: ThemeSettings,
  isLoading: boolean,
): ThemeSettings | null {
  if (isLoading) {
    return null;
  }
  if (JSON.stringify(form) === JSON.stringify(lastSaved)) {
    return null;
  }
  return form;
}

/**
 * 合并背景图片列表：去重、截断到上限，并返回是否发生截断（供 UI 提示）。
 */
function appendBackgroundImages(
  existing: string[],
  additions: string[],
): { paths: string[]; overflow: boolean } {
  const merged = [...existing];
  for (const path of additions) {
    if (path && !merged.includes(path)) {
      merged.push(path);
    }
  }
  return {
    paths: merged.slice(0, BACKGROUND_IMAGE_LIMIT),
    overflow: merged.length > BACKGROUND_IMAGE_LIMIT,
  };
}

export function ThemeSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  // 初始值优先取 localStorage 主题缓存，避免加载完成前表单回退到默认主题导致预览闪烁。
  // isLoading 初始为 true：挂载必然要异步加载一次真实设置，期间跳过预览 useEffect，
  // 保留 useTheme 在进入面板前已应用到 document 的主题，避免出现"默认主题→真实主题"的切换。
  const initialSettings = useMemo<ThemeSettings>(
    () => readThemeCache() ?? DEFAULT_THEME_SETTINGS,
    [],
  );
  const [form, setForm] = useState<ThemeSettings>(initialSettings);
  const [lastSaved, setLastSaved] = useState<ThemeSettings>(initialSettings);
  const [pets, setPets] = useState<PetManifest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [editorTab, setEditorTab] = useState<EditorTab>("light");
  const [editorOpen, setEditorOpen] = useState(false);
  const [aiColorOpen, setAiColorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [characterCardOpen, setCharacterCardOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [raw, installedPets] = await Promise.all([
        window.snow.getThemeSettings(),
        // 宠物背景来源需要已安装宠物列表，失败时降级为空列表。
        window.snow.listInstalledPets().catch(() => [] as PetManifest[]),
      ]);
      const normalized = normalizeThemeSettings(raw);
      setForm(normalized);
      setLastSaved(normalized);
      setPets(installedPets);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeLoadError", {
              defaultValue: "Failed to load theme settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 外部主题变更（如快捷键调整界面字号）时同步表单：仅在无未保存改动
  // （form 与 lastSaved 一致）时重载，避免覆盖用户正在编辑的内容。
  // 例外：背景「当前图」的节流回写（带 THEME_CHANGED_SOURCE_BG_CURRENT
  // 标记）只改了 currentImagePath 且表单已同步过，重载没有收益，反而会让
  // 面板在每次自动切换后闪一次「加载中」禁用态，故直接跳过。
  const formRef = useRef(form);
  const lastSavedRef = useRef(lastSaved);
  formRef.current = form;
  lastSavedRef.current = lastSaved;
  useEffect(() => {
    const handleExternalThemeChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source === THEME_CHANGED_SOURCE_BG_CURRENT) {
        return;
      }
      if (
        JSON.stringify(formRef.current) !== JSON.stringify(lastSavedRef.current)
      ) {
        return;
      }
      void load();
    };
    window.addEventListener("theme:changed", handleExternalThemeChange);
    return () => {
      window.removeEventListener("theme:changed", handleExternalThemeChange);
    };
  }, [load]);

  // 图层组件（轮播切换 / 列表对齐）更新当前显示图时同步表单，
  // 避免面板后续保存把「当前图」回退成旧值。
  // 注意：「当前图」由图层负责节流持久化，不构成面板的未保存改动；
  // 因此 lastSaved 的同一字段一并同步，否则表单会被判定为「脏」，
  // 触发 useDebouncedAutoSave 的整表保存并弹出「主题设置已保存」提示。
  useEffect(() => {
    const handleCurrentImageChanged = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail !== "string" || !detail) {
        return;
      }
      // form 与 lastSaved 同步更新：前者防保存回退，后者防误触发自动保存。
      const syncCurrentImagePath = (previous: ThemeSettings): ThemeSettings => {
        if (previous.background.currentImagePath === detail) {
          return previous;
        }
        return {
          ...previous,
          background: { ...previous.background, currentImagePath: detail },
        };
      };
      setForm(syncCurrentImagePath);
      setLastSaved(syncCurrentImagePath);
    };
    window.addEventListener(THEME_BG_CURRENT_EVENT, handleCurrentImageChanged);
    return () => {
      window.removeEventListener(
        THEME_BG_CURRENT_EVENT,
        handleCurrentImageChanged,
      );
    };
  }, []);

  // 实时预览：表单变化时即时应用到 document，但不持久化。
  useEffect(() => {
    if (isLoading) {
      return;
    }
    const systemDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    // 根据 mode 计算当前生效的亮/暗，而非直接用 systemDark。
    // 否则用户选"浅色"但系统是深色时仍会取深色调色板。
    const effectiveDark =
      form.mode === "system" ? systemDark : form.mode === "dark";
    applyThemeModeToDocument(form.mode);
    applyThemePresetToDocument(form.presetId);
    applyLayoutStyleToDocument(form.layoutStyle);
    const palette = resolveActivePalette(form, effectiveDark);
    applyPaletteToDocument(palette);

    // 预览字体和流式光标配置。
    applyFontFamilyToDocument(form.fontFamily);
    applyStreamCursorToDocument(form.streamCursor);
    applyTypographyToDocument(form.typography);
    applyChatStyleToDocument(form.chatStyle);

    // 同步窗口背景色到主进程，使 Electron 窗口背景跟随预览。
    const bgPrimary = palette.bgPrimary;
    if (bgPrimary && typeof window !== "undefined" && window.snow) {
      void window.snow.setThemeBackgroundColor(bgPrimary).catch(() => {
        // 忽略同步失败。
      });
    }

    syncMacTrafficLightPosition();

    // 背景层：图片由 CSS 变量铺满，宠物由渲染层画布绘制 idle 动画。
    applyBackgroundToDocument(form.background);
    // 广播实时预览，让宠物背景层无需等待持久化即可切换来源 / 宠物。
    window.dispatchEvent(
      new CustomEvent(THEME_BG_PREVIEW_EVENT, { detail: form.background }),
    );
  }, [form, isLoading]);

  const previewPalette = useMemo<ThemePalette>(() => {
    const systemDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const effectiveDark =
      form.mode === "system" ? systemDark : form.mode === "dark";
    return resolveActivePalette(form, effectiveDark);
  }, [form]);

  const handleModeChange = (mode: ThemeMode): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, mode }));
  };

  const handleLayoutStyleChange = (layoutStyle: ThemeLayoutStyle): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, layoutStyle }));
  };

  const handlePresetSelect = (presetId: string): void => {
    setForm((previous: ThemeSettings) => {
      if (presetId === "custom") {
        return { ...previous, presetId };
      }
      const preset = getPresetById(presetId);
      if (!preset) {
        return previous;
      }
      // 切换到预设时，将预设的调色板复制到 custom，作为后续自定义的起点。
      return {
        ...previous,
        presetId,
        custom: {
          light: { ...preset.light },
          dark: { ...preset.dark },
        },
      };
    });
  };

  const handleEnableCustom = (enabled: boolean): void => {
    if (enabled) {
      setForm((previous: ThemeSettings) => {
        const preset = getPresetById(previous.presetId);
        const baseLight = preset?.light ?? previous.custom.light;
        const baseDark = preset?.dark ?? previous.custom.dark;
        return {
          ...previous,
          presetId: "custom",
          custom: {
            light: { ...baseLight },
            dark: { ...baseDark },
          },
        };
      });
    } else {
      // 关闭自定义时回退到 snow 预设。
      const fallback = getPresetById("snow");
      if (fallback) {
        setForm((previous: ThemeSettings) => ({
          ...previous,
          presetId: "snow",
          custom: {
            light: { ...fallback.light },
            dark: { ...fallback.dark },
          },
        }));
      }
    }
  };

  const handleOpenEditor = (): void => {
    // 打开编辑器时，若尚未启用自定义，则把当前预设调色板复制到 custom 作为编辑起点；
    // 这里不切换 presetId，只有真正改动颜色时才切换（见 handleColorChange）。
    setForm((previous: ThemeSettings) => {
      if (previous.presetId === "custom") {
        return previous;
      }
      const preset = getPresetById(previous.presetId);
      if (!preset) {
        return previous;
      }
      return {
        ...previous,
        custom: {
          light: { ...preset.light },
          dark: { ...preset.dark },
        },
      };
    });
    setEditorOpen(true);
  };

  const handleColorChange = (role: keyof ThemePalette, value: string): void => {
    setForm((previous: ThemeSettings) => {
      // 未启用自定义时编辑会先基于当前预设的调色板，
      // 并在真正改动颜色时自动切换到 custom。
      const preset =
        previous.presetId === "custom"
          ? undefined
          : getPresetById(previous.presetId);
      const baseLight = preset?.light ?? previous.custom.light;
      const baseDark = preset?.dark ?? previous.custom.dark;
      const baseCustom =
        previous.presetId === "custom"
          ? previous.custom
          : { light: { ...baseLight }, dark: { ...baseDark } };
      return {
        ...previous,
        presetId: "custom",
        custom: {
          ...baseCustom,
          [editorTab]: {
            ...baseCustom[editorTab],
            [role]: value,
          },
        },
      };
    });
  };

  const handleApplyAiPalette = (palette: {
    light: ThemePalette;
    dark: ThemePalette;
  }): void => {
    const nextSettings: ThemeSettings = {
      ...form,
      presetId: "custom",
      custom: {
        light: { ...palette.light },
        dark: { ...palette.dark },
      },
    };
    setForm(nextSettings);
    setAiColorOpen(false);
    setStatus(
      t("settings.themeAiColorApplied", {
        defaultValue:
          "AI palette applied. Adjust colors in the editor if needed.",
      }),
    );
    // AI 配色是一个完整的生成操作，应用后立即持久化，不依赖 600ms debounce，
    // 避免用户在 debounce 窗口内切换菜单导致保存丢失。
    void saveSettings(nextSettings);
  };

  const handleBackgroundChange = (background: ThemeBackground): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, background }));
  };

  /** 点击缩略图：把该图固定为背景并结束轮播（点选即固定的交互口径）。 */
  const handlePickImage = (imagePath: string): void => {
    setForm((previous: ThemeSettings) => ({
      ...previous,
      background: {
        ...previous.background,
        currentImagePath: imagePath,
        carouselEnabled: false,
      },
    }));
  };

  const handleFontChange = (fontFamily: string): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, fontFamily }));
  };

  const handleStreamCursorChange = (streamCursor: ThemeStreamCursor): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, streamCursor }));
  };

  const handleTypographyChange = (typography: ThemeTypography): void => {
    setForm((previous: ThemeSettings) => ({ ...previous, typography }));
  };

  const handleChatStyleToggle = (imMode: boolean): void => {
    setForm((previous: ThemeSettings) => ({
      ...previous,
      chatStyle: { ...previous.chatStyle, imMode },
    }));
  };

  const avatarPathKey = (
    role: ChatAvatarRole,
  ): "aiAvatarPath" | "userAvatarPath" =>
    role === "ai" ? "aiAvatarPath" : "userAvatarPath";

  const handleSelectChatAvatar = async (
    role: ChatAvatarRole,
  ): Promise<void> => {
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      const sourcePath = await window.snow.selectThemeStreamCursorImage(
        t("settings.themeChatStyleSelectAvatarTitle", {
          defaultValue: "Select avatar image",
        }),
      );
      if (!sourcePath) {
        return;
      }
      const key = avatarPathKey(role);
      const savedPath = await window.snow.saveThemeChatAvatar(sourcePath);
      const previousPath = formRef.current.chatStyle[key];
      setForm((previous: ThemeSettings) => ({
        ...previous,
        chatStyle: { ...previous.chatStyle, [key]: savedPath },
      }));
      // 新头像落盘后再清理旧文件，失败不影响替换
      if (previousPath) {
        void window.snow.deleteThemeChatAvatar(previousPath).catch(() => {});
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeChatStyleSaveAvatarError", {
              defaultValue: "Failed to save avatar",
            }),
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetChatAvatar = async (role: ChatAvatarRole): Promise<void> => {
    const key = avatarPathKey(role);
    const previousPath = formRef.current.chatStyle[key];
    if (!previousPath) {
      return;
    }
    setForm((previous: ThemeSettings) => ({
      ...previous,
      chatStyle: { ...previous.chatStyle, [key]: "" },
    }));
    await window.snow.deleteThemeChatAvatar(previousPath).catch(() => {});
  };

  // 角色卡写入表单并立即持久化：生成与手动编辑共用，避免 debounce 窗口内切换页面导致丢失。
  const persistCharacterCard = (
    card: ThemeCharacterCard,
    statusMessage: string,
  ): void => {
    const nextSettings: ThemeSettings = {
      ...formRef.current,
      chatStyle: { ...formRef.current.chatStyle, characterCard: card },
    };
    setForm(nextSettings);
    setStatus(statusMessage);
    void saveSettings(nextSettings);
  };

  const handleApplyCharacterCard = (card: ThemeCharacterCard): void => {
    setCharacterCardOpen(false);
    persistCharacterCard(
      card,
      t("settings.themeCharacterCardApplied", {
        defaultValue:
          "Character card applied and injected into the system prompt.",
      }),
    );
  };

  // 手动编辑保存：字段留空会被规范化裁剪，角色名为空则视为未生成角色卡。
  const handleSaveCharacterCard = (card: ThemeCharacterCard): void => {
    const normalized = normalizeThemeCharacterCard(card);
    if (!normalized.name) {
      return;
    }
    persistCharacterCard(
      normalized,
      t("settings.themeCharacterCardSaved", {
        defaultValue: "Character card saved.",
      }),
    );
  };

  // 启停只切换注入状态，卡片内容保留。
  const handleToggleCharacterCard = (enabled: boolean): void => {
    persistCharacterCard(
      { ...formRef.current.chatStyle.characterCard, enabled },
      enabled
        ? t("settings.themeCharacterCardEnabledStatus", {
            defaultValue:
              "Character card enabled and injected into the system prompt.",
          })
        : t("settings.themeCharacterCardDisabledStatus", {
            defaultValue:
              "Character card disabled. It is kept but no longer injected.",
          }),
    );
  };

  const handleRemoveCharacterCard = (): void => {
    const nextSettings: ThemeSettings = {
      ...formRef.current,
      chatStyle: {
        ...formRef.current.chatStyle,
        characterCard: EMPTY_CHARACTER_CARD,
      },
    };
    setForm(nextSettings);
    setStatus(
      t("settings.themeCharacterCardRemoved", {
        defaultValue: "Character card removed. It is no longer injected.",
      }),
    );
    void saveSettings(nextSettings);
  };

  const handleSelectCursorAsset = async (
    kind: StreamCursorAssetKind,
  ): Promise<void> => {
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      const sourcePath =
        kind === "svg"
          ? await window.snow.selectThemeStreamCursorSvg(
              t("settings.themeStreamCursorSelectDialogTitle", {
                defaultValue: "Select stream cursor SVG",
              }),
            )
          : kind === "image"
            ? await window.snow.selectThemeStreamCursorImage(
                t("settings.themeStreamCursorSelectImageDialogTitle", {
                  defaultValue: "Select stream cursor image",
                }),
              )
            : await window.snow.selectThemeStreamCursorScript(
                t("settings.themeStreamCursorSelectScriptDialogTitle", {
                  defaultValue: "Select stream cursor drawing script",
                }),
              );
      if (!sourcePath) {
        return;
      }
      // 替换时先删除旧文件，避免冗余文件堆积。
      const previousSvgPath = form.streamCursor.svgPath;
      if (previousSvgPath) {
        await window.snow
          .deleteThemeStreamCursorSvg(previousSvgPath)
          .catch(() => {
            // 旧文件删除失败不阻塞新文件上传。
          });
      }
      const savedPath =
        kind === "svg"
          ? await window.snow.saveThemeStreamCursorSvg(sourcePath)
          : kind === "image"
            ? await window.snow.saveThemeStreamCursorImage(sourcePath)
            : await window.snow.saveThemeStreamCursorScript(sourcePath);
      setForm((previous: ThemeSettings) => ({
        ...previous,
        streamCursor: {
          iconType:
            kind === "svg" ? "custom" : kind === "image" ? "image" : "canvas",
          lucideName: "",
          svgPath: savedPath,
          iconSize: previous.streamCursor.iconSize,
        },
      }));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : kind === "svg"
            ? t("settings.themeStreamCursorSaveError", {
                defaultValue: "Failed to save stream cursor SVG",
              })
            : kind === "image"
              ? t("settings.themeStreamCursorSaveImageError", {
                  defaultValue: "Failed to save stream cursor image",
                })
              : t("settings.themeStreamCursorSaveScriptError", {
                  defaultValue: "Failed to save stream cursor script",
                }),
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRemoveSvg = async (): Promise<void> => {
    const svgPath = form.streamCursor.svgPath;
    if (!svgPath) {
      return;
    }
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      await window.snow.deleteThemeStreamCursorSvg(svgPath);
      setForm((previous: ThemeSettings) => ({
        ...previous,
        streamCursor: {
          iconType: "dot",
          lucideName: "",
          svgPath: "",
          iconSize: previous.streamCursor.iconSize,
        },
      }));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeStreamCursorDeleteError", {
              defaultValue: "Failed to delete stream cursor SVG",
            }),
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleAddImages = async (): Promise<void> => {
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      const title = t("settings.themeBackgroundAddDialogTitle", {
        defaultValue: "Select background images",
      });
      const sourcePaths = await window.snow.selectThemeBackgroundImages(title);
      if (sourcePaths.length === 0) {
        return;
      }
      // 逐个复制进受管目录；单张失败不阻塞其余图片。
      const savedPaths: string[] = [];
      for (const sourcePath of sourcePaths) {
        try {
          savedPaths.push(
            await window.snow.saveThemeBackgroundImage(sourcePath),
          );
        } catch {
          // 跳过失败项。
        }
      }
      if (savedPaths.length === 0) {
        setError(
          t("settings.themeBackgroundSaveError", {
            defaultValue: "Failed to save background image",
          }),
        );
        return;
      }
      const existing = formRef.current.background.imagePaths;
      const merged = appendBackgroundImages(existing, savedPaths);
      // 首次添加背景图时透明度默认 0.2；已有图片时保留用户已调整的 opacity。
      setForm((previous: ThemeSettings) => ({
        ...previous,
        background: {
          ...previous.background,
          imagePaths: merged.paths,
          enabled: true,
          opacity: existing.length === 0 ? 0.2 : previous.background.opacity,
        },
      }));
      if (merged.overflow) {
        setStatus(
          t("settings.themeBackgroundLimitHint", {
            defaultValue: "Up to 30 images; extra ones were skipped.",
          }),
        );
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeBackgroundSaveError", {
              defaultValue: "Failed to save background image",
            }),
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRemoveImage = async (imagePath: string): Promise<void> => {
    setIsBusy(true);
    setError("");
    setStatus("");
    try {
      // 仅从列表移除；文件保留在受管目录中，可从「历史图片」重新加入。
      setForm((previous: ThemeSettings) => {
        if (!previous.background.imagePaths.includes(imagePath)) {
          return previous;
        }
        const nextPaths = previous.background.imagePaths.filter(
          (item) => item !== imagePath,
        );
        return {
          ...previous,
          background: {
            ...previous.background,
            imagePaths: nextPaths,
            enabled: previous.background.enabled && nextPaths.length > 0,
          },
        };
      });
    } finally {
      setIsBusy(false);
    }
  };

  /** 从「历史图片」弹窗把选中的历史图片加入列表（文件已在受管目录，无需复制）。 */
  const handleAddFromHistory = (paths: string[]): void => {
    if (paths.length === 0) {
      return;
    }
    const existing = formRef.current.background.imagePaths;
    const merged = appendBackgroundImages(existing, paths);
    setForm((previous: ThemeSettings) => ({
      ...previous,
      background: {
        ...previous.background,
        imagePaths: merged.paths,
        enabled: true,
        opacity: existing.length === 0 ? 0.2 : previous.background.opacity,
      },
    }));
    if (merged.overflow) {
      setStatus(
        t("settings.themeBackgroundLimitHint", {
          defaultValue: "Up to 30 images; extra ones were skipped.",
        }),
      );
    }
  };

  /** 从磁盘删除历史背景图文件；若该图仍在当前列表中则同步移除。 */
  const handleDeleteHistoryImage = async (imagePath: string): Promise<void> => {
    setError("");
    setStatus("");
    try {
      await window.snow.deleteThemeBackgroundImage(imagePath);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.themeBackgroundDeleteError", {
              defaultValue: "Failed to delete background image",
            }),
      );
      return;
    }
    setForm((previous: ThemeSettings) => {
      if (!previous.background.imagePaths.includes(imagePath)) {
        return previous;
      }
      const nextPaths = previous.background.imagePaths.filter(
        (item) => item !== imagePath,
      );
      return {
        ...previous,
        background: {
          ...previous.background,
          imagePaths: nextPaths,
          enabled: previous.background.enabled && nextPaths.length > 0,
        },
      };
    });
  };

  const saveSettings = useCallback(
    async (settings: ThemeSettings) => {
      // isMountedRef 仅守卫 React state 更新；writeThemeCache 和 theme:changed
      // 是纯副作用，即使组件已卸载也必须执行，确保 flush 保存后
      // localStorage 缓存与后端一致、全局 useTheme 能同步。
      const mounted = isMountedRef.current;
      if (mounted) {
        setIsSaving(true);
        setError("");
      }
      try {
        await window.snow.setThemeSettings(settings);
        // 即时更新 localStorage 主题缓存，确保下次启动时首屏即呈现新主题。
        // 必须在 isMountedRef 守卫之外，使组件卸载 flush 时也能写入缓存。
        writeThemeCache(settings);
        // 通知全局 useTheme Hook 重新加载，使 App 级状态与持久化数据同步。
        // 必须在 isMountedRef 守卫之外，使组件卸载 flush 时也能派发事件。
        window.dispatchEvent(new CustomEvent("theme:changed"));
        if (mounted) {
          setLastSaved(settings);
          setStatus(
            t("settings.themeSaveSuccess", {
              defaultValue: "Theme settings saved.",
            }),
          );
        }
      } catch (e) {
        if (mounted) {
          setError(
            e instanceof Error
              ? e.message
              : t("settings.themeSaveError", {
                  defaultValue: "Failed to save theme settings",
                }),
          );
        }
      } finally {
        if (mounted) {
          setIsSaving(false);
        }
      }
    },
    [t],
  );

  // 修改即保存：表单变化后 debounce 保存，卸载时立即冲刷避免丢失。
  const saveValue = useMemo(
    () => computeThemeSaveValue(form, lastSaved, isLoading),
    [form, lastSaved, isLoading],
  );
  useDebouncedAutoSave(saveValue, saveSettings, SAVE_DEBOUNCE_MS);

  const handleReset = (): void => {
    setForm(DEFAULT_THEME_SETTINGS);
    setError("");
    setStatus("");
    // 重置主题时一并清除窗口尺寸缓存，下次启动回退到默认窗口尺寸。
    // 清除失败不影响主题重置本身。
    void window.snow.clearWindowState().catch(() => {});
    // 立即持久化默认主题，避免 debounce 窗口内退出导致保存丢失。
    void saveSettings(DEFAULT_THEME_SETTINGS);
  };
  const handleTabChange = (tab: EditorTab): void => {
    setEditorTab(tab);
  };

  const busy = isLoading || isSaving || isBusy;
  const isCustom = form.presetId === "custom";
  // AI 配色按钮仅在用户已上传背景图（图片来源）时显示。
  const hasBackgroundImage =
    form.background.source === "image" && form.background.imagePaths.length > 0;
  // 弹窗中始终编辑 custom 调色板，与是否启用自定义无关。
  const currentPalette =
    editorTab === "light" ? form.custom.light : form.custom.dark;

  return (
    <div className="api-settings-page theme-settings-page" role="region">
      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div className="api-settings-manual-form theme-settings-form">
        <div className="api-settings-form-body">
          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themeMode", {
                  defaultValue: "Appearance mode",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.themeModeInfo", {
                    defaultValue:
                      "Choose whether the app follows the system, stays light, or stays dark.",
                  })}
                />
              </strong>
            </div>
            <ThemeModeSelector
              mode={form.mode}
              disabled={busy}
              onChange={handleModeChange}
            />
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themeLayoutStyle", {
                  defaultValue: "Layout style",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.themeLayoutStyleInfo", {
                    defaultValue:
                      "Island keeps three separate cards (default); Layered blends the sidebar into the background and stacks the main area and right panel over each other.",
                  })}
                />
              </strong>
            </div>
            <ThemeLayoutStyleSelector
              layoutStyle={form.layoutStyle}
              disabled={busy}
              onChange={handleLayoutStyleChange}
            />
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themeTranscriptStyle", {
                  defaultValue: "Transcript display",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.themeTranscriptStyleInfo", {
                    defaultValue:
                      "How tool calls appear in the transcript. Classic keeps full tool cards, Chips compacts them into pill rows, Minimal hides thinking and merges tools into one group. Press {{shortcut}} to cycle.",
                    values: { shortcut: TOOL_CARD_STYLE_SHORTCUT_KEY },
                  })}
                />
              </strong>
            </div>
            <ThemeTranscriptStyleSelector disabled={busy} />
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themePresets", {
                  defaultValue: "Preset themes",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.themePresetsInfo", {
                    defaultValue:
                      "Pick a built-in color scheme. Light and dark variants are bundled together.",
                  })}
                />
              </strong>
            </div>
            <ThemePresetGrid
              selectedPresetId={form.presetId}
              disabled={busy}
              onSelect={handlePresetSelect}
            />
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themeCustomTitle", {
                  defaultValue: "Custom theme",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.themeCustomInfo", {
                    defaultValue:
                      "Fine-tune every color. Light and dark palettes are edited separately; editing a color switches to the custom theme.",
                  })}
                />
              </strong>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={isCustom}
                  onChange={(event) => handleEnableCustom(event.target.checked)}
                  disabled={busy}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {isCustom
                    ? t("settings.enabled", {
                        defaultValue: "Enabled",
                      })
                    : t("settings.disabled", {
                        defaultValue: "Disabled",
                      })}
                </span>
              </label>
            </div>
            <div className="api-settings-form-actions theme-custom-edit-action">
              <button
                className="api-settings-form-btn secondary"
                onClick={handleOpenEditor}
                type="button"
                disabled={busy}
              >
                <Pencil size={14} strokeWidth={1.9} />
                <span>{t("settings.edit", { defaultValue: "Edit" })}</span>
              </button>
              {hasBackgroundImage ? (
                <button
                  className="api-settings-form-btn secondary"
                  onClick={() => setAiColorOpen(true)}
                  type="button"
                  disabled={busy}
                  title={t("settings.themeAiColorButtonTitle", {
                    defaultValue:
                      "Generate a palette from the background image",
                  })}
                >
                  <Sparkles size={14} strokeWidth={1.9} />
                  <span>
                    {t("settings.themeAiColorButton", {
                      defaultValue: "AI palette",
                    })}
                  </span>
                </button>
              ) : null}
            </div>
          </div>

          <ThemeBackgroundSection
            background={form.background}
            pets={pets}
            disabled={busy}
            busy={isBusy}
            onChange={handleBackgroundChange}
            onAddImages={handleAddImages}
            onRemoveImage={handleRemoveImage}
            onPickImage={handlePickImage}
            onOpenHistory={() => setHistoryOpen(true)}
          />

          <ThemeFontSection
            fontFamily={form.fontFamily}
            disabled={busy}
            onChange={handleFontChange}
          />

          <ThemeTypographySection
            typography={form.typography}
            disabled={busy}
            onChange={handleTypographyChange}
          />

          <ThemeStreamCursorSection
            cursor={form.streamCursor}
            disabled={busy}
            busy={isBusy}
            onChange={handleStreamCursorChange}
            onSelectAsset={handleSelectCursorAsset}
            onRemoveSvg={handleRemoveSvg}
          />

          <ThemeChatStyleSection
            chatStyle={form.chatStyle}
            disabled={busy}
            onToggle={handleChatStyleToggle}
            onSelectAvatar={handleSelectChatAvatar}
            onResetAvatar={handleResetChatAvatar}
            onGenerateCharacterCard={() => setCharacterCardOpen(true)}
            onSaveCharacterCard={handleSaveCharacterCard}
            onToggleCharacterCard={handleToggleCharacterCard}
            onRemoveCharacterCard={handleRemoveCharacterCard}
          />

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.themePreviewTitle", {
                  defaultValue: "Preview",
                })}
              </strong>
            </div>
            <ThemePreview palette={previewPalette} />
          </div>
        </div>

        <div className="api-settings-form-actions">
          <button
            className="api-settings-form-btn secondary"
            onClick={handleReset}
            type="button"
            disabled={busy}
          >
            <RotateCcw size={15} strokeWidth={1.9} />
            <span>{t("settings.reset", { defaultValue: "Reset" })}</span>
          </button>
        </div>
      </div>

      <Modal
        open={editorOpen}
        title={t("settings.themeCustomTitle", {
          defaultValue: "Custom theme",
        })}
        closeLabel={t("settings.closeThemeSettings", {
          defaultValue: "Close theme settings",
        })}
        onClose={() => setEditorOpen(false)}
        size="large"
      >
        <div className="theme-custom-editor">
          <div className="theme-custom-editor-tabs">
            <CustomSelect
              value={editorTab}
              onChange={(value) => handleTabChange(value as EditorTab)}
              disabled={busy}
              options={[
                {
                  value: "light",
                  label: t("settings.themeTabLight", {
                    defaultValue: "Light palette",
                  }),
                },
                {
                  value: "dark",
                  label: t("settings.themeTabDark", {
                    defaultValue: "Dark palette",
                  }),
                },
              ]}
            />
          </div>
          <ThemeColorEditor
            palette={currentPalette}
            disabled={busy}
            onChange={handleColorChange}
          />
        </div>
      </Modal>

      <ThemeAiColorModal
        open={aiColorOpen}
        imagePath={form.background.imagePaths[0] ?? ""}
        onClose={() => setAiColorOpen(false)}
        onApply={handleApplyAiPalette}
      />

      <ThemeBackgroundHistoryModal
        open={historyOpen}
        activePaths={form.background.imagePaths}
        onClose={() => setHistoryOpen(false)}
        onAdd={handleAddFromHistory}
        onDelete={handleDeleteHistoryImage}
      />

      <ThemeCharacterCardModal
        open={characterCardOpen}
        avatarPath={form.chatStyle.aiAvatarPath}
        onClose={() => setCharacterCardOpen(false)}
        onApply={handleApplyCharacterCard}
      />
    </div>
  );
}
