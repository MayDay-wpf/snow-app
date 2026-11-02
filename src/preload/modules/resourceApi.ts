import { ipcRenderer } from "electron";
import type { MemoryOptimizeResult } from "../types/storage";
import type {
  DetachedTaskInfo,
  TaskManagerProcess,
} from "../types/taskManager";

/** 应用资源占用查询 API。 */
export const resourceApi = {
  /** 应用任务管理器：采集应用进程树占用快照（CPU 为相对上次调用的增量） */
  getProcessSnapshot: (): Promise<TaskManagerProcess[]> =>
    ipcRenderer.invoke("processes:snapshot"),

  /** 结束指定子进程树（Electron 自身进程会被主进程拒绝） */
  killProcessTree: (pid: number): Promise<void> =>
    ipcRenderer.invoke("processes:kill", pid),

  /** bash 工具 detach 启动的后台任务列表（任务管理器「后台任务」页） */
  listDetachedTasks: (): Promise<DetachedTaskInfo[]> =>
    ipcRenderer.invoke("processes:background-tasks"),

  /** 终止后台任务（整棵进程树）；返回 false 表示进程已自行退出 */
  killDetachedTask: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("processes:background-task-kill", id),

  /** 移除已完成的后台任务记录（连同日志文件一起删除）；仍在运行的任务返回 false */
  forgetDetachedTask: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("processes:background-task-forget", id),

  /** 整理本进程内存（仅 Windows 支持；其它平台快速失败），返回整理前后常驻内存 */
  optimizeMemory: (): Promise<MemoryOptimizeResult> =>
    ipcRenderer.invoke("settings:optimize-memory"),

  /** 清空应用 HTTP 缓存并强制重新加载界面 */
  clearAppCacheAndReload: (): Promise<void> =>
    ipcRenderer.invoke("app:clear-cache-and-reload"),

  /** 读取开机自启动状态 */
  getAutoLaunch: (): Promise<boolean> =>
    ipcRenderer.invoke("app:get-auto-launch"),

  /** 设置开机自启动，返回实际生效状态 */
  setAutoLaunch: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("app:set-auto-launch", enabled),
};
