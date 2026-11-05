/**
 * 用户消息附件 / 引用 chip 的图标：文件类走 fileIcons（与 PC 聊天 chip 一致），
 * 其余引用按类型映射到 lucide 图标（对齐桌面 UserMessage 的 chip 图标）。
 */
import type { SnowRemoteContentBlock } from "../renderer/types/remoteControl";
import { getFileIconMarkup } from "./fileIcons";
import { iconMarkup, type MobileIconName } from "./icons";

type AttachmentBlock = Extract<
  SnowRemoteContentBlock,
  { type: "image" | "file" | "reference" }
>;

/** 引用类型 → 图标与配色（对齐桌面 UserMessage 各 chip 的 lucide 图标）。 */
const REFERENCE_ICONS: Record<string, { name: MobileIconName; color: string }> =
  {
    commit: { name: "git-commit-horizontal", color: "#f05032" },
    change: { name: "file-diff", color: "#f59e0b" },
    "text-snippet": { name: "file-text", color: "#6c757d" },
    quote: { name: "file-text", color: "#4a9eff" },
    review: { name: "scan-search", color: "#2ea043" },
    element: { name: "target", color: "#1a73e8" },
    web: { name: "link", color: "#0f766e" },
    conversation: { name: "link", color: "#4a9eff" },
    command: { name: "command", color: "#0891b2" },
    skill: { name: "sparkles", color: "#8b5cf6" },
    annotation: { name: "message-square-plus", color: "#8b5cf6" },
    "file-selection": { name: "file-pen", color: "#6c757d" },
    workflow: { name: "workflow", color: "#4a9eff" },
  };

export const attachmentIconMarkup = (
  block: AttachmentBlock,
  size = 15,
): string => {
  if (block.type === "file") {
    return getFileIconMarkup(block.name || "file", {
      isDirectory: block.isDirectory,
      size,
    });
  }
  if (block.type === "image") {
    return getFileIconMarkup(block.name || "image.png", { size });
  }
  if (block.kind === "file-selection" && block.name) {
    return getFileIconMarkup(block.name, { size });
  }
  const icon = REFERENCE_ICONS[block.kind] ?? {
    name: "arrow-up-right" as const,
    color: "currentColor",
  };
  return iconMarkup(icon.name, icon.color);
};
