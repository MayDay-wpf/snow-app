//! config 服务 `mcpServers` 作用域（DB-backed）：直接管理 App 实际生效的
//! MCP 服务器配置与工具级启停。
//!
//! 真源与应用数据库一致：
//!   - 全局服务器 → `mcp_server_configs` 表（server_id = `global:<name>`）；
//!   - 项目级服务器 → `system_settings` 中按 blake3(projectId) 命名的
//!     `project_mcp_server_configs_*` 记录（server_id = `project:<name>`）；
//!   - 工具级启停（黑名单）→ `mcp_global_scope` / `project_mcp_scope_*`。
//!
//! 与 `settings.mcpServers`（`~/.snow/settings.json` + 差集同步）的区别：那个域是
//! Snow CLI 兼容的同步入口，本域直接读写"生效配置"，不需要经过文件同步。
//!
//! projectId 语义：省略或非空 = 项目级（会话内缺省自动注入当前项目）；
//! 显式传空字符串 `""` = 全局。key = 服务器名（`new` 表示按 value.name 新建）。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use crate::storage::services::mcp_server_configs::{
    delete_mcp_server_config, list_mcp_server_configs, upsert_mcp_server_config,
};
use crate::storage::services::project_mcp_server_configs::{
    delete_project_mcp_server_config, list_project_mcp_server_configs,
    upsert_project_mcp_server_config,
};
use crate::storage::services::system_settings::{
    get_mcp_global_scope_settings, get_mcp_project_scope_settings, set_mcp_global_tools_enabled,
    set_mcp_project_tools_enabled,
};
use crate::storage::{McpServerConfigInput, McpServerConfigRecord, ProjectMcpServerConfigRecord};

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const NEW_KEY: &str = "new";

/// 手工写入的服务器打上 `manual` 标记：Snow CLI 同步只清理 `snow-cli` 来源，
/// 因此本域写入的服务器不会被"同步 Snow CLI MCP 设置"的差集逻辑删掉。
const MANUAL_SOURCE: &str = "manual";

const SUPPORTED_TRANSPORTS: &[&str] = &["stdio", "sse", "http", "api"];

/// 配置写入后对后续工具发现立即生效；已建立的服务器连接可能需要重连。
const APPLY_NOTE: &str = "Server configs are written to the database and picked up by the next tool discovery. A server that already has a live MCP session may need the app to restart (or the session to reconnect) before a changed command/url/env takes effect.";

fn mask_secret(value: &str) -> Value {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        json!("****")
    } else {
        let head: String = chars[..4].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        json!(format!("{head}****{tail}"))
    }
}

/// 把 `{key: value}` 形式的 JSON 字符串转成对象，值全部脱敏（键名保留）。
fn masked_object(json_text: &str) -> Value {
    let Ok(parsed) = serde_json::from_str::<Value>(json_text) else {
        return json!({});
    };
    let Some(object) = parsed.as_object() else {
        return json!({});
    };
    let mut masked = Map::new();
    for (key, value) in object {
        masked.insert(
            key.clone(),
            match value {
                Value::String(text) if !text.trim().is_empty() => mask_secret(text),
                Value::Null => json!("****"),
                other => other.clone(),
            },
        );
    }
    Value::Object(masked)
}

fn json_field(value: &str, fallback: &str) -> Value {
    serde_json::from_str::<Value>(value).unwrap_or_else(|_| json!(fallback))
}

/// 统一的服务器视图：env / headers 值脱敏（键名与结构保留）。
#[allow(clippy::too_many_arguments)]
fn server_view(
    server_id: &str,
    name: &str,
    transport_type: &str,
    url: &str,
    command: &str,
    args_json: &str,
    env_json: &str,
    headers_json: &str,
    enabled: bool,
    timeout_ms: Option<i32>,
    sort_order: i32,
    source: &str,
    updated_at: &str,
) -> Value {
    json!({
        "serverId": server_id,
        "name": name,
        "type": transport_type,
        "url": url,
        "command": command,
        "args": json_field(args_json, "[]"),
        "env": masked_object(env_json),
        "headers": masked_object(headers_json),
        "enabled": enabled,
        "timeoutMs": timeout_ms,
        "sortOrder": sort_order,
        "source": source,
        "updatedAt": updated_at,
    })
}

fn global_view(record: &McpServerConfigRecord) -> Value {
    server_view(
        &record.server_id,
        &record.name,
        &record.transport_type,
        &record.url,
        &record.command,
        &record.args_json,
        &record.env_json,
        &record.headers_json,
        record.enabled,
        record.timeout_ms,
        record.sort_order,
        &record.source,
        &record.updated_at,
    )
}

fn project_view(record: &ProjectMcpServerConfigRecord) -> Value {
    server_view(
        &record.server_id,
        &record.name,
        &record.transport_type,
        &record.url,
        &record.command,
        &record.args_json,
        &record.env_json,
        &record.headers_json,
        record.enabled,
        record.timeout_ms,
        record.sort_order,
        &record.source,
        &record.updated_at,
    )
}

fn scope_state(db_path: &Path, project_id: Option<&str>) -> Result<Value> {
    match project_id {
        Some(project_id) => {
            let settings = get_mcp_project_scope_settings(db_path, project_id)?;
            Ok(json!({
                "scoped": "project",
                "projectId": project_id,
                "disabledTools": settings.disabled_tool_names,
                "disabledServerIds": settings.disabled_server_ids,
                "enabledServerIds": settings.enabled_server_ids,
                "enabledTools": settings.enabled_tool_names,
            }))
        }
        None => {
            let settings = get_mcp_global_scope_settings(db_path)?;
            Ok(json!({
                "scoped": "global",
                "projectId": Value::Null,
                "disabledTools": settings.disabled_tool_names,
                "disabledServerIds": settings.disabled_server_ids,
            }))
        }
    }
}

fn list_servers(db_path: &Path, project_id: Option<&str>) -> Result<(Vec<Value>, Value)> {
    match project_id {
        Some(project_id) => {
            let servers = list_project_mcp_server_configs(db_path, project_id)?
                .iter()
                .map(project_view)
                .collect::<Vec<_>>();
            Ok((servers, scope_state(db_path, Some(project_id))?))
        }
        None => {
            let servers = list_mcp_server_configs(db_path)?
                .iter()
                .map(global_view)
                .collect::<Vec<_>>();
            Ok((servers, scope_state(db_path, None)?))
        }
    }
}

fn find_server(db_path: &Path, project_id: Option<&str>, key: &str) -> Result<Option<Value>> {
    let normalized = key.trim();
    let (servers, _) = list_servers(db_path, project_id)?;
    Ok(servers.into_iter().find(|server| {
        let name = server.get("name").and_then(Value::as_str).unwrap_or("");
        let server_id = server
            .get("serverId")
            .and_then(Value::as_str)
            .unwrap_or("");
        name == normalized || server_id == normalized
    }))
}

fn read_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn read_json_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).map(|field| match field {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
    })
}

fn read_bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn normalize_transport(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    if SUPPORTED_TRANSPORTS.contains(&lowered.as_str()) {
        lowered
    } else {
        "stdio".to_string()
    }
}

/// 应用工具级启停：`tools: { toolName: bool }` 与 `disabledTools: [toolName]`。
fn apply_tool_scope(
    db_path: &Path,
    project_id: Option<&str>,
    value: &Value,
) -> Result<Vec<String>> {
    let mut changed = Vec::new();

    if let Some(Value::Object(tools)) = value.get("tools") {
        let mut enabled = Vec::new();
        let mut disabled = Vec::new();
        for (tool_name, state) in tools {
            match state.as_bool() {
                Some(true) => enabled.push(tool_name.clone()),
                Some(false) => disabled.push(tool_name.clone()),
                None => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!("tools[\"{tool_name}\"] must be a boolean"),
                    ))
                }
            }
        }
        match project_id {
            Some(project_id) => {
                if !enabled.is_empty() {
                    set_mcp_project_tools_enabled(db_path, project_id, &enabled, true)?;
                }
                if !disabled.is_empty() {
                    set_mcp_project_tools_enabled(db_path, project_id, &disabled, false)?;
                }
            }
            None => {
                if !enabled.is_empty() {
                    set_mcp_global_tools_enabled(db_path, &enabled, true)?;
                }
                if !disabled.is_empty() {
                    set_mcp_global_tools_enabled(db_path, &disabled, false)?;
                }
            }
        }
        changed.extend(enabled);
        changed.extend(disabled);
    }

    if let Some(Value::Array(items)) = value.get("disabledTools") {
        let mut names = Vec::new();
        for item in items {
            let name = item.as_str().map(str::trim).filter(|text| !text.is_empty());
            match name {
                Some(name) => names.push(name.to_string()),
                None => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "disabledTools must be an array of tool names".to_string(),
                    ))
                }
            }
        }
        if !names.is_empty() {
            match project_id {
                Some(project_id) => {
                    set_mcp_project_tools_enabled(db_path, project_id, &names, false)?
                }
                None => set_mcp_global_tools_enabled(db_path, &names, false)?,
            }
        }
        changed.extend(names);
    }

    Ok(changed)
}

fn set_server(
    db_path: &Path,
    project_id: Option<&str>,
    key: &str,
    value: &Value,
) -> Result<Value> {
    let changes_tool_search = value.get("tools").and_then(Value::as_object).is_some_and(|tools| {
        tools.keys().any(|name| name.starts_with("toolSearch-"))
    }) || value.get("disabledTools").and_then(Value::as_array).is_some_and(|items| {
        items.iter().any(|item| {
            item.as_str().is_some_and(|name| name.starts_with("toolSearch-"))
        })
    });
    if changes_tool_search {
        return Err(Error::from_reason(
            crate::mcp::servers::tool_search::AUTOMATIC_ONLY,
        ));
    }
    let existing = if key == NEW_KEY {
        None
    } else {
        let current = find_server(db_path, project_id, key)?;
        if current.is_none() {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "MCP server \"{key}\" does not exist in this scope; pass key=\"new\" with a name to create it"
                ),
            ));
        }
        current
    };

    let name = match existing.as_ref().and_then(|server| read_string_field(server, "name")) {
        Some(name) => name,
        None => read_string_field(value, "name").ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "Creating an MCP server requires a non-empty `name`".to_string(),
            )
        })?,
    };

    let pick = |field: &str, fallback: &str| -> String {
        read_string_field(value, field)
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|server| read_string_field(server, field))
            })
            .unwrap_or_else(|| fallback.to_string())
    };

    let transport_type = match read_string_field(value, "type") {
        Some(raw) => normalize_transport(&raw),
        None => existing
            .as_ref()
            .and_then(|server| read_string_field(server, "type"))
            .map(|raw| normalize_transport(&raw))
            .unwrap_or_else(|| "stdio".to_string()),
    };
    let url = pick("url", "");
    let command = pick("command", "");

    if transport_type == "stdio" && command.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "A stdio MCP server requires a non-empty `command`".to_string(),
        ));
    }
    if matches!(transport_type.as_str(), "http" | "sse") && url.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("A {transport_type} MCP server requires a non-empty `url`"),
        ));
    }

    let args_json = read_json_field(value, "args")
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|server| read_json_field(server, "args"))
        })
        .unwrap_or_else(|| "[]".to_string());
    let env_json = read_json_field(value, "env")
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|server| read_json_field(server, "env"))
        })
        .unwrap_or_else(|| "{}".to_string());
    let headers_json = read_json_field(value, "headers")
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|server| read_json_field(server, "headers"))
        })
        .unwrap_or_else(|| "{}".to_string());
    let enabled = read_bool_field(value, "enabled")
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|server| server.get("enabled"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);
    let timeout_ms = value
        .get("timeoutMs")
        .and_then(Value::as_i64)
        .map(|timeout| timeout as i32)
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|server| server.get("timeoutMs"))
                .and_then(Value::as_i64)
                .map(|timeout| timeout as i32)
        })
        .filter(|timeout| *timeout > 0);
    let sort_order = existing
        .as_ref()
        .and_then(|server| server.get("sortOrder"))
        .and_then(Value::as_i64)
        .unwrap_or_else(|| {
            let (servers, _) = list_servers(db_path, project_id).unwrap_or((Vec::new(), json!(null)));
            servers.len() as i64
        }) as i32;

    let server_id = match project_id {
        Some(_) => format!("project:{name}"),
        None => format!("global:{name}"),
    };

    let input = McpServerConfigInput {
        server_id: server_id.clone(),
        name: name.clone(),
        transport_type,
        url,
        command,
        args_json,
        env_json,
        headers_json,
        enabled,
        timeout_ms,
        sort_order,
        source: MANUAL_SOURCE.to_string(),
    };

    match project_id {
        Some(project_id) => upsert_project_mcp_server_config(db_path, project_id, &input)?,
        None => upsert_mcp_server_config(db_path, &input)?,
    }

    let changed_tools = apply_tool_scope(db_path, project_id, value)?;
    let (_, state) = list_servers(db_path, project_id)?;
    let server = find_server(db_path, project_id, &name)?;

    Ok(json!({
        "scope": "mcpServers",
        "key": key,
        "note": APPLY_NOTE,
        "changedTools": changed_tools,
        "value": server,
        "state": state,
    }))
}

fn delete_server(db_path: &Path, project_id: Option<&str>, key: &str) -> Result<Value> {
    let server = find_server(db_path, project_id, key)?.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("MCP server \"{key}\" does not exist in this scope"),
        )
    })?;
    let server_id = server
        .get("serverId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    match project_id {
        Some(project_id) => delete_project_mcp_server_config(db_path, project_id, &server_id)?,
        None => delete_mcp_server_config(db_path, &server_id)?,
    }

    Ok(json!({
        "scope": "mcpServers",
        "key": key,
        "deleted": true,
        "serverId": server_id,
        "note": APPLY_NOTE,
    }))
}

/// Dispatches the `config-manage` list/get/set/delete actions for the `mcpServers` scope.
pub(crate) fn execute_mcp_servers_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
    project_id: Option<&str>,
) -> Result<Value> {
    match tool_name {
        "list" => {
            let (servers, state) = list_servers(db_path, project_id)?;
            Ok(json!({
                "scope": "mcpServers",
                "file": null,
                "note": APPLY_NOTE,
                "count": servers.len(),
                "state": state,
                "keys": [{
                    "key": "servers",
                    "type": "array",
                    "sensitive": false,
                    "configured": true,
                    "value": servers,
                }],
            }))
        }
        TOOL_GET => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if key.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "mcpServers requires key = server name (or serverId)".to_string(),
                ));
            }
            let (_, state) = list_servers(db_path, project_id)?;
            let server = find_server(db_path, project_id, key)?.ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("MCP server \"{key}\" does not exist in this scope"),
                )
            })?;
            Ok(json!({
                "scope": "mcpServers",
                "key": key,
                "state": state,
                "value": server,
            }))
        }
        TOOL_SET => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if key.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "mcpServers requires key = server name, or key=\"new\" to create one".to_string(),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for action=set".to_string(),
                )
            })?;
            if !value.is_object() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "mcpServers value must be an object".to_string(),
                ));
            }
            set_server(db_path, project_id, key, &value)
        }
        "delete" => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if key.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "mcpServers requires key = server name (or serverId)".to_string(),
                ));
            }
            delete_server(db_path, project_id, key)
        }
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope mcpServers: {other}"),
        )),
    }
}
