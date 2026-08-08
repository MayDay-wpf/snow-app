import {
  Ellipsis,
  Pin,
  PinOff,
  Pencil,
  Trash2,
  Download,
  ChevronRight,
  ChevronLeft,
  SmilePlus,
  ListChecks,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../../i18n";
import { ChatDeleteConfirmDialog } from "./ChatDeleteConfirmDialog";
import { useMenuPosition } from "./useMenuPosition";
import { EmojiPicker } from "./EmojiPicker";

export type ExportFormat = "markdown" | "html" | "json" | "csv";

type ChatItemMenuProps = {
  conversationId: string;
  isPinned: boolean;
  emoji: string;
  onPin: () => void;
  onRename: () => void;
  onSetEmoji: (emoji: string) => void | Promise<void>;
  /** 确认删除；deleteImages=true 表示同时级联删除图库图片 */
  onDelete: (deleteImages: boolean) => void;
  onExport: (format: ExportFormat) => void;
  onEnterMultiSelect?: () => void;
  onOpenChange?: (isOpen: boolean) => void;
  /** 右键菜单锚点（光标位置）：非空时菜单以该点定位并保持打开 */
  contextMenuAnchor?: { x: number; y: number } | null;
  /** 右键菜单关闭回调（父组件用于清空锚点） */
  onContextMenuClose?: () => void;
};

export function ChatItemMenu({
  conversationId,
  isPinned,
  emoji,
  onPin,
  onRename,
  onSetEmoji,
  onDelete,
  onExport,
  onEnterMultiSelect,
  onOpenChange,
  contextMenuAnchor = null,
  onContextMenuClose,
}: ChatItemMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [isButtonOpen, setIsButtonOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  // 删除会话确认：该会话引用的图库图片数（null = 未查询），
  // 以及用户是否选择级联删除图片
  const [imagesCount, setImagesCount] = useState<number | null>(null);
  const [deleteImages, setDeleteImages] = useState(false);
  // 右键锚点存在时菜单即为打开状态
  const isOpen = isButtonOpen || contextMenuAnchor !== null;
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const exportPanelRef = useRef<HTMLDivElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const emojiTriggerRef = useRef<HTMLButtonElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const onContextMenuCloseRef = useRef(onContextMenuClose);
  onContextMenuCloseRef.current = onContextMenuClose;

  const showExportRef = useRef(showExport);
  showExportRef.current = showExport;

  const { position: menuPosition } = useMenuPosition({
    isOpen,
    placement: "auto-up-down",
    triggerRef,
    panelRef: menuRef,
    anchorPoint: contextMenuAnchor,
    onReposition: () => {
      if (showExportRef.current) {
        updateExportPositionRef.current?.();
      }
    },
  });

  const { position: exportPosition, updatePosition: updateExportPosition } =
    useMenuPosition({
      isOpen: isOpen && showExport,
      placement: "auto-left-right",
      triggerRef: exportTriggerRef,
      panelRef: exportPanelRef,
      observeRefs: [menuRef],
    });

  const updateExportPositionRef = useRef(updateExportPosition);
  updateExportPositionRef.current = updateExportPosition;

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // 关闭菜单：清空按钮态与右键锚点态
    const closeMenu = (): void => {
      setIsButtonOpen(false);
      onContextMenuCloseRef.current?.();
      setShowConfirm(false);
      setShowExport(false);
      setShowEmoji(false);
    };

    const handleClickOutside = (event: MouseEvent): void => {
      // 右键按下不立即关闭：由 document 级 contextmenu 监听统一处理，
      // 允许在同一行上连续右键时直接重新定位菜单，避免闪烁。
      if (event.button === 2) {
        return;
      }

      const target = event.target as Node;

      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target)) ||
        (exportPanelRef.current && exportPanelRef.current.contains(target))
      ) {
        return;
      }

      closeMenu();
    };

    // 其它区域右键时关闭本菜单（目标行会自行打开自己的菜单）。
    // 注意：右键发生在同一会话行内任意位置（而非仅三点按钮）时，
    // 需要让本行自行重新定位菜单，因此用 closest(".chat-item") 比较
    // 所在行，而不能只用 containerRef（它只包裹三点按钮）。
    const handleGlobalContextMenu = (event: MouseEvent): void => {
      const target = event.target as Node;

      const isSameChatItem =
        target instanceof Element &&
        containerRef.current instanceof Element &&
        containerRef.current.closest(".chat-item") !== null &&
        containerRef.current.closest(".chat-item") ===
          target.closest(".chat-item");

      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target)) ||
        (exportPanelRef.current && exportPanelRef.current.contains(target)) ||
        isSameChatItem
      ) {
        return;
      }

      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("contextmenu", handleGlobalContextMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("contextmenu", handleGlobalContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    // 点击 … 按钮切换按钮菜单；若右键菜单正打开则先清空锚点
    setIsButtonOpen((prev) => !prev);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
    setShowExport(false);
    setShowEmoji(false);
  };

  const handlePin = (): void => {
    onPin();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
  };

  const handleRename = (): void => {
    onRename();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
  };

  const handleMultiSelect = (): void => {
    onEnterMultiSelect?.();
    setIsButtonOpen(false);
  };

  const handleDeleteClick = (): void => {
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(true);
    setShowExport(false);
    setShowEmoji(false);
    // 打开确认框时查询该会话引用的图库图片数
    setImagesCount(null);
    setDeleteImages(false);
    void window.snow
      .countConversationImages([conversationId])
      .then((count) => setImagesCount(count))
      .catch(() => setImagesCount(0));
  };

  const handleDeleteConfirm = (): void => {
    onDelete(deleteImages);
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
  };

  const handleDeleteCancel = (): void => {
    setShowConfirm(false);
  };

  const handleExportClick = (): void => {
    setShowExport((prev) => !prev);
    setShowConfirm(false);
    setShowEmoji(false);
  };

  const handleExportSelect = (format: ExportFormat): void => {
    onExport(format);
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowExport(false);
  };

  const handleEmojiClick = (): void => {
    setShowEmoji((prev) => !prev);
    setShowConfirm(false);
    setShowExport(false);
  };

  const handleEmojiSelect = (emoji: string): void => {
    void onSetEmoji(emoji);
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowEmoji(false);
    setShowConfirm(false);
    setShowExport(false);
  };

  // Escape / 焦点离开面板等场景：关闭整个菜单
  const handleEmojiClose = (): void => {
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowEmoji(false);
    setShowConfirm(false);
    setShowExport(false);
  };

  return (
    <>
      <span className="chat-item-actions-wrapper" ref={containerRef}>
      <span
        ref={triggerRef}
        className="chat-item-actions"
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={handleToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleToggle(event);
          }
        }}
      >
        <Ellipsis size={14} />
      </span>
      {isOpen
        ? createPortal(
            <div
              ref={menuRef}
              className="chat-item-menu"
              style={
                menuPosition
                  ? { top: menuPosition.top, left: menuPosition.left }
                  : undefined
              }
              role="menu"
            >
              <>
                  <button
                    type="button"
                    className="chat-item-menu-item"
                    onClick={handlePin}
                    role="menuitem"
                  >
                    {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                    <span>
                      {isPinned
                        ? t("sidebar.chatActionUnpin", {
                            defaultValue: "Unpin",
                          })
                        : t("sidebar.chatActionPin", { defaultValue: "Pin" })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="chat-item-menu-item"
                    onClick={handleRename}
                    role="menuitem"
                  >
                    <Pencil size={13} />
                    <span>
                      {t("sidebar.chatActionRename", {
                        defaultValue: "Rename",
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    ref={emojiTriggerRef}
                    className={`chat-item-menu-item${showEmoji ? " active" : ""}`}
                    onClick={handleEmojiClick}
                    role="menuitem"
                    aria-expanded={showEmoji}
                    aria-haspopup="menu"
                  >
                    {emoji ? (
                      <span className="chat-item-menu-emoji">{emoji}</span>
                    ) : (
                      <SmilePlus size={13} />
                    )}
                    <span>
                      {t("sidebar.chatActionIcon", { defaultValue: "Icon" })}
                    </span>
                    <ChevronRight
                      size={11}
                      className="chat-item-menu-sub-arrow"
                    />
                  </button>
                  <button
                    type="button"
                    ref={exportTriggerRef}
                    className={`chat-item-menu-item${
                      showExport ? " active" : ""
                    }`}
                    onClick={handleExportClick}
                    role="menuitem"
                    aria-expanded={showExport}
                    aria-haspopup="menu"
                  >
                    <Download size={13} />
                    <span>
                      {t("sidebar.chatActionExport", {
                        defaultValue: "Export",
                      })}
                    </span>
                    <ChevronRight
                      size={11}
                      className="chat-item-menu-sub-arrow"
                    />
                  </button>
                  {onEnterMultiSelect ? (
                    <button
                      type="button"
                      className="chat-item-menu-item"
                      onClick={handleMultiSelect}
                      role="menuitem"
                    >
                      <ListChecks size={13} />
                      <span>
                        {t("sidebar.chatActionMultiSelect", {
                          defaultValue: "Multi-select",
                        })}
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="chat-item-menu-item danger"
                    onClick={handleDeleteClick}
                    role="menuitem"
                  >
                    <Trash2 size={13} />
                    <span>
                      {t("sidebar.chatActionDelete", {
                        defaultValue: "Delete",
                      })}
                    </span>
                  </button>
                </>
            </div>,
            document.body
          )
        : null}
      {isOpen && showExport
        ? createPortal(
            <div
              ref={exportPanelRef}
              className="chat-item-menu chat-item-export-panel"
              style={
                exportPosition
                  ? { top: exportPosition.top, left: exportPosition.left }
                  : undefined
              }
              role="menu"
            >
              <div className="chat-item-export-panel-header">
                <ChevronLeft size={11} className="chat-item-export-back-icon" />
                <span>
                  {t("sidebar.chatActionExport", {
                    defaultValue: "Export",
                  })}
                </span>
              </div>
              {(
                [
                  { format: "markdown" as const, label: "Markdown" },
                  { format: "html" as const, label: "HTML" },
                  { format: "json" as const, label: "JSON" },
                  { format: "csv" as const, label: "CSV" },
                ] satisfies Array<{ format: ExportFormat; label: string }>
              ).map(({ format, label }) => (
                <button
                  key={format}
                  type="button"
                  className="chat-item-menu-item"
                  onClick={() => handleExportSelect(format)}
                  role="menuitem"
                >
                  <span className="chat-item-export-format-label">{label}</span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
      {isOpen && showEmoji && (
        <EmojiPicker
          triggerRef={emojiTriggerRef}
          currentEmoji={emoji}
          onSelect={handleEmojiSelect}
          onClose={handleEmojiClose}
          focusOutKeepRef={menuRef}
        />
      )}
      </span>
      <ChatDeleteConfirmDialog
        conversationCount={1}
        deleteImages={deleteImages}
        imagesCount={imagesCount}
        isBatch={false}
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        onDeleteImagesChange={setDeleteImages}
        open={showConfirm}
      />
    </>
  );
}
