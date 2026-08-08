import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startRemoteJob = vi.hoisted(() => vi.fn());

vi.mock("../utils/fileReader", () => ({
  processFileContent: vi.fn(),
}));

vi.mock("./sshCredentials", () => ({
  getDecryptedSecret: vi.fn(),
  getSshCredential: vi.fn(),
}));

vi.mock("./sshManager", () => ({
  connectSsh: vi.fn(),
  disconnectSsh: vi.fn(),
  executeSshCommand: vi.fn(),
  isSshOperationError: () => false,
  listSshDirectory: vi.fn(),
  parseSshUrl: vi.fn(),
  readSshFile: vi.fn(),
  readSshFileWithVersion: vi.fn(),
  toSshOperationErrorResult: vi.fn(),
  writeSshFile: vi.fn(),
}));

vi.mock("./remoteJobs", () => ({
  cancelRemoteJob: vi.fn(),
  getRemoteJob: vi.fn(),
  listRemoteJobs: vi.fn(),
  startRemoteJob,
}));

import { dispatchRemoteWorkspaceCommand } from "./remoteWorkspaceCommand";

const workspacePath = "ssh://snow@example.test:22/home/snow";

describe("Remote Workspace Command mode forwarding", () => {
  beforeEach(() => {
    startRemoteJob.mockResolvedValue({
      jobId: "00000000-0000-4000-8000-000000000001",
      status: "running",
    });
  });

  afterEach(() => {
    startRemoteJob.mockReset();
  });

  it.each([
    ["bash-terminal-execute", { durable: true }],
    ["remote-job-start", {}],
  ])("forwards interactive mode through %s", async (operation, extraArgs) => {
    await dispatchRemoteWorkspaceCommand({
      operation,
      argsJson: JSON.stringify({
        workingDirectory: workspacePath,
        command: "read confirmation",
        mode: "interactive",
        ...extraArgs,
      }),
    });

    expect(startRemoteJob).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        command: "read confirmation",
        mode: "interactive",
      }),
      expect.objectContaining({ cancellationPolicy: "cancel_remote" })
    );
  });

  it("rejects an unknown mode before submitting a durable job", async () => {
    await expect(
      dispatchRemoteWorkspaceCommand({
        operation: "remote-job-start",
        argsJson: JSON.stringify({
          workingDirectory: workspacePath,
          command: "read confirmation",
          mode: "attached",
        }),
      })
    ).rejects.toThrow("Unsupported Remote Job mode");

    expect(startRemoteJob).not.toHaveBeenCalled();
  });
});
