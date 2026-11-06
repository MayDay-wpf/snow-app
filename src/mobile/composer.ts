import type {
  SnowRemoteModeId,
  SnowRemoteState,
} from "../renderer/types/remoteControl";
import {
  abortRun,
  discardAttachment,
  setGoalTokenBudget,
  setMode,
  setToolCorrection,
  sendMessage,
  uploadAttachment,
} from "./api";
import { $, escapeHtml } from "./dom";
import {
  registerInputChangeListener,
  registerInputTextSink,
} from "./inputBridge";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import {
  clearMentions,
  closeMentionPopup,
  hasMentionReferences,
  initMentions,
  mentionTags,
  resetMentionContext,
  restoreReferencesFromText,
  setMentionWorkspace,
} from "./mentions";
import { showNotice } from "./notice";
import {
  beginOverlay,
  closeOverlays,
  hideOverlays,
  isActionSheetOpen,
  rememberOverlayTrigger,
  setActionSheetOpen,
} from "./overlays";
import { openMcpPanel, openRemotePanel, openSkillsPanel } from "./panels";
import { createNewChat, selectThread } from "./threads";
import { openTodosPanel } from "./todos";
import type { AppContext } from "./types";

/**
 * 输入区：文本输入、附件（图片/文件）、发送/停止、加号动作面板。
 * 子代理 / Workflow 节点会话结束后会话转只读：输入区整体替换为收尾栏
 * （与桌面 SubAgentFinishedNotice 判定同源，见 finishedSession）。
 */
type AttachmentKind = "image" | "file";

type ComposerAttachment = {
  file: File;
  kind: AttachmentKind;
  status: "uploading" | "ready" | "failed";
  id: string;
  objectUrl: string;
};

let busy = false;
let attachments: ComposerAttachment[] = [];
let attachmentContext = "";
let pendingSendRequestId = "";
let isComposing = false;
let latestState: SnowRemoteState | null = null;

const resizeInput = (): void => {
  const input = $<HTMLTextAreaElement>("input");
  input.style.height = "40px";
  input.style.height = Math.min(150, Math.max(40, input.scrollHeight)) + "px";
};

/** 撤回待发送消息时把原文恢复到输入框（引用标签还原为 chip 并同步高度）。 */
export const restoreInputText = (text: string): void => {
  const input = $<HTMLTextAreaElement>("input");
  input.value = restoreReferencesFromText(text);
  pendingSendRequestId = "";
  resizeInput();
};

const renderAttachments = (): void => {
  const strip = $("attachmentStrip");
  strip.className =
    "attachment-strip" + (attachments.length ? " has-items" : "");
  strip.innerHTML = attachments
    .map((item, index) => {
      const preview =
        item.kind === "image"
          ? `<img src="${escapeHtml(item.objectUrl)}" alt="">`
          : `<div class="attachment-file">${escapeHtml(item.file.name)}</div>`;
      const label =
        item.status === "uploading"
          ? t("remote.attachments.uploading")
          : item.status === "failed"
            ? t("remote.attachments.failed")
            : t("remote.attachments.ready");
      return `<div class="attachment-card ${item.status}">${preview}<span class="attachment-state">${label}</span><button class="attachment-remove" data-remove-attachment="${index}" aria-label="${escapeHtml(t("remote.attachments.remove"))}">${iconMarkup("x")}</button></div>`;
    })
    .join("");
  // 发送按钮由附件上传状态控制（排队发送同样需要附件就绪）；
  // 中断按钮的可用性由 renderComposer 按运行状态维护。
  $<HTMLButtonElement>("actionButton").disabled = attachments.some(
    (item) => item.status === "uploading",
  );
};

const discardAttachmentItem = (item: ComposerAttachment): void => {
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  if (item.id) discardAttachment(item.id);
};

const clearAttachments = (): void => {
  attachments.forEach(discardAttachmentItem);
  attachments = [];
  renderAttachments();
};

const uploadAttachmentItem = async (
  item: ComposerAttachment,
): Promise<void> => {
  item.status = "uploading";
  renderAttachments();
  try {
    const result = await uploadAttachment(item.file, item.kind);
    item.id = result.id;
    if (attachments.indexOf(item) === -1) {
      discardAttachmentItem(item);
      return;
    }
    item.status = "ready";
  } catch (error) {
    if (attachments.indexOf(item) !== -1) {
      item.status = "failed";
      showNotice((error as Error).message, true);
    }
  }
  renderAttachments();
};

const addFiles = (files: FileList | null, kind: AttachmentKind): void => {
  if (!files) return;
  pendingSendRequestId = "";
  Array.from(files).forEach((file) => {
    if (attachments.length >= 4) {
      showNotice(t("remote.attachments.maxCount"), true);
      return;
    }
    if (
      kind === "image" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].indexOf(
        file.type,
      ) === -1
    ) {
      showNotice(t("remote.attachments.imageOnly"), true);
      return;
    }
    const limit = kind === "image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
    if (file.size > limit) {
      showNotice(
        kind === "image"
          ? t("remote.attachments.imageTooLarge")
          : t("remote.attachments.fileTooLarge"),
        true,
      );
      return;
    }
    const item: ComposerAttachment = {
      file,
      kind,
      status: "uploading",
      id: "",
      objectUrl: kind === "image" ? URL.createObjectURL(file) : "",
    };
    attachments.push(item);
    void uploadAttachmentItem(item);
  });
  renderAttachments();
};

/** 动作面板中的模式开关顺序（与桌面 PlusMenu 的模式区一致）。 */
const MODE_IDS: SnowRemoteModeId[] = [
  "yolo",
  "lite",
  "worktree",
  "workflow",
  "goal",
];

/** 模式分组默认收起：展开态只在本次面板内保持，每次打开重新收起。 */
let modesExpanded = false;

const isModeAction = (action: string): action is SnowRemoteModeId =>
  (MODE_IDS as readonly string[]).includes(action);

/**
 * 会话运行中锁定、不允许启停的模式（与桌面 PlusMenu 的 modesLocked 一致：
 * 精简 / WorkTree / WorkFlow / 目标；YOLO 不受限）。
 */
const LOCKED_MODE_IDS: readonly SnowRemoteModeId[] = [
  "lite",
  "worktree",
  "workflow",
  "goal",
];

/** 会话运行中（流式 / 正在停止 / 正在压缩），与桌面 isSessionRunning 判定一致。 */
const isSessionRunning = (state: SnowRemoteState | null): boolean =>
  Boolean(state?.isStreaming || state?.isAborting || state?.isCompacting);

/** 该模式此刻是否被锁定：会话运行中的模式不允许启停。 */
const isModeLocked = (
  state: SnowRemoteState | null,
  mode: SnowRemoteModeId,
): boolean => isSessionRunning(state) && LOCKED_MODE_IDS.includes(mode);

const modeLabel = (mode: SnowRemoteModeId): string => {
  switch (mode) {
    case "goal":
      return t("remote.modes.goal");
    case "worktree":
      return t("remote.modes.worktree");
    case "workflow":
      return t("remote.modes.workflow");
    case "lite":
      return t("remote.modes.lite");
    case "yolo":
      return t("remote.modes.yolo");
  }
};

/** 收起态的摘要：与桌面 PlusMenu 的 activeModeSummary 同源。 */
const renderModeSummary = (state: SnowRemoteState | null): void => {
  const labels = MODE_IDS.filter((mode) => Boolean(state?.modes?.[mode])).map(
    (mode) => modeLabel(mode),
  );
  $("actionModeSummary").textContent =
    labels.length > 0 ? labels.join(" · ") : t("remote.modes.none");
};

/** 展开 / 收起模式分组：模式行留在 DOM 内，状态刷新不受影响。 */
const setModesExpanded = (expanded: boolean): void => {
  modesExpanded = expanded;
  const trigger = document.querySelector<HTMLElement>(
    '[data-action-group="modes"]',
  );
  $("actionModeList").hidden = !expanded;
  trigger?.setAttribute("aria-expanded", String(expanded));
  trigger?.classList.toggle("is-open", expanded);
};

const renderActionToggles = (state: SnowRemoteState | null): void => {
  renderModeSummary(state);
  const modes = state?.modes;
  MODE_IDS.forEach((mode) => {
    const button = document.querySelector<HTMLElement>(
      `[data-action="${mode}"]`,
    );
    const toggle = button?.querySelector<HTMLElement>("[data-mode-toggle]");
    if (!button || !toggle) return;
    const enabled = Boolean(modes?.[mode]);
    button.setAttribute("aria-pressed", String(enabled));
    toggle.classList.toggle("on", enabled);
    // 会话运行中锁定模式开关：压暗并标记不可用，点击由 handleActionClick 拦截。
    const locked = isModeLocked(state, mode);
    button.classList.toggle("is-locked", locked);
    if (locked) {
      button.setAttribute("aria-disabled", "true");
      button.title = t("remote.mode.lockedRunning");
    } else {
      button.removeAttribute("aria-disabled");
      button.removeAttribute("title");
    }
  });

  // 应用级开关（自动纠错）：不受会话运行状态锁定。
  const correctionButton = document.querySelector<HTMLElement>(
    '[data-action="tool-correction"]',
  );
  const correctionToggle = correctionButton?.querySelector<HTMLElement>(
    '[data-setting-toggle="toolCorrection"]',
  );
  if (correctionButton && correctionToggle) {
    const enabled = Boolean(state?.toolCorrection);
    correctionButton.setAttribute("aria-pressed", String(enabled));
    correctionToggle.classList.toggle("on", enabled);
  }
};

/** 目标模式 Token 预算的默认值（与桌面 PlusMenu 取消「无上限」时一致）。 */
const GOAL_BUDGET_DEFAULT = 2000000;

/**
 * 目标模式 Token 预算行（与桌面 PlusMenu 的预算输入同源）：
 * 仅目标模式开启时展示；0 = 无上限（输入框禁用、勾选「无上限」）。
 * 会话运行中与桌面一致地整体禁用（isModeLocked）。
 */
const renderGoalBudget = (
  state: SnowRemoteState | null,
  force = false,
): void => {
  const row = $("goalBudgetRow");
  const enabled = Boolean(state?.modes?.goal);
  row.hidden = !enabled;
  if (!enabled) return;

  const budget = state?.modes?.goalTokenBudget ?? GOAL_BUDGET_DEFAULT;
  const unlimited = budget <= 0;
  const locked = isModeLocked(state, "goal");
  row.classList.toggle("is-locked", locked);

  const input = $<HTMLInputElement>("goalBudgetInput");
  // 状态推送可能随时到达：用户正在编辑时不要覆盖输入框内容。
  if (force || document.activeElement !== input) {
    input.value = String(budget);
  }
  input.disabled = locked || unlimited;

  const checkbox = $<HTMLInputElement>("goalBudgetUnlimited");
  checkbox.checked = unlimited;
  checkbox.disabled = locked;
};

/** 已结束的子会话：子代理（含 cancelled）与 Workflow 节点（completed / failed）。 */
type FinishedSession = {
  kind: "subAgent" | "workflowNode";
  status: "completed" | "failed" | "cancelled";
  parentConversationId: string;
};

/** 终态归一化：子代理含 cancelled，Workflow 节点只有 completed / failed（同桌面）。 */
const terminalStatus = (
  kind: FinishedSession["kind"],
  status: string,
): FinishedSession["status"] | null => {
  if (status === "completed" || status === "failed") return status;
  if (kind === "subAgent" && status === "cancelled") return "cancelled";
  return null;
};

/**
 * 当前视图会话是否为「已结束的子会话」。判定字段来自 /api/state 的激活会话
 * 身份快照（桌面端按会话记录 + live 子代理事件解析），与桌面 ChatContent
 * 把输入区换成收尾栏的条件一致。
 */
const finishedSession = (
  state: SnowRemoteState | null,
): FinishedSession | null => {
  const conversationType = state?.activeConversationType ?? "";
  const kind: FinishedSession["kind"] | null =
    conversationType === "sub_agent"
      ? "subAgent"
      : conversationType === "workflow_node"
        ? "workflowNode"
        : null;
  if (!kind) return null;
  const status = terminalStatus(kind, state?.activeConversationRunStatus ?? "");
  if (!status) return null;
  return {
    kind,
    status,
    parentConversationId: state?.activeConversationParentId ?? "",
  };
};

/** 收尾栏状态图标（与桌面收尾栏的 CheckCircle2 / XCircle / AlertCircle 对应）。 */
const readonlyIcon = (status: FinishedSession["status"]): MobileIconName =>
  status === "failed"
    ? "circle-alert"
    : status === "cancelled"
      ? "circle-x"
      : "circle-check";

/** 收尾栏渲染签名：身份不变时跳过重建（每轮轮询零成本）。 */
let renderedReadonlyKey = "";

/**
 * 只读收尾栏渲染：会话结束时隐藏输入区（工具条 / 附件区 / 待发送队列 / 输入行），
 * 展示结束状态与「返回主会话」；会话恢复（续跑）时整块还原。
 */
const renderReadonlyBar = (finished: FinishedSession | null): void => {
  const key = finished
    ? [finished.kind, finished.status, finished.parentConversationId].join("|")
    : "";
  if (key === renderedReadonlyKey) return;
  renderedReadonlyKey = key;

  const readonly = finished !== null;
  $("remoteToolbar").hidden = readonly;
  $("referenceStrip").hidden = readonly;
  $("attachmentStrip").hidden = readonly;
  $("pendingMessages").hidden = readonly;
  $("composerRow").hidden = readonly;
  if (readonly) closeMentionPopup();
  const bar = $("readonlyBar");
  bar.hidden = !readonly;
  if (!finished) {
    bar.innerHTML = "";
    return;
  }

  const message = escapeHtml(
    t(`remote.readonly.${finished.kind}.${finished.status}`),
  );
  const backLabel = escapeHtml(t("remote.readonly.backToParent"));
  const backButton = finished.parentConversationId
    ? `<button class="readonly-back" type="button" data-readonly-back aria-label="${backLabel}">${iconMarkup("arrow-left")}<span>${backLabel}</span></button>`
    : "";
  bar.innerHTML =
    `<span class="readonly-status ${finished.status}">${iconMarkup(readonlyIcon(finished.status))}<span>${message}</span></span>` +
    backButton;
};

export const renderComposer = (next: SnowRemoteState | null): void => {
  latestState = next;
  setMentionWorkspace(next?.workspace?.directoryId ?? "");
  renderReadonlyBar(finishedSession(next));
  // 发送与中断是独立按钮：运行中发送按钮仍可用（消息进入待发送队列，
  // 由桌面端在回合边界自动切入），中断按钮单独显示、互不影响。
  $<HTMLButtonElement>("actionButton").disabled = false;
  const stop = $<HTMLButtonElement>("stopButton");
  stop.hidden = !next?.isStreaming;
  stop.disabled = Boolean(next?.isAborting);
  renderActionToggles(next);
  renderGoalBudget(next);
  renderAttachments();
};

/** 会话上下文（工作区 + 会话）变化时丢弃旧附件与引用。 */
export const syncSessionContext = (nextContext: string): void => {
  if (attachmentContext && nextContext !== attachmentContext) {
    clearAttachments();
    resetMentionContext();
  }
  attachmentContext = nextContext;
};

const positionActions = (): void => {
  const sheet = $("actionSheet");
  if (!sheet.classList.contains("open")) return;
  const trigger = $("plusButton");
  const rect = trigger.getBoundingClientRect();
  const margin = 10;
  const gap = 8;
  const width = Math.min(360, window.innerWidth - margin * 2);
  const left = Math.min(
    window.innerWidth - width - margin,
    Math.max(margin, rect.left),
  );
  sheet.style.left = left + "px";
  sheet.style.width = width + "px";
  sheet.style.bottom =
    Math.max(margin, window.innerHeight - rect.top + gap) + "px";
  sheet.style.maxHeight = Math.max(120, rect.top - margin - gap) + "px";
};

const submit = async (ctx: AppContext): Promise<void> => {
  const input = $<HTMLTextAreaElement>("input");
  const text = input.value;
  closeMentionPopup();
  if (busy) return;
  // 只读会话（已结束的子代理 / 节点）不接受发送：输入区已隐藏，这里兜住
  // 键盘回车等残余入口（桌面端同样会拒绝这类发送）。
  if (finishedSession(latestState)) return;
  if (attachments.some((item) => item.status === "uploading")) {
    showNotice(t("remote.attachments.uploadingNotice"), true);
    return;
  }
  if (attachments.some((item) => item.status === "failed")) {
    showNotice(t("remote.attachments.failedNotice"), true);
    return;
  }
  if (!text.trim() && !attachments.length && !hasMentionReferences()) return;
  // 引用以桌面端同款标签随正文发送（桌面消息区据此渲染 chip，技能标签
  // 还会触发该技能的手动执行）。
  const tags = mentionTags();
  const messageText = tags ? (text.trim() ? `${text}\n${tags}` : tags) : text;
  // 运行中（流式 / 停止中）发送的投递方式由桌面「繁忙时的发送行为」设置决定：
  // 插话在下一个安全边界追加要求，排队等本轮结束后再发（判定与桌面一致）。
  const running = Boolean(latestState?.isStreaming || latestState?.isAborting);
  busy = true;
  $<HTMLButtonElement>("actionButton").disabled = true;
  pendingSendRequestId =
    pendingSendRequestId ||
    "send-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2);
  try {
    await sendMessage(
      messageText,
      attachments.map((item) => item.id),
      pendingSendRequestId,
    );
    input.value = "";
    resizeInput();
    clearAttachments();
    clearMentions();
    pendingSendRequestId = "";
    if (running) {
      showNotice(
        t(
          latestState?.busySendBehavior === "steer"
            ? "remote.notice.steered"
            : "remote.notice.queued",
        ),
      );
    }
    await ctx.refresh(false);
  } catch (error) {
    showNotice((error as Error).message, true);
  } finally {
    busy = false;
    renderAttachments();
  }
};

/** 提交目标预算变更（0 = 无上限）：失败提示并回填当前生效值。 */
const applyGoalBudget = async (
  ctx: AppContext,
  budget: number,
): Promise<void> => {
  try {
    await setGoalTokenBudget(budget);
    await ctx.refresh(false);
  } catch (error) {
    showNotice((error as Error).message, true);
    renderGoalBudget(latestState, true);
  }
};

const handleActionClick = async (
  ctx: AppContext,
  action: string,
): Promise<void> => {
  const panelAction =
    action === "todos" ||
    action === "skills" ||
    action === "mcp" ||
    action === "commands" ||
    action === "theme";
  const modeAction = isModeAction(action);
  // 开关类动作（模式 / 应用开关）不关闭动作面板，方便连续切换。
  const toggleAction = modeAction || action === "tool-correction";
  if (panelAction) setActionSheetOpen(false);
  else if (!toggleAction) closeOverlays(false);

  if (action === "image") {
    $<HTMLInputElement>("imagePicker").click();
    return;
  }
  if (action === "file") {
    $<HTMLInputElement>("filePicker").click();
    return;
  }
  if (action === "new-chat") {
    await createNewChat(ctx);
    return;
  }
  if (action === "todos") {
    await openTodosPanel(ctx);
    return;
  }
  if (action === "skills") {
    await openSkillsPanel();
    return;
  }
  if (action === "mcp") {
    await openMcpPanel();
    return;
  }
  if (action === "commands") {
    openRemotePanel("commandPanel");
    return;
  }
  if (action === "theme") {
    openRemotePanel("themePanel");
    return;
  }
  if (modeAction) {
    if (isModeLocked(latestState, action)) {
      showNotice(t("remote.mode.lockedRunning"));
      return;
    }
    const enabled = !latestState?.modes?.[action];
    await setMode(action, enabled);
    showNotice(
      t(enabled ? "remote.mode.enabled" : "remote.mode.disabled", {
        name: modeLabel(action),
      }),
    );
    await ctx.refresh(false);
    return;
  }
  if (action === "tool-correction") {
    await setToolCorrection(!latestState?.toolCorrection);
    showNotice(t("remote.notice.settingsUpdated"));
    await ctx.refresh(false);
  }
};

export const initComposer = (ctx: AppContext): void => {
  const input = $<HTMLTextAreaElement>("input");
  // 消息操作栏「编辑到输入框」经该回调回填；输入区只读时按钮不会渲染。
  registerInputTextSink(restoreInputText);
  // 引用 chip 插入 / 触发词剥离属于程序化改写：重置幂等标识并同步高度。
  registerInputChangeListener(() => {
    pendingSendRequestId = "";
    resizeInput();
  });
  initMentions();

  $("plusButton").onclick = () => {
    closeMentionPopup();
    if (isActionSheetOpen()) {
      closeOverlays(false);
      return;
    }
    hideOverlays();
    rememberOverlayTrigger($("plusButton"));
    setModesExpanded(false);
    beginOverlay();
    $("actionSheet").scrollTop = 0;
    setActionSheetOpen(true);
    positionActions();
  };

  $("actionSheet").onclick = async (event) => {
    const target = event.target as HTMLElement;
    // 模式分组标题行：只切换展开态，不触发模式动作。
    if (target.closest("[data-action-group]")) {
      setModesExpanded(!modesExpanded);
      return;
    }
    const button = target.closest<HTMLElement>("[data-action]");
    if (!button) return;
    try {
      await handleActionClick(ctx, button.dataset.action ?? "");
    } catch (error) {
      showNotice((error as Error).message, true);
    }
  };

  // 目标预算：与桌面 PlusMenu 一致（0 = 无上限；取消勾选恢复默认预算）。
  const goalBudgetInput = $<HTMLInputElement>("goalBudgetInput");
  goalBudgetInput.onchange = async () => {
    const value = parseInt(goalBudgetInput.value, 10);
    if (Number.isNaN(value) || value <= 0) {
      // 非法输入：回填当前生效值（无上限 = 0 由勾选框表达）。
      renderGoalBudget(latestState, true);
      return;
    }
    await applyGoalBudget(ctx, value);
  };
  $("goalBudgetUnlimited").onchange = async (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    await applyGoalBudget(ctx, checked ? 0 : GOAL_BUDGET_DEFAULT);
  };

  $("actionBackdrop").onclick = () => {
    closeOverlays(false);
  };
  window.addEventListener("resize", positionActions);

  // 只读收尾栏：返回派生子代理 / 节点的主会话（复用列表的切换链路）。
  $("readonlyBar").onclick = async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-readonly-back]",
    );
    const parentConversationId = latestState?.activeConversationParentId ?? "";
    if (!button || !parentConversationId) return;
    await selectThread(ctx, parentConversationId, "");
  };

  const imagePicker = $<HTMLInputElement>("imagePicker");
  const filePicker = $<HTMLInputElement>("filePicker");
  imagePicker.onchange = () => {
    addFiles(imagePicker.files, "image");
    imagePicker.value = "";
  };
  filePicker.onchange = () => {
    addFiles(filePicker.files, "file");
    filePicker.value = "";
  };

  $("attachmentStrip").onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-remove-attachment]",
    );
    if (!button) return;
    const index = Number(button.dataset.removeAttachment);
    const item = attachments[index];
    if (!item) return;
    discardAttachmentItem(item);
    attachments.splice(index, 1);
    pendingSendRequestId = "";
    renderAttachments();
  };

  input.addEventListener("input", () => {
    pendingSendRequestId = "";
    resizeInput();
    if (input.value.charAt(0) === "/") {
      closeMentionPopup();
      openRemotePanel("commandPanel");
      const search = $<HTMLInputElement>("commandSearch");
      search.value = input.value.slice(1);
      search.dispatchEvent(new Event("input"));
    }
  });
  input.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  input.addEventListener("compositionend", () => {
    isComposing = false;
  });
  input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !isComposing &&
      !event.isComposing
    ) {
      event.preventDefault();
      void submit(ctx);
    }
  });

  // 发送：运行中同样可发送（消息进入待发送队列，回合边界自动切入），
  // 与桌面端输入区行为一致。
  $("actionButton").onclick = async () => {
    await submit(ctx);
  };

  // 中断：独立按钮，仅运行中出现，与发送互不干扰。
  $("stopButton").onclick = async () => {
    try {
      await abortRun();
      showNotice(t("remote.notice.stopping"));
      await ctx.refresh(false);
    } catch (error) {
      showNotice((error as Error).message, true);
    }
  };
};
