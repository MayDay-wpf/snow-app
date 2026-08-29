import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronRight,
  CircleAlert,
  Folder,
  ListChecks,
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
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Tooltip } from "../../common/Tooltip";
import { useI18n } from "../../../i18n";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import {
  isPendingSessionKey,
  type ConversationSessionState,
} from "../../mainContent/chatMessages/utils/conversationTypes";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { ArchivedChatItem } from "./ArchivedChatItem";
import { ChatItem } from "./ChatItem";
import { ChatItemMenu, type ExportFormat } from "./ChatItemMenu";
import { isChatDrag, readChatDragData } from "./chatDrag";
import { SubAgentListPanel } from "./SubAgentListPanel";
import { WorkflowNodeListPanel } from "./WorkflowNodeListPanel";
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
const ARCHIVE_PAGE_SIZE = 20;

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
  runningConversationIds?: Set<string>,
): ChatConversationRecord[] => {
  if (!runningConversationIds || runningConversationIds.size === 0) {
    return [...items].sort(
      (a, b) =>
        parseDbTimestamp(b.updatedAt).getTime() -
          parseDbTimestamp(a.updatedAt).getTime() ||
        b.conversationId.localeCompare(a.conversationId),
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
    b: ChatConversationRecord,
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
  /** 收起状态变化时上报父组件（收起后剩余高度让给项目区域） */
  onCollapsedChange?: (collapsed: boolean) => void;
};

type SubAgentMap = Record<string, ChatConversationRecord[]>;

export function ChatsSection({
  isSwitchingDirectory,
  activeDirectory,
  crossProjectNotifications,
  onCollapsedChange,
}: ChatsSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    conversationListVersion,
    upsertedConversation,
    pendingToRealConversationIdRef,
    subAgentSessionEvents,
    refreshConversations,
    updateConversationSummary,
    handleSelectConversation,
    handleForkConversation,
    handleNewChat,
    activeConversationId,
    abortConversation,
    sessions,
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
    [streamingConversationIds, attentionRequiredConversationIds],
  );
  // 被用户暂停的流式会话（agent loop 阻塞等待恢复），图标切换为暂停态
  const pausedConversationIds = useMemo(
    () =>
      new Set(
        Object.entries(sessions)
          .filter(([, session]) => session.isPaused)
          .map(([id]) => id),
      ),
    [sessions],
  );
  const [conversations, setConversations] = useState<ChatConversationRecord[]>(
    [],
  );
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subAgentMap, setSubAgentMap] = useState<SubAgentMap>({});
  // Workflow 主会话 -> 其 workflow 节点会话（树形子层）
  const [workflowNodeMap, setWorkflowNodeMap] = useState<SubAgentMap>({});
  // 含待确认子代理的父会话也视为需关注：与运行中会话一样置顶排序，
  // 保证会话较多时用户不会漏掉被暂停等待确认的子代理
  const surfacedConversationIds = useMemo(() => {
    if (attentionRequiredConversationIds.size === 0) {
      return runningConversationIds;
    }
    const next = new Set(runningConversationIds);
    for (const [parentId, subs] of Object.entries(subAgentMap)) {
      if (
        subs.some((sub) =>
          attentionRequiredConversationIds.has(sub.conversationId),
        )
      ) {
        // 子代理挂在 workflow 节点会话下时，需要继续提升到
        // workflow 主会话（树形层级：Workflow → 节点 → 子代理）
        const workflowParentId = Object.keys(workflowNodeMap).find(
          (workflowId) =>
            (workflowNodeMap[workflowId] ?? []).some(
              (node) => node.conversationId === parentId,
            ),
        );
        next.add(workflowParentId ?? parentId);
      }
    }
    // workflow 节点本身需关注时提升其主会话置顶
    for (const [parentId, nodes] of Object.entries(workflowNodeMap)) {
      if (
        nodes.some((node) =>
          attentionRequiredConversationIds.has(node.conversationId),
        )
      ) {
        next.add(parentId);
      }
    }
    return next;
  }, [
    runningConversationIds,
    attentionRequiredConversationIds,
    subAgentMap,
    workflowNodeMap,
  ]);
  const [expandedSubAgentConversationIds, setExpandedSubAgentConversationIds] =
    useState<Set<string>>(() => new Set());
  // 已展开的 Workflow 主会话（显示节点树）与已展开的节点会话（显示其子代理）
  const [expandedWorkflowConversationIds, setExpandedWorkflowConversationIds] =
    useState<Set<string>>(() => new Set());
  const [
    expandedWorkflowNodeConversationIds,
    setExpandedWorkflowNodeConversationIds,
  ] = useState<Set<string>>(() => new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // 批量删除确认：所选会话引用的图库图片数（null = 未查询），
  // 以及用户是否选择级联删除图片
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchImagesCount, setBatchImagesCount] = useState<number | null>(null);
  const [batchDeleteImages, setBatchDeleteImages] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  /** 单条删除进行中的会话 id 集合 */
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  // 归档模式：true 时侧边栏展示归档会话列表（还原后才能继续使用）
  const [isArchiveMode, setIsArchiveMode] = useState(false);
  const [archivedConversations, setArchivedConversations] = useState<
    ChatConversationRecord[]
  >([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [isArchivedLoading, setIsArchivedLoading] = useState(false);
  const [isArchivedLoadingMore, setIsArchivedLoadingMore] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isArchivedMultiSelect, setIsArchivedMultiSelect] = useState(false);
  // 归档会话永久删除确认：待删除的归档会话 ID（null = 未打开）
  const [archivedDeleteTargetIds, setArchivedDeleteTargetIds] = useState<
    string[] | null
  >(null);
  // 归档/还原/删除进行中（含 VACUUM 收缩文件阶段，可能耗时数秒）：
  // 记录受影响会话 ID 集合，只给这些会话显示 loading，同时防止重复提交
  const [archivingIds, setArchivingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [restoringIds, setRestoringIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingArchivedIds, setDeletingArchivedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const archivedLoadMoreRef = useRef<HTMLDivElement | null>(null);
  // 会话区域收起/展开（localStorage 持久化，与项目区域一致）
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem("chats-section-collapsed") === "true";
    } catch {
      return false;
    }
  });
  // 向父组件同步收起状态：会话收起后剩余高度应让给上方项目区域
  useEffect(() => {
    onCollapsedChange?.(isCollapsed);
  }, [isCollapsed, onCollapsedChange]);
  // 会话拖拽悬停中：高亮提示可放置
  const [isChatDragOver, setIsChatDragOver] = useState(false);
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
  // 运行中/需关注会话 id 集合的实时镜像：列表合并逻辑在异步回调中读取，
  // 不把频繁变化的集合纳入 effect/callback 依赖。
  const runningIdsRef = useRef<Set<string>>(new Set());
  runningIdsRef.current = runningConversationIds;
  // 内存会话状态的实时镜像：合并抓取结果时据此重建运行中 pending 槽位的
  // 占位记录（跨项目切换会保留后台流式槽位的会话状态）。
  const sessionsMirrorRef = useRef<Record<string, ConversationSessionState>>(
    {},
  );
  sessionsMirrorRef.current = sessions;
  const conversationIdsKey = conversations
    .map((conv) => conv.conversationId)
    .join("\u0000");
  // workflow 节点会话 id 集合的稳定 key：节点创建/更新时触发子代理重查
  const workflowNodeIdsKey = useMemo(() => {
    const ids: string[] = [];
    for (const nodes of Object.values(workflowNodeMap)) {
      for (const node of nodes) {
        ids.push(node.conversationId);
      }
    }
    return ids.join("\u0000");
  }, [workflowNodeMap]);

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
          0,
        );

        if (!cancelled) {
          setConversations((prev) => {
            const fetchedIds = new Set(
              result.items.map((row) => row.conversationId),
            );
            // 运行中的新会话（首条 AI 响应未返回、会话行尚未落库）只存在
            // 于渲染进程内存。项目切换会整表重拉 DB 列表，直接替换会把这
            // 类会话的唯一前端表示（pending 占位记录）清掉，导致切换项目
            // 往返后运行中的新会话从列表消失（issue #118），直到会话落库
            // 后的下一次抓取才恢复。这里把属于当前项目、仍在运行的占位
            // 记录合并进抓取结果；真实记录落库后由迁移 upsert / 后续抓取
            // 自然接管，不会产生重复项。
            const pendingToReal = pendingToRealConversationIdRef.current;
            const livePlaceholders: ChatConversationRecord[] = [];
            const collected = new Set<string>();
            const collectPlaceholder = (
              record: ChatConversationRecord,
            ): void => {
              if (collected.has(record.conversationId)) {
                return;
              }
              if (fetchedIds.has(record.conversationId)) {
                return;
              }
              // 迁移映射指向的真实记录已随本次抓取返回时丢弃占位
              const realId = pendingToReal?.get(record.conversationId);
              if (realId && fetchedIds.has(realId)) {
                return;
              }
              collected.add(record.conversationId);
              livePlaceholders.push(record);
            };
            for (const item of prev) {
              if (
                isPendingSessionKey(item.conversationId) &&
                item.directoryId === directoryId &&
                runningIdsRef.current.has(item.conversationId)
              ) {
                collectPlaceholder(item);
              }
            }
            // 快速往返切换时 upsertedConversation 只保留最后一条占位，
            // 并行新会话的占位需从内存 session 重建（会话状态在跨项目
            // 切换时对后台流式运行的槽位予以保留）。
            for (const [key, session] of Object.entries(
              sessionsMirrorRef.current,
            )) {
              if (!isPendingSessionKey(key) || collected.has(key)) {
                continue;
              }
              if (!session.isStreaming || session.directoryId !== directoryId) {
                continue;
              }
              const firstUserMessage = session.messages.find(
                (message) => message.role === "user",
              );
              const content = firstUserMessage?.content ?? "";
              collectPlaceholder({
                conversationId: key,
                title: content,
                summary: "",
                lastMessagePreview:
                  content.length > 50 ? `${content.slice(0, 50)}...` : content,
                messageCount: session.messages.length,
                model:
                  session.messages.find(
                    (message) => message.role === "assistant",
                  )?.model ?? "",
                apiProfileName: "",
                status: "active",
                directoryId: session.directoryId ?? directoryId,
                forkedFromConversationId: "",
                forkMessageCount: 0,
                conversationType: "main",
                parentConversationId: "",
                subAgentId: "",
                subAgentName: "",
                subAgentStatus: "",
                subAgentError: "",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                totalDurationMs: 0,
                runInputTokens: 0,
                runOutputTokens: 0,
                runCacheCreationInputTokens: 0,
                runCacheReadInputTokens: 0,
                lastRunDurationMs: 0,
                emoji: "",
              });
            }
            if (livePlaceholders.length === 0) {
              return sortConversationsByUpdatedAt(
                result.items,
                runningIdsRef.current,
              );
            }
            return sortConversationsByUpdatedAt(
              [...livePlaceholders, ...result.items],
              runningIdsRef.current,
            );
          });
          setTotal(result.total);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : t("sidebar.loadChatsError", {
                  defaultValue: "Failed to load chats",
                }),
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
    // workflow 节点会话不进入主会话列表（由 workflow 主会话的树形面板展示），
    // 但节点状态变化仍需通过 conversationListVersion 触发树形数据重查
    if (conv.conversationType === "workflow_node") {
      return;
    }

    let isNew = false;
    setConversations((prev) => {
      const existingIndex = prev.findIndex(
        (item) => item.conversationId === conv.conversationId,
      );

      if (existingIndex >= 0) {
        // 记录内容未变化时保持原引用，避免无意义的替换与重排序
        // （AI 响应结束后的冗余 upsert 不会触发列表重渲染）
        const existing = prev[existingIndex];
        if (JSON.stringify(existing) === JSON.stringify(conv)) {
          return prev;
        }
        const updated = prev.map((item) =>
          item.conversationId === conv.conversationId ? conv : item,
        );
        return sortConversationsByUpdatedAt(updated, runningConversationIds);
      }

      // If the real conversation arrives, replace ITS OWN pending placeholder.
      // 多个 pending 槽位并存时绝不能顶替任意第一个占位：通过迁移映射
      // （pending 槽位 -> 真实 conversationId）精确找到本会话的占位项。
      const pendingKeyForConv = pendingToRealConversationIdRef.current
        ? Array.from(pendingToRealConversationIdRef.current.entries()).find(
            ([, realId]) => realId === conv.conversationId,
          )?.[0]
        : undefined;
      const pendingIndex = pendingKeyForConv
        ? prev.findIndex((item) => item.conversationId === pendingKeyForConv)
        : -1;
      if (pendingIndex >= 0) {
        const replaced = prev.map((item, index) =>
          index === pendingIndex ? conv : item,
        );
        return sortConversationsByUpdatedAt(replaced, runningConversationIds);
      }

      isNew = true;
      // New conversation: prepend and re-sort by updatedAt
      return sortConversationsByUpdatedAt(
        [conv, ...prev],
        runningConversationIds,
      );
    });

    if (isNew) {
      setTotal((prev) => prev + 1);
    }
  }, [
    upsertedConversation,
    directoryId,
    runningConversationIds,
    pendingToRealConversationIdRef,
  ]);

  // 流式或待处理交互状态变化时，重新排序使相关会话保持在顶部。
  // runningConversationIds 只在生命周期边界变化，不会随每个流式 token 更新。
  useEffect(() => {
    if (runningConversationIds.size === 0) {
      return;
    }
    setConversations((prev) =>
      sortConversationsByUpdatedAt(prev, runningConversationIds),
    );
  }, [runningConversationIds]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (isLoadingMore || !hasMore || !directoryId || isLoading) {
      return;
    }

    setIsLoadingMore(true);

    try {
      // 分页 offset 必须按"已加载的 DB 行数"计算：pending 占位记录不属于
      // DB 行，计入列表长度会让 offset 虚增而跳过真实记录。
      const dbOffset = conversationsRef.current.filter(
        (item) => !isPendingSessionKey(item.conversationId),
      ).length;
      const result = await window.snow.listChatConversationsPaginated(
        directoryId,
        CHAT_PAGE_SIZE,
        dbOffset,
      );

      setConversations((prev) => {
        // 运行中会话落库后，DB 顶部的排序位移会让相邻页出现重叠，
        // 追加前必须按 id 去重；某占位的真实记录已随本页返回时，
        // 同时丢弃占位，避免同一会话出现重复条目。
        const existingIds = new Set(prev.map((item) => item.conversationId));
        const fetchedIds = new Set(
          result.items.map((row) => row.conversationId),
        );
        const pendingToReal = pendingToRealConversationIdRef.current;
        const kept = prev.filter((item) => {
          if (!isPendingSessionKey(item.conversationId)) {
            return true;
          }
          const realId = pendingToReal?.get(item.conversationId);
          return !(realId && fetchedIds.has(realId));
        });
        const fresh = result.items.filter(
          (row) => !existingIds.has(row.conversationId),
        );
        if (fresh.length === 0 && kept.length === prev.length) {
          return prev;
        }
        return sortConversationsByUpdatedAt(
          [...kept, ...fresh],
          runningIdsRef.current,
        );
      });
      setTotal(result.total);
    } catch {
      // Silent fail for pagination
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversationsRef, directoryId, hasMore, isLoading, isLoadingMore]);

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
      },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, isLoading, loadMore, conversations.length]);

  // ===== 归档会话（冷数据库）=====

  const loadArchivedFirstPage = useCallback(async (): Promise<void> => {
    if (!directoryId) {
      setArchivedConversations([]);
      setArchivedTotal(0);
      return;
    }

    setIsArchivedLoading(true);
    setArchivedError(null);

    try {
      const result = await window.snow.listArchivedConversationsPaginated(
        directoryId,
        ARCHIVE_PAGE_SIZE,
        0,
      );
      setArchivedConversations(result.items);
      setArchivedTotal(result.total);
    } catch (err) {
      setArchivedError(
        err instanceof Error
          ? err.message
          : t("sidebar.loadChatsError", {
              defaultValue: "Failed to load chats",
            }),
      );
    } finally {
      setIsArchivedLoading(false);
    }
  }, [directoryId, t]);

  // 进入归档模式或切换项目时加载归档列表第一页
  useEffect(() => {
    if (!isArchiveMode) {
      return;
    }
    void loadArchivedFirstPage();
  }, [isArchiveMode, loadArchivedFirstPage]);

  const hasMoreArchived = archivedConversations.length < archivedTotal;

  const loadArchivedMore = useCallback(async (): Promise<void> => {
    if (
      isArchivedLoadingMore ||
      !hasMoreArchived ||
      !directoryId ||
      isArchivedLoading
    ) {
      return;
    }

    setIsArchivedLoadingMore(true);

    try {
      const result = await window.snow.listArchivedConversationsPaginated(
        directoryId,
        ARCHIVE_PAGE_SIZE,
        archivedConversations.length,
      );
      setArchivedConversations((prev) => [...prev, ...result.items]);
      setArchivedTotal(result.total);
    } catch {
      // Silent fail for pagination
    } finally {
      setIsArchivedLoadingMore(false);
    }
  }, [
    archivedConversations.length,
    directoryId,
    hasMoreArchived,
    isArchivedLoading,
    isArchivedLoadingMore,
  ]);

  // 归档列表无限滚动
  useEffect(() => {
    if (!isArchiveMode || !hasMoreArchived || isArchivedLoading) {
      return;
    }

    const sentinel = archivedLoadMoreRef.current;

    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadArchivedMore();
        }
      },
      {
        root: sectionListRef.current,
        rootMargin: "0px 0px 64px",
        threshold: 0.1,
      },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [isArchiveMode, hasMoreArchived, isArchivedLoading, loadArchivedMore]);

  const showLoading = isSwitchingDirectory || (isLoading && directoryId !== "");

  // 打开其他项目的通知会话：先激活其所属项目，再打开会话。
  // 激活成功后主进程广播 workspace-directory-list:changed，项目列表与
  // 对话列表会自动刷新到目标项目，随后 handleSelectConversation 加载
  // 会话历史；即使激活失败，会话记录已存在，直接打开也不受影响。
  const handleOpenCrossProjectNotification = async (
    group: CrossProjectNotificationGroup,
    notification: CrossProjectNotification,
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
      group.directoryId,
    );
  };

  const handlePin = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    try {
      await window.snow.updateConversationStatus(
        conversation.conversationId,
        "pin",
      );
      refreshConversations();
    } catch {
      // Silent fail
    }
  };

  /** 会话拖拽悬停：允许放置并高亮提示（归档视图不可放置） */
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (isArchiveMode || !isChatDrag(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setIsChatDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsChatDragOver(false);
  };

  /** 拖入普通会话列表：取消拖拽会话的置顶 */
  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    setIsChatDragOver(false);
    if (isArchiveMode || !isChatDrag(event)) {
      return;
    }
    event.preventDefault();
    const payload = readChatDragData(event);
    // 非会话拖拽或来源已是普通会话时无需变更
    if (!payload || payload.status === "active") {
      return;
    }
    void window.snow
      .updateConversationStatus(payload.conversationId, "active")
      .then(() => refreshConversations())
      .catch(() => {
        // Silent fail
      });
  };

  const handleRename = async (
    conversation: ChatConversationRecord,
    newTitle: string,
  ): Promise<void> => {
    await window.snow.renameConversation(conversation.conversationId, newTitle);
    // 同步更新内存中 session 的 summary，让 TopBar 标题即时刷新
    updateConversationSummary(conversation.conversationId, newTitle);
    refreshConversations();
  };

  const handleSetEmoji = async (
    conversation: ChatConversationRecord,
    emoji: string,
  ): Promise<void> => {
    // 乐观更新：直接修改本地 state，异步落库，不刷新列表
    setConversations((prev) =>
      prev.map((item) =>
        item.conversationId === conversation.conversationId
          ? { ...item, emoji }
          : item,
      ),
    );
    try {
      await window.snow.updateConversationEmoji(
        conversation.conversationId,
        emoji,
      );
    } catch {
      // 落库失败时回滚
      setConversations((prev) =>
        prev.map((item) =>
          item.conversationId === conversation.conversationId
            ? { ...item, emoji: conversation.emoji }
            : item,
        ),
      );
    }
  };

  /** 收集会话及其全部树形子层（子代理、workflow 节点、节点派生的子代理）的 id，
   *  用于删除/归档时中止流、清理草稿与判断活动会话。 */
  const collectConversationTreeIds = useCallback(
    (conversationId: string): string[] => {
      const ids = [conversationId];
      for (const sub of subAgentMap[conversationId] ?? []) {
        ids.push(sub.conversationId);
      }
      for (const node of workflowNodeMap[conversationId] ?? []) {
        ids.push(node.conversationId);
        for (const sub of subAgentMap[node.conversationId] ?? []) {
          ids.push(sub.conversationId);
        }
      }
      return ids;
    },
    [subAgentMap, workflowNodeMap],
  );

  const handleDelete = async (
    conversation: ChatConversationRecord,
    deleteImages: boolean,
  ): Promise<void> => {
    if (deletingIds.size > 0) {
      return;
    }
    setDeletingIds(new Set([conversation.conversationId]));
    try {
      // 用户选择不保留图片时，先级联删除图库图片（物理 + 索引），
      // 再执行会话删除；删除失败不阻断会话删除
      if (deleteImages) {
        await window.snow.deleteConversationImages([
          conversation.conversationId,
        ]);
      }

      // Rust 侧级联删除子代理与 workflow 节点会话：收集全部待删 ID，
      // 以便中止对应流，并在当前正打开被删会话或其子层时清空聊天区
      const deleteTargetIds = collectConversationTreeIds(
        conversation.conversationId,
      );
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
    } finally {
      setDeletingIds(new Set());
    }
  };

  /** 归档单个会话：中止相关流、清理草稿，若正在打开则新建会话 */
  const handleArchive = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    if (archivingIds.size > 0) {
      return;
    }
    setArchivingIds(new Set([conversation.conversationId]));
    try {
      const targetIds = collectConversationTreeIds(conversation.conversationId);
      for (const targetId of targetIds) {
        abortConversation(targetId);
      }

      await window.snow.archiveConversations([conversation.conversationId]);

      // 归档的会话不再需要保留输入草稿
      for (const targetId of targetIds) {
        clearInputDraft(targetId);
      }

      if (activeConversationId && targetIds.includes(activeConversationId)) {
        handleNewChat();
      }
      refreshConversations();
    } catch {
      // Silent fail
    } finally {
      setArchivingIds(new Set());
    }
  };

  const handleExport = async (
    conversation: ChatConversationRecord,
    format: ExportFormat,
  ): Promise<void> => {
    const fileName =
      conversation.summary ||
      conversation.title ||
      t("sidebar.untitledChat", { defaultValue: "Untitled" });
    await window.snow.exportConversation(
      conversation.conversationId,
      format,
      fileName,
    );
  };

  /** 从侧边栏直接创建分支（复制整个会话），无需先打开会话 */
  const handleFork = (conversation: ChatConversationRecord): void => {
    void handleForkConversation(conversation.conversationId, "");
  };

  const handleEnterMultiSelect = (): void => {
    setSelectedIds(new Set());
    setIsMultiSelectMode(true);
  };

  const handleExitMultiSelect = (): void => {
    if (isBatchDeleting || archivingIds.size > 0) {
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
    if (isArchivedMultiSelect) {
      handleExitArchivedMultiSelect();
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
      .filter((conv) => !isPendingSessionKey(conv.conversationId))
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
      .filter((conv) => !isPendingSessionKey(conv.conversationId))
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

    try {
      // 用户选择不保留图片时，先级联删除所选会话引用的图库图片
      // （物理 + 索引；会话随后被删除，无需重写消息）
      if (batchDeleteImages && (batchImagesCount ?? 0) > 0) {
        await window.snow.deleteConversationImages([...selectedIds]);
      }

      // 收集所有受影响会话 ID（含子代理、workflow 节点与节点子代理级联），
      // 用于中止流/清空聊天区
      const targetIds = new Set<string>();
      for (const convId of selectedIds) {
        for (const targetId of collectConversationTreeIds(convId)) {
          targetIds.add(targetId);
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
      // 删除完成后才关闭确认弹窗，期间显示 loading
      setIsBatchDeleting(false);
      setShowBatchConfirm(false);
    }
  };

  /** 批量归档所选会话（置顶会话由 Rust 侧跳过，不参与归档） */
  const handleBatchArchive = async (): Promise<void> => {
    if (archivingIds.size > 0 || selectedIds.size === 0) {
      return;
    }

    setArchivingIds(new Set(selectedIds));
    try {
      // 收集所有受影响会话 ID（含子代理、workflow 节点与节点子代理级联），
      // 用于中止流/清空聊天区
      const targetIds = new Set<string>();
      for (const convId of selectedIds) {
        for (const targetId of collectConversationTreeIds(convId)) {
          targetIds.add(targetId);
        }
      }

      for (const targetId of targetIds) {
        abortConversation(targetId);
      }

      await window.snow.archiveConversations([...selectedIds]);

      // 归档的会话不再需要保留输入草稿
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
      setArchivingIds(new Set());
    }
  };

  /** 切换会话区/归档区视图：切换后主动重拉目标视图的列表，
   *  避免还原/归档操作后出现列表数据滞后（还原的会话不可见） */
  const toggleArchiveMode = (): void => {
    if (isArchiveMode) {
      // 退出归档视图：回到普通会话列表并全量重拉
      setIsArchiveMode(false);
      handleExitArchivedMultiSelect();
      refreshConversations();
    } else {
      // 进入归档视图：退出普通多选模式，避免状态交叉
      handleExitMultiSelect();
      setIsArchiveMode(true);
      void loadArchivedFirstPage();
    }
  };

  /** 还原单个归档会话 */
  const handleRestore = async (
    conversation: ChatConversationRecord,
  ): Promise<void> => {
    if (restoringIds.size > 0) {
      return;
    }
    setRestoringIds(new Set([conversation.conversationId]));
    try {
      await window.snow.restoreArchivedConversations([
        conversation.conversationId,
      ]);
      await loadArchivedFirstPage();
      refreshConversations();
    } catch {
      // Silent fail
    } finally {
      setRestoringIds(new Set());
    }
  };

  /** 批量还原所选归档会话 */
  const handleBatchRestore = async (): Promise<void> => {
    if (restoringIds.size > 0 || archivedSelectedIds.size === 0) {
      return;
    }

    setRestoringIds(new Set(archivedSelectedIds));
    try {
      await window.snow.restoreArchivedConversations([...archivedSelectedIds]);
      await loadArchivedFirstPage();
      refreshConversations();
      setArchivedSelectedIds(new Set());
      setIsArchivedMultiSelect(false);
    } catch {
      // Silent fail
    } finally {
      setRestoringIds(new Set());
    }
  };
  const handleDeleteArchived = (conversation: ChatConversationRecord): void => {
    setArchivedDeleteTargetIds([conversation.conversationId]);
  };

  /** 批量永久删除所选归档会话（弹出确认框） */
  const handleBatchDeleteArchived = (): void => {
    if (archivedSelectedIds.size === 0) {
      return;
    }
    setArchivedDeleteTargetIds([...archivedSelectedIds]);
  };

  /** 确认永久删除归档会话 */
  const handleArchivedDeleteConfirm = async (): Promise<void> => {
    if (deletingArchivedIds.size > 0 || !archivedDeleteTargetIds) {
      return;
    }

    setDeletingArchivedIds(new Set(archivedDeleteTargetIds));
    const targetIds = archivedDeleteTargetIds;

    try {
      await window.snow.deleteArchivedConversations(targetIds);
      await loadArchivedFirstPage();
      setArchivedSelectedIds(new Set());
      setIsArchivedMultiSelect(false);
    } catch {
      // Silent fail
    } finally {
      // 删除完成（含 VACUUM 收缩文件）后才关闭确认弹窗，期间显示 loading
      setDeletingArchivedIds(new Set());
      setArchivedDeleteTargetIds(null);
    }
  };

  const handleExitArchivedMultiSelect = (): void => {
    if (deletingArchivedIds.size > 0 || restoringIds.size > 0) {
      return;
    }
    setIsArchivedMultiSelect(false);
    setArchivedSelectedIds(new Set());
  };

  const handleArchivedToggleSelect = (conversationId: string): void => {
    setArchivedSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  const handleArchivedSelectAll = (): void => {
    setArchivedSelectedIds(
      new Set(archivedConversations.map((conv) => conv.conversationId)),
    );
  };

  const handleArchivedDeselectAll = (): void => {
    setArchivedSelectedIds(new Set());
  };

  const timeGroups = groupConversationsByTime(
    conversations,
    new Date(),
    surfacedConversationIds,
  );

  // 加载所有主会话的 workflow 节点会话（树形子层）。
  // 依赖 conversationListVersion：workflow 节点创建/状态更新时会话记录
  // upsert 使版本递增，从而刷新节点树；conversationIdsKey 负责列表切换。
  useEffect(() => {
    const current = conversationsRef.current;
    if (current.length === 0) {
      setWorkflowNodeMap({});
      return;
    }

    let cancelled = false;

    const loadWorkflowNodes = async (): Promise<void> => {
      try {
        const map = await window.snow.listWorkflowNodeSessionsByParents(
          current.map((conv) => conv.conversationId),
        );
        if (!cancelled) {
          setWorkflowNodeMap(map);
        }
      } catch {
        if (!cancelled) {
          setWorkflowNodeMap({});
        }
      }
    };

    void loadWorkflowNodes();

    return () => {
      cancelled = true;
    };
  }, [
    conversationIdsKey,
    conversationListVersion,
    // 节点会话创建/更新时主动 upsert（workflowRunner），据此重查节点树
    upsertedConversation?.timestamp,
  ]);

  // 加载子代理：父级范围覆盖主会话与 workflow 节点会话（层级：
  // Workflow 主会话 → 节点会话 → 子代理），单次批量查询避免 N+1。
  useEffect(() => {
    const current = conversationsRef.current;
    const nodeIds = workflowNodeIdsKey
      ? workflowNodeIdsKey.split("\u0000")
      : [];
    const parentIds = [
      ...current.map((conv) => conv.conversationId),
      ...nodeIds,
    ];
    if (parentIds.length === 0) {
      setSubAgentMap({});
      return;
    }

    let cancelled = false;

    const loadSubAgents = async (): Promise<void> => {
      try {
        const map =
          await window.snow.listSubAgentConversationsByParents(parentIds);
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
  }, [conversationIdsKey, workflowNodeIdsKey, conversationListVersion]);

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
          (item) => item.conversationId === conversationId,
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
          runInputTokens: 0,
          runOutputTokens: 0,
          runCacheCreationInputTokens: 0,
          runCacheReadInputTokens: 0,
          lastRunDurationMs: 0,
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

  // 当激活的会话是某个父会话的子代理时，自动展开该父会话的面板；
  // 激活的会话是 workflow 节点或其子代理时，自动展开对应 workflow 主会话
  // 与节点面板，保证层级可见。
  useEffect(() => {
    if (!activeConversationId) {
      return;
    }
    setExpandedSubAgentConversationIds((prev) => {
      const parentIds = Object.keys(subAgentMap).filter((parentId) =>
        subAgentMap[parentId].some(
          (sub) => sub.conversationId === activeConversationId,
        ),
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
    setExpandedWorkflowConversationIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const [parentId, nodes] of Object.entries(workflowNodeMap)) {
        const isNodeActive = nodes.some(
          (node) => node.conversationId === activeConversationId,
        );
        const isNodeSubAgentActive = nodes.some((node) =>
          (subAgentMap[node.conversationId] ?? []).some(
            (sub) => sub.conversationId === activeConversationId,
          ),
        );
        if (isNodeActive) {
          if (!next.has(parentId)) {
            next.add(parentId);
            changed = true;
          }
          // 激活节点自身时也展开该节点的子代理面板
          setExpandedWorkflowNodeConversationIds((nodePrev) => {
            const nodeNext = new Set(nodePrev);
            if (isNodeActive && !nodeNext.has(activeConversationId as string)) {
              nodeNext.add(activeConversationId as string);
              return nodeNext;
            }
            return nodePrev;
          });
        } else if (isNodeSubAgentActive) {
          if (!next.has(parentId)) {
            next.add(parentId);
            changed = true;
          }
          for (const node of nodes) {
            if (
              (subAgentMap[node.conversationId] ?? []).some(
                (sub) => sub.conversationId === activeConversationId,
              )
            ) {
              setExpandedWorkflowNodeConversationIds((nodePrev) => {
                const nodeNext = new Set(nodePrev);
                if (!nodeNext.has(node.conversationId)) {
                  nodeNext.add(node.conversationId);
                  return nodeNext;
                }
                return nodePrev;
              });
            }
          }
        }
      }
      return changed ? next : prev;
    });
  }, [subAgentMap, workflowNodeMap, activeConversationId]);

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

  /** 展开/收起 Workflow 主会话的节点树 */
  const handleToggleWorkflowPanel = (conversationId: string): void => {
    setExpandedWorkflowConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  /** 展开/收起 Workflow 节点会话的子代理列表 */
  const handleToggleWorkflowNode = (conversationId: string): void => {
    setExpandedWorkflowNodeConversationIds((prev) => {
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
          JSON.stringify(next),
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
            disabled={isBatchDeleting || archivingIds.size > 0}
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
            <Tooltip
              content={
                selectedIds.size ===
                conversations.filter(
                  (conv) => !isPendingSessionKey(conv.conversationId),
                ).length
                  ? t("sidebar.chatMultiSelectDeselectAll", {
                      defaultValue: "Deselect all",
                    })
                  : t("sidebar.chatMultiSelectAll", {
                      defaultValue: "Select all",
                    })
              }
              placement="bottom"
            >
              <button
                type="button"
                className="chat-multi-select-action-btn"
                onClick={() =>
                  selectedIds.size ===
                  conversations.filter(
                    (conv) => !isPendingSessionKey(conv.conversationId),
                  ).length
                    ? handleDeselectAll()
                    : handleSelectAll()
                }
                disabled={isBatchDeleting || archivingIds.size > 0}
              >
                <CheckSquare size={13} />
                <span>
                  {selectedIds.size ===
                  conversations.filter(
                    (conv) => !isPendingSessionKey(conv.conversationId),
                  ).length
                    ? t("sidebar.chatMultiSelectDeselectAll", {
                        defaultValue: "Deselect all",
                      })
                    : t("sidebar.chatMultiSelectAll", {
                        defaultValue: "Select all",
                      })}
                </span>
              </button>
            </Tooltip>
            <Tooltip
              content={
                archivingIds.size > 0
                  ? t("sidebar.chatMultiSelectArchiving", {
                      defaultValue: "Archiving...",
                    })
                  : t("sidebar.chatMultiSelectArchive", {
                      defaultValue: "Archive selected",
                    })
              }
              placement="bottom"
            >
              <button
                type="button"
                className="chat-multi-select-action-btn"
                onClick={() => void handleBatchArchive()}
                disabled={archivingIds.size > 0 || selectedIds.size === 0}
              >
                {archivingIds.size > 0 ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <Archive size={13} />
                )}
                <span>
                  {archivingIds.size > 0
                    ? t("sidebar.chatMultiSelectArchiving", {
                        defaultValue: "Archiving...",
                      })
                    : t("sidebar.chatMultiSelectArchive", {
                        defaultValue: "Archive selected",
                      })}
                </span>
              </button>
            </Tooltip>
            <Tooltip
              content={
                isBatchDeleting
                  ? t("sidebar.chatMultiSelectDeleting", {
                      defaultValue: "Deleting...",
                    })
                  : t("sidebar.chatMultiSelectDelete", {
                      defaultValue: "Delete selected",
                    })
              }
              placement="bottom"
            >
              <button
                type="button"
                className="chat-multi-select-action-btn danger"
                onClick={handleOpenBatchConfirm}
                disabled={
                  isBatchDeleting ||
                  archivingIds.size > 0 ||
                  selectedIds.size === 0
                }
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
            </Tooltip>
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
              {isArchiveMode
                ? t("sidebar.archivedChats", { defaultValue: "Archived" })
                : t("sidebar.chats", { defaultValue: "Chats" })}
            </span>
            {isArchiveMode && archivedTotal > 0 ? (
              <span className="chats-archive-count">{archivedTotal}</span>
            ) : null}
          </button>
          <div className="section-actions">
            <button
              type="button"
              aria-pressed={isArchiveMode}
              aria-label={
                isArchiveMode
                  ? t("sidebar.archivedChatsToggleBack", {
                      defaultValue: "Back to chats",
                    })
                  : t("sidebar.archivedChatsToggle", {
                      defaultValue: "View archived chats",
                    })
              }
              className={`icon-btn ghost chats-archive-toggle${
                isArchiveMode ? " active" : ""
              }`}
              onClick={toggleArchiveMode}
              title={
                isArchiveMode
                  ? t("sidebar.archivedChatsToggleBack", {
                      defaultValue: "Back to chats",
                    })
                  : t("sidebar.archivedChatsToggle", {
                      defaultValue: "View archived chats",
                    })
              }
            >
              {isArchiveMode ? (
                <ArchiveRestore size={14} />
              ) : (
                <Archive size={14} />
              )}
            </button>
          </div>
        </div>
      )}
      {!isCollapsed && (
        <div
          className={`section-list${isChatDragOver ? " chat-drag-over" : ""}`}
          ref={sectionListRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isArchiveMode ? (
            <>
              {/* 归档模式：归档会话不允许直接打开使用，必须还原后才能继续对话 */}
              {isArchivedMultiSelect ? (
                <div className="chat-multi-select-bar">
                  <button
                    type="button"
                    className="chat-multi-select-exit-btn"
                    onClick={handleExitArchivedMultiSelect}
                    disabled={
                      deletingArchivedIds.size > 0 || restoringIds.size > 0
                    }
                    title={t("sidebar.chatMultiSelectExit", {
                      defaultValue: "Exit",
                    })}
                  >
                    <X size={14} />
                  </button>
                  <span className="chat-multi-select-count">
                    {t("sidebar.chatMultiSelectCount", {
                      defaultValue: "{{count}} selected",
                      values: { count: archivedSelectedIds.size },
                    })}
                  </span>
                  <div className="chat-multi-select-actions">
                    <Tooltip
                      content={
                        archivedSelectedIds.size ===
                        archivedConversations.length
                          ? t("sidebar.chatMultiSelectDeselectAll", {
                              defaultValue: "Deselect all",
                            })
                          : t("sidebar.chatMultiSelectAll", {
                              defaultValue: "Select all",
                            })
                      }
                      placement="bottom"
                    >
                      <button
                        type="button"
                        className="chat-multi-select-action-btn"
                        onClick={
                          archivedSelectedIds.size ===
                          archivedConversations.length
                            ? handleArchivedDeselectAll
                            : handleArchivedSelectAll
                        }
                        disabled={
                          deletingArchivedIds.size > 0 || restoringIds.size > 0
                        }
                      >
                        <CheckSquare size={13} />
                        <span>
                          {archivedSelectedIds.size ===
                          archivedConversations.length
                            ? t("sidebar.chatMultiSelectDeselectAll", {
                                defaultValue: "Deselect all",
                              })
                            : t("sidebar.chatMultiSelectAll", {
                                defaultValue: "Select all",
                              })}
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip
                      content={
                        restoringIds.size > 0
                          ? t("sidebar.chatMultiSelectRestoring", {
                              defaultValue: "Restoring...",
                            })
                          : t("sidebar.archivedChatMultiSelectRestore", {
                              defaultValue: "Restore selected",
                            })
                      }
                      placement="bottom"
                    >
                      <button
                        type="button"
                        className="chat-multi-select-action-btn"
                        onClick={() => void handleBatchRestore()}
                        disabled={
                          restoringIds.size > 0 ||
                          archivedSelectedIds.size === 0
                        }
                      >
                        {restoringIds.size > 0 ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <ArchiveRestore size={13} />
                        )}
                        <span>
                          {restoringIds.size > 0
                            ? t("sidebar.chatMultiSelectRestoring", {
                                defaultValue: "Restoring...",
                              })
                            : t("sidebar.archivedChatMultiSelectRestore", {
                                defaultValue: "Restore selected",
                              })}
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip
                      content={t("sidebar.archivedChatMultiSelectDelete", {
                        defaultValue: "Delete selected",
                      })}
                      placement="bottom"
                    >
                      <button
                        type="button"
                        className="chat-multi-select-action-btn danger"
                        onClick={handleBatchDeleteArchived}
                        disabled={
                          deletingArchivedIds.size > 0 ||
                          restoringIds.size > 0 ||
                          archivedSelectedIds.size === 0
                        }
                      >
                        {deletingArchivedIds.size > 0 ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                        <span>
                          {t("sidebar.archivedChatMultiSelectDelete", {
                            defaultValue: "Delete selected",
                          })}
                        </span>
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ) : null}
              {isSwitchingDirectory || isArchivedLoading ? (
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
              ) : archivedError ? (
                <span className="empty-text error">{archivedError}</span>
              ) : archivedConversations.length === 0 ? (
                <span className="empty-text">
                  {t("sidebar.archivedChatsEmpty", {
                    defaultValue: "No archived chats",
                  })}
                </span>
              ) : (
                <>
                  {!isArchivedMultiSelect && (
                    <div className="archived-chat-toolbar">
                      <span className="archived-chat-toolbar-hint">
                        {t("sidebar.archivedChatsHint", {
                          defaultValue:
                            "Restore archived chats to continue using them",
                        })}
                      </span>
                      <button
                        type="button"
                        className="archived-multi-select-btn"
                        onClick={() => {
                          setArchivedSelectedIds(new Set());
                          setIsArchivedMultiSelect(true);
                        }}
                      >
                        <ListChecks size={13} />
                        <span>
                          {t("sidebar.chatActionMultiSelect", {
                            defaultValue: "Multi-select",
                          })}
                        </span>
                      </button>
                    </div>
                  )}
                  {archivedConversations.map((conversation) => (
                    <ArchivedChatItem
                      key={conversation.conversationId}
                      conversation={conversation}
                      isMultiSelectMode={isArchivedMultiSelect}
                      isSelected={archivedSelectedIds.has(
                        conversation.conversationId,
                      )}
                      isRestoring={restoringIds.has(
                        conversation.conversationId,
                      )}
                      isDeleting={deletingArchivedIds.has(
                        conversation.conversationId,
                      )}
                      onToggleSelect={() =>
                        handleArchivedToggleSelect(conversation.conversationId)
                      }
                      onRestore={() => void handleRestore(conversation)}
                      onDelete={() => handleDeleteArchived(conversation)}
                    />
                  ))}
                  {hasMoreArchived ? (
                    <div
                      className={`chat-load-more ${
                        isArchivedLoadingMore ? "is-loading" : ""
                      }`}
                      ref={archivedLoadMoreRef}
                      role={isArchivedLoadingMore ? "status" : undefined}
                      aria-live="polite"
                      aria-label={
                        isArchivedLoadingMore
                          ? t("sidebar.chatLoadingMore", {
                              defaultValue: "Loading more chats...",
                            })
                          : undefined
                      }
                    >
                      {isArchivedLoadingMore ? (
                        <>
                          <Loader2
                            className="spin"
                            size={14}
                            aria-hidden="true"
                          />
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
            </>
          ) : showLoading ? (
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
                            conversation.updatedAt,
                          );
                          const timeLabel = formatTimeLabel(
                            parsedDate,
                            new Date(),
                            t,
                          );
                          return (
                            <button
                              type="button"
                              className="cross-project-notification-item"
                              key={conversation.conversationId}
                              onClick={() =>
                                void handleOpenCrossProjectNotification(
                                  group,
                                  notification,
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
                                },
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
                  .filter((conv) => !isPendingSessionKey(conv.conversationId))
                  .map((conv) => conv.conversationId);
                const groupSelectedCount = groupSelectableIds.filter((id) =>
                  selectedIds.has(id),
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
                          }${isGroupPartialSelected ? " indeterminate" : ""}`}
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
                              ? t("sidebar.chatMultiSelectGroupDeselect", {
                                  defaultValue: "Deselect this group",
                                })
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
                            conversation.conversationId,
                          );
                        const workflowNodeConversations =
                          workflowNodeMap[conversation.conversationId] ?? [];
                        const isWorkflow = workflowNodeConversations.length > 0;
                        const isWorkflowPanelExpanded =
                          expandedWorkflowConversationIds.has(
                            conversation.conversationId,
                          );
                        return (
                          <Fragment key={conversation.conversationId}>
                            <ChatItem
                              conversation={conversation}
                              isDraggable={
                                !isPendingSessionKey(
                                  conversation.conversationId,
                                )
                              }
                              isActive={
                                conversation.conversationId ===
                                activeConversationId
                              }
                              isAttentionRequired={attentionRequiredConversationIds.has(
                                conversation.conversationId,
                              )}
                              isStreaming={streamingConversationIds.has(
                                conversation.conversationId,
                              )}
                              isPaused={pausedConversationIds.has(
                                conversation.conversationId,
                              )}
                              isCompleted={completedConversationIds.has(
                                conversation.conversationId,
                              )}
                              subAgentConversations={subAgentConversations}
                              subAgentAttentionRequiredIds={
                                attentionRequiredConversationIds
                              }
                              isSubAgentExpanded={isSubAgentPanelExpanded}
                              isWorkflow={isWorkflow}
                              isWorkflowExpanded={isWorkflowPanelExpanded}
                              onToggleWorkflowPanel={() =>
                                handleToggleWorkflowPanel(
                                  conversation.conversationId,
                                )
                              }
                              isMultiSelectMode={isMultiSelectMode}
                              isSelected={selectedIds.has(
                                conversation.conversationId,
                              )}
                              onToggleSelect={() =>
                                handleToggleSelect(conversation.conversationId)
                              }
                              onEnterMultiSelect={handleEnterMultiSelect}
                              onToggleSubAgentPanel={() =>
                                handleToggleSubAgentPanel(
                                  conversation.conversationId,
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
                              onFork={() => handleFork(conversation)}
                              isArchiving={archivingIds.has(
                                conversation.conversationId,
                              )}
                              isDeleting={deletingIds.has(
                                conversation.conversationId,
                              )}
                              onArchive={
                                conversation.status === "pin"
                                  ? undefined
                                  : () => void handleArchive(conversation)
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
                                  conversation.directoryId,
                                )
                              }
                            />
                            {/* 面板渲染在 ChatItem 外部，作为兄弟节点，
                          完全不继承父级会话项的背景色 */}
                            {isWorkflow &&
                              isWorkflowPanelExpanded &&
                              !isMultiSelectMode && (
                                <WorkflowNodeListPanel
                                  conversations={workflowNodeConversations}
                                  activeConversationId={activeConversationId}
                                  attentionRequiredConversationIds={
                                    attentionRequiredConversationIds
                                  }
                                  streamingConversationIds={
                                    streamingConversationIds
                                  }
                                  subAgentMap={subAgentMap}
                                  expandedNodeIds={
                                    expandedWorkflowNodeConversationIds
                                  }
                                  onToggleNode={handleToggleWorkflowNode}
                                  onSelect={(nodeConvId) =>
                                    void handleSelectConversation(
                                      nodeConvId,
                                      undefined,
                                      undefined,
                                      conversation.directoryId,
                                    )
                                  }
                                />
                              )}
                            {subAgentConversations.length > 0 &&
                              isSubAgentPanelExpanded &&
                              !isMultiSelectMode && (
                                <SubAgentListPanel
                                  conversations={subAgentConversations}
                                  activeConversationId={activeConversationId}
                                  attentionRequiredConversationIds={
                                    attentionRequiredConversationIds
                                  }
                                  onSelect={(subConvId) =>
                                    void handleSelectConversation(
                                      subConvId,
                                      undefined,
                                      undefined,
                                      conversation.directoryId,
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
        isConfirming={isBatchDeleting}
        onCancel={() => setShowBatchConfirm(false)}
        onConfirm={() => void handleBatchDelete()}
        onDeleteImagesChange={setBatchDeleteImages}
        open={showBatchConfirm}
      />
      {/* 归档会话永久删除确认（归档数据不可恢复） */}
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.chatActionDelete", {
          defaultValue: "Delete",
        })}
        isConfirming={deletingArchivedIds.size > 0}
        message={
          (archivedDeleteTargetIds?.length ?? 0) > 1
            ? t("sidebar.archivedChatMultiSelectDeleteConfirm", {
                defaultValue:
                  "Permanently delete {{count}} selected archived conversations?",
                values: { count: archivedDeleteTargetIds?.length ?? 0 },
              })
            : t("sidebar.archivedChatDeleteConfirm", {
                defaultValue: "Permanently delete this archived conversation?",
              })
        }
        onCancel={() => setArchivedDeleteTargetIds(null)}
        onConfirm={() => void handleArchivedDeleteConfirm()}
        open={archivedDeleteTargetIds !== null}
        title={t("sidebar.chatDeleteConfirmTitle", {
          defaultValue: "Confirm deletion",
        })}
        variant="danger"
      />
    </div>
  );
}
