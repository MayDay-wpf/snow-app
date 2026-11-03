//! 子代理配置与敏感命令配置的 NAPI 转发。

use super::*;

#[napi]
pub async fn list_sub_agent_configs(
    project_id: Option<String>,
) -> napi::Result<Vec<SubAgentConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_sub_agent_configs(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_sub_agent_config(
    agent_id: String,
    project_id: Option<String>,
) -> napi::Result<Option<SubAgentConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::get_sub_agent_config(agent_id, project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_sub_agent_config(item: SubAgentConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_sub_agent_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_sub_agent_config(
    agent_id: String,
    project_id: Option<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_sub_agent_config(agent_id, project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_sensitive_command_configs() -> napi::Result<Vec<SensitiveCommandConfigRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_sensitive_command_configs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_sensitive_command_config(
    item: SensitiveCommandConfigInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_sensitive_command_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_sensitive_command_config(command_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_sensitive_command_config(command_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn reset_sensitive_command_configs() -> napi::Result<()> {
    tokio::task::spawn_blocking(crate::storage::reset_sensitive_command_configs)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_project_sensitive_command_configs(
    project_id: String,
) -> napi::Result<Vec<ProjectSensitiveCommandConfigRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_project_sensitive_command_configs(project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_project_sensitive_command_enabled(
    project_id: String,
    command_id: String,
    enabled: bool,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_project_sensitive_command_enabled(project_id, command_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_project_sensitive_command_config(
    project_id: String,
    item: ProjectSensitiveCommandConfigInput,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::upsert_project_sensitive_command_config(project_id, item)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_project_sensitive_command_config(
    project_id: String,
    command_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_project_sensitive_command_config(project_id, command_id)
    })
    .await
    .map_err(map_spawn_error)?
}
