import { protocol } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { isAbsolute, normalize } from "node:path";
import {
  PLUGIN_MEDIA_SCHEME,
  pluginMediaType,
  type PluginMediaType,
} from "../../renderer/utils/pluginMediaUrl";

/**
 * plugin-media:// 协议：只读、只服务媒体扩展名的普通文件。
 *
 * URL 格式：plugin-media://localhost/<encodeURIComponent(绝对路径)>
 *
 * 与 theme-bg:// 的差异：
 * - 扩展名白名单（音视频 / 位图）而非目录白名单 —— 产物目录由用户决定，
 *   目录白名单会让“导出到任意目录再预览”失效；
 * - 实现 HTTP Range：<video> 拖动进度条依赖 206 Partial Content，
 *   且成片可达数百 MB，必须流式返回而不是整文件读入内存。
 */

let registered = false;

/** 工具卡产物可能很大：Range 解析只接受单区间，多区间回退 200 由浏览器自行处理。 */
const parseRange = (
  header: string | null,
  size: number,
): { start: number; end: number } | null | "invalid" => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "invalid";
  if (start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
};

const streamBody = (
  filePath: string,
  range: { start: number; end: number } | null,
): ReadableStream<Uint8Array> => {
  const nodeStream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
};

const resolveMediaPath = (
  requestUrl: string,
): { filePath: string; media: PluginMediaType } | null => {
  let decoded: string;
  try {
    const url = new URL(requestUrl);
    decoded = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
  if (!decoded || /[\u0000-\u001f]/.test(decoded)) return null;
  if (!isAbsolute(decoded)) return null;
  // 目录穿越在 join/normalize 后仍是普通绝对路径，最终由扩展名 + 普通文件校验兜底。
  const filePath = normalize(decoded);
  const media = pluginMediaType(filePath);
  if (!media) return null;
  return { filePath, media };
};

/**
 * 注册 plugin-media:// 处理器。必须在 app.whenReady() 之后调用。
 */
export const registerPluginMediaProtocol = (): void => {
  if (registered) return;
  registered = true;

  protocol.handle(PLUGIN_MEDIA_SCHEME, async (request) => {
    try {
      const resolved = resolveMediaPath(request.url);
      if (!resolved) {
        return new Response("Forbidden: unsupported media path", {
          status: 403,
        });
      }

      let size: number;
      try {
        const stats = await stat(resolved.filePath);
        if (!stats.isFile()) {
          return new Response("Not found", { status: 404 });
        }
        size = stats.size;
      } catch {
        return new Response("Not found", { status: 404 });
      }

      const headers = new Headers({
        "Content-Type": resolved.media.mime,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });

      const range = parseRange(request.headers.get("range"), size);
      if (range === "invalid") {
        headers.set("Content-Range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      if (range) {
        headers.set("Content-Length", String(range.end - range.start + 1));
        headers.set(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
        return new Response(streamBody(resolved.filePath, range), {
          status: 206,
          headers,
        });
      }

      headers.set("Content-Length", String(size));
      return new Response(streamBody(resolved.filePath, null), {
        status: 200,
        headers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`Failed to load media: ${message}`, { status: 500 });
    }
  });
};

/**
 * 在 app.whenReady 之前调用，声明 scheme 特权。
 * stream: true 允许媒体元素按需读取；bypassCSP: false 让 CSP 仍然生效。
 */
export const registerPluginMediaSchemePrivilege = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_MEDIA_SCHEME,
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
