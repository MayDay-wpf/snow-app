import { app } from "electron";

/** 系统调度拉起应用时附带的命令行参数。 */
export const SCHEDULED_WAKE_ARG = "--scheduled-wake";

/** 本次进程是否由系统调度唤醒（后台启动，不显示主窗口）。 */
export const isScheduledWakeLaunch = (
  argv: readonly string[] = process.argv,
): boolean => argv.includes(SCHEDULED_WAKE_ARG);

export type ScheduledWakeLaunchSpec = {
  label: string;
  program: string;
  args: string[];
  env?: Record<string, string>;
};

/** Linux systemd 服务启动图形应用所需的会话变量。 */
const LINUX_SESSION_ENV_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS",
];

/** 从可执行文件路径推出 macOS .app 包路径。 */
const resolveMacBundlePath = (execPath: string): string | null => {
  const marker = ".app/Contents/MacOS/";
  const index = execPath.indexOf(marker);
  return index >= 0 ? execPath.slice(0, index + ".app".length) : null;
};

/** 组装系统调度拉起应用的命令（开发模式需额外传入应用目录）。 */
export const buildScheduledWakeLaunchSpec = (
  baseLabel = "com.snow.app.scheduled-wake",
): ScheduledWakeLaunchSpec => {
  const label = app.isPackaged ? baseLabel : `${baseLabel}.dev`;
  const appArgs = app.isPackaged
    ? [SCHEDULED_WAKE_ARG]
    : [app.getAppPath(), SCHEDULED_WAKE_ARG];

  if (process.platform === "darwin") {
    const bundle = resolveMacBundlePath(process.execPath);
    // 经 open 交给 LaunchServices 启动，应用不挂在 launchd 任务下；
    // -n 避免向已运行实例发送 reopen 事件而弹出窗口
    if (bundle) {
      return {
        label,
        program: "/usr/bin/open",
        args: ["-n", "-g", "-a", bundle, "--args", ...appArgs],
      };
    }
    return { label, program: process.execPath, args: appArgs };
  }

  if (process.platform === "linux") {
    const env: Record<string, string> = {};
    for (const key of LINUX_SESSION_ENV_KEYS) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return {
      label,
      program: process.env.APPIMAGE || process.execPath,
      args: appArgs,
      env,
    };
  }

  return { label, program: process.execPath, args: appArgs };
};
