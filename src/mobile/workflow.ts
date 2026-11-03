import type {
  SnowRemoteToolCall,
  SnowRemoteWorkflow,
} from "../renderer/types/remoteControl";
import { replyWorkflow, runWorkflow } from "./api";
import { $ } from "./dom";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { showNotice } from "./notice";
import { selectThread } from "./threads";
import type { AppContext } from "./types";
import {
  createWorkflowCanvas,
  fitWorkflowCanvas,
  isCanvasTapSuppressed,
  patchWorkflowCanvas,
} from "./workflowCanvas";

/**
 * WorkFlow 卡片：消息区内 workflow-generate / workflow-resume 工具调用的专用渲染。
 *
 * 数据来自 /api/state 下发的 tool.workflow 快照（桌面渲染进程按 flow 组装）：
 * - 画布按执行顺序分层展示节点状态（待执行 / 执行中 / 已完成 / 失败）与依赖连线，
 *   支持拖动平移、双指缩放、适应视图与节点拖动（见 workflowCanvas.ts）；
 * - 挂起时提供与桌面卡片一致的「执行」与反馈入口；存在断点进度（重启 / 中断 /
 *   失败）时按钮变「继续执行」（runner 自动跳过已完成节点）；
 * - 节点已创建会话后点击即跳转到节点会话，查看执行详情。
 *
 * 渲染策略：卡片元素在时间线重建与轮询之间复用，patch 只更新变化的部分，
 * 画布视图与反馈草稿不因刷新丢失。
 */

const CARD_STATUS_LABEL_KEYS: Record<SnowRemoteWorkflow["status"], string> = {
  idle: "remote.workflow.status.idle",
  running: "remote.workflow.status.running",
  completed: "remote.workflow.status.completed",
  failed: "remote.workflow.status.failed",
};

/** 反馈文本长度上限（与桌面桥、Rust 侧校验保持一致）。 */
const MAX_REPLY_LENGTH = 2_000;

/** 反馈草稿（flowId → 文本）：时间线重建后恢复输入框内容。 */
const replyDrafts = new Map<string, string>();
/** 本次会话已提交的反馈（flowId → 文本）：提交后即时展示，不等下一轮快照。 */
const submittedReplies = new Map<string, string>();
/** 请求进行中的 flow（flowId）：按钮暂时禁用，避免重复提交。 */
const pendingActions = new Set<string>();
/** 卡片元素 → 最近一次渲染的工具数据（局部重绘用）。 */
const cardTools = new WeakMap<HTMLElement, SnowRemoteToolCall>();

/** workflow 卡片工具判定：名字匹配且桥下发了快照（否则回退通用工具行）。 */
export const isWorkflowCardTool = (tool: SnowRemoteToolCall): boolean =>
  (tool.name === "workflow-workflow-generate" ||
    tool.name === "workflow-workflow-resume") &&
  Boolean(tool.workflow);

/** 卡片签名：状态 / 节点进度 / 连线变化才重绘卡片内部。 */
export const workflowDigest = (
  workflow: SnowRemoteWorkflow | undefined,
): string =>
  workflow
    ? [
        workflow.status,
        workflow.pending ? "1" : "0",
        workflow.resumeAvailable ? "1" : "0",
        workflow.failedNode?.error ?? "",
        workflow.nodes
          .map(
            (node) =>
              `${node.id}:${node.status}:${node.conversationId}:${node.errorMessage}`,
          )
          .join(","),
        workflow.edges.map((edge) => `${edge.source}>${edge.target}`).join(","),
      ].join("\u0001")
    : "";

// ── 工具结果解析 ──────────────────────────────────────────────────────────

const parseToolResult = (
  raw: string | undefined,
): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** 卡片反馈记录：本地已提交的文本优先，其次解析工具结果里的 userResponse。 */
const readReplyRecord = (tool: SnowRemoteToolCall): string => {
  const flowId = tool.workflow?.flowId ?? "";
  const local = flowId ? submittedReplies.get(flowId) : "";
  if (local) return local;
  const result = parseToolResult(tool.result);
  const response = result?.userResponse;
  return typeof response === "string" ? response : "";
};

// ── 文案 ──────────────────────────────────────────────────────────────────

const failedHint = (workflow: SnowRemoteWorkflow): string => {
  const failed = workflow.failedNode;
  const base = failed?.label
    ? t("remote.workflow.failedHint", { name: failed.label })
    : t("remote.workflow.failedHintFallback");
  return failed?.error ? `${base}：${failed.error}` : base;
};

const cardStatusLabel = (
  workflow: SnowRemoteWorkflow,
  replyRecord: string,
): string =>
  workflow.status === "idle" && replyRecord
    ? t("remote.workflow.status.replied")
    : t(CARD_STATUS_LABEL_KEYS[workflow.status]);

const cardHint = (
  workflow: SnowRemoteWorkflow,
  replyRecord: string,
): string => {
  if (workflow.status === "running") return t("remote.workflow.runningHint");
  if (workflow.status === "completed") {
    return t("remote.workflow.completedHint");
  }
  if (workflow.status === "failed") return failedHint(workflow);
  if (replyRecord) return t("remote.workflow.repliedHint");
  if (workflow.mode === "resume") return t("remote.workflow.resumeReadonly");
  if (!workflow.pending) {
    return t("remote.workflow.settledHint");
  }
  return workflow.resumeAvailable
    ? t("remote.workflow.resumeHint")
    : t("remote.workflow.idleHint");
};

/** 可操作（执行 / 反馈）判定：与桌面卡片一致——挂起中且从未运行 / 未反馈。 */
const isInteractiveCard = (
  workflow: SnowRemoteWorkflow,
  replyRecord: string,
): boolean =>
  workflow.mode === "generate" &&
  workflow.pending &&
  workflow.status === "idle" &&
  !replyRecord;

// ── DOM 构建与局部更新 ────────────────────────────────────────────────────

const setText = (root: HTMLElement, selector: string, value: string): void => {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) return;
  el.textContent = value;
  el.hidden = !value;
};

/** 反馈输入区：仅生成卡片等待操作时出现（创建一次，之后只更新状态）。 */
const ensureReplyBlock = (
  el: HTMLElement,
  flowId: string,
  busy: boolean,
): void => {
  const footer = el.querySelector(".workflow-footer");
  if (!footer) return;
  let block = el.querySelector<HTMLElement>(".workflow-reply");
  if (!block) {
    block = document.createElement("div");
    block.className = "workflow-reply";
    const label = document.createElement("span");
    label.className = "workflow-reply-label";
    label.textContent = t("remote.workflow.replyLabel");
    const input = document.createElement("textarea");
    input.className = "workflow-reply-input";
    input.rows = 2;
    input.maxLength = MAX_REPLY_LENGTH;
    input.placeholder = t("remote.workflow.replyPlaceholder");
    const send = document.createElement("button");
    send.type = "button";
    send.className = "workflow-reply-send";
    const sendIcon = document.createElement("span");
    sendIcon.className = "workflow-reply-send-icon";
    sendIcon.innerHTML = iconMarkup("send");
    const sendLabel = document.createElement("span");
    sendLabel.textContent = t("remote.workflow.replySubmit");
    send.append(sendIcon, sendLabel);
    block.append(label, input, send);
    footer.append(block);
  }
  const input = block.querySelector<HTMLTextAreaElement>(
    ".workflow-reply-input",
  );
  const send = block.querySelector<HTMLButtonElement>(".workflow-reply-send");
  if (input) {
    const draft = replyDrafts.get(flowId) ?? "";
    if (document.activeElement !== input && input.value !== draft) {
      input.value = draft;
    }
  }
  if (send) {
    send.dataset.workflowReply = flowId;
    send.disabled = busy || !(input?.value.trim() ?? "");
  }
};

/** 已提交反馈记录（提交成功或历史回放时展示）。 */
const ensureRecordBlock = (el: HTMLElement, text: string): void => {
  const footer = el.querySelector(".workflow-footer");
  if (!footer) return;
  let block = el.querySelector<HTMLElement>(".workflow-reply-record");
  if (!block) {
    block = document.createElement("div");
    block.className = "workflow-reply-record";
    const label = document.createElement("span");
    label.className = "workflow-reply-record-label";
    label.textContent = t("remote.workflow.repliedFeedback");
    const content = document.createElement("p");
    content.className = "workflow-reply-record-content";
    block.append(label, content);
    footer.append(block);
  }
  const content = block.querySelector(".workflow-reply-record-content");
  if (content) content.textContent = text;
};

/** 创建卡片骨架（内容由 patchWorkflowCard 填充）。 */
export const createWorkflowCard = (tool: SnowRemoteToolCall): HTMLElement => {
  const el = document.createElement("div");
  el.className = "workflow-card";
  const head = document.createElement("div");
  head.className = "workflow-head";
  const headIcon = document.createElement("span");
  headIcon.className = "workflow-head-icon";
  headIcon.innerHTML = iconMarkup("workflow");
  const title = document.createElement("span");
  title.className = "workflow-title";
  const status = document.createElement("span");
  status.className = "workflow-status";
  head.append(headIcon, title, status);

  const canvas = createWorkflowCanvas();
  const help = document.createElement("div");
  help.className = "workflow-canvas-help";
  help.textContent = t("remote.workflow.canvasHint");
  const footer = document.createElement("div");
  footer.className = "workflow-footer";
  const actions = document.createElement("div");
  actions.className = "workflow-actions";
  const runButton = document.createElement("button");
  runButton.type = "button";
  runButton.className = "workflow-run";
  const runIcon = document.createElement("span");
  runIcon.className = "workflow-run-icon";
  runIcon.innerHTML = iconMarkup("play");
  const runLabel = document.createElement("span");
  runLabel.className = "workflow-run-label";
  runButton.append(runIcon, runLabel);
  const hint = document.createElement("span");
  hint.className = "workflow-hint";
  actions.append(runButton, hint);
  footer.append(actions);

  el.append(head, canvas, help, footer);
  cardTools.set(el, tool);
  patchWorkflowCard(el, tool);
  return el;
};

/**
 * 原地更新卡片：节点进度、按钮与提示、反馈记录。签名未变时零成本跳过，
 * 保证高频轮询不会打断阅读与输入。
 */
export const patchWorkflowCard = (
  el: HTMLElement,
  tool: SnowRemoteToolCall,
): void => {
  const workflow = tool.workflow;
  if (!workflow) return;
  const flowId = workflow.flowId;
  const replyRecord = readReplyRecord(tool);
  const busy = pendingActions.has(flowId);
  const sig = [workflowDigest(workflow), replyRecord, busy ? "1" : "0"].join(
    "\u0002",
  );
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  cardTools.set(el, tool);

  el.className = `workflow-card is-${workflow.status}`;
  el.dataset.flowId = flowId;
  el.dataset.mode = workflow.mode;

  setText(el, ".workflow-title", workflow.title || t("remote.workflow.title"));
  const statusEl = el.querySelector<HTMLElement>(".workflow-status");
  if (statusEl) {
    statusEl.textContent = cardStatusLabel(workflow, replyRecord);
    statusEl.className = `workflow-status is-${workflow.status}`;
  }

  const canvas = el.querySelector<HTMLElement>(".workflow-canvas");
  if (canvas) patchWorkflowCanvas(canvas, workflow);

  const interactive = isInteractiveCard(workflow, replyRecord);
  const runButton = el.querySelector<HTMLButtonElement>(".workflow-run");
  if (runButton) {
    runButton.hidden = !interactive;
    runButton.disabled = busy;
    runButton.dataset.workflowRun = flowId;
    const runLabel = runButton.querySelector(".workflow-run-label");
    if (runLabel) {
      runLabel.textContent = workflow.resumeAvailable
        ? t("remote.workflow.resume")
        : t("remote.workflow.execute");
    }
  }
  setText(el, ".workflow-hint", cardHint(workflow, replyRecord));

  if (interactive) {
    ensureReplyBlock(el, flowId, busy);
  } else {
    el.querySelector(".workflow-reply")?.remove();
  }
  if (replyRecord) {
    ensureRecordBlock(el, replyRecord);
  } else {
    el.querySelector(".workflow-reply-record")?.remove();
  }
};

// ── 交互 ──────────────────────────────────────────────────────────────────

/** 局部重绘卡片（按钮禁用态 / 提示即时反映本地状态，无需等下一轮快照）。 */
const refreshCard = (card: HTMLElement): void => {
  card.dataset.sig = "";
  const tool = cardTools.get(card);
  if (tool) patchWorkflowCard(card, tool);
};

/** 卡片动作统一入口：请求期间禁用按钮，完成后立即重绘并刷新快照。 */
const runCardAction = async (
  card: HTMLElement,
  flowId: string,
  ctx: AppContext,
  action: () => Promise<void>,
): Promise<void> => {
  if (pendingActions.has(flowId)) return;
  pendingActions.add(flowId);
  refreshCard(card);
  try {
    await action();
  } catch (error) {
    showNotice((error as Error).message, true);
  } finally {
    pendingActions.delete(flowId);
    refreshCard(card);
    await ctx.refresh(true);
  }
};

const handleCardClick = async (
  event: Event,
  ctx: AppContext,
): Promise<void> => {
  const target = event.target as HTMLElement;
  const runButton = target.closest<HTMLButtonElement>("[data-workflow-run]");
  const replyButton = target.closest<HTMLButtonElement>(
    "[data-workflow-reply]",
  );
  const fitButton = target.closest<HTMLButtonElement>("[data-workflow-fit]");
  const nodeEl = target.closest<HTMLElement>(".workflow-canvas-node");
  const anchor = runButton ?? replyButton ?? fitButton ?? nodeEl;
  const card = anchor?.closest<HTMLElement>(".workflow-card") ?? null;
  const flowId = card?.dataset.flowId ?? "";
  if (!card || !flowId) return;

  if (runButton) {
    await runCardAction(card, flowId, ctx, async () => {
      await runWorkflow(flowId);
      showNotice(t("remote.workflow.started"));
    });
    return;
  }
  if (replyButton) {
    const input = card.querySelector<HTMLTextAreaElement>(
      ".workflow-reply-input",
    );
    const text = input?.value.trim() ?? "";
    if (!text) return;
    await runCardAction(card, flowId, ctx, async () => {
      await replyWorkflow(flowId, text);
      submittedReplies.set(flowId, text);
      replyDrafts.delete(flowId);
      showNotice(t("remote.workflow.replied"));
    });
    return;
  }
  if (fitButton) {
    const canvas = card.querySelector<HTMLElement>(".workflow-canvas");
    if (canvas) fitWorkflowCanvas(canvas);
    return;
  }
  // 画布刚拖动 / 缩放：忽略这次点击，避免误跳节点会话。
  if (isCanvasTapSuppressed()) return;
  const conversationId = nodeEl?.dataset.conversationId ?? "";
  if (conversationId) {
    // 与会话列表同一条切换链路（立即高亮 + 骨架屏），directoryId 由桌面端解析。
    await selectThread(ctx, conversationId, "");
  }
};

export const initWorkflow = (ctx: AppContext): void => {
  const host = $("messages");
  host.addEventListener("click", (event) => {
    void handleCardClick(event, ctx);
  });
  host.addEventListener("input", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLTextAreaElement>(
      ".workflow-reply-input",
    );
    if (!input) return;
    const card = input.closest<HTMLElement>(".workflow-card");
    const flowId = card?.dataset.flowId ?? "";
    if (flowId) replyDrafts.set(flowId, input.value);
    const send = card?.querySelector<HTMLButtonElement>(".workflow-reply-send");
    if (send) {
      send.disabled = pendingActions.has(flowId) || !input.value.trim();
    }
  });
};
