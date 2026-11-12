use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::models::*;
use super::services;

// ===== Diff 行内评论 =====

pub fn list_diff_review_comments(
    directory_id: String,
    file_path: String,
) -> Result<Vec<DiffReviewCommentRecord>> {
    let database_path = ensure_database_file()?;
    services::diff_review_comments::list_diff_review_comments(
        &database_path,
        &directory_id,
        &file_path,
    )
}

pub fn create_diff_review_comment(
    directory_id: String,
    file_path: String,
    side: String,
    line_number: i32,
    line_content: String,
    content: String,
) -> Result<DiffReviewCommentRecord> {
    let database_path = ensure_database_file()?;
    services::diff_review_comments::create_diff_review_comment(
        &database_path,
        &directory_id,
        &file_path,
        &side,
        line_number,
        &line_content,
        &content,
    )
}

pub fn update_diff_review_comment(
    comment_id: String,
    content: String,
) -> Result<DiffReviewCommentRecord> {
    let database_path = ensure_database_file()?;
    services::diff_review_comments::update_diff_review_comment(&database_path, &comment_id, &content)
}

pub fn delete_diff_review_comment(comment_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::diff_review_comments::delete_diff_review_comment(&database_path, &comment_id)
}

pub fn delete_diff_review_comments_for_file(
    directory_id: String,
    file_path: String,
) -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::diff_review_comments::delete_diff_review_comments_for_file(
        &database_path,
        &directory_id,
        &file_path,
    )
}
