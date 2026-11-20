import { ipcRenderer } from "electron";

import type { ConversationDeleteProgress } from "../types";

// 与主进程 src/main/ipc/deleteProgressChannel.ts 保持一致。
const DELETE_PROGRESS_CHANNEL = "chat-conversations:batch-delete:progress";

const progressCallbacks = new Map<
  string,
  (progress: ConversationDeleteProgress) => void
>();
let listenerRegistered = false;

const ensureListener = (): void => {
  if (listenerRegistered) {
    return;
  }
  listenerRegistered = true;
  ipcRenderer.on(DELETE_PROGRESS_CHANNEL, (_event, payload: unknown) => {
    const record = payload as Record<string, unknown> | null;
    const streamId = record?.streamId;
    const progress = record?.progress as ConversationDeleteProgress | undefined;
    if (typeof streamId !== "string" || !progress) {
      return;
    }
    progressCallbacks.get(streamId)?.(progress);
  });
};

/** 一次批量删除的进度流 id。 */
export const createDeleteProgressStreamId = (): string =>
  `conversation-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 订阅一次批量删除的进度；返回取消订阅函数。 */
export const subscribeDeleteProgress = (
  streamId: string,
  callback: (progress: ConversationDeleteProgress) => void,
): (() => void) => {
  ensureListener();
  progressCallbacks.set(streamId, callback);
  return () => {
    if (progressCallbacks.get(streamId) === callback) {
      progressCallbacks.delete(streamId);
    }
  };
};
