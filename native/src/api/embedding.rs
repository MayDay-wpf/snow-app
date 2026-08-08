use std::time::Duration;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Value};

use crate::api::config::{normalize_base_url, DEFAULT_GEMINI_BASE_URL, DEFAULT_OPENAI_BASE_URL};

const DEFAULT_JINA_BASE_URL: &str = "https://api.jina.ai/v1";
const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";

/// Configuration for the embedding API, derived from the codebase settings.
#[derive(Debug, Clone)]
pub struct EmbeddingConfig {
    pub embedding_type: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    pub dimensions: usize,
}

impl EmbeddingConfig {
    pub fn from_settings(
        embedding_type: &str,
        model_name: &str,
        base_url: &str,
        api_key: &str,
        dimensions: i32,
    ) -> Self {
        Self {
            embedding_type: embedding_type.to_string(),
            model_name: model_name.to_string(),
            base_url: normalize_base_url(base_url),
            api_key: api_key.to_string(),
            dimensions: if dimensions > 0 {
                dimensions as usize
            } else {
                1536
            },
        }
    }
}

/// Embed a batch of text inputs and return their vector representations.
///
/// This function is fully async and uses `reqwest`'s async client, so it
/// never blocks the Node.js main thread. It supports multiple embedding types:
///
/// - `openai`/`jina`: Standard OpenAI-compatible `/v1/embeddings` endpoint.
///   Supports batch requests (multiple inputs per API call).
/// - `ollama`: Ollama embedding API. Auto-detects between native `/api/embed`
///   and OpenAI-compatible `/v1/embeddings` based on the base URL.
/// - `gemini`: Google Gemini `:batchEmbedContents` endpoint. Uses
///   `x-goog-api-key` header and a distinct request/response format.
/// - `mistral`: Mistral embedding API. OpenAI-compatible but uses
///   `output_dimension` instead of `dimensions` in the request body.
pub async fn embed_batch(config: &EmbeddingConfig, inputs: &[String]) -> Result<Vec<Vec<f64>>> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }

    let client =
        crate::api::http_client::build_proxied_client_with_timeout(Duration::from_secs(120))
            .await?;

    let endpoint = resolve_embedding_endpoint(config);
    let headers = build_headers(config);
    let body = build_request_body(config, inputs);

    if let Ok(database_path) = crate::storage::ensure_database_file() {
        let request_json = serde_json::to_string(&body).unwrap_or_default();
        crate::storage::services::app_logs::maybe_log_api_request(
            database_path,
            "embedding".to_string(),
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
        .map_err(|error| Error::from_reason(format!("Embedding API request failed: {error}")))?;

    let status = response.status();
    let response_text = response.text().await.map_err(|error| {
        Error::from_reason(format!("Failed to read embedding response: {error}"))
    })?;

    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Embedding API returned status {}: {}",
            status,
            truncate_error(&response_text, 500)
        )));
    }

    parse_embedding_response(&response_text, inputs.len(), &config.embedding_type)
}

/// Resolve the default model name for the given embedding type when the user
/// has not explicitly configured one.
fn resolve_default_model(config: &EmbeddingConfig) -> String {
    if !config.model_name.is_empty() {
        return config.model_name.clone();
    }
    match config.embedding_type.as_str() {
        "jina" => "jina-embeddings-v3".to_string(),
        "gemini" => "text-embedding-004".to_string(),
        "ollama" => "nomic-embed-text".to_string(),
        "mistral" => "mistral-embed".to_string(),
        _ => "text-embedding-3-small".to_string(),
    }
}

/// Resolve the full embedding API endpoint URL based on embedding type.
fn resolve_embedding_endpoint(config: &EmbeddingConfig) -> String {
    let normalized = normalize_base_url(&config.base_url);

    match config.embedding_type.as_str() {
        "gemini" => resolve_gemini_endpoint(&normalized, &resolve_default_model(config)),
        "ollama" => resolve_ollama_endpoint(&normalized),
        _ => resolve_openai_compatible_endpoint(&normalized, &config.embedding_type),
    }
}

/// Gemini endpoint: `{base}/models/{model}:batchEmbedContents`
///
/// Uses the batch embed endpoint to support multiple inputs in a single API
/// call, which is more efficient than calling `:embedContent` repeatedly.
fn resolve_gemini_endpoint(base_url: &str, model: &str) -> String {
    let base = if base_url.is_empty() {
        DEFAULT_GEMINI_BASE_URL
    } else {
        base_url
    };
    let clean_model = model.strip_prefix("models/").unwrap_or(model);
    format!("{base}/models/{clean_model}:batchEmbedContents")
}

/// Ollama endpoint: auto-detect `/api/embed` (native) or `/v1/embeddings`
/// (OpenAI-compatible) from the base URL suffix.
///
/// Detection rules (mirrors snow-cli `resolveOllamaEmbeddingsEndpoint`):
/// - `/v1/embeddings` or `/embeddings` -> use as-is (OpenAI mode)
/// - `/api/embed` or `/embed` -> use as-is (native mode)
/// - `/v1` -> append `/embeddings` (OpenAI mode)
/// - `/api` -> append `/embed` (native mode)
/// - otherwise -> default to `/v1/embeddings` for interoperability
fn resolve_ollama_endpoint(base_url: &str) -> String {
    if base_url.is_empty() {
        return format!("{DEFAULT_OLLAMA_BASE_URL}/v1/embeddings");
    }

    if base_url.ends_with("/v1/embeddings") || base_url.ends_with("/embeddings") {
        return base_url.to_string();
    }

    if base_url.ends_with("/api/embed") || base_url.ends_with("/embed") {
        return base_url.to_string();
    }

    if base_url.ends_with("/v1") {
        return format!("{base_url}/embeddings");
    }

    if base_url.ends_with("/api") {
        return format!("{base_url}/embed");
    }

    // Default to OpenAI-compatible endpoint for better interoperability.
    format!("{base_url}/v1/embeddings")
}

/// OpenAI-compatible endpoint for `jina`, `mistral`, `openai`, and any other
/// provider that follows the standard `/v1/embeddings` convention.
fn resolve_openai_compatible_endpoint(base_url: &str, embedding_type: &str) -> String {
    if base_url.is_empty() {
        return match embedding_type {
            "jina" => format!("{DEFAULT_JINA_BASE_URL}/embeddings"),
            _ => format!("{DEFAULT_OPENAI_BASE_URL}/embeddings"),
        };
    }

    if base_url.ends_with("/v1/embeddings") || base_url.ends_with("/embeddings") {
        return base_url.to_string();
    }

    if base_url.ends_with("/v1") {
        return format!("{base_url}/embeddings");
    }

    format!("{base_url}/v1/embeddings")
}

/// Build HTTP headers based on embedding type.
///
/// - `gemini`: uses `x-goog-api-key` header for authentication
/// - all others: use standard `Authorization: Bearer {key}` header
fn build_headers(config: &EmbeddingConfig) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert("Accept", HeaderValue::from_static("application/json"));

    if config.api_key.is_empty() {
        return headers;
    }

    if config.embedding_type == "gemini" {
        // Gemini uses x-goog-api-key header instead of Authorization
        if let Ok(value) = HeaderValue::from_str(&config.api_key) {
            headers.insert("x-goog-api-key", value);
        }
    } else {
        // Jina, Ollama, Mistral, OpenAI all use Bearer token
        let auth_value = HeaderValue::from_str(&format!("Bearer {}", config.api_key));
        if let Ok(value) = auth_value {
            headers.insert("Authorization", value);
        }
    }

    headers
}

/// Build the request body based on embedding type.
fn build_request_body(config: &EmbeddingConfig, inputs: &[String]) -> Value {
    let model = resolve_default_model(config);

    match config.embedding_type.as_str() {
        "gemini" => build_gemini_request_body(&model, inputs, config.dimensions),
        "mistral" => build_mistral_request_body(&model, inputs, config.dimensions),
        _ => build_openai_request_body(&model, inputs, config.dimensions),
    }
}

/// Gemini request body format:
/// ```json
/// {
///   "requests": [
///     {
///       "model": "models/{model}",
///       "content": {"parts": [{"text": "..."}]},
///       "outputDimensionality": 768
///     }
///   ]
/// }
/// ```
fn build_gemini_request_body(model: &str, inputs: &[String], dimensions: usize) -> Value {
    let clean_model = model.strip_prefix("models/").unwrap_or(model);
    let full_model = format!("models/{clean_model}");

    let requests: Vec<Value> = inputs
        .iter()
        .map(|text| {
            let mut request = json!({
                "model": full_model,
                "content": {
                    "parts": [{"text": text}]
                }
            });
            if dimensions > 0 {
                request["outputDimensionality"] = json!(dimensions);
            }
            request
        })
        .collect();

    json!({ "requests": requests })
}

/// Mistral request body format (uses `output_dimension` instead of `dimensions`):
/// ```json
/// {
///   "model": "...",
///   "input": ["..."],
///   "output_dimension": 1024
/// }
/// ```
fn build_mistral_request_body(model: &str, inputs: &[String], dimensions: usize) -> Value {
    let mut body = json!({
        "model": model,
        "input": inputs,
    });
    if dimensions > 0 {
        body["output_dimension"] = json!(dimensions);
    }
    body
}

/// Standard OpenAI-compatible request body (jina, ollama, openai):
/// ```json
/// {
///   "model": "...",
///   "input": ["..."],
///   "dimensions": 1536
/// }
/// ```
fn build_openai_request_body(model: &str, inputs: &[String], dimensions: usize) -> Value {
    let mut body = json!({
        "model": model,
        "input": inputs,
    });
    if dimensions > 0 {
        body["dimensions"] = json!(dimensions);
    }
    body
}

/// Parse the embedding response based on embedding type.
fn parse_embedding_response(
    response_text: &str,
    expected_count: usize,
    embedding_type: &str,
) -> Result<Vec<Vec<f64>>> {
    let response_text = response_text
        .strip_prefix('\u{feff}')
        .unwrap_or(response_text);

    let parsed: Value = serde_json::from_str(response_text).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse embedding response as JSON: {error}"
        ))
    })?;

    match embedding_type {
        "gemini" => parse_gemini_response(&parsed, expected_count),
        "ollama" => parse_ollama_response(&parsed, expected_count),
        _ => parse_openai_response(&parsed, expected_count),
    }
}

/// Parse OpenAI-compatible response:
/// ```json
/// {
///   "data": [
///     {"embedding": [0.1, 0.2, ...], "index": 0},
///     {"embedding": [0.3, 0.4, ...], "index": 1}
///   ]
/// }
/// ```
fn parse_openai_response(parsed: &Value, expected_count: usize) -> Result<Vec<Vec<f64>>> {
    let data = parsed
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::from_reason("Embedding response missing 'data' array"))?;

    if data.len() != expected_count {
        return Err(Error::from_reason(format!(
            "Embedding response count mismatch: expected {expected_count}, got {}",
            data.len()
        )));
    }

    // Sort by index to ensure correct ordering
    let mut indexed_embeddings: Vec<(usize, Vec<f64>)> = Vec::with_capacity(data.len());
    for item in data {
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .map(|i| i as usize)
            .unwrap_or_else(|| indexed_embeddings.len());

        let embedding = item
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::from_reason("Embedding response item missing 'embedding' array"))?
            .iter()
            .map(|v| {
                v.as_f64().ok_or_else(|| {
                    Error::from_reason("Embedding vector contains non-numeric value")
                })
            })
            .collect::<Result<Vec<f64>>>()?;

        indexed_embeddings.push((index, embedding));
    }

    indexed_embeddings.sort_by_key(|(index, _)| *index);
    Ok(indexed_embeddings.into_iter().map(|(_, emb)| emb).collect())
}

/// Parse Ollama response. Handles both native and OpenAI-compatible formats:
///
/// Native (`/api/embed`):
/// ```json
/// {"model": "...", "embeddings": [[0.1, 0.2, ...], ...]}
/// ```
///
/// OpenAI-compatible (`/v1/embeddings`): falls through to `parse_openai_response`.
fn parse_ollama_response(parsed: &Value, expected_count: usize) -> Result<Vec<Vec<f64>>> {
    // Some Ollama deployments return OpenAI-compatible format from /v1/embeddings.
    if parsed.get("data").and_then(Value::as_array).is_some() {
        return parse_openai_response(parsed, expected_count);
    }

    // Ollama native response format from /api/embed.
    let embeddings = parsed
        .get("embeddings")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            Error::from_reason(
                "Ollama embedding response missing 'embeddings' array. \
                 Try setting baseUrl to http://localhost:11434 \
                 (or /v1 for OpenAI-compatible mode).",
            )
        })?;

    if embeddings.len() != expected_count {
        return Err(Error::from_reason(format!(
            "Ollama embedding response count mismatch: expected {expected_count}, got {}",
            embeddings.len()
        )));
    }

    embeddings
        .iter()
        .map(|emb| {
            emb.as_array()
                .ok_or_else(|| Error::from_reason("Ollama embedding vector is not an array"))?
                .iter()
                .map(|v| {
                    v.as_f64().ok_or_else(|| {
                        Error::from_reason("Embedding vector contains non-numeric value")
                    })
                })
                .collect::<Result<Vec<f64>>>()
        })
        .collect()
}

/// Parse Gemini response:
/// ```json
/// {
///   "embeddings": [
///     {"values": [0.1, 0.2, ...]},
///     {"values": [0.3, 0.4, ...]}
///   ]
/// }
/// ```
fn parse_gemini_response(parsed: &Value, expected_count: usize) -> Result<Vec<Vec<f64>>> {
    let embeddings = parsed
        .get("embeddings")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            Error::from_reason("Gemini embedding response missing 'embeddings' array")
        })?;

    if embeddings.len() != expected_count {
        return Err(Error::from_reason(format!(
            "Gemini embedding response count mismatch: expected {expected_count}, got {}",
            embeddings.len()
        )));
    }

    embeddings
        .iter()
        .map(|emb| {
            emb.get("values")
                .and_then(Value::as_array)
                .ok_or_else(|| Error::from_reason("Gemini embedding item missing 'values' array"))?
                .iter()
                .map(|v| {
                    v.as_f64().ok_or_else(|| {
                        Error::from_reason("Embedding vector contains non-numeric value")
                    })
                })
                .collect::<Result<Vec<f64>>>()
        })
        .collect()
}

fn truncate_error(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}...", &text[..max_len])
    }
}

/// Serialize a vector to JSON string for storage.
pub fn vector_to_json(vector: &[f64]) -> String {
    serde_json::to_string(vector).unwrap_or_else(|_| "[]".to_string())
}
