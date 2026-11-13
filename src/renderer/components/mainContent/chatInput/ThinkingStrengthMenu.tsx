import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Keyboard, Sparkles } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { ThinkingOption } from "./types";
import { getThinkingTint } from "./thinkingIcons";

// 与 CSS 中 --thinking-knob 保持一致
const KNOB_SIZE = 18;

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
};

/**
 * 思考强度选择菜单（拖拽进度条 + 自定义值输入）。
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
}: ThinkingStrengthMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const sliderRef = useRef<HTMLDivElement>(null);
  // 拖拽中的预览档位；ref 同步记录，松手时不依赖闭包
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  // 菜单关闭时退出自定义思考强度输入
  useEffect(() => {
    if (!open) {
      setIsCustomMode(false);
    }
  }, [open]);

  // 当前值不在预设选项中（且非继承空值）→ 视为自定义值
  const isCustomValue =
    value !== "" && !options.some((option) => option.value === value);

  const handleOpenCustom = (): void => {
    setCustomValue(isCustomValue ? value : "");
    setIsCustomMode(true);
  };

  const handleConfirmCustom = (): void => {
    const nextValue = customValue.trim();
    if (!nextValue) {
      return;
    }
    onSelect(nextValue);
    setIsCustomMode(false);
  };

  const handleSelect = (
    event: React.MouseEvent<HTMLButtonElement>,
    nextValue: string,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(nextValue);
  };

  const handleCustomKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      handleConfirmCustom();
    } else if (event.key === "Escape") {
      // 退出自定义输入即消费掉 ESC，避免继续冒泡到外层弹窗。
      event.stopPropagation();
      setIsCustomMode(false);
    }
  };

  const selectedIndex = options.findIndex((option) => option.value === value);
  const displayIndex = dragIndex ?? selectedIndex;
  const maxIndex = options.length - 1;
  const positionOf = (index: number): number =>
    maxIndex > 0 ? index / maxIndex : 0;
  const progress = displayIndex >= 0 ? positionOf(displayIndex) : 0;

  // 指针位置换算档位（两端各留出滑块半径）
  const indexFromClientX = (clientX: number): number => {
    const rect = sliderRef.current?.getBoundingClientRect();
    if (!rect || maxIndex <= 0) {
      return 0;
    }
    const usable = rect.width - KNOB_SIZE;
    const ratio = Math.min(
      Math.max((clientX - rect.left - KNOB_SIZE / 2) / usable, 0),
      1,
    );
    return Math.round(ratio * maxIndex);
  };

  const commitIndex = (index: number): void => {
    const option = options[index];
    if (option && option.value !== value) {
      onSelect(option.value);
    }
  };

  const updateDrag = (index: number): void => {
    if (dragIndexRef.current !== index) {
      dragIndexRef.current = index;
      setDragIndex(index);
    }
  };

  const endDrag = (
    event: React.PointerEvent<HTMLDivElement>,
  ): number | null => {
    const index = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragIndex(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return index;
  };

  const handlePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (options.length === 0 || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    dragIndexRef.current = null;
    updateDrag(indexFromClientX(event.clientX));
  };

  const handlePointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (dragIndexRef.current === null) {
      return;
    }
    updateDrag(indexFromClientX(event.clientX));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragIndexRef.current === null) {
      return;
    }
    const index = endDrag(event);
    if (index !== null) {
      commitIndex(index);
    }
  };

  const handlePointerCancel = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    endDrag(event);
  };

  const handleSliderKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (options.length === 0) {
      return;
    }
    const base = Math.max(selectedIndex, 0);
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = Math.max(base - 1, 0);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = selectedIndex < 0 ? 0 : Math.min(base + 1, maxIndex);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = maxIndex;
    }
    if (next === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    commitIndex(next);
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
              disabled={!customValue.trim()}
              type="button"
            >
              {t("common.confirm")}
            </button>
          </div>
        </div>
      </>
    );
  }

  const ActiveIcon =
    displayIndex >= 0
      ? options[displayIndex].icon
      : isCustomValue
        ? Keyboard
        : Sparkles;
  const activeLabel =
    displayIndex >= 0
      ? options[displayIndex].label
      : isCustomValue
        ? value
        : (inheritLabel ?? "");
  const isTopLevel = displayIndex >= 0 && displayIndex === options.length - 1;
  const activeTint =
    displayIndex >= 0
      ? getThinkingTint(options, options[displayIndex].value)
      : null;
  const sliderStyle = {
    "--thinking-p": progress,
  } as React.CSSProperties;

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
      {inheritLabel && (
        <div className="model-dropdown-list thinking-slider-inherit">
          <button
            className={`model-dropdown-item ${value === "" ? "active" : ""}`}
            onClick={(event) => handleSelect(event, "")}
            type="button"
          >
            <span className="model-dropdown-item-name with-icon">
              <Sparkles size={14} className="thinking-option-icon" />
              <span>{inheritLabel}</span>
            </span>
            {value === "" && (
              <Check size={14} className="model-dropdown-check" />
            )}
          </button>
        </div>
      )}
      <div className="thinking-slider-panel">
        <div
          className={`thinking-slider-summary ${isTopLevel ? "is-top" : ""}`}
        >
          <ActiveIcon
            size={18}
            className="thinking-slider-summary-icon"
            style={activeTint ? { color: activeTint } : undefined}
          />
          <span className="thinking-slider-summary-label">{activeLabel}</span>
        </div>
        <div
          ref={sliderRef}
          aria-label={title ?? t("chat.thinkingStrength")}
          aria-valuemax={Math.max(options.length - 1, 0)}
          aria-valuemin={0}
          aria-valuenow={Math.max(displayIndex, 0)}
          aria-valuetext={activeLabel}
          className={`thinking-slider ${
            dragIndex !== null ? "is-dragging" : ""
          } ${displayIndex >= 0 ? "has-value" : ""}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleSliderKeyDown}
          onPointerCancel={handlePointerCancel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          role="slider"
          style={sliderStyle}
          tabIndex={0}
        >
          <div className="thinking-slider-track" />
          <div className="thinking-slider-glow">
            <div className="thinking-slider-fill" />
          </div>
          <div className="thinking-slider-fill">
            <span className="thinking-slider-shine" />
          </div>
          {options.map((option, index) => (
            <span
              key={option.value}
              className={`thinking-slider-tick ${
                displayIndex >= 0 && index <= displayIndex ? "is-on" : ""
              }`}
              style={
                {
                  "--thinking-tick": positionOf(index),
                } as React.CSSProperties
              }
            />
          ))}
          <span className="thinking-slider-knob" />
        </div>
        <div className="thinking-slider-scale">
          {options.map((option, index) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.value}
                aria-label={option.label}
                className={`thinking-slider-step ${
                  index === displayIndex ? "active" : ""
                }`}
                onClick={(event) => handleSelect(event, option.value)}
                style={
                  {
                    "--thinking-tick": positionOf(index),
                    ...(index === displayIndex && activeTint
                      ? { color: activeTint }
                      : {}),
                  } as React.CSSProperties
                }
                title={option.label}
                type="button"
              >
                <OptionIcon size={13} />
              </button>
            );
          })}
        </div>
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
          {isCustomValue && (
            <Check size={14} className="model-dropdown-check" />
          )}
        </button>
      </div>
    </>
  );
}
