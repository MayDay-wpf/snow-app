import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { RangeSlider } from "../../common/RangeSlider";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import type { ThemeRadius } from "./types";
import {
  applyRadiusToDocument,
  RADIUS_SIZE_MAX,
  RADIUS_SIZE_MIN,
} from "./themeSettingsUtils";

type ThemeRadiusSectionProps = {
  radius: ThemeRadius;
  disabled?: boolean;
  onChange: (radius: ThemeRadius) => void;
};

/**
 * 全局圆角设置。
 *
 * 拖动期间直接写根节点的圆角变量做即时预览，松开后才回填表单：
 * 与背景滑块一致，避免连续拖动反复触发整表预览 effect（颜色变量 + IPC）。
 */
export function ThemeRadiusSection({
  radius,
  disabled,
  onChange,
}: ThemeRadiusSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const [localSize, setLocalSize] = useState(radius.size);
  // ref 保存最新拖动值，供松手回调构造提交值，避免闭包捕获旧值。
  const localSizeRef = useRef(localSize);
  localSizeRef.current = localSize;

  // 表单值变化（切换预设、重置主题、外部同步）时同步本地滑块。
  useEffect(() => {
    setLocalSize(radius.size);
    localSizeRef.current = radius.size;
  }, [radius.size]);

  const handleInput = (value: number): void => {
    setLocalSize(value);
    localSizeRef.current = value;
    // 拖动即预览覆盖效果；关闭状态下也先按启用渲染，松手后自动启用。
    applyRadiusToDocument({ enabled: true, size: value });
  };

  const handleCommit = (): void => {
    const size = localSizeRef.current;
    if (radius.enabled && radius.size === size) {
      return;
    }
    onChange({ enabled: true, size });
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeRadiusTitle", { defaultValue: "Corner radius" })}
          <ApiSettingsHintIcon
            hint={t("settings.themeRadiusInfo", {
              defaultValue:
                "Adjust the global corner radius. When enabled it overrides the radius bundled with the current theme preset and applies to every card, button and input.",
            })}
          />
        </strong>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={radius.enabled}
            onChange={(event) =>
              onChange({ ...radius, enabled: event.target.checked })
            }
            disabled={disabled}
            hidden
          />
          <span className="toggle-slider" />
          <span>
            {radius.enabled
              ? t("settings.enabled", { defaultValue: "Enabled" })
              : t("settings.disabled", { defaultValue: "Disabled" })}
          </span>
        </label>
      </div>
      <RangeSlider
        label={t("settings.themeRadiusSize", { defaultValue: "Radius" })}
        formatValue={(value) => `${Math.round(value)}px`}
        value={localSize}
        min={RADIUS_SIZE_MIN}
        max={RADIUS_SIZE_MAX}
        step={1}
        disabled={disabled}
        onChange={handleInput}
        onCommit={handleCommit}
      />
      <span className="settings-item-description">
        {radius.enabled
          ? t("settings.themeRadiusEnabledInfo", {
              defaultValue:
                "Global radius is on. Dragging the slider updates the UI instantly.",
            })
          : t("settings.themeRadiusDisabledInfo", {
              defaultValue:
                "Disabled: the current theme preset's own radius is used. Dragging the slider enables it automatically.",
            })}
      </span>
    </div>
  );
}
