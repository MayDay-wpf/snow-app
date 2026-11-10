import * as React from "react";
import type { Locale } from "../../shared/locale";
import { interpolate, type TranslateOptions } from "../i18n/translate";
import { rightPanelEvents } from "../components/rightPanel/rightPanelEvents";
import { ToolCallNode } from "../components/mainContent/chatMessages/toolCalls/shared/ToolCallNode";
import { DataTableViewer } from "../components/mainContent/chatMessages/toolCalls/shared/DataTableViewer";
import { localizeToolError } from "../components/mainContent/chatMessages/toolCalls/shared/toolErrorDisplay";
import {
  pluginMediaKind,
  pluginMediaUrl,
  type PluginMediaKind,
} from "../utils/pluginMediaUrl";
import {
  openPluginMedia,
  PluginMediaPreview,
  type PluginMediaPreviewProps,
} from "./pluginMedia";
import type { PluginView } from "./types";

export type PluginToolCallContext = Readonly<{
  slot: "tool-call";
  conversationId?: string;
  messageId?: string;
  toolCall: Readonly<{
    name: string;
    /** Complete manifest tool name for tool plugins; never truncated by the public-name limit. */
    originalToolName?: string;
    arguments: string;
    interactionId: string;
    status: "pending" | "running" | "completed" | "error";
    result?: string;
    /** Epoch ms when the call transitioned to "running"; absent for non-running calls. */
    startedAt?: number;
    streamingStdout?: string;
    streamingStderr?: string;
  }>;
}>;

/**
 * 工具卡本地媒体预览（只增不改的能力面）。
 *
 * 插件只传本地绝对路径；scheme、白名单与编码全部留在宿主，插件无法自行扩大读取范围。
 */
export type PluginMediaApi = Readonly<{
  /** 本地媒体路径 → plugin-media:// URL；非媒体路径或相对路径返回 undefined。 */
  url: (path: string) => string | undefined;
  /** 在内置浏览器标签页播放 / 查看；宿主不支持该扩展名时返回 false。 */
  open: (path: string) => boolean;
  /** 预览种类；非媒体扩展名返回 undefined。 */
  supports: (path: string) => PluginMediaKind | undefined;
  /** 内嵌播放器 / 缩略图；加载失败时渲染为空，不吞掉卡片其余内容。 */
  Preview: React.ComponentType<PluginMediaPreviewProps>;
}>;

export type PluginToolCallApi = Readonly<{
  id: string;
  version: string;
  locale: Locale;
  t: (key: string, options?: TranslateOptions) => string;
  signal: AbortSignal;
  ui: Readonly<{
    React: typeof React;
    icon: (name: string) => unknown;
    toolCallRendererVersion: 1;
    ToolCallNode: typeof ToolCallNode;
    DataTableViewer: typeof DataTableViewer;
    localizeToolError: typeof localizeToolError;
    /**
     * 本地媒体预览。旧宿主没有该字段，插件用 `ui.media?.Preview` 探测后降级；
     * 新增可选能力不改变 toolCallRendererVersion。
     */
    media?: PluginMediaApi;
  }>;
  links: Readonly<{
    open: (url: string, target?: "browser" | "external") => void;
  }>;
}>;

/** Synchronous factory, not a React component: return a component subtree for hooks. */
export type PluginToolCallRenderer = (
  api: PluginToolCallApi,
  context: PluginToolCallContext,
) => React.ReactNode | null;

/** No full runtime API is created or captured for this slot. ESM remains trusted code. */
export const createPluginToolCallApi = (params: {
  plugin: PluginView;
  locale: Locale;
  messages: Record<string, string>;
  icons: Record<string, unknown>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  hostTranslate: PluginToolCallApi["t"];
}): PluginToolCallApi => {
  const { plugin, locale, messages, icons, signal, isCurrent, hostTranslate } =
    params;
  const check = (): void => {
    signal.throwIfAborted();
    if (!isCurrent())
      throw new DOMException("Tool renderer context expired", "AbortError");
  };
  return Object.freeze({
    id: plugin.pluginId,
    version: plugin.version,
    locale,
    signal,
    t: (key: string, options?: TranslateOptions): string => {
      check();
      const message = Object.hasOwn(messages, key) ? messages[key] : undefined;
      return typeof message === "string"
        ? interpolate(message, options?.values)
        : hostTranslate(key, options);
    },
    ui: Object.freeze({
      React,
      icon: (name: string): unknown => {
        check();
        return Object.hasOwn(icons, name) ? icons[name] : undefined;
      },
      toolCallRendererVersion: 1 as const,
      ToolCallNode,
      DataTableViewer,
      localizeToolError,
      media: Object.freeze({
        url: pluginMediaUrl,
        open: (path: string): boolean => {
          check();
          return openPluginMedia(path);
        },
        supports: pluginMediaKind,
        Preview: PluginMediaPreview,
      }),
    }),
    links: Object.freeze({
      open: (url: string, target: "browser" | "external" = "browser"): void => {
        check();
        // Fail closed when user activation is unavailable; never navigate at module/render time.
        if (!navigator.userActivation?.isActive) return;
        if (target !== "browser" && target !== "external") return;
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        if (target === "external") {
          // Match the desktop's existing system-browser route (window.snow has no openExternal).
          window.open(parsed.href, "_blank", "noopener,noreferrer");
        } else {
          rightPanelEvents.emit("browser:navigate", { url: parsed.href });
        }
      },
    }),
  });
};
