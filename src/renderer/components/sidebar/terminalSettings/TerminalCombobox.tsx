import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, FolderOpen, Loader2 } from "lucide-react";
import type { DetectedTerminalOption } from "./types";

type TerminalComboboxProps = {
  value: string;
  placeholder: string;
  disabled: boolean;
  isSelectingExecutable: boolean;
  detectedTerminals: DetectedTerminalOption[];
  browseLabel: string;
  emptyText: string;
  /** 用户在输入框中键入时触发（仅更新表单，不保存）。 */
  onChange: (value: string) => void;
  /** 用户从下拉列表选中一项时触发（携带最终值，父组件应立即保存）。 */
  onCommit: (value: string) => void;
  /** 输入框真正失焦（焦点未移入本组件下拉区域）时触发。 */
  onBlur: () => void;
  onBrowse: () => void;
};

export function TerminalCombobox({
  value,
  placeholder,
  disabled,
  isSelectingExecutable,
  detectedTerminals,
  browseLabel,
  emptyText,
  onChange,
  onCommit,
  onBlur,
  onBrowse,
}: TerminalComboboxProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [value, detectedTerminals]);

  const filteredTerminals = detectedTerminals.filter((terminal) => {
    const keyword = value.trim().toLowerCase();
    if (!keyword) {
      return true;
    }
    return (
      terminal.name.toLowerCase().includes(keyword) ||
      terminal.path.toLowerCase().includes(keyword)
    );
  });

  const openDropdown = () => {
    if (!disabled) {
      setIsOpen(true);
    }
  };

  const handleSelect = (path: string) => {
    onChange(path);
    onCommit(path);
    setIsOpen(false);
  };

  // 焦点移入本组件的下拉区域（选项 / 浏览按钮）不算真正失焦，不触发保存；
  // 选中选项后由 onCommit 携带新值立即保存。
  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (next && rootRef.current?.contains(next)) {
      return;
    }
    onBlur();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      openDropdown();
      setHighlightedIndex((index) =>
        Math.min(index + 1, Math.max(filteredTerminals.length - 1, 0))
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (event.key === "Enter" && isOpen && filteredTerminals[highlightedIndex]) {
      event.preventDefault();
      handleSelect(filteredTerminals[highlightedIndex].path);
    }
  };

  return (
    <div className="api-settings-field terminal-combobox-field">
      <div className="terminal-combobox" ref={rootRef}>
        <div className="terminal-combobox-input-wrap">
          <input
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              openDropdown();
            }}
            onFocus={openDropdown}
            onClick={openDropdown}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={placeholder}
            disabled={disabled}
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
          />
          <span
            className="terminal-combobox-toggle"
            onClick={openDropdown}
            aria-hidden="true"
          >
            <ChevronDown size={14} />
          </span>
        </div>

        {isOpen && !disabled && (
          <div className="terminal-combobox-menu" role="listbox">
            {filteredTerminals.length > 0 ? (
              <div className="terminal-combobox-list">
                {filteredTerminals.map((terminal, index) => {
                  const isSelected = terminal.path === value;
                  const isHighlighted = index === highlightedIndex;

                  return (
                    <button
                      key={terminal.path}
                      type="button"
                      className={`terminal-combobox-option ${
                        isSelected ? "selected" : ""
                      } ${isHighlighted ? "highlighted" : ""}`}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() => handleSelect(terminal.path)}
                      role="option"
                      aria-selected={isSelected}
                      title={terminal.path}
                    >
                      <span className="terminal-combobox-option-info">
                        <span className="terminal-combobox-option-name">
                          {terminal.name}
                        </span>
                        <span className="terminal-combobox-option-path">
                          {terminal.path}
                        </span>
                      </span>
                      {isSelected && <Check size={14} />}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="terminal-combobox-empty">{emptyText}</div>
            )}

            <button
              type="button"
              className="terminal-combobox-browse"
              onClick={() => {
                setIsOpen(false);
                onBrowse();
              }}
              disabled={disabled}
            >
              {isSelectingExecutable ? (
                <Loader2 size={14} className="terminal-combobox-spin" />
              ) : (
                <FolderOpen size={14} strokeWidth={1.9} />
              )}
              <span>{browseLabel}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
