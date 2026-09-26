//! LSP 诊断结果持久化缓存（lsp_diagnostic_cache 表）。
//!
//! 指纹 = (mtime_ms, size)：一致则缓存命中，直接返回上次诊断结果，
//! 跳过语言服务器协议往返（含冷启动）。应用重启 / 会话 LRU 淘汰后缓存仍有效。
//!
//! 语义保证：缓存只是加速层——所有读写失败均向调用方暴露错误，
//! 由 session 层降级为完整诊断流程（正确性不依赖缓存）。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::Connection;

use super::super::database;

/// 缓存条目上限（LRU 清理：upsert 后删除最旧超限行）。
pub const MAX_CACHE_ENTRIES: i64 = 200;

/// 单条缓存记录（指纹 + 结果 JSON）。
pub struct CachedDiagnosticEntry {
    pub mtime_ms: i64,
    pub size: i64,
    pub result_json: String,
}

/// 读取缓存条目；未命中返回 `None`。
pub fn get(database_path: &Path, file_path: &str) -> Result<Option<CachedDiagnosticEntry>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT mtime_ms, size, result_json
                 FROM lsp_diagnostic_cache
                 WHERE file_path = ?1",
            )?;
            let mut rows = statement.query_map([file_path], |row| {
                Ok(CachedDiagnosticEntry {
                    mtime_ms: row.get(0)?,
                    size: row.get(1)?,
                    result_json: row.get(2)?,
                })
            })?;
            match rows.next() {
                Some(Ok(entry)) => Ok(Some(entry)),
                Some(Err(error)) => Err(error),
                None => Ok(None),
            }
        })
        .map_err(|error| database::database_error(database_path, "get LSP diagnostic cache", error))
}

/// 写入缓存条目（INSERT OR REPLACE），随后清理超限行（保留最近 MAX_CACHE_ENTRIES）。
pub fn upsert(
    database_path: &Path,
    file_path: &str,
    mtime_ms: i64,
    size: i64,
    result_json: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            upsert_with_connection(&connection, file_path, mtime_ms, size, result_json)
        })
        .map_err(|error| {
            database::database_error(database_path, "upsert LSP diagnostic cache", error)
        })
}

fn upsert_with_connection(
    connection: &Connection,
    file_path: &str,
    mtime_ms: i64,
    size: i64,
    result_json: &str,
) -> rusqlite::Result<()> {
    let now_ms = now_unix_ms();
    connection.execute(
        "INSERT INTO lsp_diagnostic_cache (file_path, mtime_ms, size, result_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(file_path) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           size = excluded.size,
           result_json = excluded.result_json,
           updated_at = excluded.updated_at",
        rusqlite::params![file_path, mtime_ms, size, result_json, now_ms],
    )?;
    // LRU 清理：删除超出上限的最旧行（保留最近 MAX_CACHE_ENTRIES 条）。
    connection.execute(
        "DELETE FROM lsp_diagnostic_cache
         WHERE file_path IN (
           SELECT file_path FROM lsp_diagnostic_cache
           ORDER BY updated_at DESC
           LIMIT -1 OFFSET ?1
         )",
        [MAX_CACHE_ENTRIES],
    )?;
    Ok(())
}

/// 删除缓存条目（文件被外部写盘后失效，如 format/rename 落盘）。
pub fn remove(database_path: &Path, file_path: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM lsp_diagnostic_cache WHERE file_path = ?1",
                [file_path],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "delete LSP diagnostic cache", error)
        })
}

/// 按文件路径前缀批量删除缓存条目（如项目级缓存清理 / 重启刷新）。
pub fn remove_by_prefix(database_path: &Path, path_prefix: &str) -> Result<usize> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let pattern = format!("{path_prefix}%");
            let count = connection.execute(
                "DELETE FROM lsp_diagnostic_cache WHERE file_path LIKE ?1",
                rusqlite::params![pattern],
            )?;
            Ok(count)
        })
        .map_err(|error| {
            database::database_error(database_path, "delete LSP diagnostic cache by prefix", error)
        })
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
