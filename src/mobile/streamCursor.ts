import type { SnowRemoteStreamCursor } from "../renderer/types/remoteControl";

/**
 * 移动端流式光标：与桌面 StreamCursor.tsx 的六种形态一一对应。
 *
 * 桌面把光标做成 React 组件（lucide / snowbot / SVG / 图片 / canvas 脚本），
 * 远控页没有 React 树，这里用 DOM 直接构造同一套标记：
 * - dot / lucide / custom / image：由主题配置驱动（custom / image 走
 *   /api/theme-asset 读取 stream-cursors 目录）；
 * - snowbot：按桌面 AnimatedSnowBotIcon 的关键帧逐帧替换；
 * - canvas：脚本在 Worker + OffscreenCanvas 中运行，与桌面执行器一致。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_ICON_SIZE = 14;
const MIN_ICON_SIZE = 8;
const MAX_ICON_SIZE = 48;

const DEFAULT_CONFIG: SnowRemoteStreamCursor = {
  iconType: "dot",
  lucideName: "",
  iconSize: DEFAULT_ICON_SIZE,
  assetName: "",
};

/** 流式光标可用的 lucide path 数据（与桌面 streamCursorIcons 列表一致）。 */
const LUCIDE_ICONS: Record<string, string> = {
  Loader2: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  Loader:
    '<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>',
  LoaderPinwheel:
    '<path d="M22 12a1 1 0 0 1-10 0 1 1 0 0 0-10 0"/><path d="M7 20.7a1 1 0 1 1 5-8.7 1 1 0 1 0 5-8.6"/><path d="M7 3.3a1 1 0 1 1 5 8.6 1 1 0 1 0 5 8.6"/><circle cx="12" cy="12" r="10"/>',
  Aperture:
    '<circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/>',
  Cog: '<path d="M11 10.27 7 3.34"/><path d="m11 13.73-4 6.93"/><path d="M12 22v-2"/><path d="M12 2v2"/><path d="M14 12h8"/><path d="m17 20.66-1-1.73"/><path d="m17 3.34-1 1.73"/><path d="M2 12h2"/><path d="m20.66 17-1.73-1"/><path d="m20.66 7-1.73 1"/><path d="m3.34 17 1.73-1"/><path d="m3.34 7 1.73 1"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="8"/>',
  Fan: '<path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z"/><path d="M12 12v.01"/>',
  Sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  CircleDashed:
    '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>',
  LifeBuoy:
    '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/>',
  Compass:
    '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
  Disc3:
    '<circle cx="12" cy="12" r="10"/><path d="M6 12c0-1.7.7-3.2 1.8-4.2"/><circle cx="12" cy="12" r="2"/><path d="M18 12c0 1.7-.7 3.2-1.8 4.2"/>',
  RefreshCw:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  Crosshair:
    '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
  Shell:
    '<path d="M14 11a2 2 0 1 1-4 0 4 4 0 0 1 8 0 6 6 0 0 1-12 0 8 8 0 0 1 16 0 10 10 0 1 1-20 0 11.93 11.93 0 0 1 2.42-7.22 2 2 0 1 1 3.16 2.44"/>',
  Orbit:
    '<path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/>',
  Atom: '<circle cx="12" cy="12" r="1"/><path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/><path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"/>',
  Snowflake:
    '<path d="m10 20-1.25-2.5L6 18"/><path d="M10 4 8.75 6.5 6 6"/><path d="m14 20 1.25-2.5L18 18"/><path d="m14 4 1.25 2.5L18 6"/><path d="m17 21-3-6h-4"/><path d="m17 3-3 6 1.5 3"/><path d="M2 12h6.5L10 9"/><path d="m20 10-1.5 2 1.5 2"/><path d="M22 12h-6.5L14 15"/><path d="m4 10 1.5 2L4 14"/><path d="m7 21 3-6-1.5-3"/><path d="m7 3 3 6h4"/>',
  Star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  Diamond:
    '<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>',
};

/** Snow Bot 关键帧（与桌面 AnimatedSnowBotIcon 的 12 帧完全一致）。 */
const SNOWBOT_HEAD =
  '<rect x="3.6" y="5.6" width="16.8" height="13.8" rx="4.6"/><path d="M12 5.6V3.3"/><circle cx="12" cy="2.4" r="0.8"/><path d="M10.9 15.3q1.1 0.9 2.2 0"/>';
const SNOWBOT_EYES_OPEN =
  '<circle cx="9" cy="11.9" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="11.9" r="1.5" fill="currentColor" stroke="none"/>';
const SNOWBOT_EYES_BLINK =
  '<path d="M7.9 12q1.1 0.7 2.2 0"/><path d="M13.9 12q1.1 0.7 2.2 0"/>';
const SNOWBOT_EYES_UP_LEFT =
  '<circle cx="7.6" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="13.6" cy="10.5" r="1.5" fill="currentColor" stroke="none"/>';
const SNOWBOT_EYES_UP_RIGHT =
  '<circle cx="10.4" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="16.4" cy="10.5" r="1.5" fill="currentColor" stroke="none"/>';
const SNOWBOT_EYES_SLEEP =
  '<path d="M7.9 11.8q1.1 1.25 2.2 0"/><path d="M13.9 11.8q1.1 1.25 2.2 0"/>';
const SNOWBOT_Z1 =
  '<path d="M0 0h2.4l-2.4 2.4h2.4" transform="translate(14.6 2.4) scale(0.6)"/>';
const SNOWBOT_Z2 =
  '<path d="M0 0h2.4l-2.4 2.4h2.4" transform="translate(16.9 1.4) scale(0.7)"/>';
const SNOWBOT_Z3 =
  '<path d="M0 0h2.4l-2.4 2.4h2.4" transform="translate(19.3 0.9) scale(0.8)"/>';

const snowbotFrame = (eyes: string, zzz = ""): string =>
  `<g>${SNOWBOT_HEAD}${eyes}${zzz}</g>`;

const SNOWBOT_FRAMES: string[] = [
  snowbotFrame(SNOWBOT_EYES_OPEN),
  snowbotFrame(SNOWBOT_EYES_BLINK),
  snowbotFrame(SNOWBOT_EYES_OPEN),
  snowbotFrame(SNOWBOT_EYES_UP_LEFT),
  snowbotFrame(SNOWBOT_EYES_UP_RIGHT),
  snowbotFrame(SNOWBOT_EYES_OPEN),
  snowbotFrame(SNOWBOT_EYES_BLINK),
  snowbotFrame(SNOWBOT_EYES_OPEN),
  snowbotFrame(SNOWBOT_EYES_SLEEP),
  snowbotFrame(SNOWBOT_EYES_SLEEP, SNOWBOT_Z1),
  snowbotFrame(SNOWBOT_EYES_SLEEP, SNOWBOT_Z1 + SNOWBOT_Z2),
  snowbotFrame(SNOWBOT_EYES_SLEEP, SNOWBOT_Z1 + SNOWBOT_Z2 + SNOWBOT_Z3),
];

const SNOWBOT_FRAME_MS = [
  1600, 120, 320, 600, 600, 320, 120, 260, 320, 320, 320, 1200,
];

/** Worker 执行器（拼接在用户脚本之后，与桌面 StreamCursorCanvas 一致）。 */
const CANVAS_RUNNER_SOURCE = `
;(() => {
  const drawFn = typeof draw === "function" ? draw : self.draw;
  const raf = typeof self.requestAnimationFrame === "function"
    ? self.requestAnimationFrame.bind(self)
    : (cb) => setTimeout(() => cb(performance.now()), 16);
  const caf = typeof self.cancelAnimationFrame === "function"
    ? self.cancelAnimationFrame.bind(self)
    : clearTimeout;
  let canvas = null, ctx = null, size = 14, dpr = 1, dark = false, handle = 0, start = 0;
  const fail = (error) => {
    caf(handle);
    self.postMessage({ type: "error", message: String((error && error.message) || error) });
  };
  const applySize = () => {
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
  };
  const frame = (now) => {
    handle = raf(frame);
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFn(ctx, size, (now - start) / 1000, dark);
    } catch (error) {
      fail(error);
    }
  };
  self.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "init") {
      if (typeof drawFn !== "function") {
        fail("draw(ctx, size, t, dark) is not defined");
        return;
      }
      canvas = data.canvas;
      ctx = canvas.getContext("2d");
      size = data.size; dpr = data.dpr; dark = data.dark;
      applySize();
      start = performance.now();
      handle = raf(frame);
    } else if (data.type === "resize" && canvas) {
      size = data.size; dpr = data.dpr;
      applySize();
    } else if (data.type === "theme") {
      dark = data.dark;
    }
  };
})();
`;

let currentConfig: SnowRemoteStreamCursor = DEFAULT_CONFIG;

const clampIconSize = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_ICON_SIZE;
  return Math.min(MAX_ICON_SIZE, Math.max(MIN_ICON_SIZE, Math.round(value)));
};

const normalizeConfig = (
  next: SnowRemoteStreamCursor | undefined,
): SnowRemoteStreamCursor => {
  if (!next) return DEFAULT_CONFIG;
  return {
    iconType: next.iconType,
    lucideName: typeof next.lucideName === "string" ? next.lucideName : "",
    iconSize: clampIconSize(next.iconSize),
    assetName: typeof next.assetName === "string" ? next.assetName : "",
  };
};

const themeAssetUrl = (name: string): string =>
  `/api/theme-asset/${encodeURIComponent(name)}`;

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const isDarkTheme = (): boolean =>
  document.documentElement.dataset.theme !== "light";

const currentDpr = (): number => Math.min(3, window.devicePixelRatio || 1);

const configDigest = (config: SnowRemoteStreamCursor): string =>
  `${config.iconType}|${config.lucideName}|${config.iconSize}|${config.assetName}`;

/** 主题配置摘要：形态变化必须让流式光标节点重建。 */
export const streamCursorDigest = (): string => configDigest(currentConfig);

/** 应用桌面流式光标配置（写入根 CSS 变量，配置未变化时直接返回）。 */
export const applyStreamCursorConfig = (
  next: SnowRemoteStreamCursor | undefined,
): void => {
  const normalized = normalizeConfig(next);
  if (configDigest(currentConfig) === configDigest(normalized)) return;
  currentConfig = normalized;

  const root = document.documentElement;
  root.style.setProperty("--stream-cursor-size", `${normalized.iconSize}px`);
  if (normalized.iconType === "custom" && normalized.assetName) {
    root.style.setProperty(
      "--stream-cursor-svg",
      `url("${themeAssetUrl(normalized.assetName)}")`,
    );
  } else {
    root.style.removeProperty("--stream-cursor-svg");
  }
};

const dotNode = (): HTMLElement => {
  const dot = document.createElement("span");
  dot.className = "stream-cursor-dot";
  return dot;
};

const lucideNode = (name: string, size: number): SVGSVGElement | null => {
  const paths = LUCIDE_ICONS[name.trim()];
  if (!paths) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "stream-cursor-lucide-icon");
  svg.innerHTML = paths;
  return svg;
};

const snowbotNode = (size: number): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const group = document.createElementNS(SVG_NS, "g");
  svg.append(group);
  group.innerHTML = SNOWBOT_FRAMES[0];
  if (prefersReducedMotion()) return svg;

  let index = 0;
  const step = (): void => {
    // 时间线重建后节点被移除，动画随之结束。
    if (!svg.isConnected) return;
    window.setTimeout(step, SNOWBOT_FRAME_MS[index]);
    index = (index + 1) % SNOWBOT_FRAMES.length;
    group.innerHTML = SNOWBOT_FRAMES[index];
  };
  window.setTimeout(step, SNOWBOT_FRAME_MS[0]);
  return svg;
};

const imageNode = (name: string, size: number): HTMLElement => {
  const img = document.createElement("img");
  img.className = "stream-cursor-image-icon";
  img.src = themeAssetUrl(name);
  img.alt = "";
  img.draggable = false;
  img.style.height = `${size}px`;
  return img;
};

const canvasNode = (name: string, size: number): HTMLElement => {
  const host = document.createElement("span");
  host.className = "stream-cursor-canvas-host";
  const canvas = document.createElement("canvas");
  canvas.className = "stream-cursor-canvas-icon";
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  host.append(canvas);

  if (
    typeof Worker === "undefined" ||
    typeof canvas.transferControlToOffscreen !== "function"
  ) {
    host.replaceChildren(dotNode());
    return host;
  }

  let worker: Worker | null = null;
  let objectUrl = "";
  let disposed = false;
  const dispose = (): void => {
    disposed = true;
    worker?.terminate();
    worker = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
  };
  const fail = (): void => {
    if (disposed) return;
    dispose();
    host.replaceChildren(dotNode());
  };

  fetch(themeAssetUrl(name), { credentials: "same-origin" })
    .then((response) =>
      response.ok
        ? response.text()
        : Promise.reject(new Error("theme asset unavailable")),
    )
    .then((code) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(
        new Blob([code, "\n", CANVAS_RUNNER_SOURCE], {
          type: "text/javascript",
        }),
      );
      worker = new Worker(objectUrl);
      worker.onerror = (event) => {
        event.preventDefault();
        fail();
      };
      worker.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "error") fail();
      };
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage(
        {
          type: "init",
          canvas: offscreen,
          size,
          dpr: currentDpr(),
          dark: isDarkTheme(),
        },
        [offscreen],
      );
    })
    .catch(() => fail());

  // 流式结束后节点被移除：回收 Worker 与 Blob URL（脚本可能一直画帧）。
  const watcher = window.setInterval(() => {
    if (canvas.isConnected) return;
    window.clearInterval(watcher);
    dispose();
  }, 1000);

  return host;
};

/** 构造一个完整的流式光标节点（形态由当前主题配置决定）。 */
export const createStreamCursorNode = (): HTMLElement => {
  const host = document.createElement("span");
  host.className = "stream-cursor";
  host.setAttribute("aria-hidden", "true");
  const { iconType, lucideName, iconSize, assetName } = currentConfig;

  let content: Node | null = null;
  if (iconType === "lucide") {
    content = lucideNode(lucideName, iconSize);
  } else if (iconType === "snowbot") {
    content = snowbotNode(iconSize);
  } else if (iconType === "custom" && assetName) {
    const icon = document.createElement("span");
    icon.className = "stream-cursor-custom-icon";
    content = icon;
  } else if (iconType === "image" && assetName) {
    content = imageNode(assetName, iconSize);
  } else if (iconType === "canvas" && assetName) {
    content = canvasNode(assetName, iconSize);
  }

  host.append(content ?? dotNode());
  return host;
};
