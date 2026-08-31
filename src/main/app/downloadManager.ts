import {
  app,
  Notification,
  session,
  shell,
  type DownloadItem,
  type WebContents,
} from "electron";
import * as path from "node:path";

/**
 * webview 下载管理：session 无 will-download 监听器时 Electron 会直接
 * 取消下载，网页 a[download] / Blob 下载（含 GM_download）全部静默失效。
 *
 * 每次下载弹保存对话框让用户选择保存地址（取消即放弃下载），
 * 列表与进度实时推送到宿主窗口（browser:downloads-updated）。
 */

export type BrowserDownloadItem = {
  id: number;
  url: string;
  filename: string;
  /** 保存路径（保存对话框确认后可用；取消时为空）。 */
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt: number | null;
  /** GM_download 关联的请求 id（网页下载为 0）。 */
  gmRequestId: number;
};

const downloads = new Map<number, BrowserDownloadItem>();
/** 进行中的 DownloadItem 引用（cancel 用）。 */
const activeItems = new Map<number, DownloadItem>();
/** GM_download 发起后等待与 DownloadItem 按 (webContents, url) 关联。 */
const gmPendingDownloads = new Map<
  number,
  Map<string, { requestId: number; filename: string }>
>();

let nextDownloadId = 1;
let installed = false;

const snapshot = (): BrowserDownloadItem[] =>
  Array.from(downloads.values()).sort((a, b) => b.startedAt - a.startedAt);

/** 推送列表快照到 webContents 的宿主窗口。 */
const pushSnapshot = (webContents: WebContents | null): void => {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }
  const host = webContents.hostWebContents ?? webContents;
  if (!host.isDestroyed()) {
    host.send("browser:downloads-updated", snapshot());
  }
};

const sendGmDownloadState = (
  sender: WebContents,
  requestId: number,
  state: "progressing" | "completed" | "interrupted",
  receivedBytes = 0,
  totalBytes = 0,
): void => {
  if (sender.isDestroyed()) {
    return;
  }
  sender.send("userscripts:download-state", {
    requestId,
    state,
    receivedBytes,
    totalBytes,
  });
};

/** GM_download：注册待关联下载并发起 browser 侧下载。 */
export const startGmDownload = (
  sender: WebContents,
  requestId: number,
  url: string,
  filename: string,
): void => {
  if (sender.isDestroyed()) {
    return;
  }
  let perContents = gmPendingDownloads.get(sender.id);
  if (!perContents) {
    perContents = new Map();
    gmPendingDownloads.set(sender.id, perContents);
    sender.once("destroyed", () => {
      gmPendingDownloads.delete(sender.id);
    });
  }
  perContents.set(url, { requestId, filename });
  try {
    sender.downloadURL(url);
  } catch {
    perContents.delete(url);
    sendGmDownloadState(sender, requestId, "interrupted");
  }
};

// ===== 渲染端查询 / 操作 =====

export const listDownloads = (): BrowserDownloadItem[] => snapshot();

export const openDownload = async (id: number): Promise<boolean> => {
  const item = downloads.get(id);
  if (!item || !item.path) {
    return false;
  }
  return shell.openPath(item.path).then((error) => error === "");
};

export const showDownloadInFolder = (id: number): void => {
  const item = downloads.get(id);
  if (item?.path) {
    shell.showItemInFolder(item.path);
  }
};

export const cancelDownload = (id: number): boolean => {
  const active = activeItems.get(id);
  if (!active) {
    return false;
  }
  try {
    active.cancel();
    return true;
  } catch {
    return false;
  }
};

/** 在 defaultSession 上安装 will-download 处理（幂等）。 */
export const installWebviewDownloadHandler = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  session.defaultSession.on("will-download", (_event, item, webContents) => {
    const url = item.getURL();

    // GM_download 关联：匹配后立即移除，避免同 URL 二次下载串扰。
    let gmRequestId = 0;
    let gmFilename = "";
    const perContents = webContents
      ? gmPendingDownloads.get(webContents.id)
      : undefined;
    if (perContents) {
      const record = perContents.get(url);
      if (record) {
        gmRequestId = record.requestId;
        gmFilename = record.filename;
        perContents.delete(url);
        if (perContents.size === 0) {
          gmPendingDownloads.delete(webContents.id);
        }
      }
    }

    // 保存对话框：每个下载由用户选择保存地址；取消即放弃下载。
    item.setSaveDialogOptions({
      title: "保存文件",
      defaultPath: path.join(
        app.getPath("downloads"),
        gmFilename || item.getFilename(),
      ),
    });

    const record: BrowserDownloadItem = {
      id: nextDownloadId,
      url,
      filename: item.getFilename(),
      path: "",
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      endedAt: null,
      gmRequestId,
    };
    downloads.set(record.id, record);
    activeItems.set(record.id, item);

    item.on("updated", (_e, state) => {
      record.state = state === "progressing" ? "progressing" : "interrupted";
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.path = item.getSavePath();
      pushSnapshot(webContents);
      if (gmRequestId && webContents) {
        sendGmDownloadState(
          webContents,
          gmRequestId,
          state === "progressing" ? "progressing" : "interrupted",
          record.receivedBytes,
          record.totalBytes,
        );
      }
    });

    item.once("done", (_e, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.path = item.getSavePath();
      record.endedAt = Date.now();
      activeItems.delete(record.id);
      pushSnapshot(webContents);
      if (gmRequestId && webContents) {
        sendGmDownloadState(
          webContents,
          gmRequestId,
          state === "completed" ? "completed" : "interrupted",
          record.receivedBytes,
          record.totalBytes,
        );
      }
      if (state !== "cancelled" && Notification.isSupported()) {
        new Notification({
          title: state === "completed" ? "下载完成" : "下载失败",
          body: record.filename,
          silent: state !== "completed",
        }).show();
      }
    });
  });
};
