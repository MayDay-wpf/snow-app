import { Type } from "lucide-react";
import { useI18n } from "../../../i18n";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";

type ThemeFontSectionProps = {
  fontFamily: string;
  disabled?: boolean;
  onChange: (fontFamily: string) => void;
};

type CommonFont = {
  /** 默认标签（字体名）；有 labelKey 时按当前语言显示。 */
  label: string;
  labelKey?: string;
  value: string;
};

/**
 * 字体快捷选项：内置字体（随应用打包，无需本机安装）+ 常见的纤细/特色字体。
 * 未安装的字体在预览里会回退到系统字体，用户也可以直接输入任意 CSS font-family 字符串。
 */
const COMMON_FONTS: CommonFont[] = [
  { label: "System default", value: "" },
  // 内置字体：随应用打包，未安装也一定生效。
  {
    label: "ZCOOL XiaoWei (built-in)",
    labelKey: "settings.themeFontBundledZcoolXiaoWei",
    value: "'ZCOOL XiaoWei', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    label: "Jost Light (built-in)",
    labelKey: "settings.themeFontBundledJostLight",
    value: "'Jost Light', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    label: "Porsche Sans (built-in)",
    labelKey: "settings.themeFontBundledPorscheSans",
    value: "'Porsche Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  // 常见系统字体。
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Helvetica", value: "Helvetica, Arial, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Geneva, sans-serif" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "Segoe UI", value: "'Segoe UI', sans-serif" },
  { label: "Roboto", value: "Roboto, sans-serif" },
  { label: "Microsoft YaHei", value: "'Microsoft YaHei', sans-serif" },
  { label: "PingFang SC", value: "'PingFang SC', sans-serif" },
  { label: "Noto Sans SC", value: "'Noto Sans SC', sans-serif" },
  { label: "Source Han Sans", value: "'Source Han Sans SC', sans-serif" },
  // 纤细/特色西文。
  { label: "Raleway", value: "Raleway, sans-serif" },
  { label: "Josefin Sans", value: "'Josefin Sans', sans-serif" },
  { label: "Poppins", value: "Poppins, sans-serif" },
  { label: "Quicksand", value: "Quicksand, sans-serif" },
  { label: "Comfortaa", value: "Comfortaa, sans-serif" },
  { label: "Cormorant Garamond", value: "'Cormorant Garamond', serif" },
  { label: "Playfair Display", value: "'Playfair Display', serif" },
  { label: "EB Garamond", value: "'EB Garamond', serif" },
  { label: "Optima", value: "Optima, Candara, sans-serif" },
  { label: "Futura", value: "Futura, 'Century Gothic', sans-serif" },
  { label: "Avenir Next", value: "'Avenir Next', Avenir, sans-serif" },
  { label: "Gill Sans", value: "'Gill Sans', 'Gill Sans MT', sans-serif" },
  {
    label: "Bahnschrift Light",
    value: "'Bahnschrift Light', 'Bahnschrift SemiLight', sans-serif",
  },
  // 纤细/特色中文。
  {
    label: "LXGW WenKai",
    value: "'LXGW WenKai', 'LXGW WenKai Light', '霞鹜文楷', sans-serif",
  },
  {
    label: "Source Han Sans Light",
    value:
      "'Source Han Sans SC Light', 'Noto Sans SC Light', '思源黑体 Light', sans-serif",
  },
  {
    label: "Source Han Serif Light",
    value:
      "'Source Han Serif SC Light', 'Noto Serif SC Light', '思源宋体 Light', serif",
  },
  { label: "MiSans", value: "MiSans, 'MiSans VF', sans-serif" },
  {
    label: "HarmonyOS Sans",
    value: "'HarmonyOS Sans SC', 'HarmonyOS Sans', sans-serif",
  },
  {
    label: "Alibaba PuHuiTi",
    value: "'Alibaba PuHuiTi 3.0', 'Alibaba PuHuiTi', sans-serif",
  },
  { label: "STXihei", value: "STXihei, 'Heiti SC Light', sans-serif" },
  // 纤细/特色等宽。
  { label: "JetBrains Mono", value: "'JetBrains Mono', monospace" },
  { label: "Fira Code", value: "'Fira Code', monospace" },
  {
    label: "Cascadia Code",
    value: "'Cascadia Code', 'Cascadia Mono', monospace",
  },
  { label: "IBM Plex Mono", value: "'IBM Plex Mono', monospace" },
  { label: "Victor Mono", value: "'Victor Mono', monospace" },
  { label: "SF Mono", value: "'SF Mono', 'SFMono-Regular', monospace" },
];

export function ThemeFontSection({
  fontFamily,
  disabled,
  onChange,
}: ThemeFontSectionProps): React.JSX.Element {
  const { t } = useI18n();

  const handleQuickSelect = (value: string): void => {
    onChange(value);
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeFontTitle", {
            defaultValue: "Font",
          })}
          <ApiSettingsHintIcon
            hint={t("settings.themeFontInfo", {
              defaultValue:
                "Set the application font. Choose a common font or enter a custom CSS font-family value.",
            })}
          />
        </strong>
      </div>

      <div className="theme-font-input-row">
        <Type size={15} strokeWidth={1.8} className="theme-font-input-icon" />
        <input
          type="text"
          className="theme-font-input"
          value={fontFamily}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={t("settings.themeFontPlaceholder", {
            defaultValue: "e.g. Inter, sans-serif",
          })}
        />
      </div>

      <div className="theme-font-quick-grid">
        {COMMON_FONTS.map((font) => (
          <button
            key={font.label}
            type="button"
            className={
              "theme-font-quick-btn" +
              (fontFamily === font.value ? " selected" : "")
            }
            onClick={() => handleQuickSelect(font.value)}
            disabled={disabled}
            title={
              font.value ||
              t("settings.themeFontSystemDefault", {
                defaultValue: "System default",
              })
            }
            style={font.value ? { fontFamily: font.value } : undefined}
          >
            {font.labelKey
              ? t(font.labelKey, { defaultValue: font.label })
              : font.label}
          </button>
        ))}
      </div>
    </div>
  );
}
