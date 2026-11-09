import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";

type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "medium" | "large";
  closeDisabled?: boolean;
  className?: string;
  /**
   * 是否支持按 ESC 关闭。默认关闭：部分弹窗内部存在局部 ESC 语义
   * （引用面板、下拉列表等），需要逐个显式开启。开启后无论焦点是否在
   * 弹窗内都能关闭，且不会把 ESC 漏给全局的「中断会话」快捷键。
   */
  closeOnEscape?: boolean;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({
  open,
  title,
  description,
  closeLabel,
  onClose,
  children,
  footer,
  size = "medium",
  closeDisabled = false,
  className = "",
  closeOnEscape = false,
}: ModalProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // 关闭回调写入 ref：ESC 监听器只依赖 open/closeOnEscape 注册一次，
  // 弹窗内容高频重渲染不会反复解绑。
  const closeRef = useRef({ onClose, closeDisabled });
  closeRef.current = { onClose, closeDisabled };

  useEffect(() => {
    if (!open || !closeOnEscape) return undefined;

    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target;
      const overlay = overlayRef.current;
      // 叠加的弹窗只关最上层：事件落在别的弹窗/确认框里时交给它自己处理。
      if (target instanceof Element) {
        const owner = target.closest(
          ".app-modal-overlay, .confirm-dialog-overlay",
        );
        if (owner && owner !== overlay) return;
      }
      event.preventDefault();
      if (!closeRef.current.closeDisabled) {
        closeRef.current.onClose();
      }
    };

    // 冒泡阶段监听：弹窗内部浮层（画布编辑层、确认框）先 stopPropagation
    // 时不会再关外层弹窗。
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, closeOnEscape]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocusedElement =
      document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocusedElement?.focus();
    };
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;

    const focusableElements = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === firstElement ||
        document.activeElement === dialogRef.current)
    ) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  const dialogClassName = ["app-modal-dialog", `app-modal-${size}`, className]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    open && (
      // data-esc-panel：弹窗打开期间 ESC 归弹窗所有，全局快捷键引擎
      // 据此跳过「中断会话」，避免关闭弹窗时把运行中的会话一并终止。
      <div className="app-modal-overlay" data-esc-panel ref={overlayRef}>
        <div
          aria-describedby={description ? descriptionId : undefined}
          aria-labelledby={titleId}
          aria-modal="true"
          className={dialogClassName}
          onKeyDown={handleKeyDown}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="app-modal-header">
            <div className="app-modal-title-group">
              <strong id={titleId}>{title}</strong>
              {description && <span id={descriptionId}>{description}</span>}
            </div>
            <button
              aria-label={closeLabel}
              className="icon-btn ghost app-modal-close"
              disabled={closeDisabled}
              onClick={onClose}
              title={closeLabel}
              type="button"
            >
              <X size={16} strokeWidth={1.9} />
            </button>
          </div>
          <div className="app-modal-body">{children}</div>
          {footer && <div className="app-modal-footer">{footer}</div>}
        </div>
      </div>
    ),
    document.body,
  );
}
