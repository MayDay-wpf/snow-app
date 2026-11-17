import { useI18n } from "../../../i18n";
import {
  setToolCardStyle,
  useToolCardStyle,
  type ToolCardStyle,
} from "../../../utils/toolCardStyle";

type ThemeTranscriptStyleSelectorProps = {
  disabled?: boolean;
};

const STYLE_OPTIONS: {
  value: ToolCardStyle;
  labelKey: string;
  defaultLabel: string;
}[] = [
  {
    value: "classic",
    labelKey: "chat.style.classic",
    defaultLabel: "Classic",
  },
  {
    value: "chips",
    labelKey: "chat.style.chips",
    defaultLabel: "Chips",
  },
  {
    value: "minimal",
    labelKey: "chat.style.minimal",
    defaultLabel: "Minimal",
  },
];

/** 经典：头像正文 + 时间线上逐条工具卡。 */
function ClassicThumbnail(): React.JSX.Element {
  return (
    <svg
      width="48"
      height="32"
      viewBox="0 0 48 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="31"
        rx="3.5"
        fill="var(--app-bg)"
        stroke="var(--border-color)"
      />
      <circle
        cx="8"
        cy="8.6"
        r="2.4"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="12.5"
        y="6.6"
        width="22"
        height="1.6"
        rx="0.8"
        fill="var(--text-secondary)"
        opacity="0.55"
      />
      <rect
        x="12.5"
        y="10"
        width="30"
        height="1.3"
        rx="0.65"
        fill="var(--text-secondary)"
        opacity="0.3"
      />
      <path d="M8.5 15V29" stroke="var(--border-color)" strokeWidth="0.5" />
      <circle
        cx="8.5"
        cy="16.6"
        r="1"
        fill="var(--text-secondary)"
        opacity="0.5"
      />
      <circle
        cx="8.5"
        cy="21.6"
        r="1"
        fill="var(--text-secondary)"
        opacity="0.5"
      />
      <circle
        cx="8.5"
        cy="26.6"
        r="1"
        fill="var(--text-secondary)"
        opacity="0.5"
      />
      <rect
        x="12.5"
        y="14.6"
        width="30"
        height="4"
        rx="1.2"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="12.5"
        y="19.6"
        width="30"
        height="4"
        rx="1.2"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="12.5"
        y="24.6"
        width="30"
        height="4"
        rx="1.2"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
    </svg>
  );
}

/** 简洁：工具压成一行行紧凑胶囊。 */
function ChipsThumbnail(): React.JSX.Element {
  return (
    <svg
      width="48"
      height="32"
      viewBox="0 0 48 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="31"
        rx="3.5"
        fill="var(--app-bg)"
        stroke="var(--border-color)"
      />
      <circle
        cx="8"
        cy="8.6"
        r="2.4"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="12.5"
        y="6.6"
        width="22"
        height="1.6"
        rx="0.8"
        fill="var(--text-secondary)"
        opacity="0.55"
      />
      <rect
        x="12.5"
        y="10"
        width="30"
        height="1.3"
        rx="0.65"
        fill="var(--text-secondary)"
        opacity="0.3"
      />
      <rect
        x="12.5"
        y="15"
        width="11"
        height="3.8"
        rx="1.9"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="25.5"
        y="15"
        width="8"
        height="3.8"
        rx="1.9"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="35.5"
        y="15"
        width="7"
        height="3.8"
        rx="1.9"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="12.5"
        y="20.8"
        width="9"
        height="3.8"
        rx="1.9"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="23.5"
        y="20.8"
        width="12"
        height="3.8"
        rx="1.9"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
    </svg>
  );
}

/** 极简：正文 + 一个合并后的工具集合行。 */
function MinimalThumbnail(): React.JSX.Element {
  return (
    <svg
      width="48"
      height="32"
      viewBox="0 0 48 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="31"
        rx="3.5"
        fill="var(--app-bg)"
        stroke="var(--border-color)"
      />
      <rect
        x="5"
        y="6.6"
        width="30"
        height="1.6"
        rx="0.8"
        fill="var(--text-secondary)"
        opacity="0.5"
      />
      <rect
        x="5"
        y="10.2"
        width="38"
        height="1.3"
        rx="0.65"
        fill="var(--text-secondary)"
        opacity="0.3"
      />
      <rect
        x="5"
        y="13.6"
        width="26"
        height="1.3"
        rx="0.65"
        fill="var(--text-secondary)"
        opacity="0.3"
      />
      <path d="M4.5 17.6H43.5" stroke="var(--border-color)" strokeWidth="0.5" />
      <path
        d="M5.4 20.2 7 21.8 5.4 23.4"
        stroke="var(--text-secondary)"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.6"
      />
      <rect
        x="9.5"
        y="21"
        width="18"
        height="1.4"
        rx="0.7"
        fill="var(--text-secondary)"
        opacity="0.45"
      />
      <path d="M4.5 25.8H43.5" stroke="var(--border-color)" strokeWidth="0.5" />
      <rect
        x="5"
        y="27.4"
        width="33"
        height="1.3"
        rx="0.65"
        fill="var(--text-secondary)"
        opacity="0.3"
      />
    </svg>
  );
}

const THUMBNAILS: Record<ToolCardStyle, () => React.JSX.Element> = {
  classic: ClassicThumbnail,
  chips: ChipsThumbnail,
  minimal: MinimalThumbnail,
};

export function ThemeTranscriptStyleSelector({
  disabled,
}: ThemeTranscriptStyleSelectorProps): React.JSX.Element {
  const { t } = useI18n();
  const currentStyle = useToolCardStyle();

  return (
    <div className="theme-mode-selector" role="radiogroup">
      {STYLE_OPTIONS.map((option) => {
        const isActive = currentStyle === option.value;
        const Thumbnail = THUMBNAILS[option.value];
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`theme-mode-option ${isActive ? "active" : ""}`}
            onClick={() => setToolCardStyle(option.value)}
            disabled={disabled}
          >
            <Thumbnail />
            <span>
              {t(option.labelKey, { defaultValue: option.defaultLabel })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
