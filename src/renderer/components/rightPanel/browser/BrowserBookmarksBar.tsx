import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Folder, Star, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { BrowserBookmark } from "../../../../preload/modules/systemApi";
import { useBrowserBookmarks } from "./useBrowserBookmarks";
import { WebsiteFavicon } from "./WebsiteFavicon";

export type BrowserBookmarksBarProps = {
  /** 当前激活标签页 URL（已收藏判定；空串 = 尚未导航，星标禁用）。 */
  activeUrl: string;
  /** 当前激活标签页标题（收藏时作为书签标题）。 */
  activeTitle: string;
  /** 点击书签：在当前标签页导航。 */
  onNavigate: (url: string) => void;
};

type BookmarkEntry =
  | { kind: "bookmark"; bookmark: BrowserBookmark }
  | { kind: "folder"; name: string; path: string; entries: BookmarkEntry[] };

/** 平铺书签（folder 为 "A/B" 斜杠路径）构建为树，保持列表原序。 */
const buildBookmarkTree = (bookmarks: BrowserBookmark[]): BookmarkEntry[] => {
  const root: BookmarkEntry[] = [];
  const dirs = new Map<string, BookmarkEntry[]>([["", root]]);
  const ensureDir = (path: string): BookmarkEntry[] => {
    const cached = dirs.get(path);
    if (cached) {
      return cached;
    }
    const sep = path.lastIndexOf("/");
    const name = sep < 0 ? path : path.slice(sep + 1);
    const entries: BookmarkEntry[] = [];
    ensureDir(sep < 0 ? "" : path.slice(0, sep)).push({
      kind: "folder",
      name,
      path,
      entries,
    });
    dirs.set(path, entries);
    return entries;
  };
  for (const bookmark of bookmarks) {
    const path = bookmark.folder
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("/");
    ensureDir(path).push({ kind: "bookmark", bookmark });
  }
  return root;
};

/** 文件夹下拉菜单（portal fixed 定位，级联子菜单 hover 展开）。 */
const BookmarkMenuEntries = ({
  entries,
  onNavigate,
  onClose,
}: {
  entries: BookmarkEntry[];
  onNavigate: (url: string) => void;
  onClose: () => void;
}): React.JSX.Element => (
  <>
    {entries.map((entry) =>
      entry.kind === "folder" ? (
        <div
          key={`folder-${entry.path}`}
          className="browser-bookmark-menu-item has-submenu"
        >
          <Folder size={12} strokeWidth={1.8} />
          <span className="browser-bookmark-menu-label">{entry.name}</span>
          <ChevronRight size={12} strokeWidth={1.8} />
          <div className="browser-bookmark-submenu" role="menu">
            <BookmarkMenuEntries
              entries={entry.entries}
              onNavigate={onNavigate}
              onClose={onClose}
            />
          </div>
        </div>
      ) : (
        <button
          key={entry.bookmark.id}
          type="button"
          className="browser-bookmark-menu-item"
          onClick={() => {
            onNavigate(entry.bookmark.url);
            onClose();
          }}
          title={entry.bookmark.url}
        >
          <WebsiteFavicon url={entry.bookmark.url} size={12} />
          <span className="browser-bookmark-menu-label">
            {entry.bookmark.title}
          </span>
        </button>
      ),
    )}
  </>
);

const FOLDER_MENU_WIDTH = 200;

/**
 * 浏览器收藏栏：标签栏与页面内容之间的横向书签条。
 * 左侧星标收藏/取消收藏当前页；书签与文件夹按树展示，文件夹点击弹出
 * 级联下拉菜单（portal fixed，不受收藏栏 overflow 裁剪）。
 * 数据经 useBrowserBookmarks 跨实例共享，导入/增删改后自动同步。
 */
export const BrowserBookmarksBar = ({
  activeUrl,
  activeTitle,
  onNavigate,
}: BrowserBookmarksBarProps): React.JSX.Element => {
  const { t } = useI18n();
  const { bookmarks, addBookmark, removeBookmark } = useBrowserBookmarks();

  const [openFolder, setOpenFolder] = useState<{
    path: string;
    entries: BookmarkEntry[];
    left: number;
    top: number;
  } | null>(null);

  const barRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildBookmarkTree(bookmarks), [bookmarks]);

  const activeBookmarkId = useMemo(() => {
    const trimmed = activeUrl.trim();
    if (!trimmed) {
      return null;
    }
    return bookmarks.find((item) => item.url === trimmed)?.id ?? null;
  }, [bookmarks, activeUrl]);

  // 垂直滚轮转横向滚动（原生 wheel passive:false，preventDefault 才生效）。
  useEffect(() => {
    const el = barRef.current;
    if (!el) {
      return;
    }
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0 || el.scrollWidth <= el.clientWidth) {
        return;
      }
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // 点击菜单/触发按钮以外区域（或 Escape）时关闭文件夹菜单。
  useEffect(() => {
    if (!openFolder) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(".browser-bookmark-menu") ||
        target?.closest(".browser-bookmark-folder")
      ) {
        return;
      }
      setOpenFolder(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpenFolder(null);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openFolder]);

  const handleToggle = (): void => {
    const url = activeUrl.trim();
    if (!url) {
      return;
    }
    if (activeBookmarkId) {
      void removeBookmark(activeBookmarkId).catch(() => {});
    } else {
      void addBookmark(url, activeTitle).catch(() => {});
    }
  };

  const toggleLabel = activeBookmarkId
    ? t("rightPanel.browserRemoveBookmark")
    : t("rightPanel.browserAddBookmark");

  const handleFolderClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    entry: Extract<BookmarkEntry, { kind: "folder" }>,
  ): void => {
    // 同一文件夹再次点击 = 关闭（toggle）。
    if (openFolder?.path === entry.path) {
      setOpenFolder(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setOpenFolder({
      path: entry.path,
      entries: entry.entries,
      left: Math.min(rect.left, window.innerWidth - FOLDER_MENU_WIDTH - 8),
      top: rect.bottom + 2,
    });
  };

  return (
    <div className="browser-bookmarks-bar" role="toolbar" ref={barRef}>
      <button
        type="button"
        className={`browser-bookmark-toggle${activeBookmarkId ? " is-active" : ""}`}
        onClick={handleToggle}
        disabled={!activeUrl.trim()}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        <Star
          size={12}
          strokeWidth={1.8}
          fill={activeBookmarkId ? "currentColor" : "none"}
        />
      </button>
      {tree.length === 0 ? (
        <span className="browser-bookmarks-empty">
          {t("rightPanel.browserBookmarksEmpty")}
        </span>
      ) : (
        tree.map((entry) =>
          entry.kind === "folder" ? (
            <button
              key={`folder-${entry.path}`}
              type="button"
              className={`browser-bookmark-item browser-bookmark-folder${
                openFolder?.path === entry.path ? " is-open" : ""
              }`}
              title={entry.name}
              onClick={(event) => handleFolderClick(event, entry)}
            >
              <Folder
                size={11}
                strokeWidth={1.8}
                className="browser-bookmark-icon"
              />
              <span className="browser-bookmark-label">{entry.name}</span>
            </button>
          ) : (
            <div
              key={entry.bookmark.id}
              className="browser-bookmark-item"
              title={entry.bookmark.title}
              onClick={() => onNavigate(entry.bookmark.url)}
            >
              <WebsiteFavicon
                url={entry.bookmark.url}
                size={11}
                className="browser-bookmark-icon"
              />
              <span className="browser-bookmark-label">
                {entry.bookmark.title}
              </span>
              <button
                type="button"
                className="browser-bookmark-delete"
                onClick={(event) => {
                  event.stopPropagation();
                  void removeBookmark(entry.bookmark.id).catch(() => {});
                }}
                aria-label={t("rightPanel.browserBookmarksDelete")}
                title={t("rightPanel.browserBookmarksDelete")}
              >
                <X size={10} strokeWidth={2} />
              </button>
            </div>
          ),
        )
      )}
      {openFolder &&
        createPortal(
          <div
            className="browser-bookmark-menu"
            role="menu"
            style={{ left: openFolder.left, top: openFolder.top }}
          >
            <BookmarkMenuEntries
              entries={openFolder.entries}
              onNavigate={onNavigate}
              onClose={() => setOpenFolder(null)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
};
