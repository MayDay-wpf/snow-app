use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use similar::TextDiff;

use super::gitignore::GitignoreMatcher;

const CHECKPOINT_DIR_NAME: &str = "checkpoints";
const OBJECT_DIR_NAME: &str = "objects";
const PENDING_DIR_NAME: &str = "pending";
const MANIFEST_VERSION: u32 = 2;

/// Prefix marking a manifest entry path as an absolute path outside the
/// checkpoint's working directory. Entries whose path starts with this marker
/// store the full absolute filesystem path (after the marker) instead of a
/// path relative to `work_dir`. This lets the checkpoint system record and
/// restore files edited outside the project workspace (e.g. `~/.snow/settings.json`).
const ABSOLUTE_PATH_MARKER: &str = "\x00abs:";

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "out",
    "coverage",
    ".cache",
    ".turbo",
    ".vercel",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    ".vs",
    ".snow",
    ".snowapp",
    "release",
    ".output",
    ".angular",
    ".parcel-cache",
];

static COUNTER: AtomicU64 = AtomicU64::new(0);
static CHECKPOINT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// 进程内 diff 缓存上限：超过后整体清空（LRU 之外的简单防膨胀手段，
/// diff 成本远低于全量重算，清空后逐次重建即可）。
const DIFF_CACHE_MAX_ENTRIES: usize = 2048;

struct CachedCheckpointDiff {
    /// original 状态摘要（object_id / git head+path / missing），作为失效依据之一
    original_digest: String,
    current_mtime_ms: u64,
    current_size: u64,
    content: String,
    is_binary: bool,
}

/// 进程内 diff 缓存：key = "{checkpoint_id}:{path}"。
/// 命中条件：original 摘要一致 + 磁盘文件 mtime/size 未变。
/// 工具高频循环下，list_checkpoint_diffs 对未变化文件直接复用已生成的
/// unified diff，避免反复读文件 + TextDiff 全量计算（P0-4 性能优化）。
static DIFF_CACHE: OnceLock<Mutex<HashMap<String, CachedCheckpointDiff>>> = OnceLock::new();

fn diff_cache() -> MutexGuard<'static, HashMap<String, CachedCheckpointDiff>> {
    DIFF_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn original_digest(original: &OriginalState, git: Option<&GitBaseline>, path: &str) -> String {
    match original {
        OriginalState::Missing => "missing".to_string(),
        OriginalState::Object { object_id } => format!("obj:{object_id}"),
        OriginalState::Git => format!(
            "git:{}:{path}",
            git.map(|baseline| baseline.head.as_str()).unwrap_or("?")
        ),
    }
}

#[derive(Serialize, Deserialize)]
struct CheckpointManifest {
    version: u32,
    work_dir: String,
    git: Option<GitBaseline>,
    entries: Vec<CheckpointEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct GitBaseline {
    repository_root: String,
    work_dir_prefix: String,
    head: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CheckpointEntry {
    path: String,
    original: OriginalState,
    #[serde(default)]
    expected: Option<OriginalState>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum OriginalState {
    Missing,
    Object { object_id: String },
    Git,
}
struct PendingFileState {
    /// Snapshot copy of an untracked file (its only pre-command content
    /// source). `None` for git-tracked files, whose pre-command content is
    /// recovered from the git object database at capture time — copying every
    /// tracked file on every tool execution was the main performance killer
    /// under concurrent terminal commands.
    snapshot: Option<PathBuf>,
    /// Pre-command mtime (ms) and size used as a cheap first-pass change
    /// detector for tracked files; a match skips the content read entirely.
    mtime_ms: u64,
    size: u64,
    /// Whether the file was tracked by git when the capture was taken.
    tracked: bool,
}

pub struct CheckpointWorktreeCapture {
    checkpoint_ids: Vec<String>,
    work_dir: String,
    /// Git baseline when the work dir is inside a repository. `Some` selects
    /// the git-driven capture path: the before/after passes run `git diff` /
    /// `git ls-files --others` instead of walking the whole worktree, and only
    /// dirty tracked + untracked files are snapshotted. `None` (non-git work
    /// dir or git failure) falls back to the legacy full-traversal copy path.
    baseline: Option<GitBaseline>,
    /// Single shared path set for all checkpoints in this capture. All
    /// checkpoints are validated against the same `work_dir` during capture,
    /// so one result serves every checkpoint. On the git-driven path this is
    /// the pre-command dirty tracked + untracked set (everything snapshotted);
    /// on the legacy path it is the full worktree file set.
    before_paths: HashSet<String>,
    before_states: HashMap<String, PendingFileState>,
    pending_dir: PathBuf,
}

impl Drop for CheckpointWorktreeCapture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.pending_dir);
    }
}
fn checkpoint_root() -> Result<PathBuf> {
    let storage_dir = crate::storage::paths::app_storage_dir()?;
    Ok(storage_dir.join(CHECKPOINT_DIR_NAME))
}

fn checkpoint_guard() -> Result<MutexGuard<'static, ()>> {
    CHECKPOINT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| Error::from_reason("Checkpoint state lock is poisoned"))
}

fn should_skip_relative(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .map(|value| SKIP_DIRS.contains(&value))
            .unwrap_or(false),
        _ => false,
    })
}

fn generate_checkpoint_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("cp-{}-{}-{}", now.as_secs(), now.subsec_nanos(), count)
}

fn to_forward_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn from_forward_slashes(relative: &str) -> PathBuf {
    PathBuf::from(relative.replace('/', &std::path::MAIN_SEPARATOR.to_string()))
}

fn canonical_work_dir(work_dir: &str) -> Result<PathBuf> {
    let root = Path::new(work_dir);
    if !root.exists() {
        return Err(Error::from_reason(format!(
            "Working directory does not exist: {work_dir}"
        )));
    }
    if !root.is_dir() {
        return Err(Error::from_reason(format!(
            "Path is not a directory: {work_dir}"
        )));
    }
    fs::canonicalize(root).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve working directory '{}': {error}",
            root.display()
        ))
    })
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// Strip Windows extended-length path prefixes so absolute and canonical paths
/// can be compared consistently.
///
/// `fs::canonicalize` on Windows returns paths like `\\?\D:\repo` or
/// `\\?\UNC\server\share`. Logical absolute paths from the AI / UI usually do
/// not include this prefix, so `starts_with` would otherwise reject in-workspace
/// absolute paths (especially for files that do not exist yet).
fn strip_windows_extended_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn path_key(path: &Path) -> String {
    let stripped = strip_windows_extended_prefix(path);
    let mut key = stripped.to_string_lossy().replace('\\', "/");
    while key.ends_with('/') && key.len() > 1 {
        key.pop();
    }
    #[cfg(windows)]
    {
        key = key.to_ascii_lowercase();
    }
    key
}

fn is_path_within_root(path: &Path, root: &Path) -> bool {
    let candidate_key = path_key(path);
    let base_key = path_key(root);
    candidate_key == base_key || candidate_key.starts_with(&format!("{base_key}/"))
}

/// Resolve a path that may not exist yet while preserving the same Windows
/// extended-path form as `fs::canonicalize` on the parent directory.
fn resolve_path_for_checkpoint(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to resolve checkpoint path '{}': {error}",
                path.display()
            ))
        });
    }

    let normalized = normalize_path(path);
    if let Some(parent) = normalized.parent() {
        if !parent.as_os_str().is_empty() && parent.exists() {
            let parent_canonical = fs::canonicalize(parent).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to resolve checkpoint path parent '{}': {error}",
                    parent.display()
                ))
            })?;
            if let Some(file_name) = normalized.file_name() {
                return Ok(parent_canonical.join(file_name));
            }
        }
    }

    Ok(strip_windows_extended_prefix(&normalized))
}

fn resolve_checkpoint_path(root: &Path, file_path: &str) -> Result<(PathBuf, String)> {
    let supplied = Path::new(file_path);
    let candidate = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        // Join relative paths against the logical root so Windows extended
        // prefixes do not leak into intermediate path components.
        strip_windows_extended_prefix(root).join(supplied)
    };
    let normalized = resolve_path_for_checkpoint(&candidate)?;

    if !is_path_within_root(&normalized, root) {
        // File is outside the checkpoint's working directory (e.g. editing
        // `~/.snow/settings.json`). Store it as an absolute-path-marked entry
        // so the checkpoint can still record and restore it on rollback.
        let abs_key = to_forward_slashes(&strip_windows_extended_prefix(&normalized));
        let marked = format!("{ABSOLUTE_PATH_MARKER}{abs_key}");
        return Ok((normalized, marked));
    }

    let relative = {
        let path_key_value = path_key(&normalized);
        let root_key_value = path_key(root);
        if path_key_value == root_key_value {
            String::new()
        } else {
            let relative_key = path_key_value
                .strip_prefix(&format!("{root_key_value}/"))
                .ok_or_else(|| Error::from_reason("Failed to create checkpoint-relative path"))?;
            relative_key.to_string()
        }
    };
    Ok((normalized, relative))
}

/// Resolve a manifest entry path back to an absolute filesystem path.
///
/// Paths stored with the `ABSOLUTE_PATH_MARKER` prefix are outside-workspace
/// absolute paths and are returned as-is (after stripping the marker).
/// All other paths are treated as relative to `root` and joined accordingly.
fn resolve_manifest_path(root: &Path, manifest_path: &str) -> PathBuf {
    if let Some(abs_path) = manifest_path.strip_prefix(ABSOLUTE_PATH_MARKER) {
        from_forward_slashes(abs_path)
    } else {
        root.join(from_forward_slashes(manifest_path))
    }
}

/// Check whether a manifest entry path should be skipped (e.g. it falls inside
/// a `node_modules` or `.git` directory). Absolute-path-marked entries are
/// never skipped by this check — they represent files outside the workspace
/// that the user explicitly chose to edit.
fn should_skip_manifest_path(manifest_path: &str) -> bool {
    if manifest_path.starts_with(ABSOLUTE_PATH_MARKER) {
        return false;
    }
    should_skip_relative(Path::new(manifest_path))
}

fn checkpoint_dir(checkpoint_id: &str) -> Result<PathBuf> {
    Ok(checkpoint_root()?.join(checkpoint_id))
}
fn manifest_path(checkpoint_id: &str) -> Result<PathBuf> {
    Ok(checkpoint_dir(checkpoint_id)?.join("manifest.json"))
}

/// Check whether a checkpoint manifest file exists on disk.
fn checkpoint_manifest_exists(checkpoint_id: &str) -> bool {
    match manifest_path(checkpoint_id) {
        Ok(path) => path.is_file(),
        Err(_) => false,
    }
}

/// Filter out checkpoint IDs whose manifest no longer exists on disk.
///
/// When a conversation is resumed from history, the frontend reconstructs the
/// `checkpoint_ids` list from persisted message records. Some of those
/// checkpoints may have been deleted (by rollback, compaction cleanup, or
/// new-chat pruning), leaving dangling IDs that would cause `read_manifest`
/// to fail. This helper silently drops them so tool execution can proceed
/// against the still-valid checkpoints.
fn filter_existing_checkpoints(checkpoint_ids: Vec<String>) -> Vec<String> {
    checkpoint_ids
        .into_iter()
        .filter(|id| checkpoint_manifest_exists(id))
        .collect()
}

fn read_manifest(checkpoint_id: &str) -> Result<CheckpointManifest> {
    let path = manifest_path(checkpoint_id)?;
    let json = fs::read_to_string(&path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read checkpoint manifest '{}': {error}",
            path.display()
        ))
    })?;
    let manifest: CheckpointManifest = serde_json::from_str(&json).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse checkpoint manifest '{}': {error}",
            path.display()
        ))
    })?;
    if manifest.version != MANIFEST_VERSION {
        return Err(Error::from_reason(format!(
            "Unsupported checkpoint format version: {}",
            manifest.version
        )));
    }
    Ok(manifest)
}

fn write_manifest(checkpoint_id: &str, manifest: &CheckpointManifest) -> Result<()> {
    let directory = checkpoint_dir(checkpoint_id)?;
    fs::create_dir_all(&directory).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint directory '{}': {error}",
            directory.display()
        ))
    })?;
    let json = serde_json::to_vec(manifest).map_err(|error| {
        Error::from_reason(format!("Failed to serialize checkpoint manifest: {error}"))
    })?;
    let temporary = directory.join(format!("manifest-{}.tmp", generate_checkpoint_id()));
    fs::write(&temporary, json).map_err(|error| {
        Error::from_reason(format!(
            "Failed to write checkpoint manifest '{}': {error}",
            temporary.display()
        ))
    })?;
    fs::rename(&temporary, directory.join("manifest.json")).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::from_reason(format!("Failed to publish checkpoint manifest: {error}"))
    })
}

fn run_git(work_dir: &Path, args: &[&str]) -> Result<Output> {
    let mut command = Command::new("git");
    // `safe.directory=*` bypasses Git's dubious-ownership check
    // (CVE-2022-24765), so git works inside WSL (`\\wsl$\...`) and other
    // UNC/network paths where the repo is owned by a different user.
    command
        .args(["-c", "core.quotepath=false", "-c", "safe.directory=*"])
        .args(args)
        .current_dir(work_dir);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .output()
        .map_err(|error| Error::from_reason(format!("Failed to execute git: {error}")))
}

fn git_text(work_dir: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(work_dir, args).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn detect_git_baseline(work_dir: &Path) -> Option<GitBaseline> {
    let repository_root = git_text(work_dir, &["rev-parse", "--show-toplevel"])?;
    let head = git_text(work_dir, &["rev-parse", "HEAD"])?;
    let repository_root = fs::canonicalize(repository_root).ok()?;
    let prefix = work_dir.strip_prefix(&repository_root).ok()?;
    Some(GitBaseline {
        repository_root: repository_root.to_string_lossy().to_string(),
        work_dir_prefix: to_forward_slashes(prefix),
        head,
    })
}

fn checkpoint_git_ref(checkpoint_id: &str) -> String {
    format!("refs/snow/checkpoints/{checkpoint_id}")
}

fn update_checkpoint_git_ref(
    checkpoint_id: &str,
    baseline: &GitBaseline,
    delete: bool,
) -> Result<()> {
    let repository_root = Path::new(&baseline.repository_root);
    let reference = checkpoint_git_ref(checkpoint_id);
    let output = if delete {
        run_git(repository_root, &["update-ref", "-d", &reference])?
    } else {
        run_git(repository_root, &["update-ref", &reference, &baseline.head])?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::from_reason(format!(
            "Failed to update checkpoint Git reference: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn collect_worktree_file_paths(root: &Path) -> Result<HashSet<String>> {
    let mut matcher = GitignoreMatcher::from_project_root(root);
    let mut paths = HashSet::new();
    let mut directories = vec![root.to_path_buf()];

    while let Some(directory) = directories.pop() {
        // 进入子目录时加载该目录自己的 .gitignore（root 的规则已由
        // from_project_root 加载）。LIFO 遍历保证父目录规则先于子目录
        // 规则加入 matcher,与 git 的"深层规则覆盖浅层规则"语义一致;
        // 前缀化后的规则锚定到各自目录,不会误伤兄弟目录。
        if directory != root {
            let dir_relative = directory.strip_prefix(root).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to resolve checkpoint-relative directory '{}': {error}",
                    directory.display()
                ))
            })?;
            matcher.load_directory_gitignore(&root, dir_relative);
        }

        let entries = fs::read_dir(&directory).map_err(|error| {
            Error::from_reason(format!(
                "Failed to scan checkpoint directory '{}': {error}",
                directory.display()
            ))
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                Error::from_reason(format!("Failed to read checkpoint entry: {error}"))
            })?;
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to resolve checkpoint-relative path '{}': {error}",
                    path.display()
                ))
            })?;
            if should_skip_relative(relative) {
                continue;
            }

            let file_type = entry.file_type().map_err(|error| {
                Error::from_reason(format!(
                    "Failed to inspect checkpoint path '{}': {error}",
                    path.display()
                ))
            })?;
            if file_type.is_symlink() {
                continue;
            }

            let relative_path = to_forward_slashes(relative);
            if matcher.is_ignored(&relative_path, file_type.is_dir()) {
                continue;
            }

            if file_type.is_dir() {
                directories.push(path);
            } else if file_type.is_file() {
                paths.insert(relative_path);
            }
        }
    }

    Ok(paths)
}

fn git_object_spec(baseline: &GitBaseline, relative: &str) -> String {
    let repository_path = if baseline.work_dir_prefix.is_empty() {
        relative.to_string()
    } else {
        format!(
            "{}/{}",
            baseline.work_dir_prefix.trim_end_matches('/'),
            relative
        )
    };
    format!("{}:{}", baseline.head, repository_path)
}

fn read_git_object(baseline: &GitBaseline, relative: &str) -> Result<Option<Vec<u8>>> {
    let repository_root = Path::new(&baseline.repository_root);
    let object_spec = git_object_spec(baseline, relative);
    let output = run_git(repository_root, &["show", &object_spec])?;
    if output.status.success() {
        Ok(Some(output.stdout))
    } else {
        Ok(None)
    }
}

fn store_object(path: &Path) -> Result<String> {
    let object_dir = checkpoint_root()?.join(OBJECT_DIR_NAME);
    fs::create_dir_all(&object_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object directory: {error}"
        ))
    })?;
    let temporary = object_dir.join(format!("{}.tmp", generate_checkpoint_id()));
    let mut source = File::open(path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read checkpoint source '{}': {error}",
            path.display()
        ))
    })?;
    let mut destination = File::create(&temporary).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object '{}': {error}",
            temporary.display()
        ))
    })?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).map_err(|error| {
            Error::from_reason(format!("Failed to read checkpoint source: {error}"))
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        destination.write_all(&buffer[..count]).map_err(|error| {
            Error::from_reason(format!("Failed to write checkpoint object: {error}"))
        })?;
    }
    destination.flush().map_err(|error| {
        Error::from_reason(format!("Failed to flush checkpoint object: {error}"))
    })?;

    let object_id = hasher.finalize().to_hex().to_string();
    let final_path = object_dir.join(&object_id);
    if final_path.exists() {
        let _ = fs::remove_file(&temporary);
    } else {
        fs::rename(&temporary, &final_path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!("Failed to publish checkpoint object: {error}"))
        })?;
    }
    Ok(object_id)
}

fn current_state(path: &Path) -> Result<OriginalState> {
    if !path.exists() {
        return Ok(OriginalState::Missing);
    }
    if !path.is_file() {
        return Err(Error::from_reason(format!(
            "Checkpoint path is not a regular file: {}",
            path.display()
        )));
    }
    Ok(OriginalState::Object {
        object_id: store_object(path)?,
    })
}

fn states_match(
    current: &Path,
    expected: &OriginalState,
    baseline: Option<&GitBaseline>,
    relative: &str,
) -> Result<bool> {
    Ok(classify_change(current, expected, baseline, relative)?.is_none())
}

fn update_expected_state(
    manifest: &mut CheckpointManifest,
    absolute: &Path,
    path: &str,
) -> Result<bool> {
    let Some(entry) = manifest.entries.iter_mut().find(|entry| entry.path == path) else {
        return Ok(false);
    };
    entry.expected = Some(current_state(absolute)?);
    Ok(true)
}

fn capture_entry(
    manifest: &mut CheckpointManifest,
    absolute: &Path,
    relative: &Path,
    original: OriginalState,
) -> Result<()> {
    if relative.as_os_str().is_empty() || should_skip_relative(relative) {
        return Ok(());
    }
    let path = to_forward_slashes(relative);
    let expected = current_state(absolute)?;
    if let Some(entry) = manifest.entries.iter_mut().find(|entry| entry.path == path) {
        entry.expected = Some(expected);
        return Ok(());
    }

    manifest.entries.push(CheckpointEntry {
        path,
        original,
        expected: Some(expected),
    });
    Ok(())
}

fn validate_manifest_work_dir(manifest: &CheckpointManifest, work_dir: &str) -> Result<PathBuf> {
    let requested = canonical_work_dir(work_dir)?;
    let recorded = PathBuf::from(&manifest.work_dir);
    if requested != recorded {
        return Err(Error::from_reason(format!(
            "Checkpoint belongs to '{}', not '{}'",
            recorded.display(),
            requested.display()
        )));
    }
    Ok(requested)
}

/// 捕获阶段的目录校验(工具执行前/后):checkpoint 属于其他目录时返回
/// None,调用方跳过该 checkpoint 并继续,绝不因目录不匹配拦截工具执行。
/// 回滚阶段仍由 validate_manifest_work_dir 严格校验。
fn validate_capture_work_dir(manifest: &CheckpointManifest, work_dir: &str) -> Option<PathBuf> {
    match validate_manifest_work_dir(manifest, work_dir) {
        Ok(root) => Some(root),
        Err(error) => {
            eprintln!("[checkpoint] {error}; skipping checkpoint capture");
            None
        }
    }
}

/// Create an incremental checkpoint without copying the working directory.
/// File content is captured lazily, immediately before a tool first changes it.
pub fn create_checkpoint(work_dir: String) -> Result<String> {
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;
    let checkpoint_id = generate_checkpoint_id();
    let manifest = CheckpointManifest {
        version: MANIFEST_VERSION,
        work_dir: root.to_string_lossy().to_string(),
        git: detect_git_baseline(&root),
        entries: Vec::new(),
    };

    write_manifest(&checkpoint_id, &manifest)?;
    if let Some(baseline) = manifest.git.as_ref() {
        if let Err(error) = update_checkpoint_git_ref(&checkpoint_id, baseline, false) {
            let _ = fs::remove_dir_all(checkpoint_dir(&checkpoint_id)?);
            return Err(error);
        }
    }
    Ok(checkpoint_id)
}

/// Capture the original state of one file before a filesystem tool changes it.
pub fn record_checkpoint_file(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    file_path: String,
) -> Result<()> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(());
    }
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;
    let (absolute, path) = resolve_checkpoint_path(&root, &file_path)?;
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    for checkpoint_id in checkpoint_ids {
        let mut manifest = read_manifest(&checkpoint_id)?;
        let Some(_root) = validate_capture_work_dir(&manifest, &work_dir) else {
            continue;
        };
        if manifest.entries.iter().any(|entry| entry.path == path) {
            continue;
        }
        manifest.entries.push(CheckpointEntry {
            path: path.clone(),
            original: current_state(&absolute)?,
            expected: None,
        });
        write_manifest(&checkpoint_id, &manifest)?;
    }
    Ok(())
}

/// Record the state produced by a successful filesystem tool execution.
pub fn record_checkpoint_file_after(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    file_path: String,
) -> Result<()> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(());
    }
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;
    let (absolute, path) = resolve_checkpoint_path(&root, &file_path)?;
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    for checkpoint_id in checkpoint_ids {
        let mut manifest = read_manifest(&checkpoint_id)?;
        let Some(_root) = validate_capture_work_dir(&manifest, &work_dir) else {
            continue;
        };
        if update_expected_state(&mut manifest, &absolute, &path)? {
            write_manifest(&checkpoint_id, &manifest)?;
        }
    }
    Ok(())
}

fn copy_pending_file(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create pending checkpoint directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    fs::copy(source, destination).map_err(|error| {
        Error::from_reason(format!(
            "Failed to capture pending checkpoint file '{}': {error}",
            source.display()
        ))
    })?;
    Ok(())
}

fn pending_state_matches_current(state: &PendingFileState, current: &Path) -> bool {
    let Some(snapshot) = state.snapshot.as_ref() else {
        // No snapshot (git-tracked file) — content comparison is done against
        // the git object at capture time, not against a pending copy.
        return false;
    };
    current.is_file() && !files_are_different(current, snapshot)
}

fn pending_state_to_original(state: &PendingFileState) -> Result<OriginalState> {
    let snapshot = state.snapshot.as_ref().ok_or_else(|| {
        Error::from_reason("Cannot materialize an original from a git-tracked pending state")
    })?;
    Ok(OriginalState::Object {
        object_id: store_object(snapshot)?,
    })
}

/// Map repo-root-relative paths (NUL-separated git output, forward slashes)
/// to work-dir-relative paths. Entries outside the work dir are dropped.
fn repo_paths_to_work_relative(output: &[u8], prefix: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for name in output.split(|&byte| byte == 0) {
        if name.is_empty() {
            continue;
        }
        let name = String::from_utf8_lossy(name).replace('\\', "/");
        let name = name.trim_start_matches("./");
        if prefix.is_empty() {
            paths.push(name.to_string());
        } else if let Some(rest) = name.strip_prefix(&format!("{prefix}/")) {
            paths.push(rest.to_string());
        }
    }
    paths
}

/// Resolve the set of git-tracked files (work-dir-relative, forward-slash
/// separated) via `git ls-files`. Returns an empty set when the work dir is
/// not part of the repository (callers then fall back to copying everything).
fn tracked_file_set(baseline: &GitBaseline) -> Result<HashSet<String>> {
    let repository_root = Path::new(&baseline.repository_root);
    let output = run_git(repository_root, &["ls-files", "-z"])?;
    if !output.status.success() {
        return Ok(HashSet::new());
    }
    Ok(repo_paths_to_work_relative(&output.stdout, &baseline.work_dir_prefix)
        .into_iter()
        .collect())
}

/// Tracked files whose working-tree content differs from the pre-command
/// baseline commit (`git diff --name-only`). Because the diff is computed
/// against `baseline.head` — the commit captured when the checkpoint was
/// created — changes committed *during* the command still show up here, which
/// `git status` would silently hide.
fn git_diff_name_only(baseline: &GitBaseline) -> Result<Vec<String>> {
    let repository_root = Path::new(&baseline.repository_root);
    let output = run_git(
        repository_root,
        &[
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            &baseline.head,
        ],
    )?;
    if !output.status.success() {
        return Err(Error::from_reason(format!(
            "Failed to list git diff for checkpoint baseline: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(repo_paths_to_work_relative(
        &output.stdout,
        &baseline.work_dir_prefix,
    ))
}

/// Untracked files (full gitignore rules incl. sub-directory `.gitignore` and
/// `.git/info/exclude` applied by git itself), work-dir-relative.
fn git_untracked_paths(baseline: &GitBaseline) -> Result<Vec<String>> {
    let repository_root = Path::new(&baseline.repository_root);
    let output = run_git(
        repository_root,
        &["ls-files", "-o", "--exclude-standard", "-z"],
    )?;
    if !output.status.success() {
        return Err(Error::from_reason(format!(
            "Failed to list untracked files for checkpoint baseline: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(repo_paths_to_work_relative(
        &output.stdout,
        &baseline.work_dir_prefix,
    ))
}

/// Reuse the git baseline stored in a valid checkpoint manifest (saves two
/// `git rev-parse` process spawns on every terminal command). The baseline is
/// only reused when the work dir still matches its repository root;
/// otherwise `None` lets the caller fall back to fresh detection.
///
/// `manifest_baseline` is collected from the first work-dir-matching
/// checkpoint during the validation loop in
/// `capture_checkpoint_worktree_before`; this helper validates it against the
/// canonical work dir.
fn reuse_manifest_git_baseline(baseline: &GitBaseline, root: &Path) -> bool {
    let repository_root = Path::new(&baseline.repository_root);
    root.strip_prefix(repository_root)
        .map(|prefix| to_forward_slashes(prefix) == baseline.work_dir_prefix)
        .unwrap_or(false)
}

/// Detect whether a git-tracked file changed while the command ran, and if so
/// return its original state.
///
/// Two-stage detection keeps the common path cheap:
/// 1. metadata filter — identical mtime + size means the file was untouched
///    and no content I/O happens at all;
/// 2. content confirmation — only files whose metadata changed are read
///    (git object vs current file), so a `touch` alone never records a
///    phantom change.
///
/// The original is `OriginalState::Git`: `GitBaseline.head` is a fixed commit
/// SHA captured when the checkpoint was created, so rollback and diff
/// generation recover the exact pre-command content even if the command
/// committed in the meantime.
fn tracked_file_change(
    manifest: &CheckpointManifest,
    relative_path: &str,
    current: &Path,
    state: &PendingFileState,
) -> Result<Option<OriginalState>> {
    let Ok(meta) = fs::metadata(current) else {
        // File was deleted by the command.
        return Ok(Some(OriginalState::Git));
    };
    if meta.len() == state.size && mtime_ms(&meta) == state.mtime_ms {
        return Ok(None);
    }
    tracked_file_content_change(manifest, relative_path, current)
}

/// Content-level change confirmation for a tracked file that was clean at
/// capture time (no snapshot, no pre-command metadata to filter on): compare
/// the current file against the git baseline object directly. Used by the
/// git-driven path, where `git diff` already narrowed candidates to files
/// whose content differs from the baseline — so a plain `touch` never reaches
/// this function at all.
fn tracked_file_content_change(
    manifest: &CheckpointManifest,
    relative_path: &str,
    current: &Path,
) -> Result<Option<OriginalState>> {
    let Ok(meta) = fs::metadata(current) else {
        // File was deleted by the command.
        return Ok(Some(OriginalState::Git));
    };
    if meta.is_dir() {
        // Directory-level change (e.g. a submodule pointer): not a regular
        // file, nothing to roll back at this granularity.
        return Ok(None);
    }
    let Some(baseline) = manifest.git.as_ref() else {
        // No git baseline (repository state changed between capture and
        // commit): cannot confirm, conservatively skip.
        return Ok(None);
    };
    let Some(content) = read_git_object(baseline, relative_path)? else {
        // Not present in the baseline (unexpected for a tracked file):
        // treat as added when the file exists.
        return Ok(current.is_file().then_some(OriginalState::Missing));
    };
    if file_differs_from_bytes(current, &content) {
        Ok(Some(OriginalState::Git))
    } else {
        Ok(None) // metadata changed but content identical (e.g. touch)
    }
}

/// Snapshot the current worktree into temporary storage before a terminal
/// command. No manifest entries are committed until the command ends.
///
/// Performance model (fixes the old copy-everything behaviour that serialized
/// concurrent terminal commands on one global lock):
/// - git-driven path (work dir inside a repository): zero worktree traversal,
///   zero full metadata scan. Two git commands (`git diff` against the
///   checkpoint baseline + `git ls-files --others`) yield exactly the files
///   whose pre-command content cannot be recovered from the git object
///   database: dirty tracked files and untracked files. Those are snapshotted;
///   every clean tracked file is left untouched (content recovered from the
///   baseline object at capture time). Dirty tracked files are snapshotted so
///   rollback restores the pre-command content — not the baseline commit,
///   which would silently drop edits made outside this conversation.
/// - legacy fallback (non-git work dir or git failure): full traversal, clean
///   tracked files are not copied, untracked files are copied.
pub fn capture_checkpoint_worktree_before(
    checkpoint_ids: Vec<String>,
    work_dir: String,
) -> Result<Option<CheckpointWorktreeCapture>> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(None);
    }
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;

    // 所有 checkpoint 都与当前目录不匹配:没有任何可捕获目标,
    // 不做无意义的全目录快照。顺带收集可复用的 git 基线
    // (checkpoint 创建时捕获,省两次 rev-parse 进程启动)。
    let mut matched_any = false;
    let mut manifest_baseline = None;
    for checkpoint_id in &checkpoint_ids {
        let manifest = read_manifest(checkpoint_id)?;
        if validate_capture_work_dir(&manifest, &work_dir).is_some() {
            matched_any = true;
            if manifest_baseline.is_none() {
                manifest_baseline = manifest.git.clone();
            }
        }
    }
    if !matched_any {
        return Ok(None);
    }

    let pending_dir = checkpoint_root()?
        .join(PENDING_DIR_NAME)
        .join(generate_checkpoint_id());

    // git 驱动路径:复用 manifest 基线(仅当 work_dir 仍位于其仓库根下),
    // 未命中时重新探测。git 命令失败(仓库被移动/删除等)回退旧逻辑,
    // 不阻塞工具执行。
    let baseline = manifest_baseline
        .filter(|baseline| reuse_manifest_git_baseline(baseline, &root))
        .or_else(|| detect_git_baseline(&root));
    if let Some(baseline) = baseline.as_ref() {
        match capture_worktree_before_git(baseline, &root, &pending_dir, &work_dir, &checkpoint_ids)
        {
            Ok(capture) => return Ok(Some(capture)),
            Err(error) => {
                eprintln!(
                    "[checkpoint] git-driven before-capture failed ({error}); falling back to traversal"
                );
            }
        }
    }

    // 非 git 回退:全量遍历,跟踪文件不复制内容(回滚时从 git 对象恢复),
    // 未跟踪文件复制到 pending(唯一内容来源)。tracked 集为空 → 全复制。
    let before_paths = collect_worktree_file_paths(&root)?;
    let tracked = baseline
        .as_ref()
        .map(tracked_file_set)
        .transpose()?
        .unwrap_or_default();

    let mut before_states = HashMap::new();
    for relative_path in &before_paths {
        let absolute = root.join(from_forward_slashes(relative_path));
        let meta = fs::metadata(&absolute).ok();
        let is_tracked = tracked.contains(relative_path);
        let snapshot = if is_tracked {
            None
        } else {
            let snapshot = pending_dir.join(from_forward_slashes(relative_path));
            if let Err(error) = copy_pending_file(&absolute, &snapshot) {
                // 文件在遍历后被删除:跳过该文件,不阻塞整个工具执行。
                if !absolute.exists() {
                    continue;
                }
                return Err(error);
            }
            Some(snapshot)
        };
        before_states.insert(
            relative_path.clone(),
            PendingFileState {
                snapshot,
                mtime_ms: meta.as_ref().map(mtime_ms).unwrap_or(0),
                size: meta.as_ref().map(|meta| meta.len()).unwrap_or(0),
                tracked: is_tracked,
            },
        );
    }

    Ok(Some(CheckpointWorktreeCapture {
        checkpoint_ids,
        work_dir,
        baseline: None,
        before_paths,
        before_states,
        pending_dir,
    }))
}

/// Git-driven before-capture. Snapshots only the files whose pre-command
/// content exists nowhere else: dirty tracked files (`git diff` against the
/// baseline commit) and untracked files (`git ls-files --others`). Both lists
/// come from git itself, so gitignore handling (sub-directory `.gitignore`,
/// `.git/info/exclude`) is authoritative and no worktree traversal or full
/// metadata scan is needed.
fn capture_worktree_before_git(
    baseline: &GitBaseline,
    root: &Path,
    pending_dir: &Path,
    work_dir: &str,
    checkpoint_ids: &[String],
) -> Result<CheckpointWorktreeCapture> {
    let dirty = git_diff_name_only(baseline)?;
    let untracked = git_untracked_paths(baseline)?;
    let dirty_set: HashSet<&String> = dirty.iter().collect();

    let mut before_paths = HashSet::new();
    let mut before_states = HashMap::new();
    for relative_path in dirty.iter().chain(untracked.iter()) {
        let absolute = root.join(from_forward_slashes(relative_path));
        let snapshot = pending_dir.join(from_forward_slashes(relative_path));
        if let Err(error) = copy_pending_file(&absolute, &snapshot) {
            // 文件在列出后被删除:跳过该文件,不阻塞整个工具执行。
            if !absolute.exists() {
                continue;
            }
            return Err(error);
        }
        before_paths.insert(relative_path.clone());
        before_states.insert(
            relative_path.clone(),
            PendingFileState {
                snapshot: Some(snapshot),
                mtime_ms: 0,
                size: 0,
                tracked: dirty_set.contains(relative_path),
            },
        );
    }

    Ok(CheckpointWorktreeCapture {
        checkpoint_ids: checkpoint_ids.to_vec(),
        work_dir: work_dir.to_string(),
        baseline: Some(baseline.clone()),
        before_paths,
        before_states,
        pending_dir: pending_dir.to_path_buf(),
    })
}

/// Commit only paths whose state changed while the terminal command ran.
///
/// Git-driven path (capture carried a baseline): two git commands replace the
/// whole second worktree traversal. `git diff` against the pre-command
/// baseline commit lists tracked changes — including changes committed during
/// the command, which `git status` would hide — and `git ls-files --others`
/// lists untracked files. Candidates are the union of those with the
/// snapshotted pre-command files, so a deleted untracked file (invisible to
/// git after deletion) still gets restored.
///
/// Legacy path: the worktree traversal happens **once** and is shared by every
/// checkpoint in the capture (they all validated against the same work_dir),
/// instead of repeating a full scan per checkpoint — the O(checkpoints ×
/// files) blowup that made concurrent terminal commands progressively slower
/// as a conversation accumulated checkpoints.
pub fn record_checkpoint_worktree_after(capture: CheckpointWorktreeCapture) -> Result<()> {
    let _guard = checkpoint_guard()?;

    // 先解析所有仍有效的 checkpoint（manifest 存在 + work_dir 匹配）。
    let mut effective: Vec<(String, CheckpointManifest, PathBuf)> = Vec::new();
    for checkpoint_id in &capture.checkpoint_ids {
        if !checkpoint_manifest_exists(checkpoint_id) {
            continue;
        }
        let manifest = read_manifest(checkpoint_id)?;
        if let Some(root) = validate_capture_work_dir(&manifest, &capture.work_dir) {
            effective.push((checkpoint_id.clone(), manifest, root));
        }
    }
    if effective.is_empty() {
        return Ok(());
    }

    // 所有有效 checkpoint 共享同一 work_dir。
    let root = effective[0].2.clone();

    // git 驱动路径:diff(相对命令前基线,含命令期间已提交的变更)+
    // 未跟踪文件现况。候选 = 快照文件 ∪ diff ∪ 未跟踪;不再遍历工作区。
    // 逐文件判断复用在下方循环,非 git 回退走遍历候选。
    let mut candidates = capture.before_paths.clone();
    let mut diff_now: HashSet<String> = HashSet::new();
    if let Some(baseline) = capture.baseline.as_ref() {
        diff_now = git_diff_name_only(baseline)?.into_iter().collect();
        let untracked_now = git_untracked_paths(baseline)?;
        candidates.extend(diff_now.iter().cloned());
        candidates.extend(untracked_now);
    } else {
        let after_paths = collect_worktree_file_paths(&root)?;
        candidates.extend(after_paths);
    }

    for (checkpoint_id, mut manifest, root) in effective {
        let mut changed = false;

        for relative_path in &candidates {
            let relative = from_forward_slashes(relative_path);
            if should_skip_relative(&relative) {
                continue;
            }
            let absolute = root.join(&relative);
            let before_state = capture.before_states.get(relative_path);

            // 变更检测 + 原始状态物化:
            // - git 驱动路径:有快照的文件(脏 tracked / 未跟踪)直接做
            //   快照内容级对比,original 为 Object(恢复命令前内容,保留
            //   会话外编辑与先前命令的修改);无快照的 diff 候选(干净
            //   tracked 在命令期间变更/删除/提交)走基线内容确认,original
            //   为 Git(固定 SHA,回滚安全);其余候选为命令新增的未跟踪
            //   文件 → Missing。
            // - 回退路径:git 跟踪文件元数据快速过滤 → git 内容级确认;
            //   未跟踪文件与 pending 快照内容级对比;新增文件 → Missing。
            let change = match before_state {
                Some(state) if capture.baseline.is_some() => {
                    if pending_state_matches_current(state, &absolute) {
                        None
                    } else {
                        Some(pending_state_to_original(state)?)
                    }
                }
                Some(state) if state.tracked => {
                    tracked_file_change(&manifest, relative_path, &absolute, state)?
                }
                Some(state) => {
                    if pending_state_matches_current(state, &absolute) {
                        None
                    } else {
                        Some(pending_state_to_original(state)?)
                    }
                }
                None if diff_now.contains(relative_path) => {
                    tracked_file_content_change(&manifest, relative_path, &absolute)?
                }
                None => absolute.is_file().then_some(OriginalState::Missing),
            };
            let Some(original) = change else {
                continue;
            };

            capture_entry(&mut manifest, &absolute, &relative, original)?;
            changed = true;
        }

        if changed {
            write_manifest(&checkpoint_id, &manifest)?;
        }
    }
    Ok(())
}

/// Restore only paths that were recorded by mutating tools after this checkpoint.
pub fn restore_checkpoint(checkpoint_id: String, work_dir: String) -> Result<()> {
    let _guard = checkpoint_guard()?;
    // If the manifest no longer exists (checkpoint was deleted or corrupted),
    // there is nothing to restore. Return Ok so the rollback flow continues
    // to delete messages without being blocked by a missing checkpoint.
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    let root = validate_manifest_work_dir(&manifest, &work_dir)?;

    let mut restored_entries = Vec::new();
    for entry in &manifest.entries {
        if should_skip_manifest_path(&entry.path) {
            continue;
        }
        let destination = resolve_manifest_path(&root, &entry.path);
        let Some(expected) = entry.expected.as_ref() else {
            continue;
        };
        if !states_match(&destination, expected, manifest.git.as_ref(), &entry.path)? {
            continue;
        }
        restore_entry(&root, &manifest, entry)?;
        restored_entries.push(entry.path.clone());
    }
    prune_empty_parent_directories(
        &root,
        &manifest
            .entries
            .iter()
            .filter(|entry| restored_entries.contains(&entry.path))
            .cloned()
            .collect::<Vec<_>>(),
    );

    Ok(())
}

fn restore_entry(
    root: &Path,
    manifest: &CheckpointManifest,
    entry: &CheckpointEntry,
) -> Result<()> {
    let destination = resolve_manifest_path(root, &entry.path);
    match &entry.original {
        OriginalState::Missing => {
            if destination.is_file() || destination.is_symlink() {
                fs::remove_file(&destination).map_err(|error| {
                    Error::from_reason(format!(
                        "Failed to remove added file '{}': {error}",
                        destination.display()
                    ))
                })?;
            }
            Ok(())
        }
        OriginalState::Object { object_id } => {
            let source = checkpoint_root()?.join(OBJECT_DIR_NAME).join(object_id);
            restore_file(&source, &destination)
        }
        OriginalState::Git => {
            let baseline = manifest
                .git
                .as_ref()
                .ok_or_else(|| Error::from_reason("Checkpoint Git baseline is missing"))?;
            let content = read_git_object(baseline, &entry.path)?.ok_or_else(|| {
                Error::from_reason(format!(
                    "Checkpoint Git object is missing for '{}'",
                    entry.path
                ))
            })?;
            write_file(&destination, &content)
        }
    }
}

fn restore_file(source: &Path, destination: &Path) -> Result<()> {
    if !source.is_file() {
        return Err(Error::from_reason(format!(
            "Checkpoint object not found: {}",
            source.display()
        )));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create restore directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    fs::copy(source, destination).map_err(|error| {
        Error::from_reason(format!(
            "Failed to restore file '{}': {error}",
            destination.display()
        ))
    })?;
    Ok(())
}

fn write_file(destination: &Path, content: &[u8]) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create restore directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    fs::write(destination, content).map_err(|error| {
        Error::from_reason(format!(
            "Failed to restore file '{}': {error}",
            destination.display()
        ))
    })
}

fn prune_empty_parent_directories(root: &Path, entries: &[CheckpointEntry]) {
    let mut directories: Vec<PathBuf> = entries
        .iter()
        .filter_map(|entry| {
            resolve_manifest_path(root, &entry.path)
                .parent()
                .map(Path::to_path_buf)
        })
        .collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    directories.dedup();
    for directory in directories {
        let mut current = directory;
        while current.starts_with(root) && current != root {
            if fs::remove_dir(&current).is_err() {
                break;
            }
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent.to_path_buf();
        }
    }
}

/// Delete a checkpoint and release its Git reference. Shared objects are
/// garbage-collected once no remaining manifest references them.
pub fn delete_checkpoint(checkpoint_id: String) -> Result<()> {
    let _guard = checkpoint_guard()?;
    let directory = checkpoint_dir(&checkpoint_id)?;
    if !directory.exists() {
        return Ok(());
    }

    if let Ok(manifest) = read_manifest(&checkpoint_id) {
        if let Some(baseline) = manifest.git.as_ref() {
            update_checkpoint_git_ref(&checkpoint_id, baseline, true)?;
        }
    }
    fs::remove_dir_all(&directory).map_err(|error| {
        Error::from_reason(format!(
            "Failed to delete checkpoint '{}': {error}",
            checkpoint_id
        ))
    })?;
    collect_unused_objects()
}

fn collect_unused_objects() -> Result<()> {
    let root = checkpoint_root()?;
    let object_dir = root.join(OBJECT_DIR_NAME);
    if !object_dir.is_dir() {
        return Ok(());
    }

    let mut referenced = HashSet::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if !entry.path().is_dir()
                || entry.file_name() == OBJECT_DIR_NAME
                || entry.file_name() == PENDING_DIR_NAME
            {
                continue;
            }
            let checkpoint_id = entry.file_name().to_string_lossy().to_string();
            if let Ok(manifest) = read_manifest(&checkpoint_id) {
                for item in manifest.entries {
                    if let OriginalState::Object { object_id } = item.original {
                        referenced.insert(object_id);
                    }
                    if let Some(OriginalState::Object { object_id }) = item.expected {
                        referenced.insert(object_id);
                    }
                }
            }
        }
    }

    for entry in fs::read_dir(&object_dir).map_err(|error| {
        Error::from_reason(format!("Failed to scan checkpoint objects: {error}"))
    })? {
        let entry = entry.map_err(|error| {
            Error::from_reason(format!("Failed to read checkpoint object entry: {error}"))
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_file() && !referenced.contains(&name) {
            fs::remove_file(entry.path()).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to remove unused checkpoint object: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

/// A single file change between the checkpoint snapshot and the current
/// working directory state.
#[napi(object)]
pub struct CheckpointFileChange {
    /// Relative file path (forward-slash separated).
    pub path: String,
    /// "added" (created after checkpoint, will be deleted),
    /// "modified" (content differs, will be reverted),
    /// "deleted" (existed at checkpoint, was removed, will be restored).
    pub change_type: String,
}

/// A file change with a unified diff suitable for rollback preview.
#[napi(object)]
pub struct CheckpointFileDiff {
    pub path: String,
    pub change_type: String,
    pub content: String,
    pub is_binary: bool,
}

fn collect_tracked_entries(manifest: &CheckpointManifest) -> Vec<CheckpointEntry> {
    manifest.entries.clone()
}

/// Compare only paths explicitly recorded while this conversation's tools ran.
pub fn list_checkpoint_changes(
    checkpoint_id: String,
    work_dir: String,
) -> Result<Vec<CheckpointFileChange>> {
    let _guard = checkpoint_guard()?;
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    let root = validate_manifest_work_dir(&manifest, &work_dir)?;
    let tracked = collect_tracked_entries(&manifest);

    let mut changes = Vec::new();
    for entry in tracked {
        if should_skip_manifest_path(&entry.path) {
            continue;
        }
        let Some(expected) = entry.expected.as_ref() else {
            continue;
        };
        let current = resolve_manifest_path(&root, &entry.path);
        if !states_match(&current, expected, manifest.git.as_ref(), &entry.path)? {
            continue;
        }
        if let Some(change_type) = classify_change(
            &current,
            &entry.original,
            manifest.git.as_ref(),
            &entry.path,
        )? {
            changes.push(CheckpointFileChange {
                path: entry.path,
                change_type,
            });
        }
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

/// Build unified diffs from checkpoint content to the current working state.
/// This is read-only and is used by the renderer's rollback preview and the
/// file-changes panel.
///
/// `include_all` controls which captured entries are reported:
/// - `false` (rollback preview): only files whose current state still matches
///   the checkpoint's post-change state. These are exactly the files rollback
///   would restore, so the preview matches the restore behaviour.
/// - `true` (file-changes panel): every captured entry is reported as long as
///   its current state differs from the pre-change state. Files that were
///   re-modified by later runs in a shared working tree stay visible, so an
///   earlier conversation's modifications are never erased from the panel.
pub fn list_checkpoint_diffs(
    checkpoint_id: String,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileDiff>> {
    let _guard = checkpoint_guard()?;
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    let root = validate_manifest_work_dir(&manifest, &work_dir)?;
    let tracked = collect_tracked_entries(&manifest);

    let mut diffs = Vec::new();
    for entry in tracked {
        if should_skip_manifest_path(&entry.path) {
            continue;
        }
        let Some(expected) = entry.expected.as_ref() else {
            continue;
        };
        let current = resolve_manifest_path(&root, &entry.path);
        if !include_all && !states_match(&current, expected, manifest.git.as_ref(), &entry.path)? {
            continue;
        }
        let Some(change_type) = classify_change(
            &current,
            &entry.original,
            manifest.git.as_ref(),
            &entry.path,
        )?
        else {
            continue;
        };

        // 进程内 diff 缓存：original 摘要 + 磁盘 mtime/size 均未变时直接
        // 复用上次生成的 unified diff，避免高频工具循环下反复读文件与
        // TextDiff 全量计算（P0-4 性能优化）。
        let cache_key = format!("{}:{}", checkpoint_id, entry.path);
        let digest = original_digest(&entry.original, manifest.git.as_ref(), &entry.path);
        let cached = {
            let cache = diff_cache();
            let meta = fs::metadata(&current).ok();
            cache.get(&cache_key).and_then(|cached_entry| {
                let meta = meta.as_ref()?;
                (cached_entry.original_digest == digest
                    && cached_entry.current_mtime_ms == mtime_ms(meta)
                    && cached_entry.current_size == meta.len())
                .then_some((cached_entry.content.clone(), cached_entry.is_binary))
            })
        };
        let (content, is_binary) = match cached {
            Some((content, is_binary)) => (content, is_binary),
            None => {
                let original_content =
                    read_original_content(&entry.original, manifest.git.as_ref(), &entry.path)?;
                let current_content = read_current_content(&current)?;
                let (content, is_binary) = build_unified_diff(
                    &entry.path,
                    original_content.as_deref(),
                    current_content.as_deref(),
                );
                let meta = fs::metadata(&current).ok();
                let mut cache = diff_cache();
                if cache.len() >= DIFF_CACHE_MAX_ENTRIES {
                    cache.clear();
                }
                cache.insert(
                    cache_key,
                    CachedCheckpointDiff {
                        original_digest: digest,
                        current_mtime_ms: meta.as_ref().map(mtime_ms).unwrap_or(0),
                        current_size: meta.as_ref().map(|meta| meta.len()).unwrap_or(0),
                        content: content.clone(),
                        is_binary,
                    },
                );
                (content, is_binary)
            }
        };
        diffs.push(CheckpointFileDiff {
            path: entry.path,
            change_type,
            content,
            is_binary,
        });
    }
    diffs.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(diffs)
}

fn read_original_content(
    original: &OriginalState,
    baseline: Option<&GitBaseline>,
    relative: &str,
) -> Result<Option<Vec<u8>>> {
    match original {
        OriginalState::Missing => Ok(None),
        OriginalState::Object { object_id } => {
            let object = checkpoint_root()?.join(OBJECT_DIR_NAME).join(object_id);
            fs::read(&object).map(Some).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to read checkpoint object '{}': {error}",
                    object.display()
                ))
            })
        }
        OriginalState::Git => {
            let baseline =
                baseline.ok_or_else(|| Error::from_reason("Checkpoint Git baseline is missing"))?;
            read_git_object(baseline, relative)
        }
    }
}

fn read_current_content(path: &Path) -> Result<Option<Vec<u8>>> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        return Err(Error::from_reason(format!(
            "Checkpoint path is not a regular file: {}",
            path.display()
        )));
    }
    fs::read(path).map(Some).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read current checkpoint file '{}': {error}",
            path.display()
        ))
    })
}

fn build_unified_diff(
    relative: &str,
    original: Option<&[u8]>,
    current: Option<&[u8]>,
) -> (String, bool) {
    let original_bytes = original.unwrap_or_default();
    let current_bytes = current.unwrap_or_default();
    let Ok(original_text) = std::str::from_utf8(original_bytes) else {
        return (String::new(), true);
    };
    let Ok(current_text) = std::str::from_utf8(current_bytes) else {
        return (String::new(), true);
    };
    if original_bytes.contains(&0) || current_bytes.contains(&0) {
        return (String::new(), true);
    }

    // 行尾归一化后再做行级 diff：Windows 下工具/编辑器常把文件落盘为
    // CRLF，而 original 来自 git/checkpoint 对象（LF）。直接按字节对比
    // 会让每个 CRLF 文件呈现"整文件改动"的数万行假 diff（仓库
    // .gitattributes 注释记载过同类现象）。仅当文本确实含 \r 时才替换，
    // LF-only 文件走零拷贝路径。此处仅归一化展示用的 diff，不修改任何
    // 落盘内容。
    let original_text = if original_text.contains('\r') {
        std::borrow::Cow::Owned(original_text.replace("\r\n", "\n"))
    } else {
        std::borrow::Cow::Borrowed(original_text)
    };
    let current_text = if current_text.contains('\r') {
        std::borrow::Cow::Owned(current_text.replace("\r\n", "\n"))
    } else {
        std::borrow::Cow::Borrowed(current_text)
    };

    let original_header = original
        .map(|_| format!("a/{relative}"))
        .unwrap_or_else(|| "/dev/null".to_string());
    let current_header = current
        .map(|_| format!("b/{relative}"))
        .unwrap_or_else(|| "/dev/null".to_string());
    let content = TextDiff::from_lines(&original_text, &current_text)
        .unified_diff()
        .context_radius(3)
        .header(&original_header, &current_header)
        .to_string();
    (content, false)
}

fn classify_change(
    current: &Path,
    original: &OriginalState,
    baseline: Option<&GitBaseline>,
    relative: &str,
) -> Result<Option<String>> {
    match original {
        OriginalState::Missing => Ok(current.exists().then(|| "added".to_string())),
        OriginalState::Object { object_id } => {
            if !current.exists() {
                return Ok(Some("deleted".to_string()));
            }
            let object = checkpoint_root()?.join(OBJECT_DIR_NAME).join(object_id);
            Ok(files_are_different(current, &object).then(|| "modified".to_string()))
        }
        OriginalState::Git => {
            let baseline =
                baseline.ok_or_else(|| Error::from_reason("Checkpoint Git baseline is missing"))?;
            let Some(content) = read_git_object(baseline, relative)? else {
                return Ok(current.exists().then(|| "added".to_string()));
            };
            if !current.exists() {
                return Ok(Some("deleted".to_string()));
            }
            Ok(file_differs_from_bytes(current, &content).then(|| "modified".to_string()))
        }
    }
}

fn file_differs_from_bytes(path: &Path, expected: &[u8]) -> bool {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return true,
    };
    if metadata.len() != expected.len() as u64 {
        return true;
    }
    fs::read(path)
        .map(|content| content != expected)
        .unwrap_or(true)
}

/// Compare two files by size first, then by content. Returns true if they
/// differ (or if either file cannot be read).
fn files_are_different(a: &Path, b: &Path) -> bool {
    let meta_a = match fs::metadata(a) {
        Ok(m) => m,
        Err(_) => return true,
    };
    let meta_b = match fs::metadata(b) {
        Ok(m) => m,
        Err(_) => return true,
    };

    if meta_a.len() != meta_b.len() {
        return true;
    }

    // Same size — compare content byte-by-byte.
    let content_a = match fs::read(a) {
        Ok(c) => c,
        Err(_) => return true,
    };
    let content_b = match fs::read(b) {
        Ok(c) => c,
        Err(_) => return true,
    };

    content_a != content_b
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Create a unique temporary directory for a test (no extra dependency).
    fn temp_dir(tag: &str) -> PathBuf {
        let unique = format!(
            "snow-checkpoint-test-{}-{}-{}",
            std::process::id(),
            tag,
            TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// Initialize a git repository with one committed file.
    fn init_git_repo(repo: &Path) {
        let ok = run_git(repo, &["init", "-q"]).unwrap().status.success();
        assert!(ok, "git init failed");
        let ok = run_git(repo, &["config", "user.email", "test@example.com"])
            .unwrap()
            .status
            .success();
        assert!(ok, "git config user.email failed");
        let ok = run_git(repo, &["config", "user.name", "Checkpoint Test"])
            .unwrap()
            .status
            .success();
        assert!(ok, "git config user.name failed");
        write(&repo.join("tracked.txt"), "v1\n");
        assert!(run_git(repo, &["add", "-A"]).unwrap().status.success());
        assert!(
            run_git(repo, &["commit", "-q", "-m", "init"]).unwrap().status.success(),
            "git commit failed"
        );
    }

    #[test]
    fn crlf_and_lf_content_produce_identical_diff() {
        // 行尾归一化：磁盘 CRLF 与 git/checkpoint 的 LF 内容一致时，
        // 展示 diff 应完全相同，不得出现"整文件改动"的数万行假 diff。
        let lf = Some(b"line1\nline2\nline3\n".as_slice());
        let crlf = Some(b"line1\r\nline2\r\nline3\r\n".as_slice());
        let (lf_diff, lf_binary) = build_unified_diff("test.txt", lf, lf);
        let (crlf_diff, crlf_binary) = build_unified_diff("test.txt", lf, crlf);
        assert!(!lf_binary);
        assert!(!crlf_binary);
        assert_eq!(lf_diff, crlf_diff);
        // 归一化后不得出现以 +/- 开头的假变更行
        assert!(crlf_diff
            .lines()
            .all(|line| !line.starts_with('+') && !line.starts_with('-')));
    }

    #[test]
    fn real_content_change_reports_diff_lines() {
        let original = Some(b"alpha\nbeta\ngamma\n".as_slice());
        let current = Some(b"alpha\nBETA\ngamma\n".as_slice());
        let (diff, is_binary) = build_unified_diff("test.txt", original, current);
        assert!(!is_binary);
        assert!(diff.lines().any(|line| line == "-beta"));
        assert!(diff.lines().any(|line| line == "+BETA"));
    }

    #[test]
    fn nul_bytes_are_marked_binary() {
        let (_, is_binary) = build_unified_diff(
            "bin.dat",
            Some(b"a\0b".as_slice()),
            Some(b"a\0c".as_slice()),
        );
        assert!(is_binary);
    }

    /// 端到端验证优化后的 worktree 捕获流程：
    /// 1. before 只复制未跟踪文件（跟踪文件零复制）
    /// 2. after 一次遍历记录"命令期间"的变更（Git / Object 两种 original）
    /// 3. restore 恢复跟踪文件原内容、删除新增的未跟踪文件
    #[test]
    fn worktree_capture_only_copies_untracked_files_and_restores() {
        let repo = temp_dir("repo");
        init_git_repo(&repo);
        let work_dir = repo.to_string_lossy().to_string();

        // 会话中已有一个 checkpoint（模拟对话轮次创建的基线）。
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        // 命令执行前：新增一个未跟踪文件（与跟踪文件并存）。
        write(&repo.join("new_file.txt"), "untracked\n");

        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .expect("capture before")
        .expect("capture should be Some");

        // 核心断言：pending 快照只包含未跟踪文件，干净跟踪文件零快照
        // （git 驱动路径下 before_states 只含快照文件）。
        let pending_names: Vec<String> = fs::read_dir(&capture.pending_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(pending_names, vec!["new_file.txt"], "only untracked file is snapshotted");
        assert!(
            !capture.before_states.contains_key("tracked.txt"),
            "clean tracked file has no snapshot entry"
        );
        let untracked_state = capture.before_states.get("new_file.txt").expect("untracked state");
        assert!(!untracked_state.tracked);
        assert!(untracked_state.snapshot.is_some(), "untracked file is copied");

        // 命令执行：修改跟踪文件、修改未跟踪文件、再新增一个文件。
        write(&repo.join("tracked.txt"), "v2\n");
        write(&repo.join("new_file.txt"), "changed\n");
        write(&repo.join("added_by_cmd.txt"), "added\n");

        record_checkpoint_worktree_after(capture).expect("capture after");

        // manifest 应恰好记录 3 个变更，original 类型正确。
        let manifest = read_manifest(&checkpoint_id).expect("read manifest");
        let by_path: HashMap<&str, &CheckpointEntry> = manifest
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        assert_eq!(by_path.len(), 3, "entries: {:?}", manifest.entries);
        assert!(
            matches!(by_path["tracked.txt"].original, OriginalState::Git),
            "tracked file original comes from git"
        );
        assert!(
            matches!(by_path["new_file.txt"].original, OriginalState::Object { .. }),
            "untracked file original comes from pending snapshot"
        );
        assert!(
            matches!(by_path["added_by_cmd.txt"].original, OriginalState::Missing),
            "added file has no original"
        );

        // 回滚：跟踪文件恢复 v1，被修改的未跟踪文件恢复命令前内容，
        // 命令期间新增的文件被删除。
        restore_checkpoint(checkpoint_id.clone(), work_dir.clone()).expect("restore");
        assert_eq!(fs::read_to_string(repo.join("tracked.txt")).unwrap(), "v1\n");
        assert_eq!(
            fs::read_to_string(repo.join("new_file.txt")).unwrap(),
            "untracked\n",
            "modified untracked file is restored from its pending snapshot"
        );
        assert!(!repo.join("added_by_cmd.txt").exists());

        // 清理 checkpoint 与临时仓库。
        delete_checkpoint(checkpoint_id).expect("delete checkpoint");
        let _ = fs::remove_dir_all(&repo);
    }

    /// 连续两次命令共享同一 checkpoint 时,第二次 before 不复制任何内容
    /// (所有文件都已被 git 跟踪),after 也只记录增量变更。
    #[test]
    fn repeated_captures_record_incremental_changes() {
        let repo = temp_dir("repo2");
        init_git_repo(&repo);
        let work_dir = repo.to_string_lossy().to_string();
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        // 第一次命令：capture 后修改 tracked.txt。
        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        assert!(
            fs::read_dir(&capture.pending_dir)
                .map(|mut it| it.next().is_none())
                .unwrap_or(true), // 无未跟踪文件 → pending 目录不存在 = 空
            "no untracked files → pending dir stays empty"
        );
        write(&repo.join("tracked.txt"), "v2\n");
        record_checkpoint_worktree_after(capture).unwrap();

        // 第二次命令：tracked.txt 不再变化，仅新增独立文件。
        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        write(&repo.join("other.txt"), "x\n");
        record_checkpoint_worktree_after(capture).unwrap();

        let manifest = read_manifest(&checkpoint_id).expect("read manifest");
        let by_path: HashMap<&str, &CheckpointEntry> = manifest
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        assert_eq!(by_path.len(), 2, "entries: {:?}", manifest.entries);
        assert!(by_path.contains_key("tracked.txt"));
        assert!(by_path.contains_key("other.txt"));

        delete_checkpoint(checkpoint_id).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    /// 脏跟踪文件（会话外/先前命令修改、未提交）在命令前被快照:
    /// 回滚恢复到命令前内容而非基线提交 —— 会话外编辑不丢失。
    #[test]
    fn dirty_tracked_file_rolls_back_to_pre_command_content() {
        let repo = temp_dir("repo3");
        init_git_repo(&repo);
        let work_dir = repo.to_string_lossy().to_string();
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        // 模拟会话外编辑:tracked.txt 在命令前已是脏的(v2 ≠ 提交的 v1)。
        write(&repo.join("tracked.txt"), "v2\n");

        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .expect("capture before")
        .expect("capture should be Some");
        let dirty_state = capture
            .before_states
            .get("tracked.txt")
            .expect("dirty tracked file is snapshotted");
        assert!(dirty_state.tracked);
        assert!(dirty_state.snapshot.is_some(), "dirty tracked file is copied");

        // 命令把文件改成 v3。
        write(&repo.join("tracked.txt"), "v3\n");
        record_checkpoint_worktree_after(capture).expect("capture after");

        // 回滚:恢复到命令前内容 v2,而不是提交的 v1(会话外编辑保留)。
        restore_checkpoint(checkpoint_id.clone(), work_dir.clone()).expect("restore");
        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "v2\n",
            "rollback restores pre-command content, keeping out-of-conversation edits"
        );

        delete_checkpoint(checkpoint_id).expect("delete checkpoint");
        let _ = fs::remove_dir_all(&repo);
    }

    /// 同一文件被两条命令连续修改:第二次捕获复用已记录的 original
    /// (累计语义,与 filesystem 工具一致),回滚恢复到首次修改前内容;
    /// 脏快照的作用是防止假变更(命令 2 未改动的文件不重复记录)。
    #[test]
    fn repeated_captures_keep_cumulative_rollback_semantics() {
        let repo = temp_dir("repo4");
        init_git_repo(&repo);
        let work_dir = repo.to_string_lossy().to_string();
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        // 命令 1:tracked.txt v1 → v2。
        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        write(&repo.join("tracked.txt"), "v2\n");
        record_checkpoint_worktree_after(capture).unwrap();

        // 命令 2:同一文件 v2 → v3。
        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        write(&repo.join("tracked.txt"), "v3\n");
        record_checkpoint_worktree_after(capture).unwrap();

        // 回滚(撤销命令 2):累计语义下恢复到首次修改前 v1。
        restore_checkpoint(checkpoint_id.clone(), work_dir.clone()).unwrap();
        assert_eq!(fs::read_to_string(repo.join("tracked.txt")).unwrap(), "v1\n");

        delete_checkpoint(checkpoint_id).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    /// 命令期间 git commit 的修改也能被记录并回滚:after 的 diff 相对
    /// 命令前基线提交,git status 会漏掉已提交变更。
    #[test]
    fn change_committed_during_command_is_still_rollable() {
        let repo = temp_dir("repo5");
        init_git_repo(&repo);
        let work_dir = repo.to_string_lossy().to_string();
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        write(&repo.join("tracked.txt"), "v2\n");
        assert!(run_git(&repo, &["add", "-A"]).unwrap().status.success());
        assert!(
            run_git(&repo, &["commit", "-q", "-m", "during command"])
                .unwrap()
                .status
                .success()
        );
        record_checkpoint_worktree_after(capture).unwrap();

        // manifest 记录了该变更,回滚恢复提交前的 v1。
        let manifest = read_manifest(&checkpoint_id).unwrap();
        assert_eq!(manifest.entries.len(), 1, "committed change is still recorded");
        restore_checkpoint(checkpoint_id.clone(), work_dir.clone()).unwrap();
        assert_eq!(fs::read_to_string(repo.join("tracked.txt")).unwrap(), "v1\n");

        delete_checkpoint(checkpoint_id).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    /// 未跟踪文件被命令删除后,after 仍能发现(快照文件在候选集中)并
    /// 在回滚时恢复 —— git 在文件删除后不再报告它。
    #[test]
    fn untracked_file_deleted_by_command_is_restored() {
        let repo = temp_dir("repo6");
        init_git_repo(&repo);
        let work_dir = repo.to_string_lossy().to_string();
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        write(&repo.join("scratch.txt"), "precious\n");
        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        fs::remove_file(repo.join("scratch.txt")).unwrap();
        record_checkpoint_worktree_after(capture).unwrap();

        let manifest = read_manifest(&checkpoint_id).unwrap();
        assert_eq!(manifest.entries.len(), 1, "deleted untracked file is recorded");
        restore_checkpoint(checkpoint_id.clone(), work_dir.clone()).unwrap();
        assert_eq!(
            fs::read_to_string(repo.join("scratch.txt")).unwrap(),
            "precious\n",
            "deleted untracked file is restored from its snapshot"
        );

        delete_checkpoint(checkpoint_id).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    /// 干净跟踪文件被 touch(内容不变):git diff 候选为空 → 零假变更。
    #[test]
    fn touching_clean_tracked_file_produces_no_change() {
        let repo = temp_dir("repo7");
        init_git_repo(&repo);
        let work_dir = repo.to_string_lossy().to_string();
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        // 内容与原文件相同(仅重写时间戳)。
        write(&repo.join("tracked.txt"), "v1\n");
        record_checkpoint_worktree_after(capture).unwrap();

        let manifest = read_manifest(&checkpoint_id).unwrap();
        assert!(
            manifest.entries.is_empty(),
            "touch with identical content records no change"
        );

        delete_checkpoint(checkpoint_id).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    /// 非 git 目录回退到全量复制:before 记录所有文件状态并复制内容,
    /// after 通过快照对比记录变更,回滚仍完整可用。
    #[test]
    fn non_git_directory_falls_back_to_full_copy() {
        let dir = temp_dir("plain");
        let work_dir = dir.to_string_lossy().to_string();
        let checkpoint_id = create_checkpoint(work_dir.clone()).expect("create checkpoint");

        write(&dir.join("data.txt"), "one\n");
        let capture = capture_checkpoint_worktree_before(
            vec![checkpoint_id.clone()],
            work_dir.clone(),
        )
        .unwrap()
        .unwrap();
        // 非 git:全量复制(基线为 None → tracked 为空)。
        assert!(capture.baseline.is_none());
        let state = capture.before_states.get("data.txt").expect("state");
        assert!(state.snapshot.is_some(), "non-git files are fully copied");

        write(&dir.join("data.txt"), "two\n");
        record_checkpoint_worktree_after(capture).unwrap();

        restore_checkpoint(checkpoint_id.clone(), work_dir.clone()).unwrap();
        assert_eq!(fs::read_to_string(dir.join("data.txt")).unwrap(), "one\n");

        delete_checkpoint(checkpoint_id).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
