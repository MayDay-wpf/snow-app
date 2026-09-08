import { ipcMain, webContents, type WebContents } from "electron";
import { getBrowserWebContents } from "../ipc/handlers/browserNetworkRecorder";

/**
 * 内置浏览器「显示尺寸」设备模拟（主进程侧）。
 *
 * 渲染端选中设备后，除 webview 元素的 CSS 宽高约束外，DPR / 移动端屏幕
 * 类型 / User-Agent 的模拟必须作用于 guest webContents —— 这是 Electron
 * 主进程能力（webContents.enableDeviceEmulation + setUserAgent），渲染端
 * 无法触达。这里提供 browser:device-emulation IPC：
 *
 *   params = { width, height, dpr, mobile, userAgent } → 应用模拟；
 *   params = null                                        → 关闭模拟并还原 UA。
 *
 * 安全：webContentsId 必须属于内置浏览器 webview 注册表
 * （getBrowserWebContents 校验），伪造 id 无法操纵任意页面。
 */

/** 渲染端传入的视口模拟参数（null 表示关闭模拟）。 */
export type BrowserDeviceEmulationParams = {
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  userAgent: string;
};

const DEVICE_EMULATION_CHANNEL = "browser:device-emulation";

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.round(value), min), max);

/** 校验渲染端传参（非法时抛错，防止脏数据落进 webContents API）。 */
const sanitizeParams = (
  value: unknown,
): BrowserDeviceEmulationParams | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object") {
    throw new Error("Invalid device emulation params");
  }
  const raw = value as Record<string, unknown>;
  const width = typeof raw.width === "number" ? raw.width : Number.NaN;
  const height = typeof raw.height === "number" ? raw.height : Number.NaN;
  const dpr = typeof raw.dpr === "number" ? raw.dpr : Number.NaN;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(dpr)
  ) {
    throw new Error("Invalid device emulation params");
  }
  return {
    width: clampInt(width, 50, 4000),
    height: clampInt(height, 50, 4000),
    dpr: clampInt(dpr * 8, 8, 64) / 8,
    mobile: raw.mobile === true,
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent.slice(0, 512) : "",
  };
};

/** 对 guest webContents 应用（或关闭）设备模拟与 UA 覆盖。 */
const applyDeviceEmulation = (
  contents: WebContents,
  params: BrowserDeviceEmulationParams | null,
): void => {
  if (contents.isDestroyed()) {
    return;
  }
  if (params) {
    // viewSize 不覆盖（空尺寸）：视口仍由 webview 元素的 CSS 尺寸决定，
    // 主进程只接管 DPR / 屏幕类型 / 屏幕尺寸（媒体查询与 devicePixelRatio）。
    contents.enableDeviceEmulation({
      screenPosition: params.mobile ? "mobile" : "desktop",
      screenSize: { width: params.width, height: params.height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: params.dpr,
      viewSize: { width: 0, height: 0 },
      scale: 1,
    });
  } else {
    contents.disableDeviceEmulation();
  }
  // UA：设备自带 UA 时覆盖；否则还原为会话默认（webContents 层覆盖不影响
  // session 级 UA，因此 session.getUserAgent() 即为初始值）。
  const defaultUa = contents.session.getUserAgent();
  contents.setUserAgent(params?.userAgent ? params.userAgent : defaultUa);
};

/** 初始化（幂等）：注册 browser:device-emulation IPC。 */
export const initBrowserDeviceEmulation = (): void => {
  ipcMain.handle(
    DEVICE_EMULATION_CHANNEL,
    (_event, webContentsId: unknown, params: unknown): void => {
      if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId)) {
        throw new Error("webContentsId must be an integer");
      }
      // 校验 id 属于内置浏览器 webview（防止伪造 id 操纵任意 webContents）。
      const contents = getBrowserWebContents(webContentsId);
      applyDeviceEmulation(contents, sanitizeParams(params));
    },
  );
};
