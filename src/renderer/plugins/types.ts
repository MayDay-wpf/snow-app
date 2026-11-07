import type { PluginRecord } from "../../preload/types/plugins";

export type { PluginRecord };

export type PluginRenderMode = "esm" | "iframe";

/** 插件类型：`plugin` 面板插件 / `oauth` OAuth 登录插件 / `tool` 工具插件。 */
export type PluginKind = "plugin" | "oauth" | "tool";

export type PluginLocalizedMap = Record<string, string>;

/** 插件可声明的敏感数据域（privacy 声明中的取值）。 */
export const SENSITIVE_SCOPES = [
  "apiKeys",
  "privacyConfig",
  "systemPrompts",
  "customHeaders",
  "mcpSecrets",
  "subAgents",
  "personalization",
  "conversations",
  "messages",
  "memos",
  "memory",
  "scheduledTasks",
  "checkpoints",
  "logs",
  "usage",
  "git",
  "ssh",
  "browserData",
  "userscripts",
  "remoteControl",
  "plugins",
  "terminal",
  "filesystem",
  "projectContext",
  "window",
  "storage",
  "updater",
  "toolApproval",
  "network",
] as const;

export type SensitiveScope = (typeof SENSITIVE_SCOPES)[number];

export const isSensitiveScope = (value: string): value is SensitiveScope =>
  (SENSITIVE_SCOPES as readonly string[]).includes(value);

/** Secondary actions share their parent panel's entry and runtime permissions. */
export type PluginChatInputMenuAction = {
  id: string;
  action: string;
  title: PluginLocalizedMap;
  icon?: string;
};

/** 插件面板定义；renderer-only 贡献从保存的 manifestJson 补充。 */
export type PluginPanelDefinition = {
  id: string;
  title: PluginLocalizedMap;
  entry: string;
  icon: string;
  widthHint: string;
  chatInput?: boolean;
  chatInputAction?: string;
  chatInputTitle?: PluginLocalizedMap;
  chatInputMenuActions?: PluginChatInputMenuAction[];
  /** Configuration gear only; independent from the action and plugin enablement. */
  chatInputSettings?: { defaultVisible: boolean; storageKey: string };
};

export type PluginMessageFooterDefinition = {
  id: string;
  entry: string;
  exportName: string;
  /** Opt in to immutable task-end history instead of the legacy latest slot. */
  taskHistory?: boolean;
};

export type PluginToolCallRendererDefinition = {
  id: string;
  entry: string;
  exportName: string;
  tools: string[];
  prefixes: string[];
  priority: number;
};

/** 渲染层使用的插件视图模型（PluginRecord 解析后的形态）。 */
export type PluginView = {
  pluginId: string;
  name: PluginLocalizedMap;
  description: PluginLocalizedMap;
  version: string;
  author: string;
  homepage: string;
  license: string;
  icon: string;
  renderMode: PluginRenderMode;
  entry: string;
  /** plugin.json 的 oauth.entry；非空即 OAuth 登录插件。 */
  oauthEntry: string;
  /** plugin.json 声明的类型；未声明时按 oauth.entry 推导。 */
  kind: PluginKind;
  panels: PluginPanelDefinition[];
  messageFooters: PluginMessageFooterDefinition[];
  toolCallRenderers: PluginToolCallRendererDefinition[];
  locales: Record<string, string>;
  styles: string[];
  privacy: SensitiveScope[];
  privacyNote: string;
  minAppVersion: string;
  enabled: boolean;
  installPath: string;
  sourcePath: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type PluginDeniedDomain = {
  reason: "privacy-declaration-missing";
  scope: SensitiveScope;
};

export type MetadataResponse = {
  generatedAt: number;
  domains: Record<string, unknown>;
  denied: Record<string, PluginDeniedDomain>;
  withheld: Record<string, string[]>;
  unknown: string[];
};

export type MetadataRequest = {
  domain: string;
  params?: Record<string, unknown>;
};
