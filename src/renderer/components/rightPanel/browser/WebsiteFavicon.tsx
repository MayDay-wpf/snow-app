import { useMemo, useState } from "react";
import { Globe } from "lucide-react";
import { imageProxyUrl } from "../../../utils/imageProxyUrl";

export type WebsiteFaviconProps = {
  /** 页面完整 URL（http/https）；解析失败或非 http(s) 显示默认图标。 */
  url: string;
  /** 图标尺寸（px），默认 13。 */
  size?: number;
  /** 加载中/失败时显示的回退节点（默认 Globe 图标）。 */
  fallback?: React.ReactNode;
  /** 追加到容器上的类名（如 browser-address-icon 的颜色与 flex 收缩）。 */
  className?: string;
};

/** 从页面 URL 解析 favicon 请求地址（origin + /favicon.ico），非法时为 null。 */
const faviconUrlOf = (pageUrl: string): string | null => {
  const trimmed = pageUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
};

/**
 * 网站 favicon：经 img-proxy:// 协议代理加载 `<origin>/favicon.ico`
 * （绕过 CSP img-src 限制，主进程带 24h 缓存），加载中与失败时回退默认
 * 图标。命中记录以 favicon 地址为键，URL 变化后自动失效，无需重置。
 */
export const WebsiteFavicon = ({
  url,
  size = 13,
  fallback,
  className,
}: WebsiteFaviconProps): React.JSX.Element => {
  const faviconUrl = useMemo(() => faviconUrlOf(url), [url]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const loaded = faviconUrl !== null && loadedUrl === faviconUrl;
  const failed = faviconUrl !== null && failedUrl === faviconUrl;

  return (
    <span
      className={`browser-favicon${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
    >
      {!loaded && (fallback ?? <Globe size={size} strokeWidth={1.6} />)}
      {faviconUrl !== null && !failed && (
        <img
          src={imageProxyUrl(faviconUrl)}
          width={size}
          height={size}
          alt=""
          className="browser-favicon-img"
          style={{ visibility: loaded ? "visible" : "hidden" }}
          onLoad={() => setLoadedUrl(faviconUrl)}
          onError={() => setFailedUrl(faviconUrl)}
        />
      )}
    </span>
  );
};
