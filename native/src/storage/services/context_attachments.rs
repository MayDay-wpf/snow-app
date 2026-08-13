//! 会话上下文附件（Context Attachments）
//!
//! 「把会话 A 附加到会话 B 开头作为上下文」的动态引用存储与渲染：
//! - 仅记录「B 附带 A」的引用关系（`conversation_context_attachments` 表），
//!   不改写 A / B 的 `chat_messages` 数据；
//! - `render_attachment_context` 在请求组装时把 A 智能精简渲染为单条
//!   user 上下文块（剔除思考、跳过 tool 执行噪音、超长按消息边界裁剪），
//!   注入与 UI 预览共用同一函数，保证所见即所得；
//! - 约束：同 directory、禁止自引用、目标/源均非子代理会话、幂等去重。

use std::path::Path;

use chrono::Utc;
use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};

use super::super::database;
use super::chat_conversations::load_context_messages;
use super::system_settings::get_system_setting_value;

/// 注入上下文预算（字符数）：超长会话按消息边界裁剪、保留最近内容。
/// 中文约 1 token ≈ 1-2 字符，40k 字符约对应 2-4 万 token 的对话量。
pub const ATTACH_CONTEXT_BUDGET_CHARS: usize = 40_000;

/// 全部附件合计的注入预算上限（字符数）：防止多个附件叠加撑爆上下文。
pub const ATTACH_CONTEXT_TOTAL_BUDGET_CHARS: usize = 60_000;

/// 预算设置项 code（system_settings 表，可配置范围 1000..=200_000）。
pub const ATTACH_CONTEXT_SINGLE_BUDGET_SETTING: &str = "attach_context_single_budget_chars";
pub const ATTACH_CONTEXT_TOTAL_BUDGET_SETTING: &str = "attach_context_total_budget_chars";

/// 读取用户配置的附件注入预算（字符数）：(单附件预算, 总预算)。
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

/// 会话上下文附件记录（服务层结构体；napi 结构体在 storage/mod.rs 门面层）。
#[derive(Debug, Clone)]
pub struct ContextAttachmentRecord {
    pub conversation_id: String,
    pub source_conversation_id: String,
    pub title: String,
    pub emoji: String,
    pub sort_order: i64,
    pub created_at: String,
}

/// 建表（schema 与 CRUD 同模块）。`CREATE TABLE IF NOT EXISTS` 每次启动执行，
/// 老库自动补建新表，无迁移成本。
pub fn ensure_context_attachments_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversation_context_attachments (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL,
           source_conversation_id TEXT NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
           FOREIGN KEY(source_conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
           UNIQUE(conversation_id, source_conversation_id)
         );
         CREATE INDEX IF NOT EXISTS idx_context_attachments_conv
           ON conversation_context_attachments(conversation_id, sort_order ASC);",
    )
}

fn generate_id() -> String {
    let timestamp = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_micros() * 1_000);
    format!("att-{timestamp}-{}", std::process::id())
}

fn get_conversation_directory_id(
    connection: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT directory_id FROM chat_conversations WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()
}

/// 会话是否属于子代理会话（sub_agent_sessions 表中的 conversation_id）。
fn is_sub_agent_session(connection: &Connection, conversation_id: &str) -> rusqlite::Result<bool> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM sub_agent_sessions WHERE conversation_id = ?1 LIMIT 1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(exists.is_some())
}

/// 列出 B 挂载的附带会话（按 sort_order ASC，即注入顺序：先注入在前）。
pub fn list_context_attachments(
    database_path: &Path,
    conversation_id: &str,
) -> Result<Vec<ContextAttachmentRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT a.conversation_id, a.source_conversation_id,
                        COALESCE(c.title, ''), COALESCE(c.emoji, ''),
                        a.sort_order, a.created_at
                   FROM conversation_context_attachments a
                   LEFT JOIN chat_conversations c
                     ON c.conversation_id = a.source_conversation_id
                  WHERE a.conversation_id = ?1
                  ORDER BY a.sort_order ASC, a.created_at ASC, a.id ASC",
            )?;
            let rows = statement.query_map(params![conversation_id], |row| {
                Ok(ContextAttachmentRecord {
                    conversation_id: row.get(0)?,
                    source_conversation_id: row.get(1)?,
                    title: row.get(2)?,
                    emoji: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?;
            // 源会话已被删除（理论上 FK 级联已清，LEFT JOIN 兜底过滤）
            let records: Vec<ContextAttachmentRecord> = rows
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter(|record| !record.source_conversation_id.is_empty())
                .collect();
            Ok(records)
        })
        .map_err(|error| database::database_error(database_path, "list context attachments", error))
}

/// 建立「B 附带 A」引用。校验链：存在性 → 非自引用 → 同 directory →
/// 目标/源非子代理会话 → 幂等去重（已存在则直接返回现有记录）。
pub fn add_context_attachment(
    database_path: &Path,
    target_id: &str,
    source_id: &str,
) -> Result<ContextAttachmentRecord> {
    if target_id.trim().is_empty() || source_id.trim().is_empty() {
        return Err(Error::from_reason(
            "Context attachment requires both target and source conversation ids",
        ));
    }
    if target_id == source_id {
        return Err(Error::from_reason(
            "Cannot attach a conversation to itself",
        ));
    }

    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open db for context attachment", error))?;
    let transaction = connection
        .transaction()
        .map_err(|error| database::database_error(database_path, "begin context attachment tx", error))?;

    let target_directory = get_conversation_directory_id(&transaction, target_id)
        .map_err(|error| database::database_error(database_path, "load target conversation", error))?
        .ok_or_else(|| Error::from_reason(format!("目标会话 {target_id} 不存在")))?;
    let source_directory = get_conversation_directory_id(&transaction, source_id)
        .map_err(|error| database::database_error(database_path, "load source conversation", error))?
        .ok_or_else(|| Error::from_reason(format!("被附加会话 {source_id} 不存在")))?;

    if target_directory != source_directory {
        return Err(Error::from_reason(
            "不能跨项目附加：目标会话与被附加会话必须属于同一工作区目录",
        ));
    }
    if is_sub_agent_session(&transaction, target_id)
        .map_err(|error| database::database_error(database_path, "check target sub-agent", error))?
    {
        return Err(Error::from_reason("子代理会话不能作为附加目标"));
    }
    if is_sub_agent_session(&transaction, source_id)
        .map_err(|error| database::database_error(database_path, "check source sub-agent", error))?
    {
        return Err(Error::from_reason("子代理会话不能被附加"));
    }

    // 幂等：已存在则直接返回
    let existing: Option<ContextAttachmentRecord> = transaction
        .query_row(
            "SELECT conversation_id, source_conversation_id, '',
                    '', sort_order, created_at
               FROM conversation_context_attachments
              WHERE conversation_id = ?1 AND source_conversation_id = ?2",
            params![target_id, source_id],
            |row| {
                Ok(ContextAttachmentRecord {
                    conversation_id: row.get(0)?,
                    source_conversation_id: row.get(1)?,
                    title: row.get(2)?,
                    emoji: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "check existing attachment", error))?;
    if let Some(record) = existing {
        return Ok(record);
    }

    // 取当前最大 sort_order，追加到末尾。
    // COALESCE 兜底：表为空（或该会话尚无附件）时 MAX(sort_order) 返回 NULL，
    // 若直接 row.get::<i64> 会抛 InvalidColumnType（.optional() 只兜「无行」，
    // 兜不住 NULL 值），导致首次附加永远失败。
    let max_order: Option<i64> = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM conversation_context_attachments
              WHERE conversation_id = ?1",
            params![target_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "load attachment order", error))?;
    let next_order = max_order.unwrap_or(-1) + 1;
    let created_at = Utc::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    transaction
        .execute(
            "INSERT INTO conversation_context_attachments
               (id, conversation_id, source_conversation_id, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![generate_id(), target_id, source_id, next_order, created_at],
        )
        .map_err(|error| database::database_error(database_path, "insert context attachment", error))?;

    transaction
        .commit()
        .map_err(|error| database::database_error(database_path, "commit context attachment", error))?;

    // 返回带标题的完整记录
    list_context_attachments(database_path, target_id)?
        .into_iter()
        .find(|record| record.source_conversation_id == source_id)
        .ok_or_else(|| Error::from_reason("附加成功但读取记录失败"))
}

/// 移除「B 附带 A」引用。纯关系删除，A / B 数据不受影响；不存在则静默成功。
pub fn remove_context_attachment(
    database_path: &Path,
    target_id: &str,
    source_id: &str,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM conversation_context_attachments
                  WHERE conversation_id = ?1 AND source_conversation_id = ?2",
                params![target_id, source_id],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "remove context attachment", error))
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
/// 注入与 UI 预览共用此函数（默认预算见 `ATTACH_CONTEXT_BUDGET_CHARS`）。
pub fn render_attachment_context(database_path: &Path, source_id: &str) -> Result<String> {
    render_attachment_context_with_budget(database_path, source_id, ATTACH_CONTEXT_BUDGET_CHARS)
}

/// 带预算的渲染版本：`budget_chars` 控制单附件裁剪上限（字符数）。
/// 注入链路按用户配置的预算调用（见 `read_attach_context_budgets`）；
/// UI 预览保持默认预算，所见即所得。
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
        "[附带的历史会话：{display_title}]\n\n以下是另一会话「{display_title}」的对话记录（已自动精简：去除内部思考与工具执行细节），作为背景上下文参考：{body}"
    ))
}
