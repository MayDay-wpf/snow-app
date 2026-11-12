use snow_storage_core::database;
use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use std::cell::Cell;
use std::path::Path;

// References only: file content/diffs remain in their original tool records.
pub fn save_task_history(
    path: &Path,
    conversation_id: &str,
    response_id: &str,
    manifest: &str,
) -> Result<()> {
    let value: serde_json::Value =
        serde_json::from_str(manifest).map_err(|_| Error::from_reason("Invalid task manifest"))?;
    let object = value
        .as_object()
        .ok_or_else(|| Error::from_reason("Invalid task manifest"))?;
    if object.len() != 3
        || value["version"] != 1
        || value["taskId"].as_str().filter(|s| !s.is_empty()).is_none()
        || !value["sources"].is_array()
    {
        return Err(Error::from_reason("Invalid task manifest"));
    }
    for source in value["sources"].as_array().unwrap() {
        let fields = source
            .as_object()
            .ok_or_else(|| Error::from_reason("Invalid task source"))?;
        if fields.len() != 3
            || source["conversationId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .is_none()
            || !source["subAgentName"].is_string()
            || !source["recordIds"].as_array().is_some_and(|ids| {
                ids.iter()
                    .all(|id| id.as_str().is_some_and(|id| !id.is_empty()))
            })
        {
            return Err(Error::from_reason("Invalid task source"));
        }
    }
    // 校验读与写入必须处于同一个 IMMEDIATE 事务：DEFERRED 事务先 SELECT 后
    // UPDATE，在 WAL 下若读快照之后有其他连接提交，读事务升级为写事务会直接
    // 返回 SQLITE_BUSY_SNAPSHOT（busy_timeout 对此不生效），即 "database is
    // locked"。IMMEDIATE 在事务开始时就取得写锁；全局写锁让同进程写者排队，
    // 锁竞争时整个事务回滚后有限重试——重试只重做这次保存，不涉及 AI 任务。
    // 业务校验失败以内层 Err 返回（事务随之回滚），不会触发重试。
    let stage = Cell::new("open connection");
    let outcome = database::with_write_lock(|| {
        database::with_write_retry(
            || -> rusqlite::Result<std::result::Result<(), &'static str>> {
                stage.set("open connection");
                let mut connection = database::open_connection(path)?;
                stage.set("begin task history transaction");
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                stage.set("validate task reply");
                let reply_count: i64 = transaction.query_row("SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?1 AND response_id = ?2 AND role = 'assistant'", params![conversation_id, response_id], |row| row.get(0))?;
                if reply_count != 1 {
                    return Ok(Err("Task reply identity is missing or ambiguous"));
                }
                stage.set("find task reply");
                let (message_id, raw): (String, String) = transaction.query_row("SELECT id, raw_json FROM chat_messages WHERE conversation_id = ?1 AND response_id = ?2 AND role = 'assistant' ORDER BY id DESC LIMIT 1", params![conversation_id, response_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                let mut owns_reply = false;
                for source in value["sources"].as_array().unwrap() {
                    let source_id = source["conversationId"].as_str().unwrap();
                    let mut ancestor = source_id.to_string();
                    let mut visited = std::collections::HashSet::new();
                    stage.set("validate task scope");
                    while ancestor != conversation_id && visited.insert(ancestor.clone()) {
                        let parent: Option<String> = transaction.query_row("SELECT parent_conversation_id FROM sub_agent_sessions WHERE conversation_id = ?1", params![ancestor], |row| row.get(0)).optional()?;
                        ancestor = parent.unwrap_or_default();
                    }
                    if ancestor != conversation_id {
                        return Ok(Err("Task source is outside its conversation scope"));
                    }
                    stage.set("validate task record");
                    for id in source["recordIds"].as_array().unwrap() {
                        let id = id.as_str().unwrap();
                        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM chat_messages WHERE conversation_id = ?1 AND id = ?2)", params![source_id, id], |row| row.get(0))?;
                        if !exists {
                            return Ok(Err("Task record is missing"));
                        }
                        owns_reply |= source_id == conversation_id && id == message_id;
                    }
                }
                if !owns_reply {
                    return Ok(Err("Task must own its end reply"));
                }
                let Ok(mut stored) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    return Ok(Err("Invalid stored response metadata"));
                };
                let Some(stored) = stored.as_object_mut() else {
                    return Ok(Err("Invalid stored response metadata"));
                };
                if let Some(existing) = stored.get("__snowTaskHistory") {
                    // 已保存的元数据不可改写；相同值视为幂等重试成功。
                    return Ok(if existing == &value {
                        Ok(())
                    } else {
                        Err("Task history is immutable")
                    });
                }
                stored.insert("__snowTaskHistory".to_string(), value.clone());
                let Ok(json) = serde_json::to_string(&stored) else {
                    return Ok(Err("Cannot serialize task history"));
                };
                stage.set("save task history");
                transaction.execute(
                    "UPDATE chat_messages SET raw_json = ?2 WHERE id = ?1 AND role = 'assistant'",
                    params![message_id, json],
                )?;
                stage.set("commit task history");
                transaction.commit()?;
                Ok(Ok(()))
            },
            "save task history",
        )
    })
    .map_err(|e| database::database_error(path, stage.get(), e))?;
    outcome.map_err(Error::from_reason)
}

pub fn list_task_history(path: &Path, conversation_id: &str) -> Result<Vec<String>> {
    let connection = database::open_connection(path)
        .map_err(|e| database::database_error(path, "read task history", e))?;
    let mut statement = connection.prepare("SELECT id, response_id, raw_json FROM chat_messages WHERE conversation_id = ?1 AND role = 'assistant' ORDER BY id ASC").map_err(|e| database::database_error(path, "read task history", e))?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| database::database_error(path, "read task history", e))?;
    let mut result = Vec::new();
    for row in rows {
        let (id, response_id, raw) =
            row.map_err(|e| database::database_error(path, "read task history", e))?;
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(manifest) = raw.get("__snowTaskHistory") {
                result.push(serde_json::json!({"messageId": id, "responseId": response_id, "manifest": manifest}).to_string());
            }
        }
    }
    Ok(result)
}
