//! 应用数据备份（阶段 1：本地目录后端）。
//!
//! 备份单元是 `.snowapp` 的一致性视图：两个 SQLite 库经 Online Backup API
//! 落成页序对齐的副本，其余资源按 8 MB 内容寻址分块。相同内容的块在目标
//! 目录只存一份，因此第二次之后的备份只写入发生变化的块。
//!
//! 目标目录布局与后续网络后端（S3 / WebDAV）保持一致的 key 空间：
//!
//! ```text
//! <target>/snow-app-backup/
//!   manifests/<backupId>.json
//!   chunks/<hash[0..2]>/<hash>
//!   latest.json
//!   .work/                       # 快照与恢复的临时工作区
//! ```

mod chunker;
mod gc;
mod manifest;
mod progress;
mod restore;
mod snapshot;
mod source;
mod store;

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use self::chunker::{chunk_file, CHUNK_SIZE};
use self::manifest::{
    generate_backup_id, BackupManifest, ManifestFile, ReuseIndex, MANIFEST_VERSION,
};
use self::progress::TaskProgress;
use self::snapshot::snapshot_databases;
use self::source::SourceFile;
use self::store::LocalStore;

pub use self::progress::{task_progress, BackupTaskProgress};

/// 备份根目录名：位于用户选择的目标目录下，避免与其它的文件混在一起。
pub(crate) const BACKUP_DIR_NAME: &str = "snow-app-backup";
/// 默认保留的备份份数。
const DEFAULT_KEEP: u32 = 5;
/// 保留份数上限，防止用户配置出无意义的巨大值。
const MAX_KEEP: u32 = 50;

/// 一次备份的执行结果。
#[napi(object)]
pub struct BackupCreateResult {
    /// 备份 id（同时是 manifest 文件名）。
    pub id: String,
    /// 备份完成时间（Unix 毫秒）。
    pub created_at_ms: i64,
    /// 本次备份覆盖的源数据总字节数。
    pub total_bytes: i64,
    /// 本次实际写入的块字节数（命中已有块的部分不计入）。
    pub uploaded_bytes: i64,
    /// 本次实际写入的块数量。
    pub uploaded_chunks: u32,
    /// 复用已有块的数量。
    pub reused_chunks: u32,
    /// 备份包含的文件数。
    pub file_count: u32,
}

/// 单份备份的摘要信息（用于列表展示）。
#[napi(object)]
pub struct BackupSummary {
    pub id: String,
    pub created_at_ms: i64,
    pub total_bytes: i64,
    pub file_count: u32,
    pub app_version: String,
}

/// 备份预估结果：不写入任何数据，只统计本次需要上传多少。
#[napi(object)]
pub struct BackupPlan {
    /// 本次备份覆盖的源数据总字节数。
    pub total_bytes: i64,
    /// 预计需要新写入的块字节数。
    pub pending_bytes: i64,
    /// 预计需要新写入的块数量。
    pub pending_chunks: u32,
    /// 命中已有块、无需上传的数量。
    pub reused_chunks: u32,
    pub file_count: u32,
}

/// 创建、恢复与删除共享一把进程内互斥锁。
///
/// 备份的"先写块、后写清单"与回收的"按清单引用删块"必须互斥，
/// 否则并发触发时会把刚写入、尚未被清单引用的块当成孤儿删掉。
fn with_operation_lock<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let result = operation();
    drop(guard);
    result
}

/// 创建一次本地目录备份。
pub fn create_local_backup(
    target_dir: &str,
    keep: Option<u32>,
) -> Result<BackupCreateResult> {
    with_operation_lock(|| {
        let task = TaskProgress::begin("create", "snapshot");
        create_local_backup_inner(target_dir, keep, &task)
    })
}

fn create_local_backup_inner(
    target_dir: &str,
    keep: Option<u32>,
    task: &TaskProgress,
) -> Result<BackupCreateResult> {
    let keep = normalize_keep(keep);
    let store = LocalStore::open(target_dir)?;
    let app_dir = crate::storage::paths::app_storage_dir()?;
    let reuse = ReuseIndex::from_manifest(store.latest_manifest()?.as_ref());

    let id = generate_backup_id();
    let work_dir = store.create_work_dir(&id)?;

    // 无论成功与否都清理临时工作区；成功路径下它只装着数据库快照。
    let outcome = write_backup(&store, &app_dir, &reuse, &id, &work_dir, task);
    let _ = fs::remove_dir_all(&work_dir);
    let (manifest, result) = outcome?;

    task.phase("finalize");
    store.write_manifest(&manifest)?;
    store.write_latest(&manifest.id, manifest.created_at_ms)?;

    gc::prune_manifests(&store, keep)?;
    gc::sweep_orphan_chunks(&store)?;

    Ok(result)
}

/// 预估一次备份的上传量。只读取与哈希，不写入目标目录。
pub fn plan_local_backup(target_dir: &str) -> Result<BackupPlan> {
    let store = LocalStore::open(target_dir)?;
    let app_dir = crate::storage::paths::app_storage_dir()?;
    let reuse = ReuseIndex::from_manifest(store.latest_manifest()?.as_ref());
    let sources = source::collect(&app_dir, plan_extra_sources(&app_dir, &reuse)?, &reuse)?;

    let mut plan = BackupPlan {
        total_bytes: 0,
        pending_bytes: 0,
        pending_chunks: 0,
        reused_chunks: 0,
        file_count: sources.len() as u32,
    };
    let mut seen: HashSet<String> = HashSet::new();

    for source in sources {
        plan.total_bytes += source.size;
        match source.reuse_chunks {
            Some(chunks) => {
                for hash in chunks {
                    if seen.insert(hash) {
                        plan.reused_chunks += 1;
                    }
                }
            }
            None => {
                // 估算阶段不落盘，只统计哈希；读取正在写入的数据库可能得到
                // 页级撕裂的内容，但结果仅用于提示数据量，不影响备份正确性。
                chunk_file(&source.source_path, |hash, bytes| {
                    if seen.insert(hash.to_string()) {
                        if store.has_chunk(hash) {
                            plan.reused_chunks += 1;
                        } else {
                            plan.pending_chunks += 1;
                            plan.pending_bytes += bytes.len() as i64;
                        }
                    }
                    Ok(())
                })?;
            }
        }
    }

    Ok(plan)
}

/// 列出目标目录中已有的备份，按创建时间倒序。
pub fn list_local_backups(target_dir: &str) -> Result<Vec<BackupSummary>> {
    let store = LocalStore::open(target_dir)?;
    Ok(store
        .list_manifests()?
        .into_iter()
        .map(|manifest| BackupSummary {
            id: manifest.id,
            created_at_ms: manifest.created_at_ms,
            total_bytes: manifest.total_bytes,
            file_count: manifest.files.len() as u32,
            app_version: manifest.app_version,
        })
        .collect())
}

/// 从指定备份恢复 `.snowapp`。
///
/// 资源文件立即写回，数据库文件先暂存，等应用下次启动、尚未打开任何连接时
/// 再替换——运行中的应用一直占用 `snowapp.db`，此刻无法安全改名。
pub fn restore_local_backup(target_dir: &str, backup_id: &str) -> Result<()> {
    with_operation_lock(|| {
        let store = LocalStore::open(target_dir)?;
        let app_dir = crate::storage::paths::app_storage_dir()?;
        restore::stage_restore(&store, &app_dir, backup_id)
    })
}

/// 应用上一次恢复暂存的数据库。必须在任何数据库连接打开之前调用。
pub(crate) fn apply_pending_restore(app_dir: &Path) -> Result<()> {
    restore::apply_pending_restore(app_dir)
}

/// 删除一份备份并回收不再被任何备份引用的块。
pub fn delete_local_backup(target_dir: &str, backup_id: &str) -> Result<()> {
    with_operation_lock(|| {
        let store = LocalStore::open(target_dir)?;
        store.delete_manifest(backup_id)?;
        store.clear_latest_if(backup_id)?;
        gc::sweep_orphan_chunks(&store)?;
        Ok(())
    })
}

/// 返回备份根目录的绝对路径，供 UI 展示或「在文件管理器中打开」。
pub fn local_backup_root(target_dir: &str) -> Result<String> {
    Ok(LocalStore::open(target_dir)?
        .root()
        .to_string_lossy()
        .into_owned())
}

/// 备份过程中累积的统计信息。
struct BackupProgress {
    id: String,
    created_at_ms: i64,
    total_bytes: i64,
    uploaded_bytes: i64,
    uploaded_chunks: u32,
    reused_chunks: u32,
    files: Vec<ManifestFile>,
}

/// 分块写入所有源文件，返回可持久化的清单与对外统计。
fn write_backup(
    store: &LocalStore,
    app_dir: &Path,
    reuse: &ReuseIndex,
    id: &str,
    work_dir: &Path,
    task: &TaskProgress,
) -> Result<(BackupManifest, BackupCreateResult)> {
    let snapshots = snapshot_databases(app_dir, work_dir, reuse)?;
    task.phase("collect");
    let mut sources = source::collect(app_dir, snapshots, reuse)?;
    sources.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let total_bytes: i64 = sources.iter().map(|source| source.size).sum();
    task.set_totals(total_bytes, sources.len() as u32);
    task.phase("write");

    let mut progress = BackupProgress {
        id: id.to_string(),
        created_at_ms: chrono::Local::now().timestamp_millis(),
        total_bytes: 0,
        uploaded_bytes: 0,
        uploaded_chunks: 0,
        reused_chunks: 0,
        files: Vec::with_capacity(sources.len()),
    };
    let mut seen: HashSet<String> = HashSet::new();

    for source in sources {
        let SourceFile {
            source_path,
            relative_path,
            size: source_size,
            modified_ms,
            reuse_chunks,
        } = source;
        progress.total_bytes += source_size;
        let (chunks, size) = match reuse_chunks {
            Some(chunks) => {
                for hash in &chunks {
                    if seen.insert(hash.clone()) {
                        progress.reused_chunks += 1;
                    }
                }
                (chunks, source_size)
            }
            None => {
                let (chunks, written_size) = chunk_file(&source_path, |hash, bytes| {
                    let written = store.put_chunk(hash, bytes)?;
                    if written {
                        progress.uploaded_bytes += bytes.len() as i64;
                        if seen.insert(hash.to_string()) {
                            progress.uploaded_chunks += 1;
                        }
                    } else if seen.insert(hash.to_string()) {
                        progress.reused_chunks += 1;
                    }
                    Ok(())
                })?;
                (chunks, written_size as i64)
            }
        };

        progress.files.push(ManifestFile {
            path: relative_path,
            size,
            modified_ms,
            chunks,
        });
        task.advance(source_size, 1);
    }

    Ok(build_manifest(progress))
}

/// 由进度对象构造 manifest 与对外统计（move 文件列表，避免大清单复制）。
fn build_manifest(progress: BackupProgress) -> (BackupManifest, BackupCreateResult) {
    let BackupProgress {
        id,
        created_at_ms,
        total_bytes,
        uploaded_bytes,
        uploaded_chunks,
        reused_chunks,
        files,
    } = progress;

    let result = BackupCreateResult {
        id: id.clone(),
        created_at_ms,
        total_bytes,
        uploaded_bytes,
        uploaded_chunks,
        reused_chunks,
        file_count: files.len() as u32,
    };
    let manifest = BackupManifest {
        version: MANIFEST_VERSION,
        id,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at_ms,
        chunk_size: CHUNK_SIZE as u32,
        total_bytes,
        files,
    };
    (manifest, result)
}

/// 估算时以原始数据库文件作为源（不做一致性快照）。
fn plan_extra_sources(app_dir: &Path, reuse: &ReuseIndex) -> Result<Vec<SourceFile>> {
    let mut sources = Vec::new();

    // 运行库的内容一直在写，不能按 mtime 复用，必须每次重新读取。
    let runtime = app_dir.join("snowapp.db");
    if runtime.is_file() {
        sources.push(SourceFile::from_path(&runtime, "snowapp.db".to_string())?);
    }

    // 归档库是冷数据，未变化时直接沿用上次的块列表。
    let archive = app_dir.join("archive.db");
    if archive.is_file() {
        let mut source = SourceFile::from_path(&archive, "archive.db".to_string())?;
        source.reuse_chunks =
            reuse.lookup(&source.relative_path, source.size, source.modified_ms);
        sources.push(source);
    }

    Ok(sources)
}

fn normalize_keep(keep: Option<u32>) -> u32 {
    keep.unwrap_or(DEFAULT_KEEP).clamp(1, MAX_KEEP)
}
