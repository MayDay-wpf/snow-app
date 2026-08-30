use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use similar::TextDiff;
use tokio::sync::{Mutex as AsyncMutex, RwLock as AsyncRwLock};

use super::checkpoint_skip::should_skip_pending_copy;
use super::gitignore::GitignoreMatcher;

mod git;
mod manifest;
mod paths;
pub(crate) mod remote;

use self::git::{read_git_object, update_checkpoint_git_ref};
use self::manifest::{read_manifest, write_manifest};
use self::paths::{
    canonical_work_dir, checkpoint_dir, checkpoint_manifest_exists, filter_existing_checkpoints,
    manifest_paths_equal, real_relative_path, resolve_checkpoint_path, resolve_manifest_path,
    should_skip_manifest_path,
};

const OBJECT_DIR_NAME: &str = "objects";
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

/// 工作目录读写锁表：常规捕获与 diff 查询持有共享读锁，仅回滚持有
/// 独占写锁。它保护单次 checkpoint IO；跨工具调用的 before → 执行 → after
/// 原子边界由 CHECKPOINT_OPERATION_LOCKS 负责。
/// 使用 tokio 锁：本地同步流程（spawn_blocking 内）走 blocking_*，
/// 远程 SSH 流程（async）跨 await 持锁，两种 guard 均可跨线程安全传递。
///
/// operation lock 的只读查询同样使用共享读锁，因此 diff/变更列表计算不会
/// 阻塞并行文件编辑；只有 restore 之类会修改工作区的操作使用独占写锁。
static CHECKPOINT_WORK_DIR_LOCKS: OnceLock<
    Mutex<HashMap<PathBuf, Weak<AsyncRwLock<()>>>>,
> = OnceLock::new();

/// 工具执行级工作目录锁：
/// - 文件工具：共享读锁，覆盖完整的 before → 执行 → after 区间；
/// - 只读 checkpoint 查询（变更列表 / diff）：共享读锁，可与文件工具并行；
/// - 回滚/预览中的实际恢复：独占写锁；
/// - bash 命令：执行期间**不持锁**（跨会话命令并行，回滚不再被长命令
///   阻塞），仅 before/after 扫描期间短暂持有共享读锁与回滚互斥，
///   扫描之间发生的回滚由 CHECKPOINT_RESTORE_EPOCHS 纪元检测并跳过
///   after 记录，避免把另一个会话回滚恢复的内容误记到当前 checkpoint；
/// - 外部 MCP（影响范围未知）：独占写锁覆盖整个执行区间（无捕获可跳过）。
static CHECKPOINT_OPERATION_LOCKS: OnceLock<
    Mutex<HashMap<String, Weak<AsyncRwLock<()>>>>,
> = OnceLock::new();

/// 单文件工具执行锁：同一工作目录内不同文件仍可并行；同一路径的编辑严格
/// 串行，防止两个会话在各自 before/after 之间交叉写入而混淆 original/expected。
static CHECKPOINT_FILE_OPERATION_LOCKS: OnceLock<
    Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
> = OnceLock::new();

/// manifest 级锁表：每个 checkpoint 独立串行 read-modify-write。
/// 同项目的不同会话拥有不同 checkpoint，因此文件编辑仅锁自己的
/// manifest，不再锁住整个工作目录。Weak 避免删除会话后残留锁对象。
static CHECKPOINT_MANIFEST_LOCKS: OnceLock<
    Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
> = OnceLock::new();

/// 回滚纪元表：每工作目录一个单调递增计数，键与执行级锁共用同一规范化。
/// bash 命令执行期间不再持有执行级锁（会话间互不阻塞），若此期间另一个
/// 会话的回滚改写了工作树，bash 的 after 捕获会检测到纪元变化并跳过变更
/// 记录——避免把回滚恢复的文件误记到本会话的 checkpoint（回滚不混淆）。
static CHECKPOINT_RESTORE_EPOCHS: OnceLock<Mutex<HashMap<String, Weak<AtomicU64>>>> =
    OnceLock::new();

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
    /// Content id of the file's pre-command state (BLAKE3 object). `None`
    /// when the capture was skipped (too large / binary ext): the change
    /// cannot be recovered, after-pass skips it.
    object_id: Option<String>,
    /// Content capture skipped: change cannot be recovered, after-pass skips it.
    skipped: bool,
    /// Pre-command mtime (ms) and size used as a cheap first-pass change
    /// detector; a match skips the content read entirely.
    mtime_ms: u64,
    size: u64,
}

/// 进程内工作区指纹缓存：key = "{work_dir}\0{relative}"。命中条件为
/// mtime+size 未变，此时直接复用对象 id，完全跳过内容 IO。这使 before
/// 捕获退化为一次轻量 stat 扫描；只有真实变化过的文件才重新哈希。
static FINGERPRINT_CACHE: OnceLock<Mutex<HashMap<String, FingerprintEntry>>> = OnceLock::new();

/// 指纹缓存上限：超过后整体清空（条目是轻量 stat 元数据，重建成本低）。
const FINGERPRINT_CACHE_MAX_ENTRIES: usize = 100_000;

struct FingerprintEntry {
    mtime_ms: u64,
    size: u64,
    object_id: String,
}

fn fingerprint_cache() -> MutexGuard<'static, HashMap<String, FingerprintEntry>> {
    FINGERPRINT_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fingerprint_key(work_dir: &str, relative: &str) -> String {
    format!("{work_dir}\0{relative}")
}

fn fingerprint_lookup(work_dir: &str, relative: &str, mtime_ms: u64, size: u64) -> Option<String> {
    fingerprint_cache()
        .get(&fingerprint_key(work_dir, relative))
        .filter(|entry| entry.mtime_ms == mtime_ms && entry.size == size)
        .map(|entry| entry.object_id.clone())
}

fn fingerprint_store(work_dir: &str, relative: &str, mtime_ms: u64, size: u64, object_id: String) {
    let mut cache = fingerprint_cache();
    if cache.len() >= FINGERPRINT_CACHE_MAX_ENTRIES {
        cache.clear();
    }
    cache
        .entry(fingerprint_key(work_dir, relative))
        .or_insert(FingerprintEntry {
            mtime_ms,
            size,
            object_id,
        });
}

pub struct CheckpointWorktreeCapture {
    checkpoint_ids: Vec<String>,
    work_dir: String,
    /// Pre-command file set (every file fingerprinted). All checkpoints are
    /// validated against the same `work_dir` during capture, so one result
    /// serves every checkpoint. Pre-command content lives in the content-
    /// addressed object store (BLAKE3); no git state is involved.
    before_paths: HashSet<String>,
    before_states: HashMap<String, PendingFileState>,
    /// 捕获时的回滚纪元：命令执行期间若有回滚改写了工作树，after 捕获
    /// 据此跳过变更记录，避免把其他会话回滚的内容误记到本会话。
    restore_epoch: u64,
}
fn checkpoint_root() -> Result<PathBuf> {
    super::storage_locations::checkpoint_root()
}

fn work_dir_lock(work_dir: &Path) -> Result<Arc<AsyncRwLock<()>>> {
    let locks = CHECKPOINT_WORK_DIR_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| Error::from_reason("Checkpoint work directory lock registry is poisoned"))?;
    if let Some(lock) = locks.get(work_dir).and_then(Weak::upgrade) {
        return Ok(lock);
    }

    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(AsyncRwLock::new(()));
    locks.insert(work_dir.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
}

fn normalize_operation_key(value: &str) -> String {
    let mut key = value.trim().replace('\\', "/");
    while key.len() > 1 && key.ends_with('/') {
        key.pop();
    }
    #[cfg(windows)]
    if !key.contains("://") {
        key.make_ascii_lowercase();
    }
    key
}

/// 返回工具执行级工作目录锁。这里只规范化字符串作为锁键，不执行文件
/// 系统 IO，因此可直接从 async N-API / MCP 路径调用而不阻塞。
///
/// 持有语义（会话间互不阻塞是首要目标）：
/// - 文件工具：整个编辑周期持有共享读锁（before → 执行 → after）。
/// - 只读 checkpoint 查询（变更列表 / diff）：持有共享读锁，可与文件工具并行；
/// - bash 命令：执行期间不持有任何执行级锁，跨会话命令并行运行；
///   仅在 before/after 扫描期间短暂持共享读锁，与回滚互斥即可。
/// - 外部 MCP（影响范围未知）：仍按整树独占锁隔离（无 before/after
///   捕获可跳过，无法用回滚纪元保护）。
/// - 回滚 / 实际恢复：独占写锁，仅需等待进行中的文件工具（秒级），
///   不会再被长时间运行的 bash 命令阻塞。
pub(crate) fn checkpoint_operation_lock(work_dir: &str) -> Result<Arc<AsyncRwLock<()>>> {
    let key = normalize_operation_key(work_dir);
    let locks = CHECKPOINT_OPERATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| Error::from_reason("Checkpoint operation lock registry is poisoned"))?;
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }

    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(AsyncRwLock::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

/// 取（或创建）某工作目录的回滚纪元计数器。键规范化与执行级锁一致，
/// 保证同一目录的捕获/恢复读写同一计数。Weak 避免目录废弃后残留对象。
fn restore_epoch_counter(work_dir: &str) -> Result<Arc<AtomicU64>> {
    let key = normalize_operation_key(work_dir);
    let counters = CHECKPOINT_RESTORE_EPOCHS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut counters = counters
        .lock()
        .map_err(|_| Error::from_reason("Checkpoint restore epoch registry is poisoned"))?;
    if let Some(counter) = counters.get(&key).and_then(Weak::upgrade) {
        return Ok(counter);
    }

    counters.retain(|_, counter| counter.strong_count() > 0);
    let counter = Arc::new(AtomicU64::new(0));
    counters.insert(key, Arc::downgrade(&counter));
    Ok(counter)
}

/// 读取当前回滚纪元。无锁读取，任意线程（含 async 上下文）可调用。
pub(crate) fn current_restore_epoch(work_dir: &str) -> Result<u64> {
    Ok(restore_epoch_counter(work_dir)?.load(Ordering::SeqCst))
}

/// 回滚执行时递增纪元：正在运行的 bash 命令由此感知工作树被回滚改写，
/// after 捕获据此跳过，防止跨会话误记变更。
pub(crate) fn bump_restore_epoch(work_dir: &str) -> Result<()> {
    restore_epoch_counter(work_dir)?.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// 变更归属注册表：记录工作目录内每个路径最近的文件变更由哪个捕获负责。
/// 多会话并行共享同一工作目录时，bash 的全树 before→after 对比无法区分
/// "本会话命令改的"与"并行会话改的"；文件工具（filesystem-replace_edit /
/// create）在 before 阶段登记"正在追捕目标文件"、after 阶段解除并保留
/// 归属，bash 全树 after 对比据此跳过并行会话已认领的文件——防止把其他
/// 会话在 bash 执行期间的修改误记到本会话 checkpoint（回滚列表混入无关
/// 文件的核心防线）。
/// key = "{normalized_work_dir}\\0{normalized_relative}"。
struct RecordedFileChange {
    /// 变更前内容对象 id（BLAKE3，None = 变更前不存在）。用于判断
    /// "变更起点与本会话 before 指纹一致"——一致说明该变化发生在本会话
    /// 观察起点之后且已由其他捕获记录，归它负责。
    original_object_id: Option<String>,
    /// 文件工具 before 已登记、after 尚未完成。超时自动失效（工具崩溃
    /// 后 after 不会执行，避免该路径被永久跳过）。
    active_since: Option<Instant>,
}

/// active 登记（before→after 区间）的兜底超时：正常文件工具毫秒级完成。
const ACTIVE_CAPTURE_TIMEOUT: Duration = Duration::from_secs(600);

/// 归属注册表上限：超过后清理已完成（非 active）的条目防膨胀。
const RECORDED_CHANGES_MAX_ENTRIES: usize = 100_000;

static CHECKPOINT_RECORDED_CHANGES: OnceLock<Mutex<HashMap<String, RecordedFileChange>>> =
    OnceLock::new();

fn recorded_changes() -> MutexGuard<'static, HashMap<String, RecordedFileChange>> {
    CHECKPOINT_RECORDED_CHANGES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn recorded_change_key(work_dir: &str, relative: &str) -> String {
    format!(
        "{}\0{}",
        normalize_operation_key(work_dir),
        normalize_operation_key(relative)
    )
}

fn trim_recorded_changes(changes: &mut HashMap<String, RecordedFileChange>) {
    if changes.len() >= RECORDED_CHANGES_MAX_ENTRIES {
        changes.retain(|_, entry| entry.active_since.is_some());
    }
}

/// 文件工具 before：登记目标文件（active），original 为变更前内容 id。
pub(crate) fn register_file_capture_start(
    work_dir: &str,
    relative: &str,
    original_object_id: Option<String>,
) {
    let mut changes = recorded_changes();
    trim_recorded_changes(&mut changes);
    changes.insert(
        recorded_change_key(work_dir, relative),
        RecordedFileChange {
            original_object_id,
            active_since: Some(Instant::now()),
        },
    );
}

/// 文件工具 after：解除 active，保留变更归属（original 不变）。
pub(crate) fn register_file_capture_end(work_dir: &str, relative: &str) {
    let key = recorded_change_key(work_dir, relative);
    let mut changes = recorded_changes();
    if let Some(entry) = changes.get_mut(&key) {
        entry.active_since = None;
    }
}

/// 变更被写入 manifest（bash 全树对比 / 文件工具 after）时登记归属。
pub(crate) fn register_recorded_change(
    work_dir: &str,
    relative: &str,
    original_object_id: Option<String>,
) {
    let mut changes = recorded_changes();
    trim_recorded_changes(&mut changes);
    changes
        .entry(recorded_change_key(work_dir, relative))
        .and_modify(|entry| {
            entry.original_object_id.clone_from(&original_object_id);
            entry.active_since = None;
        })
        .or_insert_with(|| RecordedFileChange {
            original_object_id,
            active_since: None,
        });
}

/// bash 全树 after 对比判定：该路径的变化是否已由其他捕获认领。
/// - active（并行文件工具正在追捕）：跳过，它稍后会自己记录；
/// - 登记的变更前内容与本会话 before 指纹一致：变化发生在观察起点之后
///   且已被人记录，归别人负责；
/// - 登记的变更前内容不同：那条记录的起点早于本会话观察，与本会话无关，
///   继续走正常对比。
pub(crate) fn change_owned_by_other_capture(
    work_dir: &str,
    relative: &str,
    before_object_id: Option<&str>,
) -> bool {
    let key = recorded_change_key(work_dir, relative);
    let changes = recorded_changes();
    let Some(entry) = changes.get(&key) else {
        return false;
    };
    if let Some(active_since) = entry.active_since {
        if active_since.elapsed() < ACTIVE_CAPTURE_TIMEOUT {
            return true;
        }
    }
    match before_object_id {
        // 本会话 before 时文件不存在：对方也登记"变更前不存在"才算同源。
        None => entry.original_object_id.is_none(),
        Some(object_id) => entry.original_object_id.as_deref() == Some(object_id),
    }
}

/// 从记录状态提取归属比对用的内容 id（Missing / Git 无法对比，返回 None）。
fn original_object_id(original: &OriginalState) -> Option<String> {
    match original {
        OriginalState::Object { object_id } => Some(object_id.clone()),
        _ => None,
    }
}

/// 返回同一工作目录下某个文件的执行锁。工作目录锁负责与 bash/回滚互斥，
/// 文件锁只串行化相同路径，保留不同文件之间的并行能力。
pub(crate) fn checkpoint_file_operation_lock(
    work_dir: &str,
    file_path: &str,
) -> Result<Arc<AsyncMutex<()>>> {
    let key = format!(
        "{}\0{}",
        normalize_operation_key(work_dir),
        normalize_operation_key(file_path)
    );
    let locks = CHECKPOINT_FILE_OPERATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| Error::from_reason("Checkpoint file operation lock registry is poisoned"))?;
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }

    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

fn work_dir_read_guard(lock: &AsyncRwLock<()>) -> Result<tokio::sync::RwLockReadGuard<'_, ()>> {
    Ok(lock.blocking_read())
}

fn work_dir_write_guard(lock: &AsyncRwLock<()>) -> Result<tokio::sync::RwLockWriteGuard<'_, ()>> {
    Ok(lock.blocking_write())
}

/// 远程（SSH）async 流程的读锁：blocking_read 在 tokio worker 线程上会
/// panic（"while the thread is being used to drive asynchronous tasks"），
/// 远程流程必须用异步等待版本。
pub(crate) async fn work_dir_read_guard_async(
    lock: &AsyncRwLock<()>,
) -> tokio::sync::RwLockReadGuard<'_, ()> {
    lock.read().await
}

/// 远程（SSH）async 流程的写锁（仅回滚使用）。
pub(crate) async fn work_dir_write_guard_async(
    lock: &AsyncRwLock<()>,
) -> tokio::sync::RwLockWriteGuard<'_, ()> {
    lock.write().await
}

fn manifest_lock(checkpoint_id: &str) -> Result<Arc<AsyncMutex<()>>> {
    let locks = CHECKPOINT_MANIFEST_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| Error::from_reason("Checkpoint manifest lock registry is poisoned"))?;
    if let Some(lock) = locks.get(checkpoint_id).and_then(Weak::upgrade) {
        return Ok(lock);
    }

    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(checkpoint_id.to_string(), Arc::downgrade(&lock));
    Ok(lock)
}

fn with_manifest_lock<T>(
    checkpoint_id: &str,
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let lock = manifest_lock(checkpoint_id)?;
    let _guard = lock.blocking_lock();
    operation()
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

/// Stream a file through BLAKE3 and return its hex content id.
fn hash_file(path: &Path) -> Result<String> {
    let mut source = File::open(path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read checkpoint source '{}': {error}",
            path.display()
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
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Publish the file's content into the content-addressed object store.
/// The object id is the BLAKE3 digest, so identical content is stored once
/// and repeated captures of unchanged files write nothing.
fn store_object(path: &Path) -> Result<String> {
    let object_dir = checkpoint_root()?.join(OBJECT_DIR_NAME);
    fs::create_dir_all(&object_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object directory: {error}"
        ))
    })?;
    let object_id = hash_file(path)?;
    let final_path = object_dir.join(&object_id);
    if final_path.exists() {
        return Ok(object_id);
    }
    let temporary = object_dir.join(format!("{}.tmp", generate_checkpoint_id()));
    fs::copy(path, &temporary).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object '{}': {error}",
            temporary.display()
        ))
    })?;
    if final_path.exists() {
        let _ = fs::remove_file(&temporary);
    } else if let Err(error) = fs::rename(&temporary, &final_path) {
        // Another session may have published the same content-addressed object
        // after our exists check. Treat that as a successful deduplicated write.
        if final_path.exists() {
            let _ = fs::remove_file(&temporary);
        } else {
            let _ = fs::remove_file(&temporary);
            return Err(Error::from_reason(format!(
                "Failed to publish checkpoint object: {error}"
            )));
        }
    }
    Ok(object_id)
}

/// Publish in-memory bytes into the content-addressed object store.
/// Used by the remote (SSH) checkpoint flows: file content arrives from
/// Electron via SFTP and is stored with the same BLAKE3 deduplication as
/// locally captured files.
fn store_object_bytes(content: &[u8]) -> Result<String> {
    let object_dir = checkpoint_root()?.join(OBJECT_DIR_NAME);
    fs::create_dir_all(&object_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object directory: {error}"
        ))
    })?;
    let object_id = blake3::Hasher::new()
        .update(content)
        .finalize()
        .to_hex()
        .to_string();
    let final_path = object_dir.join(&object_id);
    if final_path.exists() {
        return Ok(object_id);
    }
    let temporary = object_dir.join(format!("{}.tmp", generate_checkpoint_id()));
    fs::write(&temporary, content).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object '{}': {error}",
            temporary.display()
        ))
    })?;
    if final_path.exists() {
        let _ = fs::remove_file(&temporary);
    } else if let Err(error) = fs::rename(&temporary, &final_path) {
        // Another session may have published the same content-addressed object
        // after our exists check. Treat that as a successful deduplicated write.
        if final_path.exists() {
            let _ = fs::remove_file(&temporary);
        } else {
            let _ = fs::remove_file(&temporary);
            return Err(Error::from_reason(format!(
                "Failed to publish checkpoint object: {error}"
            )));
        }
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
    let Some(entry) = manifest
        .entries
        .iter_mut()
        .find(|entry| manifest_paths_equal(&entry.path, path))
    else {
        return Ok(false);
    };
    // Windows 大小写不敏感命中（如历史小写条目）时顺手把条目路径升级为
    // 当前真实大小写，避免同一文件在 manifest 中分裂成两条记录。
    entry.path = path.to_string();
    entry.expected = Some(current_state(absolute)?);
    Ok(true)
}

fn capture_entry(
    manifest: &mut CheckpointManifest,
    absolute: &Path,
    relative: &Path,
    original: OriginalState,
    work_dir: &str,
) -> Result<()> {
    if relative.as_os_str().is_empty() || should_skip_relative(relative) {
        return Ok(());
    }
    let path = to_forward_slashes(relative);
    let expected = current_state(absolute)?;
    // 归属比对用内容 id：在 original 被 move 进 manifest 前提取。
    let original_id = original_object_id(&original);
    if let Some(entry) = manifest
        .entries
        .iter_mut()
        .find(|entry| manifest_paths_equal(&entry.path, &path))
    {
        // 大小写不敏感命中：更新 expected 并把条目路径升级为真实大小写。
        entry.path = path.clone();
        entry.expected = Some(expected);
    } else {
        manifest.entries.push(CheckpointEntry {
            path: path.clone(),
            original,
            expected: Some(expected),
        });
    }
    // 登记归属：该路径的变化由本次捕获负责，并行会话的 bash 全树对比
    // 会据此跳过，不再重复/误记。
    register_recorded_change(work_dir, &path, original_id);
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
/// File content is captured lazily immediately before a tool first changes it.
/// Creation only publishes a new manifest, so it does not take the shared
/// work-directory lock used by active tool captures.
///
/// The manifest is fully self-contained: no git baseline is recorded, so
/// checkpoint capture/restore never depends on git state (working tree,
/// index, HEAD), which the user or other conversations may mutate at any time.
pub fn create_checkpoint(work_dir: String) -> Result<String> {
    let root = canonical_work_dir(&work_dir)?;
    let checkpoint_id = generate_checkpoint_id();
    with_manifest_lock(&checkpoint_id, || {
        let manifest = CheckpointManifest {
            version: MANIFEST_VERSION,
            work_dir: root.to_string_lossy().to_string(),
            git: None,
            entries: Vec::new(),
        };

        write_manifest(&checkpoint_id, &manifest)?;
        Ok(checkpoint_id.clone())
    })
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
    let root = canonical_work_dir(&work_dir)?;
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_read_guard(&work_dir_lock)?;
    let (absolute, path) = resolve_checkpoint_path(&root, &file_path)?;
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    // before 内容只采样一次；无论该文件是否已有条目（同一文件在本会话
    // 后续轮次再次被编辑时，manifest 里已存在记录）都必须登记"正在追捕"，
    // 否则本轮编辑执行期间并行 bash 的全树对比会把变化误记到自己名下。
    let original = current_state(&absolute)?;
    register_file_capture_start(&work_dir, &path, original_object_id(&original));

    for checkpoint_id in checkpoint_ids {
        with_manifest_lock(&checkpoint_id, || {
            let mut manifest = read_manifest(&checkpoint_id)?;
            let Some(_root) = validate_capture_work_dir(&manifest, &work_dir) else {
                return Ok(());
            };
            if let Some(entry) = manifest
                .entries
                .iter_mut()
                .find(|entry| manifest_paths_equal(&entry.path, &path))
            {
                // 已有条目（Windows 下大小写不同也算同一文件）：把路径升级
                // 为当前真实大小写，避免 manifest 中同一文件出现两条记录。
                entry.path = path.clone();
                return Ok(());
            }
            manifest.entries.push(CheckpointEntry {
                path: path.clone(),
                original: original.clone(),
                expected: None,
            });
            write_manifest(&checkpoint_id, &manifest)
        })?;
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
    let root = canonical_work_dir(&work_dir)?;
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_read_guard(&work_dir_lock)?;
    let (absolute, path) = resolve_checkpoint_path(&root, &file_path)?;
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    for checkpoint_id in checkpoint_ids {
        with_manifest_lock(&checkpoint_id, || {
            let mut manifest = read_manifest(&checkpoint_id)?;
            let Some(_root) = validate_capture_work_dir(&manifest, &work_dir) else {
                return Ok(());
            };
            if update_expected_state(&mut manifest, &absolute, &path)? {
                write_manifest(&checkpoint_id, &manifest)?;
            }
            Ok(())
        })?;
    }
    // 无条件解除"正在追捕"登记（即使 before 记录失败 / 工具未实际修改），
    // 并保留变更归属，供并行 bash 的全树对比判定跳过。
    register_file_capture_end(&work_dir, &path);
    Ok(())
}

/// 判断命令后文件是否仍与命令前状态一致（mtime+size 快速路径，
/// 内容 hash 兜底）。返回 true 表示无变化。
fn pending_state_matches_current(state: &PendingFileState, current: &Path) -> Result<bool> {
    // 快速路径：mtime+size 未变 → 未修改（工具写文件必更新 mtime），
    // 完全跳过内容 IO。
    if let Ok(meta) = fs::metadata(current) {
        if meta.len() == state.size && mtime_ms(&meta) == state.mtime_ms {
            return Ok(true);
        }
    }
    if !current.is_file() {
        return Ok(false);
    }
    let Some(object_id) = state.object_id.as_ref() else {
        return Ok(false);
    };
    // 内容兜底：仅 metadata 变化的文件重新哈希对比（如 touch 场景）。
    Ok(hash_file(current)? == *object_id)
}

fn pending_state_to_original(state: &PendingFileState) -> Result<OriginalState> {
    let object_id = state.object_id.as_ref().ok_or_else(|| {
        Error::from_reason("Cannot materialize an original from a skipped pending state")
    })?;
    Ok(OriginalState::Object {
        object_id: object_id.clone(),
    })
}

/// Snapshot the current worktree before a tool command runs. No manifest
/// entries are committed until the command ends.
///
/// The checkpoint system is fully self-contained ("its own git"): every file
/// is fingerprinted up front (stat + BLAKE3 content id in a deduplicated
/// object store) and the after-pass compares against these fingerprints. No
/// git state (HEAD, index, working tree) is consulted, so changes made by the
/// user or by other conversations — commits, deletes, edits — can never leak
/// into this conversation's rollback list: anything already on disk when the
/// command starts is frozen as "before". Unchanged files hit the fingerprint
/// cache (mtime+size) and cost zero content IO; the object store deduplicates
/// by content, so disk usage is bounded by the worktree's unique content, not
/// by the number of commands or checkpoints.
pub fn capture_checkpoint_worktree_before(
    checkpoint_ids: Vec<String>,
    work_dir: String,
) -> Result<Option<CheckpointWorktreeCapture>> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(None);
    }
    let root = canonical_work_dir(&work_dir)?;
    // 扫描期间短暂持有执行级共享读锁：与回滚（独占写锁）互斥，保证快照
    // 不与正在进行的回滚交错；bash 执行期间不持锁，跨会话命令并行。
    let operation_lock = checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.blocking_read();
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_read_guard(&work_dir_lock)?;
    let mut matched_any = false;
    for checkpoint_id in &checkpoint_ids {
        let lock = manifest_lock(checkpoint_id)?;
        let _guard = lock.blocking_lock();
        if !checkpoint_manifest_exists(checkpoint_id) {
            continue;
        }
        let manifest = read_manifest(checkpoint_id)?;
        if validate_capture_work_dir(&manifest, &work_dir).is_some() {
            matched_any = true;
            break;
        }
    }
    if !matched_any {
        return Ok(None);
    }

    // 全量遍历（跳过 SKIP_DIRS / gitignore / 符号链接），逐文件记录
    // mtime+size 与内容对象 id。指纹缓存命中时零内容 IO。
    let before_paths = collect_worktree_file_paths(&root)?;

    let mut before_states = HashMap::new();
    for relative_path in &before_paths {
        let absolute = root.join(from_forward_slashes(relative_path));
        let meta = fs::metadata(&absolute).ok();
        let mtime = meta.as_ref().map(mtime_ms).unwrap_or(0);
        let size = meta.as_ref().map(|meta| meta.len()).unwrap_or(0);
        let (object_id, skipped) = if let Some(object_id) =
            fingerprint_lookup(&work_dir, relative_path, mtime, size)
        {
            (Some(object_id), false)
        } else if should_skip_pending_copy(&absolute) {
            // 大文件/二进制：不抓取内容，变更不可回滚。
            (None, true)
        } else {
            match store_object(&absolute) {
                Ok(object_id) => {
                    fingerprint_store(&work_dir, relative_path, mtime, size, object_id.clone());
                    (Some(object_id), false)
                }
                Err(_) if !absolute.exists() => continue,
                Err(error) => return Err(error),
            }
        };
        before_states.insert(
            relative_path.clone(),
            PendingFileState {
                object_id,
                skipped,
                mtime_ms: mtime,
                size,
            },
        );
    }

    Ok(Some(CheckpointWorktreeCapture {
        // 先求值再移动 work_dir 字段。
        restore_epoch: current_restore_epoch(&work_dir)?,
        checkpoint_ids,
        work_dir,
        before_paths,
        before_states,
    }))
}

/// Commit only paths whose state changed while the tool command ran.
///
/// The worktree traversal happens **once** and is shared by every checkpoint
/// in the capture (they all validated against the same work_dir), instead of
/// repeating a full scan per checkpoint — the O(checkpoints × files) blowup
/// that made concurrent terminal commands progressively slower as a
/// conversation accumulated checkpoints. Only files whose state differs from
/// the before-fingerprint are recorded; every other file is left untouched.
pub fn record_checkpoint_worktree_after(capture: CheckpointWorktreeCapture) -> Result<()> {
    let root = canonical_work_dir(&capture.work_dir)?;
    // after 扫描同样短暂持有执行级共享读锁：与回滚（独占写锁）互斥。
    // 若在取得锁之前回滚已改写工作树，纪元已递增，这里跳过变更记录，
    // 避免把其他会话回滚恢复的文件误记到本会话 checkpoint。
    let operation_lock = checkpoint_operation_lock(&capture.work_dir)?;
    let _operation_guard = operation_lock.blocking_read();
    if current_restore_epoch(&capture.work_dir)? != capture.restore_epoch {
        eprintln!(
            "[checkpoint] worktree was restored by a rollback while the command ran; \
             skipping change capture for checkpoint(s) {}",
            capture.checkpoint_ids.join(", ")
        );
        return Ok(());
    }
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_read_guard(&work_dir_lock)?;
    // 先筛出仍有效且属于当前 work_dir 的 checkpoint。真正写入前会在各自
    // manifest 锁内重新读取，避免覆盖同项目其他并行工具刚记录的条目。
    let mut effective_ids = Vec::new();
    let mut root = None;
    for checkpoint_id in &capture.checkpoint_ids {
        let lock = manifest_lock(checkpoint_id)?;
        let _guard = lock.blocking_lock();
        if !checkpoint_manifest_exists(checkpoint_id) {
            continue;
        }
        let manifest = read_manifest(checkpoint_id)?;
        if let Some(matched_root) = validate_capture_work_dir(&manifest, &capture.work_dir) {
            effective_ids.push(checkpoint_id.clone());
            root.get_or_insert(matched_root);
        }
    }
    let Some(root) = root else {
        return Ok(());
    };

    // 候选 = 命令前文件集 ∪ 命令后工作树文件集：覆盖新增/删除/修改全部
    // 情形。逐文件与 before 指纹对比，只有真实变化才记录——其他会话或
    // 用户在命令执行前已落盘的改动已固化在 before 指纹里，不会误记。
    let after_paths = collect_worktree_file_paths(&root)?;
    let mut candidates = capture.before_paths.clone();
    candidates.extend(after_paths);

    for checkpoint_id in effective_ids {
        with_manifest_lock(&checkpoint_id, || {
            if !checkpoint_manifest_exists(&checkpoint_id) {
                return Ok(());
            }
            let mut manifest = read_manifest(&checkpoint_id)?;
            let Some(root) = validate_capture_work_dir(&manifest, &capture.work_dir) else {
                return Ok(());
            };
            let mut changed = false;

            for relative_path in &candidates {
                let relative = from_forward_slashes(relative_path);
                if should_skip_relative(&relative) {
                    continue;
                }
                let absolute = root.join(&relative);
                let before_state = capture.before_states.get(relative_path);

                // 变更检测：before 存在时 mtime+size/hash 对比；before 不
                // 存在且命令后存在 → 命令新建。
                let changed_now = match before_state {
                    // 内容抓取被跳过：无法恢复命令前内容，不记录变更
                    Some(state) if state.skipped => false,
                    Some(state) => !pending_state_matches_current(state, &absolute)?,
                    None => absolute.is_file(),
                };
                if !changed_now {
                    continue;
                }
                // 多会话并行防线：该路径已被并行文件工具认领（正在追捕或
                // 已按同一变更起点记录）时跳过——变化归它负责，不能记入
                // 本会话 checkpoint（回滚列表混入无关文件的根因）。
                if change_owned_by_other_capture(
                    &capture.work_dir,
                    relative_path,
                    before_state.and_then(|state| state.object_id.as_deref()),
                ) {
                    continue;
                }
                let original = match before_state {
                    Some(state) => pending_state_to_original(state)?,
                    None => OriginalState::Missing,
                };

                capture_entry(&mut manifest, &absolute, &relative, original, &capture.work_dir)?;
                changed = true;
            }

            if changed {
                write_manifest(&checkpoint_id, &manifest)?;
            }
            Ok(())
        })?;
    }
    if let Some(mut cache) = DIFF_CACHE.get().and_then(|cache| cache.lock().ok()) {
        cache.retain(|key, _| {
            !capture
                .checkpoint_ids
                .iter()
                .any(|checkpoint_id| key.starts_with(&format!("{checkpoint_id}:")))
        });
    }
    Ok(())
}

/// Restore only paths that were recorded by mutating tools after this checkpoint.
pub fn restore_checkpoint(checkpoint_id: String, work_dir: String) -> Result<()> {
    let root = canonical_work_dir(&work_dir)?;
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_write_guard(&work_dir_lock)?;
    let manifest_lock = manifest_lock(&checkpoint_id)?;
    let _manifest_guard = manifest_lock.blocking_lock();
    // If the manifest no longer exists (checkpoint was deleted or corrupted),
    // there is nothing to restore. Return Ok so the rollback flow continues
    // to delete messages without being blocked by a missing checkpoint.
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    validate_manifest_work_dir(&manifest, &work_dir)?;
    // 递增回滚纪元：此刻起该目录上正在运行的 bash 命令的 after 捕获
    // 会检测到工作树被回滚改写并跳过变更记录，防止跨会话误记。
    bump_restore_epoch(&work_dir)?;

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

pub fn restore_checkpoints(checkpoint_ids: Vec<String>, work_dir: String) -> Result<()> {
    let root = canonical_work_dir(&work_dir)?;
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_write_guard(&work_dir_lock)?;
    bump_restore_epoch(&work_dir)?;

    let mut restored_entries = Vec::new();
    for checkpoint_id in checkpoint_ids.into_iter().rev() {
        let manifest_lock = manifest_lock(&checkpoint_id)?;
        let _manifest_guard = manifest_lock.blocking_lock();
        if !checkpoint_manifest_exists(&checkpoint_id) {
            continue;
        }
        let manifest = read_manifest(&checkpoint_id)?;
        validate_manifest_work_dir(&manifest, &work_dir)?;
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
            restored_entries.push(entry.clone());
        }
    }
    prune_empty_parent_directories(&root, &restored_entries);
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

/// Delete a checkpoint and release its Git reference. Content-addressed
/// objects are intentionally retained: eager global garbage collection scanned
/// every checkpoint after each best-effort delete and raced concurrent writers.
/// Existing objects are deduplicated by BLAKE3, so retaining them keeps deletes
/// constant-time and avoids re-copying identical file contents later.
pub fn delete_checkpoint(checkpoint_id: String) -> Result<()> {
    let manifest_lock = manifest_lock(&checkpoint_id)?;
    let _manifest_guard = manifest_lock.blocking_lock();
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
    })
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

/// 展示用路径规范化：历史 manifest 中可能存在旧版记录的全小写相对路径
/// （Windows 上 path_key 产物，磁盘上并不存在该拼写）。文件仍存在时用
/// canonicalize 恢复磁盘真实大小写；文件已删除或解析失败时保持原条目。
/// `\\x00abs:` 标记的工作区外条目本身就是真实路径，原样返回。
fn display_entry_path(root: &Path, entry_path: &str) -> String {
    if entry_path.starts_with(ABSOLUTE_PATH_MARKER) {
        return entry_path.to_string();
    }
    let absolute = resolve_manifest_path(root, entry_path);
    real_relative_path(root, &absolute).unwrap_or_else(|| entry_path.to_string())
}

/// Compare only paths explicitly recorded while this conversation's tools ran.
pub fn list_checkpoint_changes(
    checkpoint_id: String,
    work_dir: String,
) -> Result<Vec<CheckpointFileChange>> {
    let root = canonical_work_dir(&work_dir)?;
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_read_guard(&work_dir_lock)?;
    let manifest_lock = manifest_lock(&checkpoint_id)?;
    let _manifest_guard = manifest_lock.blocking_lock();
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    validate_manifest_work_dir(&manifest, &work_dir)?;
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
                path: display_entry_path(&root, &entry.path),
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
    let root = canonical_work_dir(&work_dir)?;
    let work_dir_lock = work_dir_lock(&root)?;
    let _work_dir_guard = work_dir_read_guard(&work_dir_lock)?;
    let manifest_lock = manifest_lock(&checkpoint_id)?;
    let _manifest_guard = manifest_lock.blocking_lock();
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    validate_manifest_work_dir(&manifest, &work_dir)?;
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
            path: display_entry_path(&root, &entry.path),
            change_type,
            content,
            is_binary,
        });
    }
    diffs.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(diffs)
}

pub fn list_checkpoint_diffs_batch(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileDiff>> {
    let mut seen_paths = HashSet::new();
    let mut diffs = Vec::new();
    for checkpoint_id in checkpoint_ids {
        if !checkpoint_manifest_exists(&checkpoint_id) {
            continue;
        }
        for diff in list_checkpoint_diffs(checkpoint_id, work_dir.clone(), include_all)? {
            if seen_paths.insert(diff.path.clone()) {
                diffs.push(diff);
            }
        }
    }
    Ok(diffs)
}

pub fn list_checkpoint_changes_batch(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileChange>> {
    Ok(list_checkpoint_diffs_batch(checkpoint_ids, work_dir, include_all)?
        .into_iter()
        .map(|diff| CheckpointFileChange {
            path: diff.path,
            change_type: diff.change_type,
        })
        .collect())
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
