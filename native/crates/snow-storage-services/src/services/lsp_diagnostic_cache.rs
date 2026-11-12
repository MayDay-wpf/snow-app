//! LSP 诊断缓存表（`lsp_diagnostic_cache`）的历史数据清理。
//!
//! 诊断结果不再读写持久缓存；保留的前缀删除入口只用于清除旧版本写入的行
//! （如项目级缓存清理 / 重启刷新），失败向调用方暴露。

use std::path::Path;

use napi::bindgen_prelude::*;

use super::super::database;

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
