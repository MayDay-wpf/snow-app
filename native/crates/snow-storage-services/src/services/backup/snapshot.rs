use std::fs;
use std::path::Path;
use std::time::Duration;

use napi::bindgen_prelude::*;

use super::manifest::ReuseIndex;
use super::source::{modified_ms, SourceFile};

/// 生成两个数据库的一致性副本。
///
/// 运行库用 SQLite Online Backup API 复制：它按页号对齐搬运页面，未改动的页
/// 落在相同的块边界上，下一次备份的内容寻址就去重命中；`VACUUM INTO` 虽然
/// 体积更小，但会重排页序，反而让几乎每个块都变成"新内容"。
///
/// 归档库是冷数据：大小与修改时间都与上一份备份一致时直接复用其块列表，
/// 连读取都省掉。
pub(crate) fn snapshot_databases(
    app_dir: &Path,
    work_dir: &Path,
    reuse: &ReuseIndex,
) -> Result<Vec<SourceFile>> {
    let mut sources = Vec::new();

    let runtime = app_dir.join("snowapp.db");
    if runtime.is_file() {
        sources.push(copy_database(&runtime, work_dir, "snowapp.db")?);
    }

    let archive = app_dir.join("archive.db");
    if archive.is_file() {
        let mut source = SourceFile::from_path(&archive, "archive.db".to_string())?;
        source.reuse_chunks =
            reuse.lookup(&source.relative_path, source.size, source.modified_ms);
        if source.reuse_chunks.is_some() {
            sources.push(source);
        } else {
            sources.push(copy_database(&archive, work_dir, "archive.db")?);
        }
    }

    Ok(sources)
}

/// 用 Online Backup API 把数据库复制到工作区，返回指向副本的源文件条目。
fn copy_database(database: &Path, work_dir: &Path, name: &str) -> Result<SourceFile> {
    let destination_path = work_dir.join(name);
    if destination_path.exists() {
        fs::remove_file(&destination_path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to clear previous backup snapshot '{}': {error}",
                destination_path.display()
            ))
        })?;
    }

    let source = crate::storage::database::open_connection(database).map_err(|error| {
        Error::from_reason(format!(
            "Failed to open database '{}' for backup: {error}",
            database.display()
        ))
    })?;
    let mut destination = rusqlite::Connection::open(&destination_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create backup snapshot '{}': {error}",
            destination_path.display()
        ))
    })?;

    {
        let backup = rusqlite::backup::Backup::new(&source, &mut destination).map_err(|error| {
            Error::from_reason(format!(
                "Failed to start backup of '{}': {error}",
                database.display()
            ))
        })?;
        backup
            .run_to_completion(512, Duration::ZERO, None)
            .map_err(|error| {
                Error::from_reason(format!(
                    "Failed to snapshot database '{}': {error}",
                    database.display()
                ))
            })?;
    }
    drop(destination);

    let metadata = fs::metadata(&destination_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to inspect backup snapshot '{}': {error}",
            destination_path.display()
        ))
    })?;

    Ok(SourceFile {
        source_path: destination_path,
        relative_path: name.to_string(),
        size: metadata.len() as i64,
        modified_ms: modified_ms(&metadata),
        // 快照文件的修改时间代表"备份时刻"，与内容是否变化无关，
        // 因此它永远不参与 mtime 复用；跨备份去重交给块内容哈希完成。
        reuse_chunks: None,
    })
}
