import { app, webContents } from "electron";
import type { NativeBridge, ProcessSnapshotEntry } from "../native/types";

/**
 * 应用任务管理器（进程占用监控）。
 *
 * 数据来源分两层：
 * - Rust `listProcessTree(mainPid)`：以 Electron 主进程为根的进程树「系统事实」
 *   （pid / ppid / 名称 / CPU / 内存 / 线程数）。同时覆盖 GPU、Utility、各渲染
 *   进程以及终端 pty、外部 MCP、LSP、联网搜索浏览器、隧道等派生子进程。
 * - Electron `app.getAppMetrics()` + `webContents.getOSProcessId()`：只用来给
 *   pid 补「语义」（进程角色 / Utility 服务名 / 渲染进程页面标题与 URL）。
 *
 * 数值一律取自 Rust 单一来源，避免两套统计口径混用；Electron 侧只提供标签。
 */

export type TaskManagerProcessKind =
  "browser" | "renderer" | "gpu" | "utility" | "child";

export type TaskManagerProcess = {
  pid: number;
  parentPid: number;
  /** 可执行文件名（不含路径） */
  name: string;
  kind: TaskManagerProcessKind;
  /** Utility 进程的服务名（如 "Network Service"），其它进程为空串 */
  serviceName: string;
  /** 渲染进程所属页面的标题，其它进程为空串 */
  title: string;
  /** 渲染进程所属页面的 URL，其它进程为空串 */
  url: string;
  /** 相对上次采样的 CPU 占用百分比（-1 表示本次无基线，前端显示占位符） */
  cpuPercent: number;
  memoryBytes: number;
  threadCount: number;
  /** 是否允许结束：Electron 自身进程只展示，应用派生的子进程可结束 */
  killable: boolean;
};

/** Electron 进程角色（来自 app.getAppMetrics 的 type 字段）。 */
type ElectronProcessRole = {
  kind: TaskManagerProcessKind;
  serviceName: string;
};

/** 把 Electron 的进程 type 归一到任务管理器使用的角色分类。 */
const toElectronRole = (
  type: string,
  serviceName: string,
): ElectronProcessRole => {
  switch (type) {
    case "Browser":
      return { kind: "browser", serviceName: "" };
    case "GPU":
      return { kind: "gpu", serviceName: "" };
    case "Tab":
      return { kind: "renderer", serviceName: "" };
    case "Utility":
      return { kind: "utility", serviceName };
    default:
      // Zygote / Sandbox helper / Pepper Plugin / Unknown：按 Electron 自身的
      // 辅助进程处理（只展示，不可结束）。
      return { kind: "utility", serviceName: type };
  }
};

/** 渲染进程的页面信息：webContents 已销毁时取值会抛错，统一降级为空串。 */
type RendererPageInfo = {
  title: string;
  url: string;
};

const readRendererPages = (): Map<number, RendererPageInfo> => {
  const pages = new Map<number, RendererPageInfo>();
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) {
      continue;
    }
    let pid: number;
    try {
      pid = contents.getOSProcessId();
    } catch {
      continue;
    }
    if (pid <= 0) {
      continue;
    }
    let title = "";
    let url = "";
    try {
      title = contents.getTitle();
    } catch {
      title = "";
    }
    try {
      url = contents.getURL();
    } catch {
      url = "";
    }
    // 同一进程可能承载多个 webContents（如多个 webview 复用渲染进程），
    // 保留首个有标题的记录即可，避免标签抖动。
    const existing = pages.get(pid);
    if (!existing || (!existing.title && title)) {
      pages.set(pid, { title, url: url || existing?.url || "" });
    }
  }
  return pages;
};

/**
 * 进程图标缓存：key 为可执行文件路径。
 *
 * `app.getFileIcon` 走系统图标库（与任务管理器同源），但有磁盘 / 系统调用开销，
 * 而轮询每秒都会重建整张表——因此按路径缓存，进程消失也不会被清理（图标总量
 * 受可执行文件数量约束，实际很小）。取不到图标时缓存 null，避免反复重试。
 */
const iconCache = new Map<string, Promise<string | null>>();

const resolveProcessIcon = (exePath: string): Promise<string | null> => {
  if (!exePath) {
    return Promise.resolve(null);
  }
  const cached = iconCache.get(exePath);
  if (cached) {
    return cached;
  }
  const pending = app
    .getFileIcon(exePath, { size: "small" })
    .then((icon) => (icon.isEmpty() ? null : icon.toDataURL()))
    .catch(() => null);
  iconCache.set(exePath, pending);
  return pending;
};

/** 合并 Rust 进程树事实与 Electron 语义，产出进程数据行；withIcons=false 时跳过图标。 */
export const buildProcessRows = async (
  tree: ProcessSnapshotEntry[],
  withIcons: boolean,
): Promise<Array<TaskManagerProcess & { exePath: string }>> => {
  const roles = new Map<number, ElectronProcessRole>();
  for (const metric of app.getAppMetrics()) {
    roles.set(
      metric.pid,
      toElectronRole(metric.type, metric.serviceName ?? ""),
    );
  }
  const pages = readRendererPages();
  const icons = withIcons
    ? await Promise.all(tree.map((entry) => resolveProcessIcon(entry.exePath)))
    : tree.map(() => null);

  return tree.map((entry, index) => {
    const role = roles.get(entry.pid);
    const base = {
      pid: entry.pid,
      parentPid: entry.parentPid,
      name: entry.name,
      exePath: entry.exePath,
      iconDataUrl: icons[index],
      cpuPercent: entry.cpuPercent,
      memoryBytes: entry.memoryBytes,
      threadCount: entry.threadCount,
    };
    if (!role) {
      return {
        ...base,
        kind: "child" as const,
        serviceName: "",
        title: "",
        url: "",
        killable: true,
      };
    }
    const page = role.kind === "renderer" ? pages.get(entry.pid) : undefined;
    return {
      ...base,
      kind: role.kind,
      serviceName: role.serviceName,
      title: page?.title ?? "",
      url: page?.url ?? "",
      killable: false,
    };
  });
};

/** 任务管理器面板快照：面板专用 CPU 基线，并附带图标。 */
export const buildSnapshot = async (
  native: NativeBridge,
): Promise<TaskManagerProcess[]> =>
  buildProcessRows(await native.listProcessTree(process.pid), true);

/** 进程日志采样快照：独立 CPU 基线，不取图标（日志不需要图标）。 */
export const sampleProcessRowsForLog = async (
  native: NativeBridge,
): Promise<Array<TaskManagerProcess & { exePath: string }>> =>
  buildProcessRows(await native.listProcessTreeForLog(process.pid), false);
