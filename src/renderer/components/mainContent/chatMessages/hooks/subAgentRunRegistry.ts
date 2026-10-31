import type {
  SubAgentCancelReceipt,
  SubAgentCancellationSource,
  SubAgentResultPage,
  SubAgentRunCommand,
  SubAgentRunCommandResult,
  SubAgentRunRecord,
  SubAgentRunScope,
} from "../../../../../shared/subAgentRuns";
import { isSubAgentTerminal } from "../../../../../shared/subAgentRuns";

/** The desktop host supplies the real IPC/storage implementation. */
export type SubAgentRunPersistence = {
  command(command: SubAgentRunCommand): Promise<SubAgentRunCommandResult>;
  onCommitted(run: SubAgentRunRecord): void;
};

type OwnedRun = {
  promise: Promise<string>;
  cancel: () => Promise<void>;
  stopPromise?: Promise<void>;
  /** A budget stop is not user cancellation, but its failure must block a clean drain. */
  resourceStop?: Promise<void>;
  finished: boolean;
  observer?: Promise<void>;
  error?: Error;
};

// Renderer-lifetime ownership, independent of the selected chat or React tree.
const ownedRuns = new Map<string, OwnedRun>();
const listeners = new Set<() => void>();
const settledCancel = (): Promise<void> => Promise.resolve();

export const subscribeSubAgentRunChanges = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** I forwards durable IPC invalidation here as well as local owner changes. */
export const notifySubAgentRunChanges = (): void => {
  for (const listener of listeners) listener();
};

export const hasOwnedSubAgentRun = (runId: string): boolean => {
  const owner = ownedRuns.get(runId);
  return Boolean(owner && !owner.finished);
};

const requireOwner = (runId: string): OwnedRun => {
  const owner = ownedRuns.get(runId);
  if (!owner)
    throw new Error(
      `OWNER_MISMATCH: no local execution owner for run ${runId}`,
    );
  return owner;
};

/** Retain a non-cancellation resource barrier even if a failed terminal outcome is committed. */
export const retainOwnedSubAgentResourceStop = (
  runId: string,
  stop: Promise<void>,
): void => {
  const owner = requireOwner(runId);
  const previous = owner.resourceStop;
  owner.resourceStop = Promise.allSettled([
    ...(previous ? [previous] : []),
    stop,
  ]).then((results) => {
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length) {
      const error = new AggregateError(
        failures,
        `RESOURCE_STOP_FAILED: run ${runId} resources did not stop cleanly`,
      );
      owner.error ??= error;
      throw error;
    }
  });
  // Observe rejection immediately, but keep the original rejecting barrier for every drain.
  void owner.resourceStop.catch(() => undefined);
};

const drainOwnedRun = async (runId: string, owner: OwnedRun): Promise<void> => {
  const errors = new Set<unknown>();
  let stopPromise: Promise<void> | undefined;
  let resourceStop: Promise<void> | undefined;
  do {
    stopPromise = owner.stopPromise;
    resourceStop = owner.resourceStop;
    const results = await Promise.allSettled([
      owner.promise,
      ...(stopPromise ? [stopPromise] : []),
      ...(resourceStop ? [resourceStop] : []),
    ]);
    for (const result of results)
      if (result.status === "rejected") errors.add(result.reason as unknown);
    // Include a newly installed cancellation or budget barrier without polling.
  } while (
    stopPromise !== owner.stopPromise ||
    resourceStop !== owner.resourceStop
  );
  if (errors.size) {
    const error = new AggregateError(
      [...errors],
      `PERSISTENCE_ERROR: run ${runId} did not drain cleanly`,
    );
    owner.error ??= error;
    throw error;
  }
  if (owner.error) throw owner.error;
};

/** Drain retained owners, including finished execution with a pending resource stop.
 * Returns false only when this renderer has never owned the run. Never cancels. */
export const drainOwnedSubAgentRun = async (
  runId: string,
): Promise<boolean> => {
  const owner = ownedRuns.get(runId);
  if (!owner) return false;
  await drainOwnedRun(runId, owner);
  return true;
};

export const cancelOwnedSubAgentRun = async (runId: string): Promise<void> => {
  const owner = requireOwner(runId);
  // Install before invoking cancellation so all callers share one resource stop.
  // A normally completed owner is not cancelled again, but an existing stop is drained.
  owner.stopPromise ??= Promise.allSettled([
    Promise.resolve().then(() => {
      if (!owner.finished) return owner.cancel();
    }),
    owner.promise,
  ]).then((results) => {
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length) {
      const error = new AggregateError(
        errors,
        `PERSISTENCE_ERROR: run ${runId} did not stop cleanly`,
      );
      owner.error ??= error;
      throw error;
    }
  });
  await drainOwnedRun(runId, owner);
};

/** Register BEFORE executing: even hydration/initialization failures have an owner. */
export const startOwnedSubAgentRun = (
  runId: string,
  execute: () => Promise<string>,
  cancel: () => Promise<void>,
): Promise<string> => {
  if (ownedRuns.has(runId))
    throw new Error(`RUN_BUSY: run ${runId} already has an owner`);
  const promise = Promise.resolve().then(execute);
  const owner: OwnedRun = { promise, cancel, finished: false };
  ownedRuns.set(runId, owner);
  // 终态后不会再调用 cancel：换成空实现，释放其闭包（运行状态、会话引用等）。
  const settle = (): void => {
    owner.finished = true;
    owner.cancel = settledCancel;
  };
  // This rejection observer is owned by the registry. The original promise
  // still rejects for sync callers, wait-for-delete and cancellation callers.
  owner.observer = promise
    .then(
      () => {
        settle();
        notifySubAgentRunChanges();
      },
      (error: unknown) => {
        owner.error = error instanceof Error ? error : new Error(String(error));
        settle();
        console.error("[sub-agent-run] owner failed", {
          runId,
          code: "SUB_AGENT_OWNER_FAILED",
          phase: "execution_or_settlement",
        });
        notifySubAgentRunChanges();
      },
    )
    .catch((error: unknown) => {
      owner.error ??= error instanceof Error ? error : new Error(String(error));
      console.error("[sub-agent-run] observer failed", {
        runId,
        code: "SUB_AGENT_NOTIFICATION_FAILED",
        phase: "local_invalidation",
      });
    });
  return promise;
};

export const getOwnedSubAgentRunResult = (runId: string): Promise<string> =>
  requireOwner(runId).promise;

export const readSubAgentRunResult = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  runId: string,
  offset?: number,
  limit?: number,
): Promise<SubAgentResultPage> => {
  const result = await persistence.command({
    op: "get",
    scope,
    runId,
    offset,
    limit,
  });
  if (result.kind !== "result")
    throw new Error("PERSISTENCE_ERROR: get returned an unexpected receipt");
  return result;
};

export const requestOwnedSubAgentRunCancel = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  runId: string,
  source?: SubAgentCancellationSource,
): Promise<SubAgentCancelReceipt> => {
  const result = await persistence.command({
    op: "cancel",
    scope,
    runId,
    source,
  });
  if (result.kind !== "cancel")
    throw new Error("PERSISTENCE_ERROR: cancel returned an unexpected receipt");
  notifySubAgentRunChanges();
  if (
    (result.disposition === "requested" ||
      result.disposition === "confirmed") &&
    hasOwnedSubAgentRun(runId)
  ) {
    await cancelOwnedSubAgentRun(runId);
    const current = await readSubAgentRunResult(persistence, scope, runId);
    return {
      ...result,
      disposition:
        current.run.status === "cancelled" ? "confirmed" : result.disposition,
      runStatus: current.run.status,
      cancellation: current.run.cancellation,
    };
  }
  return result;
};

export const waitForSubAgentRuns = async (
  persistence: SubAgentRunPersistence,
  scope: SubAgentRunScope,
  runIds: string[],
  mode: "any" | "all" = "any",
  timeoutMs = 30000,
): Promise<{ timedOut: boolean; results: SubAgentResultPage[] }> => {
  if (
    !runIds.length ||
    runIds.length > 32 ||
    new Set(runIds).size !== runIds.length ||
    runIds.some((id) => !id.trim())
  ) {
    throw new Error(
      "VALIDATION_ERROR: runIds must contain 1..32 unique non-empty IDs",
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) {
    throw new Error(
      "VALIDATION_ERROR: timeoutMs must be an integer in 0..120000",
    );
  }
  const deadline = Date.now() + timeoutMs;
  const readAll = () =>
    Promise.all(
      runIds.map((runId) => readSubAgentRunResult(persistence, scope, runId)),
    );
  // Validate the entire scope/ID set before early any-success or subscribing.
  let results = await readAll();
  let revision = 0;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribeSubAgentRunChanges(() => {
    revision += 1;
    wake?.();
  });
  try {
    while (true) {
      const beforeRead = revision;
      // Check-subscribe-recheck closes the lost completion window.
      results = await readAll();
      const terminal = results.map((result) =>
        isSubAgentTerminal(result.run.status),
      );
      const satisfied =
        mode === "all" ? terminal.every(Boolean) : terminal.some(Boolean);
      if (satisfied || Date.now() >= deadline) {
        return {
          timedOut: !satisfied,
          results,
        };
      }
      if (revision !== beforeRead) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        if (revision !== beforeRead) resolve();
      });
      wake = undefined;
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  }
};
