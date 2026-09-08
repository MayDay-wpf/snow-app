import { useCallback, useEffect, useState } from "react";
import type { BrowserBookmark } from "../../../../preload/modules/systemApi";

// 模块级共享状态：所有浏览器实例（含独立窗口）共用同一份书签缓存与
// 全局订阅（参考 useBrowserHomepage）。增删/导入由主进程广播
// browser:bookmarks-updated，此处统一重新拉取，天然多实例同步。
let cachedBookmarks: BrowserBookmark[] = [];
let cachedLoaded = false;
let loadStarted = false;
let listenerAttached = false;
const subscribers = new Set<() => void>();

const notifySubscribers = (): void => {
  for (const subscriber of subscribers) {
    subscriber();
  }
};

const loadBookmarks = async (): Promise<void> => {
  try {
    cachedBookmarks = await window.snow.browserBookmarksList();
  } catch {
    cachedBookmarks = [];
  }
  cachedLoaded = true;
  notifySubscribers();
};

const ensureBookmarksLoaded = (): void => {
  if (!loadStarted) {
    loadStarted = true;
    void loadBookmarks();
  }
  if (!listenerAttached) {
    listenerAttached = true;
    window.snow.onBrowserBookmarksUpdated(() => {
      void loadBookmarks();
    });
  }
};

/**
 * 内置浏览器收藏夹：跨实例共享的书签列表。
 * 写操作（addBookmark/removeBookmark/updateBookmark）成功后由主进程广播
 * 触发刷新，所有实例（含独立浏览器窗口）自动同步，无需本地手动更新缓存。
 */
export function useBrowserBookmarks(): {
  bookmarks: BrowserBookmark[];
  /** True once the initial async load has settled. */
  loaded: boolean;
  /** 收藏/更新当前页（同 URL 覆盖标题；folder 可选文件夹路径）。 */
  addBookmark: (url: string, title: string, folder?: string) => Promise<void>;
  /** 删除一条书签。 */
  removeBookmark: (id: string) => Promise<void>;
  /** 编辑书签（标题 / URL / 文件夹路径）。 */
  updateBookmark: (
    id: string,
    url: string,
    title: string,
    folder: string,
  ) => Promise<void>;
} {
  const [, setVersion] = useState(0);

  useEffect(() => {
    ensureBookmarksLoaded();
    const subscriber = () => setVersion((version) => version + 1);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const addBookmark = useCallback(
    async (url: string, title: string, folder?: string) => {
      await window.snow.browserBookmarkAdd(url, title, folder);
    },
    [],
  );

  const removeBookmark = useCallback(async (id: string) => {
    await window.snow.browserBookmarkDelete(id);
  }, []);

  const updateBookmark = useCallback(
    async (id: string, url: string, title: string, folder: string) => {
      await window.snow.browserBookmarkUpdate(id, url, title, folder);
    },
    [],
  );

  return {
    bookmarks: cachedBookmarks,
    loaded: cachedLoaded,
    addBookmark,
    removeBookmark,
    updateBookmark,
  };
}
