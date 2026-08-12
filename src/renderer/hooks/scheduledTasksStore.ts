/**
 * Scheduled task scheduler with SQLite persistence (renderer singleton).
 *
 * The in-memory Map is the runtime authority: timers, the coarse tick and the
 * synchronous pub/sub API all work exactly as before. Every mutation is
 * additionally written back to the backend SQLite database (task definition,
 * status, pause state and run history), so tasks survive app restarts.
 *
 * On startup the store hydrates from the database and reconciles stale state:
 *   - a task left "running" by a crashed session is reset to "pending"
 *   - an expired once-task is marked "completed" (it never fires again)
 *   - an expired recurring task has its nextRunAt advanced to the next plan
 *     point ("missed runs are skipped", cron-style)
 *   - an in-flight history entry from a crashed session is marked "error"
 *
 * Persistence is best-effort: if the native bridge is unavailable (tests,
 * degraded mode) the store falls back to pure in-memory behavior, and a
 * failed write never blocks scheduling — it is logged and the in-process
 * task remains valid.
 *
 * Execution is delegated to a registered "executor" callback. The renderer
 * (which lives inside the ChatConversationProvider) registers buildFromContent
 * as the executor, so every task fires a fresh AI Loop with access to all
 * tools. If no executor is registered when a task fires, the run is marked as
 * error and retried on the next tick (for recurring tasks).
 *
 * The store is a tiny pub/sub singleton so React components can subscribe to
 * task-list changes. All mutation methods return the affected record (or void)
 * and notify subscribers synchronously.
 */

import type {
  CreateScheduledTaskInput,
  PreScriptResult,
  ScheduledTaskRecord,
  ScheduledTaskRunOptions,
  ScheduledTaskRunRecord,
  ScheduledTaskSchedule,
  UpdateScheduledTaskInput,
} from "../../preload";
import type {
  ScheduledTaskWireRecord,
  ScheduledTaskWireRun,
} from "../../preload/modules/scheduledTaskApi";

/** Minimum interval for interval-mode recurring tasks. */
const MIN_INTERVAL_MS = 60_000;
/** Maximum interval for interval-mode recurring tasks (366 days). Keeps the
 *  computed `nextRunAt` far inside the JS Date range so `toISOString()` can
 *  never throw; anything longer should use "daily" or "once" instead. */
const MAX_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;
/** How many times hydration retries before giving up. */
const HYDRATE_MAX_ATTEMPTS = 3;
/** Base delay between hydration retries (multiplied by the attempt number). */
const HYDRATE_RETRY_DELAY_MS = 2_000;
/** Bounds the per-task run-history ring buffer (newest last). */
const MAX_RUN_HISTORY = 20;

/** Appends a run-history entry, keeping the ring buffer bounded. */
const appendRunHistory = (
  task: ScheduledTaskRecord,
  run: ScheduledTaskRunRecord
): ScheduledTaskRunRecord[] =>
  [...(task.history ?? []), run].slice(-MAX_RUN_HISTORY);
/** Coarse tick used to wake the scheduler and check for due tasks. This keeps
 *  drift bounded and avoids one setTimeout per task (which would also leak if
 *  the renderer is throttled in the background). */
const TICK_MS = 5_000;

type Executor = (
  prompt: string,
  taskName: string,
  directoryId: string,
  options: ScheduledTaskRunOptions
) => void | Promise<void>;
/** Placeholder inside a task prompt that the pre-script's JSON "output"
 *  field is injected into (replaced with "" when the script provides none). */
export const SCRIPT_OUTPUT_PLACEHOLDER = "{{SCRIPT_OUTPUT}}";
/** Default pre-script timeout (ms). */
export const PRE_SCRIPT_DEFAULT_TIMEOUT_MS = 60_000;
export const PRE_SCRIPT_MIN_TIMEOUT_MS = 1_000;
export const PRE_SCRIPT_MAX_TIMEOUT_MS = 300_000;

/** Executes the task's pre-script. Registered by the React hook, which binds
 *  the project directory (cwd) and calls the Rust backend asynchronously. */
type ScriptRunner = (
  command: string,
  options: { timeoutMs: number; env: Record<string, string> }
) => Promise<PreScriptResult>;
type Listener = () => void;

/** Decision produced by parsing a pre-script result. */
export type PreScriptDecision =
  | { action: "run"; promptOverride?: string; output?: string }
  | { action: "skip"; reason: string; output?: string }
  | { action: "error"; errorMessage: string };

const isBrowser =
  typeof window !== "undefined" && typeof window.crypto !== "undefined";

const generateId = (): string => {
  if (isBrowser && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `st_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

/** Validates and normalizes a schedule, throwing on invalid input. */
export const validateSchedule = (schedule: ScheduledTaskSchedule): void => {
  if (schedule.type !== "once" && schedule.type !== "recurring") {
    throw new Error(
      `Invalid schedule type: "${schedule.type}". Must be "once" or "recurring".`
    );
  }

  if (schedule.type === "once") {
    if (!schedule.executeAt) {
      throw new Error("executeAt is required for a once schedule");
    }
    const ms = Date.parse(schedule.executeAt);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid executeAt timestamp: "${schedule.executeAt}"`);
    }
    return;
  }

  // recurring
  if (schedule.mode !== "interval" && schedule.mode !== "daily") {
    throw new Error(
      `Invalid recurring mode: "${schedule.mode}". Must be "interval" or "daily".`
    );
  }

  if (schedule.mode === "interval") {
    const interval =
      typeof schedule.intervalMs === "number" ? schedule.intervalMs : NaN;
    if (
      !Number.isInteger(interval) ||
      interval < MIN_INTERVAL_MS ||
      interval > MAX_INTERVAL_MS
    ) {
      throw new Error(
        `intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} ms (1 minute - 366 days), received ${schedule.intervalMs}`
      );
    }
  } else {
    // daily
    const hour =
      typeof schedule.hour === "number" ? schedule.hour : Number.NaN;
    const minute =
      typeof schedule.minute === "number" ? schedule.minute : Number.NaN;
    if (
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      throw new Error(
        `hour (0-23) and minute (0-59) are required for a daily schedule, received hour=${schedule.hour}, minute=${schedule.minute}`
      );
    }
  }
};

/** Computes the next fire time (ms epoch) for a schedule, relative to "now". */
const computeNextRunMs = (
  schedule: ScheduledTaskSchedule,
  now: number
): number | null => {
  if (schedule.type === "once") {
    if (!schedule.executeAt) return null;
    const ms = Date.parse(schedule.executeAt);
    return Number.isNaN(ms) ? null : ms;
  }

  if (schedule.mode === "interval") {
    const interval = schedule.intervalMs ?? MIN_INTERVAL_MS;
    // next run = now + interval (aligned from creation for steadiness)
    return now + interval;
  }

  // daily: next occurrence of hour:minute today (or tomorrow if already passed)
  const hour = schedule.hour ?? 0;
  const minute = schedule.minute ?? 0;
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let target = candidate.getTime();
  if (target <= now) {
    target += 24 * 60 * 60 * 1000;
  }
  return target;
};

/** Converts a wire record (SQLite shape) into the rich UI record. Returns null
 *  when the stored schedule JSON is unreadable (the task is skipped). */
export const fromWire = (
  wire: Omit<ScheduledTaskWireRecord, "history"> & {
    history?: ScheduledTaskWireRun[];
  }
): ScheduledTaskRecord | null => {
  let schedule: ScheduledTaskSchedule;
  try {
    schedule = JSON.parse(wire.scheduleJson) as ScheduledTaskSchedule;
  } catch {
    console.warn(
      `[scheduledTasks] Skipping task "${wire.id}" with unreadable schedule:`,
      wire.scheduleJson
    );
    return null;
  }
  return {
    id: wire.id,
    directoryId: wire.directoryId,
    name: wire.name,
    prompt: wire.prompt,
    schedule,
    status: wire.status as ScheduledTaskRecord["status"],
    paused: wire.paused,
    createdAt: wire.createdAt,
    lastRunAt: wire.lastRunAt,
    nextRunAt: wire.nextRunAt,
    lastError: wire.lastError,
    runCount: wire.runCount,
    history: (wire.history ?? []).map(
      (run): ScheduledTaskRunRecord => ({
        runAt: run.runAt,
        status: run.status as ScheduledTaskRunRecord["status"],
        durationMs: run.durationMs,
        error: run.error,
      })
    ),
    apiProfile: wire.apiProfile,
    basicModel: wire.basicModel,
    model: wire.model,
    thinkingStrength: wire.thinkingStrength,
    preScript: wire.preScript,
    preScriptTimeoutMs: wire.preScriptTimeoutMs,
    runOnScriptError: wire.runOnScriptError,
    skipCount: wire.skipCount ?? 0,
    lastSkippedAt: wire.lastSkippedAt,
    lastSkipReason: wire.lastSkipReason,
  };
};

/** Converts a rich record into the wire shape for upsert (history lives in
 *  the separate runs table and is excluded from the write). */
export const toWire = (
  record: ScheduledTaskRecord
): Omit<ScheduledTaskWireRecord, "history"> => ({
  id: record.id,
  directoryId: record.directoryId,
  name: record.name,
  prompt: record.prompt,
  scheduleJson: JSON.stringify(record.schedule),
  apiProfile: record.apiProfile,
  basicModel: record.basicModel,
  model: record.model,
  thinkingStrength: record.thinkingStrength,
  preScript: record.preScript,
  preScriptTimeoutMs: record.preScriptTimeoutMs,
  runOnScriptError: record.runOnScriptError,
  skipCount: record.skipCount,
  lastSkippedAt: record.lastSkippedAt,
  lastSkipReason: record.lastSkipReason,
  status: record.status,
  paused: record.paused,
  nextRunAt: record.nextRunAt,
  lastRunAt: record.lastRunAt,
  runCount: record.runCount,
  lastError: record.lastError,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt ?? record.createdAt,
});

/** Best-effort persistence adapter over the preload bridge. Returns null when
 *  the native bridge is unavailable (tests, degraded mode) — the store then
 *  behaves exactly like the old in-memory implementation. */
const createPersistence = (): PersistenceAdapter | null => {
  if (typeof window === "undefined" || !window.snow) return null;
  const api = window.snow;
  if (typeof api.listScheduledTasks !== "function") return null;
  return {
    list: () => api.listScheduledTasks(),
    upsert: (input) =>
      api.upsertScheduledTask(input).then(() => undefined),
    remove: (id) => api.deleteScheduledTask(id),
    clear: (directoryId) => api.clearScheduledTasks(directoryId).then(() => undefined),
    appendRun: (taskId, runAt) => api.appendScheduledTaskRun(taskId, runAt),
    finalizeRun: (taskId, runId, status, durationMs, error) =>
      api.finalizeScheduledTaskRun(taskId, runId, status, durationMs, error),
    reconcileRuns: () => api.reconcileScheduledTaskRuns(),
  };
};

type PersistenceAdapter = {
  list(): Promise<ScheduledTaskWireRecord[]>;
  upsert(input: Omit<ScheduledTaskWireRecord, "history">): Promise<void>;
  remove(id: string): Promise<void>;
  clear(directoryId: string | null): Promise<void>;
  appendRun(taskId: string, runAt: string): Promise<string>;
  finalizeRun(
    taskId: string,
    runId: string,
    status: "completed" | "error",
    durationMs?: number,
    error?: string
  ): Promise<void>;
  /** Marks run rows left "running" by a crashed session as errored. */
  reconcileRuns(): Promise<number>;
};

/**
 * Pre-script output protocol:
 *  - The last stdout line, when it starts with "{", is parsed as JSON:
 *      {"run": false, "reason": "...", "output": "..."}
 *      {"run": true, "output": "...", "prompt": "..."}
 *    - "run": false -> skip the AI Loop this round (reason recorded)
 *    - "output": injected into the {{SCRIPT_OUTPUT}} placeholder
 *    - "prompt": fully overrides the task prompt (advanced)
 *  - Otherwise the exit code decides: 0 = run, 1 = skip, other = error.
 *  - A timeout always counts as an error.
 */
export const parsePreScriptResult = (
  result: PreScriptResult
): PreScriptDecision => {
  if (result.timedOut) {
    return {
      action: "error",
      errorMessage: `Pre-script timed out: ${result.stderr.trim() || "no output"}`,
    };
  }

  const lastLineJson = tryParseLastLineJson(result.stdout);
  if (lastLineJson) {
    const run = lastLineJson.run;
    const output =
      typeof lastLineJson.output === "string" ? lastLineJson.output : undefined;
    if (run === false) {
      const reason =
        typeof lastLineJson.reason === "string" && lastLineJson.reason.trim()
          ? lastLineJson.reason.trim()
          : "Script requested to skip";
      return { action: "skip", reason, output };
    }
    const promptOverride =
      typeof lastLineJson.prompt === "string" && lastLineJson.prompt.trim()
        ? lastLineJson.prompt.trim()
        : undefined;
    return { action: "run", promptOverride, output };
  }

  if (result.exitCode === 0) {
    return { action: "run" };
  }
  if (result.exitCode === 1) {
    return { action: "skip", reason: "Script exited with code 1" };
  }
  return {
    action: "error",
    errorMessage: `Pre-script exited with code ${result.exitCode}${
      result.stderr.trim() ? `: ${truncateText(result.stderr.trim(), 500)}` : ""
    }`,
  };
};

/** Replaces every {{SCRIPT_OUTPUT}} occurrence in the prompt with the script
 *  output (or "" when the script provided none). */
export const applyScriptOutput = (
  prompt: string,
  output: string | undefined
): string => {
  if (!prompt.includes(SCRIPT_OUTPUT_PLACEHOLDER)) return prompt;
  const injected = output ?? "";
  return prompt.split(SCRIPT_OUTPUT_PLACEHOLDER).join(injected);
};

/** Parses the last stdout line as a JSON object; returns null when absent or
 *  not an object (e.g. plain script output, parse failure). */
const tryParseLastLineJson = (
  stdout: string
): Record<string, unknown> | null => {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  if (!lastLine.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(lastLine) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const truncateText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

export class ScheduledTasksStore {
  private tasks = new Map<string, ScheduledTaskRecord>();
  private listeners = new Set<Listener>();
  private executor: Executor | null = null;
  private scriptRunner: ScriptRunner | null = null;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Currently in-flight execution task ids, to prevent overlapping runs. */
  private runningIds = new Set<string>();

  /**
   * Serializes every persistence write (upsert/delete/clear/run rows) in the
   * order the mutations happened. Without this, fire-and-forget IPC calls can
   * commit out of order — a create upsert landing after a delete resurrects
   * the task on the next restart, and a "running" write landing after the
   * "completed" write leaves stale state in the database.
   */
  private persistQueue: Promise<unknown> = Promise.resolve();
  /** True once the database snapshot has been fully loaded into the map. */
  private hydrated = false;
  /** Tombstones for deletes/clears issued while hydration is still in flight;
   *  hydrate() consults them so rows that were deleted in the meantime are
   *  not resurrected. */
  private pendingRemovals = new Set<string>();
  /** `null` = clear everything, `""` = global tasks only, other = one project. */
  private pendingClears: Array<string | null> = [];

  /** Persistence layer (null = in-memory only). Resolved lazily on first use
   *  so tests without the preload bridge keep the legacy behavior. */
  private persistence: PersistenceAdapter | null = null;
  private hydratePromise: Promise<void> | null = null;

  /** Starts the coarse tick loop. Safe to call multiple times. */
  private ensureTick = (): void => {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.dueTasks();
    }, TICK_MS);
    // Don't keep the Node/Electron process alive solely for the scheduler.
    if (this.tickTimer && typeof this.tickTimer.unref === "function") {
      this.tickTimer.unref();
    }
  };

  private stopTick = (): void => {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  };

  /** Registers the AI Loop executor (buildFromContent). */
  setExecutor = (executor: Executor): (() => void) => {
    this.executor = executor;
    return () => {
      if (this.executor === executor) {
        this.executor = null;
      }
    };
  };

  /** Registers the pre-script runner (Rust backend via preload). */
  setScriptRunner = (runner: ScriptRunner): (() => void) => {
    this.scriptRunner = runner;
    return () => {
      if (this.scriptRunner === runner) {
        this.scriptRunner = null;
      }
    };
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify = (): void => {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors must not break the scheduler.
      }
    }
  };

  /** Loads persisted tasks once. Safe to call multiple times; concurrent
   *  callers share the same in-flight promise. Transient failures are retried
   *  with backoff so a one-off busy database at startup does not silently
   *  disable every persisted task for the whole session. */
  ensureHydrated = (): Promise<void> => {
    if (this.hydratePromise) return this.hydratePromise;
    if (!this.persistence) {
      this.persistence = createPersistence();
    }
    if (!this.persistence) {
      this.hydrated = true;
      this.hydratePromise = Promise.resolve();
      return this.hydratePromise;
    }
    this.hydratePromise = this.hydrateWithRetry().catch((error) => {
      // Retries exhausted: keep working with whatever is in memory; individual
      // mutations still persist on their own and the next app start re-attempts
      // hydration.
      console.warn(
        "[scheduledTasks] Hydration from database failed permanently:",
        error
      );
    });
    return this.hydratePromise;
  };

  private hydrateWithRetry = async (): Promise<void> => {
    const persistence = this.persistence;
    if (!persistence) return;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= HYDRATE_MAX_ATTEMPTS; attempt++) {
      try {
        await this.hydrate(persistence);
        return;
      } catch (error) {
        lastError = error;
        console.warn(
          `[scheduledTasks] Hydration attempt ${attempt}/${HYDRATE_MAX_ATTEMPTS} failed:`,
          error
        );
        if (attempt < HYDRATE_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, HYDRATE_RETRY_DELAY_MS * attempt)
          );
        }
      }
    }
    throw lastError;
  };

  private hydrate = async (persistence: PersistenceAdapter): Promise<void> => {
    // Fix up run rows left "running" by a crashed previous session BEFORE
    // reading them, so the loaded history already shows the error instead of
    // a dangling "running" entry that was never written back to the DB.
    await persistence.reconcileRuns();

    const stored = await persistence.list();
    const now = Date.now();
    const dirty: ScheduledTaskRecord[] = [];

    for (const wire of stored) {
      // Tombstones for deletes/clears issued while hydration was in flight:
      // drop the resurrected rows instead of bringing them back.
      if (this.pendingRemovals.has(wire.id)) continue;
      const directoryId = wire.directoryId ?? "";
      if (
        this.pendingClears.includes(null) ||
        this.pendingClears.includes(directoryId)
      ) {
        continue;
      }
      const record = fromWire(wire);
      if (!record) continue;
      // A task created while hydration was in flight is already live in the
      // map (with newer state) — never clobber it with the DB snapshot.
      if (this.tasks.has(record.id)) continue;
      const { task, changed } = reconcileAfterRestart(record, now);
      this.tasks.set(task.id, task);
      if (changed) dirty.push(task);
    }

    this.hydrated = true;
    this.pendingRemovals.clear();
    this.pendingClears = [];

    // The tick loop is normally started by create(); after a restart the map
    // is filled by hydration instead. Start it here — otherwise persisted
    // tasks would sit in the map forever without ever firing.
    if (this.tasks.size > 0) {
      this.ensureTick();
    }

    if (dirty.length > 0) {
      this.notify();
      for (const task of dirty) {
        this.enqueuePersist(() => persistence.upsert(toWire(task))).catch(
          (error) =>
            console.warn("[scheduledTasks] Failed to persist reconciliation:", error)
        );
      }
    } else {
      this.notify();
    }
  };

  /** Lists tasks. When a directoryId is given, returns that project's tasks
   *  PLUS global tasks (empty directoryId) — a project panel always shows the
   *  global section. With no argument, returns every task. */
  list = (directoryId?: string): ScheduledTaskRecord[] => {
    return Array.from(this.tasks.values())
      .filter(
        (task) =>
          directoryId === undefined ||
          task.directoryId === directoryId ||
          task.directoryId === ""
      )
      .sort((a, b) => {
        // Sort: running/pending first, then by nextRunAt, then createdAt
        const aRank =
          a.status === "running" ? 0 : a.status === "pending" ? 1 : 2;
        const bRank =
          b.status === "running" ? 0 : b.status === "pending" ? 1 : 2;
        if (aRank !== bRank) return aRank - bRank;
        const aNext = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.MAX_SAFE_INTEGER;
        const bNext = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) return aNext - bNext;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
  };

  /** Builds a validated record and inserts it into the in-memory map. Shared
   *  by the sync best-effort `create` and the durability-aware `createAndAwait`. */
  private applyCreate = (
    input: CreateScheduledTaskInput
  ): ScheduledTaskRecord => {
    // Empty directoryId = global task (not bound to any project).
    const directoryId = (input.directoryId ?? "").trim();
    const name = (input.name ?? "").trim();
    if (!name) {
      throw new Error("name is required");
    }
    const prompt = (input.prompt ?? "").trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }
    validateSchedule(input.schedule);

    // Optional pre-script fields
    const preScript = (input.preScript ?? "").trim();
    const preScriptTimeoutMs =
      input.preScriptTimeoutMs ?? PRE_SCRIPT_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(preScriptTimeoutMs)) {
      throw new Error("preScriptTimeoutMs must be a number");
    }
    if (
      preScriptTimeoutMs < PRE_SCRIPT_MIN_TIMEOUT_MS ||
      preScriptTimeoutMs > PRE_SCRIPT_MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `preScriptTimeoutMs must be between ${PRE_SCRIPT_MIN_TIMEOUT_MS} and ${PRE_SCRIPT_MAX_TIMEOUT_MS} ms, received ${preScriptTimeoutMs}`
      );
    }
    const runOnScriptError = input.runOnScriptError === true;

    const now = Date.now();
    const nextRunMs = computeNextRunMs(input.schedule, now);
    const record: ScheduledTaskRecord = {
      id: input.id?.trim() || generateId(),
      directoryId,
      name,
      prompt,
      schedule: input.schedule,
      // Optional per-task run overrides; omitted fields stay undefined so the
      // executor falls back to the app's current defaults.
      apiProfile: input.apiProfile?.trim() || undefined,
      basicModel: input.basicModel?.trim() || undefined,
      model: input.model?.trim() || undefined,
      thinkingStrength: input.thinkingStrength?.trim() || undefined,
      status: "pending",
      paused: false,
      preScript: preScript || undefined,
      preScriptTimeoutMs,
      runOnScriptError,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      nextRunAt:
        nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
      runCount: 0,
      skipCount: 0,
    };
    this.tasks.set(record.id, record);
    this.ensureTick();
    this.notify();
    return record;
  };

  create = (input: CreateScheduledTaskInput): ScheduledTaskRecord => {
    void this.ensureHydrated();
    // Idempotent replay: the same id returns the already-created task instead
    // of a duplicate (used by the app-control tool to survive retries).
    const existingId = input.id?.trim();
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (existing) return existing;
    }
    const record = this.applyCreate(input);
    this.persistUpsert(record);
    return record;
  };

  /** Durability-aware creation used by the app-control tool bridge: only
   *  reports success once the task row is committed to the database. On
   *  persistence failure the in-memory task is rolled back and the error
   *  rethrown, so a model retry (same id) cannot create duplicates. The UI
   *  keeps the best-effort `create`. */
  createAndAwait = async (
    input: CreateScheduledTaskInput
  ): Promise<ScheduledTaskRecord> => {
    await this.ensureHydrated();
    const existingId = input.id?.trim();
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (existing) return existing;
    }
    const record = this.applyCreate(input);
    if (this.persistence) {
      try {
        await this.enqueuePersist(() =>
          this.persistence!.upsert(toWire(record))
        );
      } catch (error) {
        // Roll back so the task exists nowhere — the model sees a clean
        // failure and a retry recreates it exactly once.
        this.tasks.delete(record.id);
        this.runningIds.delete(record.id);
        if (this.tasks.size === 0) {
          this.stopTick();
        }
        this.notify();
        throw error;
      }
    }
    return record;
  };

  remove = (id: string): void => {
    if (!this.hydrated) {
      // Hydration is still in flight: remember the id so hydrate() drops the
      // row instead of resurrecting it.
      this.pendingRemovals.add(id);
    }
    const existed = this.tasks.delete(id);
    if (existed) {
      this.runningIds.delete(id);
      if (this.tasks.size === 0) {
        this.stopTick();
      }
    }
    // Always issue the DB delete (idempotent): a delete issued before the
    // hydration snapshot completes must still reach the database.
    if (this.persistence) {
      this.enqueuePersist(() => this.persistence!.remove(id)).catch((error) => {
        console.warn("[scheduledTasks] Failed to delete task:", error);
      });
    }
    if (existed) {
      this.notify();
    }
  };

  clear = (directoryId?: string): void => {
    if (!this.hydrated) {
      this.pendingClears.push(directoryId === undefined ? null : directoryId);
    }
    if (directoryId === undefined) {
      // Clear everything (e.g. process exit / global reset).
      this.tasks.clear();
      this.runningIds.clear();
      this.stopTick();
      if (this.persistence) {
        this.enqueuePersist(() => this.persistence!.clear(null)).catch(
          (error) => {
            console.warn("[scheduledTasks] Failed to clear tasks:", error);
          }
        );
      }
      this.notify();
      return;
    }
    // Clear only tasks belonging to the given project directory.
    let cleared = false;
    for (const [id, task] of this.tasks) {
      if (task.directoryId === directoryId) {
        this.tasks.delete(id);
        this.runningIds.delete(id);
        cleared = true;
      }
    }
    // Issue the DB clear when something was removed OR when hydration is still
    // pending (rows may exist in the database without a map entry yet).
    if (cleared || !this.hydrated) {
      if (this.tasks.size === 0) {
        this.stopTick();
      }
      if (this.persistence) {
        this.enqueuePersist(() => this.persistence!.clear(directoryId)).catch(
          (error) => {
            console.warn("[scheduledTasks] Failed to clear tasks:", error);
          }
        );
      }
      if (cleared) {
        this.notify();
      }
    }
  };

  /** Removes ONLY global tasks (empty directoryId). Used by the global
   *  section's clear button so project tasks are never touched. */
  clearGlobal = (): void => {
    if (!this.hydrated) {
      this.pendingClears.push("");
    }
    let cleared = false;
    for (const [id, task] of this.tasks) {
      if (task.directoryId === "") {
        this.tasks.delete(id);
        this.runningIds.delete(id);
        cleared = true;
      }
    }
    if (cleared || !this.hydrated) {
      if (this.tasks.size === 0) {
        this.stopTick();
      }
      if (this.persistence) {
        this.enqueuePersist(() => this.persistence!.clear("")).catch(
          (error) => {
            console.warn("[scheduledTasks] Failed to clear global tasks:", error);
          }
        );
      }
      if (cleared) {
        this.notify();
      }
    }
  };

  /** Updates a task's run-configuration overrides (API profile, models,
   *  thinking strength). Everything else (name, prompt, schedule, history,
   *  status) is preserved. Omitted/empty fields clear the override, falling
   *  back to the app's current defaults — same semantics as creation.
   *  Returns the updated record, or null when the task does not exist. */
  update = (
    id: string,
    input: UpdateScheduledTaskInput
  ): ScheduledTaskRecord | null => {
    const task = this.tasks.get(id);
    if (!task) return null;
    const updated: ScheduledTaskRecord = {
      ...task,
      apiProfile: input.apiProfile?.trim() || undefined,
      basicModel: input.basicModel?.trim() || undefined,
      model: input.model?.trim() || undefined,
      thinkingStrength: input.thinkingStrength?.trim() || undefined,
      preScript: input.preScript?.trim() || undefined,
      preScriptTimeoutMs:
        input.preScript && input.preScript.trim()
          ? input.preScriptTimeoutMs ?? PRE_SCRIPT_DEFAULT_TIMEOUT_MS
          : undefined,
      runOnScriptError:
        input.preScript && input.preScript.trim()
          ? (input.runOnScriptError ?? false)
          : // Preserve a boolean even without a pre-script: the DB column is
            // NOT NULL and an undefined value would fail the whole upsert.
            (task.runOnScriptError ?? false),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, updated);
    this.persistUpsert(updated);
    this.notify();
    return updated;
  };

  togglePause = (id: string): ScheduledTaskRecord | null => {
    const task = this.tasks.get(id);
    if (!task) return null;
    const updated: ScheduledTaskRecord = {
      ...task,
      paused: !task.paused,
      status: !task.paused ? "pending" : task.status,
      nextRunAt: !task.paused
        ? new Date(
            computeNextRunMs(task.schedule, Date.now()) ?? Date.now()
          ).toISOString()
        : undefined,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, updated);
    this.persistUpsert(updated);
    this.notify();
    return updated;
  };

  /** Triggers all tasks whose nextRunAt is due and not paused/running. */
  private dueTasks = async (): Promise<void> => {
    const now = Date.now();
    const due: ScheduledTaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.paused) continue;
      if (task.status === "running") continue;
      if (task.status === "completed") continue; // once-task already fired
      if (!task.nextRunAt) continue;
      const nextMs = Date.parse(task.nextRunAt);
      if (Number.isNaN(nextMs) || nextMs > now) continue;
      due.push(task);
    }

    for (const task of due) {
      await this.execute(task.id).catch(() => undefined);
    }
  };

  /** Executes a single task immediately (used by scheduler tick + "run now"). */
  execute = async (id: string): Promise<void> => {
    const task = this.tasks.get(id);
    if (!task) return;
    if (this.runningIds.has(id)) return; // already running

    const executor = this.executor;
    this.runningIds.add(id);

    // Mark running + append an in-progress history entry (finalized by
    // advanceSchedule when the run finishes).
    const startedAt = new Date().toISOString();
    const runningRecord: ScheduledTaskRecord = {
      ...task,
      status: "running",
      lastRunAt: startedAt,
      updatedAt: startedAt,
      history: appendRunHistory(task, {
        runAt: startedAt,
        status: "running",
      }),
    };
    this.tasks.set(id, runningRecord);
    this.persistUpsert(runningRecord);
    this.notify();

    // Record the run in the persisted history table. The run id is awaited so
    // the finalize write can target the exact row; the queue keeps the append
    // before the finalize in the database.
    let runId: string | undefined;
    if (this.persistence) {
      try {
        runId = await this.enqueuePersist(() =>
          this.persistence!.appendRun(task.id, startedAt)
        );
      } catch (error) {
        console.warn("[scheduledTasks] Failed to record task run:", error);
      }
    }

    try {
      if (!executor) {
        throw new Error("No executor registered (AI Loop unavailable)");
      }
      let prompt = task.prompt;

      if (task.preScript) {
        let decision: PreScriptDecision;
        try {
          decision = await this.evaluatePreScript(task);
        } catch (error) {
          // Script infrastructure failure (no runner, IPC error, ...)
          decision = {
            action: "error",
            errorMessage:
              error instanceof Error
                ? `Pre-script failed to start: ${error.message}`
                : "Pre-script failed to start",
          };
        }

        if (decision.action === "skip") {
          this.logSkip(task, decision);
          const after = this.tasks.get(id);
          if (after) {
            const next = this.advanceSchedule(after, undefined, decision);
            this.tasks.set(id, next);
            // Persist skip counters / reason so they survive restarts (they
            // previously lived only in memory and were silently lost).
            this.persistUpsert(next);
          }
          return;
        }

        if (decision.action === "error" && !task.runOnScriptError) {
          this.logScriptError(task, decision);
          const after = this.tasks.get(id);
          if (after) {
            const next = this.advanceSchedule(
              after,
              new Error(decision.errorMessage)
            );
            this.tasks.set(id, next);
            // Persist lastError so the failure is visible after a restart.
            this.persistUpsert(next);
          }
          return;
        }

        // run: apply placeholder injection / prompt override
        if (decision.action === "error") {
          // runOnScriptError: inform the AI Loop about the script failure
          prompt = `${task.prompt}\n\n[Pre-script failed: ${decision.errorMessage}]`;
        } else {
          prompt = applyScriptOutput(
            decision.promptOverride ?? task.prompt,
            decision.output
          );
        }
      }

      await executor(prompt, task.name, task.directoryId, {
        apiProfile: task.apiProfile,
        basicModel: task.basicModel,
        model: task.model,
        thinkingStrength: task.thinkingStrength,
      });

      const after = this.tasks.get(id);
      if (after) {
        const next = this.advanceSchedule(after);
        this.tasks.set(id, next);
        this.persistUpsert(next);
      }
    } catch (error) {
      const after = this.tasks.get(id);
      if (after) {
        const next = this.advanceSchedule(after, error);
        this.tasks.set(id, next);
        this.persistUpsert(next);
      }
    } finally {
      this.runningIds.delete(id);

      // Finalize the persisted run entry (best-effort).
      if (runId && this.persistence) {
        const after = this.tasks.get(id);
        const last = after?.history?.[after.history.length - 1];
        const status: "completed" | "error" =
          last?.status === "error" ? "error" : "completed";
        const durationMs =
          last?.durationMs ??
          (Number.isNaN(Date.parse(startedAt))
            ? undefined
            : Date.now() - Date.parse(startedAt));
        this.enqueuePersist(() =>
          this.persistence!.finalizeRun(
            id,
            runId,
            status,
            durationMs,
            last?.error
          )
        ).catch((error) =>
          console.warn("[scheduledTasks] Failed to finalize task run:", error)
        );
      }

      this.notify();
    }
  };

  /** Runs the task's pre-script and parses its decision. */
  private evaluatePreScript = async (
    task: ScheduledTaskRecord
  ): Promise<PreScriptDecision> => {
    const runner = this.scriptRunner;
    if (!runner) {
      throw new Error("No script runner registered (pre-script unavailable)");
    }
    const result = await runner(task.preScript ?? "", {
      timeoutMs: task.preScriptTimeoutMs ?? PRE_SCRIPT_DEFAULT_TIMEOUT_MS,
      env: this.buildScriptEnv(task),
    });
    return parsePreScriptResult(result);
  };

  /** Builds the environment variables exposed to the pre-script. */
  private buildScriptEnv = (
    task: ScheduledTaskRecord
  ): Record<string, string> => {
    return {
      SNOW_TASK_NAME: task.name,
      SNOW_TASK_PROMPT: task.prompt,
      SNOW_RUN_COUNT: String(task.runCount),
      SNOW_SKIP_COUNT: String(task.skipCount),
      SNOW_LAST_RUN_AT: task.lastRunAt ?? "",
      SNOW_LAST_SKIP_REASON: task.lastSkipReason ?? "",
    };
  };

  /** Records a skipped run into app logs (script output preserved). */
  private logSkip = (
    task: ScheduledTaskRecord,
    decision: Extract<PreScriptDecision, { action: "skip" }>
  ): void => {
    this.writeTaskLog(task, {
      message: `Pre-script skipped the AI Loop for scheduled task "${task.name}"`,
      output: decision.output ?? "",
      context: decision.reason,
    });
  };

  /** Records a script failure into app logs. */
  private logScriptError = (
    task: ScheduledTaskRecord,
    decision: Extract<PreScriptDecision, { action: "error" }>
  ): void => {
    this.writeTaskLog(task, {
      message: `Pre-script failed for scheduled task "${task.name}": ${decision.errorMessage}`,
      context: decision.errorMessage,
    });
  };

  /** Best-effort app log write (window.snow.writeLog -> Rust app_logs). */
  private writeTaskLog = (
    task: ScheduledTaskRecord,
    entry: { message: string; output?: string; context?: string }
  ): void => {
    try {
      const writeLog = (window as unknown as {
        snow?: { writeLog?: (level: string, entry: unknown) => Promise<void> };
      })?.snow?.writeLog;
      if (!writeLog) return;
      void writeLog("INFO", {
        module: "scheduled-task",
        func: task.name,
        message: entry.message,
        input: task.preScript,
        output: entry.output,
        context: entry.context,
      });
    } catch {
      // Logging failures must never break the scheduler.
    }
  };

  /** Computes the next record state after a run (success, error or skip). */
  private advanceSchedule = (
    task: ScheduledTaskRecord,
    error?: unknown,
    skip?: Extract<PreScriptDecision, { action: "skip" }>
  ): ScheduledTaskRecord => {
    const now = new Date().toISOString();

    // skip: the AI Loop did not run; once-tasks are finished, recurring ones
    // advance to the next occurrence. runCount is NOT incremented.
    if (skip) {
      const skipCount = task.skipCount + 1;
      // Finalize the in-progress history entry appended by execute(): the
      // pre-script ran to completion and decided to skip — the entry is marked
      // completed (not an error) with elapsed time, so the UI never shows a
      // dangling "running" row and the persisted run row finalizes correctly.
      const history = [...(task.history ?? [])];
      const last = history[history.length - 1];
      if (last && last.status === "running") {
        const startedMs = Date.parse(last.runAt);
        history[history.length - 1] = {
          ...last,
          status: "completed",
          durationMs: Number.isNaN(startedMs) ? undefined : Date.now() - startedMs,
          error: undefined,
        };
      }
      if (task.schedule.type === "once") {
        return {
          ...task,
          status: "completed",
          skipCount,
          lastSkippedAt: now,
          lastSkipReason: skip.reason,
          lastError: undefined,
          nextRunAt: undefined,
          updatedAt: now,
          history,
        };
      }
      const nextRunMs = computeNextRunMs(task.schedule, Date.now());
      return {
        ...task,
        status: "pending",
        skipCount,
        lastSkippedAt: now,
        lastSkipReason: skip.reason,
        lastError: undefined,
        nextRunAt:
          nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
        updatedAt: now,
        history,
      };
    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "Unknown error";

    const runCount = task.runCount + 1;
    const lastRunAt = now;

    // Finalize the in-progress history entry appended by execute(): running →
    // completed / error, with elapsed time and error message.
    const history = [...(task.history ?? [])];
    const last = history[history.length - 1];
    if (last && last.status === "running") {
      const startedMs = Date.parse(last.runAt);
      history[history.length - 1] = {
        ...last,
        status: error ? "error" : "completed",
        durationMs: Number.isNaN(startedMs) ? undefined : Date.now() - startedMs,
        error: error ? errorMessage : undefined,
      };
    }

    // once-task: after firing it's done regardless of success
    if (task.schedule.type === "once") {
      return {
        ...task,
        status: error ? "error" : "completed",
        runCount,
        lastRunAt,
        lastError: error ? errorMessage : undefined,
        nextRunAt: undefined,
        updatedAt: lastRunAt,
        history,
      };
    }

    // recurring: schedule next run even on error (so transient failures recover)
    const nextRunMs = computeNextRunMs(task.schedule, Date.now());
    return {
      ...task,
      status: "pending",
      runCount,
      lastRunAt,
      lastError: error ? errorMessage : undefined,
      nextRunAt:
        nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
      updatedAt: lastRunAt,
      history,
    };
  };

  /** Manually trigger a task run now (UI "Run now" button). */
  runNow = (id: string): Promise<void> => {
    return this.execute(id);
  };

  /** Runs `op` after every previously enqueued persistence write, keeping DB
   *  commit order identical to mutation order. Returns the op's promise so
   *  callers that need durability (createAndAwait, run finalization) can await
   *  it; a failed write never blocks later ones. */
  private enqueuePersist = <T>(op: () => Promise<T>): Promise<T> => {
    const run = this.persistQueue.then(op, op);
    this.persistQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  /** Writes the task row back to SQLite (best-effort, never blocks). */
  private persistUpsert = (record: ScheduledTaskRecord): void => {
    if (!this.persistence) return;
    this.enqueuePersist(() => this.persistence!.upsert(toWire(record))).catch(
      (error) => {
        console.warn("[scheduledTasks] Failed to persist task:", error);
      }
    );
  };
}

/** Applies "missed runs are skipped" semantics to a task loaded from the
 *  database after a restart. Returns the reconciled task and whether anything
 *  changed (changed tasks are written back). */
export const reconcileAfterRestart = (
  record: ScheduledTaskRecord,
  now: number
): { task: ScheduledTaskRecord; changed: boolean } => {
  let task = record;
  let changed = false;

  // A run interrupted by the previous shutdown: reset the task itself and
  // mark the dangling in-flight history entry as errored.
  if (task.status === "running") {
    task = { ...task, status: "pending" };
    changed = true;
  }
  const history = [...(task.history ?? [])];
  const last = history[history.length - 1];
  if (last && last.status === "running") {
    history[history.length - 1] = {
      ...last,
      status: "error",
      error: "Interrupted by app shutdown",
    };
    task = { ...task, history };
    changed = true;
  }

  // Expired schedules: once-tasks are done (they never fire again); recurring
  // tasks advance to the next plan point.
  if (!task.paused && task.nextRunAt) {
    const nextMs = Date.parse(task.nextRunAt);
    if (!Number.isNaN(nextMs) && nextMs <= now) {
      if (task.schedule.type === "once") {
        task = { ...task, status: "completed", nextRunAt: undefined };
      } else {
        const next = computeNextRunMs(task.schedule, now);
        task = {
          ...task,
          status: "pending",
          nextRunAt:
            next != null ? new Date(next).toISOString() : undefined,
        };
      }
      changed = true;
    }
  }

  return { task, changed };
};

/**
 * Process-wide singleton. The store is module-level and owns the timers; we
 * expose a single instance to both the React hook layer and the app-control
 * bridge. Hydration starts immediately so persisted tasks appear as soon as
 * the UI subscribes.
 */
export const scheduledTasksStore = new ScheduledTasksStore();

void scheduledTasksStore.ensureHydrated();
