use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};

use super::super::super::database;
use super::super::chat_conversations::create_chat_id;

const PREVIEW_MAX_CHARS: usize = 180;

/// 导入「导出会话」JSON（单会话对象或会话数组）为当前项目下的新会话。
/// 解析与落库全部在 Rust 侧完成，调用方只需给出文件路径与目标目录，
/// 返回 JSON 字符串描述实际导入的会话列表。
pub fn import_conversation(
    database_path: &Path,
    directory_id: &str,
    file_path: &str,
) -> Result<String> {
    let directory_id = directory_id.trim();
    if directory_id.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Directory ID is required to import conversations",
        ));
    }

    let raw = std::fs::read_to_string(file_path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read conversation import file '{file_path}': {error}"),
        )
    })?;

    let parsed: Value = serde_json::from_str(&raw).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid conversation JSON in '{file_path}': {error}"),
        )
    })?;

    let entries = match parsed {
        Value::Array(items) => items,
        other => vec![other],
    };

    let mut imported: Vec<Value> = Vec::with_capacity(entries.len());
    for entry in &entries {
        imported.push(import_entry(database_path, directory_id, entry)?);
    }

    serde_json::to_string(&json!({ "imported": imported })).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize conversation import result: {error}"),
        )
    })
}

fn import_entry(database_path: &Path, directory_id: &str, entry: &Value) -> Result<Value> {
    let conversation = entry.get("conversation").ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Missing 'conversation' object in conversation import file",
        )
    })?;
    let messages = entry
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let title = resolve_title(conversation);
    let summary = string_field(conversation, "summary");
    let model = string_field(conversation, "model");
    let preview = resolve_preview(conversation, &messages);
    let message_count = messages.len() as i64;
    let conversation_id = format!("conv-{}", database::create_snowflake_id());

    database::with_write_lock(|| -> Result<()> {
        let mut connection = database::open_connection(database_path)
            .map_err(|error| database::database_error(database_path, "open", error))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                database::database_error(database_path, "begin conversation import", error)
            })?;

        transaction
            .execute(
                "INSERT INTO chat_conversations (
                   id,
                   conversation_id,
                   title,
                   summary,
                   last_message_preview,
                   message_count,
                   model,
                   api_profile_name,
                   last_response_id,
                   status,
                   input_tokens,
                   output_tokens,
                   cache_creation_input_tokens,
                   cache_read_input_tokens,
                   total_duration_ms,
                   directory_id,
                   forked_from_conversation_id,
                   fork_message_count,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', 'active',
                   ?8, ?9, ?10, ?11, ?12, ?13, '', 0,
                   datetime('now', 'localtime'), datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    title,
                    summary,
                    preview,
                    message_count,
                    model,
                    non_negative_i64(conversation, "inputTokens"),
                    non_negative_i64(conversation, "outputTokens"),
                    non_negative_i64(conversation, "cacheCreationInputTokens"),
                    non_negative_i64(conversation, "cacheReadInputTokens"),
                    non_negative_i64(conversation, "totalDurationMs"),
                    directory_id,
                ],
            )
            .map_err(|error| {
                database::database_error(database_path, "import conversation", error)
            })?;

        for (index, message) in messages.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO chat_messages (
                       id,
                       message_id,
                       conversation_id,
                       role,
                       content,
                       model,
                       response_id,
                       checkpoint_id,
                       status,
                       interruption_reason,
                       recovery_outcome,
                       raw_json,
                       thinking,
                       thinking_duration_ms,
                       thinking_token_count,
                       thinking_blocks_json,
                       tool_calls_json,
                       input_tokens,
                       output_tokens,
                       cache_creation_input_tokens,
                       cache_read_input_tokens,
                       created_at
                     ) VALUES (
                       ?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, NULL, NULL, '{}',
                       ?9, ?10, ?11, '[]', ?12, ?13, ?14, ?15, ?16, datetime('now', 'localtime')
                     )",
                    params![
                        database::create_snowflake_id(),
                        create_chat_id(&format!("msg{index}")),
                        conversation_id,
                        normalize_role(&string_field(message, "role")),
                        string_field(message, "content"),
                        model,
                        string_field(message, "responseId"),
                        normalize_status(&string_field(message, "status")),
                        string_field(message, "thinking"),
                        non_negative_i64(message, "thinkingDurationMs"),
                        non_negative_i64(message, "thinkingTokenCount"),
                        json_array_field(message, "toolCallsJson"),
                        non_negative_i64(message, "inputTokens"),
                        non_negative_i64(message, "outputTokens"),
                        non_negative_i64(message, "cacheCreationInputTokens"),
                        non_negative_i64(message, "cacheReadInputTokens"),
                    ],
                )
                .map_err(|error| {
                    database::database_error(database_path, "import conversation message", error)
                })?;
        }

        transaction.commit().map_err(|error| {
            database::database_error(database_path, "commit conversation import", error)
        })
    })?;

    Ok(json!({
        "conversationId": conversation_id,
        "title": title,
        "messageCount": message_count,
    }))
}

fn string_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn non_negative_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn json_array_field(value: &Value, key: &str) -> String {
    match value.get(key).and_then(Value::as_str) {
        Some(raw) if raw.trim_start().starts_with('[') => raw.to_string(),
        _ => "[]".to_string(),
    }
}

fn normalize_role(role: &str) -> String {
    match role.trim() {
        "assistant" => "assistant",
        "system" => "system",
        "developer" => "developer",
        "tool" => "tool",
        _ => "user",
    }
    .to_string()
}

fn normalize_status(status: &str) -> String {
    match status.trim() {
        "completed" => "completed",
        "error" => "error",
        "cancelled" => "cancelled",
        _ => "sent",
    }
    .to_string()
}

fn resolve_title(conversation: &Value) -> String {
    let title = string_field(conversation, "title");
    if !title.trim().is_empty() {
        return title;
    }
    let summary = string_field(conversation, "summary");
    if !summary.trim().is_empty() {
        return summary;
    }
    "Untitled".to_string()
}

fn resolve_preview(conversation: &Value, messages: &[Value]) -> String {
    let preview = string_field(conversation, "lastMessagePreview");
    if !preview.trim().is_empty() {
        return preview;
    }

    let Some(last) = messages.last() else {
        return String::new();
    };
    let content = string_field(last, "content");
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(PREVIEW_MAX_CHARS).collect()
}