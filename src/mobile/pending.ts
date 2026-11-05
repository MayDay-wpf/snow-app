import type {
  SnowRemoteContentBlock,
  SnowRemoteState,
} from "../renderer/types/remoteControl";
import { sendPendingNow, withdrawPending } from "./api";
import { restoreInputText } from "./composer";
import { attachmentIconMarkup } from "./contentIcons";
import { $, escapeHtml } from "./dom";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { showNotice } from "./notice";
import type { AppContext } from "./types";

/**
 * 待发送（Pending）消息区：显示当前激活会话的排队消息（会话隔离，数据随
 * /api/state 的 activeConversationId 一起切换），每条可「立即发送」（中断
 * 当前运行并直接发出）或「撤回」（从队列移除并把原文恢复到输入框）。
 *
 * 渲染策略：容器整段重绘，但内容签名未变时跳过，避免每轮轮询都重建 DOM；
 * 操作按钮用事件委托绑定，重建后无需重新挂载。操作携带渲染时队列的
 * 定位键（pendingQueueKey，不透明标记），桌面端据此解析队列真实位置
 * （含新会话槽位→真实 id 的迁移映射），界面未刷新时点击不会误操作
 * 其他会话的队列（见 RemoteControlBridge 的 sendPendingNow / withdrawPending）。
 */
let renderedSignature = "";
/** 渲染时队列的定位键（不透明标记）：操作请求原样回传，桌面端据此
 *  解析队列真实位置（含新会话槽位→真实 id 的迁移），不因会话切换失效。 */
let renderedQueueKey: string | null = null;

/** 单个附件 / 引用 chip：图标 + 名称，与消息区的附件样式呼应。 */
const chipHtml = (iconHtml: string, name: string, title?: string): string =>
  `<span class="pending-chip"${title ? ` title="${escapeHtml(title)}"` : ""}>${iconHtml}<span class="pending-chip-name">${escapeHtml(name)}</span></span>`;

/** 分段 → 展示 HTML：文本按原文（保留换行）显示，其余渲染为 chip。 */
const blockHtml = (block: SnowRemoteContentBlock): string => {
  if (block.type === "text") {
    return escapeHtml(block.text);
  }
  if (block.type === "image") {
    return chipHtml(
      attachmentIconMarkup(block, 10),
      block.name || t("remote.message.imageAlt"),
    );
  }
  if (block.type === "file") {
    return chipHtml(
      attachmentIconMarkup(block, 10),
      block.name || t("remote.message.attachment"),
      block.name,
    );
  }
  const title = block.detail ? `${block.label} · ${block.detail}` : block.label;
  return chipHtml(
    attachmentIconMarkup(block, 10),
    block.label || t("remote.message.reference"),
    title,
  );
};

export const renderPending = (next: SnowRemoteState | null): void => {
  const host = $("pendingMessages");
  const items = next?.pendingMessages ?? [];
  renderedQueueKey = next?.pendingQueueKey ?? null;
  const signature = renderedQueueKey + "|" + JSON.stringify(items);
  if (signature === renderedSignature) return;
  renderedSignature = signature;

  if (items.length === 0) {
    host.className = "pending-messages";
    host.innerHTML = "";
    return;
  }

  const rows = items
    .map((item, index) => {
      const body = item.blocks.map(blockHtml).join("");
      const sendLabel = escapeHtml(t("remote.pending.sendNow"));
      const withdrawLabel = escapeHtml(t("remote.pending.withdraw"));
      return (
        `<li class="pending-item">` +
        `<span class="pending-item-icon">${iconMarkup("list-end")}</span>` +
        `<span class="pending-item-body">${body}</span>` +
        `<div class="pending-item-actions">` +
        `<button class="pending-action primary" type="button" data-pending-action="send-now" data-pending-index="${index}" aria-label="${sendLabel}" title="${sendLabel}">${iconMarkup("arrow-up")}</button>` +
        `<button class="pending-action" type="button" data-pending-action="withdraw" data-pending-index="${index}" aria-label="${withdrawLabel}" title="${withdrawLabel}">${iconMarkup("undo-2")}</button>` +
        `</div></li>`
      );
    })
    .join("");
  host.className = "pending-messages has-items";
  host.innerHTML = `<ul class="pending-list">${rows}</ul>`;
};

export const initPending = (ctx: AppContext): void => {
  $("pendingMessages").onclick = async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-pending-action]",
    );
    if (!button) return;
    const action = button.dataset.pendingAction;
    const index = Number(button.dataset.pendingIndex);
    if (
      (action !== "send-now" && action !== "withdraw") ||
      !Number.isInteger(index) ||
      index < 0
    ) {
      return;
    }
    button.disabled = true;
    try {
      if (action === "send-now") {
        await sendPendingNow(index, renderedQueueKey);
        showNotice(t("remote.pending.sent"));
      } else {
        const result = await withdrawPending(index, renderedQueueKey);
        if (result.text) {
          restoreInputText(result.text);
        }
        showNotice(t("remote.pending.withdrawn"));
      }
      await ctx.refresh(false);
    } catch (error) {
      showNotice((error as Error).message, true);
      button.disabled = false;
    }
  };
};
