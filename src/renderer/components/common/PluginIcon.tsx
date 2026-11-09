import { Puzzle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { resolvePluginIcon } from "../../plugins/manifest";
import {
  resolveLucideIcon,
  type LucideIconComponent,
} from "../../plugins/pluginRuntime";
import { imageProxyUrl } from "../../utils/imageProxyUrl";

type PluginIconProps = {
  icon: string;
  pluginId: string;
  size?: number;
  className?: string;
};

/** 插件图标：lucide:Name / 插件内相对路径资源 / http(s) 与 data:image URL / 占位图标。 */
export const PluginIcon = ({
  icon,
  pluginId,
  size = 14,
  className,
}: PluginIconProps): React.JSX.Element => {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [lucideIcon, setLucideIcon] = useState<LucideIconComponent | null>(
    null,
  );
  const [imageFailed, setImageFailed] = useState(false);
  const resolved = useMemo(() => resolvePluginIcon(icon), [icon]);

  useEffect(() => {
    let disposed = false;
    setLucideIcon(null);
    setAssetUrl(null);
    setImageFailed(false);

    if (resolved?.kind === "lucide") {
      void resolveLucideIcon(resolved.name).then((found) => {
        if (!disposed) {
          setLucideIcon(found);
        }
      });
    } else if (resolved?.kind === "asset") {
      void window.snow
        .readPluginAsset(pluginId, resolved.path)
        .then((url) => {
          if (!disposed) {
            setAssetUrl(url);
          }
        })
        .catch(() => undefined);
    }

    return () => {
      disposed = true;
    };
  }, [pluginId, resolved]);

  const classes = className ? `plugin-icon ${className}` : "plugin-icon";

  // 远程 / 内联图标走图片代理；取不到时回退占位图标
  if (resolved?.kind === "image" && !imageFailed) {
    return (
      <img
        className={classes}
        src={imageProxyUrl(resolved.src)}
        width={size}
        height={size}
        alt=""
        onError={() => setImageFailed(true)}
      />
    );
  }

  if (assetUrl) {
    return (
      <img
        className={classes}
        src={assetUrl}
        width={size}
        height={size}
        alt=""
      />
    );
  }

  if (lucideIcon) {
    const Icon = lucideIcon;
    return (
      <span className={classes}>
        <Icon size={size} />
      </span>
    );
  }

  return (
    <span className={classes}>
      <Puzzle size={size} />
    </span>
  );
};
