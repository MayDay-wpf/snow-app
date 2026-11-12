use super::*;

#[napi]
pub async fn list_plugins() -> napi::Result<Vec<PluginRecord>> {
    tokio::task::spawn_blocking(|| {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::list_plugins(&database_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn install_plugin(source_dir: String) -> napi::Result<PluginRecord> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::install_plugin(&database_path, &source_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn rescan_plugin(plugin_id: String) -> napi::Result<PluginRecord> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::rescan_plugin(&database_path, &plugin_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_plugin_enabled(plugin_id: String, enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::set_plugin_enabled(&database_path, &plugin_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_plugin(plugin_id: String, delete_files: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::delete_plugin(&database_path, &plugin_id, delete_files)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_plugin_file(plugin_id: String, relative_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::read_plugin_file(&database_path, &plugin_id, &relative_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_plugin_asset(
    plugin_id: String,
    relative_path: String,
) -> napi::Result<Buffer> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::read_plugin_asset(&database_path, &plugin_id, &relative_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_plugin_values(plugin_id: String) -> napi::Result<Vec<PluginStorageValue>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::get_plugin_values(&database_path, &plugin_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_plugin_value(
    plugin_id: String,
    key: String,
    value: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::set_plugin_value(&database_path, &plugin_id, &key, &value)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_plugin_value(plugin_id: String, key: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::delete_plugin_value(&database_path, &plugin_id, &key)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_plugins_directory() -> napi::Result<String> {
    tokio::task::spawn_blocking(|| {
        let directory = crate::storage::plugins_dir()?;
        Ok(directory.to_string_lossy().into_owned())
    })
    .await
    .map_err(map_spawn_error)?
}

/// 工具插件的一个工具（名称 / 描述，供插件页面与 `@` 面板展示）。
#[napi(object)]
pub struct PluginToolInfo {
    pub name: String,
    pub original_name: String,
    pub description: String,
}

/// 工具插件的一个 MCP 服务器及其工具清单。
#[napi(object)]
pub struct PluginToolServerInfo {
    pub plugin_id: String,
    pub server_name: String,
    pub public_server_name: String,
    pub tools: Vec<PluginToolInfo>,
    pub error: Option<String>,
}

/// 发现全部已启用工具插件的工具清单（按项目作用域，不受会话 `@` 门控）。
#[napi]
pub async fn list_plugin_tools(
    project_id: Option<String>,
) -> napi::Result<Vec<PluginToolServerInfo>> {
    let project_id = project_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let servers = crate::mcp::external::discover_plugin_servers(project_id.as_deref()).await?;
    Ok(servers
        .into_iter()
        .map(|server| PluginToolServerInfo {
            plugin_id: server.plugin_id,
            server_name: server.server_name,
            public_server_name: server.public_server_name,
            tools: server
                .tools
                .into_iter()
                .map(|tool| PluginToolInfo {
                    name: tool.tool.name,
                    original_name: tool.original_name,
                    description: tool.tool.description,
                })
                .collect(),
            error: server.error,
        })
        .collect())
}

/// 项目级插件作用域（JSON：`{ "projectId": "...", "pluginOverrides": { "<pluginId>": bool } }`）。
#[napi]
pub async fn get_plugins_project_scope(project_id: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        let settings = crate::storage::services::system_settings::get_plugins_project_scope_settings(
            &database_path,
            &project_id,
        )?;
        serde_json::to_string(&serde_json::json!({
            "projectId": settings.project_id,
            "pluginOverrides": settings.plugin_overrides,
        }))
        .map_err(|error| {
            napi::Error::from_reason(format!("Failed to serialize plugin scope: {error}"))
        })
    })
    .await
    .map_err(map_spawn_error)?
}

/// 设置某插件在该项目内的可用状态（`app_plugins.enabled` 是全局总闸，此处只写项目覆盖）。
#[napi]
pub async fn set_plugins_project_plugin_enabled(
    project_id: String,
    plugin_id: String,
    enabled: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::services::system_settings::set_plugins_project_plugin_enabled(
            &database_path,
            &project_id,
            &plugin_id,
            enabled,
        )
    })
    .await
    .map_err(map_spawn_error)?
}
