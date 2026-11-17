import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";

/**
 * 内置浏览器访问历史 IPC：渲染端只在页面导航与标题更新时上报，检索 /
 * 列表 / 删除全部转发给 Rust 侧（持久化与排序都在原生模块完成）。
 */

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const clampNumber = (value: unknown, fallback: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
};

export const registerBrowserHistoryHandlers = (native: NativeBridge): void => {
  // 记录一次访问：非 http(s) 地址由原生侧拒绝并返回 false。
  ipcMain.handle(
    "browser-history:record",
    (_event, url: unknown, title: unknown) => {
      if (!isNonEmptyString(url)) {
        return false;
      }
      return native.browserHistoryRecord(
        url.trim(),
        typeof title === "string" ? title : "",
      );
    },
  );

  // 页面标题迟到更新：只改标题，不计入访问次数。
  ipcMain.handle(
    "browser-history:update-title",
    (_event, url: unknown, title: unknown) => {
      if (!isNonEmptyString(url) || !isNonEmptyString(title)) {
        return false;
      }
      return native.browserHistoryUpdateTitle(url.trim(), title.trim());
    },
  );

  // 地址栏补全检索（查询为空时返回最近访问）。
  ipcMain.handle(
    "browser-history:search",
    (_event, query: unknown, limit: unknown) =>
      native.browserHistorySearch(
        typeof query === "string" ? query : "",
        clampNumber(limit, 8, 50),
      ),
  );

  // 设置页历史列表（查询过滤 + 分页）。
  ipcMain.handle(
    "browser-history:list",
    (_event, query: unknown, offset: unknown, limit: unknown) =>
      native.browserHistoryList(
        typeof query === "string" ? query : "",
        clampNumber(offset, 0, 100000),
        clampNumber(limit, 50, 200),
      ),
  );

  ipcMain.handle("browser-history:delete", (_event, id: unknown) => {
    if (!isNonEmptyString(id)) {
      throw new Error("History id is required");
    }
    return native.browserHistoryDelete(id);
  });

  ipcMain.handle("browser-history:clear", () => native.browserHistoryClear());

  // 新标签页常用网站（按站点聚合）。
  ipcMain.handle("browser-history:top-sites", (_event, limit: unknown) =>
    native.browserHistoryTopSites(clampNumber(limit, 8, 50)),
  );
};
