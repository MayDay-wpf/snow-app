import {
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronRight,
  CircleAlert,
  Folder,
  Loader2,
  MessageSquareMore,
  Minus,
  Trash2,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ChatDeleteConfirmDialog } from "./ChatDeleteConfirmDialog";
import { useI18n } from "../../../i18n";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import { PENDING_SESSION_KEY } from "../../mainContent/chatMessages/utils/conversationTypes";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { ChatItem } from "./ChatItem";
import { ChatItemMenu, type ExportFormat } from "./ChatItemMenu";
import { SubAgentListPanel } from "./SubAgentListPanel";
import {
  formatTimeLabel,
  groupConversationsByTime,
  parseDbTimestamp,
  type TimeGroup,
  type TimeGroupKey,
} from "./chatTimeGroup";
import type {
  CrossProjectNotification,
  CrossProjectNotificationGroup,
} from "./useCrossProjectNotifications";

const CHAT_PAGE_SIZE = 20;

/**
 * 排序会话列表：运行中或需关注的会话永远置顶，其余按 updatedAt 倒序。
 *
 * 运行中或需关注的会话（runningConversationIds）内部按 updatedAt 倒序，
 * 其他会话也按 updatedAt 倒序，两组拼接后返回。
 *
 * 必须基于时间戳比较，不能直接用字符串 localeCompare：
 * 占位符会话的 updatedAt 是 ISO UTC 格式（带 T 与 Z），
 * 而数据库返回的是 SQLite 本地时间格式（空格分隔、无时区），
 * 两种格式的字典序与真实时间顺序不一致，会导致新会话排到旧会话下方。
 *
 * runningConversationIds 仅在流式或待处理交互的生命周期边界变化，
 * 不会随每个流式 token 更新，因此不会导致流式过程中频繁重排序。
 */
const sortConversationsByUpdatedAt = (
  items: ChatConversationRecord[],
  runningConversationIds?: Set<string>
): ChatConversationRecord[] => {
  if (!runningConversationIds || runningConversationIds.size === 0) {
    return [...items].sort(
      (a, b) =>
        parseDbTimestamp(b.updatedAt).getTime() -
          parseDbTimestamp(a.updatedAt).getTime() ||
        b.conversationId.localeCompare(a.conversationId)
    );
  }

  const running: ChatConversationRecord[] = [];
  const rest: ChatConversationRecord[] = [];
  for (const item of items) {
    if (runningConversationIds.has(item.conversationId)) {
      running.push(item);
    } else {
      rest.push(item);
    }
  }

  const compareByTime = (
    a: ChatConversationRecord,
    b: ChatConversationRecord
  ): number =>
    parseDbTimestamp(b.updatedAt).getTime() -
      parseDbTimestamp(a.updatedAt).getTime() ||
    b.conversationId.localeCompare(a.conversationId);

  running.sort(compareByTime);
  rest.sort(compareByTime);

  return [...running, ...rest];
};

type ChatsSectionProps = {
  isSwitchingDirectory: boolean;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** 跨项目通知（其他项目的运行中/需关注/已完成会话分组） */
  crossProjectNotifications: CrossProjectNotificationGroup[];
};

type SubAgentMap = Record<string, ChatConversationRecord[]>;

export function ChatsSection({
  isSwitchingDirectory,
  activeDirectory,
  crossProjectNotifications,
}: ChatsSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    conversationListVersion,
    upsertedConversation,
    subAgentSessionEvents,
    refreshConversations,
    updateConversationSummary,
    handleSelectConversation,
    handleNewChat,
    activeConversationId,
    abortConversation,
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
    clearInputDraft,
  } = useChatConversationContext();
  const runningConversationIds = useMemo(
    () =>
      new Set([
        ...streamingConversationIds,
        ...attentionRequiredConversationIds,
      ]),
    [streamingConversationIds, attentionRequiredConversationIds]
  );
  const [conversations, setConversations] = useState<ChatConversationRecord[]>(
    []
  );
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subAgentMap, setSubAgentMap] = useState<SubAgentMap>({});
  const [expandedSubAgentConversationIds, setExpandedSubAgentConversationIds] =
    useState<Set<string>>(() => new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // 批量删除确认：所选会话引用的图库图片数（null = 未查询），
  // 以及用户是否选择级联删除图片
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchImagesCount, setBatchImagesCount] = useState<number | null>(null);
  const [batchDeleteImages, setBatchDeleteImages] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  // 会话区域收起/展开（localStorage 持久化，与项目区域一致）
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem("chats-section-collapsed") === "true";
    } catch {
      return false;
    }
  });
  // 时间分组（运行中/今天/昨天/近7天/更早）收起状态（localStorage 持久化）
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const raw = localStorage.getItem("chats-time-groups-collapsed");
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  // 「其他项目」跨项目通知区块收起状态（localStorage 持久化）
  const [isCrossProjectCollapsed, setIsCrossProjectCollapsed] = useState(() => {
    try {
      return localStorage.getItem("chats-cross-project-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const sectionListRef = useRef<HTMLDivElement | null>(null);
  // 始终持有最新 conversations，供子代理加载 effect 读取。
  // effect 仅以会话 id 集合为依赖：upsert/重排（id 不变）不会重查子代理。
  const conversationsRef = useRef<ChatConversationRecord[]>([]);
  conversationsRef.current = conversations;
  const conversationIdsKey = conversations
    .map((conv) => conv.conversationId)
    .join("\u0000");

  const directoryId = activeDirectory?.directoryId ?? "";
  const hasMore = conversations.length < total;

  useEffect(() => {
    if (!directoryId) {
      setConversations([]);
      setTotal(0);
      return;
    }

    let cancelled = false;

    const loadFirstPage = async (): Promise<void> => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await window.snow.listChatConversationsPaginated(
          directoryId,
          CHAT_PAGE_SIZE,
          0
        );

        if (!cancelled) {
          setConversations(result.items);
          setTotal(result.total);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : t("sidebar.loadChatsError", {
                  defaultValue: "Failed to load chats",
                })
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadFirstPage();

    return () => {
      cancelled = true;
    };
  }, [directoryId, t, conversationListVersion]);

  useEffect(() => {
    if (!upsertedConversation) {
      return;
    }

    const { record: conv } = upsertedConversation;
    if (conv.directoryId !== directoryId) {
      return;
    }
    if (conv.status === "pin") {
      return;
    }

    let isNew = false;
    setConversations((prev) => {
      const existingIndex = prev.findIndex(
        (item) => item.conversationId === conv.conversationId
      );

      if (existingIndex >= 0) {
        // 记录内容未变化时保持原引用，避免无意义的替换与重排序
        // （AI 响应结束后的冗余 upsert 不会触发列表重渲染）
        const existing = prev[existingIndex];
        if (JSON.stringify(existing) === JSON.stringify(conv)) {
          return prev;
        }
        const updated = prev.map((item) =>
          item.conversationId === conv.conversationId ? conv : item
        );
        return sortConversationsByUpdatedAt(updated, runningConversationIds);
      }

      // If the real conversation arrives, replace the pending placeholder.
      const pendingIndex = prev.findIndex(
        (item) => item.conversationId === PENDING_SESSION_KEY
      );
      if (pendingIndex >= 0) {
        const replaced = prev.map((item, index) =>
          index === pendingIndex ? conv : item
        );
        return sortConversationsByUpdatedAt(replaced, runningConversationIds);
      }

      isNew = true;
      // New conversation: prepend and re-sort by updatedAt
      return sortConversationsByUpdatedAt(
        [conv, ...prev],
        runningConversationIds
      );
    });

    if (isNew) {
      setTotal((prev) => prev + 1);
    }
  }, [upsertedConversation, directoryId, runningConversationIds]);

  // 流式或待处理交互状态变化时，重新排序使相关会话保持在顶部。
  // runningConversationIds 只在生命周期边界变化，不会随每个流式 token 更新。
  useEffect(() => {
    if (runningConversationIds.size === 0) {
      return;
    }
    setConversations((prev) =>
      sortConversationsByUpdatedAt(prev, runningConversationIds)
    );
  }, [runningConversationIds]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (isLoadingMore || !hasMore || !directoryId || isLoading) {
      return;
    }

    setIsLoadingMore(true);

    try {
      const result = await window.snow.listChatConversationsPaginated(
        directoryId,
        CHAT_PAGE_SIZE,
        conversations.length
      );

      setConversations((prev) => [...prev, ...result.items]);
      setTotal(result.total);
    } catch {
      // Silent fail for pagination
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversations.length, directoryId, hasMore, isLoading, isLoadingMore]);

  useEffect(() => {
    if (!hasMore || isLoading) {
      return;
    }

    const sentinel = loadMoreRef.current;

    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      {
        root: sectionListRef.current,
        rootMargin: "0px 0px 64px",
        threshold: 0.1,
      }
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, isLoading, loadMore, conversations.length]);

  const showLoading = isSwitchingDirectory || (isLoading && directoryId !== "");

  // 打开其他项目的通知会话：先激活其所属项目，再打开会话。
  // 激活成功后主进程广播 workspace-directory-list:changed，项目列表与
  // 对话列表会自动刷新到目标项目，随后 handleSelectConversation 加载
  // 会话历史；即使激活失败，会话记录已存在，直接打开也不受影响。
  const handleOpenCrossProjectNotification = async (
    group: CrossProjectNotificationGroup,
    notification: CrossProjectNotification
  ): Promise<void> => {
    try {
      await window.snow.activateWorkspaceDirectory(group.directoryId);
    } catch {
      // 项目切换失败不阻塞会话打开
    }
    await handleSelectConversation(
      notification.conversation.conversationId,
      notification.conversation.summary || notification.conversation.title,
      {
        inputTokens: notification.conversation.inputTokens,
        outputTokens: notification.conversation.outputTokens,
        cacheCreationInputTokens:
          notification.conversation.cacheCreationInputTokens,
        cacheReadInputTokens: notification.conversation.cacheReadInputTokens,
      },
      group.directoryId
    );
  };

  const handlePin = async (
    conversation: ChatConversationRecord
  ): Promise<void> => {
    try {
      await window.snow.updateConversationStatus(
        conversation.conversationId,
        "pin"
      );
      refreshConversations();
    } catch {
      // Silent fail
    }
  };

  const handleRename = async (
    conversation: ChatConversationRecord,
    newTitle: string
  ): Promise<void> => {
    await window.snow.renameConversation(conversation.conversationId, newTitle);
    // 同步更新内存中 session 的 summary，让 TopBar 标题即时刷新
    updateConversationSummary(conversation.conversationId, newTitle);
    refreshConversations();
  };

  const handleSetEmoji = async (
    conversation: ChatConversationRecord,
    emoji: string
  ): Promise<void> => {
    // 乐观更新：直接修改本地 state，异步落库，不刷新列表
    setConversations((prev) =>
      prev.map((item) =>
        item.conversationId === conversation.conversationId
          ? { ...item, emoji }
          : item
      )
    );
    try {
      await window.snow.updateConversationEmoji(
        conversation.conversationId,
        emoji
      );
    } catch {
      // 落库失败时回滚
      setConversations((prev) =>
        prev.map((item) =>
          item.conversationId === conversation.conversationId
            ? { ...item, emoji: conversation.emoji }
            : item
        )
      );
    }
  };

  const handleDelete = async (
    conversation: ChatConversationRecord,
    deleteImages: boolean
  ): Promise<void> => {
    try {
      // 用户选择不保留图片时，先级联删除图库图片（物理 + 索引），
      // 再执行会话删除；删除失败不阻断会话删除
      if (deleteImages) {
        await window.snow.deleteConversationImages([
          conversation.conversationId,
        ]);
      }

      // Rust 侧级联删除子代理会话：收集全部待删 ID，以便中止对应流，
      // 并在当前正打开被删会话或其子代理时清空聊天区
      const deleteTargetIds = [
        conversation.conversationId,
        ...(subAgentMap[conversation.conversationId] ?? []).map(
          (sub) => sub.conversationId
        ),
      ];
      for (const targetId of deleteTargetIds) {
        abortConversation(targetId);
      }

      await window.snow.deleteConversation(conversation.conversationId);

      // 删除的会话不再需要保留输入草稿
      for (const targetId of deleteTargetIds) {
        clearInputDraft(targetId);
      }

      if (
        activeConversationId &&
        deleteTargetIds.includes(activeConversationId)
      ) {
        handleNewChat();
      }
      refreshConversations();
    } catch {
      // Silent fail
    }
  };

  const handleExport = async (
    conversation: ChatConversationRecord,
    format: ExportFormat
  ): Promise<void> => {
    const fileName =
      conversation.summary ||
      conversation.title ||
      t("sidebar.untitledChat", { defaultValue: "Untitled" });
    await window.snow.exportConversation(
      conversation.conversationId,
      format,
      fileName
    );
  };

  const handleEnterMultiSelect = (): void => {
    setSelectedIds(new Set());
    setIsMultiSelectMode(true);
  };

  const handleExitMultiSelect = (): void => {
    if (isBatchDeleting) {
      return;
    }
    setIsMultiSelectMode(false);
    setSelectedIds(new Set());
    setShowBatchConfirm(false);
  };

  /** 收起/展开会话区域；收起时退出多选模式并持久化到 localStorage */
  const toggleCollapsed = (): void => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("chats-section-collapsed", String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
    if (isMultiSelectMode) {
      handleExitMultiSelect();
    }
  };

  const handleToggleSelect = (conversationId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  const handleSelectAll = (): void => {
    const allIds = conversations
      .filter((conv) => conv.conversationId !== PENDING_SESSION_KEY)
      .map((conv) => conv.conversationId);
    setSelectedIds(new Set(allIds));
  };
  const handleDeselectAll = (): void => {
    setSelectedIds(new Set());
  };

  /**
   * 分组粒度的全选/取消全选：目标分组内全部已选时取消该组，
   * 否则选中该组全部（与顶部全局全选互不影响）。
   */
  const handleToggleGroupSelect = (group: TimeGroup): void => {
    const groupIds = group.conversations
      .filter((conv) => conv.conversationId !== PENDING_SESSION_KEY)
      .map((conv) => conv.conversationId);
    if (groupIds.length === 0) {
      return;
    }
    const allSelected = groupIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of groupIds) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  };

  // 打开批量删除确认框：查询所选会话引用的图库图片数
  const handleOpenBatchConfirm = (): void => {
    setShowBatchConfirm(true);
    setBatchImagesCount(null);
    setBatchDeleteImages(false);
    if (selectedIds.size > 0) {
      void window.snow
        .countConversationImages([...selectedIds])
        .then((count) => setBatchImagesCount(count))
        .catch(() => setBatchImagesCount(0));
    }
  };

  const handleBatchDelete = async (): Promise<void> => {
    if (isBatchDeleting || selectedIds.size === 0) {
      return;
    }

    setIsBatchDeleting(true);
    setShowBatchConfirm(false);

    try {
      // 用户选择不保留图片时，先级联删除所选会话引用的图库图片
      // （物理 + 索引；会话随后被删除，无需重写消息）
      if (batchDeleteImages && (batchImagesCount ?? 0) > 0) {
        await window.snow.deleteConversationImages([...selectedIds]);
      }

      // 收集所有受影响会话 ID（含子代理级联），用于中止流/清空聊天区
      const targetIds = new Set<string>();
      for (const convId of selectedIds) {
        targetIds.add(convId);
        const subs = subAgentMap[convId] ?? [];
        for (const sub of subs) {
          targetIds.add(sub.conversationId);
        }
      }

      for (const targetId of targetIds) {
        abortConversation(targetId);
      }

      // 单次批量删除：native 单事务完成（选中父会话时子代理随级联删除），
      // 避免逐条 IPC + 逐条事务（N+1）
      await window.snow.deleteConversations([...selectedIds]);

      // 删除的会话不再需要保留输入草稿
      for (const targetId of targetIds) {
        clearInputDraft(targetId);
      }

      if (activeConversationId && targetIds.has(activeConversationId)) {
        handleNewChat();
      }
      refreshConversations();
      setSelectedIds(new Set());
      setIsMultiSelectMode(false);
    } catch {
      // Silent fail
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const timeGroups = groupConversationsByTime(
    conversations,
    new Date(),
    runningConversationIds
  );

  useEffect(() => {
    const current = conversationsRef.current;
    if (current.length === 0) {
      setSubAgentMap({});
      return;
    }

    let cancelled = false;

    const loadSubAgents = async (): Promise<void> => {
      // 单次批量查询所有父会话的子代理，避免逐条 IPC（N+1）
      try {
        const map = await window.snow.listSubAgentConversationsByParents(
          current.map((conv) => conv.conversationId)
        );
        if (!cancelled) {
          setSubAgentMap(map);
        }
      } catch {
        if (!cancelled) {
          setSubAgentMap({});
        }
      }
    };

    void loadSubAgents();

    return () => {
      cancelled = true;
    };
  }, [conversationIdsKey]);

  useEffect(() => {
    const events = Object.values(subAgentSessionEvents);
    if (events.length === 0) {
      return;
    }

    setSubAgentMap((prev) => {
      let next = prev;
      for (const event of events) {
        const { parentConversationId, conversationId, agentName, status } =
          event;

        const existing = next[parentConversationId] ?? [];
        const existingIndex = existing.findIndex(
          (item) => item.conversationId === conversationId
        );

        const subAgentRecord: ChatConversationRecord = {
          conversationId,
          title: agentName,
          summary: "",
          lastMessagePreview: "",
          messageCount: 0,
          model: "",
          apiProfileName: "",
          status: "active",
          directoryId: "",
          forkedFromConversationId: "",
          forkMessageCount: 0,
          conversationType: "sub_agent",
          parentConversationId,
          subAgentId: event.agentId,
          subAgentName: agentName,
          subAgentStatus: status,
          subAgentError: "",
          createdAt: new Date(event.timestamp).toISOString(),
          updatedAt: new Date(event.timestamp).toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalDurationMs: 0,
          emoji: "",
        };

        if (existingIndex >= 0) {
          const updated = [...existing];
          updated[existingIndex] = {
            ...updated[existingIndex],
            subAgentStatus: status,
            subAgentName: agentName,
          };
          next = { ...next, [parentConversationId]: updated };
        } else {
          next = {
            ...next,
            [parentConversationId]: [...existing, subAgentRecord],
          };
        }
      }
      return next;
    });
  }, [subAgentSessionEvents]);

  // 当激活的会话是某个父会话的子代理时，自动展开该父会话的面板
  useEffect(() => {
    if (!activeConversationId) {
      return;
    }
    setExpandedSubAgentConversationIds((prev) => {
      const parentIds = Object.keys(subAgentMap).filter((parentId) =>
        subAgentMap[parentId].some(
          (sub) => sub.conversationId === activeConversationId
        )
      );
      if (parentIds.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      for (const parentId of parentIds) {
        next.add(parentId);
      }
      return next;
    });
  }, [subAgentMap, activeConversationId]);

  const handleToggleSubAgentPanel = (conversationId: string): void => {
    setExpandedSubAgentConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  const getGroupLabel = (key: TimeGroupKey): string => {
    switch (key) {
      case "running":
        return t("sidebar.chatTimeRunning", { defaultValue: "Running" });
      case "today":
        return t("sidebar.chatTimeToday", { defaultValue: "Today" });
      case "yesterday":
        return t("sidebar.chatTimeYesterday", {
          defaultValue: "Yesterday",
        });
      case "last7days":
        return t("sidebar.chatTimeLast7Days", {
          defaultValue: "Last 7 days",
        });
      case "earlier":
        return t("sidebar.chatTimeEarlier", { defaultValue: "Earlier" });
      default:
        return "";
    }
  };

  /** 收起/展开时间分组并持久化到 localStorage */
  const toggleGroupCollapsed = (key: TimeGroupKey): void => {
    setCollapsedGroupKeys((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(
          "chats-time-groups-collapsed",
          JSON.stringify(next)
        );
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  /** 收起/展开「其他项目」跨项目通知区块并持久化到 localStorage */
  const toggleCrossProjectCollapsed = (): void => {
    setIsCrossProjectCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("chats-cross-project-collapsed", String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  return (
    <div
      className={`sidebar-section chats-section${
        isCollapsed ? " collapsed" : ""
      }`}
    >
      {isMultiSelectMode ? (
        <div className="chat-multi-select-bar">
          <button
            type="button"
            className="chat-multi-select-exit-btn"
            onClick={handleExitMultiSelect}
            disabled={isBatchDeleting}
            title={t("sidebar.chatMultiSelectExit", { defaultValue: "Exit" })}
          >
            <X size={14} />
          </button>
          <span className="chat-multi-select-count">
            {t("sidebar.chatMultiSelectCount", {
              defaultValue: "{{count}} selected",
              values: { count: selectedIds.size },
            })}
          </span>
          <div className="chat-multi-select-actions">
            <button
              type="button"
              className="chat-multi-select-action-btn"
              onClick={() =>
                selectedIds.size ===
                conversations.filter(
                  (conv) => conv.conversationId !== PENDING_SESSION_KEY
                ).length
                  ? handleDeselectAll()
                  : handleSelectAll()
              }
              disabled={isBatchDeleting}
            >
              <CheckSquare size={13} />
              <span>
                {selectedIds.size ===
                conversations.filter(
                  (conv) => conv.conversationId !== PENDING_SESSION_KEY
                ).length
                  ? t("sidebar.chatMultiSelectDeselectAll", {
                      defaultValue: "Deselect all",
                    })
                  : t("sidebar.chatMultiSelectAll", {
                      defaultValue: "Select all",
                    })}
              </span>
            </button>
            <button
              type="button"
              className="chat-multi-select-action-btn danger"
              onClick={handleOpenBatchConfirm}
              disabled={isBatchDeleting || selectedIds.size === 0}
            >
              {isBatchDeleting ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <Trash2 size={13} />
              )}
              <span>
                {isBatchDeleting
                  ? t("sidebar.chatMultiSelectDeleting", {
                      defaultValue: "Deleting...",
                    })
                  : t("sidebar.chatMultiSelectDelete", {
                      defaultValue: "Delete selected",
                    })}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="section-header">
          <button
            type="button"
            aria-expanded={!isCollapsed}
            className="section-toggle-btn chats-section-toggle"
            onClick={toggleCollapsed}
            title={t("sidebar.chatToggleCollapse", {
              defaultValue: "Collapse chats",
            })}
          >
            <ChevronRight
              className={isCollapsed ? "" : "section-toggle-chevron--open"}
              size={12}
            />
            <span className="section-title">
              {t("sidebar.chats", { defaultValue: "Chats" })}
            </span>
          </button>
        </div>
      )}
      {!isCollapsed && (
        <div className="section-list" ref={sectionListRef}>
          {showLoading ? (
            <span className="empty-text loading">
              <Loader2 className="spin" size={13} />
              {t("sidebar.loadingWorkspaceContent", {
                defaultValue: "Loading workspace content...",
              })}
            </span>
          ) : !directoryId ? (
            <span className="empty-text">
              {t("sidebar.noActiveDirectory", {
                defaultValue: "No active directory",
              })}
            </span>
          ) : error ? (
            <span className="empty-text error">{error}</span>
          ) : conversations.length === 0 &&
            crossProjectNotifications.length === 0 ? (
            <span className="empty-text">
              {t("sidebar.noChats", { defaultValue: "No chats" })}
            </span>
          ) : (
            <>
              {/* 跨项目通知：其他项目运行中/需关注/已完成的会话，
                  点击自动切换项目并打开对应会话 */}
              {crossProjectNotifications.length > 0 && (
                <div className="cross-project-notifications">
                  <button
                    type="button"
                    className="cross-project-notifications-header"
                    onClick={toggleCrossProjectCollapsed}
                    aria-expanded={!isCrossProjectCollapsed}
                    title={t("sidebar.crossProjectToggleCollapse", {
                      defaultValue:
                        "Collapse/expand other project notifications",
                    })}
                  >
                    <ChevronRight
                      size={12}
                      className={
                        isCrossProjectCollapsed
                          ? ""
                          : "cross-project-notifications-chevron--open"
                      }
                    />
                    <span>
                      {t("sidebar.crossProjectNotificationsTitle", {
                        defaultValue: "Other projects",
                      })}
                    </span>
                  </button>
                  {!isCrossProjectCollapsed &&
                    crossProjectNotifications.map((group) => (
                      <div
                        className="cross-project-notification-group"
                        key={group.directoryId}
                      >
                        <div className="cross-project-notification-project">
                          <Folder size={11} aria-hidden="true" />
                          <span className="cross-project-notification-project-name">
                            {group.directoryName}
                          </span>
                          <span className="cross-project-notification-project-count">
                            {group.notifications.length}
                          </span>
                        </div>
                        {group.notifications.map((notification) => {
                          const conversation = notification.conversation;
                          const displayName =
                            conversation.summary ||
                            conversation.title ||
                            t("sidebar.untitledChat", {
                              defaultValue: "Untitled",
                            });
                          const parsedDate = parseDbTimestamp(
                            conversation.updatedAt
                          );
                          const timeLabel = formatTimeLabel(
                            parsedDate,
                            new Date(),
                            t
                          );
                          return (
                            <button
                              type="button"
                              className="cross-project-notification-item"
                              key={conversation.conversationId}
                              onClick={() =>
                                void handleOpenCrossProjectNotification(
                                  group,
                                  notification
                                )
                              }
                              title={t(
                                "sidebar.crossProjectNotificationOpenTitle",
                                {
                                  values: {
                                    project: group.directoryName,
                                    conversation: displayName,
                                  },
                                  defaultValue:
                                    "Open {{conversation}} in {{project}}",
                                }
                              )}
                            >
                              <span
                                className={`chat-item-icon${
                                  notification.isAttentionRequired
                                    ? " attention-required"
                                    : notification.isStreaming
                                      ? " streaming"
                                      : notification.isCompleted
                                        ? " completed"
                                        : ""
                                }`}
                              >
                                {notification.isAttentionRequired ? (
                                  <CircleAlert size={12} aria-hidden="true" />
                                ) : notification.isStreaming ? (
                                  <Loader2
                                    size={11}
                                    className="spin"
                                    aria-hidden="true"
                                  />
                                ) : notification.isCompleted ? (
                                  <CheckCircle2 size={12} aria-hidden="true" />
                                ) : (
                                  <MessageSquareMore
                                    size={11}
                                    aria-hidden="true"
                                  />
                                )}
                              </span>
                              <span className="list-label">{displayName}</span>
                              <span className="cross-project-notification-time">
                                {timeLabel}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                </div>
              )}
              {timeGroups.map((group) => {
                const isGroupCollapsed = collapsedGroupKeys[group.key] === true;
                // 分组粒度的选择状态：全部已选 / 部分已选 / 未选
                const groupSelectableIds = group.conversations
                  .filter(
                    (conv) => conv.conversationId !== PENDING_SESSION_KEY
                  )
                  .map((conv) => conv.conversationId);
                const groupSelectedCount = groupSelectableIds.filter((id) =>
                  selectedIds.has(id)
                ).length;
                const isGroupAllSelected =
                  groupSelectableIds.length > 0 &&
                  groupSelectedCount === groupSelectableIds.length;
                const isGroupPartialSelected =
                  groupSelectedCount > 0 && !isGroupAllSelected;
                return (
                  <div key={group.key}>
                    <button
                      type="button"
                      className="chat-time-group-header"
                      onClick={() => toggleGroupCollapsed(group.key)}
                      aria-expanded={!isGroupCollapsed}
                      title={t("sidebar.chatToggleCollapse", {
                        defaultValue: "Collapse/expand chats",
                      })}
                    >
                      <ChevronRight
                        size={12}
                        className={
                          isGroupCollapsed
                            ? ""
                            : "chat-time-group-chevron--open"
                        }
                      />
                      <span>{getGroupLabel(group.key)}</span>
                      <span className="chat-time-group-count">
                        {group.conversations.length}
                      </span>
                      {isMultiSelectMode && groupSelectableIds.length > 0 && (
                        <span
                          className={`chat-time-group-select${
                            isGroupAllSelected ? " checked" : ""
                          }${
                            isGroupPartialSelected ? " indeterminate" : ""
                          }`}
                          role="checkbox"
                          aria-checked={
                            isGroupAllSelected
                              ? true
                              : isGroupPartialSelected
                                ? "mixed"
                                : false
                          }
                          title={
                            isGroupAllSelected
                              ? t(
                                  "sidebar.chatMultiSelectGroupDeselect",
                                  { defaultValue: "Deselect this group" }
                                )
                              : t("sidebar.chatMultiSelectGroupSelect", {
                                  defaultValue: "Select this group",
                                })
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            handleToggleGroupSelect(group);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              handleToggleGroupSelect(group);
                            }
                          }}
                          tabIndex={0}
                        >
                          {isGroupAllSelected ? (
                            <Check size={11} strokeWidth={3} />
                          ) : isGroupPartialSelected ? (
                            <Minus size={11} strokeWidth={3} />
                          ) : null}
                        </span>
                      )}
                    </button>
                    {!isGroupCollapsed &&
                      group.conversations.map((conversation) => {
                        const subAgentConversations =
                          subAgentMap[conversation.conversationId] ?? [];
                        const isSubAgentPanelExpanded =
                          expandedSubAgentConversationIds.has(
                            conversation.conversationId
                          );
                        return (
                          <Fragment key={conversation.conversationId}>
                            <ChatItem
                              conversation={conversation}
                              isActive={
                                conversation.conversationId ===
                                activeConversationId
                              }
                              isAttentionRequired={attentionRequiredConversationIds.has(
                                conversation.conversationId
                              )}
                              isStreaming={streamingConversationIds.has(
                                conversation.conversationId
                              )}
                              isCompleted={completedConversationIds.has(
                                conversation.conversationId
                              )}
                              subAgentConversations={subAgentConversations}
                              isSubAgentExpanded={isSubAgentPanelExpanded}
                              isMultiSelectMode={isMultiSelectMode}
                              isSelected={selectedIds.has(
                                conversation.conversationId
                              )}
                              onToggleSelect={() =>
                                handleToggleSelect(conversation.conversationId)
                              }
                              onEnterMultiSelect={handleEnterMultiSelect}
                              onToggleSubAgentPanel={() =>
                                handleToggleSubAgentPanel(
                                  conversation.conversationId
                                )
                              }
                              onPin={() => void handlePin(conversation)}
                              onRename={(newTitle) =>
                                handleRename(conversation, newTitle)
                              }
                              onSetEmoji={(emoji) =>
                                handleSetEmoji(conversation, emoji)
                              }
                              onDelete={(deleteImages) =>
                                void handleDelete(conversation, deleteImages)
                              }
                              onExport={(format) =>
                                handleExport(conversation, format)
                              }
                              onSelect={() =>
                                void handleSelectConversation(
                                  conversation.conversationId,
                                  conversation.summary || conversation.title,
                                  {
                                    inputTokens: conversation.inputTokens,
                                    outputTokens: conversation.outputTokens,
                                    cacheCreationInputTokens:
                                      conversation.cacheCreationInputTokens,
                                    cacheReadInputTokens:
                                      conversation.cacheReadInputTokens,
                                  },
                                  conversation.directoryId
                                )
                              }
                            />
                            {/* 面板渲染在 ChatItem 外部，作为兄弟节点，
                          完全不继承父级会话项的背景色 */}
                            {subAgentConversations.length > 0 &&
                              isSubAgentPanelExpanded &&
                              !isMultiSelectMode && (
                                <SubAgentListPanel
                                  conversations={subAgentConversations}
                                  activeConversationId={activeConversationId}
                                  onSelect={(subConvId) =>
                                    void handleSelectConversation(
                                      subConvId,
                                      undefined,
                                      undefined,
                                      conversation.directoryId
                                    )
                                  }
                                />
                              )}
                          </Fragment>
                        );
                      })}
                  </div>
                );
              })}
              {hasMore ? (
                <div
                  className={`chat-load-more ${
                    isLoadingMore ? "is-loading" : ""
                  }`}
                  ref={loadMoreRef}
                  role={isLoadingMore ? "status" : undefined}
                  aria-live="polite"
                  aria-label={
                    isLoadingMore
                      ? t("sidebar.chatLoadingMore", {
                          defaultValue: "Loading more chats...",
                        })
                      : undefined
                  }
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="spin" size={14} aria-hidden="true" />
                      <span>
                        {t("sidebar.chatLoadingMore", {
                          defaultValue: "Loading more chats...",
                        })}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="chat-all-loaded">
                  {t("sidebar.chatAllLoaded", {
                    defaultValue: "All chats loaded",
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {/* 单条与批量删除共用同一确认弹窗，并通过 portal 渲染到 body。 */}
      <ChatDeleteConfirmDialog
        conversationCount={selectedIds.size}
        deleteImages={batchDeleteImages}
        imagesCount={batchImagesCount}
        isBatch
        onCancel={() => setShowBatchConfirm(false)}
        onConfirm={() => void handleBatchDelete()}
        onDeleteImagesChange={setBatchDeleteImages}
        open={showBatchConfirm}
      />
    </div>
  );
}
