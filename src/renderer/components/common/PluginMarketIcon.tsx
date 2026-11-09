import { Puzzle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { resolveMarketIcon } from "../../plugins/market";
import {
  resolveLucideIcon,
  type LucideIconComponent,
} from "../../plugins/pluginRuntime";

type PluginMarketIconProps = {
  icon: string;
  size?: number;
};

/**
 * 插件市场 / 社区条目的图标。
 *
 * 与插件清单的图标规则不同：市场条目在安装前没有插件目录可读，因此
 * `lucide:Name` 走宿主内置图标，`http(s)` 与 `data:image` 直接作为图片渲染
 * （远程地址由 `resolveMarketIcon` 转成 `img-proxy://`），其余回退占位图标。
 */
export const PluginMarketIcon = ({
  icon,
  size = 18,
}: PluginMarketIconProps): React.JSX.Element => {
  const [lucideIcon, setLucideIcon] = useState<LucideIconComponent | null>(
    null,
  );
  const [imageFailed, setImageFailed] = useState(false);
  const resolved = useMemo(() => resolveMarketIcon(icon), [icon]);

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

  // 图片取不到（离线 / 仓库删图）时回退占位图标
  if (resolved?.kind === "image" && !imageFailed) {
    return (
      <img
        className="plugin-icon"
        src={resolved.src}
        width={size}
        height={size}
        alt=""
        onError={() => setImageFailed(true)}
      />
    );
  }

  if (resolved?.kind === "lucide" && lucideIcon) {
    const Icon = lucideIcon;
    return (
      <span className="plugin-icon">
        <Icon size={size} />
      </span>
    );
  }

  return (
    <span className="plugin-icon">
      <Puzzle size={size} />
    </span>
  );
};
