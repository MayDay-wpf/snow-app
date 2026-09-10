/**
 * Markdown 图片代理自定义协议工具。
 *
 * 主进程通过 protocol.handle 注册 img-proxy:// 协议：
 *  - `img-proxy://localhost/<encodeURIComponent(http(s) URL)>` 代理外部图片
 *  - `img-proxy://local/<encodeURIComponent(路径)>` 读取本地图片
 *    （image/ 图库路径、upload/ 上传路径或磁盘绝对路径），由主进程读盘返回
 * 渲染进程通过 imageProxyUrl / localImageProxyUrl 构造代理 URL。
 *
 * 这个文件是纯函数，不依赖 electron 模块，主进程和渲染进程（含 Web Worker）均可导入。
 *
 * 存在动机：CSP 的 img-src 不允许 http:/https:，外部图片会被拒绝加载。
 * 通过自定义协议代理，CSP 只需放行 img-proxy: 即可；本地相对路径在渲染进程
 * 也没有静态映射，统一走协议后主进程直接读磁盘，无需 IPC + data URL 中转。
 */

export const IMG_PROXY_SCHEME = "img-proxy";

/** 外部图片代理的 host（区分本地文件分支）。 */
export const IMG_PROXY_REMOTE_HOST = "localhost";
/** 本地图片代理的 host。 */
export const IMG_PROXY_LOCAL_HOST = "local";

/** 仅允许代理 http/https URL，禁止 file:、data: 等被构造成代理地址。 */
const HTTP_OR_HTTPS = /^https?:\/\//i;

/**
 * 将外部 http(s) 图片 URL 转换为 img-proxy:// 代理 URL。
 * 非法 scheme 原样返回，避免误代理本地资源或已有 data: URL。
 */
export const imageProxyUrl = (originalUrl: string): string => {
  if (!HTTP_OR_HTTPS.test(originalUrl)) {
    return originalUrl;
  }
  return `${IMG_PROXY_SCHEME}://${IMG_PROXY_REMOTE_HOST}/${encodeURIComponent(
    originalUrl,
  )}`;
};

/** 绝对图片路径判断：Windows 盘符（D:/...）或 POSIX 根路径（/...）。
 *  调用前需已把反斜杠统一为正斜杠。 */
export const isAbsoluteImagePath = (path: string): boolean =>
  /^[a-zA-Z]:\//.test(path) || path.startsWith("/");

/**
 * 将本地图片路径（image/... 或 upload/... 相对路径，或磁盘绝对路径如
 * D:/proj/src/assets/logo.png）转换为 img-proxy:// 代理 URL。
 * 非本地路径原样返回。
 */
export const localImageProxyUrl = (path: string): string => {
  if (!path || !(/^(image|upload)\//.test(path) || isAbsoluteImagePath(path))) {
    return path;
  }
  return `${IMG_PROXY_SCHEME}://${IMG_PROXY_LOCAL_HOST}/${encodeURIComponent(
    path,
  )}`;
};

/**
 * 解码 img-proxy:// URL，还原出原始外部图片 URL。
 * 主进程协议处理器使用。
 */
export const decodeImageProxyUrl = (proxyUrl: string): string => {
  const url = new URL(proxyUrl);
  const encoded = url.pathname.replace(/^\//, "");
  return decodeURIComponent(encoded);
};

/**
 * 判断 img-proxy:// URL 是否指向本地文件（host 为 local）。
 * 主进程协议处理器据此分流到本地读盘分支。
 */
export const isLocalImageProxyUrl = (proxyUrl: string): boolean => {
  try {
    return new URL(proxyUrl).hostname === IMG_PROXY_LOCAL_HOST;
  } catch {
    return false;
  }
};
