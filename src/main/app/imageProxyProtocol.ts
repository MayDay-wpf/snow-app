import { protocol, net } from "electron";
import { createHash } from "crypto";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, normalize, sep } from "path";
import type { NativeBridge } from "../native/types";
import {
  IMG_PROXY_SCHEME,
  decodeImageProxyUrl,
  imageProxyUrl,
  isAbsoluteImagePath,
  isLocalImageProxyUrl,
} from "../../renderer/utils/imageProxyUrl";

let registered = false;

/** 代理图片下载的最大字节数，避免被超大响应拖垮主进程内存。 */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB

/** 绝对路径分支要求的图片扩展名白名单，避免代理协议沦为任意文件读取通道。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|ico|avif)$/i;

/** 按扩展名推断图片 MIME，未知扩展名回退 image/png（与图片 IPC 行为一致）。 */
const mimeForImagePath = (filePath: string): string => {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
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

/** 读盘并构造图片响应（大小上限校验；客户端不缓存，避免改图后不刷新）。 */
const serveImageFile = async (filePath: string): Promise<Response> => {
  const bytes = await readFile(filePath);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return new Response("Image too large", { status: 413 });
  }

  const headers = new Headers();
  headers.set("Content-Type", mimeForImagePath(filePath));
  headers.set("Cache-Control", "no-store");
  return new Response(bytes, { status: 200, headers });
};

/**
 * 本地图片分支：img-proxy://local/<encodeURIComponent(路径)>。
 *
 * 两种形态：
 *  - 绝对路径：模型常引用磁盘上的完整路径（如 D:/proj/src/assets/logo.png），
 *    仅放行图片扩展名（防 `..`、超长输入），校验后直接读盘。
 *  - 相对路径：必须以 image/（图库）或 upload/（上传）开头，以对应根目录
 *    （图库根目录 / 数据库目录下的 upload 目录）为基准拼接；解析后做前缀
 *    二次校验，保证读取始终落在允许的目录内。
 */
const serveLocalImage = async (
  proxyUrl: string,
  native: NativeBridge,
): Promise<Response> => {
  const relative = decodeImageProxyUrl(proxyUrl);
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");

  // 绝对路径分支：直接读盘（normalize 统一为平台原生分隔符）。
  if (isAbsoluteImagePath(normalized)) {
    if (
      normalized.length > 512 ||
      normalized.includes("..") ||
      !IMAGE_EXT_RE.test(normalized)
    ) {
      return new Response("Forbidden: invalid local image path", {
        status: 403,
      });
    }
    return serveImageFile(normalize(normalized));
  }

  if (
    !normalized ||
    normalized.length > 512 ||
    !/^(image|upload)\//.test(normalized) ||
    normalized.includes("..")
  ) {
    return new Response("Forbidden: invalid local image path", {
      status: 403,
    });
  }

  let root: string;
  let inner: string;
  if (normalized.startsWith("image/")) {
    root = await native.getImageLibraryRoot();
    // 根目录本身即 image 目录（物理文件直接位于根目录下，按 日期/文件名 落盘），
    // image/ 仅为逻辑前缀 —— 与 Rust 侧 library_file_path 的 strip_prefix 保持一致。
    inner = normalized.slice("image/".length);
  } else {
    // upload/ 同上：根目录本身即 upload 目录，upload/ 仅为逻辑前缀。
    root = await native.getUploadRoot();
    inner = normalized.slice("upload/".length);
  }

  const filePath = normalize(join(root, inner));
  // 二次校验：解析后的路径必须仍在允许的根目录内（防符号链接/分隔符绕过）。
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (
    filePath !== root &&
    !filePath.toLowerCase().startsWith(rootPrefix.toLowerCase())
  ) {
    return new Response("Forbidden: path escapes root", { status: 403 });
  }

  return serveImageFile(filePath);
};

/** 是否为站点 favicon 请求（`<origin>/favicon.ico`）；favicon 变化频率极低，
 *  允许缓存，避免徽章 DOM 重建时重复请求上游导致图标闪烁。 */
const isFaviconUrl = (url: string): boolean => {
  try {
    return new URL(url).pathname.endsWith("/favicon.ico");
  } catch {
    return false;
  }
};

/** 头像类图片的 host 白名单：体积小、内容稳定，且提交卡片会反复展示，
 *  因此额外落盘长期缓存（与普通图片 no-store 的「改图即刷新」区分开）。 */
const AVATAR_HOSTS = new Set([
  "github.com",
  "avatars.githubusercontent.com",
  "secure.gravatar.com",
  "gravatar.com",
  "www.gravatar.com",
  "q1.qlogo.cn",
  "q2.qlogo.cn",
  "q3.qlogo.cn",
  "q4.qlogo.cn",
]);

/** 头像缓存有效期：GitHub 头像换图后 URL 不变，靠 TTL 兜底刷新。 */
const AVATAR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 头像磁盘缓存目录（应用自有数据目录，与 browser-state 等约定一致）。 */
const avatarCacheDir = (): string => join(homedir(), ".snowapp", "avatars");

const isAvatarUrl = (url: string): boolean => {
  try {
    return AVATAR_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** 缓存文件按 URL 的 sha1 命名，避免同一 owner 的不同尺寸互相覆盖。 */
const avatarCachePath = (url: string): string =>
  join(avatarCacheDir(), `${createHash("sha1").update(url).digest("hex")}.img`);

/** 命中未过期缓存时直接返回本地字节；未命中 / 过期返回 null 走网络分支。 */
const serveCachedAvatar = async (url: string): Promise<Response | null> => {
  const filePath = avatarCachePath(url);
  try {
    const info = await stat(filePath);
    if (Date.now() - info.mtimeMs > AVATAR_CACHE_TTL_MS) {
      return null;
    }

    const bytes = await readFile(filePath);
    const headers = new Headers();
    // GitHub / Gravatar 头像均为位图，统一按 PNG 声明即可被解码器识别。
    headers.set("Content-Type", "image/png");
    headers.set("Cache-Control", "no-store");
    return new Response(bytes, { status: 200, headers });
  } catch {
    return null;
  }
};

/** 把上游头像写入本地缓存；写失败只影响下次命中，不向上抛。 */
const cacheAvatar = async (url: string, bytes: Buffer): Promise<void> => {
  try {
    await mkdir(avatarCacheDir(), { recursive: true });
    await writeFile(avatarCachePath(url), bytes);
  } catch {
    // 忽略：缓存是纯优化，失败时下次请求重新拉取即可。
  }
};

/**
 * 注册 img-proxy:// 自定义协议，代理外部 HTTP/HTTPS 图片与本地图片文件。
 *
 * URL 格式：
 *  - 外部：img-proxy://localhost/<encodeURIComponent(原始图片 URL)>
 *  - 本地：img-proxy://local/<encodeURIComponent(image/ 或 upload/ 相对路径)>
 *
 * 渲染进程通过 imageProxyUrl(url) / localImageProxyUrl(path) 构造 URL。
 * 外部请求主进程用 net.fetch（基于 Chromium 网络栈，异步非阻塞）获取并透传；
 * 本地请求主进程直接读磁盘返回。这样 CSP 只需放行 img-proxy:，渲染进程无需
 * IPC 中转或 data URL。
 *
 * 必须在 app.whenReady() 之后调用。
 */
export const registerImageProxyProtocol = (native: NativeBridge): void => {
  if (registered) {
    return;
  }
  registered = true;

  protocol.handle(IMG_PROXY_SCHEME, (request) =>
    respondImageProxy(request.url, native),
  );
};

/** img-proxy:// 请求的统一响应：协议处理器与主进程内读取（readImageSource）共用。 */
const respondImageProxy = async (
  proxyUrl: string,
  native: NativeBridge,
): Promise<Response> => {
  try {
    // 本地图片分支：host 为 local
    if (isLocalImageProxyUrl(proxyUrl)) {
      return await serveLocalImage(proxyUrl, native);
    }

    const originalUrl = decodeImageProxyUrl(proxyUrl);

    // 仅允许 http/https，防止通过代理绕过 CSP 访问 file:/data: 等资源。
    if (!/^https?:\/\//i.test(originalUrl)) {
      return new Response("Forbidden: only http(s) URLs can be proxied", {
        status: 403,
      });
    }

    // 头像走本地磁盘缓存：命中即返回，不再打上游（断网也能显示）。
    const avatar = isAvatarUrl(originalUrl);
    if (avatar) {
      const cached = await serveCachedAvatar(originalUrl);
      if (cached) {
        return cached;
      }
    }

    const upstream = await net.fetch(originalUrl, {
      redirect: "follow",
      // 避免主进程挂载本地 Cookie 仓库泄露给第三方图床。
      credentials: "omit",
    });

    if (!upstream.ok) {
      return new Response(`Upstream responded ${upstream.status}`, {
        status: upstream.status,
      });
    }

    // 校验 Content-Type，避免被当作图片代理拉取 HTML/JSON 等。
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return new Response(`Unsupported content-type: ${contentType}`, {
        status: 415,
      });
    }

    // 限制响应体大小，防止超大文件耗尽内存。
    const contentLength = Number(upstream.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      return new Response("Image too large", { status: 413 });
    }

    // 读取后转发，避免上游流式响应被 Chromium 挂起；同时便于二次大小校验。
    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return new Response("Image too large", { status: 413 });
    }

    // 回写头像缓存（不阻塞本次响应）。
    if (avatar) {
      void cacheAvatar(originalUrl, Buffer.from(buffer));
    }

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    // 普通图片 no-store 避免改图不刷新；favicon 允许缓存（站点图标基本不变）。
    headers.set(
      "Cache-Control",
      isFaviconUrl(originalUrl) ? "public, max-age=86400" : "no-store",
    );

    return new Response(buffer, {
      status: 200,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to proxy image: ${message}`, {
      status: 502,
    });
  }
};

/**
 * 在主进程内读取任意图片来源的字节：data URL、img-proxy:// 代理地址或 http(s) URL。
 *
 * 渲染进程对 img-proxy:// 发起 fetch 属于跨源请求（自定义协议未开启 CORS），
 * 会被 Chromium 直接拒绝，因此保存 / 复制图片统一交给主进程按同一代理逻辑读取。
 */
export const readImageSource = async (
  src: string,
  native: NativeBridge,
): Promise<{ bytes: Buffer; mimeType: string }> => {
  if (src.startsWith("data:")) {
    const commaIndex = src.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Invalid image data URL");
    }
    const header = src.slice(0, commaIndex);
    const mimeType = /^data:([^;,]+)/.exec(header)?.[1] ?? "image/png";
    const payload = src.slice(commaIndex + 1);
    const bytes = header.includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { bytes, mimeType };
  }

  const proxyUrl = src.startsWith(`${IMG_PROXY_SCHEME}://`)
    ? src
    : imageProxyUrl(src);
  if (!proxyUrl.startsWith(`${IMG_PROXY_SCHEME}://`)) {
    throw new Error("Unsupported image source");
  }

  const response = await respondImageProxy(proxyUrl, native);
  if (!response.ok) {
    throw new Error(
      `Read image failed: ${response.status} ${await response.text()}`,
    );
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") ?? "image/png",
  };
};

/**
 * 在 app.whenReady 之前调用，声明 scheme 特权。
 * 这样 Chromium 才会允许在 <img src> 中加载该协议的资源。
 */
export const registerImageProxySchemePrivilege = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMG_PROXY_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
};
