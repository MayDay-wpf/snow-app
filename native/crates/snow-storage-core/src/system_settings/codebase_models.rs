//! 代码库设置与模型注册表的衔接：代码库设置只保存选中的嵌入 / 重排模型 id，
//! 运行时（索引 / 检索 / 插件上下文）经 [`resolve_codebase_settings`] 把选中的
//! 模型展开成旧的内联字段，下游解析结构无需感知模型表。
//!
//! 旧格式（Snow CLI 同步、历史版本）里内联的模型字段与 Jev 字段由
//! [`migrate_codebase_inline_models_with_connection`] 迁入模型表。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::set_system_setting_with_connection;
use crate::database;
use crate::model_registry::{
    list_decision_models_with_connection, list_embedding_models_with_connection,
    list_reranking_models_with_connection, read_setting_with_connection,
    upsert_decision_model_with_connection, upsert_embedding_model_with_connection,
    upsert_reranking_model_with_connection, DecisionModelEntry, EmbeddingModelEntry,
    RerankingModelEntry, DECISION_PROVIDER_TYPESAFE, DEFAULT_EMBEDDING_CONTEXT_LENGTH,
    DEFAULT_EMBEDDING_TYPE, DEFAULT_RERANKING_CONTEXT_LENGTH, DEFAULT_TYPESAFE_BASE_URL,
    DEFAULT_TYPESAFE_MODEL, DEFAULT_TYPESAFE_NAME,
};

const CODEBASE_SETTING_NAME: &str = "Codebase settings";
const CODEBASE_SETTING_CODE: &str = "codebase_settings";

pub const EMBEDDING_MODEL_ID_KEY: &str = "embeddingModelId";
pub const RERANKING_MODEL_ID_KEY: &str = "rerankingModelId";
pub const AGENT_REVIEW_MODEL_ID_KEY: &str = "agentReviewModelId";

/// 旧版内联在 codebase_settings 里的嵌入字段（迁移后移除）。
pub const INLINE_EMBEDDING_KEYS: &[&str] = &[
    "embeddingType",
    "embeddingModelName",
    "embeddingBaseUrl",
    "embeddingApiKey",
    "embeddingDimensions",
    "modelContextLength",
];

/// 旧版内联在 codebase_settings 里的重排字段（迁移后移除；rerankingTopN 仍属代码库设置）。
pub const INLINE_RERANKING_KEYS: &[&str] = &[
    "rerankingModelName",
    "rerankingBaseUrl",
    "rerankingApiKey",
    "rerankingContextLength",
];

/// 更早版本内联的 TypeSafe Jev 审查配置（迁入决策模型表后移除）。
const LEGACY_JEV_KEYS: &[&str] = &["jevApiKey", "jevBaseUrl", "jevModel"];

// 旧前端的默认表单值：未填密钥时等于「从未配置」，迁移时不生成模型条目。
const LEGACY_DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";
const LEGACY_DEFAULT_EMBEDDING_BASE_URL: &str = "https://api.openai.com/v1";

fn parse_object(raw: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(object)) => object,
        _ => Map::new(),
    }
}

fn text_field(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn int_field(object: &Map<String, Value>, key: &str) -> Option<i32> {
    let value = object.get(key)?;
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        .and_then(|number| i32::try_from(number).ok())
}

fn positive_or(value: i32, fallback: i32) -> i32 {
    if value > 0 {
        value
    } else {
        fallback
    }
}

/// 把选中的模型展开为运行时内联字段。
///
/// - 带 `embeddingModelId` / `rerankingModelId` 键：命中已启用条目时写入其配置，
///   否则清空对应字段（嵌入视为未配置、重排视为未启用）。
/// - 不带 id 键：未迁移的旧数据，保留内联字段原样。
pub fn resolve_codebase_settings(
    raw: &str,
    embedding_models: &[EmbeddingModelEntry],
    reranking_models: &[RerankingModelEntry],
) -> Value {
    let mut object = parse_object(raw);

    if object.contains_key(EMBEDDING_MODEL_ID_KEY) {
        let id = text_field(&object, EMBEDDING_MODEL_ID_KEY);
        let selected = embedding_models
            .iter()
            .find(|model| model.enabled && !id.is_empty() && model.id == id);
        match selected {
            Some(model) => {
                let embedding_type = if model.embedding_type.trim().is_empty() {
                    DEFAULT_EMBEDDING_TYPE
                } else {
                    model.embedding_type.trim()
                };
                object.insert("embeddingType".into(), json!(embedding_type));
                object.insert("embeddingModelName".into(), json!(model.model_name.trim()));
                object.insert("embeddingBaseUrl".into(), json!(model.base_url.trim()));
                object.insert("embeddingApiKey".into(), json!(model.api_key.trim()));
                object.insert("embeddingDimensions".into(), json!(model.dimensions.max(0)));
                object.insert(
                    "modelContextLength".into(),
                    json!(positive_or(model.context_length, DEFAULT_EMBEDDING_CONTEXT_LENGTH)),
                );
            }
            None => {
                object.insert("embeddingModelName".into(), json!(""));
                object.insert("embeddingBaseUrl".into(), json!(""));
                object.insert("embeddingApiKey".into(), json!(""));
            }
        }
    }

    if object.contains_key(RERANKING_MODEL_ID_KEY) {
        let id = text_field(&object, RERANKING_MODEL_ID_KEY);
        let selected = reranking_models
            .iter()
            .find(|model| model.enabled && !id.is_empty() && model.id == id);
        match selected {
            Some(model) => {
                object.insert("rerankingModelName".into(), json!(model.model_name.trim()));
                object.insert("rerankingBaseUrl".into(), json!(model.base_url.trim()));
                object.insert("rerankingApiKey".into(), json!(model.api_key.trim()));
                object.insert(
                    "rerankingContextLength".into(),
                    json!(positive_or(model.context_length, DEFAULT_RERANKING_CONTEXT_LENGTH)),
                );
            }
            None => {
                object.insert("rerankingModelName".into(), json!(""));
                object.insert("rerankingBaseUrl".into(), json!(""));
                object.insert("rerankingApiKey".into(), json!(""));
            }
        }
    }

    Value::Object(object)
}

/// 用调用方的连接直读（不走缓存）展开代码库设置；返回 (原始 JSON, 展开结果)。
pub fn resolve_codebase_settings_with_connection(
    connection: &Connection,
) -> rusqlite::Result<(String, Value)> {
    let raw = read_setting_with_connection(connection, CODEBASE_SETTING_CODE)?.unwrap_or_default();
    let embedding = list_embedding_models_with_connection(connection)?;
    let reranking = list_reranking_models_with_connection(connection)?;
    let resolved = resolve_codebase_settings(&raw, &embedding, &reranking);
    Ok((raw, resolved))
}

/// 读取代码库设置并展开选中的模型（供索引与检索使用）。
pub fn load_resolved_codebase_settings(database_path: &Path) -> Result<Value> {
    database::open_connection(database_path)
        .and_then(|connection| resolve_codebase_settings_with_connection(&connection))
        .map(|(_, resolved)| resolved)
        .map_err(|error| {
            database::database_error(database_path, "read codebase settings", error)
        })
}

/// 内联嵌入字段 -> 模型 id（复用配置完全相同的条目）；空配置返回空串。
fn lift_inline_embedding(
    connection: &Connection,
    object: &Map<String, Value>,
) -> rusqlite::Result<String> {
    let embedding_type = {
        let value = text_field(object, "embeddingType");
        if value.is_empty() {
            DEFAULT_EMBEDDING_TYPE.to_string()
        } else {
            value
        }
    };
    let model_name = text_field(object, "embeddingModelName");
    let base_url = text_field(object, "embeddingBaseUrl");
    let api_key = text_field(object, "embeddingApiKey");
    let dimensions = int_field(object, "embeddingDimensions").unwrap_or(0).max(0);
    let context_length = positive_or(
        int_field(object, "modelContextLength").unwrap_or(0),
        DEFAULT_EMBEDDING_CONTEXT_LENGTH,
    );

    if model_name.is_empty() && base_url.is_empty() {
        return Ok(String::new());
    }
    let untouched_default = api_key.is_empty()
        && embedding_type == DEFAULT_EMBEDDING_TYPE
        && model_name == LEGACY_DEFAULT_EMBEDDING_MODEL
        && base_url == LEGACY_DEFAULT_EMBEDDING_BASE_URL;
    if untouched_default {
        return Ok(String::new());
    }

    let existing = list_embedding_models_with_connection(connection)?
        .into_iter()
        .find(|model| {
            model.embedding_type == embedding_type
                && model.model_name == model_name
                && model.base_url == base_url
                && model.api_key == api_key
                && model.dimensions == dimensions
        });
    if let Some(existing) = existing {
        return Ok(existing.id);
    }

    let saved = upsert_embedding_model_with_connection(
        connection,
        EmbeddingModelEntry {
            name: model_name.clone(),
            embedding_type,
            model_name,
            base_url,
            api_key,
            dimensions,
            context_length,
            ..EmbeddingModelEntry::default()
        },
    )?;
    Ok(saved.id)
}

/// 内联重排字段 -> 模型 id（复用配置完全相同的条目）；空配置返回空串。
fn lift_inline_reranking(
    connection: &Connection,
    object: &Map<String, Value>,
) -> rusqlite::Result<String> {
    let model_name = text_field(object, "rerankingModelName");
    let base_url = text_field(object, "rerankingBaseUrl");
    let api_key = text_field(object, "rerankingApiKey");
    let context_length = positive_or(
        int_field(object, "rerankingContextLength").unwrap_or(0),
        DEFAULT_RERANKING_CONTEXT_LENGTH,
    );

    if model_name.is_empty() && base_url.is_empty() {
        return Ok(String::new());
    }

    let existing = list_reranking_models_with_connection(connection)?
        .into_iter()
        .find(|model| {
            model.model_name == model_name && model.base_url == base_url && model.api_key == api_key
        });
    if let Some(existing) = existing {
        return Ok(existing.id);
    }

    let saved = upsert_reranking_model_with_connection(
        connection,
        RerankingModelEntry {
            name: model_name.clone(),
            model_name,
            base_url,
            api_key,
            context_length,
            ..RerankingModelEntry::default()
        },
    )?;
    Ok(saved.id)
}

/// 旧 Jev 字段 -> 决策模型 id（复用相同端点 / 密钥 / 模型的条目）；未填密钥返回空串。
fn lift_legacy_jev(
    connection: &Connection,
    object: &Map<String, Value>,
) -> rusqlite::Result<String> {
    let api_key = text_field(object, "jevApiKey");
    if api_key.is_empty() {
        return Ok(String::new());
    }
    let base_url = {
        let value = text_field(object, "jevBaseUrl");
        if value.is_empty() {
            DEFAULT_TYPESAFE_BASE_URL.to_string()
        } else {
            value
        }
    };
    let model = {
        let value = text_field(object, "jevModel");
        if value.is_empty() {
            DEFAULT_TYPESAFE_MODEL.to_string()
        } else {
            value
        }
    };

    let existing = list_decision_models_with_connection(connection)?
        .into_iter()
        .find(|item| item.api_key == api_key && item.base_url == base_url && item.model == model);
    if let Some(existing) = existing {
        return Ok(existing.id);
    }

    let saved = upsert_decision_model_with_connection(
        connection,
        DecisionModelEntry {
            name: DEFAULT_TYPESAFE_NAME.to_string(),
            provider: DECISION_PROVIDER_TYPESAFE.to_string(),
            base_url,
            model,
            api_key,
            ..DecisionModelEntry::default()
        },
    )?;
    Ok(saved.id)
}

/// 把 codebase_settings 里的内联模型字段 / 旧 Jev 字段迁入模型表并改存 id（幂等）。
///
/// 启动迁移与每次写入 codebase_settings（如 Snow CLI 同步）后都会调用；
/// 没有旧字段时直接返回 false。
pub fn migrate_codebase_inline_models_with_connection(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    let Some(raw) = read_setting_with_connection(connection, CODEBASE_SETTING_CODE)? else {
        return Ok(false);
    };
    let mut object = parse_object(&raw);
    let has_key = |keys: &[&str]| keys.iter().any(|key| object.contains_key(*key));
    let has_embedding = has_key(INLINE_EMBEDDING_KEYS);
    let has_reranking = has_key(INLINE_RERANKING_KEYS);
    let has_jev = has_key(LEGACY_JEV_KEYS);
    if !has_embedding && !has_reranking && !has_jev {
        return Ok(false);
    }

    if has_embedding {
        let id = lift_inline_embedding(connection, &object)?;
        for key in INLINE_EMBEDDING_KEYS {
            object.remove(*key);
        }
        object.insert(EMBEDDING_MODEL_ID_KEY.into(), json!(id));
    }

    if has_reranking {
        let id = lift_inline_reranking(connection, &object)?;
        for key in INLINE_RERANKING_KEYS {
            object.remove(*key);
        }
        object.insert(RERANKING_MODEL_ID_KEY.into(), json!(id));
    }

    if has_jev {
        // 已选择决策模型时不覆盖，只清理旧字段。
        if text_field(&object, AGENT_REVIEW_MODEL_ID_KEY).is_empty() {
            let id = lift_legacy_jev(connection, &object)?;
            if !id.is_empty() {
                object.insert(AGENT_REVIEW_MODEL_ID_KEY.into(), json!(id));
            }
        }
        for key in LEGACY_JEV_KEYS {
            object.remove(*key);
        }
    }

    let serialized = serde_json::to_string(&Value::Object(object)).unwrap_or(raw);
    set_system_setting_with_connection(
        connection,
        CODEBASE_SETTING_NAME,
        CODEBASE_SETTING_CODE,
        &serialized,
    )?;
    Ok(true)
}
