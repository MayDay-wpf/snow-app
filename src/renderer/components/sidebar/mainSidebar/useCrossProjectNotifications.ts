import { useEffect, useMemo, useState } from "react";

import { useChatConversationContext } from "../../mainContent/chatMessages";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { parseDbTimestamp } from "./chatTimeGroup";

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

/** 项目名称回退：local:/path → 末级目录名；SSH 等特殊格式直接原样返回。 */
const fallbackDirectoryName = (directoryId: string): string => {
  const trimmed = directoryId.trim();
  const separatorIndex = trimmed.indexOf(":");
  const rawPath = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
  const segments = rawPath.split(/[\\/]/).filter(Boolean);
  return segments.pop() || trimmed;
};

export const useCrossProjectNotifications = (
  activeDirectoryId: string
): CrossProjectNotificationGroup[] => {
  const {
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
  } = useChatConversationContext();

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
            new Map(directories.map((directory) => [directory.directoryId, directory]))
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

  // 跨项目按 id 查询会话记录；状态集合清空时同步清空缓存。
  useEffect(() => {
    let cancelled = false;
    if (!notificationIdsKey) {
      setConversationsById(new Map());
      return;
    }

    const ids = notificationIdsKey.split("\u0000");
    void window.snow
      .listChatConversationsByIds(ids)
      .then((records) => {
        if (cancelled) {
          return;
        }
        setConversationsById((prev) => {
          const activeIds = new Set(ids);
          const next = new Map(prev);
          // 清理已不在通知集合中的过期记录
          for (const key of next.keys()) {
            if (!activeIds.has(key)) {
              next.delete(key);
            }
          }
          for (const record of records) {
            next.set(record.conversationId, record);
          }
          return next;
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [notificationIdsKey]);

  return useMemo(() => {
    const groups = new Map<string, CrossProjectNotificationGroup>();

    const visit = (
      conversationId: string,
      flag: keyof Pick<
        CrossProjectNotification,
        "isStreaming" | "isAttentionRequired" | "isCompleted"
      >
    ): void => {
      const conversation = conversationsById.get(conversationId);
      if (!conversation) {
        return;
      }
      const directoryId = conversation.directoryId;
      // 当前项目的动态由对话列表自身展示，这里只聚合其他项目的通知
      if (!directoryId || directoryId === activeDirectoryId) {
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
        (item) => item.conversation.conversationId === conversationId
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

    return [...groups.values()]
      .map((group) => ({
        ...group,
        notifications: group.notifications.sort(
          (a, b) =>
            parseDbTimestamp(b.conversation.updatedAt).getTime() -
            parseDbTimestamp(a.conversation.updatedAt).getTime()
        ),
      }))
      .sort((a, b) => a.directoryName.localeCompare(b.directoryName));
  }, [
    conversationsById,
    directoriesById,
    streamingConversationIds,
    attentionRequiredConversationIds,
    completedConversationIds,
    activeDirectoryId,
  ]);
};
