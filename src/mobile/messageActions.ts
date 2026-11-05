import type {
  SnowRemoteMessage,
  SnowRemoteRunStats,
} from "../renderer/types/remoteControl";
import { stripMarkdown } from "../shared/stripMarkdown";
import { forkConversation } from "./api";
import { copyTextToClipboard } from "./clipboard";
import { $, escapeHtml } from "./dom";
import {
  formatDuration,
  formatTtft,
  formatTokenAmount,
  messageTime,
} from "./format";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import { writeBackToMobileInput } from "./inputBridge";
import { showNotice } from "./notice";

/**
 * 消息操作栏（气泡外）：与桌面 UserMessageActions / AiResponseActions 对齐。
 * - 用户消息：时间 + 复制 / 编辑到输入框 / 回滚；
 * - AI 响应：时间 + 原始 Markdown 切换 / 复制（纯文本或 Markdown）/ 分支 / 运行统计。
 */
export type MessageActionsContext = {
  message: SnowRemoteMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
  canRollback: boolean;
  runStats: SnowRemoteRunStats | null;
};

/** 原始 Markdown 视图 / 展开的运行统计：按消息 id 记录，会话切换时清空。 */
const rawMarkdownIds = new Set<string>();
const openStatsIds = new Set<string>();
let redraw: (() => void) | null = null;
let openMenu: HTMLElement | null = null;
let menuCleanup: (() => void) | null = null;

export const setMessageActionsRedraw = (handler: (() => void) | null): void => {
  redraw = handler;
};

export const resetMessageActionsState = (): void => {
  rawMarkdownIds.clear();
  openStatsIds.clear();
  closeCopyMenu();
};

export const isRawMarkdown = (messageId: string): boolean =>
  rawMarkdownIds.has(messageId);

/** 视图状态摘要：参与消息签名，原始 Markdown 切换后内容块必须重建。 */
export const messageActionsDigest = (messageId: string): string =>
  `${rawMarkdownIds.has(messageId) ? "r1" : "r0"}${
    openStatsIds.has(messageId) ? "s1" : "s0"
  }`;

/** 运行统计摘要：统计出现 / 变化时最后一条 AI 消息的操作栏要重建。 */
export const runStatsDigest = (runStats: SnowRemoteRunStats | null): string => {
  if (!runStats) return "0";
  const usage = runStats.tokenUsage;
  return [
    runStats.durationMs,
    runStats.ttftSumMs,
    runStats.requestCount,
    usage?.inputTokens ?? 0,
    usage?.outputTokens ?? 0,
    usage?.cacheReadInputTokens ?? 0,
    usage?.cacheCreationInputTokens ?? 0,
    runStats.model ?? "",
  ].join(":");
};

const actionButton = (
  action: string,
  icon: MobileIconName,
  label: string,
  active = false,
): string =>
  `<button class="message-action${active ? " is-open" : ""}" type="button" data-msg-action="${action}" aria-label="${escapeHtml(
    label,
  )}" title="${escapeHtml(label)}">${iconMarkup(icon)}</button>`;

const timeMarkup = (message: SnowRemoteMessage): string => {
  const time = messageTime(message.timestamp);
  return time ? `<span class="message-time">${escapeHtml(time)}</span>` : "";
};

const flashCheck = (button: HTMLElement): void => {
  const original = button.innerHTML;
  button.innerHTML = iconMarkup("check");
  window.setTimeout(() => {
    if (button.isConnected) button.innerHTML = original;
  }, 1600);
};

/** 用户消息操作栏：与桌面同序（时间 → 复制 → 编辑 → 回滚）。 */
export const buildUserMessageActions = (
  message: SnowRemoteMessage,
  canRollback: boolean,
): HTMLElement => {
  const canEdit = !$("composerRow").hidden;
  const el = document.createElement("div");
  el.className = "message-actions user-actions";
  el.dataset.messageId = message.id;
  el.innerHTML =
    `<div class="message-actions-row">${timeMarkup(message)}` +
    actionButton("copy", "copy", t("remote.message.copy")) +
    (canEdit
      ? actionButton("edit", "file-pen", t("remote.message.edit"))
      : "") +
    (canRollback
      ? actionButton("rollback", "undo-2", t("remote.rollback.actionHint"))
      : "") +
    "</div>";
  return el;
};

const runStatsRows = (stats: SnowRemoteRunStats): string[] => {
  const rows: string[] = [];
  const push = (label: string, value: string, model = false): void => {
    rows.push(
      `<div class="message-run-stats-row"><span class="message-run-stats-label">${escapeHtml(
        label,
      )}</span><span class="message-run-stats-value${
        model ? " is-model" : ""
      }">${value}</span></div>`,
    );
  };
  const usage = stats.tokenUsage;
  const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const outputTokens = usage?.outputTokens ?? 0;
  if (stats.durationMs > 0) {
    push(t("remote.message.stats.duration"), formatDuration(stats.durationMs));
  }
  if (stats.requestCount > 0 && stats.ttftSumMs > 0) {
    push(
      t("remote.message.stats.ttft"),
      formatTtft(stats.ttftSumMs / stats.requestCount),
    );
  }
  if (totalTokens > 0) {
    push(t("remote.message.stats.tokens"), formatTokenAmount(totalTokens));
  }
  if (stats.durationMs > 0 && outputTokens > 0) {
    push(
      t("remote.message.stats.speed"),
      `${(outputTokens / (stats.durationMs / 1000)).toFixed(1)} tok/s`,
    );
  }
  if ((usage?.cacheCreationInputTokens ?? 0) > 0) {
    push(
      t("remote.message.stats.cacheWrite"),
      formatTokenAmount(usage?.cacheCreationInputTokens ?? 0),
    );
  }
  if ((usage?.cacheReadInputTokens ?? 0) > 0) {
    push(
      t("remote.message.stats.cacheRead"),
      formatTokenAmount(usage?.cacheReadInputTokens ?? 0),
    );
  }
  if (stats.model) {
    push(t("remote.message.stats.model"), escapeHtml(stats.model), true);
  }
  return rows;
};

/** AI 响应操作栏：动作可见性与桌面 MessageContent 的 showActions 判定一致。 */
export const buildAssistantMessageActions = (
  context: MessageActionsContext,
): HTMLElement | null => {
  const { message, isLastAssistant, isStreaming, runStats } = context;
  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
  const showActions =
    message.status !== "sending" &&
    !(isLastAssistant && isStreaming) &&
    (!hasToolCalls || isLastAssistant);
  const time = timeMarkup(message);
  const content = message.content || "";
  // 统计入口只在动作可见时提供（与桌面 runStats 只在操作栏展示一致）。
  const stats = isLastAssistant && showActions ? runStats : null;
  const statRows = stats ? runStatsRows(stats) : [];
  if (!time && !showActions && !statRows.length) return null;

  const raw = isRawMarkdown(message.id);
  const statsOpen = openStatsIds.has(message.id) && statRows.length > 0;
  const buttons = showActions
    ? (content
        ? actionButton(
            "raw",
            raw ? "eye" : "file-code",
            raw ? t("remote.message.rendered") : t("remote.message.raw"),
            raw,
          )
        : "") +
      actionButton("copy", "copy", t("remote.message.copy")) +
      actionButton("fork", "git-fork", t("remote.message.fork")) +
      (statRows.length
        ? actionButton(
            "stats",
            "activity",
            t("remote.message.stats"),
            statsOpen,
          )
        : "")
    : "";

  const el = document.createElement("div");
  el.className = "message-actions";
  el.dataset.messageId = message.id;
  el.innerHTML =
    `<div class="message-actions-row">${time}${buttons}</div>` +
    (statRows.length
      ? `<div class="message-run-stats${statsOpen ? " open" : ""}">${statRows.join(
          "",
        )}</div>`
      : "");
  return el;
};

const closeCopyMenu = (): void => {
  menuCleanup?.();
  menuCleanup = null;
  openMenu?.remove();
  openMenu = null;
};

/** 复制菜单：与桌面 MessageCopyButton 一致（纯文本 / Markdown 两种模式）。 */
const openCopyMenu = (anchor: HTMLElement, content: string): void => {
  closeCopyMenu();
  const menu = document.createElement("div");
  menu.className = "message-copy-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML =
    `<button class="message-copy-menu-item" type="button" role="menuitem" data-copy-mode="text">${iconMarkup(
      "file-text",
    )}<span>${escapeHtml(t("remote.message.copyAsText"))}</span></button>` +
    `<button class="message-copy-menu-item" type="button" role="menuitem" data-copy-mode="markdown">${iconMarkup(
      "copy",
    )}<span>${escapeHtml(t("remote.message.copyAsMarkdown"))}</span></button>`;
  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const gap = 6;
  const width = Math.max(168, rect.width);
  const height = menu.offsetHeight || 88;
  const left = Math.min(
    Math.max(8, rect.left),
    Math.max(8, window.innerWidth - width - 8),
  );
  const top =
    rect.bottom + gap + height > window.innerHeight - 8
      ? Math.max(8, rect.top - gap - height)
      : rect.bottom + gap;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.minWidth = `${width}px`;
  openMenu = menu;

  menu.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-copy-mode]",
    );
    if (!item) return;
    const text =
      item.dataset.copyMode === "text" ? stripMarkdown(content) : content;
    closeCopyMenu();
    void copyTextToClipboard(text).then((ok) => {
      showNotice(
        ok ? t("remote.message.copied") : t("remote.message.copyFailed"),
        !ok,
      );
    });
    flashCheck(anchor);
  });

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (menu.contains(target) || anchor.contains(target)) return;
    closeCopyMenu();
  };
  const close = (): void => closeCopyMenu();
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  menuCleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
  };
};

/** 操作栏点击：复制 / 编辑 / 原始 Markdown / 分支 / 运行统计。 */
export const handleMessageAction = async (
  action: string,
  button: HTMLElement,
  message: SnowRemoteMessage,
  conversationId: string | null,
): Promise<void> => {
  const content = message.content || "";
  if (action === "copy") {
    if ((message.role || "assistant") === "assistant") {
      openCopyMenu(button, content);
      return;
    }
    const ok = await copyTextToClipboard(content);
    if (ok) flashCheck(button);
    else showNotice(t("remote.message.copyFailed"), true);
    return;
  }
  if (action === "edit") {
    if (!writeBackToMobileInput(content)) {
      showNotice(t("remote.message.editUnavailable"), true);
      return;
    }
    flashCheck(button);
    $<HTMLTextAreaElement>("input").focus();
    return;
  }
  if (action === "raw") {
    if (rawMarkdownIds.has(message.id)) rawMarkdownIds.delete(message.id);
    else rawMarkdownIds.add(message.id);
    redraw?.();
    return;
  }
  if (action === "stats") {
    const container = button.closest<HTMLElement>(".message-actions");
    const panel = container?.querySelector<HTMLElement>(".message-run-stats");
    if (!container || !panel) return;
    const open = !openStatsIds.has(message.id);
    if (open) openStatsIds.add(message.id);
    else openStatsIds.delete(message.id);
    button.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    panel.classList.toggle("open", open);
    return;
  }
  if (action === "fork") {
    if (!conversationId) {
      showNotice(t("remote.message.forkUnavailable"), true);
      return;
    }
    const forkButton = button as HTMLButtonElement;
    forkButton.disabled = true;
    try {
      await forkConversation(conversationId, message.responseId ?? "");
      showNotice(t("remote.message.forked"));
    } catch (error) {
      showNotice((error as Error).message, true);
    } finally {
      if (forkButton.isConnected) forkButton.disabled = false;
    }
  }
};
