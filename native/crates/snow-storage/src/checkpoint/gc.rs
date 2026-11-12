//! 内容对象回收：删除不再被任何 manifest 引用的对象文件。
//!
//! 对象 id 在写入 manifest 前可能只存在于内存（bash before 指纹、指纹缓存），
//! 因此所有产出/复用对象 id 的捕获入口都持有 [`ObjectWriterGuard`]。回收只在
//! 无写入者时开始；删除按批在状态锁内进行并校验写入代数，任一写入者介入即
//! 中止，待写入者全部结束后自动重试。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime};

use napi::bindgen_prelude::*;

use super::{checkpoint_root, fingerprint_cache, object_path_cache, OBJECT_DIR_NAME};

const DELETE_BATCH: usize = 128;
const START_DELAY: Duration = Duration::from_millis(800);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
/// 全量清理只回收超过保留期的未引用对象：近期对象多为 bash 捕获的工作区内容缓存。
/// 保留天数由通用设置写入 system_settings（与前端常量保持一致）。
const ORPHAN_RETENTION_SETTING_CODE: &str = "checkpoint_orphan_retention_days";
const ORPHAN_RETENTION_DEFAULT_DAYS: u64 = 7;
const ORPHAN_RETENTION_MIN_DAYS: u64 = 1;
const ORPHAN_RETENTION_MAX_DAYS: u64 = 365;
const MANIFEST_FILE_NAME: &str = "manifest.json";
const MAX_SCAN_DEPTH: usize = 4;
const OBJECT_ID_LEN: usize = 64;

#[derive(Default)]
struct GcState {
    active_writers: u64,
    /// 每次取得写入租约递增：回收期间代数变化即说明有写入者介入。
    generation: u64,
    running: bool,
    candidates: HashSet<String>,
    full_sweep: bool,
}

impl GcState {
    fn has_work(&self) -> bool {
        self.full_sweep || !self.candidates.is_empty()
    }
}

static GC_STATE: OnceLock<Mutex<GcState>> = OnceLock::new();

fn gc_state() -> MutexGuard<'static, GcState> {
    GC_STATE
        .get_or_init(|| Mutex::new(GcState::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 对象写入租约：持有期间回收不会开始，进行中的回收在下一批前中止。
pub(crate) struct ObjectWriterGuard {
    _private: (),
}

pub(crate) fn object_writer_guard() -> ObjectWriterGuard {
    let mut state = gc_state();
    state.active_writers += 1;
    state.generation = state.generation.wrapping_add(1);
    ObjectWriterGuard { _private: () }
}

impl Drop for ObjectWriterGuard {
    fn drop(&mut self) {
        let mut state = gc_state();
        state.active_writers = state.active_writers.saturating_sub(1);
        maybe_start(&mut state);
    }
}

/// 登记被删除检查点引用过的对象，后台回收其中已无引用者。
pub(crate) fn release_objects(object_ids: impl IntoIterator<Item = String>) {
    let mut state = gc_state();
    state.candidates.extend(object_ids);
    maybe_start(&mut state);
}

/// 调度一次全量清理：回收未被引用且超过保留期的对象（应用启动时调用）。
pub fn schedule_orphan_object_sweep() {
    let mut state = gc_state();
    state.full_sweep = true;
    maybe_start(&mut state);
}

fn maybe_start(state: &mut GcState) {
    if state.running || state.active_writers > 0 || !state.has_work() {
        return;
    }
    state.running = true;
    let spawned = std::thread::Builder::new()
        .name("checkpoint-gc".to_string())
        .spawn(run_worker);
    if spawned.is_err() {
        state.running = false;
    }
}

enum PassOutcome {
    Done,
    Interrupted,
}

fn run_worker() {
    let mut delay = START_DELAY;
    loop {
        // 延迟启动：合并批量删除产生的多次登记
        std::thread::sleep(delay);
        let (candidates, full_sweep, generation) = {
            let mut state = gc_state();
            if state.active_writers > 0 || !state.has_work() {
                // 写入者结束时由租约 Drop 重新拉起
                state.running = false;
                return;
            }
            (
                std::mem::take(&mut state.candidates),
                std::mem::replace(&mut state.full_sweep, false),
                state.generation,
            )
        };
        match run_pass(&candidates, full_sweep, generation) {
            Ok(PassOutcome::Done) => delay = START_DELAY,
            Ok(PassOutcome::Interrupted) => {
                let mut state = gc_state();
                state.candidates.extend(candidates);
                state.full_sweep |= full_sweep;
                delay = (delay * 2).min(MAX_RETRY_DELAY);
            }
            Err(error) => {
                // 放弃本轮：遗留对象由下次启动的全量清理兜底
                eprintln!("[checkpoint-gc] {error}");
                delay = START_DELAY;
            }
        }
    }
}

fn run_pass(
    candidates: &HashSet<String>,
    full_sweep: bool,
    generation: u64,
) -> Result<PassOutcome> {
    let root = checkpoint_root()?;
    let objects_dir = root.join(OBJECT_DIR_NAME);
    if !objects_dir.is_dir() {
        return Ok(PassOutcome::Done);
    }
    let referenced = collect_referenced_ids(&root).map_err(|error| {
        Error::from_reason(format!("Failed to scan checkpoint manifests: {error}"))
    })?;

    let mut targets: Vec<(String, PathBuf)> = Vec::new();
    for object_id in candidates {
        if !is_object_id(object_id) || referenced.contains(object_id) {
            continue;
        }
        for path in object_locations(&objects_dir, object_id) {
            targets.push((object_id.clone(), path));
        }
    }
    if full_sweep {
        let cutoff = SystemTime::now().checked_sub(orphan_retention());
        collect_stale_objects(&objects_dir, &referenced, cutoff, &mut targets);
    }
    let mut seen = HashSet::new();
    targets.retain(|(_, path)| seen.insert(path.clone()));
    Ok(delete_targets(&targets, generation))
}

/// 读取保留天数；缺失或非法回落默认值，越界截断。
fn orphan_retention_days() -> u64 {
    snow_storage_core::bootstrap::ensure_database_file()
        .ok()
        .and_then(|database_path| {
            snow_storage_core::system_settings::get_system_setting_value(
                &database_path,
                ORPHAN_RETENTION_SETTING_CODE,
            )
            .ok()
            .flatten()
        })
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(ORPHAN_RETENTION_DEFAULT_DAYS)
        .clamp(ORPHAN_RETENTION_MIN_DAYS, ORPHAN_RETENTION_MAX_DAYS)
}

fn orphan_retention() -> Duration {
    Duration::from_secs(orphan_retention_days() * 24 * 60 * 60)
}

/// SSH 远程对象库清理的输入：本机全部 manifest 引用的对象 id 加上指纹缓存
/// 中尚未写入 manifest 的对象 id（bash before 捕获），以及保留天数。
pub(crate) fn remote_sweep_inputs() -> Result<(Vec<String>, u64)> {
    let mut referenced = collect_referenced_ids(&checkpoint_root()?).map_err(|error| {
        Error::from_reason(format!("Failed to scan checkpoint manifests: {error}"))
    })?;
    referenced.extend(
        fingerprint_cache()
            .values()
            .map(|entry| entry.object_id.clone()),
    );
    Ok((referenced.into_iter().collect(), orphan_retention_days()))
}

/// 对象可能位于分片目录或旧版扁平目录。
fn object_locations(objects_dir: &Path, object_id: &str) -> Vec<PathBuf> {
    [
        objects_dir.join(&object_id[..2]).join(object_id),
        objects_dir.join(object_id),
    ]
    .into_iter()
    .filter(|path| path.is_file())
    .collect()
}

fn is_object_id(value: &str) -> bool {
    value.len() == OBJECT_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 引用集合：全部 manifest 文本中出现的 64 位十六进制串（保守超集，
/// 不依赖 manifest 结构，损坏或旧版格式也不会漏标）。
fn collect_referenced_ids(root: &Path) -> std::io::Result<HashSet<String>> {
    let mut referenced = HashSet::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name = entry.file_name();
            let name = name.to_str();
            if file_type.is_dir() {
                if depth == 0 && name == Some(OBJECT_DIR_NAME) {
                    continue;
                }
                if depth < MAX_SCAN_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
            } else if file_type.is_file() && name == Some(MANIFEST_FILE_NAME) {
                match fs::read(entry.path()) {
                    Ok(bytes) => collect_hex_ids(&bytes, &mut referenced),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(referenced)
}

fn collect_hex_ids(bytes: &[u8], referenced: &mut HashSet<String>) {
    let mut run_start = 0usize;
    let mut run_len = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_digit() || (b'a'..=b'f').contains(byte) {
            if run_len == 0 {
                run_start = index;
            }
            run_len += 1;
        } else {
            push_hex_id(bytes, run_start, run_len, referenced);
            run_len = 0;
        }
    }
    push_hex_id(bytes, run_start, run_len, referenced);
}

fn push_hex_id(bytes: &[u8], start: usize, len: usize, referenced: &mut HashSet<String>) {
    if len != OBJECT_ID_LEN {
        return;
    }
    if let Ok(text) = std::str::from_utf8(&bytes[start..start + len]) {
        referenced.insert(text.to_string());
    }
}

/// 全量清理目标：未被引用且超过保留期的对象，以及残留的临时写入文件。
fn collect_stale_objects(
    objects_dir: &Path,
    referenced: &HashSet<String>,
    cutoff: Option<SystemTime>,
    targets: &mut Vec<(String, PathBuf)>,
) {
    let Some(cutoff) = cutoff else {
        return;
    };
    let mut directories = vec![(objects_dir.to_path_buf(), true)];
    while let Some((directory, is_root)) = directories.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if is_root {
                    directories.push((entry.path(), false));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let removable = name.ends_with(".tmp")
                || (is_object_id(&name) && !referenced.contains(&name));
            if !removable {
                continue;
            }
            let stale = entry
                .metadata()
                .ok()
                .and_then(|metadata| last_touched(&metadata))
                .is_some_and(|touched| touched < cutoff);
            if stale {
                targets.push((name, entry.path()));
            }
        }
    }
}

/// 取修改/创建/状态变更时间中最新者，避免 fs::copy 继承源文件 mtime 造成误判。
fn last_touched(metadata: &fs::Metadata) -> Option<SystemTime> {
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        u64::try_from(metadata.ctime())
            .ok()
            .and_then(|secs| SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(secs)))
    };
    #[cfg(not(unix))]
    let changed: Option<SystemTime> = None;
    [metadata.modified().ok(), metadata.created().ok(), changed]
        .into_iter()
        .flatten()
        .max()
}

fn delete_targets(targets: &[(String, PathBuf)], generation: u64) -> PassOutcome {
    let mut removed = 0usize;
    let mut bytes = 0u64;
    for batch in targets.chunks(DELETE_BATCH) {
        // 整批在状态锁内完成：写入者取得租约前不会再有对象消失
        let state = gc_state();
        if state.active_writers > 0 || state.generation != generation {
            return PassOutcome::Interrupted;
        }
        let mut deleted = HashSet::new();
        for (object_id, path) in batch {
            let size = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
            if fs::remove_file(path).is_ok() {
                removed += 1;
                bytes = bytes.saturating_add(size);
                deleted.insert(object_id.clone());
            }
        }
        if !deleted.is_empty() {
            forget_cached_objects(&deleted);
        }
        drop(state);
    }
    if removed > 0 {
        eprintln!("[checkpoint-gc] removed {removed} unreferenced object(s), {bytes} bytes");
    }
    PassOutcome::Done
}

/// 失效指向已删对象的路径缓存与指纹缓存，后续捕获会重新写入对象。
fn forget_cached_objects(deleted: &HashSet<String>) {
    {
        let mut cache = object_path_cache();
        for object_id in deleted {
            cache.remove(object_id);
        }
    }
    fingerprint_cache().retain(|_, entry| !deleted.contains(&entry.object_id));
}
