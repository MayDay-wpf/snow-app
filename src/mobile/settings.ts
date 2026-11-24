import { $, escapeHtml } from "./dom";
import { t } from "./i18n";
import { rememberOverlayTrigger } from "./overlays";
import { openRemotePanel } from "./panels";
import { rerenderTimeline } from "./timeline";
import {
  getTranscriptStyle,
  setTranscriptStyle,
  type TranscriptStyle,
} from "./transcriptStyle";

/**
 * 手机端设置页：入口固定在会话列表底部。
 *
 * 内容按「分组 → 选项」渲染，后续新增设置项直接追加分组（或分组内的行），
 * 不影响既有布局；面板本身沿用 .remote-panel 的吸顶标题与滚动正文。
 */
const STYLE_OPTIONS: {
  value: TranscriptStyle;
  labelKey: string;
  hintKey: string;
}[] = [
  {
    value: "classic",
    labelKey: "remote.settings.transcriptClassic",
    hintKey: "remote.settings.transcriptClassicHint",
  },
  {
    value: "chips",
    labelKey: "remote.settings.transcriptChips",
    hintKey: "remote.settings.transcriptChipsHint",
  },
  {
    value: "minimal",
    labelKey: "remote.settings.transcriptMinimal",
    hintKey: "remote.settings.transcriptMinimalHint",
  },
];

const transcriptOptionsHtml = (): string => {
  const current = getTranscriptStyle();
  return STYLE_OPTIONS.map((option) => {
    const active = option.value === current;
    return (
      `<button class="settings-option${active ? " active" : ""}" type="button" role="radio" aria-checked="${active}" data-transcript-style="${option.value}">` +
      `<span class="settings-option-label">${escapeHtml(t(option.labelKey))}</span>` +
      `<span class="settings-option-hint">${escapeHtml(t(option.hintKey))}</span>` +
      `</button>`
    );
  }).join("");
};

const renderSettings = (): void => {
  const title = escapeHtml(t("remote.settings.transcript"));
  $("settingsBody").innerHTML =
    `<section class="settings-group">` +
    `<div class="settings-group-title">${title}</div>` +
    `<div class="settings-group-hint">${escapeHtml(t("remote.settings.transcriptHint"))}</div>` +
    `<div class="settings-options" role="radiogroup" aria-label="${title}">${transcriptOptionsHtml()}</div>` +
    `</section>`;
};

export const initSettings = (): void => {
  $("threadSettingsButton").onclick = (event) => {
    rememberOverlayTrigger(event.currentTarget as HTMLElement);
    renderSettings();
    openRemotePanel("settingsPanel");
  };

  $("settingsBody").onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-transcript-style]",
    );
    if (!button) return;
    const next = STYLE_OPTIONS.find(
      (option) => option.value === button.dataset.transcriptStyle,
    );
    if (!next || next.value === getTranscriptStyle()) return;
    setTranscriptStyle(next.value);
    renderSettings();
    rerenderTimeline();
  };
};
