use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{Map, Value};

use snow_storage_core::database;
use snow_storage_core::models::McpServerConfigRecord;
use snow_storage_core::system_settings;

pub fn list_tool_plugin_server_configs(
    database_path: &Path,
    project_id: Option<&str>,
) -> Result<Vec<McpServerConfigRecord>> {
    let scope = match project_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(project_id) => Some(
            system_settings::get_plugins_project_scope_settings(
                database_path,
                project_id,
            )?,
        ),
        None => None,
    };

    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "list tool plugins", error))?;
    let rows = connection
        .prepare(
            "SELECT plugin_id, manifest_json, install_path FROM app_plugins WHERE enabled = 1 \
             ORDER BY sort_order ASC, plugin_id ASC",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| database::database_error(database_path, "list tool plugins", error))?;

    let mut configs = Vec::new();
    for (plugin_id, manifest_json, install_path) in rows {
        if let Some(scope) = scope.as_ref() {
            // 项目内默认禁用：仅显式启用（pluginOverrides=true）才参与发现。
            if !scope.effective_enabled(&plugin_id, false) {
                continue;
            }
        }
        let Some(servers) = tool_plugin_mcp_servers(&manifest_json) else {
            continue;
        };
        for (server_name, entry) in servers {
            let entry = expand_plugin_dir_placeholder(&entry, &install_path);
            let server_id = format!("plugin:{plugin_id}:{server_name}");
            configs.push(McpServerConfigRecord {
                id: server_id.clone(),
                server_id,
                name: format!("plugin-{plugin_id}-{server_name}"),
                transport_type: entry
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("stdio")
                    .to_string(),
                url: entry
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                command: entry
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                args_json: entry
                    .get("args")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "[]".to_string()),
                env_json: entry
                    .get("env")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "{}".to_string()),
                headers_json: entry
                    .get("headers")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "{}".to_string()),
                enabled: true,
                timeout_ms: entry
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .map(|value| value.clamp(1, i32::MAX as i64) as i32),
                sort_order: 0,
                source: format!("plugin:{plugin_id}"),
                updated_at: String::new(),
            });
        }
    }

    Ok(configs)
}

/// 从清单解析工具插件的 `mcpServers`：安装时已归一化为内联对象，空对象视为无工具。
fn tool_plugin_mcp_servers(manifest_json: &str) -> Option<Map<String, Value>> {
    let parsed: Value = serde_json::from_str(manifest_json).ok()?;
    let servers = parsed.as_object()?.get("mcpServers")?.as_object()?;
    (!servers.is_empty()).then(|| servers.clone())
}

/// 把 `{{pluginDir}}` 替换为插件的安装目录。
///
/// 安装目录直到安装后才确定，清单无法写死路径；因此在派生服务器配置时
/// 对 `command`、`args` 与环境变量值展开占位符，插件即可引用自带脚本。
fn expand_plugin_dir_placeholder(entry: &Value, install_path: &str) -> Value {
    const PLACEHOLDER: &str = "{{pluginDir}}";
    let install_path = install_path.trim();
    if install_path.is_empty() {
        return entry.clone();
    }
    let mut entry = entry.clone();
    let Some(object) = entry.as_object_mut() else {
        return entry;
    };
    if let Some(Value::String(command)) = object.get_mut("command") {
        *command = command.replace(PLACEHOLDER, install_path);
    }
    if let Some(Value::Array(args)) = object.get_mut("args") {
        for arg in args.iter_mut() {
            if let Value::String(text) = arg {
                *text = text.replace(PLACEHOLDER, install_path);
            }
        }
    }
    if let Some(Value::Object(env)) = object.get_mut("env") {
        for value in env.values_mut() {
            if let Value::String(text) = value {
                *text = text.replace(PLACEHOLDER, install_path);
            }
        }
    }
    entry
}