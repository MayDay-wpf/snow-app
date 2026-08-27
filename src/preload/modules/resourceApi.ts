import { ipcRenderer } from "electron";

/** 应用资源占用查询 API。 */
export const resourceApi = {
  /** 当前进程常驻内存占用（字节）；由 Rust 侧系统调用统计 */
  getProcessMemoryBytes: (): Promise<number> =>
    ipcRenderer.invoke("settings:get-process-memory"),
};
