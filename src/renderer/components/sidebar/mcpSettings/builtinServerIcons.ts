import {
  AppWindow,
  Bot,
  Brain,
  CodeXml,
  Crosshair,
  DatabaseSearch,
  FolderTree,
  Globe,
  History,
  Image as ImageIcon,
  ListTodo,
  MessageCircleQuestion,
  Monitor,
  MousePointerClick,
  Scale,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * 内置 MCP 服务专属图标映射：键为项目 scope 中的服务 id（Rust 侧
 * builtin_scope_server_id 生成）。未命中的服务由调用方决定兜底图标。
 */
const BUILTIN_SERVER_ICONS: Record<string, LucideIcon> = {
  "builtin:filesystem": FolderTree,
  "builtin:bash": SquareTerminal,
  "builtin:todo": ListTodo,
  "builtin:grep": Search,
  "builtin:websearch": Globe,
  "builtin:browser": AppWindow,
  "builtin:user-interaction": MessageCircleQuestion,
  "builtin:sub-agents": Bot,
  "builtin:codebase": DatabaseSearch,
  "builtin:app-control": MousePointerClick,
  "builtin:config": SlidersHorizontal,
  "builtin:terminal": Terminal,
  "builtin:imagegen": ImageIcon,
  "builtin:lsp": Crosshair,
  "builtin:workflow": Workflow,
  "builtin:memory": Brain,
  "builtin:computer-use": Monitor,
  "builtin:html": CodeXml,
  "builtin:decision": Scale,
  "builtin:toolSearch": Search,
  "builtin:context": History,
};

/** 返回内置服务的专属图标；非内置服务返回 undefined。 */
export const builtinServerIcon = (serverId: string): LucideIcon | undefined =>
  BUILTIN_SERVER_ICONS[serverId];
