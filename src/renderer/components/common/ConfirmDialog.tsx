import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  appleSurfaceTransition,
  useAppleThemeMotion,
} from "../../hooks/useAppleThemeMotion";

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
  variant = "default",
  className,
  children,
}: ConfirmDialogProps): React.JSX.Element => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  const transition = appleSurfaceTransition(reducedMotion);

  useEffect(() => {
    if (!open) {
      return;
    }
    dialogRef.current?.focus();
  }, [open]);

  return createPortal(
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          animate={appleMotionEnabled ? { opacity: 1 } : undefined}
          className="confirm-dialog-overlay"
          exit={appleMotionEnabled ? { opacity: 0 } : undefined}
          initial={appleMotionEnabled ? { opacity: 0 } : false}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
            if (e.key === "Enter" && e.target === dialogRef.current) {
              e.preventDefault();
              onConfirm();
            }
          }}
          transition={appleMotionEnabled ? { duration: 0.16 } : undefined}
        >
          <motion.div
            animate={
              appleMotionEnabled
                ? { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }
                : undefined
            }
            className={`confirm-dialog confirm-dialog-${variant}${className ? ` ${className}` : ""}`}
            exit={
              appleMotionEnabled
                ? reducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.985, y: -4, filter: "blur(1px)" }
                : undefined
            }
            initial={
              appleMotionEnabled
                ? reducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.985, y: -4, filter: "blur(1px)" }
                : false
            }
            ref={dialogRef}
            tabIndex={-1}
            transition={appleMotionEnabled ? transition : undefined}
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
                >
                  {cancelLabel}
                </button>
              )}
              {extraLabel && onExtra && (
                <button
                  type="button"
                  className="confirm-dialog-btn cancel"
                  onClick={onExtra}
                >
                  {extraLabel}
                </button>
              )}
              <button
                type="button"
                className="confirm-dialog-btn confirm"
                onClick={onConfirm}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
