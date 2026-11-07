import type { Locale } from "../../shared/locale";
import { resolveLocalized } from "./manifest";
import type { PluginView } from "./types";

/** 插件 chip 表达用户意图，是否可用由插件的全局和项目启用状态决定。 */

export type PluginTag = {
  pluginId: string;
  name: string;
};

/** 插件 chip 的悬停提示：插件名 + 本地化简介，与技能 chip 的 title 一致。 */
export const pluginMentionTitle = (
  name: string,
  plugin: PluginView | null,
  locale: Locale,
): string => {
  const description = plugin
    ? resolveLocalized(plugin.description, locale)
    : "";
  return description ? `${name} - ${description}` : name;
};

/** 将插件引用编码为 plugin chip（与 `@@skill:` 同格式）。 */
export const encodePluginTag = (tag: PluginTag): string =>
  `@@plugin:${JSON.stringify({
    pluginId: tag.pluginId,
    name: tag.name,
  })}@@`;
