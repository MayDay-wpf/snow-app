const WINDOWS_JOB_OBJECT_INTEROP_LINES = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class SnowWindowsJob {",
  "  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);",
  "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);",
  "  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existingFileName, string newFileName, uint flags);",
  "  public const uint MoveFileReplaceExisting = 0x00000001;",
  "  public const uint MoveFileWriteThrough = 0x00000008;",
  "  public const uint ProcessTerminate = 0x0001;",
  "  public const uint ProcessSetQuota = 0x0100;",
  "  [StructLayout(LayoutKind.Sequential)] public struct BasicLimit { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }",
  "  [StructLayout(LayoutKind.Sequential)] public struct IoCounters { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }",
  "  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimit { public BasicLimit BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }",
  "  public static IntPtr CreateKillOnCloseJob() { var job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(); var value = new ExtendedLimit(); value.BasicLimitInformation.LimitFlags = 0x00002000; int size = Marshal.SizeOf(value); IntPtr memory = Marshal.AllocHGlobal(size); try { Marshal.StructureToPtr(value, memory, false); if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new System.ComponentModel.Win32Exception(); return job; } catch { CloseHandle(job); throw; } finally { Marshal.FreeHGlobal(memory); } }",
  "}",
  "'@",
];

export const WINDOWS_JOB_OBJECT_INTEROP_SCRIPT =
  WINDOWS_JOB_OBJECT_INTEROP_LINES.join("\r\n");

/**
 * Exercise the Job Object contract the Windows runner needs, including the
 * KILL_ON_JOB_CLOSE behaviour that guarantees child cleanup after a runner exit.
 */
export const buildWindowsJobObjectLifecycleProbeScript = (
  successScript: string
): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    WINDOWS_JOB_OBJECT_INTEROP_SCRIPT,
    "$job = [IntPtr]::Zero",
    "$child = $null",
    "$childHandle = [IntPtr]::Zero",
    "try {",
    "  $job = [SnowWindowsJob]::CreateKillOnCloseJob()",
    "  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru",
    "  $childHandle = [SnowWindowsJob]::OpenProcess(([SnowWindowsJob]::ProcessTerminate -bor [SnowWindowsJob]::ProcessSetQuota), $false, [uint32]$child.Id)",
    "  if ($childHandle -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new() }",
    "  if (-not [SnowWindowsJob]::AssignProcessToJobObject($job, $childHandle)) { throw [ComponentModel.Win32Exception]::new() }",
    "  if (-not [SnowWindowsJob]::CloseHandle($childHandle)) { throw [ComponentModel.Win32Exception]::new() }",
    "  $childHandle = [IntPtr]::Zero",
    "  if (-not [SnowWindowsJob]::CloseHandle($job)) { throw [ComponentModel.Win32Exception]::new() }",
    "  $job = [IntPtr]::Zero",
    "  if (-not $child.WaitForExit(5000)) { throw 'Windows Job Object did not terminate the probe child when closed' }",
    successScript,
    "} finally {",
    "  if ($childHandle -ne [IntPtr]::Zero) { [SnowWindowsJob]::CloseHandle($childHandle) | Out-Null }",
    "  if ($job -ne [IntPtr]::Zero) { [SnowWindowsJob]::TerminateJobObject($job, 1) | Out-Null; [SnowWindowsJob]::CloseHandle($job) | Out-Null }",
    "  if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join("\r\n");
