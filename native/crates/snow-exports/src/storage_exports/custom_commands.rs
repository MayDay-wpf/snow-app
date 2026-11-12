//! 自定义指令（斜杠命令）配置的 NAPI 转发。

use super::*;

#[napi]
pub async fn list_custom_commands(
    project_id: Option<String>,
) -> napi::Result<Vec<CustomCommandRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_custom_commands(project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_custom_command(item: CustomCommandInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_custom_command(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_custom_command(command_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_custom_command(command_id))
        .await
        .map_err(map_spawn_error)?
}
