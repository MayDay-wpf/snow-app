import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { useShortcutLabel } from "../../../hooks/useShortcutLabel";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import type { ThemeTypography } from "./types";
import {
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  CHAT_LINE_HEIGHT_MAX,
  CHAT_LINE_HEIGHT_MIN,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  FONT_WEIGHT_MAX,
  FONT_WEIGHT_MIN,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
} from "./themeSettingsUtils";

type ThemeTypographySectionProps = {
  typography: ThemeTypography;
  disabled?: boolean;
  onChange: (typography: ThemeTypography) => void;
};

type ThemeNumberFieldProps = {
  value: number;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  unit?: string;
  hint?: string;
  onChange: (value: number) => void;
};

const formatNumber = (value: number): string =>
  String(Math.round(value * 100) / 100);

const parseNumber = (raw: string, min: number, max: number): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
};

/**
 * 排版数值输入框：输入合法值即时预览并提交；非法值不提交，
 * 失焦 / 回车时回退显示当前生效值，聚焦期间不被外部同步打断。
 */
function ThemeNumberField({
  value,
  min,
  max,
  label,
  disabled,
  unit,
  hint,
  onChange,
}: ThemeNumberFieldProps): React.JSX.Element {
  const [text, setText] = useState(() => formatNumber(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef(text);
  const lastValueRef = useRef(value);
  textRef.current = text;

  useEffect(() => {
    if (lastValueRef.current === value) {
      return;
    }
    lastValueRef.current = value;
    const focused = document.activeElement === inputRef.current;
    // 聚焦且文本等值（如输入中的 "15."）时保留用户原始文本。
    if (focused && parseNumber(textRef.current, min, max) === value) {
      return;
    }
    setText(formatNumber(value));
  }, [value, min, max]);

  const handleChange = (raw: string): void => {
    setText(raw);
    const parsed = parseNumber(raw, min, max);
    if (parsed !== null) {
      onChange(parsed);
    }
  };

  const handleBlur = (): void => {
    const parsed = parseNumber(textRef.current, min, max);
    setText(formatNumber(parsed ?? value));
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  return (
    <div className="theme-typography-field">
      <span className="theme-typography-field-label">{label}</span>
      <div className="theme-typography-field-control">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          className="theme-typography-number-input"
          value={text}
          disabled={disabled}
          aria-label={label}
          title={`${min}–${max}`}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        />
        {unit ? <span className="theme-typography-unit">{unit}</span> : null}
        {hint ? <span className="theme-typography-hint">{hint}</span> : null}
      </div>
    </div>
  );
}

export function ThemeTypographySection({
  typography,
  disabled,
  onChange,
}: ThemeTypographySectionProps): React.JSX.Element {
  const { t } = useI18n();
  const zoomInLabel = useShortcutLabel("uiZoomIn");
  const zoomOutLabel = useShortcutLabel("uiZoomOut");
  const zoomResetLabel = useShortcutLabel("uiZoomReset");

  const uiFontSizeLabel = t("settings.themeUiFontSize", {
    defaultValue: "UI font size",
  });
  const fontWeightLabel = t("settings.themeFontWeight", {
    defaultValue: "Body font weight",
  });
  const chatFontSizeLabel = t("settings.themeChatFontSize", {
    defaultValue: "Chat font size",
  });
  const chatLineHeightLabel = t("settings.themeChatLineHeight", {
    defaultValue: "Chat line height",
  });
  const codeFontSizeLabel = t("settings.themeCodeFontSize", {
    defaultValue: "Code font size",
  });

  const update = (patch: Partial<ThemeTypography>): void => {
    onChange({ ...typography, ...patch });
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeTypographyTitle", {
            defaultValue: "Typography",
          })}
          <ApiSettingsHintIcon
            hint={`${t("settings.themeTypographyInfo", {
              defaultValue:
                "Adjust the UI font size (whole-app zoom, 13px = 100%), body font weight, and chat / code typography.",
            })} ${t("settings.themeTypographyShortcutHint", {
              defaultValue:
                "Shortcuts: {{zoomIn}} zoom in, {{zoomOut}} zoom out, {{zoomReset}} reset",
              values: {
                zoomIn: zoomInLabel,
                zoomOut: zoomOutLabel,
                zoomReset: zoomResetLabel,
              },
            })}`}
          />
        </strong>
      </div>

      <div className="theme-typography-grid">
        <ThemeNumberField
          value={typography.fontSize}
          min={UI_FONT_SIZE_MIN}
          max={UI_FONT_SIZE_MAX}
          label={uiFontSizeLabel}
          unit="px"
          hint={`${Math.round((typography.fontSize / UI_FONT_SIZE_DEFAULT) * 100)}%`}
          disabled={disabled}
          onChange={(value) => update({ fontSize: value })}
        />
        <ThemeNumberField
          value={typography.fontWeight}
          min={FONT_WEIGHT_MIN}
          max={FONT_WEIGHT_MAX}
          label={fontWeightLabel}
          disabled={disabled}
          onChange={(value) => update({ fontWeight: value })}
        />
        <ThemeNumberField
          value={typography.chatFontSize}
          min={CHAT_FONT_SIZE_MIN}
          max={CHAT_FONT_SIZE_MAX}
          label={chatFontSizeLabel}
          unit="px"
          disabled={disabled}
          onChange={(value) => update({ chatFontSize: value })}
        />
        <ThemeNumberField
          value={typography.chatLineHeight}
          min={CHAT_LINE_HEIGHT_MIN}
          max={CHAT_LINE_HEIGHT_MAX}
          label={chatLineHeightLabel}
          disabled={disabled}
          onChange={(value) => update({ chatLineHeight: value })}
        />
        <ThemeNumberField
          value={typography.codeFontSize}
          min={CODE_FONT_SIZE_MIN}
          max={CODE_FONT_SIZE_MAX}
          label={codeFontSizeLabel}
          unit="px"
          disabled={disabled}
          onChange={(value) => update({ codeFontSize: value })}
        />
      </div>
    </div>
  );
}
