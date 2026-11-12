//! 分层增量压缩（context fold）的存储层：折叠元数据、上下文视图与原文读取。
//!
//! 一次折叠落库为一条 status=context_compaction、origin=internal 的 user 行：
//! content 是模型写的摘要，raw_json 携带 `{"contextFold":{seq,tier,startId,endId}}`。
//! 被折叠的原始消息是 `[startId, endId]` 区间内的行（行 id 的字典序与插入顺序一致，
//! 与 `load_context_messages` 的 `id >=` 比较口径相同），它们原样留在库内，只在
//! 组装上下文时被摘要替换。没有该元数据的压缩行是交接式压缩边界，仍是上下文起点。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use snow_storage_core::database;
use super::ChatContextMessage;

/// raw_json 中折叠元数据的键。SQL 侧用 `instr(raw_json, '"contextFold"')` 识别。
const FOLD_META_KEY: &str = "contextFold";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFoldMeta {
    /// 会话内的折叠序号（从 1 递增），即摘要标题里的 `#N`。
    pub seq: i64,
    /// 层级：1 = 直接由原始消息折叠；合并已有摘要时取被合并层级 + 1（上限 3）。
    pub tier: i64,
    pub start_id: String,
    pub end_id: String,
}

impl ContextFoldMeta {
    pub fn parse(raw_json: &str) -> Option<Self> {
        if !raw_json.contains(FOLD_META_KEY) {
            return None;
        }
        let value = serde_json::from_str::<Value>(raw_json).ok()?;
        serde_json::from_value(value.get(FOLD_META_KEY)?.clone()).ok()
    }

    pub fn to_raw_json(&self) -> String {
        serde_json::json!({ FOLD_META_KEY: self }).to_string()
    }

    pub fn covers(&self, row_id: &str) -> bool {
        row_id >= self.start_id.as_str() && row_id <= self.end_id.as_str()
    }
}

/// 折叠压缩成功后随压缩边界一起落库的信息。
pub struct ContextFoldRecord {
    pub meta: ContextFoldMeta,
    /// 压缩请求里被折叠的区间与压缩指令的估算 token：折叠后不再进入上下文，
    /// 从压缩调用的输入用量里扣除。
    pub removed_tokens: i64,
    /// 原样保留的近期消息估算 token：压缩请求没有发送它们，折叠后仍在上下文里。
    pub retained_tokens: i64,
}

impl ContextFoldRecord {
    /// 折叠后的上下文快照：压缩调用输入 - 被折叠部分 + 保留部分 + 新摘要。
    pub fn context_input_tokens(&self, call_input_tokens: i64, summary_tokens: i64) -> i64 {
        (call_input_tokens - self.removed_tokens + self.retained_tokens).max(0) + summary_tokens
    }
}

/// 上下文视图中的一项：原样消息，或替换了一段原始消息的折叠摘要。
pub enum ContextViewItem {
    Message {
        id: String,
        message: ChatContextMessage,
    },
    Fold {
        meta: ContextFoldMeta,
        summary: String,
    },
}

impl ContextViewItem {
    pub fn to_message(&self) -> ChatContextMessage {
        match self {
            Self::Message { message, .. } => message.clone(),
            Self::Fold { meta, summary } => ChatContextMessage {
                role: "user".to_string(),
                origin: super::ORIGIN_INTERNAL.to_string(),
                content: render_fold_summary(meta, summary),
                tool_calls_json: None,
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
        }
    }
}

/// 折叠摘要在上下文中的固定呈现。只由落库数据决定，保证每次请求逐字节一致，
/// 折叠之前的前缀缓存不受影响。
pub fn render_fold_summary(meta: &ContextFoldMeta, summary: &str) -> String {
    format!(
        "[Compressed conversation section #{} · tier {}]\n{}",
        meta.seq,
        meta.tier,
        summary.trim()
    )
}

/// `load_context_messages` 读出的一行（已按原有规则过滤）。
pub(super) struct ContextRow {
    pub id: String,
    pub fold: Option<ContextFoldMeta>,
    pub message: ChatContextMessage,
}

/// 应用折叠：被更新折叠区间完整包含的旧折叠视为已合并；其余活跃折叠替换其覆盖
/// 的行，摘要出现在区间第一行的位置，折叠行自身不再按落库时间出现。
pub(super) fn build_view(rows: Vec<ContextRow>) -> Vec<ContextViewItem> {
    let mut folds: Vec<(ContextFoldMeta, String)> = Vec::new();
    let mut messages: Vec<(String, ChatContextMessage)> = Vec::new();
    for row in rows {
        match row.fold {
            Some(meta) => folds.push((meta, row.message.content)),
            None => messages.push((row.id, row.message)),
        }
    }
    if folds.is_empty() {
        return messages
            .into_iter()
            .map(|(id, message)| ContextViewItem::Message { id, message })
            .collect();
    }

    let mut active: Vec<(ContextFoldMeta, String)> = folds
        .iter()
        .enumerate()
        .filter(|(index, (meta, _))| {
            !folds[index + 1..].iter().any(|(later, _)| {
                later.start_id <= meta.start_id && meta.end_id <= later.end_id
            })
        })
        .map(|(_, fold)| fold.clone())
        .collect();
    active.sort_by(|left, right| left.0.start_id.cmp(&right.0.start_id));

    let mut view = Vec::with_capacity(messages.len() + active.len());
    let mut pending = active.into_iter().peekable();
    let mut current: Option<ContextFoldMeta> = None;
    for (id, message) in messages {
        while pending
            .peek()
            .is_some_and(|(meta, _)| meta.start_id.as_str() <= id.as_str())
        {
            let (meta, summary) = pending.next().expect("peeked fold");
            current = Some(meta.clone());
            view.push(ContextViewItem::Fold { meta, summary });
        }
        if current.as_ref().is_some_and(|meta| meta.covers(&id)) {
            continue;
        }
        view.push(ContextViewItem::Message { id, message });
    }
    view.extend(
        pending.map(|(meta, summary)| ContextViewItem::Fold { meta, summary }),
    );
    view
}

/// 会话里已用过的最大折叠序号（含已被合并的折叠），新折叠取它 + 1。
pub fn max_fold_seq(database_path: &Path, conversation_id: &str) -> Result<i64> {
    Ok(list_fold_metas(database_path, conversation_id)?
        .iter()
        .map(|(_, meta, _)| meta.seq)
        .max()
        .unwrap_or(0))
}

/// 会话内全部折叠（含已被合并的旧折叠）：`(折叠行 id, 元数据, 摘要)`，按 id 升序。
pub fn list_fold_metas(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<(String, ContextFoldMeta, String)>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, raw_json, content
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND status = 'context_compaction'
                    AND instr(raw_json, '\"contextFold\"') > 0
                  ORDER BY id ASC",
            )?;
            let rows = statement.query_map(params![conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map(|rows| {
            rows.into_iter()
                .filter_map(|(id, raw_json, content)| {
                    ContextFoldMeta::parse(&raw_json).map(|meta| (id, meta, content))
                })
                .collect()
        })
        .map_err(|error| database::database_error(database_path, "list context folds", error))
}

/// 供 context-recall 读取的原始行（不受压缩边界与折叠影响）。
pub struct RecallRow {
    pub id: String,
    pub role: String,
    pub content: String,
    pub tool_calls_json: String,
    /// tool 行的结构化结果（`[{name, callId, result}]`），其余为空。
    pub tool_results_json: String,
    /// 折叠摘要行的元数据；原始消息为 None。
    pub fold: Option<ContextFoldMeta>,
}

/// 读取会话全部有效行（按 id 升序）：折叠摘要、交接边界与原始消息都在内，
/// 失败的助手行与空行除外。
pub fn list_recall_rows(database_path: &Path, conversation_id: &str) -> Result<Vec<RecallRow>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, role, content, tool_calls_json, raw_json, status
                   FROM chat_messages
                  WHERE conversation_id = ?1
                    AND NOT (role = 'assistant' AND status = 'error')
                    AND (
                      content <> ''
                      OR (role = 'assistant' AND tool_calls_json <> '' AND tool_calls_json <> '[]')
                    )
                  ORDER BY id ASC",
            )?;
            let rows = statement.query_map(params![conversation_id], |row| {
                let role: String = row.get(1)?;
                let raw_json: String = row.get(4)?;
                let status: String = row.get(5)?;
                let fold = if status == "context_compaction" {
                    ContextFoldMeta::parse(&raw_json)
                } else {
                    None
                };
                let tool_results_json =
                    if role.trim() == "tool" && !raw_json.is_empty() && raw_json != "{}" {
                        raw_json
                    } else {
                        String::new()
                    };
                let tool_calls_json: String = row.get(3)?;
                Ok(RecallRow {
                    id: row.get(0)?,
                    role,
                    content: row.get(2)?,
                    tool_calls_json: if tool_calls_json == "[]" {
                        String::new()
                    } else {
                        tool_calls_json
                    },
                    tool_results_json,
                    fold,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| database::database_error(database_path, "list recall rows", error))
}

/// 分叉复制消息时把折叠区间换成新会话的行 id：起点取第一条旧 id ≥ 原起点的行，
/// 终点取最后一条旧 id ≤ 原终点的行。区间在新会话里没有对应行时返回 None，
/// 调用方原样复制（旧 id 早于新会话全部行，不会误覆盖任何消息）。
pub fn translate_fold_raw_json(raw_json: &str, id_pairs: &[(&str, &str)]) -> Option<String> {
    let meta = ContextFoldMeta::parse(raw_json)?;
    let start = id_pairs
        .iter()
        .find(|(old, _)| *old >= meta.start_id.as_str())
        .filter(|(old, _)| *old <= meta.end_id.as_str())
        .map(|(_, new)| new.to_string())?;
    let end = id_pairs
        .iter()
        .rev()
        .find(|(old, _)| *old <= meta.end_id.as_str())
        .map(|(_, new)| new.to_string())?;
    Some(
        ContextFoldMeta {
            start_id: start,
            end_id: end,
            ..meta
        }
        .to_raw_json(),
    )
}
