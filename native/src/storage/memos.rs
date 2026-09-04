use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::models::*;
use super::services;

// ===== Memos =====

pub fn list_memos(
    directory_id: String,
    limit: i32,
    offset: i32,
    status: Option<String>,
    sort_order: Option<String>,
) -> Result<MemoPage> {
    let database_path = ensure_database_file()?;
    services::memos::list_memos(
        &database_path,
        &directory_id,
        limit,
        offset,
        status.as_deref(),
        sort_order.as_deref(),
    )
}

pub fn create_memo(directory_id: String, content: String) -> Result<MemoRecord> {
    let database_path = ensure_database_file()?;
    services::memos::create_memo(&database_path, &directory_id, &content)
}

pub fn update_memo_content(memo_id: String, content: String) -> Result<MemoRecord> {
    let database_path = ensure_database_file()?;
    services::memos::update_memo_content(&database_path, &memo_id, &content)
}

pub fn update_memo_status(memo_id: String, status: String) -> Result<MemoRecord> {
    let database_path = ensure_database_file()?;
    services::memos::update_memo_status(&database_path, &memo_id, &status)
}

pub fn delete_memo(memo_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::memos::delete_memo(&database_path, &memo_id)
}

pub fn get_memo_count_summary(directory_id: String) -> Result<MemoCountSummary> {
    let database_path = ensure_database_file()?;
    services::memos::get_memo_count_summary(&database_path, &directory_id)
}
