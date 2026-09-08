import { ipcMain, session } from "electron";
import type { NativeBridge } from "../../native/types";
import {
  deletePasswordRecord,
  deletePasswordRecords,
  findPasswordForOrigin,
  getPasswordRecord,
  listPasswordRecords,
  savePasswordRecord,
} from "./browserPasswordManager";
import {
  addBookmark,
  deleteBookmark,
  deleteBookmarks,
  importBookmarks,
  listBookmarks,
  updateBookmark,
  type BookmarkImportItem,
} from "../../app/browserBookmarkManager";

/** 从任意 URL 提取 origin；失败返回空串。 */
const originOfUrl = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

const toSameSiteElectron = (
  value: string,
): "unspecified" | "no_restriction" | "lax" | "strict" => {
  switch (value) {
    case "None":
      return "no_restriction";
    case "Lax":
      return "lax";
    case "Strict":
      return "strict";
    default:
      return "unspecified";
  }
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const registerBrowserPasswordHandlers = (native: NativeBridge): void => {
  // ===== 密码保险库 =====

  // 列表：只返回元信息，不泄露明文密码。
  ipcMain.handle("browser-passwords:list", () => listPasswordRecords());

  // 单条明文（密码管理 UI 显式查看时调用）。
  ipcMain.handle("browser-passwords:get", (_event, id: unknown) => {
    if (!isNonEmptyString(id)) {
      throw new Error("Password record id is required");
    }
    return getPasswordRecord(id);
  });

  // 保存/更新。来自 webview preload 的自动保存与导入共用此通道。
  ipcMain.handle("browser-passwords:save", (_event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") {
      throw new Error("Invalid password payload");
    }
    const { origin, username, password } = payload as Record<string, unknown>;
    if (!isNonEmptyString(origin)) {
      throw new Error("Password origin is required");
    }
    if (typeof username !== "string") {
      throw new Error("Password username must be a string");
    }
    if (!isNonEmptyString(password)) {
      throw new Error("Password must not be empty");
    }
    return savePasswordRecord({
      origin: origin.trim(),
      username,
      password,
    });
  });

  ipcMain.handle("browser-passwords:delete", (_event, id: unknown) => {
    if (!isNonEmptyString(id)) {
      throw new Error("Password record id is required");
    }
    return deletePasswordRecord(id);
  });

  // 批量删除：一次校验 + 一次加载/持久化，避免逐条删除的重复写盘。
  ipcMain.handle("browser-passwords:delete-batch", (_event, ids: unknown) => {
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id): id is string => isNonEmptyString(id))
    ) {
      throw new Error("Password record ids are required");
    }
    return deletePasswordRecords(ids);
  });

  // 自动填充通道：必须校验调用方（webview guest 页面）的真实 origin，
  // 防止恶意站点读取其他站点的已保存密码。
  ipcMain.handle("browser-passwords:find", (event, payload: unknown) => {
    const origin =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).origin
        : undefined;
    if (!isNonEmptyString(origin)) {
      throw new Error("Origin is required");
    }
    const frameUrl = event.senderFrame?.url ?? "";
    const frameOrigin = originOfUrl(frameUrl);
    if (!frameOrigin || frameOrigin !== origin.trim()) {
      throw new Error("Origin mismatch: cross-origin password lookup rejected");
    }
    return findPasswordForOrigin(origin.trim());
  });

  // ===== 从本机浏览器导入 =====

  // 探测本机已安装浏览器及其配置文件（含密码/Cookie 数量统计）。
  ipcMain.handle("browser-import:sources", () =>
    native.browserImportListSources(),
  );

  // 导入密码：Rust 端解密 → 逐条写入保险库（加密落盘）。
  ipcMain.handle(
    "browser-import:passwords",
    async (_event, sourceId: unknown, profile: unknown) => {
      if (!isNonEmptyString(sourceId) || !isNonEmptyString(profile)) {
        throw new Error("sourceId and profile are required");
      }
      const items = await native.browserImportPasswords(sourceId, profile);
      let imported = 0;
      let skipped = 0;
      for (const item of items) {
        try {
          await savePasswordRecord({
            origin: item.origin,
            username: item.username,
            password: item.password,
          });
          imported += 1;
        } catch {
          skipped += 1;
        }
      }
      return { total: items.length, imported, skipped };
    },
  );

  // 导入 Cookie：Rust 端解析（Chrome 系需解密）→ 写入默认会话。
  ipcMain.handle(
    "browser-import:cookies",
    async (_event, sourceId: unknown, profile: unknown) => {
      if (!isNonEmptyString(sourceId) || !isNonEmptyString(profile)) {
        throw new Error("sourceId and profile are required");
      }
      const items = await native.browserImportCookies(sourceId, profile);
      let imported = 0;
      let failed = 0;
      for (const cookie of items) {
        try {
          const host = cookie.domain.replace(/^\./, "");
          const url = `${cookie.secure ? "https" : "http"}://${host}${
            cookie.path || "/"
          }`;
          // 域 Cookie（host_key 带前导点，如 .google.com）必须显式传 domain，
          // 否则 Electron 会存成 host-only Cookie，只匹配裸域名本身，不会发送
          // 给 mail.google.com / accounts.google.com 等子域名，导致 Gmail 等
          // 站点识别不到登录态。
          const isDomainCookie = cookie.domain.startsWith(".");
          // Chromium 拒绝 SameSite=None 且非 Secure 的组合，直接写入会失败；
          // 对这类 Cookie 降级为 unspecified 保证能写入。
          let sameSite = toSameSiteElectron(cookie.sameSite);
          if (sameSite === "no_restriction" && !cookie.secure) {
            sameSite = "unspecified";
          }
          await session.defaultSession.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            ...(isDomainCookie ? { domain: cookie.domain } : {}),
            ...(cookie.expires !== undefined && cookie.expires !== null
              ? { expirationDate: cookie.expires }
              : {}),
            sameSite,
          });
          imported += 1;
        } catch {
          failed += 1;
        }
      }
      return { total: items.length, imported, failed };
    },
  );

  // ===== 书签（收藏夹）=====

  // 列出全部书签（收藏栏展示）。
  ipcMain.handle("browser-bookmarks:list", () => listBookmarks());

  // 收藏/更新当前页（同 URL 覆盖标题；folder 为可选文件夹路径）。
  ipcMain.handle(
    "browser-bookmarks:add",
    (_event, url: unknown, title: unknown, folder: unknown) => {
      if (!isNonEmptyString(url)) {
        throw new Error("Bookmark url is required");
      }
      if (typeof title !== "string") {
        throw new Error("Bookmark title must be a string");
      }
      if (folder !== undefined && typeof folder !== "string") {
        throw new Error("Bookmark folder must be a string");
      }
      return addBookmark(url, title, folder ?? "");
    },
  );

  ipcMain.handle("browser-bookmarks:delete", (_event, id: unknown) => {
    if (!isNonEmptyString(id)) {
      throw new Error("Bookmark id is required");
    }
    return deleteBookmark(id);
  });

  // 批量删除：一次校验 + 一次加载/持久化，避免逐条删除的重复写盘。
  ipcMain.handle("browser-bookmarks:delete-batch", (_event, ids: unknown) => {
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id): id is string => isNonEmptyString(id))
    ) {
      throw new Error("Bookmark ids are required");
    }
    return deleteBookmarks(ids);
  });

  // 编辑书签（标题 / URL / 文件夹路径）。
  ipcMain.handle(
    "browser-bookmarks:update",
    (_event, id: unknown, url: unknown, title: unknown, folder: unknown) => {
      if (!isNonEmptyString(id)) {
        throw new Error("Bookmark id is required");
      }
      if (!isNonEmptyString(url)) {
        throw new Error("Bookmark url is required");
      }
      if (typeof title !== "string") {
        throw new Error("Bookmark title must be a string");
      }
      if (typeof folder !== "string") {
        throw new Error("Bookmark folder must be a string");
      }
      return updateBookmark(id, url, title, folder);
    },
  );

  // 导入书签：Rust 端解析（明文，无需解密）→ 按 URL 去重合并存储。
  ipcMain.handle(
    "browser-bookmarks:import",
    async (_event, sourceId: unknown, profile: unknown) => {
      if (!isNonEmptyString(sourceId) || !isNonEmptyString(profile)) {
        throw new Error("sourceId and profile are required");
      }
      const items: BookmarkImportItem[] = await native.browserImportBookmarks(
        sourceId,
        profile,
      );
      return importBookmarks(items);
    },
  );
};
