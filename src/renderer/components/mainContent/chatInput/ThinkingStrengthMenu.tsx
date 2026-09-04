import { useEffect, useState } from "react";
import { Check, ChevronLeft, Keyboard, Sparkles } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { ThinkingOption } from "./types";

type ThinkingStrengthMenuProps = {
  /** 菜单是否打开：关闭时自动退出自定义输入模式 */
  open: boolean;
  /** 当前选中的思考强度值；"" 表示继承 Profile（仅当提供 inheritLabel 时） */
  value: string;
  /** 当前请求方法对应的选项列表（THINKING_OPTIONS_BY_METHOD[requestMethod]） */
  options: ThinkingOption[];
  /** 渲染在选项列表顶部的"继承/默认"项文案（如"默认（Max）"）；不传则隐藏 */
  inheritLabel?: string | null;
  /** 菜单标题，默认"思考强度" */
  title?: string;
  /** 头部右侧小字（如请求方法），可选 */
  subtitle?: string;
  /** 是否显示返回按钮（聊天模型菜单的子视图场景） */
  showBack?: boolean;
  onBack?: () => void;
  /** 选中某值："" = 继承 Profile，或任意自定义字符串 */
  onSelect: (value: string) => void;
  /** 保存中：禁用自定义值确认按钮 */
  saving?: boolean;
};

/**
 * 思考强度选择菜单（带图标选项 + 自定义值输入）。
 * 由聊天输入区的模型菜单（子视图）与定时任务"运行配置"表单共用：
 * - 聊天：showBack 返回模型菜单 root，选择后写入当前会话 runtime override；
 *   保存由调用方负责；
 * - 运行配置：可传 inheritLabel 渲染"默认（继承 Profile）"项，"" 即继承语义。
 */
export function ThinkingStrengthMenu({
  open,
  value,
  options,
  inheritLabel,
  title,
  subtitle,
  showBack = false,
  onBack,
  onSelect,
  saving = false,
}: ThinkingStrengthMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");

  // 菜单关闭时退出自定义思考强度输入
  useEffect(() => {
    if (!open) {
      setIsCustomMode(false);
    }
  }, [open]);

  // 当前值不在预设选项中（且非继承空值）→ 视为自定义值
  const isCustomValue = value !== "" && !options.some((option) => option.value === value);

  const handleOpenCustom = (): void => {
    setCustomValue(isCustomValue ? value : "");
    setIsCustomMode(true);
  };

  const handleConfirmCustom = (): void => {
    const nextValue = customValue.trim();
    if (!nextValue || saving) {
      return;
    }
    onSelect(nextValue);
    setIsCustomMode(false);
  };

  const handleSelect = (
    event: React.MouseEvent<HTMLButtonElement>,
    nextValue: string
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(nextValue);
  };

  const handleCustomKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      handleConfirmCustom();
    } else if (event.key === "Escape") {
      setIsCustomMode(false);
    }
  };

  if (isCustomMode) {
    return (
      <>
        <div className="model-menu-header">
          {showBack && (
            <button
              aria-label={t("common.back")}
              className="model-menu-back"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onBack?.();
              }}
              type="button"
            >
              <ChevronLeft size={14} />
            </button>
          )}
          <span>{t("chat.customThinkingStrength")}</span>
        </div>
        <div className="model-manual-input thinking-custom-input">
          <input
            autoFocus
            value={customValue}
            onChange={(event) => setCustomValue(event.target.value)}
            onKeyDown={handleCustomKeyDown}
            placeholder={t("chat.customThinkingPlaceholder")}
            className="model-manual-field thinking-custom-field"
            maxLength={64}
          />
          <div className="model-manual-actions thinking-custom-actions">
            <button
              className="model-manual-btn thinking-custom-btn secondary"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsCustomMode(false);
              }}
              type="button"
            >
              {t("common.cancel")}
            </button>
            <button
              className="model-manual-btn thinking-custom-btn primary"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleConfirmCustom();
              }}
              disabled={!customValue.trim() || saving}
              type="button"
            >
              {t("common.confirm")}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="model-menu-header">
        {showBack && (
          <button
            aria-label={t("common.back")}
            className="model-menu-back"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onBack?.();
            }}
            type="button"
          >
            <ChevronLeft size={14} />
          </button>
        )}
        <span>{title ?? t("chat.thinkingStrength")}</span>
        {subtitle && <small>{subtitle}</small>}
      </div>
      <div className="model-dropdown-list">
        {inheritLabel && (
          <button
            className={`model-dropdown-item ${value === "" ? "active" : ""}`}
            onClick={(event) => handleSelect(event, "")}
            type="button"
          >
            <span className="model-dropdown-item-name with-icon">
              <Sparkles size={14} className="thinking-option-icon" />
              <span>{inheritLabel}</span>
            </span>
            {value === "" && <Check size={14} className="model-dropdown-check" />}
          </button>
        )}
        {options.map((option) => {
          const ThinkingOptionIcon = option.icon;

          return (
            <button
              key={option.value}
              className={`model-dropdown-item ${
                value === option.value ? "active" : ""
              }`}
              onClick={(event) => handleSelect(event, option.value)}
              type="button"
            >
              <span className="model-dropdown-item-name with-icon">
                <ThinkingOptionIcon
                  size={14}
                  className="thinking-option-icon"
                />
                <span>{option.label}</span>
              </span>
              {value === option.value && (
                <Check size={14} className="model-dropdown-check" />
              )}
            </button>
          );
        })}
      </div>
      <div className="model-dropdown-footer">
        <button
          className={`model-dropdown-action ${isCustomValue ? "active" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleOpenCustom();
          }}
          type="button"
        >
          <Keyboard size={14} />
          <span>{t("chat.customThinking")}</span>
          {isCustomValue && <Check size={14} className="model-dropdown-check" />}
        </button>
      </div>
    </>
  );
}
