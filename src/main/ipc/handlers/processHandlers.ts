import { app, ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import { buildSnapshot } from "../../monitoring/processSnapshot";
import {
  readProcessSamplingLog,
  updateProcessSamplingLog,
} from "../../monitoring/processSamplingLog";

const requirePid = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("A valid process id is required");
  }
  return value;
};

const requireTaskId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A valid background task id is required");
  }
  return value.trim();
};

export const registerProcessHandlers = (native: NativeBridge): void => {
  ipcMain.handle("processes:snapshot", () => buildSnapshot(native));

  ipcMain.handle("processes:kill", async (_event, pid: unknown) => {
    const targetPid = requirePid(pid);
    // 防御性校验：Electron 自身进程不允许从任务管理器结束（UI 也不提供入口），
    // 误杀主进程 / 渲染进程会让整个应用直接崩溃。
    const isElectronProcess = app
      .getAppMetrics()
      .some((metric) => metric.pid === targetPid);
    if (isElectronProcess) {
      throw new Error(
        "Electron-owned processes cannot be terminated from the task manager",
      );
    }
    await native.killProcessTree(targetPid);
  });

  // bash 工具 detach 启动的后台任务：登记表在 Rust 侧（含存活探测），这里只透传。
  ipcMain.handle("processes:background-tasks", () =>
    native.listDetachedTasks(),
  );

  ipcMain.handle("processes:background-task-kill", (_event, id: unknown) =>
    native.killDetachedTask(requireTaskId(id)),
  );

  ipcMain.handle("processes:background-task-forget", (_event, id: unknown) =>
    native.forgetDetachedTask(requireTaskId(id)),
  );

  // 进程采样日志（全局开关）：读取 / 保存开关与间隔，保存即时生效。
  ipcMain.handle("processes:sampling-log:get", () =>
    readProcessSamplingLog(native),
  );
  ipcMain.handle("processes:sampling-log:set", (_event, value: unknown) =>
    updateProcessSamplingLog(native, value),
  );
};
