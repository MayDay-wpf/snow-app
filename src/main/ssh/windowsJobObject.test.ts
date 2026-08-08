import { describe, expect, it } from "vitest";
import {
  buildWindowsJobObjectLifecycleProbeScript,
  WINDOWS_JOB_OBJECT_INTEROP_SCRIPT,
} from "./windowsJobObject";

describe("Windows Job Object lifecycle probe", () => {
  it("uses the runner's complete Job Object contract before reporting success", () => {
    const success = "[Console]::Out.WriteLine('windows_job_objects=1')";
    const script = buildWindowsJobObjectLifecycleProbeScript(success);

    expect(WINDOWS_JOB_OBJECT_INTEROP_SCRIPT).toContain("Add-Type @'");
    expect(WINDOWS_JOB_OBJECT_INTEROP_SCRIPT).toContain("CreateJobObject");
    expect(WINDOWS_JOB_OBJECT_INTEROP_SCRIPT).toContain("SetInformationJobObject");
    expect(WINDOWS_JOB_OBJECT_INTEROP_SCRIPT).toContain(
      "AssignProcessToJobObject"
    );
    expect(script).toContain("Start-Process -FilePath 'powershell.exe'");
    expect(script).toContain("CreateKillOnCloseJob()");
    expect(script).toContain("CloseHandle($job)");
    expect(script).toContain("$child.WaitForExit(5000)");
    expect(script.indexOf(success)).toBeGreaterThan(
      script.indexOf("$child.WaitForExit(5000)")
    );
  });
});
