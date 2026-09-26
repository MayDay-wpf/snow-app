//! CodeLens 符号索引与文件指纹持久化存储服务（codelens_file_cache 与 codelens_symbol_index 表）。
//!
//! 提供基于文件指纹 (mtime_ms, size) 的项目级增量符号更新，以及通过 B-Tree 索引进行的
//! 毫秒级符号定义与引用倒排查询，彻底避免每次重复遍历全项目文件做 AST 解析。

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;

use super::super::database;

/// 单条符号记录（定义或引用）。
#[derive(Clone, Debug)]
pub struct SymbolRecord {
    pub symbol_name: String,
    pub kind: String,
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub container_name: Option<String>,
    pub is_exported: bool,
}

/// 获取指定项目下所有已索引文件的指纹映射 (file_path -> (mtime_ms, size))。
/// 用于一次性快速比对项目文件变动（增量扫描）。
pub fn get_file_cache_map(
    database_path: &Path,
    project_root: &str,
) -> Result<HashMap<String, (i64, i64)>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut stmt = connection.prepare(
                "SELECT file_path, mtime_ms, size
                 FROM codelens_file_cache
                 WHERE project_root = ?1",
            )?;
            let rows = stmt.query_map([project_root], |row| {
                let file_path: String = row.get(0)?;
                let mtime_ms: i64 = row.get(1)?;
                let size: i64 = row.get(2)?;
                Ok((file_path, (mtime_ms, size)))
            })?;
            let mut map = HashMap::new();
            for item in rows {
                let (path, meta) = item?;
                map.insert(path, meta);
            }
            Ok(map)
        })
        .map_err(|error| database::database_error(database_path, "get codelens file cache map", error))
}

/// 事务性更新单个文件的指纹与符号索引。
pub fn upsert_file_symbols(
    database_path: &Path,
    project_root: &str,
    file_path: &str,
    mtime_ms: i64,
    size: i64,
    symbols: &[SymbolRecord],
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let tx = connection.transaction()?;
            let now_ms = now_unix_ms();

            // 1. 更新文件指纹
            tx.execute(
                "INSERT INTO codelens_file_cache (file_path, project_root, mtime_ms, size, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(file_path) DO UPDATE SET
                   project_root = excluded.project_root,
                   mtime_ms = excluded.mtime_ms,
                   size = excluded.size,
                   updated_at = excluded.updated_at",
                rusqlite::params![file_path, project_root, mtime_ms, size, now_ms],
            )?;

            // 2. 清理旧符号
            tx.execute(
                "DELETE FROM codelens_symbol_index WHERE file_path = ?1",
                [file_path],
            )?;

            // 3. 批量插入新符号
            {
                let mut insert_stmt = tx.prepare(
                    "INSERT INTO codelens_symbol_index (
                       project_root, symbol_name, kind, file_path, line, column, end_line, end_column, container_name, is_exported
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )?;
                for s in symbols {
                    insert_stmt.execute(rusqlite::params![
                        project_root,
                        s.symbol_name,
                        s.kind,
                        s.file_path,
                        s.line,
                        s.column,
                        s.end_line,
                        s.end_column,
                        s.container_name,
                        if s.is_exported { 1 } else { 0 },
                    ])?;
                }
            }

            tx.commit()?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "upsert codelens file symbols", error))
}

/// 删除指定文件的指纹与符号索引（文件被删除时调用）。
pub fn remove_file(database_path: &Path, file_path: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let tx = connection.transaction()?;
            tx.execute(
                "DELETE FROM codelens_file_cache WHERE file_path = ?1",
                [file_path],
            )?;
            tx.execute(
                "DELETE FROM codelens_symbol_index WHERE file_path = ?1",
                [file_path],
            )?;
            tx.commit()?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "remove codelens file", error))
}

/// 根据符号名称和项目根路径，毫秒级查询所有引用位置（走 B-Tree 索引）。
pub fn query_references(
    database_path: &Path,
    project_root: &str,
    symbol_name: &str,
) -> Result<Vec<SymbolRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut stmt = connection.prepare(
                "SELECT symbol_name, kind, file_path, line, column, end_line, end_column, container_name, is_exported
                 FROM codelens_symbol_index
                 WHERE project_root = ?1 AND symbol_name = ?2 AND kind = 'reference'
                 ORDER BY file_path ASC, line ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_root, symbol_name], |row| {
                let is_exported_num: i32 = row.get(8)?;
                Ok(SymbolRecord {
                    symbol_name: row.get(0)?,
                    kind: row.get(1)?,
                    file_path: row.get(2)?,
                    line: row.get(3)?,
                    column: row.get(4)?,
                    end_line: row.get(5)?,
                    end_column: row.get(6)?,
                    container_name: row.get(7)?,
                    is_exported: is_exported_num != 0,
                })
            })?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
        .map_err(|error| database::database_error(database_path, "query codelens references", error))
}

/// 根据符号名称和项目根路径，毫秒级查询符号定义位置（走 B-Tree 索引）。
pub fn query_definitions(
    database_path: &Path,
    project_root: &str,
    symbol_name: &str,
) -> Result<Vec<SymbolRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut stmt = connection.prepare(
                "SELECT symbol_name, kind, file_path, line, column, end_line, end_column, container_name, is_exported
                 FROM codelens_symbol_index
                 WHERE project_root = ?1 AND symbol_name = ?2 AND kind = 'definition'
                 ORDER BY file_path ASC, line ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_root, symbol_name], |row| {
                let is_exported_num: i32 = row.get(8)?;
                Ok(SymbolRecord {
                    symbol_name: row.get(0)?,
                    kind: row.get(1)?,
                    file_path: row.get(2)?,
                    line: row.get(3)?,
                    column: row.get(4)?,
                    end_line: row.get(5)?,
                    end_column: row.get(6)?,
                    container_name: row.get(7)?,
                    is_exported: is_exported_num != 0,
                })
            })?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
        .map_err(|error| database::database_error(database_path, "query codelens definitions", error))
}

/// 清空指定项目的 CodeLens 符号索引与缓存。
pub fn clear_project_cache(database_path: &Path, project_root: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let tx = connection.transaction()?;
            tx.execute(
                "DELETE FROM codelens_file_cache WHERE project_root = ?1",
                [project_root],
            )?;
            tx.execute(
                "DELETE FROM codelens_symbol_index WHERE project_root = ?1",
                [project_root],
            )?;
            tx.commit()?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "clear codelens project cache", error))
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
