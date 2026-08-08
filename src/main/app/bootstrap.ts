import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
} from "electron";
import { APP_ICON_PATH, APP_USER_MODEL_ID, isMacOS } from "./constants";
import { initializeApplicationServices } from "./applicationServices";
import { createWindow } from "./mainWindow";
import { initTray } from "./tray";
import { registerIpcHandlers } from "../ipc/registerIpcHandlers";
import { native, getRawNative } from "../native/nativeBridge";
import { installGuestViewErrorFilter } from "../utils/guestViewErrorFilter";
import { snowLog } from "../../utils/snowLogger";
import {
  registerThemeBgProtocol,
  registerThemeBgSchemePrivilege,
} from "./themeBgProtocol";
import {
  registerImageProxyProtocol,
  registerImageProxySchemePrivilege,
} from "./imageProxyProtocol";
import { applySessionProxy } from "./sessionProxy";
import { ensureBuiltinDocs, ensureBuiltinSkills } from "./ensureBuiltinSkills";
import {
  initBrowserDialogHandler,
  initBrowserNetworkRecorder,
} from "../ipc/handlers/browserNetworkRecorder";
import { installWebviewContextMenu } from "../utils/webviewContextMenu";
import { initBrowserPopupHandler } from "../browser/browserPopupWindow";

export const bootstrapApplication = (): void => {
  // ─── Chromium 启动加速开关（必须在 whenReady 之前）─────────────────────
  // 禁用不必要的 GPU 光栅化和合成特性检测，减少内核初始化耗时。
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  // 跳过 GPU 沙箱预热（部分显卡驱动初始化极慢）。
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // 禁用后台节流，确保启动阶段渲染不被降频。
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");

  snowLog.info({
    module: "app/bootstrap",
    func: "bootstrapApplication",
    message: "Application bootstrap started",
    context: `platform=${process.platform} electron=${process.versions.electron}`,
  });

  // registerSchemesAsPrivileged 必须在 app.whenReady() 之前调用，
  // 否则 Chromium 不会允许在 CSS url() / <img src> 中加载 theme-bg:// 资源。
  registerThemeBgSchemePrivilege();
  // img-proxy:// 同样需要在 whenReady 前声明特权，才能用于 <img src>。
  registerImageProxySchemePrivilege();

  // Prevent multiple instances — must be called before app.whenReady().
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    snowLog.info({
      module: "app/bootstrap",
      func: "second-instance",
      message: "Second instance detected, focusing existing window",
    });
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      const win = windows[0];
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  // Install early, before any webview is created, so that expected
  // GUEST_VIEW_MANAGER_CALL navigation-abort errors are filtered from logs.
  installGuestViewErrorFilter();

  app.name = "Snow App";

  // Windows 上必须设置 AppUserModelID，否则系统通知会显示默认的
  // "electron.app.Snow App" 包名形式，且无法正确归类到本应用。
  // 需在 app.whenReady() 之前调用，保证 Notification 初始化时已生效。
  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    nativeTheme.themeSource = "system";

    // 注册 theme-bg:// 自定义协议处理器，使渲染进程能加载本地背景图。
    // 必须在 createWindow 之前调用，确保窗口加载时协议已就绪。
    registerThemeBgProtocol();
    // 注册 img-proxy:// 协议处理器：代理外部 http(s) 图片，并直接读取本地
    // image/、upload/ 图片文件返回，使 markdown 图片能绕过 CSP 限制安全加载。
    registerImageProxyProtocol(native);

    if (isMacOS && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PATH));
    }

    // ─── 极速出窗口 ─────────────────────────────────────────────────────
    // 第一优先级：创建窗口并加载 boot-loader HTML。
    // 窗口使用 show:false + ready-to-show，确保用户看到的第一帧就是
    // 完整的 loading 动画，而非空白/黑屏过渡。
    const mainWindow = createWindow();

    // 初始化系统托盘（黑白脱色图标 + 悬停快速信息 + 右键菜单）。
    initTray(native);

    // 安装/同步内置 skills 与内置文档（供 snow-app-docs 技能阅读）：
    // 首次安装、应用升级或开发模式下自动推送官方版本；内置 skill 的
    // 用户启用/禁用开关会在同步时保留。
    ensureBuiltinSkills();
    ensureBuiltinDocs();

    snowLog.info({
      module: "app/bootstrap",
      func: "whenReady",
      message: "Application ready, main window created",
    });

    // IPC 注册放在窗口创建之后 — 渲染进程 boot-loader 阶段不需要 IPC，
    // 等 React 挂载后才会发起 invoke 调用，此时注册早已完成。
    registerIpcHandlers(native);

    // 浏览器调试数据收集：网络请求记录 + JavaScript 弹窗捕获（幂等）。
    // 需在 app ready 且 defaultSession 可用后初始化。
    initBrowserNetworkRecorder();
    initBrowserDialogHandler();
    // 浏览器弹出窗口：webview 内 window.open / target=_blank 创建真实窗体
    // （Google 登录等 OAuth 弹窗依赖 window.opener 关系，不能转交系统浏览器）。
    initBrowserPopupHandler();
    // 浏览器右键菜单：Electron webview 默认无右键菜单，需主进程手动弹出。
    installWebviewContextMenu();

    // 渲染进程保存代理设置后通知主进程重新应用会话代理。
    ipcMain.handle("proxy-browser-settings:apply", () =>
      applySessionProxy(native)
    );

    // ─── 重型原生模块延迟到页面首帧绘制完成后加载 ─────────────────────────
    // 40MB .node 文件的 require() 是同步阻塞操作。
    // 等待 did-finish-load 确保 boot-loader HTML 已完成渲染，
    // 用户已看到 loading 动画后再执行阻塞操作。
    mainWindow.webContents.once("did-finish-load", () => {
      // Initialise storage — use raw binding to avoid storageReady deadlock.
      initializeApplicationServices(getRawNative()).catch((error) => {
        console.error("Failed to initialize application storage:", error);
        snowLog.error({
          module: "app/bootstrap",
          func: "initializeApplicationServices",
          message: "Failed to initialize application storage",
          error: error instanceof Error ? error.message : String(error),
        });
      });

      // 启动时应用会话代理，使 net.fetch / electron-updater 走内置代理配置。
      void applySessionProxy(native);

      // Apply persisted theme mode to nativeTheme as soon as storage is ready.
      getRawNative()
        .getThemeSettings()
        .then((settings) => {
          if (
            settings.mode === "light" ||
            settings.mode === "dark" ||
            settings.mode === "system"
          ) {
            nativeTheme.themeSource = settings.mode;
          }
        })
        .catch((error) => {
          console.warn("Failed to apply persisted theme mode:", error);
          snowLog.warn({
            module: "app/bootstrap",
            func: "applyThemeSettings",
            message: "Failed to apply persisted theme mode",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      snowLog.info({
        module: "app/bootstrap",
        func: "window-all-closed",
        message: "All windows closed, quitting application",
      });
      app.quit();
    }
  });
};
