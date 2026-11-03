//! 模型注册表（嵌入 / 重排 / 决策模型表）的 NAPI 导出；SQLite 读写均在阻塞线程执行。

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::services::model_registry::{
    self, DecisionModelEntry, EmbeddingModelEntry, ModelDeleteResult, RegisteredModelKind,
    RerankingModelEntry,
};

async fn run_blocking<T, F>(task: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        task(&database_path)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Model registry task failed: {error}")))?
}

fn parse_kind(kind: &str) -> Result<RegisteredModelKind> {
    RegisteredModelKind::parse(kind).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Unknown model kind \"{kind}\"; expected embedding, reranking or decision"),
        )
    })
}

#[napi]
pub async fn list_embedding_models() -> Result<Vec<EmbeddingModelEntry>> {
    run_blocking(|path| model_registry::list_embedding_models(path)).await
}

#[napi]
pub async fn upsert_embedding_model(model: EmbeddingModelEntry) -> Result<EmbeddingModelEntry> {
    run_blocking(move |path| model_registry::upsert_embedding_model(path, model)).await
}

#[napi]
pub async fn list_reranking_models() -> Result<Vec<RerankingModelEntry>> {
    run_blocking(|path| model_registry::list_reranking_models(path)).await
}

#[napi]
pub async fn upsert_reranking_model(model: RerankingModelEntry) -> Result<RerankingModelEntry> {
    run_blocking(move |path| model_registry::upsert_reranking_model(path, model)).await
}

#[napi]
pub async fn list_decision_models() -> Result<Vec<DecisionModelEntry>> {
    run_blocking(|path| model_registry::list_decision_models(path)).await
}

#[napi]
pub async fn upsert_decision_model(model: DecisionModelEntry) -> Result<DecisionModelEntry> {
    run_blocking(move |path| model_registry::upsert_decision_model(path, model)).await
}

/// 删除模型（kind = embedding | reranking | decision），同时清空引用它的设置。
#[napi]
pub async fn delete_registered_model(kind: String, model_id: String) -> Result<ModelDeleteResult> {
    let kind = parse_kind(&kind)?;
    run_blocking(move |path| model_registry::delete_model(path, kind, &model_id)).await
}

#[napi]
pub async fn set_registered_model_enabled(
    kind: String,
    model_id: String,
    enabled: bool,
) -> Result<()> {
    let kind = parse_kind(&kind)?;
    run_blocking(move |path| model_registry::set_model_enabled(path, kind, &model_id, enabled))
        .await
}
