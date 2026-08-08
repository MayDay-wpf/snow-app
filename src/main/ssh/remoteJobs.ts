import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
  executeSshCommand,
  probeSshPty,
  probeSshCapabilities,
  readSshFile,
  readSshFileRange,
  statSshEntry,
  writeInternalSshFile,
  type SshCapabilities,
} from "./sshManager";
import {
  normalizeRemotePath,
  shellQuote,
  withSshSession,
} from "./remoteWorkspaceCommand";
import { encodeWindowsPowerShell } from "./windowsRemoteRunner";
import {
  canUseSnowAgent,
  cancelSnowAgentJob,
  getSnowAgentAttachCommand,
  inspectSnowAgentJob,
  launchSnowAgentJob,
  negotiateSnowAgent,
  startSnowAgentLivenessProbe,
  startSnowAgentInteractiveProbe,
  supportsSnowAgentInteractiveAttach,
  verifySnowAgentInteractiveProbe,
} from "./snowAgent";

const JOB_SCHEMA_VERSION = 1;
const MAX_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = MAX_JOB_TIMEOUT_MS;
const MAX_OUTPUT_READ_BYTES = 64 * 1024;
const MAX_REMOTE_JOB_LOG_BYTES = 50 * 1024 * 1024;
const SUCCESS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const BACKEND_PROBE_CACHE_MS = 10 * 60 * 1000;
const BACKEND_PROBE_FAILURES = new Map<string, string>();
const STATE_LOCK_ATTEMPTS = 400;
const STATE_LOCK_STALE_SECONDS = 5;
const POSIX_CANCEL_GRACE_SECONDS = 5;
const SYSTEMD_RUNTIME_GRACE_SECONDS = 10;
const POSIX_RUNNER_POLL_SECONDS = 0.2;
const INACTIVE_RUNNER_SETTLE_MS = 750;

export const WINDOWS_DURABLE_JOB_UNAVAILABLE_MESSAGE =
  "Windows durable jobs require a protected remote helper running under a least-privileged service account; Snow App does not provision or transmit service credentials over SSH.";

export const assertDurableJobPlatformSupported = (
  platform: SshCapabilities["platform"]
): void => {
  if (platform === "windows") {
    throw new Error(WINDOWS_DURABLE_JOB_UNAVAILABLE_MESSAGE);
  }
};

export type RemoteJobCancellationPolicy = "cancel_remote" | "detach_only";
export type RemoteJobMode = "batch" | "interactive";

export class RemoteJobLaunchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteJobLaunchRejectedError";
  }
}

export class RemoteJobUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "RemoteJobUnavailableError";
    this.code = code;
  }
}

export type RemoteJobStatus =
  | "preparing"
  | "launching"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost"
  | "launch_failed"
  | "indeterminate";

export type RemoteJobBackendKind =
  | "snow-agent"
  | "systemd-user"
  | "tmux"
  | "posix-detach";

export type RemoteJobState = {
  schemaVersion: number;
  jobId: string;
  status: RemoteJobStatus;
  revision: number;
  backend?: RemoteJobBackendKind;
  mode?: RemoteJobMode;
  runnerPid?: number;
  exitCode?: number;
  createdAt?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  reason?: string;
  truncated?: boolean;
};

export type RemoteJobBinding = {
  jobId: string;
  workspacePath: string;
  workspaceId: string;
  profileId: string;
  commandHash: string;
  displayCommand: string;
  backend: RemoteJobBackendKind;
  mode: RemoteJobMode;
  cancellationPolicy?: RemoteJobCancellationPolicy;
  jobTokenHash: string;
  createdAt: string;
  updatedAt: string;
  status: RemoteJobStatus;
  revision: number;
  conversationId?: string;
  toolCallId?: string;
  lastOutputOffset: number;
  lastError?: string;
};

export type RemoteJobStartRequest = {
  workspacePath: string;
  workspaceId?: string;
  command: string;
  timeoutMs?: number;
  jobId?: string;
  backend?: RemoteJobBackendKind;
  mode?: RemoteJobMode;
  conversationId?: string;
  toolCallId?: string;
};

export type RemoteJobStartOptions = {
  signal?: AbortSignal;
  cancellationPolicy?: RemoteJobCancellationPolicy;
};

export type RemoteJobOutput = {
  job: RemoteJobBinding;
  state: RemoteJobState;
  output: string;
  outputBytes: Buffer;
  offset: number;
  nextOffset: number;
  eof: boolean;
};

export type RemoteJobAttachSpec = {
  jobId: string;
  workspacePath: string;
  backend: RemoteJobBackendKind;
  mode: "interactive";
  remoteCommand: string;
};

export type RemoteJobBackendContext = {
  sessionId: string;
  jobDirectory: string;
  jobId: string;
  timeoutMs: number;
  capabilities: SshCapabilities;
  mode: RemoteJobMode;
  signal?: AbortSignal;
};

export interface RemoteJobBackend {
  kind: RemoteJobBackendKind;
  isAvailable(capabilities: SshCapabilities): boolean;
  launch(context: RemoteJobBackendContext): Promise<void>;
  inspect(context: RemoteJobBackendContext): Promise<"active" | "inactive">;
  cancel(context: RemoteJobBackendContext): Promise<void>;
}

type StoredBindings = {
  schemaVersion: number;
  jobs: RemoteJobBinding[];
};

const TERMINAL_STATUSES = new Set<RemoteJobStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
  "launch_failed",
  "indeterminate",
]);

const BACKEND_PROBE_CACHE = new Map<string, number>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJobId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );

const isRemoteJobStatus = (value: unknown): value is RemoteJobStatus =>
  typeof value === "string" &&
  [
    "preparing",
    "launching",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "launch_failed",
    "indeterminate",
  ].includes(value);

const isBackendKind = (value: unknown): value is RemoteJobBackendKind =>
  value === "snow-agent" ||
  value === "systemd-user" ||
  value === "tmux" ||
  value === "posix-detach";

const isCancellationPolicy = (
  value: unknown
): value is RemoteJobCancellationPolicy =>
  value === "cancel_remote" || value === "detach_only";

const isRemoteJobMode = (value: unknown): value is RemoteJobMode =>
  value === "batch" || value === "interactive";

const modeFromStoredValue = (value: unknown): RemoteJobMode =>
  isRemoteJobMode(value) ? value : "batch";

const normalizeWorkspacePath = (value: string): string => {
  const path = value.trim();
  if (!path.startsWith("ssh://")) {
    throw new Error("Remote Job requires an SSH workspace path");
  }
  return path.replace(/\/+$/, "") || path;
};

const normalizeTimeout = (value: number | undefined): number => {
  if (value === undefined) {
    return DEFAULT_JOB_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Remote Job timeout must be a positive number");
  }
  return Math.min(Math.floor(value), MAX_JOB_TIMEOUT_MS);
};

const getBindingsDirectory = (): string =>
  process.env.SNOW_REMOTE_JOB_BINDINGS_DIR?.trim() ||
  join(app.getPath("userData"), "remote-jobs");

const getBindingsPath = (): string => join(getBindingsDirectory(), "bindings.json");

const ensureBindingsDirectory = (): void => {
  const directory = getBindingsDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Some platforms do not expose POSIX permissions.
  }
};

const readBindings = (): RemoteJobBinding[] => {
  const path = getBindingsPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) {
      return [];
    }
    return parsed.jobs.flatMap((job): RemoteJobBinding[] =>
      isRecord(job) &&
      typeof job.jobId === "string" &&
      isJobId(job.jobId) &&
      typeof job.workspacePath === "string" &&
      typeof job.workspaceId === "string" &&
      typeof job.profileId === "string" &&
      typeof job.commandHash === "string" &&
      typeof job.displayCommand === "string" &&
      isBackendKind(job.backend) &&
      (job.cancellationPolicy === undefined ||
        isCancellationPolicy(job.cancellationPolicy)) &&
      typeof job.jobTokenHash === "string" &&
      typeof job.createdAt === "string" &&
      typeof job.updatedAt === "string" &&
      isRemoteJobStatus(job.status) &&
      typeof job.revision === "number" &&
      typeof job.lastOutputOffset === "number"
        ? [
            {
              ...job,
              mode: modeFromStoredValue(job.mode),
            } as RemoteJobBinding,
          ]
        : []
    );
  } catch {
    return [];
  }
};

const writeBindings = (jobs: RemoteJobBinding[]): void => {
  ensureBindingsDirectory();
  const path = getBindingsPath();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const content: StoredBindings = { schemaVersion: JOB_SCHEMA_VERSION, jobs };
  writeFileSync(temporaryPath, JSON.stringify(content, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some platforms do not expose POSIX permissions.
  }
};

const upsertBinding = (binding: RemoteJobBinding): RemoteJobBinding => {
  const jobs = readBindings();
  const index = jobs.findIndex((job) => job.jobId === binding.jobId);
  if (index >= 0) {
    jobs[index] = binding;
  } else {
    jobs.push(binding);
  }
  writeBindings(jobs);
  return binding;
};

const updateBinding = (
  jobId: string,
  update: Partial<RemoteJobBinding>
): RemoteJobBinding | null => {
  const jobs = readBindings();
  const index = jobs.findIndex((job) => job.jobId === jobId);
  if (index < 0) {
    return null;
  }
  const binding = { ...jobs[index], ...update, updatedAt: new Date().toISOString() };
  jobs[index] = binding;
  writeBindings(jobs);
  return binding;
};

const getBinding = (jobId: string): RemoteJobBinding | null =>
  readBindings().find((job) => job.jobId === jobId) ?? null;

const commandHash = (command: string): string =>
  createHash("sha256").update(command).digest("hex");

// The exact command can contain secrets in forms that cannot be reliably
// recognized without a shell parser. Keep it only in protected remote job
// files and use a deliberately content-free value in persisted/UI contexts.
const summarizeCommand = (): string => "Remote command";

const pathForJob = (root: string, jobId: string): string => `${root}/${jobId}`;

const powerShellQuote = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const writePosixRemoteState = async (
  sessionId: string,
  jobDirectory: string,
  previous: RemoteJobState,
  next: RemoteJobState
): Promise<RemoteJobState> => {
  const lockPath = `${jobDirectory}/state.lock`;
  const statePath = `${jobDirectory}/state.json`;
  const revisionPath = `${jobDirectory}/revision`;
  const owner = randomUUID();
  const script = [
    "set -eu",
    `state_path=${shellQuote(statePath)}`,
    `revision_path=${shellQuote(revisionPath)}`,
    `lock=${shellQuote(lockPath)}`,
    'lock_owner="$lock/owner"',
    'lock_reclaim="$lock/reclaim"',
    `owner=${shellQuote(owner)}`,
    `expected_revision=${Math.max(0, Math.floor(previous.revision))}`,
    `next_state=${shellQuote(JSON.stringify(next))}`,
    'state_tmp="$state_path.$owner.tmp"',
    'revision_tmp="$revision_path.$owner.tmp"',
    "lock_held=0",
    "owns_state_lock() {",
    '  [ -f "$lock_owner" ] || return 1',
    '  [ ! -e "$lock_reclaim" ] || return 1',
    '  [ "$(sed -n \'1p\' "$lock_owner" 2>/dev/null || true)" = "$owner" ]',
    "}",
    "release_state_lock() {",
    '  rm -f -- "$state_tmp" "$revision_tmp" 2>/dev/null || true',
    '  if [ "$lock_held" -eq 1 ] && owns_state_lock; then',
    '    rm -f -- "$lock_owner" 2>/dev/null || true',
    '    rmdir -- "$lock" 2>/dev/null || true',
    "  fi",
    "  lock_held=0",
    "}",
    "cleanup_state_lock() {",
    "  status=$?",
    "  trap - EXIT HUP INT TERM",
    "  release_state_lock",
    '  exit "$status"',
    "}",
    "trap cleanup_state_lock EXIT",
    "trap 'exit 128' HUP INT TERM",
    "state_lock_is_stale() {",
    '  [ -f "$lock_owner" ] || return 0',
    '  lock_owner_pid=$(sed -n \'2p\' "$lock_owner" 2>/dev/null || true)',
    '  lock_owner_expiry=$(sed -n \'3p\' "$lock_owner" 2>/dev/null || true)',
    '  case "$lock_owner_pid" in ""|*[!0-9]*) return 0 ;; esac',
    '  case "$lock_owner_expiry" in ""|*[!0-9]*) return 0 ;; esac',
    '  lock_now=$(date +%s)',
    '  [ "$lock_now" -ge "$lock_owner_expiry" ] || return 1',
    '  kill -0 "$lock_owner_pid" 2>/dev/null && return 1',
    "  return 0",
    "}",
    "reclaim_stale_state_lock() {",
    '  mkdir -- "$lock_reclaim" 2>/dev/null || return 1',
    '  if ! state_lock_is_stale; then rmdir -- "$lock_reclaim" 2>/dev/null || true; return 1; fi',
    '  rm -f -- "$lock_owner" 2>/dev/null || true',
    '  rmdir -- "$lock_reclaim" 2>/dev/null || return 1',
    '  rmdir -- "$lock" 2>/dev/null',
    "}",
    "acquire_state_lock() {",
    "  attempt=0",
    "  while [ \"$attempt\" -lt " + STATE_LOCK_ATTEMPTS + " ]; do",
    '    if owns_state_lock; then lock_held=1; return 0; fi',
    '    if mkdir -- "$lock" 2>/dev/null; then',
    '      lock_now=$(date +%s)',
    `      (umask 077; printf "%s\\n%s\\n%s\\n" "$owner" "$$" "$((lock_now + ${STATE_LOCK_STALE_SECONDS}))" > "$lock_owner")`,
    '      if owns_state_lock; then lock_held=1; return 0; fi',
    '    else',
    '      reclaim_stale_state_lock || true',
    "    fi",
    "    attempt=$((attempt + 1))",
    "    sleep 0.025",
    "  done",
    "  return 75",
    "}",
    "acquire_state_lock",
    'current_state=$(cat -- "$state_path")',
    'current_revision=$(sed -n \'s/.*"revision"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p\' "$state_path" | head -n 1)',
    'case "$current_revision" in ""|*[!0-9]*) exit 1 ;; esac',
    'if [ "$current_revision" != "$expected_revision" ] || grep -Eq \'"status"[[:space:]]*:[[:space:]]*"(succeeded|failed|timed_out|cancelled|lost|launch_failed|indeterminate)"\' "$state_path"; then',
    '  printf "%s\\n" "$current_state"',
    "  exit 0",
    "fi",
    'next_revision=$((current_revision + 1))',
    '(umask 077; printf "%s\\n" "$next_revision" > "$revision_tmp")',
    'mv -f -- "$revision_tmp" "$revision_path"',
    '(umask 077; printf "%s\\n" "$next_state" > "$state_tmp")',
    'mv -f -- "$state_tmp" "$state_path"',
    'cat -- "$state_path"',
  ].join("\n");
  const output = await executeSshCommand(
    sessionId,
    `sh -lc ${shellQuote(script)}`,
    { timeoutMs: 15_000 }
  );
  return parseRemoteState(JSON.parse(output), previous.jobId);
};

const writeWindowsRemoteState = async (
  sessionId: string,
  jobDirectory: string,
  previous: RemoteJobState,
  next: RemoteJobState
): Promise<RemoteJobState> => {
  const owner = randomUUID();
  const statePath = `${jobDirectory}/state.json`;
  const revisionPath = `${jobDirectory}/revision`;
  const lockPath = `${jobDirectory}/state.lock`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$statePath = ${powerShellQuote(statePath)}`,
    `$revisionPath = ${powerShellQuote(revisionPath)}`,
    `$stateLockPath = ${powerShellQuote(lockPath)}`,
    "$stateLockOwnerPath = Join-Path $stateLockPath 'owner.json'",
    "$stateLockReclaimPath = Join-Path $stateLockPath 'reclaim'",
    `$owner = ${powerShellQuote(owner)}`,
    `$expectedRevision = ${Math.max(0, Math.floor(previous.revision))}`,
    `$nextStateJson = ${powerShellQuote(JSON.stringify(next))}`,
    "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "$lockHeld = $false",
    "function Test-StateLockOwner {",
    "  if (-not (Test-Path -LiteralPath $stateLockOwnerPath) -or (Test-Path -LiteralPath $stateLockReclaimPath)) { return $false }",
    "  try { return ((Get-Content -LiteralPath $stateLockOwnerPath -Raw | ConvertFrom-Json).owner -eq $owner) } catch { return $false }",
    "}",
    "function Exit-StateLock {",
    "  if ($lockHeld -and (Test-StateLockOwner)) {",
    "    Remove-Item -LiteralPath $stateLockOwnerPath -Force -ErrorAction SilentlyContinue",
    "    Remove-Item -LiteralPath $stateLockPath -Force -ErrorAction SilentlyContinue",
    "  }",
    "  $lockHeld = $false",
    "}",
    "function Test-StateLockStale {",
    "  if (-not (Test-Path -LiteralPath $stateLockOwnerPath)) { return $true }",
    "  try { $metadata = Get-Content -LiteralPath $stateLockOwnerPath -Raw | ConvertFrom-Json } catch { return $true }",
    "  if ($metadata.pid -isnot [long] -or $metadata.createdAtEpoch -isnot [long] -or $metadata.processStartTicks -isnot [long]) { return $true }",
    "  $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$metadata.createdAtEpoch",
    `  if ($age -lt ${STATE_LOCK_STALE_SECONDS}) { return $false }`,
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
    "    if (Test-StateLockOwner) { $lockHeld = $true; return }",
    "    try {",
    "      New-Item -ItemType Directory -Path $stateLockPath -ErrorAction Stop | Out-Null",
    "      $metadata = [ordered]@{ owner = $owner; pid = $PID; createdAtEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); processStartTicks = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks }",
    "      [System.IO.File]::WriteAllText($stateLockOwnerPath, ($metadata | ConvertTo-Json -Compress), $utf8NoBom)",
    "      if (Test-StateLockOwner) { $lockHeld = $true; return }",
    "    } catch {",
    "      if (Test-StateLockStale) { [void](Try-ReclaimStateLock) }",
    "    }",
    "    Start-Sleep -Milliseconds 25",
    "  }",
    "  throw 'Remote Job state lock timed out'",
    "}",
    "$result = $null",
    "$revisionTemporary = \"$revisionPath.$owner.tmp\"",
    "$stateTemporary = \"$statePath.$owner.tmp\"",
    "try {",
    "  Enter-StateLock",
    "  $current = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json",
    "  $terminal = $current.status -in @('succeeded','failed','timed_out','cancelled','lost','launch_failed','indeterminate')",
    "  if ([int]$current.revision -ne $expectedRevision -or $terminal) {",
    "    $result = $current",
    "  } else {",
    "    $nextRevision = [int]$current.revision + 1",
    "    [System.IO.File]::WriteAllText($revisionTemporary, [string]$nextRevision, [System.Text.Encoding]::ASCII)",
    "    [System.IO.File]::Replace($revisionTemporary, $revisionPath, $null)",
    "    [System.IO.File]::WriteAllText($stateTemporary, $nextStateJson, $utf8NoBom)",
    "    [System.IO.File]::Replace($stateTemporary, $statePath, $null)",
    "    $result = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json",
    "  }",
    "  [Console]::Out.Write(($result | ConvertTo-Json -Compress))",
    "} finally {",
    "  Remove-Item -LiteralPath $revisionTemporary, $stateTemporary -Force -ErrorAction SilentlyContinue",
    "  Exit-StateLock",
    "}",
  ].join("\r\n");
  const output = await executeSshCommand(
    sessionId,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodeWindowsPowerShell(
      script
    )}`,
    { timeoutMs: 15_000 }
  );
  return parseRemoteState(JSON.parse(output), previous.jobId);
};

const remotePathExists = async (sessionId: string, path: string): Promise<boolean> =>
  (await statSshEntry(sessionId, path)) !== null;

const createRemoteJobDirectory = (
  sessionId: string,
  capabilities: SshCapabilities,
  path: string
): Promise<string> =>
  capabilities.platform === "windows"
    ? createWindowsRemoteDirectory(sessionId, path)
    : runShell(sessionId, `umask 077 && mkdir -- ${shellQuote(path)}`);

const moveRemoteJobDirectory = (
  sessionId: string,
  capabilities: SshCapabilities,
  source: string,
  target: string
): Promise<string> =>
  capabilities.platform === "windows"
    ? moveWindowsRemotePath(sessionId, source, target)
    : runShell(
        sessionId,
        `mv -- ${shellQuote(source)} ${shellQuote(target)}`
      );

const removeRemoteJobPath = (
  sessionId: string,
  capabilities: SshCapabilities,
  path: string
): Promise<string> =>
  capabilities.platform === "windows"
    ? removeWindowsRemotePath(sessionId, path)
    : runShell(sessionId, `rm -rf -- ${shellQuote(path)}`);

const getRemoteJobRoot = async (
  sessionId: string,
  knownCapabilities?: SshCapabilities
): Promise<string> => {
  const capabilities = knownCapabilities ?? (await probeSshCapabilities(sessionId));
  if (capabilities.platform === "windows") {
    return getWindowsRemoteJobRoot(sessionId);
  }
  const root = (
    await executeSshCommand(
      sessionId,
      [
        'state_root="${XDG_STATE_HOME:-$HOME/.local/state}/snow-app/jobs"',
        "umask 077",
        'mkdir -p -- "$state_root"',
        'chmod 700 -- "$state_root"',
        'cd -- "$state_root"',
        "pwd -P",
      ].join("\n"),
      { timeoutMs: 10_000 }
    )
  ).trim();
  if (!root.startsWith("/") || root.includes("\n")) {
    throw new Error("Remote Job state directory is not an absolute POSIX path");
  }
  return normalizeRemotePath(root);
};

const readRemoteJson = async <T>(
  sessionId: string,
  path: string,
  label: string
): Promise<T> => {
  const content = await readSshFile(sessionId, path);
  try {
    return JSON.parse(content.toString("utf8")) as T;
  } catch {
    throw new Error(`Remote Job ${label} is invalid JSON`);
  }
};

const parseRemoteState = (value: unknown, expectedJobId: string): RemoteJobState => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== JOB_SCHEMA_VERSION ||
    value.jobId !== expectedJobId ||
    !isRemoteJobStatus(value.status) ||
    typeof value.revision !== "number" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Remote Job state is malformed");
  }
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: expectedJobId,
    status: value.status,
    revision: Math.max(0, Math.floor(value.revision)),
    backend: isBackendKind(value.backend) ? value.backend : undefined,
    mode: modeFromStoredValue(value.mode),
    runnerPid:
      typeof value.runnerPid === "number" && Number.isInteger(value.runnerPid)
        ? value.runnerPid
        : undefined,
    exitCode:
      typeof value.exitCode === "number" && Number.isInteger(value.exitCode)
        ? value.exitCode
        : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    updatedAt: value.updatedAt,
    completedAt:
      typeof value.completedAt === "string" ? value.completedAt : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    truncated: value.truncated === true ? true : undefined,
  };
};

/** Test-only protocol migration hook; production callers use readRemoteState. */
export const parseRemoteJobStateForTesting = (
  value: unknown,
  expectedJobId: string
): RemoteJobState => parseRemoteState(value, expectedJobId);

/** Test-only local binding migration hook. */
export const getRemoteJobBindingsForTesting = (): RemoteJobBinding[] => readBindings();

const readRemoteState = async (
  sessionId: string,
  jobDirectory: string,
  jobId: string
): Promise<RemoteJobState> =>
  parseRemoteState(
    await readRemoteJson<unknown>(sessionId, `${jobDirectory}/state.json`, "state"),
    jobId
  );

const recoverStaleSnowAgentLaunch = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string,
  jobId: string,
  state: RemoteJobState
): Promise<RemoteJobState> => {
  if (
    state.status !== "launching" ||
    state.backend !== "snow-agent"
  ) {
    return state;
  }

  // `launching` is recoverable only before the runner records `running`.
  // The agent checks its recorded runner PID and atomically reacquires a stale
  // handoff lock, so this never restarts a task that might already be running.
  const active = await inspectSnowAgentJob(
    sessionId,
    capabilities,
    jobDirectory
  ).catch(() => true);
  if (active) {
    return state;
  }
  await launchSnowAgentJob(
    sessionId,
    capabilities,
    jobDirectory,
    jobId
  );
  return readRemoteState(sessionId, jobDirectory, jobId);
};

const writeRemoteState = async (
  sessionId: string,
  jobDirectory: string,
  previous: RemoteJobState,
  update: Partial<RemoteJobState>,
  capabilities: SshCapabilities
): Promise<RemoteJobState> => {
  const next: RemoteJobState = {
    ...previous,
    ...update,
    schemaVersion: JOB_SCHEMA_VERSION,
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  // Keep the conditional read, revision update, state replacement, and lock
  // cleanup in one remote process. A lost SSH channel can no longer strand a
  // client-held lock between independent SFTP operations.
  return capabilities.platform === "windows"
    ? writeWindowsRemoteState(sessionId, jobDirectory, previous, next)
    : writePosixRemoteState(sessionId, jobDirectory, previous, next);
};

const getUnitName = (jobId: string): string =>
  `snow-app-job-${jobId.replace(/-/g, "")}`;

const getTmuxSessionName = (jobId: string): string =>
  `snow-app-${jobId.replace(/-/g, "")}`;

const runShell = (
  sessionId: string,
  script: string,
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<string> =>
  executeSshCommand(sessionId, `sh -lc ${shellQuote(script)}`, { timeoutMs, signal });

const runConfirmedLaunchShell = async (
  sessionId: string,
  script: string,
  signal?: AbortSignal
): Promise<string> => {
  const marker = `__snow_remote_job_launch_${randomUUID()}__`;
  const output = await runShell(
    sessionId,
    [
      "set +e",
      `(${script})`,
      "status=$?",
      `printf '\\n${marker}:%s\\n' \"$status\"`,
      "exit 0",
    ].join("\n"),
    15_000,
    signal
  );
  const match = output.match(new RegExp(`\\n${marker}:(\\d+)\\n?$`));
  if (!match) {
    throw new Error("Remote Job backend launch acknowledgement was not confirmed");
  }
  const status = Number(match[1]);
  if (status !== 0) {
    throw new RemoteJobLaunchRejectedError(
      `Remote Job backend rejected the launch with exit code ${status}`
    );
  }
  return output.slice(0, match.index).trim();
};

const withSystemdUserEnvironment = (command: string): string =>
  [
    'runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'export XDG_RUNTIME_DIR="$runtime_dir"',
    'export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$runtime_dir/bus}"',
    command,
  ].join("\n");

const remoteBackends: Record<RemoteJobBackendKind, RemoteJobBackend> = {
  "snow-agent": {
    kind: "snow-agent",
    isAvailable: canUseSnowAgent,
    async launch(context): Promise<void> {
      await launchSnowAgentJob(
        context.sessionId,
        context.capabilities,
        context.jobDirectory,
        context.jobId,
        context.signal
      );
    },
    async inspect(context): Promise<"active" | "inactive"> {
      return inspectSnowAgentJob(
        context.sessionId,
        context.capabilities,
        context.jobDirectory
      );
    },
    async cancel(context): Promise<void> {
      await cancelSnowAgentJob(
        context.sessionId,
        context.capabilities,
        context.jobDirectory
      );
    },
  },
  "systemd-user": {
    kind: "systemd-user",
    isAvailable: (capabilities) => capabilities.systemdUser,
    async launch(context): Promise<void> {
      const unit = getUnitName(context.jobId);
      const timeoutSeconds = Math.max(1, Math.ceil(context.timeoutMs / 1000));
      // The runner owns timeout handling and needs time to stop the command
      // group before atomically recording its terminal state.
      const runtimeMaxSeconds = timeoutSeconds + SYSTEMD_RUNTIME_GRACE_SECONDS;
      await runConfirmedLaunchShell(
        context.sessionId,
        withSystemdUserEnvironment([
          "systemd-run --user --no-block --quiet",
          `--unit ${shellQuote(unit)}`,
          `--property=${shellQuote(`RuntimeMaxSec=${runtimeMaxSeconds}`)}`,
          `--property=${shellQuote("KillMode=control-group")}`,
          `/bin/sh ${shellQuote(`${context.jobDirectory}/runner.sh`)}`,
        ].join(" ")),
        context.signal
      );
    },
    async inspect(context): Promise<"active" | "inactive"> {
      const unit = getUnitName(context.jobId);
      const output = await runShell(
        context.sessionId,
        withSystemdUserEnvironment(
          `if systemctl --user is-active --quiet ${shellQuote(
            unit
          )}; then printf active; else printf inactive; fi`
        )
      );
      return output.trim() === "active" ? "active" : "inactive";
    },
    async cancel(context): Promise<void> {
      await runShell(
        context.sessionId,
        withSystemdUserEnvironment(
          `systemctl --user stop ${shellQuote(getUnitName(context.jobId))} || true`
        )
      );
    },
  },
  tmux: {
    kind: "tmux",
    isAvailable: (capabilities) => capabilities.tmux,
    async launch(context): Promise<void> {
      await runConfirmedLaunchShell(
        context.sessionId,
        [
          "tmux -L snow-app -f /dev/null new-session -d",
          `-s ${shellQuote(getTmuxSessionName(context.jobId))}`,
          `/bin/sh ${shellQuote(`${context.jobDirectory}/runner.sh`)}`,
        ].join(" "),
        context.signal
      );
    },
    async inspect(context): Promise<"active" | "inactive"> {
      const output = await runShell(
        context.sessionId,
        `if tmux -L snow-app -f /dev/null has-session -t ${shellQuote(
          getTmuxSessionName(context.jobId)
        )} 2>/dev/null; then printf active; else printf inactive; fi`
      );
      return output.trim() === "active" ? "active" : "inactive";
    },
    async cancel(context): Promise<void> {
      await runShell(
        context.sessionId,
        `tmux -L snow-app -f /dev/null kill-session -t ${shellQuote(
          getTmuxSessionName(context.jobId)
        )} 2>/dev/null || true`
      );
    },
  },
  "posix-detach": {
    kind: "posix-detach",
    isAvailable: (capabilities) => capabilities.setsid && capabilities.nohup,
    async launch(context): Promise<void> {
      const output = await runConfirmedLaunchShell(
        context.sessionId,
        `nohup setsid /bin/sh ${shellQuote(
          `${context.jobDirectory}/runner.sh`
        )} </dev/null >/dev/null 2>&1 & printf '%s' "$!"`,
        context.signal
      );
      if (!/^\d+$/.test(output.trim())) {
        throw new Error("POSIX detached backend did not return a runner PID");
      }
    },
    async inspect(context): Promise<"active" | "inactive"> {
      const state = await readRemoteState(
        context.sessionId,
        context.jobDirectory,
        context.jobId
      );
      if (!state.runnerPid) {
        return "inactive";
      }
      const output = await runShell(
        context.sessionId,
        `if kill -0 ${state.runnerPid} 2>/dev/null; then printf active; else printf inactive; fi`
      );
      return output.trim() === "active" ? "active" : "inactive";
    },
    async cancel(context): Promise<void> {
      const state = await readRemoteState(
        context.sessionId,
        context.jobDirectory,
        context.jobId
      );
      if (state.runnerPid) {
        await runShell(
          context.sessionId,
          `kill -TERM -- -${state.runnerPid} 2>/dev/null || kill -TERM ${state.runnerPid} 2>/dev/null || true`
        );
      }
    },
  },
};

const buildCommandScript = (workingDirectory: string, command: string): string =>
  [
    "#!/bin/sh",
    "set -eu",
    `cd -- ${shellQuote(workingDirectory)}`,
    `exec /bin/sh -lc ${shellQuote(command)}`,
    "",
  ].join("\n");

const buildRunnerScript = (jobId: string, createdAt: string): string => [
  "#!/bin/sh",
  "set -eu",
  'job_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
  `job_id=${shellQuote(jobId)}`,
  `created_at=${shellQuote(createdAt)}`,
  'backend=$(cat "$job_dir/backend")',
  'timeout_ms=$(cat "$job_dir/timeout-ms")',
  'log_path="$job_dir/output.log"',
  'revision_path="$job_dir/revision"',
  'state_lock="$job_dir/state.lock"',
  'state_lock_owner="$state_lock/owner"',
  'state_lock_reclaim="$state_lock/reclaim"',
  'state_lock_owner_id="$job_id:$$:$(date +%s)"',
  `state_lock_stale_seconds=${STATE_LOCK_STALE_SECONDS}`,
  'state_lock_held=0',
  'runner_pid="$$"',
  'printf "%s\\n" "$runner_pid" > "$job_dir/runner.pid"',
  "chmod 600 \"$job_dir/runner.pid\" 2>/dev/null || true",
  "ulimit -f 102400 2>/dev/null || true",
  "owns_state_lock() {",
  '  [ -f "$state_lock_owner" ] || return 1',
  '  [ ! -e "$state_lock_reclaim" ] || return 1',
  '  [ "$(sed -n \'1p\' "$state_lock_owner" 2>/dev/null || true)" = "$state_lock_owner_id" ]',
  "}",
  "release_state_lock() {",
  '  if [ "$state_lock_held" -eq 1 ] && owns_state_lock; then',
  '    rm -f -- "$state_lock_owner" 2>/dev/null || true',
  '    rmdir -- "$state_lock" 2>/dev/null || true',
  "  fi",
  "  state_lock_held=0",
  "}",
  "trap 'release_state_lock' EXIT",
  "trap 'exit 128' HUP INT TERM",
  "state_lock_is_stale() {",
  '  [ -f "$state_lock_owner" ] || return 0',
  '  lock_owner_pid=$(sed -n \'2p\' "$state_lock_owner" 2>/dev/null || true)',
  '  lock_owner_started=$(sed -n \'3p\' "$state_lock_owner" 2>/dev/null || true)',
  '  case "$lock_owner_pid" in ""|*[!0-9]*) return 0 ;; esac',
  '  case "$lock_owner_started" in ""|*[!0-9]*) return 0 ;; esac',
  '  lock_now=$(date +%s)',
  '  [ "$lock_now" -ge "$lock_owner_started" ] || return 1',
  '  [ $((lock_now - lock_owner_started)) -ge "$state_lock_stale_seconds" ] || return 1',
  '  kill -0 "$lock_owner_pid" 2>/dev/null && return 1',
  "  return 0",
  "}",
  "reclaim_stale_state_lock() {",
  '  mkdir -- "$state_lock_reclaim" 2>/dev/null || return 1',
  '  if ! state_lock_is_stale; then rmdir -- "$state_lock_reclaim" 2>/dev/null || true; return 1; fi',
  '  rm -f -- "$state_lock_owner" 2>/dev/null || true',
  '  rmdir -- "$state_lock_reclaim" 2>/dev/null || return 1',
  '  rmdir -- "$state_lock" 2>/dev/null',
  "}",
  "acquire_state_lock() {",
  "  i=0",
  `  while [ "$i" -lt ${STATE_LOCK_ATTEMPTS} ]; do`,
  '    if owns_state_lock; then state_lock_held=1; return 0; fi',
  '    if mkdir -- "$state_lock" 2>/dev/null; then',
  '      lock_now=$(date +%s)',
  '      (umask 077; printf "%s\\n%s\\n%s\\n" "$state_lock_owner_id" "$$" "$lock_now" > "$state_lock_owner")',
  '      if owns_state_lock; then state_lock_held=1; return 0; fi',
  "    else",
  "      reclaim_stale_state_lock || true",
  "    fi",
  '    i=$((i + 1))',
  '    sleep 0.025',
  "  done",
  "  return 75",
  "}",
  "next_revision() {",
  '  current=$(cat "$revision_path" 2>/dev/null || printf 0)',
  '  current=$((current + 1))',
  '  printf "%s\\n" "$current" > "$revision_path"',
  '  printf "%s" "$current"',
  "}",
  "write_state() {",
  '  status="$1"',
  '  exit_code="${2:-null}"',
  '  reason="${3:-}"',
  '  acquire_state_lock || return $?',
  "  if [ -f \"$job_dir/state.json\" ] && grep -Eq '\"status\":\"(succeeded|failed|timed_out|cancelled|lost|launch_failed|indeterminate)\"' \"$job_dir/state.json\"; then",
  '    release_state_lock',
  '    return 0',
  '  fi',
  '  revision=$(next_revision)',
  '  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")',
  '  completed=""',
  '  case "$status" in succeeded|failed|timed_out|cancelled|lost|launch_failed|indeterminate) completed=",\\"completedAt\\":\\"$now\\"" ;; esac',
  '  reason_json=""',
  '  if [ -n "$reason" ]; then reason_json=",\\"reason\\":\\"$reason\\"" ; fi',
  '  printf "{\\"schemaVersion\\":1,\\"jobId\\":\\"%s\\",\\"status\\":\\"%s\\",\\"revision\\":%s,\\"backend\\":\\"%s\\",\\"runnerPid\\":%s,\\"createdAt\\":\\"%s\\",\\"updatedAt\\":\\"%s\\"%s%s,\\"exitCode\\":%s}\\n" "$job_id" "$status" "$revision" "$backend" "$runner_pid" "$created_at" "$now" "$completed" "$reason_json" "$exit_code" > "$job_dir/state.json.tmp"',
  '  mv -f -- "$job_dir/state.json.tmp" "$job_dir/state.json"',
  '  release_state_lock',
  "}",
  'write_state launching null ""',
  'write_state running null ""',
  'if [ -f "$job_dir/cancel.request" ]; then',
  '  write_state cancelled null "cancelled before command start"',
  '  exit 0',
  "fi",
  'timeout_seconds=$(( (timeout_ms + 999) / 1000 ))',
  "signal_command_group() {",
  '  signal="$1"',
  '  if [ -x /bin/kill ]; then',
  '    /bin/kill -"$signal" -- "-$command_pgid" 2>/dev/null || true',
  '  elif [ -x /usr/bin/kill ]; then',
  '    /usr/bin/kill -"$signal" -- "-$command_pgid" 2>/dev/null || true',
  '  else',
  '    kill -"$signal" "-$command_pgid" 2>/dev/null || true',
  '  fi',
  "}",
  "terminate_command_group() {",
  '  signal="$1"',
  '  signal_command_group "$signal"',
  "}",
  "command_group_active() {",
  '  if [ -x /bin/kill ]; then',
  '    /bin/kill -0 -- "-$command_pgid" 2>/dev/null',
  '  elif [ -x /usr/bin/kill ]; then',
  '    /usr/bin/kill -0 -- "-$command_pgid" 2>/dev/null',
  '  else',
  '    kill -0 "-$command_pgid" 2>/dev/null',
  '  fi',
  "}",
  'setsid /bin/sh "$job_dir/command.sh" >> "$log_path" 2>&1 &',
  'command_pid="$!"',
  'command_pgid="$command_pid"',
  'printf "%s\\n" "$command_pid" > "$job_dir/command.pid"',
  'printf "%s\\n" "$command_pgid" > "$job_dir/command.pgid"',
  '( sleep "$timeout_seconds"; touch "$job_dir/timeout.request" ) &',
  'watchdog_pid="$!"',
  'cancelled=0',
  'timed_out=0',
  'termination_deadline=0',
  'while command_group_active; do',
  '  if [ -f "$job_dir/timeout.request" ] && [ "$timed_out" -eq 0 ]; then',
  '    timed_out=1',
  `    termination_deadline=$(( $(date +%s) + ${POSIX_CANCEL_GRACE_SECONDS} ))`,
  '    terminate_command_group TERM',
  '  elif [ -f "$job_dir/cancel.request" ] && [ "$cancelled" -eq 0 ] && [ "$timed_out" -eq 0 ]; then',
  '    cancelled=1',
  `    termination_deadline=$(( $(date +%s) + ${POSIX_CANCEL_GRACE_SECONDS} ))`,
  '    terminate_command_group TERM',
  '  elif [ "$termination_deadline" -gt 0 ] && [ "$(date +%s)" -ge "$termination_deadline" ]; then',
  '    terminate_command_group KILL',
  '    termination_deadline=$(( $(date +%s) + 1 ))',
  "  fi",
  `  sleep ${POSIX_RUNNER_POLL_SECONDS}`,
  "done",
  'wait "$command_pid" || command_exit_code="$?"',
  'command_exit_code="${command_exit_code:-0}"',
  'kill "$watchdog_pid" 2>/dev/null || true',
  'wait "$watchdog_pid" 2>/dev/null || true',
  'if [ -f "$job_dir/timeout.request" ]; then',
  '  write_state timed_out "$command_exit_code" "timeout"',
  'elif [ "$cancelled" -eq 1 ] || [ -f "$job_dir/cancel.request" ]; then',
  '  write_state cancelled "$command_exit_code" "cancelled"',
  'elif [ "$command_exit_code" -eq 0 ]; then',
  '  write_state succeeded 0 ""',
  "else",
  '  write_state failed "$command_exit_code" "exit"',
  "fi",
  "",
].join("\n");

const backendProbeScript = (markerPath: string): string =>
  `sleep 1; printf ok > ${shellQuote(markerPath)}`;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const verifyBackendLiveness = async (
  workspacePath: string,
  backend: RemoteJobBackend,
  capabilities: SshCapabilities,
  mode: RemoteJobMode
): Promise<boolean> => {
  if (!backend.isAvailable(capabilities)) {
    return false;
  }
  const cacheKey = `${workspacePath}|${backend.kind}|${mode}`;
  const cachedUntil =
    mode === "interactive" ? undefined : BACKEND_PROBE_CACHE.get(cacheKey);
  if (cachedUntil && cachedUntil > Date.now()) {
    return true;
  }

  const probeId = randomUUID();
  try {
    if (backend.kind === "snow-agent") {
      const initial = await withSshSession(workspacePath, async (sessionId) => {
        const agent = await negotiateSnowAgent(sessionId, capabilities);
        if (mode === "interactive") {
          try {
            await probeSshPty(sessionId);
          } catch (error) {
            throw new RemoteJobUnavailableError(
              "PTY_UNAVAILABLE",
              `SSH server did not permit PTY allocation: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          if (!supportsSnowAgentInteractiveAttach(agent.capabilities)) {
            throw new RemoteJobUnavailableError(
              "PTY_UNAVAILABLE",
              "The signed Snow Agent does not support interactive attach protocol v1"
            );
          }
          const interactiveCacheKey = `${cacheKey}|${agent.artifactSha256}|${
            agent.capabilities.interactiveAttachProtocolVersion
          }`;
          const cachedUntil = BACKEND_PROBE_CACHE.get(interactiveCacheKey);
          if (cachedUntil && cachedUntil > Date.now()) {
            return {
              agent,
              interactive: undefined,
              batch: undefined,
              interactiveCached: true,
              interactiveCacheKey,
            };
          }
          return {
            agent,
            interactive: await startSnowAgentInteractiveProbe(sessionId, capabilities),
            batch: undefined,
            interactiveCached: false,
            interactiveCacheKey,
          };
        }
        return {
          agent,
          batch: await startSnowAgentLivenessProbe(sessionId, capabilities),
          interactive: undefined,
          interactiveCached: false,
          interactiveCacheKey: undefined,
        };
      });
      await withSshSession(workspacePath, async (sessionId) => {
        if (initial.interactiveCached) {
          return;
        }
        if (initial.interactive) {
          const deadline = Date.now() + 3_000;
          let lastError: unknown;
          while (Date.now() < deadline) {
            try {
              await verifySnowAgentInteractiveProbe(
                sessionId,
                capabilities,
                initial.interactive
              );
              BACKEND_PROBE_CACHE.set(
                initial.interactiveCacheKey!,
                Date.now() + BACKEND_PROBE_CACHE_MS
              );
              return;
            } catch (error) {
              lastError = error;
              await wait(125);
            }
          }
          throw new RemoteJobUnavailableError(
            "DISCONNECT_PROBE_FAILED",
            `Snow Agent PTY disconnect probe failed: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }`
          );
        }
        const probe = initial.batch;
        if (!probe) {
          throw new Error("snow-agent liveness probe did not return a batch receipt");
        }
        const root = await getRemoteJobRoot(sessionId, capabilities);
        const marker = `${root}/.snow-agent-self-test-${probe.probeId}`;
        const deadline = Date.now() + 3_000;
        try {
          while (Date.now() < deadline) {
            if (await remotePathExists(sessionId, marker)) {
              const content = await readSshFile(sessionId, marker);
              if (content.toString("utf8") === probe.markerToken) {
                return;
              }
              throw new Error("snow-agent disconnect-survival marker token mismatched");
            }
            await wait(125);
          }
          throw new Error(
            "snow-agent detached runner did not write its marker after the SSH disconnect"
          );
        } finally {
          await runShell(sessionId, `rm -f -- ${shellQuote(marker)}`).catch(
            () => undefined
          );
        }
      });
      if (mode === "batch") {
        BACKEND_PROBE_CACHE.set(cacheKey, Date.now() + BACKEND_PROBE_CACHE_MS);
      }
      return true;
    }
    await withSshSession(workspacePath, async (sessionId) => {
      const root = await getRemoteJobRoot(sessionId, capabilities);
      const marker = `${root}/.backend-probe-${probeId}`;
      const probeScript = backendProbeScript(marker);
      if (backend.kind === "systemd-user") {
        await runShell(
          sessionId,
          withSystemdUserEnvironment([
            "exec systemd-run --user --no-block --quiet",
            `--unit ${shellQuote(`snow-app-probe-${probeId.replace(/-/g, "")}`)}`,
            `/bin/sh -lc ${shellQuote(probeScript)}`,
          ].join(" "))
        );
      } else if (backend.kind === "tmux") {
        await runShell(
          sessionId,
          [
            "tmux -L snow-app -f /dev/null new-session -d",
            `-s ${shellQuote(`snow-probe-${probeId.replace(/-/g, "")}`)}`,
            `/bin/sh -lc ${shellQuote(probeScript)}`,
          ].join(" ")
        );
      } else {
        await runShell(
          sessionId,
          `nohup setsid /bin/sh -lc ${shellQuote(
            probeScript
          )} </dev/null >/dev/null 2>&1 &`
        );
      }
    });
    await withSshSession(workspacePath, async (sessionId) => {
      const root = await getRemoteJobRoot(sessionId, capabilities);
      const marker = `${root}/.backend-probe-${probeId}`;
      const deadline = Date.now() + 1_250;
      while (Date.now() < deadline) {
        if (await remotePathExists(sessionId, marker)) {
          const content = await readSshFile(sessionId, marker);
          if (content.toString("utf8") === "ok") {
            await runShell(sessionId, `rm -f -- ${shellQuote(marker)}`);
            return;
          }
        }
        await wait(125);
      }
      throw new Error(
        "Remote backend did not survive the SSH disconnect: detached process did not start"
      );
    });
    BACKEND_PROBE_CACHE.set(cacheKey, Date.now() + BACKEND_PROBE_CACHE_MS);
    BACKEND_PROBE_FAILURES.delete(cacheKey);
    return true;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    BACKEND_PROBE_FAILURES.set(
      cacheKey,
      reason
    );
    return false;
  }
};

const selectBackend = async (
  workspacePath: string,
  requested: RemoteJobBackendKind | undefined,
  mode: RemoteJobMode
): Promise<RemoteJobBackend> => {
  const capabilities = await withSshSession(workspacePath, async (sessionId) =>
    probeSshCapabilities(sessionId)
  );
  assertDurableJobPlatformSupported(capabilities.platform);
  if (mode === "interactive" && requested && requested !== "snow-agent") {
    throw new RemoteJobUnavailableError(
      "PTY_UNAVAILABLE",
      "Interactive Remote Jobs require the signed Snow Agent PTY broker"
    );
  }
  if (mode === "interactive" && !canUseSnowAgent(capabilities)) {
    throw new RemoteJobUnavailableError(
      "UNSUPPORTED_ARCH",
      "Interactive Remote Jobs support Linux x86_64 and aarch64 only"
    );
  }
  const candidates =
    mode === "interactive"
      ? [remoteBackends["snow-agent"]]
      : requested
        ? [remoteBackends[requested]]
        : [
            remoteBackends["snow-agent"],
            remoteBackends["systemd-user"],
            remoteBackends.tmux,
            remoteBackends["posix-detach"],
          ];
  for (const backend of candidates) {
    if (await verifyBackendLiveness(workspacePath, backend, capabilities, mode)) {
      return backend;
    }
  }
  const probedBackend = requested ?? (mode === "interactive" ? "snow-agent" : undefined);
  const probeFailure = probedBackend
    ? BACKEND_PROBE_FAILURES.get(`${workspacePath}|${probedBackend}|${mode}`)
    : undefined;
  if (mode === "interactive") {
    const code = /^\[(UNSUPPORTED_ARCH|SFTP_UNAVAILABLE|AGENT_HOME_NOEXEC|PTY_UNAVAILABLE|SIGNATURE_INVALID|DISCONNECT_PROBE_FAILED)\]/.exec(
      probeFailure ?? ""
    )?.[1] ?? "DISCONNECT_PROBE_FAILED";
    throw new RemoteJobUnavailableError(
      code,
      `Interactive Snow Agent is unavailable${probeFailure ? `: ${probeFailure}` : ""}`
    );
  }
  throw new Error(
    requested
      ? `Remote Job backend ${requested} is unavailable or failed disconnect verification${
          probeFailure ? `: ${probeFailure}` : ""
        }`
      : "No Remote Job backend passed disconnect verification"
  );
};

const getRemoteOutput = async (
  sessionId: string,
  outputPath: string,
  offset: number,
  limit: number
): Promise<Buffer> => {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const normalizedLimit = Math.min(
    MAX_OUTPUT_READ_BYTES,
    Math.max(1, Math.floor(limit))
  );
  return readSshFileRange(sessionId, outputPath, {
    offset: normalizedOffset,
    length: normalizedLimit,
  });
};

const classifyRemoteJobFileTransferError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  if (/sftp|remote file|write stream|ssh session not found/i.test(message)) {
    throw new RemoteJobUnavailableError(
      "REMOTE_FILE_TRANSFER_UNAVAILABLE",
      `Remote Job requires SFTP to create its protected task directory: ${message}`
    );
  }
  throw error;
};

const buildBinding = (params: {
  jobId: string;
  workspacePath: string;
  workspaceId: string;
  command: string;
  backend: RemoteJobBackendKind;
  mode: RemoteJobMode;
  jobTokenHash: string;
  createdAt: string;
  cancellationPolicy: RemoteJobCancellationPolicy;
  conversationId?: string;
  toolCallId?: string;
}): RemoteJobBinding => ({
  jobId: params.jobId,
  workspacePath: params.workspacePath,
  workspaceId: params.workspaceId,
  profileId: params.workspacePath.replace(/^ssh:\/\//, "").split("/")[0],
  commandHash: commandHash(params.command),
  displayCommand: summarizeCommand(),
  backend: params.backend,
  mode: params.mode,
  cancellationPolicy: params.cancellationPolicy,
  jobTokenHash: params.jobTokenHash,
  createdAt: params.createdAt,
  updatedAt: params.createdAt,
  status: "preparing",
  revision: 0,
  conversationId: params.conversationId,
  toolCallId: params.toolCallId,
  lastOutputOffset: 0,
});

const readExistingJob = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string,
  expected: RemoteJobBinding,
  trustedJobTokenHash?: string
): Promise<RemoteJobBinding> => {
  const manifest = await readRemoteJson<Record<string, unknown>>(
    sessionId,
    `${jobDirectory}/manifest.json`,
    "manifest"
  );
  if (
    manifest.jobId !== expected.jobId ||
    manifest.commandHash !== expected.commandHash ||
    manifest.workspacePath !== expected.workspacePath ||
    modeFromStoredValue(manifest.mode) !== expected.mode
  ) {
    throw new Error("JOB_ID_COLLISION: jobId already belongs to another command");
  }
  if (
    typeof manifest.jobTokenHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(manifest.jobTokenHash)
  ) {
    throw new Error("Remote Job manifest has an invalid cleanup token");
  }
  if (trustedJobTokenHash && manifest.jobTokenHash !== trustedJobTokenHash) {
    throw new Error("JOB_ID_COLLISION: jobId cleanup token does not match the local Binding");
  }
  const state = await recoverStaleSnowAgentLaunch(
    sessionId,
    capabilities,
    jobDirectory,
    expected.jobId,
    await readRemoteState(sessionId, jobDirectory, expected.jobId)
  );
  return {
    ...expected,
    jobTokenHash: manifest.jobTokenHash,
    createdAt:
      typeof manifest.createdAt === "string"
        ? manifest.createdAt
        : expected.createdAt,
    backend:
      state.backend ??
      (isBackendKind(manifest.backend) ? manifest.backend : expected.backend),
    cancellationPolicy: isCancellationPolicy(manifest.cancellationPolicy)
      ? manifest.cancellationPolicy
      : expected.cancellationPolicy ?? "cancel_remote",
    mode: modeFromStoredValue(manifest.mode ?? state.mode),
    status: state.status,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
};

export const startRemoteJob = async (
  request: RemoteJobStartRequest,
  options?: RemoteJobStartOptions
): Promise<RemoteJobBinding> => {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new Error("Remote Job start was cancelled before submission");
  }
  const workspacePath = normalizeWorkspacePath(request.workspacePath);
  const command = request.command;
  if (!command.trim()) {
    throw new Error("Remote Job command is required");
  }
  if (Buffer.byteLength(command, "utf8") > 512 * 1024) {
    throw new Error("Remote Job command is too large");
  }
  const jobId = request.jobId?.trim() || randomUUID();
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  if (request.backend !== undefined && !isBackendKind(request.backend)) {
    throw new Error("Unknown Remote Job backend");
  }
  if (request.mode !== undefined && !isRemoteJobMode(request.mode)) {
    throw new Error("Unknown Remote Job mode");
  }
  const timeoutMs = normalizeTimeout(request.timeoutMs);
  const mode = request.mode ?? "batch";
  const existingBinding = getBinding(jobId);
  const requestedCommandHash = commandHash(command);
  if (
    existingBinding &&
    (existingBinding.workspacePath !== workspacePath ||
      existingBinding.commandHash !== requestedCommandHash ||
      existingBinding.mode !== mode)
  ) {
    throw new Error("JOB_ID_COLLISION: jobId already belongs to another command");
  }

  const createdAt = existingBinding?.createdAt ?? new Date().toISOString();
  const cancellationPolicy =
    options?.cancellationPolicy ??
    existingBinding?.cancellationPolicy ??
    "cancel_remote";
  const bindingFor = (backend: RemoteJobBackendKind): RemoteJobBinding =>
    buildBinding({
      jobId,
      workspacePath,
      workspaceId:
        existingBinding?.workspaceId ??
        request.workspaceId?.trim() ??
        workspacePath,
      command,
      backend,
      mode: existingBinding?.mode ?? mode,
      jobTokenHash:
        existingBinding?.jobTokenHash ??
        createHash("sha256").update(randomUUID()).digest("hex"),
      createdAt,
      cancellationPolicy,
      conversationId:
        existingBinding?.conversationId ??
        request.conversationId?.trim() ??
        undefined,
      toolCallId:
        existingBinding?.toolCallId ?? request.toolCallId?.trim() ?? undefined,
    });

  const recoveryBinding = bindingFor(
    existingBinding?.backend ?? request.backend ?? "posix-detach"
  );

  let recovered: RemoteJobBinding | null;
  try {
    recovered = await withSshSession(workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    assertDurableJobPlatformSupported(capabilities.platform);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    let existing: boolean;
    try {
      existing = await remotePathExists(sessionId, jobDirectory);
    } catch (error) {
      // Every durable job needs SFTP, including the idempotency lookup before
      // backend selection. Do not present an unavailable transfer channel as a
      // backend failure or silently fall back to a shell-only job.
      throw new RemoteJobUnavailableError(
        "REMOTE_FILE_TRANSFER_UNAVAILABLE",
        `Remote Job requires SFTP to inspect its protected task directory: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!existing) {
      return null;
    }
    return readExistingJob(
      sessionId,
      capabilities,
      jobDirectory,
      recoveryBinding,
      existingBinding?.jobTokenHash
    );
    }, { signal });
  } catch (error) {
    classifyRemoteJobFileTransferError(error);
  }
  if (recovered) {
    upsertBinding(recovered);
    return recovered;
  }

  const backend = await selectBackend(workspacePath, request.backend, mode);
  if (signal?.aborted) {
    throw new Error("Remote Job start was cancelled before durable submission");
  }
  const binding = bindingFor(backend.kind);
  upsertBinding(binding);

  try {
    return await withSshSession(workspacePath, async (sessionId) => {
      const capabilities = await probeSshCapabilities(sessionId);
      const root = await getRemoteJobRoot(sessionId, capabilities);
      const jobDirectory = pathForJob(root, jobId);
      if (await remotePathExists(sessionId, jobDirectory)) {
        const recoveredExisting = await readExistingJob(
          sessionId,
          capabilities,
          jobDirectory,
          binding,
          existingBinding?.jobTokenHash
        );
        upsertBinding(recoveredExisting);
        return recoveredExisting;
      }

      const temporaryDirectory = `${root}/.${jobId}.${randomUUID()}.tmp`;
      const manifest = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        jobTokenHash: binding.jobTokenHash,
        workspacePath,
        commandHash: binding.commandHash,
        displayCommand: binding.displayCommand,
        createdAt,
        timeoutMs,
        backend: backend.kind,
        mode,
        cancellationPolicy,
      };
      const agentRequest = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        jobTokenHash: binding.jobTokenHash,
        workspacePath,
        workingDirectory: normalizeRemotePath(
          workspacePath.replace(/^ssh:\/\/[^/]+/, "") || "/"
        ).replace(/^\/([A-Za-z]:\/)/, "$1"),
        command,
        timeoutMs,
        mode,
        createdAt,
        resourceLimits: {
          maxLogBytes: MAX_REMOTE_JOB_LOG_BYTES,
          maxRuntimeMs: timeoutMs,
        },
      };
      const initialState: RemoteJobState = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        status: "preparing",
        revision: 0,
        backend: backend.kind,
        mode,
        createdAt,
        updatedAt: createdAt,
      };

      await createRemoteJobDirectory(sessionId, capabilities, temporaryDirectory);
      const workingDirectory = normalizeRemotePath(
        workspacePath.replace(/^ssh:\/\/[^/]+/, "") || "/"
      ).replace(/^\/([A-Za-z]:\/)/, "$1");
      const jobFiles = [
        writeInternalSshFile(
          sessionId,
          `${temporaryDirectory}/command.sh`,
          buildCommandScript(workingDirectory, command)
        ),
        writeInternalSshFile(
          sessionId,
          `${temporaryDirectory}/runner.sh`,
          buildRunnerScript(jobId, createdAt)
        ),
      ];
      try {
        await Promise.all([
          ...jobFiles,
          writeInternalSshFile(
            sessionId,
            `${temporaryDirectory}/manifest.json`,
            `${JSON.stringify(manifest)}\n`
          ),
          writeInternalSshFile(
            sessionId,
            `${temporaryDirectory}/agent-request.json`,
            `${JSON.stringify(agentRequest)}\n`
          ),
          writeInternalSshFile(sessionId, `${temporaryDirectory}/backend`, `${backend.kind}\n`),
          writeInternalSshFile(sessionId, `${temporaryDirectory}/timeout-ms`, `${timeoutMs}\n`),
          writeInternalSshFile(sessionId, `${temporaryDirectory}/revision`, "0\n"),
          writeInternalSshFile(
            sessionId,
            `${temporaryDirectory}/state.json`,
            `${JSON.stringify(initialState)}\n`
          ),
          writeInternalSshFile(sessionId, `${temporaryDirectory}/output.log`, ""),
        ]);
      } catch (error) {
        await removeRemoteJobPath(sessionId, capabilities, temporaryDirectory).catch(
          () => undefined
        );
        classifyRemoteJobFileTransferError(error);
      }
      if (signal?.aborted) {
        await removeRemoteJobPath(sessionId, capabilities, temporaryDirectory).catch(
          () => undefined
        );
        throw new Error("Remote Job start was cancelled before durable submission");
      }
      await runShell(
        sessionId,
        `chmod 700 -- ${shellQuote(
          `${temporaryDirectory}/command.sh`
        )} ${shellQuote(`${temporaryDirectory}/runner.sh`)} && chmod 600 -- ${shellQuote(
          `${temporaryDirectory}/manifest.json`
        )} ${shellQuote(`${temporaryDirectory}/agent-request.json`
        )} ${shellQuote(`${temporaryDirectory}/state.json`)} ${shellQuote(
          `${temporaryDirectory}/backend`
        )} ${shellQuote(`${temporaryDirectory}/timeout-ms`)}`
      );
      if (signal?.aborted) {
        await removeRemoteJobPath(sessionId, capabilities, temporaryDirectory).catch(
          () => undefined
        );
        throw new Error("Remote Job start was cancelled before durable submission");
      }
      try {
        await moveRemoteJobDirectory(
          sessionId,
          capabilities,
          temporaryDirectory,
          jobDirectory
        );
      } catch (error) {
        const existingAfterRace = await remotePathExists(sessionId, jobDirectory).catch(
          () => false
        );
        if (existingAfterRace) {
          const recoveredExisting = await readExistingJob(
            sessionId,
            capabilities,
            jobDirectory,
            binding,
            existingBinding?.jobTokenHash
          );
          upsertBinding(recoveredExisting);
          return recoveredExisting;
        }
        throw error;
      }
      const cancelBeforeLaunch = async (): Promise<RemoteJobBinding> => {
        const cancelled = await writeRemoteState(
          sessionId,
          jobDirectory,
          initialState,
          {
            status: "cancelled",
            reason: "cancelled before remote backend launch",
          },
          capabilities
        );
        const updated = {
          ...binding,
          status: cancelled.status,
          revision: cancelled.revision,
          updatedAt: cancelled.updatedAt,
          lastError: cancelled.reason,
        };
        upsertBinding(updated);
        return updated;
      };
      if (signal?.aborted) {
        return cancelBeforeLaunch();
      }
      if (backend.kind !== "snow-agent") {
        await createRemoteJobDirectory(
          sessionId,
          capabilities,
          `${jobDirectory}/launch.lock`
        );
      }
      if (signal?.aborted) {
        return cancelBeforeLaunch();
      }

      try {
        const launching = await writeRemoteState(
          sessionId,
          jobDirectory,
          initialState,
          { status: "launching", backend: backend.kind },
          capabilities
        );
        await backend.launch({
          sessionId,
          jobDirectory,
          jobId,
          timeoutMs,
          capabilities,
          mode,
          signal,
        });
        if (signal?.aborted && cancellationPolicy === "cancel_remote") {
          await writeInternalSshFile(
            sessionId,
            `${jobDirectory}/cancel.request`,
            `${new Date().toISOString()}\n`
          ).catch(() => undefined);
        }
        const observed = await readRemoteState(sessionId, jobDirectory, jobId).catch(
          () => launching
        );
        const accepted: RemoteJobBinding = {
          ...binding,
          status: observed.status,
          revision: observed.revision,
          updatedAt: observed.updatedAt,
          lastError: signal?.aborted
            ? cancellationPolicy === "cancel_remote"
              ? "cancellation requested after remote launch acknowledgement"
              : "local wait detached after remote launch acknowledgement"
            : undefined,
        };
        upsertBinding(accepted);
        return accepted;
      } catch (error) {
        const current = await readRemoteState(sessionId, jobDirectory, jobId).catch(
          () => initialState
        );
        if (signal?.aborted && cancellationPolicy === "cancel_remote") {
          await writeInternalSshFile(
            sessionId,
            `${jobDirectory}/cancel.request`,
            `${new Date().toISOString()}\n`
          ).catch(() => undefined);
          const updated = {
            ...binding,
            status: current.status,
            revision: current.revision,
            updatedAt: current.updatedAt,
            lastError: "cancellation requested; awaiting remote runner confirmation",
          };
          upsertBinding(updated);
          return updated;
        }
        const confirmedRejection = error instanceof RemoteJobLaunchRejectedError;
        const outcome = await writeRemoteState(
          sessionId,
          jobDirectory,
          current,
          {
            status: confirmedRejection ? "launch_failed" : "indeterminate",
            reason:
              confirmedRejection && error instanceof Error
                ? error.message.slice(0, 240)
                : error instanceof Error
                ? `launch acknowledgement was not confirmed: ${error.message.slice(0, 240)}`
                : "launch acknowledgement was not confirmed",
          },
          capabilities
        ).catch(() => ({
          ...current,
          status: confirmedRejection
            ? ("launch_failed" as const)
            : ("indeterminate" as const),
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        }));
        const updated = {
          ...binding,
          status: outcome.status,
          revision: outcome.revision,
          updatedAt: outcome.updatedAt,
          lastError: outcome.reason,
        };
        upsertBinding(updated);
        return updated;
      }
    }, { signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = getBinding(jobId);
    if (
      !signal?.aborted &&
      (current?.status === "preparing" || current?.status === "launching")
    ) {
      updateBinding(jobId, {
        status: "indeterminate",
        lastError: message,
      });
    } else if (signal?.aborted) {
      updateBinding(jobId, {
        lastError: "Remote Job start was cancelled before durable submission",
      });
    }
    throw error;
  }
};

export const getRemoteJob = async (
  jobId: string,
  options?: { offset?: number; limit?: number }
): Promise<RemoteJobOutput> => {
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  const binding = getBinding(jobId);
  if (!binding) {
    throw new Error("Remote Job binding was not found");
  }
  const offset = Math.max(0, Math.floor(options?.offset ?? binding.lastOutputOffset));
  const limit = Math.min(
    MAX_OUTPUT_READ_BYTES,
    Math.max(1, Math.floor(options?.limit ?? MAX_OUTPUT_READ_BYTES))
  );
  return withSshSession(binding.workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    const state = await readRemoteState(sessionId, jobDirectory, jobId);
    let resolvedState = await recoverStaleSnowAgentLaunch(
      sessionId,
      capabilities,
      jobDirectory,
      jobId,
      state
    );
    if (resolvedState.status === "running") {
      const backend = remoteBackends[resolvedState.backend ?? binding.backend];
      const activity = await backend
        .inspect({
          sessionId,
          jobDirectory,
          jobId,
          timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
          capabilities,
          mode: binding.mode,
        })
        .catch(() => "active" as const);
      if (activity === "inactive") {
        // A runner writes its terminal state just before it exits. Re-read it
        // after a short settle period so an inactive probe cannot turn that
        // terminal update into a stale `lost` state.
        await wait(INACTIVE_RUNNER_SETTLE_MS);
        const settledState = await readRemoteState(sessionId, jobDirectory, jobId);
        resolvedState = TERMINAL_STATUSES.has(settledState.status)
          ? settledState
          : await writeRemoteState(
              sessionId,
              jobDirectory,
              settledState,
              {
                status: "lost",
                reason: "backend inactive before a terminal state was recorded",
              },
              capabilities
            );
      }
    }
    const outputBytes = await getRemoteOutput(
      sessionId,
      `${jobDirectory}/output.log`,
      offset,
      limit
    );
    const output = outputBytes.toString("utf8");
    const updated = {
      ...binding,
      backend: resolvedState.backend ?? binding.backend,
      status: resolvedState.status,
      revision: resolvedState.revision,
      updatedAt: resolvedState.updatedAt,
      lastOutputOffset: offset + outputBytes.length,
    };
    upsertBinding(updated);
    return {
      job: updated,
      state: resolvedState,
      output,
      outputBytes,
      offset,
      nextOffset: updated.lastOutputOffset,
      eof: outputBytes.length < limit,
    };
  });
};

export const listRemoteJobs = async (
  workspacePath?: string
): Promise<RemoteJobBinding[]> => {
  const normalizedWorkspace = workspacePath
    ? normalizeWorkspacePath(workspacePath)
    : undefined;
  const jobs = readBindings().filter(
    (job) => !normalizedWorkspace || job.workspacePath === normalizedWorkspace
  );
  const refreshed = await Promise.all(
    jobs.map(async (job) => {
      try {
        return (await getRemoteJob(job.jobId, { offset: job.lastOutputOffset, limit: 1 }))
          .job;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return updateBinding(job.jobId, { lastError: message }) ?? job;
      }
    })
  );
  return refreshed.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

export const cancelRemoteJob = async (jobId: string): Promise<RemoteJobBinding> => {
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  const binding = getBinding(jobId);
  if (!binding) {
    throw new Error("Remote Job binding was not found");
  }
  return withSshSession(binding.workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    const state = await readRemoteState(sessionId, jobDirectory, jobId);
    if (TERMINAL_STATUSES.has(state.status)) {
      const unchanged = {
        ...binding,
        status: state.status,
        revision: state.revision,
        updatedAt: state.updatedAt,
      };
      upsertBinding(unchanged);
      return unchanged;
    }
    // The runner owns process termination and is the only writer that can
    // confirm `cancelled`. A request alone must not be presented as completion.
    await writeInternalSshFile(
      sessionId,
      `${jobDirectory}/cancel.request`,
      `${new Date().toISOString()}\n`
    );
    const observed = await readRemoteState(sessionId, jobDirectory, jobId);
    const updated = {
      ...binding,
      status: observed.status,
      revision: observed.revision,
      updatedAt: observed.updatedAt,
      lastError: TERMINAL_STATUSES.has(observed.status)
        ? undefined
        : "cancellation requested; awaiting remote runner confirmation",
    };
    upsertBinding(updated);
    return updated;
  });
};

export const getRemoteJobAttachSpec = async (
  jobId: string
): Promise<RemoteJobAttachSpec> => {
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  const binding = getBinding(jobId);
  if (!binding) {
    throw new Error("Remote Job binding was not found");
  }
  return withSshSession(binding.workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    const state = await readRemoteState(sessionId, jobDirectory, jobId);
    const backendKind = state.backend ?? binding.backend;
    if (binding.mode !== "interactive" || state.mode !== "interactive") {
      throw new RemoteJobUnavailableError(
        "PTY_UNAVAILABLE",
        "Only Remote Jobs created in interactive mode can attach a terminal"
      );
    }
    if (state.status !== "running") {
      throw new RemoteJobUnavailableError(
        "PTY_UNAVAILABLE",
        "Interactive Remote Job is not running"
      );
    }
    if (backendKind !== "snow-agent") {
      throw new RemoteJobUnavailableError(
        "PTY_UNAVAILABLE",
        "Interactive Remote Jobs require the Snow Agent PTY broker"
      );
    }
    const agent = await negotiateSnowAgent(sessionId, capabilities);
    if (!supportsSnowAgentInteractiveAttach(agent.capabilities)) {
      throw new RemoteJobUnavailableError(
        "PTY_UNAVAILABLE",
        "The negotiated Snow Agent does not support interactive attach protocol v1"
      );
    }
    return {
      jobId,
      workspacePath: binding.workspacePath,
      backend: backendKind,
      mode: "interactive",
      remoteCommand: await getSnowAgentAttachCommand(
        sessionId,
        capabilities,
        jobDirectory
      ),
    };
  });
};

export const getRemoteJobAnalysisContext = async (
  jobId: string,
  options?: { offset?: number; limit?: number }
): Promise<string> => {
  const result = await getRemoteJob(jobId, options);
  return JSON.stringify(
    {
      jobId: result.job.jobId,
      workspacePath: result.job.workspacePath,
      command: result.job.displayCommand,
      backend: result.job.backend,
      state: result.state,
      offset: result.offset,
      nextOffset: result.nextOffset,
      output: result.output,
    },
    null,
    2
  );
};

export const cleanupRemoteJobs = async (): Promise<{ removed: string[] }> => {
  const now = Date.now();
  const jobs = readBindings();
  const retained: RemoteJobBinding[] = [];
  const removed: string[] = [];
  for (const job of jobs) {
    const retention =
      job.status === "succeeded" ? SUCCESS_RETENTION_MS : FAILURE_RETENTION_MS;
    const age = now - Date.parse(job.updatedAt);
    if (!TERMINAL_STATUSES.has(job.status) || !Number.isFinite(age) || age < retention) {
      retained.push(job);
      continue;
    }
    try {
      await withSshSession(job.workspacePath, async (sessionId) => {
        const capabilities = await probeSshCapabilities(sessionId);
        const root = await getRemoteJobRoot(sessionId, capabilities);
        const jobDirectory = pathForJob(root, job.jobId);
        const manifest = await readRemoteJson<Record<string, unknown>>(
          sessionId,
          `${jobDirectory}/manifest.json`,
          "manifest"
        );
        if (
          manifest.jobId !== job.jobId ||
          manifest.jobTokenHash !== job.jobTokenHash
        ) {
          throw new Error("Remote Job cleanup token mismatch");
        }
        await removeRemoteJobPath(sessionId, capabilities, jobDirectory);
      });
      removed.push(job.jobId);
    } catch {
      retained.push(job);
    }
  }
  writeBindings(retained);
  return { removed };
};

export const getRemoteJobBackendsForTesting = (): Record<
  RemoteJobBackendKind,
  RemoteJobBackend
> => remoteBackends;
