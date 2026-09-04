import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Eye, FileCode, GitFork, Type } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { stripMarkdown } from "../utils/stripMarkdown";

export type AiResponseActionsProps = {
  content: string;
  conversationId: string;
  responseId?: string;
  showRawMarkdown: boolean;
  onToggleRawMarkdown: () => void;
  onFork: (conversationId: string, upToResponseId: string) => void;
};

type MenuPosition = {
  top: number;
  left: number;
} | null;

const MENU_WIDTH = 160;
const MENU_GAP = 6;

export const AiResponseActions = ({
  content,
  conversationId,
  responseId,
  showRawMarkdown,
  onToggleRawMarkdown,
  onFork,
}: AiResponseActionsProps): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [isCopyMenuOpen, setIsCopyMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const copyToClipboard = useCallback(
    (text: string): void => {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      });
    },
    []
  );

  const handleCopyAsMarkdown = useCallback((): void => {
    copyToClipboard(content);
    setIsCopyMenuOpen(false);
  }, [content, copyToClipboard]);

  const handleCopyAsText = useCallback((): void => {
    copyToClipboard(stripMarkdown(content));
    setIsCopyMenuOpen(false);
  }, [content, copyToClipboard]);

  const handleFork = (): void => {
    onFork(conversationId, responseId ?? "");
  };

  // Close on outside click / Escape. The menu is portaled to document.body, so
  // we must exclude clicks inside BOTH the trigger button and the portaled menu.
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

  // Compute the portal position. Depends on [isCopyMenuOpen] only so that
  // mid-render zero-rect reads do not fling the menu to the top-left corner.
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

  const handleCopyBtnClick = (): void => {
    setIsCopyMenuOpen((prev) => !prev);
  };

  return (
    <div className="ai-response-actions" aria-label="AI response actions">
      <button
        className={`ai-response-action-btn${showRawMarkdown ? " is-open" : ""}`}
        type="button"
        aria-label={
          showRawMarkdown
            ? t("chat.showRenderedView", { defaultValue: "Show rendered view" })
            : t("chat.showRawMarkdown", { defaultValue: "Show raw Markdown" })
        }
        aria-pressed={showRawMarkdown}
        onClick={onToggleRawMarkdown}
      >
        {showRawMarkdown ? (
          <Eye size={15} strokeWidth={1.8} />
        ) : (
          <FileCode size={15} strokeWidth={1.8} />
        )}
      </button>
      <button
        ref={copyBtnRef}
        className={`ai-response-action-btn${isCopyMenuOpen ? " is-open" : ""}`}
        type="button"
        aria-label={t("chat.copyResponse", { defaultValue: "Copy" })}
        aria-haspopup="true"
        aria-expanded={isCopyMenuOpen}
        onClick={handleCopyBtnClick}
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
              className="ai-response-copy-menu"
              style={{ top: menuPosition.top, left: menuPosition.left }}
              role="menu"
            >
              <button
                type="button"
                className="ai-response-copy-menu-item"
                role="menuitem"
                onClick={handleCopyAsText}
              >
                <Type size={14} strokeWidth={1.8} />
                <span className="ai-response-copy-menu-label">
                  {t("chat.copyAsText", { defaultValue: "Copy as text" })}
                </span>
              </button>
              <button
                type="button"
                className="ai-response-copy-menu-item"
                role="menuitem"
                onClick={handleCopyAsMarkdown}
              >
                <Copy size={14} strokeWidth={1.8} />
                <span className="ai-response-copy-menu-label">
                  {t("chat.copyAsMarkdown", {
                    defaultValue: "Copy as Markdown",
                  })}
                </span>
              </button>
            </div>,
            document.body
          )
        : null}
      <button
        className="ai-response-action-btn"
        type="button"
        aria-label={t("chat.forkConversation", { defaultValue: "Fork" })}
        onClick={handleFork}
      >
        <GitFork size={15} strokeWidth={1.8} />
      </button>
    </div>
  );
};
