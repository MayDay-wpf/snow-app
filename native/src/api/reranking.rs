//! Reranking API: reorders codebase search results by relevance to the query.
//!
//! Supports OpenAI-compatible rerank endpoints (e.g. Jina AI). The API
//! receives a query and a list of documents, and returns a relevance score
//! for each document. Results are then sorted by the returned score.
//!
//! This module is fully async and never blocks the Node.js main thread.

use std::time::Duration;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Value};

use crate::api::config::normalize_base_url;

/// Configuration for the reranking API, derived from codebase settings.
#[derive(Debug, Clone)]
pub struct RerankingConfig {
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    pub context_length: usize,
    pub top_n: usize,
}

impl RerankingConfig {
    pub fn from_settings(
        model_name: &str,
        base_url: &str,
        api_key: &str,
        context_length: i32,
        top_n: i32,
    ) -> Self {
        Self {
            model_name: model_name.to_string(),
            base_url: normalize_base_url(base_url),
            api_key: api_key.to_string(),
            context_length: if context_length > 0 {
                context_length as usize
            } else {
                4096
            },
            top_n: if top_n > 0 { top_n as usize } else { 5 },
        }
    }

    /// Returns true if the reranking config has enough information to make
    /// an API call (model name and base URL are both set).
    pub fn is_configured(&self) -> bool {
        !self.model_name.is_empty() && !self.base_url.is_empty()
    }
}

/// A single document to rerank, paired with its original index so callers
/// can map results back to their source data.
#[derive(Debug, Clone)]
pub struct RerankDocument {
    /// Original index in the input list.
    pub index: usize,
    /// The text content to evaluate.
    pub text: String,
}

/// A reranked result: the original index plus the new relevance score.
#[derive(Debug, Clone)]
pub struct RerankResult {
    /// Original index in the input list.
    pub index: usize,
    /// Relevance score from the reranking model (higher = more relevant).
    pub score: f64,
}

/// Rerank documents by relevance to the query.
///
/// Sends a request to the reranking API with the query and all documents,
/// then returns the results sorted by descending relevance score. The
/// returned Vec contains the original indices in relevance order.
///
/// If the API call fails or the response can't be parsed, an error is
/// returned — the caller should fall back to the original ordering.
pub async fn rerank(
    config: &RerankingConfig,
    query: &str,
    documents: &[RerankDocument],
) -> Result<Vec<RerankResult>> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }

    if !config.is_configured() {
        return Err(Error::from_reason(
            "Reranking model name and base URL are required",
        ));
    }

    let client =
        crate::api::http_client::build_proxied_client_with_timeout(Duration::from_secs(60)).await?;

    let endpoint = resolve_rerank_endpoint(&config.base_url);
    let headers = build_headers(config);
    let body = build_request_body(config, query, documents);

    if let Ok(database_path) = crate::storage::ensure_database_file() {
        let request_json = serde_json::to_string(&body).unwrap_or_default();
        crate::storage::services::app_logs::maybe_log_api_request(
            database_path,
            "reranking".to_string(),
            endpoint.clone(),
            request_json,
        )
        .await;
    }

    let response = client
        .post(&endpoint)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Reranking API request failed: {error}")))?;

    let status = response.status();
    let response_text = response.text().await.map_err(|error| {
        Error::from_reason(format!("Failed to read reranking response: {error}"))
    })?;

    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Reranking API returned status {}: {}",
            status,
            truncate_error(&response_text, 500)
        )));
    }

    parse_rerank_response(&response_text, documents.len())
}

/// Resolve the full reranking API endpoint URL.
///
/// - If the base URL already ends with `/rerank`, use it as-is.
/// - If it ends with `/v1`, append `/rerank`.
/// - Otherwise, append `/v1/rerank`.
fn resolve_rerank_endpoint(base_url: &str) -> String {
    let normalized = normalize_base_url(base_url);

    if normalized.is_empty() {
        return "https://api.jina.ai/v1/rerank".to_string();
    }

    if normalized.ends_with("/rerank") {
        return normalized;
    }

    if normalized.ends_with("/v1") {
        return format!("{normalized}/rerank");
    }

    format!("{normalized}/v1/rerank")
}

fn build_headers(config: &RerankingConfig) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert("Accept", HeaderValue::from_static("application/json"));

    if !config.api_key.is_empty() {
        let auth_value = HeaderValue::from_str(&format!("Bearer {}", config.api_key));
        if let Ok(value) = auth_value {
            headers.insert("Authorization", value);
        }
    }

    headers
}

fn build_request_body(
    config: &RerankingConfig,
    query: &str,
    documents: &[RerankDocument],
) -> Value {
    let doc_texts: Vec<&str> = documents.iter().map(|d| d.text.as_str()).collect();
    json!({
        "model": config.model_name,
        "query": query,
        "documents": doc_texts,
        "top_n": documents.len().min(config.top_n.max(documents.len())),
    })
}

/// Parse the reranking API response.
///
/// Expected format (Jina/Cohere-compatible):
/// ```json
/// {
///   "results": [
///     { "index": 2, "relevance_score": 0.95 },
///     { "index": 0, "relevance_score": 0.82 },
///     ...
///   ]
/// }
/// ```
fn parse_rerank_response(response_text: &str, expected_count: usize) -> Result<Vec<RerankResult>> {
    let response_text = response_text
        .strip_prefix('\u{feff}')
        .unwrap_or(response_text);

    let parsed: Value = serde_json::from_str(response_text).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse reranking response as JSON: {error}"
        ))
    })?;

    let results = parsed
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::from_reason("Reranking response missing 'results' array"))?;

    let mut collected: Vec<RerankResult> = Vec::with_capacity(results.len());
    for item in results {
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .map(|i| i as usize)
            .ok_or_else(|| Error::from_reason("Reranking response item missing 'index' field"))?;

        if index >= expected_count {
            return Err(Error::from_reason(format!(
                "Reranking response index {index} out of bounds (expected < {expected_count})"
            )));
        }

        let score = item
            .get("relevance_score")
            .and_then(Value::as_f64)
            .or_else(|| item.get("score").and_then(Value::as_f64))
            .unwrap_or(0.0);

        collected.push(RerankResult { index, score });
    }

    // Sort by descending score
    collected.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(collected)
}

fn truncate_error(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}...", &text[..max_len])
    }
}
