import { memo, useState } from "react";
import { localImageProxyUrl } from "../../utils/imageProxyUrl";

/** 代理 URL 缓存条数上限（只存短字符串，按条数限制即可）。 */
const PROXY_CACHE_MAX = 300;

/** 每个 data URL 缓存的字节预算：data URL 为单字节字符串，长度即占用。 */
const DATA_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

/** 带条数上限的 Map 写入：超限时删除最旧的条目。 */
const cacheSet = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
): void => {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
};

/** 按字节预算淘汰的 data URL LRU：大图不会因为条数上限宽松而长期驻留。 */
class DataUrlCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    this.delete(key);
    if (value.length > DATA_CACHE_BUDGET_BYTES) {
      return;
    }
    this.entries.set(key, value);
    this.bytes += value.length;
    for (const [oldestKey, oldestValue] of this.entries) {
      if (this.bytes <= DATA_CACHE_BUDGET_BYTES) break;
      this.entries.delete(oldestKey);
      this.bytes -= oldestValue.length;
    }
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (value === undefined) {
      return false;
    }
    this.entries.delete(key);
    this.bytes -= value.length;
    return true;
  }
}

/** 生成结果中图库落盘引用（image/... 前缀）的代理 URL 缓存。 */
export const libraryProxyCache = new Map<string, string>();

/** 把图库相对路径解析为可展示的代理 URL（带 LRU 缓存，避免重复构造）。 */
export const proxyForLibraryPath = (path: string): string => {
  const cached = libraryProxyCache.get(path);
  if (cached) {
    cacheSet(libraryProxyCache, path, cached, PROXY_CACHE_MAX);
    return cached;
  }
  const url = localImageProxyUrl(path);
  cacheSet(libraryProxyCache, path, url, PROXY_CACHE_MAX);
  return url;
};

/** 图库图片的 data URL 缓存（IPC resolveLibraryImage，删除图片时同步失效）。 */
export const libraryDataCache = new DataUrlCache();

/** 异步读取图库图片为 data URL（带字节预算 LRU；失败返回 null）。 */
export const resolveLibraryDataUrl = async (
  path: string,
): Promise<string | null> => {
  const cached = libraryDataCache.get(path);
  if (cached) {
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveLibraryImage(path);
    if (dataUrl) {
      libraryDataCache.set(path, dataUrl);
    }
    return dataUrl;
  } catch {
    return null;
  }
};

/** 上传/任意本地路径图片的 data URL 缓存（绝对路径或 upload/...，参考图用）。 */
export const uploadDataCache = new DataUrlCache();

/** 异步读取 upload/ 相对路径或绝对路径图片为 data URL（带字节预算 LRU；失败返回 null）。 */
export const resolveUploadDataUrl = async (
  path: string,
): Promise<string | null> => {
  const cached = uploadDataCache.get(path);
  if (cached) {
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveUploadImage(path);
    if (dataUrl) {
      uploadDataCache.set(path, dataUrl);
    }
    return dataUrl;
  } catch {
    return null;
  }
};

/** 图片扩展名白名单（外部文件拖入判断用）。 */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|tiff?)$/i;

/** 按扩展名推断图片 MIME（上传参考图用；服务端亦会按扩展名兜底）。 */
export const inferMimeFromPath = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
};

export type LibraryImageProps = {
  /** 本地图库相对路径（image/...）；提供时忽略 src。 */
  path?: string;
  /** 直接图片 src（远程代理 URL / data URL）；仅无 path 时使用。 */
  src?: string;
  alt: string;
  title?: string;
  className?: string;
  loading?: "lazy" | "eager";
  onClick?: () => void;
};

/**
 * 图库图片渲染组件：始终使用 img-proxy:// 协议（与聊天 markdown 图片同一链路），
 * 只有代理加载失败时才按需回退到 IPC 读取的 data URL，保证不出现破损图的同时
 * 不让每张可正常显示的图片都在渲染进程常驻一份 base64。
 */
export const LibraryImage = memo(function LibraryImage({
  path,
  src,
  alt,
  title,
  className,
  loading,
  onClick,
}: LibraryImageProps): React.JSX.Element {
  const [fallback, setFallback] = useState<{
    path: string;
    dataUrl: string;
  } | null>(null);

  if (!path) {
    return (
      <img
        src={src}
        alt={alt}
        title={title}
        className={className}
        loading={loading}
        onClick={onClick}
      />
    );
  }

  const isLibraryPath = path.startsWith("image/");
  const fallbackSrc = fallback?.path === path ? fallback.dataUrl : null;
  const effectiveSrc =
    fallbackSrc ??
    (isLibraryPath ? proxyForLibraryPath(path) : localImageProxyUrl(path));

  return (
    <img
      src={effectiveSrc}
      alt={alt}
      title={title}
      className={className}
      loading={loading}
      onClick={onClick}
      onError={() => {
        if (fallbackSrc) {
          return;
        }
        const load = isLibraryPath
          ? resolveLibraryDataUrl
          : resolveUploadDataUrl;
        void load(path).then((dataUrl) => {
          if (dataUrl) {
            setFallback({ path, dataUrl });
          }
        });
      }}
    />
  );
});
