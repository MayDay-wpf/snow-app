import { Puzzle } from "lucide-react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { resolvePluginIcon } from "./manifest";
import { pluginStore } from "./pluginStore";
import { resolveLucideIcon } from "./pluginRuntime";
import { imageProxyUrl } from "../utils/imageProxyUrl";

/** 编辑区 chip 图标尺寸，与既有文件 / 技能 chip 一致。 */
const ICON_SIZE = 12;

/** 与 PluginIcon 的缺省图标（Puzzle）一致。 */
const PLACEHOLDER_ICON_HTML = renderToStaticMarkup(
  createElement(Puzzle, {
    size: ICON_SIZE,
    className: "file-chip-icon-inner",
    "aria-hidden": true,
  }),
);

const iconCache = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();

const cacheKey = (pluginId: string, icon: string): string =>
  `${pluginId}\u0000${icon}`;

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 把已解析的图标 HTML 补到编辑区中同插件的 chip 上。 */
const paintChipIcons = (pluginId: string): void => {
  const plugin = pluginStore.getById(pluginId);
  const html = plugin
    ? iconCache.get(cacheKey(pluginId, plugin.icon))
    : undefined;
  if (!html) {
    return;
  }
  const elements = document.querySelectorAll<HTMLElement>(
    "[data-plugin-chip-icon]",
  );
  for (const element of elements) {
    if (element.dataset.pluginChipIcon === pluginId) {
      element.innerHTML = html;
    }
  }
};

const loadIcon = async (pluginId: string): Promise<void> => {
  await pluginStore.ensureLoaded();
  const plugin = pluginStore.getById(pluginId);
  if (!plugin) {
    return;
  }
  const key = cacheKey(pluginId, plugin.icon);
  if (!iconCache.has(key)) {
    const resolved = resolvePluginIcon(plugin.icon);
    let html = PLACEHOLDER_ICON_HTML;
    if (resolved?.kind === "lucide") {
      const Icon = await resolveLucideIcon(resolved.name);
      if (Icon) {
        html = renderToStaticMarkup(
          createElement(
            Icon as ComponentType<{
              size?: number;
              className?: string;
              "aria-hidden"?: boolean;
            }>,
            {
              size: ICON_SIZE,
              className: "file-chip-icon-inner",
              "aria-hidden": true,
            },
          ),
        );
      }
    } else if (resolved?.kind === "asset") {
      const url = await window.snow.readPluginAsset(pluginId, resolved.path);
      if (url) {
        html = `<img class="file-chip-icon-inner" src="${escapeAttribute(
          url,
        )}" width="${ICON_SIZE}" height="${ICON_SIZE}" alt="" />`;
      }
    } else if (resolved?.kind === "image") {
      html = `<img class="file-chip-icon-inner" src="${escapeAttribute(
        imageProxyUrl(resolved.src),
      )}" width="${ICON_SIZE}" height="${ICON_SIZE}" alt="" />`;
    }
    iconCache.set(key, html);
  }
  paintChipIcons(pluginId);
};

/**
 * 编辑区插件 chip 图标 HTML（同步）。
 *
 * chip 以 HTML 字符串插入 contenteditable，而 lucide 组件与插件目录资源
 * 只能异步解析：未命中缓存时先渲染占位图标，解析完成后按
 * `data-plugin-chip-icon` 就地补到已插入的 chip 上。
 */
export const getPluginChipIconHtml = (pluginId: string): string => {
  const plugin = pluginStore.getById(pluginId);
  const cached = plugin
    ? iconCache.get(cacheKey(pluginId, plugin.icon))
    : undefined;
  if (cached) {
    return cached;
  }
  if (!inflight.has(pluginId)) {
    const task = loadIcon(pluginId)
      .catch(() => undefined)
      .finally(() => {
        inflight.delete(pluginId);
      });
    inflight.set(pluginId, task);
  }
  return PLACEHOLDER_ICON_HTML;
};
