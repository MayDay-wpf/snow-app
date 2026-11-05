import type {
  SnowRemoteMessage,
  SnowRemoteState,
  SnowRemoteToolCall,
} from "../renderer/types/remoteControl";
import { fetchOlderMessages } from "./api";
import {
  compactionCardHtml,
  copyCompactionContent,
  syncCompactionNode,
} from "./compaction";
import { $, escapeHtml } from "./dom";
import { messageTime } from "./format";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { renderMarkdown } from "./markdown";
import { showNotice } from "./notice";
import { openImageLightbox } from "./overlays";
import { openRollbackSheet } from "./rollback";
import { createAskGroupEl, createToolCallEl } from "./tools";
import { correctionDigest } from "./tools/correction";
import {
  attachMessageNode,
  detachMessageNode,
  flushMessageMeasures,
  initViewportVirtualization,
  isMessageVisible,
  markForceVisible,
  messagePlaceholderHeight,
  resetViewportVirtualization,
  setPinnedMessageIds,
} from "./virtualization";
import {
  createWorkflowCard,
  isWorkflowCardTool,
  patchWorkflowCard,
  workflowDigest,
} from "./workflow";

/**
 * 时间线渲染。
 *
 * 渲染策略（避免整段 innerHTML 重建）：
 * - 消息级 diff：按 id 复用消息节点，只有签名变化的消息才会被更新；
 * - 块级 diff：消息内部按「思考 / 正文 / 工具活动 / 光标 / 时间」
 *   分块比较，只替换发生变化的块；details 一律默认折叠（工具执行中 / 思考
 *   进行中都不自动展开，思考折叠时在头部显示单行预览），仅用户手动展开过
 *   的 details 在重建时保留展开状态；未变化的块保持原样；
 * - 工具活动再做工具级 diff，单个工具的流式输出不会重建其余工具；
 * - 视口虚拟化：滚动视口外（含 600px 缓冲）的消息整体卸载内容、只留一个按
 *   实测高度撑开的占位符，回到视口内再重建（见 virtualization.ts）。长会话
 *   下每轮快照的 diff 与布局重排只覆盖视口附近的消息。
 *
 * 消息模型：
 * - knownList 本地单调累积当前会话的全部已知消息（state 的消息窗口 +
 *   通过「加载更早」分页拿到的历史），合并时顺序以快照窗口为准（桌面向前
 *   补页会把更早的消息插到窗口头部，见 mergeKnown），并处理桌面端用户消息落库后
 *   「前端临时 id → 数据库 snowflake id」的原地迁移（见
 *   reconcileRemappedUserIds），避免同一消息以新旧两个 id 重复出现；
 * - 「是否还有更早记录」以桌面会话的 DB 分页状态（state.hasOlderMessages）
 *   为准，移动端自己加载过历史后以服务端响应的 hasMore 为准；
 * - 会话切换时清空并整表重建。
 */

/** 单次「加载更早」的分页大小（服务端限制 <= 50）。 */
const OLDER_PAGE_SIZE = 30;
/** 滚动到距顶部该像素范围内，自动触发加载更早记录。 */
const LOAD_EARLIER_THRESHOLD = 160;
/** 距底部小于该像素视为「在底部」：自动跟随与按钮显隐共用同一阈值。 */
const NEAR_BOTTOM_THRESHOLD = 48;
/** 「滚动到底部」按钮平滑回底的时长（与桌面端 ChatContent 的观感一致）。 */
const SCROLL_TO_BOTTOM_DURATION_MS = 350;

// ── 模块状态 ──────────────────────────────────────────────────────────────

/** 最近一轮 /api/state 快照（本地加载历史后按它重绘）。 */
let currentState: SnowRemoteState | null = null;
/** 当前渲染的会话 id；变化即整表重建。 */
let renderedConversationId: string | null = null;
/** 当前会话累计的已知消息（时间正序，state 窗口 + 分页历史）。 */
let knownList: SnowRemoteMessage[] = [];
const knownIds = new Set<string>();
/** 是否可能还有更早的记录（初始由 state.hasOlderMessages 给出）。 */
let hasOlder = false;
/** 移动端自己是否完成过一次历史分页加载（完成后 hasOlder 以响应为准）。 */
let hasLoadedHistory = false;
let loadingOlder = false;
/** 用户是否停留在底部（决定新消息是否自动跟随）。 */
let userNearBottom = true;
/** 最近一次快照是否处于流式生成：按钮显示运行光环。 */
let streaming = false;
/**
 * 桌面当前会话是否可回滚（子代理 / 节点会话不可回滚）且不在运行中。
 * 字段缺失（未上报该状态的桌面版本）时按可用处理，由桥侧做最终校验。
 */
let rollbackAvailable = false;
/** 平滑回底动画的帧句柄（0 = 空闲；非 0 期间滚动事件属于程序化滚动）。 */
let scrollToBottomAnim = 0;
/**
 * 会话切换过渡态的目标会话 id（null = 无过渡态）：点击会话后立即清空消息区并
 * 显示骨架屏，等桌面端切换结果（快照的 activeConversationId 变成目标会话）到达
 * 再渲染。过渡期间仍指向旧会话的快照不参与消息区渲染——否则骨架屏会被旧会话的
 * 消息顶掉，切换完成后再闪一次。
 */
let switchingTo: string | null = null;

// ── DOM 节点缓存 ──────────────────────────────────────────────────────────

type BlockNode = { key: string; sig: string; el: HTMLElement };
type MessageNode = {
  /** 消息 id；id 迁移（前端临时 id → 数据库 id）时原地更新。 */
  id: string;
  el: HTMLElement;
  /** 可见时承载块内容的 .message-shell；占位符阶段为 null（内容已卸载）。 */
  blockHost: HTMLElement | null;
  blocks: BlockNode[];
  sig: string;
};

/**
 * 视口外消息的占位符类名（高度由 inline style 给出，见 virtualization.ts）：
 * 带该类的节点会被高度测量与观察器逻辑识别为「占位符而非真实内容」。
 */
const MESSAGE_PLACEHOLDER_CLASS = "is-placeholder";

const renderedNodes = new Map<string, MessageNode>();

// ── 消息过滤 ──────────────────────────────────────────────────────────────

/**
 * 工具结果不作为独立消息渲染：assistant 消息的活动块已经包含工具的状态、
 * 参数与输出，独立的 role=tool 消息只在流式生成期间短暂出现（历史回放也
 * 不包含它），因此统一不进入消息列表。
 */
const isRenderableMessage = (message: SnowRemoteMessage): boolean =>
  (message.role || "assistant") !== "tool";

// ── 回滚入口 ──────────────────────────────────────────────────────────────

/**
 * 该消息是否展示回滚入口：用户消息 + 桌面会话可回滚（子代理 / 节点会话不可）。
 * 桌面按分页加载会话消息，手机上「加载更早」取回的历史消息同样可回滚——桥侧
 * 会先沿桌面同一条历史加载通道把目标消息翻页加载进内存再发起回滚。
 */
const canRollbackMessage = (message: SnowRemoteMessage): boolean =>
  (message.role || "assistant") === "user" && rollbackAvailable;

/**
 * 用户消息上的回滚入口：点击打开回滚确认弹层（与桌面 UserMessageActions 的
 * 回滚按钮同语义，文案与无障碍标签一并对齐）。回滚本身完全复用桌面逻辑，
 * 手机端只负责发起与确认。
 */
const rollbackActionNode = (messageId: string): HTMLElement => {
  const row = document.createElement("div");
  row.className = "message-rollback";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-rollback-button";
  button.dataset.rollback = messageId;
  button.title = t("remote.rollback.actionHint");
  button.setAttribute("aria-label", t("remote.rollback.actionHint"));
  button.innerHTML = `${iconMarkup("undo-2")}<span>${escapeHtml(
    t("remote.rollback.action"),
  )}</span>`;
  row.append(button);
  return row;
};

// ── 通用工具 ──────────────────────────────────────────────────────────────

/** 按位置对齐子元素：复用元素只移动不重建，多余节点会被清理。 */
const alignChildren = (parent: HTMLElement, els: HTMLElement[]): void => {
  for (let i = 0; i < els.length; i += 1) {
    const current = parent.children[i];
    if (current !== els[i]) {
      parent.insertBefore(els[i], current ?? null);
    }
  }
  while (parent.children.length > els.length) {
    parent.lastElementChild?.remove();
  }
};

const htmlToElement = (html: string): HTMLElement => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return (
    (template.content.firstElementChild as HTMLElement | null) ??
    document.createElement("div")
  );
};

/** 低成本内容签名：长度 + 头尾采样，避免每轮比较超长全文。 */
const contentDigest = (value: string): string =>
  value.length <= 64
    ? value
    : `${value.length}\u0003${value.slice(0, 32)}\u0003${value.slice(-32)}`;

/** 折叠头部单行思考预览的字符上限（与桌面端 ThinkingBlock 一致）。 */
const THINKING_PREVIEW_MAX_CHARS = 150;
const THINKING_PREVIEW_SCAN_CHARS = THINKING_PREVIEW_MAX_CHARS * 4;

/** 折叠头部的思考单行预览：去换行后取尾部，过长时加前导省略号。 */
const thinkingPreviewText = (content: string): string => {
  if (!content) return "";
  const hasMore = content.length > THINKING_PREVIEW_SCAN_CHARS;
  const tail = (
    hasMore ? content.slice(-THINKING_PREVIEW_SCAN_CHARS) : content
  ).replace(/[\n\r\t]+/g, " ");
  if (tail.length <= THINKING_PREVIEW_MAX_CHARS) {
    return hasMore ? "…" + tail : tail;
  }
  return "…" + tail.slice(-THINKING_PREVIEW_MAX_CHARS);
};

/**
 * 「思考中」显示判定，与桌面端 ChatMessageList 的门控一致：运行时标记
 * isThinkingActive 只在首个正文增量 / 重试时复位，消息落定（sent / error /
 * incomplete）后不会清零。因此必须叠加「消息仍在流式生成」（status=sending），
 * 否则思考已结束的消息会一直显示「Snow 正在思考」。
 */
const isThinkingDisplayActive = (message: SnowRemoteMessage): boolean =>
  Boolean(message.isThinkingActive) && message.status === "sending";

/**
 * 把旧元素的展开状态带给重建后的新元素。程序从不自动展开 details
 * （工具执行中 / 思考进行中也都保持折叠），因此 `open === true` 只可能
 * 来自用户点击；重建时保留它，避免流式更新打断用户阅读。
 */
const inheritUserOpen = (
  oldEl: HTMLElement | null | undefined,
  newEl: HTMLElement,
): void => {
  if (
    oldEl instanceof HTMLDetailsElement &&
    newEl instanceof HTMLDetailsElement &&
    oldEl.open
  ) {
    newEl.open = true;
  }
};

/**
 * 折叠块展开 / 收起：状态类 .tc-expanded 挂在最近的折叠容器上（框架的
 * .tc-fold；兼容直接用 .tc-pre 表达折叠的写法），按钮文案随状态更新，
 * 模块自带的双文案按钮（.tc-more-show / .tc-more-hide）由 CSS 按状态切换。
 */
const toggleFold = (button: HTMLButtonElement): void => {
  const fold = button.closest<HTMLElement>(".tc-fold, .tc-pre");
  if (!fold) return;
  const expanded = fold.classList.toggle("tc-expanded");
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  const label = button.querySelector<HTMLElement>(".tc-more-label");
  if (label) {
    label.textContent = t(
      expanded
        ? "remote.toolCall.common.collapse"
        : "remote.toolCall.common.expand",
    );
  }
};

const toolSignature = (tool: SnowRemoteToolCall): string =>
  [
    tool.interactionId,
    tool.name,
    tool.status,
    (tool.arguments || "").length,
    (tool.result || "").length,
    (tool.streamingStdout || "").length,
    (tool.streamingStderr || "").length,
    // 纠错 Agent 的尝试 / 状态 / 结果变化必须触发工具卡重建。
    correctionDigest(tool.correction),
    // workflow 卡片快照（节点进度）参与签名：快照变化必须让消息签名变化，
    // 否则块级 diff 会被消息签名短路，卡片进度冻结。
    workflowDigest(tool.workflow),
  ].join("\u0001");

const toolSummary = (tools: SnowRemoteToolCall[] | undefined): string =>
  (tools ?? []).map(toolSignature).join("\u0002");

/** user 消息的附件/引用块（与旧版整段渲染保持相同结构）。 */
const userContentBlocksHtml = (message: SnowRemoteMessage): string => {
  if (!Array.isArray(message.contentBlocks)) {
    return `<div class="markdown">${renderMarkdown(message.content || "")}</div>`;
  }
  return (
    '<div class="message-content-blocks">' +
    message.contentBlocks
      .map((block) => {
        if (block.type === "text") {
          return `<div class="markdown">${renderMarkdown(block.text || "")}</div>`;
        }
        if (
          block.type === "image" &&
          /^\/api\/message-images\/[A-Za-z0-9_%.-]+\/\d+$/.test(
            block.source || "",
          )
        ) {
          return `<img class="remote-image" src="${escapeHtml(block.source)}" alt="${escapeHtml(block.name || t("remote.message.imageAlt"))}" loading="lazy">`;
        }
        const name =
          (block.type === "reference" ? block.label : block.name) ||
          t("remote.message.attachment");
        const detail =
          block.type === "file"
            ? block.isDirectory
              ? t("remote.message.folder")
              : t("remote.message.file")
            : block.type === "reference"
              ? block.detail || block.kind || t("remote.message.reference")
              : t("remote.message.reference");
        const icon =
          block.type === "file"
            ? block.isDirectory
              ? iconMarkup("folder")
              : iconMarkup("file")
            : iconMarkup("arrow-up-right");
        return `<div class="remote-attachment"><span class="remote-attachment-icon">${icon}</span><span class="remote-attachment-copy"><div class="remote-attachment-name">${escapeHtml(name)}</div><div class="remote-attachment-detail">${escapeHtml(detail)}</div></span></div>`;
      })
      .join("") +
    "</div>"
  );
};

// ── 工具（详情）元素 ──────────────────────────────────────────────────────

/** 需要合并为 Tab 容器的提问工具名。 */
const ASK_TOOL_NAME = "user-interaction-askUserQuestion";

type ToolListEntry = {
  /** dataset.toolId：工具级 diff 的复用键。 */
  id: string;
  /** dataset.sig：条目签名，任一子项变化都需要重建。 */
  sig: string;
  /** 创建元素；提问组按 old 上的 activeTab 保留用户停留的 Tab。 */
  create: (old?: HTMLElement) => HTMLElement;
};

const singleToolEntry = (tool: SnowRemoteToolCall): ToolListEntry => ({
  id: tool.interactionId,
  sig: toolSignature(tool),
  create: (old) => createToolCallEl(tool, old),
});

/**
 * 工具列表条目：相邻的多个提问合并为一个 Tab 容器（≥2 才合并，单个提问
 * 保持原卡片形态），其余工具逐个成卡（顺序不变）。
 */
const buildToolEntries = (tools: SnowRemoteToolCall[]): ToolListEntry[] => {
  const entries: ToolListEntry[] = [];
  for (let i = 0; i < tools.length;) {
    if (tools[i].name !== ASK_TOOL_NAME) {
      entries.push(singleToolEntry(tools[i]));
      i += 1;
      continue;
    }
    let j = i;
    while (j < tools.length && tools[j].name === ASK_TOOL_NAME) j += 1;
    if (j - i >= 2) {
      const group = tools.slice(i, j);
      entries.push({
        // 以首问 interactionId 命名：组内追加提问时复用键保持稳定
        id: `ask-group:${group[0].interactionId}`,
        sig: `ask-group\u0001${group.map(toolSignature).join("\u0002")}`,
        create: (old) => createAskGroupEl(group, old?.dataset.activeTab),
      });
    } else {
      entries.push(singleToolEntry(tools[i]));
    }
    i = j;
  }
  return entries;
};

/**
 * 工具级 keyed diff：卡片由 tools/index.ts 的派发器渲染（精确名 → 前缀 →
 * 兜底），这里只重建签名变化的条目；dataset.toolId / dataset.sig 是复用
 * 判定依据，用户展开状态跨重建保留。
 */
const syncToolList = (host: HTMLElement, tools: SnowRemoteToolCall[]): void => {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(host.children)) {
    const el = child as HTMLElement;
    const id = el.dataset.toolId ?? "";
    if (id) existing.set(id, el);
  }

  const nextEls: HTMLElement[] = [];
  for (const entry of buildToolEntries(tools)) {
    const old = existing.get(entry.id);
    existing.delete(entry.id);
    if (old && old.dataset.sig === entry.sig) {
      nextEls.push(old);
      continue;
    }
    const el = entry.create(old);
    el.dataset.toolId = entry.id;
    el.dataset.sig = entry.sig;
    inheritUserOpen(old, el);
    old?.remove();
    nextEls.push(el);
  }

  for (const old of existing.values()) old.remove();
  alignChildren(host, nextEls);
};

// ── 块定义 ────────────────────────────────────────────────────────────────

type BlockSpec = {
  key: string;
  sig: string;
  create: () => HTMLElement;
  /** 可选原地更新（工具活动块用它做工具级 diff，避免重建整个块）。 */
  patch?: (el: HTMLElement) => void;
};

const contentBlockSig = (message: SnowRemoteMessage): string => {
  const blocks = message.contentBlocks;
  if (!Array.isArray(blocks)) return contentDigest(message.content || "");
  return (
    contentDigest(message.content || "") +
    "\u0001" +
    blocks
      .map((block) =>
        block.type === "text"
          ? `t${block.text.length}`
          : block.type === "image"
            ? `i${block.source}`
            : block.type === "file"
              ? `f${block.name}${block.isDirectory ? "d" : "f"}`
              : `r${block.kind}${block.label}${block.detail ?? ""}`,
      )
      .join("\u0002")
  );
};

const buildMessageBlocks = (
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): BlockSpec[] => {
  const role = message.role || "assistant";
  const body = message.content || "";
  const blocks: BlockSpec[] = [];

  const thinking = message.thinking || "";
  if (thinking) {
    const thinkingActive = isThinkingDisplayActive(message);
    const summaryText = thinkingActive
      ? t("remote.message.thinkingActive")
      : message.thinkingDurationMs
        ? t("remote.message.thinkingDone", {
            seconds: Math.max(1, Math.round(message.thinkingDurationMs / 1000)),
          })
        : t("remote.message.thinkingView");
    // 折叠头部的单行预览：仅思考进行中展示（参考桌面端 ThinkingBlock）。
    const preview = thinkingActive ? thinkingPreviewText(thinking) : "";
    blocks.push({
      key: "thinking",
      sig: `${contentDigest(thinking)}|${thinkingActive ? 1 : 0}|${message.thinkingDurationMs ?? 0}`,
      create: () => {
        const details = document.createElement("details");
        details.className = "thinking";
        const summary = document.createElement("summary");
        const title = document.createElement("span");
        title.className = "thinking-title";
        title.textContent = summaryText;
        summary.append(title);
        if (preview) {
          const previewEl = document.createElement("span");
          previewEl.className = "thinking-preview";
          previewEl.textContent = preview;
          summary.append(previewEl);
        }
        const content = document.createElement("div");
        content.className = "thinking-body";
        content.textContent = thinking;
        details.append(summary, content);
        return details;
      },
    });
  }

  // 块顺序与桌面端 AiResponse 一致：思考 → 正文 → 工具活动。
  blocks.push({
    key: "content",
    sig: contentBlockSig(message),
    create: () =>
      htmlToElement(
        role === "user"
          ? Boolean(message.isContextCompaction)
            ? compactionCardHtml(message.id, body)
            : userContentBlocksHtml(message)
          : `<div class="markdown">${renderMarkdown(body)}</div>`,
      ),
  });

  // 回滚入口（仅用户消息）：与桌面版同在消息动作区，位于正文之后。
  if (canRollbackMessage(message)) {
    blocks.push({
      key: "rollback",
      sig: "rollback",
      create: () => rollbackActionNode(message.id),
    });
  }

  const tools = message.toolCalls ?? [];
  // workflow 卡片单独成块：卡片不适合折叠的工具行渲染，块级 diff 也让
  // 节点进度更新（patch）不会重建其它工具条目。
  const activityTools = tools.filter((tool) => !isWorkflowCardTool(tool));
  if (activityTools.length) {
    blocks.push({
      key: "activity",
      sig: toolSummary(activityTools),
      create: () => {
        const el = document.createElement("div");
        el.className = "activity";
        syncToolList(el, activityTools);
        return el;
      },
      patch: (el) => syncToolList(el, activityTools),
    });
  }
  for (const tool of tools) {
    if (!isWorkflowCardTool(tool)) continue;
    blocks.push({
      key: `workflow:${tool.interactionId}`,
      sig: workflowDigest(tool.workflow),
      create: () => createWorkflowCard(tool),
      patch: (el) => patchWorkflowCard(el, tool),
    });
  }

  if (isStreaming && index === total - 1 && role === "assistant") {
    blocks.push({
      key: "caret",
      sig: "caret",
      create: () => {
        const el = document.createElement("span");
        el.className = "streaming-caret";
        return el;
      },
    });
  }

  const time = messageTime(message.timestamp);
  if (time) {
    blocks.push({
      key: "time",
      sig: time,
      create: () => {
        const el = document.createElement("div");
        el.className = "message-time";
        el.textContent = time;
        return el;
      },
    });
  }

  return blocks;
};

/** 块级 diff：签名未变的块保持原 DOM（含 details 展开状态）。 */
const syncBlocks = (
  host: HTMLElement,
  blocks: BlockNode[],
  specs: BlockSpec[],
): BlockNode[] => {
  const byKey = new Map(blocks.map((block) => [block.key, block]));
  const nextBlocks: BlockNode[] = [];
  const nextEls: HTMLElement[] = [];

  for (const spec of specs) {
    const existing = byKey.get(spec.key);
    if (existing && existing.sig === spec.sig) {
      nextBlocks.push(existing);
      nextEls.push(existing.el);
      continue;
    }
    if (existing && spec.patch) {
      spec.patch(existing.el);
      nextBlocks.push({ key: spec.key, sig: spec.sig, el: existing.el });
      nextEls.push(existing.el);
      continue;
    }
    const el = spec.create();
    // 程序从不自动展开 details；旧元素处于展开只可能来自用户操作，
    // 重建时保留（未变化的块整体保留，同样不受刷新影响）。
    inheritUserOpen(existing?.el, el);
    existing?.el.remove();
    nextBlocks.push({ key: spec.key, sig: spec.sig, el });
    nextEls.push(el);
  }

  for (const block of blocks) {
    if (!nextBlocks.some((next) => next.el === block.el)) block.el.remove();
  }
  alignChildren(host, nextEls);
  return nextBlocks;
};

// ── 消息节点 ──────────────────────────────────────────────────────────────

const messageSignature = (
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): string => {
  const role = message.role || "assistant";
  const caret = isStreaming && index === total - 1 && role === "assistant";
  return [
    message.id,
    role,
    message.status || "",
    contentBlockSig(message),
    contentDigest(message.thinking || ""),
    isThinkingDisplayActive(message) ? "t1" : "t0",
    String(message.thinkingDurationMs ?? 0),
    caret ? "c1" : "c0",
    message.isContextCompaction ? "k1" : "k0",
    toolSummary(message.toolCalls),
    contentDigest(message.content || ""),
    // 回滚入口的显隐参与签名：可回滚状态变化（流式起止 / 会话切换）必须触发重建。
    canRollbackMessage(message) ? "r1" : "r0",
  ].join("\u0001");
};

/** 消息 article 的角色类名；占位符阶段不带角色类（气泡等装饰不参与绘制）。 */
const messageElementClass = (role: string, isCompaction: boolean): string => {
  if (role === "user" && isCompaction) return "message compaction";
  return role === "user" || role === "assistant"
    ? `message ${role}`
    : "message";
};

/**
 * 占位符化：卸载全部内容（.message-shell 及其块），按缓存的实测高度撑开
 * article。节点保持挂载并被观察，滚回视口时才能在 updateMessageNode 里复活。
 */
const placeMessageNode = (node: MessageNode): MessageNode => {
  if (node.blockHost === null) return node;
  for (const block of node.blocks) block.el.remove();
  node.blocks = [];
  node.blockHost.remove();
  node.blockHost = null;
  node.sig = "";
  node.el.className = `message ${MESSAGE_PLACEHOLDER_CLASS}`;
  node.el.style.height = `${messagePlaceholderHeight(node.id)}px`;
  node.el.setAttribute("aria-hidden", "true");
  return node;
};

/** 为从未渲染过内容的消息直接创建占位符（远端新增但当前在视口外）。 */
const createPlaceholderNode = (id: string): MessageNode => {
  const el = document.createElement("article");
  el.className = `message ${MESSAGE_PLACEHOLDER_CLASS}`;
  el.style.height = `${messagePlaceholderHeight(id)}px`;
  el.setAttribute("aria-hidden", "true");
  attachMessageNode(id, el);
  return { id, el, blockHost: null, blocks: [], sig: "" };
};

/**
 * 占位符 → 真实内容：重建 .message-shell，块由紧随其后的块级 diff 填充。
 * 复活不是「新消息入场」：抑制入场动画，避免快速滚动时消息不断淡入。
 */
const reviveMessageNode = (
  node: MessageNode,
  message: SnowRemoteMessage,
): HTMLElement => {
  node.el.className = messageElementClass(
    message.role || "assistant",
    Boolean(message.isContextCompaction),
  );
  node.el.style.height = "";
  node.el.style.animation = "none";
  node.el.removeAttribute("aria-hidden");
  const shell = document.createElement("div");
  shell.className = "message-shell";
  node.el.append(shell);
  node.blockHost = shell;
  node.blocks = [];
  node.sig = "";
  // 复活后内容高度可能与占位符不同：重新登记并排队一次实测。
  attachMessageNode(node.id, node.el);
  return shell;
};

/**
 * 构造真实内容节点。虚拟化观察器登记（attachMessageNode）由调用方负责：
 * 重复 id 的兜底节点不参与虚拟化，因此不注册。
 */
const createMessageNode = (
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): MessageNode => {
  const el = document.createElement("article");
  el.className = messageElementClass(
    message.role || "assistant",
    Boolean(message.isContextCompaction),
  );
  const shell = document.createElement("div");
  shell.className = "message-shell";
  el.append(shell);
  const blocks = syncBlocks(
    shell,
    [],
    buildMessageBlocks(message, index, total, isStreaming),
  );
  return {
    id: message.id,
    el,
    blockHost: shell,
    blocks,
    sig: messageSignature(message, index, total, isStreaming),
  };
};

const updateMessageNode = (
  node: MessageNode,
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): void => {
  // 占位符（视口外卸载过内容）先复活，真实内容再走下面的块级 diff。
  const host = node.blockHost ?? reviveMessageNode(node, message);
  const signature = messageSignature(message, index, total, isStreaming);
  if (signature === node.sig) return;
  node.sig = signature;
  node.blocks = syncBlocks(
    host,
    node.blocks,
    buildMessageBlocks(message, index, total, isStreaming),
  );
};

// ── 消息区装配 ────────────────────────────────────────────────────────────

const emptyHtml = (): string =>
  `<div class="empty"><div><img class="snow-logo" src="/icon.png" alt=""><strong>${t("remote.empty.start.title")}</strong><span>${t("remote.empty.start.detail")}</span></div></div>`;

const paintEmpty = (): void => {
  const container = $("messages");
  setSkeletonContainer(false);
  const html = emptyHtml();
  if (container.dataset.emptyHtml === html) return;
  container.dataset.emptyHtml = html;
  container.innerHTML = html;
};

/** 骨架屏单行占位（条数与排布见 skeletonHtml）。 */
const SKELETON_LINE = '<span class="message-skeleton-line"></span>';

/**
 * 骨架屏容器态：消息区占满可视高度并垂直居中骨架屏（见 styles/app.css）。
 * 不挂类时骨架屏会贴在消息区顶部、下方留一大片空白，与桌面端
 * .chat-area.is-loading-history 的居中观感不一致。
 */
const SKELETON_CONTAINER_CLASS = "is-switching";

/** 切换骨架屏容器态（进入过渡态时开启，真实内容 / 空态接管时关闭）。 */
const setSkeletonContainer = (active: boolean): void => {
  $("messages").classList.toggle(SKELETON_CONTAINER_CLASS, active);
};

/** 会话切换骨架屏：3 条与真实消息同构的占位（assistant / user / assistant）。 */
const skeletonHtml = (): string => {
  const items = [
    { tone: "is-assistant", lines: 3 },
    { tone: "is-user", lines: 2 },
    { tone: "is-assistant", lines: 2 },
  ];
  return (
    `<div class="message-skeleton" aria-hidden="true">` +
    items
      .map(
        (item) =>
          `<div class="message-skeleton-item ${item.tone}">${SKELETON_LINE.repeat(item.lines)}</div>`,
      )
      .join("") +
    `</div>`
  );
};

/** 消息区当前是否仍是会话切换骨架屏（离线占位等其它内容接管后即为否）。 */
const skeletonVisible = (): boolean =>
  $("messages").firstElementChild?.classList.contains("message-skeleton") ===
  true;

/** 清空消息区并绘制骨架屏（会话切换过渡态，见 beginConversationSwitch）。 */
const paintSkeleton = (): void => {
  clearRenderedNodes();
  resetViewportVirtualization();
  cancelScrollToBottomAnim();
  const container = $("messages");
  // 空态标记必须清掉：否则恢复消息态时 paintEmpty 会认为占位内容仍是它画的，
  // 直接跳过重绘，骨架屏会一直留在页面上。
  delete container.dataset.emptyHtml;
  container.innerHTML = skeletonHtml();
  setSkeletonContainer(true);
  $("timeline").scrollTop = 0;
  updateLoadEarlierButton();
  syncScrollToBottomButton();
};

/** 清空全部消息节点（同时停止虚拟化观察）。 */
const clearRenderedNodes = (): void => {
  for (const node of renderedNodes.values()) {
    detachMessageNode(node.id);
    node.el.remove();
  }
  renderedNodes.clear();
};

const reconcileMessages = (rebuild: boolean): void => {
  const container = $("messages");
  const state = currentState;
  if (!state) return;
  // 真实内容（或空态）接管消息区：撤下骨架屏容器态。
  setSkeletonContainer(false);
  const isStreaming = state.isStreaming;

  if (rebuild) {
    clearRenderedNodes();
    container.textContent = "";
    delete container.dataset.emptyHtml;
    // 会话切换：消息 id 与滚动位置都换了，虚拟化状态与高度缓存全部失效。
    resetViewportVirtualization();
  }

  if (!knownList.length) {
    clearRenderedNodes();
    resetViewportVirtualization();
    paintEmpty();
    return;
  }

  if (container.dataset.emptyHtml || renderedNodes.size === 0) {
    // 从空态（或静态连接占位）进入消息态：清掉占位内容。
    container.textContent = "";
    delete container.dataset.emptyHtml;
  }

  const total = knownList.length;
  const nextEls: HTMLElement[] = [];
  const nextIdSet = new Set<string>();
  for (let index = 0; index < total; index += 1) {
    const message = knownList[index];
    const id = message.id;
    if (nextIdSet.has(id)) {
      // 异常数据（重复 id）：不复用缓存，构造独立节点保证列表结构正确。
      // 该节点不参与虚拟化（同一个 id 无法被观察器稳定跟踪），始终真实渲染。
      nextEls.push(createMessageNode(message, index, total, isStreaming).el);
      continue;
    }
    nextIdSet.add(id);
    const node = renderedNodes.get(id);
    if (!isMessageVisible(id)) {
      // 视口外：卸载内容，只留按实测高度撑开的占位符（高度不变 → 滚动条不跳）。
      nextEls.push(
        (node ? placeMessageNode(node) : createPlaceholderNode(id)).el,
      );
      continue;
    }
    if (!node) {
      const created = createMessageNode(message, index, total, isStreaming);
      attachMessageNode(id, created.el);
      renderedNodes.set(id, created);
      nextEls.push(created.el);
      continue;
    }
    // 占位符在此复活（updateMessageNode 内部处理）。
    updateMessageNode(node, message, index, total, isStreaming);
    nextEls.push(node.el);
  }

  for (const [id, node] of Array.from(renderedNodes.entries())) {
    if (!nextIdSet.has(id)) {
      detachMessageNode(id);
      node.el.remove();
      renderedNodes.delete(id);
    }
  }

  const compactionEl = syncCompactionNode(state);
  const expected = new Set<Element>(nextEls);
  if (compactionEl) expected.add(compactionEl);
  for (const child of Array.from(container.children)) {
    if (!expected.has(child)) child.remove();
  }
  alignChildren(container, nextEls);
  if (compactionEl) container.append(compactionEl);
  flushMessageMeasures();
};

/** 取消进行中的平滑回底动画。 */
const cancelScrollToBottomAnim = (): void => {
  if (scrollToBottomAnim !== 0) {
    cancelAnimationFrame(scrollToBottomAnim);
    scrollToBottomAnim = 0;
  }
};

/**
 * 同步「滚动到底部」按钮：离开底部即显示（显隐阈值与自动跟随共用，和
 * 桌面端行为一致）；流式生成期间显示光环；平滑回底动画期间保持隐藏。
 */
const syncScrollToBottomButton = (): void => {
  const timeline = $("timeline");
  const button = $<HTMLButtonElement>("scrollToBottomButton");
  const distance =
    timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
  button.hidden = scrollToBottomAnim !== 0 || distance < NEAR_BOTTOM_THRESHOLD;
  button.classList.toggle("streaming", streaming);
};

/** 平滑滚动回底部：easeOutCubic 补间；流式期间内容增高时每帧重取目标追赶。 */
const scrollTimelineToBottom = (timeline: HTMLElement): void => {
  cancelScrollToBottomAnim();
  userNearBottom = true;
  const startTop = timeline.scrollTop;
  const startTime = performance.now();
  const tick = (now: number): void => {
    const maxTop = timeline.scrollHeight - timeline.clientHeight;
    const progress = Math.min(
      1,
      (now - startTime) / SCROLL_TO_BOTTOM_DURATION_MS,
    );
    const eased = 1 - Math.pow(1 - progress, 3);
    const nextTop = Math.min(startTop + (maxTop - startTop) * eased, maxTop);
    timeline.scrollTop = nextTop;
    if (progress >= 1 || nextTop >= maxTop - 1) {
      scrollToBottomAnim = 0;
      timeline.scrollTop = maxTop;
      syncScrollToBottomButton();
      return;
    }
    scrollToBottomAnim = requestAnimationFrame(tick);
  };
  scrollToBottomAnim = requestAnimationFrame(tick);
  syncScrollToBottomButton();
};

/**
 * 视口高度变化（软键盘弹出 / 收起、旋转）后保持贴底。
 *
 * 只在用户原本就贴在底部时补偿，避免打断正在阅读历史的人；供 main.ts 的
 * visualViewport 监听调用——键盘弹起会让消息区变矮，不补偿会把正在看的
 * 正文尾部顶出视口。
 */
export const stickToBottomIfNear = (threshold = 48): void => {
  const timeline = $("timeline");
  const distance =
    timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
  if (distance >= threshold) return;
  cancelScrollToBottomAnim();
  userNearBottom = true;
  timeline.scrollTop = timeline.scrollHeight;
  syncScrollToBottomButton();
};

const paint = (options: {
  follow: boolean;
  anchorEl: HTMLElement | null;
  rebuild?: boolean;
}): void => {
  const timeline = $("timeline");
  const anchorEl = options.anchorEl;
  // 在更新前记录锚点位置；更新后回补滚动偏移，保证视口内容不跳动。
  const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : null;

  reconcileMessages(Boolean(options.rebuild));

  if (anchorEl !== null && anchorTop !== null) {
    timeline.scrollTop += anchorEl.getBoundingClientRect().top - anchorTop;
    return;
  }

  requestAnimationFrame(() => {
    // 跟随底部：抢占进行中的平滑回底动画，直接钉底避免动画向旧目标回写。
    if (options.follow) {
      cancelScrollToBottomAnim();
      timeline.scrollTop = timeline.scrollHeight;
    }
    syncScrollToBottomButton();
  });
};

// ── 历史分页 ──────────────────────────────────────────────────────────────

let earlierButtonKey = "";
/** 分页请求代际：会话切换或并发保护时递增，使在途请求失效。 */
let loadGeneration = 0;

const updateLoadEarlierButton = (): void => {
  const hasMessages = knownList.length > 0;
  const key = `${loadingOlder ? 1 : 0}|${hasOlder ? 1 : 0}|${hasMessages ? 1 : 0}`;
  if (key === earlierButtonKey) return;
  earlierButtonKey = key;
  const button = $<HTMLButtonElement>("loadEarlier");
  button.classList.toggle("loading", loadingOlder);
  button.disabled = loadingOlder;
  $("loadEarlierLabel").textContent = loadingOlder
    ? t("remote.timeline.loadingEarlier")
    : t("remote.timeline.loadEarlier");
  // 没有已知消息（空会话 / 新建会话）时不存在「更早的记录」入口。
  button.hidden = !loadingOlder && (!hasOlder || !hasMessages);
};

const loadEarlier = async (): Promise<void> => {
  const conversationId = renderedConversationId;
  if (!conversationId || loadingOlder || !hasOlder || !knownList.length) {
    return;
  }
  loadingOlder = true;
  loadGeneration += 1;
  const generation = loadGeneration;
  updateLoadEarlierButton();
  try {
    const page = await fetchOlderMessages(
      conversationId,
      knownList[0].id,
      OLDER_PAGE_SIZE,
    );
    if (
      generation !== loadGeneration ||
      conversationId !== renderedConversationId
    ) {
      return;
    }
    const fresh = page.items.filter(
      (item) => !knownIds.has(item.id) && isRenderableMessage(item),
    );
    if (fresh.length) {
      const anchorEl =
        ($("messages").firstElementChild as HTMLElement | null) ?? null;
      knownList = [...fresh, ...knownList];
      for (const item of fresh) knownIds.add(item.id);
      // 新分页的消息先按真实内容挂载（观察器首批报告后再交还常规判定）：
      // 它们尚未被测量过，若先以 80px 占位符存在，下面的滚动锚点回补会按
      // 占位符几何校正而偏小，真实内容展开时视口内容被顶下去。
      markForceVisible(fresh.map((item) => item.id));
      paint({ follow: false, anchorEl });
    }
    hasOlder = page.hasMore;
    hasLoadedHistory = true;
  } catch (error) {
    if (generation === loadGeneration) {
      showNotice((error as Error).message, true);
    }
  } finally {
    if (generation === loadGeneration) {
      loadingOlder = false;
      updateLoadEarlierButton();
    }
  }
};

/**
 * 桌面端会在用户消息落库后把前端临时 id（`user-…`）原地替换为数据库
 * snowflake id（数字串，见 renderer 的 remapPersistedUserMessageIds）。
 * 移动端按 id 累积消息且从不移除旧条目，若不处理这层迁移，同一条消息会以
 * 「临时 id 副本 + 数字 id 副本」出现两次（刷新页面整表重建才恢复）。判定
 * 与桌面端一致：纯数字串为持久化 id，其余为前端临时 id。
 */
const isFrontendId = (id: string): boolean => Number.isNaN(Number(id));

/**
 * id 迁移的消息身份签名：角色 + 时间 + 正文/内容块摘要。图片块 source 中的
 * 消息 id（`/api/message-images/<messageId>/<n>`）会随迁移一起变化，比较前
 * 先归一化该段。
 */
const remapIdentity = (message: SnowRemoteMessage): string => {
  const blocks = message.contentBlocks;
  const blockSig = Array.isArray(blocks)
    ? blocks
        .map((block) => {
          if (block.type === "text")
            return `t${contentDigest(block.text || "")}`;
          if (block.type === "image")
            return `i${block.name}\u0003${block.source.replace(
              /^\/api\/message-images\/[^/]+\//,
              "/api/message-images/",
            )}`;
          if (block.type === "file")
            return `f${block.name}${block.isDirectory ? "d" : "f"}`;
          return `r${block.kind}${block.label}${block.detail ?? ""}`;
        })
        .join("\u0002")
    : contentDigest(message.content || "");
  return `${message.role || "assistant"}\u0001${message.timestamp}\u0001${blockSig}`;
};

/**
 * 合并快照前的 id 迁移对账：
 * 1. 快照中已消失的临时 id 用户消息与快照中新出现的数字 id 用户消息按序
 *    配对（身份签名一致才迁移），原地换 id，DOM 节点缓存跟随换 key；
 * 2. 数字副本已在本地、只剩临时 id 残留的旧副本：把数字副本移回临时副本
 *    的原位置并清理残留，恢复正确顺序（同时修复已产生的历史性重复）。
 */
const reconcileRemappedUserIds = (incoming: SnowRemoteMessage[]): void => {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const staleIndexes: number[] = [];
  knownList.forEach((message, index) => {
    if ((message.role || "assistant") !== "user") return;
    if (!isFrontendId(message.id)) return;
    if (incomingIds.has(message.id)) return;
    staleIndexes.push(index);
  });
  if (!staleIndexes.length) return;

  const freshPersisted = incoming.filter(
    (message) =>
      (message.role || "assistant") === "user" &&
      !isFrontendId(message.id) &&
      !knownIds.has(message.id),
  );

  // 1. 按序配对迁移。
  const pairs = Math.min(staleIndexes.length, freshPersisted.length);
  for (let i = 0; i < pairs; i += 1) {
    const index = staleIndexes[i];
    const previous = knownList[index];
    const next = freshPersisted[i];
    if (remapIdentity(previous) !== remapIdentity(next)) continue;
    knownIds.delete(previous.id);
    knownIds.add(next.id);
    knownList[index] = next;
    const node = renderedNodes.get(previous.id);
    if (node) {
      renderedNodes.delete(previous.id);
      renderedNodes.set(next.id, node);
      // 虚拟化观察器按 id 绑定：随迁移重新登记（占位符节点同样适用），并
      // 在新 id 被观察器判定前保持真实渲染，避免迁移瞬间的消息位置跳变。
      detachMessageNode(previous.id);
      node.id = next.id;
      attachMessageNode(next.id, node.el);
      markForceVisible([next.id]);
    }
  }

  // 2. 修复残留：数字副本已在本地时，把它移回临时副本的原位置。
  const placed = new Set<number>();
  const removals = new Set<number>();
  for (const index of staleIndexes) {
    const stale = knownList[index];
    if (!stale || !isFrontendId(stale.id)) continue;
    let twinIndex = -1;
    for (let i = 0; i < knownList.length; i += 1) {
      if (i === index || placed.has(i) || removals.has(i)) continue;
      const candidate = knownList[i];
      if ((candidate.role || "assistant") !== "user") continue;
      if (isFrontendId(candidate.id)) continue;
      if (remapIdentity(candidate) !== remapIdentity(stale)) continue;
      twinIndex = i;
      break;
    }
    if (twinIndex === -1) continue;
    knownIds.delete(stale.id);
    knownList[index] = knownList[twinIndex];
    placed.add(index);
    removals.add(twinIndex);
  }
  if (removals.size) {
    knownList = knownList.filter((_, index) => !removals.has(index));
  }
};

/**
 * state 窗口与本地已知消息合并（同 id 取快照中的新值），顺序以快照窗口为准。
 *
 * 桌面下发的窗口是会话消息的连续尾段，但它不只在末尾增长：桌面切换会话后
 * 若视口未填满会自动向前补页，新页插在窗口头部。若把新 id 一律追加到末尾，
 * 这些更早的消息会被排到最后（乱序），knownList[0] 也不再是最早一条，
 * 「加载更早」的分页锚点随之失效。
 *
 * 合并规则：
 * - 本地首个落在窗口内的消息之前的部分原样保留为前缀（移动端自己翻页拿到
 *   的更早历史、已滑出窗口的旧消息）；
 * - 其后按窗口顺序排列；
 * - 本地已知但窗口中已不存在的消息（单调累积保留）跟随它在本地的前一条
 *   窗口内消息，维持原有相对位置；
 * - 本地没有任何消息落在窗口内时，窗口整体追加到末尾。
 */
const mergeKnown = (incoming: SnowRemoteMessage[]): void => {
  if (!incoming.length) return;
  reconcileRemappedUserIds(incoming);
  const windowList = incoming.filter(isRenderableMessage);
  if (!windowList.length) return;
  const windowIds = new Set(windowList.map((message) => message.id));
  const firstHit = knownList.findIndex((message) => windowIds.has(message.id));
  const merged =
    firstHit === -1 ? [...knownList] : knownList.slice(0, firstHit);
  const trailing = new Map<string, SnowRemoteMessage[]>();
  if (firstHit !== -1) {
    let anchorId = knownList[firstHit].id;
    for (let index = firstHit + 1; index < knownList.length; index += 1) {
      const message = knownList[index];
      if (windowIds.has(message.id)) {
        anchorId = message.id;
        continue;
      }
      const group = trailing.get(anchorId);
      if (group) group.push(message);
      else trailing.set(anchorId, [message]);
    }
  }
  const placed = new Set<string>();
  for (const message of windowList) {
    // 异常数据（窗口内重复 id）：只保留首次出现的位置。
    if (placed.has(message.id)) continue;
    placed.add(message.id);
    merged.push(message);
    const group = trailing.get(message.id);
    if (group) merged.push(...group);
  }
  knownList = merged;
  knownIds.clear();
  for (const message of merged) knownIds.add(message.id);
};

// ── 公共入口 ──────────────────────────────────────────────────────────────

/**
 * 恒定渲染（不因滚出视口而卸载）的消息 id：最后一条 assistant 消息。
 * 它是唯一持续增长的内容——流式期间卸载再重建的 Markdown 代价最高，而且
 * 用户随时可能滚回来看实时输出，因此与桌面端一致地始终留在 DOM 里。
 */
const pinnedMessageIds = (): ReadonlySet<string> => {
  const pinned = new Set<string>();
  for (let index = knownList.length - 1; index >= 0; index -= 1) {
    if ((knownList[index].role || "assistant") === "assistant") {
      pinned.add(knownList[index].id);
      break;
    }
  }
  return pinned;
};

/**
 * 进入会话切换过渡态：立即清空消息区并显示骨架屏，并忽略仍指向旧会话的快照。
 *
 * 由会话列表在发起切换请求前调用，使点击会话的视觉反馈（列表选中项 + 消息区
 * 骨架屏）不再依赖服务端响应，与桌面端「选中即切换、历史加载中显示骨架屏」
 * 的观感一致。
 */
export const beginConversationSwitch = (conversationId: string): void => {
  switchingTo = conversationId;
  knownList = [];
  knownIds.clear();
  hasOlder = false;
  hasLoadedHistory = false;
  loadingOlder = false;
  // 会话已变：在途的「加载更早」请求作废。
  loadGeneration += 1;
  userNearBottom = true;
  paintSkeleton();
};

/**
 * 取消会话切换过渡态（切换失败 / 快照未跟上）：解除快照过滤并按当前快照重绘，
 * 消息区从骨架屏回退到上一个会话的真实内容。
 */
export const cancelConversationSwitch = (): void => {
  if (switchingTo === null) return;
  switchingTo = null;
  // 骨架屏已被其它内容接管（离线占位 / 快照已渲染）：只撤下容器态。
  if (!skeletonVisible()) {
    setSkeletonContainer(false);
    return;
  }
  if (currentState) renderTimeline(currentState, false);
  else paintEmpty();
};

/**
 * 渲染消息区。仅在 main.ts 检测到快照签名变化时调用；
 * isFirstRender 表示本次是首次渲染（必然滚到底部）。
 */
export const renderTimeline = (
  next: SnowRemoteState,
  isFirstRender: boolean,
): void => {
  currentState = next;
  streaming = next.isStreaming;
  // 回滚入口门控：桌面可回滚（子代理 / 节点会话不可）且不在流式输出中——
  // 与桌面流式期间隐藏回滚按钮一致；字段缺失时按可用处理（见上方注释）。
  rollbackAvailable = next.rollbackAvailable !== false && !next.isStreaming;
  if (switchingTo !== null) {
    // 切换尚未生效：忽略旧会话的快照，把骨架屏留在消息区。
    if ((next.activeConversationId ?? null) !== switchingTo) return;
    // 目标会话已到达：结束过渡，走下面的整表重建（骨架屏随之被清掉）。
    switchingTo = null;
  }
  const nextConversationId = next.activeConversationId ?? null;
  // 新会话视图（activeConversationId 为空）在首轮响应结束后会被桌面迁移为真实
  // 会话 id（pending 槽位 → 持久化会话，见 useAgentLoop 的 migrateSession）。
  // 这是同一段对话的 id 升级：消息与滚动位置都连续，若按会话切换整表重建，
  // 第一轮响应结束时整列消息会闪一次（内容重绘、图片重载、滚动位置丢失）。
  // 判定依据是快照仍包含本地已渲染的消息——真实切换会话时消息集合互不相交。
  if (
    renderedConversationId === null &&
    nextConversationId !== null &&
    knownList.length > 0 &&
    next.messages.some((message) => knownIds.has(message.id))
  ) {
    renderedConversationId = nextConversationId;
  }
  const conversationChanged = nextConversationId !== renderedConversationId;
  if (conversationChanged) {
    renderedConversationId = nextConversationId;
    knownList = [];
    knownIds.clear();
    // 状态未知（undefined）时默认不显示「加载更早」入口，待桌面会话状态
    // 就绪后的下一轮快照跟随更新；新建会话（无活动会话）固定为 false。
    hasOlder = next.hasOlderMessages ?? false;
    hasLoadedHistory = false;
    loadingOlder = false;
    loadGeneration += 1;
    userNearBottom = true;
    cancelScrollToBottomAnim();
  } else if (!hasLoadedHistory) {
    // 移动端尚未自己翻页：跟随桌面会话的 DB 分页状态（状态未知时保留现值）。
    hasOlder = next.hasOlderMessages ?? hasOlder;
  }
  mergeKnown(next.messages);
  setPinnedMessageIds(pinnedMessageIds());
  paint({
    follow: isFirstRender || userNearBottom,
    anchorEl: null,
    rebuild: conversationChanged,
  });
  updateLoadEarlierButton();
};

/**
 * 回滚成功后清理本地时间线：移除目标消息及其之后的所有消息（桌面已按同一边界
 * 截断会话，首条消息回滚则是整个会话被删除）。手机端的时间线是单调累积的，
 * 不主动清理会让已回滚的内容一直显示到会话切换。
 * 目标不在本地（例如 id 已随落库迁移）时保守清空，由下一次快照重建尾部消息。
 */
export const dropMessagesFrom = (messageId: string): void => {
  const index = knownList.findIndex((message) => message.id === messageId);
  const kept = index === -1 ? [] : knownList.slice(0, index);
  knownList = kept;
  knownIds.clear();
  for (const message of kept) knownIds.add(message.id);
  if (index === -1) {
    // 清空后失去分页锚点：复位「加载更早」状态，由快照重新给出结论。
    loadGeneration += 1;
    loadingOlder = false;
    hasLoadedHistory = false;
    hasOlder = currentState?.hasOlderMessages ?? false;
  }
  setPinnedMessageIds(pinnedMessageIds());
  paint({ follow: true, anchorEl: null });
  updateLoadEarlierButton();
};

export const initTimeline = (): void => {
  const timeline = $("timeline");
  // 视口虚拟化：相交集合变化（滚动 / 键盘弹出 / 视口尺寸变化）就重绘消息区，
  // 视口外的消息卸载为占位符、回到视口内的恢复真实内容；占位符高度取自实测
  // 缓存，文档高度基本不变，无需修正滚动位置。
  initViewportVirtualization(timeline, () => {
    paint({ follow: false, anchorEl: null });
  });
  timeline.addEventListener("scroll", () => {
    // 平滑回底动画期间：滚动本身是程序化行为，不重推导跟随状态。
    if (scrollToBottomAnim !== 0) return;
    const distance =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    userNearBottom = distance < NEAR_BOTTOM_THRESHOLD;
    syncScrollToBottomButton();
    if (timeline.scrollTop <= LOAD_EARLIER_THRESHOLD) {
      void loadEarlier();
    }
  });
  // 手指按下即视为用户接管滚动：打断按钮触发的平滑回底并恢复按钮显隐。
  timeline.addEventListener(
    "pointerdown",
    () => {
      if (scrollToBottomAnim !== 0) {
        cancelScrollToBottomAnim();
        syncScrollToBottomButton();
      }
    },
    { passive: true },
  );
  $("loadEarlier").onclick = () => {
    void loadEarlier();
  };
  $("scrollToBottomButton").onclick = () => {
    scrollTimelineToBottom(timeline);
  };
  $("messages").onclick = (event) => {
    const target = event.target as HTMLElement;
    // 回滚入口（用户消息）：打开回滚确认弹层。
    const rollback = target.closest<HTMLElement>("[data-rollback]");
    if (rollback) {
      void openRollbackSheet(rollback.dataset.rollback ?? "", rollback);
      return;
    }
    const compactionCopy = target.closest<HTMLElement>(
      "[data-compaction-copy]",
    );
    if (compactionCopy) {
      event.preventDefault();
      const card = compactionCopy.closest<HTMLElement>("[data-compaction]");
      const messageId = card?.dataset.compaction ?? "";
      const message = knownList.find((item) => item.id === messageId);
      void copyCompactionContent(compactionCopy, message?.content ?? "");
      return;
    }
    // 折叠块：.tc-more 切换展开态并同步按钮文案。
    const more = target.closest<HTMLButtonElement>(".tc-more");
    if (more) {
      toggleFold(more);
      return;
    }
    // 图片（消息附件与工具卡片出图共用灯箱）。
    const image = target.closest<HTMLImageElement>(".remote-image, .tc-image");
    if (!image) return;
    openImageLightbox(image.src);
  };
};
