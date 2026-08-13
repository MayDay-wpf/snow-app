import assert from "node:assert/strict";
import test from "node:test";
import type { ResponsesApiStreamChunk } from "../../../../../preload/types/api";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import { applyStreamChunkToMessage } from "./agentLoopHelpers";

const makeMessage = (
  overrides: Partial<ChatConversationMessage> = {}
): ChatConversationMessage => ({
  id: "assistant-1",
  role: "assistant",
  content: "failed partial",
  thinking: "failed thinking",
  timestamp: "10:00",
  status: "sending",
  ...overrides,
});

const makeChunk = (
  overrides: Partial<ResponsesApiStreamChunk> = {}
): ResponsesApiStreamChunk => ({
  contentDelta: "",
  thinkingDelta: "",
  content: "",
  thinking: "",
  retrying: false,
  streamTokenCount: 0,
  elapsedMs: 0,
  ttftMs: 0,
  ...overrides,
});

test("retry chunks clear the failed attempt and presentation retry metadata", () => {
  const message = makeMessage({
    isRetrying: true,
    retryAttempt: 2,
    retryError: "previous raw transport error",
  });
  const result = applyStreamChunkToMessage(
    message,
    makeChunk({
      retrying: true,
      retryAttempt: 3,
      retryError: "new raw transport error",
    }),
    "10:01"
  );

  assert.equal(result.content, "");
  assert.equal(result.thinking, undefined);
  assert.equal(result.status, "sending");
  assert.equal("isRetrying" in result, false);
  assert.equal("retryAttempt" in result, false);
  assert.equal("retryError" in result, false);
});

test("successful chunks accumulate once from the cleared retry state", () => {
  const reset = applyStreamChunkToMessage(
    makeMessage(),
    makeChunk({ retrying: true }),
    "10:01"
  );
  const firstSuccess = applyStreamChunkToMessage(
    reset,
    makeChunk({
      contentDelta: "fresh",
      thinkingDelta: "new ",
    }),
    "10:02"
  );
  const completedSuccess = applyStreamChunkToMessage(
    firstSuccess,
    makeChunk({
      contentDelta: " answer",
      thinkingDelta: "thinking",
    }),
    "10:03"
  );

  assert.equal(completedSuccess.content, "fresh answer");
  assert.equal(completedSuccess.thinking, "new thinking");
  assert.equal(completedSuccess.status, "sending");
  assert.doesNotMatch(completedSuccess.content, /failed partial/);
  assert.doesNotMatch(completedSuccess.thinking ?? "", /failed thinking/);
});
