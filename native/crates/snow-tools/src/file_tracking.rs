//! Bounded attribution at tool boundaries, not an OS write audit.
//! This coordinator is deliberately independent of checkpoint/restore locks.
//! 租约等待同样有界：终端命令窗口不被他人等待，长时间命令不阻塞其他会话。
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 短窗口写者（文件工具 / 格式化）最多等待的时长，覆盖毫秒级的并发写窗口。
pub const WRITER_LEASE_WAIT: Duration = Duration::from_secs(2);
/// 终端命令窗口最多等短窗口写者让位的时间；被其他终端窗口占用立即降级。
pub const TERMINAL_LEASE_WAIT: Duration = Duration::from_millis(500);

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

const MAX_GIT_BYTES: usize = 1024 * 1024;
const READ_CHUNK_BYTES: usize = 4096;
const MAX_FILES: usize = 2048;
const MAX_ENTRIES: usize = 8192;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RESULT_FILES: usize = 256;
const SCAN_TIME: Duration = Duration::from_secs(3);

pub fn physical_path(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::new();
    let mut resolved = loop {
        if let Ok(canonical) = std::fs::canonicalize(ancestor) {
            break canonical;
        }
        suffix.push(ancestor.file_name()?.to_os_string());
        ancestor = ancestor.parent()?;
    };
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    let mut clean = PathBuf::new();
    for component in resolved.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    Some(clean)
}

fn display(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if let Some(unc) = text.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        text.strip_prefix("//?/").unwrap_or(&text).to_string()
    }
}
pub fn path_string(path: &Path) -> String {
    display(path)
}
fn key(path: &Path) -> String {
    let text = display(path);
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}
fn repository_root(path: &Path) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    start
        .ancestors()
        .find(|parent| parent.join(".git").exists())
        .map(Path::to_path_buf)
}
fn overlap(a: &str, b: &str) -> bool {
    a == "*"
        || b == "*"
        || a == b
        || a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/'))
        || b.strip_prefix(a).is_some_and(|rest| rest.starts_with('/'))
}

/// 租约类别：终端命令窗口覆盖整个命令执行期（可能数分钟），短窗口写者
/// （文件工具 / 格式化）只有毫秒级。等待策略据此区分。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LeaseClass {
    Writer,
    Terminal,
}

#[derive(Default)]
struct Coordination {
    next: u64,
    active: BTreeMap<u64, (LeaseClass, Vec<String>, Arc<AtomicBool>)>,
}
static COORDINATION: OnceLock<Mutex<Coordination>> = OnceLock::new();
static NOTIFY: OnceLock<Notify> = OnceLock::new();
fn coordination() -> std::sync::MutexGuard<'static, Coordination> {
    COORDINATION
        .get_or_init(|| Mutex::new(Coordination::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn lease_resources(paths: &[String]) -> Vec<String> {
    let mut resources = Vec::new();
    for path in paths {
        match physical_path(Path::new(path)) {
            Some(path) => {
                resources.push(key(&path));
                // Worktree .git files resolve to their own physical workdir,
                // never the common git dir shared with other worktrees.
                resources.push(
                    repository_root(&path)
                        .map(|root| key(&root))
                        .unwrap_or_else(|| "*".into()),
                );
            }
            None => resources.push("*".into()),
        }
    }
    if resources.is_empty() {
        resources.push("*".into());
    }
    resources.sort();
    resources.dedup();
    resources
}

fn same_domain(held: &[String], resources: &[String]) -> bool {
    // Physical repo roots are equality domains, not path prefixes:
    // nested independent worktrees must not serialize their parent repo.
    held.iter()
        .any(|a| resources.iter().any(|b| a == "*" || b == "*" || a == b))
}

/// 与本次请求冲突的持有者类别；Terminal 优先，决定调用方能否等待。
fn conflict(state: &Coordination, resources: &[String]) -> Option<LeaseClass> {
    let mut busy = None;
    for (class, held, _) in state.active.values() {
        if same_domain(held, resources) {
            if *class == LeaseClass::Terminal {
                return Some(LeaseClass::Terminal);
            }
            busy = Some(LeaseClass::Writer);
        }
    }
    busy
}

/// Keep even degraded operations visible until they finish. Otherwise a new
/// terminal could acquire a clean window while an unreserved write still runs.
fn register_lease(
    state: &mut Coordination,
    resources: Vec<String>,
    class: LeaseClass,
    contaminated: bool,
) -> Arc<WriteLease> {
    if contaminated {
        for (_, held, flag) in state.active.values() {
            if same_domain(held, &resources) {
                flag.store(true, Ordering::Release);
            }
        }
    }
    state.next = state.next.wrapping_add(1);
    let id = state.next;
    let flag = Arc::new(AtomicBool::new(contaminated));
    state.active.insert(id, (class, resources, flag.clone()));
    Arc::new(WriteLease { id, contaminated: flag })
}

/// Arc leases can be carried into blocking writes, so cancellation of the
/// awaiting future cannot release the observation while that write still runs.
/// A contaminated lease is an in-flight marker, NOT an isolated tracking lease.
pub struct WriteLease {
    id: u64,
    contaminated: Arc<AtomicBool>,
}
impl WriteLease {
    pub fn is_contaminated(&self) -> bool {
        self.contaminated.load(Ordering::Acquire)
    }
}
impl Drop for WriteLease {
    fn drop(&mut self) {
        coordination().active.remove(&self.id);
        NOTIFY.get_or_init(Notify::new).notify_waiters();
    }
}

/// Bounded isolation attempt. Conflicting terminals or elapsed waits yield a
/// contaminated observation marker, never a long-lived exclusion lock. Every
/// caller must check contamination before trusting differential attribution.
pub async fn coordinate(
    paths: &[String],
    class: LeaseClass,
    wait: Duration,
) -> Option<Arc<WriteLease>> {
    let resources = lease_resources(paths);
    let deadline = Instant::now() + wait;
    loop {
        let notified = NOTIFY.get_or_init(Notify::new).notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let mut state = coordination();
            match conflict(&state, &resources) {
                None => return Some(register_lease(&mut state, resources, class, false)),
                Some(LeaseClass::Terminal) => {
                    return Some(register_lease(&mut state, resources, class, true));
                }
                Some(LeaseClass::Writer) if Instant::now() >= deadline => {
                    // The timeout branch must also poison existing windows.
                    return Some(register_lease(&mut state, resources, class, true));
                }
                Some(LeaseClass::Writer) => {}
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            // Recheck and register under the coordinator mutex even on timeout.
            // This closes the gap between noticing contention and executing.
            let _ = tokio::time::timeout(remaining, notified).await;
        }
    }
}

fn envelope(
    source: &str,
    root: Option<&Path>,
    coverage: &str,
    reasons: BTreeSet<String>,
    files: Vec<Value>,
) -> Value {
    json!({"version":1,"source":source,"root":root.map(display),"coverage":coverage,"reasons":reasons,"files":files})
}
fn file(path: &Path, kind: &str) -> Value {
    json!({"filePath":display(path),"fileKey":key(path),"kind":kind})
}
pub fn unavailable(source: &str, reason: &str) -> Value {
    let mut reasons = BTreeSet::from([reason.to_string()]);
    if source == "terminal" {
        reasons.insert("terminal-boundary".into());
    }
    envelope(source, None, "unavailable", reasons, vec![])
}

/// Observe only the explicit targets inside the actual blocking write boundary.
pub fn filesystem_before(paths: &[String]) -> Vec<(String, PathBuf, Option<bool>)> {
    paths
        .iter()
        .filter_map(|original| {
            let path = physical_path(Path::new(original))?;
            let exists = match std::fs::metadata(&path) {
                Ok(_) => Some(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
                Err(_) => None,
            };
            Some((original.clone(), path, exists))
        })
        .collect()
}
pub fn filesystem_after(
    before: Vec<(String, PathBuf, Option<bool>)>,
    result: &Value,
    expected: usize,
    isolated: bool,
) -> Value {
    let root = before.first().and_then(|(_, path, _)| {
        repository_root(path).or_else(|| path.parent().map(Path::to_path_buf))
    });
    let mut reasons = BTreeSet::from(["explicit-targets".to_string()]);
    if !isolated {
        reasons.insert("concurrent-execution".into());
        reasons.insert("operation-evidence-only".into());
    }
    let mut files = Vec::new();
    if before.len() != expected {
        reasons.insert("path-resolution-failed".into());
    }
    if result.get("success").and_then(Value::as_bool) == Some(true) {
        for (original, path, existed) in before {
            // These tools write files; cutting lines rewrites the source and
            // never deletes the source file. A concurrent disappearance is not
            // evidence that this successful operation deleted anything.
            let Some(after_path) = physical_path(Path::new(&original)) else {
                reasons.insert("path-resolution-failed".into());
                continue;
            };
            if key(&after_path) != key(&path) {
                reasons.insert("path-identity-changed".into());
                continue;
            }
            match std::fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => {
                    let kind = if isolated {
                        match existed {
                            Some(true) => "edit",
                            Some(false) => "create",
                            None => {
                                reasons.insert("metadata-unavailable".into());
                                continue;
                            }
                        }
                    } else {
                        // In degraded evidence, edit denotes the confirmed write
                        // to this target, not an inferred absent->present change.
                        // Do not infer create/delete from a racing disk snapshot.
                        "edit"
                    };
                    files.push(file(&path, kind));
                }
                _ => {
                    reasons.insert("metadata-unavailable".into());
                }
            }
        }
    } else {
        reasons.insert("tool-not-successful".into());
    }
    files.sort_by_key(|value| value["fileKey"].as_str().unwrap_or_default().to_string());
    files.dedup_by(|a, b| a["fileKey"] == b["fileKey"]);
    let coverage = if !isolated || reasons.len() > 1 {
        "partial"
    } else {
        "scoped"
    };
    envelope("filesystem", root.as_deref(), coverage, reasons, files)
}

struct Snapshot {
    entries: BTreeMap<String, (PathBuf, Option<blake3::Hash>)>,
    complete: bool,
    reasons: BTreeSet<String>,
}
async fn git_paths(root: &Path) -> Result<Vec<PathBuf>, &'static str> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "git-list-unavailable")?;
    let mut bytes = Vec::new();
    let mut stdout = child.stdout.take().ok_or("git-list-unavailable")?;
    let mut buffer = [0_u8; READ_CHUNK_BYTES];
    loop {
        let read_limit = buffer.len().min(MAX_GIT_BYTES - bytes.len() + 1);
        let read = stdout
            .read(&mut buffer[..read_limit])
            .await
            .map_err(|_| "git-list-unavailable")?;
        if read == 0 {
            break;
        }
        if read > MAX_GIT_BYTES - bytes.len() {
            return Err("git-list-byte-limit");
        }
        // Tracking is optional: allocation failure must degrade coverage, not abort the app.
        bytes
            .try_reserve(read)
            .map_err(|_| "git-list-allocation-failed")?;
        bytes.extend_from_slice(&buffer[..read]);
    }
    if !child
        .wait()
        .await
        .map_err(|_| "git-list-unavailable")?
        .success()
    {
        return Err("git-list-unavailable");
    }
    let mut paths = Vec::new();
    for part in bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        let text = std::str::from_utf8(part).map_err(|_| "git-path-encoding")?;
        let relative = Path::new(text);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("git-path-invalid");
        }
        paths.push(root.join(relative));
        if paths.len() > MAX_ENTRIES {
            return Err("file-list-limit");
        }
    }
    Ok(paths)
}
async fn scan(root: &Path, previous: Option<&Snapshot>) -> Snapshot {
    let mut snapshot = Snapshot {
        entries: BTreeMap::new(),
        complete: true,
        reasons: BTreeSet::new(),
    };
    let mut paths = BTreeSet::new();
    if repository_root(root).as_deref() == Some(root) {
        snapshot
            .reasons
            .insert("git-list-scope:tracked-and-untracked-excluding-ignored".into());
        match git_paths(root).await {
            Ok(list) => paths.extend(list),
            Err(reason) => {
                snapshot.complete = false;
                snapshot.reasons.insert(reason.into());
            }
        }
    } else {
        snapshot
            .reasons
            .insert("non-git-scope:build-dependencies-and-symlinks-excluded".into());
        let mut directories = vec![root.to_path_buf()];
        let mut count = 0;
        'walk: while let Some(directory) = directories.pop() {
            let Ok(mut entries) = tokio::fs::read_dir(&directory).await else {
                snapshot.complete = false;
                snapshot.reasons.insert("directory-read-failed".into());
                continue;
            };
            loop {
                let entry = match entries.next_entry().await {
                    Ok(Some(entry)) => entry,
                    Ok(None) => break,
                    Err(_) => {
                        snapshot.complete = false;
                        snapshot.reasons.insert("directory-read-failed".into());
                        break;
                    }
                };
                count += 1;
                if count > MAX_ENTRIES {
                    snapshot.complete = false;
                    snapshot.reasons.insert("file-list-limit".into());
                    break 'walk;
                }
                let Ok(kind) = entry.file_type().await else {
                    snapshot.complete = false;
                    snapshot.reasons.insert("metadata-unavailable".into());
                    continue;
                };
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if !matches!(
                        entry.file_name().to_str(),
                        Some(
                            ".git" | "node_modules" | "target" | "dist" | "out" | "build" | ".snow"
                        )
                    ) {
                        directories.push(entry.path());
                    }
                } else if kind.is_file() {
                    paths.insert(entry.path());
                }
            }
        }
    }
    if let Some(previous) = previous {
        paths.extend(previous.entries.values().map(|(path, _)| path.clone()));
    }
    let mut total = 0;
    for path in paths {
        if snapshot.entries.len() >= MAX_FILES {
            snapshot.complete = false;
            snapshot.reasons.insert("file-count-limit".into());
            break;
        }
        // Do not follow symlinks outside the scan root (nor directory symlinks).
        let Some(physical) = physical_path(&path) else {
            snapshot.complete = false;
            snapshot.reasons.insert("path-resolution-failed".into());
            continue;
        };
        if !overlap(&key(root), &key(&physical)) || !key(&physical).starts_with(&(key(root) + "/"))
        {
            snapshot.reasons.insert("external-symlink-excluded".into());
            continue;
        }
        // Separate (even nested) Git worktrees have their own coordination
        // domain; the parent repository must not attribute their writes.
        if repository_root(root).as_deref() == Some(root)
            && repository_root(&physical).as_deref() != Some(root)
        {
            snapshot.reasons.insert("nested-repository-excluded".into());
            continue;
        }
        let metadata = match tokio::fs::metadata(&physical).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                snapshot.entries.insert(key(&physical), (physical, None));
                continue;
            }
            Err(_) => {
                snapshot.complete = false;
                snapshot.reasons.insert("metadata-unavailable".into());
                continue;
            }
        };
        if !metadata.is_file() {
            snapshot.complete = false;
            snapshot.reasons.insert("non-file-excluded".into());
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES || total + metadata.len() > MAX_BYTES {
            snapshot.complete = false;
            snapshot.reasons.insert("content-byte-limit".into());
            continue;
        }
        let Ok(mut input) = tokio::fs::File::open(&physical).await else {
            snapshot.complete = false;
            snapshot.reasons.insert("file-read-failed".into());
            continue;
        };
        // Only the fingerprint is needed; never allocate a buffer the size of the file.
        let mut hasher = blake3::Hasher::new();
        let mut buffer = [0_u8; READ_CHUNK_BYTES];
        let mut file_bytes = 0_u64;
        let hash = loop {
            // Probe one byte beyond either budget, including when a file grows after metadata.
            let read_limit = (buffer.len() as u64)
                .min(MAX_FILE_BYTES - file_bytes + 1)
                .min(MAX_BYTES.saturating_sub(total) + 1) as usize;
            let read = match input.read(&mut buffer[..read_limit]).await {
                Ok(0) => break Some(hasher.finalize()),
                Ok(read) => read,
                Err(_) => {
                    snapshot.complete = false;
                    snapshot.reasons.insert("file-read-failed".into());
                    break None;
                }
            };
            file_bytes += read as u64;
            // Failed/over-limit files still consume the scan's actual I/O budget.
            total += read as u64;
            if file_bytes > MAX_FILE_BYTES || total > MAX_BYTES {
                snapshot.complete = false;
                snapshot.reasons.insert("content-byte-limit".into());
                break None;
            }
            hasher.update(&buffer[..read]);
        };
        if let Some(hash) = hash {
            snapshot
                .entries
                .insert(key(&physical), (physical, Some(hash)));
        }
    }
    snapshot
}
async fn bounded_scan(root: &Path, previous: Option<&Snapshot>) -> Option<Snapshot> {
    tokio::time::timeout(SCAN_TIME, scan(root, previous))
        .await
        .ok()
}

pub struct TerminalTracking {
    root: Option<PathBuf>,
    before: Option<Snapshot>,
    reason: Option<&'static str>,
    _lease: Option<Arc<WriteLease>>,
}
impl TerminalTracking {
    pub async fn begin(args: &Value, remote: bool) -> Self {
        let reason = if remote {
            Some("ssh")
        } else if args.get("detach").and_then(Value::as_bool) == Some(true) {
            Some("detached")
        } else {
            None
        };
        let root = args
            .get("workingDirectory")
            .and_then(Value::as_str)
            .filter(|_| !remote)
            .and_then(|root| physical_path(Path::new(root)))
            .map(|path| repository_root(&path).unwrap_or(path));
        let mut tracking = Self {
            root,
            before: None,
            reason,
            _lease: None,
        };
        if !remote {
            // Even an untracked local command (detached or missing a root) must
            // be visible to other active windows while this invocation runs.
            let paths = tracking.root.as_ref().map(|root| vec![display(root)])
                .unwrap_or_default();
            tracking._lease = coordinate(&paths, LeaseClass::Terminal, TERMINAL_LEASE_WAIT).await;
        }
        if tracking.reason.is_none() {
            if let Some(root) = tracking.root.as_ref() {
                if tracking._lease.as_ref().is_some_and(|lease| !lease.is_contaminated()) {
                    tracking.before = bounded_scan(root, None).await;
                } else {
                    tracking.reason = Some("concurrent-execution");
                }
            } else {
                tracking.reason = Some("root-unavailable");
            }
        }
        tracking
    }
    pub async fn finish(self) -> Value {
        if self._lease.as_ref().is_some_and(|lease| lease.is_contaminated()) {
            return unavailable("terminal", "concurrent-execution");
        }
        if let Some(reason) = self.reason {
            return unavailable("terminal", reason);
        }
        let Some(root) = self.root.as_ref() else {
            return unavailable("terminal", "root-unavailable");
        };
        let after = bounded_scan(root, self.before.as_ref()).await;
        if self._lease.as_ref().is_some_and(|lease| lease.is_contaminated()) {
            return unavailable("terminal", "concurrent-execution");
        }
        let (Some(before), Some(after)) = (self.before, after) else {
            return envelope(
                "terminal",
                Some(root),
                "unavailable",
                BTreeSet::from(["terminal-boundary".into(), "scan-time-limit".into()]),
                vec![],
            );
        };
        let mut reasons = before.reasons;
        reasons.extend(after.reasons);
        reasons.insert("terminal-boundary".into());
        let mut files = Vec::new();
        for (identity, (path, current)) in &after.entries {
            let old = before.entries.get(identity).map(|(_, hash)| hash);
            let kind = match (old, current) {
                (Some(Some(old)), Some(new)) if old != new => Some("edit"),
                (Some(Some(_)), None) => Some("delete"),
                (Some(None), Some(_)) => Some("create"),
                (None, Some(_)) if before.complete => Some("create"),
                _ => None,
            };
            if let Some(kind) = kind {
                if files.len() == MAX_RESULT_FILES {
                    reasons.insert("response-file-limit".into());
                    break;
                }
                files.push(file(path, kind));
            }
        }
        // Serialize the final contamination check with new window admission,
        // but hold no coordinator mutex during scans or command execution.
        let _coordination_guard = coordination();
        if self._lease.as_ref().is_some_and(|lease| lease.is_contaminated()) {
            return unavailable("terminal", "concurrent-execution");
        }
        envelope("terminal", Some(root), "partial", reasons, files)
    }
}
