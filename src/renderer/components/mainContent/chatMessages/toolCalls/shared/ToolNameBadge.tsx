import type { ReactNode } from "react";
import {
  Activity,
  Bot,
  CodeXml,
  Copy,
  Database,
  FilePen,
  FilePlus,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  ListChecks,
  ListTree,
  MessageCircleQuestion,
  Plug,
  Scale,
  ScanSearch,
  Search,
  Send,
  Sparkles,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type ToolCategory =
  | "read"
  | "edit"
  | "create"
  | "copy"
  | "search"
  | "terminal"
  | "web"
  | "git"
  | "outline"
  | "todo"
  | "interaction"
  | "agent"
  | "message"
  | "workflow"
  | "lens"
  | "image"
  | "skill"
  | "database"
  | "telemetry"
  | "html"
  | "decision"
  | "generic";

const CATEGORY_ICONS: Record<ToolCategory, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  create: FilePlus,
  copy: Copy,
  search: Search,
  terminal: Terminal,
  web: Globe,
  git: GitBranch,
  outline: ListTree,
  todo: ListChecks,
  interaction: MessageCircleQuestion,
  agent: Bot,
  message: Send,
  workflow: Workflow,
  lens: ScanSearch,
  image: ImageIcon,
  skill: Sparkles,
  database: Database,
  telemetry: Activity,
  html: CodeXml,
  decision: Scale,
  generic: Plug,
};

/** Resolve a fixed icon for every tool category. */
const getToolIcon = (category: ToolCategory): LucideIcon =>
  CATEGORY_ICONS[category];

/**
 * Map a raw MCP tool name to a display category for icon selection.
 *
 * Examples:
 *   "filesystem-read"       -> "read"
 *   "filesystem-replace_edit" -> "edit"
 *   "filesystem-create"      -> "create"
 *   "filesystem-copy"        -> "copy"
 *   "grep-search"                   -> "search"
 *   "terminal-execute"             -> "terminal"
 *   "websearch-search"             -> "web"
 *   "skills-skill-execute"         -> "skill"
 *   "sub-agents-sendMessage"       -> "message"
 */
export const getToolCategory = (toolName: string): ToolCategory => {
  const lower = toolName.toLowerCase();
  if (lower.startsWith("decision-")) {
    return "decision";
  }
  if (lower.includes("workflow")) {
    return "workflow";
  }
  if (lower.includes("skill")) {
    return "skill";
  }
  if (
    lower.includes("sendmessage") ||
    lower.includes("send-message") ||
    lower.includes("message-")
  ) {
    return "message";
  }
  if (
    lower.includes("sub-agent") ||
    lower.includes("subagent") ||
    lower.includes("activate")
  ) {
    return "agent";
  }
  if (lower.includes("copy")) return "copy";
  if (lower.includes("read")) return "read";
  if (lower.includes("edit") || lower.includes("replace")) return "edit";
  if (lower.includes("create") || lower.includes("write")) return "create";
  if (
    lower.includes("search") ||
    lower.includes("find") ||
    lower.includes("semantic") ||
    lower.includes("codebase")
  )
    return "search";
  if (
    lower.includes("terminal") ||
    lower.includes("execute") ||
    lower.includes("command")
  )
    return "terminal";
  if (
    lower.includes("db") ||
    lower.includes("sql") ||
    lower.includes("database") ||
    lower.includes("table") ||
    lower.includes("redis") ||
    lower.includes("postgres") ||
    lower.includes("mongo")
  ) {
    return "database";
  }
  if (
    lower.includes("telemetry") ||
    lower.includes("diagnos") ||
    lower.includes("audit") ||
    lower.includes("trace") ||
    lower.includes("metric") ||
    lower.includes("log")
  ) {
    return "telemetry";
  }
  if (
    lower.includes("web") ||
    lower.includes("fetch") ||
    lower.includes("url") ||
    lower.includes("firecrawl") ||
    lower.includes("crawl") ||
    lower.includes("scrape")
  ) {
    return "web";
  }
  if (lower.includes("imagegen") || lower.includes("generate-image"))
    return "image";
  if (lower.includes("git")) return "git";
  if (lower.startsWith("lsp-")) return "lens";
  if (
    lower.includes("outline") ||
    lower.includes("tree") ||
    lower.includes("symbol")
  )
    return "outline";
  if (lower.includes("todo")) return "todo";
  if (lower.includes("question") || lower.includes("interaction")) {
    return "interaction";
  }
  return "generic";
};

type ToolNameBadgeProps = {
  /** The display name shown in the badge, e.g. "read", "edit", "create". */
  name: string;
  /** Category used to select the tool's fixed icon. */
  category?: ToolCategory;
  /** 自定义图标节点（插件图标等），优先于 category。 */
  icon?: ReactNode;
};

export const ToolNameBadge = ({
  name,
  category = "generic",
  icon,
}: ToolNameBadgeProps): React.JSX.Element => {
  const Icon = getToolIcon(category);

  return (
    <span className="tool-call-tool-name">
      {icon ?? (
        <Icon
          size={10}
          className="tool-call-tool-name-icon"
          aria-hidden="true"
        />
      )}
      {name}
    </span>
  );
};
