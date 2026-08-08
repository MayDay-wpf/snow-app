import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostKeys = vi.hoisted(() => new Map<string, string>());

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => process.cwd(), isPackaged: false },
  net: { fetch: globalThis.fetch },
}));

vi.mock("./sshCredentials", () => ({
  getSshCredential: () => ({
    authMethod: "password",
    encryptedSecret: "test-only",
  }),
  getDecryptedSecret: () => "snow-test-password",
}));

vi.mock("./sshHostKeys", () => ({
  getSshHostKey: (host: string, port: number) => {
    const fingerprint = hostKeys.get(`${host}:${port}`);
    return fingerprint
      ? { host, port, fingerprint, trustedAt: "2026-01-01T00:00:00.000Z" }
      : null;
  },
  saveSshHostKey: (params: {
    host: string;
    port: number;
    fingerprint: string;
  }) => {
    hostKeys.set(`${params.host}:${params.port}`, params.fingerprint);
    return { ...params, trustedAt: "2026-01-01T00:00:00.000Z" };
  },
}));

import {
  connectSsh,
  disconnectAllSsh,
  disconnectSsh,
  executeSshCommand,
  getSshSession,
  probeSshCapabilities,
  readSshFileWithVersion,
  writeSshFile,
} from "./sshManager";
import {
  cancelRemoteJob,
  cleanupRemoteJobs,
  getRemoteJob,
  getRemoteJobAttachSpec,
  getRemoteJobAnalysisContext,
  getRemoteJobBackendsForTesting,
  RemoteJobLaunchRejectedError,
  startRemoteJob,
  type RemoteJobBackendKind,
  type RemoteJobOutput,
  type RemoteJobStartRequest,
} from "./remoteJobs";

const enabled = process.env.SNOW_SSH_TEST === "1";
const host = process.env.SNOW_SSH_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.SNOW_SSH_TEST_PORT ?? "0");
const fixture = process.env.SNOW_SSH_TEST_FIXTURE ?? "full";
const unavailableFixtures = new Set(["noexec", "sftp-disabled", "permit-tty-no"]);
const durableOpenSsh =
  enabled && !unavailableFixtures.has(fixture) ? describe : describe.skip;
const unavailableOpenSsh =
  enabled && unavailableFixtures.has(fixture) ? describe : describe.skip;
const originalBindingsDir = process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
let bindingsDirectory = "";

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const workspacePath = (): string =>
  `ssh://snow@${host}:${port}/home/snow`;

const passwordParams = () => ({
  host,
  port,
  username: "snow",
  authMethod: "password" as const,
  password: "snow-test-password",
});

const clearRemoteJobDirectory = async (): Promise<void> => {
  const sessionId = await connectSsh(passwordParams());
  try {
    await executeSshCommand(
      sessionId,
      [
        'jobs_root="/home/snow/.local/state/snow-app/jobs"',
        "for attempt in $(seq 1 50); do",
        '  rm -rf -- "$jobs_root"',
        '  if [ ! -e "$jobs_root" ]; then',
        "    sleep 0.1",
        '    if [ ! -e "$jobs_root" ]; then',
        "      mkdir -p -- /home/snow/workspace",
        "      exit 0",
        "    fi",
        "  fi",
        "  sleep 0.1",
        "done",
        'printf "Remote Job directory remained active: %s\\n" "$jobs_root" >&2',
        "exit 1",
      ].join("\n")
    );
  } finally {
    disconnectSsh(sessionId);
  }
};

const waitFor = async (
  jobId: string,
  predicate: (result: RemoteJobOutput) => boolean,
  timeoutMs = 12_000
): Promise<RemoteJobOutput> => {
  const deadline = Date.now() + timeoutMs;
  let last: RemoteJobOutput | null = null;
  while (Date.now() < deadline) {
    last = await getRemoteJob(jobId, { offset: 0, limit: 64 * 1024 });
    if (predicate(last)) {
      return last;
    }
    await wait(200);
  }
  throw new Error(
    `Remote Job ${jobId} did not reach the expected state: ${JSON.stringify(last?.state)}`
  );
};

const isTerminal = (status: string): boolean =>
  [
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "launch_failed",
    "indeterminate",
  ].includes(status);

const openRemoteJobPty = async (jobId: string) => {
  const spec = await getRemoteJobAttachSpec(jobId);
  const sessionId = await connectSsh(passwordParams());
  const session = getSshSession(sessionId);
  if (!session) {
    throw new Error("SSH session was not retained for PTY attach");
  }
  const channel = await new Promise<import("ssh2").ClientChannel>((resolve, reject) => {
    session.client.exec(spec.remoteCommand, { pty: true }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
  return { sessionId, channel };
};

const waitForPtyOutput = (
  channel: import("ssh2").ClientChannel,
  text: string,
  timeoutMs = 8_000
): Promise<void> =>
  new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`PTY did not produce ${text}: ${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      channel.off("data", onData);
      channel.off("error", onError);
    };
    channel.on("data", onData);
    channel.on("error", onError);
  });

durableOpenSsh("Durable Remote Job OpenSSH fault injection", () => {
  beforeEach(async () => {
    expect(port).toBeGreaterThan(0);
    bindingsDirectory = mkdtempSync(join(tmpdir(), "snow-remote-jobs-test-"));
    process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = bindingsDirectory;
    await clearRemoteJobDirectory();
  });

  afterEach(async () => {
    disconnectAllSsh();
    hostKeys.clear();
    if (bindingsDirectory) {
      rmSync(bindingsDirectory, { recursive: true, force: true });
      bindingsDirectory = "";
    }
    await clearRemoteJobDirectory();
  });

  afterAll(() => {
    if (originalBindingsDir === undefined) {
      delete process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
    } else {
      process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = originalBindingsDir;
    }
  });

  const backends =
    fixture === "full"
      ? (["posix-detach", "tmux"] as const)
      : fixture === "systemd-user"
        ? (["systemd-user"] as const)
        : (["posix-detach"] as const);
  for (const backend of backends) {
    it(`${backend} survives SSH disconnection, is idempotent, and restores a deleted Binding`, async () => {
      const jobId = randomUUID();
      const executionsPath = `/home/snow/${jobId}.executions`;
      const request: RemoteJobStartRequest = {
        workspacePath: workspacePath(),
        command: [
          "printf 'started\\n'",
          "sleep 2",
          "printf 'finished\\n'",
          `printf 1 >> ${executionsPath}`,
        ].join("; "),
        timeoutMs: 10_000,
        jobId,
        backend: backend as RemoteJobBackendKind,
      };

      // startRemoteJob closes its launch SSH session before this wait. A later
      // connection observes that the remote runner completed independently.
      const accepted = await startRemoteJob(request);
      const retry = await startRemoteJob(request);
      expect(retry.jobId).toBe(jobId);
      expect(retry.createdAt).toBe(accepted.createdAt);

      const completed = await waitFor(jobId, (result) =>
        isTerminal(result.state.status)
      );
      expect(completed.state.status).toBe("succeeded");
      expect(completed.output).toContain("started");
      expect(completed.output).toContain("finished");

      const sessionId = await connectSsh(passwordParams());
      try {
        await expect(
          executeSshCommand(sessionId, `cat -- ${executionsPath}`)
        ).resolves.toBe("1");
      } finally {
        disconnectSsh(sessionId);
      }

      const bindingsPath = join(bindingsDirectory, "bindings.json");
      expect(existsSync(bindingsPath)).toBe(true);
      rmSync(bindingsPath);
      const restored = await startRemoteJob(request);
      expect(restored.jobId).toBe(jobId);
      expect(restored.status).toBe("succeeded");
      await expect(getRemoteJob(jobId, { offset: 0 })).resolves.toMatchObject({
        state: { status: "succeeded" },
        output: expect.stringContaining("finished"),
      });
    }, 30_000);
  }

  it("reclaims an orphaned state lock before the runner records completion", async () => {
    const jobId = randomUUID();
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: "sleep 1; printf 'lock-recovered\\n'",
      timeoutMs: 10_000,
      jobId,
      backend: "posix-detach",
    });
    await waitFor(jobId, (result) => result.state.status === "running");

    const sessionId = await connectSsh(passwordParams());
    try {
      const lockPath = `/home/snow/.local/state/snow-app/jobs/${jobId}/state.lock`;
      await executeSshCommand(
        sessionId,
        [
          `mkdir -- ${lockPath}`,
          `printf 'interrupted-client\\n99999999\\n1\\n' > ${lockPath}/owner`,
        ].join("\n")
      );
    } finally {
      disconnectSsh(sessionId);
    }

    await expect(
      waitFor(jobId, (result) => result.state.status === "succeeded", 15_000)
    ).resolves.toMatchObject({
      state: { status: "succeeded" },
      output: expect.stringContaining("lock-recovered"),
    });

    const verificationSession = await connectSsh(passwordParams());
    try {
      await expect(
        executeSshCommand(
          verificationSession,
          `test ! -e /home/snow/.local/state/snow-app/jobs/${jobId}/state.lock`
        )
      ).resolves.toBe("");
    } finally {
      disconnectSsh(verificationSession);
    }
  }, 30_000);

  it("creates and repairs the POSIX Job state root with mode 0700", async () => {
    const sessionId = await connectSsh(passwordParams());
    try {
      await executeSshCommand(
        sessionId,
        "mkdir -p -- /home/snow/.local/state/snow-app/jobs && chmod 755 -- /home/snow/.local/state/snow-app/jobs"
      );
    } finally {
      disconnectSsh(sessionId);
    }

    const jobId = randomUUID();
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: "true",
      timeoutMs: 10_000,
      jobId,
      backend: "posix-detach",
    });

    const verificationSession = await connectSsh(passwordParams());
    try {
      await expect(
        executeSshCommand(
          verificationSession,
          "stat -c %a -- /home/snow/.local/state/snow-app/jobs"
        )
      ).resolves.toBe("700\n");
      } finally {
        disconnectSsh(verificationSession);
      }
    await expect(
      waitFor(jobId, (result) => isTerminal(result.state.status))
    ).resolves.toMatchObject({ state: { status: "succeeded" } });
  }, 30_000);

  it("atomically replaces an existing file while retaining its basic POSIX mode", async () => {
    const remotePath = `/home/snow/${randomUUID()}.atomic-save`;
    const sessionId = await connectSsh(passwordParams());
    try {
      await executeSshCommand(
        sessionId,
        `printf 'before' > ${remotePath} && chmod 640 -- ${remotePath}`
      );
      const before = await executeSshCommand(
        sessionId,
        `stat -c '%i %a' -- ${remotePath}`
      );
      const loaded = await readSshFileWithVersion(sessionId, remotePath);

      await expect(
        writeSshFile(sessionId, remotePath, "after", {
          expectedVersion: loaded.version,
          workspaceRoot: "/home/snow",
        })
      ).resolves.toMatchObject({
        guarantee: "atomic_best_effort",
        durability: { posixRename: true },
      });

      await expect(
        executeSshCommand(sessionId, `cat -- ${remotePath}`)
      ).resolves.toBe("after");
      const after = await executeSshCommand(
        sessionId,
        `stat -c '%i %a' -- ${remotePath}`
      );
      const [beforeInode, beforeMode] = before.trim().split(" ");
      const [afterInode, afterMode] = after.trim().split(" ");
      expect(afterInode).not.toBe(beforeInode);
      expect(afterMode).toBe(beforeMode);
    } finally {
      await executeSshCommand(sessionId, `rm -f -- ${remotePath}`).catch(
        () => undefined
      );
      disconnectSsh(sessionId);
    }
  }, 30_000);

  it.skipIf(fixture !== "systemd-user")(
    "lets the runner record timed_out before systemd stops its unit",
    async () => {
      const jobId = randomUUID();
      await startRemoteJob({
        workspacePath: workspacePath(),
        command:
          'sh -c \'trap "" TERM; sleep 30 & child=$!; wait "$child"\'',
        timeoutMs: 1_000,
        jobId,
        backend: "systemd-user",
      });

      await expect(
        waitFor(jobId, (result) => result.state.status === "timed_out", 15_000)
      ).resolves.toMatchObject({
        state: { status: "timed_out", reason: "timeout" },
      });
    },
    30_000
  );

  it("keeps a submitted Job indeterminate when its launch acknowledgement is lost", async () => {
    const jobId = randomUUID();
    const request: RemoteJobStartRequest = {
      workspacePath: workspacePath(),
      command: "printf 'ack-started\\n'; sleep 5; printf 'ack-finished\\n'",
      timeoutMs: 10_000,
      jobId,
      backend: "posix-detach",
    };
    const backend = getRemoteJobBackendsForTesting()["posix-detach"];
    const launch = backend.launch;
    backend.launch = async (context) => {
      await launch(context);
      throw new Error("simulated SSH disconnect after launch submission");
    };
    try {
      const submitted = await startRemoteJob(request);
      expect(submitted.status).toBe("indeterminate");
    } finally {
      backend.launch = launch;
    }

    const result = await getRemoteJob(jobId, { offset: 0 });
    expect(result.state.status).toBe("indeterminate");
    expect(result.state.reason).toMatch(/acknowledgement was not confirmed/i);
  }, 30_000);

  it("records a confirmed backend rejection as launch_failed", async () => {
    const jobId = randomUUID();
    const backend = getRemoteJobBackendsForTesting()["posix-detach"];
    const launch = backend.launch;
    backend.launch = async () => {
      throw new RemoteJobLaunchRejectedError("test backend rejected launch");
    };
    try {
      const submitted = await startRemoteJob({
        workspacePath: workspacePath(),
        command: "printf should-not-run",
        timeoutMs: 10_000,
        jobId,
        backend: "posix-detach",
      });
      expect(submitted.status).toBe("launch_failed");
    } finally {
      backend.launch = launch;
    }

    await expect(getRemoteJob(jobId, { offset: 0 })).resolves.toMatchObject({
      state: { status: "launch_failed", reason: "test backend rejected launch" },
    });
  }, 30_000);

  it("recovers a running Job after the main-process module is reloaded", async () => {
    const jobId = randomUUID();
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: "printf 'restart-started\\n'; sleep 5; printf 'restart-finished\\n'",
      timeoutMs: 10_000,
      jobId,
      backend: "posix-detach",
    });
    await waitFor(jobId, (result) => result.state.status === "running");

    vi.resetModules();
    const restartedRemoteJobs = await import("./remoteJobs");
    const recovered = await restartedRemoteJobs.getRemoteJob(jobId, { offset: 0 });
    expect(recovered.state.status).toBe("running");
    expect(recovered.output).toContain("restart-started");
  }, 30_000);

  it.skipIf(fixture !== "no-tmux")(
    "keeps an interactive Snow Agent PTY alive across SSH controller disconnect",
    async () => {
      const jobId = randomUUID();
      await startRemoteJob({
        workspacePath: workspacePath(),
        command:
          "IFS= read first; printf 'first:%s\\n' \"$first\"; IFS= read second; printf 'second:%s\\n' \"$second\"",
        timeoutMs: 15_000,
        jobId,
        mode: "interactive",
      });
      await waitFor(jobId, (result) => result.state.status === "running", 15_000);

      const first = await openRemoteJobPty(jobId);
      const firstOutput = waitForPtyOutput(first.channel, "first:one");
      first.channel.write("one\n");
      await firstOutput;
      disconnectSsh(first.sessionId);

      await wait(250);
      const second = await openRemoteJobPty(jobId);
      const secondOutput = waitForPtyOutput(second.channel, "second:two");
      second.channel.write("two\n");
      await secondOutput;
      await new Promise<void>((resolve) => second.channel.once("close", () => resolve()));
      disconnectSsh(second.sessionId);

      await expect(
        waitFor(jobId, (result) => result.state.status === "succeeded", 15_000)
      ).resolves.toMatchObject({
        state: { status: "succeeded", mode: "interactive" },
        output: expect.stringContaining("first:one"),
      });
    },
    40_000
  );

  it("does not claim unavailable POSIX backends", async () => {
    const sessionId = await connectSsh(passwordParams());
    try {
      const capabilities = await probeSshCapabilities(sessionId);
      if (fixture === "systemd-user") {
        expect(capabilities.systemdUser).toBe(true);
        return;
      }
      if (fixture === "no-tmux") {
        expect(capabilities.tmux).toBe(false);
        await expect(
          startRemoteJob({
            workspacePath: workspacePath(),
            command: "printf should-not-launch",
            backend: "tmux",
            jobId: randomUUID(),
          })
        ).rejects.toThrow(/tmux is unavailable|failed disconnect verification/i);
      } else {
        expect(capabilities.tmux).toBe(true);
      }

      if (!capabilities.systemdUser) {
        await expect(
          startRemoteJob({
            workspacePath: workspacePath(),
            command: "printf should-not-launch",
            backend: "systemd-user",
            jobId: randomUUID(),
          })
        ).rejects.toThrow(/systemd-user is unavailable|failed disconnect verification/i);
      }
    } finally {
      disconnectSsh(sessionId);
    }
  }, 30_000);

  it("records cancellation and keeps prior output readable", async () => {
    const jobId = randomUUID();
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: [
        "printf 'cancellable-start\\n'",
        `sh -c 'trap "" TERM; sleep 30 & child=$!; printf "%s\\n" "$child" > /home/snow/${jobId}.child.pid; wait "$child"'`,
        "printf 'must-not-complete\\n'",
      ].join("; "),
      timeoutMs: 30_000,
      jobId,
      backend: "posix-detach",
    });

    await waitFor(jobId, (result) => result.output.includes("cancellable-start"));
    const cancellationRequested = await cancelRemoteJob(jobId);
    expect(["launching", "running", "cancelled"]).toContain(
      cancellationRequested.status
    );

    const result = await waitFor(
      jobId,
      (current) => current.state.status === "cancelled"
    );
    expect(result.output).toContain("cancellable-start");
    expect(result.output).not.toContain("must-not-complete");
    const sessionId = await connectSsh(passwordParams());
    try {
      await expect(
        executeSshCommand(
          sessionId,
          `child=$(cat /home/snow/${jobId}.child.pid); ! kill -0 "$child" 2>/dev/null`
        )
      ).resolves.toBe("");
    } finally {
      disconnectSsh(sessionId);
    }
  }, 30_000);

  it("cleans expired Snow Agent terminal jobs with ISO-8601 timestamps", async () => {
    const jobs = [
      { status: "succeeded" as const, ageMs: 8 * 24 * 60 * 60 * 1000 },
      { status: "failed" as const, ageMs: 15 * 24 * 60 * 60 * 1000 },
    ];
    const jobIds: string[] = [];

    for (const { status, ageMs } of jobs) {
      const jobId = randomUUID();
      jobIds.push(jobId);
      await startRemoteJob({
        workspacePath: workspacePath(),
        command: "true",
        timeoutMs: 10_000,
        jobId,
        backend: "posix-detach",
      });
      const completed = await waitFor(jobId, (result) =>
        result.state.status === "succeeded"
      );
      const updatedAt = new Date(Date.now() - ageMs).toISOString();
      const statePath = `/home/snow/.local/state/snow-app/jobs/${jobId}/state.json`;
      const sessionId = await connectSsh(passwordParams());
      try {
        const existing = await readSshFileWithVersion(sessionId, statePath);
        await writeSshFile(
          sessionId,
          statePath,
          JSON.stringify({
            ...completed.state,
            status,
            revision: completed.state.revision + 1,
            backend: "snow-agent",
            createdAt: updatedAt,
            updatedAt,
            completedAt: updatedAt,
            exitCode: status === "succeeded" ? 0 : 1,
          }),
          {
            expectedVersion: existing.version,
            workspaceRoot: "/home/snow",
          }
        );
      } finally {
        disconnectSsh(sessionId);
      }

      const observed = await getRemoteJob(jobId, { offset: 0 });
      expect(observed.job).toMatchObject({
        backend: "snow-agent",
        status,
        updatedAt,
      });
      expect(Date.parse(observed.job.updatedAt)).toBe(Date.parse(updatedAt));
    }

    await expect(cleanupRemoteJobs()).resolves.toEqual({ removed: expect.arrayContaining(jobIds) });
    for (const jobId of jobIds) {
      await expect(getRemoteJob(jobId)).rejects.toThrow("Remote Job binding was not found");
    }
  }, 30_000);

  it("does not replace a runner terminal state with a stale lost snapshot", async () => {
    const jobId = randomUUID();
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: "sleep 1; printf 'race-finished\\n'",
      timeoutMs: 10_000,
      jobId,
      backend: "posix-detach",
    });
    await waitFor(jobId, (result) => result.state.status === "running");

    const backend = getRemoteJobBackendsForTesting()["posix-detach"];
    const inspect = backend.inspect;
    backend.inspect = async (context) => {
      await wait(1_500);
      return "inactive";
    };
    try {
      const resolved = await getRemoteJob(jobId, { offset: 0 });
      expect(resolved.state.status).toBe("succeeded");
      expect(resolved.output).toContain("race-finished");
      await expect(cancelRemoteJob(jobId)).resolves.toMatchObject({
        status: "succeeded",
      });
    } finally {
      backend.inspect = inspect;
    }
  }, 30_000);

  it("advances output offsets by bytes across a 64 KiB UTF-8 boundary", async () => {
    const jobId = randomUUID();
    const prefixLength = 64 * 1024 - 1;
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: `head -c ${prefixLength} /dev/zero | tr '\\000' x; printf '中😀\\n'`,
      timeoutMs: 10_000,
      jobId,
      backend: "posix-detach",
    });
    await waitFor(jobId, (result) => result.state.status === "succeeded");

    const first = await getRemoteJob(jobId, { offset: 0, limit: 64 * 1024 });
    expect(first.outputBytes).toHaveLength(64 * 1024);
    expect(first.nextOffset).toBe(64 * 1024);
    expect(first.eof).toBe(false);

    const second = await getRemoteJob(jobId, {
      offset: first.nextOffset,
      limit: 64 * 1024,
    });
    const decoder = new TextDecoder();
    const output =
      decoder.decode(first.outputBytes, { stream: !first.eof }) +
      decoder.decode(second.outputBytes, { stream: !second.eof }) +
      decoder.decode();
    expect(output).toBe(`${"x".repeat(prefixLength)}中😀\n`);
    expect(second.nextOffset).toBe(
      prefixLength + Buffer.byteLength("中😀\n", "utf8")
    );
  }, 30_000);

  it("does not persist sensitive command forms in bindings, manifests, or AI context", async () => {
    const jobId = randomUUID();
    const secrets = ["env-secret", "flag-secret", "header-secret", "short-secret"];
    const job = await startRemoteJob({
      workspacePath: workspacePath(),
      command: `printf 'redaction-check\\n' # TOKEN=${secrets[0]} --token ${secrets[1]} -H 'Authorization: Bearer ${secrets[2]}' -p ${secrets[3]}`,
      timeoutMs: 10_000,
      jobId,
      backend: "posix-detach",
    });
    expect(job.displayCommand).toBe("Remote command");

    await waitFor(jobId, (result) => result.state.status === "succeeded");
    const context = await getRemoteJobAnalysisContext(jobId, { offset: 0 });
    const sessionId = await connectSsh(passwordParams());
    try {
      const manifest = await executeSshCommand(
        sessionId,
        `cat -- /home/snow/.local/state/snow-app/jobs/${jobId}/manifest.json`
      );
      for (const secret of secrets) {
        expect(JSON.stringify(job)).not.toContain(secret);
        expect(manifest).not.toContain(secret);
        expect(context).not.toContain(secret);
      }
    } finally {
      disconnectSsh(sessionId);
    }
  }, 30_000);
});

unavailableOpenSsh("Interactive Remote Job OpenSSH availability failures", () => {
  beforeEach(() => {
    expect(port).toBeGreaterThan(0);
    bindingsDirectory = mkdtempSync(join(tmpdir(), "snow-remote-jobs-test-"));
    process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = bindingsDirectory;
  });

  afterEach(() => {
    disconnectAllSsh();
    hostKeys.clear();
    if (bindingsDirectory) {
      rmSync(bindingsDirectory, { recursive: true, force: true });
      bindingsDirectory = "";
    }
  });

  afterAll(() => {
    if (originalBindingsDir === undefined) {
      delete process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
    } else {
      process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = originalBindingsDir;
    }
  });

  const expectedCode =
    fixture === "noexec"
      ? "AGENT_HOME_NOEXEC"
      : fixture === "sftp-disabled"
        ? "REMOTE_FILE_TRANSFER_UNAVAILABLE"
        : "PTY_UNAVAILABLE";

  it(`returns ${expectedCode} without creating an attachable job`, async () => {
    const jobId = randomUUID();
    await expect(
      startRemoteJob({
        workspacePath: workspacePath(),
        command: "printf should-not-run",
        jobId,
        backend: fixture === "sftp-disabled" ? "posix-detach" : undefined,
        mode: fixture === "sftp-disabled" ? "batch" : "interactive",
      })
    ).rejects.toMatchObject({ code: expectedCode });
    await expect(getRemoteJobAttachSpec(jobId)).rejects.toThrow(
      "Remote Job binding was not found"
    );
  }, 30_000);
});
