import {
  Blocks,
  Brush,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  GitPullRequest,
  Image,
  Layout,
  Palette,
  Presentation,
  Snowflake,
  Sparkles,
  Wrench,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

const SKILL_ICONS: Record<string, LucideIcon> = {
  "snow-app-docs": Snowflake,
  "git-upstream-pr": GitPullRequest,
  gh: GitPullRequest,
  "gh-skill": GitPullRequest,
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  slides: Presentation,
  "banner-design": Image,
  brand: Palette,
  design: Palette,
  "design-system": Layout,
  "frontend-design": Layout,
  "ui-ux-pro-max": Layout,
  "ui-styling": Brush,
  "webapp-testing": FlaskConical,
  "mcp-builder": Blocks,
  "skill-creator": Wrench,
};

export const getSkillIcon = (
  skillId: string,
  props: LucideProps,
): React.JSX.Element => {
  const name = skillId.slice(skillId.lastIndexOf("/") + 1).toLowerCase();
  const Icon = SKILL_ICONS[name] ?? Sparkles;
  return <Icon {...props} aria-hidden="true" />;
};

export const getSkillIconHtml = (skillId: string, size = 12): string =>
  renderToStaticMarkup(
    getSkillIcon(skillId, { size, className: "file-chip-icon-inner" }),
  );
