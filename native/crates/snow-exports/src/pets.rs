//! Codex 宠物系统 NAPI 导出。
//!
//! 所有函数均为 async + spawn_blocking 模式，文件 I/O 与 zip 解压
//! 不会阻塞 Node.js 主线程。

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::services::pets::{self, PetManifest};

#[napi]
pub async fn install_pet_from_zip(
    zip_path: String,
    builtin: Option<bool>,
) -> napi::Result<PetManifest> {
    let builtin = builtin.unwrap_or(false);
    tokio::task::spawn_blocking(move || pets::install_pet_from_zip(zip_path, builtin))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_installed_pets() -> napi::Result<Vec<PetManifest>> {
    tokio::task::spawn_blocking(pets::list_installed_pets)
        .await
        .map_err(map_spawn_error)
}

#[napi]
pub async fn uninstall_pet(pet_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || pets::uninstall_pet(pet_id))
        .await
        .map_err(map_spawn_error)?
}

fn map_spawn_error(error: tokio::task::JoinError) -> Error {
    Error::from_reason(format!("Pet task failed to complete: {error}"))
}
