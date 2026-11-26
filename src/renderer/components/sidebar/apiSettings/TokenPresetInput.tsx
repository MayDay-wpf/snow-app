import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { useI18n } from "../../../i18n";

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
  /** 当前取值是否跟随模型：为 true 时菜单里的「跟随模型」档位展示为已选中。 */
  followModel?: boolean;
  /** 传 "follow" 表示用户选了跟随档位，传 "manual" 表示用户填了具体数字。 */
  onFollowModelChange?: (mode: "follow" | "manual") => void;
  /** 「跟随模型」档位文案；与 onFollowModelChange 同时提供时才显示该档位。 */
  followModelLabel?: string;
  /** 跟随档位的补充说明（右侧小字）。 */
  followModelHint?: string;
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
  followModel = false,
  onFollowModelChange,
  followModelLabel,
  followModelHint,
  onChange,
}: TokenPresetInputProps): React.JSX.Element {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // true = 箭头/方向键展开显示全部预设;false = 按当前输入过滤提示
  const [showAll, setShowAll] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // 「跟随模型」档位只在调用方提供回调与文案时出现，作为列表首项参与键盘导航。
  const showFollowOption = Boolean(onFollowModelChange && followModelLabel);
  const followLabel = followModelLabel ?? "";

  // 跟随态下在数值右侧补一句说明：输入框里仍是自动填入的真实数字，
  // 若不加标注，用户会以为菜单里的「跟随模型」勾选与数字互相矛盾。
  const showFollowBadge =
    followModel && Boolean(followLabel) && value.trim() !== "";

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
        preset.label.toLowerCase().includes(keyword),
    );
  }, [presets, value, showAll]);

  // 「跟随模型」档位同样按关键字过滤，避免用户输入数字时它仍占着首项位置。
  // 已选中跟随态时始终保留该项，否则输入框里的旧数值会把它过滤掉。
  const isFollowVisible = useMemo(() => {
    if (!showFollowOption) return false;
    if (followModel || showAll) return true;
    const keyword = value.trim().toLowerCase();
    return !keyword || followLabel.toLowerCase().includes(keyword);
  }, [followLabel, followModel, showAll, showFollowOption, value]);

  // 键盘导航用的统一行列表：首项可能是「跟随模型」，其余是数值预设。
  const rows = useMemo<
    Array<{ key: string; preset: TokenPreset | null }>
  >(() => {
    const items: Array<{ key: string; preset: TokenPreset | null }> = [];
    if (isFollowVisible) {
      items.push({ key: "__follow-model__", preset: null });
    }
    for (const preset of visiblePresets) {
      items.push({ key: preset.value, preset });
    }
    return items;
  }, [isFollowVisible, visiblePresets]);

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
    // 跟随态下默认高亮「跟随模型」，否则高亮当前数值命中的预设；
    // 首个额度被「跟随模型」占据时索引整体后移一位。
    if (showFollowOption && followModel) {
      setHighlightedIndex(0);
    } else {
      const presetOffset = showFollowOption ? 1 : 0;
      setHighlightedIndex(
        selectedIndex >= 0 ? selectedIndex + presetOffset : 0,
      );
    }
    setIsOpen(true);
  };

  const handleInputChange = (nextValue: string): void => {
    onChange(nextValue);
    // 手动改过输入框（含清空）即视为固定取值，不再跟随模型变化
    if (followModel) {
      onFollowModelChange?.("manual");
    }
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
    if (followModel) {
      onFollowModelChange?.("manual");
    }
    setIsOpen(false);
  };

  const handleSelectFollowModel = (): void => {
    onFollowModelChange?.("follow");
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
        Math.min(index + 1, Math.max(rows.length - 1, 0)),
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
    if (event.key === "Enter" && isOpen && rows[highlightedIndex]) {
      const row = rows[highlightedIndex];
      event.preventDefault();
      if (row.preset) {
        handleSelectPreset(row.preset);
      } else {
        handleSelectFollowModel();
      }
    }
  };

  // 过滤结果变化时防止高亮越界
  const clampedHighlightedIndex = Math.min(
    highlightedIndex,
    Math.max(rows.length - 1, 0),
  );

  return (
    <div
      className={`api-token-preset-input${showFollowBadge ? " has-follow" : ""}`}
      ref={rootRef}
    >
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
        {showFollowBadge && (
          <span className="api-token-preset-follow-hint" aria-hidden="true">
            {followLabel}
          </span>
        )}
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
          aria-label={t("settings.tokenPresetToggle", {
            defaultValue: "Toggle token presets",
          })}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {isOpen && !disabled && (
        <div className="api-model-combobox-menu" role="listbox">
          {rows.length > 0 ? (
            <div className="api-model-combobox-list">
              {rows.map((row, index) => {
                if (!row.preset) {
                  const isHighlighted = index === clampedHighlightedIndex;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      className={`api-model-combobox-option ${
                        followModel ? "selected" : ""
                      } ${isHighlighted ? "highlighted" : ""}`}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={(event) => {
                        event.preventDefault();
                        handleSelectFollowModel();
                      }}
                      role="option"
                      aria-selected={followModel}
                    >
                      <span className="api-token-preset-option-main">
                        <span className="api-token-preset-option-label">
                          {followLabel}
                        </span>
                        {followModelHint && (
                          <span className="api-token-preset-option-hint">
                            {followModelHint}
                          </span>
                        )}
                      </span>
                      {followModel && <Check size={14} />}
                    </button>
                  );
                }
                const preset = row.preset;
                const isSelected = preset.value === value;
                const isHighlighted = index === clampedHighlightedIndex;
                return (
                  <button
                    key={row.key}
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
