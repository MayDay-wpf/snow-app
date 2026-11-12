//! 决策 / 嵌入 / 重排模型的可观测性：共享请求发送、失败日志、连接自检与检测结果持久化。
//!
//! - [`post_json`]：三类模型共用的 JSON POST 发送路径，失败时带上 HTTP 状态，
//!   让运行时调用与「测试连接」拿到同样的诊断信息。
//! - [`observe_call`]：计时并把失败写入系统日志（module = `decision_model` /
//!   `embedding` / `reranking`，含 endpoint / status / duration / error），在
//!   「设置 → 系统日志」里可以按模块检索。
//! - `test_*`：连接自检。结果写入对应模型表的 health_* 列，配置页在重启应用后
//!   仍能看到最近一次检测；删除模型时随行清理。
//!
//! 全部异步执行，SQLite 读写放在 `spawn_blocking` 中，不阻塞 Node.js 主线程。

use std::future::Future;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use reqwest::header::HeaderMap;
use serde_json::{json, Value};

use crate::api::common::truncate_chars;
use crate::api::embedding::EmbeddingConfig;
use crate::api::reranking::RerankingConfig;
use crate::storage::services::app_logs::{insert_app_log, redact_request_endpoint, AppLogInput};
use crate::storage::services::model_registry::{self, RegisteredModelKind};

pub use crate::storage::services::model_registry::ModelConnectionTestResult;

/// 系统日志里「测试连接」调用的 func 名称。
pub const CONNECTION_TEST_FUNC: &str = "connection_test";

/// 错误响应体写入错误信息时保留的最大字符数。
const MAX_ERROR_BODY_CHARS: usize = 500;

/// 需要可观测性的模型类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    Decision,
    Embedding,
    Reranking,
}

impl ModelKind {
    fn registry_kind(self) -> RegisteredModelKind {
        match self {
            ModelKind::Decision => RegisteredModelKind::Decision,
            ModelKind::Embedding => RegisteredModelKind::Embedding,
            ModelKind::Reranking => RegisteredModelKind::Reranking,
        }
    }

    /// 系统日志的 module，供「设置 → 系统日志」按模块检索。
    fn log_module(self) -> &'static str {
        match self {
            ModelKind::Decision => "decision_model",
            ModelKind::Embedding => "embedding",
            ModelKind::Reranking => "reranking",
        }
    }

    /// 请求日志（request logging）的 provider 标签。
    fn request_tag(self) -> &'static str {
        match self {
            ModelKind::Decision => "decision_model",
            ModelKind::Embedding => "embedding",
            ModelKind::Reranking => "reranking",
        }
    }

    /// 错误信息里的接口名称。
    fn api_label(self) -> &'static str {
        match self {
            ModelKind::Decision => "Decision model API",
            ModelKind::Embedding => "Embedding API",
            ModelKind::Reranking => "Reranking API",
        }
    }
}

/// 一次模型请求失败的结构化信息。
#[derive(Debug, Clone)]
pub struct ModelRequestError {
    /// 服务端返回的 HTTP 状态（连接失败、配置不完整等没有响应时为空）。
    pub http_status: Option<u16>,
    pub message: String,
}

impl ModelRequestError {
    pub fn new(http_status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            http_status,
            message: message.into(),
        }
    }
}

/// [`observe_call`] 的结果：调用结果 + HTTP 状态 + 耗时。
pub struct ModelCallReport<T> {
    pub result: std::result::Result<T, ModelRequestError>,
    pub http_status: Option<u16>,
    pub latency_ms: u64,
}

impl<T> ModelCallReport<T> {
    /// 运行时调用方只关心结果：失败转成 napi 错误（失败日志已由 [`observe_call`] 写入）。
    pub fn into_result(self) -> Result<T> {
        self.result
            .map_err(|error| Error::from_reason(error.message))
    }
}

/// 发送一次模型 JSON 请求，成功（2xx）时返回 `(HTTP 状态, 响应体)`。
///
/// 传输失败、读取失败与非 2xx 状态都转成 [`ModelRequestError`]，并尽量带上 HTTP 状态。
/// 开启请求日志时，请求体按原有规则写入系统日志。
pub async fn post_json(
    kind: ModelKind,
    endpoint: &str,
    headers: HeaderMap,
    body: &Value,
    timeout: Duration,
) -> std::result::Result<(u16, String), ModelRequestError> {
    log_request_payload(kind, endpoint, body).await;

    let label = kind.api_label();
    let client = crate::api::http_client::build_proxied_client_with_timeout(timeout)
        .await
        .map_err(|error| ModelRequestError::new(None, error.reason.clone()))?;

    let response = client
        .post(endpoint)
        .headers(headers)
        .json(body)
        .send()
        .await
        .map_err(|error| ModelRequestError::new(None, format!("{label} request failed: {error}")))?;

    let status = response.status();
    let code = status.as_u16();
    let text = response.text().await.map_err(|error| {
        ModelRequestError::new(Some(code), format!("Failed to read {label} response: {error}"))
    })?;

    if !status.is_success() {
        return Err(ModelRequestError::new(
            Some(code),
            format!(
                "{label} returned status {status}: {}",
                truncate_chars(&text, MAX_ERROR_BODY_CHARS)
            ),
        ));
    }

    Ok((code, text))
}

/// 请求日志开启时记录请求体。数据库路径首次解析会触碰文件系统，放到阻塞线程执行。
async fn log_request_payload(kind: ModelKind, endpoint: &str, body: &Value) {
    let Ok(Ok(database_path)) =
        tokio::task::spawn_blocking(crate::storage::ensure_database_file).await
    else {
        return;
    };

    crate::storage::services::app_logs::maybe_log_api_request(
        database_path,
        kind.request_tag().to_string(),
        endpoint.to_string(),
        serde_json::to_string(body).unwrap_or_default(),
    )
    .await;
}

/// 执行一次模型调用并计时；失败时写入系统日志。
///
/// `call` 成功时返回 `(值, HTTP 状态)`。运行时调用（索引、检索、审查、敏感命令判定）
/// 与「测试连接」都经过这里，所以三类模型的失败都能在系统日志里按模块检索到。
pub async fn observe_call<T, F>(
    kind: ModelKind,
    func: &str,
    endpoint: &str,
    model: &str,
    call: F,
) -> ModelCallReport<T>
where
    F: Future<Output = std::result::Result<(T, u16), ModelRequestError>>,
{
    let started = Instant::now();
    let outcome = call.await;
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    match outcome {
        Ok((value, status)) => ModelCallReport {
            result: Ok(value),
            http_status: Some(status),
            latency_ms,
        },
        Err(error) => {
            log_model_failure(kind, func, endpoint, model, &error, latency_ms).await;
            ModelCallReport {
                http_status: error.http_status,
                result: Err(error),
                latency_ms,
            }
        }
    }
}

/// 把一次模型失败写入系统日志（best effort，写入失败直接忽略）。
async fn log_model_failure(
    kind: ModelKind,
    func: &str,
    endpoint: &str,
    model: &str,
    error: &ModelRequestError,
    latency_ms: u64,
) {
    // task-local 的 ephemeral 状态不会传进阻塞线程，必须在这里判定。
    if crate::api::ephemeral::is_active() {
        return;
    }

    let input = AppLogInput {
        level: "ERROR".to_string(),
        module: kind.log_module().to_string(),
        func: func.to_string(),
        line: None,
        message: format!("{} call failed", kind.api_label()),
        input: None,
        output: None,
        duration: Some(format!("{latency_ms}ms")),
        context: Some(
            json!({
                "endpoint": redact_request_endpoint(endpoint),
                "model": model,
                "httpStatus": error.http_status,
            })
            .to_string(),
        ),
        error: Some(error.message.clone()),
        source: "main".to_string(),
    };

    tokio::task::spawn_blocking(move || {
        if let Ok(database_path) = crate::storage::ensure_database_file() {
            let _ = insert_app_log(&database_path, &input);
        }
    })
    .await
    .ok();
}

/// 三类模型最近一次连接自检的结果。
#[napi(object)]
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelHealthSnapshot {
    /// 按决策模型 id（`targetId`）区分的检测结果。
    pub decision: Vec<ModelConnectionTestResult>,
    /// 按嵌入模型 id 区分。
    pub embedding_models: Vec<ModelConnectionTestResult>,
    /// 按重排模型 id 区分。
    pub reranking_models: Vec<ModelConnectionTestResult>,
}

/// 测试决策模型连接：按 provider 发送一条最小请求。
///
/// 配置不完整（缺少 API Key / 模型名 / 自定义地址）时不发请求，直接记为失败。
pub async fn test_decision_model(
    target_id: &str,
    base_url: &str,
    base_url_mode: &str,
    provider: &str,
    api_key: &str,
    model: &str,
) -> Result<ModelConnectionTestResult> {
    let provider = crate::api::decision_model::DecisionProvider::from_str(provider);
    let endpoint = crate::api::decision_model::resolve_endpoint(base_url, base_url_mode, provider);
    let model = model.trim();

    let report = match crate::api::decision_model::DecisionModelConfig::new(
        base_url,
        base_url_mode,
        api_key,
        model,
        provider,
    ) {
        Ok(config) => crate::api::decision_model::test_connection(&config).await,
        Err(reason) => reject_config(ModelKind::Decision, &endpoint, model, reason).await,
    };

    let result = test_result_from_report(target_id, &endpoint, model, &report);
    record_test_result(ModelKind::Decision, result.clone()).await?;
    Ok(result)
}

/// 测试嵌入模型连接：发送一条 input，并校验返回维度与配置维度一致。
pub async fn test_embedding(
    target_id: &str,
    config: EmbeddingConfig,
) -> Result<ModelConnectionTestResult> {
    let endpoint = crate::api::embedding::resolve_embedding_endpoint(&config);
    let model = crate::api::embedding::resolve_default_model(&config);
    let report = crate::api::embedding::test_connection(&config, &endpoint, &model).await;

    let mut result = test_result_from_report(target_id, &endpoint, &model, &report);
    if let Ok(dimension) = &report.result {
        let dimension = *dimension;
        result.dimension = u32::try_from(dimension).ok();

        if config.dimensions > 0 {
            result.expected_dimension = u32::try_from(config.dimensions).ok();
            if dimension != config.dimensions {
                let error = ModelRequestError::new(
                    report.http_status,
                    format!(
                        "Embedding dimension mismatch: configured {}, returned {dimension}",
                        config.dimensions
                    ),
                );
                log_model_failure(
                    ModelKind::Embedding,
                    CONNECTION_TEST_FUNC,
                    &endpoint,
                    &model,
                    &error,
                    report.latency_ms,
                )
                .await;
                result.ok = false;
                result.error = Some(error.message);
            }
        }
    }

    record_test_result(ModelKind::Embedding, result.clone()).await?;
    Ok(result)
}

/// 测试重排模型连接：发送一条 query + 一条 document，并校验返回了 results。
pub async fn test_reranking(
    target_id: &str,
    config: RerankingConfig,
) -> Result<ModelConnectionTestResult> {
    let endpoint = crate::api::reranking::resolve_rerank_endpoint(&config.base_url);
    let report = crate::api::reranking::test_connection(&config, &endpoint).await;

    let result = test_result_from_report(target_id, &endpoint, &config.model_name, &report);
    record_test_result(ModelKind::Reranking, result.clone()).await?;
    Ok(result)
}

/// 读取三类模型最近一次的检测结果（模型表的 health_* 列）。
pub async fn load_snapshot() -> Result<ModelHealthSnapshot> {
    tokio::task::spawn_blocking(|| {
        let database_path = crate::storage::ensure_database_file()?;
        let (decision, embedding_models, reranking_models) =
            model_registry::load_model_health(&database_path)?;
        Ok(ModelHealthSnapshot {
            decision,
            embedding_models,
            reranking_models,
        })
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load model health: {error}")))?
}

/// 配置不完整：不发请求，直接生成一条失败报告并写日志。
async fn reject_config<T>(
    kind: ModelKind,
    endpoint: &str,
    model: &str,
    reason: String,
) -> ModelCallReport<T> {
    let error = ModelRequestError::new(None, reason);
    log_model_failure(kind, CONNECTION_TEST_FUNC, endpoint, model, &error, 0).await;
    ModelCallReport {
        result: Err(error),
        http_status: None,
        latency_ms: 0,
    }
}

fn test_result_from_report<T>(
    target_id: &str,
    endpoint: &str,
    model: &str,
    report: &ModelCallReport<T>,
) -> ModelConnectionTestResult {
    ModelConnectionTestResult {
        target_id: target_id.to_string(),
        ok: report.result.is_ok(),
        http_status: report.http_status.map(u32::from),
        latency_ms: report.latency_ms as f64,
        endpoint: redact_request_endpoint(endpoint),
        model: model.to_string(),
        dimension: None,
        expected_dimension: None,
        error: report.result.as_ref().err().map(|error| error.message.clone()),
        tested_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as f64)
            .unwrap_or(0.0),
    }
}

/// 写入模型表；未保存的草稿没有对应行，结果只返回给调用方。
async fn record_test_result(kind: ModelKind, result: ModelConnectionTestResult) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        model_registry::record_model_health(&database_path, kind.registry_kind(), &result)
            .map(|_| ())
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to save model health: {error}")))?
}
