import type {
  SnowRemoteState,
  SnowRemoteTodoItem,
  SnowRemoteTodoStatus,
} from "../renderer/types/remoteControl";
import { mutateTodos } from "./api";
import { $, escapeHtml } from "./dom";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import { showNotice } from "./notice";
import { openRemotePanel } from "./panels";
import type { AppContext } from "./types";
import { isSubmitEnter } from "../shared/imeKeyboard";

/**
 * 会话待办面板：展示当前激活会话的待办列表（与桌面顶部待办面板同一数据源），
 * 并支持远程新增 / 切换状态 / 删除。数据全部来自 /api/state 的 todos 字段，
 * 本模块只负责渲染与调用变更接口（见 api.ts 的 mutateTodos）。
 * 与桌面端一致：会话运行中（AI 正在管理待办）列表只读。
 */

/** 状态图标与桌面端 TodoPanelButton 一致：待完成 / 进行中 / 已完成。 */
const STATUS_ICONS: Record<SnowRemoteTodoStatus, MobileIconName> = {
  pending: "circle",
  inProgress: "circle-dot",
  completed: "circle-check",
};

/** 点击状态图标时循环切换：待完成 → 进行中 → 已完成 → 待完成。 */
const nextStatus = (status: SnowRemoteTodoStatus): SnowRemoteTodoStatus => {
  switch (status) {
    case "completed":
      return "pending";
    case "inProgress":
      return "completed";
    default:
      return "inProgress";
  }
};

const statusLabel = (status: SnowRemoteTodoStatus): string => {
  switch (status) {
    case "completed":
      return t("remote.todos.statusCompleted");
    case "inProgress":
      return t("remote.todos.statusInProgress");
    default:
      return t("remote.todos.statusPending");
  }
};

/** 已进入「确认删除」的条目 id（点删除图标进入，点确认才真正删除）。 */
let confirmingId: string | null = null;
/** 变更请求进行中：期间禁用全部待办操作，避免并发写。 */
let busy = false;
/** 最近一次快照的待办（切换状态时需要读当前条目）。 */
let latestTodos: SnowRemoteTodoItem[] = [];
/** 面板内容签名：仅在内容真正变化时重建列表（面板每秒随快照刷新）。 */
let renderedSignature = "";

const renderItem = (item: SnowRemoteTodoItem, readOnly: boolean): string => {
  const content = `<span class="todo-content">${escapeHtml(item.content)}</span>`;
  if (item.id === confirmingId) {
    return `<div class="todo-item is-confirming">${content}<div class="todo-confirm-actions"><button type="button" class="todo-confirm-button" data-todo-cancel="${escapeHtml(item.id)}">${escapeHtml(t("remote.todos.cancelDelete"))}</button><button type="button" class="todo-confirm-button danger" data-todo-confirm="${escapeHtml(item.id)}" ${busy ? "disabled" : ""}>${escapeHtml(t("remote.todos.confirmDelete"))}</button></div></div>`;
  }
  const statusButton = `<button type="button" class="todo-status" data-todo-cycle="${escapeHtml(item.id)}" aria-label="${escapeHtml(t("remote.todos.cycleStatus", { status: statusLabel(nextStatus(item.status)) }))}" ${readOnly || busy ? "disabled" : ""}>${iconMarkup(STATUS_ICONS[item.status])}</button>`;
  const removeButton = readOnly
    ? ""
    : `<button type="button" class="todo-remove" data-todo-remove="${escapeHtml(item.id)}" aria-label="${escapeHtml(t("remote.todos.delete"))}" ${busy ? "disabled" : ""}>${iconMarkup("trash-2")}</button>`;
  return `<div class="todo-item" data-status="${item.status}">${statusButton}${content}${removeButton}</div>`;
};

const renderPanel = (state: SnowRemoteState | null): void => {
  const items = state?.todos ?? null;
  const readOnly = Boolean(state?.isStreaming);
  const list = $("todosList");
  if (!state?.activeConversationId) {
    list.innerHTML = `<div class="empty">${escapeHtml(t("remote.todos.noConversation"))}</div>`;
  } else if (items === null) {
    list.innerHTML = `<div class="empty">${escapeHtml(t("remote.todos.unavailable"))}</div>`;
  } else if (items.length === 0) {
    list.innerHTML = `<div class="empty">${escapeHtml(t("remote.todos.empty"))}</div>`;
  } else {
    const completed = items.filter(
      (item) => item.status === "completed",
    ).length;
    list.innerHTML =
      `<div class="todo-progress">${escapeHtml(t("remote.todos.progress", { completed, total: items.length }))}</div>` +
      items.map((item) => renderItem(item, readOnly)).join("");
  }
  // 会话运行中：待办由 AI 管理，隐藏新增入口并说明原因（与桌面端同规则）；
  // 没有活动会话时同样不给新增入口（待办按会话保存，无处可写）。
  $("todoRunningHint").hidden = !readOnly;
  $("todoAddBar").hidden = readOnly || !state?.activeConversationId;
  $<HTMLButtonElement>("todoAddButton").disabled =
    busy || !$<HTMLInputElement>("todoAddInput").value.trim();
};

/**
 * 快照 → 待办 UI：顶栏入口徽标 + 面板内容。
 * 入口只在会话存在待办时出现（与桌面顶栏一致），日常不占顶栏空间。
 */
export const renderTodos = (next: SnowRemoteState | null): void => {
  latestTodos = next?.todos ?? [];
  const incomplete = latestTodos.filter(
    (item) => item.status !== "completed",
  ).length;
  $("todoButton").hidden = latestTodos.length === 0;
  const badge = $("todoBadge");
  badge.hidden = incomplete === 0;
  badge.textContent = incomplete > 0 ? String(incomplete) : "";

  const panel = $("todosPanel");
  if (!panel.classList.contains("open")) {
    // 面板关闭时不同步内容，重新打开时由签名复位触发一次完整重建。
    renderedSignature = "";
    return;
  }
  const signature = [
    next?.activeConversationId ?? "",
    next?.isStreaming ? "1" : "0",
    busy ? "1" : "0",
    confirmingId ?? "",
    latestTodos.map((item) => `${item.id}:${item.status}`).join(","),
  ].join("|");
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  renderPanel(next);
};

const applyMutation = async (
  ctx: AppContext,
  action: "add" | "update" | "delete",
  payload: { content?: string; todoId?: string; status?: SnowRemoteTodoStatus },
): Promise<boolean> => {
  busy = true;
  renderTodos(ctx.getState());
  try {
    await mutateTodos(action, payload);
    await ctx.refresh(false);
    return true;
  } catch (error) {
    showNotice((error as Error).message, true);
    return false;
  } finally {
    busy = false;
    renderTodos(ctx.getState());
  }
};

const addTodo = async (ctx: AppContext): Promise<void> => {
  const input = $<HTMLInputElement>("todoAddInput");
  const content = input.value.trim();
  if (!content || busy) return;
  if (await applyMutation(ctx, "add", { content })) {
    input.value = "";
    $<HTMLButtonElement>("todoAddButton").disabled = true;
  }
};

export const openTodosPanel = async (ctx: AppContext): Promise<void> => {
  confirmingId = null;
  renderedSignature = "";
  openRemotePanel("todosPanel");
  // 先用当前快照渲染（打开动画期间就有内容），再拉一次最新快照。
  renderTodos(ctx.getState());
  await ctx.refresh(false);
};

export const initTodos = (ctx: AppContext): void => {
  $("todoButton").onclick = () => {
    void openTodosPanel(ctx);
  };

  $("todosList").onclick = (event) => {
    const target = event.target as HTMLElement;
    const cycle = target.closest<HTMLElement>("[data-todo-cycle]");
    if (cycle) {
      const item = latestTodos.find(
        (todo) => todo.id === cycle.dataset.todoCycle,
      );
      if (item) {
        confirmingId = null;
        void applyMutation(ctx, "update", {
          todoId: item.id,
          status: nextStatus(item.status),
        });
      }
      return;
    }
    const remove = target.closest<HTMLElement>("[data-todo-remove]");
    if (remove) {
      confirmingId = remove.dataset.todoRemove ?? null;
      renderTodos(ctx.getState());
      return;
    }
    const cancel = target.closest<HTMLElement>("[data-todo-cancel]");
    if (cancel) {
      confirmingId = null;
      renderTodos(ctx.getState());
      return;
    }
    const confirm = target.closest<HTMLElement>("[data-todo-confirm]");
    if (confirm) {
      const todoId = confirm.dataset.todoConfirm ?? "";
      confirmingId = null;
      void applyMutation(ctx, "delete", { todoId });
    }
  };

  const input = $<HTMLInputElement>("todoAddInput");
  input.oninput = () => {
    $<HTMLButtonElement>("todoAddButton").disabled =
      busy || !input.value.trim();
  };
  input.onkeydown = (event) => {
    if (isSubmitEnter(event)) {
      event.preventDefault();
      void addTodo(ctx);
    }
  };
  $("todoAddButton").onclick = () => {
    void addTodo(ctx);
  };
};
