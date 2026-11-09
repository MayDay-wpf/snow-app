import { app } from "electron";
import { join } from "node:path";
import type { NativeBridge } from "../native/types";
import { onMainLocaleChange, refreshMainLocale, tMain } from "../i18n/mainI18n";
import { createWorkspaceDirectoryInput } from "../settings/workspaceDirectories";
import { broadcastWorkspaceDirectoryListChanged } from "../utils/workspaceDirectoryBroadcast";
import { snowLog } from "../../utils/snowLogger";

/**
 * 资源管理器右键菜单拉起应用时携带的开关：`--snow-open-directory="<目录>"`。
 * 写成单个 `开关=值` 参数，避免 Chromium 重排命令行时开关与路径被拆开。
 */
const OPEN_DIRECTORY_SWITCH = "--snow-open-directory";

/** 从命令行中取出右键菜单传入的目录（原样返回，规整与校验交给 Rust）。 */
export const readOpenDirectoryArg = (
  argv: readonly string[],
): string | null => {
  const prefix = `${OPEN_DIRECTORY_SWITCH}=`;
  const arg = argv.find((item) => item.toLowerCase().startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
};

type ExplorerMenuTarget = {
  titleKey: string;
  executable: string;
  appPath: string | null;
  icon: string;
  preview: boolean;
};

/**
 * 菜单命令指向的启动目标。
 * - 打包版：应用 exe（便携版运行在临时解压目录，需指向外层启动 exe），图标取 exe 本身。
 * - `npm run preview`：electron.exe + 项目根目录（快照目录随会话删除，不能写进菜单），
 *   electron.exe 自带的是 Electron 图标，改用项目内的 icon.ico。
 * - 其余未打包场景（npm run dev）不注册。
 */
const resolveExplorerMenuTarget = (): ExplorerMenuTarget | null => {
  if (app.isPackaged) {
    const executable =
      process.env.PORTABLE_EXECUTABLE_FILE?.trim() || process.execPath;
    return {
      titleKey: "explorerMenu.openInSnowApp",
      executable,
      appPath: null,
      icon: executable,
      preview: false,
    };
  }
  const previewRoot = process.env.SNOW_PREVIEW_APP_ROOT?.trim();
  if (!previewRoot) {
    return null;
  }
  return {
    titleKey: "explorerMenu.openInSnowAppPreview",
    executable: process.execPath,
    appPath: previewRoot,
    icon: join(previewRoot, "resources", "icon.ico"),
    preview: true,
  };
};

/**
 * 注册 Windows 资源管理器文件夹右键菜单「在 Snow App 中打开」。
 *
 * 每次启动都按当前启动目标重写一次（安装目录变化、便携版挪位置后自动纠正），
 * 菜单文本跟随桌面语言，语言切换后即时重写。预览模式写入独立菜单项，与已安装
 * 版本并存；开发模式不注册。
 */
export const initExplorerContextMenu = (native: NativeBridge): void => {
  if (process.platform !== "win32") {
    return;
  }
  const target = resolveExplorerMenuTarget();
  if (!target) {
    return;
  }

  const register = (): void => {
    void native
      .registerExplorerContextMenu({
        title: tMain(target.titleKey),
        executable: target.executable,
        appPath: target.appPath,
        icon: target.icon,
        switchName: OPEN_DIRECTORY_SWITCH,
        preview: target.preview,
      })
      .catch((error) => {
        snowLog.warn({
          module: "app/explorerContextMenu",
          func: "registerExplorerContextMenu",
          message: "Failed to register explorer context menu",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  void refreshMainLocale().then(register);
  onMainLocaleChange(register);
};

/** 本地路径比较：Windows 不区分大小写与分隔符，并忽略结尾分隔符。 */
const toComparablePath = (value: string): string => {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? trimmed.replace(/\//g, "\\").toLowerCase()
    : trimmed;
};

/**
 * 打开右键菜单传入的目录：已添加为项目时直接激活，否则先添加为项目（添加即激活）。
 * 变更后广播项目列表，界面随之切换到该项目。
 */
export const openDirectoryFromShell = async (
  native: NativeBridge,
  rawPath: string,
): Promise<void> => {
  const directoryPath = await native.resolveShellDirectoryPath(rawPath);
  if (!directoryPath) {
    snowLog.warn({
      module: "app/explorerContextMenu",
      func: "openDirectoryFromShell",
      message: "Ignored explorer request for an unavailable directory",
      context: rawPath,
    });
    return;
  }

  const directories = await native.listWorkspaceDirectories();
  const comparablePath = toComparablePath(directoryPath);
  const existing = directories.find(
    (directory) =>
      directory.kind === "local" &&
      toComparablePath(directory.path) === comparablePath,
  );

  if (existing?.isActive) {
    return;
  }
  if (existing) {
    await native.activateWorkspaceDirectory(existing.directoryId);
  } else {
    await native.upsertWorkspaceDirectory(
      createWorkspaceDirectoryInput(directoryPath, "local", directories.length),
    );
  }
  broadcastWorkspaceDirectoryListChanged();

  snowLog.info({
    module: "app/explorerContextMenu",
    func: "openDirectoryFromShell",
    message: existing
      ? "Activated existing project from explorer context menu"
      : "Added project from explorer context menu",
    context: directoryPath,
  });
};
