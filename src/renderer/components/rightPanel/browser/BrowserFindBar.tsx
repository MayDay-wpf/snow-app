import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

export type BrowserFindResult = {
  activeMatchOrdinal: number;
  matches: number;
};

export type BrowserFindBarProps = {
  value: string;
  result: BrowserFindResult | null;
  onSearch: (text: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
};

const formatMatchCount = (
  value: string,
  result: BrowserFindResult | null
): string => {
  if (!value || !result) {
    return "";
  }
  if (result.matches === 0) {
    return "0/0";
  }
  return `${result.activeMatchOrdinal}/${result.matches}`;
};

/**
 * Find-in-page bar overlaid on the browser content area. Autofocuses on mount,
 * forwards input changes to `onSearch` (which drives `webview.findInPage`),
 * and supports Enter / Shift+Enter to jump between matches and Escape to close.
 *
 * Rendered inside `.browser-content` (position: relative), so no portal is
 * needed — it stays within bounds and is never clipped.
 */
export const BrowserFindBar = ({
  value,
  result,
  onSearch,
  onNext,
  onPrev,
  onClose,
}: BrowserFindBarProps): React.JSX.Element => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
    }
  };

  const matchCount = formatMatchCount(value, result);
  const hasNoMatches = !!value && !!result && result.matches === 0;

  return (
    <div className="browser-find-bar">
      <input
        ref={inputRef}
        type="text"
        className="browser-find-input"
        value={value}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="查找"
        spellCheck={false}
      />
      <span
        className={`browser-find-count${hasNoMatches ? " is-empty" : ""}`}
      >
        {matchCount}
      </span>
      <button
        type="button"
        className="browser-find-btn"
        onClick={onPrev}
        disabled={!value}
        aria-label="上一个"
        title="上一个"
      >
        <ChevronUp size={14} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-find-btn"
        onClick={onNext}
        disabled={!value}
        aria-label="下一个"
        title="下一个"
      >
        <ChevronDown size={14} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-find-btn"
        onClick={onClose}
        aria-label="关闭查找"
        title="关闭"
      >
        <X size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
};
