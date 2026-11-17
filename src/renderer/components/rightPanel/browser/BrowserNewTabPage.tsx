import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Compass, Folder, History, Search, Star } from "lucide-react";
import { useI18n } from "../../../i18n";
import type {
  BrowserBookmark,
  BrowserTopSite,
} from "../../../../preload/modules/systemApi";
import { useBrowserBookmarks } from "./useBrowserBookmarks";
import { WebsiteFavicon } from "./WebsiteFavicon";

export type BrowserNewTabPageProps = {
  /** 所在标签页是否为当前激活 tab（仅激活时自动聚焦搜索框）。 */
  active: boolean;
  /** 搜索 / 点击网站：交给地址栏同一套解析与导航。 */
  onNavigate: (input: string) => void;
};

const TOP_SITES_LIMIT = 8;

/** 按小时取问候语 key */
const greetingKey = (hour: number) => {
  if (hour >= 5 && hour < 11) return "browser.newTabGreetingMorning" as const;
  if (hour >= 11 && hour < 13) return "browser.newTabGreetingNoon" as const;
  if (hour >= 13 && hour < 18)
    return "browser.newTabGreetingAfternoon" as const;
  if (hour >= 18 && hour < 23) return "browser.newTabGreetingEvening" as const;
  return "browser.newTabGreetingNight" as const;
};

/** 每到整分钟刷新一次的当前时间 */
const useMinuteClock = (): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = (): void => {
      const delay = 60_000 - (Date.now() % 60_000) + 50;
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
};

type BookmarkGroup = { folder: string; items: BrowserBookmark[] };

/** 按文件夹路径分组，未分组在前，组内保持原序。 */
const groupBookmarks = (bookmarks: BrowserBookmark[]): BookmarkGroup[] => {
  const groups = new Map<string, BrowserBookmark[]>();
  for (const bookmark of bookmarks) {
    const folder = bookmark.folder
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" / ");
    const list = groups.get(folder);
    if (list) {
      list.push(bookmark);
    } else {
      groups.set(folder, [bookmark]);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left === "" ? -1 : right === "" ? 1 : 0))
    .map(([folder, items]) => ({ folder, items }));
};

/**
 * 内置浏览器新标签页（起始页为空白页时覆盖在 webview 之上）：
 * 搜索框 + 常用网站（Rust 按站点聚合历史）+ 书签分组，各区无数据时给出引导。
 */
export const BrowserNewTabPage = ({
  active,
  onNavigate,
}: BrowserNewTabPageProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const now = useMinuteClock();
  const timeText = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(now),
    [locale, now],
  );
  const dateText = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "long",
        day: "numeric",
        weekday: "long",
      }).format(now),
    [locale, now],
  );
  const { bookmarks, loaded: bookmarksLoaded } = useBrowserBookmarks();
  const [topSites, setTopSites] = useState<BrowserTopSite[] | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.snow
      .browserHistoryTopSites(TOP_SITES_LIMIT)
      .then((sites) => {
        if (!cancelled) {
          setTopSites(sites);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTopSites([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 仅在焦点空闲时聚焦，避免抢走聊天输入框的焦点
  useEffect(() => {
    if (!active) {
      return;
    }
    const focused = document.activeElement;
    if (!focused || focused === document.body) {
      inputRef.current?.focus();
    }
  }, [active]);

  const groups = useMemo(() => groupBookmarks(bookmarks), [bookmarks]);
  const ready = topSites !== null && bookmarksLoaded;
  const hasSites = (topSites?.length ?? 0) > 0;
  const hasBookmarks = groups.length > 0;

  const submit = (): void => {
    const value = query.trim();
    if (value) {
      onNavigate(value);
    }
  };

  return (
    <div className="browser-newtab">
      <div className="browser-newtab-inner">
        <div className="browser-newtab-clock">
          <span className="browser-newtab-time">{timeText}</span>
          <span className="browser-newtab-date">
            {t(greetingKey(now.getHours()))} · {dateText}
          </span>
        </div>
        <form
          className="browser-newtab-search"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Search size={15} strokeWidth={1.8} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("browser.newTabSearchPlaceholder")}
            spellCheck={false}
          />
        </form>

        {ready && !hasSites && !hasBookmarks ? (
          <div className="browser-newtab-empty">
            <Compass size={28} strokeWidth={1.5} />
            <strong>{t("browser.newTabEmptyTitle")}</strong>
            <span>{t("browser.newTabEmptyHint")}</span>
          </div>
        ) : ready ? (
          <>
            <section className="browser-newtab-section">
              <div className="browser-newtab-section-title">
                <History size={13} strokeWidth={1.8} />
                <span>{t("browser.newTabTopSites")}</span>
              </div>
              {hasSites ? (
                <div className="browser-newtab-sites">
                  {topSites?.map((site) => (
                    <button
                      key={site.host}
                      type="button"
                      className="browser-newtab-site"
                      title={site.url}
                      onClick={() => onNavigate(site.url)}
                    >
                      <span className="browser-newtab-site-icon">
                        <WebsiteFavicon url={site.url} size={20} />
                      </span>
                      <span className="browser-newtab-site-label">
                        {site.title || site.host}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="browser-newtab-hint">
                  {t("browser.newTabTopSitesEmpty")}
                </div>
              )}
            </section>

            <section className="browser-newtab-section">
              <div className="browser-newtab-section-title">
                <Bookmark size={13} strokeWidth={1.8} />
                <span>{t("browser.newTabBookmarks")}</span>
              </div>
              {hasBookmarks ? (
                groups.map((group) => (
                  <div
                    key={group.folder || "__root__"}
                    className="browser-newtab-group"
                  >
                    {groups.length > 1 || group.folder ? (
                      <div className="browser-newtab-group-title">
                        <Folder size={12} strokeWidth={1.8} />
                        <span>
                          {group.folder ||
                            t("browser.newTabBookmarksUngrouped")}
                        </span>
                      </div>
                    ) : null}
                    <div className="browser-newtab-bookmarks">
                      {group.items.map((bookmark) => (
                        <button
                          key={bookmark.id}
                          type="button"
                          className="browser-newtab-bookmark"
                          title={bookmark.url}
                          onClick={() => onNavigate(bookmark.url)}
                        >
                          <WebsiteFavicon url={bookmark.url} size={13} />
                          <span>{bookmark.title || bookmark.url}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="browser-newtab-hint">
                  <Star size={12} strokeWidth={1.8} />
                  <span>{t("browser.newTabBookmarksEmpty")}</span>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
};
