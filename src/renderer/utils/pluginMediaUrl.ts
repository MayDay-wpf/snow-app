/**
 * 工具卡本地媒体预览的自定义协议工具。
 *
 * 主进程通过 protocol.handle 注册 plugin-media://，只读取媒体扩展名的本地文件；
 * 渲染进程通过 pluginMediaUrl(path) 构造 URL 供 <video> / <audio> / <img> 使用。
 *
 * 扩展名 → MIME 表在这里单点定义：主进程的白名单校验与渲染进程的 kind 判断
 * 都从本文件消费，禁止在别处复制第二份表。
 *
 * 这个文件是纯函数，不依赖 electron 模块，主进程和渲染进程均可导入。
 */

export const PLUGIN_MEDIA_SCHEME = "plugin-media";

export type PluginMediaKind = "video" | "audio" | "image";

export type PluginMediaType = Readonly<{
  kind: PluginMediaKind;
  mime: string;
}>;

/**
 * 允许协议读取的扩展名。刻意不包含 svg（唯一可携带活动内容的图片类型）
 * 与文本 / HTML / JSON / PDF：预览面只服务音视频与位图产物。
 */
const MEDIA_TYPES: Readonly<
  Record<string, readonly [PluginMediaKind, string]>
> = {
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  ogv: ["video", "video/ogg"],
  mp3: ["audio", "audio/mpeg"],
  m4a: ["audio", "audio/mp4"],
  ogg: ["audio", "audio/ogg"],
  oga: ["audio", "audio/ogg"],
  opus: ["audio", "audio/ogg"],
  wav: ["audio", "audio/wav"],
  flac: ["audio", "audio/flac"],
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  jfif: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  avif: ["image", "image/avif"],
  bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"],
};

const extensionOf = (path: string): string =>
  path.match(/\.([^./\\]+)$/)?.[1].toLowerCase() ?? "";

/** 媒体类型（含 MIME）；扩展名不在白名单时返回 undefined。 */
export const pluginMediaType = (path: string): PluginMediaType | undefined => {
  const entry = MEDIA_TYPES[extensionOf(path)];
  return entry ? { kind: entry[0], mime: entry[1] } : undefined;
};

/** 仅返回预览种类，供插件决定缩略图 / 播放器形态。 */
export const pluginMediaKind = (path: string): PluginMediaKind | undefined =>
  pluginMediaType(path)?.kind;

const isAbsoluteLocalPath = (path: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/");

/**
 * 将本地媒体文件绝对路径转换为 plugin-media:// URL。
 *
 * 非媒体扩展名、相对路径、含控制字符或 UNC 前缀的路径一律返回 undefined，
 * 让调用方降级到普通路径展示，而不是渲染一个必定 403 的元素。
 */
export const pluginMediaUrl = (filePath: string): string | undefined => {
  if (!filePath || /[\u0000-\u001f]/.test(filePath)) return undefined;
  // UNC 路径（\\server\share）不经过本协议，避免把网络位置当本地文件读取。
  if (/^[\\/]{2}/.test(filePath)) return undefined;
  const normalized = filePath.replace(/\\/g, "/");
  if (!isAbsoluteLocalPath(normalized)) return undefined;
  if (!pluginMediaType(normalized)) return undefined;
  return `${PLUGIN_MEDIA_SCHEME}://localhost/${encodeURIComponent(normalized)}`;
};
