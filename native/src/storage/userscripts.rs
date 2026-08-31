use std::{
    fs,
    path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::database;
use super::models::{UserscriptMeta, UserscriptRecord, UserscriptValue};
use crate::i18n::AppLocale;

/// 用户脚本文件存放目录（`~/.snowapp/browser-script/`），跨平台一致。
const BROWSER_SCRIPT_DIR_NAME: &str = "browser-script";

/// 用户脚本文件存放目录的绝对路径（`~/.snowapp/browser-script/`）。
pub fn browser_script_dir() -> Result<PathBuf> {
    Ok(super::paths::app_storage_dir()?.join(BROWSER_SCRIPT_DIR_NAME))
}

/// 根据 script_id 推导脚本文件路径（`~/.snowapp/browser-script/{script_id}.user.js`）。
fn script_file_path(script_id: &str) -> Result<PathBuf> {
    Ok(browser_script_dir()?.join(format!("{script_id}.user.js")))
}

// ===== 元数据解析 =====

/// 从原始内容中提取 `// ==UserScript==` 元数据头。
pub fn parse_meta(raw: &str) -> UserscriptMeta {
    let mut name = String::new();
    // 本地化名称变体（`@name:zh-CN` / `@name:zh` / `@name:en` 等），按 (locale, 名称) 收集。
    let mut localized_names: Vec<(String, String)> = Vec::new();
    let mut version = String::from("1.0");
    let mut description = String::new();
    let mut namespace = String::new();
    let mut author = String::new();
    let mut run_at = String::from("document-idle");
    let mut noframes = true;
    let mut grant = Vec::new();
    let mut matches = Vec::new();
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    let mut requires = Vec::new();

    // 找到元数据块
    let start = raw.find("// ==UserScript==");
    let end = raw.find("// ==/UserScript==");
    let block = start.and_then(|s| end.and_then(|e| {
        if e > s { Some(&raw[s..e]) } else { None }
    }));

    if let Some(block) = block {
        for line in block.lines() {
            let line = line.trim();
            if !line.starts_with("// @") {
                continue;
            }
            // 去掉 "// @" 四个字符，得到 "@key value" 中 key 与 value 部分
            let content = &line[4..].trim();
            let colon = content.find([' ', '\t']);
            let (key, value) = if let Some(pos) = colon {
                let k = content[..pos].trim().to_lowercase();
                let v = content[pos + 1..].trim().to_string();
                (k, v)
            } else {
                (content.trim().to_lowercase(), String::new())
            };

            match key.as_str() {
                "name" => name = value,
                // 本地化名称（`@name:zh` / `@name:en` / `@name:zh-TW` 等）：key 已转小写。
                _ if key.starts_with("name:") => {
                    let locale = key["name:".len()..].to_string();
                    if !locale.is_empty() && !value.is_empty() {
                        localized_names.push((locale, value));
                    }
                }
                "version" => version = value,
                "description" => description = value,
                "namespace" => namespace = value,
                "author" => author = value,
                "run-at" | "run_at" => {
                    let v = value.to_lowercase();
                    if matches!(v.as_str(), "document-start" | "document-end" | "document-idle") {
                        run_at = v;
                    }
                }
                "noframes" => {
                    noframes = value.is_empty() || value == "true" || value == "1";
                }
                "grant" => {
                    if !value.is_empty() {
                        grant.push(value);
                    }
                }
                "match" => {
                    if !value.is_empty() {
                        matches.push(value);
                    }
                }
                "include" => {
                    if !value.is_empty() {
                        includes.push(value);
                    }
                }
                "exclude" | "exclude-match" => {
                    if !value.is_empty() {
                        excludes.push(value);
                    }
                }
                "require" => {
                    if !value.is_empty() {
                        requires.push(value);
                    }
                }
                _ => {}
            }
        }
    }

    // 裸 @name 优先；缺失时按当前应用语言环境从本地化变体中选择，兜底取第一个可用值。
    if name.is_empty() && !localized_names.is_empty() {
        name = pick_localized_name(&localized_names, crate::i18n::app_locale_blocking());
    }

    UserscriptMeta {
        name,
        version,
        description,
        namespace,
        author,
        run_at,
        noframes,
        grant,
        matches,
        includes,
        excludes,
        requires,
    }
}

/// 根据应用语言环境选择本地化名称：
/// 精确标签（如 `zh-cn` / `zh-hans`）→ 主语言标签（如 `zh`）→ 首个可用变体。
fn pick_localized_name(localized: &[(String, String)], locale: AppLocale) -> String {
    if localized.is_empty() {
        return String::new();
    }
    let normalize = |tag: &str| tag.to_ascii_lowercase().replace('_', "-");
    // 与 i18n::normalize_locale 对齐的候选精确标签。
    let exact_tags: &[&str] = match locale {
        AppLocale::En => &["en"],
        AppLocale::ZhCn => &["zh-cn", "zh-hans", "zh-sg"],
        AppLocale::ZhTw => &["zh-tw", "zh-hant", "zh-hk", "zh-mo"],
    };
    let primary = match locale {
        AppLocale::En => "en",
        AppLocale::ZhCn | AppLocale::ZhTw => "zh",
    };

    for (tag, value) in localized {
        let normalized = normalize(tag);
        if exact_tags.iter().any(|candidate| normalized == *candidate) {
            return value.clone();
        }
    }
    for (tag, value) in localized {
        let normalized = normalize(tag);
        if normalized == primary || normalized.split('-').next() == Some(primary) {
            return value.clone();
        }
    }
    localized.first().map(|(_, value)| value.clone()).unwrap_or_default()
}

// ===== 数据库操作 =====

pub fn list_userscripts(database_path: &Path) -> Result<Vec<UserscriptRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_userscripts(&connection))
        .map_err(|error| database::database_error(database_path, "list userscripts", error))
}

/// 创建用户脚本：解析元数据 → 写文件 → 插入 DB（元数据 + file_path）。
pub fn create_userscript(database_path: &Path, raw: &str) -> Result<UserscriptRecord> {
    let meta = parse_meta(raw);
    let script_id = Uuid::new_v4().to_string();

    // 确保目录存在并写出文件
    let file_path = script_file_path(&script_id)?;
    fs::create_dir_all(file_path.parent().unwrap())
        .map_err(|e| Error::from_reason(format!("Failed to create browser-script dir: {e}")))?;
    fs::write(&file_path, raw)
        .map_err(|e| Error::from_reason(format!("Failed to write userscript file: {e}")))?;

    let file_path_str = file_path.to_string_lossy().to_string();
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "create userscript", error))?;
    connection
        .execute(
            "INSERT INTO userscripts (
                script_id, name, version, description, namespace, author,
                enabled, run_at, noframes, grant_json, matches_json,
                includes_json, excludes_json, requires_json, file_path
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                1, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14
            )",
            params![
                script_id,
                meta.name,
                meta.version,
                meta.description,
                meta.namespace,
                meta.author,
                meta.run_at,
                meta.noframes,
                serde_json::to_string(&meta.grant).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.matches).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.includes).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.excludes).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.requires).unwrap_or_else(|_| "[]".to_string()),
                file_path_str,
            ],
        )
        .map_err(|error| database::database_error(database_path, "create userscript", error))?;

    let created = query_userscript(database_path, &script_id)?;
    created.ok_or_else(|| Error::from_reason("Failed to read back created userscript"))
}

/// 更新用户脚本：解析元数据 → 覆写文件 → 更新 DB 元数据。
pub fn update_userscript(database_path: &Path, script_id: &str, raw: &str) -> Result<UserscriptRecord> {
    let meta = parse_meta(raw);

    // 从 DB 查出 file_path 并覆写文件
    let (file_path_str,) = {
        let connection = database::open_connection(database_path)
            .map_err(|error| database::database_error(database_path, "update userscript", error))?;
        connection.query_row(
            "SELECT file_path FROM userscripts WHERE script_id = ?1",
            [script_id],
            |row| Ok((row.get::<_, String>(0)?,)),
        )
        .map_err(|error| database::database_error(database_path, "update userscript", error))?
    };
    let file_path = Path::new(&file_path_str);
    fs::write(file_path, raw)
        .map_err(|e| Error::from_reason(format!("Failed to write userscript file: {e}")))?;

    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "update userscript", error))?;
    let changed = connection
        .execute(
            "UPDATE userscripts SET
                name = ?2, version = ?3, description = ?4,
                namespace = ?5, author = ?6,
                run_at = ?7, noframes = ?8,
                grant_json = ?9, matches_json = ?10,
                includes_json = ?11, excludes_json = ?12,
                requires_json = ?13,
                updated_at = datetime('now', 'localtime')
            WHERE script_id = ?1",
            params![
                script_id,
                meta.name,
                meta.version,
                meta.description,
                meta.namespace,
                meta.author,
                meta.run_at,
                meta.noframes,
                serde_json::to_string(&meta.grant).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.matches).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.includes).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.excludes).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&meta.requires).unwrap_or_else(|_| "[]".to_string()),
            ],
        )
        .map_err(|error| database::database_error(database_path, "update userscript", error))?;
    if changed == 0 {
        return Err(database::database_error(
            database_path,
            "update userscript",
            rusqlite::Error::QueryReturnedNoRows,
        ));
    }

    let updated = query_userscript(database_path, script_id)?;
    updated.ok_or_else(|| Error::from_reason("Failed to read back updated userscript"))
}

/// 删除用户脚本：删除 DB 行 + 删除文件（最佳努力）。
pub fn delete_userscript(database_path: &Path, script_id: &str) -> Result<()> {
    let file_path = {
        let connection = database::open_connection(database_path)
            .map_err(|error| database::database_error(database_path, "delete userscript", error))?;
        connection
            .query_row(
                "SELECT file_path FROM userscripts WHERE script_id = ?1",
                [script_id],
                |row| row.get::<_, String>(0),
            )
            .ok()
    };

    database::open_connection(database_path)
        .and_then(|connection| {
            let changed = connection.execute(
                "DELETE FROM userscripts WHERE script_id = ?1",
                [script_id],
            )?;
            if changed == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete userscript", error))?;

    // 最佳努力删除文件
    if let Some(path) = file_path {
        let _ = fs::remove_file(Path::new(&path));
    }
    Ok(())
}

pub fn set_userscript_enabled(database_path: &Path, script_id: &str, enabled: bool) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let changed = connection.execute(
                "UPDATE userscripts SET enabled = ?2, updated_at = datetime('now', 'localtime')
                WHERE script_id = ?1",
                params![script_id, enabled],
            )?;
            if changed == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "set userscript enabled", error))
}

/// 从 DB 查出 file_path 并读取脚本文件完整内容。
pub fn read_userscript_source(database_path: &Path, script_id: &str) -> Result<String> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "read userscript source", error))?;
    let file_path: String = connection
        .query_row(
            "SELECT file_path FROM userscripts WHERE script_id = ?1",
            [script_id],
            |row| row.get(0),
        )
        .map_err(|error| {
            database::database_error(database_path, "read userscript source (query)", error)
        })?;

    fs::read_to_string(Path::new(&file_path))
        .map_err(|e| Error::from_reason(format!("Failed to read userscript file: {e}")))
}

// ===== GM 值操作 =====

pub fn get_userscript_values(database_path: &Path, script_id: &str) -> Result<Vec<UserscriptValue>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT key, value FROM userscript_values WHERE script_id = ?1 ORDER BY key"
            )?;
            let rows = statement.query_map([script_id], |row| {
                Ok(UserscriptValue {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
        .map_err(|error| database::database_error(database_path, "get userscript values", error))
}

pub fn set_userscript_value(database_path: &Path, script_id: &str, key: &str, value: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO userscript_values (script_id, key, value, updated_at)
                VALUES (?1, ?2, ?3, datetime('now', 'localtime'))
                ON CONFLICT(script_id, key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = datetime('now', 'localtime')",
                params![script_id, key, value],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "set userscript value", error))
}

pub fn delete_userscript_value(database_path: &Path, script_id: &str, key: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM userscript_values WHERE script_id = ?1 AND key = ?2",
                params![script_id, key],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete userscript value", error))
}

// ===== 内部查询 =====

fn query_userscripts(connection: &Connection) -> rusqlite::Result<Vec<UserscriptRecord>> {
    let mut statement = connection.prepare(
        "SELECT script_id FROM userscripts ORDER BY updated_at DESC, script_id ASC"
    )?;
    let script_ids: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut records = Vec::new();
    for id in script_ids {
        if let Some(record) = query_userscript_record(connection, &id)? {
            records.push(record);
        }
    }
    Ok(records)
}

fn query_userscript(database_path: &Path, script_id: &str) -> Result<Option<UserscriptRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_userscript_record(&connection, script_id))
        .map_err(|error| database::database_error(database_path, "query userscript", error))
}

fn query_userscript_record(connection: &Connection, script_id: &str) -> rusqlite::Result<Option<UserscriptRecord>> {
    let row = connection.query_row(
        "SELECT script_id, name, version, description, namespace, author,
                enabled, run_at, noframes, grant_json, matches_json,
                includes_json, excludes_json, requires_json, file_path,
                created_at, updated_at
        FROM userscripts WHERE script_id = ?1",
        [script_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, bool>(6)?, row.get::<_, String>(7)?,
                row.get::<_, bool>(8)?, row.get::<_, String>(9)?,
                row.get::<_, String>(10)?, row.get::<_, String>(11)?,
                row.get::<_, String>(12)?, row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
                row.get::<_, String>(15)?, row.get::<_, String>(16)?,
            ))
        },
    ).optional()?;

    let Some((script_id, name, version, description, namespace, author,
              enabled, run_at, noframes, grant_json, matches_json,
              includes_json, excludes_json, requires_json, file_path,
              created_at, updated_at)) = row else {
        return Ok(None);
    };

    Ok(Some(UserscriptRecord {
        script_id,
        name,
        version,
        description,
        namespace,
        author,
        enabled,
        run_at,
        noframes,
        grant: serde_json::from_str(&grant_json).unwrap_or_default(),
        matches: serde_json::from_str(&matches_json).unwrap_or_default(),
        includes: serde_json::from_str(&includes_json).unwrap_or_default(),
        excludes: serde_json::from_str(&excludes_json).unwrap_or_default(),
        requires: serde_json::from_str(&requires_json).unwrap_or_default(),
        file_path,
        created_at,
        updated_at,
    }))
}