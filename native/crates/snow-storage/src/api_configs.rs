use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use snow_storage_core::database;
use snow_storage_core::models::{ApiConfigInput, ApiConfigRecord};

const DEFAULT_PROFILE_NAME: &str = "default";
const DEFAULT_DISPLAY_NAME: &str = "Default API";
const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/v1";
const DEFAULT_REQUEST_METHOD: &str = "chat";
const DEFAULT_ADVANCED_MODEL: &str = "deepseek-v4-pro";
const DEFAULT_BASIC_MODEL: &str = "deepseek-v4-flash";
const DEFAULT_MAX_CONTEXT_TOKENS: i32 = 256000;

/// Legacy columns stay as compatibility shadows for older Snow App releases.
/// The serialized `config_json.snowcfg` document is the canonical source.
#[derive(Clone)]
struct LegacyConfigValues {
    base_url: String,
    base_url_mode: String,
    api_key: String,
    request_method: String,
    advanced_model: String,
    basic_model: String,
    supports_vision: bool,
    vision_base_url: String,
    vision_base_url_mode: String,
    vision_api_key: String,
    vision_request_method: String,
    vision_model: String,
    max_context_tokens: Option<i32>,
    max_tokens: Option<i32>,
    stream_idle_timeout_sec: Option<i32>,
    enable_auto_compress: bool,
    auto_compress_threshold: Option<i32>,
    max_retries: i32,
    retry_base_delay_ms: i32,
    partial_retry_max_chars: i32,
    system_prompt_ids_json: String,
    custom_header_scheme_id: String,
    source: String,
}

fn parse_json_object(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(object)) => Value::Object(object),
        _ => json!({}),
    }
}

fn merge_json_values(target: &mut Value, incoming: &Value) {
    match (target, incoming) {
        (Value::Object(target), Value::Object(incoming)) => {
            for (key, value) in incoming {
                match target.get_mut(key) {
                    Some(existing) => merge_json_values(existing, value),
                    None => {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (target, incoming) => *target = incoming.clone(),
    }
}

fn ensure_snowcfg(root: &mut Value) -> &mut Map<String, Value> {
    let object = root
        .as_object_mut()
        .expect("canonical API config root must be an object");
    if !matches!(object.get("snowcfg"), Some(Value::Object(_))) {
        object.insert("snowcfg".to_string(), json!({}));
    }
    object
        .get_mut("snowcfg")
        .and_then(Value::as_object_mut)
        .expect("snowcfg must be an object")
}

fn set_legacy_text(snowcfg: &mut Map<String, Value>, key: &str, value: &str) {
    if !value.trim().is_empty() || !snowcfg.contains_key(key) {
        snowcfg.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn set_legacy_optional(snowcfg: &mut Map<String, Value>, key: &str, value: Option<i32>) {
    if let Some(value) = value {
        snowcfg.insert(key.to_string(), json!(value));
    } else {
        snowcfg.entry(key.to_string()).or_insert(Value::Null);
    }
}

fn apply_legacy_values(root: &mut Value, legacy: &LegacyConfigValues) {
    let snowcfg = ensure_snowcfg(root);
    set_legacy_text(snowcfg, "baseUrl", &legacy.base_url);
    set_legacy_text(snowcfg, "baseUrlMode", &legacy.base_url_mode);
    set_legacy_text(snowcfg, "apiKey", &legacy.api_key);
    set_legacy_text(snowcfg, "requestMethod", &legacy.request_method);
    set_legacy_text(snowcfg, "advancedModel", &legacy.advanced_model);
    set_legacy_text(snowcfg, "basicModel", &legacy.basic_model);
    snowcfg.insert("supportsVision".to_string(), json!(legacy.supports_vision));
    set_legacy_text(snowcfg, "visionBaseUrl", &legacy.vision_base_url);
    set_legacy_text(snowcfg, "visionBaseUrlMode", &legacy.vision_base_url_mode);
    set_legacy_text(snowcfg, "visionApiKey", &legacy.vision_api_key);
    set_legacy_text(
        snowcfg,
        "visionRequestMethod",
        &legacy.vision_request_method,
    );
    set_legacy_text(snowcfg, "visionModel", &legacy.vision_model);
    set_legacy_optional(snowcfg, "maxContextTokens", legacy.max_context_tokens);
    set_legacy_optional(snowcfg, "maxTokens", legacy.max_tokens);
    set_legacy_optional(
        snowcfg,
        "streamIdleTimeoutSec",
        legacy.stream_idle_timeout_sec,
    );
    snowcfg.insert(
        "enableAutoCompress".to_string(),
        json!(legacy.enable_auto_compress),
    );
    set_legacy_optional(
        snowcfg,
        "autoCompressThreshold",
        legacy.auto_compress_threshold,
    );
    snowcfg.insert("maxRetries".to_string(), json!(legacy.max_retries));
    // legacy 列为 NOT NULL，0 是「档案留 0」的哨兵值：此时不覆盖 config_json 里
    // 已显式写入的 null（留 0 = 指数退避），仅在该键缺失时补 null。
    if legacy.retry_base_delay_ms > 0 {
        snowcfg.insert(
            "retryDelayMs".to_string(),
            json!(legacy.retry_base_delay_ms),
        );
    } else {
        snowcfg
            .entry("retryDelayMs".to_string())
            .or_insert(Value::Null);
    }
    snowcfg.insert(
        "partialRetryMaxChars".to_string(),
        json!(legacy.partial_retry_max_chars),
    );
    set_legacy_text(
        snowcfg,
        "systemPromptIdsJson",
        &legacy.system_prompt_ids_json,
    );
    set_legacy_text(
        snowcfg,
        "customHeaderSchemeId",
        &legacy.custom_header_scheme_id,
    );
    set_legacy_text(snowcfg, "source", &legacy.source);
}

fn canonicalize_legacy_json(raw: &str, legacy: &LegacyConfigValues) -> String {
    let mut root = parse_json_object(raw);
    apply_legacy_values(&mut root, legacy);
    serde_json::to_string(&root).unwrap_or_else(|_| "{\"snowcfg\":{}}".to_string())
}

fn default_config_json() -> String {
    serde_json::to_string(&json!({
        "snowcfg": {
            "baseUrl": DEFAULT_BASE_URL,
            "baseUrlMode": "auto",
            "apiKey": "",
            "requestMethod": DEFAULT_REQUEST_METHOD,
            "advancedModel": DEFAULT_ADVANCED_MODEL,
            "basicModel": DEFAULT_BASIC_MODEL,
            "supportsVision": true,
            "visionBaseUrl": "",
            "visionBaseUrlMode": "auto",
            "visionApiKey": "",
            "visionRequestMethod": DEFAULT_REQUEST_METHOD,
            "visionModel": "",
            "maxContextTokens": DEFAULT_MAX_CONTEXT_TOKENS,
            "maxTokens": null,
            "streamIdleTimeoutSec": null,
            "enableAutoCompress": true,
            "autoCompressThreshold": null,
            "maxRetries": 5,
            "retryDelayMs": null,
            "partialRetryMaxChars": 1000,
            "systemPromptIdsJson": "",
            "customHeaderSchemeId": "",
            "source": "default",
            "chatThinking": {"enabled": true, "reasoning_effort": "high"},
            "responsesReasoning": {"enabled": true, "effort": "high"},
            "geminiThinking": {"enabled": true, "thinkingLevel": "high"},
            "thinking": {"enabled": true, "effort": "high"}
        }
    }))
    .expect("default API config JSON must serialize")
}

fn snowcfg_text(raw: &str, key: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.get("snowcfg").cloned())
        .and_then(|value| value.get(key).cloned())
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_default()
}

fn snowcfg_i32(raw: &str, key: &str) -> Option<i32> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.get("snowcfg").cloned())
        .and_then(|value| value.get(key).cloned())
        .and_then(|value| value.as_i64())
        .and_then(|value| i32::try_from(value).ok())
}

fn snowcfg_bool(raw: &str, key: &str, fallback: bool) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.get("snowcfg").cloned())
        .and_then(|value| value.get(key).cloned())
        .and_then(|value| value.as_bool())
        .unwrap_or(fallback)
}

fn legacy_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LegacyConfigValues> {
    Ok(LegacyConfigValues {
        base_url: row.get(4)?,
        base_url_mode: row.get(5)?,
        api_key: row.get(6)?,
        request_method: row.get(7)?,
        advanced_model: row.get(8)?,
        basic_model: row.get(9)?,
        supports_vision: row.get::<_, i64>(10)? != 0,
        vision_base_url: row.get(11)?,
        vision_base_url_mode: row.get(12)?,
        vision_api_key: row.get(13)?,
        vision_request_method: row.get(14)?,
        vision_model: row.get(15)?,
        max_context_tokens: row
            .get::<_, Option<i64>>(16)?
            .and_then(|value| i32::try_from(value).ok()),
        max_tokens: row
            .get::<_, Option<i64>>(17)?
            .and_then(|value| i32::try_from(value).ok()),
        stream_idle_timeout_sec: row
            .get::<_, Option<i64>>(18)?
            .and_then(|value| i32::try_from(value).ok()),
        enable_auto_compress: row.get::<_, i64>(19)? != 0,
        auto_compress_threshold: row
            .get::<_, Option<i64>>(20)?
            .and_then(|value| i32::try_from(value).ok()),
        max_retries: row.get::<_, i64>(21)? as i32,
        retry_base_delay_ms: row.get::<_, i64>(22)? as i32,
        partial_retry_max_chars: row.get::<_, i64>(23)? as i32,
        system_prompt_ids_json: row.get(24)?,
        custom_header_scheme_id: row.get(25)?,
        source: row.get(27)?,
    })
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApiConfigRecord> {
    let raw_config_json: String = row.get(26)?;
    let legacy = legacy_from_row(row)?;
    let config_json = canonicalize_legacy_json(&raw_config_json, &legacy);

    Ok(ApiConfigRecord {
        id: row.get(0)?,
        profile_name: row.get(1)?,
        display_name: row.get(2)?,
        is_active: row.get::<_, i64>(3)? != 0,
        base_url: snowcfg_text(&config_json, "baseUrl"),
        base_url_mode: snowcfg_text(&config_json, "baseUrlMode"),
        api_key: snowcfg_text(&config_json, "apiKey"),
        request_method: snowcfg_text(&config_json, "requestMethod"),
        advanced_model: snowcfg_text(&config_json, "advancedModel"),
        basic_model: snowcfg_text(&config_json, "basicModel"),
        supports_vision: snowcfg_bool(&config_json, "supportsVision", legacy.supports_vision),
        vision_base_url: snowcfg_text(&config_json, "visionBaseUrl"),
        vision_base_url_mode: snowcfg_text(&config_json, "visionBaseUrlMode"),
        vision_api_key: snowcfg_text(&config_json, "visionApiKey"),
        vision_request_method: snowcfg_text(&config_json, "visionRequestMethod"),
        vision_model: snowcfg_text(&config_json, "visionModel"),
        max_context_tokens: snowcfg_i32(&config_json, "maxContextTokens"),
        max_tokens: snowcfg_i32(&config_json, "maxTokens"),
        stream_idle_timeout_sec: snowcfg_i32(&config_json, "streamIdleTimeoutSec"),
        enable_auto_compress: snowcfg_bool(
            &config_json,
            "enableAutoCompress",
            legacy.enable_auto_compress,
        ),
        auto_compress_threshold: snowcfg_i32(&config_json, "autoCompressThreshold"),
        max_retries: snowcfg_i32(&config_json, "maxRetries"),
        retry_base_delay_ms: snowcfg_i32(&config_json, "retryDelayMs"),
        partial_retry_max_chars: snowcfg_i32(&config_json, "partialRetryMaxChars"),
        system_prompt_ids_json: snowcfg_text(&config_json, "systemPromptIdsJson"),
        custom_header_scheme_id: snowcfg_text(&config_json, "customHeaderSchemeId"),
        source: snowcfg_text(&config_json, "source"),
        config_json,
        updated_at: row.get(28)?,
        sort_order: row.get(29)?,
    })
}

pub fn list_api_configs(database_path: &Path) -> Result<Vec<ApiConfigRecord>> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "list API configs", error))?;
    // 空表（首次安装）保持为空，不播种默认档案：渲染层据此显示「前往配置 API」
    // 引导条。已有档案时才校正唯一激活档案。
    let has_any = has_any_api_config(&connection).map_err(|error| {
        database::database_error(database_path, "check API configs", error)
    })?;
    if has_any {
        ensure_one_active_config(&connection).map_err(|error| {
            database::database_error(database_path, "normalize active API config", error)
        })?;
    }

    let mut statement = connection
        .prepare(
            "SELECT CAST(id AS TEXT),
                    profile_name,
                    display_name,
                    is_active,
                    base_url,
                    base_url_mode,
                    api_key,
                    request_method,
                    advanced_model,
                    basic_model,
                    supports_vision,
                    vision_base_url,
                    vision_base_url_mode,
                    vision_api_key,
                    vision_request_method,
                    vision_model,
                    max_context_tokens,
                    max_tokens,
                    stream_idle_timeout_sec,
                    enable_auto_compress,
                    auto_compress_threshold,
                    max_retries,
                    retry_base_delay_ms,
                    partial_retry_max_chars,
                    system_prompt_ids_json,
                    custom_header_scheme_id,
                    config_json,
                    source,
                    updated_at,
                    sort_order
               FROM api_configs
              ORDER BY sort_order ASC, display_name COLLATE NOCASE ASC, profile_name ASC",
        )
        .map_err(|error| database::database_error(database_path, "prepare API config list", error))?;
    let rows = statement
        .query_map([], record_from_row)
        .map_err(|error| database::database_error(database_path, "query API configs", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| database::database_error(database_path, "read API configs", error))
}

/// 重排 API 档案：按给定档案名顺序重写 `sort_order`（0,1,2,...）。
///
/// 未出现在 `ordered_profile_names` 中的档案保持原有相对顺序并排在其后；
/// 名单里不存在的名称（例如已被删除的档案）会被忽略。
pub fn reorder_api_configs(database_path: &Path, ordered_profile_names: &[String]) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            let mut statement = transaction.prepare(
                "SELECT profile_name
                   FROM api_configs
                  ORDER BY sort_order ASC, display_name COLLATE NOCASE ASC, profile_name ASC",
            )?;
            let existing: Vec<String> = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);

            let mut ordered: Vec<String> = Vec::with_capacity(existing.len());
            for name in ordered_profile_names {
                let name = name.trim();
                if name.is_empty()
                    || !existing.iter().any(|item| item == name)
                    || ordered.iter().any(|item| item == name)
                {
                    continue;
                }
                ordered.push(name.to_string());
            }
            for name in &existing {
                if !ordered.iter().any(|item| item == name) {
                    ordered.push(name.clone());
                }
            }

            for (index, profile_name) in ordered.iter().enumerate() {
                transaction.execute(
                    "UPDATE api_configs SET sort_order = ?1 WHERE profile_name = ?2",
                    params![index as i64, profile_name],
                )?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "reorder API configs", error))
}

pub fn upsert_api_config(database_path: &Path, config: &ApiConfigInput) -> Result<()> {
    if config.is_active && config.advanced_model.trim().is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Advanced model is required for an active API profile".to_string(),
        ));
    }
    if config.is_active && config.basic_model.trim().is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Basic model is required for an active API profile".to_string(),
        ));
    }

    let result = database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;

            if let Some(previous_profile_name) = config.previous_profile_name.as_deref() {
                let previous = previous_profile_name.trim();
                if !previous.is_empty() && previous != config.profile_name {
                    let renamed = transaction.execute(
                        "UPDATE api_configs
                            SET profile_name = ?1,
                                updated_at = datetime('now', 'localtime')
                          WHERE profile_name = ?2",
                        params![config.profile_name, previous],
                    )?;
                    if renamed == 0 {
                        return Err(rusqlite::Error::SqliteFailure(
                            rusqlite::ffi::Error::new(rusqlite::ffi::ErrorCode::NotFound as i32),
                            Some(format!(
                                "API profile \"{previous}\" does not exist (rename failed)"
                            )),
                        ));
                    }
                }
            }

            if config.is_active {
                transaction.execute(
                    "UPDATE api_configs
                        SET is_active = 0,
                            updated_at = datetime('now', 'localtime')
                      WHERE is_active = 1",
                    [],
                )?;
            }

            let existing = transaction
                .query_row(
                    "SELECT api_key, vision_api_key, config_json
                       FROM api_configs
                      WHERE profile_name = ?1",
                    [config.profile_name.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let existing_api_key = existing
                .as_ref()
                .map(|value| value.0.clone())
                .unwrap_or_default();
            let existing_vision_api_key = existing
                .as_ref()
                .map(|value| value.1.clone())
                .unwrap_or_default();
            let api_key = if config.api_key.is_empty() {
                existing_api_key
            } else {
                config.api_key.clone()
            };
            let vision_api_key = if config.vision_api_key.is_empty() {
                existing_vision_api_key
            } else {
                config.vision_api_key.clone()
            };
            let existing_config_json = existing
                .as_ref()
                .map(|value| value.2.as_str())
                .unwrap_or("{}");
            let effective_max_context_tokens = config.max_context_tokens;
            let effective_max_tokens = config.max_tokens;
            let effective_stream_idle_timeout_sec = config.stream_idle_timeout_sec;
            let effective_auto_compress_threshold = config.auto_compress_threshold;
            let effective_max_retries = config.max_retries.unwrap_or(5);
            let effective_retry_base_delay_ms = config.retry_base_delay_ms.filter(|value| *value > 0);
            let legacy_retry_base_delay_ms = effective_retry_base_delay_ms.unwrap_or(0);
            let effective_partial_retry_max_chars = config.partial_retry_max_chars.unwrap_or(1000);

            let mut canonical = parse_json_object(existing_config_json);
            merge_json_values(&mut canonical, &parse_json_object(&config.config_json));
            let snowcfg = ensure_snowcfg(&mut canonical);
            snowcfg.insert("baseUrl".to_string(), json!(config.base_url));
            snowcfg.insert("baseUrlMode".to_string(), json!(config.base_url_mode));
            snowcfg.insert("apiKey".to_string(), json!(api_key));
            snowcfg.insert("requestMethod".to_string(), json!(config.request_method));
            snowcfg.insert("advancedModel".to_string(), json!(config.advanced_model));
            snowcfg.insert("basicModel".to_string(), json!(config.basic_model));
            snowcfg.insert("supportsVision".to_string(), json!(config.supports_vision));
            snowcfg.insert("visionBaseUrl".to_string(), json!(config.vision_base_url));
            snowcfg.insert(
                "visionBaseUrlMode".to_string(),
                json!(config.vision_base_url_mode),
            );
            snowcfg.insert("visionApiKey".to_string(), json!(vision_api_key));
            snowcfg.insert(
                "visionRequestMethod".to_string(),
                json!(config.vision_request_method),
            );
            snowcfg.insert("visionModel".to_string(), json!(config.vision_model));
            set_input_optional(
                &mut *snowcfg,
                "maxContextTokens",
                effective_max_context_tokens,
            );
            // maxTokens 允许清空：None 时显式写 null 覆盖 config_json 残留旧值，
            // 否则请求/回显（均从 config_json 读取）仍会命中已删除的 max_tokens。
            if let Some(max_tokens) = effective_max_tokens {
                snowcfg.insert("maxTokens".to_string(), json!(max_tokens));
            } else {
                snowcfg.insert("maxTokens".to_string(), Value::Null);
            }
            set_input_optional(
                &mut *snowcfg,
                "streamIdleTimeoutSec",
                effective_stream_idle_timeout_sec,
            );
            snowcfg.insert(
                "enableAutoCompress".to_string(),
                json!(config.enable_auto_compress),
            );
            set_input_optional(
                &mut *snowcfg,
                "autoCompressThreshold",
                effective_auto_compress_threshold,
            );
            set_input_optional(
                &mut *snowcfg,
                "maxRetries",
                Some(effective_max_retries),
            );
            set_input_optional(
                &mut *snowcfg,
                "retryDelayMs",
                effective_retry_base_delay_ms,
            );
            set_input_optional(
                &mut *snowcfg,
                "partialRetryMaxChars",
                Some(effective_partial_retry_max_chars),
            );
            snowcfg.insert(
                "systemPromptIdsJson".to_string(),
                json!(config.system_prompt_ids_json),
            );
            snowcfg.insert(
                "customHeaderSchemeId".to_string(),
                json!(config.custom_header_scheme_id),
            );
            snowcfg.insert("source".to_string(), json!(config.source));
            let canonical_json = serde_json::to_string(&canonical).unwrap_or_else(|_| {
                "{\"snowcfg\":{}}".to_string()
            });

            // 新档案追加到列表末尾；已存在的档案保持用户排序（ON CONFLICT 分支不写 sort_order）。
            let next_sort_order: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM api_configs",
                [],
                |row| row.get(0),
            )?;

            transaction.execute(
                "INSERT INTO api_configs (
                   id,
                   profile_name,
                   display_name,
                   is_active,
                   base_url,
                   base_url_mode,
                   api_key,
                   request_method,
                   advanced_model,
                   basic_model,
                   supports_vision,
                   vision_base_url,
                   vision_base_url_mode,
                   vision_api_key,
                   vision_request_method,
                   vision_model,
                   max_context_tokens,
                   max_tokens,
                   stream_idle_timeout_sec,
                   enable_auto_compress,
                   auto_compress_threshold,
                   max_retries,
                   retry_base_delay_ms,
                   partial_retry_max_chars,
                   system_prompt_ids_json,
                   custom_header_scheme_id,
                   config_json,
                   source,
                   sort_order,
                   created_at,
                   updated_at
                 ) VALUES (
                   CASE WHEN EXISTS (
                     SELECT 1 FROM pragma_table_info('api_configs')
                      WHERE name = 'id' AND upper(type) = 'INTEGER'
                   ) THEN NULL ELSE ?1 END,
                   ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                   ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                   ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29,
                   datetime('now', 'localtime'), datetime('now', 'localtime')
                 )
                 ON CONFLICT(profile_name) DO UPDATE SET
                   display_name = excluded.display_name,
                   is_active = excluded.is_active,
                   base_url = excluded.base_url,
                   base_url_mode = excluded.base_url_mode,
                   api_key = CASE
                     WHEN excluded.api_key = '' AND api_configs.api_key <> '' THEN api_configs.api_key
                     ELSE excluded.api_key
                   END,
                   request_method = excluded.request_method,
                   advanced_model = excluded.advanced_model,
                   basic_model = excluded.basic_model,
                   supports_vision = excluded.supports_vision,
                   vision_base_url = excluded.vision_base_url,
                   vision_base_url_mode = excluded.vision_base_url_mode,
                   vision_api_key = CASE
                     WHEN excluded.vision_api_key = '' AND api_configs.vision_api_key <> '' THEN api_configs.vision_api_key
                     ELSE excluded.vision_api_key
                   END,
                   vision_request_method = excluded.vision_request_method,
                   vision_model = excluded.vision_model,
                   max_context_tokens = excluded.max_context_tokens,
                   max_tokens = excluded.max_tokens,
                   stream_idle_timeout_sec = excluded.stream_idle_timeout_sec,
                   enable_auto_compress = excluded.enable_auto_compress,
                   auto_compress_threshold = excluded.auto_compress_threshold,
                   max_retries = excluded.max_retries,
                   retry_base_delay_ms = excluded.retry_base_delay_ms,
                   partial_retry_max_chars = excluded.partial_retry_max_chars,
                   system_prompt_ids_json = excluded.system_prompt_ids_json,
                   custom_header_scheme_id = excluded.custom_header_scheme_id,
                   config_json = excluded.config_json,
                   source = excluded.source,
                   updated_at = datetime('now', 'localtime')",
                params![
                    database::create_snowflake_id(),
                    config.profile_name,
                    config.display_name,
                    config.is_active as i32,
                    config.base_url,
                    config.base_url_mode,
                    api_key,
                    config.request_method,
                    config.advanced_model,
                    config.basic_model,
                    config.supports_vision as i32,
                    config.vision_base_url,
                    config.vision_base_url_mode,
                    vision_api_key,
                    config.vision_request_method,
                    config.vision_model,
                    effective_max_context_tokens,
                    effective_max_tokens,
                    effective_stream_idle_timeout_sec,
                    config.enable_auto_compress as i32,
                    effective_auto_compress_threshold,
                    effective_max_retries,
                    legacy_retry_base_delay_ms,
                    effective_partial_retry_max_chars,
                    config.system_prompt_ids_json,
                    config.custom_header_scheme_id,
                     canonical_json,
                     config.source,
                     next_sort_order,
                 ],
            )?;

            if !config.is_active {
                ensure_one_active_config(&transaction)?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "upsert API config", error));

    result?;
    sync_active_profile_to_snow_cli(database_path)
}

fn set_input_optional(snowcfg: &mut Map<String, Value>, key: &str, value: Option<i32>) {
    if let Some(value) = value {
        snowcfg.insert(key.to_string(), json!(value));
    } else {
        snowcfg.entry(key.to_string()).or_insert(Value::Null);
    }
}

pub fn delete_api_config(database_path: &Path, profile_name: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM api_configs WHERE profile_name = ?1",
                [profile_name],
            )?;
            seed_default_api_config_with_connection(&transaction)?;
            ensure_one_active_config(&transaction)?;
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "delete API config", error))?;

    sync_active_profile_to_snow_cli(database_path)
}

fn insert_default_api_config(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO api_configs (
           id, profile_name, display_name, is_active, base_url, base_url_mode,
           api_key, request_method, advanced_model, basic_model, supports_vision,
           vision_base_url, vision_base_url_mode, vision_api_key,
           vision_request_method, vision_model, max_context_tokens, max_tokens,
           stream_idle_timeout_sec, enable_auto_compress, auto_compress_threshold,
           max_retries, retry_base_delay_ms, partial_retry_max_chars,
           system_prompt_ids_json, custom_header_scheme_id, config_json, source,
           created_at, updated_at
         ) VALUES (
           CASE WHEN EXISTS (
             SELECT 1 FROM pragma_table_info('api_configs')
              WHERE name = 'id' AND upper(type) = 'INTEGER'
           ) THEN NULL ELSE ?1 END,
           ?2, ?3, 1, ?4, 'auto', '', ?5, ?6, ?7, 1,
           '', 'auto', '', ?5, '', ?8, NULL, NULL, 1, NULL,
           5, 0, 1000, '', '', ?9, 'default',
           datetime('now', 'localtime'), datetime('now', 'localtime')
         ) ON CONFLICT(profile_name) DO NOTHING",
        params![
            database::create_snowflake_id(),
            DEFAULT_PROFILE_NAME,
            DEFAULT_DISPLAY_NAME,
            DEFAULT_BASE_URL,
            DEFAULT_REQUEST_METHOD,
            DEFAULT_ADVANCED_MODEL,
            DEFAULT_BASIC_MODEL,
            DEFAULT_MAX_CONTEXT_TOKENS,
            default_config_json(),
        ],
    )?;
    Ok(())
}

fn has_any_api_config(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM api_configs)",
        [],
        |row| row.get(0),
    )
}

fn seed_default_api_config_with_connection(connection: &Connection) -> rusqlite::Result<()> {
    if !has_any_api_config(connection)? {
        insert_default_api_config(connection)?;
    }
    ensure_one_active_config(connection)
}

fn ensure_complete_default_api_config(connection: &Connection) -> rusqlite::Result<()> {
    let has_default: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM api_configs WHERE profile_name = ?1)",
        [DEFAULT_PROFILE_NAME],
        |row| row.get(0),
    )?;
    if !has_default {
        insert_default_api_config(connection)?;
    }
    connection.execute(
        "UPDATE api_configs
            SET advanced_model = CASE WHEN trim(advanced_model) = '' THEN ?1 ELSE advanced_model END,
                basic_model = CASE WHEN trim(basic_model) = '' THEN ?2 ELSE basic_model END,
                updated_at = datetime('now', 'localtime')
          WHERE profile_name = ?3",
        params![
            DEFAULT_ADVANCED_MODEL,
            DEFAULT_BASIC_MODEL,
            DEFAULT_PROFILE_NAME
        ],
    )?;
    Ok(())
}

fn complete_api_config_candidate(connection: &Connection) -> rusqlite::Result<Option<String>> {
    let mut statement = connection.prepare(
        "SELECT CAST(id AS TEXT), advanced_model, basic_model
           FROM api_configs
          ORDER BY is_active DESC, updated_at DESC, display_name COLLATE NOCASE ASC",
    )?;
    let profiles = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for profile in profiles {
        let (id, advanced_model, basic_model) = profile?;
        if !advanced_model.trim().is_empty() && !basic_model.trim().is_empty() {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn ensure_one_active_config(connection: &Connection) -> rusqlite::Result<()> {
    let candidate_id = match complete_api_config_candidate(connection)? {
        Some(candidate_id) => candidate_id,
        None => {
            ensure_complete_default_api_config(connection)?;
            connection.query_row(
                "SELECT CAST(id AS TEXT) FROM api_configs WHERE profile_name = ?1",
                [DEFAULT_PROFILE_NAME],
                |row| row.get(0),
            )?
        }
    };
    connection.execute(
        "UPDATE api_configs
            SET is_active = 0,
                updated_at = datetime('now', 'localtime')
          WHERE is_active = 1 AND CAST(id AS TEXT) <> ?1",
        [&candidate_id],
    )?;
    connection.execute(
        "UPDATE api_configs
            SET is_active = 1,
                updated_at = datetime('now', 'localtime')
          WHERE CAST(id AS TEXT) = ?1 AND is_active = 0",
        [&candidate_id],
    )?;
    Ok(())
}

fn read_json_object(path: &Path) -> std::result::Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(Value::Object(object)) => Ok(Value::Object(object)),
            Ok(_) => Err(format!("{} must contain a JSON object", path.display())),
            Err(error) => Err(format!("Invalid JSON in {}: {error}", path.display())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

fn atomic_write_json(path: &Path, value: &Value) -> std::result::Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("snow-config.json");
    let temporary = path.with_file_name(format!(".{file_name}.tmp-{}-{timestamp}", std::process::id()));

    if let Err(error) = fs::write(&temporary, content) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to write {}: {error}", temporary.display()));
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to replace {}: {error}", path.display()));
    }
    Ok(())
}

fn sync_active_profile_to_snow_cli(database_path: &Path) -> Result<()> {
    let active = list_api_configs(database_path)?
        .into_iter()
        .find(|config| config.is_active)
        .ok_or_else(|| Error::from_reason("API profile database has no active profile".to_string()))?;
    let profile_name = active.profile_name;
    let canonical = parse_json_object(&active.config_json);
    let home = dirs_next::home_dir().ok_or_else(|| {
        Error::from_reason("Cannot determine home directory for Snow CLI sync".to_string())
    })?;
    let snow_dir = home.join(".snow");
    fs::create_dir_all(&snow_dir).map_err(|error| {
        Error::from_reason(format!("Failed to create Snow CLI directory: {error}"))
    })?;

    let config_path = snow_dir.join("config.json");
    let mut config_file = read_json_object(&config_path).map_err(Error::from_reason)?;
    if let (Some(config_object), Some(canonical_object)) =
        (config_file.as_object_mut(), canonical.as_object())
    {
        for (key, value) in canonical_object {
            if key == "snowcfg" {
                config_object.insert(key.clone(), value.clone());
            } else {
                match config_object.get_mut(key) {
                    Some(existing) => merge_json_values(existing, value),
                    None => {
                        config_object.insert(key.clone(), value.clone());
                    }
                }
            }
        }
    }
    atomic_write_json(&config_path, &config_file).map_err(|error| {
        Error::from_reason(format!(
            "API profile database committed, but Snow CLI config sync failed: {error}"
        ))
    })?;

    let active_path = snow_dir.join("active-profile.json");
    let mut active_file = read_json_object(&active_path).map_err(Error::from_reason)?;
    active_file["activeProfile"] = Value::String(profile_name);
    atomic_write_json(&active_path, &active_file).map_err(|error| {
        Error::from_reason(format!(
            "API profile database committed, but active profile sync failed: {error}"
        ))
    })
}
