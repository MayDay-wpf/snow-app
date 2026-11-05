import { useMemo, useSyncExternalStore } from "react";

/**
 * 工具归属索引：工具插件暴露的工具全名为 `{publicServerName}-{工具名}`，
 * 据此把工具调用反查回提供它的插件，用于在工具卡片上标注来源、并让插件
 * 优先接管自身工具的自带渲染器。
 *
 * 只在首次订阅时发现一次；发现失败时保持空索引（工具卡片不显示归属，
 * 不影响卡片本身）。
 */
export type PluginToolOwner = {
  pluginId: string;
  /** 插件清单内的原始工具名（不含公开服务器名前缀）。 */
  toolName: string;
};

const EMPTY_INDEX: ReadonlyMap<string, PluginToolOwner> = new Map();

let index: ReadonlyMap<string, PluginToolOwner> = EMPTY_INDEX;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const commit = (next: ReadonlyMap<string, PluginToolOwner>): void => {
  index = next;
  for (const listener of listeners) {
    listener();
  }
};

const load = async (): Promise<void> => {
  try {
    const servers = await window.snow.listPluginTools();
    const next = new Map<string, PluginToolOwner>();
    for (const server of servers) {
      for (const tool of server.tools) {
        next.set(`${server.publicServerName}-${tool.name}`, {
          pluginId: server.pluginId,
          toolName: tool.name,
        });
      }
    }
    commit(next);
  } catch (error) {
    console.error("Failed to load plugin tools:", error);
    commit(EMPTY_INDEX);
  } finally {
    loaded = true;
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (!loaded && !inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): ReadonlyMap<string, PluginToolOwner> => index;

/** 工具调用所属的工具插件与原始工具名；无归属时返回 null。 */
export const usePluginToolOwnerInfo = (
  toolName: string,
): PluginToolOwner | null => {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return current.get(toolName) ?? null;
};

/** 工具调用所属的工具插件 id；无归属时返回 null。 */
export const usePluginToolOwner = (toolName: string): string | null =>
  usePluginToolOwnerInfo(toolName)?.pluginId ?? null;

/** 批量反查一组工具调用涉及的所有插件 id（去重并保序）。 */
export const usePluginToolOwners = (toolNames: string[]): string[] => {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const ids = new Set<string>();
    for (const name of toolNames) {
      const owner = current.get(name);
      if (owner) {
        ids.add(owner.pluginId);
      }
    }
    return Array.from(ids);
  }, [current, toolNames]);
};
