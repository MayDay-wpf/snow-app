/**
 * 图片保存共享工具。
 *
 * 由生图工具调用（ImageGenToolCall）与 Markdown 图片灯箱共用，
 * 避免各组件重复实现 data URL 解码与文件保存逻辑。
 */

/** 将 data URL 直接解码为 Blob。不走 fetch(dataUrl) —— CSP connect-src
 *  不允许 data:，fetch 会被拦截导致保存静默失败（点击无反应）。 */
export const dataUrlToBlob = (dataUrl: string): Blob => {
  const [header, base64] = dataUrl.split(",");
  const mimeType =
    /^data:([^;]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

/** 把任意图片 src（data URL、http(s) URL 或 img-proxy:// 代理 URL）解析为 Blob。 */
export const srcToBlob = async (src: string): Promise<Blob> => {
  if (src.startsWith("data:")) {
    return dataUrlToBlob(src);
  }
  // img-proxy:// 是主进程注册的自定义协议（CSP connect-src 已放行），
  // fetch 由主进程代理转发，无 CORS 限制。
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`fetch image failed: ${response.status}`);
  }
  return response.blob();
};

/**
 * 把 Blob 保存到本地：原生文件选择器优先（可自定义路径），
 * 回退为浏览器下载（anchor + download）。
 */
export const saveBlobToFile = async (
  blob: Blob,
  filename: string
): Promise<void> => {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types: { description?: string; accept: Record<string, string[]> }[];
      }) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [
          {
            description: "Image file",
            accept: { [blob.type]: [blob.type] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch {
      // User cancelled the picker — fall through to anchor download.
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** 按 Blob MIME 推断图片扩展名，未知类型回退为 png。 */
export const extensionForBlob = (blob: Blob): string => {
  const mimeType = blob.type || "image/png";
  if (mimeType.includes("webp")) {
    return "webp";
  }
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return "jpg";
  }
  if (mimeType.includes("gif")) {
    return "gif";
  }
  if (mimeType.includes("svg")) {
    return "svg";
  }
  return "png";
};

/** 下载一张图片（data URL 或 http(s) URL），供灯箱等场景使用。 */
export const downloadImageSrc = async (src: string): Promise<void> => {
  const blob = await srcToBlob(src);
  const filename = `image-${Date.now()}.${extensionForBlob(blob)}`;
  await saveBlobToFile(blob, filename);
};
