import * as React from "react";
import type { Locale } from "../../../../../shared/locale";
import { useI18n } from "../../../../i18n";
import { loadPluginMessages } from "../../../../plugins/manifest";
import {
  createPluginToolCallApi,
  type PluginToolCallApi,
  type PluginToolCallContext,
  type PluginToolCallRenderer,
} from "../../../../plugins/pluginToolCall";
import {
  injectPluginStyles,
  loadLucideIcons,
  loadPluginModule,
  type PluginModuleExports,
} from "../../../../plugins/pluginRuntime";
import { pluginStore, usePluginStore } from "../../../../plugins/pluginStore";
import {
  usePluginToolOwnerInfo,
  type PluginToolOwner,
} from "../../../../plugins/pluginToolIndex";
import type {
  PluginToolCallRendererDefinition,
  PluginView,
} from "../../../../plugins/types";
import type { ToolCallInfo } from "../utils/conversationTypes";

type Match = {
  plugin: PluginView;
  definition: PluginToolCallRendererDefinition;
  exact: boolean;
  prefixLength: number;
};
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * 插件工具全名为 `plugin_<sanitized plugin/server>-<tool>`。公开服务器名由
 * 宿主派生，若归属索引尚未加载，插件渲染器仍可按最终短名匹配，避免首轮
 * 工具卡回退成 `com_snow_do-system_info` 这类未本地化名称。
 */
const pluginToolShortName = (fullName: string): string | null => {
  if (!fullName.startsWith("plugin_")) return null;
  const separator = fullName.indexOf("-");
  return separator > 0 && separator < fullName.length - 1
    ? fullName.slice(separator + 1)
    : null;
};

/**
 * 渲染器选择器匹配：`tools` 支持工具全名与清单内短名，`prefixes` 同样对
 * 两者生效。工具插件自己的渲染器通常只声明短名（公开服务器名由宿主派生，
 * 插件无从预知）。
 */
const matchesDefinition = (
  definition: PluginToolCallRendererDefinition,
  fullName: string,
  shortName: string | null,
): { exact: boolean; prefixLength: number } | null => {
  if (
    definition.tools.includes(fullName) ||
    (shortName !== null && definition.tools.includes(shortName))
  ) {
    return { exact: true, prefixLength: 0 };
  }
  let prefixLength = 0;
  for (const prefix of definition.prefixes) {
    if (fullName.startsWith(prefix)) {
      prefixLength = Math.max(prefixLength, prefix.length);
    }
    if (shortName !== null && shortName.startsWith(prefix)) {
      prefixLength = Math.max(prefixLength, prefix.length);
    }
  }
  return prefixLength ? { exact: false, prefixLength } : null;
};

// Identity per PluginView instance. pluginStore.refresh() rebuilds every view, so the
// match cache below must be keyed on the instance as well: otherwise it keeps handing
// out a stale plugin object and MatchedToolCall disposes itself on the next store
// notification (pluginCurrent compares by identity).
const pluginObjectIds = new WeakMap<PluginView, number>();
let nextPluginObjectId = 0;
const pluginObjectId = (plugin: PluginView): number => {
  let id = pluginObjectIds.get(plugin);
  if (id === undefined) {
    id = ++nextPluginObjectId;
    pluginObjectIds.set(plugin, id);
  }
  return id;
};

// LRU/Map memoization cache for tool renderer selection to avoid recalculating matches on every message render
const rendererMatchCache = new Map<string, Match | undefined>();
const MAX_MATCH_CACHE_SIZE = 1000;

export const clearPluginToolCallMatchCache = (): void => {
  rendererMatchCache.clear();
};

const selectRenderer = (
  plugins: PluginView[],
  name: string,
  owner: PluginToolOwner | null,
): Match | undefined => {
  // Compute cache key combining enabled plugins revision and tool name
  const cacheKey = `${plugins.map((p) => `${pluginObjectId(p)}:${p.pluginId}:${p.version}:${p.enabled ? 1 : 0}:${p.toolCallRenderers.length}`).join("|")}::${name}::${owner?.pluginId ?? ""}::${owner?.toolName ?? ""}`;
  if (rendererMatchCache.has(cacheKey)) {
    return rendererMatchCache.get(cacheKey);
  }

  const storeMatch = (match: Match | undefined): Match | undefined => {
    if (rendererMatchCache.size >= MAX_MATCH_CACHE_SIZE) {
      rendererMatchCache.clear();
    }
    rendererMatchCache.set(cacheKey, match);
    return match;
  };

  // 工具插件自己的工具优先交给该插件自带的渲染器：公开服务器名由宿主派生，
  // 插件无法稳定预知，因此按清单内的工具短名匹配。归属索引未就绪时从完整
  // 名称推导短名，避免首轮回退到通用卡片。
  const shortName = owner?.toolName ?? pluginToolShortName(name);
  if (owner) {
    const ownerPlugin = plugins.find(
      (plugin) => plugin.pluginId === owner.pluginId,
    );
    if (
      ownerPlugin &&
      ownerPlugin.enabled &&
      ownerPlugin.renderMode === "esm" &&
      ownerPlugin.privacy.includes("messages")
    ) {
      for (const definition of ownerPlugin.toolCallRenderers) {
        const hit = matchesDefinition(definition, name, owner.toolName);
        if (hit) {
          return storeMatch({
            plugin: ownerPlugin,
            definition,
            exact: hit.exact,
            prefixLength: hit.prefixLength,
          });
        }
      }
    }
  }

  const matches: Match[] = [];
  for (const plugin of plugins) {
    if (
      !plugin.enabled ||
      plugin.renderMode !== "esm" ||
      !plugin.privacy.includes("messages")
    )
      continue;
    for (const definition of plugin.toolCallRenderers) {
      const hit = matchesDefinition(definition, name, shortName);
      if (hit)
        matches.push({
          plugin,
          definition,
          exact: hit.exact,
          prefixLength: hit.prefixLength,
        });
    }
  }
  const result = matches.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.prefixLength - a.prefixLength ||
      b.definition.priority - a.definition.priority ||
      a.plugin.sortOrder - b.plugin.sortOrder ||
      compareText(a.plugin.pluginId, b.plugin.pluginId) ||
      compareText(a.definition.id, b.definition.id),
  )[0];

  return storeMatch(result);
};

type Loaded = {
  module: PluginModuleExports;
  messages: Record<string, string>;
  icons: Record<string, unknown>;
};
type ModuleLease = {
  controller: AbortController;
  users: number;
  settled: boolean;
  promise: Promise<Loaded>;
};
const moduleCache = new WeakMap<PluginView, Map<string, ModuleLease>>();
const pluginCurrent = (plugin: PluginView): boolean =>
  plugin.enabled && pluginStore.getById(plugin.pluginId) === plugin;

// Module and dictionary work is shared, never tied to the first card's signal.
const acquireModule = (
  plugin: PluginView,
  entry: string,
  locale: Locale,
  hostTranslate: PluginToolCallApi["t"],
): { promise: Promise<Loaded>; release: () => void } => {
  let cache = moduleCache.get(plugin);
  if (!cache) {
    cache = new Map();
    moduleCache.set(plugin, cache);
  }
  const key = JSON.stringify([entry, locale]);
  let lease = cache.get(key);
  if (!lease) {
    const controller = new AbortController();
    const bootstrap = new AbortController();
    const isCurrent = (): boolean =>
      pluginCurrent(plugin) && !controller.signal.aborted;
    const promise = (async (): Promise<Loaded> => {
      try {
        const [messages, icons] = await Promise.all([
          loadPluginMessages(plugin, locale, controller.signal),
          loadLucideIcons(),
        ]);
        controller.signal.throwIfAborted();
        const api = createPluginToolCallApi({
          plugin,
          locale,
          messages,
          icons,
          signal: bootstrap.signal,
          isCurrent,
          hostTranslate,
        });
        const module = await loadPluginModule({
          plugin,
          entry,
          locale,
          api,
          signal: controller.signal,
          isCurrent,
        });
        return { module, messages, icons };
      } finally {
        // A module may only keep the React constant, not a live loading-time API.
        bootstrap.abort();
      }
    })();
    lease = { controller, users: 0, settled: false, promise };
    const created = lease;
    void promise.then(
      () => {
        created.settled = true;
      },
      () => {
        created.settled = true;
      },
    );
    cache.set(key, lease);
  }
  lease.users++;
  const acquired = lease;
  let released = false;
  return {
    promise: acquired.promise,
    release: () => {
      if (released) return;
      released = true;
      acquired.users--;
      if (!acquired.users && (!acquired.settled || !pluginCurrent(plugin))) {
        acquired.controller.abort();
        if (cache.get(key) === acquired) cache.delete(key);
      }
    },
  };
};

type StyleLease = {
  users: number;
  controller: AbortController;
  promise: Promise<() => void>;
};
const styleCache = new WeakMap<PluginView, StyleLease>();
const acquireStyles = (
  plugin: PluginView,
): { promise: Promise<() => void>; release: () => void } => {
  let lease = styleCache.get(plugin);
  if (!lease) {
    const controller = new AbortController();
    lease = {
      controller,
      users: 0,
      promise: injectPluginStyles(plugin, controller.signal, () =>
        pluginCurrent(plugin),
      ),
    };
    styleCache.set(plugin, lease);
  }
  lease.users++;
  const acquired = lease;
  let released = false;
  return {
    promise: acquired.promise,
    release: () => {
      if (released) return;
      released = true;
      acquired.users--;
      if (!acquired.users) {
        acquired.controller.abort();
        void acquired.promise.then(
          (cleanup) => cleanup(),
          () => {},
        );
        if (styleCache.get(plugin) === acquired) styleCache.delete(plugin);
      }
    },
  };
};

class RendererBoundary extends React.Component<
  {
    fallback: React.ReactNode;
    onFailure: () => void;
    children: React.ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(): void {
    this.props.onFailure();
  }
  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// Call the factory outside a functional component's hooks dispatcher. Hooks belong
// in the component subtree it returns, which stays in the original context tree.
class RenderContribution extends React.Component<{
  renderPlugin: PluginToolCallRenderer;
  api: PluginToolCallApi;
  context: PluginToolCallContext;
  fallback: React.ReactNode;
}> {
  render(): React.ReactNode {
    const { renderPlugin, api, context, fallback } = this.props;
    if (api.signal.aborted) return fallback;
    const node = renderPlugin(api, context);
    if (node == null) return fallback;
    if (
      typeof node === "object" &&
      "then" in node &&
      typeof node.then === "function"
    ) {
      // Promise is explicitly outside v1; also consume rejection without data logging.
      void Promise.resolve(node).catch(() => {});
      return fallback;
    }
    return node;
  }
}

type Props = {
  toolCall: ToolCallInfo;
  conversationId?: string;
  messageId?: string;
  fallback: React.ReactNode;
};
const MatchedToolCall = ({
  plugin,
  definition,
  locale,
  originalToolName,
  toolCall,
  conversationId,
  messageId,
  fallback,
}: Props & {
  plugin: PluginView;
  definition: PluginToolCallRendererDefinition;
  locale: Locale;
  originalToolName?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [loaded, setLoaded] = React.useState<{
    renderPlugin: PluginToolCallRenderer;
    api: PluginToolCallApi;
  } | null>(null);
  const disposeRef = React.useRef<() => void>(() => {});
  const identity = JSON.stringify([
    toolCall.name,
    toolCall.interactionId,
    conversationId,
    messageId,
    locale,
  ]);
  const identityRef = React.useRef(identity);
  identityRef.current = identity;
  React.useLayoutEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const isCurrent = (): boolean =>
      !disposed &&
      identityRef.current === identity &&
      pluginCurrent(plugin) &&
      plugin.toolCallRenderers.includes(definition);
    const module = acquireModule(plugin, definition.entry, locale, t);
    const styles = acquireStyles(plugin);
    const unsubscribe = pluginStore.subscribe(() => {
      if (!isCurrent()) dispose();
    });
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      module.release();
      styles.release();
      unsubscribe();
    };
    disposeRef.current = dispose;
    void Promise.all([module.promise, styles.promise]).then(
      ([resource]) => {
        if (!isCurrent() || controller.signal.aborted) return;
        const renderPlugin = resource.module[definition.exportName];
        if (typeof renderPlugin !== "function") {
          dispose();
          return;
        }
        const api = createPluginToolCallApi({
          plugin,
          locale,
          messages: resource.messages,
          icons: resource.icons,
          signal: controller.signal,
          isCurrent,
          hostTranslate: t,
        });
        setLoaded({
          renderPlugin: renderPlugin as PluginToolCallRenderer,
          api,
        });
      },
      () => {
        dispose();
      },
    );
    return dispose;
  }, [plugin, definition, locale, identity, t]);
  const context: PluginToolCallContext = Object.freeze({
    slot: "tool-call",
    conversationId,
    messageId,
    toolCall: Object.freeze({
      name: toolCall.name,
      originalToolName,
      arguments: toolCall.arguments,
      interactionId: toolCall.interactionId,
      status: toolCall.status,
      result: toolCall.result,
      streamingStdout: toolCall.streamingStdout,
      streamingStderr: toolCall.streamingStderr,
    }),
  });
  if (!loaded || loaded.api.signal.aborted) return <>{fallback}</>;
  return (
    <RendererBoundary
      fallback={fallback}
      onFailure={() => disposeRef.current()}
    >
      <RenderContribution {...loaded} context={context} fallback={fallback} />
    </RendererBoundary>
  );
};

export const PluginToolCall = (props: Props): React.JSX.Element => {
  const { plugins } = usePluginStore();
  const { locale } = useI18n();
  const owner = usePluginToolOwnerInfo(props.toolCall.name);
  React.useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);
  const match = React.useMemo(
    () => selectRenderer(plugins, props.toolCall.name, owner),
    [plugins, props.toolCall.name, owner],
  );
  if (!match) return <>{props.fallback}</>;
  const key = JSON.stringify([
    pluginObjectId(match.plugin),
    match.plugin.pluginId,
    match.definition.id,
    props.toolCall.name,
    props.toolCall.interactionId,
    props.conversationId,
    props.messageId,
    locale,
  ]);
  return (
    <MatchedToolCall
      key={key}
      {...props}
      plugin={match.plugin}
      definition={match.definition}
      locale={locale}
      originalToolName={owner?.toolName}
    />
  );
};
