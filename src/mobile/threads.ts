import type {
  SnowRemoteConversation,
  SnowRemoteState,
} from "../renderer/types/remoteControl";
import {
  fetchMoreConversations,
  selectConversation,
  startNewChat,
} from "./api";
import { $, escapeHtml } from "./dom";
import { relativeTime } from "./format";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import { showNotice } from "./notice";
import {
  beginOverlay,
  closeOverlays,
  hideOverlays,
  rememberOverlayTrigger,
} from "./overlays";
import type { AppContext } from "./types";

/**
 * 会话选择列表（左侧抽屉），按工作区分组。
 *
 * 展示内容与桌面侧边栏对齐：
 * - 每条会话带运行状态（需处理 / 已暂停 / 运行中 / 已完成），与桌面同源；
 * - 主会话可展开树形子层（Workflow 节点会话 → 其子代理，以及主会话直接
 *   派生的子代理），子会话可直接点击打开；
 * - 工作区分组可收起：默认只展开当前使用的工作区（未使用的项目默认收起）。
 *
 * 分页模型：
 * - state 每轮提供每个工作区的最新一页（conversationTotals 里带总数）；
 * - 「加载更多」按 offset = 该组已加载条目数向前翻页，结果累积在
 *   extraByDirectory，与会话内记录一样不受 state 窗口滑动影响；
 * - 列表渲染带签名比较：数据未变化时完全不触碰 DOM（每轮轮询零成本），
 *   只有内容/加载状态/展开状态（含分组收起）变化才重建。
 */

/** 每次「加载更多」的分页大小（与 bridge 首屏页长同量级）。 */
const THREADS_PAGE_SIZE = 20;

/** 通过「加载更多」追加的条目（offset > 首屏页），key = directoryId。 */
const extraByDirectory = new Map<string, SnowRemoteConversation[]>();
/** 分页响应里的总数覆盖（state.conversationTotals 的补充/刷新）。 */
const totalOverrides = new Map<string, number>();
let loadingDirectory: string | null = null;
let lastState: SnowRemoteState | null = null;
let renderedKey = "";
/** 已展开子层的会话 id（主会话与 Workflow 节点会话共用一套展开状态）。 */
const expandedIds = new Set<string>();
/** 分组（工作区）展开状态的手动覆盖：true = 展开，false = 收起；未覆盖走默认。 */
const groupOverrides = new Map<string, boolean>();
/**
 * 乐观选中的目标会话：点击会话后立即按它高亮条目（不等服务端响应），
 * 快照的 activeConversationId 追上目标后自动解除。
 */
let pendingConversationId: string | null = null;

/** 列表应高亮的会话：优先乐观选中的目标，其次快照里的活动会话。 */
const activeConversationIdOf = (next: SnowRemoteState): string | null =>
  pendingConversationId ?? next.activeConversationId ?? null;

type ThreadGroup = {
  name: string;
  directoryId: string;
  items: SnowRemoteConversation[];
  total: number;
};

/**
 * 排序规则与桌面侧边栏一致（renderer/components/sidebar/mainSidebar/chats/
 * conversationSort.ts）：运行中 / 需关注的会话永远置顶，置顶组内与其余条目都
 * 按 updatedAt 倒序。
 *
 * 必须比较时间戳而不是字符串字典序：占位会话的 updatedAt 是 ISO 格式（带 T
 * 与 Z），数据库返回的是 SQLite 本地时间格式（空格分隔、无时区），两种格式的
 * 字典序与真实时间顺序不一致，会把新会话排到旧会话下方。
 */
const conversationTime = (conversation: SnowRemoteConversation): number => {
  const raw = conversation.updatedAt.trim();
  if (!raw) return 0;
  const time = new Date(
    raw.includes("T") ? raw : raw.replace(" ", "T"),
  ).getTime();
  return Number.isNaN(time) ? 0 : time;
};

const compareConversations = (
  left: SnowRemoteConversation,
  right: SnowRemoteConversation,
): number =>
  conversationTime(right) - conversationTime(left) ||
  right.conversationId.localeCompare(left.conversationId);

/** 运行中或需关注（与桌面 runningConversationIds 同义）：这类会话永远置顶。 */
const isRunningConversation = (conversation: SnowRemoteConversation): boolean =>
  conversation.isStreaming || conversation.attentionRequired;

/** state 首页 + 本地加载的更多页，按工作区合并去重并排序。 */
const buildGroups = (next: SnowRemoteState): ThreadGroup[] => {
  const groups = new Map<string, ThreadGroup>();
  const stateIds = new Set(
    next.conversations.map((conversation) => conversation.conversationId),
  );
  const add = (conversation: SnowRemoteConversation): void => {
    const name =
      conversation.workspaceName || t("remote.threads.otherWorkspace");
    let group = groups.get(conversation.directoryId);
    if (!group) {
      group = {
        name,
        directoryId: conversation.directoryId,
        items: [],
        total: 0,
      };
      groups.set(conversation.directoryId, group);
    }
    group.items.push(conversation);
  };

  for (const conversation of next.conversations) add(conversation);
  for (const [directoryId, extra] of extraByDirectory) {
    for (const conversation of extra) {
      if (!stateIds.has(conversation.conversationId)) add(conversation);
    }
  }

  for (const group of groups.values()) {
    group.total = Math.max(
      group.items.length,
      totalOverrides.get(group.directoryId) ??
        next.conversationTotals[group.directoryId] ??
        group.items.length,
    );
    // 运行中 / 需关注的会话置顶（同桌面侧边栏）：否则多个会话同时运行时，
    // 每个会话一收到消息就会被顶到最前，整列条目跟着位移。
    const running = group.items.filter(isRunningConversation);
    const rest = group.items.filter(
      (conversation) => !isRunningConversation(conversation),
    );
    running.sort(compareConversations);
    rest.sort(compareConversations);
    group.items = [...running, ...rest];
  }
  return Array.from(groups.values());
};

/**
 * 会话（含树形子层）的签名片段：任一可见字段变化都必须触发列表重建，
 * 因此运行状态、子代理名与子树结构全部参与比较。
 */
const conversationDigest = (conversation: SnowRemoteConversation): string =>
  [
    conversation.conversationId,
    conversation.updatedAt,
    conversation.status,
    conversation.title,
    conversation.summary,
    conversation.lastMessagePreview,
    conversation.conversationType,
    conversation.subAgentName,
    conversation.runStatus,
    conversation.isStreaming ? "1" : "0",
    conversation.isPaused ? "1" : "0",
    conversation.attentionRequired ? "1" : "0",
    conversation.isCompleted ? "1" : "0",
    conversation.children.map(conversationDigest).join("\u0006"),
  ].join("\u0003");

const threadsSignature = (
  groups: ThreadGroup[],
  groupState: string,
  activeConversationId: string | null,
): string =>
  [
    // 分钟级时间桶：让相对时间标签自然刷新，同时避免每轮重建。
    String(Math.floor(Date.now() / 60000)),
    activeConversationId ?? "",
    loadingDirectory ?? "",
    // 展开状态参与签名：点击箭头后无需等待下一轮快照即可重绘。
    Array.from(expandedIds).sort().join(","),
    // 分组（项目）收起状态同理参与签名。
    groupState,
    groups
      .map((group) =>
        [
          group.directoryId,
          group.name,
          String(group.total),
          group.items.map(conversationDigest).join("\u0001"),
        ].join("\u0002"),
      )
      .join("\u0004"),
  ].join("\u0005");

/** 列表条目的状态指示（图标 + 色调 + 无障碍文案）。 */
type ThreadStatus = {
  icon: MobileIconName;
  tone: string;
  label: string;
};

/** 主会话状态：需处理 > 已暂停 > 运行中 > 已完成（优先级同桌面侧边栏）。 */
const conversationStatus = (
  conversation: SnowRemoteConversation,
): ThreadStatus | null => {
  if (conversation.attentionRequired) {
    return {
      icon: "circle-alert",
      tone: "attention",
      label: t("remote.threads.statusAttention"),
    };
  }
  if (conversation.isPaused) {
    return {
      icon: "pause",
      tone: "paused",
      label: t("remote.threads.statusPaused"),
    };
  }
  if (conversation.isStreaming) {
    return {
      icon: "loader-circle",
      tone: "running",
      label: t("remote.threads.statusStreaming"),
    };
  }
  if (conversation.isCompleted) {
    return {
      icon: "circle-check",
      tone: "completed",
      label: t("remote.threads.statusCompleted"),
    };
  }
  return null;
};

/**
 * 子会话（Workflow 节点 / 子代理）状态：运行态来自 DB 的 runStatus，
 * 待确认（提问 / 授权）优先；静态状态回落到节点 / 子代理图标。
 */
const childStatus = (conversation: SnowRemoteConversation): ThreadStatus => {
  if (conversation.attentionRequired) {
    return {
      icon: "circle-alert",
      tone: "attention",
      label: t("remote.threads.statusAttention"),
    };
  }
  if (conversation.runStatus === "running") {
    return {
      icon: "loader-circle",
      tone: "running",
      label: t("remote.threads.statusStreaming"),
    };
  }
  if (conversation.runStatus === "failed") {
    return {
      icon: "circle-x",
      tone: "failed",
      label: t("remote.threads.statusFailed"),
    };
  }
  if (conversation.runStatus === "completed") {
    return {
      icon: "circle-check",
      tone: "completed",
      label: t("remote.threads.statusCompleted"),
    };
  }
  return {
    icon:
      conversation.conversationType === "workflow_node" ? "workflow" : "bot",
    tone: "idle",
    label: "",
  };
};

/** 主会话展示名（与桌面一致：summary 优先，其次 title）。 */
const conversationName = (conversation: SnowRemoteConversation): string =>
  conversation.summary || conversation.title || t("remote.threads.untitled");

/** 子会话展示名：子代理摘要优先，其次子代理名 / 节点标题。 */
const childName = (conversation: SnowRemoteConversation): string =>
  (conversation.conversationType === "sub_agent" ? conversation.summary : "") ||
  conversation.subAgentName ||
  conversation.title ||
  t(
    conversation.conversationType === "workflow_node"
      ? "remote.threads.workflowNode"
      : "remote.threads.subAgent",
  );

/**
 * 子层是否展开：手动展开优先；当前激活会话位于子层时自动展开（不写入状态），
 * 保证从手机端打开节点 / 子代理会话后，列表里能直接看到它在树中的位置。
 */
const isChildrenExpanded = (
  conversation: SnowRemoteConversation,
  activeConversationId: string | null,
): boolean =>
  expandedIds.has(conversation.conversationId) ||
  (activeConversationId !== null &&
    conversation.children.some(
      (child) =>
        child.conversationId === activeConversationId ||
        child.children.some(
          (grandChild) => grandChild.conversationId === activeConversationId,
        ),
    ));

/** 圆形徽标标记：运行状态与会话类型图标共用同一外观（桌面 .chat-item-icon）。 */
const badgeMarkup = (
  icon: MobileIconName,
  tone: string,
  modifier: string,
  label: string,
): string => {
  const described = label
    ? ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"`
    : "";
  return `<span class="thread-item-status${tone ? ` ${tone}` : ""}${modifier}"${described}>${iconMarkup(icon)}</span>`;
};

/**
 * 主会话类型图标（无运行状态时），优先级与桌面 ChatItem 一致：
 * Workflow 主会话（存在节点会话）> 分支会话 > 默认对话图标；
 * 默认图标在会话直接派生了子代理时加紫色描边（桌面 .has-sub-agents）。
 */
const conversationTypeBadgeHtml = (
  conversation: SnowRemoteConversation,
): string => {
  const children = conversation.children;
  if (children.some((child) => child.conversationType === "workflow_node")) {
    return badgeMarkup(
      "workflow",
      "workflow",
      "",
      t("remote.threads.workflowSession"),
    );
  }
  if (conversation.isForked) {
    return badgeMarkup(
      "git-fork",
      "forked",
      "",
      t("remote.threads.forkedSession"),
    );
  }
  const hasSubAgents = children.some(
    (child) => child.conversationType === "sub_agent",
  );
  return badgeMarkup(
    "message-square-more",
    "",
    hasSubAgents ? " has-sub-agents" : "",
    hasSubAgents ? t("remote.threads.hasSubAgents") : "",
  );
};

/**
 * 会话徽标：与桌面 .chat-item-icon 同构——带描边与底色的圆形图标，
 * 优先级为「运行状态 > 会话类型」。
 * 子会话的静态图标由 childStatus 提供（bot / workflow），不会落到类型图标。
 */
const statusBadgeHtml = (
  conversation: SnowRemoteConversation,
  status: ThreadStatus | null,
): string => {
  if (status) {
    return badgeMarkup(status.icon, status.tone, "", status.label);
  }
  return conversationTypeBadgeHtml(conversation);
};

/**
 * 状态文案胶囊（桌面 .chat-item-status-label）：主会话在「需处理 / 已完成」时
 * 展示文字，子会话只在「需处理」时展示——否则一个流程跑完会出现满屏「已完成」。
 */
const statusPillHtml = (
  status: ThreadStatus | null,
  isChild: boolean,
): string => {
  if (!status?.label) return "";
  const visible =
    status.tone === "attention" || (!isChild && status.tone === "completed");
  return visible
    ? `<span class="thread-item-status-label ${status.tone}">${escapeHtml(status.label)}</span>`
    : "";
};

/** 单个会话条目（含其展开后的树形子层）；depth 决定缩进层级。 */
const conversationHtml = (
  conversation: SnowRemoteConversation,
  activeConversationId: string | null,
  depth: number,
): string => {
  const isChild = depth > 0;
  const active = conversation.conversationId === activeConversationId;
  const children = conversation.children;
  const expanded = isChildrenExpanded(conversation, activeConversationId);
  const toggleHtml =
    children.length > 0
      ? `<span class="thread-item-toggle" data-toggle-children="${escapeHtml(conversation.conversationId)}" role="button" tabindex="-1" aria-expanded="${expanded}" aria-label="${escapeHtml(t(expanded ? "remote.threads.collapseChildren" : "remote.threads.expandChildren"))}"><span class="thread-item-chevron${expanded ? " expanded" : ""}">${iconMarkup("chevron-right")}</span></span>`
      : "";
  const nameHtml = `<span class="thread-item-title">${escapeHtml(isChild ? childName(conversation) : conversationName(conversation))}</span>`;
  const status = isChild
    ? childStatus(conversation)
    : conversationStatus(conversation);
  const badgeHtml = statusBadgeHtml(conversation, status);
  const pillHtml = statusPillHtml(status, isChild);
  // 子会话只展示名称与时间，保持树形紧凑（与桌面子代理面板一致）。
  const previewHtml = isChild
    ? ""
    : `<span class="thread-item-preview">${escapeHtml(conversation.lastMessagePreview || t("remote.threads.noPreview"))}</span>`;
  const nestedHtml = expanded
    ? children
        .map((child) =>
          conversationHtml(child, activeConversationId, depth + 1),
        )
        .join("")
    : "";

  return `<button class="thread-item${active ? " active" : ""}" data-conversation="${escapeHtml(conversation.conversationId)}" data-directory="${escapeHtml(conversation.directoryId)}" data-depth="${depth}"><span class="thread-item-head">${toggleHtml}${badgeHtml}${nameHtml}${pillHtml}</span>${previewHtml}<span class="thread-item-time">${escapeHtml(relativeTime(conversation.updatedAt))}</span></button>${nestedHtml}`;
};

/**
 * 默认展开的分组 = 当前使用的工作区；该工作区不在列表里（无活动工作区 /
 * 会话都在别处）时退回第一组，避免打开列表看到一片全收起的空列表。
 */
const defaultOpenDirectory = (
  groups: ThreadGroup[],
  state: SnowRemoteState,
): string => {
  const workspaceId = state.workspace?.directoryId ?? "";
  if (groups.some((group) => group.directoryId === workspaceId)) {
    return workspaceId;
  }
  return groups[0]?.directoryId ?? "";
};

/** 分组是否展开：手动覆盖优先，否则只展开默认分组（未使用的项目默认收起）。 */
const isGroupExpanded = (directoryId: string, defaultOpen: string): boolean =>
  groupOverrides.get(directoryId) ?? directoryId === defaultOpen;

/** 分组头（项目名 + 收起/展开箭头 + 条目数）：整行可点，收起后不渲染条目。 */
const groupHeaderHtml = (group: ThreadGroup, expanded: boolean): string => {
  const toggleLabel = t(
    expanded ? "remote.threads.collapseGroup" : "remote.threads.expandGroup",
  );
  return (
    `<button class="workspace-toggle" type="button" data-toggle-group="${escapeHtml(group.directoryId)}" aria-expanded="${expanded}" aria-label="${escapeHtml(toggleLabel)}">` +
    `<span class="thread-item-chevron${expanded ? " expanded" : ""}">${iconMarkup("chevron-right")}</span>` +
    `<span class="workspace-name">${escapeHtml(group.name)}</span>` +
    `<span class="workspace-count">${group.items.length}</span>` +
    `</button>`
  );
};

const groupHtml = (
  group: ThreadGroup,
  activeConversationId: string | null,
  expanded: boolean,
): string => {
  const header = groupHeaderHtml(group, expanded);
  if (!expanded) {
    return `<section class="workspace-group collapsed">${header}</section>`;
  }

  const items = group.items
    .map((conversation) =>
      conversationHtml(conversation, activeConversationId, 0),
    )
    .join("");

  let footer = "";
  if (group.items.length < group.total) {
    const loading = loadingDirectory === group.directoryId;
    const label = loading
      ? t("remote.threads.loading")
      : t("remote.threads.loadMore");
    const disabled = loadingDirectory !== null;
    footer = `<div class="thread-more"><button class="thread-more-button${loading ? " loading" : ""}" type="button" data-load-more="${escapeHtml(group.directoryId)}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button></div>`;
  }

  return `<section class="workspace-group">${header}${items}${footer}</section>`;
};

/** 会话选择列表渲染（由 main.ts 每轮快照调用）。 */
export const renderThreads = (next: SnowRemoteState): void => {
  lastState = next;
  // 快照已追上乐观选中：解除覆盖，之后一律以快照为准。
  if (pendingConversationId === next.activeConversationId) {
    pendingConversationId = null;
  }
  const activeConversationId = activeConversationIdOf(next);
  const groups = buildGroups(next);
  const defaultOpen = defaultOpenDirectory(groups, next);
  const expandedByDirectory = new Map(
    groups.map((group) => [
      group.directoryId,
      isGroupExpanded(group.directoryId, defaultOpen),
    ]),
  );
  const groupState = groups
    .map(
      (group) =>
        group.directoryId +
        (expandedByDirectory.get(group.directoryId) ? ":1" : ":0"),
    )
    .join(",");
  const key = threadsSignature(groups, groupState, activeConversationId);
  if (key === renderedKey) return;
  renderedKey = key;

  const html = groups
    .map((group) =>
      groupHtml(
        group,
        activeConversationId,
        expandedByDirectory.get(group.directoryId) === true,
      ),
    )
    .join("");
  $("threadList").innerHTML =
    html || `<div class="empty">${t("remote.threads.empty")}</div>`;
};

const loadMoreConversations = async (directoryId: string): Promise<void> => {
  if (loadingDirectory || !lastState) return;
  const group = buildGroups(lastState).find(
    (item) => item.directoryId === directoryId,
  );
  if (!group) return;

  loadingDirectory = directoryId;
  renderThreads(lastState);
  try {
    const page = await fetchMoreConversations(
      directoryId,
      group.items.length,
      THREADS_PAGE_SIZE,
    );
    const known = new Set([
      ...lastState.conversations.map(
        (conversation) => conversation.conversationId,
      ),
      ...(extraByDirectory.get(directoryId) ?? []).map(
        (conversation) => conversation.conversationId,
      ),
    ]);
    const extra = extraByDirectory.get(directoryId) ?? [];
    for (const conversation of page.items) {
      if (known.has(conversation.conversationId)) continue;
      known.add(conversation.conversationId);
      extra.push(conversation);
    }
    extraByDirectory.set(directoryId, extra);
    totalOverrides.set(directoryId, page.total);
  } catch (error) {
    showNotice(
      (error as Error).message || t("remote.threads.loadMoreFailed"),
      true,
    );
  } finally {
    loadingDirectory = null;
    if (lastState) renderThreads(lastState);
  }
};

/** 新建会话：创建 → 失效消息区缓存 → 刷新快照（顶栏按钮与动作面板共用）。 */
export const createNewChat = async (ctx: AppContext): Promise<void> => {
  await startNewChat();
  ctx.invalidateTimeline();
  await ctx.refresh(false);
};

/**
 * 切换会话（会话列表、只读收尾栏的「返回主会话」与 Workflow 节点会话共用）：
 * 关闭浮层 → 立即高亮目标条目并显示骨架屏 → 通知桌面端切换 → 刷新快照。
 *
 * 选中与骨架屏是乐观反馈（不等服务端响应），与桌面端「选中即切换、历史加载中
 * 显示骨架屏」一致：点击的瞬间列表条目就切换、消息区进入加载占位，桌面端切换
 * 结果到达后由快照接管；请求失败或快照未跟上则回退到真实快照。
 * directoryId 为空时由桌面端按会话记录解析。
 */
export const selectThread = async (
  ctx: AppContext,
  conversationId: string,
  directoryId: string,
): Promise<void> => {
  if (!conversationId) return;
  closeOverlays(false);
  // 已是当前会话：只收起列表，不重复切换（避免多余的骨架屏闪烁）。
  if (conversationId === lastState?.activeConversationId) return;
  pendingConversationId = conversationId;
  if (lastState) renderThreads(lastState);
  ctx.beginConversationSwitch(conversationId);
  // 骨架屏已就位：让下一次快照必定重绘消息区（即使签名未变），避免过渡态滞留。
  ctx.invalidateTimeline();
  try {
    await selectConversation(conversationId, directoryId);
    await ctx.refresh(false);
  } catch (error) {
    showNotice((error as Error).message, true);
  } finally {
    if (pendingConversationId === conversationId) {
      // 切换未生效（请求失败 / 快照未跟上）：撤销乐观选中，回退到真实快照。
      pendingConversationId = null;
      if (lastState) renderThreads(lastState);
      ctx.cancelConversationSwitch();
    }
  }
};

const openThreadSheet = (): void => {
  rememberOverlayTrigger();
  hideOverlays();
  beginOverlay();
  $("scrim").classList.add("open");
  $("threadSheet").classList.add("open");
};

/**
 * 递归查找会话（含 Workflow 节点与子代理子层）：顶栏标题据此识别子会话，
 * 避免打开子会话后标题退化为「新对话」。
 */
export const findConversation = (
  state: SnowRemoteState | null,
  conversationId: string | null,
): SnowRemoteConversation | null => {
  if (!state || !conversationId) return null;
  const search = (
    items: SnowRemoteConversation[],
  ): SnowRemoteConversation | null => {
    for (const item of items) {
      if (item.conversationId === conversationId) return item;
      const found = search(item.children);
      if (found) return found;
    }
    return null;
  };
  return search(state.conversations);
};

export const initThreads = (ctx: AppContext): void => {
  $("historyButton").onclick = openThreadSheet;
  $("closeSheet").onclick = () => {
    closeOverlays(false);
  };
  $("scrim").onclick = () => {
    closeOverlays(false);
  };
  $("threadList").onclick = async (event) => {
    const target = event.target as HTMLElement;
    const loadMoreButton = target.closest<HTMLElement>("[data-load-more]");
    if (loadMoreButton) {
      const directoryId = loadMoreButton.dataset.loadMore ?? "";
      if (directoryId) await loadMoreConversations(directoryId);
      return;
    }
    // 子层展开/收起：不打开会话，只重绘列表（签名变化即触发重建）。
    const toggle = target.closest<HTMLElement>("[data-toggle-children]");
    if (toggle) {
      const conversationId = toggle.dataset.toggleChildren ?? "";
      if (conversationId) {
        if (expandedIds.has(conversationId)) {
          expandedIds.delete(conversationId);
        } else {
          expandedIds.add(conversationId);
        }
        if (lastState) renderThreads(lastState);
      }
      return;
    }
    // 分组（项目）收起/展开：不打开会话，只重绘列表。
    const groupToggle = target.closest<HTMLElement>("[data-toggle-group]");
    if (groupToggle) {
      const directoryId = groupToggle.dataset.toggleGroup ?? "";
      if (directoryId && lastState) {
        const expanded =
          groupOverrides.get(directoryId) ??
          directoryId ===
            defaultOpenDirectory(buildGroups(lastState), lastState);
        groupOverrides.set(directoryId, !expanded);
        renderThreads(lastState);
      }
      return;
    }
    const button = target.closest<HTMLElement>(".thread-item");
    if (!button) return;
    await selectThread(
      ctx,
      button.dataset.conversation ?? "",
      button.dataset.directory ?? "",
    );
  };
};
