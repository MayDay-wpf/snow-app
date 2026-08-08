use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};
use serde_json::Value;

use super::super::database;
use super::super::{SystemPromptItemInput, SystemPromptItemRecord};

/// Sentinel value that explicitly disables user system prompts for a profile,
/// overriding the global active list. Matches the frontend convention used in
/// `SystemPromptSelect` (`__DISABLED__`).
const DISABLED_SENTINEL: &str = "__DISABLED__";
const GLOBAL_SCOPE: &str = "global";
const PROJECT_SCOPE: &str = "project";

pub fn list_system_prompts(database_path: &Path) -> Result<Vec<SystemPromptItemRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_system_prompts(&connection))
        .map_err(|error| database::database_error(database_path, "list system prompts", error))
}

pub fn upsert_system_prompt(database_path: &Path, item: &SystemPromptItemInput) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| upsert_system_prompt_with_connection(&connection, item))
        .map_err(|error| database::database_error(database_path, "upsert system prompt", error))
}

pub fn delete_system_prompt(database_path: &Path, prompt_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM system_prompts WHERE prompt_id = ?1",
                [prompt_id],
            )?;
            super::import_resources::delete_prompt_tracking_for_target(&transaction, prompt_id)?;
            transaction.commit()?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete system prompt", error))
}

fn query_system_prompts(connection: &Connection) -> rusqlite::Result<Vec<SystemPromptItemRecord>> {
    let mut statement = connection.prepare(
        "SELECT id,
                prompt_id,
                name,
                content,
                is_active,
                sort_order,
                scope,
                project_id,
                updated_at
           FROM system_prompts
          ORDER BY sort_order ASC, id ASC",
    )?;

    let rows = statement.query_map([], |row| {
        let is_active: i64 = row.get(4)?;

        Ok(SystemPromptItemRecord {
            id: row.get(0)?,
            prompt_id: row.get(1)?,
            name: row.get(2)?,
            content: row.get(3)?,
            is_active: is_active != 0,
            sort_order: row.get(5)?,
            scope: row.get(6)?,
            project_id: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;

    rows.collect()
}

pub(crate) fn upsert_system_prompt_with_connection(
    connection: &Connection,
    item: &SystemPromptItemInput,
) -> rusqlite::Result<()> {
    let (scope, project_id) = normalize_scope(item).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            error.reason.clone(),
        )))
    })?;
    connection.execute(
        "INSERT INTO system_prompts (
           id,
           prompt_id,
           name,
           content,
           is_active,
           sort_order,
           scope,
           project_id,
           created_at,
           updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now', 'localtime'), datetime('now', 'localtime')
         )
         ON CONFLICT(prompt_id) DO UPDATE SET
           name = excluded.name,
           content = excluded.content,
           is_active = excluded.is_active,
           sort_order = excluded.sort_order,
           scope = excluded.scope,
           project_id = excluded.project_id,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            item.prompt_id,
            item.name,
            item.content,
            item.is_active as i32,
            item.sort_order,
            scope,
            project_id,
        ],
    )?;

    Ok(())
}

fn normalize_scope(item: &SystemPromptItemInput) -> Result<(String, Option<String>)> {
    let scope = item
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .unwrap_or(GLOBAL_SCOPE);
    match scope {
        GLOBAL_SCOPE => Ok((GLOBAL_SCOPE.to_string(), None)),
        PROJECT_SCOPE => {
            let project_id = item
                .project_id
                .as_deref()
                .map(str::trim)
                .filter(|project_id| !project_id.is_empty())
                .ok_or_else(|| {
                    Error::from_reason("Project-scoped system prompts require a project ID")
                })?;
            Ok((PROJECT_SCOPE.to_string(), Some(project_id.to_string())))
        }
        _ => Err(Error::from_reason(
            "System prompt scope must be global or project",
        )),
    }
}

/// Resolve the user-configured system prompt contents for a given API profile.
///
/// Mirrors Snow CLI's `getCustomSystemPromptForConfig`:
/// - `system_prompt_ids_json` empty → follow active global prompts plus active
///   project prompts for the current workspace, ordered by `sort_order`.
/// - `system_prompt_ids_json` equal to `__DISABLED__` or an empty JSON array
///   → return an empty vector (profile explicitly opts out).
/// - Otherwise parse the JSON as an array of prompt IDs and return the
///   matching prompt contents in the declared order and current workspace.
///
/// Returns an empty vector when the database is unreadable or no prompts
/// match, so callers can treat "no user system prompts" uniformly.
pub fn resolve_active_system_prompt_contents(
    database_path: &Path,
    system_prompt_ids_json: &str,
    directory_id: Option<&str>,
) -> Vec<String> {
    let trimmed = system_prompt_ids_json.trim();
    if trimmed.is_empty() {
        return query_active_contents(database_path, directory_id);
    }

    if trimmed == DISABLED_SENTINEL {
        return Vec::new();
    }

    let ids = match parse_prompt_id_array(trimmed) {
        Some(ids) if !ids.is_empty() => ids,
        _ => return Vec::new(),
    };

    let prompts = match list_system_prompts(database_path) {
        Ok(prompts) => prompts,
        Err(_) => return Vec::new(),
    };

    let mut contents = Vec::new();
    for id in ids {
        if let Some(prompt) = prompts
            .iter()
            .find(|item| item.prompt_id == id && prompt_applies_to_directory(item, directory_id))
        {
            let content = prompt.content.trim();
            if !content.is_empty() {
                contents.push(content.to_string());
            }
        }
    }
    contents
}

fn query_active_contents(database_path: &Path, directory_id: Option<&str>) -> Vec<String> {
    let prompts = match list_system_prompts(database_path) {
        Ok(prompts) => prompts,
        Err(_) => return Vec::new(),
    };

    prompts
        .into_iter()
        .filter(|prompt| prompt.is_active && prompt_applies_to_directory(prompt, directory_id))
        .map(|prompt| prompt.content.trim().to_string())
        .filter(|content| !content.is_empty())
        .collect()
}

fn prompt_applies_to_directory(
    prompt: &SystemPromptItemRecord,
    directory_id: Option<&str>,
) -> bool {
    match prompt.scope.as_str() {
        PROJECT_SCOPE => {
            let directory_id = directory_id.map(str::trim).filter(|id| !id.is_empty());
            directory_id == prompt.project_id.as_deref()
        }
        _ => true,
    }
}

/// Parse a JSON string into a list of prompt IDs.
///
/// Accepts both `["id1", "id2"]` arrays and a bare string `"id1"` for
/// backward compatibility with single-select profiles.
fn parse_prompt_id_array(raw: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(raw).ok()?;

    match value {
        Value::Array(items) => {
            let ids = items
                .into_iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>();
            Some(ids)
        }
        Value::String(id) => Some(vec![id]),
        _ => None,
    }
}
