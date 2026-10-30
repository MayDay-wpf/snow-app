import type { ChatConversationRecord } from "../../../../../preload";
import { parseDbTimestamp } from "../chatTimeGroup";

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
 *
 * pendingToReal（pending 槽位 -> 真实 conversationId）用于判定占位记录的运行态：
 * 新会话迁移后运行中集合改记真实 id，而列表里的占位记录在真实记录 upsert
 * 之前仍以 pending 槽位为 id。若只按自身 id 判断，占位会先被挤出置顶区、
 * 真实记录到达后又回到顶部，表现为条目一下一上闪一次。
 */
export const sortConversationsByUpdatedAt = (
  items: ChatConversationRecord[],
  runningConversationIds?: Set<string>,
  pendingToReal?: Map<string, string>,
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
    const realId = pendingToReal?.get(item.conversationId);
    if (
      runningConversationIds.has(item.conversationId) ||
      (realId !== undefined && runningConversationIds.has(realId))
    ) {
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
