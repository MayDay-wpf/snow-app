//! 会话与消息的 NAPI 转发（模式、归档、子代理、回滚等）。

use super::*;
use crate::storage::ContextAttachmentRecord;

#[napi(object)]
pub struct ConversationModesResult {
    /// Whether Plan Mode is enabled (true) or disabled (false) for this
    /// conversation. Legacy rows with a NULL flag are read as disabled;
    /// null is only returned when the conversation row does not exist
    /// (follow the global default).
    pub plan_mode: Option<bool>,
    /// Whether Goal Mode is enabled (true) or disabled (false) for this
    /// conversation. Legacy rows with a NULL flag are read as disabled;
    /// null is only returned when the conversation row does not exist
    /// (follow the global default).
    pub goal_mode: Option<bool>,
    /// Per-conversation Goal Mode token budget override (null → follow the
    /// global default budget).
    pub goal_mode_token_budget: Option<i64>,
}

#[napi]
pub async fn get_conversation_modes(
    conversation_id: String,
) -> napi::Result<ConversationModesResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_conversation_modes(&conversation_id).map(|modes| {
            ConversationModesResult {
                plan_mode: modes.plan_mode,
                goal_mode: modes.goal_mode,
                goal_mode_token_budget: modes.goal_mode_token_budget,
            }
        })
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_conversation_modes(
    conversation_id: String,
    plan_mode: Option<bool>,
    goal_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_conversation_modes(
            &conversation_id,
            plan_mode,
            goal_mode,
            goal_mode_token_budget,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_conversations(
    directory_id: String,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_chat_conversations(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_conversations_paginated(
    directory_id: String,
    limit: i32,
    offset: i32,
) -> napi::Result<ChatConversationPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_chat_conversations_paginated(directory_id, limit, offset)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 归档会话：从运行库搬移到独立的归档冷数据库（含子代理级联）。
/// 置顶会话不参与归档。
#[napi]
pub async fn archive_conversations(conversation_ids: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::archive_conversations(conversation_ids))
        .await
        .map_err(map_spawn_error)?
}

/// 分页列出归档会话（按归档时间倒序）。
#[napi]
pub async fn list_archived_conversations_paginated(
    directory_id: String,
    limit: i32,
    offset: i32,
) -> napi::Result<ChatConversationPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_archived_conversations_paginated(directory_id, limit, offset)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 还原归档会话：从归档冷数据库搬移回运行库（含子代理级联）。
#[napi]
pub async fn restore_archived_conversations(conversation_ids: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::restore_archived_conversations(conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 永久删除归档会话（含子代理级联）。
#[napi]
pub async fn delete_archived_conversations(conversation_ids: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_archived_conversations(conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 跨项目按会话 ID 查询会话记录（供「跨项目通知」使用）。
#[napi]
pub async fn list_chat_conversations_by_ids(
    conversation_ids: Vec<String>,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_chat_conversations_by_ids(conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_pinned_conversations(
    directory_id: String,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_pinned_conversations(directory_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn search_chat_conversations(
    query: String,
) -> napi::Result<Vec<ConversationSearchResult>> {
    tokio::task::spawn_blocking(move || crate::storage::search_chat_conversations(query))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_chat_conversation(
    conversation_id: String,
) -> napi::Result<Option<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::get_chat_conversation(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_sub_agent_conversations(
    parent_conversation_id: String,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_sub_agent_conversations(parent_conversation_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_sub_agent_conversations_by_parents(
    parent_conversation_ids: Vec<String>,
) -> napi::Result<std::collections::HashMap<String, Vec<ChatConversationRecord>>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_sub_agent_conversations_by_parents(parent_conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_sub_agent_session(
    conversation_id: String,
    parent_conversation_id: String,
    agent_id: String,
    agent_name: String,
    directory_id: String,
    api_profile_name: String,
    model: String,
    title: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_sub_agent_session(
            conversation_id,
            parent_conversation_id,
            agent_id,
            agent_name,
            directory_id,
            api_profile_name,
            model,
            title,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_sub_agent_session_status(
    conversation_id: String,
    run_status: String,
    error_message: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_sub_agent_session_status(conversation_id, run_status, error_message)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn cancel_running_sub_agent_sessions() -> napi::Result<u32> {
    tokio::task::spawn_blocking(crate::storage::cancel_running_sub_agent_sessions)
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_conversation_status(
    conversation_id: String,
    status: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_conversation_status(conversation_id, status)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn rename_conversation(conversation_id: String, title: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::rename_conversation(conversation_id, title))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_conversation_emoji(conversation_id: String, emoji: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_conversation_emoji(conversation_id, emoji)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_conversation_api_profile(
    conversation_id: String,
    profile_name: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_conversation_api_profile(conversation_id, profile_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_conversation(conversation_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_conversation(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_conversations(conversation_ids: Vec<String>) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_conversations(conversation_ids))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn append_tool_message(conversation_id: String, content: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::append_tool_message(conversation_id, content)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_messages(conversation_id: String) -> napi::Result<Vec<ChatMessageRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_chat_messages(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

/// Lightweight list of user messages for the chat UI's user-message rail.
/// Runs on a blocking thread so the Node.js event loop is never blocked.
#[napi]
pub async fn list_user_messages(conversation_id: String) -> napi::Result<Vec<UserMessageSummary>> {
    tokio::task::spawn_blocking(move || crate::storage::list_user_messages(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_chat_messages_paginated(
    conversation_id: String,
    before_message_id: String,
    limit: i32,
) -> napi::Result<ChatMessagePage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_chat_messages_paginated(conversation_id, before_message_id, limit)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn find_latest_tool_result(
    conversation_id: String,
    tool_name: String,
) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::find_latest_tool_result(conversation_id, tool_name)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn fork_conversation(
    source_conversation_id: String,
    up_to_response_id: String,
) -> napi::Result<ChatConversationRecord> {
    tokio::task::spawn_blocking(move || {
        crate::storage::fork_conversation(source_conversation_id, up_to_response_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn truncate_conversation_from_response(
    conversation_id: String,
    response_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::truncate_conversation_from_response(conversation_id, response_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// Truncate a conversation starting from a persisted message id. Used as the
/// rollback boundary for exchanges without a provider response id (failed or
/// cancelled turns), where the persisted user message id is the only anchor.
#[napi]
pub async fn truncate_conversation_from_message(
    conversation_id: String,
    message_id: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::truncate_conversation_from_message(conversation_id, message_id)
    })
    .await
    .map_err(map_spawn_error)?
}

/// List TODO items that will be deleted when rolling back to the given
/// response_id within a conversation.  Returns a JSON string.
#[napi]
pub async fn list_todos_for_rollback(
    session_id: String,
    response_id: String,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::mcp::servers::todo::TodoService::list_todos_for_rollback(&session_id, &response_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn export_conversation(conversation_id: String, format: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::export_conversation(conversation_id, format)
    })
    .await
    .map_err(map_spawn_error)?
}

// ============================================================================
// Conversation context attachments — 会话上下文附件（拖拽会话到另一会话开头）
// ============================================================================

#[napi]
pub async fn list_context_attachments(
    conversation_id: String,
) -> napi::Result<Vec<ContextAttachmentRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::list_context_attachments(conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn add_context_attachment(
    target_id: String,
    source_id: String,
) -> napi::Result<ContextAttachmentRecord> {
    tokio::task::spawn_blocking(move || {
        crate::storage::add_context_attachment(target_id, source_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn remove_context_attachment(target_id: String, source_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::remove_context_attachment(target_id, source_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn render_attachment_context(source_id: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::render_attachment_context(source_id))
        .await
        .map_err(map_spawn_error)?
}
