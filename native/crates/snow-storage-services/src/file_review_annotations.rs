use super::{ensure_database_file, services, FileReviewAnnotationRecord};
use napi::bindgen_prelude::*;

pub fn list_file_review_annotations(
    source_key: String,
    file_path: String,
) -> Result<Vec<FileReviewAnnotationRecord>> {
    services::file_review_annotations::list_file_review_annotations(
        &ensure_database_file()?,
        &source_key,
        &file_path,
    )
}

pub fn create_file_review_annotation(
    source_key: String,
    file_path: String,
    anchor_json: String,
    content: String,
) -> Result<FileReviewAnnotationRecord> {
    services::file_review_annotations::create_file_review_annotation(
        &ensure_database_file()?,
        &source_key,
        &file_path,
        &anchor_json,
        &content,
    )
}

pub fn update_file_review_annotation(
    source_key: String,
    file_path: String,
    annotation_id: String,
    content: String,
) -> Result<FileReviewAnnotationRecord> {
    services::file_review_annotations::update_file_review_annotation(
        &ensure_database_file()?,
        &source_key,
        &file_path,
        &annotation_id,
        &content,
    )
}

pub fn delete_file_review_annotation(
    source_key: String,
    file_path: String,
    annotation_id: String,
) -> Result<()> {
    services::file_review_annotations::delete_file_review_annotation(
        &ensure_database_file()?,
        &source_key,
        &file_path,
        &annotation_id,
    )
}
