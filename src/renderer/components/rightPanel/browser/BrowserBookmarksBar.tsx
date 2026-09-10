import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

/** 文件夹下拉菜单条目（子菜单 hover 展开前由 positionSubmenu 写入 fixed 坐标）。 */
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
          onMouseEnter={(event) => positionSubmenu(event.currentTarget)}
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
/** 子菜单宽度（与 CSS 一致，用于向右放不下时向左翻转）。 */
const SUBMENU_WIDTH = 200;
/** 菜单与触发按钮之间的间距。 */
const MENU_GAP = 2;
/** 菜单与视口边缘的最小留白。 */
const VIEWPORT_MARGIN = 8;
/** 条目行高估算（仅用于判断展开方向，实际高度由 max-height 兜底）。 */
const MENU_ITEM_HEIGHT = 28;
/** 空间被极限压缩时仍保留的最小菜单高度。 */
const MIN_MENU_HEIGHT = 80;

/** 文件夹下拉菜单的定位结果。 */
type FolderMenuPlacement = {
  left: number;
  /** 向下展开时的吸附边（与 bottom 二选一）。 */
  top?: number;
  /** 上方空间更充裕时向上翻转，改用 bottom 吸附。 */
  bottom?: number;
  /** 视口可用高度上限，超出部分菜单内部滚动。 */
  maxHeight: number;
};

/** 下拉菜单状态：定位可随窗口尺寸变化重算，故与内容分开保存。 */
type FolderMenuState = FolderMenuPlacement & {
  path: string;
  entries: BookmarkEntry[];
};

/** 按条目数估算菜单高度（内容区 4px 内边距上下各一份）。 */
const estimateMenuHeight = (count: number): number =>
  count * MENU_ITEM_HEIGHT + 8;

/** 按触发按钮位置与视口剩余空间计算菜单吸附边与限高。 */
const resolveFolderMenuPlacement = (
  rect: DOMRect,
  entryCount: number,
): FolderMenuPlacement => {
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - VIEWPORT_MARGIN;
  // 下方整体放不下且上方更宽裕时向上翻转，否则向下展开并限高滚动。
  const openAbove =
    estimateMenuHeight(entryCount) > spaceBelow && spaceAbove > spaceBelow;
  return {
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        rect.left,
        window.innerWidth - FOLDER_MENU_WIDTH - VIEWPORT_MARGIN,
      ),
    ),
    top: openAbove ? undefined : rect.bottom + MENU_GAP,
    bottom: openAbove ? window.innerHeight - rect.top + MENU_GAP : undefined,
    maxHeight: Math.max(MIN_MENU_HEIGHT, openAbove ? spaceAbove : spaceBelow),
  };
};

/**
 * 子菜单 hover 展开前写入 fixed 坐标：右侧放不下时向左翻转，下方不足时上移
 * 并限高。fixed 定位使其不受父级滚动容器裁剪，也始终留在视口内。
 */
const positionSubmenu = (item: HTMLElement): void => {
  const submenu = item.querySelector<HTMLElement>(
    ":scope > .browser-bookmark-submenu",
  );
  if (!submenu) {
    return;
  }
  const rect = item.getBoundingClientRect();
  // 与父项紧贴，避免鼠标横穿空隙时 hover 中断导致子菜单收起。
  const left =
    rect.right + SUBMENU_WIDTH > window.innerWidth - VIEWPORT_MARGIN
      ? Math.max(VIEWPORT_MARGIN, rect.left - SUBMENU_WIDTH)
      : rect.right;
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(
      rect.top - 5,
      window.innerHeight -
        VIEWPORT_MARGIN -
        estimateMenuHeight(submenu.children.length),
    ),
  );
  submenu.style.left = `${left}px`;
  submenu.style.top = `${top}px`;
  submenu.style.maxHeight = `${Math.max(
    MIN_MENU_HEIGHT,
    window.innerHeight - top - VIEWPORT_MARGIN,
  )}px`;
};

/** 窗口尺寸变化后重算当前展开（display 非 none 即 hover 中）的子菜单坐标。 */
const repositionOpenSubmenus = (): void => {
  document
    .querySelectorAll<HTMLElement>(".browser-bookmark-submenu")
    .forEach((submenu) => {
      if (getComputedStyle(submenu).display === "none") {
        return;
      }
      const item = submenu.parentElement;
      if (item) {
        positionSubmenu(item);
      }
    });
};

/**
 * 浏览器收藏栏：标签栏与页面内容之间的横向书签条。
 * 左侧星标收藏/取消收藏当前页；书签与文件夹按树展示，文件夹点击弹出
 * 级联下拉菜单（portal fixed，不受收藏栏 overflow 裁剪；视口高度不足时
 * 向上翻转并按可用空间限高滚动）。
 * 数据经 useBrowserBookmarks 跨实例共享，导入/增删改后自动同步。
 */
export const BrowserBookmarksBar = ({
  activeUrl,
  activeTitle,
  onNavigate,
}: BrowserBookmarksBarProps): React.JSX.Element => {
  const { t } = useI18n();
  const { bookmarks, addBookmark, removeBookmark } = useBrowserBookmarks();

  const [openFolder, setOpenFolder] = useState<FolderMenuState | null>(null);

  const barRef = useRef<HTMLDivElement>(null);
  /** 当前菜单对应的收藏栏按钮，窗口尺寸变化时据此重算位置。 */
  const folderTriggerRef = useRef<HTMLButtonElement | null>(null);

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

  /** 按触发按钮当前所在位置重算菜单吸附边与限高（尺寸变化时值不变则不重渲染）。 */
  const updateFolderMenuPosition = useCallback((): void => {
    const trigger = folderTriggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setOpenFolder((prev) => {
      if (!prev) {
        return prev;
      }
      const next = {
        ...prev,
        ...resolveFolderMenuPlacement(rect, prev.entries.length),
      };
      return prev.left === next.left &&
        prev.top === next.top &&
        prev.bottom === next.bottom &&
        prev.maxHeight === next.maxHeight &&
        prev.path === next.path
        ? prev
        : next;
    });
  }, []);

  const isFolderMenuOpen = openFolder !== null;

  // 菜单打开期间跟随窗口尺寸、收藏栏滚动与容器尺寸变化，保持贴住触发按钮。
  useEffect(() => {
    if (!isFolderMenuOpen) {
      return;
    }
    let pendingFrame = 0;
    const handleViewportChange = (): void => {
      updateFolderMenuPosition();
      if (pendingFrame) {
        return;
      }
      // 子菜单坐标由主菜单条目位置推导，待 React 提交新位置后再重算。
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        repositionOpenSubmenus();
      });
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    const container = barRef.current?.parentElement ?? null;
    const observer =
      container && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(handleViewportChange)
        : null;
    if (container && observer) {
      observer.observe(container);
    }
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      observer?.disconnect();
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
      }
      folderTriggerRef.current = null;
    };
  }, [isFolderMenuOpen, updateFolderMenuPosition]);

  // 主菜单位置变更后，已展开的子菜单跟随其父项重新定位。
  useLayoutEffect(() => {
    if (openFolder) {
      repositionOpenSubmenus();
    }
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
    folderTriggerRef.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setOpenFolder({
      path: entry.path,
      entries: entry.entries,
      ...resolveFolderMenuPlacement(rect, entry.entries.length),
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
            style={{
              left: openFolder.left,
              top: openFolder.top,
              bottom: openFolder.bottom,
              maxHeight: openFolder.maxHeight,
            }}
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
