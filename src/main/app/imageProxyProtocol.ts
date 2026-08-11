import { protocol, net } from "electron";
import { readFile } from "fs/promises";
import { join, normalize, sep } from "path";
import type { NativeBridge } from "../native/types";
import {
  IMG_PROXY_SCHEME,
  decodeImageProxyUrl,
  isLocalImageProxyUrl,
} from "../../renderer/utils/imageProxyUrl";

let registered = false;

/** 代理图片下载的最大字节数，避免被超大响应拖垮主进程内存。 */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB

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

/**
 * 本地图片分支：img-proxy://local/<encodeURIComponent(相对路径)>。
 *
 * 相对路径必须以 image/（图库）或 upload/（上传）开头，拒绝 `..` 穿越、
 * 绝对路径与超长输入。image/ 以图库根目录为根，upload/ 以数据库目录下的
 * upload 目录为根（相对路径自带 upload/ 前缀，直接基于数据库目录拼接）。
 * 解析后做前缀二次校验，保证读取始终落在允许的目录内。
 */
const serveLocalImage = async (
  proxyUrl: string,
  native: NativeBridge
): Promise<Response> => {
  const relative = decodeImageProxyUrl(proxyUrl);
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");
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

  const bytes = await readFile(filePath);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return new Response("Image too large", { status: 413 });
  }

  const headers = new Headers();
  headers.set("Content-Type", mimeForImagePath(filePath));
  // 不允许客户端缓存代理结果，避免改图后不刷新。
  headers.set("Cache-Control", "no-store");
  return new Response(bytes, { status: 200, headers });
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

  protocol.handle(IMG_PROXY_SCHEME, async (request) => {
    try {
      // 本地图片分支：host 为 local
      if (isLocalImageProxyUrl(request.url)) {
        return await serveLocalImage(request.url, native);
      }

      const originalUrl = decodeImageProxyUrl(request.url);

      // 仅允许 http/https，防止通过代理绕过 CSP 访问 file:/data: 等资源。
      if (!/^https?:\/\//i.test(originalUrl)) {
        return new Response("Forbidden: only http(s) URLs can be proxied", {
          status: 403,
        });
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

      const headers = new Headers();
      headers.set("Content-Type", contentType);
      // 不允许客户端缓存代理结果，避免改图后不刷新；如需缓存可在主进程做 LRU。
      headers.set("Cache-Control", "no-store");

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
  });
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
