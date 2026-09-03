import {
  Bot,
  FilePen,
  FilePlus,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  ListChecks,
  ListTree,
  MessageCircleQuestion,
  ScanSearch,
  Search,
  Terminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ToolCategory =
  | "read"
  | "edit"
  | "create"
  | "search"
  | "terminal"
  | "web"
  | "git"
  | "outline"
  | "todo"
  | "interaction"
  | "agent"
  | "workflow"
  | "lens"
  | "image"
  | "generic";

const CATEGORY_ICONS: Record<ToolCategory, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  create: FilePlus,
  search: Search,
  terminal: Terminal,
  web: Globe,
  git: GitBranch,
  outline: ListTree,
  todo: ListChecks,
  interaction: MessageCircleQuestion,
  agent: Bot,
  workflow: Workflow,
  lens: ScanSearch,
  image: ImageIcon,
  generic: Wrench,
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
 *   "ace-search"                   -> "search"
 *   "terminal-execute"             -> "terminal"
 *   "websearch-search"             -> "web"
 *   "todo-manage"                  -> "generic"
 */
export const getToolCategory = (toolName: string): ToolCategory => {
  const lower = toolName.toLowerCase();
  if (lower.includes("workflow")) {
    return "workflow";
  }
  if (
    lower.includes("sub-agent") ||
    lower.includes("subagent") ||
    lower.includes("activate")
  ) {
    return "agent";
  }
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
  if (lower.includes("web") || lower.includes("fetch") || lower.includes("url"))
    return "web";
  if (lower.includes("imagegen") || lower.includes("generate-image"))
    return "image";
  if (lower.includes("git")) return "git";
  if (lower.includes("codelens") || lower.startsWith("lsp-")) {
    return "lens";
  }
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
};

export const ToolNameBadge = ({
  name,
  category = "generic",
}: ToolNameBadgeProps): React.JSX.Element => {
  const Icon = getToolIcon(category);

  return (
    <span className="tool-call-tool-name">
      <Icon size={10} className="tool-call-tool-name-icon" aria-hidden="true" />
      {name}
    </span>
  );
};
