import { History, ImageIcon, PawPrint, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { PetManifest } from "../../../../preload/types/pets";
import { CustomSelect } from "../../common/CustomSelect";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import { RangeSlider } from "../../common/RangeSlider";
import { PetPreview } from "../../pet/PetPreview";
import { themeBgUrl } from "../../../utils/themeBgUrl";
import type {
  ThemeBackground,
  ThemeBackgroundSource,
  ThemeCarouselOrder,
} from "./types";
import {
  BACKGROUND_IMAGE_LIMIT,
  hasBackgroundContent,
  MAX_BACKGROUND_OPACITY,
  PET_BACKGROUND_SCALE_MAX,
  PET_BACKGROUND_SCALE_MIN,
} from "./themeSettingsUtils";

/** 轮播间隔档位（秒）：10 秒 ~ 2 小时。 */
const CAROUSEL_INTERVAL_OPTIONS = [10, 30, 60, 300, 900, 1800, 3600, 7200];

type ThemeBackgroundSectionProps = {
  background: ThemeBackground;
  /** 已安装宠物列表（宠物背景来源可选） */
  pets: PetManifest[];
  disabled?: boolean;
  busy?: boolean;
  onChange: (background: ThemeBackground) => void;
  /** 多选本地图片并加入背景列表 */
  onAddImages: () => Promise<void>;
  /** 从列表移除指定图片（不删除文件，可从「历史图片」重新加入） */
  onRemoveImage: (imagePath: string) => Promise<void>;
  /** 点击缩略图：固定该图为背景并结束轮播 */
  onPickImage: (imagePath: string) => void;
  /** 打开「历史图片」弹窗 */
  onOpenHistory: () => void;
};

const SOURCE_OPTIONS: {
  value: ThemeBackgroundSource;
  labelKey: string;
  defaultLabel: string;
  icon: typeof ImageIcon;
}[] = [
  {
    value: "image",
    labelKey: "settings.themeBackgroundSourceImage",
    defaultLabel: "Image",
    icon: ImageIcon,
  },
  {
    value: "pet",
    labelKey: "settings.themeBackgroundSourcePet",
    defaultLabel: "Pet",
    icon: PawPrint,
  },
];

export function ThemeBackgroundSection({
  background,
  pets,
  disabled,
  busy,
  onChange,
  onAddImages,
  onRemoveImage,
  onPickImage,
  onOpenHistory,
}: ThemeBackgroundSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const isBusy = disabled || busy;
  const isPetSource = background.source === "pet";
  const selectedPet = isPetSource
    ? (pets.find((pet) => pet.id === background.petId) ?? null)
    : null;

  /** 轮播仅在「背景已开启」且图片数量 >= 2 时可用（关闭背景时禁用轮播控件）。 */
  const isCarouselReady =
    background.enabled && background.imagePaths.length >= 2;
  // 当前间隔不在预设档位时（如手改配置数据），补充进选项列表以便正常展示。
  const intervalOptions = CAROUSEL_INTERVAL_OPTIONS.includes(
    background.carouselIntervalSecs,
  )
    ? CAROUSEL_INTERVAL_OPTIONS
    : [...CAROUSEL_INTERVAL_OPTIONS, background.carouselIntervalSecs].sort(
        (a, b) => a - b,
      );

  const formatIntervalLabel = (secs: number): string => {
    if (secs < 60) {
      return t("settings.themeBackgroundIntervalSeconds", {
        defaultValue: "{{count}} sec",
        values: { count: secs },
      });
    }
    if (secs < 3600) {
      return t("settings.themeBackgroundIntervalMinutes", {
        defaultValue: "{{count}} min",
        values: { count: secs / 60 },
      });
    }
    return t("settings.themeBackgroundIntervalHours", {
      defaultValue: "{{count}} h",
      values: { count: secs / 3600 },
    });
  };

  // 本地 state 用于滑块拖动期间的即时 UI 响应，拖动期间不触发父组件
  // setForm，避免预览 useEffect 全量重绘 + IPC 调用导致卡涩。
  // 仅在松开鼠标（onPointerUp）或松开按键（onKeyUp）时提交一次到父组件。
  const [localOpacity, setLocalOpacity] = useState(background.opacity);
  const [localBlur, setLocalBlur] = useState(background.blur);
  const [localPetScale, setLocalPetScale] = useState(background.petScale);

  // ref 保存最新的 background 与本地滑块值，供 pointerup/keyup 回调构造提交值，
  // 避免闭包捕获旧值。range input 拖动时浏览器会自动 capture pointer 到该元素，
  // 因此即使鼠标移到 input 外松开，onPointerUp 仍会在该 input 上触发。
  const backgroundRef = useRef(background);
  const localOpacityRef = useRef(localOpacity);
  const localBlurRef = useRef(localBlur);
  const localPetScaleRef = useRef(localPetScale);
  backgroundRef.current = background;

  // 父组件 background 变化（如切换预设、删除图片、首次上传）时同步本地 state。
  useEffect(() => {
    setLocalOpacity(background.opacity);
    localOpacityRef.current = background.opacity;
  }, [background.opacity]);
  useEffect(() => {
    setLocalBlur(background.blur);
    localBlurRef.current = background.blur;
  }, [background.blur]);
  useEffect(() => {
    setLocalPetScale(background.petScale);
    localPetScaleRef.current = background.petScale;
  }, [background.petScale]);

  const updateField = <K extends keyof ThemeBackground>(
    field: K,
    value: ThemeBackground[K],
  ): void => {
    onChange({ ...background, [field]: value });
  };

  // 松开鼠标/按键时提交：同时带上所有滑块的最新本地值，避免连续拖动不同滑块时
  // 因 backgroundRef 尚未更新而把另一个滑块覆盖回旧值。
  const commitSliders = (): void => {
    onChange({
      ...backgroundRef.current,
      opacity: localOpacityRef.current,
      blur: localBlurRef.current,
      petScale: localPetScaleRef.current,
    });
  };

  // 拖动期间直接更新对应 CSS 变量实现渐进预览，不走父组件 setForm → 预览 useEffect
  // 的完整链路（重绘整个 palette 几十个 CSS 变量 + IPC 调用），避免卡顿。
  // 松开时 commitSliders 提交到父组件，由其预览 useEffect 统一收尾。
  const isBackgroundActive = (): boolean =>
    document.documentElement.getAttribute("data-theme-bg") === "on";

  const previewOpacity = (value: number): void => {
    if (isBackgroundActive()) {
      document.documentElement.style.setProperty(
        "--theme-bg-opacity",
        String(value),
      );
    }
  };

  const previewBlur = (value: number): void => {
    if (isBackgroundActive()) {
      document.documentElement.style.setProperty(
        "--theme-bg-blur",
        `${value}px`,
      );
    }
  };

  const previewPetScale = (value: number): void => {
    if (isBackgroundActive()) {
      document.documentElement.style.setProperty(
        "--theme-pet-scale",
        String(value),
      );
    }
  };

  const handleOpacityInput = (value: number): void => {
    setLocalOpacity(value);
    localOpacityRef.current = value;
    previewOpacity(value);
  };

  const handleBlurInput = (value: number): void => {
    setLocalBlur(value);
    localBlurRef.current = value;
    previewBlur(value);
  };

  const handlePetScaleInput = (value: number): void => {
    setLocalPetScale(value);
    localPetScaleRef.current = value;
    previewPetScale(value);
  };

  const handleSourceChange = (source: ThemeBackgroundSource): void => {
    if (source === background.source) {
      return;
    }
    // 切换来源时按新来源的素材可用性决定是否启用。
    onChange({
      ...background,
      source,
      enabled:
        source === "pet"
          ? Boolean(background.petId)
          : background.imagePaths.length > 0,
    });
  };

  const handlePetChange = (petId: string): void => {
    onChange({ ...background, petId, enabled: Boolean(petId) });
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeBackgroundTitle", {
            defaultValue: "Background",
          })}
          <ApiSettingsHintIcon
            hint={t("settings.themeBackgroundInfo", {
              defaultValue:
                "Use a custom image or a desktop pet animation as the background, then adjust its opacity and blur.",
            })}
          />
        </strong>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={background.enabled}
            onChange={(event) => updateField("enabled", event.target.checked)}
            disabled={isBusy || !hasBackgroundContent(background)}
            hidden
          />
          <span className="toggle-slider" />
          <span>
            {background.enabled
              ? t("settings.enabled", { defaultValue: "Enabled" })
              : t("settings.disabled", { defaultValue: "Disabled" })}
          </span>
        </label>
      </div>

      <div className="theme-background-source" role="radiogroup">
        {SOURCE_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isActive = background.source === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              className={`theme-background-source-option ${isActive ? "active" : ""}`}
              onClick={() => handleSourceChange(option.value)}
              disabled={isBusy}
            >
              <Icon size={14} strokeWidth={1.9} />
              <span>
                {t(option.labelKey, { defaultValue: option.defaultLabel })}
              </span>
            </button>
          );
        })}
      </div>

      {isPetSource ? (
        <div className="api-settings-form-grid">
          <div className="theme-background-preview">
            {selectedPet ? (
              <PetPreview
                spritesheetPath={selectedPet.spritesheetPath}
                size={56}
              />
            ) : (
              <span className="theme-background-placeholder">
                <PawPrint size={24} strokeWidth={1.6} />
              </span>
            )}
          </div>
          <div className="theme-background-actions">
            <CustomSelect
              value={background.petId}
              onChange={handlePetChange}
              disabled={isBusy || pets.length === 0}
              title={t("settings.themeBackgroundPetSelect", {
                defaultValue: "Select pet",
              })}
              options={pets.map((pet) => ({
                value: pet.id,
                label: pet.displayName,
              }))}
            />
            <span className="settings-item-description">
              {pets.length === 0
                ? t("settings.themeBackgroundPetEmpty", {
                    defaultValue:
                      "No pets installed yet. Install one in Settings > Desktop pet first.",
                  })
                : t("settings.themeBackgroundPetInfo", {
                    defaultValue:
                      "The selected pet's idle animation loops as the background.",
                  })}
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="theme-background-grid">
            {background.imagePaths.length === 0 ? (
              <span className="theme-background-placeholder">
                <ImageIcon size={24} strokeWidth={1.6} />
              </span>
            ) : (
              background.imagePaths.map((imagePath) => (
                <div key={imagePath} className="theme-background-thumb">
                  <button
                    type="button"
                    className="theme-background-thumb-select"
                    onClick={() => onPickImage(imagePath)}
                    disabled={isBusy}
                  >
                    <img
                      src={themeBgUrl(imagePath)}
                      alt=""
                      className="theme-background-thumbnail"
                    />
                  </button>
                  <button
                    type="button"
                    className="theme-background-thumb-remove"
                    title={t("settings.themeBackgroundRemove", {
                      defaultValue: "Remove",
                    })}
                    onClick={() => void onRemoveImage(imagePath)}
                    disabled={isBusy}
                  >
                    <X size={12} strokeWidth={2.2} />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="theme-background-actions row">
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={() => void onAddImages()}
              disabled={
                isBusy || background.imagePaths.length >= BACKGROUND_IMAGE_LIMIT
              }
            >
              <ImageIcon size={15} strokeWidth={1.8} />
              <span>
                {t("settings.themeBackgroundAddImages", {
                  defaultValue: "Add images",
                })}
              </span>
            </button>
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={onOpenHistory}
              disabled={isBusy}
            >
              <History size={15} strokeWidth={1.8} />
              <span>
                {t("settings.themeBackgroundHistory", {
                  defaultValue: "Image history",
                })}
              </span>
            </button>
          </div>
          {background.imagePaths.length === 0 && (
            <span className="settings-item-description">
              {t("settings.themeBackgroundImagesEmpty", {
                defaultValue:
                  "No backgrounds yet. Use the add button to pick some.",
              })}
            </span>
          )}

          <div className="theme-background-carousel">
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={background.carouselEnabled}
                onChange={(event) =>
                  updateField("carouselEnabled", event.target.checked)
                }
                disabled={isBusy || !isCarouselReady}
                hidden
              />
              <span className="toggle-slider" />
              <span>
                {t("settings.themeBackgroundCarouselEnable", {
                  defaultValue: "Auto carousel",
                })}
              </span>
            </label>
            <span className="settings-item-description">
              {t("settings.themeBackgroundCarouselInfo", {
                defaultValue:
                  "When enabled, backgrounds switch automatically at the chosen interval (up to 30 images).",
              })}
            </span>
            <div className="theme-background-carousel-options">
              <div className="theme-background-option">
                <span className="theme-background-option-label">
                  {t("settings.themeBackgroundCarouselInterval", {
                    defaultValue: "Interval",
                  })}
                </span>
                <CustomSelect
                  value={String(background.carouselIntervalSecs)}
                  onChange={(value) =>
                    updateField("carouselIntervalSecs", Number(value))
                  }
                  disabled={isBusy || !isCarouselReady}
                  options={intervalOptions.map((secs) => ({
                    value: String(secs),
                    label: formatIntervalLabel(secs),
                  }))}
                />
              </div>
              <div className="theme-background-option">
                <span className="theme-background-option-label">
                  {t("settings.themeBackgroundCarouselOrder", {
                    defaultValue: "Playback order",
                  })}
                </span>
                <CustomSelect
                  value={background.carouselOrder}
                  onChange={(value) =>
                    updateField("carouselOrder", value as ThemeCarouselOrder)
                  }
                  disabled={isBusy || !isCarouselReady}
                  options={[
                    {
                      value: "sequential",
                      label: t(
                        "settings.themeBackgroundCarouselOrderSequential",
                        {
                          defaultValue: "Sequential",
                        },
                      ),
                    },
                    {
                      value: "random",
                      label: t("settings.themeBackgroundCarouselOrderRandom", {
                        defaultValue: "Random",
                      }),
                    },
                  ]}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {hasBackgroundContent(background) && (
        <>
          {isPetSource && (
            <RangeSlider
              label={t("settings.themeBackgroundPetSize", {
                defaultValue: "Pet size",
              })}
              formatValue={(value) => `${Math.round(value * 100)}%`}
              value={localPetScale}
              min={PET_BACKGROUND_SCALE_MIN}
              max={PET_BACKGROUND_SCALE_MAX}
              step={0.01}
              disabled={isBusy}
              onChange={handlePetScaleInput}
              onCommit={commitSliders}
            />
          )}
          <RangeSlider
            label={t("settings.themeBackgroundOpacity", {
              defaultValue: "Opacity",
            })}
            formatValue={(value) => `${Math.round(value * 100)}%`}
            value={localOpacity}
            min={0}
            max={MAX_BACKGROUND_OPACITY}
            step={0.01}
            disabled={isBusy}
            onChange={handleOpacityInput}
            onCommit={commitSliders}
          />
          <RangeSlider
            label={t("settings.themeBackgroundBlur", {
              defaultValue: "Blur",
            })}
            formatValue={(value) => `${Math.round(value)}px`}
            value={localBlur}
            min={0}
            max={100}
            step={1}
            disabled={isBusy}
            onChange={handleBlurInput}
            onCommit={commitSliders}
          />
        </>
      )}
    </div>
  );
}
