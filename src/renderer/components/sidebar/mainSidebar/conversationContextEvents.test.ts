import assert from "node:assert/strict";
import test from "node:test";
import {
  beginConversationDrag,
  CONVERSATION_DRAG_MIME,
  endConversationDrag,
  readConversationDragPayload,
  type ConversationDragPayload,
} from "./conversationContextEvents";

const payload: ConversationDragPayload = {
  conversationId: "conversation-source",
  directoryId: "local:D:\\project",
  title: "Source conversation",
  emoji: "🧪",
};

const createDataTransfer = (
  initialData = "",
  types: readonly string[] = []
): DataTransfer => {
  let data = initialData;
  const transfer = {
    effectAllowed: "none",
    types,
    getData: (type: string): string =>
      type === CONVERSATION_DRAG_MIME ? data : "",
    setData: (type: string, value: string): void => {
      if (type === CONVERSATION_DRAG_MIME) {
        data = value;
      }
    },
  };
  return transfer as unknown as DataTransfer;
};

test("conversation drag payload survives Chromium protected dragover mode", async (t) => {
  await t.test("writes the drag payload and copy effect at dragstart", () => {
    const transfer = createDataTransfer();

    beginConversationDrag(transfer, payload);

    assert.equal(transfer.effectAllowed, "copy");
    assert.deepEqual(readConversationDragPayload(transfer), payload);
    endConversationDrag();
  });

  await t.test("falls back to the active payload when dragover hides data", () => {
    beginConversationDrag(createDataTransfer(), payload);
    const protectedTransfer = createDataTransfer("", [CONVERSATION_DRAG_MIME]);

    assert.deepEqual(readConversationDragPayload(protectedTransfer), payload);
    endConversationDrag();
  });

  await t.test("does not reuse stale payload after dragend", () => {
    beginConversationDrag(createDataTransfer(), payload);
    endConversationDrag();
    const protectedTransfer = createDataTransfer("", [CONVERSATION_DRAG_MIME]);

    assert.equal(readConversationDragPayload(protectedTransfer), null);
  });

  await t.test("does not expose the cache to unrelated drag types", () => {
    beginConversationDrag(createDataTransfer(), payload);
    const unrelatedTransfer = createDataTransfer("", ["text/plain"]);

    assert.equal(readConversationDragPayload(unrelatedTransfer), null);
    endConversationDrag();
  });

  await t.test("rejects malformed readable payloads instead of using the cache", () => {
    beginConversationDrag(createDataTransfer(), payload);
    const malformedTransfer = createDataTransfer("not-json", [
      CONVERSATION_DRAG_MIME,
    ]);

    assert.equal(readConversationDragPayload(malformedTransfer), null);
    endConversationDrag();
  });
});
