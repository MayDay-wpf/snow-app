import {
  ChevronRight,
  CircleDot,
  Code2,
  Ellipsis,
  FileSearch,
  FolderMinus,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../../i18n";
import type { IdeInfo, WorkspaceDirectoryKind } from "../../../../preload";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { FileManagerIcon } from "../../icons/fileManagerIcons";
import { IdeIcon } from "../../icons/ideIcons";
import { isMacOS } from "../../../utils/shortcutUtils";
import { useMenuPosition } from "./useMenuPosition";

type WorkspaceDirectoryMenuProps = {
  canDelete?: boolean;
  directoryPath?: string;
  disabled?: boolean;
  /** 当前目录是否为活动目录（控制“设为活动目录”菜单项的显隐） */
  isActive?: boolean;
  onActivate?: () => void;
  kind?: WorkspaceDirectoryKind;
  onDelete: () => void;
  onOpenChange?: (isOpen: boolean) => void;
  /** 从所属合集移除（合集成员行菜单项，非成员行不传） */
  onRemoveFromCollection?: () => void;
  onRename?: () => void;
  onShowDetails?: () => void;
  /** 右键菜单锚点（光标位置）：非空时菜单以该点定位并保持打开 */
  contextMenuAnchor?: { x: number; y: number } | null;
  /** 右键菜单关闭回调（父组件用于清空锚点） */
  onContextMenuClose?: () => void;
};

const getIdeIcon = (ideId: string): React.JSX.Element => (
  <IdeIcon ideId={ideId} size={13} />
);

export function WorkspaceDirectoryMenu({
  canDelete = true,
  directoryPath,
  disabled,
  isActive = false,
  onActivate,
  kind,
  onDelete,
  onOpenChange,
  onRemoveFromCollection,
  onRename,
  onShowDetails,
  contextMenuAnchor = null,
  onContextMenuClose,
}: WorkspaceDirectoryMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [isButtonOpen, setIsButtonOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // 右键锚点存在时菜单即为打开状态
  const isOpen = isButtonOpen || contextMenuAnchor !== null;
  const [isOpenWithOpen, setIsOpenWithOpen] = useState(false);
  const [installedIdes, setInstalledIdes] = useState<IdeInfo[]>([]);
  const [isLoadingIdes, setIsLoadingIdes] = useState(false);
  const [ideError, setIdeError] = useState<string | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openWithItemRef = useRef<HTMLButtonElement>(null);
  const openWithPanelRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const onContextMenuCloseRef = useRef(onContextMenuClose);
  onContextMenuCloseRef.current = onContextMenuClose;
  const idesLoadedRef = useRef(false);
  const openWithCloseTimerRef = useRef<number | null>(null);

  // 鼠标从触发项移到二级菜单之间存在间隙，直接关闭会导致菜单闪烁。
  // 用短暂延时确认用户确实离开后再收起。
  const scheduleOpenWithClose = (): void => {
    if (openWithCloseTimerRef.current !== null) {
      window.clearTimeout(openWithCloseTimerRef.current);
    }
    openWithCloseTimerRef.current = window.setTimeout(() => {
      openWithCloseTimerRef.current = null;
      setIsOpenWithOpen(false);
    }, 150);
  };

  const cancelOpenWithClose = (): void => {
    if (openWithCloseTimerRef.current !== null) {
      window.clearTimeout(openWithCloseTimerRef.current);
      openWithCloseTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (openWithCloseTimerRef.current !== null) {
        window.clearTimeout(openWithCloseTimerRef.current);
      }
    },
    [],
  );

  const { position: menuPosition } = useMenuPosition({
    isOpen,
    placement: "auto-up-down",
    triggerRef,
    panelRef: menuRef,
    anchorPoint: contextMenuAnchor,
  });

  const { position: openWithPosition } = useMenuPosition({
    isOpen: isOpenWithOpen,
    placement: "auto-left-right",
    triggerRef: openWithItemRef,
    panelRef: openWithPanelRef,
  });

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  const canOpenWith = kind !== "ssh" && Boolean(directoryPath);

  useEffect(() => {
    if (!isOpen || !canOpenWith || idesLoadedRef.current) {
      return;
    }
    idesLoadedRef.current = true;
    setIsLoadingIdes(true);
    setIdeError(null);
    window.snow
      .listInstalledIdes()
      .then((ides) => setInstalledIdes(ides))
      .catch((error) => {
        setIdeError(
          error instanceof Error
            ? error.message
            : t("sidebar.openWithError", {
                defaultValue: "Failed to detect installed IDEs",
              }),
        );
      })
      .finally(() => setIsLoadingIdes(false));
  }, [isOpen, canOpenWith, t]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // 关闭菜单：清空按钮态、右键锚点态与二级菜单态
    const closeMenu = (): void => {
      setIsButtonOpen(false);
      onContextMenuCloseRef.current?.();
      setShowConfirm(false);
      setIsOpenWithOpen(false);
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
        // 二级菜单是独立 portal，不在外层菜单内部，需单独纳入内部判定，
        // 否则点击 IDE 项时 mousedown 会先关闭整个菜单导致点击失效
        (openWithPanelRef.current && openWithPanelRef.current.contains(target))
      ) {
        return;
      }

      closeMenu();
    };

    // 其它区域右键时关闭本菜单（目标行会自行打开自己的菜单）。
    // 注意：右键发生在同一目录行内任意位置（而非仅三点按钮）时，
    // 需要让本行自行重新定位菜单，因此用 closest(".workspace-directory-row")
    // 比较所在行，而不能只用 containerRef（它只包裹三点按钮）。
    const handleGlobalContextMenu = (event: MouseEvent): void => {
      const target = event.target as Node;

      const isSameRow =
        target instanceof Element &&
        containerRef.current instanceof Element &&
        containerRef.current.closest(".workspace-directory-row") !== null &&
        containerRef.current.closest(".workspace-directory-row") ===
          target.closest(".workspace-directory-row");

      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target)) ||
        isSameRow
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
    setIsOpenWithOpen(false);
  };

  const handleActivateClick = (): void => {
    onActivate?.();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
  };

  const handleRenameClick = (): void => {
    onRename?.();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
  };

  const handleDeleteClick = (): void => {
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(true);
    setIsOpenWithOpen(false);
  };

  const handleShowDetailsClick = (): void => {
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
    setIsOpenWithOpen(false);
    onShowDetails?.();
  };

  const handleDeleteConfirm = (): void => {
    onDelete();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
    setIsOpenWithOpen(false);
  };

  const handleDeleteCancel = (): void => {
    setShowConfirm(false);
  };

  const handleOpenWithToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    setIsOpenWithOpen((prev) => !prev);
  };

  const handleOpenInIde = (ide: IdeInfo): void => {
    if (!directoryPath) {
      return;
    }
    void window.snow.openInIde(ide.id, directoryPath).catch((error) => {
      // 打开失败时重新展开二级菜单，让用户能看到具体错误
      setIdeError(
        error instanceof Error
          ? error.message
          : t("sidebar.openInIdeError", {
              defaultValue: "Failed to open project in IDE",
            }),
      );
      setIsOpenWithOpen(true);
    });
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
    setIsOpenWithOpen(false);
  };

  // macOS 显示“访达”，Windows 显示“资源管理器”，其余平台显示“文件管理器”
  const fileManagerLabelKey = isMacOS()
    ? "sidebar.openWithFinder"
    : navigator.userAgent.includes("Windows")
      ? "sidebar.openWithExplorer"
      : "sidebar.openWithFileManager";

  const handleOpenInFileManager = (): void => {
    if (!directoryPath) {
      return;
    }
    void window.snow.showItemInFolder(directoryPath).catch((error) => {
      setIdeError(
        error instanceof Error
          ? error.message
          : t("sidebar.openInFileManagerError", {
              defaultValue: "Failed to open in file manager",
            }),
      );
      setIsOpenWithOpen(true);
    });
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
    setIsOpenWithOpen(false);
  };

  const renderOpenWithItems = (): React.JSX.Element => (
    <>
      <button
        type="button"
        className="workspace-directory-menu-item"
        onClick={handleOpenInFileManager}
        role="menuitem"
      >
        <FileManagerIcon size={13} />
        <span>
          {t(fileManagerLabelKey, {
            defaultValue: "Open in Explorer",
          })}
        </span>
      </button>
      {isLoadingIdes ? (
        <div className="workspace-directory-menu-submenu-status">
          <Loader2 className="spin" size={12} />
          <span>
            {t("sidebar.openWithLoading", {
              defaultValue: "Detecting installed IDEs...",
            })}
          </span>
        </div>
      ) : installedIdes.length === 0 ? (
        <div className="workspace-directory-menu-submenu-status">
          <span>
            {t("sidebar.openWithEmpty", {
              defaultValue: "No installed IDEs detected",
            })}
          </span>
        </div>
      ) : (
        installedIdes.map((ide) => (
          <button
            key={ide.id}
            type="button"
            className="workspace-directory-menu-item"
            onClick={() => handleOpenInIde(ide)}
            role="menuitem"
            title={ide.executable}
          >
            {getIdeIcon(ide.id)}
            <span>{ide.name}</span>
          </button>
        ))
      )}
      {ideError ? (
        <div className="workspace-directory-menu-submenu-status error">
          <span>{ideError}</span>
        </div>
      ) : null}
    </>
  );

  return (
    <>
      <span className="workspace-directory-actions-wrapper" ref={containerRef}>
        <span
          aria-expanded={isOpen}
          aria-haspopup="menu"
          className="workspace-directory-actions"
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              handleToggle(event);
            }
          }}
          ref={triggerRef}
          role="button"
          tabIndex={0}
        >
          <Ellipsis size={14} />
        </span>
        {isOpen
          ? createPortal(
              <div
                ref={menuRef}
                className="workspace-directory-menu"
                style={
                  menuPosition
                    ? { top: menuPosition.top, left: menuPosition.left }
                    : undefined
                }
                role="menu"
              >
                {!isActive ? (
                  <button
                    type="button"
                    className="workspace-directory-menu-item"
                    onClick={handleActivateClick}
                    role="menuitem"
                  >
                    <CircleDot size={13} />
                    <span>
                      {t("sidebar.directoryActionActivate", {
                        defaultValue: "Set as active",
                      })}
                    </span>
                  </button>
                ) : null}
                {canOpenWith ? (
                  <span
                    className="workspace-directory-menu-submenu-trigger"
                    onMouseEnter={() => {
                      cancelOpenWithClose();
                      setIsOpenWithOpen(true);
                    }}
                    onMouseLeave={scheduleOpenWithClose}
                  >
                    <button
                      ref={openWithItemRef}
                      type="button"
                      className="workspace-directory-menu-item"
                      aria-expanded={isOpenWithOpen}
                      aria-haspopup="menu"
                      onClick={handleOpenWithToggle}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          handleOpenWithToggle(event);
                        }
                      }}
                      role="menuitem"
                    >
                      <Code2 size={13} />
                      <span>
                        {t("sidebar.openWith", {
                          defaultValue: "Open with",
                        })}
                      </span>
                      <ChevronRight
                        size={12}
                        className="workspace-directory-menu-item-chevron"
                      />
                    </button>
                    {isOpenWithOpen
                      ? createPortal(
                          <div
                            ref={openWithPanelRef}
                            className="workspace-directory-menu workspace-directory-menu-submenu"
                            style={
                              openWithPosition
                                ? {
                                    top: openWithPosition.top,
                                    left: openWithPosition.left,
                                  }
                                : undefined
                            }
                            role="menu"
                            onMouseEnter={() => {
                              cancelOpenWithClose();
                              setIsOpenWithOpen(true);
                            }}
                            onMouseLeave={scheduleOpenWithClose}
                          >
                            {renderOpenWithItems()}
                          </div>,
                          document.body,
                        )
                      : null}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="workspace-directory-menu-item"
                  onClick={handleShowDetailsClick}
                  role="menuitem"
                >
                  <FileSearch size={13} />
                  <span>
                    {t("sidebar.directoryDetails", {
                      defaultValue: "Details",
                    })}
                  </span>
                </button>
                {onRename ? (
                  <button
                    type="button"
                    className="workspace-directory-menu-item"
                    onClick={handleRenameClick}
                    role="menuitem"
                  >
                    <Pencil size={13} />
                    <span>
                      {t("sidebar.directoryActionRename", {
                        defaultValue: "Rename",
                      })}
                    </span>
                  </button>
                ) : null}
                {onRemoveFromCollection ? (
                  <button
                    type="button"
                    className="workspace-directory-menu-item"
                    onClick={() => {
                      setIsButtonOpen(false);
                      onContextMenuCloseRef.current?.();
                      setShowConfirm(false);
                      setIsOpenWithOpen(false);
                      onRemoveFromCollection();
                    }}
                    role="menuitem"
                  >
                    <FolderMinus size={13} />
                    <span>
                      {t("sidebar.removeFromCollection", {
                        defaultValue: "Remove from collection",
                      })}
                    </span>
                  </button>
                ) : null}
                {canDelete ? (
                  <button
                    type="button"
                    className="workspace-directory-menu-item danger"
                    disabled={disabled}
                    onClick={handleDeleteClick}
                    role="menuitem"
                  >
                    <Trash2 size={13} />
                    <span>
                      {t("sidebar.deleteDirectory", {
                        defaultValue: "Delete",
                      })}
                    </span>
                  </button>
                ) : null}
              </div>,
              document.body,
            )
          : null}
      </span>
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.deleteDirectory", { defaultValue: "Delete" })}
        message={t("sidebar.directoryDeleteConfirm", {
          defaultValue: "Are you sure you want to delete this directory?",
        })}
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        open={showConfirm}
        title={t("sidebar.deleteDirectoryTitle", {
          defaultValue: "Delete directory",
        })}
        variant="danger"
      />
    </>
  );
}
