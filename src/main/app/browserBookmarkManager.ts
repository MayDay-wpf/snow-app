import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 内置浏览器书签（收藏夹）存储。
 *
 * 书签不含敏感凭据，明文 JSON 落盘 ~/.snowapp/browser-bookmarks.json
 * （临时文件 + rename 原子替换）。任意变更后向所有窗口广播
 * browser:bookmarks-updated，渲染端各浏览器实例的收藏栏据此实时刷新。
 */

const BOOKMARKS_DIR = join(homedir(), ".snowapp");
const BOOKMARKS_FILE = join(BOOKMARKS_DIR, "browser-bookmarks.json");
const BOOKMARKS_VERSION = 1;

export type StoredBookmark = {
  id: string;
  title: string;
  url: string;
  /** 源浏览器中的文件夹路径（导入用），手动收藏为空串 */
  folder: string;
  createdAt: number;
};

/** Rust 导入返回的原始条目（无 id / createdAt）。 */
export type BookmarkImportItem = {
  title: string;
  url: string;
  folder: string;
};

type BookmarksFile = {
  version: number;
  bookmarks: StoredBookmark[];
};

let cachePromise: Promise<StoredBookmark[]> | null = null;
let writeChain: Promise<void> = Promise.resolve();

const isValidBookmarkUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const loadBookmarks = (): Promise<StoredBookmark[]> => {
  if (cachePromise) {
    return cachePromise;
  }
  cachePromise = (async () => {
    try {
      const text = await fs.readFile(BOOKMARKS_FILE, "utf8");
      const parsed = JSON.parse(text) as Partial<BookmarksFile> | null;
      if (
        parsed &&
        parsed.version === BOOKMARKS_VERSION &&
        Array.isArray(parsed.bookmarks)
      ) {
        return parsed.bookmarks as StoredBookmark[];
      }
    } catch {
      // 文件缺失或损坏：返回空列表，首次写入时自动创建。
    }
    return [];
  })();
  return cachePromise;
};

const persistBookmarks = (bookmarks: StoredBookmark[]): Promise<void> => {
  const task = writeChain.then(async () => {
    await fs.mkdir(BOOKMARKS_DIR, { recursive: true });
    const tmp = `${BOOKMARKS_FILE}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: BOOKMARKS_VERSION, bookmarks }, null, 2),
      "utf8",
    );
    await fs.rename(tmp, BOOKMARKS_FILE);
    // 写盘成功后必须让缓存指向最新数组：调用方传 filter 出的新数组时
    // （如批量删除），缓存若仍停在旧数组，广播后的 list 拉取会拿到
    // 含已删条目的过期快照（表现为删除不生效、须重启才刷新）。
    cachePromise = Promise.resolve(bookmarks);
  });
  // 单次失败不阻塞后续写入，错误仍通过 task 抛给调用方。
  writeChain = task.catch(() => {});
  return task;
};

/** 变更广播：主窗口与独立浏览器窗口的收藏栏都监听此事件。 */
const broadcastBookmarksChanged = (): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("browser:bookmarks-updated");
    }
  }
};

const saveAndBroadcast = async (bookmarks: StoredBookmark[]): Promise<void> => {
  await persistBookmarks(bookmarks);
  broadcastBookmarksChanged();
};

/** 列出全部书签（按创建时间升序，与收藏栏展示顺序一致）。 */
export const listBookmarks = async (): Promise<StoredBookmark[]> => {
  const bookmarks = await loadBookmarks();
  return [...bookmarks].sort((a, b) => a.createdAt - b.createdAt);
};

/** 收藏当前页：同 URL 更新标题（created=false），否则新增。 */
export const addBookmark = async (
  url: string,
  title: string,
  folder = "",
): Promise<{ id: string; created: boolean }> => {
  const trimmed = url.trim();
  if (!isValidBookmarkUrl(trimmed)) {
    throw new Error("Invalid bookmark URL");
  }
  const normalizedTitle = title.trim();
  const bookmarks = await loadBookmarks();
  const existing = bookmarks.find((item) => item.url === trimmed);
  if (existing) {
    existing.title = normalizedTitle || existing.title;
    await saveAndBroadcast(bookmarks);
    return { id: existing.id, created: false };
  }
  const record: StoredBookmark = {
    id: randomUUID(),
    title: normalizedTitle || trimmed,
    url: trimmed,
    folder: folder.trim(),
    createdAt: Date.now(),
  };
  bookmarks.push(record);
  await saveAndBroadcast(bookmarks);
  return { id: record.id, created: true };
};

/** 删除一条书签。 */
export const deleteBookmark = async (id: string): Promise<boolean> => {
  const bookmarks = await loadBookmarks();
  const index = bookmarks.findIndex((item) => item.id === id);
  if (index < 0) {
    return false;
  }
  bookmarks.splice(index, 1);
  await saveAndBroadcast(bookmarks);
  return true;
};

/** 编辑书签（标题 / URL / 文件夹路径），返回更新后的记录（不存在返回 null）。 */
export const updateBookmark = async (
  id: string,
  url: string,
  title: string,
  folder: string,
): Promise<StoredBookmark | null> => {
  const trimmedUrl = url.trim();
  if (!isValidBookmarkUrl(trimmedUrl)) {
    throw new Error("Invalid bookmark URL");
  }
  const bookmarks = await loadBookmarks();
  const record = bookmarks.find((item) => item.id === id);
  if (!record) {
    return null;
  }
  record.url = trimmedUrl;
  record.title = title.trim() || trimmedUrl;
  record.folder = folder.trim();
  await saveAndBroadcast(bookmarks);
  return record;
};

/** 批量删除书签（一次加载、一次持久化、一次广播），返回实际删除数量。 */
export const deleteBookmarks = async (ids: string[]): Promise<number> => {
  if (ids.length === 0) {
    return 0;
  }
  const idSet = new Set(ids);
  const bookmarks = await loadBookmarks();
  // 原地剔除（而非 filter 出新数组）：缓存持有的就是这一个数组引用，
  // 删除后写盘与广播，渲染端重新拉取时天然拿到最新数据。
  const before = bookmarks.length;
  for (let i = bookmarks.length - 1; i >= 0; i -= 1) {
    if (idSet.has(bookmarks[i].id)) {
      bookmarks.splice(i, 1);
    }
  }
  const removed = before - bookmarks.length;
  if (removed === 0) {
    return 0;
  }
  await saveAndBroadcast(bookmarks);
  return removed;
};

/**
 * 导入合并：按 URL 去重，已存在的跳过（不覆盖用户已有的标题/记录）。
 * 一次加载、一次持久化、一次广播。
 */
export const importBookmarks = async (
  items: BookmarkImportItem[],
): Promise<{ total: number; imported: number; skipped: number }> => {
  const bookmarks = await loadBookmarks();
  const seen = new Set(bookmarks.map((item) => item.url));
  let imported = 0;
  let skipped = 0;
  const now = Date.now();
  for (const item of items) {
    const url = item.url.trim();
    if (!isValidBookmarkUrl(url)) {
      skipped += 1;
      continue;
    }
    if (seen.has(url)) {
      skipped += 1;
      continue;
    }
    seen.add(url);
    bookmarks.push({
      id: randomUUID(),
      title: item.title.trim() || url,
      url,
      folder: item.folder ?? "",
      createdAt: now,
    });
    imported += 1;
  }
  if (imported > 0) {
    await saveAndBroadcast(bookmarks);
  }
  return { total: items.length, imported, skipped };
};
