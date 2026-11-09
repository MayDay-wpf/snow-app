/**
 * 工具显示名解析（工具卡片徽章与子代理活动列表共用）。
 *
 * 只查 `toolNames.<工具全名>` 词条（如 `filesystem-read`、`lsp-goto`）；
 * 内置工具必须全部收录，未收录的外部 MCP 工具回退为去掉 server 前缀的
 * 原始短名（`dbx_list_tables` → `list_tables`）。
 */

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string;

/**
 * 提取工具短名：内置工具按 `prefix-` 去掉服务器前缀；插件工具全名形如
 * `plugin_<sanitized>-<tool>`，按第一个连字符切分，避免把公开服务器名
 * 截断后残留的 `com_snow_do-` 一起显示出来。
 */
export const getToolShortName = (name: string): string => {
  if (name.startsWith("plugin_")) {
    const separator = name.indexOf("-");
    if (separator > 0 && separator < name.length - 1) {
      return name.slice(separator + 1);
    }
  }
  return name.replace(/^.*?[-_]/, "");
};

export const resolveToolDisplayName = (
  t: TranslateFn,
  toolName: string,
): string => {
  // 注意：用 `||` 而非 `??`——i18n 查找可能返回空字符串（defaultValue: ""），
  // 空字符串应视为"未收录"并继续走 fallback 链。
  const localized = t(`toolNames.${toolName}`, { defaultValue: "" });
  return localized || getToolShortName(toolName);
};
