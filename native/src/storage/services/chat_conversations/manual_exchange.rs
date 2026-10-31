//! 业务逻辑直接生成的「用户消息 + 助手工具调用」交换（不经模型请求），
//! 例如输入区 WorkFlow 手动编排器提交：图已由用户画好，直接落库成一次工具调用。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};

use crate::storage::database;
use super::{
    create_snippet, create_title, insert_message, is_conversation_tombstoned,
    resolve_conversation_id, ChatContextMessage,
};
use crate::api::conversation::tags::expand_display_tags_in_content;

pub struct ManualToolExchangeInput<'a> {
    pub conversation_id: Option<&'a str>,
    pub directory_id: &'a str,
    pub model: &'a str,
    pub api_profile_name: &'a str,
    pub checkpoint_id: &'a str,
    pub messages: &'a [ChatContextMessage],
    pub tool_calls: &'a [(String, String)],
}

pub struct ManualToolExchange {
    pub conversation_id: String,
    pub response_id: String,
    pub tool_calls_json: String,
    pub persisted_user_message_ids: Vec<String>,
    pub persisted_assistant_message_id: String,
}

pub fn store_manual_tool_exchange(
    database_path: &Path,
    input: &ManualToolExchangeInput<'_>,
) -> Result<ManualToolExchange> {
    if input.tool_calls.is_empty() || input.messages.iter().any(|message| {
        !matches!(message.role.as_str(), "user" | "tool") || message.content.trim().is_empty()
    }) || (input.conversation_id.is_none() && !input.messages.iter().any(|message| message.role == "user")) {
        return Err(Error::from_reason("Invalid manual tool exchange messages or tool calls"));
    }
    let conversation_id = resolve_conversation_id(database_path, input.conversation_id, None)?;
    let snowflake = database::create_snowflake_id();
    let response_id = format!("manual_{snowflake}");
    let tool_calls: Vec<Value> = input.tool_calls.iter().enumerate().map(|(index, (name, arguments_json))| {
        if name.trim().is_empty() {
            return Err(Error::from_reason("Manual tool name is required"));
        }
        let arguments: Value = serde_json::from_str(arguments_json)
            .map_err(|error| Error::from_reason(format!("Invalid tool arguments JSON: {error}")))?;
        if !arguments.is_object() {
            return Err(Error::from_reason("Tool arguments must be a JSON object"));
        }
        Ok(json!({
            "id": format!("call_manual_{snowflake}_{index}"),
            "type": "function",
            "function": { "name": name.trim(), "arguments": arguments.to_string() },
        }))
    }).collect::<Result<_>>()?;
    let tool_calls_json = serde_json::to_string(&tool_calls)
        .map_err(|error| Error::from_reason(format!("Cannot serialize manual tool calls: {error}")))?;
    let mut request_messages = input.messages.to_vec();
    for message in &mut request_messages {
        message.content = crate::api::conversation::images::persist_inline_images_to_disk(&message.content, database_path)?;
        if let Some(raw) = message.tool_results_json.as_deref() {
            message.tool_results_json = Some(crate::api::conversation::images::persist_inline_images_to_disk(raw, database_path)?);
        }
    }
    let title = create_title(&request_messages);
    let preview = request_messages.iter().rev().find(|message| message.role == "user").map(|message| {
        create_snippet(&expand_display_tags_in_content(&message.content).unwrap_or_else(|| message.content.clone()), 180)
    }).unwrap_or_default();

    let persisted = database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if is_conversation_tombstoned(&transaction, &conversation_id)? {
                return Ok(None);
            }
            transaction.execute(
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
                   directory_id,
                   forked_from_conversation_id,
                   fork_message_count,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?3, '', 0, ?4, ?5, ?6, 'active', ?7, '', 0, datetime('now', 'localtime'), datetime('now', 'localtime')
                 )
                 ON CONFLICT(conversation_id) DO NOTHING",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    title,
                    input.model,
                    input.api_profile_name,
                    response_id,
                    input.directory_id,
                ],
            )?;
            let mut user_message_ids = Vec::new();
            for (index, message) in request_messages.iter().enumerate() {
                let is_user = message.role == "user";
                let message_id = insert_message(
                    &transaction,
                    &conversation_id,
                    &message.role,
                    &message.content,
                    "",
                    if is_user { input.checkpoint_id } else { "" },
                    input.model,
                    "sent",
                    None,
                    None,
                    if is_user { "{}" } else { message.tool_results_json.as_deref().unwrap_or("{}") },
                    "",
                    "[]",
                    0,
                    0,
                    "[]",
                    None,
                    index,
                    0,
                    "",
                )?;
                if is_user { user_message_ids.push(message_id); }
            }
            // 无模型调用：不写 token 快照，保留会话已有的上下文用量
            let assistant_message_id = insert_message(
                &transaction,
                &conversation_id,
                "assistant",
                "",
                &response_id,
                "",
                input.model,
                "completed",
                None,
                None,
                "{}",
                "",
                "[]",
                0,
                0,
                &tool_calls_json,
                None,
                request_messages.len(),
                0,
                "",
            )?;
            transaction.execute(
                "UPDATE chat_conversations
                    SET title = CASE WHEN title = '' THEN ?2 ELSE title END,
                        summary = CASE WHEN summary = '' THEN ?2 ELSE summary END,
                        last_message_preview = CASE WHEN ?3 <> '' THEN ?3 ELSE last_message_preview END,
                        message_count = (
                          SELECT COUNT(*)
                            FROM chat_messages
                           WHERE conversation_id = ?1
                        ),
                        model = CASE WHEN ?4 <> '' THEN ?4 ELSE model END,
                        last_response_id = ?5,
                        status = 'active',
                        directory_id = CASE WHEN directory_id = '' THEN ?6 ELSE directory_id END,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![
                    conversation_id,
                    title,
                    preview,
                    input.model,
                    response_id,
                    input.directory_id,
                ],
            )?;
            transaction.commit()?;
            Ok(Some((user_message_ids, assistant_message_id)))
        })
        .map_err(|error| {
            database::database_error(database_path, "store manual tool exchange", error)
        })?;

    let Some((user_message_ids, assistant_message_id)) = persisted else {
        return Err(Error::from_reason("Conversation has been deleted or archived"));
    };

    Ok(ManualToolExchange {
        conversation_id,
        response_id,
        tool_calls_json,
        persisted_user_message_ids: user_message_ids,
        persisted_assistant_message_id: assistant_message_id,
    })
}
