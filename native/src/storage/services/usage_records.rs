use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Row};

use super::super::database;

/// Input for recording a single API usage event. All string fields are
/// trimmed before insertion. Token counts are stored as-is.
pub struct UsageRecordInput<'a> {
    pub conversation_id: &'a str,
    pub response_id: &'a str,
    pub model: &'a str,
    pub api_profile_name: &'a str,
    pub api_config_id: &'a str,
    pub request_method: &'a str,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub status: &'a str,
    pub is_sub_agent: bool,
    pub directory_id: &'a str,
}

#[napi(object)]
pub struct UsageRecord {
    pub id: String,
    pub conversation_id: String,
    pub response_id: String,
    pub model: String,
    pub api_profile_name: String,
    pub api_config_id: String,
    pub request_method: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub status: String,
    pub is_sub_agent: bool,
    pub directory_id: String,
    pub created_at: String,
    /// Total tokens for this call: `input_tokens + output_tokens`.
    /// Mirrors the frontend `TokenUsageRing` formula where `input` already
    /// includes cache reads (Rust normalizes all providers so `input_tokens`
    /// contains `cache_read_input_tokens`).
    pub total_tokens: i64,
    /// `min(cache_read_input_tokens, input_tokens)` — cache reads are a
    /// subset of input, not an additional total. Matches the frontend
    /// `cacheRead = Math.min(cacheReadInputTokens, input)` calculation.
    pub effective_cache_read_tokens: i64,
    /// `input_tokens - effective_cache_read_tokens` — the non-cached portion
    /// of input. Matches the frontend `nonCachedInput` value.
    pub non_cached_input_tokens: i64,
}

#[napi(object)]
pub struct UsageRecordPage {
    pub items: Vec<UsageRecord>,
    pub total: i32,
}

#[napi(object)]
pub struct DailyUsageBreakdown {
    /// Date in `YYYY-MM-DD` format (SQLite `date(created_at)`).
    pub date: String,
    pub total_requests: i64,
    pub error_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_creation_input_tokens: i64,
    pub total_cache_read_input_tokens: i64,
    /// `total_input_tokens + total_output_tokens` for the day.
    pub total_tokens: i64,
}

#[napi(object)]
pub struct UsageSummary {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_creation_input_tokens: i64,
    pub total_cache_read_input_tokens: i64,
    pub total_requests: i64,
    pub error_requests: i64,
    /// `total_input_tokens + total_output_tokens`. Consistent with the
    /// frontend `TokenUsageRing` where `total = input + output` and input
    /// already contains cache reads.
    pub total_tokens: i64,
    /// `min(total_cache_read_input_tokens, total_input_tokens)` — cache
    /// reads are a subset of input. Matches the frontend
    /// `cacheRead = Math.min(cacheReadInputTokens, input)` semantics.
    pub effective_cache_read_tokens: i64,
    /// `total_input_tokens - effective_cache_read_tokens` — the non-cached
    /// portion of total input. Matches the frontend `nonCachedInput` value.
    pub non_cached_input_tokens: i64,
}

/// Persist a single usage record. Errors are propagated so the caller can
/// decide whether to log-and-continue or abort. The insertion runs in its
/// own short-lived connection, matching the pattern used by other services.
pub fn record_usage(database_path: &Path, input: &UsageRecordInput<'_>) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO usage_records (
                   id,
                   conversation_id,
                   response_id,
                   model,
                   api_profile_name,
                   api_config_id,
                   request_method,
                   input_tokens,
                   output_tokens,
                   cache_creation_input_tokens,
                   cache_read_input_tokens,
                   status,
                   is_sub_agent,
                   directory_id,
                   created_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    input.conversation_id.trim(),
                    input.response_id.trim(),
                    input.model.trim(),
                    input.api_profile_name.trim(),
                    input.api_config_id.trim(),
                    input.request_method.trim(),
                    input.input_tokens,
                    input.output_tokens,
                    input.cache_creation_input_tokens,
                    input.cache_read_input_tokens,
                    input.status.trim(),
                    if input.is_sub_agent { 1 } else { 0 },
                    input.directory_id.trim(),
                ],
            )
        })
        .map_err(|error| database::database_error(database_path, "record usage", error))
        .map(|_| ())
}

/// List usage records with optional filters. `conversation_id` and
/// `directory_id` accept empty strings to skip filtering. `limit` and
/// `offset` are clamped to non-negative values; `limit <= 0` defaults to 50.
pub fn list_usage_records(
    database_path: &Path,
    conversation_id: &str,
    directory_id: &str,
    limit: i32,
    offset: i32,
) -> Result<UsageRecordPage> {
    let safe_limit = if limit > 0 { limit } else { 50 };
    let safe_offset = if offset > 0 { offset } else { 0 };

    let filter_conversation = !conversation_id.trim().is_empty();
    let filter_directory = !directory_id.trim().is_empty();

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut where_clauses: Vec<String> = Vec::new();
            let mut param_index = 1usize;
            if filter_conversation {
                where_clauses.push(format!("conversation_id = ?{param_index}"));
                param_index += 1;
            }
            if filter_directory {
                where_clauses.push(format!("directory_id = ?{param_index}"));
                param_index += 1;
            }
            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_clauses.join(" AND "))
            };

            let count_sql = format!("SELECT COUNT(*) FROM usage_records{where_sql}");
            let total: i32 = if filter_conversation && filter_directory {
                connection.query_row(
                    &count_sql,
                    params![conversation_id.trim(), directory_id.trim()],
                    |row| row.get(0),
                )?
            } else if filter_conversation {
                connection.query_row(&count_sql, params![conversation_id.trim()], |row| {
                    row.get(0)
                })?
            } else if filter_directory {
                connection.query_row(&count_sql, params![directory_id.trim()], |row| row.get(0))?
            } else {
                connection.query_row(&count_sql, [], |row| row.get(0))?
            };

            let list_sql = format!(
                "SELECT id,
                        conversation_id,
                        response_id,
                        model,
                        api_profile_name,
                        api_config_id,
                        request_method,
                        input_tokens,
                        output_tokens,
                        cache_creation_input_tokens,
                        cache_read_input_tokens,
                        status,
                        is_sub_agent,
                        directory_id,
                        created_at
                   FROM usage_records{where_sql}
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?{param_index} OFFSET ?{next}",
                param_index = param_index,
                next = param_index + 1
            );

            let mut statement = connection.prepare(&list_sql)?;
            let rows = if filter_conversation && filter_directory {
                statement.query_map(
                    params![
                        conversation_id.trim(),
                        directory_id.trim(),
                        safe_limit,
                        safe_offset
                    ],
                    map_usage_row,
                )?
            } else if filter_conversation {
                statement.query_map(
                    params![conversation_id.trim(), safe_limit, safe_offset],
                    map_usage_row,
                )?
            } else if filter_directory {
                statement.query_map(
                    params![directory_id.trim(), safe_limit, safe_offset],
                    map_usage_row,
                )?
            } else {
                statement.query_map(params![safe_limit, safe_offset], map_usage_row)?
            };

            let items: Vec<UsageRecord> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(UsageRecordPage { items, total })
        })
        .map_err(|error| database::database_error(database_path, "list usage records", error))
}

/// Aggregate usage statistics over an optional time range. `since` and
/// `until` are RFC3339/SQLite datetime strings; empty strings skip the
/// corresponding bound.
pub fn get_usage_summary(database_path: &Path, since: &str, until: &str) -> Result<UsageSummary> {
    let filter_since = !since.trim().is_empty();
    let filter_until = !until.trim().is_empty();

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut where_clauses: Vec<String> = Vec::new();
            if filter_since {
                where_clauses.push("created_at >= ?1".to_string());
            }
            if filter_until {
                let idx = if filter_since { 2 } else { 1 };
                where_clauses.push(format!("created_at <= ?{idx}"));
            }
            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_clauses.join(" AND "))
            };

            let sql = format!(
                "SELECT
                   COALESCE(SUM(input_tokens), 0),
                   COALESCE(SUM(output_tokens), 0),
                   COALESCE(SUM(cache_creation_input_tokens), 0),
                   COALESCE(SUM(cache_read_input_tokens), 0),
                   COUNT(*),
                   COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)
                 FROM usage_records{where_sql}"
            );

            let row = if filter_since && filter_until {
                connection.query_row(&sql, params![since.trim(), until.trim()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })?
            } else if filter_since {
                connection.query_row(&sql, params![since.trim()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })?
            } else if filter_until {
                connection.query_row(&sql, params![until.trim()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })?
            } else {
                connection.query_row(&sql, [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })?
            };

            Ok(UsageSummary {
                total_input_tokens: row.0,
                total_output_tokens: row.1,
                total_cache_creation_input_tokens: row.2,
                total_cache_read_input_tokens: row.3,
                total_requests: row.4,
                error_requests: row.5,
                // Mirror the frontend TokenUsageRing semantics: cache reads
                // are a subset of input (input_tokens already contains
                // cache_read_input_tokens after Rust normalization).
                total_tokens: row.0 + row.1,
                effective_cache_read_tokens: row.3.min(row.0),
                non_cached_input_tokens: row.0 - row.3.min(row.0),
            })
        })
        .map_err(|error| database::database_error(database_path, "get usage summary", error))
}

/// Aggregate usage by day for heatmap visualization. Returns one row per
/// day with a non-zero request count, ordered by date ascending. `since`
/// and `until` are SQLite datetime strings; empty strings skip the bound.
pub fn get_usage_daily_breakdown(
    database_path: &Path,
    since: &str,
    until: &str,
) -> Result<Vec<DailyUsageBreakdown>> {
    let filter_since = !since.trim().is_empty();
    let filter_until = !until.trim().is_empty();

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut where_clauses: Vec<String> = Vec::new();
            if filter_since {
                where_clauses.push("date(created_at) >= date(?1)".to_string());
            }
            if filter_until {
                let idx = if filter_since { 2 } else { 1 };
                where_clauses.push(format!("date(created_at) <= date(?{idx})"));
            }
            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_clauses.join(" AND "))
            };

            let sql = format!(
                "SELECT date(created_at) AS day,
                        COUNT(*) AS req_count,
                        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS err_count,
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cache_creation_input_tokens), 0),
                        COALESCE(SUM(cache_read_input_tokens), 0)
                   FROM usage_records{where_sql}
                  GROUP BY day
                  ORDER BY day ASC"
            );

            let mut statement = connection.prepare(&sql)?;
            let rows = if filter_since && filter_until {
                statement.query_map(params![since.trim(), until.trim()], map_daily_row)?
            } else if filter_since {
                statement.query_map(params![since.trim()], map_daily_row)?
            } else if filter_until {
                statement.query_map(params![until.trim()], map_daily_row)?
            } else {
                statement.query_map([], map_daily_row)?
            };

            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "get usage daily breakdown", error)
        })
}

fn map_daily_row(row: &Row<'_>) -> rusqlite::Result<DailyUsageBreakdown> {
    let input: i64 = row.get(3)?;
    let output: i64 = row.get(4)?;
    Ok(DailyUsageBreakdown {
        date: row.get(0)?,
        total_requests: row.get(1)?,
        error_requests: row.get(2)?,
        total_input_tokens: input,
        total_output_tokens: output,
        total_cache_creation_input_tokens: row.get(5)?,
        total_cache_read_input_tokens: row.get(6)?,
        total_tokens: input + output,
    })
}

fn map_usage_row(row: &Row<'_>) -> rusqlite::Result<UsageRecord> {
    let is_sub_agent: i64 = row.get(12)?;
    let input_tokens: i64 = row.get(7)?;
    let output_tokens: i64 = row.get(8)?;
    let cache_read_input_tokens: i64 = row.get(10)?;

    // Mirror the frontend TokenUsageRing semantics: cache reads are a subset
    // of input (Rust normalizes all providers so input_tokens already
    // contains cache_read_input_tokens).
    let effective_cache_read_tokens = cache_read_input_tokens.min(input_tokens);
    let non_cached_input_tokens = input_tokens - effective_cache_read_tokens;
    let total_tokens = input_tokens + output_tokens;

    Ok(UsageRecord {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        response_id: row.get(2)?,
        model: row.get(3)?,
        api_profile_name: row.get(4)?,
        api_config_id: row.get(5)?,
        request_method: row.get(6)?,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: row.get(9)?,
        cache_read_input_tokens,
        status: row.get(11)?,
        is_sub_agent: is_sub_agent != 0,
        directory_id: row.get(13)?,
        created_at: row.get(14)?,
        total_tokens,
        effective_cache_read_tokens,
        non_cached_input_tokens,
    })
}
