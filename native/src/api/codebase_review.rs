//! Agent review for codebase search results.
//!
//! Uses the active API config's **basic model** to review vector search
//! results and remove irrelevant chunks. If more than 50% of the results
//! are deemed irrelevant, the model is asked to generate a refined search
//! query and the search is retried (up to 3 attempts total).
//!
//! On the 3rd attempt, all results are returned regardless of how many
//! were deemed irrelevant — this guarantees the caller always gets
//! *something* back.
//!
//! This module is fully async and never blocks the Node.js main thread.
//! It reuses the same non-streaming chat/responses/anthropic/gemini
//! dispatch pattern as `summary.rs`.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE,
};
use serde_json::{json, Value};

use crate::api::config::{
    get_active_api_request_context, normalize_base_url, resolve_sdk_api_base_url,
    DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_GEMINI_BASE_URL, DEFAULT_OPENAI_BASE_URL,
};
use crate::api::retry::{should_retry, RetryOptions};
use crate::storage::services::codebase_index::SearchResult;

const REVIEW_SYSTEM_PROMPT: &str = "You are a code search relevance reviewer. Given a user's search query and a list of code search results, your job is to identify which results are actually relevant to the query and which are irrelevant noise.\n\nYou will receive the query and a numbered list of code snippets. Respond with ONLY a JSON object in this exact format:\n{\"relevant\": [1, 3, 5], \"refined_query\": \"optional better search query\"}\n\nRules:\n- \"relevant\" is an array of 1-based result indices that are genuinely relevant to the query.\n- \"refined_query\" should be a better search query ONLY if many results are irrelevant. If results are mostly relevant, set it to empty string \"\".\n- Do not include any explanation, only the JSON object.";

const MAX_REVIEW_ATTEMPTS: u32 = 3;

/// Threshold: if the fraction of irrelevant results exceeds this value,
/// a refined query is requested and the search is retried.
const IRRELEVANT_FRACTION_THRESHOLD: f64 = 0.5;

/// Result of an agent review pass.
struct ReviewOutcome {
    /// Indices (0-based) of results deemed relevant.
    relevant_indices: Vec<usize>,
    /// A refined query if the model suggested one, empty otherwise.
    refined_query: String,
}

/// Final outcome of the agent review process.
pub struct AgentReviewResult {
    /// The final set of search results after review (irrelevant ones removed).
    pub results: Vec<SearchResult>,
    /// The query that produced the final results (may differ from the
    /// original if a refined query was used).
    pub effective_query: String,
    /// How many review attempts were made (1..=3).
    pub attempts: u32,
}

/// A progress event emitted during the agent review loop.
///
/// Each event describes what the review loop is currently doing, so the
/// UI can show real-time feedback instead of a static "processing..."
/// spinner.
#[derive(Debug, Clone)]
pub struct ReviewProgress {
    /// What phase the review loop is in.
    pub phase: ReviewPhase,
    /// 1-based attempt number (1..=3).
    pub attempt: u32,
    /// The query used for the current attempt.
    pub query: String,
    /// Total number of results being reviewed in the current attempt.
    pub total_count: usize,
    /// Number of results deemed relevant (only set after review completes).
    pub relevant_count: Option<usize>,
    /// The refined query suggested by the model (only set when retrying).
    pub refined_query: Option<String>,
}

/// The phase of the agent review loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewPhase {
    /// The model is currently reviewing the search results.
    Reviewing,
    /// The model suggested a refined query and we are re-searching.
    ReSearching,
    /// The review loop has completed (either results accepted or max
    /// attempts reached).
    Completed,
}

impl ReviewPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReviewPhase::Reviewing => "reviewing",
            ReviewPhase::ReSearching => "re_searching",
            ReviewPhase::Completed => "completed",
        }
    }
}

/// Run the agent review loop on a set of search results.
///
/// `initial_results` are the results from the first vector search.
/// `re_search_fn` is a closure that takes a query string and returns a
/// new set of search results — this is called when the model suggests a
/// refined query.
/// `on_progress` is called at each step of the review loop so the caller
/// can report progress to the UI.
///
/// Behavior:
/// 1. Send results to the basic model for review.
/// 2. If >50% are irrelevant AND we haven't hit MAX_REVIEW_ATTEMPTS,
///    use the refined query to re-search and review again.
/// 3. On the final attempt, return all results regardless of relevance.
pub async fn run_agent_review<F, Fut, P>(
    initial_query: String,
    initial_results: Vec<SearchResult>,
    re_search_fn: F,
    on_progress: P,
) -> Result<AgentReviewResult>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<SearchResult>>>,
    P: Fn(ReviewProgress),
{
    let mut current_query = initial_query.clone();
    let mut current_results = initial_results;
    let mut attempts = 0u32;

    loop {
        attempts += 1;

        if current_results.is_empty() {
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: 0,
                relevant_count: Some(0),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: current_results,
                effective_query: current_query,
                attempts,
            });
        }

        // On the final attempt, skip review and return everything.
        if attempts >= MAX_REVIEW_ATTEMPTS {
            let total = current_results.len();
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: total,
                relevant_count: Some(total),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: current_results,
                effective_query: current_query,
                attempts,
            });
        }

        // Notify: starting review for this attempt.
        on_progress(ReviewProgress {
            phase: ReviewPhase::Reviewing,
            attempt: attempts,
            query: current_query.clone(),
            total_count: current_results.len(),
            relevant_count: None,
            refined_query: None,
        });

        let outcome = review_results(&current_query, &current_results).await?;

        let total = current_results.len();
        let relevant_count = outcome.relevant_indices.len();
        let irrelevant_count = total.saturating_sub(relevant_count);
        let irrelevant_fraction = irrelevant_count as f64 / total as f64;

        // Filter to relevant results.
        let filtered: Vec<SearchResult> = outcome
            .relevant_indices
            .iter()
            .filter_map(|&i| current_results.get(i).cloned())
            .collect();

        // If irrelevant fraction is within threshold, return filtered results.
        if irrelevant_fraction <= IRRELEVANT_FRACTION_THRESHOLD {
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: total,
                relevant_count: Some(relevant_count),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: filtered,
                effective_query: current_query,
                attempts,
            });
        }

        // Too many irrelevant results — try a refined query if one was suggested.
        let refined = outcome.refined_query.trim().to_string();
        if refined.is_empty() || refined == current_query {
            // No refinement suggested — return filtered results.
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: total,
                relevant_count: Some(relevant_count),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: filtered,
                effective_query: current_query,
                attempts,
            });
        }

        // Notify: re-searching with the refined query.
        on_progress(ReviewProgress {
            phase: ReviewPhase::ReSearching,
            attempt: attempts,
            query: current_query.clone(),
            total_count: total,
            relevant_count: Some(relevant_count),
            refined_query: Some(refined.clone()),
        });

        // Re-search with the refined query.
        current_query = refined;
        current_results = re_search_fn(current_query.clone()).await?;
    }
}

/// Send the current results to the basic model for relevance review.
async fn review_results(query: &str, results: &[SearchResult]) -> Result<ReviewOutcome> {
    let context = get_active_api_request_context()?;
    let api_config = context.api_config;
    let custom_headers = context.custom_headers;

    let model = api_config.basic_model.trim();
    if model.is_empty() {
        return Err(Error::from_reason(
            "Basic model not configured. Please configure a basic model in API settings.",
        ));
    }

    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let retry_options =
        RetryOptions::from_config(api_config.max_retries, api_config.retry_base_delay_ms);

    let review_text = match api_config.request_method.as_str() {
        "responses" => {
            review_via_responses(
                &api_config,
                &api_key,
                &custom_headers,
                model,
                query,
                results,
                &retry_options,
            )
            .await?
        }
        "anthropic" => {
            review_via_anthropic(
                &api_config,
                &api_key,
                &custom_headers,
                model,
                query,
                results,
                &retry_options,
            )
            .await?
        }
        "gemini" => {
            review_via_gemini(
                &api_config,
                &api_key,
                &custom_headers,
                model,
                query,
                results,
                &retry_options,
            )
            .await?
        }
        _ => {
            review_via_chat(
                &api_config,
                &api_key,
                &custom_headers,
                model,
                query,
                results,
                &retry_options,
            )
            .await?
        }
    };

    parse_review_response(&review_text, results.len())
}

fn build_review_user_content(query: &str, results: &[SearchResult]) -> String {
    let mut content = format!("Search query: {}\n\nResults:\n", query);
    for (i, result) in results.iter().enumerate() {
        // Truncate content to keep the prompt manageable.
        let truncated: String = result.content.chars().take(800).collect();
        content.push_str(&format!(
            "[{}] {} (lines {}-{}, score {:.3}):\n{}\n\n",
            i + 1,
            result.relative_path,
            result.start_line,
            result.end_line,
            result.score,
            truncated
        ));
    }
    content
}

async fn review_via_chat(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    query: &str,
    results: &[SearchResult],
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_chat_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let user_content = build_review_user_content(query, results);
    let payload = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
        ],
        "stream": false,
        "max_tokens": 4096,
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    let content = body
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");

    Ok(content.to_string())
}

async fn review_via_responses(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    query: &str,
    results: &[SearchResult],
    retry_options: &RetryOptions,
) -> Result<String> {
    let base_url = normalize_base_url(&api_config.base_url);
    if base_url.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    let endpoint = format!("{}/responses", resolved_base);

    let user_content = build_review_user_content(query, results);
    let payload = json!({
        "model": model,
        "input": [
            {"type": "message", "role": "system", "content": REVIEW_SYSTEM_PROMPT},
            {"type": "message", "role": "user", "content": user_content}
        ],
        "stream": false,
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    Ok(extract_responses_content(&body))
}

async fn review_via_anthropic(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    query: &str,
    results: &[SearchResult],
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_anthropic_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let user_content = build_review_user_content(query, results);
    let payload = json!({
        "model": model,
        "max_tokens": 4096,
        "stream": false,
        "system": REVIEW_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_anthropic_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    Ok(extract_anthropic_content(&body))
}

async fn review_via_gemini(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    query: &str,
    results: &[SearchResult],
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_gemini_endpoint(api_config, model, api_key);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let user_content = build_review_user_content(query, results);
    let payload = json!({
        "systemInstruction": {
            "parts": [{"text": REVIEW_SYSTEM_PROMPT}]
        },
        "contents": [{
            "role": "user",
            "parts": [{"text": user_content}]
        }],
        "generationConfig": {
            "maxOutputTokens": 4096
        }
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_gemini_header_map(custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    let content = body
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .and_then(|parts| parts.first())
        .and_then(|part| part.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");

    Ok(content.to_string())
}

/// Send a non-streaming review request with retry logic.
async fn send_review_request_with_retry(
    client: &reqwest::Client,
    endpoint: &str,
    headers: reqwest::header::HeaderMap,
    payload: &Value,
    retry_options: &RetryOptions,
) -> Result<Value> {
    let mut attempt: u32 = 0;
    loop {
        let response = client
            .post(endpoint)
            .headers(headers.clone())
            .json(payload)
            .send()
            .await
            .map_err(|error| Error::from_reason(format!("Review request failed: {}", error)));

        match response {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    let error_body = response.text().await.unwrap_or_default();
                    let error = Error::from_reason(format!(
                        "Review request failed: {} {}",
                        status, error_body
                    ));

                    if !should_retry(&error, attempt, retry_options) {
                        return Err(error);
                    }

                    attempt += 1;
                    let delay = std::time::Duration::from_millis(retry_options.base_delay_ms);
                    tokio::time::sleep(delay).await;
                    continue;
                }

                let body: Value = response.json().await.map_err(|error| {
                    Error::from_reason(format!("Failed to parse review response: {}", error))
                })?;

                return Ok(body);
            }
            Err(error) => {
                if !should_retry(&error, attempt, retry_options) {
                    return Err(error);
                }

                attempt += 1;
                let delay = std::time::Duration::from_millis(retry_options.base_delay_ms);
                tokio::time::sleep(delay).await;
                continue;
            }
        }
    }
}

/// Parse the model's review response into a ReviewOutcome.
///
/// Expected JSON: `{"relevant": [1, 3, 5], "refined_query": "new query"}`
/// Indices in the response are 1-based; we convert to 0-based.
fn parse_review_response(text: &str, total_results: usize) -> Result<ReviewOutcome> {
    let trimmed = text.trim();

    // Strip markdown code fences if present.
    let json_str = trimmed
        .strip_prefix("```json")
        .or_else(|| strip_prefix_ci(trimmed, "```json"))
        .map(|s| s.trim())
        .and_then(|s| s.strip_suffix("```").map(|s| s.trim()))
        .or_else(|| {
            trimmed
                .strip_prefix("```")
                .and_then(|s| s.strip_suffix("```"))
                .map(|s| s.trim())
        })
        .unwrap_or(trimmed);

    // Try to extract JSON from the text — the model may include extra text.
    let json_str = extract_json_object(json_str).unwrap_or(json_str);

    let parsed: Value = serde_json::from_str(json_str).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse review response as JSON: {}. Raw text: {}",
            error,
            truncate(text, 300)
        ))
    })?;

    let relevant_indices: Vec<usize> = parsed
        .get("relevant")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_u64().map(|n| n as usize))
                .filter(|&i| i > 0 && i <= total_results)
                .map(|i| i - 1) // Convert to 0-based
                .collect()
        })
        .unwrap_or_else(|| {
            // If no "relevant" field, treat all as relevant.
            (0..total_results).collect()
        });

    let refined_query = parsed
        .get("refined_query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Ok(ReviewOutcome {
        relevant_indices,
        refined_query,
    })
}

/// Extract the first JSON object from a string that may contain extra text.
fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end >= start {
        Some(&text[start..=end])
    } else {
        None
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}

fn extract_anthropic_content(body: &Value) -> String {
    let Some(content_array) = body.get("content").and_then(Value::as_array) else {
        return String::new();
    };

    for block in content_array {
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if block_type == "text" {
            if let Some(text) = block
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return text.to_string();
            }
        }
    }

    for block in content_array {
        if let Some(text) = block
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return text.to_string();
        }
    }

    String::new()
}

fn extract_responses_content(body: &Value) -> String {
    if let Some(output) = body.get("output").and_then(Value::as_array) {
        for item in output {
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            return text.to_string();
                        }
                    }
                    if let Some(text) = part.get("output_text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            return text.to_string();
                        }
                    }
                }
            }
        }
    }

    body.get("output_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn resolve_anthropic_endpoint(api_config: &crate::storage::ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_ANTHROPIC_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    if api_config.base_url_mode == "endpoint" {
        return base_url;
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    format!("{}/messages", resolved_base)
}

fn resolve_gemini_endpoint(
    api_config: &crate::storage::ApiConfigRecord,
    model: &str,
    api_key: &str,
) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_GEMINI_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    let resolved_base = if api_config.base_url_mode == "endpoint" {
        base_url
    } else {
        resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode)
    };

    let clean_model = model.strip_prefix("models/").unwrap_or(model);

    let mut url = format!("{}/models/{}:generateContent", resolved_base, clean_model);

    if !api_key.is_empty() {
        url.push_str(&format!("?key={}", api_key));
    }

    url
}

fn resolve_chat_endpoint(api_config: &crate::storage::ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    if api_config.base_url_mode == "endpoint" {
        normalized_base_url
    } else {
        format!(
            "{}/chat/completions",
            resolve_sdk_api_base_url(&normalized_base_url, &api_config.base_url_mode)
        )
    }
}

fn build_header_map(api_key: &str, custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid authorization header value: {}", error))
        })?,
    );

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
            || trimmed_key.eq_ignore_ascii_case("authorization")
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header '{}': {}",
                trimmed_key, error
            ))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

fn build_anthropic_header_map(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| {
            Error::from_reason(format!("Invalid API key header value: {}", error))
        })?,
    );

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
            || trimmed_key.eq_ignore_ascii_case("x-api-key")
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header '{}': {}",
                trimmed_key, error
            ))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

fn build_gemini_header_map(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header '{}': {}",
                trimmed_key, error
            ))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}
