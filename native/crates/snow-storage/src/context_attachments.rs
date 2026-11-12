//! 会话上下文引用（历史会话拖拽 chip）的渲染与注入预算。
//!
//! 「把会话 A 作为上下文引入会话 B」不再使用数据库附件表：A 的引用以
//! `@@conversation:` 标签随用户消息内容进入请求，各 provider 的 payload
//! 构建层经 `parse_chat_message_content` 调用本模块把标签就地展开为
//! 精简渲染的对话记录上下文块（首条消息即生效，无挂载时序问题）。
//!
//! 渲染策略：剔除思考与 tool 执行噪音、超长按消息边界裁剪保留最近内容。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};

use snow_storage_core::database;
use crate::chat_conversations::load_context_messages;
use snow_storage_core::system_settings::get_system_setting_value;

/// 注入上下文预算（字符数）：超长会话按消息边界裁剪、保留最近内容。
/// 中文约 1 token ≈ 1-2 字符，40k 字符约对应 2-4 万 token 的对话量。
pub const ATTACH_CONTEXT_BUDGET_CHARS: usize = 40_000;

/// 全部引用合计的注入预算上限（字符数）：防止多个引用叠加撑爆上下文。
pub const ATTACH_CONTEXT_TOTAL_BUDGET_CHARS: usize = 60_000;

/// 预算设置项 code（system_settings 表，可配置范围 1000..=200_000）。
pub const ATTACH_CONTEXT_SINGLE_BUDGET_SETTING: &str = "attach_context_single_budget_chars";
pub const ATTACH_CONTEXT_TOTAL_BUDGET_SETTING: &str = "attach_context_total_budget_chars";

/// 读取用户配置的引用注入预算（字符数）：(单引用预算, 总预算)。
/// 设置缺失 / 非法 / 超出保护范围时回退默认值。
pub fn read_attach_context_budgets(database_path: &Path) -> (usize, usize) {
    let single = read_budget_setting(
        database_path,
        ATTACH_CONTEXT_SINGLE_BUDGET_SETTING,
        ATTACH_CONTEXT_BUDGET_CHARS,
    );
    let total = read_budget_setting(
        database_path,
        ATTACH_CONTEXT_TOTAL_BUDGET_SETTING,
        ATTACH_CONTEXT_TOTAL_BUDGET_CHARS,
    );
    (single, total)
}

/// 读取单个预算设置；缺失 / 非法 / 超出 [MIN, MAX] 时回退默认值。
fn read_budget_setting(database_path: &Path, code: &str, default: usize) -> usize {
    const MIN_BUDGET: usize = 1_000;
    const MAX_BUDGET: usize = 200_000;
    get_system_setting_value(database_path, code)
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| (MIN_BUDGET..=MAX_BUDGET).contains(value))
        .unwrap_or(default)
}

/// 智能精简渲染「会话 A」为单条 user 上下文块（Markdown）。
///
/// 流水线：
/// 1. 过滤：跳过 role=tool 消息（纯执行噪音）；跳过空正文消息；
/// 2. 剥离思考：不复制 thinking / thinking_blocks_json / tool_calls_json，
///    仅保留 user / assistant 正文；
/// 3. 裁剪：超出预算时按消息边界从最旧开始丢弃，
///    保证至少保留最后 1 条消息（保留最近内容）。
///
/// 非递归：只渲染被引用会话自身的消息，其内部的 `@@conversation:` 标签
/// 按原文保留（不跟随展开，防止上下文爆炸 / 循环引用）。
pub fn render_attachment_context_with_budget(
    database_path: &Path,
    source_id: &str,
    budget_chars: usize,
) -> Result<String> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open db for render context", error))?;
    let title: String = connection
        .query_row(
            "SELECT COALESCE(title, '') FROM chat_conversations WHERE conversation_id = ?1",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "load source title", error))?
        .unwrap_or_default();

    let messages = load_context_messages(database_path, source_id)?;
    if messages.is_empty() {
        return Ok(String::new());
    }

    let display_title = if title.trim().is_empty() {
        "(未命名会话)".to_string()
    } else {
        title
    };

    // 按消息边界渲染为分段，记录总长度
    let mut segments: Vec<String> = Vec::with_capacity(messages.len());
    let mut total_len: usize = 0;
    for message in &messages {
        let content = message.content.trim();
        if content.is_empty() || message.role.trim() == "tool" {
            continue;
        }
        let label = if message.role.trim() == "user" {
            "## 用户"
        } else {
            "## 助手"
        };
        let segment = format!("\n{label}\n{content}\n");
        total_len += segment.len();
        segments.push(segment);
    }
    if segments.is_empty() {
        return Ok(String::new());
    }

    // 超长裁剪：从最旧（队首）丢弃整段，保底保留最后 1 条
    while total_len > budget_chars && segments.len() > 1 {
        if let Some(removed) = segments.first() {
            total_len = total_len.saturating_sub(removed.len());
            segments.remove(0);
        }
    }

    let body = segments.concat();
    Ok(format!(
        "[引用的历史会话：{display_title}]\n\n以下是另一会话「{display_title}」的对话记录（已自动精简：去除内部思考与工具执行细节），作为背景上下文参考：{body}"
    ))
}
