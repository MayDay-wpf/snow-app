//! File annotations have an independent contract; all SQLite work runs off the Node thread.
use super::*;

#[napi]
pub async fn list_file_review_annotations(
    source_key: String,
    file_path: String,
) -> napi::Result<Vec<FileReviewAnnotationRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_file_review_annotations(source_key, file_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_file_review_annotation(
    source_key: String,
    file_path: String,
    anchor_json: String,
    content: String,
) -> napi::Result<FileReviewAnnotationRecord> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_file_review_annotation(source_key, file_path, anchor_json, content)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_file_review_annotation(
    source_key: String,
    file_path: String,
    annotation_id: String,
    content: String,
) -> napi::Result<FileReviewAnnotationRecord> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_file_review_annotation(source_key, file_path, annotation_id, content)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_file_review_annotation(
    source_key: String,
    file_path: String,
    annotation_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_file_review_annotation(source_key, file_path, annotation_id)
    })
    .await
    .map_err(map_spawn_error)?
}
