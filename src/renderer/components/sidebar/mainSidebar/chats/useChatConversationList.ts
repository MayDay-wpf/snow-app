import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import {
  isPendingSessionKey,
  type ConversationSessionState,
} from "../../../mainContent/chatMessages/utils/conversationTypes";
import { buildPendingConversationRecord } from "../pendingConversationRecord";
import { sortConversationsByUpdatedAt } from "./conversationSort";

const CHAT_PAGE_SIZE = 20;

type PendingToRealRef = { current: Map<string, string> };

type UpsertedConversationLike = {
  record: ChatConversationRecord;
  timestamp: number;
};

type UseChatConversationListOptions = {
  directoryId: string;
  conversationListVersion: number;
  upsertedConversation: UpsertedConversationLike | null;
  pendingToRealConversationIdRef: PendingToRealRef;
  runningConversationIds: Set<string>;
  sessions: Record<string, ConversationSessionState>;
  isCollapsed: boolean;
  infiniteScroll?: boolean;
  sectionListRef: RefObject<HTMLDivElement | null>;
};

export function useChatConversationList({
  directoryId,
  conversationListVersion,
  upsertedConversation,
  pendingToRealConversationIdRef,
  runningConversationIds,
  sessions,
  isCollapsed,
  infiniteScroll = true,
  sectionListRef,
}: UseChatConversationListOptions) {
  const { t } = useI18n();
  const [storedConversations, setConversations] = useState<
    ChatConversationRecord[]
  >([]);
  const conversations = useMemo(() => {
    const pendingToReal = pendingToRealConversationIdRef.current;
    const persistedIds = new Set(
      storedConversations
        .filter((item) => !isPendingSessionKey(item.conversationId))
        .map((item) => item.conversationId),
    );
    let changed = false;
    const resolved: ChatConversationRecord[] = [];
    for (const conversation of storedConversations) {
      const realId = pendingToReal.get(conversation.conversationId);
      if (!realId) {
        resolved.push(conversation);
        continue;
      }
      changed = true;
      if (!persistedIds.has(realId)) {
        persistedIds.add(realId);
        resolved.push({ ...conversation, conversationId: realId });
      }
    }
    return changed ? resolved : storedConversations;
  }, [
    storedConversations,
    runningConversationIds,
    pendingToRealConversationIdRef,
  ]);
  const getConversationKey = useCallback(
    (conversation: ChatConversationRecord): string => {
      for (const [
        pendingKey,
        realId,
      ] of pendingToRealConversationIdRef.current) {
        if (realId === conversation.conversationId) {
          return pendingKey;
        }
      }
      return conversation.conversationId;
    },
    [pendingToRealConversationIdRef],
  );
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 分页哨兵节点：用回调 ref 存进 state，让观察者 effect 依赖「节点身份」。
  // 列表会因切换项目/显示形态而整块重挂载（哨兵 DOM 被替换），若只读
  // ref.current，重挂载后 effect 依赖不变、不会重新 observe，无限滚动失效。
  const [loadMoreSentinel, setLoadMoreSentinel] =
    useState<HTMLDivElement | null>(null);
  const loadMoreRef = useCallback((node: HTMLDivElement | null): void => {
    setLoadMoreSentinel(node);
  }, []);

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
              collectPlaceholder(
                buildPendingConversationRecord(key, session, directoryId),
              );
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
  }, [directoryId, t, conversationListVersion, pendingToRealConversationIdRef]);

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
      // 分页 offset 必须按“已加载的 DB 行数”计算：pending 占位记录不属于
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
  }, [
    conversationsRef,
    directoryId,
    hasMore,
    isLoading,
    isLoadingMore,
    pendingToRealConversationIdRef,
  ]);

  useEffect(() => {
    if (!infiniteScroll || !hasMore || isLoading || isCollapsed) {
      return;
    }

    const sentinel = loadMoreSentinel;

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
  }, [
    hasMore,
    isLoading,
    isCollapsed,
    infiniteScroll,
    loadMore,
    loadMoreSentinel,
    sectionListRef,
  ]);

  return {
    conversations,
    setConversations,
    total,
    setTotal,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    conversationIdsKey,
    conversationsRef,
    getConversationKey,
    loadMore,
    loadMoreRef,
  };
}
