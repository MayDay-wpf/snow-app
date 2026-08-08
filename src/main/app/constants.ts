import { join } from "node:path";
import { app } from "electron";

export const isMacOS = process.platform === "darwin";
export const isWindows = process.platform === "win32";
export const macTrafficLightPosition = { x: 18, y: 28 };

// 图标资源根目录：
// - 打包后由 electron-builder extraResources 复制到 process.resourcesPath
//   （Windows: <安装目录>/resources，macOS: .app/Contents/Resources）；
// - 开发/preview 模式下 out/main 相对项目根目录，直接使用 resources/。
// 不能固定用模块目录相对路径：打包后模块位于 app.asar 内，
// 而图标 PNG 未打进 asar，会导致托盘/窗口图标全部加载失败。
const RESOURCES_DIR = app.isPackaged
  ? process.resourcesPath
  : join(import.meta.dirname, "../../resources");

export const APP_ICON_PATH = join(RESOURCES_DIR, "icon.png");
// Windows 标题栏小图标优先使用包含多尺寸位图的 ICO；PNG 在 Chromium DevTools
// 内容完成加载后可能被其默认 Electron favicon 覆盖或无法生成合适的 HICON。
export const APP_WINDOW_ICON_PATH = join(
  RESOURCES_DIR,
  isWindows ? "icon.ico" : "icon.png"
);

// 托盘图标用的小尺寸源图：16px（100% DPI）与 32px（200% DPI @2x 表示），
// 直接使用设计好的 favicon，避免从大图缩放导致的模糊。
export const APP_FAVICON_16_PATH = join(RESOURCES_DIR, "web/favicon-16.png");
export const APP_FAVICON_32_PATH = join(RESOURCES_DIR, "web/favicon-32.png");

/**
 * Windows 应用用户模型 ID (AppUserModelID)。
 *
 * 该 ID 必须与 electron-builder 配置中的 `appId` 一致，否则 Windows 通知中心
 * 会使用默认的 `electron.app.<productName>` 形式（导致显示成 "electron.app.Snow App"），
 * 同时通知无法正确归类到应用、开始菜单快捷方式也会丢失应用名。
 *
 * 在 app.whenReady() 之前或之后调用 `app.setAppUserModelId()` 都可以生效，
 * 这里作为常量统一维护，避免与 package.json 中的 build.appId 漂移。
 */
export const APP_USER_MODEL_ID = "com.snow.app";
