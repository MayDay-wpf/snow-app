use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::api::conversation::images::resolve_inline_images_from_disk;

use super::ensure_archive_database_file;
use super::ensure_database_file;
use super::models::*;
use super::services;

pub fn get_conversation_modes(
    conversation_id: &str,
) -> Result<services::chat_conversations::ConversationModes> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::get_conversation_modes(&database_path, conversation_id)
}

pub fn set_conversation_modes(
    conversation_id: &str,
    plan_mode: Option<bool>,
    goal_mode: Option<bool>,
    worktree_mode: Option<bool>,
    workflow_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::set_conversation_modes(
        &database_path,
        conversation_id,
        plan_mode,
        goal_mode,
        worktree_mode,
        workflow_mode,
        goal_mode_token_budget,
    )
}

pub fn create_workflow_node_session(
    conversation_id: &str,
    parent_conversation_id: &str,
    flow_id: &str,
    flow_checkpoint_id: &str,
    node_id: &str,
    node_name: &str,
    directory_id: &str,
    api_profile_name: &str,
    model: &str,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::create_workflow_node_session(
        &database_path,
        conversation_id,
        parent_conversation_id,
        flow_id,
        flow_checkpoint_id,
        node_id,
        node_name,
        directory_id,
        api_profile_name,
        model,
    )
}

pub fn update_workflow_node_session(
    conversation_id: &str,
    run_status: &str,
    error_message: &str,
    handoff_content: &str,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_workflow_node_session(
        &database_path,
        conversation_id,
        run_status,
        error_message,
        handoff_content,
    )
}

pub fn update_workflow_node_handoff(
    conversation_id: &str,
    handoff_content: &str,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_workflow_node_handoff(
        &database_path,
        conversation_id,
        handoff_content,
    )
}

pub fn list_workflow_node_sessions(
    parent_conversation_id: &str,
) -> Result<Vec<WorkflowNodeSessionRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_workflow_node_sessions(
        &database_path,
        parent_conversation_id,
    )
}

pub fn list_workflow_node_sessions_by_parents(
    parent_conversation_ids: &[String],
) -> Result<std::collections::HashMap<String, Vec<ChatConversationRecord>>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_workflow_node_sessions_by_parents(
        &database_path,
        parent_conversation_ids,
    )
}

pub fn get_workflow_node_session(
    conversation_id: &str,
) -> Result<Option<WorkflowNodeSessionRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::get_workflow_node_session(&database_path, conversation_id)
}

pub fn upsert_workflow_run(
    parent_conversation_id: &str,
    flow_id: &str,
    run_status: &str,
    current_node_index: i64,
    last_handoff: &str,
    total_tokens: i64,
    flow_checkpoint_id: &str,
    directory_id: &str,
    error_message: &str,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::upsert_workflow_run(
        &database_path,
        parent_conversation_id,
        flow_id,
        run_status,
        current_node_index,
        last_handoff,
        total_tokens,
        flow_checkpoint_id,
        directory_id,
        error_message,
    )
}

pub fn get_workflow_run(
    parent_conversation_id: &str,
    flow_id: &str,
) -> Result<Option<WorkflowRunRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::get_workflow_run(&database_path, parent_conversation_id, flow_id)
}

pub fn upsert_workflow_canvas(
    parent_conversation_id: &str,
    interaction_id: &str,
    canvas_json: &str,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::upsert_workflow_canvas(
        &database_path,
        parent_conversation_id,
        interaction_id,
        canvas_json,
    )
}

pub fn get_workflow_canvas(
    parent_conversation_id: &str,
    interaction_id: &str,
) -> Result<Option<WorkflowCanvasRecord>> {
    let database_path = ensure_database_file()?;
services::chat_conversations::get_workflow_canvas(
        &database_path,
        parent_conversation_id,
        interaction_id,
    )
}

pub fn get_conversation_runtime_config(
    conversation_id: &str,
) -> Result<services::chat_conversations::ConversationRuntimeConfig> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::get_conversation_runtime_config(
        &database_path,
        conversation_id,
    )
}

pub fn set_conversation_runtime_config(
    conversation_id: &str,
    thinking_strength: Option<String>,
    responses_fast_mode: Option<bool>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::set_conversation_runtime_config(
        &database_path,
        conversation_id,
        thinking_strength,
        responses_fast_mode,
    )
}

pub fn set_conversation_run_stats(
    conversation_id: &str,
    run_input_tokens: i64,
    run_output_tokens: i64,
    run_cache_creation_input_tokens: i64,
    run_cache_read_input_tokens: i64,
    last_run_duration_ms: i64,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::set_conversation_run_stats(
        &database_path,
        conversation_id,
        run_input_tokens,
        run_output_tokens,
        run_cache_creation_input_tokens,
        run_cache_read_input_tokens,
        last_run_duration_ms,
    )
}

pub fn reset_conversation_run_stats(conversation_id: &str) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::reset_conversation_run_stats(
        &database_path,
        conversation_id,
    )
}

pub fn list_chat_conversations(directory_id: String) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_chat_conversations(&database_path, &directory_id)
}
pub fn list_chat_conversations_paginated(
    directory_id: String,
    limit: i32,
    offset: i32,
) -> Result<ChatConversationPage> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_chat_conversations_paginated(
        &database_path,
        &directory_id,
        limit,
        offset,
    )
}

/// 跨项目按会话 ID 查询会话记录（供「跨项目通知」使用）。
pub fn list_chat_conversations_by_ids(
    conversation_ids: Vec<String>,
) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_chat_conversations_by_ids(
        &database_path,
        &conversation_ids,
    )
}

pub fn list_pinned_conversations(directory_id: String) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_pinned_conversations(&database_path, &directory_id)
}

pub fn search_chat_conversations(query: String) -> Result<Vec<ConversationSearchResult>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::search_chat_conversations(&database_path, &query)
}

pub fn get_chat_conversation(conversation_id: String) -> Result<Option<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::get_chat_conversation(&database_path, &conversation_id)
}

/// 预览 `@@conversation:` 标签发送时实际注入的上下文内容。
///
/// 与请求组装（parse_chat_message_content）共用渲染与预算逻辑：预算取
/// 单引用预算受总预算约束后的值（等同消息内首个标签可用预算），渲染
/// 结果即 AI 实际收到的上下文块，供输入框悬停「所见即所得」预览。
pub fn preview_conversation_attachment(conversation_id: String) -> Result<String> {
    let database_path = ensure_database_file()?;
    let (single_budget, total_budget) =
        services::context_attachments::read_attach_context_budgets(&database_path);
    let budget = single_budget.min(total_budget);
    services::context_attachments::render_attachment_context_with_budget(
        &database_path,
        &conversation_id,
        budget,
    )
}

pub fn list_sub_agent_conversations(
    parent_conversation_id: String,
) -> Result<Vec<ChatConversationRecord>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_sub_agent_conversations(
        &database_path,
        &parent_conversation_id,
    )
}

pub fn list_sub_agent_conversations_by_parents(
    parent_conversation_ids: Vec<String>,
) -> Result<HashMap<String, Vec<ChatConversationRecord>>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::list_sub_agent_conversations_by_parents(
        &database_path,
        &parent_conversation_ids,
    )
}

pub fn create_sub_agent_session(
    conversation_id: String,
    parent_conversation_id: String,
    agent_id: String,
    agent_name: String,
    directory_id: String,
    api_profile_name: String,
    model: String,
    title: String,
    thinking_strength: Option<String>,
    responses_fast_mode: Option<bool>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::create_sub_agent_session(
        &database_path,
        &conversation_id,
        &parent_conversation_id,
        &agent_id,
        &agent_name,
        &directory_id,
        &api_profile_name,
        &model,
        &title,
        thinking_strength,
        responses_fast_mode,
    )
}

pub fn update_sub_agent_session_status(
    conversation_id: String,
    run_status: String,
    error_message: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_sub_agent_session_status(
        &database_path,
        &conversation_id,
        &run_status,
        &error_message,
    )
}

pub fn cancel_running_sub_agent_sessions() -> Result<u32> {
    let database_path = ensure_database_file()?;
    let cancelled_count =
        services::chat_conversations::cancel_running_sub_agent_sessions(&database_path)?;
    u32::try_from(cancelled_count).map_err(|_| {
        Error::new(
            Status::GenericFailure,
            "Cancelled sub-agent session count exceeds u32 range".to_string(),
        )
    })
}

pub fn update_conversation_status(conversation_id: String, status: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_conversation_status(
        &database_path,
        &conversation_id,
        &status,
    )
}

pub fn rename_conversation(conversation_id: String, title: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::rename_conversation(&database_path, &conversation_id, &title)
}

pub fn update_conversation_emoji(conversation_id: String, emoji: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_conversation_emoji(
        &database_path,
        &conversation_id,
        &emoji,
    )
}

pub fn update_conversation_api_profile(
    conversation_id: String,
    profile_name: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::update_conversation_api_profile(
        &database_path,
        &conversation_id,
        &profile_name,
    )
}

/// 删除会话。`delete_memories=true` 时把该会话（含级联子会话）保存的
/// 项目记忆一并删除——由删除确认弹窗的用户选择传入，默认保留。
pub fn delete_conversation(conversation_id: String, delete_memories: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::delete_conversation(
        &database_path,
        &conversation_id,
        delete_memories,
    )
}

pub fn delete_conversations(conversation_ids: Vec<String>, delete_memories: bool) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::delete_conversations(
        &database_path,
        &conversation_ids,
        delete_memories,
    )
}

pub fn archive_conversations(conversation_ids: Vec<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    let archive_path = ensure_archive_database_file()?;
    services::archive::archive_conversations(&database_path, &archive_path, &conversation_ids)
}

pub fn list_archived_conversations_paginated(
    directory_id: String,
    limit: i32,
    offset: i32,
) -> Result<ChatConversationPage> {
    let archive_path = ensure_archive_database_file()?;
    services::archive::list_archived_conversations_paginated(
        &archive_path,
        &directory_id,
        limit,
        offset,
    )
}

pub fn restore_archived_conversations(conversation_ids: Vec<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    let archive_path = ensure_archive_database_file()?;
    services::archive::restore_archived_conversations(
        &database_path,
        &archive_path,
        &conversation_ids,
    )
}

pub fn delete_archived_conversations(conversation_ids: Vec<String>) -> Result<()> {
    let archive_path = ensure_archive_database_file()?;
    services::archive::delete_archived_conversations(&archive_path, &conversation_ids)
}

pub fn append_tool_message(conversation_id: String, content: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::append_tool_message(&database_path, &conversation_id, &content)
}

pub fn list_chat_messages(conversation_id: String) -> Result<Vec<ChatMessageRecord>> {
    let database_path = ensure_database_file()?;
    let mut records =
        services::chat_conversations::list_chat_messages(&database_path, &conversation_id)?;
    for record in &mut records {
        record.content = resolve_inline_images_from_disk(&record.content, &database_path);
    }
    Ok(records)
}

/// Lightweight summary of a single user message, used by the chat UI's
/// user-message rail for quick navigation. Only carries the fields the rail
/// needs (id for DOM lookup, content for preview, created_at for ordering),
/// so long conversations do not pay the cost of loading full tool_calls_json
/// and thinking blobs for every message.
#[napi(object)]
pub struct UserMessageSummary {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

pub fn list_user_messages(conversation_id: String) -> Result<Vec<UserMessageSummary>> {
    let database_path = ensure_database_file()?;
    let mut records =
        services::chat_conversations::list_user_messages(&database_path, &conversation_id)?;
    for record in &mut records {
        record.content = resolve_inline_images_from_disk(&record.content, &database_path);
    }
    Ok(records)
}

pub fn list_chat_messages_paginated(
    conversation_id: String,
    before_message_id: String,
    limit: i32,
) -> Result<ChatMessagePage> {
    let database_path = ensure_database_file()?;
    let mut page = services::chat_conversations::list_chat_messages_paginated(
        &database_path,
        &conversation_id,
        &before_message_id,
        limit,
    )?;
    for record in &mut page.items {
        record.content = resolve_inline_images_from_disk(&record.content, &database_path);
    }
    Ok(page)
}

pub fn find_latest_tool_result(
    conversation_id: String,
    tool_name: String,
) -> Result<Option<String>> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::find_latest_tool_result(
        &database_path,
        &conversation_id,
        &tool_name,
    )
}
pub fn fork_conversation(
    source_conversation_id: String,
    up_to_response_id: String,
) -> Result<ChatConversationRecord> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::fork_conversation(
        &database_path,
        &source_conversation_id,
        &up_to_response_id,
    )
}

pub fn truncate_conversation_from_response(
    conversation_id: String,
    response_id: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::truncate_conversation_from_response(
        &database_path,
        &conversation_id,
        &response_id,
    )
}

pub fn truncate_conversation_from_message(
    conversation_id: String,
    message_id: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::chat_conversations::truncate_conversation_from_message(
        &database_path,
        &conversation_id,
        &message_id,
    )
}

/// 导出指定会话为 markdown / html / json / csv 格式文本。
/// 文件路径选择与写入由 Electron 主进程 IPC handler 负责，
/// Rust 端仅负责从 SQLite 读取数据并格式化，所有 I/O 在 spawn_blocking 中执行。
pub fn export_conversation(conversation_id: String, format: String) -> Result<String> {
    let database_path = ensure_database_file()?;
    services::conversation_export::export_conversation(&database_path, &conversation_id, &format)
}
