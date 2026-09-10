import { useEffect, useMemo, useRef, useState } from "react";

import { useChatConversationContext } from "../../mainContent/chatMessages";
import { isPendingSessionKey } from "../../mainContent/chatMessages/utils/conversationTypes";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { parseDbTimestamp } from "./chatTimeGroup";
import { buildPendingConversationRecord } from "./pendingConversationRecord";

/**
 * 跨项目通知聚合。
 *
 * 侧边栏的「对话」区域默认只显示当前项目（directoryId）的会话，但
 * 流式/需关注/已完成的会话状态（streamingConversationIds 等）是
 * 渲染进程全局持有的——切走项目后，旧项目后台会话的状态仍保留在
 * 这些集合中，只是 UI 没有入口展示。此 hook 把这些状态对应的会话
 * 记录（跨项目按 id 查询）按所属项目分组，供侧边栏展示「跨项目
 * 通知」：其他项目有动态时，在当前项目视图也能看到，并且提示对应
 * 到具体项目上。
 */

export type CrossProjectNotification = {
  conversation: ChatConversationRecord;
  isStreaming: boolean;
  isAttentionRequired: boolean;
  isCompleted: boolean;
};

export type CrossProjectNotificationGroup = {
  directoryId: string;
  directoryName: string;
  notifications: CrossProjectNotification[];
};

export type CrossProjectNotificationState = {
  groups: CrossProjectNotificationGroup[];
  activeSessionDirectoryIds: Set<string>;
};

/** 项目名称回退：local:/path → 末级目录名；SSH 等特殊格式直接原样返回。 */
const fallbackDirectoryName = (directoryId: string): string => {
  const trimmed = directoryId.trim();
  const separatorIndex = trimmed.indexOf(":");
  const rawPath =
    separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
  const segments = rawPath.split(/[\\/]/).filter(Boolean);
  return segments.pop() || trimmed;
};

export const useCrossProjectNotifications = (
  activeDirectoryId: string,
): CrossProjectNotificationState => {
  const {
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
    // 内存会话状态：pending 槽位（首条 AI 响应未返回、会话行尚未落库）的
    // 通知记录只能从内存 session 重建，无法按 id 查库。
    sessions,
    // 会话记录更新广播（LLM 摘要生成、fork 等）：项目内列表依赖它刷新，
    // 跨项目通知的缓存同样需要跟进，否则摘要生成后这里仍显示旧记录
    // （运行中会话的 summary 初始是第一条用户消息，生成摘要后才变成标题）。
    upsertedConversation,
    // 列表版本（重命名/置顶/删除等递增）：同步触发按 id 重查，
    // 保证跨项目通知与项目内列表显示的标题始终一致。
    conversationListVersion,
  } = useChatConversationContext();

  // 内存 session 的实时镜像：按 id 查询是异步的，重建 pending 占位记录时
  // 读取最新值，避免把频繁变化的 sessions 纳入 effect 依赖。
  const sessionsMirrorRef = useRef(sessions);
  sessionsMirrorRef.current = sessions;

  // 通知会话记录缓存：conversationId → 会话记录（含所属项目 directoryId）。
  const [conversationsById, setConversationsById] = useState<
    Map<string, ChatConversationRecord>
  >(new Map());
  // 工作区目录缓存：directoryId → 记录（用于项目名映射）。
  const [directoriesById, setDirectoriesById] = useState<
    Map<string, WorkspaceDirectoryRecord>
  >(new Map());

  // 项目列表用于名称映射：启动加载一次 + 目录列表变更时刷新。
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const directories = await window.snow.listWorkspaceDirectories();
        if (!cancelled) {
          setDirectoriesById(
            new Map(
              directories.map((directory) => [
                directory.directoryId,
                directory,
              ]),
            ),
          );
        }
      } catch {
        // 名称映射失败时使用回退名，不影响通知展示
      }
    };
    void load();
    const unsubscribe = window.snow.onWorkspaceDirectoryListChanged(() => {
      void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // 通知 id 集合：流式 + 需关注 + 已完成。以排序后的键串作为 effect 依赖，
  // 集合内容不变时不触发重新查询。
  const notificationIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const id of streamingConversationIds) {
      ids.add(id);
    }
    for (const id of attentionRequiredConversationIds) {
      ids.add(id);
    }
    for (const id of completedConversationIds) {
      ids.add(id);
    }
    return [...ids].sort().join("\u0000");
  }, [
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
  ]);

  // pending 槽位的内存数据签名：session 状态随每个流式 token 变化，但占位
  // 记录只依赖所属项目 / 首条用户消息 / 消息数；签名不变时不重建记录，
  // 避免逐 token 刷新「其他项目」通知区块。
  const pendingSignature = useMemo(() => {
    if (!notificationIdsKey) {
      return "";
    }
    const parts: string[] = [];
    for (const id of notificationIdsKey.split("\u0000")) {
      if (!isPendingSessionKey(id)) {
        continue;
      }
      const session = sessions[id];
      if (!session?.directoryId) {
        continue;
      }
      const firstUserMessage = session.messages.find(
        (message) => message.role === "user",
      );
      parts.push(
        `${id}\u0001${session.directoryId}\u0001${session.messages.length}\u0001${
          firstUserMessage?.content ?? session.summary
        }`,
      );
    }
    return parts.join("\u0002");
  }, [notificationIdsKey, sessions]);

  // 跨项目按 id 查询会话记录；状态集合清空时同步清空缓存。
  // conversationListVersion 变化（重命名/置顶/删除等）时也重查，
  // 让跨项目通知的标题与项目内列表保持一致。
  // pending 槽位（首条 AI 响应未返回、会话行尚未落库）无法按 id 查库：
  // 从内存 session 重建占位记录一并缓存，否则切走项目后运行中的新会话
  // 在「其他项目」通知区块中完全不可见。
  useEffect(() => {
    let cancelled = false;
    if (!notificationIdsKey) {
      setConversationsById(new Map());
      return;
    }

    const ids = notificationIdsKey.split("\u0000");
    const activeIds = new Set(ids);
    const pendingRecords: ChatConversationRecord[] = [];
    const persistedIds: string[] = [];
    for (const id of ids) {
      if (!isPendingSessionKey(id)) {
        persistedIds.push(id);
        continue;
      }
      const session = sessionsMirrorRef.current[id];
      if (!session?.directoryId) {
        continue;
      }
      pendingRecords.push(buildPendingConversationRecord(id, session, ""));
    }

    const load = async (): Promise<void> => {
      let records: ChatConversationRecord[] = [];
      if (persistedIds.length > 0) {
        try {
          records = await window.snow.listChatConversationsByIds(persistedIds);
        } catch {
          records = [];
        }
      }
      if (cancelled) {
        return;
      }
      setConversationsById((prev) => {
        // 内容未变化时保持原引用，避免无意义的缓存替换与列表重渲染
        let changed = prev.size !== activeIds.size;
        const next = new Map(prev);
        for (const key of next.keys()) {
          if (!activeIds.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        for (const record of [...records, ...pendingRecords]) {
          const existing = next.get(record.conversationId);
          if (
            !existing ||
            existing.title !== record.title ||
            existing.summary !== record.summary ||
            existing.updatedAt !== record.updatedAt
          ) {
            next.set(record.conversationId, record);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [notificationIdsKey, conversationListVersion, pendingSignature]);

  // 会话记录更新广播（如 LLM 摘要生成后 upsert 新记录）时，同步更新
  // 缓存中对应记录：运行中会话的 summary 初始为第一条用户消息，
  // 摘要生成后项目内列表已显示标题，这里必须跟进以免表现不统一。
  useEffect(() => {
    if (!upsertedConversation) {
      return;
    }
    const { record } = upsertedConversation;
    setConversationsById((prev) => {
      const existing = prev.get(record.conversationId);
      if (!existing) {
        return prev;
      }
      if (
        existing.title === record.title &&
        existing.summary === record.summary &&
        existing.updatedAt === record.updatedAt
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(record.conversationId, record);
      return next;
    });
  }, [upsertedConversation]);

  return useMemo(() => {
    const groups = new Map<string, CrossProjectNotificationGroup>();
    const activeSessionDirectoryIds = new Set<string>();

    const visit = (
      conversationId: string,
      flag: keyof Pick<
        CrossProjectNotification,
        "isStreaming" | "isAttentionRequired" | "isCompleted"
      >,
    ): void => {
      const conversation = conversationsById.get(conversationId);
      const directoryId =
        conversation?.directoryId ||
        sessionsMirrorRef.current[conversationId]?.directoryId ||
        "";
      if (!directoryId) {
        return;
      }
      if (flag !== "isCompleted") {
        activeSessionDirectoryIds.add(directoryId);
      }
      // 当前项目的动态由对话列表自身展示，这里只聚合其他项目的通知
      if (!conversation || directoryId === activeDirectoryId) {
        return;
      }
      let group = groups.get(directoryId);
      if (!group) {
        const directory = directoriesById.get(directoryId);
        group = {
          directoryId,
          directoryName: directory?.name || fallbackDirectoryName(directoryId),
          notifications: [],
        };
        groups.set(directoryId, group);
      }
      const existing = group.notifications.find(
        (item) => item.conversation.conversationId === conversationId,
      );
      if (existing) {
        existing[flag] = true;
      } else {
        group.notifications.push({
          conversation,
          isStreaming: flag === "isStreaming",
          isAttentionRequired: flag === "isAttentionRequired",
          isCompleted: flag === "isCompleted",
        });
      }
    };

    for (const id of streamingConversationIds) {
      visit(id, "isStreaming");
    }
    for (const id of attentionRequiredConversationIds) {
      visit(id, "isAttentionRequired");
    }
    for (const id of completedConversationIds) {
      visit(id, "isCompleted");
    }

    return {
      groups: [...groups.values()]
        .map((group) => ({
          ...group,
          notifications: group.notifications.sort(
            (a, b) =>
              parseDbTimestamp(b.conversation.updatedAt).getTime() -
              parseDbTimestamp(a.conversation.updatedAt).getTime(),
          ),
        }))
        .sort((a, b) => a.directoryName.localeCompare(b.directoryName)),
      activeSessionDirectoryIds,
    };
  }, [
    conversationsById,
    directoriesById,
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
    activeDirectoryId,
  ]);
};
