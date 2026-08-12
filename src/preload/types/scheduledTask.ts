/**
 * Type model for scheduled tasks.
 *
 * Tasks are persisted to the backend SQLite database: definition, status,
 * pause state and run history all survive app restarts. The scheduler itself
 * (timers, the tick loop) runs in the renderer process, so tasks only execute
 * while the app is running; a task whose fire time passes while the app is
 * closed is skipped and its schedule advances to the next plan point.
 *
 * A task wraps a user-configured prompt that is sent to the existing AI Loop
 * (via buildFromContent, which creates a new chat conversation and auto-sends,
 * giving the task access to all tools). Schedules are either:
 *  - "once":   executes one time at a chosen start time (ISO timestamp)
 *  - "recurring": repeats either at a fixed interval (intervalMs) or every
 *                day at a fixed hour:minute (daily mode)
 */

export type ScheduledTaskType = "once" | "recurring";

export type ScheduledTaskSchedule = {
  /** "once" = execute a single time at executeAt; "recurring" = repeat */
  type: ScheduledTaskType;
  /** ISO 8601 timestamp (UTC). Required when type === "once". */
  executeAt?: string;
  /** Recurring mode: "interval" = every intervalMs; "daily" = every day at hour:minute */
  mode?: "interval" | "daily";
  /** Milliseconds between executions. Required when mode === "interval". Min 60000 (1 min). */
  intervalMs?: number;
  /** Hour of day (0-23) for daily schedule. Required when mode === "daily". */
  hour?: number;
  /** Minute of hour (0-59) for daily schedule. Required when mode === "daily". */
  minute?: number;
};

/** Internal runtime status of a task (derived from the scheduler, not stored). */
export type ScheduledTaskStatus =
  | "pending" // scheduled, waiting to fire
  | "running" // currently executing (AI Loop running for this task)
  | "completed" // once-task that already fired
  | "error"; // last execution failed

/** One entry of the task's execution history (in-memory ring buffer). */
export type ScheduledTaskRunRecord = {
  /** ISO timestamp (UTC) when this run started. */
  runAt: string;
  /** Outcome: "running" = in progress (only the newest entry), "completed" /
   *  "error" = finished run. */
  status: "running" | "completed" | "error";
  /** Elapsed milliseconds of the finished run. */
  durationMs?: number;
  /** Error message when status === "error". */
  error?: string;
};

export type ScheduledTaskRecord = {
  id: string;
  /** The workspace directory this task belongs to. Empty string = a global
   *  task not bound to any project (visible from every project's panel and
   *  executed in the currently active project). */
  directoryId: string;
  name: string;
  /** The user-configured prompt sent to the AI Loop on each execution.
   *  May contain the {{SCRIPT_OUTPUT}} placeholder, replaced with the
   *  pre-script's JSON "output" field (or empty) before sending. */
  prompt: string;
  schedule: ScheduledTaskSchedule;
  status: ScheduledTaskStatus;
  /** Whether the task is paused (timers cleared, not firing). */
  paused: boolean;
  /** Optional shell command executed before the AI Loop. The script decides
   *  whether the prompt is sent: exit 0 = run, exit 1 = skip; or the last
   *  stdout line may be a JSON object {"run":bool,"reason":string,"output":string}. */
  preScript?: string;
  /** Timeout for the pre-script in ms (default 60000, range 1000-300000). */
  preScriptTimeoutMs?: number;
  /** When true, a pre-script failure (non-zero/other exit, timeout, spawn
   *  error) still proceeds to the AI Loop. Default false. */
  runOnScriptError?: boolean;
  createdAt: string;
  /** ISO timestamp of the last modification (also touched by runs). */
  updatedAt?: string;
  /** ISO timestamp of the last execution, if any. */
  lastRunAt?: string;
  /** ISO timestamp of the next scheduled execution, if known. */
  nextRunAt?: string;
  /** Error message from the last execution, if status === "error". */
  lastError?: string;
  /** How many times this task has executed the AI Loop. */
  runCount: number;
  /** How many times the pre-script skipped the AI Loop. */
  skipCount: number;
  /** ISO timestamp of the last skip, if any. */
  lastSkippedAt?: string;
  /** Reason from the last skip (script JSON "reason" or exit-code summary). */
  lastSkipReason?: string;
  /** Recent execution history (ring buffer, newest last, max 20 entries).
   *  Persisted in the backend database and restored after a restart. */
  history?: ScheduledTaskRunRecord[];
  /** Optional per-task API configuration overrides (see ScheduledTaskRunOptions). */
  apiProfile?: string;
  /** Basic model snapshot used only for the fired conversation's first title
   *  generation. The conversation itself continues to run on `model`. */
  basicModel?: string;
  /** Advanced model id used for the task's conversation. */
  model?: string;
  thinkingStrength?: string;
};

/**
 * Optional per-task run configuration. When a field is omitted/empty, the
 * fired conversation falls back to the app's current defaults exactly like a
 * task created before this feature existed (global active API profile,
 * profile/model default, profile-bound thinking strength).
 */
export type ScheduledTaskRunOptions = {
  /** API config profile name that serves this task's conversation. */
  apiProfile?: string;
  /** Basic model snapshot used only for the first conversation title. */
  basicModel?: string;
  /** Advanced model id used for the task's conversation. */
  model?: string;
  /** Thinking strength override ("none" | "low" | "medium" | "high" | custom).
   *  Applied per-request (in-memory), never mutates the profile config. */
  thinkingStrength?: string;
};

/** Input shape for creating a scheduled task (mirrors the MCP tool schema). */
export type CreateScheduledTaskInput = {
  /** The workspace directory this task belongs to. Optional: when omitted or
   *  empty, the task is created as a GLOBAL task (not bound to any project). */
  directoryId?: string;
  /**
   * Optional idempotency key. When provided and a task with this id already
   * exists, creation returns the existing task instead of creating a
   * duplicate — safe to reuse when retrying a timed-out tool call.
   */
  id?: string;
  name: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  /** Optional per-task API configuration overrides (see ScheduledTaskRunOptions). */
  apiProfile?: string;
  /** Basic model snapshot used only for the fired conversation's first title. */
  basicModel?: string;
  model?: string;
  thinkingStrength?: string;
  preScript?: string;
  preScriptTimeoutMs?: number;
  runOnScriptError?: boolean;
};

/** Result of running a scheduled-task pre-script in the Rust backend. */
export type PreScriptResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Input shape for updating an existing task's run configuration. Only the
 *  optional per-task overrides can change after creation; name, prompt and
 *  schedule are immutable. An omitted/empty field clears the override, falling
 *  back to the app's current defaults (same semantics as creation). */
export type UpdateScheduledTaskInput = {
  apiProfile?: string;
  basicModel?: string;
  model?: string;
  thinkingStrength?: string;
  preScript?: string;
  preScriptTimeoutMs?: number;
  runOnScriptError?: boolean;
};
