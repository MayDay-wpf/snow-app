import { ipcRenderer, type IpcRendererEvent } from "electron";
import {
  isImageGenerationTerminal,
  parseImageGenerationTask,
  type ImageGenerationTaskSnapshot,
} from "../../shared/imageGeneration";
import type { BashStreamChunk } from "../types";
import {
  imageGenerationApi,
  logImageGenerationDelivery,
} from "./imageGenerationApi";

const CHUNK_CHANNEL = "mcp:call-tool:chunk";
// Resource ceilings, not task deadlines: native receipt budgets remain the source
// of truth. Exceeding a ceiling only releases callbacks, never settles a task.
const MAX_CALLBACK_BUDGET_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_IMAGE_CALLBACKS = 512;
const RECOVERY_ATTEMPTS = 3;
const RECOVERY_QUERY_TIMEOUT_MS = 10_000;
const RECOVERY_RETRY_MS = 2_000;

type StreamState = {
  streamId: string;
  callback?: (chunk: BashStreamChunk) => void;
  imageGeneration: boolean;
  conversationId: string;
  interactionId: string;
  taskId: string;
  batchId: string;
  startedAt: number;
  terminalReceived: boolean;
  pending: boolean;
  disposed: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const streams = new Map<string, StreamState>();
const cancelRecoveryQueries = new Set<() => void>();
let listenerInstalled = false;
let unloaded = false;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRecord = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const normalizeChunk = (value: unknown): BashStreamChunk | null => {
  if (
    !isRecord(value) ||
    (value.stream !== "stdout" &&
      value.stream !== "stderr" &&
      value.stream !== "interactive_session" &&
      value.stream !== "tool_execution" &&
      value.stream !== "imagegen") ||
    typeof value.data !== "string"
  )
    return null;
  return { stream: value.stream, data: value.data };
};

const isActive = (state: StreamState): boolean =>
  !state.disposed && !unloaded && streams.get(state.streamId) === state;

const disposeStream = (state: StreamState): void => {
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.timer = undefined;
  state.disposed = true;
  state.callback = undefined;
  streams.delete(state.streamId);
};

const terminalEvent = (metadata: Record<string, unknown> | null): boolean =>
  metadata?.type === "completed" ||
  metadata?.type === "failed" ||
  metadata?.type === "cancelled";

const updateIdentity = (
  state: StreamState,
  metadata: Record<string, unknown>,
): void => {
  if (typeof metadata.taskId === "string" && metadata.taskId.trim())
    state.taskId = metadata.taskId;
  if (typeof metadata.batchId === "string" && metadata.batchId.trim())
    state.batchId = metadata.batchId;
};

const deliverChunk = (state: StreamState, chunk: BashStreamChunk): void => {
  try {
    if (state.callback) {
      state.callback(chunk);
      if (
        chunk.stream === "imagegen" &&
        terminalEvent(parseRecord(chunk.data))
      ) {
        logImageGenerationDelivery("callback_delivered", state);
      }
    } else if (
      chunk.stream === "imagegen" &&
      terminalEvent(parseRecord(chunk.data))
    ) {
      logImageGenerationDelivery("no_active_callback", state);
    }
  } catch {
    if (state.imageGeneration)
      logImageGenerationDelivery("callback_failed", state);
  }
};

const chunkListener = (_event: IpcRendererEvent, payload: unknown): void => {
  if (!isRecord(payload) || typeof payload.streamId !== "string") return;
  const chunk = normalizeChunk(payload.chunk);
  if (!chunk) return;
  const metadata = chunk.stream === "imagegen" ? parseRecord(chunk.data) : null;
  const state = streams.get(payload.streamId);
  if (!state) {
    if (metadata && terminalEvent(metadata)) {
      const task = parseImageGenerationTask(metadata.task);
      logImageGenerationDelivery("no_active_callback", {
        conversationId: task?.conversationId ?? "",
        taskId: task?.taskId,
        batchId: task?.batchId,
      });
    }
    return;
  }
  if (metadata) {
    state.imageGeneration = true;
    updateIdentity(state, metadata);
  }
  const terminal = metadata !== null && terminalEvent(metadata);
  // Set before invoking user code: it may synchronously trigger another call.
  if (terminal) state.terminalReceived = true;
  try {
    deliverChunk(state, chunk);
  } finally {
    // The captured state still records terminalReceived when invoke resolves later.
    if (terminal) disposeStream(state);
  }
};

const ensureChunkListener = (): void => {
  if (listenerInstalled || unloaded) return;
  listenerInstalled = true;
  ipcRenderer.on(CHUNK_CHANNEL, chunkListener);
};

window.addEventListener(
  "unload",
  () => {
    unloaded = true;
    if (listenerInstalled)
      ipcRenderer.removeListener(CHUNK_CHANNEL, chunkListener);
    listenerInstalled = false;
    for (const state of streams.values()) disposeStream(state);
    for (const cancel of cancelRecoveryQueries) cancel();
    cancelRecoveryQueries.clear();
  },
  { once: true },
);

const readPendingReceipt = (result: string): Record<string, unknown> | null => {
  const parsed = parseRecord(result);
  if (!parsed || parsed.isError === true) return null;
  if (
    parsed.status === "pending" &&
    typeof parsed.taskId === "string" &&
    parsed.taskId.trim()
  )
    return parsed;
  // Support the normal MCP text envelope without changing public tool schemas.
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content.slice(0, 8)) {
      if (
        !isRecord(block) ||
        block.type !== "text" ||
        typeof block.text !== "string"
      )
        continue;
      const receipt = parseRecord(block.text);
      if (
        receipt?.status === "pending" &&
        typeof receipt.taskId === "string" &&
        receipt.taskId.trim()
      )
        return receipt;
    }
  }
  return null;
};

const readDeadline = (
  state: StreamState,
  receipt: Record<string, unknown>,
): number => {
  const deadline =
    typeof receipt.deadlineAt === "string"
      ? Date.parse(receipt.deadlineAt)
      : NaN;
  if (Number.isFinite(deadline))
    return Math.min(deadline, state.startedAt + MAX_CALLBACK_BUDGET_MS);
  if (
    typeof receipt.budgetMs === "number" &&
    Number.isFinite(receipt.budgetMs) &&
    receipt.budgetMs > 0
  ) {
    return state.startedAt + Math.min(receipt.budgetMs, MAX_CALLBACK_BUDGET_MS);
  }
  if (
    typeof receipt.timeoutSecs === "number" &&
    Number.isFinite(receipt.timeoutSecs) &&
    receipt.timeoutSecs > 0
  ) {
    return (
      state.startedAt +
      Math.min(receipt.timeoutSecs * 1000, MAX_CALLBACK_BUDGET_MS)
    );
  }
  // A legacy receipt without a budget is queried immediately; never invent a
  // success or retain a callback forever based on the requested async flag.
  return Date.now();
};

const boundedTaskQuery = async (
  state: StreamState,
): Promise<ImageGenerationTaskSnapshot | null> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      imageGenerationApi.getImageGenerationTask(
        state.conversationId,
        state.taskId,
      ),
      new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(new Error("Image generation recovery query cancelled"));
        cancelRecoveryQueries.add(cancel);
        if (unloaded) cancel();
        else
          timeout = setTimeout(
            () =>
              reject(new Error("Image generation recovery query timed out")),
            RECOVERY_QUERY_TIMEOUT_MS,
          );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (cancel) cancelRecoveryQueries.delete(cancel);
  }
};

const recoverTerminalChunk = (
  task: ImageGenerationTaskSnapshot,
): BashStreamChunk => {
  // This is replay of the committed result, not a completion inferred from time.
  const result = parseRecord(task.resultJson);
  return {
    stream: "imagegen",
    data: JSON.stringify({
      type: task.status,
      taskId: task.taskId,
      conversationId: task.conversationId,
      batchId: task.batchId,
      interactionId: task.interactionId,
      callId: task.callId,
      durationMs: task.durationMs,
      result: result ?? task.resultJson,
      task,
    }),
  };
};

const recoverAtBudget = async (
  state: StreamState,
  attempt = 0,
): Promise<void> => {
  state.timer = undefined;
  if (!isActive(state)) return;
  if (state.taskId) {
    try {
      const task = await boundedTaskQuery(state);
      if (!isActive(state) || state.terminalReceived) return;
      if (task && isImageGenerationTerminal(task.status)) {
        state.terminalReceived = true;
        deliverChunk(state, recoverTerminalChunk(task));
        disposeStream(state);
        return;
      }
    } catch {
      if (isActive(state))
        logImageGenerationDelivery("task_read_failed", state);
    }
  }
  if (!isActive(state)) return;
  if (attempt + 1 < RECOVERY_ATTEMPTS && state.taskId) {
    state.timer = setTimeout(() => {
      void recoverAtBudget(state, attempt + 1);
    }, RECOVERY_RETRY_MS);
    return;
  }
  logImageGenerationDelivery("callback_budget_released", state);
  disposeStream(state);
};

const retainPendingStream = (
  state: StreamState,
  receipt: Record<string, unknown>,
): void => {
  if (!isActive(state) || state.terminalReceived) return;
  state.pending = true;
  updateIdentity(state, receipt);
  // Attribution stays tied to actual IPC arguments, not native/model receipt text.
  const retained = [...streams.values()].filter((stream) => stream.pending);
  while (retained.length > MAX_RETAINED_IMAGE_CALLBACKS) {
    const oldest = retained.shift();
    if (!oldest) break;
    logImageGenerationDelivery("callback_budget_released", oldest);
    disposeStream(oldest);
  }
  if (!isActive(state)) return;
  const remaining = Math.max(0, readDeadline(state, receipt) - Date.now());
  state.timer = setTimeout(() => {
    void recoverAtBudget(state);
  }, remaining);
};

export const callMcpTool = async (
  toolFullName: string,
  argsJson: string,
  projectId?: string,
  checkpointIds?: string[],
  checkpointWorkDir?: string,
  sensitiveAuthorizationToken?: string,
  onChunk?: (chunk: BashStreamChunk) => void,
  interactionId?: string,
  subAgentAllowedTools?: string[],
  conversationId?: string,
  modelRequestId?: string,
): Promise<string> => {
  const streamId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ensureChunkListener();
  const state: StreamState = {
    streamId,
    callback: onChunk,
    imageGeneration:
      /(?:^|[^A-Za-z0-9_-])imagegen-generate(?:$|[^A-Za-z0-9_-])/u.test(
        toolFullName,
      ),
    conversationId: conversationId?.trim() ?? "",
    interactionId: interactionId ?? streamId,
    taskId: "",
    batchId: "",
    startedAt: Date.now(),
    terminalReceived: false,
    pending: false,
    disposed: unloaded,
  };
  if (!unloaded && (onChunk || state.imageGeneration))
    streams.set(streamId, state);
  try {
    const result: string = await ipcRenderer.invoke(
      "mcp:call-tool",
      toolFullName,
      argsJson,
      projectId,
      checkpointIds,
      checkpointWorkDir,
      sensitiveAuthorizationToken,
      streamId,
      interactionId ?? streamId,
      subAgentAllowedTools,
      conversationId,
      modelRequestId,
    );
    const pending = state.imageGeneration ? readPendingReceipt(result) : null;
    if (pending && !state.terminalReceived) retainPendingStream(state, pending);
    else disposeStream(state);
    return result;
  } catch (error) {
    // Submission failures release stream callbacks immediately. If native already
    // identified a durable task, a bounded background read recovers its real state
    // through the independent task API without turning the rejected invoke into success.
    disposeStream(state);
    if (
      state.imageGeneration &&
      state.taskId &&
      !state.terminalReceived &&
      !unloaded
    ) {
      void boundedTaskQuery(state).catch(() => {
        if (!unloaded) logImageGenerationDelivery("task_read_failed", state);
      });
    }
    throw error;
  }
};
