import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
}));

import {
  assertDurableJobPlatformSupported,
  getRemoteJobBackendsForTesting,
  WINDOWS_DURABLE_JOB_UNAVAILABLE_MESSAGE,
} from "./remoteJobs";

describe("Remote Job backend registration", () => {
  it("does not expose the retired Windows scheduled-task backend", () => {
    expect(getRemoteJobBackendsForTesting()).not.toHaveProperty("windows-job");
  });

  it("requires a protected helper for Windows durable jobs", () => {
    expect(() => assertDurableJobPlatformSupported("windows")).toThrow(
      WINDOWS_DURABLE_JOB_UNAVAILABLE_MESSAGE
    );
    expect(() => assertDurableJobPlatformSupported("posix")).not.toThrow();
    expect(WINDOWS_DURABLE_JOB_UNAVAILABLE_MESSAGE).toMatch(
      /protected remote helper.*least-privileged service account/i
    );
    expect(WINDOWS_DURABLE_JOB_UNAVAILABLE_MESSAGE).toMatch(
      /does not provision or transmit service credentials over SSH/i
    );
  });
});
