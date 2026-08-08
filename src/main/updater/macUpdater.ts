// macOS 无签名更新流程
//
// 应用没有代码签名证书，不能走 electron-updater 的签名更新方案，改为：
//   1. 主进程请求服务端 latest-mac.json 比对版本，下载全量 xxx-mac.zip；
//   2. 下载完校验 SHA256 哈希防篡改（Rust 后端异步计算，不阻塞 Node）；
//   3. 用户确认更新 -> 关闭 Electron 主程序 -> 拉起独立 bash 脚本；
//   4. 脚本静默执行：删除旧 App、unzip 解压新版、xattr -cr 清除隔离属性、
//      open 启动新版本。
//
// 全程静默后台替换，无需用户拖拽 DMG、无需手动授权。

import { app, ipcMain, net, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { snowLog } from "../../utils/snowLogger";
import { markCloseConfirmed } from "../app/mainWindow";
import { applySessionProxy } from "../app/sessionProxy";
import { getRawNative, native } from "../native/nativeBridge";
import {
  getUpdateStatus,
  setUpdateStatus,
  subscribeUpdateStatus,
} from "./updateStatus";

const UPDATE_CHANNEL = "updater:status-changed";

// 更新清单地址。默认指向 GitHub Releases 的 latest 资源，
// 可通过环境变量 SNOW_UPDATE_MANIFEST_URL 覆盖（用于测试自建服务端）。
const MANIFEST_URL =
  process.env.SNOW_UPDATE_MANIFEST_URL ??
  "https://github.com/MayDay-wpf/snow-app/releases/latest/download/latest-mac.json";

// 运行时定时检查间隔（毫秒），默认 1 小时
const RUNTIME_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// 统一的应用 User-Agent（与 native 侧 http_client.rs 保持一致）：
// Snow-App/<version> Snow App <role> (<OS>; <arch>)
const appUserAgent = (role?: string): string =>
  `Snow-App/${app.getVersion()} Snow App${role ? ` ${role}` : ""} (${uaPlatform()})`;

const uaPlatform = (): string => {
  // process.getSystemVersion() 返回真实系统版本（如 10.0.26100 / 15.3.1 / 24.04）
  const sysVer = process.getSystemVersion();
  if (process.platform === "win32") {
    const arch = process.arch === "arm64" ? "ARM64" : "x64";
    return `Windows NT ${sysVer}; Win64; ${arch}`;
  }
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "ARM64" : "Intel";
    return `Macintosh; ${arch} Mac OS X ${sysVer.replace(/\./g, "_")}`;
  }
  if (process.platform === "linux") {
    return `X11; Linux ${process.arch} (${sysVer})`;
  }
  return `${process.platform}; ${process.arch}`;
};

// 清单请求超时（毫秒）
const MANIFEST_FETCH_TIMEOUT_MS = 20 * 1000;

// 安装脚本等待旧进程退出的最长时间（秒）
const INSTALL_WAIT_APP_EXIT_SEC = 90;

interface MacUpdateFileInfo {
  url: string;
  sha256: string;
  size?: number;
}

interface MacUpdateManifest {
  version: string;
  publishedAt?: string;
  files: Record<string, MacUpdateFileInfo>;
}

let initialized = false;
let mainWindowRef: BrowserWindow | null = null;
let runtimeCheckTimer: NodeJS.Timeout | null = null;
let checkInFlight = false;
let downloadInFlight = false;

// 已下载并通过校验的更新包（install 时使用）
let downloadedZipPath: string | null = null;
let downloadedVersion: string | null = null;

const getUpdatesDir = (): string => join(app.getPath("userData"), "updates");

const getZipPathFor = (version: string): string =>
  join(getUpdatesDir(), `snow-app-update-${version}-${process.arch}.zip`);

const getStoredManifestPath = (): string =>
  join(getUpdatesDir(), "latest-mac.json");

const broadcastStatus = (): void => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(UPDATE_CHANNEL, getUpdateStatus());
  }
};

// ---------------------------------------------------------------------------
// 版本比对
// ---------------------------------------------------------------------------

const parseVersion = (version: string): number[] =>
  version
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => parseInt(part, 10) || 0);

const isNewerVersion = (candidate: string, current: string): boolean => {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  const length = Math.max(candidateParts.length, currentParts.length);
  for (let i = 0; i < length; i += 1) {
    const left = candidateParts[i] ?? 0;
    const right = currentParts[i] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// 清单获取与校验
// ---------------------------------------------------------------------------

const fetchManifest = async (): Promise<MacUpdateManifest> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
  try {
    const response = await net.fetch(MANIFEST_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": appUserAgent("Updater"),
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const raw = (await response.json()) as Partial<MacUpdateManifest>;

    if (typeof raw.version !== "string" || !raw.version.trim()) {
      throw new Error("更新清单缺少 version 字段");
    }
    const fileInfo = raw.files?.[process.arch];
    if (!fileInfo || typeof fileInfo.url !== "string" || !fileInfo.url.trim()) {
      throw new Error(`更新清单缺少 ${process.arch} 架构的下载地址`);
    }
    if (typeof fileInfo.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(fileInfo.sha256)) {
      throw new Error("更新清单的 sha256 字段非法");
    }
    return {
      version: raw.version.trim(),
      publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : undefined,
      files: raw.files as MacUpdateManifest["files"],
    };
  } finally {
    clearTimeout(timeout);
  }
};

// ---------------------------------------------------------------------------
// 下载与校验
// ---------------------------------------------------------------------------

const downloadZip = async (
  fileInfo: MacUpdateFileInfo,
  zipPath: string
): Promise<void> => {
  const response = await net.fetch(fileInfo.url, {
    headers: {
      "User-Agent": appUserAgent("Updater"),
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  let lastReported = -1;

  const fileStream = createWriteStream(zipPath);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      // 写入时尊重背压，避免大文件下载时内存无界增长
      if (!fileStream.write(Buffer.from(value))) {
        await new Promise<void>((resolveDrain) => {
          fileStream.once("drain", resolveDrain);
        });
      }
      if (total > 0) {
        const percent = Math.min(99, Math.round((received / total) * 100));
        if (percent !== lastReported) {
          lastReported = percent;
          setUpdateStatus({ progress: percent });
        }
      }
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      fileStream.once("finish", resolveEnd);
      fileStream.once("error", rejectEnd);
      fileStream.end();
    });
  } finally {
    reader.releaseLock();
    // 正常完成时 destroy 无副作用；失败时确保文件句柄被释放
    fileStream.destroy();
  }

  if (total > 0 && received !== total) {
    throw new Error(`下载不完整：期望 ${total} 字节，实际 ${received} 字节`);
  }
};

const verifyZip = async (
  zipPath: string,
  fileInfo: MacUpdateFileInfo
): Promise<void> => {
  const fileStat = await stat(zipPath);
  if (typeof fileInfo.size === "number" && fileStat.size !== fileInfo.size) {
    throw new Error(
      `文件大小不匹配：期望 ${fileInfo.size} 字节，实际 ${fileStat.size} 字节`
    );
  }

  // Rust 后端异步计算 SHA-256，不阻塞 Node 主线程
  const actualHash = await getRawNative().sha256File(zipPath);
  if (actualHash.toLowerCase() !== fileInfo.sha256.toLowerCase()) {
    throw new Error(`SHA256 校验失败：期望 ${fileInfo.sha256}，实际 ${actualHash}`);
  }
};

// 清理更新目录下旧版本的 zip，只保留当前版本
const cleanupStaleZips = async (keepZipPath: string): Promise<void> => {
  try {
    const names = await readdir(getUpdatesDir());
    for (const name of names) {
      if (!name.startsWith("snow-app-update-") || !name.endsWith(".zip")) {
        continue;
      }
      const candidate = join(getUpdatesDir(), name);
      if (candidate !== keepZipPath) {
        rmSync(candidate, { force: true });
      }
    }
  } catch (error) {
    snowLog.warn({
      module: "updater/mac",
      func: "cleanupStaleZips",
      message: "Failed to clean stale update zips",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

const checkForUpdatesAction = async (): Promise<void> => {
  if (checkInFlight || downloadInFlight) {
    return;
  }
  checkInFlight = true;
  try {
    // 每次检查前同步代理设置，确保清单请求与后续下载走配置的代理
    await applySessionProxy(native);
    if (!app.isPackaged) {
      return;
    }
    const manifest = await fetchManifest();
    const currentVersion = app.getVersion();

    if (!isNewerVersion(manifest.version, currentVersion)) {
      setUpdateStatus({
        available: false,
        version: null,
        downloading: false,
        progress: 0,
        downloaded: false,
        error: null,
      });
      downloadedZipPath = null;
      downloadedVersion = null;
      return;
    }

    const fileInfo = manifest.files[process.arch];
    const zipPath = getZipPathFor(manifest.version);

    // 已下载过且哈希一致：直接进入“可安装”状态，跳过重复下载
    if (
      existsSync(zipPath) &&
      (await getRawNative().sha256File(zipPath)).toLowerCase() ===
        fileInfo.sha256.toLowerCase()
    ) {
      downloadedZipPath = zipPath;
      downloadedVersion = manifest.version;
      setUpdateStatus({
        available: true,
        version: manifest.version,
        downloading: false,
        progress: 100,
        downloaded: true,
        error: null,
      });
      return;
    }

    downloadedZipPath = null;
    downloadedVersion = null;
    setUpdateStatus({
      available: true,
      version: manifest.version,
      downloading: false,
      progress: 0,
      downloaded: false,
      error: null,
    });
  } catch (error) {
    snowLog.error({
      module: "updater/mac",
      func: "checkForUpdatesAction",
      message: "Check for updates failed",
      error: error instanceof Error ? error.message : String(error),
    });
    setUpdateStatus({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    checkInFlight = false;
  }
};

// ---------------------------------------------------------------------------
// 下载更新（复用 check 时解析的 manifest，避免重复请求）
// ---------------------------------------------------------------------------

const downloadUpdateAction = async (): Promise<void> => {
  if (downloadInFlight) {
    return;
  }
  downloadInFlight = true;
  try {
    // 下载前同步代理设置，确保更新包下载走配置的代理
    await applySessionProxy(native);
    if (!app.isPackaged) {
      throw new Error("开发模式下不支持下载更新");
    }
    // 已下载完成则直接返回
    if (
      downloadedZipPath &&
      downloadedVersion &&
      existsSync(downloadedZipPath)
    ) {
      return;
    }

    setUpdateStatus({ downloading: true, progress: 0, error: null });

    const manifest = await fetchManifest();
    if (!isNewerVersion(manifest.version, app.getVersion())) {
      setUpdateStatus({
        downloading: false,
        progress: 0,
        downloaded: false,
        available: false,
        version: null,
        error: null,
      });
      return;
    }

    const fileInfo = manifest.files[process.arch];
    const zipPath = getZipPathFor(manifest.version);

    if (!existsSync(getUpdatesDir())) {
      mkdirSync(getUpdatesDir(), { recursive: true });
    }

    try {
      await downloadZip(fileInfo, zipPath);
      setUpdateStatus({ progress: 99 });

      // 下载完成后校验大小与 SHA256，防篡改
      await verifyZip(zipPath, fileInfo);
    } catch (error) {
      // 下载或校验失败：删除残留文件，避免下次误用损坏的安装包
      rmSync(zipPath, { force: true });
      throw error;
    }

    // 保存 manifest 副本，供下次启动复用已下载的安装包
    await writeFile(
      getStoredManifestPath(),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    await cleanupStaleZips(zipPath);

    downloadedZipPath = zipPath;
    downloadedVersion = manifest.version;
    setUpdateStatus({
      downloading: false,
      progress: 100,
      downloaded: true,
      error: null,
    });
    snowLog.info({
      module: "updater/mac",
      func: "downloadUpdateAction",
      message: `Update downloaded and verified: ${manifest.version}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    snowLog.error({
      module: "updater/mac",
      func: "downloadUpdateAction",
      message: "Failed to download update",
      error: message,
    });
    setUpdateStatus({
      downloading: false,
      downloaded: false,
      error: message,
    });
  } finally {
    downloadInFlight = false;
  }
};

// ---------------------------------------------------------------------------
// 安装脚本（独立 bash 进程，应用退出后继续执行）
// ---------------------------------------------------------------------------

const buildInstallScript = (
  exePath: string,
  bundlePath: string,
  zipPath: string,
  destDir: string,
  logPath: string
): string => {
  const waitSeconds = INSTALL_WAIT_APP_EXIT_SEC;
  return [
    "#!/bin/bash",
    "# Snow App 无签名静默更新脚本（由应用生成，退出后独立执行）",
    `APP_EXE="${exePath}"`,
    `APP_BUNDLE="${bundlePath}"`,
    `ZIP_PATH="${zipPath}"`,
    `DEST_DIR="${destDir}"`,
    `LOG_FILE="${logPath}"`,
    "",
    'log() { echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] $1" >> "$LOG_FILE"; }',
    "",
    'mkdir -p "$(dirname "$LOG_FILE")"',
    'log "updater start"',
    'log "  exe=$APP_EXE"',
    'log "  bundle=$APP_BUNDLE"',
    'log "  zip=$ZIP_PATH"',
    'log "  dest=$DEST_DIR"',
    "",
    "app_running() {",
    '  ps -ax -o command= | grep -F "$APP_EXE" | grep -v grep >/dev/null 2>&1',
    "}",
    "",
    `# 等待旧应用完全退出，最长 ${waitSeconds} 秒`,
    `for _ in $(seq 1 ${waitSeconds}); do`,
    "  if ! app_running; then",
    "    break",
    "  fi",
    "  sleep 1",
    "done",
    "",
    "if app_running; then",
    '  log "[ERROR] app still running after timeout, abort"',
    "  exit 1",
    "fi",
    "",
    'log "removing old bundle"',
    'rm -rf "$APP_BUNDLE" >> "$LOG_FILE" 2>&1',
    "if [ $? -ne 0 ]; then",
    '  log "[ERROR] failed to remove old bundle"',
    "  exit 1",
    "fi",
    "",
    'log "unzipping update"',
    '/usr/bin/unzip -o -q "$ZIP_PATH" -d "$DEST_DIR" >> "$LOG_FILE" 2>&1',
    "if [ $? -ne 0 ]; then",
    '  log "[ERROR] failed to unzip update"',
    "  exit 1",
    "fi",
    "",
    'log "clearing quarantine attributes"',
    'xattr -cr "$APP_BUNDLE" >> "$LOG_FILE" 2>&1 || true',
    "",
    'log "launching new version"',
    'open "$APP_BUNDLE" >> "$LOG_FILE" 2>&1 || true',
    "",
    'log "updater done"',
    "exit 0",
  ].join("\n");
};

const installUpdateAction = async (): Promise<void> => {
  try {
    if (!app.isPackaged) {
      throw new Error("开发模式下不支持安装更新");
    }
    if (!downloadedZipPath || !downloadedVersion) {
      throw new Error("更新包不存在，请先完成下载");
    }
    if (!existsSync(downloadedZipPath)) {
      throw new Error("更新包文件缺失，请重新下载");
    }

    // exe 位于 <Bundle>.app/Contents/MacOS/<name>，向上三级即 .app 根目录
    const exePath = app.getPath("exe");
    const bundlePath = resolve(exePath, "..", "..", "..");
    const destDir = dirname(bundlePath);
    const scriptPath = join(getUpdatesDir(), "install-update.sh");
    const logPath = join(app.getPath("logs"), "updater.log");

    const script = buildInstallScript(
      exePath,
      bundlePath,
      downloadedZipPath,
      destDir,
      logPath
    );
    await writeFile(scriptPath, script, { mode: 0o755 });

    snowLog.info({
      module: "updater/mac",
      func: "installUpdateAction",
      message: `Spawning detached updater script, version: ${downloadedVersion}`,
    });

    // detached + unref：应用退出后脚本继续独立执行
    const child = spawn("/bin/bash", [scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // 跳过关闭二次确认，正常退出主程序，脚本随即接管替换流程
    markCloseConfirmed();
    app.quit();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    snowLog.error({
      module: "updater/mac",
      func: "installUpdateAction",
      message: "Failed to install update",
      error: message,
    });
    setUpdateStatus({ error: message });
  }
};

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

export const initMacUpdater = (mainWindow: BrowserWindow): void => {
  mainWindowRef = mainWindow;

  if (initialized) {
    return;
  }
  initialized = true;

  subscribeUpdateStatus(() => {
    broadcastStatus();
  });

  // 启动时异步检查更新
  setTimeout(() => {
    void checkForUpdatesAction();
  }, 3000);

  // 运行时定时检查：仅在无可用更新、未在下载、未下载完成时才实际检查
  runtimeCheckTimer = setInterval(() => {
    const status = getUpdateStatus();
    if (status.available || status.downloading || status.downloaded) {
      return;
    }
    void checkForUpdatesAction();
  }, RUNTIME_CHECK_INTERVAL_MS);

  ipcMain.handle("updater:download-update", async () => {
    await downloadUpdateAction();
    return getUpdateStatus();
  });

  ipcMain.handle("updater:install-update", async () => {
    await installUpdateAction();
  });

  ipcMain.handle("updater:get-status", () => getUpdateStatus());

  ipcMain.handle("updater:check-for-updates", async () => {
    await checkForUpdatesAction();
    return getUpdateStatus();
  });

  app.on("before-quit", () => {
    if (runtimeCheckTimer) {
      clearInterval(runtimeCheckTimer);
      runtimeCheckTimer = null;
    }
  });
};
