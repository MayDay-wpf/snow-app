//! JSON NAPI boundary implementing src/shared/imageGeneration.ts.

use napi::{Error, Result};
use napi_derive::napi;

use crate::storage::services::image_generation as service;

async fn database_operation<T: Send + 'static>(
    operation: impl FnOnce(&std::path::Path) -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(move || {
        let path = crate::storage::ensure_database_file()?;
        operation(&path)
    })
    .await
    .map_err(|_| Error::from_reason("Image generation storage worker failed"))?
}

fn encode(value: impl serde::Serialize) -> Result<String> {
    serde_json::to_string(&value)
        .map_err(|_| Error::from_reason("Failed to encode image generation snapshot"))
}

#[napi]
pub async fn register_image_generation_batch(registration_json: String) -> Result<String> {
    database_operation(move |path| {
        let registration = serde_json::from_str(&registration_json)
            .map_err(|_| Error::from_reason("Invalid image generation batch registration"))?;
        encode(service::register_batch(path, registration)?)
    })
    .await
}

#[napi]
pub async fn seal_image_generation_batch(
    conversation_id: String,
    batch_id: String,
) -> Result<String> {
    database_operation(move |path| encode(service::seal_batch(path, &conversation_id, &batch_id)?))
        .await
}

#[napi]
pub async fn list_image_generation_batches(conversation_id: String) -> Result<String> {
    database_operation(move |path| encode(service::list_batches(path, &conversation_id)?)).await
}

#[napi]
pub async fn get_image_generation_task(conversation_id: String, task_id: String) -> Result<String> {
    database_operation(move |path| encode(service::get_task(path, &conversation_id, &task_id)?))
        .await
}

#[napi]
pub async fn claim_image_generation_batch_notification(
    conversation_id: String,
    batch_id: String,
) -> Result<bool> {
    database_operation(move |path| service::claim_notification(path, &conversation_id, &batch_id))
        .await
}

#[napi]
pub async fn release_image_generation_batch_notification(
    conversation_id: String,
    batch_id: String,
) -> Result<()> {
    database_operation(move |path| service::release_notification(path, &conversation_id, &batch_id))
        .await
}

#[napi]
pub async fn recover_interrupted_image_generation_tasks() -> Result<u32> {
    database_operation(service::recover_interrupted_tasks).await
}
