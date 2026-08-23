use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, params_from_iter, types::Value, Row};

use super::super::database;
use super::system_settings;

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

pub fn insert_app_log(database_path: &Path, input: &AppLogInput) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO app_logs (
                   id, level, module, func, line, message,
                   input, output, duration, context, error, source, created_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
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
            let mut where_clauses: Vec<String> = Vec::new();
            let mut filter_values = Vec::new();
            for (column, operator, raw_value) in [
                ("level", "=", level),
                ("module", "=", module),
                ("created_at", ">=", since),
                ("created_at", "<=", until),
            ] {
                let value = raw_value.trim();
                if !value.is_empty() {
                    where_clauses.push(format!("{column} {operator} ?"));
                    filter_values.push(Value::Text(value.to_string()));
                }
            }
            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_clauses.join(" AND "))
            };

            let count_sql = format!("SELECT COUNT(*) FROM app_logs{where_sql}");
            let total: i32 = connection.query_row(
                &count_sql,
                params_from_iter(filter_values.iter()),
                |row| row.get(0),
            )?;

            let list_sql = format!(
                "SELECT id, level, module, func, line, message,
                        input, output, duration, context, error, source, created_at
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

pub fn clear_app_logs(database_path: &Path) -> Result<u32> {
    database::open_connection(database_path)
        .and_then(|connection| connection.execute("DELETE FROM app_logs", []))
        .map_err(|error| database::database_error(database_path, "clear app logs", error))
        .map(|count| count as u32)
}

/// Write an API-layer warning log (tool JSON parse failure, empty response, etc.).
/// Failures are silently ignored to avoid disrupting the main request flow.
pub fn log_api_warning(database_path: &Path, func: &str, message: &str, context: &str) {
    let _ = insert_app_log(
        database_path,
        &AppLogInput {
            level: "WARN".to_string(),
            module: "api".to_string(),
            func: func.to_string(),
            line: None,
            message: message.to_string(),
            input: None,
            output: None,
            duration: None,
            context: Some(context.to_string()),
            error: None,
            source: "main".to_string(),
        },
    );
}

/// Write an API-layer error log (request failure, stream error, etc.).
/// Failures are silently ignored to avoid disrupting the main request flow.
pub fn log_api_error(database_path: &Path, func: &str, message: &str, error: &str) {
    let _ = insert_app_log(
        database_path,
        &AppLogInput {
            level: "ERROR".to_string(),
            module: "api".to_string(),
            func: func.to_string(),
            line: None,
            message: message.to_string(),
            input: None,
            output: None,
            duration: None,
            context: None,
            error: Some(error.to_string()),
            source: "main".to_string(),
        },
    );
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
    let db_path = database_path;
    let provider = provider;
    let endpoint = redact_request_endpoint(&endpoint);
    let payload_json = payload_json;

    tokio::task::spawn_blocking(move || {
        let enabled = system_settings::get_request_logging(&db_path).unwrap_or(false);
        if !enabled {
            return;
        }
        // 强制校验自动关闭时间：即使渲染进程的倒计时未运行（面板关闭/视图切换），
        // 到期后 Rust 写入路径也会拒绝记录，并顺手复位开关与过期时间。
        let expires_at_ms = system_settings::get_request_logging_expiry(&db_path).unwrap_or(0);
        if expires_at_ms > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            if now_ms >= expires_at_ms {
                let _ = system_settings::set_request_logging(&db_path, false);
                let _ = system_settings::set_request_logging_expiry(&db_path, 0);
                return;
            }
        }
        let _ = insert_app_log(
            &db_path,
            &AppLogInput {
                level: "DEBUG".to_string(),
                module: "api_request".to_string(),
                func: provider,
                line: None,
                message: endpoint,
                input: Some(payload_json),
                output: None,
                duration: None,
                context: None,
                error: None,
                source: "main".to_string(),
            },
        );
    })
    .await
    .ok();
}

const REDACTED_QUERY_VALUE: &str = "[REDACTED]";
const ENCODED_REDACTED_QUERY_VALUE: &str = "%5BREDACTED%5D";

fn redact_request_endpoint(endpoint: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::redact_request_endpoint;

    #[test]
    fn request_endpoint_redacts_sensitive_aliases_case_insensitively() {
        let endpoint = concat!(
            "https://api.example.test/v1/models?",
            "key=first&API_KEY=second&api-key=third&token=fourth&",
            "access_token=fifth&refresh-token=sixth&Authorization=seventh&",
            "signature=eighth&secret=ninth&password=tenth&key=eleventh&",
            "x-api-key=twelfth&x-goog-api-key=thirteenth&auth_token=fourteenth&",
            "bearer-token=fifteenth&client_secret=sixteenth&credential=seventeenth"
        );

        let redacted = redact_request_endpoint(endpoint);
        let url = reqwest::Url::parse(&redacted).expect("redacted endpoint should remain valid");
        let pairs = url.query_pairs().collect::<Vec<_>>();

        assert_eq!(pairs.len(), 17);
        assert!(pairs.iter().all(|(_, value)| value == "[REDACTED]"));
        for secret in [
            "first",
            "second",
            "third",
            "fourth",
            "fifth",
            "sixth",
            "seventh",
            "eighth",
            "ninth",
            "tenth",
            "eleventh",
            "twelfth",
            "thirteenth",
            "fourteenth",
            "fifteenth",
            "sixteenth",
            "seventeenth",
        ] {
            assert!(!redacted.contains(secret));
        }
    }

    #[test]
    fn request_endpoint_decodes_encoded_names_and_preserves_diagnostics() {
        let endpoint = concat!(
            "https://api.example.test/v1beta/interactions?",
            "%61pi%5Fkey=credential&model=gemini-3.7&region=us-west#trace"
        );

        let redacted = redact_request_endpoint(endpoint);
        let url = reqwest::Url::parse(&redacted).expect("redacted endpoint should remain valid");
        let pairs = url.query_pairs().collect::<Vec<_>>();

        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("api.example.test"));
        assert_eq!(url.path(), "/v1beta/interactions");
        assert_eq!(url.fragment(), Some("trace"));
        assert_eq!(pairs[0].1, "[REDACTED]");
        assert_eq!(pairs[1], ("model".into(), "gemini-3.7".into()));
        assert_eq!(pairs[2], ("region".into(), "us-west".into()));
        assert!(!redacted.contains("credential"));
    }

    #[test]
    fn request_endpoint_leaves_non_sensitive_query_names_unchanged() {
        let endpoint = concat!(
            "https://api.example.test/v1?monkey=capuchin&",
            "tokenizer=sentencepiece&secret_mode=disabled&signature_version=v4"
        );

        assert_eq!(redact_request_endpoint(endpoint), endpoint);
    }

    #[test]
    fn malformed_endpoint_redacts_encoded_and_duplicate_sensitive_values() {
        let endpoint = concat!(
            "not a valid endpoint?%41ccess%5FToken=first&mode=debug&",
            "%61ccess_token=second#diagnostic"
        );

        let redacted = redact_request_endpoint(endpoint);

        assert_eq!(
            redacted,
            concat!(
                "not a valid endpoint?%41ccess%5FToken=%5BREDACTED%5D&mode=debug&",
                "%61ccess_token=%5BREDACTED%5D#diagnostic"
            )
        );
        assert!(!redacted.contains("first"));
        assert!(!redacted.contains("second"));
    }

    #[test]
    fn malformed_endpoint_without_query_is_not_persisted_verbatim() {
        assert_eq!(
            redact_request_endpoint("not a valid endpoint containing a credential"),
            "[INVALID ENDPOINT]"
        );
    }
}
