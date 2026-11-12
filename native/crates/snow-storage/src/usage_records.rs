use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Row};

use snow_storage_core::database;

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

#[napi(object)]
pub struct ModelUsageBreakdown {
    /// Model identifier, as recorded in the usage record.
    pub model: String,
    /// Request method (chat / responses / decisions / ...). Grouping by it keeps
    /// decision model calls out of the chat statistics of the same model.
    pub request_method: String,
    pub total_requests: i64,
    pub error_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_creation_input_tokens: i64,
    pub total_cache_read_input_tokens: i64,
    /// `total_input_tokens + total_output_tokens` for this model.
    pub total_tokens: i64,
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

/// List usage records with optional filters. `conversation_id`,
/// `directory_id` and `profile_name` accept empty strings to skip filtering.
/// `limit` and `offset` are clamped to non-negative values; `limit <= 0`
/// defaults to 50.
pub fn list_usage_records(
    database_path: &Path,
    conversation_id: &str,
    directory_id: &str,
    profile_name: &str,
    limit: i32,
    offset: i32,
) -> Result<UsageRecordPage> {
    let safe_limit = if limit > 0 { limit } else { 50 };
    let safe_offset = if offset > 0 { offset } else { 0 };

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut where_clauses: Vec<String> = Vec::new();
            let mut values: Vec<String> = Vec::new();
            for (column, value) in [
                ("conversation_id", conversation_id),
                ("directory_id", directory_id),
                ("api_profile_name", profile_name),
            ] {
                if value.trim().is_empty() {
                    continue;
                }
                values.push(value.trim().to_string());
                where_clauses.push(format!("{column} = ?{}", values.len()));
            }
            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_clauses.join(" AND "))
            };

            let count_sql = format!("SELECT COUNT(*) FROM usage_records{where_sql}");
            let filter_params = to_sql_params(&values);
            let total: i32 =
                connection.query_row(&count_sql, filter_params.as_slice(), |row| row.get(0))?;

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
                  LIMIT ?{limit_index} OFFSET ?{offset_index}",
                limit_index = values.len() + 1,
                offset_index = values.len() + 2
            );

            let mut list_params = to_sql_params(&values);
            list_params.push(&safe_limit);
            list_params.push(&safe_offset);

            let mut statement = connection.prepare(&list_sql)?;
            let rows = statement.query_map(list_params.as_slice(), map_usage_row)?;

            let items: Vec<UsageRecord> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(UsageRecordPage { items, total })
        })
        .map_err(|error| database::database_error(database_path, "list usage records", error))
}

/// Aggregate usage statistics over an optional time range. `since` and
/// `until` are RFC3339/SQLite datetime strings, `profile_name` an exact API
/// profile name; empty strings skip the corresponding filter.
pub fn get_usage_summary(
    database_path: &Path,
    since: &str,
    until: &str,
    profile_name: &str,
) -> Result<UsageSummary> {
    let (where_sql, values) = build_usage_filter(since, until, profile_name, false);

    database::open_connection(database_path)
        .and_then(|connection| {
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

            let query_params = to_sql_params(&values);
            let row = connection.query_row(&sql, query_params.as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?;

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
/// day with a non-zero request count, ordered by date ascending. `since`,
/// `until` and `profile_name` accept empty strings to skip that filter.
pub fn get_usage_daily_breakdown(
    database_path: &Path,
    since: &str,
    until: &str,
    profile_name: &str,
) -> Result<Vec<DailyUsageBreakdown>> {
    let (where_sql, values) = build_usage_filter(since, until, profile_name, true);

    database::open_connection(database_path)
        .and_then(|connection| {
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

            let query_params = to_sql_params(&values);
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(query_params.as_slice(), map_daily_row)?;

            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "get usage daily breakdown", error)
        })
}

/// Aggregate usage grouped by model and request method for per-model
/// consumption stats. Returns one row per (model, request method) pair with a
/// non-zero request count, ordered by total tokens descending. `since`, `until`
/// and `profile_name` accept empty strings to skip that filter.
pub fn get_usage_model_breakdown(
    database_path: &Path,
    since: &str,
    until: &str,
    profile_name: &str,
) -> Result<Vec<ModelUsageBreakdown>> {
    let (where_sql, values) = build_usage_filter(since, until, profile_name, false);

    database::open_connection(database_path)
        .and_then(|connection| {
            let sql = format!(
                "SELECT model,
                        request_method,
                        COUNT(*) AS req_count,
                        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS err_count,
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cache_creation_input_tokens), 0),
                        COALESCE(SUM(cache_read_input_tokens), 0)
                   FROM usage_records{where_sql}
                  GROUP BY model, request_method
                  ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC,
                           COUNT(*) DESC"
            );

            let query_params = to_sql_params(&values);
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(query_params.as_slice(), map_model_row)?;

            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "get usage model breakdown", error)
        })
}

/// List the distinct API profile names found in the usage records, ordered by
/// consumed tokens descending. Used to populate the profile filter dropdown.
pub fn list_usage_profile_names(database_path: &Path) -> Result<Vec<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT api_profile_name
                   FROM usage_records
                  WHERE TRIM(api_profile_name) <> ''
                  GROUP BY api_profile_name
                  ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC,
                           COUNT(*) DESC",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;

            rows.collect()
        })
        .map_err(|error| {
            database::database_error(database_path, "list usage profile names", error)
        })
}

/// Builds the `WHERE` clause and its bound values shared by the usage
/// aggregation queries. Empty `since`/`until`/`profile_name` skip that
/// filter; `date_only` compares calendar days instead of full timestamps.
fn build_usage_filter(
    since: &str,
    until: &str,
    profile_name: &str,
    date_only: bool,
) -> (String, Vec<String>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();

    let compare = |operator: &str, index: usize| {
        if date_only {
            format!("date(created_at) {operator} date(?{index})")
        } else {
            format!("created_at {operator} ?{index}")
        }
    };

    if !since.trim().is_empty() {
        values.push(since.trim().to_string());
        clauses.push(compare(">=", values.len()));
    }
    if !until.trim().is_empty() {
        values.push(until.trim().to_string());
        clauses.push(compare("<=", values.len()));
    }
    if !profile_name.trim().is_empty() {
        values.push(profile_name.trim().to_string());
        clauses.push(format!("api_profile_name = ?{}", values.len()));
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (where_sql, values)
}

fn to_sql_params(values: &[String]) -> Vec<&dyn rusqlite::ToSql> {
    values.iter().map(|value| value as &dyn rusqlite::ToSql).collect()
}

/// Delete usage records within an optional time range, mirroring the
/// `created_at` filters used by the read queries. `since` and `until` are
/// SQLite datetime strings; empty strings skip the corresponding bound.
/// Returns the number of deleted rows.
pub fn delete_usage_records(database_path: &Path, since: &str, until: &str) -> Result<u32> {
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
            let sql = format!("DELETE FROM usage_records{where_sql}");
            let deleted = if filter_since && filter_until {
                connection.execute(&sql, params![since.trim(), until.trim()])?
            } else if filter_since {
                connection.execute(&sql, params![since.trim()])?
            } else if filter_until {
                connection.execute(&sql, params![until.trim()])?
            } else {
                connection.execute(&sql, [])?
            };
            Ok(deleted as u32)
        })
        .map_err(|error| database::database_error(database_path, "delete usage records", error))
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

fn map_model_row(row: &Row<'_>) -> rusqlite::Result<ModelUsageBreakdown> {
    let input: i64 = row.get(4)?;
    let output: i64 = row.get(5)?;
    Ok(ModelUsageBreakdown {
        model: row.get(0)?,
        request_method: row.get(1)?,
        total_requests: row.get(2)?,
        error_requests: row.get(3)?,
        total_input_tokens: input,
        total_output_tokens: output,
        total_cache_creation_input_tokens: row.get(6)?,
        total_cache_read_input_tokens: row.get(7)?,
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
