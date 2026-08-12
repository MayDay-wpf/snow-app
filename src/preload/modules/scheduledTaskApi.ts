import { ipcRenderer } from "electron";

import type { PreScriptResult } from "../types";

/**
 * Wire shape of a scheduled task as persisted in SQLite (camelCase view of
 * the Rust napi struct). `scheduleJson` holds the serialized
 * `ScheduledTaskSchedule`; the renderer store converts to/from the rich
 * `ScheduledTaskRecord` type used across the UI.
 */
export type ScheduledTaskWireRun = {
  runAt: string;
  status: string;
  durationMs?: number;
  error?: string;
};

export type ScheduledTaskWireRecord = {
  id: string;
  directoryId: string;
  name: string;
  prompt: string;
  scheduleJson: string;
  apiProfile?: string;
  basicModel?: string;
  model?: string;
  thinkingStrength?: string;
  status: string;
  paused: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  runCount: number;
  lastError?: string;
  /** Optional pre-script shell command executed before the AI Loop. */
  preScript?: string;
  /** Pre-script timeout in ms (default 60000, range 1000-300000). */
  preScriptTimeoutMs?: number;
  /** When true, a pre-script failure still proceeds to the AI Loop. */
  runOnScriptError?: boolean;
  /** How many times the pre-script skipped the AI Loop. */
  skipCount?: number;
  /** ISO timestamp of the last skip, if any. */
  lastSkippedAt?: string;
  /** Reason from the last skip. */
  lastSkipReason?: string;
  createdAt: string;
  updatedAt: string;
  history: ScheduledTaskWireRun[];
};

/**
 * Persistence bridge for scheduled tasks. The renderer store keeps its
 * in-memory Map as the runtime authority and writes every mutation through
 * these channels so tasks and their run history survive app restarts.
 */
export const scheduledTaskApi = {
  listScheduledTasks: (): Promise<ScheduledTaskWireRecord[]> =>
    ipcRenderer.invoke("scheduled-tasks:list"),
  upsertScheduledTask: (
    input: Omit<ScheduledTaskWireRecord, "history">
  ): Promise<ScheduledTaskWireRecord> =>
    ipcRenderer.invoke("scheduled-tasks:upsert", input),
  deleteScheduledTask: (taskId: string): Promise<void> =>
    ipcRenderer.invoke("scheduled-tasks:delete", taskId),
  /** directoryId: null = clear all; "" = global only; other = that project. */
  clearScheduledTasks: (directoryId: string | null): Promise<number> =>
    ipcRenderer.invoke("scheduled-tasks:clear", directoryId),
  appendScheduledTaskRun: (
    taskId: string,
    runAt: string
  ): Promise<string> =>
    ipcRenderer.invoke("scheduled-tasks:append-run", taskId, runAt),
  finalizeScheduledTaskRun: (
    taskId: string,
    runId: string,
    status: "completed" | "error",
    durationMs?: number,
    error?: string
  ): Promise<void> =>
    ipcRenderer.invoke(
      "scheduled-tasks:finalize-run",
      taskId,
      runId,
      status,
      durationMs,
      error
    ),
  /** Marks run rows left "running" by a crashed session as errored. Called
   *  once at startup before hydration reads the run history. */
  reconcileScheduledTaskRuns: (): Promise<number> =>
    ipcRenderer.invoke("scheduled-tasks:reconcile-runs"),
  /** Runs a pre-script shell command in the given cwd. Never blocks: the
   *  Rust backend spawns the process on the tokio runtime. */
  runPreScript: (
    command: string,
    cwd: string,
    timeoutMs: number,
    envJson: string
  ): Promise<PreScriptResult> =>
    ipcRenderer.invoke(
      "scheduled-task:run-pre-script",
      command,
      cwd,
      timeoutMs,
      envJson
    ),
};
