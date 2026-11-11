use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use super::super::database;
use super::super::{WorkspaceRelinkRecord, WorkspaceRelinkReport};
use super::workspace_directory_health::{
    fs_identity, KIND_SSH, STATE_MISSING, STATE_OK, STATE_REMOTE,
};

const KEYED_COLUMNS: &[(&str, &str)] = &[
    ("collection_members", "directory_id"),
    ("chat_conversations", "directory_id"),
    ("workflow_runs", "directory_id"),
    ("usage_records", "directory_id"),
    ("memos", "directory_id"),
    ("scheduled_tasks", "directory_id"),
    ("project_memories", "directory_id"),
    ("memory_prompt_snapshots", "directory_id"),
    ("system_prompt_snapshots", "directory_id"),
    ("sub_agent_configs", "project_id"),
    ("system_prompts", "project_id"),
];

const HASHED_SETTING_KEY_PREFIXES: &[&str] = &[
    "project_mcp_scope_",
    "project_skills_scope_",
    "project_codebase_scope_",
    "project_tool_approval_scope_",
    "hooks_project_",
    "project_mcp_server_configs_",
    "project_sensitive_command_scope_",
];

const PLAIN_SETTING_KEY_PREFIXES: &[&str] = &["project_lsp_server_configs_"];

const BUILTIN_SOURCE: &str = "builtin";
const LOCAL_KIND: &str = "local";
const ARCHIVE_TABLES: &[&str] = &["chat_conversations", "workflow_runs"];

// 带唯一约束的路径列：改写时用 OR REPLACE，冲突行直接替换（缓存/遗留 id 可重建）。
const UNIQUE_PATH_PREFIX_COLUMNS: &[(&str, &str)] = &[
    ("lsp_diagnostic_cache", "file_path"),
    ("system_prompts", "prompt_id"),
];

const CHECKPOINT_MANIFEST_FILE: &str = "manifest.json";

// 由迁移逻辑单独处理的表：目录注册表自身与项目向量表配套的嵌入会话表。
const SELF_MANAGED_PROJECT_TABLES: &[&str] = &[
    "workspace_directories",
    "codebase_embed_sessions",
    // Composite run/task identities are migrated together, with deferred FK
    // validation at commit; the generic project-column loop must not move them.
    "sub_agent_runs",
    "sub_agent_parent_tasks",
    "sub_agent_run_requests",
];

struct MoveCounts {
    conversations: i32,
    memories: i32,
    memos: i32,
    scheduled_tasks: i32,
    collections_touched: i32,
    settings_keys_moved: i32,
    paths_rewritten: i32,
    codebase_reindex_required: bool,
}

struct DirectoryRow {
    directory_id: String,
    path: String,
    name: String,
    kind: String,
    source: String,
    is_active: bool,
    sort_order: i32,
}

fn hashed_setting_code(prefix: &str, directory_id: &str) -> String {
    format!("{prefix}{}", blake3::hash(directory_id.as_bytes()).to_hex())
}

fn table_exists(connection: &Connection, table: &str) -> rusqlite::Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
}

fn count_rows(
    connection: &Connection,
    table: &str,
    column: &str,
    value: &str,
) -> rusqlite::Result<i32> {
    connection.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
        [value],
        |row| row.get(0),
    )
}

fn rewrite_project_id_json(value: &str, from_id: &str, to_id: &str) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(value) else {
        return value.to_string();
    };

    if !rewrite_project_id_value(&mut parsed, from_id, to_id) {
        return value.to_string();
    }

    serde_json::to_string(&parsed).unwrap_or_else(|_| value.to_string())
}

fn rewrite_project_id_value(value: &mut Value, from_id: &str, to_id: &str) -> bool {
    match value {
        Value::Object(map) => {
            let mut changed = false;
            for key in ["projectId", "project_id", "directoryId", "directory_id"] {
                if let Some(Value::String(current)) = map.get_mut(key) {
                    if current == from_id {
                        *current = to_id.to_string();
                        changed = true;
                    }
                }
            }
            for child in map.values_mut() {
                if rewrite_project_id_value(child, from_id, to_id) {
                    changed = true;
                }
            }
            changed
        }
        Value::Array(items) => {
            let mut changed = false;
            for item in items.iter_mut() {
                if rewrite_project_id_value(item, from_id, to_id) {
                    changed = true;
                }
            }
            changed
        }
        _ => false,
    }
}

fn move_setting_key(
    connection: &Connection,
    old_code: &str,
    new_code: &str,
    from_id: &str,
    to_id: &str,
) -> rusqlite::Result<bool> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
            [old_code],
            |row| row.get(0),
        )
        .optional()?;

    let Some(value) = existing else {
        return Ok(false);
    };

    let occupied: Option<String> = connection
        .query_row(
            "SELECT setting_code FROM system_settings WHERE setting_code = ?1",
            [new_code],
            |row| row.get(0),
        )
        .optional()?;

    if occupied.is_some() {
        connection.execute(
            "DELETE FROM system_settings WHERE setting_code = ?1",
            [old_code],
        )?;
        return Ok(false);
    }

    let rewritten = rewrite_project_id_json(&value, from_id, to_id);
    connection.execute(
        "UPDATE system_settings
            SET setting_code = ?1,
                setting_value = ?2,
                updated_at = datetime('now', 'localtime')
          WHERE setting_code = ?3",
        params![new_code, rewritten, old_code],
    )?;

    Ok(true)
}

fn move_setting_keys(connection: &Connection, from_id: &str, to_id: &str) -> rusqlite::Result<i32> {
    let mut moved = 0;

    for prefix in PLAIN_SETTING_KEY_PREFIXES {
        let old_code = format!("{prefix}{from_id}");
        let new_code = format!("{prefix}{to_id}");
        if move_setting_key(connection, &old_code, &new_code, from_id, to_id)? {
            moved += 1;
        }
    }

    for prefix in HASHED_SETTING_KEY_PREFIXES {
        let old_code = hashed_setting_code(prefix, from_id);
        let new_code = hashed_setting_code(prefix, to_id);
        if move_setting_key(connection, &old_code, &new_code, from_id, to_id)? {
            moved += 1;
        }
    }

    Ok(moved)
}

fn count_setting_keys(connection: &Connection, from_id: &str) -> rusqlite::Result<i32> {
    let mut total = 0;

    for prefix in PLAIN_SETTING_KEY_PREFIXES {
        if setting_key_exists(connection, &format!("{prefix}{from_id}"))? {
            total += 1;
        }
    }

    for prefix in HASHED_SETTING_KEY_PREFIXES {
        if setting_key_exists(connection, &hashed_setting_code(prefix, from_id))? {
            total += 1;
        }
    }

    Ok(total)
}

fn setting_key_exists(connection: &Connection, setting_code: &str) -> rusqlite::Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM system_settings WHERE setting_code = ?1",
            [setting_code],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
}

fn rewrite_path_prefix(
    connection: &Connection,
    table: &str,
    column: &str,
    old_prefix: &str,
    new_prefix: &str,
    replace_conflicts: bool,
) -> rusqlite::Result<i32> {
    let verb = if replace_conflicts {
        "UPDATE OR REPLACE"
    } else {
        "UPDATE"
    };

    let updated = connection.execute(
        &format!(
            "{verb} {table}
                SET {column} = ?1 || substr({column}, length(?2) + 1)
              WHERE {column} = ?2
                 OR substr({column}, 1, length(?2) + 1) = ?2 || '/'
                 OR substr({column}, 1, length(?2) + 1) = ?2 || '\\'"
        ),
        params![new_prefix, old_prefix],
    )?;

    Ok(updated as i32)
}

fn rewrite_path_columns(
    connection: &Connection,
    old_path: &str,
    new_path: &str,
) -> rusqlite::Result<i32> {
    if old_path.is_empty() || new_path.is_empty() {
        return Ok(0);
    }

    let mut total = 0;

    for (table, column) in UNIQUE_PATH_PREFIX_COLUMNS {
        total += rewrite_path_prefix(connection, table, column, old_path, new_path, true)?;
    }

    Ok(total)
}

fn count_path_columns(
    connection: &Connection,
    table: &str,
    column: &str,
    old_path: &str,
) -> rusqlite::Result<i32> {
    connection.query_row(
        &format!(
            "SELECT COUNT(*)
               FROM {table}
              WHERE {column} = ?1
                 OR substr({column}, 1, length(?1) + 1) = ?1 || '/'
                 OR substr({column}, 1, length(?1) + 1) = ?1 || '\\'"
        ),
        [old_path],
        |row| row.get(0),
    )
}

fn count_paths(connection: &Connection, old_path: &str) -> rusqlite::Result<i32> {
    if old_path.is_empty() {
        return Ok(0);
    }

    let mut total = 0;

    for (table, column) in UNIQUE_PATH_PREFIX_COLUMNS {
        total += count_path_columns(connection, table, column, old_path)?;
    }

    Ok(total)
}

fn rewrite_manifest_work_dir(
    manifest_path: &Path,
    old_candidates: &[String],
    new_path: &str,
) -> bool {
    let Ok(raw) = fs::read_to_string(manifest_path) else {
        return false;
    };

    if !old_candidates
        .iter()
        .any(|candidate| raw.contains(candidate.as_str()))
    {
        return false;
    }

    let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };

    let mut changed = false;

    if let Some(Value::String(work_dir)) = value.get_mut("work_dir") {
        if old_candidates.iter().any(|candidate| candidate == work_dir) {
            *work_dir = new_path.to_string();
            changed = true;
        }
    }

    if let Some(git) = value.get_mut("git").and_then(Value::as_object_mut) {
        if let Some(Value::String(repository_root)) = git.get_mut("repository_root") {
            if old_candidates
                .iter()
                .any(|candidate| candidate == repository_root)
            {
                *repository_root = new_path.to_string();
                changed = true;
            }
        }
    }

    if !changed {
        return false;
    }

    let Ok(serialized) = serde_json::to_vec(&value) else {
        return false;
    };

    let temporary = manifest_path.with_extension("json.tmp");

    if fs::write(&temporary, serialized).is_err() {
        return false;
    }

    if fs::rename(&temporary, manifest_path).is_err() {
        let _ = fs::remove_file(&temporary);
        return false;
    }

    true
}

fn history_paths(connection: &Connection, directory_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT old_path, new_path
           FROM workspace_directory_relinks
          WHERE old_directory_id = ?1 OR new_directory_id = ?1
          ORDER BY id DESC",
    )?;

    let rows = statement.query_map([directory_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut paths: Vec<String> = Vec::new();

    for row in rows {
        let (old_path, new_path) = row?;
        for value in [old_path, new_path] {
            if !value.is_empty() && !paths.contains(&value) {
                paths.push(value);
            }
        }
    }

    Ok(paths)
}

fn rewrite_checkpoint_manifests(old_paths: &[String], new_path: &str) -> i32 {
    if old_paths.is_empty() || new_path.is_empty() {
        return 0;
    }

    let Ok(root) = crate::storage::services::storage_locations::checkpoint_root() else {
        return 0;
    };
    if !root.is_dir() {
        return 0;
    }

    let resolved_new = fs::canonicalize(new_path)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| new_path.to_string());

    let mut candidates: Vec<String> = Vec::new();

    for old_path in old_paths {
        if old_path.is_empty() || old_path == &resolved_new {
            continue;
        }
        if !candidates.contains(old_path) {
            candidates.push(old_path.clone());
        }
        if let Ok(canonical_old) = fs::canonicalize(old_path) {
            let value = canonical_old.to_string_lossy().to_string();
            if !candidates.contains(&value) {
                candidates.push(value);
            }
        }
    }

    if candidates.is_empty() {
        return 0;
    }

    let mut rewritten = 0;
    let mut stack = vec![root];

    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }

            if entry.file_name() != CHECKPOINT_MANIFEST_FILE {
                continue;
            }

            if rewrite_manifest_work_dir(&entry.path(), &candidates, &resolved_new) {
                rewritten += 1;
            }
        }
    }

    rewritten
}

fn drop_codebase_index(connection: &Connection, directory_id: &str) -> rusqlite::Result<()> {
    let table_name = crate::storage::services::codebase_index::vector_table_name(directory_id);

    if table_exists(connection, &table_name)? {
        connection.execute_batch(&format!("DROP TABLE IF EXISTS {table_name};"))?;
    }
    connection.execute(
        "DELETE FROM codebase_embed_sessions WHERE project_id = ?1",
        [directory_id],
    )?;

    Ok(())
}

fn directory_path_from_id(directory_id: &str) -> &str {
    directory_id
        .split_once(':')
        .map(|(_, path)| path)
        .unwrap_or(directory_id)
}

/// 规范化 SSH 工作区 URL：强制 `ssh://` 前缀，authority 后的路径保持稳定形式，
/// 使同一连接始终生成同一个 directory_id（避免仅斜杠差异触发无意义迁移）。
fn normalize_ssh_target(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    let rest = trimmed.strip_prefix("ssh://").ok_or_else(|| {
        Error::from_reason(
            "WORKSPACE_SSH_URL_INVALID: SSH connection URL must start with ssh://",
        )
    })?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let (username, host_port) = authority.split_once('@').ok_or_else(|| {
        Error::from_reason(
            "WORKSPACE_SSH_URL_INVALID: SSH connection URL must include a username",
        )
    })?;
    let host = host_port
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(host_port);
    if username.trim().is_empty() || host.trim().is_empty() {
        return Err(Error::from_reason(
            "WORKSPACE_SSH_URL_INVALID: SSH connection URL must include a username and host",
        ));
    }
    let mut normalized_path = path.trim_end_matches('/').to_string();
    if normalized_path.is_empty() {
        normalized_path.push('/');
    }
    Ok(format!("ssh://{authority}{normalized_path}"))
}

/// SSH 目录的显示名（去掉协议前缀，与添加连接时的默认命名保持一致）。
fn ssh_display_name(url: &str) -> String {
    url.trim()
        .strip_prefix("ssh://")
        .unwrap_or(url.trim())
        .to_string()
}

/// 与主进程 getSshProfileKey 一致的连接档案键（user@host:port）。
fn ssh_profile_key(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("ssh://")?;
    let authority = rest.split('/').next()?;
    let (username, host_port) = authority.split_once('@')?;
    // 与 parseSshUrl 相同：按首个冒号切 host 与 port（缺省 22）。
    let (host, port) = match host_port.split_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().unwrap_or(22)),
        None => (host_port, 22),
    };
    if username.is_empty() || host.is_empty() {
        return None;
    }
    Some(format!("ssh-profile:{username}@{host}:{port}"))
}

/// SSH 工作区独有的项目键：远程草稿、文件评审标注、行内 diff 评论与项目级指令
/// 随连接一起迁移，避免换用户名/主机/目录后这些数据变成孤儿。
fn move_ssh_workspace_extras(
    connection: &Connection,
    from_id: &str,
    to_id: &str,
) -> rusqlite::Result<()> {
    if table_exists(connection, "remote_drafts")? {
        // 草稿同时绑定 profile（user@host:port）：换登录信息后同步改写，
        // 否则旧草稿会因 profile 不匹配而查不到。
        match ssh_profile_key(directory_path_from_id(to_id)) {
            Some(profile_id) => {
                connection.execute(
                    "UPDATE OR REPLACE remote_drafts
                        SET workspace_id = ?1, profile_id = ?2
                      WHERE workspace_id = ?3",
                    params![to_id, profile_id, from_id],
                )?;
            }
            None => {
                connection.execute(
                    "UPDATE OR REPLACE remote_drafts SET workspace_id = ?1 WHERE workspace_id = ?2",
                    params![to_id, from_id],
                )?;
            }
        }
    }

    if table_exists(connection, "file_review_annotations")? {
        connection.execute(
            "UPDATE OR REPLACE file_review_annotations
                SET source_key = 'ssh:' || ?1
              WHERE source_key = 'ssh:' || ?2",
            params![to_id, from_id],
        )?;
    }

    for (table, column) in [
        ("diff_review_comments", "directory_id"),
        ("custom_commands", "project_id"),
    ] {
        if table_exists(connection, table)? {
            connection.execute(
                &format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2"),
                params![to_id, from_id],
            )?;
        }
    }

    Ok(())
}

fn count_move(connection: &Connection, from_id: &str) -> rusqlite::Result<MoveCounts> {
    let from_path = directory_path_from_id(from_id);

    Ok(MoveCounts {
        conversations: count_rows(connection, "chat_conversations", "directory_id", from_id)?,
        memories: count_rows(connection, "project_memories", "directory_id", from_id)?,
        memos: count_rows(connection, "memos", "directory_id", from_id)?,
        scheduled_tasks: count_rows(connection, "scheduled_tasks", "directory_id", from_id)?,
        collections_touched: count_rows(connection, "collection_members", "directory_id", from_id)?,
        settings_keys_moved: count_setting_keys(connection, from_id)?,
        paths_rewritten: count_paths(connection, from_path)?,
        codebase_reindex_required: true,
    })
}

fn move_sub_agent_run_identities(
    connection: &Connection,
    from_id: &str,
    to_id: &str,
) -> rusqlite::Result<()> {
    let busy: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sub_agent_runs WHERE project_id IN (?1,?2)
          AND status IN ('queued','running','waiting_input','finalizing','cancelling'))",
        params![from_id, to_id],
        |row| row.get(0),
    )?;
    if busy {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            Error::from_reason("RUN_BUSY: source or target project has an active sub-agent run"),
        )));
    }
    // Preserve the composite task FK throughout the existing Immediate write
    // transaction. Deferral is scoped to this transaction; commit still checks
    // every FK, and failure rolls back the project move instead of losing runs.
    connection.pragma_update(None, "defer_foreign_keys", true)?;
    let records = {
        let mut statement = connection
            .prepare("SELECT run_id,record_json,version FROM sub_agent_runs WHERE project_id=?1")?;
        let records = statement
            .query_map([from_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records
    };
    let old_path = directory_path_from_id(from_id);
    let new_path = directory_path_from_id(to_id);
    for (run_id, raw, version) in records {
        let mut record: Value = serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        let object = record
            .as_object_mut()
            .ok_or(rusqlite::Error::InvalidQuery)?;
        if object.get("projectId").and_then(Value::as_str) != Some(from_id)
            || object.get("version").and_then(Value::as_i64) != Some(version)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        object.insert("projectId".to_string(), Value::String(to_id.to_string()));
        object.insert("version".to_string(), Value::from(version + 1));
        let snapshot = object
            .get_mut("snapshot")
            .and_then(Value::as_object_mut)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let workspace = snapshot
            .get("workspacePath")
            .and_then(Value::as_str)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        // A valid persisted binding also wins when worktreeMode=false. Rewrite
        // only paths owned by the moved project, not an external binding path.
        let moved_workspace = if workspace == old_path {
            Some(new_path.to_string())
        } else {
            workspace
                .strip_prefix(old_path)
                .filter(|suffix| suffix.starts_with('/') || suffix.starts_with('\\'))
                .map(|suffix| format!("{new_path}{suffix}"))
        };
        if let Some(path) = moved_workspace {
            snapshot.insert("workspacePath".to_string(), Value::String(path));
        }
        // Only structured host identity is changed; summary, outcome, acceptance,
        // prompt-bearing content and toolsJson are deliberately not traversed.
        let changed = connection.execute(
            "UPDATE sub_agent_runs SET project_id=?1,record_json=?2,version=?3
             WHERE run_id=?4 AND project_id=?5 AND version=?6",
            params![
                to_id,
                record.to_string(),
                version + 1,
                run_id,
                from_id,
                version
            ],
        )?;
        if changed != 1 {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    connection.execute(
        "UPDATE sub_agent_parent_tasks SET project_id=?1 WHERE project_id=?2",
        params![to_id, from_id],
    )?;
    connection.execute(
        "UPDATE sub_agent_run_requests SET project_id=?1 WHERE project_id=?2",
        params![to_id, from_id],
    )?;
    // Stable ids, requestInput hashes, receipts, events and queued messages are
    // untouched. This helper is also used by undo in the same transaction.
    Ok(())
}

fn apply_move(connection: &Connection, from_id: &str, to_id: &str) -> rusqlite::Result<MoveCounts> {
    move_sub_agent_run_identities(connection, from_id, to_id)?;
    let counts = count_move(connection, from_id)?;

    connection.execute(
        "DELETE FROM collection_members
          WHERE directory_id = ?1
            AND EXISTS (
                SELECT 1
                  FROM collection_members AS target
                 WHERE target.collection_id = collection_members.collection_id
                   AND target.directory_id = ?2
            )",
        params![from_id, to_id],
    )?;

    connection.execute(
        "DELETE FROM sub_agent_configs
          WHERE project_id = ?1
            AND agent_id IN (
                SELECT agent_id FROM sub_agent_configs WHERE project_id = ?2
            )",
        params![from_id, to_id],
    )?;

    for (table, column) in KEYED_COLUMNS {
        connection.execute(
            &format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2"),
            params![to_id, from_id],
        )?;
    }

    let settings_keys_moved = move_setting_keys(connection, from_id, to_id)?;
    // SSH 专属键（草稿 profile、评审标注、diff 评论、项目指令）不参与通用循环
    move_ssh_workspace_extras(connection, from_id, to_id)?;
    let paths_rewritten = rewrite_path_columns(
        connection,
        directory_path_from_id(from_id),
        directory_path_from_id(to_id),
    )?;

    drop_codebase_index(connection, from_id)?;

    Ok(MoveCounts {
        settings_keys_moved,
        paths_rewritten,
        ..counts
    })
}

fn warn_unregistered_project_key_tables(connection: &Connection) {
    let registered: Vec<&str> = KEYED_COLUMNS.iter().map(|(table, _)| *table).collect();

    let tables: Vec<String> =
        match connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'") {
            Ok(mut statement) => match statement.query_map([], |row| row.get::<_, String>(0)) {
                Ok(rows) => rows.flatten().collect(),
                Err(_) => return,
            },
            Err(_) => return,
        };

    for table in tables {
        if registered.contains(&table.as_str())
            || SELF_MANAGED_PROJECT_TABLES.contains(&table.as_str())
            || table.starts_with(crate::storage::services::codebase_index::VECTOR_TABLE_PREFIX)
            || table.starts_with("sqlite_")
        {
            continue;
        }

        let columns: Vec<String> = match connection.prepare(&format!("PRAGMA table_info({table})"))
        {
            Ok(mut statement) => match statement.query_map([], |row| row.get::<_, String>(1)) {
                Ok(rows) => rows.flatten().collect(),
                Err(_) => continue,
            },
            Err(_) => continue,
        };

        if columns
            .iter()
            .any(|column| column == "directory_id" || column == "project_id")
        {
            eprintln!(
                "Snow App workspace relink: table '{table}' carries a project key column but is not registered in KEYED_COLUMNS"
            );
        }
    }
}

fn run_in_transaction<T>(
    database_path: &Path,
    action: &str,
    operation: impl Fn(&Connection) -> rusqlite::Result<T>,
) -> Result<T> {
    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let value = operation(&transaction)?;
                    transaction.commit()?;
                    Ok(value)
                })
            },
            action,
        )
    })
    .map_err(|error| {
        if let rusqlite::Error::ToSqlConversionFailure(ref inner) = error {
            if let Some(run_error) = inner.downcast_ref::<Error>() {
                if run_error.reason.starts_with("RUN_BUSY:") {
                    return Error::from_reason(run_error.reason.clone());
                }
            }
        }
        database::database_error(database_path, action, error)
    })
}

fn load_directory_row(
    connection: &Connection,
    directory_id: &str,
) -> rusqlite::Result<Option<DirectoryRow>> {
    connection
        .query_row(
            "SELECT directory_id, path, name, kind, source, is_active, sort_order
               FROM workspace_directories
              WHERE directory_id = ?1
              LIMIT 1",
            [directory_id],
            |row| {
                Ok(DirectoryRow {
                    directory_id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    kind: row.get(3)?,
                    source: row.get(4)?,
                    is_active: row.get::<_, i32>(5)? != 0,
                    sort_order: row.get(6)?,
                })
            },
        )
        .optional()
}

fn path_basename(path: &str) -> String {
    PathBuf::from(path.trim())
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn normalize_new_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = trimmed.trim_end_matches(['/', '\\']);

    if trimmed.is_empty() {
        raw.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn update_archive_database(from_id: &str, to_id: &str) -> (bool, i32) {
    let Ok(storage_dir) = crate::storage::paths::app_storage_dir() else {
        return (false, 0);
    };
    let archive_path = crate::storage::paths::archive_database_file_path(&storage_dir);

    if !archive_path.exists() {
        return (true, 0);
    }

    let result = database::with_write_lock(|| -> rusqlite::Result<(bool, i32)> {
        let mut connection = Connection::open(&archive_path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "DELETE")?;

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut updated = 0i32;

        // Pre-v5 archives have no run records. If present, move all structured
        // run/task/request identities in this same cold-database transaction.
        if table_exists(&transaction, "sub_agent_runs")? {
            move_sub_agent_run_identities(&transaction, from_id, to_id)?;
        }

        for table in ARCHIVE_TABLES {
            if !table_exists(&transaction, table)? {
                continue;
            }
            updated += transaction.execute(
                &format!("UPDATE {table} SET directory_id = ?1 WHERE directory_id = ?2"),
                params![to_id, from_id],
            )? as i32;
        }

        transaction.commit()?;
        Ok((true, updated))
    });

    match result {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Snow App workspace relink archive update failed: {error}");
            (false, 0)
        }
    }
}

fn build_report(
    relink_id: &str,
    old_id: &str,
    new_id: &str,
    old_path: &str,
    new_path: &str,
    dry_run: bool,
    merged: bool,
    counts: MoveCounts,
    archived_conversations: i32,
    archive_updated: bool,
    checkpoints_rewritten: i32,
    notes: Vec<String>,
) -> WorkspaceRelinkReport {
    WorkspaceRelinkReport {
        relink_id: relink_id.to_string(),
        old_directory_id: old_id.to_string(),
        new_directory_id: new_id.to_string(),
        old_path: old_path.to_string(),
        new_path: new_path.to_string(),
        dry_run,
        merged,
        conversations: counts.conversations,
        archived_conversations,
        memories: counts.memories,
        memos: counts.memos,
        scheduled_tasks: counts.scheduled_tasks,
        collections_touched: counts.collections_touched,
        settings_keys_moved: counts.settings_keys_moved,
        paths_rewritten: counts.paths_rewritten,
        checkpoints_rewritten,
        codebase_reindex_required: counts.codebase_reindex_required,
        archive_updated,
        notes,
    }
}

pub fn relink_workspace_directory(
    database_path: &Path,
    old_directory_id: &str,
    new_path: &str,
    dry_run: bool,
) -> Result<WorkspaceRelinkReport> {
    let old_id = old_directory_id.trim();
    if old_id.is_empty() {
        return Err(Error::from_reason(
            "WORKSPACE_RELINK_SOURCE_NOT_FOUND: workspace directory id is required".to_string(),
        ));
    }

    let source = database::open_connection(database_path)
        .and_then(|connection| load_directory_row(&connection, old_id))
        .map_err(|error| {
            database::database_error(database_path, "read workspace directory", error)
        })?;

    let Some(source) = source else {
        return Err(Error::from_reason(format!(
            "WORKSPACE_RELINK_SOURCE_NOT_FOUND: unknown workspace directory '{old_id}'"
        )));
    };

    if source.source == BUILTIN_SOURCE {
        return Err(Error::from_reason(
            "WORKSPACE_RELINK_BUILTIN_UNSUPPORTED: the built-in workspace directory cannot be relinked"
                .to_string(),
        ));
    }

    // SSH 目录的「迁移」= 修改连接（登录信息 / 端口 / 远程目录），目标不做本地磁盘校验。
    let is_remote = source.kind == KIND_SSH;
    let (normalized_path, target_dir) = if is_remote {
        (normalize_ssh_target(new_path)?, None)
    } else {
        let normalized = normalize_new_path(new_path);
        if normalized.is_empty() {
            return Err(Error::from_reason(
                "WORKSPACE_RELINK_TARGET_NOT_DIR: target path is required".to_string(),
            ));
        }
        let target = Path::new(&normalized);
        if !target.is_dir() {
            return Err(Error::from_reason(format!(
                "WORKSPACE_RELINK_TARGET_NOT_DIR: '{}' is not an existing directory",
                target.display()
            )));
        }
        let target_dir = target.to_path_buf();
        (normalized, Some(target_dir))
    };

    let new_id = if is_remote {
        format!("{KIND_SSH}:{normalized_path}")
    } else {
        format!("{LOCAL_KIND}:{normalized_path}")
    };

    if new_id == source.directory_id {
        let counts = MoveCounts {
            conversations: 0,
            memories: 0,
            memos: 0,
            scheduled_tasks: 0,
            collections_touched: 0,
            settings_keys_moved: 0,
            paths_rewritten: 0,
            codebase_reindex_required: false,
        };
        return Ok(build_report(
            "",
            &source.directory_id,
            &new_id,
            &source.path,
            &normalized_path,
            dry_run,
            false,
            counts,
            0,
            true,
            0,
            vec!["already_at_target".to_string()],
        ));
    }

    let existing_target = database::open_connection(database_path)
        .and_then(|connection| load_directory_row(&connection, &new_id))
        .map_err(|error| {
            database::database_error(database_path, "read workspace directory", error)
        })?;

    let merged = existing_target.is_some();
    // SSH 目录改连接时不允许并到已有目录：合并会删掉源记录，语义上更像「换连接失败」。
    if is_remote && merged {
        return Err(Error::from_reason(format!(
            "WORKSPACE_RELINK_TARGET_OCCUPIED: remote workspace '{new_id}' already exists"
        )));
    }
    // 默认名（本地=目录名，SSH=去掉协议前缀的连接串）：仍是默认名时跟随新目标更新
    let source_default_name = if is_remote {
        ssh_display_name(&source.path)
    } else {
        path_basename(&source.path)
    };
    let new_default_name = if is_remote {
        ssh_display_name(&normalized_path)
    } else {
        path_basename(&normalized_path)
    };
    let derived_name = source.name.trim().is_empty() || source.name.trim() == source_default_name;
    let keep_name = if merged {
        existing_target
            .as_ref()
            .map(|target| target.name.clone())
            .unwrap_or_default()
    } else if derived_name {
        new_default_name
    } else {
        source.name.clone()
    };

    if dry_run {
        let counts = database::open_connection(database_path)
            .and_then(|connection| count_move(&connection, &source.directory_id))
            .map_err(|error| {
                database::database_error(database_path, "count workspace relink", error)
            })?;

        return Ok(build_report(
            "",
            &source.directory_id,
            &new_id,
            &source.path,
            &normalized_path,
            true,
            merged,
            counts,
            0,
            true,
            0,
            Vec::new(),
        ));
    }

    let relink_id = database::create_snowflake_id();
    // 远端目录没有本地身份信息，健康状态固定为 remote。
    let target_state = if is_remote {
        STATE_REMOTE
    } else {
        STATE_OK
    };
    let identity = target_dir
        .as_deref()
        .map(fs_identity)
        .unwrap_or_default();

    let counts = run_in_transaction(database_path, "relink workspace directory", |connection| {
        warn_unregistered_project_key_tables(connection);

        let counts = apply_move(connection, &source.directory_id, &new_id)?;

        match existing_target.as_ref() {
            Some(target) => {
                if source.is_active && !target.is_active {
                    connection.execute(
                        "UPDATE workspace_directories
                            SET is_active = 0,
                                updated_at = datetime('now', 'localtime')
                          WHERE is_active = 1",
                        [],
                    )?;
                    connection.execute(
                        "UPDATE workspace_directories
                            SET is_active = 1,
                                updated_at = datetime('now', 'localtime')
                          WHERE directory_id = ?1",
                        [&new_id],
                    )?;
                }

                connection.execute(
                    "UPDATE workspace_directories
                        SET path_state = ?1,
                            path_checked_at = datetime('now', 'localtime'),
                            fs_identity = ?2,
                            last_known_path = ?3,
                            sort_order = MIN(sort_order, ?4),
                            updated_at = datetime('now', 'localtime')
                      WHERE directory_id = ?5",
                    params![
                        target_state,
                        identity,
                        normalized_path,
                        source.sort_order,
                        new_id
                    ],
                )?;

                connection.execute(
                    "DELETE FROM workspace_directories WHERE directory_id = ?1",
                    [&source.directory_id],
                )?;
            }
            None => {
                connection.execute(
                    "UPDATE workspace_directories
                        SET directory_id = ?1,
                            path = ?2,
                            name = ?3,
                            path_state = ?4,
                            path_checked_at = datetime('now', 'localtime'),
                            fs_identity = ?5,
                            last_known_path = ?2,
                            updated_at = datetime('now', 'localtime')
                      WHERE directory_id = ?6",
                    params![
                        new_id,
                        normalized_path,
                        keep_name,
                        target_state,
                        identity,
                        source.directory_id
                    ],
                )?;
            }
        }

        connection.execute(
            "INSERT INTO workspace_directory_relinks (
               id,
               old_directory_id,
               new_directory_id,
               old_path,
               new_path,
               moved_by,
               report_json,
               created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', datetime('now', 'localtime'))",
            params![
                relink_id,
                source.directory_id,
                new_id,
                source.path,
                normalized_path,
                "manual"
            ],
        )?;

        Ok(counts)
    })?;

    let (archive_updated, archived_conversations) =
        update_archive_database(&source.directory_id, &new_id);
    let checkpoint_paths = database::open_connection(database_path)
        .and_then(|connection| history_paths(&connection, &new_id))
        .unwrap_or_default();
    let checkpoints_rewritten = rewrite_checkpoint_manifests(&checkpoint_paths, &normalized_path);

    let mut notes = Vec::new();
    if merged {
        notes.push("merged_with_existing".to_string());
    }

    Ok(build_report(
        &relink_id,
        &source.directory_id,
        &new_id,
        &source.path,
        &normalized_path,
        false,
        merged,
        counts,
        archived_conversations,
        archive_updated,
        checkpoints_rewritten,
        notes,
    ))
}

pub fn undo_workspace_directory_relink(
    database_path: &Path,
    relink_id: &str,
) -> Result<WorkspaceRelinkReport> {
    let normalized_relink_id = relink_id.trim();
    if normalized_relink_id.is_empty() {
        return Err(Error::from_reason(
            "WORKSPACE_RELINK_UNDO_NOT_FOUND: relink id is required".to_string(),
        ));
    }

    let audit: Option<(String, String, String, String, bool)> =
        database::open_connection(database_path)
            .and_then(|connection| {
                connection
                    .query_row(
                        "SELECT old_directory_id, new_directory_id, old_path, new_path, undone_at
                       FROM workspace_directory_relinks
                      WHERE id = ?1",
                        [normalized_relink_id],
                        |row| {
                            let undone_at: Option<String> = row.get(4)?;
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                undone_at.is_some(),
                            ))
                        },
                    )
                    .optional()
            })
            .map_err(|error| {
                database::database_error(database_path, "read workspace relink", error)
            })?;

    let Some((old_id, new_id, old_path, new_path, is_undone)) = audit else {
        return Err(Error::from_reason(format!(
            "WORKSPACE_RELINK_UNDO_NOT_FOUND: unknown relink record '{normalized_relink_id}'"
        )));
    };

    if is_undone {
        return Err(Error::from_reason(
            "WORKSPACE_RELINK_ALREADY_UNDONE: this relink record was already undone".to_string(),
        ));
    }

    let source = database::open_connection(database_path)
        .and_then(|connection| load_directory_row(&connection, &new_id))
        .map_err(|error| {
            database::database_error(database_path, "read workspace directory", error)
        })?;

    let Some(source) = source else {
        return Err(Error::from_reason(format!(
            "WORKSPACE_RELINK_SOURCE_NOT_FOUND: unknown workspace directory '{new_id}'"
        )));
    };

    let occupied = database::open_connection(database_path)
        .and_then(|connection| load_directory_row(&connection, &old_id))
        .map_err(|error| {
            database::database_error(database_path, "read workspace directory", error)
        })?;

    if occupied.is_some() {
        return Err(Error::from_reason(format!(
            "WORKSPACE_RELINK_TARGET_OCCUPIED: workspace directory '{old_id}' already exists"
        )));
    }

    let restored_path = if old_path.trim().is_empty() {
        new_path.clone()
    } else {
        old_path.clone()
    };
    // 远端目录不校验本地磁盘，状态恒为 remote。
    let restored_is_remote = source.kind == KIND_SSH;
    let restored_exists = !restored_is_remote && Path::new(&restored_path).is_dir();
    let state = if restored_is_remote {
        STATE_REMOTE
    } else if restored_exists {
        STATE_OK
    } else {
        STATE_MISSING
    };
    let restored_identity = if restored_exists {
        fs_identity(Path::new(&restored_path))
    } else {
        String::new()
    };

    let counts = run_in_transaction(
        database_path,
        "undo workspace directory relink",
        |connection| {
            let counts = apply_move(connection, &new_id, &old_id)?;

            connection.execute(
                "UPDATE workspace_directories
                SET directory_id = ?1,
                    path = ?2,
                    path_state = ?3,
                    path_checked_at = datetime('now', 'localtime'),
                    last_known_path = ?4,
                    fs_identity = ?5,
                    updated_at = datetime('now', 'localtime')
              WHERE directory_id = ?6",
                params![
                    old_id,
                    restored_path,
                    state,
                    if restored_exists {
                        restored_path.clone()
                    } else {
                        source.path.clone()
                    },
                    restored_identity,
                    new_id
                ],
            )?;

            connection.execute(
                "UPDATE workspace_directory_relinks
                SET undone_at = datetime('now', 'localtime')
              WHERE id = ?1",
                [normalized_relink_id],
            )?;

            Ok(counts)
        },
    )?;

    let (archive_updated, archived_conversations) = update_archive_database(&new_id, &old_id);
    let checkpoint_paths = database::open_connection(database_path)
        .and_then(|connection| history_paths(&connection, &old_id))
        .unwrap_or_default();
    let checkpoints_rewritten = rewrite_checkpoint_manifests(&checkpoint_paths, &restored_path);

    Ok(build_report(
        normalized_relink_id,
        &new_id,
        &old_id,
        &new_path,
        &restored_path,
        false,
        false,
        counts,
        archived_conversations,
        archive_updated,
        checkpoints_rewritten,
        vec!["undo".to_string()],
    ))
}

pub fn list_workspace_directory_relinks(
    database_path: &Path,
    directory_id: &str,
    limit: i32,
) -> Result<Vec<WorkspaceRelinkRecord>> {
    let normalized_id = directory_id.trim();
    if normalized_id.is_empty() {
        return Err(Error::from_reason(
            "WORKSPACE_RELINK_HISTORY_INVALID: workspace directory id is required".to_string(),
        ));
    }

    let safe_limit = if limit > 0 { limit.min(200) } else { 50 };

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,
                        old_directory_id,
                        new_directory_id,
                        old_path,
                        new_path,
                        moved_by,
                        created_at,
                        undone_at
                   FROM workspace_directory_relinks
                  WHERE old_directory_id = ?1 OR new_directory_id = ?1
                  ORDER BY id DESC
                  LIMIT ?2",
            )?;

            let rows = statement.query_map(params![normalized_id, safe_limit], |row| {
                Ok(WorkspaceRelinkRecord {
                    relink_id: row.get(0)?,
                    old_directory_id: row.get(1)?,
                    new_directory_id: row.get(2)?,
                    old_path: row.get(3)?,
                    new_path: row.get(4)?,
                    moved_by: row.get(5)?,
                    created_at: row.get(6)?,
                    undone_at: row.get(7)?,
                })
            })?;

            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "list workspace directory relinks", error)
        })
}
