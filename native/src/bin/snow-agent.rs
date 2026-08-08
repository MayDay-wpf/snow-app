use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(test)]
use std::time::Instant;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

const PROTOCOL_VERSION: u64 = 1;
const INTERACTIVE_ATTACH_PROTOCOL_VERSION: u64 = 1;
const CONTROLLER_MAX_PENDING_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ATTACH_FRAME_BYTES: usize = 1024 * 1024;
const TERMINAL_STATUSES: &[&str] = &[
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "launch_failed",
    "indeterminate",
];
const STATE_LOCK_ATTEMPTS: usize = 400;
const LAUNCH_LOCK_OWNER_GRACE: Duration = Duration::from_secs(5);
const LAUNCH_LOCK_OWNER_FILE: &str = "launcher.pid";
const LAUNCH_LOCK_RUNNER_FILE: &str = "runner.pid";
const SELF_TEST_DELAY: Duration = Duration::from_millis(750);
const STATE_LOCK_LEASE: Duration = Duration::from_secs(5);

#[cfg(unix)]
static WINDOW_CHANGED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum JobMode {
    Batch,
    Interactive,
}

impl Default for JobMode {
    fn default() -> Self {
        Self::Batch
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    schema_version: u64,
    job_id: String,
    job_token_hash: String,
    working_directory: String,
    command: String,
    timeout_ms: u64,
    #[serde(default)]
    mode: JobMode,
    created_at: Option<String>,
    resource_limits: Option<ResourceLimits>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLimits {
    max_log_bytes: Option<u64>,
    max_runtime_ms: Option<u64>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("snow-agent: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let raw_args = env::args().skip(1).collect::<Vec<_>>();
    let args = raw_args.iter().map(String::as_str).collect::<Vec<_>>();
    match args.as_slice() {
        [command, format] if *command == "protocol" && *format == "--format=json" => {
            print_release_handshake()
        }
        ["job", "self-test", "--disconnect-survival"] => run_self_test(),
        ["job", "self-test", "--interactive-disconnect-survival"] => run_interactive_self_test(),
        ["job", "self-test-run", "--probe-id", probe_id, "--marker-token", marker_token] => {
            run_self_test_runner(probe_id, marker_token)
        }
        ["job", "self-test-interactive-run", "--job-directory", directory, "--marker-token", marker_token] => {
            run_interactive_self_test_runner(Path::new(directory), marker_token)
        }
        ["job", "self-test-check", "--probe-id", probe_id, "--marker-token", marker_token, "--job-directory", directory] => {
            check_interactive_self_test(probe_id, marker_token, Path::new(directory))
        }
        ["job", "launch", "--job-directory", directory] => launch_job(Path::new(directory)),
        ["job", "run", "--job-directory", directory] => run_job(Path::new(directory)),
        ["job", "attach", "--job-directory", directory] => attach_job(Path::new(directory)),
        ["job", "inspect", "--job-directory", directory] => inspect_job(Path::new(directory)),
        ["job", "cancel", "--job-directory", directory] => cancel_job(Path::new(directory)),
        ["file", "cas-write", "--target", target, "--expected-sha256", expected, "--content-base64", content] => {
            cas_write(Path::new(target), expected, content)
        }
        _ => Err("unsupported command".to_string()),
    }
}

fn print_json(value: Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn release_manifest_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("SNOW_AGENT_RELEASE_MANIFEST") {
        return Ok(PathBuf::from(path));
    }
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    Ok(executable.with_file_name("snow-agent-release.json"))
}

fn print_release_handshake() -> Result<(), String> {
    let path = release_manifest_path()?;
    let content = fs::read_to_string(&path)
        .map_err(|_| format!("signed release manifest is missing: {}", path.display()))?;
    let manifest: Value = serde_json::from_str(&content)
        .map_err(|error| format!("signed release manifest is invalid: {error}"))?;
    let protocol = manifest
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "signed release manifest has no protocolVersion".to_string())?;
    if protocol != PROTOCOL_VERSION {
        return Err(format!("release protocol {protocol} is unsupported"));
    }
    if manifest
        .get("capabilities")
        .and_then(|value| value.get("interactiveAttach"))
        .and_then(Value::as_bool)
        == Some(true)
        && manifest
            .get("capabilities")
            .and_then(|value| value.get("interactiveAttachProtocolVersion"))
            .and_then(Value::as_u64)
            != Some(INTERACTIVE_ATTACH_PROTOCOL_VERSION)
    {
        return Err(
            "signed release manifest has an incompatible interactive attach protocol".to_string(),
        );
    }
    let declared_hash = manifest
        .get("artifactSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "signed release manifest has no artifactSha256".to_string())?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let actual_hash = sha256(&fs::read(&executable).map_err(|error| error.to_string())?);
    if !declared_hash.eq_ignore_ascii_case(&actual_hash) {
        return Err("snow-agent binary does not match its signed release manifest".to_string());
    }
    print_json(manifest)
}

fn self_test_root() -> Result<PathBuf, String> {
    let root = env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("snow-app/jobs");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(root)
}

fn self_test_marker(root: &Path, probe_id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(probe_id).map_err(|_| "invalid self-test probe id".to_string())?;
    Ok(root.join(format!(".snow-agent-self-test-{probe_id}")))
}

fn run_self_test() -> Result<(), String> {
    // The caller closes its SSH session before it reads this marker. Keep the
    // launch mechanism shared with actual runners so the probe exercises the
    // same session-detachment path instead of self-certifying synchronously.
    let probe_id = Uuid::new_v4().to_string();
    let marker_token = Uuid::new_v4().to_string();
    let root = self_test_root()?;
    let _marker = self_test_marker(&root, &probe_id)?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    launch_self_test_runner(&executable, &probe_id, &marker_token)?;
    print_json(json!({
        "accepted": true,
        "probeId": probe_id,
        "markerToken": marker_token,
    }))
}

fn run_self_test_runner(probe_id: &str, marker_token: &str) -> Result<(), String> {
    Uuid::parse_str(marker_token).map_err(|_| "invalid self-test marker token".to_string())?;
    run_self_test_runner_at(&self_test_root()?, probe_id, marker_token)
}

fn run_self_test_runner_at(root: &Path, probe_id: &str, marker_token: &str) -> Result<(), String> {
    let marker = self_test_marker(root, probe_id)?;
    thread::sleep(SELF_TEST_DELAY);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
        .map_err(|error| format!("failed to create self-test marker: {error}"))?;
    file.write_all(marker_token.as_bytes())
        .map_err(|error| format!("failed to write self-test marker: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync self-test marker: {error}"))
}

#[cfg(unix)]
fn run_interactive_self_test() -> Result<(), String> {
    let probe_id = Uuid::new_v4().to_string();
    let marker_token = Uuid::new_v4().to_string();
    let root = self_test_root()?;
    let directory = root.join(format!(".snow-agent-interactive-probe-{probe_id}"));
    fs::create_dir(&directory).map_err(|error| format!("failed to create PTY probe: {error}"))?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to protect PTY probe: {error}"))?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    launch_detached(&executable, |command| {
        command
            .args(["job", "self-test-interactive-run", "--job-directory"])
            .arg(&directory)
            .args(["--marker-token", &marker_token]);
    })?;
    print_json(json!({
        "accepted": true,
        "probeId": probe_id,
        "markerToken": marker_token,
        "jobDirectory": directory,
    }))
}

#[cfg(not(unix))]
fn run_interactive_self_test() -> Result<(), String> {
    Err("PTY_UNAVAILABLE: Snow Agent interactive jobs require Linux".to_string())
}

#[cfg(unix)]
fn run_interactive_self_test_runner(directory: &Path, marker_token: &str) -> Result<(), String> {
    Uuid::parse_str(marker_token)
        .map_err(|_| "invalid interactive probe marker token".to_string())?;
    let socket_path = directory.join("attach.sock");
    let (master, slave) = open_pty()?;
    let mut child = spawn_pty_command("sleep 5", directory, &slave)?;
    let listener = create_attach_listener(&socket_path)?;
    fs::write(directory.join("runner.pid"), std::process::id().to_string())
        .map_err(|error| error.to_string())?;
    thread::sleep(SELF_TEST_DELAY);
    fs::write(directory.join("ready.marker"), marker_token).map_err(|error| error.to_string())?;
    while child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        let _ = listener.accept();
        thread::sleep(Duration::from_millis(50));
    }
    drop(master);
    drop(listener);
    let _ = fs::remove_file(socket_path);
    let _ = fs::remove_dir_all(directory);
    Ok(())
}

#[cfg(not(unix))]
fn run_interactive_self_test_runner(_directory: &Path, _marker_token: &str) -> Result<(), String> {
    Err("PTY_UNAVAILABLE: Snow Agent interactive jobs require Linux".to_string())
}

#[cfg(unix)]
fn check_interactive_self_test(
    probe_id: &str,
    marker_token: &str,
    directory: &Path,
) -> Result<(), String> {
    Uuid::parse_str(probe_id).map_err(|_| "invalid interactive probe id".to_string())?;
    Uuid::parse_str(marker_token)
        .map_err(|_| "invalid interactive probe marker token".to_string())?;
    let root = self_test_root()?;
    if directory.parent() != Some(root.as_path())
        || !directory
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == format!(".snow-agent-interactive-probe-{probe_id}"))
    {
        return Err("interactive probe directory is invalid".to_string());
    }
    let socket_ready = fs::metadata(directory.join("attach.sock"))
        .is_ok_and(|metadata| metadata.file_type().is_socket());
    let marker_ready = fs::read_to_string(directory.join("ready.marker"))
        .is_ok_and(|content| content == marker_token);
    let active = fs::read_to_string(directory.join("runner.pid"))
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .is_some_and(process_is_active);
    print_json(json!({ "ready": socket_ready && marker_ready, "active": active }))
}

#[cfg(not(unix))]
fn check_interactive_self_test(
    _probe_id: &str,
    _marker_token: &str,
    _directory: &Path,
) -> Result<(), String> {
    Err("PTY_UNAVAILABLE: Snow Agent interactive jobs require Linux".to_string())
}

fn read_request(directory: &Path) -> Result<AgentRequest, String> {
    let content = fs::read_to_string(directory.join("agent-request.json"))
        .map_err(|error| format!("failed to read agent request: {error}"))?;
    let request: AgentRequest = serde_json::from_str(&content)
        .map_err(|error| format!("invalid agent request: {error}"))?;
    if request.schema_version != PROTOCOL_VERSION || request.job_id.is_empty() {
        return Err("agent request has an unsupported schema or empty job id".to_string());
    }
    if request.job_token_hash.len() != 64 || request.command.trim().is_empty() {
        return Err("agent request is missing the cleanup token or command".to_string());
    }
    Ok(request)
}

fn read_state(directory: &Path) -> Option<Value> {
    fs::read_to_string(directory.join("state.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn state_is_terminal(state: &Value) -> bool {
    state
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| TERMINAL_STATUSES.contains(&status))
}

fn next_revision(directory: &Path) -> u64 {
    let revision_path = directory.join("revision");
    let current = fs::read_to_string(&revision_path)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let next = current + 1;
    let _ = fs::write(revision_path, next.to_string());
    next
}

struct StateLock {
    path: PathBuf,
    owner: String,
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let owner_path = self.path.join("owner");
        if fs::read_to_string(&owner_path)
            .ok()
            .and_then(|content| content.lines().next().map(str::to_string))
            .as_deref()
            == Some(self.owner.as_str())
        {
            let _ = fs::remove_file(owner_path);
            let _ = fs::remove_dir(&self.path);
        }
    }
}

fn unix_timestamp_seconds() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn state_lock_is_reclaimable(path: &Path) -> bool {
    let Some(content) = fs::read_to_string(path.join("owner")).ok() else {
        return true;
    };
    let mut values = content.lines();
    let _owner = values.next();
    let pid = values.next().and_then(|value| value.parse::<u32>().ok());
    let expiry = values.next().and_then(|value| value.parse::<u64>().ok());
    let Some(expiry) = expiry else {
        return true;
    };
    expiry <= unix_timestamp_seconds() && !pid.is_some_and(process_is_active)
}

fn reclaim_state_lock(path: &Path) -> bool {
    let reclaim = path.join("reclaim");
    if fs::create_dir(&reclaim).is_err() {
        return false;
    }
    let reclaimable = state_lock_is_reclaimable(path);
    if reclaimable {
        let _ = fs::remove_file(path.join("owner"));
        let _ = fs::remove_dir(&reclaim);
        let _ = fs::remove_dir(path);
    } else {
        let _ = fs::remove_dir(&reclaim);
    }
    reclaimable
}

fn acquire_state_lock(directory: &Path) -> Result<StateLock, String> {
    let path = directory.join("state.lock");
    let owner = Uuid::new_v4().to_string();
    for _ in 0..STATE_LOCK_ATTEMPTS {
        match fs::create_dir(&path) {
            Ok(()) => {
                let expiry = unix_timestamp_seconds() + STATE_LOCK_LEASE.as_secs();
                let owner_path = path.join("owner");
                if let Err(error) = fs::write(
                    &owner_path,
                    format!("{owner}\n{}\n{expiry}\n", std::process::id()),
                ) {
                    let _ = fs::remove_dir(&path);
                    return Err(format!("failed to write state lock lease: {error}"));
                }
                return Ok(StateLock { path, owner });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let _ = reclaim_state_lock(&path);
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("failed to acquire state lock: {error}")),
        }
    }
    Err("remote job state lock timed out".to_string())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn write_state(
    directory: &Path,
    request: &AgentRequest,
    status: &str,
    exit_code: Option<i32>,
    reason: Option<&str>,
) -> Result<(), String> {
    write_state_with_runner_pid(
        directory,
        request,
        status,
        exit_code,
        reason,
        Some(std::process::id()),
    )
}

fn write_launching_state(directory: &Path, request: &AgentRequest) -> Result<(), String> {
    write_state_with_runner_pid(directory, request, "launching", None, None, None)
}

fn write_state_with_runner_pid(
    directory: &Path,
    request: &AgentRequest,
    status: &str,
    exit_code: Option<i32>,
    reason: Option<&str>,
    runner_pid: Option<u32>,
) -> Result<(), String> {
    let _state_lock = acquire_state_lock(directory)?;
    let truncated = if let Some(current) = read_state(directory) {
        if state_is_terminal(&current) {
            return Ok(());
        }
        current
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    } else {
        false
    };
    let now = timestamp();
    let mut state = json!({
        "schemaVersion": PROTOCOL_VERSION,
        "jobId": request.job_id,
        "status": status,
        "revision": next_revision(directory),
        "backend": "snow-agent",
        "mode": &request.mode,
        "createdAt": request.created_at.clone().unwrap_or_else(|| now.clone()),
        "updatedAt": now,
        "exitCode": exit_code,
    });
    if let Some(runner_pid) = runner_pid {
        state["runnerPid"] = json!(runner_pid);
    }
    if TERMINAL_STATUSES.contains(&status) {
        state["completedAt"] = Value::String(timestamp());
    }
    if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
        state["reason"] = Value::String(reason.to_string());
    }
    if truncated {
        state["truncated"] = Value::Bool(true);
    }
    let temporary = directory.join(format!("state.{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(&state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, directory.join("state.json")).map_err(|error| error.to_string())
}

fn mark_output_truncated(directory: &Path) -> Result<(), String> {
    let _state_lock = acquire_state_lock(directory)?;
    let Some(mut state) = read_state(directory) else {
        return Ok(());
    };
    if state_is_terminal(&state) || state["truncated"].as_bool() == Some(true) {
        return Ok(());
    }
    state["truncated"] = Value::Bool(true);
    state["revision"] = Value::from(next_revision(directory));
    state["updatedAt"] = Value::String(timestamp());
    let temporary = directory.join(format!("state.{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(&state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, directory.join("state.json")).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn launch_detached<F>(executable: &Path, configure: F) -> Result<(), String>
where
    F: FnOnce(&mut Command),
{
    use std::os::unix::process::CommandExt;

    let mut command = Command::new(executable);
    configure(&mut command);
    // Calling setsid(2) in the child keeps the agent portable across POSIX
    // hosts. macOS does not ship the GNU `setsid` executable used previously.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to start detached runner: {error}"))
}

#[cfg(not(unix))]
fn launch_detached<F>(_executable: &Path, _configure: F) -> Result<(), String>
where
    F: FnOnce(&mut Command),
{
    Err("snow-agent runner is currently published for POSIX hosts only".to_string())
}

fn launch_runner(executable: &Path, directory: &Path) -> Result<(), String> {
    launch_detached(executable, |command| {
        command
            .args(["job", "run", "--job-directory"])
            .arg(directory);
    })
}

fn launch_self_test_runner(
    executable: &Path,
    probe_id: &str,
    marker_token: &str,
) -> Result<(), String> {
    launch_detached(executable, |command| {
        command.args([
            "job",
            "self-test-run",
            "--probe-id",
            probe_id,
            "--marker-token",
            marker_token,
        ]);
    })
}

struct LaunchLock {
    path: PathBuf,
    release_on_drop: bool,
}

impl LaunchLock {
    fn acquire(directory: &Path) -> Result<Self, io::Error> {
        let path = directory.join("launch.lock");
        fs::create_dir(&path)?;
        let lock = Self {
            path,
            release_on_drop: true,
        };
        if let Err(error) = fs::write(
            lock.path.join(LAUNCH_LOCK_OWNER_FILE),
            std::process::id().to_string(),
        ) {
            return Err(error);
        }
        Ok(lock)
    }

    fn claim_for_runner(directory: &Path) -> Result<Self, String> {
        let path = directory.join("launch.lock");
        if !path.is_dir() {
            return Err("snow-agent runner started without a launch handoff lock".to_string());
        }
        let runner_marker = path.join(LAUNCH_LOCK_RUNNER_FILE);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&runner_marker)
            .and_then(|mut file| write!(file, "{}", std::process::id()))
            .map_err(|error| format!("failed to claim launch handoff lock: {error}"))?;
        Ok(Self {
            path,
            release_on_drop: true,
        })
    }

    fn hand_off(mut self) {
        self.release_on_drop = false;
    }

    fn release(&mut self) -> Result<(), String> {
        release_launch_lock(&self.path)?;
        self.release_on_drop = false;
        Ok(())
    }
}

impl Drop for LaunchLock {
    fn drop(&mut self) {
        if self.release_on_drop {
            let _ = release_launch_lock(&self.path);
        }
    }
}

fn read_lock_pid(path: &Path, name: &str) -> Option<u32> {
    fs::read_to_string(path.join(name))
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
}

#[cfg(unix)]
fn process_is_active(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(unix))]
fn process_is_active(_pid: u32) -> bool {
    false
}

fn launch_lock_is_active(path: &Path) -> bool {
    if read_lock_pid(path, LAUNCH_LOCK_RUNNER_FILE).is_some_and(process_is_active) {
        return true;
    }
    let Some(owner_pid) = read_lock_pid(path, LAUNCH_LOCK_OWNER_FILE) else {
        // Older agents created an empty lock directory. A dead runner PID in
        // state.json is enough to reclaim that legacy lock immediately.
        return false;
    };
    if process_is_active(owner_pid) {
        return true;
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|modified| modified.elapsed().map_err(io::Error::other))
        .is_ok_and(|elapsed| elapsed < LAUNCH_LOCK_OWNER_GRACE)
}

fn release_launch_lock(path: &Path) -> Result<(), String> {
    for marker in [LAUNCH_LOCK_RUNNER_FILE, LAUNCH_LOCK_OWNER_FILE] {
        match fs::remove_file(path.join(marker)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to release launch lock: {error}")),
        }
    }
    fs::remove_dir(path).map_err(|error| format!("failed to release launch lock: {error}"))
}

fn acquire_or_recover_launch_lock(directory: &Path) -> Result<Option<LaunchLock>, String> {
    match LaunchLock::acquire(directory) {
        Ok(lock) => Ok(Some(lock)),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let path = directory.join("launch.lock");
            if launch_lock_is_active(&path) {
                return Ok(None);
            }
            release_launch_lock(&path)?;
            match LaunchLock::acquire(directory) {
                Ok(lock) => Ok(Some(lock)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(None),
                Err(error) => Err(format!("failed to acquire launch lock: {error}")),
            }
        }
        Err(error) => Err(format!("failed to acquire launch lock: {error}")),
    }
}

fn launch_job_with<F>(directory: &Path, launch_runner: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let request = read_request(directory)?;
    if let Some(state) = read_state(directory) {
        let status = state.get("status").and_then(Value::as_str);
        if state_is_terminal(&state) || status == Some("running") {
            return print_json(json!({ "accepted": true, "jobId": request.job_id }));
        }
        if status == Some("launching")
            && state
                .get("runnerPid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .is_some_and(process_is_active)
        {
            return print_json(json!({ "accepted": true, "jobId": request.job_id }));
        }
    }
    let Some(lock) = acquire_or_recover_launch_lock(directory)? else {
        return print_json(json!({ "accepted": true, "jobId": request.job_id }));
    };
    write_launching_state(directory, &request)?;
    if let Err(error) = launch_runner(directory) {
        let _ = write_state(directory, &request, "launch_failed", None, Some(&error));
        return Err(error);
    }
    lock.hand_off();
    print_json(json!({ "accepted": true, "jobId": request.job_id }))
}

fn launch_job(directory: &Path) -> Result<(), String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    launch_job_with(directory, |directory| launch_runner(&executable, directory))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

struct OutputCapture {
    log: File,
    frames: File,
    offset: u64,
    used_bytes: u64,
    max_bytes: u64,
    truncated: bool,
}

impl OutputCapture {
    fn open(directory: &Path, max_bytes: u64) -> Result<Self, String> {
        let log_path = directory.join("output.log");
        let frames_path = directory.join("output.frames.ndjson");
        let log_bytes = fs::metadata(&log_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let frame_bytes = fs::metadata(&frames_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Ok(Self {
            log: OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
                .map_err(|error| error.to_string())?,
            frames: OpenOptions::new()
                .create(true)
                .append(true)
                .open(frames_path)
                .map_err(|error| error.to_string())?,
            offset: log_bytes,
            used_bytes: log_bytes.saturating_add(frame_bytes),
            max_bytes,
            truncated: log_bytes.saturating_add(frame_bytes) >= max_bytes,
        })
    }

    fn frame(start: u64, stream: &str, chunk: &[u8]) -> Result<Vec<u8>, String> {
        let mut frame = serde_json::to_vec(&json!({
            "offset": start,
            "stream": stream,
            "data": BASE64.encode(chunk),
        }))
        .map_err(|error| error.to_string())?;
        frame.push(b'\n');
        Ok(frame)
    }

    fn largest_recordable_chunk(&self, stream: &str, chunk: &[u8]) -> Result<usize, String> {
        let remaining = self.max_bytes.saturating_sub(self.used_bytes);
        let mut low = 0;
        let mut high = chunk
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        while low < high {
            let middle = low + (high - low + 1) / 2;
            let frame = Self::frame(self.offset, stream, &chunk[..middle])?;
            if middle as u64 + frame.len() as u64 <= remaining {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        Ok(low)
    }

    fn capture(&mut self, stream: &str, chunk: &[u8]) -> Result<bool, String> {
        if self.truncated {
            return Ok(false);
        }
        let length = self.largest_recordable_chunk(stream, chunk)?;
        if length == 0 {
            self.truncated = true;
            return Ok(true);
        }
        let frame = Self::frame(self.offset, stream, &chunk[..length])?;
        self.log
            .write_all(&chunk[..length])
            .map_err(|error| error.to_string())?;
        self.frames
            .write_all(&frame)
            .map_err(|error| error.to_string())?;
        self.offset += length as u64;
        self.used_bytes += length as u64 + frame.len() as u64;
        if length < chunk.len() {
            self.truncated = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn is_truncated(&self) -> bool {
        self.truncated
    }
}

fn capture_stream<R: Read + Send + 'static>(
    mut reader: R,
    stream: &'static str,
    output: Arc<Mutex<OutputCapture>>,
    directory: PathBuf,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let chunk = &buffer[..read];
            let truncated = output
                .lock()
                .expect("output capture lock poisoned")
                .capture(stream, chunk)
                .unwrap_or(false);
            if truncated {
                let _ = mark_output_truncated(&directory);
            }
        }
    })
}

fn terminate_process_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", child.id())])
            .status();
    }
    let _ = child.kill();
}

fn run_job(directory: &Path) -> Result<(), String> {
    let request = read_request(directory)?;
    let mut lock = LaunchLock::claim_for_runner(directory)?;
    if read_state(directory).is_some_and(|state| state_is_terminal(&state)) {
        return lock.release();
    }
    write_state(directory, &request, "launching", None, None)?;
    lock.release()?;
    run_job_after_handoff(directory, &request)
}

fn run_job_after_handoff(directory: &Path, request: &AgentRequest) -> Result<(), String> {
    match request.mode {
        JobMode::Batch => run_batch_job_after_handoff(directory, request),
        JobMode::Interactive => run_interactive_job_after_handoff(directory, request),
    }
}

fn run_batch_job_after_handoff(directory: &Path, request: &AgentRequest) -> Result<(), String> {
    let max_runtime_ms = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_runtime_ms)
        .unwrap_or(request.timeout_ms)
        .min(request.timeout_ms);
    let max_output_bytes = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_log_bytes)
        .unwrap_or(50 * 1024 * 1024);
    let output = Arc::new(Mutex::new(OutputCapture::open(
        directory,
        max_output_bytes,
    )?));
    if output
        .lock()
        .expect("output capture lock poisoned")
        .is_truncated()
    {
        mark_output_truncated(directory)?;
    }
    let wrapped = format!(
        "ulimit -f {} 2>/dev/null || true; exec /bin/sh -lc {}",
        max_output_bytes / 512,
        shell_quote(&request.command)
    );
    let mut command = Command::new("/bin/sh");
    command
        .args(["-lc", &wrapped])
        .current_dir(&request.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start job command: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "missing job stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "missing job stderr".to_string())?;
    let stdout_reader = capture_stream(stdout, "stdout", output.clone(), directory.to_path_buf());
    let stderr_reader = capture_stream(stderr, "stderr", output, directory.to_path_buf());
    write_state(directory, &request, "running", None, None)?;
    let started = SystemTime::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let exit_code = loop {
        if directory.join("cancel.request").exists() {
            cancelled = true;
            terminate_process_group(&mut child);
        } else if started.elapsed().unwrap_or_default() >= Duration::from_millis(max_runtime_ms) {
            timed_out = true;
            terminate_process_group(&mut child);
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status.code().unwrap_or(1);
        }
        thread::sleep(Duration::from_millis(200));
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    if timed_out {
        write_state(
            directory,
            &request,
            "timed_out",
            Some(exit_code),
            Some("timeout"),
        )
    } else if cancelled {
        write_state(
            directory,
            &request,
            "cancelled",
            Some(exit_code),
            Some("cancelled"),
        )
    } else if exit_code == 0 {
        write_state(directory, &request, "succeeded", Some(0), None)
    } else {
        write_state(directory, &request, "failed", Some(exit_code), Some("exit"))
    }
}

#[cfg(unix)]
const FRAME_INPUT: u8 = 1;
#[cfg(unix)]
const FRAME_OUTPUT: u8 = 2;
#[cfg(unix)]
const FRAME_RESIZE: u8 = 3;
#[cfg(unix)]
const FRAME_DETACH: u8 = 4;
#[cfg(unix)]
const FRAME_ERROR: u8 = 5;

#[cfg(unix)]
fn open_pty() -> Result<(File, File), String> {
    let mut master = -1;
    let mut slave = -1;
    let result = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == -1 {
        return Err(format!("PTY_UNAVAILABLE: {}", io::Error::last_os_error()));
    }
    let master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    disable_pty_input_echo(slave.as_raw_fd())?;
    Ok((master, slave))
}

#[cfg(unix)]
fn disable_pty_input_echo(slave: RawFd) -> Result<(), String> {
    let mut attributes = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(slave, &mut attributes) } == -1 {
        return Err(format!(
            "PTY_UNAVAILABLE: cannot read terminal attributes: {}",
            io::Error::last_os_error()
        ));
    }
    attributes.c_lflag &= !(libc::ECHO | libc::ECHONL);
    if unsafe { libc::tcsetattr(slave, libc::TCSANOW, &attributes) } == -1 {
        return Err(format!(
            "PTY_UNAVAILABLE: cannot disable PTY input echo: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn duplicate_fd(fd: RawFd) -> Result<File, String> {
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate == -1 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(unsafe { File::from_raw_fd(duplicate) })
}

#[cfg(unix)]
fn spawn_pty_command(command: &str, directory: &Path, slave: &File) -> Result<Child, String> {
    let slave_fd = slave.as_raw_fd();
    let stdin = duplicate_fd(slave_fd)?;
    let stdout = duplicate_fd(slave_fd)?;
    let stderr = duplicate_fd(slave_fd)?;
    let mut child = Command::new("/bin/sh");
    child
        .args(["-lc", command])
        .current_dir(directory)
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    unsafe {
        child.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(slave_fd, libc::TIOCSCTTY, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            for target in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO] {
                if libc::dup2(slave_fd, target) == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    child
        .spawn()
        .map_err(|error| format!("failed to start PTY command: {error}"))
}

#[cfg(unix)]
fn create_attach_listener(path: &Path) -> Result<UnixListener, String> {
    let _ = fs::remove_file(path);
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("PTY_UNAVAILABLE: failed to create attach socket: {error}"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("failed to protect attach socket: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure attach socket: {error}"))?;
    Ok(listener)
}

#[cfg(unix)]
fn set_nonblocking(fd: RawFd) -> Result<(), String> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len() + 1).unwrap_or(u32::MAX);
    let mut frame = Vec::with_capacity(payload.len() + 5);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.push(kind);
    frame.extend_from_slice(payload);
    frame
}

#[cfg(unix)]
fn take_frames(buffer: &mut Vec<u8>) -> Result<Vec<(u8, Vec<u8>)>, String> {
    let mut frames = Vec::new();
    loop {
        if buffer.len() < 4 {
            return Ok(frames);
        }
        let length = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
        if length == 0 || length > MAX_ATTACH_FRAME_BYTES {
            return Err("PTY_UNAVAILABLE: invalid attach frame length".to_string());
        }
        if buffer.len() < 4 + length {
            return Ok(frames);
        }
        let kind = buffer[4];
        let payload = buffer[5..4 + length].to_vec();
        buffer.drain(..4 + length);
        frames.push((kind, payload));
    }
}

#[cfg(unix)]
fn flush_controller(controller: &mut UnixStream, pending: &mut Vec<u8>) -> bool {
    while !pending.is_empty() {
        match controller.write(pending) {
            Ok(0) => return false,
            Ok(written) => {
                pending.drain(..written);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return true,
            Err(_) => return false,
        }
    }
    true
}

#[cfg(unix)]
fn queue_controller_frame(
    controller: &mut Option<UnixStream>,
    pending: &mut Vec<u8>,
    kind: u8,
    payload: &[u8],
) {
    if controller.is_none() {
        return;
    }
    let frame = encode_frame(kind, payload);
    if pending.len().saturating_add(frame.len()) > CONTROLLER_MAX_PENDING_OUTPUT_BYTES {
        // The PTY must keep draining even when a renderer cannot keep up.
        *controller = None;
        pending.clear();
        return;
    }
    pending.extend_from_slice(&frame);
}

#[cfg(unix)]
fn apply_pty_resize(master: RawFd, payload: &[u8], child_pid: u32) -> Result<(), String> {
    if payload.len() != 4 {
        return Err("PTY_UNAVAILABLE: resize frame is malformed".to_string());
    }
    let columns = u16::from_be_bytes([payload[0], payload[1]]);
    let rows = u16::from_be_bytes([payload[2], payload[3]]);
    if columns == 0 || rows == 0 {
        return Err("PTY_UNAVAILABLE: resize frame has zero dimensions".to_string());
    }
    let size = libc::winsize {
        ws_row: rows,
        ws_col: columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &size) } == -1 {
        return Err(format!(
            "PTY_UNAVAILABLE: cannot resize PTY: {}",
            io::Error::last_os_error()
        ));
    }
    if child_pid <= i32::MAX as u32 {
        let _ = unsafe { libc::kill(-(child_pid as i32), libc::SIGWINCH) };
    }
    Ok(())
}

#[cfg(unix)]
fn poll_fds(fds: &mut [libc::pollfd], timeout_ms: i32) -> Result<(), String> {
    let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout_ms) };
    if result == -1 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn run_interactive_job_after_handoff(
    directory: &Path,
    request: &AgentRequest,
) -> Result<(), String> {
    let max_runtime_ms = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_runtime_ms)
        .unwrap_or(request.timeout_ms)
        .min(request.timeout_ms);
    let max_output_bytes = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_log_bytes)
        .unwrap_or(50 * 1024 * 1024);
    let mut output = OutputCapture::open(directory, max_output_bytes)?;
    let socket_path = directory.join("attach.sock");
    let listener = create_attach_listener(&socket_path)?;
    let (master, slave) = open_pty()?;
    set_nonblocking(master.as_raw_fd())?;
    let wrapped = format!(
        "ulimit -f {} 2>/dev/null || true; exec /bin/sh -lc {}",
        max_output_bytes / 512,
        shell_quote(&request.command)
    );
    let mut child = spawn_pty_command(&wrapped, Path::new(&request.working_directory), &slave)?;
    drop(slave);
    write_state(directory, request, "running", None, None)?;

    let started = SystemTime::now();
    let mut controller: Option<UnixStream> = None;
    let mut controller_input: Vec<u8> = Vec::new();
    let mut controller_output: Vec<u8> = Vec::new();
    let mut pending_input: Vec<u8> = Vec::new();
    let mut cancelled = false;
    let mut timed_out = false;
    let exit_code = loop {
        if directory.join("cancel.request").exists() && !cancelled {
            cancelled = true;
            terminate_process_group(&mut child);
        } else if started.elapsed().unwrap_or_default() >= Duration::from_millis(max_runtime_ms)
            && !timed_out
        {
            timed_out = true;
            terminate_process_group(&mut child);
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status.code().unwrap_or(1);
        }

        let controller_index = if controller.is_some() { 2 } else { usize::MAX };
        let mut fds = vec![
            libc::pollfd {
                fd: master.as_raw_fd(),
                events: libc::POLLIN
                    | if pending_input.is_empty() {
                        0
                    } else {
                        libc::POLLOUT
                    },
                revents: 0,
            },
            libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        if let Some(stream) = controller.as_ref() {
            fds.push(libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLIN
                    | if controller_output.is_empty() {
                        0
                    } else {
                        libc::POLLOUT
                    },
                revents: 0,
            });
        }
        poll_fds(&mut fds, 100)?;

        if fds[1].revents & libc::POLLIN != 0 {
            while let Ok((mut incoming, _)) = listener.accept() {
                if controller.is_some() {
                    let _ = incoming.write_all(&encode_frame(FRAME_ERROR, b"CONTROLLER_BUSY"));
                } else if incoming.set_nonblocking(true).is_ok() {
                    controller = Some(incoming);
                    controller_input.clear();
                    controller_output.clear();
                }
            }
        }

        if fds[0].revents & libc::POLLIN != 0 {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                let read = unsafe {
                    libc::read(
                        master.as_raw_fd(),
                        buffer.as_mut_ptr().cast::<libc::c_void>(),
                        buffer.len(),
                    )
                };
                if read > 0 {
                    let chunk = &buffer[..read as usize];
                    if output.capture("pty", chunk)? {
                        mark_output_truncated(directory)?;
                    }
                    queue_controller_frame(
                        &mut controller,
                        &mut controller_output,
                        FRAME_OUTPUT,
                        chunk,
                    );
                    continue;
                }
                if read == -1 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::WouldBlock {
                        break;
                    }
                }
                break;
            }
        }

        if fds[0].revents & libc::POLLOUT != 0 && !pending_input.is_empty() {
            let written = unsafe {
                libc::write(
                    master.as_raw_fd(),
                    pending_input.as_ptr().cast::<libc::c_void>(),
                    pending_input.len(),
                )
            };
            if written > 0 {
                pending_input.drain(..written as usize);
            }
        }

        if controller_index != usize::MAX {
            let events = fds[controller_index].revents;
            let mut detach = events & (libc::POLLERR | libc::POLLHUP) != 0;
            if events & libc::POLLIN != 0 {
                let mut buffer = [0_u8; 16 * 1024];
                if let Some(stream) = controller.as_mut() {
                    loop {
                        match stream.read(&mut buffer) {
                            Ok(0) => {
                                detach = true;
                                break;
                            }
                            Ok(read) => controller_input.extend_from_slice(&buffer[..read]),
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                            Err(_) => {
                                detach = true;
                                break;
                            }
                        }
                    }
                }
                for (kind, payload) in take_frames(&mut controller_input)? {
                    match kind {
                        FRAME_INPUT => {
                            if pending_input.len().saturating_add(payload.len())
                                > MAX_ATTACH_FRAME_BYTES
                            {
                                detach = true;
                            } else {
                                pending_input.extend_from_slice(&payload);
                            }
                        }
                        FRAME_RESIZE => {
                            if let Err(error) =
                                apply_pty_resize(master.as_raw_fd(), &payload, child.id())
                            {
                                queue_controller_frame(
                                    &mut controller,
                                    &mut controller_output,
                                    FRAME_ERROR,
                                    error.as_bytes(),
                                );
                            }
                        }
                        FRAME_DETACH => detach = true,
                        _ => {
                            queue_controller_frame(
                                &mut controller,
                                &mut controller_output,
                                FRAME_ERROR,
                                b"PTY_UNAVAILABLE: unsupported controller frame",
                            );
                        }
                    }
                }
            }
            if !detach && events & libc::POLLOUT != 0 {
                if let Some(stream) = controller.as_mut() {
                    detach = !flush_controller(stream, &mut controller_output);
                }
            }
            if detach {
                controller = None;
                controller_input.clear();
                controller_output.clear();
            }
        }
    };

    let result = if timed_out {
        write_state(
            directory,
            request,
            "timed_out",
            Some(exit_code),
            Some("timeout"),
        )
    } else if cancelled {
        write_state(
            directory,
            request,
            "cancelled",
            Some(exit_code),
            Some("cancelled"),
        )
    } else if exit_code == 0 {
        write_state(directory, request, "succeeded", Some(0), None)
    } else {
        write_state(directory, request, "failed", Some(exit_code), Some("exit"))
    };
    drop(controller);
    drop(listener);
    drop(master);
    let _ = fs::remove_file(socket_path);
    result
}

#[cfg(not(unix))]
fn run_interactive_job_after_handoff(
    _directory: &Path,
    _request: &AgentRequest,
) -> Result<(), String> {
    Err("PTY_UNAVAILABLE: Snow Agent interactive jobs require Linux".to_string())
}

fn inspect_job(directory: &Path) -> Result<(), String> {
    let state = read_state(directory).ok_or_else(|| "job state is unavailable".to_string())?;
    let active = state
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| !TERMINAL_STATUSES.contains(&status))
        && state
            .get("runnerPid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .is_some_and(process_is_active);
    print_json(json!({ "active": active, "state": state }))
}

#[cfg(unix)]
extern "C" fn on_sigwinch(_: libc::c_int) {
    WINDOW_CHANGED.store(true, Ordering::Relaxed);
}

#[cfg(unix)]
struct RawTerminal {
    fd: RawFd,
    original: libc::termios,
}

#[cfg(unix)]
impl RawTerminal {
    fn enter(fd: RawFd) -> Result<Self, String> {
        let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
        if unsafe { libc::tcgetattr(fd, &mut original) } == -1 {
            return Err(format!(
                "PTY_UNAVAILABLE: attach requires a terminal: {}",
                io::Error::last_os_error()
            ));
        }
        let mut raw = original;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } == -1 {
            return Err(format!(
                "PTY_UNAVAILABLE: cannot enter raw terminal mode: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self { fd, original })
    }
}

#[cfg(unix)]
impl Drop for RawTerminal {
    fn drop(&mut self) {
        let _ = unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.original) };
    }
}

#[cfg(unix)]
fn read_terminal_size(fd: RawFd) -> Option<[u8; 4]> {
    let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) } == -1
        || size.ws_col == 0
        || size.ws_row == 0
    {
        return None;
    }
    let mut payload = [0_u8; 4];
    payload[..2].copy_from_slice(&size.ws_col.to_be_bytes());
    payload[2..].copy_from_slice(&size.ws_row.to_be_bytes());
    Some(payload)
}

#[cfg(unix)]
fn send_attach_frame(stream: &mut UnixStream, kind: u8, payload: &[u8]) -> Result<(), String> {
    stream
        .write_all(&encode_frame(kind, payload))
        .map_err(|error| format!("failed to communicate with PTY broker: {error}"))
}

#[cfg(unix)]
fn attach_job(directory: &Path) -> Result<(), String> {
    let request = read_request(directory)?;
    if request.mode != JobMode::Interactive {
        return Err("PTY_UNAVAILABLE: this Remote Job was created in batch mode".to_string());
    }
    if read_state(directory).is_some_and(|state| state_is_terminal(&state)) {
        return Err("PTY_UNAVAILABLE: this Remote Job has already completed".to_string());
    }
    let mut stream = UnixStream::connect(directory.join("attach.sock"))
        .map_err(|error| format!("PTY_UNAVAILABLE: interactive broker is unavailable: {error}"))?;
    let stdin_fd = io::stdin().as_raw_fd();
    let _raw = RawTerminal::enter(stdin_fd)?;
    unsafe {
        libc::signal(libc::SIGWINCH, on_sigwinch as libc::sighandler_t);
    }
    if let Some(size) = read_terminal_size(stdin_fd) {
        send_attach_frame(&mut stream, FRAME_RESIZE, &size)?;
    }
    let mut received = Vec::new();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    loop {
        if WINDOW_CHANGED.swap(false, Ordering::Relaxed) {
            if let Some(size) = read_terminal_size(stdin_fd) {
                send_attach_frame(&mut stream, FRAME_RESIZE, &size)?;
            }
        }
        let mut fds = [
            libc::pollfd {
                fd: stdin_fd,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        poll_fds(&mut fds, 200)?;
        if fds[0].revents & libc::POLLIN != 0 {
            let mut input = [0_u8; 16 * 1024];
            let read = unsafe {
                libc::read(
                    stdin_fd,
                    input.as_mut_ptr().cast::<libc::c_void>(),
                    input.len(),
                )
            };
            if read <= 0 {
                let _ = send_attach_frame(&mut stream, FRAME_DETACH, &[]);
                return Ok(());
            }
            send_attach_frame(&mut stream, FRAME_INPUT, &input[..read as usize])?;
        }
        if fds[1].revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            return Ok(());
        }
        if fds[1].revents & libc::POLLIN != 0 {
            let mut buffer = [0_u8; 16 * 1024];
            let read = stream
                .read(&mut buffer)
                .map_err(|error| format!("failed to read PTY output: {error}"))?;
            if read == 0 {
                return Ok(());
            }
            received.extend_from_slice(&buffer[..read]);
            for (kind, payload) in take_frames(&mut received)? {
                match kind {
                    FRAME_OUTPUT => output
                        .write_all(&payload)
                        .and_then(|()| output.flush())
                        .map_err(|error| format!("failed to write PTY output: {error}"))?,
                    FRAME_ERROR => {
                        return Err(String::from_utf8_lossy(&payload).to_string());
                    }
                    _ => return Err("PTY_UNAVAILABLE: broker sent an invalid frame".to_string()),
                }
            }
        }
    }
}

#[cfg(not(unix))]
fn attach_job(_directory: &Path) -> Result<(), String> {
    Err("PTY_UNAVAILABLE: Snow Agent interactive jobs require Linux".to_string())
}

fn cancel_job(directory: &Path) -> Result<(), String> {
    fs::write(directory.join("cancel.request"), b"").map_err(|error| error.to_string())?;
    print_json(json!({ "accepted": true }))
}

fn sha256(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

fn cas_write(target: &Path, expected: &str, content: &str) -> Result<(), String> {
    let current = fs::read(target).ok();
    let current_hash = current.as_deref().map(sha256);
    if (expected == "missing" && current.is_some())
        || (expected != "missing" && current_hash.as_deref() != Some(expected))
    {
        return Err("CAS precondition failed".to_string());
    }
    let decoded = BASE64
        .decode(content)
        .map_err(|error| format!("invalid base64 content: {error}"))?;
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let temporary = parent.join(format!(
        ".{}.snow-agent-{}.tmp",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("target"),
        Uuid::new_v4()
    ));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(&decoded)?;
            file.sync_all()
        })
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, target).map_err(|error| error.to_string())?;
    print_json(json!({ "committed": true, "sha256": sha256(&decoded), "bytes": decoded.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_job_directory() -> PathBuf {
        let directory = env::temp_dir().join(format!("snow-agent-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test job directory");
        directory
    }

    fn write_test_request(directory: &Path, working_directory: &Path) {
        fs::write(
            directory.join("agent-request.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": PROTOCOL_VERSION,
                "jobId": Uuid::new_v4().to_string(),
                "jobTokenHash": "a".repeat(64),
                "workingDirectory": working_directory,
                "command": "true",
                "timeoutMs": 1_000,
            }))
            .expect("serialize agent request"),
        )
        .expect("write agent request");
    }

    #[cfg(unix)]
    fn write_interactive_test_request(directory: &Path, command: &str) {
        write_interactive_test_request_with_limit(directory, command, 1024 * 1024);
    }

    #[cfg(unix)]
    fn write_interactive_test_request_with_limit(
        directory: &Path,
        command: &str,
        max_log_bytes: u64,
    ) {
        fs::write(
            directory.join("agent-request.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": PROTOCOL_VERSION,
                "jobId": Uuid::new_v4().to_string(),
                "jobTokenHash": "a".repeat(64),
                "workingDirectory": directory,
                "command": command,
                "timeoutMs": 5_000,
                "mode": "interactive",
                "resourceLimits": { "maxLogBytes": max_log_bytes, "maxRuntimeMs": 5_000 },
            }))
            .expect("serialize interactive agent request"),
        )
        .expect("write interactive agent request");
    }

    #[cfg(unix)]
    fn wait_for_attach_socket(directory: &Path) {
        let socket = directory.join("attach.sock");
        for _ in 0..80 {
            if socket.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("interactive attach socket was not created");
    }

    #[cfg(unix)]
    #[test]
    fn runner_releases_handoff_lock_before_a_missing_working_directory_fails() {
        let directory = test_job_directory();
        let missing_working_directory = directory.join("deleted-workspace");
        write_test_request(&directory, &missing_working_directory);
        let lock = directory.join("launch.lock");
        fs::create_dir(&lock).expect("create handoff lock");
        fs::write(lock.join(LAUNCH_LOCK_OWNER_FILE), "1").expect("write launcher marker");

        let error = run_job(&directory).expect_err("missing working directory must fail");
        assert!(error.contains("failed to start job command"));
        assert!(!lock.exists(), "runner must release the handoff lock");
        let state = read_state(&directory).expect("runner writes its launching state");
        assert_eq!(state["status"], "launching");
        assert_eq!(state["runnerPid"], std::process::id());

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[test]
    fn stale_launching_state_reclaims_a_legacy_lock_and_relaunches() {
        let directory = test_job_directory();
        write_test_request(&directory, &directory);
        let request = read_request(&directory).expect("read test request");
        fs::write(
            directory.join("state.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": PROTOCOL_VERSION,
                "jobId": request.job_id,
                "status": "launching",
                "revision": 1,
                "backend": "snow-agent",
                "runnerPid": u32::MAX,
                "createdAt": "unix-ms:0",
                "updatedAt": "unix-ms:0",
                "exitCode": null,
            }))
            .expect("serialize stale state"),
        )
        .expect("write stale state");
        fs::create_dir(directory.join("launch.lock")).expect("create legacy lock");

        let mut launches = 0;
        launch_job_with(&directory, |_| {
            launches += 1;
            Ok(())
        })
        .expect("stale launch must be retried");
        assert_eq!(launches, 1);
        assert!(directory.join("launch.lock").is_dir());

        release_launch_lock(&directory.join("launch.lock")).expect("release test lock");
        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[test]
    fn self_test_runner_writes_a_delayed_token_marker() {
        let root = test_job_directory();
        let probe_id = Uuid::new_v4().to_string();
        let marker_token = Uuid::new_v4().to_string();
        let marker = self_test_marker(&root, &probe_id).expect("build self-test marker path");
        let started = Instant::now();

        run_self_test_runner_at(&root, &probe_id, &marker_token)
            .expect("write delayed self-test marker");

        assert!(
            started.elapsed() >= SELF_TEST_DELAY,
            "the marker must not be written before the launching SSH session can close"
        );
        assert_eq!(
            fs::read_to_string(&marker).expect("read self-test marker"),
            marker_token
        );

        fs::remove_file(marker).expect("remove self-test marker");
        fs::remove_dir_all(root).expect("remove test job directory");
    }

    #[test]
    fn batch_job_rejects_interactive_attach() {
        let directory = test_job_directory();
        write_test_request(&directory, &directory);
        let error = attach_job(&directory).expect_err("batch job must not attach");
        assert!(error.contains("batch mode"));

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[cfg(unix)]
    #[test]
    fn interactive_job_survives_detach_and_releases_the_controller_lease() {
        let directory = test_job_directory();
        write_interactive_test_request(
            &directory,
            "IFS= read first; printf 'first:%s\\n' \"$first\"; IFS= read second; printf 'second:%s\\n' \"$second\"",
        );
        let request = read_request(&directory).expect("read interactive request");
        let runner_directory = directory.clone();
        let runner =
            thread::spawn(move || run_interactive_job_after_handoff(&runner_directory, &request));
        wait_for_attach_socket(&directory);
        let socket = directory.join("attach.sock");
        assert_eq!(
            fs::metadata(&socket)
                .expect("stat attach socket")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let mut first = UnixStream::connect(&socket).expect("connect first controller");
        thread::sleep(Duration::from_millis(150));
        let mut busy = UnixStream::connect(&socket).expect("connect busy controller");
        busy.set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set busy controller timeout");
        let mut busy_reply = [0_u8; 64];
        let received = busy
            .read(&mut busy_reply)
            .expect("receive controller busy error");
        assert!(
            String::from_utf8_lossy(&busy_reply[..received]).contains("CONTROLLER_BUSY"),
            "second controller must be rejected"
        );
        first
            .write_all(&encode_frame(FRAME_INPUT, b"one\n"))
            .expect("write first interactive input");
        drop(first);
        thread::sleep(Duration::from_millis(250));

        let mut second = UnixStream::connect(&socket).expect("reconnect controller");
        second
            .write_all(&encode_frame(FRAME_RESIZE, &[0, 100, 0, 30]))
            .expect("resize interactive terminal");
        second
            .write_all(&encode_frame(FRAME_INPUT, b"two\n"))
            .expect("write second interactive input");
        drop(second);

        runner
            .join()
            .expect("join interactive runner")
            .expect("interactive command succeeds");
        let output = fs::read_to_string(directory.join("output.log")).expect("read output log");
        assert!(output.contains("first:one"));
        assert!(output.contains("second:two"));
        assert_eq!(
            read_state(&directory).expect("read final state")["status"],
            "succeeded"
        );
        assert!(
            !socket.exists(),
            "terminal runner must remove attach socket"
        );

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[cfg(unix)]
    #[test]
    fn interactive_job_does_not_echo_controller_input_to_output() {
        let directory = test_job_directory();
        let secret = b"controller-input-must-not-echo";
        write_interactive_test_request(
            &directory,
            "IFS= read ignored; printf 'command-completed\\n'; sleep 1",
        );
        let request = read_request(&directory).expect("read interactive request");
        let runner_directory = directory.clone();
        let runner =
            thread::spawn(move || run_interactive_job_after_handoff(&runner_directory, &request));
        wait_for_attach_socket(&directory);

        let socket = directory.join("attach.sock");
        let mut controller = UnixStream::connect(&socket).expect("connect controller");
        controller
            .set_nonblocking(true)
            .expect("configure controller reads");
        let mut input = secret.to_vec();
        input.push(b'\n');
        controller
            .write_all(&encode_frame(FRAME_INPUT, &input))
            .expect("write private controller input");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut received = Vec::new();
        let mut live_output = Vec::new();
        while Instant::now() < deadline
            && !live_output
                .windows(b"command-completed".len())
                .any(|part| part == b"command-completed")
        {
            let mut chunk = [0_u8; 16 * 1024];
            match controller.read(&mut chunk) {
                Ok(0) => break,
                Ok(length) => received.extend_from_slice(&chunk[..length]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("read controller output: {error}"),
            }
            for (kind, payload) in take_frames(&mut received).expect("decode controller frames") {
                if kind == FRAME_OUTPUT {
                    live_output.extend_from_slice(&payload);
                    assert!(
                        !live_output.windows(secret.len()).any(|part| part == secret),
                        "controller input must not be forwarded as output"
                    );
                }
                assert_ne!(kind, FRAME_ERROR, "broker error: {:?}", payload);
            }
        }
        assert!(
            live_output
                .windows(b"command-completed".len())
                .any(|part| part == b"command-completed"),
            "the command output must still be forwarded"
        );
        drop(controller);

        runner
            .join()
            .expect("join interactive runner")
            .expect("interactive command succeeds");
        let output = fs::read(directory.join("output.log")).expect("read output log");
        assert!(
            !output.windows(secret.len()).any(|part| part == secret),
            "controller input must not be written to output.log"
        );
        let mut persisted_frames = Vec::new();
        for line in fs::read_to_string(directory.join("output.frames.ndjson"))
            .expect("read output frames")
            .lines()
        {
            let frame: Value = serde_json::from_str(line).expect("parse output frame");
            persisted_frames.extend(
                BASE64
                    .decode(frame["data"].as_str().expect("frame data"))
                    .expect("decode output frame"),
            );
        }
        assert!(
            !persisted_frames
                .windows(secret.len())
                .any(|part| part == secret),
            "controller input must not be written to output frames"
        );

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[cfg(unix)]
    #[test]
    fn interactive_job_keeps_forwarding_live_output_after_log_truncation() {
        let directory = test_job_directory();
        write_interactive_test_request_with_limit(
            &directory,
            "IFS= read start; head -c 8192 /dev/zero | tr '\\000' x; printf 'after-limit\\n'; IFS= read done",
            512,
        );
        let request = read_request(&directory).expect("read interactive request");
        let runner_directory = directory.clone();
        let runner =
            thread::spawn(move || run_interactive_job_after_handoff(&runner_directory, &request));
        wait_for_attach_socket(&directory);

        let socket = directory.join("attach.sock");
        let mut controller = UnixStream::connect(&socket).expect("connect controller");
        controller
            .set_nonblocking(true)
            .expect("configure controller reads");
        controller
            .write_all(&encode_frame(FRAME_INPUT, b"start\n"))
            .expect("start interactive output");
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut saw_live_marker = false;
        let mut received = Vec::new();
        let mut live_output = Vec::new();
        while Instant::now() < deadline {
            let mut chunk = [0_u8; 16 * 1024];
            match controller.read(&mut chunk) {
                Ok(0) => break,
                Ok(length) => received.extend_from_slice(&chunk[..length]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("read controller output: {error}"),
            }
            for (kind, payload) in take_frames(&mut received).expect("decode controller frames") {
                if kind == FRAME_OUTPUT {
                    live_output.extend_from_slice(&payload);
                    if live_output
                        .windows(b"after-limit".len())
                        .any(|part| part == b"after-limit")
                    {
                        saw_live_marker = true;
                        break;
                    }
                }
                assert_ne!(kind, FRAME_ERROR, "broker error: {:?}", payload);
            }
            if saw_live_marker {
                break;
            }
        }
        assert!(
            saw_live_marker,
            "PTY output after the persistence quota must still reach the controller"
        );
        controller
            .set_nonblocking(false)
            .expect("use blocking controller writes");
        controller
            .write_all(&encode_frame(FRAME_INPUT, b"done\n"))
            .expect("finish interactive command");
        drop(controller);

        runner
            .join()
            .expect("join interactive runner")
            .expect("interactive command succeeds");
        let state = read_state(&directory).expect("read terminal state");
        let output = fs::read_to_string(directory.join("output.log")).expect("read output log");
        assert_eq!(state["status"], "succeeded");
        assert_eq!(state["truncated"], true);
        assert!(!output.contains("after-limit"));
        assert!(
            !output.contains("done"),
            "controller input must not be logged"
        );

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[cfg(unix)]
    #[test]
    fn slow_controller_is_released_after_four_mebibytes_of_pending_output() {
        let (stream, _peer) = UnixStream::pair().expect("create controller pair");
        let mut controller = Some(stream);
        let mut pending = vec![0_u8; CONTROLLER_MAX_PENDING_OUTPUT_BYTES - 1];

        queue_controller_frame(&mut controller, &mut pending, FRAME_OUTPUT, b"overflow");

        assert!(controller.is_none(), "slow controller must be disconnected");
        assert!(
            pending.is_empty(),
            "released controller must not retain output"
        );
    }

    #[test]
    fn writes_iso_8601_timestamps_to_terminal_state() {
        let directory = test_job_directory();
        write_test_request(&directory, &directory);
        let request = read_request(&directory).expect("read test request");

        write_state(&directory, &request, "succeeded", Some(0), None)
            .expect("write completed state");

        let state = read_state(&directory).expect("read completed state");
        for field in ["createdAt", "updatedAt", "completedAt"] {
            let value = state[field].as_str().expect("timestamp must be a string");
            assert!(
                chrono::DateTime::parse_from_rfc3339(value).is_ok(),
                "{field} must be an ISO-8601 timestamp: {value}"
            );
        }

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[test]
    fn output_capture_bounds_log_and_frames_and_preserves_truncation_state() {
        let directory = test_job_directory();
        write_test_request(&directory, &directory);
        let request = read_request(&directory).expect("read test request");
        write_state(&directory, &request, "running", None, None).expect("write running state");

        let output = Arc::new(Mutex::new(
            OutputCapture::open(&directory, 512).expect("open output capture"),
        ));
        let reader = io::Cursor::new(vec![b'x'; 16 * 1024]);
        capture_stream(reader, "stdout", output, directory.clone())
            .join()
            .expect("join output capture");
        write_state(&directory, &request, "succeeded", Some(0), None)
            .expect("write completed state");

        let log = fs::read(directory.join("output.log")).expect("read output log");
        let frame_line =
            fs::read_to_string(directory.join("output.frames.ndjson")).expect("read output frames");
        let frame: Value = serde_json::from_str(frame_line.trim()).expect("parse output frame");
        let framed = BASE64
            .decode(frame["data"].as_str().expect("frame data"))
            .expect("decode frame data");
        let stored_bytes = fs::metadata(directory.join("output.log"))
            .expect("stat output log")
            .len()
            + fs::metadata(directory.join("output.frames.ndjson"))
                .expect("stat output frames")
                .len();
        let state = read_state(&directory).expect("read completed state");

        assert!(!log.is_empty());
        assert_eq!(framed, log);
        assert!(stored_bytes <= 512, "combined output must fit the quota");
        assert_eq!(state["status"], "succeeded");
        assert_eq!(state["truncated"], true);

        fs::remove_dir_all(directory).expect("remove test job directory");
    }
}
