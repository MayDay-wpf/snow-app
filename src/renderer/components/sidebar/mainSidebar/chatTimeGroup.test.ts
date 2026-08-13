import assert from "node:assert/strict";
import test from "node:test";
import type { ChatConversationRecord } from "../../../../preload";
import { groupConversationsByTime } from "./chatTimeGroup";

const now = new Date(2026, 7, 13, 10, 0, 0);

const record = (
  conversationId: string,
  updatedAt: string
): ChatConversationRecord =>
  ({ conversationId, updatedAt }) as unknown as ChatConversationRecord;

test("groupConversationsByTime", async (t) => {
  await t.test("已排序列表按固定顺序分组，每个分组只出现一次", () => {
    const groups = groupConversationsByTime(
      [
        record("c-running", "2026-08-10 09:00:00"),
        record("c-today-1", "2026-08-13 09:30:00"),
        record("c-today-2", "2026-08-13 08:00:00"),
        record("c-yesterday", "2026-08-12 23:00:00"),
        record("c-week", "2026-08-10 12:00:00"),
        record("c-old", "2026-08-01 08:00:00"),
      ],
      now,
      new Set(["c-running"])
    );

    assert.deepEqual(
      groups.map((group) => group.key),
      ["running", "today", "yesterday", "last7days", "earlier"]
    );
    // 组内按 updatedAt 倒序
    assert.deepEqual(
      groups
        .find((group) => group.key === "today")!
        .conversations.map((conversation) => conversation.conversationId),
      ["c-today-1", "c-today-2"]
    );
  });

  await t.test("乱序输入不会产生重复分组头（复现：昨天的过期记录夹在今天项之间）", () => {
    const groups = groupConversationsByTime(
      [
        record("c-running", "2026-08-10 09:00:00"),
        // 长跑会话的过期记录：updatedAt 还停在昨天，位置却排在今天项之前
        record("c-stale", "2026-08-12 23:00:00"),
        record("c-today-1", "2026-08-13 09:30:00"),
        record("c-today-2", "2026-08-13 08:00:00"),
        record("c-yesterday", "2026-08-12 22:00:00"),
      ],
      now,
      new Set(["c-running"])
    );

    assert.deepEqual(
      groups.map((group) => group.key),
      ["running", "today", "yesterday"]
    );
    // 两条"昨天"合并为一组，组内仍按 updatedAt 倒序
    assert.deepEqual(
      groups
        .find((group) => group.key === "yesterday")!
        .conversations.map((conversation) => conversation.conversationId),
      ["c-stale", "c-yesterday"]
    );
  });

  await t.test("无运行中会话时不产生 running 组", () => {
    const groups = groupConversationsByTime(
      [
        record("c-today", "2026-08-13 09:00:00"),
        record("c-old", "2026-08-01 08:00:00"),
      ],
      now
    );

    assert.deepEqual(
      groups.map((group) => group.key),
      ["today", "earlier"]
    );
  });

  await t.test("空列表返回空数组", () => {
    assert.deepEqual(groupConversationsByTime([], now, new Set(["x"])), []);
  });
});
