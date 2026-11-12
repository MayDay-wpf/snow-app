//! 决策 / 嵌入 / 重排模型连接自检的 NAPI 导出（实现见 `api/model_health.rs`）。
//!
//! 配置页传入当前表单里的值（可以尚未保存），自检结果会持久化，重启后仍可查看。

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::api::embedding::EmbeddingConfig;
use crate::api::model_health::{self, ModelConnectionTestResult, ModelHealthSnapshot};
use crate::api::reranking::RerankingConfig;

/// 待检测的决策模型（字段与 `decision_models` 表的条目一致）。
#[napi(object)]
pub struct DecisionModelTestInput {
    pub id: String,
    pub base_url: String,
    pub base_url_mode: String,
    pub provider: String,
    pub api_key: String,
    pub model: String,
}

/// 待检测的嵌入模型配置（字段与嵌入模型条目一致）。
#[napi(object)]
pub struct EmbeddingTestInput {
    /// 嵌入模型条目 id，检测结果按它归档。
    pub id: String,
    pub embedding_type: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    /// 0 表示不指定维度。
    pub dimensions: i32,
}

/// 待检测的重排模型配置（字段与重排模型条目一致）。
#[napi(object)]
pub struct RerankingTestInput {
    /// 重排模型条目 id，检测结果按它归档。
    pub id: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
}

#[napi]
pub async fn test_decision_model_connection(
    input: DecisionModelTestInput,
) -> Result<ModelConnectionTestResult> {
    model_health::test_decision_model(
        &input.id,
        &input.base_url,
        &input.base_url_mode,
        &input.provider,
        &input.api_key,
        &input.model,
    )
    .await
}

#[napi]
pub async fn test_embedding_connection(
    input: EmbeddingTestInput,
) -> Result<ModelConnectionTestResult> {
    model_health::test_embedding(
        input.id.trim(),
        EmbeddingConfig::from_settings(
            input.embedding_type.trim(),
            input.model_name.trim(),
            input.base_url.trim(),
            input.api_key.trim(),
            input.dimensions,
        ),
    )
    .await
}

#[napi]
pub async fn test_reranking_connection(
    input: RerankingTestInput,
) -> Result<ModelConnectionTestResult> {
    model_health::test_reranking(
        input.id.trim(),
        RerankingConfig::from_settings(
            input.model_name.trim(),
            input.base_url.trim(),
            input.api_key.trim(),
            0,
            0,
        ),
    )
    .await
}

/// 三类模型最近一次连接自检的结果。
#[napi]
pub async fn get_model_health_snapshot() -> Result<ModelHealthSnapshot> {
    model_health::load_snapshot().await
}
