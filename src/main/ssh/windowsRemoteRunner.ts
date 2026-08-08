import { Buffer } from "node:buffer";
import { executeSshCommand } from "./sshManager";
import { WINDOWS_JOB_OBJECT_INTEROP_SCRIPT } from "./windowsJobObject";

const powerShellQuote = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const POWER_SHELL_NON_INTERACTIVE_PRELUDE =
  "$ProgressPreference = 'SilentlyContinue'\r\n";
const STATE_LOCK_STALE_SECONDS = 5;

export const encodeWindowsPowerShell = (script: string): string =>
  Buffer.from(
    `${POWER_SHELL_NON_INTERACTIVE_PRELUDE}${script}`,
    "utf16le"
  ).toString("base64");

export const runWindowsPowerShell = (
  sessionId: string,
  script: string,
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<string> =>
  executeSshCommand(
    sessionId,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodeWindowsPowerShell(script)}`,
    { timeoutMs, signal }
  );

export const getWindowsRemoteJobRoot = async (sessionId: string): Promise<string> => {
  const root = (
    await runWindowsPowerShell(
      sessionId,
      "$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SnowApp\\jobs'; New-Item -ItemType Directory -Force -Path $root | Out-Null; [Console]::Out.Write($root.Replace('\\','/'))",
      10_000
    )
  ).trim();
  if (!/^[A-Za-z]:\//.test(root) || root.includes("\n")) {
    throw new Error("Remote Job state directory is not an absolute Windows path");
  }
  return root.replace(/\/+$/, "");
};

export const createWindowsRemoteDirectory = (
  sessionId: string,
  path: string
): Promise<string> =>
  runWindowsPowerShell(
    sessionId,
    `New-Item -ItemType Directory -Path ${powerShellQuote(path)} -ErrorAction Stop | Out-Null`
  );

export const moveWindowsRemotePath = (
  sessionId: string,
  source: string,
  target: string
): Promise<string> =>
  runWindowsPowerShell(
    sessionId,
    `Move-Item -LiteralPath ${powerShellQuote(source)} -Destination ${powerShellQuote(
      target
    )} -ErrorAction Stop`
  );

export const removeWindowsRemotePath = (
  sessionId: string,
  path: string
): Promise<string> =>
  runWindowsPowerShell(
    sessionId,
    `Remove-Item -LiteralPath ${powerShellQuote(path)} -Force -Recurse -ErrorAction Stop`
  );

export const buildWindowsCommandScript = (
  workingDirectory: string,
  maxOutputBytes: number
): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `Set-Location -LiteralPath ${powerShellQuote(workingDirectory)}`,
    "$command = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'command.txt'), [System.Text.Encoding]::UTF8)",
    "$outputPath = Join-Path $PSScriptRoot 'output.log'",
    "$outputTruncatedPath = Join-Path $PSScriptRoot 'output.truncated'",
    `$maxOutputBytes = [int64]${Math.max(0, Math.floor(maxOutputBytes))}`,
    "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "$writtenOutputBytes = if (Test-Path -LiteralPath $outputPath) { [int64](Get-Item -LiteralPath $outputPath).Length } else { 0 }",
    "$outputTruncated = (Test-Path -LiteralPath $outputTruncatedPath) -or $writtenOutputBytes -ge $maxOutputBytes",
    "if ($outputTruncated) { [System.IO.File]::WriteAllText($outputTruncatedPath, '', [System.Text.Encoding]::ASCII) }",
    "$output = [System.IO.StreamWriter]::new($outputPath, $true, $utf8NoBom)",
    "$output.AutoFlush = $true",
    "try {",
    "  & ([ScriptBlock]::Create($command)) *>&1 | ForEach-Object {",
    "    if (-not $outputTruncated) {",
    "      $entry = $_.ToString() + [Environment]::NewLine",
    "      $entryBytes = [int64]$utf8NoBom.GetByteCount($entry)",
    "      if ($entryBytes -le ($maxOutputBytes - $writtenOutputBytes)) {",
    "        $output.Write($entry)",
    "        $writtenOutputBytes += $entryBytes",
    "      } else {",
    "        $outputTruncated = $true",
    "        [System.IO.File]::WriteAllText($outputTruncatedPath, '', [System.Text.Encoding]::ASCII)",
    "      }",
    "    }",
    "  }",
    "  if ($null -eq $LASTEXITCODE) { exit 0 }",
    "  exit $LASTEXITCODE",
    "} finally {",
    "  $output.Dispose()",
    "}",
    "",
  ].join("\r\n");

/**
 * The runner owns a Windows Job Object with KILL_ON_JOB_CLOSE. Killing the
 * runner therefore also terminates its descendants, unlike a bare
 * Start-Process call over OpenSSH.
 */
export const buildWindowsRunnerScript = (jobId: string, createdAt: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "$jobDirectory = $PSScriptRoot",
    `$jobId = ${powerShellQuote(jobId)}`,
    `$createdAt = ${powerShellQuote(createdAt)}`,
    "$statePath = Join-Path $jobDirectory 'state.json'",
    "$revisionPath = Join-Path $jobDirectory 'revision'",
    "$runnerErrorPath = Join-Path $jobDirectory 'runner-error.log'",
    "$outputTruncatedPath = Join-Path $jobDirectory 'output.truncated'",
    "$timeoutMs = [int64](Get-Content -LiteralPath (Join-Path $jobDirectory 'timeout-ms') -Raw)",
    "$backend = 'windows-helper'",
    "$runnerPid = $PID",
    "$stateLockPath = Join-Path $jobDirectory 'state.lock'",
    "$stateLockOwnerPath = Join-Path $stateLockPath 'owner.json'",
    "$stateLockReclaimPath = Join-Path $stateLockPath 'reclaim'",
    "$stateLockOwner = [Guid]::NewGuid().ToString('N')",
    `$stateLockStaleSeconds = ${STATE_LOCK_STALE_SECONDS}`,
    "$stateLockHeld = $false",
    "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "[System.IO.File]::WriteAllText((Join-Path $jobDirectory 'runner.pid'), [string]$runnerPid, [System.Text.Encoding]::ASCII)",
    "function Test-StateLockOwner {",
    "  if (-not (Test-Path -LiteralPath $stateLockOwnerPath) -or (Test-Path -LiteralPath $stateLockReclaimPath)) { return $false }",
    "  try { return ((Get-Content -LiteralPath $stateLockOwnerPath -Raw | ConvertFrom-Json).owner -eq $stateLockOwner) } catch { return $false }",
    "}",
    "function Exit-StateLock {",
    "  if ($stateLockHeld -and (Test-StateLockOwner)) {",
    "    Remove-Item -LiteralPath $stateLockOwnerPath -Force -ErrorAction SilentlyContinue",
    "    Remove-Item -LiteralPath $stateLockPath -Force -ErrorAction SilentlyContinue",
    "  }",
    "  $stateLockHeld = $false",
    "}",
    "function Test-StateLockStale {",
    "  if (-not (Test-Path -LiteralPath $stateLockOwnerPath)) { return $true }",
    "  try { $metadata = Get-Content -LiteralPath $stateLockOwnerPath -Raw | ConvertFrom-Json } catch { return $true }",
    "  if ($metadata.pid -isnot [long] -or $metadata.createdAtEpoch -isnot [long] -or $metadata.processStartTicks -isnot [long]) { return $true }",
    "  $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$metadata.createdAtEpoch",
    "  if ($age -lt $stateLockStaleSeconds) { return $false }",
    "  try {",
    "    $process = Get-Process -Id ([int]$metadata.pid) -ErrorAction Stop",
    "    if ($process.StartTime.ToUniversalTime().Ticks -eq [long]$metadata.processStartTicks) { return $false }",
    "  } catch {}",
    "  return $true",
    "}",
    "function Try-ReclaimStateLock {",
    "  try { New-Item -ItemType Directory -Path $stateLockReclaimPath -ErrorAction Stop | Out-Null } catch { return $false }",
    "  if (-not (Test-StateLockStale)) { Remove-Item -LiteralPath $stateLockReclaimPath -Force -ErrorAction SilentlyContinue; return $false }",
    "  try { Remove-Item -LiteralPath $stateLockPath -Force -Recurse -ErrorAction Stop; return $true } catch { return $false }",
    "}",
    "function Enter-StateLock {",
    "  $deadline = [DateTime]::UtcNow.AddMilliseconds(10000)",
    "  while ([DateTime]::UtcNow -lt $deadline) {",
    "    if (Test-StateLockOwner) { $stateLockHeld = $true; return }",
    "    try {",
    "      New-Item -ItemType Directory -Path $stateLockPath -ErrorAction Stop | Out-Null",
    "      $metadata = [ordered]@{ owner = $stateLockOwner; pid = $PID; createdAtEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); processStartTicks = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks }",
    "      [System.IO.File]::WriteAllText($stateLockOwnerPath, ($metadata | ConvertTo-Json -Compress), $utf8NoBom)",
    "      if (Test-StateLockOwner) { $stateLockHeld = $true; return }",
    "    } catch {",
    "      if (Test-StateLockStale) { [void](Try-ReclaimStateLock) }",
    "    }",
    "    Start-Sleep -Milliseconds 25",
    "  }",
    "  throw 'Remote Job state lock timed out'",
    "}",
    "function Write-State([string]$status, [Nullable[int]]$exitCode, [string]$reason) {",
    "  Enter-StateLock",
    "  try {",
    "    $truncated = Test-Path -LiteralPath $outputTruncatedPath",
    "    if (Test-Path -LiteralPath $statePath) { $currentState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json; if ($currentState.status -in @('succeeded','failed','timed_out','cancelled','lost','launch_failed','indeterminate')) { return }; if ($currentState.truncated -eq $true) { $truncated = $true } }",
    "    $revision = 1 + [int](Get-Content -LiteralPath $revisionPath -Raw)",
    "    [System.IO.File]::WriteAllText($revisionPath, [string]$revision, [System.Text.Encoding]::ASCII)",
    "    $now = [DateTime]::UtcNow.ToString('o')",
    "    $state = [ordered]@{ schemaVersion = 1; jobId = $jobId; status = $status; revision = $revision; backend = $backend; runnerPid = $runnerPid; createdAt = $createdAt; updatedAt = $now; exitCode = $exitCode }",
    "    if ($status -in @('succeeded','failed','timed_out','cancelled','lost','launch_failed','indeterminate')) { $state.completedAt = $now }",
    "    if ($reason) { $state.reason = $reason }",
    "    if ($truncated) { $state['truncated'] = $true }",
    "    $temporary = \"$statePath.$([Guid]::NewGuid().ToString('N')).tmp\"",
    "    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress), $utf8NoBom)",
    "    if (-not [SnowWindowsJob]::MoveFileEx($temporary, $statePath, [SnowWindowsJob]::MoveFileReplaceExisting -bor [SnowWindowsJob]::MoveFileWriteThrough)) { throw [ComponentModel.Win32Exception]::new() }",
    "  } finally { Exit-StateLock }",
    "}",
    WINDOWS_JOB_OBJECT_INTEROP_SCRIPT,
    "$job = [IntPtr]::Zero",
    "try {",
    "  Write-State 'launching' $null ''",
    "  $job = [SnowWindowsJob]::CreateKillOnCloseJob()",
    "  try {",
    "    $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $jobDirectory 'command.ps1')) -WindowStyle Hidden -PassThru",
    "    $childHandle = [SnowWindowsJob]::OpenProcess(([SnowWindowsJob]::ProcessTerminate -bor [SnowWindowsJob]::ProcessSetQuota), $false, [uint32]$child.Id)",
    "    if ($childHandle -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new() }",
    "    try { if (-not [SnowWindowsJob]::AssignProcessToJobObject($job, $childHandle)) { throw [ComponentModel.Win32Exception]::new() } } finally { [SnowWindowsJob]::CloseHandle($childHandle) | Out-Null }",
    "    Write-State 'running' $null ''",
    "    $started = [Environment]::TickCount64; $cancelled = $false; $timedOut = $false; $outputTruncated = Test-Path -LiteralPath $outputTruncatedPath",
    "    while (-not $child.WaitForExit(250)) {",
    "      if (-not $outputTruncated -and (Test-Path -LiteralPath $outputTruncatedPath)) { $outputTruncated = $true; Write-State 'running' $null '' }",
    "      if (Test-Path -LiteralPath (Join-Path $jobDirectory 'cancel.request')) { $cancelled = $true }",
    "      elseif (([Environment]::TickCount64 - $started) -ge $timeoutMs) { $timedOut = $true }",
    "      if ($cancelled -or $timedOut) {",
    "        if (-not [SnowWindowsJob]::TerminateJobObject($job, 1)) { throw [ComponentModel.Win32Exception]::new() }",
    "        if (-not $child.WaitForExit(5000)) { throw 'Windows Job Object did not terminate the command process' }",
    "        break",
    "      }",
    "    }",
    "    if ($timedOut) { Write-State 'timed_out' $child.ExitCode 'timeout' }",
    "    elseif ($cancelled) { Write-State 'cancelled' $child.ExitCode 'cancelled' }",
    "    elseif ($child.ExitCode -eq 0) { Write-State 'succeeded' 0 '' }",
    "    else { Write-State 'failed' $child.ExitCode 'exit' }",
    "  } catch { [System.IO.File]::WriteAllText($runnerErrorPath, $_.Exception.ToString(), $utf8NoBom); Write-State 'launch_failed' $null $_.Exception.Message }",
    "} catch {",
    "  [System.IO.File]::WriteAllText($runnerErrorPath, $_.Exception.ToString(), $utf8NoBom)",
    "  try { Write-State 'launch_failed' $null $_.Exception.Message } catch {}",
    "}",
    "finally { if ($job -and $job -ne [IntPtr]::Zero) { [SnowWindowsJob]::CloseHandle($job) | Out-Null } }",
    "",
  ].join("\r\n");

export const inspectWindowsRemoteJob = async (
  sessionId: string,
  runnerPid: number | undefined
): Promise<"active" | "inactive"> => {
  if (!runnerPid) {
    return "inactive";
  }
  const output = await runWindowsPowerShell(
    sessionId,
    `if (Get-Process -Id ${Math.max(0, Math.floor(runnerPid))} -ErrorAction SilentlyContinue) { [Console]::Out.Write('active') } else { [Console]::Out.Write('inactive') }`
  );
  return output.trim() === "active" ? "active" : "inactive";
};

export const cancelWindowsRemoteJob = async (
  sessionId: string,
  runnerPid: number | undefined
): Promise<void> => {
  if (!runnerPid) {
    return;
  }
  await runWindowsPowerShell(
    sessionId,
    `Stop-Process -Id ${Math.max(0, Math.floor(runnerPid))} -Force -ErrorAction SilentlyContinue`
  );
};
