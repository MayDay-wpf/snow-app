import type { SnowRemoteChatInputState } from "../renderer/types/remoteControl";
import {
  setApiProfile,
  setModel,
  setResponsesFastMode,
  setThinking,
} from "./api";
import { $, escapeHtml } from "./dom";
import { effectiveThinkingLabel } from "./format";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { showNotice } from "./notice";
import type { AppContext } from "./types";

/**
 * 模型与推理面板（#modelPanel）：层级与桌面 ModelSelector 一致。
 * root 视图汇总「模型 / 思考强度 / Fast Mode / 选择 API 提供商」，
 * 子视图提供搜索与选中列表；由输入区上方的模型 chip 直接打开
 * （不再从 Plus 菜单进入）。
 */
type ModelPanelView = "root" | "model" | "thinking" | "fastMode" | "apiProfile";

const FAST_MODE_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: "off", labelKey: "remote.model.fastModeOff" },
  { value: "fast", labelKey: "remote.model.fastModeFast" },
  { value: "ultrafast", labelKey: "remote.model.fastModeUltrafast" },
];

const fastModeLabel = (tier: string | undefined): string => {
  const option = FAST_MODE_OPTIONS.find((item) => item.value === tier);
  return option ? t(option.labelKey) : t("remote.model.fastModeOff");
};

let view: ModelPanelView = "root";
let modelQuery = "";
let profileQuery = "";
let latestInput: SnowRemoteChatInputState | null = null;
let lastRenderedSignature = "";

const isView = (value: string | undefined): value is ModelPanelView =>
  value === "root" ||
  value === "model" ||
  value === "thinking" ||
  value === "fastMode" ||
  value === "apiProfile";

/** 输入区的模型 chip 打开面板前调用：回到 root 视图并清空搜索。 */
export const resetModelPanel = (): void => {
  view = "root";
  modelQuery = "";
  profileQuery = "";
  lastRenderedSignature = "";
};

const itemHtml = (name: string, attrs: string, active: boolean): string =>
  `<button class="model-menu-item${active ? " active" : ""}" type="button" ${attrs}>` +
  `<span class="model-menu-item-name">${escapeHtml(name)}</span>` +
  (active ? iconMarkup("check") : "") +
  `</button>`;

const emptyState = (key: string): string =>
  `<div class="empty">${t(key)}</div>`;

const listHtml = (): string => {
  const input = latestInput;
  // 快照整体不可用（桌面不在对话页等）与“过滤无结果”区分提示。
  if (!input) return emptyState("remote.model.unavailable");
  if (view === "thinking") {
    const options = input.thinkingOptions || [];
    if (!options.length) return emptyState("remote.model.empty");
    const active = input.effectiveThinkingValue ?? "";
    return (
      options
        .map((option) =>
          itemHtml(
            option.label || option.value,
            `data-thinking="${escapeHtml(option.value)}"`,
            option.value === active,
          ),
        )
        .join("") || emptyState("remote.model.noMatches")
    );
  }
  if (view === "fastMode") {
    const active = input.responsesFastMode ?? "off";
    // anthropic 仅支持 off / fast。
    const isAnthropic = input.requestMethod === "anthropic";
    return FAST_MODE_OPTIONS.filter(
      (option) => !isAnthropic || option.value !== "ultrafast",
    )
      .map((option) =>
        itemHtml(
          t(option.labelKey),
          `data-fast-mode="${option.value}"`,
          option.value === active,
        ),
      )
      .join("");
  }
  if (view === "apiProfile") {
    const names = input.apiProfileNames || [];
    if (!names.length) return emptyState("remote.model.empty");
    const query = profileQuery.trim().toLowerCase();
    const active = input.selectedApiProfile ?? "";
    return (
      names
        .filter((name) => !query || name.toLowerCase().indexOf(query) !== -1)
        .map((name) =>
          itemHtml(name, `data-profile="${escapeHtml(name)}"`, name === active),
        )
        .join("") || emptyState("remote.model.noMatches")
    );
  }
  const modelIds = input.modelIds || [];
  if (!modelIds.length) return emptyState("remote.model.empty");
  const query = modelQuery.trim().toLowerCase();
  const active = input.selectedModel ?? "";
  return (
    modelIds
      .filter((id) => !query || id.toLowerCase().indexOf(query) !== -1)
      .map((id) =>
        itemHtml(id, `data-model-id="${escapeHtml(id)}"`, id === active),
      )
      .join("") || emptyState("remote.model.noMatches")
  );
};

const searchHtml = (): string => {
  const isModel = view === "model";
  const query = isModel ? modelQuery : profileQuery;
  const placeholder = t(
    isModel ? "remote.model.searchModels" : "remote.model.searchProfiles",
  );
  return (
    `<div class="model-menu-search">${iconMarkup("search")}` +
    `<input data-model-search type="text" autocomplete="off" value="${escapeHtml(query)}" placeholder="${escapeHtml(placeholder)}" />` +
    `</div>`
  );
};

const headerHtml = (title: string): string =>
  `<div class="model-menu-header">` +
  `<button class="model-menu-back" type="button" data-model-back aria-label="${escapeHtml(t("remote.model.back"))}">${iconMarkup("chevron-left")}</button>` +
  `<span>${escapeHtml(title)}</span>` +
  `</div>`;

const rootHtml = (): string => {
  const input = latestInput;
  const displayModel =
    input?.displayModel ||
    input?.selectedModel ||
    t("remote.model.notSelected");
  const profile = input?.selectedApiProfile || t("remote.model.notSelected");
  const rows: string[] = [
    `<button class="model-menu-row" type="button" data-model-view="model">` +
      `<span class="model-menu-label">${t("remote.model.menuModel")}</span>` +
      `<span class="model-menu-value"><span class="model-menu-value-text">${escapeHtml(displayModel)}</span>${iconMarkup("chevron-right")}</span>` +
      `</button>`,
    `<button class="model-menu-row" type="button" data-model-view="thinking">` +
      `<span class="model-menu-label">${t("remote.model.thinking")}</span>` +
      `<span class="model-menu-value"><span class="model-menu-value-text">${escapeHtml(effectiveThinkingLabel(input))}</span>${iconMarkup("chevron-right")}</span>` +
      `</button>`,
  ];
  if (
    input?.requestMethod === "responses" ||
    input?.requestMethod === "anthropic"
  ) {
    rows.push(
      `<button class="model-menu-row" type="button" data-model-view="fastMode">` +
        `<span class="model-menu-label">${t("remote.model.fastMode")}</span>` +
        `<span class="model-menu-value"><span class="model-menu-value-text">${escapeHtml(fastModeLabel(input?.responsesFastMode))}</span>${iconMarkup("chevron-right")}</span>` +
        `</button>`,
    );
  }
  rows.push(
    `<button class="model-menu-row" type="button" data-model-view="apiProfile">` +
      `<span class="model-menu-label">${t("remote.model.menuProfile")}</span>` +
      `<span class="model-menu-value"><span class="model-menu-value-text">${escapeHtml(profile)}</span>${iconMarkup("chevron-right")}</span>` +
      `</button>`,
  );
  return rows.join("");
};

/** 渲染签名：无变化的轮询帧跳过重建，保住列表滚动位置。 */
const buildSignature = (input: SnowRemoteChatInputState | null): string => {
  if (!input) return view + "|empty";
  return [
    view,
    input.selectedModel,
    input.displayModel,
    input.modelIds.join(","),
    input.selectedApiProfile,
    input.apiProfileNames.join(","),
    input.effectiveThinkingValue,
    (input.thinkingOptions || []).map((option) => option.value).join(","),
    input.responsesFastMode,
    input.requestMethod,
  ].join("|");
};

export const renderModelPanel = (
  input: SnowRemoteChatInputState | null | undefined,
): void => {
  latestInput = input ?? null;
  const panel = $("modelPanel");
  if (!panel.classList.contains("open")) return;
  const signature = buildSignature(latestInput);
  if (signature === lastRenderedSignature) return;
  lastRenderedSignature = signature;
  if (view === "root") {
    $("modelPanelBody").innerHTML = rootHtml();
    return;
  }
  // 子视图：数据更新只刷新列表，返回头 / 搜索框保持原样（输入不被打断）。
  const list = document.getElementById("modelMenuList");
  if (list) {
    list.innerHTML = listHtml();
    return;
  }
  $("modelPanelBody").innerHTML =
    headerHtml(
      view === "model"
        ? t("remote.model.menuModel")
        : view === "thinking"
          ? t("remote.model.thinking")
          : view === "fastMode"
            ? t("remote.model.fastMode")
            : t("remote.model.menuProfile"),
    ) +
    (view === "thinking" || view === "fastMode" ? "" : searchHtml()) +
    `<div class="model-menu-list" id="modelMenuList">${listHtml()}</div>`;
};

const setView = (next: ModelPanelView): void => {
  if (view === next) return;
  view = next;
  if (next === "model") modelQuery = "";
  if (next === "apiProfile") profileQuery = "";
  // 视图切换强制重建（root 行 / 子视图骨架在此刷新；数据更新只走列表分支）。
  lastRenderedSignature = "";
  $("modelPanel").scrollTop = 0;
  renderModelPanel(latestInput);
  // 与桌面 ModelSelector 的搜索框 autoFocus 一致：进入可搜索视图即可直接输入。
  if (next === "model" || next === "apiProfile") {
    document
      .querySelector<HTMLInputElement>("#modelPanelBody [data-model-search]")
      ?.focus();
  }
};

const handleAction = async (
  ctx: AppContext,
  target: HTMLElement,
): Promise<void> => {
  const back = target.closest<HTMLElement>("[data-model-back]");
  if (back) {
    setView("root");
    return;
  }
  const viewButton = target.closest<HTMLElement>("[data-model-view]");
  if (viewButton && isView(viewButton.dataset.modelView)) {
    setView(viewButton.dataset.modelView);
    return;
  }
  const modelItem = target.closest<HTMLElement>("[data-model-id]");
  if (modelItem) {
    await setModel(modelItem.dataset.modelId ?? "");
    showNotice(t("remote.notice.settingsUpdated"));
    await ctx.refresh(false);
    return;
  }
  const thinkingItem = target.closest<HTMLElement>("[data-thinking]");
  if (thinkingItem) {
    await setThinking(thinkingItem.dataset.thinking ?? "");
    showNotice(t("remote.notice.settingsUpdated"));
    await ctx.refresh(false);
    return;
  }
  const profileItem = target.closest<HTMLElement>("[data-profile]");
  if (profileItem) {
    await setApiProfile(profileItem.dataset.profile ?? "");
    showNotice(t("remote.notice.settingsUpdated"));
    await ctx.refresh(false);
    return;
  }
  const fastModeItem = target.closest<HTMLElement>("[data-fast-mode]");
  if (fastModeItem) {
    await setResponsesFastMode(fastModeItem.dataset.fastMode ?? "off");
    showNotice(t("remote.notice.settingsUpdated"));
    await ctx.refresh(false);
  }
};

const applySearchInput = (value: string): void => {
  if (view === "model") modelQuery = value;
  else if (view === "apiProfile") profileQuery = value;
  else return;
  const list = document.getElementById("modelMenuList");
  if (list) list.innerHTML = listHtml();
};

export const initModelPanel = (ctx: AppContext): void => {
  const body = $("modelPanelBody");
  body.addEventListener("click", (event) => {
    void handleAction(ctx, event.target as HTMLElement).catch((error) => {
      showNotice((error as Error).message, true);
    });
  });
  // 搜索：input 实时过滤；compositionend 兜底（个别输入法组合期间不派发 input）。
  body.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.matches("[data-model-search]")) return;
    applySearchInput(input.value);
  });
  body.addEventListener("compositionend", (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.matches("[data-model-search]")) return;
    applySearchInput(input.value);
  });
};
