use napi::bindgen_prelude::*;
use serde_json::json;

use super::super::super::{ChatConversationRecord, ChatMessageRecord};

// ============================================================================
// JSON
// ============================================================================

pub(crate) fn render_json(
    conversation: &ChatConversationRecord,
    messages: &[ChatMessageRecord],
) -> Result<String> {
    let conversation_json = conversation_to_json(conversation);
    let messages_json: Vec<serde_json::Value> = messages.iter().map(message_to_json).collect();

    let export = json!({
        "conversation": conversation_json,
        "messages": messages_json,
    });

    serde_json::to_string_pretty(&export).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize conversation to JSON: {error}"),
        )
    })
}

fn conversation_to_json(c: &ChatConversationRecord) -> serde_json::Value {
    json!({
        "conversationId": c.conversation_id,
        "title": c.title,
        "summary": c.summary,
        "lastMessagePreview": c.last_message_preview,
        "messageCount": c.message_count,
        "model": c.model,
        "status": c.status,
        "directoryId": c.directory_id,
        "forkedFromConversationId": c.forked_from_conversation_id,
        "forkMessageCount": c.fork_message_count,
        "conversationType": c.conversation_type,
        "parentConversationId": c.parent_conversation_id,
        "subAgentId": c.sub_agent_id,
        "subAgentName": c.sub_agent_name,
        "subAgentStatus": c.sub_agent_status,
        "subAgentError": c.sub_agent_error,
        "createdAt": c.created_at,
        "updatedAt": c.updated_at,
        "inputTokens": c.input_tokens,
        "outputTokens": c.output_tokens,
        "cacheCreationInputTokens": c.cache_creation_input_tokens,
        "cacheReadInputTokens": c.cache_read_input_tokens,
        "totalDurationMs": c.total_duration_ms,
    })
}

fn message_to_json(m: &ChatMessageRecord) -> serde_json::Value {
    json!({
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "thinking": m.thinking,
        "thinkingDurationMs": m.thinking_duration_ms,
        "thinkingTokenCount": m.thinking_token_count,
        "status": m.status,
        "model": m.model,
        "responseId": m.response_id,
        "checkpointId": m.checkpoint_id,
        "toolCallsJson": m.tool_calls_json,
        "createdAt": m.created_at,
    })
}
