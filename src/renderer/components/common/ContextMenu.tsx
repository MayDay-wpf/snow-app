import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useEscapeKey } from "../../hooks/useEscapeKey";

export type ContextMenuItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  /** 置灰禁用（如对已删除文件执行打开操作）。 */
  disabled?: boolean;
  /** 危险操作样式（红色文字，如放弃修改）。 */
  danger?: boolean;
  /** 为 true 时在该项之前插入分隔线。 */
  separator?: boolean;
};

type ContextMenuProps = {
  /** 右键时的鼠标坐标（viewport 坐标）。 */
  x: number;
  y: number;
  /** 主菜单项。 */
  items: ContextMenuItem[];
  /** 分隔线下方的附加菜单项（如“关闭标签页”）。 */
  footerItems?: ContextMenuItem[];
  onClose: () => void;
};

const MENU_MIN_WIDTH = 150;

/**
 * 通用右键菜单：portal 渲染在鼠标点击处，
 * 越界时自动收进视口；点击外部或按 Esc 关闭。
 */
export function ContextMenu({
  x,
  y,
  items,
  footerItems,
  onClose,
}: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(y);

  // 统一 ESC 关闭：菜单挂载期间注册为 ESC 层，卸载自动注销
  // （替换原先的 window keydown 监听，走层级栈统一分派）。
  useEscapeKey({ onEscape: onClose });

  // 测量菜单实际高度，避免超出窗口底部。
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
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) {
        return;
      }
      onClose();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - MENU_MIN_WIDTH - 8);

  const renderItem = (item: ContextMenuItem): React.JSX.Element => (
    <div key={item.id}>
      {item.separator && (
        <div className="context-menu-separator" role="separator" />
      )}
      <button
        type="button"
        className={`context-menu-item${item.disabled ? " disabled" : ""}${
          item.danger ? " danger" : ""
        }`}
        role="menuitem"
        disabled={item.disabled}
        onClick={item.onClick}
      >
        {item.icon}
        <span>{item.label}</span>
      </button>
    </div>
  );

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      {items.map(renderItem)}
      {footerItems && footerItems.length > 0 && (
        <>
          <div className="context-menu-separator" role="separator" />
          {footerItems.map(renderItem)}
        </>
      )}
    </div>,
    document.body
  );
}
