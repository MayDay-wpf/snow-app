import type {
  SnowRemoteModeId,
  SnowRemoteState,
} from "../renderer/types/remoteControl";
import { $, escapeHtml } from "./dom";
import { contextLabel, effectiveThinkingLabel } from "./format";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import { renderModelPanel, resetModelPanel } from "./modelPanel";
import { openRemotePanel } from "./panels";
import type { AppContext } from "./types";
import { usageDetailMarkup, usageRingMarkup } from "./usageRing";

/** 思考强度值 → lucide 图标（与桌面端 THINKING_OPTIONS_BY_METHOD 逐值对应）。 */
const THINKING_ICONS: Record<string, MobileIconName> = {
  none: "circle-off",
  minimal: "circle-dot",
  low: "gauge",
  medium: "activity",
  high: "brain-circuit",
  xhigh: "chevrons-up",
  max: "rocket",
};

/**
 * 模式徽章：顺序与图标同桌面端 ChatInputToolbar，仅图标展示，
 * 点击后弹出说明 tooltip。
 */
const MODE_BADGES: ReadonlyArray<{
  id: SnowRemoteModeId;
  icon: MobileIconName;
}> = [
  { id: "goal", icon: "target" },
  { id: "worktree", icon: "git-branch" },
  { id: "workflow", icon: "workflow" },
  { id: "yolo", icon: "shield-alert" },
  { id: "lite", icon: "feather" },
];

/** 徽章说明文案（与桌面端模式 tooltip 同源）。 */
const MODE_DESCRIPTION_KEYS: Record<SnowRemoteModeId, string> = {
  goal: "remote.modes.goalDescription",
  worktree: "remote.modes.worktreeDescription",
  workflow: "remote.modes.workflowDescription",
  yolo: "remote.modes.yoloDescription",
  lite: "remote.modes.liteDescription",
};

const closeModeTooltip = (): void => {
  const tooltip = document.getElementById("modeTooltip");
  if (!tooltip || tooltip.hidden) return;
  tooltip.hidden = true;
  $("modeBadges")
    .querySelectorAll<HTMLElement>('.mode-badge[aria-expanded="true"]')
    .forEach((badge) => badge.setAttribute("aria-expanded", "false"));
};

const openModeTooltip = (badge: HTMLElement, content: string): void => {
  const tooltip = document.getElementById("modeTooltip");
  if (!tooltip) return;
  tooltip.textContent = content;
  tooltip.hidden = false;
  // 定位在徽章上方，左右夹在视口内。
  const rect = badge.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - tooltip.offsetWidth / 2, margin),
    window.innerWidth - tooltip.offsetWidth - margin,
  );
  const top = Math.max(rect.top - tooltip.offsetHeight - 8, margin);
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  badge.setAttribute("aria-expanded", "true");
};

/** 已启用模式的签名：集合不变时不重建 DOM，避免状态刷新打断 tooltip。 */
let modeBadgeSignature = "";

const renderModeBadges = (
  modes: SnowRemoteState["modes"] | undefined,
): void => {
  const container = $("modeBadges");
  const active = MODE_BADGES.filter((badge) => Boolean(modes?.[badge.id]));
  container.hidden = active.length === 0;
  const signature = active.map((badge) => badge.id).join("|");
  if (signature === modeBadgeSignature) return;
  modeBadgeSignature = signature;
  closeModeTooltip();
  container.innerHTML = active
    .map(({ id, icon }) => {
      const label = escapeHtml(t(MODE_DESCRIPTION_KEYS[id]));
      return (
        `<button type="button" class="mode-badge mode-badge-${id}" data-mode="${id}"` +
        ` aria-label="${label}" aria-expanded="false">${iconMarkup(icon)}</button>`
      );
    })
    .join("");
};

/**
 * 输入区上方的远程状态 chips：
 * 模型 + 思考强度合并为一个选择器（参考桌面端 ModelSelector 触发器，
 * 思考区带分隔线 + 强度图标），后接模式徽章；上下文环在顶栏。
 */
export const renderControls = (next: SnowRemoteState | null): void => {
  const input = next?.chatInput;

  const thinkingValue = input?.effectiveThinkingValue || "";
  $("modelChip").innerHTML =
    `<span class="chip-model">${escapeHtml(input?.selectedModel || t("remote.model.notSelected"))}</span>` +
    `<span class="chip-thinking">${iconMarkup(THINKING_ICONS[thinkingValue] ?? "brain-circuit")}<span class="chip-thinking-label">${escapeHtml(effectiveThinkingLabel(input))}</span></span>` +
    `<span class="chip-caret">${iconMarkup("chevron-down")}</span>`;
  renderModeBadges(next?.modes);
  // 顶栏上下文环：四段绘制同桌面端，点击展开用量明细。
  const ring = $("usageRing");
  const ringHtml = usageRingMarkup(input?.tokenUsage, input?.maxContextTokens);
  ring.innerHTML = ringHtml ?? "";
  ring.hidden = !ringHtml;
  $("usagePopover").innerHTML =
    usageDetailMarkup(input?.tokenUsage, input?.maxContextTokens) ?? "";
  if (!ringHtml) closeUsagePopover();
  ring.title = contextLabel(input?.tokenUsage, input?.maxContextTokens);
};

/** 关闭用量明细浮层（数据失效或点击外部时调用）。 */
const closeUsagePopover = (): void => {
  const popover = document.getElementById("usagePopover");
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  document.getElementById("usageRing")?.setAttribute("aria-expanded", "false");
};

export const initControls = (ctx: AppContext): void => {
  $("remoteToolbar").onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-panel]",
    );
    if (!button) return;
    const panelId = button.dataset.panel ?? "";
    if (panelId === "modelPanel") {
      // 模型面板由模型 chip 直接打开（不再从 Plus 菜单进入），回到 root 视图。
      resetModelPanel();
      openRemotePanel(panelId);
      renderModelPanel(ctx.getState()?.chatInput);
      return;
    }
    openRemotePanel(panelId);
  };

  // 模式徽章：点击弹出说明 tooltip，再次点击 / 点击别处 / 滚动时收起。
  const badges = $("modeBadges");
  badges.onclick = (event) => {
    event.stopPropagation();
    const badge = (event.target as HTMLElement).closest<HTMLElement>(
      ".mode-badge",
    );
    const mode = badge?.dataset.mode as SnowRemoteModeId | undefined;
    if (!badge || !mode) return;
    if (badge.getAttribute("aria-expanded") === "true") {
      closeModeTooltip();
      return;
    }
    closeModeTooltip();
    openModeTooltip(badge, t(MODE_DESCRIPTION_KEYS[mode]));
  };
  document.addEventListener("click", closeModeTooltip);
  window.addEventListener("scroll", closeModeTooltip, true);
  window.addEventListener("resize", closeModeTooltip);

  // 点环切换用量明细；点页面其它位置关闭。
  const ring = $("usageRing");
  const popover = $("usagePopover");
  ring.onclick = (event) => {
    event.stopPropagation();
    popover.hidden = !popover.hidden;
    ring.setAttribute("aria-expanded", String(!popover.hidden));
  };
  document.addEventListener("click", (event) => {
    if (popover.hidden) return;
    const target = event.target as Node;
    if (popover.contains(target) || ring.contains(target)) return;
    closeUsagePopover();
  });
};
