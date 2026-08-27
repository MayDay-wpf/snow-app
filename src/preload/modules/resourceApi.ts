import { ipcRenderer } from "electron";
import type { MemoryOptimizeResult } from "../types/storage";

/** 应用资源占用查询 API。 */
export const resourceApi = {
  /** 当前进程常驻内存占用（字节）；由 Rust 侧系统调用统计 */
  getProcessMemoryBytes: (): Promise<number> =>
    ipcRenderer.invoke("settings:get-process-memory"),

  /** 整理本进程内存（主进程 V8 GC + Rust 收缩 OS 工作集），返回整理前后常驻内存 */
  optimizeMemory: (): Promise<MemoryOptimizeResult> =>
    ipcRenderer.invoke("settings:optimize-memory"),
};
