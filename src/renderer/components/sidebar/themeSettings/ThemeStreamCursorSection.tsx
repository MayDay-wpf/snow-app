import { FileCode, FileUp, ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import { RangeSlider } from "../../common/RangeSlider";
import { AnimatedSnowBotIcon } from "../../icons/AnimatedSnowBotIcon";
import { STREAM_CURSOR_LUCIDE_ICONS } from "./streamCursorIcons";
import { StreamCursorCanvas } from "./StreamCursorCanvas";
import type { ThemeStreamCursor } from "./types";
import { themeBgUrl } from "../../../utils/themeBgUrl";

type ThemeStreamCursorSectionProps = {
  cursor: ThemeStreamCursor;
  disabled?: boolean;
  busy?: boolean;
  onChange: (cursor: ThemeStreamCursor) => void;
  onSelectAsset: (kind: StreamCursorAssetKind) => Promise<void>;
  onRemoveSvg: () => Promise<void>;
};

export type StreamCursorAssetKind = "svg" | "image" | "script";

const isSvgPath = (path: string): boolean => /\.svg$/i.test(path);
const isScriptPath = (path: string): boolean => /\.js$/i.test(path);

const ASSET_KIND_BY_TYPE: Partial<
  Record<ThemeStreamCursor["iconType"], StreamCursorAssetKind>
> = {
  custom: "svg",
  image: "image",
  canvas: "script",
};

export function ThemeStreamCursorSection({
  cursor,
  disabled,
  busy,
  onChange,
  onSelectAsset,
  onRemoveSvg,
}: ThemeStreamCursorSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const isBusy = disabled || busy;
  const assetKind = ASSET_KIND_BY_TYPE[cursor.iconType] ?? null;
  const AssetIcon =
    assetKind === "script"
      ? FileCode
      : assetKind === "image"
        ? ImageUp
        : FileUp;
  const selectLabel =
    assetKind === "script"
      ? t("settings.themeStreamCursorSelectScript", {
          defaultValue: "Select script",
        })
      : assetKind === "image"
        ? t("settings.themeStreamCursorSelectImage", {
            defaultValue: "Select image",
          })
        : t("settings.themeStreamCursorSelectSvg", {
            defaultValue: "Select SVG",
          });

  // 脚本运行错误：换脚本后清空。
  const [scriptError, setScriptError] = useState("");
  useEffect(() => {
    setScriptError("");
  }, [cursor.svgPath]);

  // 本地 state 用于滑块拖动期间的即时 UI 响应，与 ThemeBackgroundSection 模式一致。
  const [localSize, setLocalSize] = useState(cursor.iconSize);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    setLocalSize(cursor.iconSize);
  }, [cursor.iconSize]);

  const commitSize = (): void => {
    const c = cursorRef.current;
    onChange({ ...c, iconSize: localSize });
  };

  const handleTypeChange = (iconType: string): void => {
    const resolved: ThemeStreamCursor["iconType"] =
      iconType === "lucide" ||
      iconType === "custom" ||
      iconType === "snowbot" ||
      iconType === "image" ||
      iconType === "canvas"
        ? iconType
        : "dot";
    if (resolved === "dot") {
      onChange({
        iconType: "dot",
        lucideName: "",
        svgPath: "",
        iconSize: cursor.iconSize,
      });
    } else if (resolved === "lucide") {
      onChange({
        iconType: "lucide",
        lucideName: cursor.lucideName || STREAM_CURSOR_LUCIDE_ICONS[0].name,
        svgPath: "",
        iconSize: cursor.iconSize,
      });
    } else if (resolved === "snowbot") {
      onChange({
        iconType: "snowbot",
        lucideName: "",
        svgPath: "",
        iconSize: cursor.iconSize,
      });
    } else if (resolved === "image") {
      // 路径字段共用；SVG 也是图片可沿用，脚本不行。
      onChange({
        iconType: "image",
        lucideName: "",
        svgPath: isScriptPath(cursor.svgPath) ? "" : cursor.svgPath,
        iconSize: cursor.iconSize,
      });
    } else if (resolved === "canvas") {
      onChange({
        iconType: "canvas",
        lucideName: "",
        svgPath: isScriptPath(cursor.svgPath) ? cursor.svgPath : "",
        iconSize: cursor.iconSize,
      });
    } else {
      onChange({
        iconType: "custom",
        lucideName: "",
        svgPath: isSvgPath(cursor.svgPath) ? cursor.svgPath : "",
        iconSize: cursor.iconSize,
      });
    }
  };

  const handleLucideSelect = (name: string): void => {
    onChange({
      iconType: "lucide",
      lucideName: name,
      svgPath: "",
      iconSize: cursor.iconSize,
    });
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeStreamCursorTitle", {
            defaultValue: "Streaming indicator",
          })}
          <ApiSettingsHintIcon
            hint={t("settings.themeStreamCursorInfo", {
              defaultValue:
                "Customize the indicator shown while the AI is generating a response.",
            })}
          />
        </strong>
      </div>

      <div className="theme-stream-cursor-type-select">
        <CustomSelect
          value={cursor.iconType}
          onChange={handleTypeChange}
          disabled={isBusy}
          options={[
            {
              value: "dot",
              label: t("settings.themeStreamCursorTypeDot", {
                defaultValue: "Pulsing dot",
              }),
            },
            {
              value: "lucide",
              label: t("settings.themeStreamCursorTypeLucide", {
                defaultValue: "Built-in icon",
              }),
            },
            {
              value: "snowbot",
              label: t("settings.themeStreamCursorTypeSnowBot", {
                defaultValue: "Snow Bot",
              }),
            },
            {
              value: "custom",
              label: t("settings.themeStreamCursorTypeCustom", {
                defaultValue: "Custom SVG",
              }),
            },
            {
              value: "image",
              label: t("settings.themeStreamCursorTypeImage", {
                defaultValue: "Custom image",
              }),
            },
            {
              value: "canvas",
              label: t("settings.themeStreamCursorTypeCanvas", {
                defaultValue: "Canvas script",
              }),
            },
          ]}
        />
      </div>

      {cursor.iconType === "lucide" && (
        <div className="theme-stream-cursor-icon-grid">
          {STREAM_CURSOR_LUCIDE_ICONS.map(({ name, Icon }) => (
            <button
              key={name}
              type="button"
              className={
                "theme-stream-cursor-icon-btn" +
                (cursor.lucideName === name ? " selected" : "")
              }
              onClick={() => handleLucideSelect(name)}
              disabled={isBusy}
              title={name}
            >
              <Icon size={18} strokeWidth={2} />
            </button>
          ))}
        </div>
      )}

      {assetKind && (
        <div className="api-settings-form-grid">
          <div className="theme-stream-cursor-preview">
            {cursor.svgPath && assetKind !== "script" ? (
              <img
                src={themeBgUrl(cursor.svgPath)}
                alt=""
                className="theme-stream-cursor-thumbnail"
              />
            ) : (
              <span className="theme-background-placeholder">
                <AssetIcon size={24} strokeWidth={1.6} />
              </span>
            )}
          </div>
          <div className="theme-background-actions">
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={() => void onSelectAsset(assetKind)}
              disabled={isBusy}
            >
              <AssetIcon size={15} strokeWidth={1.8} />
              <span>{selectLabel}</span>
            </button>
            {cursor.svgPath && (
              <button
                type="button"
                className="api-settings-form-btn secondary danger"
                onClick={() => void onRemoveSvg()}
                disabled={isBusy}
              >
                <Trash2 size={15} strokeWidth={1.8} />
                <span>
                  {t("settings.themeStreamCursorRemoveSvg", {
                    defaultValue: "Remove",
                  })}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {assetKind === "script" && (
        <span className="settings-item-description theme-stream-cursor-script-hint">
          {t("settings.themeStreamCursorCanvasHint", {
            defaultValue:
              "The script must define draw(ctx, size, t, dark): ctx is already scaled for the device pixel ratio, size is in CSS pixels, t is elapsed seconds, dark tells whether the dark theme is active. It runs in an isolated Worker without access to the page or app APIs.",
          })}
        </span>
      )}
      {assetKind === "script" && scriptError && (
        <span className="theme-stream-cursor-script-error">
          {t("settings.themeStreamCursorCanvasError", {
            defaultValue: "Script error: {{message}}",
            values: { message: scriptError },
          })}
        </span>
      )}

      {/* 尺寸滑块 + 实时预览 */}
      {cursor.iconType !== "dot" && (
        <>
          <div className="theme-stream-cursor-live-preview">
            {cursor.iconType === "lucide" &&
              (() => {
                const Icon = STREAM_CURSOR_LUCIDE_ICONS.find(
                  (i) => i.name === cursor.lucideName,
                )?.Icon;
                return Icon ? (
                  <Icon
                    size={localSize}
                    strokeWidth={2}
                    className="stream-cursor-lucide-icon"
                  />
                ) : null;
              })()}
            {cursor.iconType === "snowbot" && (
              <AnimatedSnowBotIcon size={localSize} strokeWidth={2} />
            )}
            {cursor.iconType === "custom" && cursor.svgPath && (
              <span
                className="stream-cursor-custom-icon"
                style={{
                  width: `${localSize}px`,
                  height: `${localSize}px`,
                  backgroundImage: `url("${themeBgUrl(cursor.svgPath)}")`,
                }}
              />
            )}
            {cursor.iconType === "image" && cursor.svgPath && (
              <img
                src={themeBgUrl(cursor.svgPath)}
                alt=""
                draggable={false}
                className="stream-cursor-image-icon"
                style={{ height: `${localSize}px` }}
              />
            )}
            {cursor.iconType === "canvas" && cursor.svgPath && (
              <StreamCursorCanvas
                scriptPath={cursor.svgPath}
                size={localSize}
                onError={setScriptError}
              />
            )}
          </div>
          <RangeSlider
            label={t("settings.themeStreamCursorSize", {
              defaultValue: "Icon size",
            })}
            formatValue={(value) => `${Math.round(value)}px`}
            value={localSize}
            min={8}
            max={48}
            step={1}
            disabled={isBusy}
            onChange={(value) => setLocalSize(value)}
            onCommit={commitSize}
          />
        </>
      )}
    </div>
  );
}
