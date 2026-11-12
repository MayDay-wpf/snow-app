//! Hook 配置与执行的 NAPI 转发。

use super::*;

#[napi]
pub async fn list_hook_configs(
    scope: String,
    project_id: Option<String>,
) -> napi::Result<Vec<HookConfigRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_hook_configs(scope, project_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_hook_config(item: HookConfigInput) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::upsert_hook_config(item))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_hook_config(
    hook_type: String,
    scope: String,
    project_id: Option<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_hook_config(hook_type, scope, project_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn execute_hooks(input: HookExecuteInput) -> napi::Result<HookExecuteResult> {
    // 获取数据库路径需要文件系统 I/O，使用 spawn_blocking 避免阻塞 Node.js 主线程
    let database_path = tokio::task::spawn_blocking(crate::storage::get_storage_dir)
        .await
        .map_err(map_spawn_error)??;
    // execute_hooks 内部使用 tokio::process::Command 异步执行命令，直接 await
    crate::hooks::execute_hooks(&database_path, &input).await
}
