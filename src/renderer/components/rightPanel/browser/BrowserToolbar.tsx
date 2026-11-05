import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  BotOff,
  Download,
  Loader2,
  MousePointer2,
  RotateCw,
} from "lucide-react";
import { Tooltip } from "../../common/Tooltip";
import { ShortcutHint } from "../../ShortcutHint";
import type {
  BrowserBookmark,
  BrowserDownloadItemEvent,
  BrowserHistoryEntry,
} from "../../../../preload/modules/systemApi";
import { BrowserMenu } from "./BrowserMenu";
import type { BrowserDisplayDevice } from "./browserDeviceSize";
import { BrowserDownloadsPanel } from "./BrowserDownloadsPanel";
import { WebsiteFavicon } from "./WebsiteFavicon";
import { BrowserAddressSuggestions } from "./BrowserAddressSuggestions";
import type { AddressSuggestion } from "./BrowserAddressSuggestions";
import { useBrowserBookmarks } from "./useBrowserBookmarks";
import { useI18n } from "../../../i18n";

/** 地址栏补全下拉的建议条数上限 */
const MAX_ADDRESS_SUGGESTIONS = 8;

/** 合并历史命中与未重复的书签命中（历史在前，已按检索分值排序）。 */
const buildAddressSuggestions = (
  query: string,
  history: readonly BrowserHistoryEntry[],
  bookmarks: readonly BrowserBookmark[],
): AddressSuggestion[] => {
  const trimmed = query.trim().toLowerCase();
  const items: AddressSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of history) {
    if (seen.has(entry.url)) {
      continue;
    }
    seen.add(entry.url);
    items.push({
      key: `history:${entry.id}`,
      kind: "history",
      id: entry.id,
      url: entry.url,
      title: entry.title,
      visitCount: entry.visitCount,
      lastVisitAt: entry.lastVisitAt,
    });
  }
  for (const bookmark of bookmarks) {
    if (seen.has(bookmark.url)) {
      continue;
    }
    if (
      trimmed &&
      !`${bookmark.title} ${bookmark.url}`.toLowerCase().includes(trimmed)
    ) {
      continue;
    }
    seen.add(bookmark.url);
    items.push({
      key: `bookmark:${bookmark.id}`,
      kind: "bookmark",
      id: "",
      url: bookmark.url,
      title: bookmark.title,
      visitCount: 0,
      lastVisitAt: 0,
    });
  }
  return items.slice(0, MAX_ADDRESS_SUGGESTIONS);
};

export type BrowserToolbarProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** 页面已加载完成且存在实际页面时才能选择元素（未加载完成时隐藏选择按钮） */
  canPickElement: boolean;
  addressInput: string;
  isCapturing: boolean;
  isPickingElement: boolean;
  onAddressChange: (value: string) => void;
  onAddressKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** 地址栏 Esc：放弃编辑、恢复当前页面地址，焦点交回页面 */
  onAddressEscape: () => void;
  /** 用户主动聚焦地址栏：上层据此取消待执行的焦点交接 */
  onAddressFocused: () => void;
  /** 选择补全建议（历史/书签）后导航到该地址 */
  onNavigateToUrl: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onScreenshot: () => void;
  onToggleElementPicker: () => void;
  // Browser menu
  zoomFactor: number;
  homepage: string;
  /** 当前选中的显示尺寸设备 id（"default" = 不约束） */
  selectedDeviceId: string;
  /** 菜单「显示尺寸」子菜单展示的设备列表（启用的内置设备 + 自定义设备） */
  menuDevices: readonly BrowserDisplayDevice[];
  onClearCache: () => void;
  onClearCookies: () => void;
  /** 清空内置浏览器的访问历史（地址栏补全数据源） */
  onClearHistory: () => void;
  onOpenSettings: () => void;
  /** 直达浏览器设置面板的「显示尺寸设备」tab */
  onManageDevices: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onForceReload: () => void;
  onFindInPage: () => void;
  onOpenDevTools: () => void;
  onSetHomepage: (url: string) => Promise<void>;
  onSetDeviceSize: (id: string) => void;
  /** 独立窗口专属：还原为右侧面板标签页（undefined 时菜单不显示该项） */
  onRestoreToTabs?: () => void;
  /** 当前标签页是否已共享给 Agent（工具栏显示可见标识，可一键撤销） */
  sharedWithAgent: boolean;
  /** 当前标签页是否运行在隔离会话（Agent 自开页） */
  isolatedSession: boolean;
  onToggleShareWithAgent: () => void;
  onSendPageToAgent: () => void;
  onSendConsoleToAgent: () => void;
  onSendNetworkToAgent: () => void;
  // 下载管理
  downloads: BrowserDownloadItemEvent[];
  onDownloadOpen: (id: number) => void;
  onDownloadShowInFolder: (id: number) => void;
  onDownloadCancel: (id: number) => void;
};

/** 工具栏提示内容：主标题 + 可选说明行 + 可选快捷键键帽。 */
const ToolbarTooltip = ({
  title,
  hint,
  shortcut,
}: {
  title: string;
  hint?: string;
  shortcut?: React.ReactNode;
}): React.JSX.Element => (
  <span className="browser-tooltip-content">
    <span className="browser-tooltip-title">{title}</span>
    {hint ? <span className="browser-tooltip-hint">{hint}</span> : null}
    {shortcut ? (
      <span className="browser-tooltip-shortcut">{shortcut}</span>
    ) : null}
  </span>
);

/**
 * The browser top toolbar: back / forward / reload navigation buttons and
 * an address bar. The screenshot entry lives in the BrowserMenu dropdown.
 *
 * Extracted from BrowserPanelContent for maintainability.
 */
export const BrowserToolbar = ({
  canGoBack,
  canGoForward,
  isLoading,
  canPickElement,
  addressInput,
  isCapturing,
  isPickingElement,
  onAddressChange,
  onAddressKeyDown,
  onAddressEscape,
  onAddressFocused,
  onNavigateToUrl,
  onBack,
  onForward,
  onReload,
  onScreenshot,
  onToggleElementPicker,
  zoomFactor,
  homepage,
  selectedDeviceId,
  menuDevices,
  onClearCache,
  onClearCookies,
  onClearHistory,
  onOpenSettings,
  onManageDevices,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onForceReload,
  onFindInPage,
  onOpenDevTools,
  onSetHomepage,
  onSetDeviceSize,
  onRestoreToTabs,
  sharedWithAgent,
  isolatedSession,
  onToggleShareWithAgent,
  onSendPageToAgent,
  onSendConsoleToAgent,
  onSendNetworkToAgent,
  downloads,
  onDownloadOpen,
  onDownloadShowInFolder,
  onDownloadCancel,
}: BrowserToolbarProps): React.JSX.Element => {
  const { t } = useI18n();
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const activeDownloadCount = downloads.filter(
    (item) => item.state === "progressing",
  ).length;
  // ---- 地址栏补全：历史记录 + 书签建议 ----
  const addressBarRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  // 连续输入时丢弃过期查询结果（只认最后一次请求）。
  const suggestionsRequestRef = useRef(0);
  const suggestionsTimerRef = useRef<number | null>(null);
  const { bookmarks } = useBrowserBookmarks();
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;

  useEffect(
    () => () => {
      if (suggestionsTimerRef.current !== null) {
        window.clearTimeout(suggestionsTimerRef.current);
      }
    },
    [],
  );

  const loadSuggestions = useCallback(async (query: string): Promise<void> => {
    const requestId = suggestionsRequestRef.current + 1;
    suggestionsRequestRef.current = requestId;
    let history: BrowserHistoryEntry[] = [];
    try {
      history = await window.snow.browserHistorySearch(
        query,
        MAX_ADDRESS_SUGGESTIONS,
      );
    } catch {
      history = [];
    }
    if (requestId !== suggestionsRequestRef.current) {
      return;
    }
    setSuggestions(
      buildAddressSuggestions(query, history, bookmarksRef.current),
    );
    setHighlighted(-1);
  }, []);

  const scheduleSuggestions = useCallback(
    (query: string, delay: number): void => {
      if (suggestionsTimerRef.current !== null) {
        window.clearTimeout(suggestionsTimerRef.current);
        suggestionsTimerRef.current = null;
      }
      if (delay <= 0) {
        void loadSuggestions(query);
        return;
      }
      suggestionsTimerRef.current = window.setTimeout(() => {
        suggestionsTimerRef.current = null;
        void loadSuggestions(query);
      }, delay);
    },
    [loadSuggestions],
  );

  const closeSuggestions = useCallback((): void => {
    setSuggestionsOpen(false);
    setHighlighted(-1);
  }, []);

  // 点击下拉与地址栏以外的任何位置（含 guest 内点击经 browserGuestDismiss
  // 合成的 body mousedown）都收起下拉。
  useEffect(() => {
    if (!suggestionsOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Element) {
        if (addressBarRef.current?.contains(target)) {
          return;
        }
        if (target.closest("#browser-address-suggestions")) {
          return;
        }
      }
      closeSuggestions();
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [suggestionsOpen, closeSuggestions]);

  // 聚焦先给最近访问（空查询），继续输入再按内容检索。
  const handleAddressFocus = (): void => {
    // 与浏览器地址栏一致：获得焦点即全选现有地址
    addressInputRef.current?.select();
    onAddressFocused();
    setSuggestionsOpen(true);
    scheduleSuggestions("", 0);
  };

  // 未聚焦时按下鼠标先阻止默认的光标定位，保证首次点击也全选
  const handleAddressMouseDown = (
    e: React.MouseEvent<HTMLInputElement>,
  ): void => {
    const input = addressInputRef.current;
    if (input && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  };

  const handleAddressInputChange = (value: string): void => {
    onAddressChange(value);
    setSuggestionsOpen(true);
    scheduleSuggestions(value, 120);
  };

  const selectSuggestion = useCallback(
    (suggestion: AddressSuggestion): void => {
      closeSuggestions();
      onAddressChange(suggestion.url);
      onNavigateToUrl(suggestion.url);
    },
    [closeSuggestions, onAddressChange, onNavigateToUrl],
  );

  const removeSuggestion = useCallback(
    (suggestion: AddressSuggestion): void => {
      if (suggestion.kind !== "history" || !suggestion.id) {
        return;
      }
      const next = suggestions.filter((item) => item.key !== suggestion.key);
      setSuggestions(next);
      setHighlighted((index) =>
        index >= next.length ? next.length - 1 : index,
      );
      void window.snow.browserHistoryDelete(suggestion.id).catch(() => {});
    },
    [suggestions],
  );

  /** 已消费按键返回 true（不再下发给导航逻辑）。 */
  const handleSuggestionKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ): boolean => {
    // 输入法组合期间的方向键/回车属于候选词操作，交回默认处理。
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return false;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!suggestionsOpen) {
        setSuggestionsOpen(true);
        scheduleSuggestions(addressInput, 0);
        return true;
      }
      if (suggestions.length === 0) {
        return true;
      }
      setHighlighted((prev) => {
        const next = prev + (e.key === "ArrowDown" ? 1 : -1);
        if (next < -1) {
          return suggestions.length - 1;
        }
        if (next >= suggestions.length) {
          return -1;
        }
        return next;
      });
      return true;
    }
    if (e.key === "Escape" && suggestionsOpen) {
      e.preventDefault();
      closeSuggestions();
      return true;
    }
    if (e.key === "Enter" && suggestionsOpen && highlighted >= 0) {
      const suggestion = suggestions[highlighted];
      if (suggestion) {
        e.preventDefault();
        selectSuggestion(suggestion);
        return true;
      }
    }
    return false;
  };

  const handleAddressKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (handleSuggestionKeyDown(e)) {
      return;
    }
    // 下拉已关闭时 Esc = 放弃编辑：恢复当前页面地址并把焦点交回页面。
    if (e.key === "Escape" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      onAddressEscape();
      return;
    }
    onAddressKeyDown(e);
  };

  return (
    <div className="browser-toolbar">
      <Tooltip
        content={<ToolbarTooltip title={t("browser.back")} />}
        placement="top"
      >
        <button
          type="button"
          className="browser-nav-btn"
          onClick={onBack}
          disabled={!canGoBack}
          aria-label={t("browser.back")}
        >
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip
        content={<ToolbarTooltip title={t("browser.forward")} />}
        placement="top"
      >
        <button
          type="button"
          className="browser-nav-btn"
          onClick={onForward}
          disabled={!canGoForward}
          aria-label={t("browser.forward")}
        >
          <ArrowRight size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip
        content={<ToolbarTooltip title={t("browser.reload")} />}
        placement="top"
      >
        <button
          type="button"
          className="browser-nav-btn"
          onClick={onReload}
          aria-label={t("browser.reload")}
        >
          {isLoading ? (
            <Loader2 size={15} strokeWidth={1.8} className="spin-icon" />
          ) : (
            <RotateCw size={15} strokeWidth={1.8} />
          )}
        </button>
      </Tooltip>
      <div className="browser-address-bar" ref={addressBarRef}>
        <WebsiteFavicon
          url={addressInput}
          size={13}
          className="browser-address-icon"
        />
        <input
          type="text"
          className="browser-address-input"
          ref={addressInputRef}
          value={addressInput}
          onChange={(e) => handleAddressInputChange(e.target.value)}
          onKeyDown={handleAddressKeyDown}
          onMouseDown={handleAddressMouseDown}
          onFocus={handleAddressFocus}
          onBlur={closeSuggestions}
          placeholder={t("browser.addressPlaceholder")}
          spellCheck={false}
          role="combobox"
          aria-expanded={suggestionsOpen && suggestions.length > 0}
          aria-controls="browser-address-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={
            highlighted >= 0
              ? `browser-address-suggestion-${highlighted}`
              : undefined
          }
        />
      </div>
      {suggestionsOpen && suggestions.length > 0 && (
        <BrowserAddressSuggestions
          anchor={addressBarRef.current}
          suggestions={suggestions}
          highlightedIndex={highlighted}
          onHighlight={setHighlighted}
          onSelect={selectSuggestion}
          onRemove={removeSuggestion}
        />
      )}
      <Tooltip
        content={
          <ToolbarTooltip
            title={
              sharedWithAgent
                ? t("browser.unshareFromAgent")
                : t("browser.shareWithAgent")
            }
            hint={
              sharedWithAgent
                ? t("browser.unshareFromAgentTitle")
                : t("browser.shareWithAgentTitle")
            }
            shortcut={<ShortcutHint action="browserToggleShareWithAgent" />}
          />
        }
        placement="top"
      >
        <button
          type="button"
          className={`browser-nav-btn browser-agent-share-btn${
            sharedWithAgent ? " is-active" : ""
          }`}
          onClick={onToggleShareWithAgent}
          aria-pressed={sharedWithAgent}
          aria-label={
            sharedWithAgent
              ? t("browser.unshareFromAgent")
              : t("browser.shareWithAgent")
          }
        >
          {sharedWithAgent ? (
            <Bot size={15} strokeWidth={1.8} />
          ) : (
            <BotOff size={15} strokeWidth={1.8} />
          )}
          {sharedWithAgent && <span className="browser-agent-share-dot" />}
        </button>
      </Tooltip>
      {canPickElement && (
        <Tooltip
          content={
            <ToolbarTooltip
              title={t("browser.pickElement")}
              hint={t("browser.pickElementTitle")}
              shortcut={<ShortcutHint action="browserPickElement" />}
            />
          }
          placement="top"
        >
          <button
            type="button"
            className={`browser-nav-btn browser-element-pick-btn${
              isPickingElement ? " is-active" : ""
            }`}
            onClick={onToggleElementPicker}
            aria-label={t("browser.pickElement")}
            aria-pressed={isPickingElement}
          >
            <MousePointer2 size={15} strokeWidth={1.8} />
          </button>
        </Tooltip>
      )}
      <Tooltip
        content={
          <ToolbarTooltip
            title={t("browser.downloadsTitle")}
            hint={t("browser.downloadsHint")}
          />
        }
        placement="top"
      >
        <button
          type="button"
          className={`browser-nav-btn browser-downloads-btn${
            downloadsOpen ? " is-active" : ""
          }`}
          onClick={() => setDownloadsOpen((prev) => !prev)}
          disabled={downloads.length === 0 && activeDownloadCount === 0}
          aria-label={t("browser.downloadsTitle")}
        >
          <Download size={15} strokeWidth={1.8} />
          {activeDownloadCount > 0 && (
            <span className="browser-downloads-badge">
              {activeDownloadCount}
            </span>
          )}
        </button>
      </Tooltip>
      <BrowserMenu
        zoomFactor={zoomFactor}
        homepage={homepage}
        selectedDeviceId={selectedDeviceId}
        menuDevices={menuDevices}
        isCapturing={isCapturing}
        onScreenshot={onScreenshot}
        onClearCache={onClearCache}
        onClearCookies={onClearCookies}
        onClearHistory={onClearHistory}
        onOpenSettings={onOpenSettings}
        onManageDevices={onManageDevices}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomReset={onZoomReset}
        onForceReload={onForceReload}
        onFindInPage={onFindInPage}
        onOpenDevTools={onOpenDevTools}
        onSetHomepage={onSetHomepage}
        onSetDeviceSize={onSetDeviceSize}
        onRestoreToTabs={onRestoreToTabs}
        sharedWithAgent={sharedWithAgent}
        isolatedSession={isolatedSession}
        onSendPageToAgent={onSendPageToAgent}
        onSendConsoleToAgent={onSendConsoleToAgent}
        onSendNetworkToAgent={onSendNetworkToAgent}
      />
      {downloadsOpen && (
        <BrowserDownloadsPanel
          items={downloads}
          onOpen={onDownloadOpen}
          onShowInFolder={onDownloadShowInFolder}
          onCancel={onDownloadCancel}
          onClose={() => setDownloadsOpen(false)}
        />
      )}
    </div>
  );
};
