import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export type TokenPreset = {
  value: string;
  label: string;
};

type TokenPresetInputProps = {
  value: string;
  presets: TokenPreset[];
  placeholder?: string;
  disabled?: boolean;
  noMatchText?: string;
  onChange: (value: string) => void;
};

/** 将 "128000" 格式化为 "128,000" 便于阅读;非数字内容原样返回。 */
function formatTokenCount(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return raw;
  return Number(digits).toLocaleString("en-US");
}

/**
 * 可自由输入、支持预设快捷选择的 token 数值输入框。
 * 视觉沿用 api-model-combobox 的下拉语言(输入框 + 箭头 + 浮层列表),
 * 替代浏览器原生 <datalist> 以获得与主题一致的样式。
 *
 * 交互:聚焦时不弹出列表;输入时按相似值(数字包含 / 标签包含)过滤提示;
 * 点击右侧箭头或按方向键可展开完整预设列表。
 */
export function TokenPresetInput({
  value,
  presets,
  placeholder,
  disabled = false,
  noMatchText = "No matching presets",
  onChange,
}: TokenPresetInputProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // true = 箭头/方向键展开显示全部预设;false = 按当前输入过滤提示
  const [showAll, setShowAll] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // 当前值命中的预设项,用于展开全部时高亮与复选标记
  const selectedIndex = presets.findIndex((preset) => preset.value === value);

  // 输入时按相似值过滤(数字包含 / 标签包含,大小写不敏感);
  // 展开全部时显示完整列表。
  const visiblePresets = useMemo(() => {
    if (showAll) return presets;
    const keyword = value.trim().toLowerCase();
    if (!keyword) return presets;
    return presets.filter(
      (preset) =>
        preset.value.toLowerCase().includes(keyword) ||
        preset.label.toLowerCase().includes(keyword)
    );
  }, [presets, value, showAll]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  const openAll = (): void => {
    if (disabled) return;
    setShowAll(true);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };

  const handleInputChange = (nextValue: string): void => {
    onChange(nextValue);
    if (nextValue.trim() === "") {
      setIsOpen(false);
      return;
    }
    setShowAll(false);
    setHighlightedIndex(0);
    setIsOpen(true);
  };

  const handleSelectPreset = (preset: TokenPreset): void => {
    onChange(preset.value);
    setIsOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!isOpen) {
        openAll();
        return;
      }
      setHighlightedIndex((index) =>
        Math.min(index + 1, Math.max(visiblePresets.length - 1, 0))
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        openAll();
        return;
      }
      setHighlightedIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && isOpen && visiblePresets[highlightedIndex]) {
      event.preventDefault();
      handleSelectPreset(visiblePresets[highlightedIndex]);
    }
  };

  // 过滤结果变化时防止高亮越界
  const clampedHighlightedIndex = Math.min(
    highlightedIndex,
    Math.max(visiblePresets.length - 1, 0)
  );

  return (
    <div className="api-token-preset-input" ref={rootRef}>
      <div className="api-token-preset-input-wrap">
        <input
          value={value}
          onChange={(event) => handleInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          type="number"
          min={0}
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
        />
        <button
          type="button"
          className="api-token-preset-arrow"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => {
            if (isOpen) {
              setIsOpen(false);
            } else {
              openAll();
            }
          }}
          aria-label="Toggle token presets"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {isOpen && !disabled && (
        <div className="api-model-combobox-menu" role="listbox">
          {visiblePresets.length > 0 ? (
            <div className="api-model-combobox-list">
              {visiblePresets.map((preset, index) => {
                const isSelected = preset.value === value;
                const isHighlighted = index === clampedHighlightedIndex;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    className={`api-model-combobox-option ${
                      isSelected ? "selected" : ""
                    } ${isHighlighted ? "highlighted" : ""}`}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={(event) => {
                      // 阻止外层 <label> 把点击转发给输入框(会重新聚焦)
                      event.preventDefault();
                      handleSelectPreset(preset);
                    }}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <span className="api-token-preset-option-main">
                      <span className="api-token-preset-option-label">
                        {preset.label}
                      </span>
                      <span className="api-token-preset-option-value">
                        {formatTokenCount(preset.value)}
                      </span>
                    </span>
                    {isSelected && <Check size={14} />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="api-model-combobox-message">{noMatchText}</div>
          )}
        </div>
      )}
    </div>
  );
}
