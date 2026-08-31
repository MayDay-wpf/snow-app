import { useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Download,
  Globe,
  Loader2,
  MousePointer2,
  RotateCw,
} from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import type { ScreenshotFeedback } from "./useWebviewScreenshot";
import type { BrowserDownloadItemEvent } from "../../../../preload/modules/systemApi";
import { BrowserMenu } from "./BrowserMenu";
import { BrowserDownloadsPanel } from "./BrowserDownloadsPanel";
import { useI18n } from "../../../i18n";

export type BrowserToolbarProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** 页面已加载完成且存在实际页面时才能选择元素（未加载完成时隐藏选择按钮） */
  canPickElement: boolean;
  addressInput: string;
  isCapturing: boolean;
  isPickingElement: boolean;
  screenshotFeedback: ScreenshotFeedback;
  onAddressChange: (value: string) => void;
  onAddressKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onScreenshot: () => void;
  onToggleElementPicker: () => void;
  // Browser menu
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
  // 下载管理
  downloads: BrowserDownloadItemEvent[];
  onDownloadOpen: (id: number) => void;
  onDownloadShowInFolder: (id: number) => void;
  onDownloadCancel: (id: number) => void;
};

const buildScreenshotClassName = (feedback: ScreenshotFeedback): string => {
  const base = "browser-nav-btn browser-screenshot-btn";
  if (feedback === "success") {
    return `${base} is-success`;
  }
  if (feedback === "error") {
    return `${base} is-error`;
  }
  return base;
};

const renderScreenshotIcon = (
  isCapturing: boolean,
  feedback: ScreenshotFeedback,
): React.JSX.Element => {
  if (isCapturing) {
    return <Loader2 size={15} strokeWidth={1.8} className="spin-icon" />;
  }
  if (feedback === "success") {
    return <Check size={15} strokeWidth={1.8} />;
  }
  return <Camera size={15} strokeWidth={1.8} />;
};

/**
 * The browser top toolbar: back / forward / reload navigation buttons,
 * an address bar, and a screenshot button that captures the current page
 * image to the clipboard.
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
  screenshotFeedback,
  onAddressChange,
  onAddressKeyDown,
  onBack,
  onForward,
  onReload,
  onScreenshot,
  onToggleElementPicker,
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
  // 地址输入框右键菜单（剪切/复制/粘贴/全选）：
  // 主进程已 Menu.setApplicationMenu(null)，Electron 不再提供原生编辑菜单，需自建。
  const addressInputRef = useRef<HTMLInputElement>(null);
  const [addressMenu, setAddressMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleAddressContextMenu = (
    e: React.MouseEvent<HTMLInputElement>,
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    addressInputRef.current?.focus();
    setAddressMenu({ x: e.clientX, y: e.clientY });
  };

  const runAddressCommand = (
    command: "cut" | "copy" | "paste" | "selectAll",
  ): void => {
    const input = addressInputRef.current;
    setAddressMenu(null);
    if (!input) {
      return;
    }
    // 点击菜单项会夺走焦点，执行前必须重新聚焦输入框。
    input.focus();
    if (command === "selectAll") {
      input.select();
      return;
    }
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    if (command === "cut") {
      // 无选区时剪切无意义（对齐原生行为，菜单项已置灰）
      if (start !== end) {
        document.execCommand("cut");
      }
      return;
    }
    if (command === "copy") {
      // 有选区复制选区，否则复制全文
      const text = start !== end ? input.value.slice(start, end) : input.value;
      if (!text) {
        return;
      }
      navigator.clipboard.writeText(text).catch(() => {
        if (start !== end) {
          document.execCommand("copy");
        }
      });
      return;
    }
    document.execCommand("paste");
  };

  const hasAddressSelection = (() => {
    const input = addressInputRef.current;
    return !!input && (input.selectionStart ?? 0) !== (input.selectionEnd ?? 0);
  })();

  const addressMenuItems: ContextMenuItem[] = [
    {
      id: "cut",
      label: t("browser.cut"),
      disabled: !hasAddressSelection,
      onClick: () => runAddressCommand("cut"),
    },
    {
      id: "copy",
      label: t("browser.copy"),
      onClick: () => runAddressCommand("copy"),
    },
    {
      id: "paste",
      label: t("browser.paste"),
      onClick: () => runAddressCommand("paste"),
    },
    {
      id: "selectAll",
      label: t("browser.selectAll"),
      separator: true,
      onClick: () => runAddressCommand("selectAll"),
    },
  ];

  return (
    <div className="browser-toolbar">
      <button
        type="button"
        className="browser-nav-btn"
        onClick={onBack}
        disabled={!canGoBack}
        aria-label={t("browser.back")}
        title={t("browser.back")}
      >
        <ArrowLeft size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-nav-btn"
        onClick={onForward}
        disabled={!canGoForward}
        aria-label={t("browser.forward")}
        title={t("browser.forward")}
      >
        <ArrowRight size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-nav-btn"
        onClick={onReload}
        aria-label={t("browser.reload")}
        title={t("browser.reload")}
      >
        {isLoading ? (
          <Loader2 size={15} strokeWidth={1.8} className="spin-icon" />
        ) : (
          <RotateCw size={15} strokeWidth={1.8} />
        )}
      </button>
      <div className="browser-address-bar">
        <Globe size={13} strokeWidth={1.6} className="browser-address-icon" />
        <input
          ref={addressInputRef}
          type="text"
          className="browser-address-input"
          value={addressInput}
          onChange={(e) => onAddressChange(e.target.value)}
          onKeyDown={onAddressKeyDown}
          onContextMenu={handleAddressContextMenu}
          placeholder={t("browser.addressPlaceholder")}
          spellCheck={false}
        />
      </div>
      {canPickElement && (
        <button
          type="button"
          className={`browser-nav-btn browser-element-pick-btn${
            isPickingElement ? " is-active" : ""
          }`}
          onClick={onToggleElementPicker}
          aria-label={t("browser.pickElement")}
          aria-pressed={isPickingElement}
          title={t("browser.pickElementTitle")}
        >
          <MousePointer2 size={15} strokeWidth={1.8} />
        </button>
      )}
      <button
        type="button"
        className={buildScreenshotClassName(screenshotFeedback)}
        onClick={onScreenshot}
        disabled={isCapturing}
        aria-label={t("browser.screenshot")}
        title={t("browser.screenshotTitle")}
      >
        {renderScreenshotIcon(isCapturing, screenshotFeedback)}
      </button>
      <button
        type="button"
        className={`browser-nav-btn browser-downloads-btn${
          downloadsOpen ? " is-active" : ""
        }`}
        onClick={() => setDownloadsOpen((prev) => !prev)}
        disabled={downloads.length === 0 && activeDownloadCount === 0}
        aria-label={t("browser.downloadsTitle")}
        title={t("browser.downloadsTitle")}
      >
        <Download size={15} strokeWidth={1.8} />
        {activeDownloadCount > 0 && (
          <span className="browser-downloads-badge">{activeDownloadCount}</span>
        )}
      </button>
      <BrowserMenu
        zoomFactor={zoomFactor}
        homepage={homepage}
        onClearCache={onClearCache}
        onClearCookies={onClearCookies}
        onOpenSettings={onOpenSettings}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomReset={onZoomReset}
        onForceReload={onForceReload}
        onFindInPage={onFindInPage}
        onOpenDevTools={onOpenDevTools}
        onSetHomepage={onSetHomepage}
        onRestoreToTabs={onRestoreToTabs}
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
      {addressMenu && (
        <ContextMenu
          x={addressMenu.x}
          y={addressMenu.y}
          items={addressMenuItems}
          onClose={() => setAddressMenu(null)}
        />
      )}
    </div>
  );
};
