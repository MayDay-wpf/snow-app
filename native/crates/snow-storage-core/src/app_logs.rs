use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, params_from_iter, types::Value, Row};

use crate::database;
use crate::system_settings;

#[napi(object)]
pub struct AppLogInput {
    pub level: String,
    pub module: String,
    pub func: String,
    pub line: Option<i32>,
    pub message: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub duration: Option<String>,
    pub context: Option<String>,
    pub error: Option<String>,
    pub source: String,
}

#[napi(object)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLogRecord {
    pub id: String,
    pub level: String,
    pub module: String,
    pub func: String,
    pub line: Option<i32>,
    pub message: String,
    pub input: String,
    pub output: String,
    pub duration: String,
    pub context: String,
    pub error: String,
    pub source: String,
    pub created_at: String,
}

#[napi(object)]
pub struct AppLogPage {
    pub items: Vec<AppLogRecord>,
    pub total: i32,
}

/// 导出文件片段：fileName 不含扩展名，由主进程按格式补 .log / .json。
#[napi(object)]
pub struct AppLogExportFile {
    pub file_name: String,
    pub content: String,
    pub count: u32,
}

const LOG_SELECT_COLUMNS: &str = "id, level, module, func, line, message, input, output, duration, context, error, source, created_at";

/// 构造日志筛选条件：自定义选择（ids 非空）时只按 id 过滤，忽略其它筛选。
fn build_log_filters(
    level: &str,
    module: &str,
    since: &str,
    until: &str,
    ids: &[String],
) -> (String, Vec<Value>) {
    let mut where_clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if ids.is_empty() {
        for (column, operator, raw_value) in [
            ("level", "=", level),
            ("module", "=", module),
            ("created_at", ">=", since),
            ("created_at", "<=", until),
        ] {
            let value = raw_value.trim();
            if !value.is_empty() {
                where_clauses.push(format!("{column} {operator} ?"));
                values.push(Value::Text(value.to_string()));
            }
        }
    } else {
        let placeholders = vec!["?"; ids.len()].join(", ");
        where_clauses.push(format!("id IN ({placeholders})"));
        for id in ids {
            values.push(Value::Text(id.clone()));
        }
    }
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clauses.join(" AND "))
    };
    (where_sql, values)
}

fn context_conversation_id(context: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(context)
        .ok()?
        .get("conversation_id")?
        .as_str()
        .map(ToString::to_string)
}

pub fn insert_app_log(database_path: &Path, input: &AppLogInput) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO app_logs (
                   id, level, module, func, line, message,
                   input, output, duration, context, error, conversation_id, source, created_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    input.level.trim(),
                    input.module.trim(),
                    input.func.trim(),
                    input.line,
                    input.message.trim(),
                    input.input.as_deref().unwrap_or("").trim(),
                    input.output.as_deref().unwrap_or("").trim(),
                    input.duration.as_deref().unwrap_or("").trim(),
                    input.context.as_deref().unwrap_or("").trim(),
                    input.error.as_deref().unwrap_or("").trim(),
                    input
                        .context
                        .as_deref()
                        .and_then(context_conversation_id)
                        .unwrap_or_default(),
                    input.source.trim(),
                ],
            )
        })
        .map_err(|error| database::database_error(database_path, "insert app log", error))
        .map(|_| ())
}

pub fn list_app_logs(
    database_path: &Path,
    level: &str,
    module: &str,
    since: &str,
    until: &str,
    limit: i32,
    offset: i32,
) -> Result<AppLogPage> {
    let safe_limit = if limit > 0 { limit } else { 100 };
    let safe_offset = if offset > 0 { offset } else { 0 };

    database::open_connection(database_path)
        .and_then(|connection| {
            let (where_sql, filter_values) = build_log_filters(level, module, since, until, &[]);

            let count_sql = format!("SELECT COUNT(*) FROM app_logs{where_sql}");
            let total: i32 = connection.query_row(
                &count_sql,
                params_from_iter(filter_values.iter()),
                |row| row.get(0),
            )?;

            let list_sql = format!(
                "SELECT {LOG_SELECT_COLUMNS}
                   FROM app_logs{where_sql}
                  ORDER BY created_at DESC, id DESC
                  LIMIT ? OFFSET ?"
            );

            let mut list_values = filter_values;
            list_values.push(Value::Integer(i64::from(safe_limit)));
            list_values.push(Value::Integer(i64::from(safe_offset)));
            let mut statement = connection.prepare(&list_sql)?;
            let rows = statement.query_map(params_from_iter(list_values.iter()), map_log_row)?;

            let items: Vec<AppLogRecord> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(AppLogPage { items, total })
        })
        .map_err(|error| database::database_error(database_path, "list app logs", error))
}

/// 导出日志：Rust 负责查询与格式化，主进程负责保存对话框与写文件。
/// format 为 "json" 时输出 JSON 数组，否则输出单行文本日志。
/// group_by_day 为 true 时按 created_at 的日期拆分成多个文件片段。
pub fn export_app_logs(
    database_path: &Path,
    level: &str,
    module: &str,
    since: &str,
    until: &str,
    ids: &[String],
    format: &str,
    group_by_day: bool,
) -> Result<Vec<AppLogExportFile>> {
    let json = format == "json";

    database::open_connection(database_path)
        .and_then(|connection| {
            let (where_sql, filter_values) = build_log_filters(level, module, since, until, ids);
            let sql = format!(
                "SELECT {LOG_SELECT_COLUMNS}
                   FROM app_logs{where_sql}
                  ORDER BY created_at ASC, id ASC"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(params_from_iter(filter_values.iter()), map_log_row)?;
            let records = rows.collect::<rusqlite::Result<Vec<_>>>()?;

            if records.is_empty() {
                return Ok(Vec::new());
            }

            if !group_by_day {
                let content = render_log_export(&records, json);
                return Ok(vec![AppLogExportFile {
                    file_name: "snow-logs".to_string(),
                    content,
                    count: records.len() as u32,
                }]);
            }

            // created_at 为 "YYYY-MM-DD HH:MM:SS"，按日期前缀分组（BTreeMap 保证日期升序）。
            let mut grouped: std::collections::BTreeMap<String, Vec<AppLogRecord>> =
                std::collections::BTreeMap::new();
            for record in records {
                let day = record.created_at.get(0..10).unwrap_or("unknown").to_string();
                grouped.entry(day).or_default().push(record);
            }
            Ok(grouped
                .into_iter()
                .map(|(day, items)| AppLogExportFile {
                    file_name: format!("snow-logs-{day}"),
                    content: render_log_export(&items, json),
                    count: items.len() as u32,
                })
                .collect())
        })
        .map_err(|error| database::database_error(database_path, "export app logs", error))
}

fn render_log_export(records: &[AppLogRecord], json: bool) -> String {
    if json {
        return serde_json::to_string_pretty(records).unwrap_or_else(|_| "[]".to_string());
    }
    let mut output = String::new();
    for record in records {
        output.push_str(&format_log_entry(record));
    }
    output
}

fn format_log_entry(record: &AppLogRecord) -> String {
    let mut location = record.module.clone();
    if !record.func.is_empty() {
        location.push('.');
        location.push_str(&record.func);
    }
    if let Some(line) = record.line {
        if line > 0 {
            location.push_str(&format!(":{line}"));
        }
    }
    let mut output = format!(
        "{} [{}] [{}] {} {}\n",
        record.created_at, record.level, record.source, location, record.message
    );
    for (label, value) in [
        ("input", &record.input),
        ("output", &record.output),
        ("duration", &record.duration),
        ("context", &record.context),
        ("error", &record.error),
    ] {
        if !value.is_empty() {
            output.push_str(&format!("  {label}: {value}\n"));
        }
    }
    output
}

pub fn clear_app_logs(database_path: &Path) -> Result<u32> {
    database::open_connection(database_path)
        .and_then(|connection| connection.execute("DELETE FROM app_logs", []))
        .map_err(|error| database::database_error(database_path, "clear app logs", error))
        .map(|count| count as u32)
}

/// 系统日志里出现过的模块名（去重、按名称排序），供系统日志页按模块筛选。
pub fn list_app_log_modules(database_path: &Path) -> Result<Vec<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT DISTINCT module FROM app_logs WHERE module <> '' ORDER BY module",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| database::database_error(database_path, "list app log modules", error))
}

/// 按保留天数删除过期系统日志（0 或负数表示不清理），返回删除行数。
/// `created_at` 由写入路径以本地时间写入，比较同样使用本地时间。
pub fn prune_app_logs(database_path: &Path, retention_days: i32) -> Result<u32> {
    if retention_days <= 0 {
        return Ok(0);
    }

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM app_logs WHERE created_at < datetime('now', 'localtime', ?1)",
                params![format!("-{retention_days} days")],
            )
        })
        .map_err(|error| database::database_error(database_path, "prune app logs", error))
        .map(|count| count as u32)
}

/// Write an API-layer warning log (tool JSON parse failure, empty response, etc.).
/// The SQLite insert is offloaded to `spawn_blocking` so the async API path is
/// never blocked by database I/O. Failures are silently ignored to avoid
/// disrupting the main request flow.
pub async fn log_api_warning(database_path: &Path, func: &str, message: &str, context: &str) {
    if snow_runtime::ephemeral::is_active() { return; }
    let db_path = database_path.to_path_buf();
    let func = func.to_string();
    let message = message.to_string();
    let context = context.to_string();

    tokio::task::spawn_blocking(move || {
        let _ = insert_app_log(
            &db_path,
            &AppLogInput {
                level: "WARN".to_string(),
                module: "api".to_string(),
                func,
                line: None,
                message,
                input: None,
                output: None,
                duration: None,
                context: Some(context),
                error: None,
                source: "main".to_string(),
            },
        );
    })
    .await
    .ok();
}

/// Write an API-layer error log (request failure, stream error, etc.).
/// The SQLite insert is offloaded to `spawn_blocking` so the async API path is
/// never blocked by database I/O. Failures are silently ignored to avoid
/// disrupting the main request flow.
pub async fn log_api_error(database_path: &Path, func: &str, message: &str, error: &str) {
    if snow_runtime::ephemeral::is_active() { return; }
    let db_path = database_path.to_path_buf();
    let func = func.to_string();
    let message = message.to_string();
    let error = error.to_string();

    tokio::task::spawn_blocking(move || {
        let _ = insert_app_log(
            &db_path,
            &AppLogInput {
                level: "ERROR".to_string(),
                module: "api".to_string(),
                func,
                line: None,
                message,
                input: None,
                output: None,
                duration: None,
                context: None,
                error: Some(error),
                source: "main".to_string(),
            },
        );
    })
    .await
    .ok();
}

/// Conditionally log a complete raw API request JSON when request logging
/// is enabled. The check + insert are offloaded to `spawn_blocking` so the
/// hot async API path is never blocked by SQLite I/O.
///
/// - `database_path`: path to the SQLite database file.
/// - `provider`: short provider tag ("chat", "gemini", "responses",
///   "anthropic", "embedding", "reranking").
/// - `endpoint`: the full request URL. Credential query values are redacted
///   before persistence.
/// - `payload_json`: serialized request body JSON.
///
/// Failures (disabled flag read errors, insert errors) are silently
/// discarded — request logging must never break the main request flow.
pub async fn maybe_log_api_request(
    database_path: PathBuf,
    provider: String,
    endpoint: String,
    payload_json: String,
) {
    maybe_log_api_payload(
        database_path,
        provider,
        endpoint,
        payload_json,
        None,
        None,
        false,
    )
    .await;
}

pub async fn maybe_log_api_request_for_conversation(
    database_path: PathBuf,
    provider: String,
    endpoint: String,
    payload_json: String,
    conversation_id: String,
    api_key: String,
) {
    maybe_log_api_payload(
        database_path,
        provider,
        endpoint,
        payload_json,
        Some(conversation_id),
        Some(api_key),
        false,
    )
    .await;
}

pub async fn maybe_log_api_response_for_conversation(
    database_path: PathBuf,
    provider: String,
    endpoint: String,
    response_json: String,
    conversation_id: String,
    api_key: String,
) {
    maybe_log_api_payload(
        database_path,
        provider,
        endpoint,
        response_json,
        Some(conversation_id),
        Some(api_key),
        true,
    )
    .await;
}

async fn maybe_log_api_payload(
    database_path: PathBuf,
    provider: String,
    endpoint: String,
    body_json: String,
    conversation_id: Option<String>,
    api_key: Option<String>,
    is_response: bool,
) {
    // Check in the async caller before spawn_blocking: task-local state is not
    // inherited by blocking jobs. No draft, context, response or provider error
    // from ephemeral requests may enter the request/response log database.
    if snow_runtime::ephemeral::is_active() { return; }
    tokio::task::spawn_blocking(move || {
        let enabled = system_settings::get_request_logging(&database_path).unwrap_or(false);
        if !enabled {
            return;
        }
        let expires_at_ms =
            system_settings::get_request_logging_expiry(&database_path).unwrap_or(0);
        if expires_at_ms > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            if now_ms >= expires_at_ms {
                let _ = system_settings::set_request_logging(&database_path, false);
                let _ = system_settings::set_request_logging_expiry(&database_path, 0);
                return;
            }
        }

        let endpoint = redact_request_endpoint(&endpoint);
        let body_json = redact_payload_json(&body_json, api_key.as_deref().unwrap_or(""));
        let context = conversation_id.map(|conversation_id| {
            serde_json::json!({"conversation_id": conversation_id}).to_string()
        });
        let _ = insert_app_log(
            &database_path,
            &AppLogInput {
                level: "DEBUG".to_string(),
                module: if is_response {
                    "api_response"
                } else {
                    "api_request"
                }
                .to_string(),
                func: provider,
                line: None,
                message: endpoint,
                input: (!is_response).then_some(body_json.clone()),
                output: is_response.then_some(body_json),
                duration: None,
                context,
                error: None,
                source: "main".to_string(),
            },
        );
    })
    .await
    .ok();
}

fn redact_payload_json(body: &str, api_key: &str) -> String {
    fn redact_value(value: &mut serde_json::Value, api_key: &str) {
        match value {
            serde_json::Value::Object(object) => {
                for (name, value) in object.iter_mut() {
                    if is_sensitive_query_name(name) {
                        *value = serde_json::Value::String("[REDACTED]".to_string());
                    } else {
                        redact_value(value, api_key);
                    }
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    redact_value(item, api_key);
                }
            }
            serde_json::Value::String(text) if !api_key.is_empty() => {
                *text = text.replace(api_key, "[REDACTED]");
            }
            _ => {}
        }
    }

    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(mut value) => {
            redact_value(&mut value, api_key);
            serde_json::to_string(&value).unwrap_or_else(|_| "[BODY REDACTION FAILED]".to_string())
        }
        Err(_) if !api_key.is_empty() => body.replace(api_key, "[REDACTED]"),
        Err(_) => body.to_string(),
    }
}

const REDACTED_QUERY_VALUE: &str = "[REDACTED]";
const ENCODED_REDACTED_QUERY_VALUE: &str = "%5BREDACTED%5D";

pub fn redact_request_endpoint(endpoint: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(endpoint) else {
        return redact_malformed_request_endpoint(endpoint);
    };

    let mut contains_sensitive_value = false;
    let query_pairs = url
        .query_pairs()
        .map(|(name, value)| {
            let value = if is_sensitive_query_name(&name) {
                contains_sensitive_value = true;
                REDACTED_QUERY_VALUE.to_string()
            } else {
                value.into_owned()
            };
            (name.into_owned(), value)
        })
        .collect::<Vec<_>>();

    if !contains_sensitive_value {
        return endpoint.to_string();
    }

    url.query_pairs_mut()
        .clear()
        .extend_pairs(query_pairs.iter().map(|(name, value)| (name, value)));
    url.to_string()
}

fn redact_malformed_request_endpoint(endpoint: &str) -> String {
    let Some((prefix, remainder)) = endpoint.split_once('?') else {
        return "[INVALID ENDPOINT]".to_string();
    };
    let (query, fragment) = remainder
        .split_once('#')
        .map_or((remainder, None), |(query, fragment)| {
            (query, Some(fragment))
        });

    let mut contains_sensitive_value = false;
    let redacted_query = query
        .split('&')
        .map(|component| {
            let raw_name = component
                .split_once('=')
                .map_or(component, |(name, _)| name);
            if decoded_query_name(raw_name)
                .as_deref()
                .is_some_and(is_sensitive_query_name)
            {
                contains_sensitive_value = true;
                format!("{raw_name}={ENCODED_REDACTED_QUERY_VALUE}")
            } else {
                component.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&");

    if !contains_sensitive_value {
        return endpoint.to_string();
    }

    let fragment = fragment.map_or_else(String::new, |value| format!("#{value}"));
    format!("{prefix}?{redacted_query}{fragment}")
}

fn decoded_query_name(raw_name: &str) -> Option<String> {
    let probe = reqwest::Url::parse(&format!(
        "https://request-log-redaction.invalid/?{raw_name}="
    ))
    .ok()?;
    probe
        .query_pairs()
        .next()
        .map(|(name, _)| name.into_owned())
}

fn is_sensitive_query_name(name: &str) -> bool {
    let canonical_name = name
        .trim()
        .chars()
        .filter(|character| !matches!(character, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect::<String>();

    matches!(
        canonical_name.as_str(),
        "key"
            | "apikey"
            | "xapikey"
            | "xgoogapikey"
            | "token"
            | "authtoken"
            | "bearertoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "sessiontoken"
            | "authorization"
            | "auth"
            | "signature"
            | "secret"
            | "clientsecret"
            | "password"
            | "credential"
            | "credentials"
    )
}

/// Write a hook warning log when a hook command exits with code 1 (soft warning).
/// The warning does not block the action but is recorded for diagnostics.
/// Uses `spawn_blocking` so the async hook execution path is never blocked
/// by SQLite I/O.
///
/// Failures are silently ignored to avoid disrupting the main hook flow.
pub async fn log_hook_warning(
    database_path: PathBuf,
    hook_type: String,
    command: String,
    exit_code: i32,
    output: Option<String>,
    error: Option<String>,
    context: Option<String>,
) {
    let db_path = database_path;
    let message = format!(
        "Hook '{}' command exited with code {} (soft warning)",
        hook_type, exit_code
    );

    tokio::task::spawn_blocking(move || {
        let _ = insert_app_log(
            &db_path,
            &AppLogInput {
                level: "WARN".to_string(),
                module: "hooks".to_string(),
                func: hook_type,
                line: None,
                message,
                input: Some(command),
                output,
                duration: None,
                context,
                error,
                source: "main".to_string(),
            },
        );
    })
    .await
    .ok();
}

fn map_log_row(row: &Row<'_>) -> rusqlite::Result<AppLogRecord> {
    Ok(AppLogRecord {
        id: row.get(0)?,
        level: row.get(1)?,
        module: row.get(2)?,
        func: row.get(3)?,
        line: row.get(4)?,
        message: row.get(5)?,
        input: row.get(6)?,
        output: row.get(7)?,
        duration: row.get(8)?,
        context: row.get(9)?,
        error: row.get(10)?,
        source: row.get(11)?,
        created_at: row.get(12)?,
    })
}
