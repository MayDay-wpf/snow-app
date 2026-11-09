import {
  Anthropic,
  Antigravity,
  Codex,
  Grok,
  Kimi,
  OpenAI,
} from "@lobehub/icons";
import { KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  resolveLucideIcon,
  type LucideIconComponent,
} from "../../../plugins/pluginRuntime";
import { imageProxyUrl } from "../../../utils/imageProxyUrl";

type OAuthProviderIconProps = {
  providerId: string;
  /** 插件提供的图标（`lucide:Name` / data URL / https URL），优先于内置映射。 */
  iconUrl?: string;
  size?: number;
};

type ResolvedProviderIcon =
  { kind: "lucide"; name: string } | { kind: "image"; src: string };

const LUCIDE_ICON_PREFIX = "lucide:";

/** 与插件 / 市场 / 脚本图标同口径：lucide 名称、http(s) 与 data:image。 */
const resolveProviderIcon = (
  icon: string | undefined,
): ResolvedProviderIcon | null => {
  const trimmed = icon?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase().startsWith(LUCIDE_ICON_PREFIX)) {
    return {
      kind: "lucide",
      name: trimmed.slice(LUCIDE_ICON_PREFIX.length).trim(),
    };
  }
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return { kind: "image", src: trimmed };
  }
  return null;
};

/** 内置 provider 的品牌图标；未知 id 用钥匙占位。 */
const renderBrandIcon = (
  providerId: string,
  size: number,
): React.JSX.Element => {
  switch (providerId) {
    case "chatgpt":
      return <OpenAI size={size} />;
    case "codex":
      return <Codex.Color size={size} />;
    case "anthropic":
    case "claude":
      return <Anthropic size={size} />;
    case "antigravity":
      return <Antigravity.Color size={size} />;
    case "kimi":
    case "moonshot":
      return <Kimi.Color size={size} />;
    case "xai":
    case "grok":
      return <Grok size={size} />;
    default:
      return <KeyRound size={size} strokeWidth={1.8} />;
  }
};

export function OAuthProviderIcon({
  providerId,
  iconUrl,
  size = 22,
}: OAuthProviderIconProps): React.JSX.Element {
  const resolved = useMemo(() => resolveProviderIcon(iconUrl), [iconUrl]);
  const [lucideIcon, setLucideIcon] = useState<LucideIconComponent | null>(
    null,
  );
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    setLucideIcon(null);
    setImageFailed(false);
    if (resolved?.kind === "lucide") {
      void resolveLucideIcon(resolved.name).then((found) => {
        if (!disposed) {
          setLucideIcon(found);
        }
      });
    }
    return () => {
      disposed = true;
    };
  }, [resolved]);

  // 图片取不到（离线 / 插件删图）时回退品牌图标
  if (resolved?.kind === "image" && !imageFailed) {
    return (
      <img
        src={imageProxyUrl(resolved.src)}
        width={size}
        height={size}
        alt=""
        draggable={false}
        style={{ objectFit: "contain" }}
        onError={() => setImageFailed(true)}
      />
    );
  }

  if (resolved?.kind === "lucide" && lucideIcon) {
    const Icon = lucideIcon;
    return <Icon size={size} />;
  }

  return renderBrandIcon(providerId, size);
}
