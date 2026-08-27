import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2 } from "lucide-react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  /** When omitted, the cancel button is hidden (single-button alert mode). */
  cancelLabel?: string;
  /** Optional third button (e.g. "minimize to tray" in the close reminder). */
  extraLabel?: string;
  onExtra?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 确认操作进行中（如删除会话）：禁用按钮并显示 loading */
  isConfirming?: boolean;
  variant?: "default" | "warning" | "danger";
  className?: string;
  children?: ReactNode;
};

export const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  extraLabel,
  onExtra,
  onConfirm,
  onCancel,
  isConfirming = false,
  variant = "default",
  className,
  children,
}: ConfirmDialogProps): React.JSX.Element => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    dialogRef.current?.focus();
  }, [open]);

  return createPortal(
    open && (
      <div
        className="confirm-dialog-overlay"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (!isConfirming) {
              onCancel();
            }
          }
          if (e.key === "Enter" && e.target === dialogRef.current) {
            e.preventDefault();
            if (!isConfirming) {
              onConfirm();
            }
          }
        }}
      >
        <div
          className={`confirm-dialog confirm-dialog-${variant}${className ? ` ${className}` : ""}`}
          ref={dialogRef}
          tabIndex={-1}
        >
          <div className="confirm-dialog-header">
            <div className="confirm-dialog-title">
              <AlertTriangle size={16} />
              <span>{title}</span>
            </div>
          </div>
          <div className="confirm-dialog-body">
            {message ? <p>{message}</p> : null}
            {children}
          </div>
          <div className="confirm-dialog-actions">
            {cancelLabel && (
              <button
                type="button"
                className="confirm-dialog-btn cancel"
                onClick={onCancel}
                disabled={isConfirming}
              >
                {cancelLabel}
              </button>
            )}
            {extraLabel && onExtra && (
              <button
                type="button"
                className="confirm-dialog-btn cancel"
                onClick={onExtra}
                disabled={isConfirming}
              >
                {extraLabel}
              </button>
            )}
            <button
              type="button"
              className="confirm-dialog-btn confirm"
              onClick={onConfirm}
              disabled={isConfirming}
            >
              {isConfirming ? (
                <Loader2 size={14} className="spin" aria-hidden="true" />
              ) : null}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    ),
    document.body,
  );
};
