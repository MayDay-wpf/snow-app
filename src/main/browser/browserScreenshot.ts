import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
} from "../ipc/handlers/browserNetworkRecorder";

export type BrowserScreenshotFormat = "png" | "jpeg" | "webp";

export type BrowserScreenshotRequest = {
  format: BrowserScreenshotFormat;
  quality?: number;
  fullPage: boolean;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
  };
  filePath?: string;
};

export type BrowserScreenshotResult = {
  mimeType: string;
  bytes: number;
  savedTo: string | null;
  data?: string;
};

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

const MIME_TYPES: Record<BrowserScreenshotFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// 窗口最小化/被遮挡时 Chromium 会停掉合成器产帧，Page.captureScreenshot 要等一个
// 永远不会「呈现」的帧，于是整条命令挂起（实测最小化窗口下必挂）。截图期间持有帧订阅
// 即可解：合成器产出的帧直接交给订阅者，强制重绘无需等窗口呈现就能返回（实测最小化/
// 被遮挡窗口下连续截图全部成功，主窗口与 webview guest 均同）。窗口被真正隐藏
// （win.hide）时 Chromium 不建输出面，任何手段都取不到帧，只能报错。
//
// 视口截图单次超时先等 1.5s 就重试，避免整次截图卡住十几秒；整页/元素裁剪
// 需要 rasterize 整片内容，给足首轮时间，避免把正常的慢截图判成挂起。
const CROP_TIMEOUT_STEPS_MS = [4_000, 8_000];
const VIEWPORT_TIMEOUT_STEPS_MS = [1_500, 2_500];
const CAPTURE_RETRY_DELAY_MS = 150;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("timed out");

/** 截图期间持有帧订阅；不支持帧订阅的 webContents 直接执行，由重试兜底。 */
const withFrameSubscription = async <T>(
  contents: Electron.WebContents,
  run: () => Promise<T>,
): Promise<T> => {
  let subscribed = false;
  try {
    contents.beginFrameSubscription(true, () => {});
    subscribed = true;
  } catch {
    // 已有订阅或该 webContents 不支持帧订阅：直接截图。
  }
  try {
    return await run();
  } finally {
    if (subscribed) {
      try {
        contents.endFrameSubscription();
      } catch {
        // webContents 已销毁，无需收尾。
      }
    }
  }
};

const captureOnce = async (
  contents: Electron.WebContents,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ data?: unknown }> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return (await Promise.race([
      contents.debugger.sendCommand("Page.captureScreenshot", params),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Browser screenshot timed out after ${timeoutMs}ms: the page produced no frame (the tab may not be rendering)`,
            ),
          );
        }, timeoutMs);
      }),
    ])) as { data?: unknown };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/** 超时视为「暂未产帧」重试；其他错误立即抛出。 */
const captureWithRetry = async (
  contents: Electron.WebContents,
  params: Record<string, unknown>,
  timeouts: readonly number[],
): Promise<{ data?: unknown }> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
    try {
      return await captureOnce(contents, params, timeouts[attempt]);
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || attempt === timeouts.length - 1) {
        break;
      }
      // 已超时：给足后续更长的一轮，慢页面（大片 rasterize）能在这轮里完成。
      await delay(CAPTURE_RETRY_DELAY_MS);
    }
  }
  if (!isTimeoutError(lastError)) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Browser screenshot failed");
  }
  const message =
    lastError instanceof Error && lastError.message
      ? lastError.message
      : "Browser screenshot failed";
  throw new Error(
    `${message}; the browser window is hidden or the tab is not rendering - show the window and retry`,
  );
};

export const captureBrowserScreenshot = async (
  webContentsId: number,
  request: BrowserScreenshotRequest,
): Promise<BrowserScreenshotResult> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  const params: Record<string, unknown> = { format: request.format };
  if (request.quality !== undefined && request.format !== "png") {
    params.quality = request.quality;
  }
  if (request.fullPage || request.clip) {
    params.captureBeyondViewport = true;
  }
  if (request.clip) {
    params.clip = {
      x: request.clip.x,
      y: request.clip.y,
      width: request.clip.width,
      height: request.clip.height,
      scale: request.clip.scale ?? 1,
    };
  }
  const result = await withFrameSubscription(contents, () =>
    captureWithRetry(
      contents,
      params,
      request.fullPage || request.clip
        ? CROP_TIMEOUT_STEPS_MS
        : VIEWPORT_TIMEOUT_STEPS_MS,
    ),
  );
  if (typeof result.data !== "string" || result.data.length === 0) {
    throw new Error("Browser screenshot did not return image data");
  }
  const buffer = Buffer.from(result.data, "base64");
  if (request.filePath) {
    await mkdir(dirname(request.filePath), { recursive: true });
    await writeFile(request.filePath, buffer);
    return {
      mimeType: MIME_TYPES[request.format],
      bytes: buffer.byteLength,
      savedTo: request.filePath,
    };
  }
  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `Browser screenshot is too large to return inline (${buffer.byteLength} bytes, maximum ${MAX_SCREENSHOT_BYTES}); pass filePath to save it to a file instead`,
    );
  }
  return {
    mimeType: MIME_TYPES[request.format],
    bytes: buffer.byteLength,
    savedTo: null,
    data: result.data,
  };
};
