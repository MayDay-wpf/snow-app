import type { Locale } from "../../shared/locale";
import type { PluginRecord } from "../../preload/types/plugins";
import type {
  PluginChatInputMenuAction,
  PluginLocalizedMap,
  PluginMessageFooterDefinition,
  PluginPanelDefinition,
  PluginRenderMode,
  PluginToolCallRendererDefinition,
  PluginView,
} from "./types";
import { isSensitiveScope } from "./types";

const parseJson = <T>(raw: string, fallback: T): T => {
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const normalizeLocalizedMap = (value: unknown): PluginLocalizedMap => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { default: trimmed } : {};
  }
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: PluginLocalizedMap = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed) {
      result[key] = trimmed;
    }
  }
  return result;
};

const PRIMARY_LOCALE_TAG: Record<Locale, string> = {
  en: "en",
  "zh-CN": "zh",
  "zh-TW": "zh",
};

export const resolveLocalized = (
  map: PluginLocalizedMap,
  locale: Locale,
): string => {
  if (map[locale]) {
    return map[locale];
  }
  const lower = locale.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  const primary = PRIMARY_LOCALE_TAG[locale];
  for (const [key, value] of Object.entries(map)) {
    const normalized = key.toLowerCase();
    if (normalized === primary || normalized.split("-")[0] === primary) {
      return value;
    }
  }
  return map.default ?? Object.values(map)[0] ?? "";
};

/** 依据应用语言挑选插件的语言包文件路径。 */
export const pickLocaleFile = (
  locales: Record<string, string>,
  locale: Locale,
): string | null => {
  if (locales[locale]) {
    return locales[locale];
  }
  const lower = locale.toLowerCase();
  for (const [key, value] of Object.entries(locales)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  const primary = PRIMARY_LOCALE_TAG[locale];
  for (const [key, value] of Object.entries(locales)) {
    if (key.toLowerCase().split("-")[0] === primary) {
      return value;
    }
  }
  return locales.default ?? Object.values(locales)[0] ?? null;
};

const ACTION_EXPORT_NAME =
  /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u;
const CONTRIBUTION_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const normalizeChatInputMenuActions = (
  value: unknown,
): PluginChatInputMenuAction[] => {
  if (!Array.isArray(value)) return [];
  const result: PluginChatInputMenuAction[] = [];
  const ids = new Set<string>();
  // Bound work even when a manifest contains many invalid entries.
  for (const item of value.slice(0, 32)) {
    if (result.length === 8) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === "string" && record.id.length <= 64
        ? record.id.trim()
        : "";
    const action =
      typeof record.action === "string" && record.action.length <= 128
        ? record.action.trim()
        : "";
    if (
      !CONTRIBUTION_ID.test(id) ||
      ids.has(id) ||
      !ACTION_EXPORT_NAME.test(action) ||
      record.entry !== undefined
    )
      continue;
    const rawTitle = record.title;
    const boundedTitle: PluginLocalizedMap = Object.create(null);
    if (typeof rawTitle === "string" && rawTitle.length <= 256) {
      boundedTitle.default = rawTitle;
    } else if (
      rawTitle &&
      typeof rawTitle === "object" &&
      !Array.isArray(rawTitle)
    ) {
      let scanned = 0;
      for (const key in rawTitle) {
        if (++scanned > 16) break;
        if (
          !Object.hasOwn(rawTitle, key) ||
          key.length > 64 ||
          key === "__proto__"
        )
          continue;
        const text = (rawTitle as Record<string, unknown>)[key];
        if (typeof text === "string" && text.length <= 256)
          boundedTitle[key] = text;
      }
    }
    const title = normalizeLocalizedMap(boundedTitle);
    if (!Object.keys(title).length) continue;
    ids.add(id);
    result.push({
      id,
      action,
      title,
      ...(typeof record.icon === "string" && record.icon.length <= 256
        ? { icon: record.icon.trim() }
        : {}),
    });
  }
  return result;
};

const normalizePanels = (value: unknown): PluginPanelDefinition[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const panels: PluginPanelDefinition[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      continue;
    }
    panels.push({
      id,
      chatInput: record.chatInput === true,
      chatInputAction:
        typeof record.chatInputAction === "string" &&
        ACTION_EXPORT_NAME.test(record.chatInputAction.trim())
          ? record.chatInputAction.trim()
          : "",
      chatInputTitle: normalizeLocalizedMap(record.chatInputTitle),
      title: normalizeLocalizedMap(record.title),
      entry: typeof record.entry === "string" ? record.entry.trim() : "",
      icon: typeof record.icon === "string" ? record.icon.trim() : "",
      widthHint:
        typeof record.widthHint === "string" ? record.widthHint.trim() : "",
    });
  }
  return panels;
};

const normalizeMessageFooters = (
  record: PluginRecord,
): PluginMessageFooterDefinition[] => {
  if (record.renderMode !== "esm") return [];
  const manifest = parseJson<unknown>(record.manifestJson, null);
  if (!manifest || typeof manifest !== "object") return [];
  const contributions = (manifest as Record<string, unknown>).contributions;
  if (!contributions || typeof contributions !== "object") return [];
  const items = (contributions as Record<string, unknown>).messageFooters;
  if (!Array.isArray(items)) return [];
  const result: PluginMessageFooterDefinition[] = [];
  const ids = new Set<string>();
  for (const item of items.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const exportName =
      typeof value.exportName === "string" ? value.exportName.trim() : "";
    // Only an omitted entry falls back; a supplied invalid path is rejected.
    const entry = value.entry === undefined ? record.entry : value.entry;
    if (
      !CONTRIBUTION_ID.test(id) ||
      ids.has(id) ||
      !ACTION_EXPORT_NAME.test(exportName) ||
      typeof entry !== "string" ||
      !entry ||
      entry !== entry.trim() ||
      /[\\\x00-\x1f\x7f:%?#]/.test(entry) ||
      entry.split("/").some((part) => !part || part === "." || part === "..")
    )
      continue;
    ids.add(id);
    result.push({
      id,
      entry,
      exportName,
      ...(value.taskHistory === true ? { taskHistory: true } : {}),
    });
  }
  return result;
};

const normalizeToolCallRenderers = (
  record: PluginRecord,
): PluginToolCallRendererDefinition[] => {
  if (
    record.renderMode !== "esm" ||
    !Array.isArray(record.privacy) ||
    !record.privacy.includes("messages")
  )
    return [];
  const manifest = parseJson<unknown>(record.manifestJson, null);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return [];
  const contributions = (manifest as Record<string, unknown>).contributions;
  if (
    !contributions ||
    typeof contributions !== "object" ||
    Array.isArray(contributions)
  )
    return [];
  const items = (contributions as Record<string, unknown>).toolCallRenderers;
  if (!Array.isArray(items)) return [];
  const result: PluginToolCallRendererDefinition[] = [];
  const ids = new Set<string>();
  const selectors = (value: unknown, prefix: boolean): string[] => {
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value
          .slice(0, 128)
          .filter(
            (item): item is string =>
              typeof item === "string" &&
              item.length <= 128 &&
              item.length >= (prefix ? 3 : 1) &&
              /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(item),
          ),
      ),
    ];
  };
  for (const item of items.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const id =
      typeof value.id === "string" && value.id.length <= 64
        ? value.id.trim()
        : "";
    const exportName =
      typeof value.exportName === "string" && value.exportName.length <= 128
        ? value.exportName.trim()
        : "";
    const entry = value.entry === undefined ? record.entry : value.entry;
    if (
      !CONTRIBUTION_ID.test(id) ||
      ids.has(id) ||
      !ACTION_EXPORT_NAME.test(exportName) ||
      typeof entry !== "string" ||
      !entry ||
      entry.length > 256 ||
      entry !== entry.trim() ||
      /[\\\x00-\x1f\x7f:%?#]/.test(entry) ||
      entry.split("/").some((part) => !part || part === "." || part === "..")
    )
      continue;
    const tools = selectors(value.tools, false);
    const prefixes = selectors(value.prefixes, true);
    if (!tools.length && !prefixes.length) continue;
    const priority = value.priority === undefined ? 0 : value.priority;
    if (
      typeof priority !== "number" ||
      !Number.isSafeInteger(priority) ||
      Math.abs(priority) > 1000
    )
      continue;
    ids.add(id);
    result.push({ id, entry, exportName, tools, prefixes, priority });
  }
  return result;
};

// Read renderer-only contributions from the saved manifest: older native panel
// normalization deliberately keeps only its known fields. No native upgrade needed.
const panelsWithSettings = (record: PluginRecord): PluginPanelDefinition[] => {
  const panels = normalizePanels(parseJson(record.panels, []));
  const manifest = parseJson<Record<string, unknown>>(record.manifestJson, {});
  const rawPanels =
    manifest && Array.isArray(manifest.panels) ? manifest.panels : [];
  return panels.map((panel) => {
    const raw = rawPanels.find(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        item.id.trim() === panel.id,
    );
    const settings = raw?.chatInputSettings;
    // Menu parsing must not depend on a settings-gear preference being valid.
    const chatInputMenuActions =
      record.renderMode === "esm" && panel.chatInput && panel.chatInputAction
        ? normalizeChatInputMenuActions(raw?.chatInputMenuActions)
        : [];
    const chatInputSettings =
      settings &&
      typeof settings === "object" &&
      !Array.isArray(settings) &&
      typeof settings.storageKey === "string" &&
      settings.storageKey.trim()
        ? {
            defaultVisible: settings.defaultVisible !== false,
            storageKey: settings.storageKey.trim(),
          }
        : undefined;
    return {
      ...panel,
      ...(chatInputMenuActions.length ? { chatInputMenuActions } : {}),
      ...(chatInputSettings ? { chatInputSettings } : {}),
    };
  });
};

const readOAuthEntry = (record: PluginRecord): string => {
  const manifest = parseJson<Record<string, unknown> | null>(
    record.manifestJson,
    null,
  );
  const oauth = manifest?.oauth;
  if (!oauth || typeof oauth !== "object") {
    return "";
  }
  const entry = (oauth as Record<string, unknown>).entry;
  return typeof entry === "string" ? entry.trim() : "";
};

export const parsePluginRecord = (record: PluginRecord): PluginView => {
  const oauthEntry = readOAuthEntry(record);
  return {
    pluginId: record.pluginId,
    name: normalizeLocalizedMap(parseJson(record.name, {})),
    description: normalizeLocalizedMap(parseJson(record.description, {})),
    version: record.version,
    author: record.author,
    homepage: record.homepage,
    license: record.license,
    icon: record.icon,
    renderMode: (record.renderMode === "iframe"
      ? "iframe"
      : "esm") as PluginRenderMode,
    entry: record.entry,
    oauthEntry,
    // 清单声明的类型为准；缺省（旧记录）时按 oauth.entry 推导。
    kind:
      record.kind === "oauth" || Boolean(oauthEntry)
        ? "oauth"
        : record.kind === "tool"
          ? "tool"
          : "plugin",
    panels: panelsWithSettings(record),
    messageFooters: normalizeMessageFooters(record),
    toolCallRenderers: normalizeToolCallRenderers(record),
    locales: parseJson(record.locales, {}),
    styles: parseJson<string[]>(record.styles, []).filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    ),
    privacy: Array.isArray(record.privacy)
      ? record.privacy.filter(isSensitiveScope)
      : [],
    privacyNote: record.privacyNote,
    minAppVersion: record.minAppVersion,
    enabled: record.enabled,
    installPath: record.installPath,
    sourcePath: record.sourcePath,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

/** 插件图标：lucide:IconName / 插件内相对路径 / http(s) 或 data:image URL。 */
export const resolvePluginIcon = (
  icon: string,
):
  | { kind: "lucide"; name: string }
  | { kind: "asset"; path: string }
  | { kind: "image"; src: string }
  | null => {
  const trimmed = icon.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase().startsWith("lucide:")) {
    return { kind: "lucide", name: trimmed.slice("lucide:".length).trim() };
  }
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return { kind: "image", src: trimmed };
  }
  return { kind: "asset", path: trimmed };
};

const localeTagCandidates = (locale: Locale): string[] => {
  if (locale === "zh-CN") {
    return ["zh-CN", "zh", "en"];
  }
  if (locale === "zh-TW") {
    return ["zh-TW", "zh", "en"];
  }
  return ["en", "zh-CN", "zh"];
};

/** 读取插件语言包（缺失时返回空表，调用方回退到插件自带文案）。 */
export const loadPluginMessages = async (
  plugin: PluginView,
  locale: Locale,
  signal?: AbortSignal,
): Promise<Record<string, string>> => {
  signal?.throwIfAborted();
  const direct = pickLocaleFile(plugin.locales, locale);
  if (direct) {
    try {
      const raw = await window.snow.readPluginFile(plugin.pluginId, direct);
      signal?.throwIfAborted();
      return parseJson<Record<string, string>>(raw, {});
    } catch {
      signal?.throwIfAborted();
      return {};
    }
  }

  for (const tag of localeTagCandidates(locale)) {
    signal?.throwIfAborted();
    const candidate = plugin.locales[tag];
    if (!candidate) {
      continue;
    }
    try {
      const raw = await window.snow.readPluginFile(plugin.pluginId, candidate);
      signal?.throwIfAborted();
      return parseJson<Record<string, string>>(raw, {});
    } catch {
      signal?.throwIfAborted();
      continue;
    }
  }
  return {};
};
