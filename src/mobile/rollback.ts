import type {
  SnowRemoteRollbackChange,
  SnowRemoteRollbackDiff,
  SnowRemoteRollbackFile,
  SnowRemoteRollbackMode,
  SnowRemoteRollbackPreview,
  SnowRemoteRollbackState,
} from "../renderer/types/remoteControl";
import {
  cancelRollback,
  confirmRollback,
  fetchRollbackFileDiff,
  fetchRollbackFiles,
  fetchRollbackState,
  startRollback,
} from "./api";
import { $ } from "./dom";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import { isLiveReady, setLiveRollbackListener } from "./live";
import { showNotice } from "./notice";
import {
  beginOverlay,
  closeOverlays,
  hideOverlays,
  rememberOverlayTrigger,
  setOverlayCloseHook,
} from "./overlays";
import { dropMessagesFrom } from "./timeline";
import type { AppContext } from "./types";

/**
 * 回滚确认弹层（底部弹层）。
 *
 * 与电脑端 RollbackConfirmDialog 等价：数据全部来自桌面会话上下文
 * （GET /api/rollback 轮询），手机端只做展示与确认——
 * - 预览计算期间（桌面中止运行 + 遍历检查点，SSH 下较慢）显示计算中；
 * - 预览就绪后展示文件变更清单、TODO、项目记忆清理选项与 WorkFlow 提示；
 * - 文件变更由 Rust 检查点服务直接计算（POST action=diff 只返回摘要，选中
 *   文件时再按 action=diff-page 拉取该文件 diff 的首页）；
 * - 确认复用桌面 confirmRollback（文件恢复 → 会话截断 / 删除 → 清理检查点与记忆）。
 *
 * 电脑端会同时弹出同一次预览的对话框：在电脑端取消同样结束手机端这次回滚，
 * 反之亦然（两端共用同一份会话上下文状态，不存在第二套回滚实现）。
 */

/** 预览状态轮询间隔：桌面计算变更通常几百毫秒内完成，SSH 下会持续更久。 */
const POLL_INTERVAL_MS = 800;
/** 摘要里最多列出的文件数（与桌面弹窗同量级）。 */
const MAX_VISIBLE_CHANGES = 50;
/** diff 视图单个文件渲染的行数上限（触摸端 DOM 保护）。 */
const MAX_DIFF_LINES = 400;

// ── 模块状态 ──────────────────────────────────────────────────────────────

let ctx: AppContext | null = null;
/** 弹层是否打开（关闭后所有在途请求按代际丢弃）。 */
let active = false;
/** 回滚目标用户消息 id（本次弹层的身份）。 */
let targetMessageId = "";
let state: SnowRemoteRollbackState | null = null;
/** 是否已观察到桌面开始处理（preparing / preview），用于识别「已结束」。 */
let sawActivity = false;
/** 已确认、等待桌面执行完成的方式；非空即执行中。 */
let pendingMode: SnowRemoteRollbackMode | null = null;
let deleteMemories = false;
let showTodos = false;
let showMemories = false;
let view: "summary" | "diffs" = "summary";
let files: SnowRemoteRollbackFile[] | null = null;
let filesLoading = false;
let filesError = false;
let selectedFile = 0;
/** 已加载的单文件 diff（按路径缓存，切回看过的文件不再请求）。 */
const fileDiffs = new Map<string, SnowRemoteRollbackDiff>();
let diffLoadingPath: string | null = null;
let diffErrorPath: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** 请求代际：关闭 / 重开弹层即自增，使在途轮询与 diff 请求失效。 */
let generation = 0;
/** 已渲染内容签名：快照轮询下内容未变时完全不触碰 DOM。 */
let renderedSignature = "";

// ── DOM 小件 ──────────────────────────────────────────────────────────────

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 静态 lucide 图标（只承载图标标记，不含数据，可安全走 innerHTML）。 */
const iconSpan = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

const CHANGE_LABEL_KEY: Record<SnowRemoteRollbackChange["changeType"], string> =
  {
    added: "remote.rollback.changeAdded",
    modified: "remote.rollback.changeModified",
    deleted: "remote.rollback.changeDeleted",
  };

const CHANGE_ICON: Record<
  SnowRemoteRollbackChange["changeType"],
  MobileIconName
> = {
  added: "file-plus",
  modified: "file-pen",
  deleted: "trash-2",
};

/** 计算中 / 加载中的旋转图标行。 */
const spinnerRow = (label: string): HTMLElement => {
  const row = el("div", "rollback-loading");
  row.append(
    iconSpan("loader-circle", "rollback-spinner"),
    el("span", undefined, label),
  );
  return row;
};

/** 提示行（warning / error 为强调色）。 */
const noteRow = (text: string, tone?: "warning" | "error"): HTMLElement =>
  el("div", `rollback-note${tone ? ` ${tone}` : ""}`, text);

/** TODO 条目图标（对应桌面 CheckSquare）。 */
const TODO_ITEM_ICON: MobileIconName = "square-check-big";
/** 项目记忆条目图标（与桌面记忆面板一致）。 */
const MEMORY_ITEM_ICON: MobileIconName = "brain-circuit";

/** 区段头部的展开 / 收起按钮。 */
const toggleButton = (
  expanded: boolean,
  label: string,
  action: string,
  icon: MobileIconName,
): HTMLButtonElement => {
  const button = el("button", "rollback-toggle");
  button.type = "button";
  button.dataset.rollbackAction = action;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(
    iconSpan(
      expanded ? "chevron-down" : "chevron-right",
      "rollback-toggle-arrow",
    ),
    iconSpan(icon, "rollback-toggle-icon"),
  );
  return button;
};

// ── 状态读取 ──────────────────────────────────────────────────────────────

/** 当前弹层的预览（必须与目标消息一致，避免他人发起的新预览串线）。 */
const preview = (): SnowRemoteRollbackPreview | null => {
  const value = state?.preview ?? null;
  return value && value.messageId === targetMessageId ? value : null;
};

const preparing = (): boolean => state?.preparingMessageId === targetMessageId;

const canPreviewDiffs = (value: SnowRemoteRollbackPreview | null): boolean =>
  Boolean(
    value &&
    value.changes.length > 0 &&
    value.workDir &&
    value.checkpointIds.length,
  );

/** 回滚执行中（已确认、等待桌面完成）。 */
const busy = (): boolean => pendingMode !== null;

// ── 轮询 ──────────────────────────────────────────────────────────────────

const clearPoll = (): void => {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
};

/** 清空 diff 视图状态（文件摘要与已加载的单文件 diff）。 */
const resetDiffState = (): void => {
  files = null;
  filesLoading = false;
  filesError = false;
  selectedFile = 0;
  fileDiffs.clear();
  diffLoadingPath = null;
  diffErrorPath = null;
};

const resetState = (): void => {
  active = false;
  targetMessageId = "";
  state = null;
  sawActivity = false;
  pendingMode = null;
  deleteMemories = false;
  showTodos = false;
  showMemories = false;
  view = "summary";
  resetDiffState();
  renderedSignature = "";
  generation += 1;
  clearPoll();
  setLiveRollbackListener(null);
};

const schedulePoll = (): void => {
  clearPoll();
  const requestGeneration = generation;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void poll(requestGeneration);
  }, POLL_INTERVAL_MS);
};

const poll = async (requestGeneration: number): Promise<void> => {
  if (!active || requestGeneration !== generation) return;
  if (isLiveReady()) {
    // 实时通道在线：由服务端推送回滚状态，定时器只用于掉线后回落轮询。
    setLiveRollbackListener((next) => applyState(next, requestGeneration));
    schedulePoll();
    return;
  }
  setLiveRollbackListener(null);
  try {
    const next = await fetchRollbackState();
    applyState(next, requestGeneration);
  } catch (error) {
    if (!active || requestGeneration !== generation) return;
    showNotice((error as Error).message, true);
  }
  if (active && requestGeneration === generation) schedulePoll();
};

/** 轮询结果 → 弹层：就绪渲染清单，清空即代表本次回滚已结束。 */
const applyState = (
  next: SnowRemoteRollbackState,
  requestGeneration: number,
): void => {
  if (!active || requestGeneration !== generation) return;
  state = next;
  const value = preview();
  if (value || preparing()) {
    sawActivity = true;
  } else if (sawActivity) {
    // 桌面已结束：回滚完成，或在电脑端取消 / 关闭了这次预览。
    finish();
    return;
  }
  // 截断失败时桌面保留预览并带上错误：退出执行中状态，让用户重试。
  if (value?.error && pendingMode) pendingMode = null;
  render();
};

/** 本次回滚结束：收起弹层；已确认的按目标消息清理本地时间线。 */
const finish = (): void => {
  const mode = pendingMode;
  const finishedTarget = targetMessageId;
  resetState();
  closeOverlays(false);
  if (mode && ctx) {
    dropMessagesFrom(finishedTarget);
    showNotice(t("remote.rollback.done"));
    void ctx.refresh(false);
    return;
  }
  showNotice(t("remote.rollback.ended"));
};

// ── 渲染 ──────────────────────────────────────────────────────────────────

const changeItem = (change: SnowRemoteRollbackChange): HTMLElement => {
  const item = el("li", `rollback-change ${change.changeType}`);
  const path = el("span", "rollback-change-path", change.path);
  path.title = change.path;
  item.append(
    iconSpan(CHANGE_ICON[change.changeType], "rollback-change-icon"),
    el("span", "rollback-change-type", t(CHANGE_LABEL_KEY[change.changeType])),
    path,
  );
  return item;
};

const listItems = (
  items: Array<{ text: string; icon: MobileIconName }>,
): HTMLElement => {
  const list = el("ul", "rollback-list");
  for (const item of items) {
    const row = el("li", "rollback-list-item");
    row.append(
      iconSpan(item.icon, "rollback-list-icon"),
      el("span", "rollback-list-text", item.text),
    );
    list.append(row);
  }
  return list;
};

/** 记忆清理选项（勾选后随回滚删除被回滚轮次保存的项目记忆）。 */
const memoryOption = (value: SnowRemoteRollbackPreview): HTMLElement => {
  const label = el("label", "rollback-memory-option");
  const checkbox = el("input");
  checkbox.type = "checkbox";
  checkbox.checked = deleteMemories;
  checkbox.disabled = busy();
  checkbox.dataset.rollbackMemoryOption = "true";
  label.append(
    checkbox,
    el(
      "span",
      undefined,
      t("remote.rollback.memoryOption", { count: value.memoryItems.length }),
    ),
  );
  return label;
};

/** 摘要视图：错误 / 首条消息 / 文件变更 / WorkFlow / TODO / 记忆。 */
const renderSummary = (
  host: HTMLElement,
  value: SnowRemoteRollbackPreview,
): void => {
  if (value.error) {
    host.append(noteRow(value.error, "error"));
  }
  if (value.isFirstMessage) {
    host.append(noteRow(t("remote.rollback.firstMessageNotice"), "warning"));
  }

  const { added, modified, deleted } = value.changeTotals;
  const total = added + modified + deleted;
  if (total > 0) {
    host.append(
      el(
        "p",
        "rollback-lead",
        t("remote.rollback.changesNotice", { count: total }),
      ),
    );
    const chips = el("div", "rollback-chips");
    for (const [tone, count] of [
      ["added", added],
      ["modified", modified],
      ["deleted", deleted],
    ] as const) {
      if (count === 0) continue;
      chips.append(
        el(
          "span",
          `rollback-chip ${tone}`,
          `${t(CHANGE_LABEL_KEY[tone])} ${count}`,
        ),
      );
    }
    host.append(chips);

    const list = el("ul", "rollback-change-list");
    for (const change of value.changes.slice(0, MAX_VISIBLE_CHANGES)) {
      list.append(changeItem(change));
    }
    host.append(list);
    if (total > value.changes.length) {
      host.append(
        noteRow(
          t("remote.rollback.hiddenChanges", {
            count: total - value.changes.length,
          }),
        ),
      );
    }
  } else {
    host.append(el("p", "rollback-lead", t("remote.rollback.noChangesNotice")));
  }

  if (value.workflowFlowCount > 0) {
    host.append(
      noteRow(
        t("remote.rollback.workflowNotice", { count: value.workflowFlowCount }),
        "warning",
      ),
    );
  }

  if (value.todoItems.length > 0) {
    const section = el("div", "rollback-section");
    section.append(
      toggleButton(
        showTodos,
        t("remote.rollback.todoToggle"),
        "toggle-todos",
        "list-checks",
      ),
      el(
        "span",
        "rollback-section-title",
        t("remote.rollback.todoNotice", { count: value.todoItems.length }),
      ),
    );
    host.append(section);
    if (showTodos) {
      host.append(
        listItems(
          value.todoItems.map((todo) => ({
            text: todo.content,
            icon: TODO_ITEM_ICON,
          })),
        ),
      );
    }
  }

  if (value.memoryItems.length > 0) {
    const section = el("div", "rollback-section");
    section.append(
      toggleButton(
        showMemories,
        t("remote.rollback.memoryToggle"),
        "toggle-memories",
        MEMORY_ITEM_ICON,
      ),
      memoryOption(value),
    );
    host.append(section);
    if (showMemories) {
      host.append(
        listItems(
          value.memoryItems.map((memory) => ({
            text: memory.title || memory.memoryId,
            icon: MEMORY_ITEM_ICON,
          })),
        ),
      );
    }
  }
};

const diffLineClass = (line: string): string => {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("\\")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
};

const retryButton = (action: string): HTMLButtonElement => {
  const retry = el(
    "button",
    "rollback-secondary-action",
    t("remote.rollback.previewRetry"),
  );
  retry.type = "button";
  retry.dataset.rollbackAction = action;
  return retry;
};

/** 选中文件的 unified diff（逐行着色；超出行数上限时截断并提示）。
 *  diff 正文按需拉取：未加载时显示加载中，失败时提供重试。 */
const fileDiffContent = (file: SnowRemoteRollbackFile): HTMLElement => {
  const wrapper = el("div", "rollback-diff");
  const diff = fileDiffs.get(file.path);
  if (file.isBinary || diff?.isBinary) {
    wrapper.append(noteRow(t("remote.rollback.binaryFile")));
    return wrapper;
  }
  if (file.tooLarge || diff?.tooLarge) {
    wrapper.append(noteRow(t("remote.rollback.tooLargeFile")));
    return wrapper;
  }
  if (!diff) {
    if (diffErrorPath === file.path) {
      wrapper.append(
        noteRow(t("remote.rollback.previewError"), "error"),
        retryButton("retry-file-diff"),
      );
    } else {
      wrapper.append(spinnerRow(t("remote.rollback.previewLoading")));
    }
    return wrapper;
  }
  if (!diff.content.trim()) {
    wrapper.append(noteRow(t("remote.toolCall.diff.noDiff")));
    return wrapper;
  }
  const lines = diff.content.split("\n");
  const capped = lines.slice(0, MAX_DIFF_LINES);
  const body = el("div", "rollback-diff-body");
  for (const line of capped) {
    body.append(
      // 空行留一个空格，保持行高一致（white-space: pre）。
      el("div", `rollback-diff-line ${diffLineClass(line)}`, line || " "),
    );
  }
  wrapper.append(body);
  if (lines.length > capped.length || diff.truncated) {
    wrapper.append(
      noteRow(t("remote.toolCall.diff.truncated", { count: capped.length })),
    );
  }
  return wrapper;
};

const diffFileButton = (
  file: SnowRemoteRollbackFile,
  index: number,
): HTMLButtonElement => {
  const button = el(
    "button",
    `rollback-diff-file${index === selectedFile ? " active" : ""}`,
  );
  button.type = "button";
  button.dataset.rollbackFile = String(index);
  const path = el("span", "rollback-diff-file-path", file.path);
  path.title = file.path;
  button.append(
    iconSpan(CHANGE_ICON[file.changeType], "rollback-change-icon"),
    path,
    el(
      "span",
      "rollback-diff-file-stats",
      t("remote.toolCall.diff.stats", {
        additions: file.additions,
        deletions: file.deletions,
      }),
    ),
  );
  return button;
};

/** diff 视图：文件列表（摘要）+ 选中文件的 unified diff。 */
const renderDiffs = (
  host: HTMLElement,
  value: SnowRemoteRollbackPreview,
): void => {
  if (filesLoading) {
    host.append(spinnerRow(t("remote.rollback.previewLoading")));
    return;
  }
  if (filesError) {
    host.append(
      noteRow(t("remote.rollback.previewError"), "error"),
      retryButton("retry-diffs"),
    );
    return;
  }
  if (!files || files.length === 0) {
    host.append(noteRow(t("remote.rollback.previewEmpty")));
    return;
  }
  const total =
    value.changeTotals.added +
    value.changeTotals.modified +
    value.changeTotals.deleted;
  const list = el("div", "rollback-diff-files");
  files.forEach((file, index) => list.append(diffFileButton(file, index)));
  host.append(list);
  if (total > files.length) {
    host.append(
      noteRow(
        t("remote.rollback.previewTruncatedFiles", { count: files.length }),
      ),
    );
  }
  host.append(fileDiffContent(files[Math.min(selectedFile, files.length - 1)]));
};

const renderBody = (value: SnowRemoteRollbackPreview | null): void => {
  const host = $("rollbackBody");
  host.replaceChildren();
  if (view === "diffs") {
    if (value) renderDiffs(host, value);
    return;
  }
  if (!value) {
    host.append(
      spinnerRow(t("remote.rollback.preparing")),
      noteRow(t("remote.rollback.preparingHint")),
    );
    return;
  }
  renderSummary(host, value);
};

const actionButton = (
  label: string,
  action: string,
  className: string,
): HTMLButtonElement => {
  const button = el("button", className, label);
  button.type = "button";
  button.dataset.rollbackAction = action;
  button.disabled = busy();
  return button;
};

const renderActions = (value: SnowRemoteRollbackPreview | null): void => {
  const host = $("rollbackActions");
  host.replaceChildren();
  if (value && view === "summary" && canPreviewDiffs(value)) {
    const previewButton = actionButton(
      t("remote.rollback.viewChanges"),
      "view-changes",
      "rollback-secondary-action",
    );
    previewButton.prepend(iconSpan("eye", "rollback-action-icon"));
    host.append(previewButton);
  }

  const group = el("div", "rollback-primary-actions");
  group.append(
    actionButton(
      t("remote.rollback.cancelAction"),
      "cancel",
      "rollback-action cancel",
    ),
  );
  if (value) {
    if (value.changes.length > 0) {
      group.append(
        actionButton(
          t("remote.rollback.conversationOnlyAction"),
          "conversation-only",
          "rollback-action",
        ),
      );
    }
    const label =
      value.changes.length > 0
        ? t("remote.rollback.conversationAndFilesAction")
        : t("remote.rollback.confirmAction");
    const confirmButton = actionButton(
      busy() ? t("remote.rollback.inProgress") : label,
      "confirm",
      `rollback-action confirm${busy() ? " busy" : ""}`,
    );
    if (busy()) {
      confirmButton.prepend(iconSpan("loader-circle", "rollback-spinner"));
    }
    group.append(confirmButton);
  }
  host.append(group);
};

const renderSignature = (value: SnowRemoteRollbackPreview | null): string =>
  [
    view,
    value
      ? `preview:${value.messageId}:${value.changes.length}:${value.changeTotals.added}:${value.changeTotals.modified}:${value.changeTotals.deleted}:${value.error ?? ""}`
      : `preparing:${preparing() ? 1 : 0}`,
    pendingMode ?? "",
    deleteMemories ? "m1" : "m0",
    showTodos ? "t1" : "t0",
    showMemories ? "y1" : "y0",
    filesLoading ? "l1" : "l0",
    filesError ? "e1" : "e0",
    files ? String(files.length) : "-",
    String(selectedFile),
    `d${fileDiffs.size}`,
    diffLoadingPath ?? "",
    diffErrorPath ?? "",
  ].join("|");

const render = (): void => {
  if (!active) return;
  const value = preview();
  const signature = renderSignature(value);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  $("rollbackBack").hidden = view !== "diffs";
  renderBody(value);
  renderActions(value);
};

// ── 交互 ──────────────────────────────────────────────────────────────────

/** 拉取当前选中文件的 diff 首页（已加载 / 加载中 / 无内容可预览时跳过）。 */
const loadSelectedFileDiff = async (
  value: SnowRemoteRollbackPreview,
): Promise<void> => {
  const file = files?.[Math.min(selectedFile, files.length - 1)];
  if (
    !file ||
    file.isBinary ||
    file.tooLarge ||
    fileDiffs.has(file.path) ||
    diffLoadingPath === file.path
  ) {
    return;
  }
  const requestGeneration = generation;
  diffLoadingPath = file.path;
  diffErrorPath = null;
  render();
  try {
    const diff = await fetchRollbackFileDiff(
      value.checkpointIds,
      value.workDir,
      file.path,
    );
    if (!active || requestGeneration !== generation) return;
    fileDiffs.set(file.path, diff);
  } catch (error) {
    if (!active || requestGeneration !== generation) return;
    diffErrorPath = file.path;
    showNotice((error as Error).message, true);
  } finally {
    if (active && requestGeneration === generation) {
      if (diffLoadingPath === file.path) diffLoadingPath = null;
      render();
    }
  }
};

const loadFiles = async (value: SnowRemoteRollbackPreview): Promise<void> => {
  if (!canPreviewDiffs(value)) return;
  const requestGeneration = generation;
  filesLoading = true;
  filesError = false;
  render();
  try {
    const result = await fetchRollbackFiles(value.checkpointIds, value.workDir);
    if (!active || requestGeneration !== generation) return;
    files = result.files;
    selectedFile = 0;
  } catch (error) {
    if (!active || requestGeneration !== generation) return;
    filesError = true;
    showNotice((error as Error).message, true);
  } finally {
    if (active && requestGeneration === generation) {
      filesLoading = false;
      render();
    }
  }
  if (active && requestGeneration === generation) {
    void loadSelectedFileDiff(value);
  }
};

const openDiffs = (): void => {
  const value = preview();
  if (!value || !canPreviewDiffs(value)) return;
  view = "diffs";
  render();
  if (!files && !filesLoading) void loadFiles(value);
};

const handleConfirm = async (mode: SnowRemoteRollbackMode): Promise<void> => {
  const value = preview();
  if (!value || busy()) return;
  const requestGeneration = generation;
  const messageId = targetMessageId;
  pendingMode = mode;
  render();
  try {
    // 桌面开始执行（文件恢复 → 会话截断 → 清理检查点 / 记忆）：执行期间保持
    // 执行中状态，直到轮询发现预览被清空（成功）或重新带上错误（失败）。
    await confirmRollback(messageId, mode, deleteMemories);
  } catch (error) {
    if (!active || requestGeneration !== generation) return;
    pendingMode = null;
    render();
    showNotice((error as Error).message, true);
  }
};

const handleCancel = async (): Promise<void> => {
  // 回滚执行中不可取消（与桌面一致：确认后按钮禁用）。
  if (busy()) return;
  const messageId = targetMessageId;
  const hadPreview = preview() !== null || preparing();
  resetState();
  closeOverlays(false);
  if (!hadPreview) return;
  try {
    await cancelRollback(messageId);
  } catch {
    // 预览可能已在电脑端结束：无需向用户报错。
  }
};

/** 打开回滚弹层：先进入计算中状态，随后轮询桌面预览。 */
export const openRollbackSheet = async (
  messageId: string,
  trigger?: HTMLElement | null,
): Promise<void> => {
  if (!ctx || active || !messageId) return;
  // 关掉可能仍在展示的其他浮层（此时本弹层尚未激活，不会触发自身的复位钩子）。
  hideOverlays();
  active = true;
  targetMessageId = messageId;
  state = null;
  sawActivity = false;
  pendingMode = null;
  deleteMemories = false;
  showTodos = false;
  showMemories = false;
  view = "summary";
  resetDiffState();
  renderedSignature = "";
  generation += 1;
  rememberOverlayTrigger(trigger);
  beginOverlay();
  $("rollbackScrim").classList.add("open");
  $("rollbackSheet").classList.add("open");
  render();
  try {
    await startRollback(messageId);
  } catch (error) {
    resetState();
    closeOverlays(false);
    showNotice((error as Error).message, true);
    return;
  }
  schedulePoll();
};

export const initRollback = (appCtx: AppContext): void => {
  ctx = appCtx;
  // 返回键 / 其他浮层触发的隐藏：复位状态并停止轮询（桌面预览保持不变）。
  setOverlayCloseHook(() => {
    if (active) resetState();
  });

  $("rollbackScrim").onclick = () => {
    void handleCancel();
  };
  $("closeRollbackSheet").onclick = () => {
    void handleCancel();
  };
  $("rollbackBack").onclick = () => {
    view = "summary";
    render();
  };

  $("rollbackSheet").onclick = (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-rollback-action]")
      ?.dataset.rollbackAction;
    if (action) {
      switch (action) {
        case "view-changes":
          openDiffs();
          return;
        case "cancel":
          void handleCancel();
          return;
        case "conversation-only":
          void handleConfirm("conversation-only");
          return;
        case "confirm":
          void handleConfirm("conversation-and-files");
          return;
        case "toggle-todos":
          showTodos = !showTodos;
          render();
          return;
        case "toggle-memories":
          showMemories = !showMemories;
          render();
          return;
        case "retry-diffs": {
          const value = preview();
          if (value) void loadFiles(value);
          return;
        }
        case "retry-file-diff": {
          const value = preview();
          if (value) void loadSelectedFileDiff(value);
          return;
        }
        default:
          break;
      }
    }
    const fileIndex = target.closest<HTMLElement>("[data-rollback-file]")
      ?.dataset.rollbackFile;
    if (fileIndex !== undefined) {
      selectedFile = Number(fileIndex) || 0;
      render();
      const value = preview();
      if (value) void loadSelectedFileDiff(value);
    }
  };

  // 记忆清理选项：与桌面弹窗一致，默认不勾选（保留记忆）。
  $("rollbackSheet").onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.rollbackMemoryOption) {
      deleteMemories = input.checked;
    }
  };
};
