use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::super::database;
use super::super::{McpServerConfigInput, McpServerConfigRecord, ProjectMcpServerConfigRecord};
use super::system_settings;

const PROJECT_MCP_SERVER_SETTING_NAME: &str = "Project MCP server configs";
const PROJECT_MCP_SERVER_SETTING_CODE_PREFIX: &str = "project_mcp_server_configs_";
const PROJECT_MCP_SERVER_SOURCE: &str = "project";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ProjectMcpServerSettings {
    project_id: String,
    servers: Vec<ProjectMcpServerConfig>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ProjectMcpServerConfig {
    server_id: String,
    name: String,
    transport_type: String,
    url: String,
    command: String,
    args_json: String,
    env_json: String,
    headers_json: String,
    enabled: bool,
    timeout_ms: Option<i32>,
    sort_order: i32,
    updated_at: String,
}

pub fn list_project_mcp_server_configs(
    database_path: &Path,
    project_id: &str,
) -> Result<Vec<ProjectMcpServerConfigRecord>> {
    let settings = get_project_mcp_server_settings(database_path, project_id)?;
    Ok(settings.servers.iter().map(to_project_record).collect())
}

pub fn list_effective_mcp_server_configs(
    database_path: &Path,
    project_id: Option<&str>,
) -> Result<Vec<McpServerConfigRecord>> {
    let global_servers = super::mcp_server_configs::list_mcp_server_configs(database_path)?;
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(global_servers);
    };
    let settings = get_project_mcp_server_settings(database_path, project_id)?;
    let mut effective_servers = global_servers;
    let mut server_ids = effective_servers
        .iter()
        .map(|server| server.server_id.clone())
        .collect::<HashSet<_>>();

    for server in &settings.servers {
        if !server_ids.insert(server.server_id.clone()) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Project MCP server id conflicts with a global server: {}",
                    server.server_id
                ),
            ));
        }
        effective_servers.push(to_effective_record(server));
    }

    Ok(effective_servers)
}

pub fn upsert_project_mcp_server_config(
    database_path: &Path,
    project_id: &str,
    item: &McpServerConfigInput,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            upsert_project_mcp_server_config_with_connection(&connection, project_id, item)
        })
        .map_err(|error| {
            database::database_error(database_path, "upsert project MCP server config", error)
        })
}

pub(crate) fn upsert_project_mcp_server_config_with_connection(
    connection: &Connection,
    project_id: &str,
    item: &McpServerConfigInput,
) -> rusqlite::Result<()> {
    let name = normalize_required_value(&item.name, "MCP server name")
        .map_err(project_mcp_error_from_napi)?;
    let transport_type =
        normalize_transport_type(&item.transport_type).map_err(project_mcp_error_from_napi)?;
    let url = item.url.trim().to_string();
    let command = item.command.trim().to_string();
    if transport_type == "http" && url.is_empty() {
        return Err(project_mcp_storage_error("HTTP MCP server URL is required"));
    }
    if transport_type == "stdio" && command.is_empty() {
        return Err(project_mcp_storage_error(
            "Stdio MCP server command is required",
        ));
    }
    validate_json_string_array(&item.args_json, "Args").map_err(project_mcp_error_from_napi)?;
    validate_json_string_object(&item.env_json, "Environment")
        .map_err(project_mcp_error_from_napi)?;
    validate_json_string_object(&item.headers_json, "Headers")
        .map_err(project_mcp_error_from_napi)?;
    if item.timeout_ms.is_some_and(|timeout| timeout <= 0) {
        return Err(project_mcp_storage_error(
            "MCP server timeout must be a positive integer",
        ));
    }

    let global_servers = super::mcp_server_configs::query_mcp_server_configs(connection)?;
    let mut settings = get_project_mcp_server_settings_with_connection(connection, project_id)?;
    let requested_server_id = item.server_id.trim();
    let existing_server_id = (!requested_server_id.is_empty()).then_some(requested_server_id);
    let server_id = existing_server_id
        .map(str::to_string)
        .unwrap_or_else(|| create_project_server_id(&settings.project_id));

    if global_servers
        .iter()
        .any(|server| server.server_id == server_id)
    {
        return Err(project_mcp_storage_error(
            "Project MCP server id conflicts with a global server",
        ));
    }
    if global_servers.iter().any(|server| server.name == name) {
        return Err(project_mcp_storage_error(
            "MCP server name already exists in global scope",
        ));
    }
    if settings
        .servers
        .iter()
        .any(|server| server.server_id != server_id && server.name.trim() == name)
    {
        return Err(project_mcp_storage_error(
            "MCP server name already exists in this project",
        ));
    }

    let updated_at = chrono::Local::now().to_rfc3339();
    if let Some(server) = settings
        .servers
        .iter_mut()
        .find(|server| server.server_id == server_id)
    {
        server.name = name;
        server.transport_type = transport_type;
        server.url = url;
        server.command = command;
        server.args_json = item.args_json.clone();
        server.env_json = item.env_json.clone();
        server.headers_json = item.headers_json.clone();
        server.enabled = item.enabled;
        server.timeout_ms = item.timeout_ms;
        server.sort_order = item.sort_order;
        server.updated_at = updated_at;
    } else {
        settings.servers.push(ProjectMcpServerConfig {
            server_id,
            name,
            transport_type,
            url,
            command,
            args_json: item.args_json.clone(),
            env_json: item.env_json.clone(),
            headers_json: item.headers_json.clone(),
            enabled: item.enabled,
            timeout_ms: item.timeout_ms,
            sort_order: item.sort_order,
            updated_at,
        });
    }

    write_project_mcp_server_settings_with_connection(connection, &settings)
}

pub fn set_project_mcp_server_enabled(
    database_path: &Path,
    project_id: &str,
    server_id: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_server_id = normalize_required_value(server_id, "MCP server id")?;
    let mut settings = get_project_mcp_server_settings(database_path, project_id)?;
    let Some(server) = settings
        .servers
        .iter_mut()
        .find(|server| server.server_id == normalized_server_id)
    else {
        return Err(Error::new(
            Status::InvalidArg,
            "Project MCP server does not exist".to_string(),
        ));
    };
    server.enabled = enabled;
    server.updated_at = chrono::Local::now().to_rfc3339();
    write_project_mcp_server_settings(database_path, &settings)
}

pub fn delete_project_mcp_server_config(
    database_path: &Path,
    project_id: &str,
    server_id: &str,
) -> Result<()> {
    let normalized_server_id = normalize_required_value(server_id, "MCP server id")?;
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            let mut settings =
                get_project_mcp_server_settings_with_connection(&transaction, project_id)?;
            let previous_len = settings.servers.len();
            settings
                .servers
                .retain(|server| server.server_id != normalized_server_id);
            if settings.servers.len() == previous_len {
                return Err(project_mcp_storage_error(
                    "Project MCP server does not exist",
                ));
            }
            write_project_mcp_server_settings_with_connection(&transaction, &settings)?;
            super::import_resources::delete_mcp_tracking_for_target(
                &transaction,
                "project",
                Some(&settings.project_id),
                &normalized_server_id,
            )?;
            transaction.commit()?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "delete project MCP server config", error)
        })
}

fn get_project_mcp_server_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<ProjectMcpServerSettings> {
    database::open_connection(database_path)
        .and_then(|connection| {
            get_project_mcp_server_settings_with_connection(&connection, project_id)
        })
        .map_err(|error| {
            database::database_error(database_path, "read project MCP server settings", error)
        })
}

fn get_project_mcp_server_settings_with_connection(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<ProjectMcpServerSettings> {
    let normalized_project_id = project_id.trim();
    if normalized_project_id.is_empty() {
        return Err(project_mcp_storage_error("Project id is required"));
    }
    let setting_code = project_mcp_server_setting_code(&normalized_project_id);
    let raw_value = connection
        .query_row(
            "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
            [&setting_code],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(raw_value) = raw_value else {
        return Ok(ProjectMcpServerSettings {
            project_id: normalized_project_id.to_string(),
            ..ProjectMcpServerSettings::default()
        });
    };

    let mut settings =
        serde_json::from_str::<ProjectMcpServerSettings>(&raw_value).map_err(|error| {
            project_mcp_storage_error(format!(
                "Failed to parse project MCP server settings: {error}"
            ))
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.to_string();
    }
    if settings.project_id != normalized_project_id {
        return Err(project_mcp_storage_error(
            "Project MCP server setting identity does not match the requested project",
        ));
    }
    Ok(settings)
}

fn write_project_mcp_server_settings(
    database_path: &Path,
    settings: &ProjectMcpServerSettings,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            write_project_mcp_server_settings_with_connection(&connection, settings)
        })
        .map_err(|error| {
            database::database_error(database_path, "write project MCP server settings", error)
        })
}

fn write_project_mcp_server_settings_with_connection(
    connection: &Connection,
    settings: &ProjectMcpServerSettings,
) -> rusqlite::Result<()> {
    let setting_code = project_mcp_server_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        project_mcp_storage_error(format!(
            "Failed to serialize project MCP server settings: {error}"
        ))
    })?;
    system_settings::set_system_setting_with_connection(
        connection,
        PROJECT_MCP_SERVER_SETTING_NAME,
        &setting_code,
        &setting_value,
    )?;
    Ok(())
}

fn project_mcp_storage_error(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        message.into(),
    )))
}

fn project_mcp_error_from_napi(error: Error) -> rusqlite::Error {
    project_mcp_storage_error(error.reason.clone())
}

fn to_project_record(server: &ProjectMcpServerConfig) -> ProjectMcpServerConfigRecord {
    ProjectMcpServerConfigRecord {
        server_id: server.server_id.clone(),
        name: server.name.clone(),
        transport_type: server.transport_type.clone(),
        url: server.url.clone(),
        command: server.command.clone(),
        args_json: server.args_json.clone(),
        env_json: server.env_json.clone(),
        headers_json: server.headers_json.clone(),
        enabled: server.enabled,
        timeout_ms: server.timeout_ms,
        sort_order: server.sort_order,
        source: PROJECT_MCP_SERVER_SOURCE.to_string(),
        updated_at: server.updated_at.clone(),
    }
}

fn to_effective_record(server: &ProjectMcpServerConfig) -> McpServerConfigRecord {
    McpServerConfigRecord {
        id: server.server_id.clone(),
        server_id: server.server_id.clone(),
        name: server.name.clone(),
        transport_type: server.transport_type.clone(),
        url: server.url.clone(),
        command: server.command.clone(),
        args_json: server.args_json.clone(),
        env_json: server.env_json.clone(),
        headers_json: server.headers_json.clone(),
        enabled: server.enabled,
        timeout_ms: server.timeout_ms,
        sort_order: server.sort_order,
        source: PROJECT_MCP_SERVER_SOURCE.to_string(),
        updated_at: server.updated_at.clone(),
    }
}

fn create_project_server_id(project_id: &str) -> String {
    format!(
        "project:{}:{}",
        &blake3::hash(project_id.as_bytes()).to_hex()[..12],
        database::create_snowflake_id()
    )
}

fn project_mcp_server_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_MCP_SERVER_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

fn normalize_transport_type(value: &str) -> Result<String> {
    match value.trim() {
        "stdio" | "local" => Ok("stdio".to_string()),
        "http" => Ok("http".to_string()),
        transport => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported MCP transport: {transport}"),
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

fn validate_json_string_array(value: &str, label: &str) -> Result<()> {
    let parsed = serde_json::from_str::<serde_json::Value>(value).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("{label} must be valid JSON: {error}"),
        )
    })?;
    let valid = parsed
        .as_array()
        .is_some_and(|items| items.iter().all(serde_json::Value::is_string));
    if !valid {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} must be a JSON string array"),
        ));
    }
    Ok(())
}

fn validate_json_string_object(value: &str, label: &str) -> Result<()> {
    let parsed = serde_json::from_str::<serde_json::Value>(value).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("{label} must be valid JSON: {error}"),
        )
    })?;
    let valid = parsed.as_object().is_some_and(|items| {
        items
            .iter()
            .all(|(key, value)| !key.trim().is_empty() && value.is_string())
    });
    if !valid {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} must be a JSON object with string values"),
        ));
    }
    Ok(())
}

impl ProjectMcpServerSettings {
    fn normalize(&mut self) {
        self.project_id = self.project_id.trim().to_string();
        let mut seen_server_ids = BTreeSet::new();
        self.servers.retain_mut(|server| {
            server.server_id = server.server_id.trim().to_string();
            server.name = server.name.trim().to_string();
            server.transport_type = server.transport_type.trim().to_string();
            server.url = server.url.trim().to_string();
            server.command = server.command.trim().to_string();
            server.updated_at = server.updated_at.trim().to_string();
            !server.server_id.is_empty()
                && !server.name.is_empty()
                && seen_server_ids.insert(server.server_id.clone())
        });
        self.servers
            .sort_by_key(|server| (server.sort_order, server.server_id.clone()));
    }
}
