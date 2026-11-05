import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Type } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { stripMarkdown } from "../../../../../shared/stripMarkdown";

type MessageCopyButtonProps = {
  content: string;
  className: string;
};

type MenuPosition = {
  top: number;
  left: number;
} | null;

const MENU_WIDTH = 160;
const MENU_GAP = 6;

export const MessageCopyButton = ({
  content,
  className,
}: MessageCopyButtonProps): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [isCopyMenuOpen, setIsCopyMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const copyToClipboard = useCallback((text: string): void => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const handleCopyAsMarkdown = useCallback((): void => {
    copyToClipboard(content);
    setIsCopyMenuOpen(false);
  }, [content, copyToClipboard]);

  const handleCopyAsText = useCallback((): void => {
    copyToClipboard(stripMarkdown(content));
    setIsCopyMenuOpen(false);
  }, [content, copyToClipboard]);

  useEffect(() => {
    if (!isCopyMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        (copyBtnRef.current && copyBtnRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }
      setIsCopyMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsCopyMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCopyMenuOpen]);

  useLayoutEffect(() => {
    if (!isCopyMenuOpen || !copyBtnRef.current) {
      setMenuPosition(null);
      return;
    }
    const rect = copyBtnRef.current.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + MENU_GAP;
    if (left + MENU_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, rect.right - MENU_WIDTH);
    }
    if (top + 120 > window.innerHeight) {
      top = Math.max(8, rect.top - MENU_GAP - 120);
    }
    setMenuPosition({ top, left });
  }, [isCopyMenuOpen]);

  return (
    <>
      <button
        ref={copyBtnRef}
        className={`${className}${isCopyMenuOpen ? " is-open" : ""}`}
        type="button"
        aria-label={t("chat.copyResponse", { defaultValue: "Copy" })}
        aria-haspopup="true"
        aria-expanded={isCopyMenuOpen}
        onClick={() => setIsCopyMenuOpen((prev) => !prev)}
      >
        {copied ? (
          <Check size={15} strokeWidth={1.8} />
        ) : (
          <Copy size={15} strokeWidth={1.8} />
        )}
      </button>
      {isCopyMenuOpen && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="message-copy-menu"
              style={{ top: menuPosition.top, left: menuPosition.left }}
              role="menu"
            >
              <button
                type="button"
                className="message-copy-menu-item"
                role="menuitem"
                onClick={handleCopyAsText}
              >
                <Type size={14} strokeWidth={1.8} />
                <span className="message-copy-menu-label">
                  {t("chat.copyAsText", { defaultValue: "Copy as text" })}
                </span>
              </button>
              <button
                type="button"
                className="message-copy-menu-item"
                role="menuitem"
                onClick={handleCopyAsMarkdown}
              >
                <Copy size={14} strokeWidth={1.8} />
                <span className="message-copy-menu-label">
                  {t("chat.copyAsMarkdown", {
                    defaultValue: "Copy as Markdown",
                  })}
                </span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
