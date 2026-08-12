import { ipcMain } from "electron";
import type {
  NativeBridge,
  ScheduledTaskRecordInput,
} from "../../native/types";

const requireTaskId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Scheduled task ID is required");
  }
  return value.trim();
};

const requireRunAt = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("runAt timestamp is required");
  }
  return value.trim();
};

const requireRunId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("run ID is required");
  }
  return value.trim();
};

const requireRunStatus = (value: unknown): string => {
  if (value === "completed" || value === "error") {
    return value;
  }
  throw new Error("Run status must be 'completed' or 'error'");
};

const requireOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const requireOptionalInt = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
};

const requireTaskInput = (value: unknown): ScheduledTaskRecordInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Scheduled task record is required");
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    "id",
    "directoryId",
    "name",
    "prompt",
    "scheduleJson",
    "status",
    "createdAt",
    "updatedAt",
  ]) {
    if (typeof record[field] !== "string" || !record[field].trim()) {
      throw new Error(`Scheduled task field "${field}" is required`);
    }
  }
  return {
    id: (record.id as string).trim(),
    directoryId: (record.directoryId as string).trim(),
    name: (record.name as string).trim(),
    prompt: (record.prompt as string).trim(),
    scheduleJson: (record.scheduleJson as string).trim(),
    apiProfile: requireOptionalString(record.apiProfile),
    basicModel: requireOptionalString(record.basicModel),
    model: requireOptionalString(record.model),
    thinkingStrength: requireOptionalString(record.thinkingStrength),
    status: (record.status as string).trim(),
    paused: record.paused === true,
    nextRunAt: requireOptionalString(record.nextRunAt),
    lastRunAt: requireOptionalString(record.lastRunAt),
    runCount:
      typeof record.runCount === "number" && Number.isFinite(record.runCount)
        ? Math.floor(record.runCount)
        : 0,
    lastError: requireOptionalString(record.lastError),
    preScript: requireOptionalString(record.preScript),
    preScriptTimeoutMs: requireOptionalInt(record.preScriptTimeoutMs),
    // Always a boolean: the DB column is NOT NULL DEFAULT 0 and an explicit
    // null/undefined would fail the whole upsert (SQLite only applies DEFAULT
    // when the column is omitted from the INSERT).
    runOnScriptError: record.runOnScriptError === true,
    skipCount:
      typeof record.skipCount === "number" && Number.isFinite(record.skipCount)
        ? Math.floor(record.skipCount)
        : 0,
    lastSkippedAt: requireOptionalString(record.lastSkippedAt),
    lastSkipReason: requireOptionalString(record.lastSkipReason),
    createdAt: (record.createdAt as string).trim(),
    updatedAt: (record.updatedAt as string).trim(),
  };
};

export const registerScheduledTaskHandlers = (native: NativeBridge): void => {
  ipcMain.handle("scheduled-tasks:list", () => {
    return native.listScheduledTasks();
  });

  ipcMain.handle("scheduled-tasks:upsert", (_event, input: unknown) => {
    return native.upsertScheduledTask(requireTaskInput(input));
  });

  ipcMain.handle("scheduled-tasks:delete", (_event, taskId: unknown) => {
    return native.deleteScheduledTask(requireTaskId(taskId));
  });

  ipcMain.handle("scheduled-tasks:clear", (_event, directoryId: unknown) => {
    // undefined / null / empty string clears everything; a non-empty value
    // clears only that project's (or "" for global-only) tasks.
    if (directoryId === undefined || directoryId === null) {
      return native.clearScheduledTasks(null);
    }
    if (typeof directoryId !== "string") {
      throw new Error("directoryId must be a string or null");
    }
    return native.clearScheduledTasks(directoryId.trim());
  });

  ipcMain.handle(
    "scheduled-tasks:append-run",
    (_event, taskId: unknown, runAt: unknown) => {
      return native.appendScheduledTaskRun(
        requireTaskId(taskId),
        requireRunAt(runAt)
      );
    }
  );

  ipcMain.handle(
    "scheduled-tasks:finalize-run",
    (
      _event,
      taskId: unknown,
      runId: unknown,
      status: unknown,
      durationMs: unknown,
      error: unknown
    ) => {
      return native.finalizeScheduledTaskRun(
        requireTaskId(taskId),
        requireRunId(runId),
        requireRunStatus(status),
        requireOptionalInt(durationMs),
        requireOptionalString(error)
      );
    }
  );

  ipcMain.handle("scheduled-tasks:reconcile-runs", () => {
    return native.reconcileScheduledTaskRuns();
  });
};
