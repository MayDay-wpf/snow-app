import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  appleSurfaceTransition,
  useAppleThemeMotion,
} from "../../hooks/useAppleThemeMotion";

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
}: ModalProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  const transition = appleSurfaceTransition(reducedMotion);

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

  const dialogClassName = ["app-modal-dialog", `app-modal-${size}`, className]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          animate={appleMotionEnabled ? { opacity: 1 } : undefined}
          className="app-modal-overlay"
          exit={appleMotionEnabled ? { opacity: 0 } : undefined}
          initial={appleMotionEnabled ? { opacity: 0 } : false}
          transition={appleMotionEnabled ? { duration: 0.16 } : undefined}
        >
          <motion.div
            animate={
              appleMotionEnabled
                ? { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }
                : undefined
            }
            aria-describedby={description ? descriptionId : undefined}
            aria-labelledby={titleId}
            aria-modal="true"
            className={dialogClassName}
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
            onKeyDown={handleKeyDown}
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
            transition={appleMotionEnabled ? transition : undefined}
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
