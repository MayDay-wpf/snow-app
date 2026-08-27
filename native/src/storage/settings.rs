use std::fs;

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::ensure_database_file;
use super::models::*;
use super::services;

pub fn get_system_setting_value(setting_code: String) -> Result<Option<String>> {
    let database_path = ensure_database_file()?;
    services::system_settings::get_system_setting_value(&database_path, &setting_code)
}

pub fn set_system_setting(
    setting_name: String,
    setting_code: String,
    setting_value: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_system_setting(
        &database_path,
        &setting_name,
        &setting_code,
        &setting_value,
    )
}

pub fn delete_system_setting(setting_code: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::delete_system_setting(&database_path, &setting_code)
}

pub fn get_yolo_mode() -> Result<bool> {
    let database_path = ensure_database_file()?;
    services::yolo_settings::get_yolo_mode(&database_path)
}

pub fn set_yolo_mode(enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::yolo_settings::set_yolo_mode(&database_path, enabled)
}

pub fn get_lite_mode() -> Result<bool> {
    let database_path = ensure_database_file()?;
    services::system_settings::get_lite_mode(&database_path)
}

pub fn set_lite_mode(enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_lite_mode(&database_path, enabled)
}

pub fn get_auto_format() -> Result<bool> {
    let database_path = ensure_database_file()?;
    services::system_settings::get_auto_format(&database_path)
}

pub fn set_auto_format(enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_auto_format(&database_path, enabled)
}

pub fn get_request_logging() -> Result<bool> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::get_request_logging(&database_path)
}

pub fn set_request_logging(enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::set_request_logging(&database_path, enabled)
}

pub fn get_request_logging_expiry() -> Result<i64> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::get_request_logging_expiry(&database_path)
}

pub fn set_request_logging_expiry(expires_at_ms: i64) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::request_logging_settings::set_request_logging_expiry(&database_path, expires_at_ms)
}

pub fn get_privacy_settings() -> Result<services::system_settings::PrivacySettings> {
    let database_path = ensure_database_file()?;
    services::privacy_settings::get_privacy_settings(&database_path)
}

pub fn set_privacy_settings(settings: services::system_settings::PrivacySettings) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::privacy_settings::set_privacy_settings(&database_path, &settings)
}

pub fn get_theme_settings() -> Result<services::system_settings::ThemeSettings> {
    let database_path = ensure_database_file()?;
    services::theme_settings::get_theme_settings(&database_path)
}

pub fn set_theme_settings(settings: services::system_settings::ThemeSettings) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::theme_settings::set_theme_settings(&database_path, &settings)
}

pub fn get_codebase_project_scope_settings(
    project_id: String,
) -> Result<CodebaseProjectScopeSettings> {
    let database_path = ensure_database_file()?;
    let settings = services::system_settings::get_codebase_project_scope_settings(
        &database_path,
        &project_id,
    )?;
    Ok(CodebaseProjectScopeSettings {
        project_id: settings.project_id,
        enabled: settings.enabled,
        enable_agent_review: settings.enable_agent_review,
        enable_reranking: settings.enable_reranking,
    })
}

pub fn set_codebase_project_enabled(project_id: String, enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_codebase_project_enabled(&database_path, &project_id, enabled)
}

pub fn set_codebase_project_agent_review(project_id: String, enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_codebase_project_agent_review(
        &database_path,
        &project_id,
        enabled,
    )
}

pub fn set_codebase_project_reranking(project_id: String, enabled: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_codebase_project_reranking(&database_path, &project_id, enabled)
}

pub fn list_tool_approval_project_approved_tools(project_id: String) -> Result<Vec<String>> {
    let database_path = ensure_database_file()?;
    services::system_settings::list_tool_approval_project_approved_tools(
        &database_path,
        &project_id,
    )
}

pub fn set_tool_approval_project_tool_approved(
    project_id: String,
    tool_name: String,
    approved: bool,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_tool_approval_project_tool_approved(
        &database_path,
        &project_id,
        &tool_name,
        approved,
    )
}

pub fn set_tool_approval_project_tools_approved(
    project_id: String,
    tool_names: Vec<String>,
    approved: bool,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_tool_approval_project_tools_approved(
        &database_path,
        &project_id,
        &tool_names,
        approved,
    )
}

/// 读取全局免审批工具列表（`~/.snow/permissions.json` 的 `alwaysApprovedTools`）。
/// 文件不存在或字段缺失时返回空列表。
pub fn get_always_approved_tools() -> Result<Vec<String>> {
    let Some(file_path) = dirs_next::home_dir().map(|home| home.join(".snow").join("permissions.json"))
    else {
        return Ok(Vec::new());
    };
    let content = match fs::read_to_string(&file_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Failed to read {}: {error}", file_path.display()),
            ));
        }
    };
    let root = match serde_json::from_str::<Value>(&content) {
        Ok(root) => root,
        Err(error) => {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Invalid JSON in {}: {error}", file_path.display()),
            ));
        }
    };
    match root.get("alwaysApprovedTools") {
        Some(Value::Array(items)) => Ok(items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()),
        _ => Ok(Vec::new()),
    }
}

/// 写入全局免审批工具列表（`~/.snow/permissions.json` 的 `alwaysApprovedTools`）。
/// 保留文件中其它字段，原子写入（tmp + rename），避免崩溃损坏配置。
pub fn set_always_approved_tools(tools: Vec<String>) -> Result<()> {
    let Some(file_path) = dirs_next::home_dir().map(|home| home.join(".snow").join("permissions.json"))
    else {
        return Err(Error::new(
            Status::GenericFailure,
            "Cannot resolve home directory".to_string(),
        ));
    };

    let mut root = match fs::read_to_string(&file_path) {
        Ok(content) => serde_json::from_str::<Value>(&content).unwrap_or_else(|_| {
            Value::Object(serde_json::Map::new())
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Value::Object(serde_json::Map::new())
        }
        Err(error) => {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Failed to read {}: {error}", file_path.display()),
            ));
        }
    };
    if !root.is_object() {
        root = Value::Object(serde_json::Map::new());
    }
    root["alwaysApprovedTools"] = Value::Array(
        tools.into_iter().map(Value::String).collect(),
    );

    let content = serde_json::to_string_pretty(&root).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize {}: {error}", file_path.display()),
        )
    })?;

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Failed to create directory '{}': {error}",
                    parent.display()
                ),
            )
        })?;
    }
    let tmp_path = file_path.with_extension("json.tmp");
    fs::write(&tmp_path, &content).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write {}: {error}", tmp_path.display()),
        )
    })?;
    fs::rename(&tmp_path, &file_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        Error::new(
            Status::GenericFailure,
            format!("Failed to replace {}: {error}", file_path.display()),
        )
    })?;
    Ok(())
}

/// 读取图库自定义保存目录（空字符串表示使用默认目录）。
pub fn get_image_library_dir() -> Result<String> {
    let database_path = ensure_database_file()?;
    services::system_settings::get_image_library_dir(&database_path)
}

/// 设置图库自定义保存目录（传入空字符串重置为默认目录）。
pub fn set_image_library_dir(dir: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_image_library_dir(&database_path, &dir)
}

// ===== Keyboard shortcuts =====

pub fn get_keyboard_shortcuts_settings(
) -> Result<services::keyboard_shortcuts::KeyboardShortcutsSettings> {
    let database_path = ensure_database_file()?;
    services::keyboard_shortcuts::get_keyboard_shortcuts_settings(&database_path)
}

pub fn set_keyboard_shortcuts_settings(
    settings: services::keyboard_shortcuts::KeyboardShortcutsSettings,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::keyboard_shortcuts::set_keyboard_shortcuts_settings(&database_path, &settings)
}
