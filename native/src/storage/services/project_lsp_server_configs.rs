//! 项目级 LSP 服务器配置（system_settings JSON 存储，照 project_mcp_server_configs 模式）。
//!
//! 项目配置**覆盖**全局同 lang 配置（list_effective_lsp_server_configs），
//! 未配置的 lang 回退全局。会话粒度 (语言 × 项目根) 天然支持按项目独立进程。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::super::database;
use super::super::{LspServerConfigInput, LspServerConfigRecord};
use super::system_settings;

const PROJECT_LSP_SERVER_SETTING_NAME: &str = "Project LSP server configs";
const PROJECT_LSP_SERVER_SETTING_CODE_PREFIX: &str = "project_lsp_server_configs_";
const PROJECT_LSP_SERVER_SOURCE: &str = "project";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ProjectLspServerSettings {
    project_id: String,
    servers: Vec<ProjectLspServerConfig>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ProjectLspServerConfig {
    lang: String,
    command: String,
    args_json: String,
    file_extensions_json: String,
    install_command: Option<String>,
    initialization_options_json: Option<String>,
    enabled: bool,
    sort_order: i32,
    source: String,
    updated_at: String,
}

fn project_lsp_server_setting_code(project_id: &str) -> String {
    format!("{PROJECT_LSP_SERVER_SETTING_CODE_PREFIX}{project_id}")
}

fn lsp_storage_error(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        message.into(),
    )))
}

fn to_record(project_id: &str, config: &ProjectLspServerConfig) -> LspServerConfigRecord {
    LspServerConfigRecord {
        id: format!("project:{project_id}:{}", config.lang),
        lang: config.lang.clone(),
        command: config.command.clone(),
        args_json: config.args_json.clone(),
        file_extensions_json: config.file_extensions_json.clone(),
        install_command: config.install_command.clone(),
        initialization_options_json: config.initialization_options_json.clone(),
        enabled: config.enabled,
        sort_order: config.sort_order,
        source: config.source.clone(),
        updated_at: config.updated_at.clone(),
    }
}

/// 项目级配置列表。
pub fn list_project_lsp_server_configs(
    database_path: &Path,
    project_id: &str,
) -> Result<Vec<LspServerConfigRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            get_project_lsp_server_settings_with_connection(&connection, project_id)
        })
        .map(|settings| {
            settings
                .servers
                .iter()
                .map(|config| to_record(project_id, config))
                .collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "list project LSP server configs", error)
        })
}

/// 有效配置：项目配置覆盖全局同 lang（项目优先，§8.5）。
pub fn list_effective_lsp_server_configs(
    database_path: &Path,
    project_id: Option<&str>,
) -> Result<Vec<LspServerConfigRecord>> {
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return super::lsp_server_configs::list_lsp_server_configs(database_path);
    };

    let connection = database::open_connection(database_path).map_err(|error| {
        database::database_error(database_path, "list effective LSP server configs", error)
    })?;
    let global_records = super::lsp_server_configs::query_lsp_server_configs(&connection)
        .map_err(|error| {
            database::database_error(database_path, "list effective LSP server configs", error)
        })?;
    let project_settings = get_project_lsp_server_settings_with_connection(&connection, project_id)
        .map_err(|error| {
            database::database_error(database_path, "list effective LSP server configs", error)
        })?;

    let mut effective = global_records;
    // 项目覆盖：先移除全局同 lang，再追加项目记录。
    let mut project_langs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for config in &project_settings.servers {
        project_langs.insert(config.lang.clone());
    }
    effective.retain(|record| !project_langs.contains(&record.lang));
    let mut project_records: Vec<LspServerConfigRecord> = project_settings
        .servers
        .iter()
        .map(|config| to_record(project_id, config))
        .collect();
    effective.append(&mut project_records);
    effective.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.lang.cmp(&b.lang)));
    Ok(effective)
}

/// 新增/更新项目级配置（lang 冲突更新）。
pub fn upsert_project_lsp_server_config(
    database_path: &Path,
    project_id: &str,
    item: &LspServerConfigInput,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            upsert_project_lsp_server_config_with_connection(&connection, project_id, item)
        })
        .map_err(|error| {
            database::database_error(database_path, "upsert project LSP server config", error)
        })
}

fn upsert_project_lsp_server_config_with_connection(
    connection: &Connection,
    project_id: &str,
    item: &LspServerConfigInput,
) -> rusqlite::Result<()> {
    let lang = item.lang.trim();
    if lang.is_empty() {
        return Err(lsp_storage_error("Language is required"));
    }
    if item.command.trim().is_empty() {
        return Err(lsp_storage_error("Command is required"));
    }

    let mut settings = get_project_lsp_server_settings_with_connection(connection, project_id)?;
    let updated_at = chrono::Local::now().to_rfc3339();
    if let Some(server) = settings
        .servers
        .iter_mut()
        .find(|server| server.lang == lang)
    {
        server.command = item.command.trim().to_string();
        server.args_json = item.args_json.clone();
        server.file_extensions_json = item.file_extensions_json.clone();
        server.install_command = item.install_command.clone();
        server.initialization_options_json = item.initialization_options_json.clone();
        server.enabled = item.enabled;
        server.sort_order = item.sort_order;
        server.source = PROJECT_LSP_SERVER_SOURCE.to_string();
        server.updated_at = updated_at;
    } else {
        settings.servers.push(ProjectLspServerConfig {
            lang: lang.to_string(),
            command: item.command.trim().to_string(),
            args_json: item.args_json.clone(),
            file_extensions_json: item.file_extensions_json.clone(),
            install_command: item.install_command.clone(),
            initialization_options_json: item.initialization_options_json.clone(),
            enabled: item.enabled,
            sort_order: item.sort_order,
            source: PROJECT_LSP_SERVER_SOURCE.to_string(),
            updated_at,
        });
    }
    settings.servers.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.lang.cmp(&b.lang)));

    write_project_lsp_server_settings_with_connection(connection, &settings)
}

/// 删除项目级配置。
pub fn delete_project_lsp_server_config(
    database_path: &Path,
    project_id: &str,
    lang: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            delete_project_lsp_server_config_with_connection(&connection, project_id, lang)
        })
        .map_err(|error| {
            database::database_error(database_path, "delete project LSP server config", error)
        })
}

/// 清空项目级全部配置（config-manage action=delete scope=lsp-config projectId=... 用）。
pub fn clear_project_lsp_server_configs(
    database_path: &Path,
    project_id: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut settings =
                get_project_lsp_server_settings_with_connection(&connection, project_id)?;
            settings.servers.clear();
            write_project_lsp_server_settings_with_connection(&connection, &settings)
        })
        .map_err(|error| {
            database::database_error(database_path, "clear project LSP server configs", error)
        })
}

fn delete_project_lsp_server_config_with_connection(
    connection: &Connection,
    project_id: &str,
    lang: &str,
) -> rusqlite::Result<()> {
    let normalized_lang = lang.trim();
    if normalized_lang.is_empty() {
        return Err(lsp_storage_error("Language is required"));
    }
    let mut settings = get_project_lsp_server_settings_with_connection(connection, project_id)?;
    let previous_len = settings.servers.len();
    settings
        .servers
        .retain(|server| server.lang != normalized_lang);
    if settings.servers.len() == previous_len {
        return Err(lsp_storage_error(format!(
            "Project LSP server for language \"{normalized_lang}\" does not exist"
        )));
    }
    write_project_lsp_server_settings_with_connection(connection, &settings)
}

fn get_project_lsp_server_settings_with_connection(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<ProjectLspServerSettings> {
    let normalized_project_id = project_id.trim();
    if normalized_project_id.is_empty() {
        return Err(lsp_storage_error("Project id is required"));
    }
    let setting_code = project_lsp_server_setting_code(normalized_project_id);
    let raw_value = connection
        .query_row(
            "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
            [&setting_code],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(raw_value) = raw_value else {
        return Ok(ProjectLspServerSettings {
            project_id: normalized_project_id.to_string(),
            ..ProjectLspServerSettings::default()
        });
    };

    let mut settings = serde_json::from_str::<ProjectLspServerSettings>(&raw_value).map_err(
        |error| {
            lsp_storage_error(format!(
                "Failed to parse project LSP server settings: {error}"
            ))
        },
    )?;
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.to_string();
    }
    if settings.project_id != normalized_project_id {
        return Err(lsp_storage_error(
            "Project LSP server setting identity does not match the requested project",
        ));
    }
    Ok(settings)
}

fn write_project_lsp_server_settings_with_connection(
    connection: &Connection,
    settings: &ProjectLspServerSettings,
) -> rusqlite::Result<()> {
    let setting_code = project_lsp_server_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        lsp_storage_error(format!(
            "Failed to serialize project LSP server settings: {error}"
        ))
    })?;
    system_settings::set_system_setting_with_connection(
        connection,
        PROJECT_LSP_SERVER_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}
