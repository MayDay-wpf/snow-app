import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => process.cwd(), isPackaged: false },
  net: { fetch: globalThis.fetch },
}));

import {
  getRemoteJobBindingsForTesting,
  parseRemoteJobStateForTesting,
} from "./remoteJobs";

const originalBindingsDirectory = process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
let bindingsDirectory = "";

afterEach(() => {
  if (bindingsDirectory) {
    rmSync(bindingsDirectory, { recursive: true, force: true });
    bindingsDirectory = "";
  }
  if (originalBindingsDirectory === undefined) {
    delete process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
  } else {
    process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = originalBindingsDirectory;
  }
});

describe("Remote Job mode migration", () => {
  it("treats a legacy local binding with no mode as batch", () => {
    bindingsDirectory = mkdtempSync(join(tmpdir(), "snow-remote-job-mode-"));
    process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = bindingsDirectory;
    const jobId = randomUUID();
    writeFileSync(
      join(bindingsDirectory, "bindings.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobs: [
          {
            jobId,
            workspacePath: "ssh://snow@example.test:22/home/snow",
            workspaceId: "ssh://snow@example.test:22/home/snow",
            profileId: "snow@example.test:22",
            commandHash: "a".repeat(64),
            displayCommand: "Remote command",
            backend: "posix-detach",
            jobTokenHash: "b".repeat(64),
            createdAt: "2026-08-08T00:00:00.000Z",
            updatedAt: "2026-08-08T00:00:00.000Z",
            status: "succeeded",
            revision: 1,
            lastOutputOffset: 0,
          },
        ],
      })
    );

    expect(getRemoteJobBindingsForTesting()).toMatchObject([{ jobId, mode: "batch" }]);
  });

  it("treats a legacy remote state with no mode as batch", () => {
    const jobId = randomUUID();
    expect(
      parseRemoteJobStateForTesting(
        {
          schemaVersion: 1,
          jobId,
          status: "running",
          revision: 3,
          updatedAt: "2026-08-08T00:00:00.000Z",
        },
        jobId
      )
    ).toMatchObject({ mode: "batch" });
  });
});
