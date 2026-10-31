//! 会话与消息的 NAPI 转发（模式、归档、子代理、回滚等）。

use super::*;

#[napi(object)]
pub struct ConversationModesResult {
    /// Whether Goal Mode is enabled (true) or disabled (false) for this
    /// conversation. Legacy rows with a NULL flag are read as disabled;
    /// null is only returned when the conversation row does not exist
    /// (follow the global default).
    pub goal_mode: Option<bool>,
    /// Whether WorkTree Mode is enabled for this conversation.
    pub worktree_mode: Option<bool>,
    /// Whether WorkFlow Mode is enabled for this conversation.
    pub workflow_mode: Option<bool>,
    /// Per-conversation Goal Mode token budget override (null → follow the
    /// global default budget).
    pub goal_mode_token_budget: Option<i64>,
}

#[napi(object)]
pub struct ConversationRuntimeConfigResult {
    pub thinking_strength: Option<String>,
    pub responses_fast_mode: Option<String>,
}

#[napi]
pub async fn get_conversation_modes(
    conversation_id: String,
) -> napi::Result<ConversationModesResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_conversation_modes(&conversation_id).map(|modes| {
            ConversationModesResult {
                goal_mode: modes.goal_mode,
                worktree_mode: modes.worktree_mode,
                workflow_mode: modes.workflow_mode,
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
    goal_mode: Option<bool>,
    worktree_mode: Option<bool>,
    workflow_mode: Option<bool>,
    goal_mode_token_budget: Option<i64>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_conversation_modes(
            &conversation_id,
            goal_mode,
            worktree_mode,
            workflow_mode,
            goal_mode_token_budget,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_conversation_runtime_config(
    conversation_id: String,
) -> napi::Result<ConversationRuntimeConfigResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_conversation_runtime_config(&conversation_id).map(|config| {
            ConversationRuntimeConfigResult {
                thinking_strength: config.thinking_strength,
                responses_fast_mode: config.responses_fast_mode,
            }
        })
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_conversation_runtime_config(
    conversation_id: String,
    thinking_strength: Option<String>,
    responses_fast_mode: Option<String>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_conversation_runtime_config(
            &conversation_id,
            thinking_strength,
            responses_fast_mode,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 持久化最近一次 AI run 的累计用量与墙钟总耗时（run 摘要条回显用）。
#[napi]
pub async fn set_conversation_run_stats(
    conversation_id: String,
    run_input_tokens: i64,
    run_output_tokens: i64,
    run_cache_creation_input_tokens: i64,
    run_cache_read_input_tokens: i64,
    last_run_duration_ms: i64,
    run_ttft_sum_ms: i64,
    run_request_count: i64,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::set_conversation_run_stats(
            &conversation_id,
            run_input_tokens,
            run_output_tokens,
            run_cache_creation_input_tokens,
            run_cache_read_input_tokens,
            last_run_duration_ms,
            run_ttft_sum_ms,
            run_request_count,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// 清零会话的累计 run 统计（回滚截断消息后调用）。
#[napi]
pub async fn reset_conversation_run_stats(conversation_id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::reset_conversation_run_stats(&conversation_id)
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

/// 分页列出归档会话（按归档时间倒序）；keyword 非空时按标题/摘要/预览模糊过滤。
#[napi]
pub async fn list_archived_conversations_paginated(
    directory_id: String,
    keyword: Option<String>,
    limit: i32,
    offset: i32,
) -> napi::Result<ChatConversationPage> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_archived_conversations_paginated(
            directory_id,
            keyword.unwrap_or_default(),
            limit,
            offset,
        )
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

/// 记忆来源解析：按会话 ID 批量查询会话记录（含子代理 / WorkFlow 节点会话；
/// 未返回的 ID 表示来源会话已被删除）。
#[napi]
pub async fn list_memory_source_conversations(
    conversation_ids: Vec<String>,
) -> napi::Result<Vec<ChatConversationRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_memory_source_conversations(conversation_ids)
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

/// 预览历史会话引用 chip 发送时实际注入的上下文内容（与请求组装共用
/// 渲染与预算逻辑），供输入框悬停「所见即所得」预览。
#[napi]
pub async fn preview_conversation_attachment(conversation_id: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::preview_conversation_attachment(conversation_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi(js_name = "subAgentRunCommand")]
pub async fn sub_agent_run_command(command_json: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::sub_agent_run_command(&command_json))
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
pub async fn create_chat_conversation(
    directory_id: String,
    title: String,
    initial_text: Option<String>,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_chat_conversation(directory_id, title, initial_text)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn create_workflow_node_session(
    conversation_id: String,
    parent_conversation_id: String,
    flow_id: String,
    flow_checkpoint_id: String,
    node_id: String,
    node_name: String,
    directory_id: String,
    api_profile_name: String,
    model: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::create_workflow_node_session(
            &conversation_id,
            &parent_conversation_id,
            &flow_id,
            &flow_checkpoint_id,
            &node_id,
            &node_name,
            &directory_id,
            &api_profile_name,
            &model,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_workflow_node_session(
    conversation_id: String,
    run_status: String,
    error_message: String,
    handoff_content: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_workflow_node_session(
            &conversation_id,
            &run_status,
            &error_message,
            &handoff_content,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn update_workflow_node_handoff(
    conversation_id: String,
    handoff_content: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_workflow_node_handoff(&conversation_id, &handoff_content)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_workflow_node_sessions(
    parent_conversation_id: String,
) -> napi::Result<Vec<WorkflowNodeSessionRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_workflow_node_sessions(&parent_conversation_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_workflow_node_sessions_by_parents(
    parent_conversation_ids: Vec<String>,
) -> napi::Result<std::collections::HashMap<String, Vec<ChatConversationRecord>>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::list_workflow_node_sessions_by_parents(&parent_conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_workflow_node_session(
    conversation_id: String,
) -> napi::Result<Option<WorkflowNodeSessionRecord>> {
    tokio::task::spawn_blocking(move || crate::storage::get_workflow_node_session(&conversation_id))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_workflow_run(
    parent_conversation_id: String,
    flow_id: String,
    run_status: String,
    current_node_index: i64,
    last_handoff: String,
    total_tokens: i64,
    flow_checkpoint_id: String,
    directory_id: String,
    error_message: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::upsert_workflow_run(
            &parent_conversation_id,
            &flow_id,
            &run_status,
            current_node_index,
            &last_handoff,
            total_tokens,
            &flow_checkpoint_id,
            &directory_id,
            &error_message,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_workflow_run(
    parent_conversation_id: String,
    flow_id: String,
) -> napi::Result<Option<WorkflowRunRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_workflow_run(&parent_conversation_id, &flow_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn upsert_workflow_canvas(
    parent_conversation_id: String,
    interaction_id: String,
    canvas_json: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::upsert_workflow_canvas(
            &parent_conversation_id,
            &interaction_id,
            &canvas_json,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_workflow_canvas(
    parent_conversation_id: String,
    interaction_id: String,
) -> napi::Result<Option<WorkflowCanvasRecord>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_workflow_canvas(&parent_conversation_id, &interaction_id)
    })
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
pub async fn delete_conversation(
    conversation_id: String,
    delete_memories: Option<bool>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_conversation(conversation_id, delete_memories.unwrap_or(false))
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_conversations(
    conversation_ids: Vec<String>,
    delete_memories: Option<bool>,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_conversations(conversation_ids, delete_memories.unwrap_or(false))
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_task_history(
    conversation_id: String,
    response_id: String,
    manifest: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::storage::save_task_history(conversation_id, response_id, manifest)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn list_task_history(conversation_id: String) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || crate::storage::list_task_history(conversation_id))
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

#[napi(object)]
pub struct ManualToolExchangeRequest {
    /// 为空时新建会话
    pub conversation_id: Option<String>,
    pub directory_id: Option<String>,
    pub model: Option<String>,
    pub api_profile: Option<String>,
    pub checkpoint_id: Option<String>,
    pub messages: Vec<ManualExchangeMessage>,
    pub tool_calls: Vec<ManualExchangeToolCall>,
}

#[napi(object)]
pub struct ManualExchangeMessage {
    pub role: String,
    pub content: String,
    pub tool_results_json: Option<String>,
}

#[napi(object)]
pub struct ManualExchangeToolCall {
    pub name: String,
    pub arguments_json: String,
}

/// 业务逻辑直接生成一次工具调用（不请求模型），返回与模型响应同构的结果，
/// 渲染端据此复用工具执行与续跑链路。
#[napi(ts_return_type = "Promise<ResponsesApiResult>")]
pub async fn store_manual_tool_exchange(
    request: ManualToolExchangeRequest,
) -> napi::Result<crate::api::responses::ResponsesApiResult> {
    tokio::task::spawn_blocking(move || {
        let model = request.model.unwrap_or_default();
        let messages: Vec<_> = request.messages.into_iter().map(|message| {
            crate::storage::services::chat_conversations::ChatContextMessage {
                role: message.role,
                content: message.content,
                tool_calls_json: None,
                tool_results_json: message.tool_results_json,
                thinking: None,
                thinking_blocks_json: None,
            }
        }).collect();
        let tool_calls: Vec<_> = request.tool_calls.into_iter()
            .map(|call| (call.name, call.arguments_json)).collect();
        let exchange = crate::storage::store_manual_tool_exchange(
            &crate::storage::services::chat_conversations::ManualToolExchangeInput {
                conversation_id: request.conversation_id.as_deref(),
                directory_id: request.directory_id.as_deref().unwrap_or(""),
                model: &model,
                api_profile_name: request.api_profile.as_deref().unwrap_or(""),
                checkpoint_id: request.checkpoint_id.as_deref().unwrap_or(""),
                messages: &messages,
                tool_calls: &tool_calls,
            },
        )?;
        Ok(crate::api::responses::ResponsesApiResult {
            id: exchange.response_id,
            conversation_id: exchange.conversation_id,
            content: String::new(),
            thinking: String::new(),
            model,
            status: "completed".to_string(),
            interruption_reason: None,
            recovery_outcome: None,
            failure_reason: None,
            tool_calls_json: exchange.tool_calls_json,
            token_usage: crate::api::responses::TokenUsage {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            persisted_user_message_ids: exchange.persisted_user_message_ids,
            persisted_assistant_message_id: exchange.persisted_assistant_message_id,
        })
    })
    .await
    .map_err(map_spawn_error)?
}

/// Replace the arguments of one persisted assistant tool call after the
/// correction agent produced a successful retry. Returns whether a matching
/// call was found and updated.
#[napi]
pub async fn update_tool_call_arguments(
    conversation_id: String,
    response_id: String,
    call_id: String,
    arguments_json: String,
) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_tool_call_arguments(
            conversation_id,
            response_id,
            call_id,
            arguments_json,
        )
    })
    .await
    .map_err(map_spawn_error)?
}

/// Persist (or clear, with an empty string) the correction-agent state of one
/// tool call so the correction tree survives an app restart. Returns whether a
/// matching assistant message was found.
#[napi]
pub async fn update_tool_call_correction(
    conversation_id: String,
    response_id: String,
    call_id: String,
    correction_json: String,
) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || {
        crate::storage::update_tool_call_correction(
            conversation_id,
            response_id,
            call_id,
            correction_json,
        )
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

/// 按消息 id 解析用户消息中的第 `image_index` 张图片（远控图片接口的
/// 数据库兜底路径：渲染进程只持有当前会话已加载的内存消息窗口）。
#[napi]
pub async fn get_chat_message_image(
    message_id: String,
    image_index: i32,
) -> napi::Result<Option<ChatMessageImage>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::get_chat_message_image(message_id, image_index)
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

/// 删除会话末尾的失败回合（子代理失败重试前清理），返回是否删除。
#[napi]
pub async fn truncate_trailing_failed_exchange(conversation_id: String) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || {
        crate::storage::truncate_trailing_failed_exchange(conversation_id)
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

#[napi]
pub async fn import_conversation(directory_id: String, file_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        crate::storage::import_conversation(directory_id, file_path)
    })
    .await
    .map_err(map_spawn_error)?
}
