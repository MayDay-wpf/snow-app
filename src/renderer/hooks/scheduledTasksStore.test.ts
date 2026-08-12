import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledTaskRunOptions } from "../../preload";
import { scheduledTasksStore, validateSchedule } from "./scheduledTasksStore";

test("scheduled task creation and execution preserve basicModel", async (t) => {
  scheduledTasksStore.clear();
  let receivedOptions: ScheduledTaskRunOptions | undefined;
  const unregister = scheduledTasksStore.setExecutor(
    (_prompt, _taskName, _directoryId, options) => {
      receivedOptions = { ...options };
    }
  );
  t.after(() => {
    unregister();
    scheduledTasksStore.clear();
  });

  const schedule = {
    type: "once" as const,
    executeAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const task = scheduledTasksStore.create({
    name: "Title snapshot",
    prompt: "Run the task",
    schedule,
    basicModel: " title-basic ",
  });
  const blankTask = scheduledTasksStore.create({
    name: "Blank title snapshot",
    prompt: "Run without a snapshot",
    schedule,
    basicModel: "   ",
  });

  assert.equal(task.basicModel, "title-basic");
  assert.equal(blankTask.basicModel, undefined);

  await scheduledTasksStore.runNow(task.id);

  assert.ok(receivedOptions);
  assert.equal(receivedOptions.basicModel, "title-basic");
});

test("scheduled task update changes only run-configuration overrides", (t) => {
  scheduledTasksStore.clear();
  t.after(() => {
    scheduledTasksStore.clear();
  });

  const schedule = {
    type: "recurring" as const,
    mode: "daily" as const,
    hour: 9,
    minute: 0,
  };
  const task = scheduledTasksStore.create({
    name: "Update me",
    prompt: "Run the task",
    schedule,
    apiProfile: "profile-a",
    basicModel: "basic-a",
    model: "model-a",
    thinkingStrength: "low",
  });

  const updated = scheduledTasksStore.update(task.id, {
    apiProfile: " profile-b ",
    basicModel: "",
    model: "model-b",
    thinkingStrength: " ",
  });

  assert.ok(updated);
  assert.equal(updated.id, task.id);
  // 覆盖字段更新；空值/空白清除覆盖（回到继承语义）
  assert.equal(updated.apiProfile, "profile-b");
  assert.equal(updated.basicModel, undefined);
  assert.equal(updated.model, "model-b");
  assert.equal(updated.thinkingStrength, undefined);
  // 其余字段保持不变
  assert.equal(updated.name, "Update me");
  assert.equal(updated.prompt, "Run the task");
  assert.equal(updated.schedule, schedule);
  assert.equal(updated.status, "pending");
  assert.equal(updated.paused, false);
  assert.equal(updated.runCount, 0);
  assert.equal(updated.directoryId, "");
});

test("scheduled task update returns null for unknown id", (t) => {
  scheduledTasksStore.clear();
  t.after(() => {
    scheduledTasksStore.clear();
  });

  const result = scheduledTasksStore.update("does-not-exist", {
    model: "model-x",
  });
  assert.equal(result, null);
});

test("scheduled task update feeds the executor with new overrides", async (t) => {
  scheduledTasksStore.clear();
  let receivedOptions: ScheduledTaskRunOptions | undefined;
  const unregister = scheduledTasksStore.setExecutor(
    (_prompt, _taskName, _directoryId, options) => {
      receivedOptions = { ...options };
    }
  );
  t.after(() => {
    unregister();
    scheduledTasksStore.clear();
  });

  const schedule = {
    type: "once" as const,
    executeAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const task = scheduledTasksStore.create({
    name: "Config switch",
    prompt: "Run the task",
    schedule,
    apiProfile: "profile-a",
    model: "model-a",
  });

  scheduledTasksStore.update(task.id, {
    apiProfile: "profile-b",
    model: "model-b",
    thinkingStrength: "high",
  });

  await scheduledTasksStore.runNow(task.id);

  assert.ok(receivedOptions);
  assert.equal(receivedOptions.apiProfile, "profile-b");
  assert.equal(receivedOptions.model, "model-b");
  assert.equal(receivedOptions.thinkingStrength, "high");
});

test("scheduled task update keeps runOnScriptError boolean without preScript", (t) => {
  scheduledTasksStore.clear();
  t.after(() => {
    scheduledTasksStore.clear();
  });

  const task = scheduledTasksStore.create({
    name: "No script",
    prompt: "Run the task",
    schedule: {
      type: "once" as const,
      executeAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  // Regression: runOnScriptError must stay a boolean (the DB column is
  // NOT NULL); an undefined value used to fail the whole SQLite upsert.
  const updated = scheduledTasksStore.update(task.id, { model: "model-x" });
  assert.ok(updated);
  assert.equal(updated.runOnScriptError, false);

  const cleared = scheduledTasksStore.update(task.id, {
    model: "model-y",
    preScript: "",
  });
  assert.ok(cleared);
  assert.equal(cleared.runOnScriptError, false);
  assert.equal(cleared.preScript, undefined);
});

test("scheduled task create is idempotent when the same id is reused", (t) => {
  scheduledTasksStore.clear();
  t.after(() => {
    scheduledTasksStore.clear();
  });

  const input = {
    id: "stable-id",
    name: "Idempotent",
    prompt: "Run the task",
    schedule: {
      type: "once" as const,
      executeAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const first = scheduledTasksStore.create(input);
  const second = scheduledTasksStore.create(input);

  assert.equal(first.id, "stable-id");
  assert.equal(second.id, first.id);
  assert.equal(scheduledTasksStore.list().length, 1);
});

test("validateSchedule rejects fractional and oversized intervals", () => {
  assert.throws(
    () =>
      validateSchedule({
        type: "recurring",
        mode: "interval",
        intervalMs: 60_000.5,
      }),
    /integer/
  );
  assert.throws(
    () =>
      validateSchedule({
        type: "recurring",
        mode: "interval",
        intervalMs: 366 * 24 * 60 * 60 * 1000 + 1,
      }),
    /366 days/
  );
  assert.throws(
    () =>
      validateSchedule({
        type: "recurring",
        mode: "interval",
        intervalMs: 59_000,
      }),
    /1 minute/
  );
});
