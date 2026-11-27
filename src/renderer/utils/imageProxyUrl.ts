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

/** 本地图片路径长度上限（与主进程 serveLocalImage 的校验一致）。 */
const LOCAL_IMAGE_PATH_MAX = 512;

/** 相对路径解析前的图片扩展名白名单（与主进程绝对路径分支一致）。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|ico|avif)$/i;

/**
 * 归一化图片 src：解码 URL 转义、统一分隔符、去掉 ./ 前缀。
 * 只认图库 / 上传逻辑前缀或磁盘绝对路径，其余返回 null（交给基准目录解析）。
 */
export const normalizeLocalImagePath = (src: string): string | null => {
  if (!src || src.length > LOCAL_IMAGE_PATH_MAX || /\s/.test(src)) {
    return null;
  }
  // markdown-it 会把反斜杠路径（image\2026-...）URL 编码为 %5C，先解码
  // 再统一分隔符判断；非法 % 转义按字面值处理。
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // 保留原值
  }
  const normalized = decoded.replace(/\\/g, "/").replace(/^\.\//, "");
  // 绝对路径：交给主进程直接读盘（主进程侧限制图片扩展名）。
  if (isAbsoluteImagePath(normalized)) {
    return normalized.includes("..") ? null : normalized;
  }
  if (!/^(image|upload)\//.test(normalized) || normalized.includes("..")) {
    return null;
  }
  return normalized;
};

/**
 * 相对图片路径按基准目录解析为绝对路径（支持 ./ 与 ../ 回退）。
 * 结果统一为正斜杠；越界、带协议或含空白的输入返回 null。
 */
export const resolveRelativeImagePath = (
  src: string,
  baseDir: string,
): string | null => {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // 保留原值
  }
  const trimmed = decoded.trim();
  if (
    !trimmed ||
    trimmed.length > LOCAL_IMAGE_PATH_MAX ||
    /\s/.test(trimmed) ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    // 带协议（file:、javascript: 等）的地址不按路径解析
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  ) {
    return null;
  }
  const posixBase = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^[a-zA-Z]:/.test(posixBase) ? posixBase.slice(0, 2) : "";
  const root = drive || posixBase.startsWith("/") ? "/" : "";
  const stack = (drive ? posixBase.slice(2) : posixBase)
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  for (const part of trimmed.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // 越过基准目录根：拒绝，避免代理到预期之外的文件
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) {
    return null;
  }
  // 统一输出正斜杠：本地图片代理按 isAbsoluteImagePath 判定，Windows 盘符
  // 路径必须保持 `D:/...` 形式（主进程读盘前会归一化为原生分隔符）。
  const resolved = `${drive}${root}${stack.join("/")}`;
  if (resolved.length > LOCAL_IMAGE_PATH_MAX) {
    return null;
  }
  return resolved;
};

/**
 * 预览用图片地址：http(s) 走远程代理，本地绝对 / 图库路径与相对路径
 * （按 baseDir 解析）走本地代理；data: 与已代理地址原样返回。
 * 无法处理时返回 null，由调用方决定保留原值还是丢弃。
 */
export const resolvePreviewImageSrc = (
  src: string,
  baseDir?: string,
): string | null => {
  const trimmed = src.trim();
  if (!trimmed || trimmed.length > LOCAL_IMAGE_PATH_MAX) {
    return null;
  }
  if (/^data:image\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith(`${IMG_PROXY_SCHEME}://`)) {
    return trimmed;
  }
  if (HTTP_OR_HTTPS.test(trimmed)) {
    return imageProxyUrl(trimmed);
  }
  // 其他协议（file:、javascript: 等）一律不代理
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }
  const local = normalizeLocalImagePath(trimmed);
  if (local) {
    return localImageProxyUrl(local);
  }
  const relative = baseDir ? resolveRelativeImagePath(trimmed, baseDir) : null;
  return relative && IMAGE_EXT_RE.test(relative)
    ? localImageProxyUrl(relative)
    : null;
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
