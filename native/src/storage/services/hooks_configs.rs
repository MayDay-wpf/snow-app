use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::OptionalExtension;
use serde_json::Value;

use super::super::database;
use super::super::{HookConfigInput, HookConfigRecord};
use super::system_settings;

const HOOKS_SETTING_NAME: &str = "Hooks config";
const HOOKS_GLOBAL_SETTING_CODE: &str = "hooks_global";
const HOOKS_PROJECT_SETTING_CODE_PREFIX: &str = "hooks_project_";

const SUPPORTED_HOOK_TYPES: &[&str] = &[
    "onUserMessage",
    "beforeToolCall",
    "toolConfirmation",
    "afterToolCall",
    "onSubAgentComplete",
    "beforeCompress",
    "onSessionStart",
    "onStop",
    "beforeSubAgentStart",
];

pub fn list_hook_configs(
    database_path: &Path,
    scope: &str,
    project_id: Option<&str>,
) -> Result<Vec<HookConfigRecord>> {
    let normalized_scope = normalize_scope(scope)?;
    let normalized_project_id = normalize_project_id_for_scope(&normalized_scope, project_id)?;

    let setting_code = setting_code_for(&normalized_scope, normalized_project_id.as_deref());
    let (raw_value, updated_at) = read_hooks_setting(database_path, &setting_code)?;

    let records = match raw_value {
        Some(json) => parse_hook_configs(
            &json,
            &normalized_scope,
            normalized_project_id.as_deref(),
            updated_at.as_deref(),
        )?,
        None => Vec::new(),
    };

    Ok(records)
}

pub fn upsert_hook_config(database_path: &Path, item: &HookConfigInput) -> Result<()> {
    let normalized_scope = normalize_scope(&item.scope)?;
    let normalized_project_id =
        normalize_project_id_for_scope(&normalized_scope, item.project_id.as_deref())?;
    let normalized_hook_type = normalize_hook_type(&item.hook_type)?;
    validate_rules_json(&item.rules_json, &normalized_hook_type)?;

    let setting_code = setting_code_for(&normalized_scope, normalized_project_id.as_deref());
    let (existing_value, _) = read_hooks_setting(database_path, &setting_code)?;

    let mut root: serde_json::Map<String, Value> = match existing_value.as_deref() {
        Some(json) if !json.trim().is_empty() => match serde_json::from_str::<Value>(json) {
            Ok(Value::Object(map)) => map,
            Ok(_) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    "Hooks config JSON must be an object".to_string(),
                ));
            }
            Err(error) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse hooks config JSON: {error}"),
                ));
            }
        },
        _ => serde_json::Map::new(),
    };

    let parsed_rules: Value = serde_json::from_str(&item.rules_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Hook rules JSON is invalid: {error}"),
        )
    })?;

    root.insert(normalized_hook_type.clone(), parsed_rules);

    let serialized = serde_json::to_string(&Value::Object(root)).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize hooks config JSON: {error}"),
        )
    })?;

    system_settings::set_system_setting(
        database_path,
        HOOKS_SETTING_NAME,
        &setting_code,
        &serialized,
    )
}

pub fn delete_hook_config(
    database_path: &Path,
    hook_type: &str,
    scope: &str,
    project_id: Option<&str>,
) -> Result<()> {
    let normalized_scope = normalize_scope(scope)?;
    let normalized_project_id = normalize_project_id_for_scope(&normalized_scope, project_id)?;
    let normalized_hook_type = normalize_hook_type(hook_type)?;

    let setting_code = setting_code_for(&normalized_scope, normalized_project_id.as_deref());
    let (existing_value, _) = read_hooks_setting(database_path, &setting_code)?;

    let mut root: serde_json::Map<String, Value> = match existing_value.as_deref() {
        Some(json) if !json.trim().is_empty() => match serde_json::from_str::<Value>(json) {
            Ok(Value::Object(map)) => map,
            Ok(_) => serde_json::Map::new(),
            Err(_) => serde_json::Map::new(),
        },
        _ => serde_json::Map::new(),
    };

    root.remove(&normalized_hook_type);

    let serialized = serde_json::to_string(&Value::Object(root)).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize hooks config JSON: {error}"),
        )
    })?;

    system_settings::set_system_setting(
        database_path,
        HOOKS_SETTING_NAME,
        &setting_code,
        &serialized,
    )
}

fn normalize_scope(value: &str) -> Result<String> {
    match value.trim() {
        "global" => Ok("global".to_string()),
        "project" => Ok("project".to_string()),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported hook scope: {other}"),
        )),
    }
}

fn normalize_project_id_for_scope(scope: &str, project_id: Option<&str>) -> Result<Option<String>> {
    if scope == "global" {
        return Ok(None);
    }

    match project_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(id) => Ok(Some(id.to_string())),
        None => Err(Error::new(
            Status::InvalidArg,
            "Project id is required for project scope".to_string(),
        )),
    }
}

fn normalize_hook_type(value: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Hook type is required".to_string(),
        ));
    }

    if !SUPPORTED_HOOK_TYPES.contains(&normalized) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported hook type: {normalized}"),
        ));
    }

    Ok(normalized.to_string())
}

/// 校验 rules JSON 的结构（规则数组、description、hooks 数组、action 类型）。
/// 供 hooks_configs 的 upsert 与 config 内置工具的 hooks scope 复用。
pub(crate) fn validate_rules_json(rules_json: &str, hook_type: &str) -> Result<()> {
    let parsed: Value = serde_json::from_str(rules_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Hook rules JSON is invalid: {error}"),
        )
    })?;

    let rules = parsed.as_array().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Hook rules JSON must be an array".to_string(),
        )
    })?;

    for rule in rules {
        let rule_obj = rule.as_object().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "Each hook rule must be a JSON object".to_string(),
            )
        })?;

        if !rule_obj.contains_key("description") {
            return Err(Error::new(
                Status::InvalidArg,
                "Hook rule must contain a description field".to_string(),
            ));
        }

        let hooks = rule_obj
            .get("hooks")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "Hook rule must contain a hooks array".to_string(),
                )
            })?;

        for action in hooks {
            let action_obj = action.as_object().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "Each hook action must be a JSON object".to_string(),
                )
            })?;

            let action_type = action_obj
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "Hook action must contain a type field".to_string(),
                    )
                })?;

            if !is_action_type_allowed(hook_type, action_type) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Hook action type '{action_type}' is not allowed for hook '{hook_type}'"
                    ),
                ));
            }
        }
    }

    Ok(())
}

fn is_action_type_allowed(hook_type: &str, action_type: &str) -> bool {
    match action_type {
        "command" => true,
        "prompt" => hook_type == "onSubAgentComplete" || hook_type == "onStop",
        "context" => {
            hook_type == "onSessionStart"
                || hook_type == "onUserMessage"
                || hook_type == "beforeSubAgentStart"
        }
        _ => false,
    }
}

fn setting_code_for(scope: &str, project_id: Option<&str>) -> String {
    match scope {
        "project" => {
            let id = project_id.unwrap_or("");
            format!(
                "{HOOKS_PROJECT_SETTING_CODE_PREFIX}{}",
                blake3::hash(id.as_bytes()).to_hex()
            )
        }
        _ => HOOKS_GLOBAL_SETTING_CODE.to_string(),
    }
}

fn read_hooks_setting(
    database_path: &Path,
    setting_code: &str,
) -> Result<(Option<String>, Option<String>)> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT setting_value, updated_at FROM system_settings WHERE setting_code = ?1",
                    [setting_code],
                    |row| {
                        let value: String = row.get(0)?;
                        let updated_at: String = row.get(1)?;
                        Ok((value, updated_at))
                    },
                )
                .optional()
                .map(|result| match result {
                    Some((value, updated_at)) => (Some(value), Some(updated_at)),
                    None => (None, None),
                })
        })
        .map_err(|error| database::database_error(database_path, "read hooks config", error))
}

fn parse_hook_configs(
    json: &str,
    scope: &str,
    project_id: Option<&str>,
    updated_at: Option<&str>,
) -> Result<Vec<HookConfigRecord>> {
    let obj: serde_json::Map<String, Value> = if json.trim().is_empty() {
        serde_json::Map::new()
    } else {
        match serde_json::from_str::<Value>(json) {
            Ok(Value::Object(map)) => map,
            Ok(_) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    "Hooks config JSON must be an object".to_string(),
                ));
            }
            Err(error) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse hooks config JSON: {error}"),
                ));
            }
        }
    };

    let mut keys: Vec<String> = obj.keys().cloned().collect();
    keys.sort();

    let project_id_str = project_id.unwrap_or("").to_string();
    let updated_at_str = updated_at.unwrap_or("").to_string();
    let mut records = Vec::new();

    for key in keys {
        if let Some(rules) = obj.get(&key) {
            let rules_json = serde_json::to_string(rules).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize hook rules: {error}"),
                )
            })?;
            records.push(HookConfigRecord {
                hook_type: key,
                scope: scope.to_string(),
                project_id: project_id_str.clone(),
                rules_json,
                updated_at: updated_at_str.clone(),
            });
        }
    }

    Ok(records)
}
