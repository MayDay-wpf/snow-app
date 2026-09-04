import {
  AlertTriangle,
  ChevronRight,
  Code2,
  Copy,
  FolderOpen,
  Loader2,
  Pencil,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import type { IdeInfo } from "../../../preload";
import { IdeIcon } from "../icons/ideIcons";
import { useMenuPosition } from "./mainSidebar/useMenuPosition";

type ExplorerEntryContextMenuProps = {
  entryName: string;
  entryPath: string;
  /** 目录时在终端中打开该目录；文件时打开其所在目录。 */
  isDirectory: boolean;
  /** SSH 远程条目不支持系统文件管理器与 IDE 打开方式。 */
  isSsh: boolean;
  /** 当前选中条目数；>1 时菜单切换为批量操作模式。 */
  selectedCount: number;
  onClose: () => void;
  onDelete: () => Promise<void>;
  /** 批量删除选中条目（selectedCount > 1 时使用）。 */
  onDeleteSelected?: () => Promise<void>;
  /** 批量复制选中路径（selectedCount > 1 时使用）。 */
  onCopySelectedPaths?: () => void;
  onOpenTerminal?: (cwd: string) => void;
  onRename: (newName: string) => Promise<void>;
  position: { x: number; y: number };
};

export type MenuMode = "actions" | "delete" | "rename";

export function ExplorerEntryContextMenu({
  entryName,
  entryPath,
  isDirectory,
  isSsh,
  selectedCount,
  onClose,
  onDelete,
  onDeleteSelected,
  onCopySelectedPaths,
  onOpenTerminal,
  onRename,
  position,
}: ExplorerEntryContextMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const isMultiSelect = selectedCount > 1;
  const [mode, setMode] = useState<MenuMode>("actions");
  const [newName, setNewName] = useState(entryName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [top, setTop] = useState(position.y);

  // 打开方式二级菜单：已安装 IDE 列表（仿工作区目录菜单的加载与悬停逻辑）。
  const [isOpenWithOpen, setIsOpenWithOpen] = useState(false);
  const [installedIdes, setInstalledIdes] = useState<IdeInfo[]>([]);
  const [isLoadingIdes, setIsLoadingIdes] = useState(false);
  const [ideError, setIdeError] = useState<string | null>(null);
  const idesLoadedRef = useRef(false);
  const openWithItemRef = useRef<HTMLButtonElement | null>(null);
  const openWithPanelRef = useRef<HTMLDivElement | null>(null);
  const openWithCloseTimerRef = useRef<number | null>(null);

  const canOpenWith = !isSsh && Boolean(entryPath);

  // 测量菜单实际高度，避免超出窗口底部；三种模式高度不同，切换时重新测量。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      setTop(Math.max(8, window.innerHeight - rect.height - 8));
    } else if (rect.top < 8) {
      setTop(8);
    }
  }, [mode]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      // 二级菜单是独立 portal，需纳入内部判定，否则点击 IDE 项时
      // pointerdown 会先关闭整个菜单导致点击失效。
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) ||
          openWithPanelRef.current?.contains(target))
      ) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (mode === "rename") {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [mode]);

  // 菜单打开且可用「打开方式」时，加载一次已安装 IDE 列表。
  useEffect(() => {
    if (mode !== "actions" || !canOpenWith || idesLoadedRef.current) {
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
              })
        );
      })
      .finally(() => setIsLoadingIdes(false));
  }, [mode, canOpenWith, t]);

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
    []
  );

  const { position: openWithPosition } = useMenuPosition({
    isOpen: isOpenWithOpen,
    placement: "auto-left-right",
    triggerRef: openWithItemRef,
    panelRef: openWithPanelRef,
  });

  const handleRenameSubmit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    const trimmedName = newName.trim();
    if (!trimmedName || isSubmitting) {
      return;
    }

    if (trimmedName === entryName) {
      onClose();
      return;
    }

    setIsSubmitting(true);
    try {
      await onRename(trimmedName);
      onClose();
    } catch {
      // The explorer surfaces operation errors in its content area.
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      if (isMultiSelect && onDeleteSelected) {
        await onDeleteSelected();
      } else {
        await onDelete();
      }
      onClose();
    } catch {
      // The explorer surfaces operation errors in its content area.
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenTerminalClick = (): void => {
    onClose();
    // 文件条目在终端中打开其所在目录（与文件查看器行为一致）。
    let cwd = entryPath;
    if (!isDirectory) {
      const lastSep = Math.max(
        entryPath.lastIndexOf("/"),
        entryPath.lastIndexOf("\\")
      );
      cwd = lastSep === -1 ? entryPath : entryPath.slice(0, lastSep);
    }
    onOpenTerminal?.(cwd);
  };

  const handleShowInFolder = (): void => {
    onClose();
    void window.snow.showItemInFolder(entryPath).catch(() => {
      // 打开失败时静默忽略（例如路径已被删除）。
    });
  };

  const handleCopyPath = (): void => {
    onClose();
    void window.snow.writeClipboardText(entryPath).catch(() => {
      // 剪贴板写入失败时静默忽略。
    });
  };

  const handleCopySelectedPaths = (): void => {
    onClose();
    onCopySelectedPaths?.();
  };

  const handleOpenInIde = (ide: IdeInfo): void => {
    // 先收起二级菜单；打开成功才关闭整个菜单，失败时保留菜单并
    // 重新展开二级菜单展示错误，避免错误信息一闪而过。
    setIsOpenWithOpen(false);
    void window.snow
      .openInIde(ide.id, entryPath)
      .then(() => onClose())
      .catch((error) => {
        setIdeError(
          error instanceof Error
            ? error.message
            : t("sidebar.openInIdeError", {
                defaultValue: "Failed to open project in IDE",
              })
        );
        setIsOpenWithOpen(true);
      });
  };

  const handleOpenWithToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    setIsOpenWithOpen((prev) => !prev);
  };

  const renderOpenWithItems = (): React.JSX.Element => (
    <>
      {isLoadingIdes ? (
        <div className="explorer-entry-context-menu-submenu-status">
          <Loader2 className="spin" size={12} />
          <span>
            {t("sidebar.openWithLoading", {
              defaultValue: "Detecting installed IDEs...",
            })}
          </span>
        </div>
      ) : installedIdes.length === 0 ? (
        <div className="explorer-entry-context-menu-submenu-status">
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
            className="explorer-entry-context-menu-item"
            onClick={() => handleOpenInIde(ide)}
            role="menuitem"
            title={ide.executable}
          >
            <IdeIcon ideId={ide.id} size={13} />
            <span>{ide.name}</span>
          </button>
        ))
      )}
      {ideError ? (
        <div className="explorer-entry-context-menu-submenu-status error">
          <span>{ideError}</span>
        </div>
      ) : null}
    </>
  );

  const menuWidth = 208;
  const left = Math.min(position.x, window.innerWidth - menuWidth - 8);

  return createPortal(
    <div
      className="explorer-entry-context-menu"
      ref={menuRef}
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      {mode === "actions" ? (
        isMultiSelect ? (
          <>
            <div className="explorer-entry-context-menu-heading">
              {t("sidebar.explorerMultiSelectCount", {
                defaultValue: "{{count}} selected",
                values: { count: selectedCount },
              })}
            </div>
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleCopySelectedPaths}
              role="menuitem"
              type="button"
            >
              <Copy size={13} />
              <span>
                {t("sidebar.explorerMultiSelectCopyPaths", {
                  defaultValue: "Copy {{count}} paths",
                  values: { count: selectedCount },
                })}
              </span>
            </button>
            <div className="explorer-entry-context-menu-separator" />
            <button
              className="explorer-entry-context-menu-item danger"
              onClick={() => setMode("delete")}
              role="menuitem"
              type="button"
            >
              <Trash2 size={13} />
              <span>
                {t("sidebar.explorerMultiSelectDelete", {
                  defaultValue: "Delete {{count}} items",
                  values: { count: selectedCount },
                })}
              </span>
            </button>
          </>
        ) : (
          <>
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleOpenTerminalClick}
              role="menuitem"
              type="button"
            >
              <Terminal size={13} />
              <span>
                {t("sidebar.explorerOpenInTerminal", {
                  defaultValue: "Open in Terminal",
                })}
              </span>
            </button>
            {!isSsh ? (
              <button
                className="explorer-entry-context-menu-item"
                onClick={handleShowInFolder}
                role="menuitem"
                type="button"
              >
                <FolderOpen size={13} />
                <span>
                  {t("sidebar.explorerShowInFolder", {
                    defaultValue: "Show in System File Manager",
                  })}
                </span>
              </button>
            ) : null}
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleCopyPath}
              role="menuitem"
              type="button"
            >
              <Copy size={13} />
              <span>
                {t("sidebar.explorerCopyPath", { defaultValue: "Copy Path" })}
              </span>
            </button>
            {canOpenWith ? (
              <span
                className="explorer-entry-context-menu-submenu-trigger"
                onMouseEnter={() => {
                  cancelOpenWithClose();
                  setIsOpenWithOpen(true);
                }}
                onMouseLeave={scheduleOpenWithClose}
              >
                <button
                  ref={openWithItemRef}
                  type="button"
                  className="explorer-entry-context-menu-item"
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
                    {t("sidebar.openWith", { defaultValue: "Open with" })}
                  </span>
                  <ChevronRight
                    size={12}
                    className="explorer-entry-context-menu-item-chevron"
                  />
                </button>
                {isOpenWithOpen
                  ? createPortal(
                      <div
                        ref={openWithPanelRef}
                        className="explorer-entry-context-menu explorer-entry-context-menu-submenu"
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
                      document.body
                    )
                  : null}
              </span>
            ) : null}
            <div className="explorer-entry-context-menu-separator" />
            <button
              className="explorer-entry-context-menu-item"
              onClick={() => setMode("rename")}
              role="menuitem"
              type="button"
            >
              <Pencil size={13} />
              <span>{t("sidebar.explorerRename", { defaultValue: "Rename" })}</span>
            </button>
            <button
              className="explorer-entry-context-menu-item danger"
              onClick={() => setMode("delete")}
              role="menuitem"
              type="button"
            >
              <Trash2 size={13} />
              <span>{t("sidebar.explorerDelete", { defaultValue: "Delete" })}</span>
            </button>
          </>
        )
      ) : mode === "rename" ? (
        <form className="explorer-entry-context-menu-form" onSubmit={handleRenameSubmit}>
          <label htmlFor="explorer-entry-rename-input">
            {t("sidebar.explorerRename", { defaultValue: "Rename" })}
          </label>
          <input
            id="explorer-entry-rename-input"
            onChange={(event) => setNewName(event.target.value)}
            ref={renameInputRef}
            value={newName}
          />
          <div className="explorer-entry-context-menu-actions">
            <button
              disabled={isSubmitting}
              onClick={() => setMode("actions")}
              type="button"
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
            <button disabled={isSubmitting} type="submit">
              {t("common.confirm", { defaultValue: "Confirm" })}
            </button>
          </div>
        </form>
      ) : (
        <div className="explorer-entry-context-menu-confirm">
          <div className="explorer-entry-context-menu-confirm-message">
            <AlertTriangle size={14} />
            <span>
              {isMultiSelect
                ? t("sidebar.explorerMultiSelectDeleteConfirm", {
                    defaultValue:
                      "Delete {{count}} selected items? This cannot be undone.",
                    values: { count: selectedCount },
                  })
                : t("sidebar.explorerDeleteConfirm", {
                    defaultValue: "Delete '{{name}}'? This cannot be undone.",
                    values: { name: entryName },
                  })}
            </span>
          </div>
          <div className="explorer-entry-context-menu-actions">
            <button
              disabled={isSubmitting}
              onClick={() => setMode("actions")}
              type="button"
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
            <button
              className="danger"
              disabled={isSubmitting}
              onClick={() => void handleDelete()}
              type="button"
            >
              {isMultiSelect
                ? t("sidebar.explorerMultiSelectDelete", {
                    defaultValue: "Delete",
                    values: { count: selectedCount },
                  })
                : t("sidebar.explorerDelete", { defaultValue: "Delete" })}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
