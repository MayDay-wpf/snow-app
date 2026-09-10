import type { LucideIcon } from "lucide-react";
import {
  Loader2,
  Loader,
  LoaderPinwheel,
  Aperture,
  Cog,
  Fan,
  Sun,
  CircleDashed,
  LifeBuoy,
  Compass,
  Disc3,
  RefreshCw,
  Crosshair,
  Shell,
  Orbit,
  Atom,
  Snowflake,
  Star,
  Diamond,
} from "lucide-react";

/**
 * 流式光标可用的内置 lucide 图标列表。
 * 每项包含 lucide 图标的组件引用和 PascalCase 名称（用于持久化）。
 * 持久化时存储 name 字段（如 "Loader2"），渲染时通过此列表查找对应组件。
 */
export type StreamCursorLucideIcon = {
  name: string;
  Icon: LucideIcon;
};

export const STREAM_CURSOR_LUCIDE_ICONS: StreamCursorLucideIcon[] = [
  { name: "Loader2", Icon: Loader2 },
  { name: "Loader", Icon: Loader },
  { name: "LoaderPinwheel", Icon: LoaderPinwheel },
  { name: "Aperture", Icon: Aperture },
  { name: "Cog", Icon: Cog },
  { name: "Fan", Icon: Fan },
  { name: "Sun", Icon: Sun },
  { name: "CircleDashed", Icon: CircleDashed },
  { name: "LifeBuoy", Icon: LifeBuoy },
  { name: "Compass", Icon: Compass },
  { name: "Disc3", Icon: Disc3 },
  { name: "RefreshCw", Icon: RefreshCw },
  { name: "Crosshair", Icon: Crosshair },
  { name: "Shell", Icon: Shell },
  { name: "Orbit", Icon: Orbit },
  { name: "Atom", Icon: Atom },
  { name: "Snowflake", Icon: Snowflake },
  { name: "Star", Icon: Star },
  { name: "Diamond", Icon: Diamond },
];

/**
 * 根据持久化的 lucide 图标名称查找对应组件。
 * 找不到时返回 null，调用方应回退到默认脉冲圆点。
 */
export const findStreamCursorLucideIcon = (name: string): LucideIcon | null => {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  const entry = STREAM_CURSOR_LUCIDE_ICONS.find(
    (item) => item.name === trimmed,
  );
  return entry?.Icon ?? null;
};
