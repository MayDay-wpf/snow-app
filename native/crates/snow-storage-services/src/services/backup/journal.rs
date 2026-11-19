//! 备份 / 删除任务的持久化日志。
//!
//! 任务开始时写入 `.snowapp/.backup-task.json`，成功后删除。应用中途退出或
//! 任务失败时日志保留，用户可以选择继续或放弃：
//!
//! - 备份续跑沿用同一个备份 id 重新执行。数据库快照重新生成（保证与资源文件
//!   处于同一时刻），已写入目标的块按内容寻址直接命中、不再重复上传，因此
//!   续跑只补传上次没写完的部分。
//! - 删除的每一步（删清单、清指针、回收孤儿块）都是幂等的，重新执行即可。
//!
//! 日志存在期间不允许开始新的备份或删除，块回收因此不会误删续跑所需、
//! 尚未被任何清单引用的块。

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use super::BackupTarget;

/// 日志文件名（位于 `.snowapp` 根目录，备份扫描时跳过）。
pub(crate) const JOURNAL_FILE_NAME: &str = ".backup-task.json";
/// 写入日志时使用的临时文件名（同样不进入备份）。
pub(crate) const JOURNAL_TEMP_FILE_NAME: &str = ".backup-task.json.tmp";
const JOURNAL_VERSION: u32 = 1;

pub(crate) const KIND_CREATE: &str = "create";
pub(crate) const KIND_DELETE: &str = "delete";

/// 一个尚未完成的备份或删除任务。
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct TaskJournal {
    version: u32,
    /// create（备份）| delete（删除备份）。
    pub(crate) kind: String,
    target_kind: String,
    target_dir: Option<String>,
    /// 备份：正在生成的备份 id；删除：正在删除的备份 id。
    pub(crate) backup_id: String,
    /// 备份的保留份数（删除任务为空）。
    pub(crate) keep: Option<u32>,
    pub(crate) started_at_ms: i64,
}

impl TaskJournal {
    pub(crate) fn create(target: &BackupTarget, backup_id: String, keep: u32) -> Self {
        Self::new(KIND_CREATE, target, backup_id, Some(keep))
    }

    pub(crate) fn delete(target: &BackupTarget, backup_id: String) -> Self {
        Self::new(KIND_DELETE, target, backup_id, None)
    }

    fn new(kind: &str, target: &BackupTarget, backup_id: String, keep: Option<u32>) -> Self {
        Self {
            version: JOURNAL_VERSION,
            kind: kind.to_string(),
            target_kind: target.kind.clone(),
            target_dir: target.dir.clone(),
            backup_id,
            keep,
            started_at_ms: chrono::Local::now().timestamp_millis(),
        }
    }

    /// 任务开始时使用的备份目标（续跑必须回到同一个目标）。
    pub(crate) fn target(&self) -> BackupTarget {
        BackupTarget {
            kind: self.target_kind.clone(),
            dir: self.target_dir.clone(),
        }
    }

    pub(crate) fn target_kind(&self) -> String {
        self.target_kind.clone()
    }

    pub(crate) fn target_dir(&self) -> Option<String> {
        self.target_dir.clone()
    }
}

fn journal_path() -> Result<PathBuf> {
    Ok(crate::storage::paths::app_storage_dir()?.join(JOURNAL_FILE_NAME))
}

/// 读取未完成的任务；日志损坏或版本不符时丢弃，避免一直卡在同一份坏日志上。
pub(crate) fn load() -> Result<Option<TaskJournal>> {
    let path = journal_path()?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(Error::from_reason(format!(
                "Failed to read backup task journal '{}': {error}",
                path.display()
            )))
        }
    };
    match serde_json::from_slice::<TaskJournal>(&bytes) {
        Ok(journal)
            if journal.version == JOURNAL_VERSION
                && (journal.kind == KIND_CREATE || journal.kind == KIND_DELETE) =>
        {
            Ok(Some(journal))
        }
        _ => {
            eprintln!(
                "Snow App backup task journal '{}' is invalid; discarding it",
                path.display()
            );
            let _ = fs::remove_file(&path);
            Ok(None)
        }
    }
}

/// 写入日志：先写临时文件再改名，退出时不会留下写了一半的日志。
pub(crate) fn save(journal: &TaskJournal) -> Result<()> {
    let path = journal_path()?;
    let json = serde_json::to_vec(journal).map_err(|error| {
        Error::from_reason(format!("Failed to serialize backup task journal: {error}"))
    })?;
    let temporary = path.with_file_name(JOURNAL_TEMP_FILE_NAME);
    fs::write(&temporary, json).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::from_reason(format!(
            "Failed to write backup task journal '{}': {error}",
            temporary.display()
        ))
    })?;
    fs::rename(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::from_reason(format!(
            "Failed to publish backup task journal '{}': {error}",
            path.display()
        ))
    })
}

/// 任务完成或被放弃后删除日志。
pub(crate) fn clear() -> Result<()> {
    let path = journal_path()?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Error::from_reason(format!(
            "Failed to remove backup task journal '{}': {error}",
            path.display()
        ))),
    }
}

/// 存在未完成的任务时拒绝开始新任务。
pub(crate) fn ensure_none() -> Result<()> {
    if load()?.is_some() {
        return Err(Error::from_reason(
            "An interrupted backup task is pending; resume or discard it first",
        ));
    }
    Ok(())
}
