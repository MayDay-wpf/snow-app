use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use crate::storage::services::custom_commands::{
    delete_custom_command, list_custom_commands, upsert_custom_command,
};
use crate::storage::{CustomCommandInput, CustomCommandRecord};

const SCOPE_NAME: &str = "customCommands";
const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const NEW_KEY: &str = "new";
const SCOPE_GLOBAL: &str = "global";
const SCOPE_PROJECT: &str = "project";
const TYPE_PROMPT: &str = "prompt";
const TYPE_BASH: &str = "bash";
const PREVIEW_CHARS: usize = 200;

const RESERVED_NAMES: &[&str] = &[
    "clear",
    "changes",
    "memory",
    "mcp",
    "permissions",
    "role",
    "sensitive",
    "skills",
    "codebase",
    "review",
    "compact",
    "custom",
    "help",
];

const GUIDANCE: &str = "CUSTOM COMMANDS - user-defined slash commands offered in the chat input as /<name> (app database custom_commands table, same source as the Settings > Custom commands panel; effective immediately).\n\
CREATE/UPDATE: config-manage action=set scope=customCommands key=\"new\" value={name, commandType: \"prompt\"|\"bash\", content, description?, enabled?, scope?} creates a command and returns its generated commandId; pass an existing commandId (or its name) as key to update it - omitted fields keep their current values.\n\
KEY RULES: (1) commandType \"prompt\" sends `content` as a user message when the user runs /<name> (the $ARGUMENTS placeholder is replaced by the text typed after the command, or the text is appended when the placeholder is absent); commandType \"bash\" opens a right-panel terminal tab in the project directory and runs `content` in the real shell; (2) the name accepts letters/digits/hyphen/underscore/dot only (a leading \"/\" is stripped) and must be unique within its scope; the built-in command names (clear, changes, memory, mcp, permissions, role, sensitive, skills, codebase, review, compact, custom, help) are rejected; (3) project sessions auto-inject projectId, so key=\"new\" creates a command for THAT project (a project command shadows a same-named global one); pass projectId=\"\" (or value={scope: \"global\"}) to write a global command that applies to every project; an existing command keeps its scope - create a new one to move it; (4) enabled=false keeps the command in the list but hides it from the chat input.\n\
READ: config-manage action=list scope=customCommands returns metadata + contentPreview for the visible commands (global + current project); config-manage action=get scope=customCommands key=<commandId|name> returns the full content; config-manage action=delete scope=customCommands key=<commandId|name> confirmed=true deletes it (project commands need the owning project's projectId). Every write is broadcast to the UI, so the chat input's / menu and the Settings > Custom commands panel refresh immediately.";

fn storage_error(error: Error) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("customCommands storage error: {error}"),
    )
}

fn load_commands(
    db_path: &Path,
    project_id: Option<&str>,
) -> Result<Vec<CustomCommandRecord>> {
    list_custom_commands(db_path, project_id.map(str::to_string)).map_err(storage_error)
}

fn content_preview(content: &str) -> String {
    let total = content.chars().count();
    let preview: String = content.chars().take(PREVIEW_CHARS).collect();
    if total > PREVIEW_CHARS {
        format!("{preview}...")
    } else {
        preview
    }
}

fn record_to_json(record: &CustomCommandRecord, with_content: bool) -> Value {
    let mut value = json!({
        "commandId": record.command_id,
        "scope": record.scope,
        "projectId": record.project_id,
        "name": record.name,
        "commandType": record.command_type,
        "description": record.description,
        "enabled": record.enabled,
        "sortOrder": record.sort_order,
        "shadowed": record.shadowed,
        "updatedAt": record.updated_at,
    });
    if let Some(map) = value.as_object_mut() {
        if with_content {
            map.insert("content".to_string(), json!(record.content));
        } else {
            map.insert(
                "contentPreview".to_string(),
                json!(content_preview(&record.content)),
            );
            map.insert(
                "contentLength".to_string(),
                json!(record.content.chars().count()),
            );
        }
    }
    value
}

fn find_command<'a>(
    records: &'a [CustomCommandRecord],
    key: &str,
) -> Option<&'a CustomCommandRecord> {
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let lowered = key.to_lowercase();
    records
        .iter()
        .find(|record| record.command_id == key)
        .or_else(|| {
            records
                .iter()
                .find(|record| record.name.to_lowercase() == lowered)
        })
}

fn find_by_name<'a>(
    records: &'a [CustomCommandRecord],
    name: &str,
    scope: &str,
) -> Option<&'a CustomCommandRecord> {
    let lowered = name.to_lowercase();
    records.iter().find(|record| {
        record.scope == scope && record.name.to_lowercase() == lowered
    })
}

fn read_text(fields: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        fields
            .get(*name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn read_flag(fields: &Map<String, Value>, names: &[&str]) -> Option<bool> {
    names.iter().find_map(|name| match fields.get(*name) {
        Some(Value::Bool(flag)) => Some(*flag),
        Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

fn read_int(fields: &Map<String, Value>, name: &str) -> Option<i32> {
    fields.get(name).and_then(|field| {
        field
            .as_i64()
            .map(|number| number.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32)
            .or_else(|| {
                field
                    .as_u64()
                    .map(|number| number.min(i32::MAX as u64) as i32)
            })
    })
}

fn invalid_value_error(received: &Value) -> Error {
    let received_desc = match received {
        Value::String(text) => {
            let preview: String = text.chars().take(80).collect();
            format!(
                "a string of {} chars starting with {preview:?}",
                text.chars().count()
            )
        }
        other => {
            let serialized = serde_json::to_string(other).unwrap_or_else(|_| other.to_string());
            serialized.chars().take(80).collect::<String>()
        }
    };
    Error::new(
        Status::InvalidArg,
        format!(
            "value for the customCommands scope must be an object like {{name: \"deploy\", commandType: \"prompt\", content: \"...\"}} (create with key=\"{NEW_KEY}\"; pass a commandId or name to update). Received {received_desc}"
        ),
    )
}

fn normalize_fields(value: &Value) -> Result<Map<String, Value>> {
    match value {
        Value::Object(map) => Ok(map.clone()),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{') && trimmed.ends_with('}') {
                if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
                    return Ok(map);
                }
            }
            Err(invalid_value_error(value))
        }
        other => Err(invalid_value_error(other)),
    }
}

fn require_project_id(project_id: Option<&str>) -> Result<String> {
    project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "a project-scoped custom command requires a projectId (project sessions inject the current project automatically; pass a real projectId, or omit value.scope to write a global command)".to_string(),
            )
        })
}

fn resolve_create_scope(
    project_id: Option<&str>,
    fields: &Map<String, Value>,
) -> Result<(String, String)> {
    match read_text(fields, &["scope"]).map(|text| text.to_lowercase()) {
        Some(scope) if scope == SCOPE_GLOBAL => Ok((SCOPE_GLOBAL.to_string(), String::new())),
        Some(scope) if scope == SCOPE_PROJECT => {
            Ok((SCOPE_PROJECT.to_string(), require_project_id(project_id)?))
        }
        Some(other) => Err(Error::new(
            Status::InvalidArg,
            format!(
                "value.scope must be \"{SCOPE_GLOBAL}\" or \"{SCOPE_PROJECT}\" (got \"{other}\")"
            ),
        )),
        None => match project_id.map(str::trim).filter(|value| !value.is_empty()) {
            Some(project_id) => Ok((SCOPE_PROJECT.to_string(), project_id.to_string())),
            None => Ok((SCOPE_GLOBAL.to_string(), String::new())),
        },
    }
}

fn resolve_command_type(fields: &Map<String, Value>, fallback: &str) -> Result<String> {
    match read_text(fields, &["commandType", "type"]) {
        Some(raw) => match raw.to_lowercase().as_str() {
            TYPE_PROMPT => Ok(TYPE_PROMPT.to_string()),
            TYPE_BASH => Ok(TYPE_BASH.to_string()),
            other => Err(Error::new(
                Status::InvalidArg,
                format!(
                    "value.commandType must be \"{TYPE_PROMPT}\" or \"{TYPE_BASH}\" (got \"{other}\")"
                ),
            )),
        },
        None => Ok(fallback.to_string()),
    }
}

fn reject_reserved_name(name: &str) -> Result<()> {
    let lowered = name.trim().trim_start_matches('/').to_lowercase();
    if RESERVED_NAMES.contains(&lowered.as_str()) {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "command name \"{name}\" is reserved by a built-in command; reserved names: {}",
                RESERVED_NAMES.join(", ")
            ),
        ));
    }
    Ok(())
}

fn list_view(db_path: &Path, project_id: Option<&str>) -> Result<Value> {
    let records = load_commands(db_path, project_id)?;
    let items: Vec<Value> = records
        .iter()
        .map(|record| record_to_json(record, false))
        .collect();
    Ok(json!({
        "scope": SCOPE_NAME,
        "file": null,
        "projectId": project_id,
        "count": items.len(),
        "items": items,
        "guidance": GUIDANCE,
    }))
}

fn get_view(db_path: &Path, project_id: Option<&str>, key: &str) -> Result<Value> {
    let records = load_commands(db_path, project_id)?;
    let found = find_command(&records, key);
    Ok(json!({
        "scope": SCOPE_NAME,
        "key": key,
        "value": found.map(|record| record_to_json(record, true)).unwrap_or(Value::Null),
    }))
}

fn set_command(
    db_path: &Path,
    project_id: Option<&str>,
    key: &str,
    value: &Value,
) -> Result<Value> {
    let fields = normalize_fields(value)?;

    if key == NEW_KEY {
        let (scope, scope_project_id) = resolve_create_scope(project_id, &fields)?;
        let name = read_text(&fields, &["name"]).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "value.name is required to create a custom command (config-manage action=set scope=customCommands key=\"{NEW_KEY}\" value={{name: \"deploy\", commandType: \"prompt\", content: \"...\"}})"
                ),
            )
        })?;
        reject_reserved_name(&name)?;
        let command_type = resolve_command_type(&fields, TYPE_PROMPT)?;
        let content = read_text(&fields, &["content"]).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "value.content is required to create a custom command".to_string(),
            )
        })?;
        let item = CustomCommandInput {
            command_id: String::new(),
            scope: scope.clone(),
            project_id: scope_project_id,
            name: name.clone(),
            command_type,
            content,
            description: read_text(&fields, &["description"]).unwrap_or_default(),
            enabled: read_flag(&fields, &["enabled", "enable"]).unwrap_or(true),
            sort_order: 0,
        };
        upsert_custom_command(db_path, &item).map_err(storage_error)?;

        let records = load_commands(db_path, project_id)?;
        let saved = find_by_name(&records, &name, &scope);
        return Ok(json!({
            "scope": SCOPE_NAME,
            "key": NEW_KEY,
            "saved": true,
            "created": true,
            "value": saved.map(|record| record_to_json(record, true)).unwrap_or(Value::Null),
        }));
    }

    let records = load_commands(db_path, project_id)?;
    let existing = find_command(&records, key).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!(
                "custom command \"{key}\" does not exist in this scope; pass key=\"{NEW_KEY}\" with value.name to create it"
            ),
        )
    })?;

    if let Some(requested) = read_text(&fields, &["scope"]).map(|text| text.to_lowercase()) {
        if requested != existing.scope {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "custom command scope cannot be changed (existing scope is \"{}\"); create a new command with key=\"{NEW_KEY}\" instead",
                    existing.scope
                ),
            ));
        }
    }

    let command_id = existing.command_id.clone();
    let command_scope = existing.scope.clone();
    let command_project_id = existing.project_id.clone();
    let name = read_text(&fields, &["name"]).unwrap_or_else(|| existing.name.clone());
    reject_reserved_name(&name)?;
    let command_type = resolve_command_type(&fields, &existing.command_type)?;
    let content = read_text(&fields, &["content"]).unwrap_or_else(|| existing.content.clone());
    let description = match fields.get("description") {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => existing.description.clone(),
    };
    let enabled = read_flag(&fields, &["enabled", "enable"]).unwrap_or(existing.enabled);
    let sort_order = read_int(&fields, "sortOrder").unwrap_or(existing.sort_order);

    let item = CustomCommandInput {
        command_id: command_id.clone(),
        scope: command_scope,
        project_id: command_project_id,
        name,
        command_type,
        content,
        description,
        enabled,
        sort_order,
    };
    upsert_custom_command(db_path, &item).map_err(storage_error)?;

    let records = load_commands(db_path, project_id)?;
    let saved = records
        .iter()
        .find(|record| record.command_id == command_id);
    Ok(json!({
        "scope": SCOPE_NAME,
        "key": key,
        "commandId": command_id,
        "saved": true,
        "created": false,
        "value": saved.map(|record| record_to_json(record, true)).unwrap_or(Value::Null),
    }))
}

fn delete_view(db_path: &Path, project_id: Option<&str>, key: &str) -> Result<Value> {
    let records = load_commands(db_path, project_id)?;
    let Some(existing) = find_command(&records, key) else {
        return Ok(json!({
            "scope": SCOPE_NAME,
            "key": key,
            "deleted": false,
        }));
    };
    let command_id = existing.command_id.clone();
    let name = existing.name.clone();
    let command_scope = existing.scope.clone();
    delete_custom_command(db_path, &command_id).map_err(storage_error)?;
    Ok(json!({
        "scope": SCOPE_NAME,
        "key": key,
        "deleted": true,
        "commandId": command_id,
        "name": name,
        "commandScope": command_scope,
    }))
}

pub(crate) fn execute_custom_commands_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
    project_id: Option<&str>,
) -> Result<Value> {
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    match tool_name {
        "list" => list_view(db_path, project_id),
        TOOL_GET => {
            if key.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "customCommands requires key = commandId (or command name)".to_string(),
                ));
            }
            get_view(db_path, project_id, key)
        }
        TOOL_SET => {
            if key.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "customCommands requires key = commandId (or command name), or key=\"{NEW_KEY}\" to create one"
                    ),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for action=set".to_string(),
                )
            })?;
            set_command(db_path, project_id, key, &value)
        }
        TOOL_DELETE => {
            if key.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "customCommands requires key = commandId (or command name)".to_string(),
                ));
            }
            delete_view(db_path, project_id, key)
        }
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope customCommands: {other}"),
        )),
    }
}
