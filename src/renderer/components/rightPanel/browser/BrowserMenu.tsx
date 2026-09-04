import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Code2,
  Cookie,
  EllipsisVertical,
  Eraser,
  Globe,
  Minus,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import { useI18n } from "../../../i18n";

export type BrowserMenuProps = {
  zoomFactor: number;
  homepage: string;
  onClearCache: () => void;
  onClearCookies: () => void;
  onOpenSettings: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onForceReload: () => void;
  onFindInPage: () => void;
  onOpenDevTools: () => void;
  onSetHomepage: (url: string) => Promise<void>;
  /** 独立窗口专属：还原为右侧面板标签页（undefined 时菜单不显示该项） */
  onRestoreToTabs?: () => void;
};

type MenuPosition = {
  top: number;
  left: number;
} | null;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const MENU_WIDTH = 200;
const MENU_GAP = 4;
const ESTIMATED_MENU_HEIGHT = 268;
/** 「还原为标签页」菜单项（独立窗口专属）的高度估算增量 */
const RESTORE_ITEM_HEIGHT = 36;

const formatZoomPercent = (factor: number): string =>
  `${Math.round(factor * 100)}%`;

/**
 * "More actions" dropdown menu for the embedded browser toolbar.
 *
 * Rendered through a React portal (document.body) with `position: fixed` so it
 * is never clipped by the `overflow: hidden` ancestors (`.browser-panel`,
 * `.browser-content`) or by any `backdrop-filter` containing block. Follows the
 * same positioning pattern as `WorkspaceDirectoryMenu`.
 *
 * Layout:
 *   - 清除浏览数据: flyout submenu (清除缓存 / 清除 Cookie), opens on hover
 *     to the left of the menu.
 *   - 缩放: inline row with direct - / % (click to reset) / + controls. The
 *     menu stays open while adjusting so the user can tap +/- repeatedly.
 *   - 设置默认起始页: inline row with click-to-edit input. Empty means blank.
 *   - 强制重新加载, 在页面中查找, 开发者工具: one-shot action items.
 */
export const BrowserMenu = ({
  zoomFactor,
  homepage,
  onClearCache,
  onClearCookies,
  onOpenSettings,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onForceReload,
  onFindInPage,
  onOpenDevTools,
  onSetHomepage,
  onRestoreToTabs,
}: BrowserMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isClearDataSubOpen, setIsClearDataSubOpen] = useState(false);
  const [isHomepageEditing, setIsHomepageEditing] = useState(false);
  const [homepageDraft, setHomepageDraft] = useState(homepage);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const homepageInputRef = useRef<HTMLInputElement>(null);

  // Sync draft when homepage changes externally or menu reopens
  useEffect(() => {
    setHomepageDraft(homepage);
  }, [homepage]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isHomepageEditing && homepageInputRef.current) {
      homepageInputRef.current.focus();
      homepageInputRef.current.select();
    }
  }, [isHomepageEditing]);

  // Close on outside click / Escape. The portal lives on document.body, so we
  // must exclude clicks inside BOTH the trigger wrapper and the portaled menu.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }
      setIsOpen(false);
      setIsClearDataSubOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen]);

  // Compute the portal position. Dependencies are intentionally [isOpen] only:
  // re-running on other state changes (e.g. the submenu toggling) can read a
  // zero bounding rect mid-render and fling the menu to the top-left corner.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) {
      setMenuPosition(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedHeight =
      ESTIMATED_MENU_HEIGHT + (onRestoreToTabs ? RESTORE_ITEM_HEIGHT : 0);
    let left = rect.right - MENU_WIDTH;
    let top = rect.bottom + MENU_GAP;
    if (left < 8) {
      left = 8;
    }
    if (top + estimatedHeight > window.innerHeight) {
      top = Math.max(8, rect.top - MENU_GAP - estimatedHeight);
    }
    setMenuPosition({ top, left });
  }, [isOpen, onRestoreToTabs]);

  const close = useCallback((): void => {
    setIsOpen(false);
    setIsClearDataSubOpen(false);
    setIsHomepageEditing(false);
  }, []);

  // ESC 关闭整个菜单（层级栈）。默认主页编辑态时本层让位（gate=false）：
  // 事件继续传播到 homepage 输入框的 onKeyDown，由其恢复草稿并退出编辑态、
  // 保留菜单（与收敛前行为一致）。
  useEscapeKey({
    onEscape: close,
    enabled: isOpen,
    gate: () => !isHomepageEditing,
  });

  const runAction = useCallback(
    (fn: () => void): void => {
      fn();
      close();
    },
    [close],
  );

  const handleTriggerClick = (): void => {
    setIsOpen((prev) => !prev);
    setIsClearDataSubOpen(false);
    setIsHomepageEditing(false);
  };

  const handleSaveHomepage = useCallback(async (): Promise<void> => {
    await onSetHomepage(homepageDraft);
    setIsHomepageEditing(false);
  }, [homepageDraft, onSetHomepage]);

  const handleHomepageKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSaveHomepage();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setHomepageDraft(homepage);
      setIsHomepageEditing(false);
    }
  };

  const canZoomIn = zoomFactor < ZOOM_MAX;
  const canZoomOut = zoomFactor > ZOOM_MIN;
  const canZoomReset = zoomFactor !== 1;

  return (
    <div className="browser-menu-wrapper" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`browser-nav-btn browser-menu-trigger${
          isOpen ? " is-open" : ""
        }`}
        onClick={handleTriggerClick}
        aria-label={t("browser.moreActions")}
        aria-haspopup="true"
        aria-expanded={isOpen}
        title={t("browser.moreActions")}
      >
        <EllipsisVertical size={15} strokeWidth={1.8} />
      </button>
      {isOpen && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="browser-menu-dropdown"
              style={{ top: menuPosition.top, left: menuPosition.left }}
              role="menu"
            >
              {/* 独立窗口专属：把本实例（含全部内部标签页）还原回主窗口
                  右侧面板的浏览器 tab（保持实例 id），随后窗口关闭。 */}
              {onRestoreToTabs && (
                <button
                  type="button"
                  className="browser-menu-item"
                  role="menuitem"
                  onClick={() => runAction(onRestoreToTabs)}
                >
                  <PanelLeft size={14} strokeWidth={1.8} />
                  <span className="browser-menu-label">
                    {t("browser.restoreToTabs")}
                  </span>
                </button>
              )}

              <div
                className="browser-menu-submenu"
                onMouseEnter={() => setIsClearDataSubOpen(true)}
                onMouseLeave={() => setIsClearDataSubOpen(false)}
              >
                <button
                  type="button"
                  className="browser-menu-item browser-menu-submenu-trigger"
                  role="menuitem"
                  aria-haspopup="true"
                  aria-expanded={isClearDataSubOpen}
                  onClick={() => setIsClearDataSubOpen((prev) => !prev)}
                >
                  <Trash2 size={14} strokeWidth={1.8} />
                  <span className="browser-menu-label">
                    {t("browser.clearBrowsingData")}
                  </span>
                  <ChevronRight
                    size={13}
                    strokeWidth={1.8}
                    className="browser-menu-chevron"
                  />
                </button>
                {isClearDataSubOpen && (
                  <div className="browser-menu-flyout" role="menu">
                    <button
                      type="button"
                      className="browser-menu-item"
                      role="menuitem"
                      onClick={() => runAction(onClearCache)}
                    >
                      <Eraser size={14} strokeWidth={1.8} />
                      <span className="browser-menu-label">
                        {t("browser.clearCache")}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="browser-menu-item"
                      role="menuitem"
                      onClick={() => runAction(onClearCookies)}
                    >
                      <Cookie size={14} strokeWidth={1.8} />
                      <span className="browser-menu-label">
                        {t("browser.clearCookies")}
                      </span>
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                className="browser-menu-item"
                role="menuitem"
                onClick={() => runAction(onOpenSettings)}
              >
                <Settings size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">
                  {t("browser.browserSettings")}
                </span>
              </button>

              <div className="browser-menu-zoom-row">
                <ZoomIn size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">{t("browser.zoom")}</span>
                <button
                  type="button"
                  className="browser-menu-zoom-btn"
                  onClick={onZoomOut}
                  disabled={!canZoomOut}
                  aria-label={t("browser.zoomOut")}
                  title={t("browser.zoomOut")}
                >
                  <Minus size={13} strokeWidth={2.2} />
                </button>
                <button
                  type="button"
                  className="browser-menu-zoom-value"
                  onClick={onZoomReset}
                  disabled={!canZoomReset}
                  title={t("browser.zoomReset")}
                >
                  {formatZoomPercent(zoomFactor)}
                </button>
                <button
                  type="button"
                  className="browser-menu-zoom-btn"
                  onClick={onZoomIn}
                  disabled={!canZoomIn}
                  aria-label={t("browser.zoomIn")}
                  title={t("browser.zoomIn")}
                >
                  <Plus size={13} strokeWidth={2.2} />
                </button>
              </div>

              <div className="browser-menu-homepage-row">
                <Globe size={14} strokeWidth={1.8} />
                {isHomepageEditing ? (
                  <input
                    ref={homepageInputRef}
                    type="text"
                    className="browser-menu-homepage-input"
                    value={homepageDraft}
                    onChange={(e) => setHomepageDraft(e.target.value)}
                    onKeyDown={handleHomepageKeyDown}
                    onBlur={() => void handleSaveHomepage()}
                    placeholder={t("browser.homepagePlaceholder")}
                    spellCheck={false}
                  />
                ) : (
                  <button
                    type="button"
                    className="browser-menu-homepage-display"
                    onClick={() => setIsHomepageEditing(true)}
                    title={t("browser.setHomepage")}
                  >
                    {homepage || t("browser.homepageEmpty")}
                  </button>
                )}
              </div>

              <button
                type="button"
                className="browser-menu-item"
                role="menuitem"
                onClick={() => runAction(onForceReload)}
              >
                <RefreshCw size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">
                  {t("browser.forceReload")}
                </span>
              </button>
              <button
                type="button"
                className="browser-menu-item"
                role="menuitem"
                onClick={() => runAction(onFindInPage)}
              >
                <Search size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">
                  {t("browser.findInPage")}
                </span>
              </button>
              <button
                type="button"
                className="browser-menu-item"
                role="menuitem"
                onClick={() => runAction(onOpenDevTools)}
              >
                <Code2 size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">
                  {t("browser.openDevTools")}
                </span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};
