import {
  Braces,
  ChartColumn,
  Compass,
  Database,
  Download,
  EyeOff,
  FishingHook,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Images,
  Keyboard,
  List,
  MessageSquareText,
  Palette,
  PawPrint,
  Plug,
  ScrollText,
  Settings2,
  Sparkles,
  ShieldAlert,
  Terminal,
  Users,
} from "lucide-react";

import { McpLogo } from "../icons/mcpLogo";
import type { MainContentView } from "../mainContent/types";

export type SettingsItem = {
  id: string;
  icon: React.ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
  labelKey: string;
  defaultLabel: string;
  view: MainContentView;
};

export const SETTINGS_ITEMS: SettingsItem[] = [
  {
    id: "general",
    icon: Settings2,
    labelKey: "settings.generalSettings",
    defaultLabel: "General settings",
    view: "general-settings",
  },
  {
    id: "api",
    icon: Plug,
    labelKey: "settings.apiSettings",
    defaultLabel: "API settings",
    view: "api-settings",
  },
  {
    id: "imagegen",
    icon: ImageIcon,
    labelKey: "settings.imagegenSettings",
    defaultLabel: "Image generation",
    view: "imagegen-settings",
  },
  {
    id: "imagelibrary",
    icon: Images,
    labelKey: "settings.imageLibrary",
    defaultLabel: "Image library",
    view: "image-library",
  },
  {
    id: "proxy",
    icon: Globe,
    labelKey: "settings.proxySettings",
    defaultLabel: "Proxy and search engine",
    view: "proxy-browser-settings",
  },
  {
    id: "codebase",
    icon: Database,
    labelKey: "settings.codebaseSettings",
    defaultLabel: "Codebase settings",
    view: "codebase-settings",
  },
  {
    id: "git",
    icon: GitBranch,
    labelKey: "settings.gitSettings",
    defaultLabel: "Git settings",
    view: "git-settings",
  },
  {
    id: "systemprompt",
    icon: MessageSquareText,
    labelKey: "settings.systemPromptSettings",
    defaultLabel: "System prompt",
    view: "system-prompt-settings",
  },
  {
    id: "personalization",
    icon: ScrollText,
    labelKey: "settings.personalizationSettings",
    defaultLabel: "Personalization",
    view: "personalization-settings",
  },
  {
    id: "customheaders",
    icon: List,
    labelKey: "settings.customHeadersSettings",
    defaultLabel: "Custom headers",
    view: "custom-headers-settings",
  },
  {
    id: "mcp",
    icon: McpLogo,
    labelKey: "settings.mcpSettings",
    defaultLabel: "MCP settings",
    view: "mcp-settings",
  },
  {
    id: "lsp",
    icon: Braces,
    labelKey: "settings.lspSettings",
    defaultLabel: "LSP settings",
    view: "lsp-settings",
  },
  {
    id: "skills",
    icon: Sparkles,
    labelKey: "settings.skillsSettings",
    defaultLabel: "Skills settings",
    view: "skills-settings",
  },
  {
    id: "import-config",
    icon: Download,
    labelKey: "settings.thirdPartySettings",
    defaultLabel: "Third-party configuration",
    view: "import-settings",
  },
  {
    id: "subagent",
    icon: Users,
    labelKey: "settings.subAgentSettings",
    defaultLabel: "Sub-agent settings",
    view: "sub-agent-settings",
  },
  {
    id: "sensitive-commands",
    icon: ShieldAlert,
    labelKey: "settings.sensitiveCommands",
    defaultLabel: "Sensitive commands",
    view: "sensitive-command-settings",
  },
  {
    id: "hooks",
    icon: FishingHook,
    labelKey: "settings.hooksSettings",
    defaultLabel: "Hooks settings",
    view: "hooks-settings",
  },
  {
    id: "theme",
    icon: Palette,
    labelKey: "settings.themeSettings",
    defaultLabel: "Theme settings",
    view: "theme-settings",
  },
  {
    id: "terminal",
    icon: Terminal,
    labelKey: "settings.terminalSettings",
    defaultLabel: "Terminal settings",
    view: "terminal-settings",
  },
  {
    id: "browser",
    icon: Compass,
    labelKey: "settings.browserSettings",
    defaultLabel: "Browser settings",
    view: "browser-settings",
  },
  {
    id: "keyboard-shortcuts",
    icon: Keyboard,
    labelKey: "settings.keyboardShortcutsSettings",
    defaultLabel: "Keyboard shortcuts",
    view: "keyboard-shortcuts-settings",
  },
  {
    id: "pets",
    icon: PawPrint,
    labelKey: "settings.pets",
    defaultLabel: "Desktop pet",
    view: "pets-settings",
  },
  {
    id: "privacy",
    icon: EyeOff,
    labelKey: "settings.privacySettings",
    defaultLabel: "Privacy settings",
    view: "privacy-settings",
  },
  {
    id: "usage",
    icon: ChartColumn,
    labelKey: "settings.usageSettings",
    defaultLabel: "Usage statistics",
    view: "usage-settings",
  },
  {
    id: "system-logs",
    icon: ScrollText,
    labelKey: "settings.systemLogs",
    defaultLabel: "System logs",
    view: "system-logs",
  },
];

/**
 * Set of all MainContentView values backed by a settings panel. Used to detect
 * when the active view is a settings page (e.g. to reset to chat on exit).
 */
export const SETTINGS_VIEW_IDS: ReadonlySet<MainContentView> = new Set(
  SETTINGS_ITEMS.map((item) => item.view),
);
