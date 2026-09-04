import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type FormDialogProps = {
  open: boolean;
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  closeLabel?: string;
  showFooter?: boolean;
  confirmDisabled?: boolean;
  isSubmitting?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onConfirm?: () => void;
  onCancel: () => void;
  children: ReactNode;
};

export function FormDialog({
  open,
  title,
  confirmLabel,
  cancelLabel,
  closeLabel = "Close",
  showFooter = true,
  confirmDisabled = false,
  isSubmitting = false,
  initialFocusRef,
  onConfirm,
  onCancel,
  children,
}: FormDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    const previouslyFocusedElement = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    requestAnimationFrame(() => {
      initialFocusRef?.current?.focus();
      if (!initialFocusRef?.current) {
        dialogRef.current?.focus();
      }
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocusedElement?.focus();
    };
  }, [initialFocusRef, open]);

  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!isSubmitting) onCancel();
      return;
    }

    if (event.key !== "Tab" || !dialogRef.current) return;

    const focusableElements = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
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

  return createPortal(
    <div className="form-dialog-overlay">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="form-dialog-card"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="form-dialog-header">
          <h2 className="form-dialog-title" id={titleId}>
            {title}
          </h2>
          <button
            aria-label={closeLabel}
            className="icon-btn ghost form-dialog-close"
            disabled={isSubmitting}
            onClick={onCancel}
            title={closeLabel}
            type="button"
          >
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>
        <div className="form-dialog-body">{children}</div>
        {showFooter ? (
          <div className="form-dialog-footer">
            <button
              className="form-dialog-button cancel"
              disabled={isSubmitting}
              onClick={onCancel}
              type="button"
            >
              {cancelLabel}
            </button>
            <button
              className="form-dialog-button confirm"
              disabled={confirmDisabled || isSubmitting}
              onClick={onConfirm}
              type="button"
            >
              {isSubmitting ? <span className="form-dialog-spinner" /> : null}
              {confirmLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
