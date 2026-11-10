import { useEffect, useMemo, useSyncExternalStore } from "react";

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
          toolName: tool.originalName,
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

// The index is built once per session, so a tool that appears after a plugin install
// (or after a restart of the plugin server) is missing from it. A lookup miss schedules
// one bounded re-read instead of leaving the tool unowned forever.
let lastRefreshAt = 0;
const REFRESH_AFTER_MS = 2000;
// Bounded: a tool that is simply not a plugin tool must not keep re-reading the list.
let refreshesLeft = 5;

const refreshWhenUnknown = (): void => {
  if (inflight || refreshesLeft <= 0) return;
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_AFTER_MS) return;
  lastRefreshAt = now;
  refreshesLeft -= 1;
  inflight = load().finally(() => {
    inflight = null;
  });
};

/** 工具调用所属的工具插件与原始工具名；无归属时返回 null。 */
export const usePluginToolOwnerInfo = (
  toolName: string,
): PluginToolOwner | null => {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const owner = current.get(toolName) ?? null;
  useEffect(() => {
    if (!owner) refreshWhenUnknown();
  }, [owner, toolName]);
  return owner;
};

/** 工具调用所属的工具插件 id；无归属时返回 null。 */
export const usePluginToolOwner = (toolName: string): string | null =>
  usePluginToolOwnerInfo(toolName)?.pluginId ?? null;

/** 只有整组工具都属于同一插件时才返回组级归属，混合组和纯内置工具组返回 null。 */
export const useSharedPluginToolOwner = (
  toolNames: string[],
): string | null => {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const pluginId = useMemo(() => {
    if (toolNames.length === 0) return null;
    const owner = current.get(toolNames[0]);
    if (!owner) return null;
    return toolNames.every(
      (name) => current.get(name)?.pluginId === owner.pluginId,
    )
      ? owner.pluginId
      : null;
  }, [current, toolNames]);
  useEffect(() => {
    if (!pluginId) refreshWhenUnknown();
  }, [pluginId, toolNames]);
  return pluginId;
};
