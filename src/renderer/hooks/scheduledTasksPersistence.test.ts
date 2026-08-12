import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledTaskRecord } from "../../preload";
import type { ScheduledTaskWireRecord } from "../../preload/modules/scheduledTaskApi";
import {
  ScheduledTasksStore,
  fromWire,
  reconcileAfterRestart,
  toWire,
} from "./scheduledTasksStore";

/** Minimal wire record with a far-future once schedule. */
const makeWire = (
  overrides: Partial<ScheduledTaskWireRecord> = {}
): ScheduledTaskWireRecord => ({
  id: "t1",
  directoryId: "",
  name: "Task",
  prompt: "prompt",
  scheduleJson: JSON.stringify({
    type: "once",
    executeAt: "2099-01-01T00:00:00.000Z",
  }),
  status: "pending",
  paused: false,
  runCount: 0,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  history: [],
  ...overrides,
});

/** Installs a fake preload bridge on `window` and restores it afterwards. */
const withFakeBridge = async <T>(
  api: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = { snow: api };
  try {
    return await fn();
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
};

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

test("reconcileAfterRestart marks an expired once-task completed", () => {
  const base = fromWire(
    makeWire({ nextRunAt: "2020-01-01T00:00:00.000Z" })
  )!;
  const { task, changed } = reconcileAfterRestart(base, Date.now());

  assert.equal(changed, true);
  assert.equal(task.status, "completed");
  assert.equal(task.nextRunAt, undefined);
});

test("reconcileAfterRestart advances an expired recurring task to the next plan point", () => {
  const scheduleJson = JSON.stringify({
    type: "recurring",
    mode: "daily",
    hour: 9,
    minute: 0,
  });
  const base = fromWire(
    makeWire({ scheduleJson, nextRunAt: "2020-01-01T00:00:00.000Z" })
  )!;
  // Local-time 10:00 on Aug 9, 2026 → next daily fire is Aug 10 09:00 local.
  const now = new Date(2026, 7, 9, 10, 0, 0).getTime();
  const { task, changed } = reconcileAfterRestart(base, now);

  assert.equal(changed, true);
  assert.equal(task.status, "pending");
  assert.equal(task.nextRunAt, new Date(2026, 7, 10, 9, 0, 0).toISOString());
});

test("reconcileAfterRestart resets an interrupted running task and marks its dangling history entry errored", () => {
  const base = fromWire(
    makeWire({
      status: "running",
      nextRunAt: "2099-01-01T00:00:00.000Z",
      history: [{ runAt: "2026-08-09T01:00:00.000Z", status: "running" }],
    })
  )!;
  const { task, changed } = reconcileAfterRestart(base, Date.now());

  assert.equal(changed, true);
  assert.equal(task.status, "pending");
  assert.equal(task.history?.[0].status, "error");
  assert.equal(task.history?.[0].error, "Interrupted by app shutdown");
});

test("reconcileAfterRestart leaves a paused task untouched even when expired", () => {
  const base = fromWire(
    makeWire({ paused: true, nextRunAt: "2020-01-01T00:00:00.000Z" })
  )!;
  const { task, changed } = reconcileAfterRestart(base, Date.now());

  assert.equal(changed, false);
  assert.equal(task.nextRunAt, "2020-01-01T00:00:00.000Z");
});

test("toWire/fromWire round-trip preserves the schedule and strips history", () => {
  const record: ScheduledTaskRecord = {
    id: "t9",
    directoryId: "proj-a",
    name: "Round trip",
    prompt: "Run it",
    schedule: { type: "recurring", mode: "interval", intervalMs: 600000 },
    status: "pending",
    paused: false,
    skipCount: 0,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    nextRunAt: "2026-08-09T00:10:00.000Z",
    runCount: 3,
    apiProfile: "profile-x",
    basicModel: "basic-x",
    model: "model-x",
    thinkingStrength: "high",
    preScript: "git diff --quiet || exit 1",
    preScriptTimeoutMs: 120000,
    runOnScriptError: true,
    lastRunAt: "2026-08-08T10:00:00.000Z",
    lastError: undefined,
    history: [
      { runAt: "2026-08-08T10:00:00.000Z", status: "completed", durationMs: 100 },
    ],
  };

  const wire = toWire(record);
  assert.equal(wire.scheduleJson, JSON.stringify(record.schedule));
  assert.equal(wire.apiProfile, "profile-x");
  assert.equal(wire.runCount, 3);
  // pre-script config and skip state are persisted alongside the task
  assert.equal(wire.preScript, "git diff --quiet || exit 1");
  assert.equal(wire.preScriptTimeoutMs, 120000);
  assert.equal(wire.runOnScriptError, true);
  // history lives in the separate runs table — excluded from the write shape
  assert.ok(!("history" in wire));

  const back = fromWire(wire)!;
  assert.deepEqual(back.schedule, record.schedule);
  assert.equal(back.id, "t9");
  assert.equal(back.directoryId, "proj-a");
  assert.equal(back.preScript, "git diff --quiet || exit 1");
  assert.equal(back.preScriptTimeoutMs, 120000);
  assert.equal(back.runOnScriptError, true);
  assert.equal(back.history?.length, 0);
});

test("fromWire skips tasks with unreadable schedule JSON", () => {
  const wire = makeWire({ scheduleJson: "{not-json" });
  assert.equal(fromWire(wire), null);
});

test("store hydrates persisted tasks and reconciles expired ones", async () => {
  const upserted: Array<{ id: string; status: string }> = [];
  const calls: string[] = [];
  const fakeApi = {
    reconcileScheduledTaskRuns: async (): Promise<number> => {
      calls.push("reconcile");
      return 0;
    },
    listScheduledTasks: async (): Promise<ScheduledTaskWireRecord[]> => {
      calls.push("list");
      return [
        makeWire({ id: "a", nextRunAt: "2099-01-01T00:00:00.000Z" }),
        makeWire({
          id: "b",
          scheduleJson: JSON.stringify({
            type: "once",
            executeAt: "2020-01-01T00:00:00.000Z",
          }),
          nextRunAt: "2020-01-01T00:00:00.000Z",
        }),
      ];
    },
    upsertScheduledTask: async (input: {
      id: string;
      status: string;
    }): Promise<unknown> => {
      upserted.push({ id: input.id, status: input.status });
      return input;
    },
    deleteScheduledTask: async (): Promise<void> => undefined,
    clearScheduledTasks: async (): Promise<number> => 0,
    appendScheduledTaskRun: async (): Promise<string> => "run-1",
    finalizeScheduledTaskRun: async (): Promise<void> => undefined,
  };

  await withFakeBridge(fakeApi, async () => {
    const store = new ScheduledTasksStore();
    await store.ensureHydrated();
    await flush();

    const tasks = store.list();
    assert.equal(tasks.length, 2);
    const expired = tasks.find((task) => task.id === "b")!;
    assert.equal(expired.status, "completed");
    assert.equal(expired.nextRunAt, undefined);

    // The reconciliation write-back is persisted for the changed task only.
    assert.deepEqual(
      upserted.map((entry) => entry.id).sort(),
      ["b"]
    );
    // Zombie run rows are fixed up BEFORE the history snapshot is read.
    assert.deepEqual(calls, ["reconcile", "list"]);
  });
});

test("store writes create/remove mutations through the persistence adapter", async () => {
  const upserted: string[] = [];
  const deleted: string[] = [];
  const fakeApi = {
    reconcileScheduledTaskRuns: async (): Promise<number> => 0,
    listScheduledTasks: async (): Promise<ScheduledTaskWireRecord[]> => [],
    upsertScheduledTask: async (input: { id: string }): Promise<unknown> => {
      upserted.push(input.id);
      return input;
    },
    deleteScheduledTask: async (taskId: string): Promise<void> => {
      deleted.push(taskId);
    },
    clearScheduledTasks: async (): Promise<number> => 0,
    appendScheduledTaskRun: async (): Promise<string> => "run-1",
    finalizeScheduledTaskRun: async (): Promise<void> => undefined,
  };

  await withFakeBridge(fakeApi, async () => {
    const store = new ScheduledTasksStore();
    await store.ensureHydrated();

    const task = store.create({
      name: "Persist me",
      prompt: "Run it",
      schedule: {
        type: "once",
        executeAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await flush();
    assert.ok(upserted.includes(task.id));

    store.remove(task.id);
    await flush();
    assert.ok(deleted.includes(task.id));
  });
});

test("remove issued during pending hydration is not resurrected", async () => {
  const deleted: string[] = [];
  let resolveList!: (rows: ScheduledTaskWireRecord[]) => void;
  const listPromise = new Promise<ScheduledTaskWireRecord[]>((resolve) => {
    resolveList = resolve;
  });
  const fakeApi = {
    reconcileScheduledTaskRuns: async (): Promise<number> => 0,
    listScheduledTasks: (): Promise<ScheduledTaskWireRecord[]> => listPromise,
    upsertScheduledTask: async (input: unknown): Promise<unknown> => input,
    deleteScheduledTask: async (taskId: string): Promise<void> => {
      deleted.push(taskId);
    },
    clearScheduledTasks: async (): Promise<number> => 0,
    appendScheduledTaskRun: async (): Promise<string> => "run-1",
    finalizeScheduledTaskRun: async (): Promise<void> => undefined,
  };

  await withFakeBridge(fakeApi, async () => {
    const store = new ScheduledTasksStore();
    const hydration = store.ensureHydrated();
    // Hydration is still waiting on the list snapshot...
    store.remove("doomed");
    resolveList([makeWire({ id: "doomed" })]);
    await hydration;
    await flush();

    // The tombstone drops the row instead of resurrecting it...
    assert.equal(store.list().length, 0);
    // ...and the DB delete was issued regardless.
    assert.ok(deleted.includes("doomed"));
  });
});

test("createAndAwait is idempotent for the same id and persists once", async () => {
  const upserted: string[] = [];
  const fakeApi = {
    reconcileScheduledTaskRuns: async (): Promise<number> => 0,
    listScheduledTasks: async (): Promise<ScheduledTaskWireRecord[]> => [],
    upsertScheduledTask: async (input: { id: string }): Promise<unknown> => {
      upserted.push(input.id);
      return input;
    },
    deleteScheduledTask: async (): Promise<void> => undefined,
    clearScheduledTasks: async (): Promise<number> => 0,
    appendScheduledTaskRun: async (): Promise<string> => "run-1",
    finalizeScheduledTaskRun: async (): Promise<void> => undefined,
  };

  await withFakeBridge(fakeApi, async () => {
    const store = new ScheduledTasksStore();
    const input = {
      id: "idem-1",
      name: "Idempotent",
      prompt: "Run it",
      schedule: {
        type: "once" as const,
        executeAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const first = await store.createAndAwait(input);
    const second = await store.createAndAwait(input);

    assert.equal(first.id, second.id);
    assert.equal(store.list().length, 1);
    assert.equal(upserted.length, 1);
  });
});

test("createAndAwait rolls back and rethrows when persistence fails", async () => {
  const fakeApi = {
    reconcileScheduledTaskRuns: async (): Promise<number> => 0,
    listScheduledTasks: async (): Promise<ScheduledTaskWireRecord[]> => [],
    upsertScheduledTask: async (): Promise<never> => {
      throw new Error("disk full");
    },
    deleteScheduledTask: async (): Promise<void> => undefined,
    clearScheduledTasks: async (): Promise<number> => 0,
    appendScheduledTaskRun: async (): Promise<string> => "run-1",
    finalizeScheduledTaskRun: async (): Promise<void> => undefined,
  };

  await withFakeBridge(fakeApi, async () => {
    const store = new ScheduledTasksStore();
    await assert.rejects(
      store.createAndAwait({
        name: "Doomed",
        prompt: "Run it",
        schedule: {
          type: "once",
          executeAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
      /disk full/
    );
    // The in-memory task is rolled back so a retry cannot duplicate it.
    assert.equal(store.list().length, 0);
  });
});

test("hydration retries transient failures with backoff", async () => {
  let listCalls = 0;
  const fakeApi = {
    reconcileScheduledTaskRuns: async (): Promise<number> => 0,
    listScheduledTasks: async (): Promise<ScheduledTaskWireRecord[]> => {
      listCalls += 1;
      if (listCalls < 2) {
        throw new Error("database is locked");
      }
      return [makeWire({ id: "later" })];
    },
    upsertScheduledTask: async (input: unknown): Promise<unknown> => input,
    deleteScheduledTask: async (): Promise<void> => undefined,
    clearScheduledTasks: async (): Promise<number> => 0,
    appendScheduledTaskRun: async (): Promise<string> => "run-1",
    finalizeScheduledTaskRun: async (): Promise<void> => undefined,
  };

  await withFakeBridge(fakeApi, async () => {
    const store = new ScheduledTasksStore();
    await store.ensureHydrated();
    assert.equal(listCalls, 2);
    assert.equal(store.list().length, 1);
  });
});

test("hydration starts the tick loop so persisted tasks can fire", async () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCalls = 0;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    intervalCalls += 1;
    return originalSetInterval(fn, ms);
  }) as typeof setInterval;
  try {
    const fakeApi = {
      reconcileScheduledTaskRuns: async (): Promise<number> => 0,
      listScheduledTasks: async (): Promise<ScheduledTaskWireRecord[]> => [
        makeWire({ id: "resumed", nextRunAt: "2099-01-01T00:00:00.000Z" }),
      ],
      upsertScheduledTask: async (input: unknown): Promise<unknown> => input,
      deleteScheduledTask: async (): Promise<void> => undefined,
      clearScheduledTasks: async (): Promise<number> => 0,
      appendScheduledTaskRun: async (): Promise<string> => "run-1",
      finalizeScheduledTaskRun: async (): Promise<void> => undefined,
    };

    await withFakeBridge(fakeApi, async () => {
      const store = new ScheduledTasksStore();
      await store.ensureHydrated();
      // Regression: without this, hydrated tasks never fire after a restart
      // because only create() used to start the coarse tick loop.
      assert.ok(intervalCalls >= 1);
      store.clear();
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});
