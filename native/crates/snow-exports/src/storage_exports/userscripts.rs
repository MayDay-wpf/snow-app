//! 用户脚本（油猴兼容）的 NAPI 转发。

use super::*;

#[napi]
pub async fn list_userscripts() -> napi::Result<Vec<UserscriptRecord>> {
    tokio::task::spawn_blocking(|| {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::list_userscripts(&database_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_userscript(raw: String) -> napi::Result<UserscriptRecord> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::create_userscript(&database_path, &raw)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_userscript(script_id: String, raw: String) -> napi::Result<UserscriptRecord> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::update_userscript(&database_path, &script_id, &raw)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_userscript(script_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::delete_userscript(&database_path, &script_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_userscript_enabled(script_id: String, enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::set_userscript_enabled(&database_path, &script_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_userscript_source(script_id: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::read_userscript_source(&database_path, &script_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_userscript_values(script_id: String) -> napi::Result<Vec<UserscriptValue>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::get_userscript_values(&database_path, &script_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_userscript_value(
    script_id: String,
    key: String,
    value: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::set_userscript_value(&database_path, &script_id, &key, &value)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_userscript_value(script_id: String, key: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::delete_userscript_value(&database_path, &script_id, &key)
    })
    .await
    .map_err(map_spawn_error)?
}