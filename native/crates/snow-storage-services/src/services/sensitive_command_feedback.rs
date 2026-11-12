//! 敏感命令偏好学习：记录用户在拦截提示中的同意 / 拒绝，判定时（建议 / 托管）
//! 挑出相似的历史记录交给决策模型参考。

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::super::database;

/// 保留的记录上限，超出删除最早的。
const MAX_FEEDBACK_ROWS: i64 = 1000;
/// 检索时参与打分的最近记录条数。
const CANDIDATE_ROWS: i64 = 400;
/// 单次判定最多附带的偏好条目（聚合后）。
const MAX_PREFERENCE_EXAMPLES: usize = 12;
/// 落库命令文本上限。
const MAX_STORED_COMMAND_CHARS: usize = 2000;
/// 发给决策模型的单条命令文本上限。
const MAX_EXAMPLE_COMMAND_CHARS: usize = 400;
/// 用户拒绝理由上限。
const MAX_NOTE_CHARS: usize = 300;
/// 词集相似度下限：低于它且未命中同一规则的记录不算相似命令。
const MIN_SIMILARITY: f64 = 0.25;

const USER_APPROVED: &str = "approved";
const USER_REJECTED: &str = "rejected";

pub fn ensure_feedback_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS sensitive_command_feedback (
           id TEXT PRIMARY KEY NOT NULL,
           project_id TEXT NOT NULL DEFAULT '',
           command TEXT NOT NULL,
           rule_ids_json TEXT NOT NULL DEFAULT '[]',
           model_verdict TEXT,
           model_reason TEXT,
           user_decision TEXT NOT NULL,
           user_note TEXT,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_sensitive_command_feedback_created
           ON sensitive_command_feedback(created_at DESC, id DESC);",
    )
}

/// 渲染层上报的一次用户选择（JSON，camelCase）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    #[serde(default)]
    pub project_id: String,
    pub command: String,
    #[serde(default)]
    pub rule_ids: Vec<String>,
    /// 当时决策模型的建议：allow / deny；无判定或判定失败为空。
    #[serde(default)]
    pub model_verdict: Option<String>,
    #[serde(default)]
    pub model_reason: Option<String>,
    /// approved / rejected。
    pub user_decision: String,
    /// 用户填写的拒绝理由（纯文本摘要）。
    #[serde(default)]
    pub user_note: Option<String>,
}

/// 交给决策模型的一条偏好（相同命令 + 相同选择已聚合）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceExample {
    pub command: String,
    pub user_decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_verdict: Option<String>,
    /// 用户推翻了模型的拒绝（模型 deny、用户 approved）。
    pub overrode_model_deny: bool,
    pub times: u32,
    pub last_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_note: Option<String>,
    pub same_project: bool,
}

struct FeedbackRow {
    project_id: String,
    command: String,
    rule_ids: Vec<String>,
    model_verdict: Option<String>,
    user_decision: String,
    user_note: Option<String>,
    created_at: String,
}

/// 解析并校验上报内容；结构非法直接报错，不写脏数据。
pub fn parse_feedback_input(raw: &str) -> Result<FeedbackInput> {
    let mut input: FeedbackInput = serde_json::from_str(raw).map_err(|error| {
        Error::from_reason(format!("Invalid sensitive command feedback: {error}"))
    })?;
    if input.command.trim().is_empty() {
        return Err(Error::from_reason(
            "Sensitive command feedback has no command".to_string(),
        ));
    }
    if !matches!(input.user_decision.as_str(), USER_APPROVED | USER_REJECTED) {
        return Err(Error::from_reason(format!(
            "Invalid sensitive command feedback decision '{}'",
            input.user_decision
        )));
    }
    input.model_verdict = input
        .model_verdict
        .take()
        .filter(|verdict| matches!(verdict.as_str(), "allow" | "deny"));
    input.user_note = input
        .user_note
        .take()
        .map(|note| truncate_chars(note.trim(), MAX_NOTE_CHARS))
        .filter(|note| !note.is_empty());
    input.project_id = input.project_id.trim().to_string();
    Ok(input)
}

pub fn insert_feedback(database_path: &Path, input: &FeedbackInput) -> Result<()> {
    let command = truncate_chars(input.command.trim(), MAX_STORED_COMMAND_CHARS);
    let rule_ids_json = serde_json::to_string(&input.rule_ids).unwrap_or_else(|_| "[]".into());
    database::open_connection(database_path)
        .and_then(|connection| {
            database::with_write_retry(
                || {
                    connection.execute(
                        "INSERT INTO sensitive_command_feedback (
                           id, project_id, command, rule_ids_json, model_verdict, model_reason,
                           user_decision, user_note, created_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now', 'localtime'))",
                        params![
                            database::create_snowflake_id(),
                            &input.project_id,
                            &command,
                            &rule_ids_json,
                            &input.model_verdict,
                            &input.model_reason,
                            &input.user_decision,
                            &input.user_note,
                        ],
                    )?;
                    connection.execute(
                        "DELETE FROM sensitive_command_feedback
                          WHERE id NOT IN (
                            SELECT id FROM sensitive_command_feedback
                             ORDER BY created_at DESC, id DESC
                             LIMIT ?1
                          )",
                        params![MAX_FEEDBACK_ROWS],
                    )?;
                    Ok(())
                },
                "insert sensitive command feedback",
            )
        })
        .map_err(|error| {
            database::database_error(database_path, "insert sensitive command feedback", error)
        })
}

pub fn count_feedback(database_path: &Path) -> Result<u32> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM sensitive_command_feedback",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .map(|count| u32::try_from(count.max(0)).unwrap_or(u32::MAX))
        .map_err(|error| {
            database::database_error(database_path, "count sensitive command feedback", error)
        })
}

pub fn clear_feedback(database_path: &Path) -> Result<u32> {
    database::open_connection(database_path)
        .and_then(|connection| {
            database::with_write_retry(
                || connection.execute("DELETE FROM sensitive_command_feedback", []),
                "clear sensitive command feedback",
            )
        })
        .map(|removed| u32::try_from(removed).unwrap_or(u32::MAX))
        .map_err(|error| {
            database::database_error(database_path, "clear sensitive command feedback", error)
        })
}

/// 挑出与待判定命令相似的历史选择：同一规则命中或词集相近，按相似度、
/// 同项目与新近程度排序，相同命令 + 相同选择聚合为一条。
pub fn find_relevant_preferences(
    database_path: &Path,
    command: &str,
    rule_ids: &[String],
    project_id: &str,
) -> Result<Vec<PreferenceExample>> {
    let rows = load_recent_rows(database_path)?;
    Ok(rank_preferences(rows, command, rule_ids, project_id.trim()))
}

fn load_recent_rows(database_path: &Path) -> Result<Vec<FeedbackRow>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT project_id, command, rule_ids_json, model_verdict, user_decision,
                        user_note, created_at
                   FROM sensitive_command_feedback
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?1",
            )?;
            let rows = statement.query_map(params![CANDIDATE_ROWS], |row| {
                let rule_ids_json: String = row.get(2)?;
                Ok(FeedbackRow {
                    project_id: row.get(0)?,
                    command: row.get(1)?,
                    rule_ids: serde_json::from_str(&rule_ids_json).unwrap_or_default(),
                    model_verdict: row.get(3)?,
                    user_decision: row.get(4)?,
                    user_note: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| {
            database::database_error(database_path, "load sensitive command feedback", error)
        })
}

struct PreferenceGroup {
    example: PreferenceExample,
    score: f64,
}

fn rank_preferences(
    rows: Vec<FeedbackRow>,
    command: &str,
    rule_ids: &[String],
    project_id: &str,
) -> Vec<PreferenceExample> {
    let target = normalize_command(command);
    let target_tokens = command_tokens(&target);
    let target_rules: HashSet<&str> = rule_ids.iter().map(String::as_str).collect();
    let total = rows.len().max(1) as f64;

    // key = (规范化命令, 用户选择, 模型建议)；行按新到旧排列。
    let mut groups: HashMap<(String, String, Option<String>), PreferenceGroup> = HashMap::new();
    for (index, row) in rows.into_iter().enumerate() {
        let normalized = normalize_command(&row.command);
        let exact = normalized == target;
        let similarity = if exact {
            1.0
        } else {
            jaccard(&target_tokens, &command_tokens(&normalized))
        };
        let shares_rule = row
            .rule_ids
            .iter()
            .any(|rule| target_rules.contains(rule.as_str()));
        if !exact && !shares_rule && similarity < MIN_SIMILARITY {
            continue;
        }

        let same_project = !project_id.is_empty() && row.project_id == project_id;
        let recency = 0.1 * (1.0 - index as f64 / total);
        let score = similarity
            + if exact { 1.0 } else { 0.0 }
            + if shares_rule { 0.3 } else { 0.0 }
            + if same_project { 0.1 } else { 0.0 }
            + recency;

        let key = (
            normalized,
            row.user_decision.clone(),
            row.model_verdict.clone(),
        );
        match groups.entry(key) {
            Entry::Occupied(mut entry) => {
                let group = entry.get_mut();
                group.example.times = group.example.times.saturating_add(1);
                group.example.same_project |= same_project;
                if group.example.user_note.is_none() {
                    group.example.user_note = row.user_note;
                }
                group.score = group.score.max(score);
            }
            Entry::Vacant(entry) => {
                let overrode_model_deny = row.model_verdict.as_deref() == Some("deny")
                    && row.user_decision == USER_APPROVED;
                entry.insert(
                    PreferenceGroup {
                        example: PreferenceExample {
                            command: truncate_chars(&row.command, MAX_EXAMPLE_COMMAND_CHARS),
                            user_decision: row.user_decision,
                            model_verdict: row.model_verdict,
                            overrode_model_deny,
                            times: 1,
                            last_at: row.created_at,
                            user_note: row.user_note,
                            same_project,
                        },
                        score,
                    },
                );
            }
        }
    }

    let mut ranked: Vec<PreferenceGroup> = groups.into_values().collect();
    // 同分时重复次数多的优先，体现稳定偏好。
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.example.times.cmp(&a.example.times))
    });
    ranked
        .into_iter()
        .take(MAX_PREFERENCE_EXAMPLES)
        .map(|group| group.example)
        .collect()
}

fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn command_tokens(command: &str) -> HashSet<String> {
    command
        .split(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    ';' | '|' | '&' | '(' | ')' | '<' | '>' | '`' | '"' | '\'' | '=' | ','
                )
        })
        .map(|token| token.to_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

fn jaccard(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(right).count() as f64;
    let union = left.union(right).count() as f64;
    intersection / union
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max).collect();
    truncated.push_str("...");
    truncated
}
