use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use super::manifest::{BackupManifest, ManifestFile};
use super::progress::TaskProgress;
use super::store::LocalStore;

/// 必须等应用下次启动才替换的数据库文件。
const DATABASES: [&str; 2] = ["snowapp.db", "archive.db"];
/// 数据库暂存目录：位于 `.snowapp` 内部，备份扫描时整体跳过。
pub(crate) const STAGING_DIR_NAME: &str = ".restore-pending";
const JOURNAL_FILE: &str = "pending.json";
const JOURNAL_VERSION: u32 = 1;

/// 待应用的恢复日志：记录暂存目录里已经组装好的数据库文件。
#[derive(Debug, Serialize, Deserialize)]
struct PendingRestore {
    version: u32,
    backup_id: String,
    databases: Vec<PendingDatabase>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingDatabase {
    name: String,
    size: i64,
}

fn staging_dir(app_dir: &Path) -> PathBuf {
    app_dir.join(STAGING_DIR_NAME)
}

fn is_database(relative_path: &str) -> bool {
    DATABASES.contains(&relative_path)
}

/// 组装备份：资源文件立即写回 `.snowapp`，数据库文件暂存到 `.restore-pending/`。
///
/// 运行中的应用始终占用 `snowapp.db`，Windows 上无法改名替换；因此数据库
/// 只在下次启动、尚未打开任何连接时由 [apply_pending_restore] 换入。
pub(crate) fn stage_restore(store: &LocalStore, app_dir: &Path, backup_id: &str) -> Result<()> {
    let staging = staging_dir(app_dir);
    if staging.join(JOURNAL_FILE).is_file() {
        return Err(Error::from_reason(
            "A restored backup is already waiting to be applied; restart Snow App before restoring again"
                .to_string(),
        ));
    }

    let manifest = store.read_manifest(backup_id)?;

    // 上一次恢复可能中途退出：清掉残留的暂存内容再重新组装。
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| {
            Error::from_reason(format!(
                "Failed to clear previous restore workspace '{}': {error}",
                staging.display()
            ))
        })?;
    }
    fs::create_dir_all(&staging).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create restore workspace '{}': {error}",
            staging.display()
        ))
    })?;

    let task = TaskProgress::begin("restore", "apply");
    task.set_totals(manifest.total_bytes, manifest.files.len() as u32);

    if let Err(error) = assemble_files(store, app_dir, &staging, &manifest, &task) {
        // 组装失败时清掉暂存目录；已写回的资源文件保持原样。
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    task.phase("finalize");
    let databases = manifest
        .files
        .iter()
        .filter(|file| is_database(&file.path))
        .map(|file| PendingDatabase {
            name: file.path.clone(),
            size: file.size,
        })
        .collect();
    write_journal(
        &staging,
        &PendingRestore {
            version: JOURNAL_VERSION,
            backup_id: backup_id.to_string(),
            databases,
        },
    )
}

/// 逐文件组装备份内容，任何一块缺失或哈希不符都中止。
fn assemble_files(
    store: &LocalStore,
    app_dir: &Path,
    staging: &Path,
    manifest: &BackupManifest,
    task: &TaskProgress,
) -> Result<()> {
    for file in &manifest.files {
        let target = if is_database(&file.path) {
            staging.join(&file.path)
        } else {
            safe_join(app_dir, &file.path)?
        };
        assemble_file(store, file, &target)?;
        task.advance(file.size, 1);
    }
    Ok(())
}

/// 把单个文件的内容块按顺序写入临时文件，校验通过后再替换目标。
fn assemble_file(store: &LocalStore, file: &ManifestFile, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create restore directory '{}': {error}",
                parent.display()
            ))
        })?;
    }

    let temporary = temporary_path(destination);
    let written = write_assembled(store, file, &temporary).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })?;

    if written != file.size as u64 {
        let _ = fs::remove_file(&temporary);
        return Err(Error::from_reason(format!(
            "Restored file '{}' has {} bytes, expected {}",
            file.path, written, file.size
        )));
    }

    publish_file(&temporary, destination)
}

/// 按块内容重建文件，返回写入的字节数（临时文件由调用方负责清理）。
fn write_assembled(store: &LocalStore, file: &ManifestFile, temporary: &Path) -> Result<u64> {
    let mut output = fs::File::create(temporary).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create restore file '{}': {error}",
            temporary.display()
        ))
    })?;
    let mut written = 0_u64;

    for hash in &file.chunks {
        let bytes = store.get_chunk(hash)?;
        // 块文件名即其内容地址：重算哈希即可发现存储介质损坏，
        // 避免把损坏的数据写回用户目录。
        let actual = blake3::hash(&bytes).to_hex().to_string();
        if actual != *hash {
            return Err(Error::from_reason(format!(
                "Backup chunk '{hash}' is corrupted; restore aborted"
            )));
        }
        output.write_all(&bytes).map_err(|error| {
            Error::from_reason(format!(
                "Failed to write restore file '{}': {error}",
                temporary.display()
            ))
        })?;
        written += bytes.len() as u64;
    }

    Ok(written)
}

/// 用临时文件原子替换目标：先删旧文件再改名（Windows 不允许覆盖已有文件的改名）。
fn publish_file(temporary: &Path, destination: &Path) -> Result<()> {
    if destination.is_file() {
        fs::remove_file(destination).map_err(|error| {
            let _ = fs::remove_file(temporary);
            Error::from_reason(format!(
                "Failed to replace restore file '{}': {error}",
                destination.display()
            ))
        })?;
    }
    fs::rename(temporary, destination).map_err(|error| {
        let _ = fs::remove_file(temporary);
        Error::from_reason(format!(
            "Failed to publish restore file '{}': {error}",
            destination.display()
        ))
    })
}

fn write_journal(staging: &Path, pending: &PendingRestore) -> Result<()> {
    let json = serde_json::to_vec(pending).map_err(|error| {
        Error::from_reason(format!("Failed to serialize restore journal: {error}"))
    })?;
    let temporary = staging.join(format!("{JOURNAL_FILE}.tmp"));
    fs::write(&temporary, json).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::from_reason(format!(
            "Failed to write restore journal '{}': {error}",
            temporary.display()
        ))
    })?;
    fs::rename(&temporary, staging.join(JOURNAL_FILE)).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::from_reason(format!(
            "Failed to publish restore journal in '{}': {error}",
            staging.display()
        ))
    })
}

/// 应用待恢复的数据库。调用方必须保证此刻还没有任何数据库连接打开。
pub(crate) fn apply_pending_restore(app_dir: &Path) -> Result<()> {
    let staging = staging_dir(app_dir);
    let journal_path = staging.join(JOURNAL_FILE);
    if !journal_path.is_file() {
        // 没有待应用的恢复：清掉组装中途退出留下的暂存内容。
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        return Ok(());
    }

    let pending = match fs::read_to_string(&journal_path)
        .ok()
        .and_then(|json| serde_json::from_str::<PendingRestore>(&json).ok())
    {
        Some(pending) if pending.version == JOURNAL_VERSION => pending,
        _ => {
            // 日志不可读时保留现有数据库，丢弃暂存目录，避免每次启动都失败。
            eprintln!(
                "Snow App restore journal '{}' is invalid; discarding the pending restore",
                journal_path.display()
            );
            let _ = fs::remove_dir_all(&staging);
            return Ok(());
        }
    };

    let mut staged: Vec<(String, PathBuf)> = Vec::with_capacity(pending.databases.len());
    for database in &pending.databases {
        let source = staging.join(&database.name);
        let metadata = fs::metadata(&source).map_err(|error| {
            Error::from_reason(format!(
                "Restored database '{}' is missing: {error}",
                source.display()
            ))
        })?;
        if metadata.len() as i64 != database.size {
            return Err(Error::from_reason(format!(
                "Restored database '{}' has {} bytes, expected {}",
                source.display(),
                metadata.len(),
                database.size
            )));
        }
        staged.push((database.name.clone(), source));
    }

    swap_databases(app_dir, &staged)?;
    let _ = fs::remove_dir_all(&staging);
    eprintln!(
        "Snow App applied restored backup '{}' ({} database(s))",
        pending.backup_id,
        staged.len()
    );
    Ok(())
}

/// 把暂存数据库换入 `.snowapp`。
///
/// 旧数据库与它的 WAL/SHM 整体改名保留；任一步失败都回退，保证要么全换、
/// 要么维持原状，不会出现新旧数据库混用。
fn swap_databases(app_dir: &Path, staged: &[(String, PathBuf)]) -> Result<()> {
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S");
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();

    for (name, _) in staged {
        for suffix in ["", "-wal", "-shm"] {
            let current = app_dir.join(format!("{name}{suffix}"));
            if !current.is_file() {
                continue;
            }
            let previous = app_dir.join(format!("{name}{suffix}.pre-restore.{stamp}.bak"));
            if let Err(error) = fs::rename(&current, &previous) {
                revert_moved(&moved);
                return Err(Error::from_reason(format!(
                    "Failed to move current database aside '{}': {error}",
                    current.display()
                )));
            }
            moved.push((current, previous));
        }
    }

    let mut published: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (name, source) in staged {
        let destination = app_dir.join(name);
        if let Err(error) = fs::rename(source, &destination) {
            // 已替换的数据库退回暂存目录，再把旧文件还原。
            for (destination, source) in published.iter().rev() {
                let _ = fs::rename(destination, source);
            }
            revert_moved(&moved);
            return Err(Error::from_reason(format!(
                "Failed to publish restored database '{}': {error}",
                destination.display()
            )));
        }
        published.push((destination, source.clone()));
    }

    Ok(())
}

/// 把改名的旧文件还原回原位（尽力而为，失败时留待用户手工处理）。
fn revert_moved(moved: &[(PathBuf, PathBuf)]) {
    for (current, previous) in moved.iter().rev() {
        let _ = fs::rename(previous, current);
    }
}

fn temporary_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("restore");
    destination.with_file_name(format!("{name}.restore.tmp"))
}

/// 在 root 下安全拼接清单中的相对路径，拒绝绝对路径、`..` 与暂存目录。
fn safe_join(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty() {
        return Err(Error::from_reason("Backup manifest contains an empty path"));
    }
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => {
                if part == std::ffi::OsStr::new(STAGING_DIR_NAME) {
                    return Err(Error::from_reason(format!(
                        "Backup manifest contains a reserved path: {relative}"
                    )));
                }
                path.push(part);
            }
            _ => {
                return Err(Error::from_reason(format!(
                    "Backup manifest contains an unsafe path: {relative}"
                )))
            }
        }
    }
    Ok(path)
}
