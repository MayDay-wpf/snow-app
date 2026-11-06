import type { ChatMessageRecord } from "../../../../../preload";
import type {
  FileChangeRecord,
  FileChangeCoverageRecord,
} from "../utils/conversationTypes";
import { parseToolCalls } from "../utils/conversationHelpers";
import { extractFileTrackingFromRecords } from "./fileChangeTracking";

type Source = {
  conversationId: string;
  subAgentName: string;
  recordIds: string[];
};
type Manifest = { version: 1; taskId: string; sources: Source[] };
export type TaskSnapshot = Readonly<{
  id: string;
  records: readonly FileChangeRecord[];
  coverage: readonly FileChangeCoverageRecord[];
}>;

const hashPatch = (patch: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const taskSnapshotFingerprint = (
  snapshot: TaskSnapshot | undefined,
): string => {
  if (!snapshot) return "";
  const parts: string[] = [
    snapshot.id,
    String(snapshot.records.length),
    String(snapshot.coverage.length),
  ];
  let patchHash = 2166136261;
  for (const record of snapshot.records) {
    parts.push(
      [
        record.filePath,
        record.kind,
        record.agent,
        record.subAgentName ?? "",
        record.timestamp,
        record.diff?.isBinary ? "binary" : "text",
      ].join("\u0001"),
    );
    if (record.diff) patchHash = hashPatch(record.diff.patch, patchHash);
  }
  for (const record of snapshot.coverage) {
    parts.push(
      [
        record.coverage,
        record.source,
        record.root ?? "",
        record.agent,
        record.timestamp,
        record.reasons.join(","),
      ].join("\u0001"),
    );
  }
  return `${parts.join("\u0003")}\u0002${patchHash.toString(16)}`;
};
export type AgentTaskHistory = {
  id: string;
  closed: boolean;
  endResponseId: string;
  sources: Map<string, { responseIds: Set<string>; subAgentName: string }>;
};
const activeTasks = new Map<string, AgentTaskHistory>();
export const startAgentTask = (key: string): AgentTaskHistory => {
  const task = {
    id: crypto.randomUUID(),
    closed: false,
    endResponseId: "",
    sources: new Map(),
  };
  activeTasks.set(key, task);
  return task;
};
export const currentAgentTask = (key: string): AgentTaskHistory | undefined =>
  activeTasks.get(key);
export const bindAgentTask = (key: string, task: AgentTaskHistory): void => {
  if (task.closed) return;
  const current = activeTasks.get(key);
  if (!current || current === task) activeTasks.set(key, task);
};
export const recordTaskResponse = (
  task: AgentTaskHistory | undefined,
  conversationId: string,
  responseId: string,
  subAgentName = "",
): void => {
  if (!task || task.closed || !responseId || !conversationId) return;
  const source = task.sources.get(conversationId) ?? {
    responseIds: new Set<string>(),
    subAgentName,
  };
  source.responseIds.add(responseId);
  task.sources.set(conversationId, source);
};

const persistedTasks = new WeakSet<AgentTaskHistory>();
const savingTasks = new WeakMap<AgentTaskHistory, Promise<void>>();
const sealedTasks = new WeakMap<AgentTaskHistory, AgentTaskHistory>();
const permanentSaveFailures = new WeakMap<AgentTaskHistory, Error>();

/** Only fixed codes and identity/count fields may enter task-history diagnostics. */
const logTaskHistory = (
  level: "DEBUG" | "INFO" | "WARN",
  func: string,
  conversationId: string,
  reason: string,
  context: Record<string, string | number> = {},
): void => {
  try {
    if (typeof window.snow.writeLog !== "function") return;
    void window.snow
      .writeLog(level, {
        module: "chat/taskHistory",
        func,
        message: reason,
        context: JSON.stringify({
          conversation_id: conversationId,
          reason,
          ...context,
        }),
      })
      .catch(() => {});
  } catch {
    // Older bridges and logging failures must not affect task history.
  }
};

const isPermanentSaveFailure = (error: unknown): boolean => {
  // IPC may prefix native errors. Inspect only known validation codes; never log
  // the original error text, which may contain sensitive provider information.
  if (!(error instanceof Error)) return false;
  return [
    "Invalid task manifest",
    "Invalid task source",
    "Task reply identity is missing or ambiguous",
    "Task response identity is missing or ambiguous",
    "Task source is outside its conversation scope",
    "Task record is missing",
    "Task must own its end reply",
    "Invalid stored response metadata",
    "Task history is immutable",
    "Cannot serialize task history",
    "Invalid task history request",
  ].some((code) => error.message.includes(code));
};

/** Resolve identities from actual responses and paired call IDs, never time/checkpoints. */
const persistAgentTask = async (
  task: AgentTaskHistory,
  conversationId: string,
  setStage: (stage: string) => void,
): Promise<void> => {
  const manifest: Manifest = { version: 1, taskId: task.id, sources: [] };
  let finalResponseId = "";
  for (const [sourceId, source] of task.sources) {
    setStage("read-records");
    const records = await window.snow.listChatMessages(sourceId);
    setStage("resolve-identities");
    for (const responseId of source.responseIds) {
      if (
        records.filter(
          (record) =>
            record.role === "assistant" && record.responseId === responseId,
        ).length !== 1
      )
        throw new Error("Task response identity is missing or ambiguous");
    }
    const assistants = records.filter(
      (record) =>
        record.role === "assistant" &&
        source.responseIds.has(record.responseId),
    );
    const ids = new Set(assistants.map((record) => record.id));
    // Tool results are persisted after their calling assistant and before the
    // next assistant. Scope the call-ID pairing to that actual record chain;
    // providers can reuse a call ID in a later user task.
    let callingKeys = new Set<string>();
    for (const record of records) {
      if (record.role === "assistant") {
        callingKeys = source.responseIds.has(record.responseId)
          ? new Set(
              parseToolCalls(record.toolCallsJson).flatMap((call) =>
                call.callId ? [`${call.name}#${call.callId}`] : [],
              ),
            )
          : new Set();
        continue;
      }
      if (record.role !== "tool") continue;
      const segments = record.content.split(/\n\n(?=\[Tool: [^\n]+\]\n)/);
      if (
        segments.some((segment) => {
          const header = /^\[Tool:\s*(.+?)\]\n/.exec(segment);
          return !!header && callingKeys.has(header[1]);
        })
      )
        ids.add(record.id);
    }
    manifest.sources.push({
      conversationId: sourceId,
      subAgentName: source.subAgentName,
      recordIds: records
        .filter((record) => ids.has(record.id))
        .map((record) => record.id),
    });
    if (sourceId === conversationId)
      finalResponseId = assistants.some(
        (record) => record.responseId === task.endResponseId,
      )
        ? task.endResponseId
        : "";
  }
  if (!finalResponseId)
    throw new Error("Task response identity is missing or ambiguous");
  setStage("save-ipc");
  await window.snow.saveTaskHistory(
    conversationId,
    finalResponseId,
    JSON.stringify(manifest),
  );
};

export const finishAgentTask = (
  task: AgentTaskHistory,
  conversationId: string,
): Promise<void> => {
  // Close collection synchronously, even while persistence is being retried.
  task.closed = true;
  for (const [key, current] of activeTasks)
    if (current === task) activeTasks.delete(key);
  if (persistedTasks.has(task)) return Promise.resolve();
  const saving = savingTasks.get(task);
  if (saving) return saving;
  const permanentFailure = permanentSaveFailures.get(task);
  if (permanentFailure) return Promise.reject(permanentFailure);
  let sealed = sealedTasks.get(task);
  if (!sealed) {
    sealed = {
      ...task,
      sources: new Map(
        [...task.sources].map(([id, source]) => [
          id,
          { ...source, responseIds: new Set(source.responseIds) },
        ]),
      ),
    };
    sealedTasks.set(task, sealed);
  }
  const snapshot = sealed;
  const pending = (async (): Promise<void> => {
    if (!snapshot.endResponseId) {
      logTaskHistory(
        "INFO",
        "finishAgentTask",
        conversationId,
        "save-skipped-no-end-response",
        {
          taskId: snapshot.id,
          stage: "seal",
          sourceCount: snapshot.sources.size,
        },
      );
      return;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      let stage = "read-records";
      try {
        await persistAgentTask(snapshot, conversationId, (next) => {
          stage = next;
        });
      } catch (error) {
        const permanent =
          stage === "resolve-identities" || isPermanentSaveFailure(error);
        const failure = new Error(
          permanent
            ? "Task history validation failed"
            : "Task history persistence failed",
        );
        if (permanent) permanentSaveFailures.set(task, failure);
        logTaskHistory(
          "WARN",
          "finishAgentTask",
          conversationId,
          permanent ? "save-failed-permanent" : "save-failed-transient",
          {
            taskId: snapshot.id,
            stage,
            attempt,
            sourceCount: snapshot.sources.size,
          },
        );
        if (permanent || attempt === 2) throw failure;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      persistedTasks.add(task);
      pendingSnapshots.delete(conversationId);
      invalidateTaskSnapshots(conversationId);
      logTaskHistory(
        "INFO",
        "finishAgentTask",
        conversationId,
        "save-succeeded",
        {
          taskId: snapshot.id,
          stage: "saved",
          attempt,
          sourceCount: snapshot.sources.size,
        },
      );
      window.dispatchEvent(
        new CustomEvent("agent-task-history-updated", {
          detail: conversationId,
        }),
      );
      return;
    }
  })();
  savingTasks.set(task, pending);
  void pending
    .finally(() => {
      if (savingTasks.get(task) === pending) savingTasks.delete(task);
    })
    .catch(() => {});
  return pending;
};

const readManifest = (value: unknown): Manifest | null => {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Manifest;
  if (
    manifest.version !== 1 ||
    typeof manifest.taskId !== "string" ||
    !manifest.taskId ||
    !Array.isArray(manifest.sources)
  )
    return null;
  if (
    !manifest.sources.every(
      (source) =>
        source &&
        typeof source.conversationId === "string" &&
        !!source.conversationId &&
        typeof source.subAgentName === "string" &&
        Array.isArray(source.recordIds) &&
        source.recordIds.every((id) => typeof id === "string" && !!id),
    )
  )
    return null;
  return manifest;
};

/** Host-only reconstruction. Plugins receive file evidence, never chat records. */
const reconstructTaskSnapshots = async (
  conversationId: string,
): Promise<Map<string, TaskSnapshot>> => {
  let manifests: string[];
  try {
    manifests = await window.snow.listTaskHistory(conversationId);
  } catch {
    logTaskHistory(
      "WARN",
      "reconstructTaskSnapshots",
      conversationId,
      "restore-list-failed",
      {
        stage: "list-manifests",
      },
    );
    throw new Error("Task history listing failed");
  }
  const histories = new Map<string, Promise<ChatMessageRecord[]>>();
  const snapshots = new Map<string, TaskSnapshot>();
  let failedCount = 0;
  for (const json of manifests) {
    let stage = "parse-manifest";
    let taskId = "";
    try {
      const value: unknown = JSON.parse(json);
      if (!value || typeof value !== "object")
        throw new Error("Invalid task history");
      const saved = value as {
        messageId?: unknown;
        responseId?: unknown;
        manifest?: unknown;
      };
      const manifest = readManifest(saved.manifest);
      if (
        !manifest ||
        typeof saved.responseId !== "string" ||
        !saved.responseId ||
        typeof saved.messageId !== "string" ||
        !saved.messageId
      )
        throw new Error("Invalid task history");
      taskId = manifest.taskId;
      stage = "validate-ownership";
      // Fork/import can copy raw provider metadata without remapping references.
      // Never read the original conversation as if it belonged to this fork.
      if (
        !manifest.sources.some(
          (source) =>
            source.conversationId === conversationId &&
            source.recordIds.includes(saved.messageId as string),
        )
      )
        throw new Error("Invalid task ownership");
      const changes: FileChangeRecord[] = [];
      const coverage: FileChangeCoverageRecord[] = [];
      for (const source of manifest.sources) {
        stage = "read-source";
        let history = histories.get(source.conversationId);
        if (!history) {
          history = window.snow.listChatMessages(source.conversationId);
          histories.set(source.conversationId, history);
        }
        let sourceRecords: ChatMessageRecord[];
        try {
          sourceRecords = await history;
        } catch {
          // Do not let a rejected cached read poison every subsequent task.
          if (histories.get(source.conversationId) === history)
            histories.delete(source.conversationId);
          throw new Error("Task source read failed");
        }
        stage = "validate-records";
        const records = sourceRecords.filter((record) =>
          source.recordIds.includes(record.id),
        );
        if (records.length !== new Set(source.recordIds).size)
          throw new Error("Task source records missing");
        stage = "extract-tracking";
        const tracking = extractFileTrackingFromRecords(records);
        const attribution = {
          agent:
            source.conversationId === conversationId
              ? ("main" as const)
              : ("sub" as const),
          ...(source.subAgentName ? { subAgentName: source.subAgentName } : {}),
        };
        changes.push(
          ...tracking.changes.map((change) => ({ ...change, ...attribution })),
        );
        coverage.push(
          ...tracking.coverage.map((record) => ({ ...record, ...attribution })),
        );
      }
      stage = "freeze-snapshot";
      const snapshot: TaskSnapshot = Object.freeze({
        id: manifest.taskId,
        records: Object.freeze(
          changes.map((record) =>
            Object.freeze({
              ...record,
              ...(record.diff
                ? { diff: Object.freeze({ ...record.diff }) }
                : {}),
            }),
          ),
        ),
        coverage: Object.freeze(
          coverage.map((record) =>
            Object.freeze({
              ...record,
              reasons: Object.freeze([
                ...record.reasons,
              ]) as unknown as string[],
            }),
          ),
        ),
      });
      stage = "resolve-response";
      const rootRecords = await histories.get(conversationId);
      // A provider may reuse a response ID. Persisted message IDs still identify
      // old cards, but a live temporary message must never inherit their snapshot.
      const uniqueResponse =
        rootRecords?.filter(
          (record) =>
            record.role === "assistant" &&
            record.responseId === saved.responseId,
        ).length === 1;
      // Publish only after this task has been fully reconstructed.
      snapshots.set(`message:${saved.messageId}`, snapshot);
      if (uniqueResponse)
        snapshots.set(`response:${saved.responseId}`, snapshot);
    } catch {
      failedCount++;
      logTaskHistory(
        "WARN",
        "reconstructTaskSnapshots",
        conversationId,
        "restore-task-failed",
        {
          stage,
          ...(taskId ? { taskId } : {}),
        },
      );
    }
  }
  // 成功恢复不写日志；仅在存在失败任务时汇总一次。
  if (failedCount > 0)
    logTaskHistory(
      "WARN",
      "reconstructTaskSnapshots",
      conversationId,
      "restore-partial",
      {
        stage: "completed",
        manifestCount: manifests.length,
        failedCount,
      },
    );
  return snapshots;
};

// Share simultaneous history reads across the visible message window, not durable data.
const pendingSnapshots = new Map<string, Promise<Map<string, TaskSnapshot>>>();

const SNAPSHOT_CACHE_TTL_MS = 1000;
const snapshotCache = new Map<
  string,
  { at: number; value: Map<string, TaskSnapshot> }
>();

export const invalidateTaskSnapshots = (conversationId: string): void => {
  snapshotCache.delete(conversationId);
};

export const loadTaskSnapshots = (
  conversationId: string,
): Promise<Map<string, TaskSnapshot>> => {
  const cached = snapshotCache.get(conversationId);
  if (cached && Date.now() - cached.at < SNAPSHOT_CACHE_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  const existing = pendingSnapshots.get(conversationId);
  if (existing) return existing;
  const pending = reconstructTaskSnapshots(conversationId);
  pendingSnapshots.set(conversationId, pending);
  void pending
    .then((value) => {
      snapshotCache.set(conversationId, { at: Date.now(), value });
    })
    .catch(() => {})
    .finally(() => {
      if (pendingSnapshots.get(conversationId) === pending)
        pendingSnapshots.delete(conversationId);
    });
  return pending;
};
