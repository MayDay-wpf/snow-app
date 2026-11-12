//! Diff 行内评论的 NAPI 转发。
//! 所有 SQLite I/O 均在 spawn_blocking 中执行，不阻塞 Node.js。

use super::*;

#[napi]
pub async fn list_diff_review_comments(
    directory_id: String,
    file_path: String,
) -> napi::Result<Vec<DiffReviewCommentRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_diff_review_comments(directory_id, file_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_diff_review_comment(
    directory_id: String,
    file_path: String,
    side: String,
    line_number: i32,
    line_content: String,
    content: String,
) -> napi::Result<DiffReviewCommentRecord> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_diff_review_comment(
            directory_id,
            file_path,
            side,
            line_number,
            line_content,
            content,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_diff_review_comment(
    comment_id: String,
    content: String,
) -> napi::Result<DiffReviewCommentRecord> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_diff_review_comment(comment_id, content)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_diff_review_comment(comment_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_diff_review_comment(comment_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_diff_review_comments_for_file(
    directory_id: String,
    file_path: String,
) -> napi::Result<u32> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_diff_review_comments_for_file(directory_id, file_path)
    })
    .await
    .map_err(map_spawn_error)?
}
