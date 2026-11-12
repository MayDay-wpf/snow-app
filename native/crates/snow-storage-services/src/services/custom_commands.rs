use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::super::database;
use super::super::{CustomCommandInput, CustomCommandRecord};

const SCOPE_GLOBAL: &str = "global";
const SCOPE_PROJECT: &str = "project";
const TYPE_PROMPT: &str = "prompt";
const TYPE_BASH: &str = "bash";
const MAX_COMMAND_NAME_LENGTH: usize = 64;

pub fn list_custom_commands(
    database_path: &Path,
    project_id: Option<String>,
) -> Result<Vec<CustomCommandRecord>> {
    let normalized_project_id = project_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    database::open_connection(database_path)
        .and_then(|connection| query_custom_commands(&connection, normalized_project_id.as_deref()))
        .map_err(|error| database::database_error(database_path, "list custom commands", error))
}

pub fn upsert_custom_command(database_path: &Path, item: &CustomCommandInput) -> Result<()> {
    let name = normalize_command_name(&item.name)?;
    let scope = normalize_scope(&item.scope)?;
    let command_type = normalize_command_type(&item.command_type)?;
    let content = item.content.trim().to_string();
    if content.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Custom command content is required".to_string(),
        ));
    }
    let description = item.description.trim().to_string();
    let project_id = if scope == SCOPE_PROJECT {
        normalize_required_value(&item.project_id, "Project id")?
    } else {
        String::new()
    };
    let command_id = item.command_id.trim().to_string();

    if command_id.is_empty() {
        let sort_order = next_sort_order(database_path, &scope, &project_id)?;
        return write_custom_command(
            database_path,
            &CustomCommandInput {
                command_id: database::create_snowflake_id(),
                scope,
                project_id,
                name,
                command_type,
                content,
                description,
                enabled: item.enabled,
                sort_order,
            },
        );
    }

    match find_command_scope(database_path, &command_id)? {
        Some((existing_scope, existing_project_id)) => {
            if existing_scope != scope || existing_project_id != project_id {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Custom command scope cannot be changed, create a new command instead"
                        .to_string(),
                ));
            }
        }
        None => {
            return Err(Error::new(
                Status::InvalidArg,
                "Custom command does not exist".to_string(),
            ));
        }
    }

    write_custom_command(
        database_path,
        &CustomCommandInput {
            command_id,
            scope,
            project_id,
            name,
            command_type,
            content,
            description,
            enabled: item.enabled,
            sort_order: item.sort_order.max(0),
        },
    )
}

pub fn delete_custom_command(database_path: &Path, command_id: &str) -> Result<()> {
    let normalized_command_id = normalize_required_value(command_id, "Custom command id")?;

    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(database_path).and_then(|mut connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    transaction.execute(
                        "DELETE FROM custom_commands WHERE command_id = ?1",
                        [&normalized_command_id],
                    )?;
                    transaction.commit()
                })
            },
            "delete custom command",
        )
    })
    .map_err(|error| database::database_error(database_path, "delete custom command", error))
}

fn write_custom_command(database_path: &Path, item: &CustomCommandInput) -> Result<()> {
    let database_path = database_path.to_path_buf();

    database::with_write_lock(|| {
        database::with_write_retry(
            || {
                database::open_connection(&database_path).and_then(|mut connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

                    let duplicate: Option<String> = transaction
                        .query_row(
                            "SELECT command_id
                               FROM custom_commands
                              WHERE scope = ?1
                                AND project_id = ?2
                                AND name = ?3 COLLATE NOCASE
                                AND command_id <> ?4",
                            params![item.scope, item.project_id, item.name, item.command_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if duplicate.is_some() {
                        return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                            Some(DUPLICATE_NAME_MARKER.to_string()),
                        ));
                    }

                    transaction.execute(
                        "INSERT INTO custom_commands (
                           id,
                           command_id,
                           scope,
                           project_id,
                           name,
                           command_type,
                           content,
                           description,
                           enabled,
                           sort_order,
                           created_at,
                           updated_at
                         ) VALUES (
                           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                           datetime('now', 'localtime'), datetime('now', 'localtime')
                         )
                         ON CONFLICT(command_id) DO UPDATE SET
                           name = excluded.name,
                           command_type = excluded.command_type,
                           content = excluded.content,
                           description = excluded.description,
                           enabled = excluded.enabled,
                           sort_order = excluded.sort_order,
                           updated_at = datetime('now', 'localtime')",
                        params![
                            database::create_snowflake_id(),
                            item.command_id,
                            item.scope,
                            item.project_id,
                            item.name,
                            item.command_type,
                            item.content,
                            item.description,
                            item.enabled as i32,
                            item.sort_order,
                        ],
                    )?;

                    transaction.commit()
                })
            },
            "save custom command",
        )
    })
    .map_err(|error| {
        if error.to_string().contains(DUPLICATE_NAME_MARKER) {
            return Error::new(
                Status::InvalidArg,
                "Custom command name already exists in this scope".to_string(),
            );
        }
        database::database_error(&database_path, "save custom command", error)
    })
}

const DUPLICATE_NAME_MARKER: &str = "CUSTOM_COMMAND_DUPLICATE_NAME";

fn next_sort_order(database_path: &Path, scope: &str, project_id: &str) -> Result<i32> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1
                   FROM custom_commands
                  WHERE scope = ?1 AND project_id = ?2",
                params![scope, project_id],
                |row| row.get::<_, i32>(0),
            )
        })
        .map_err(|error| database::database_error(database_path, "read custom command order", error))
}

fn find_command_scope(database_path: &Path, command_id: &str) -> Result<Option<(String, String)>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT scope, project_id FROM custom_commands WHERE command_id = ?1",
                    [command_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
        })
        .map_err(|error| database::database_error(database_path, "read custom command", error))
}

fn query_custom_commands(
    connection: &Connection,
    project_id: Option<&str>,
) -> rusqlite::Result<Vec<CustomCommandRecord>> {
    let mut statement = connection.prepare(
        "SELECT command_id,
                scope,
                project_id,
                name,
                command_type,
                content,
                description,
                enabled,
                sort_order,
                updated_at
           FROM custom_commands
          WHERE scope = 'global' OR project_id = ?1
          ORDER BY CASE scope WHEN 'project' THEN 0 ELSE 1 END,
                   sort_order ASC,
                   name COLLATE NOCASE ASC",
    )?;

    let records = statement
        .query_map([project_id.unwrap_or("")], |row| {
            let enabled: i64 = row.get(7)?;
            Ok(CustomCommandRecord {
                command_id: row.get(0)?,
                scope: row.get(1)?,
                project_id: row.get(2)?,
                name: row.get(3)?,
                command_type: row.get(4)?,
                content: row.get(5)?,
                description: row.get(6)?,
                enabled: enabled != 0,
                sort_order: row.get(8)?,
                shadowed: false,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(mark_shadowed(records))
}

fn mark_shadowed(records: Vec<CustomCommandRecord>) -> Vec<CustomCommandRecord> {
    let project_names: HashSet<String> = records
        .iter()
        .filter(|record| record.scope == SCOPE_PROJECT)
        .map(|record| record.name.to_lowercase())
        .collect();

    records
        .into_iter()
        .map(|mut record| {
            record.shadowed =
                record.scope == SCOPE_GLOBAL && project_names.contains(&record.name.to_lowercase());
            record
        })
        .collect()
}

fn normalize_command_name(value: &str) -> Result<String> {
    let trimmed = value.trim().trim_start_matches('/').trim();
    if trimmed.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Custom command name is required".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_COMMAND_NAME_LENGTH {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Custom command name cannot exceed {MAX_COMMAND_NAME_LENGTH} characters"),
        ));
    }
    let is_valid = trimmed
        .chars()
        .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | '.'));
    if !is_valid {
        return Err(Error::new(
            Status::InvalidArg,
            "Custom command name only supports letters, digits, hyphen, underscore and dot"
                .to_string(),
        ));
    }

    Ok(trimmed.to_string())
}

fn normalize_scope(value: &str) -> Result<String> {
    match value.trim() {
        SCOPE_GLOBAL => Ok(SCOPE_GLOBAL.to_string()),
        SCOPE_PROJECT => Ok(SCOPE_PROJECT.to_string()),
        _ => Err(Error::new(
            Status::InvalidArg,
            "Custom command scope must be 'global' or 'project'".to_string(),
        )),
    }
}

fn normalize_command_type(value: &str) -> Result<String> {
    match value.trim() {
        TYPE_PROMPT => Ok(TYPE_PROMPT.to_string()),
        TYPE_BASH => Ok(TYPE_BASH.to_string()),
        _ => Err(Error::new(
            Status::InvalidArg,
            "Custom command type must be 'prompt' or 'bash'".to_string(),
        )),
    }
}

fn normalize_required_value(value: &str, label: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} is required"),
        ));
    }

    Ok(normalized.to_string())
}
