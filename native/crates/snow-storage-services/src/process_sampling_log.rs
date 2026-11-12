//! 进程采样日志落盘：追加 JSONL，单文件超过上限时轮转，保留最近 N 个文件。
//!
//! 全部为同步文件系统调用，调用方必须置于 `spawn_blocking` 中执行。
//! 路径全部由 `Path` 拼接，三平台（Windows / macOS / Linux）行为一致。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use napi::bindgen_prelude::*;

const ACTIVE_FILE_NAME: &str = "process-sampling.jsonl";
/// 文件总数上限（含当前文件）的硬上限，同时限定归档清理的扫描范围。
const MAX_FILES_LIMIT: u32 = 64;

/// 串行化所有追加与轮转，避免并发调用时归档互相覆盖。
static APPEND_LOCK: Mutex<()> = Mutex::new(());

fn archive_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(format!("process-sampling.{index}.jsonl"))
}

/// 追加一行（调用方保证 `line` 不含换行）。写入前若当前文件加上新行会超过
/// `max_bytes`，先轮转。`max_files` 为文件总数上限（含当前文件）。
pub fn append_sampling_line(
    dir: &Path,
    line: &str,
    max_bytes: u64,
    max_files: u32,
) -> Result<()> {
    let _guard = APPEND_LOCK
        .lock()
        .map_err(|_| Error::from_reason("Process sampling log lock poisoned"))?;
    fs::create_dir_all(dir).map_err(|error| {
        Error::from_reason(format!("Failed to create sampling log directory: {error}"))
    })?;

    let active = dir.join(ACTIVE_FILE_NAME);
    let incoming = line.len() as u64 + 1;
    let current = fs::metadata(&active).map(|meta| meta.len()).unwrap_or(0);
    if current > 0 && current.saturating_add(incoming) > max_bytes {
        rotate(dir, &active, max_files.clamp(1, MAX_FILES_LIMIT));
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&active)
        .map_err(|error| {
            Error::from_reason(format!("Failed to open sampling log file: {error}"))
        })?;
    let mut payload = String::with_capacity(line.len() + 1);
    payload.push_str(line);
    payload.push('\n');
    file.write_all(payload.as_bytes()).map_err(|error| {
        Error::from_reason(format!("Failed to write sampling log file: {error}"))
    })
}

/// 轮转：丢弃最旧归档，归档依次后移，当前文件成为 `.1`。
/// 任一步移动失败时保留原文件继续追加：宁可略超上限也不丢失记录。
fn rotate(dir: &Path, active: &Path, max_files: u32) {
    let archive_slots = max_files - 1;
    if archive_slots == 0 {
        let _ = fs::remove_file(active);
        return;
    }
    // 清理最旧槽位及配置调小后遗留的多余归档。
    for index in archive_slots..=MAX_FILES_LIMIT {
        let _ = fs::remove_file(archive_path(dir, index));
    }
    for index in (1..archive_slots).rev() {
        let _ = fs::rename(archive_path(dir, index), archive_path(dir, index + 1));
    }
    let _ = fs::rename(active, archive_path(dir, 1));
}
