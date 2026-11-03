//! 旧存储迁入模型表（幂等）：system_settings 里的 `embedding_models` /
//! `reranking_models` / `decision_models` JSON 列表与 `model_health` 自检快照。
//! 导入后删除旧设置项；已存在的 model_id 不覆盖。

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{
    model_exists_with_connection, read_setting_with_connection,
    record_model_health_with_connection, upsert_decision_model_with_connection,
    upsert_embedding_model_with_connection, upsert_reranking_model_with_connection,
    DecisionModelEntry, EmbeddingModelEntry, ModelConnectionTestResult, RegisteredModelKind,
    RerankingModelEntry,
};

const LEGACY_EMBEDDING_MODELS_CODE: &str = "embedding_models";
const LEGACY_RERANKING_MODELS_CODE: &str = "reranking_models";
const LEGACY_DECISION_MODELS_CODE: &str = "decision_models";
const LEGACY_MODEL_HEALTH_CODE: &str = "model_health";

fn delete_setting(connection: &Connection, setting_code: &str) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM system_settings WHERE setting_code = ?1",
        [setting_code],
    )?;
    Ok(())
}

/// `{ "models": [...] }` 里能解析的条目；非法条目逐个跳过。
fn legacy_items<T: DeserializeOwned>(raw: &str) -> Vec<T> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(Value::Array(items)) = root.get("models") else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| serde_json::from_value::<T>(item.clone()).ok())
        .collect()
}

/// 已有同 id 的行时跳过（重复执行迁移不覆盖用户后续修改）。
fn is_new(
    connection: &Connection,
    kind: RegisteredModelKind,
    id: &str,
) -> rusqlite::Result<bool> {
    Ok(id.trim().is_empty() || !model_exists_with_connection(connection, kind, id)?)
}

fn import_embedding_models(connection: &Connection) -> rusqlite::Result<()> {
    let Some(raw) = read_setting_with_connection(connection, LEGACY_EMBEDDING_MODELS_CODE)? else {
        return Ok(());
    };
    for model in legacy_items::<EmbeddingModelEntry>(&raw) {
        if model.model_name.trim().is_empty() && model.name.trim().is_empty() {
            continue;
        }
        if is_new(connection, RegisteredModelKind::Embedding, &model.id)? {
            upsert_embedding_model_with_connection(connection, model)?;
        }
    }
    delete_setting(connection, LEGACY_EMBEDDING_MODELS_CODE)
}

fn import_reranking_models(connection: &Connection) -> rusqlite::Result<()> {
    let Some(raw) = read_setting_with_connection(connection, LEGACY_RERANKING_MODELS_CODE)? else {
        return Ok(());
    };
    for model in legacy_items::<RerankingModelEntry>(&raw) {
        if model.model_name.trim().is_empty() && model.name.trim().is_empty() {
            continue;
        }
        if is_new(connection, RegisteredModelKind::Reranking, &model.id)? {
            upsert_reranking_model_with_connection(connection, model)?;
        }
    }
    delete_setting(connection, LEGACY_RERANKING_MODELS_CODE)
}

fn import_decision_models(connection: &Connection) -> rusqlite::Result<()> {
    let Some(raw) = read_setting_with_connection(connection, LEGACY_DECISION_MODELS_CODE)? else {
        return Ok(());
    };
    for model in legacy_items::<DecisionModelEntry>(&raw) {
        if model.model.trim().is_empty() && model.name.trim().is_empty() {
            continue;
        }
        if is_new(connection, RegisteredModelKind::Decision, &model.id)? {
            upsert_decision_model_with_connection(connection, model)?;
        }
    }
    delete_setting(connection, LEGACY_DECISION_MODELS_CODE)
}

/// 旧快照按 targetId 写入对应模型行；已有自检结果的行不覆盖。
fn import_model_health(connection: &Connection) -> rusqlite::Result<()> {
    let Some(raw) = read_setting_with_connection(connection, LEGACY_MODEL_HEALTH_CODE)? else {
        return Ok(());
    };
    if let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&raw) {
        let groups = [
            ("decision", RegisteredModelKind::Decision),
            ("embeddingModels", RegisteredModelKind::Embedding),
            ("rerankingModels", RegisteredModelKind::Reranking),
        ];
        for (key, kind) in groups {
            let Some(Value::Array(items)) = root.get(key) else {
                continue;
            };
            let tested: Vec<String> = super::list_model_health_with_connection(connection, kind)?
                .into_iter()
                .map(|result| result.target_id)
                .collect();
            for item in items {
                let Ok(result) = serde_json::from_value::<ModelConnectionTestResult>(item.clone())
                else {
                    continue;
                };
                if result.target_id.trim().is_empty() || tested.contains(&result.target_id) {
                    continue;
                }
                record_model_health_with_connection(connection, kind, &result)?;
            }
        }
    }
    delete_setting(connection, LEGACY_MODEL_HEALTH_CODE)
}

/// 启动迁移入口：先导入模型列表，再挂接自检结果。
pub fn migrate_legacy_model_settings(connection: &Connection) -> rusqlite::Result<()> {
    import_embedding_models(connection)?;
    import_reranking_models(connection)?;
    import_decision_models(connection)?;
    import_model_health(connection)
}
