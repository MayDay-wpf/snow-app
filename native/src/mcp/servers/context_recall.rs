//! 上下文回溯（context-recall）内置 MCP 服务：分层增量压缩的可逆面。
//!
//! 折叠压缩把较早的消息替换成摘要，但原始消息仍在库内。本工具只读：
//! - search：对本会话全部落库内容（原始消息 + 折叠摘要）做 grep 式检索
//!   （字面量或正则），返回命中行片段与所属折叠段；
//! - expand：按折叠段序号或消息 ref 读回原始消息，按 token 预算分页。
//!
//! 会话 id 由 `call_mcp_tool` 分发层注入，模型无法跨会话读取；全部 SQLite
//! 读取在 spawn_blocking 中执行。

use napi::bindgen_prelude::*;
use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use crate::api::conversation::tool_messages::parse_tool_results_json;
use crate::api::token_counter::{count_tokens, truncate_middle_by_tokens};
use crate::storage::services::chat_conversations::{list_recall_rows, ContextFoldMeta, RecallRow};

const SERVER_ID: &str = "context";

const DEFAULT_SEARCH_LIMIT: usize = 20;
const MAX_SEARCH_LIMIT: usize = 100;
const MAX_LINES_PER_HIT: usize = 3;
const SNIPPET_MAX_CHARS: usize = 240;
const DEFAULT_EXPAND_TOKENS: usize = 6000;
const MAX_EXPAND_TOKENS: usize = 16000;
const REGEX_SIZE_LIMIT: usize = 1 << 20;

pub struct ContextRecallService;

impl ContextRecallService {
    pub fn new() -> Self {
        ContextRecallService
    }

    /// call.rs 分发入口：`conversation_id` 为当前会话（分发层注入）。
    pub async fn execute_async(
        &self,
        args: &Value,
        conversation_id: Option<&str>,
    ) -> napi::Result<Value> {
        let conversation_id = conversation_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "context-recall needs a persisted conversation; nothing has been stored yet."
                        .to_string(),
                )
            })?
            .to_string();
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let args = args.clone();
        tokio::task::spawn_blocking(move || {
            let database_path = crate::storage::ensure_database_file()?;
            let rows = list_recall_rows(&database_path, &conversation_id)?;
            match action.as_str() {
                "search" => search(&rows, &args),
                "expand" => expand(&rows, &args),
                other => Err(invalid(format!(
                    "Unknown action \"{other}\" for context-recall. Available actions: [search, expand]"
                ))),
            }
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("context-recall task failed: {error}"),
            )
        })?
    }
}

fn invalid(message: String) -> Error {
    Error::new(Status::InvalidArg, message)
}

fn optional_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

/// 一行的可检索 / 可读文本：正文 + 工具调用 + 工具结果。
fn row_text(row: &RecallRow) -> String {
    let mut parts: Vec<String> = Vec::new();
    let content = row.content.trim();
    if !content.is_empty() {
        parts.push(content.to_string());
    }
    if !row.tool_calls_json.is_empty() {
        parts.push(format!("Tool calls: {}", row.tool_calls_json));
    }
    if !row.tool_results_json.is_empty() {
        for (name, _call_id, result) in parse_tool_results_json(&row.tool_results_json) {
            parts.push(format!("Tool result ({name}): {result}"));
        }
    }
    parts.join("\n")
}

/// 原始消息所属的折叠段：取覆盖它的最新折叠（通常就是上下文里的活跃段）。
fn covering_section(folds: &[&ContextFoldMeta], row_id: &str) -> Option<i64> {
    folds
        .iter()
        .rev()
        .find(|meta| meta.covers(row_id))
        .map(|meta| meta.seq)
}

/// 以命中位置为中心截取单行片段（按字符计数，保证 UTF-8 边界）。
fn snippet(line: &str, match_start: usize) -> String {
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    if chars.len() <= SNIPPET_MAX_CHARS {
        return line.trim().to_string();
    }
    let center = chars
        .iter()
        .position(|(offset, _)| *offset >= match_start)
        .unwrap_or(0);
    let begin = center.saturating_sub(SNIPPET_MAX_CHARS / 3);
    let end = (begin + SNIPPET_MAX_CHARS).min(chars.len());
    let begin = end.saturating_sub(SNIPPET_MAX_CHARS);
    let text: String = chars[begin..end].iter().map(|(_, ch)| *ch).collect();
    format!(
        "{}{}{}",
        if begin > 0 { "..." } else { "" },
        text.trim(),
        if end < chars.len() { "..." } else { "" }
    )
}

fn build_matcher(args: &Value) -> napi::Result<Regex> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("query is required for action=search".to_string()))?;
    let use_regex = args.get("regex").and_then(Value::as_bool).unwrap_or(false);
    let case_sensitive = args
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|error| invalid(format!("Invalid regex: {error}")))
}

fn search(rows: &[RecallRow], args: &Value) -> napi::Result<Value> {
    let matcher = build_matcher(args)?;
    let limit = optional_usize(args, "limit")
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let offset = optional_usize(args, "offset").unwrap_or(0);
    let folds: Vec<&ContextFoldMeta> = rows.iter().filter_map(|row| row.fold.as_ref()).collect();

    let mut total = 0usize;
    let mut hits: Vec<Value> = Vec::new();
    for row in rows {
        let text = row_text(row);
        let matched: Vec<(usize, &str)> = text
            .lines()
            .filter_map(|line| matcher.find(line).map(|found| (found.start(), line)))
            .collect();
        if matched.is_empty() {
            continue;
        }
        total += 1;
        if total <= offset || hits.len() >= limit {
            continue;
        }
        let lines: Vec<String> = matched
            .iter()
            .take(MAX_LINES_PER_HIT)
            .map(|(start, line)| snippet(line, *start))
            .collect();
        let mut hit = json!({
            "ref": row.id,
            "role": row.role,
            "lines": lines,
        });
        match row.fold.as_ref() {
            Some(meta) => {
                hit["kind"] = json!("summary");
                hit["section"] = json!(meta.seq);
            }
            None => {
                hit["kind"] = json!("message");
                if let Some(section) = covering_section(&folds, &row.id) {
                    hit["section"] = json!(section);
                }
            }
        }
        if matched.len() > MAX_LINES_PER_HIT {
            hit["moreMatchingLines"] = json!(matched.len() - MAX_LINES_PER_HIT);
        }
        hits.push(hit);
    }

    let next_offset = (offset + hits.len() < total).then_some(offset + hits.len());
    Ok(json!({
        "hits": hits,
        "count": hits.len(),
        "total": total,
        "nextOffset": next_offset,
    }))
}

fn expand(rows: &[RecallRow], args: &Value) -> napi::Result<Value> {
    let section = args.get("section").and_then(Value::as_i64);
    let start_ref = args
        .get("ref")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let budget = optional_usize(args, "maxTokens")
        .unwrap_or(DEFAULT_EXPAND_TOKENS)
        .clamp(500, MAX_EXPAND_TOKENS);

    let range: Option<&ContextFoldMeta> = match section {
        Some(seq) => Some(
            rows.iter()
                .filter_map(|row| row.fold.as_ref())
                .find(|meta| meta.seq == seq)
                .ok_or_else(|| invalid(format!("Compressed section #{seq} does not exist")))?,
        ),
        None => None,
    };
    if range.is_none() && start_ref.is_none() {
        return Err(invalid(
            "action=expand needs section (compressed section number) and/or ref (message id)"
                .to_string(),
        ));
    }

    let candidates: Vec<&RecallRow> = rows
        .iter()
        .filter(|row| row.fold.is_none())
        .filter(|row| range.is_none_or(|meta| meta.covers(&row.id)))
        .filter(|row| start_ref.is_none_or(|start| row.id.as_str() >= start))
        .collect();
    if candidates.is_empty() {
        return Err(invalid("No stored messages match this section/ref".to_string()));
    }

    let mut used = 0usize;
    let mut messages: Vec<Value> = Vec::new();
    let mut next_ref: Option<String> = None;
    for (index, row) in candidates.iter().enumerate() {
        let text = row_text(row);
        let tokens = count_tokens(&text);
        let remaining = budget - used;
        if tokens <= remaining {
            used += tokens;
            messages.push(json!({ "ref": row.id, "role": row.role, "text": text }));
            continue;
        }
        if messages.is_empty() {
            // 单条消息就超出预算：截断中段后返回，下一页从下一条继续。
            messages.push(json!({
                "ref": row.id,
                "role": row.role,
                "text": truncate_middle_by_tokens(&text, remaining),
                "truncated": true,
            }));
            used = budget;
            next_ref = candidates.get(index + 1).map(|next| next.id.clone());
        } else {
            next_ref = Some(row.id.clone());
        }
        break;
    }

    Ok(json!({
        "section": section,
        "messages": messages,
        "count": messages.len(),
        "tokens": used,
        "nextRef": next_ref,
    }))
}

impl McpService for ContextRecallService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: "recall".to_string(),
            description: "Recall conversation history that incremental context compression folded away. Older messages are replaced in your context by summaries headed \"[Compressed conversation section #N · tier T]\"; the original messages stay stored and can be read back here. Use it when a summary lacks an exact detail you need (an earlier file content, an error text, the user's exact wording, a command output) instead of guessing or redoing the work.\n\nACTIONS:\n- search: grep the full stored history of this conversation (original messages and section summaries). Required query; regex (default false = literal text), caseSensitive (default false), limit (default 20, max 100), offset for paging. Each hit carries ref (message id), role, kind (message | summary), section (the compressed section covering it, if any) and the matching line snippets.\n- expand: read original messages back. Pass section=N to read the messages folded into section #N, and/or ref=<message id> to start from that message (together: within the section; ref alone: from that message onward). maxTokens bounds the result (default 6000, max 16000); when more remains the result carries nextRef — call again with it to continue.\n\nRead-only. The conversation is injected by the runtime — never pass ids of other conversations.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["search", "expand"],
                        "description": "search = grep stored history; expand = read original messages back."
                    },
                    "query": {
                        "type": "string",
                        "description": "search: text (or regex when regex=true) matched line by line."
                    },
                    "regex": {
                        "type": "boolean",
                        "description": "search: treat query as a regular expression (default false)."
                    },
                    "caseSensitive": {
                        "type": "boolean",
                        "description": "search: case-sensitive matching (default false)."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "search: max hits (default 20, max 100)."
                    },
                    "offset": {
                        "type": "integer",
                        "description": "search: skip this many hits (use nextOffset from the previous result)."
                    },
                    "section": {
                        "type": "integer",
                        "description": "expand: compressed section number N from \"[Compressed conversation section #N ...]\"."
                    },
                    "ref": {
                        "type": "string",
                        "description": "expand: message id (ref from search hits or nextRef) to start reading from."
                    },
                    "maxTokens": {
                        "type": "integer",
                        "description": "expand: token budget of the returned text (default 6000, max 16000)."
                    }
                },
                "required": ["action"]
            }),
        }]
    }

    /// 同步 fallback：本工具依赖分发层注入的会话 id，只能走异步路径。
    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "Tool \"{tool_name}\" of server \"context\" requires the async call_mcp_tool path (conversation context). Available tools: [context-recall]"
            ),
        ))
    }
}
