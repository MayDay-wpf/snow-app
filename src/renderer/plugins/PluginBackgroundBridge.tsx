import { useEffect } from "react";

import { useI18n } from "../i18n";
import type { PluginBackgroundRequest } from "../../preload/types/plugins";
import { collectMetadata, describeMetadataDomains } from "./metadata";
import { pluginStore } from "./pluginStore";
import type { PluginView } from "./types";
import { describeWriteDomains, executeWrite } from "./writes";

/**
 * 常驻后台模块（主进程）的渲染层执行端：按插件身份执行元数据读取与写动作，
 * 与插件面板走同一套隐私声明校验。后台模块本身不持有渲染上下文，因此
 * 所有 RPC 都在这里以插件视图为准完成授权判断。
 */
const resolvePlugin = async (pluginId: string): Promise<PluginView> => {
  await pluginStore.ensureLoaded();
  const plugin = pluginStore
    .getState()
    .plugins.find((item) => item.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Plugin '${pluginId}' is not installed`);
  }
  if (!plugin.enabled) {
    throw new Error(`Plugin '${pluginId}' is disabled`);
  }
  return plugin;
};

const readStringArg = (args: Record<string, unknown>, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Parameter '${name}' must be a non-empty string`);
  }
  return value.trim();
};

const readParams = (args: Record<string, unknown>): Record<string, unknown> =>
  args.params && typeof args.params === "object" && !Array.isArray(args.params)
    ? (args.params as Record<string, unknown>)
    : {};

export const PluginBackgroundBridge = (): null => {
  const { locale } = useI18n();

  useEffect(() => {
    const dispatch = async (
      request: PluginBackgroundRequest,
    ): Promise<unknown> => {
      const plugin = await resolvePlugin(request.pluginId);
      switch (request.method) {
        case "metadata.get": {
          const domains = request.args.domains;
          const list = Array.isArray(domains)
            ? domains.filter((item): item is string => typeof item === "string")
            : [readStringArg(request.args, "domains")];
          return collectMetadata(plugin, locale, list, {
            params: readParams(request.args),
          });
        }
        case "metadata.domains":
          return describeMetadataDomains(plugin);
        case "write.run":
          return executeWrite({
            plugin,
            locale,
            actionId: readStringArg(request.args, "actionId"),
            params: readParams(request.args),
          });
        case "write.domains":
          return describeWriteDomains(plugin, locale);
        default:
          throw new Error(`Unknown background method '${request.method}'`);
      }
    };

    return window.snow.onPluginBackgroundRequest((request) => {
      dispatch(request)
        .then((result) => {
          window.snow.respondPluginBackground({
            id: request.id,
            ok: true,
            result,
          });
        })
        .catch((error: unknown) => {
          window.snow.respondPluginBackground({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  }, [locale]);

  return null;
};
