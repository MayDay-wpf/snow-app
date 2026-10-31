import {
  app,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
} from "electron";
import { APP_ICON_PATH, APP_USER_MODEL_ID, isMacOS } from "./constants";
import { initializeApplicationServices } from "./applicationServices";
import { createWindow, getMainWindow, markCloseConfirmed } from "./mainWindow";
import { markDetachedPanelsQuitting } from "./detachedPanelWindow";
import { initDetachedPanelWindowState } from "./detachedPanelWindowState";
import { lockAppOnStartup } from "./appLock";
import { initTray } from "./tray";
import { registerGlobalShortcuts } from "./globalShortcuts";
import { registerIpcHandlers } from "../ipc/registerIpcHandlers";
import { native, getRawNative } from "../native/nativeBridge";
import { installGuestViewErrorFilter } from "../utils/guestViewErrorFilter";
import { flushLogs, snowLog } from "../../utils/snowLogger";
import {
  registerThemeBgProtocol,
  registerThemeBgSchemePrivilege,
} from "./themeBgProtocol";
import {
  registerImageProxyProtocol,
  registerImageProxySchemePrivilege,
} from "./imageProxyProtocol";
import {
  registerHtmlPreviewProtocol,
  registerHtmlPreviewSchemePrivilege,
} from "./htmlPreviewProtocol";
import { applySessionProxy } from "./sessionProxy";
import { ensureBuiltinDocs, ensureBuiltinSkills } from "./ensureBuiltinSkills";
import {
  initBrowserNetworkRecorder,
  initBrowserWebviewRegistry,
} from "../ipc/handlers/browserNetworkRecorder";
import { installWebviewContextMenu } from "../utils/webviewContextMenu";
import { installWebviewDownloadHandler } from "./downloadManager";
import { initCookieAutoBackup } from "./cookieAutoBackup";
import { initUserscriptSyncStore } from "./userscriptSyncStore";
import { initBrowserPopupHandler } from "../browser/browserPopupWindow";
import { initBrowserDeviceEmulation } from "../browser/browserDeviceEmulation";
import {
  initBrowserUserAgent,
  syncLocalBrowserUserAgent,
} from "../browser/browserUserAgent";
import { disposePetWindow, restorePetWindow } from "../pets/petWindow";
import { ensureBuiltinPets } from "../pets/ensureBuiltinPet";
import { registerRequestProxy } from "../requestProxy/requestProxy";
import { registerOAuthPlugins } from "../oauthPlugins/oauthPluginHost";
import { startScheduledTaskWakeup } from "./scheduledTaskWakeup";
import { isScheduledWakeLaunch } from "./scheduledWakeLaunch";
import { isTeamHostLaunch } from "../team/teamServiceLaunch";
import { stopRemoteControlServer } from "../remoteControl/remoteControlServer";
import { initializeRemoteControl } from "../remoteControl/remoteControlLifecycle";
import { remoteTunnelManager } from "../remoteControl/remoteTunnelManager";
import { disposeWebSearchService } from "../websearch/webSearchRegistry";
import { isInstallerQuitRequest } from "./installerQuit";
import { sanitizeLauncherEnvironment } from "./launcherEnvironment";
import { appendTrace, initRuntimeTrace } from "./runtimeTrace";

/** 队长服务是否正在运行（决定关窗后是否托盘常驻）。 */
const isTeamHostRunning = (): boolean => {
  try {
    const state = JSON.parse(native.teamHostState()) as { running?: boolean };
    return state.running === true;
  } catch {
    return false;
  }
};

export const bootstrapApplication = (): void => {
  // 必须先于任何子进程创建：剔除 Linux AppImage 运行时注入的 ARGV0，
  // 否则 zsh 会把它当作子命令的 argv[0]（python venv 因此失效）。
  sanitizeLauncherEnvironment();

  // ─── Chromium 启动加速开关（必须在 whenReady 之前）─────────────────────
  // 跳过 GPU 沙箱预热（部分显卡驱动初始化极慢）。
  app.commandLine.appendSwitch("disable-gpu-sandbox");

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
  // html-preview://：HTML 渲染器预览需要独立源（standard）才能按文档隔离。
  registerHtmlPreviewSchemePrivilege();

  // Prevent multiple instances — must be called before app.whenReady().
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }

  // 拿锁成功后立即安装运行时追踪：此后的退出、卡死、窗口销毁都会留痕。
  // 拿锁失败的第二实例不初始化，保持零日志静默退出。
  initRuntimeTrace();

  // The installer can launch the executable only to ask an existing instance
  // to quit. If there is no existing instance, do not open the full app.
  if (isInstallerQuitRequest(process.platform, process.argv)) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, commandLine) => {
    if (isInstallerQuitRequest(process.platform, commandLine)) {
      appendTrace({ ev: "second-instance-installer-quit" });
      snowLog.info({
        module: "app/bootstrap",
        func: "second-instance",
        message: "Installer requested a graceful application shutdown",
      });
      markCloseConfirmed();
      app.quit();
      return;
    }

    // 系统调度唤醒时应用已在运行：调度器自行触发，不打扰用户
    if (isScheduledWakeLaunch(commandLine)) {
      appendTrace({ ev: "second-instance-scheduled-wake" });
      snowLog.info({
        module: "app/bootstrap",
        func: "second-instance",
        message: "Scheduled wake ignored, application already running",
      });
      return;
    }

    appendTrace({ ev: "second-instance-focus" });
    snowLog.info({
      module: "app/bootstrap",
      func: "second-instance",
      message: "Second instance detected, focusing existing window",
    });
    // 使用 getMainWindow() 而非 getAllWindows()[0]：宠物窗口始终存在，
    // getAllWindows()[0] 可能返回宠物窗口而非会话主窗口。
    const existing = getMainWindow();
    if (existing) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      if (!existing.isVisible()) {
        existing.show();
      }
      existing.focus();
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
    // 注册 html-preview:// 协议处理器：HTML 渲染器会话内预览（按文档 id 由
    // Rust 解析缓存文件）。
    registerHtmlPreviewProtocol(native);
    // 对话请求代理层：注册 Rust 回调并确保用户脚本模板存在（模板默认不改变任何请求）。
    registerRequestProxy(native);
    // OAuth 登录插件：注册 Rust 回调并同步已启用插件声明的 provider。
    registerOAuthPlugins(native);
    // 预加载独立窗口记忆的尺寸（异步读取，创建窗口时无需同步读盘）。
    void initDetachedPanelWindowState();

    if (isMacOS && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PATH));
    }

    // 内置浏览器 UA：去掉 Electron/应用名 token，先用内核版本的标准 Chrome UA，
    // 原生模块加载后再对齐本机真实浏览器版本（见 did-finish-load）。
    initBrowserUserAgent();

    // ─── Cookie 自动备份与丢失自愈 ──────────────────────────────────────
    // Keychain "Chromium Safe Storage" 密钥漂移会让 Chromium 启动时静默清空
    // 整库 Cookie，此处启动检测骤减并自动恢复，周期加密快照兜底。
    initCookieAutoBackup();

    // ─── 极速出窗口 ─────────────────────────────────────────────────────
    // 第一优先级：创建窗口并加载 boot-loader HTML。
    // 窗口使用 show:false + ready-to-show，确保用户看到的第一帧就是
    // 完整的 loading 动画，而非空白/黑屏过渡。
    // 应用锁先落库：启用时本次启动必须重新验证身份，重启不可绕过。
    void lockAppOnStartup();
    // 系统调度唤醒 / 队长常驻服务：后台启动，仅保留托盘（macOS 同时隐藏 Dock 图标）
    const wakeLaunch = isScheduledWakeLaunch();
    const teamHostLaunch = isTeamHostLaunch();
    const backgroundLaunch = wakeLaunch || teamHostLaunch;
    if (backgroundLaunch && isMacOS) {
      app.dock?.hide();
    }
    const mainWindow = createWindow({ show: !backgroundLaunch });
    if (backgroundLaunch) {
      snowLog.info({
        module: "app/bootstrap",
        func: "whenReady",
        message: "Launched in background, main window hidden",
        context: `scheduledWake=${wakeLaunch} teamHost=${teamHostLaunch}`,
      });
    }

    const stopScheduledTaskWakeup = startScheduledTaskWakeup(mainWindow);

    // 宠物窗口生命周期绑定主窗口：主窗口关闭后一并销毁宠物，
    // 避免 Windows 下悬浮宠物窗口残留导致进程无法退出。
    mainWindow.on("closed", () => {
      stopScheduledTaskWakeup();
      disposePetWindow();
    });

    // 初始化系统托盘（黑白脱色图标 + 悬停快速信息 + 右键菜单）。
    initTray(native);

    // 注册全局生效的快捷键（foregroundOnly=false 的动作，默认含 toggleWindow）。
    // native 代理已做 storageReady 门控，会等待 storage 就绪后读取设置再注册。
    void registerGlobalShortcuts(native);

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
    // 手机遥控默认关闭；仅在用户于设置中开启过时恢复服务与公网隧道，
    // 启动失败不会阻塞 Snow 主程序。
    void initializeRemoteControl();
    // 团队协作：队长恢复 WebSocket 服务，队员恢复与队长的长连接。
    void native.teamResumeServices().catch((error) => {
      snowLog.warn({
        module: "app/bootstrap",
        func: "teamResumeServices",
        message: "Failed to resume team services",
        error: error instanceof Error ? error.message : String(error),
      });
    });
    powerMonitor.on("resume", () => {
      // 重连失败不影响主应用；隧道状态在设置的远控面板中可见。
      void remoteTunnelManager
        .reconnectAfterSystemResume()
        .catch(() => undefined);
    });
    // 用户脚本同步匹配缓存：必须在任何 webview 创建前注册 sendSync
    // handler（webview preload 顶层同步调用，未注册会死锁渲染进程）。
    initUserscriptSyncStore(native);

    // 浏览器调试数据收集：网络请求记录 + JavaScript 弹窗捕获（幂等）。
    // 需在 app ready 且 defaultSession 可用后初始化。
    initBrowserNetworkRecorder();
    initBrowserWebviewRegistry();
    // 浏览器弹出窗口：webview 内 window.open / target=_blank 创建真实窗体
    // （Google 登录等 OAuth 弹窗依赖 window.opener 关系，不能转交系统浏览器）。
    initBrowserPopupHandler();
    // 浏览器显示尺寸设备模拟：guest webContents 的 DPR / 屏幕类型 / UA 覆盖。
    initBrowserDeviceEmulation();
    // 浏览器右键菜单：Electron webview 默认无右键菜单，需主进程手动弹出。
    installWebviewContextMenu();
    // webview 下载接管：无 will-download 监听器时 Electron 会静默取消下载，
    // 使网页 a[download] / Blob 下载（含用户脚本 GM_download）全部失效。
    installWebviewDownloadHandler();

    // 渲染进程保存代理设置后通知主进程重新应用会话代理。
    ipcMain.handle("proxy-browser-settings:apply", () =>
      applySessionProxy(native),
    );

    // ─── 重型原生模块延迟到页面首帧绘制完成后加载 ─────────────────────────
    // 40MB .node 文件的 require() 是同步阻塞操作。
    // 等待 did-finish-load 确保 boot-loader HTML 已完成渲染，
    // 用户已看到 loading 动画后再执行阻塞操作。
    mainWindow.webContents.once("did-finish-load", () => {
      // Initialise storage — use raw binding to avoid storageReady deadlock.
      initializeApplicationServices(getRawNative())
        .then(async () => {
          // 内置宠物包随应用分发（resources/pets），首次安装 / 升级 /
          // 内置包内容变化时由 Rust 侧解压安装到 ~/.snowapp/pets，
          // 老用户提前装过的同名宠物会被覆盖去重；安装失败不阻断启动。
          await ensureBuiltinPets(native).catch(() => undefined);
          await restorePetWindow(native);
        })
        .catch((error) => {
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

      // 内置浏览器 UA 对齐本机真实浏览器（Chrome/Edge 版本由 Rust 探测）。
      syncLocalBrowserUserAgent(native).catch((error) => {
        snowLog.warn({
          module: "app/bootstrap",
          func: "syncLocalBrowserUserAgent",
          message: "Failed to detect local browser version",
          error: error instanceof Error ? error.message : String(error),
        });
      });

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
      // macOS：点击 Dock 图标时，优先恢复已存在的主窗口（可能是最小化或
      // hide-to-tray 隐藏状态）；主窗口不存在时才创建新窗口。
      // 不能使用 getAllWindows().length 判断——宠物窗口始终存在，
      // 会导致最小化/隐藏主窗口后点击 Dock 图标无法复原。
      const existing = getMainWindow();
      if (existing) {
        if (existing.isMinimized()) {
          existing.restore();
        }
        if (!existing.isVisible()) {
          existing.show();
        }
        existing.focus();
      } else {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") {
      return;
    }
    // 队长服务运行中：保留进程与托盘常驻，团队队员继续在线；
    // 用户可从托盘菜单显式退出。
    if (isTeamHostRunning()) {
      snowLog.info({
        module: "app/bootstrap",
        func: "window-all-closed",
        message: "All windows closed, staying resident for team host service",
      });
      return;
    }
    snowLog.info({
      module: "app/bootstrap",
      func: "window-all-closed",
      message: "All windows closed, quitting application",
    });
    app.quit();
  });

  let remoteShutdownComplete = false;
  let remoteShutdownPromise: Promise<void> | null = null;

  // 退出前释放远控监听端口和隧道进程、关闭常驻的 headless 浏览器，
  // 并销毁宠物窗口。
  app.on("before-quit", (event) => {
    markDetachedPanelsQuitting();
    disposePetWindow();
    if (remoteShutdownComplete) return;

    event.preventDefault();
    remoteShutdownPromise ??= Promise.all([
      remoteTunnelManager.shutdown(),
      stopRemoteControlServer(),
      // 团队协作：断开队员长连接并停止队长 WebSocket 服务。
      native.teamShutdownServices(),
      // 联网搜索的浏览器实例不随父进程退出而结束，必须显式关闭。
      disposeWebSearchService(),
      // 自动格式化已改为延迟执行：退出前把尚未落盘的格式化任务跑完。
      native.flushPendingFileFormats(),
      flushLogs(),
    ])
      .then(() => undefined)
      .finally(() => {
        remoteShutdownComplete = true;
        app.quit();
      });
  });
};
