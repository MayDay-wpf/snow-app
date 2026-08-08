//! Codebase semantic search MCP service.
//!
//! Provides the `codebase-search` tool that performs vector
//! similarity search over a project's embedded codebase. Optionally
//! applies reranking and/or agent review based on the project's
//! CodebaseProjectScopeSettings.
//!
//! The tool is only registered when:
//! 1. The project has codebase enabled (`enabled = true`).
//! 2. The project has at least one embedded chunk (index exists).
//!
//! Pipeline:
//! 1. Embed the query using the configured embedding API.
//! 2. Search the vector table for top-N similar chunks.
//! 3. If reranking is enabled (and agent review is NOT), rerank results.
//! 4. If agent review is enabled, run the review loop (which subsumes
//!    reranking — the agent already judges relevance).
//! 5. Return the final results as JSON.

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::bash::{BashStreamCallback, BashStreamChunk};

const SERVER_ID: &str = "codebase";

/// Default number of results to return from vector search.
const DEFAULT_TOP_N: usize = 10;

/// Maximum number of results to return (hard cap).
const MAX_TOP_N: usize = 50;

pub struct CodebaseService;

impl CodebaseService {
    pub fn new() -> Self {
        CodebaseService
    }
}

impl McpService for CodebaseService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: "search".to_string(),
            description: "Search the project's embedded codebase using semantic vector similarity. Returns matching code chunks with file paths, line numbers, and relevance scores. Only available when the project has codebase indexing enabled and embeddings have been generated.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The natural-language search query describing what code you are looking for."
                    },
                    "topN": {
                        "type": "number",
                        "description": "Maximum number of results to return (default 10, max 50).",
                        "default": 10
                    }
                },
                "required": ["query"]
            }),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "search" => Err(Error::new(
                Status::GenericFailure,
                "The Codebase search tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{}\" for MCP server \"codebase\". Available tools: [codebase-search]",
                    tool_name
                ),
            )),
        }
    }
}

impl CodebaseService {
    /// Execute the codebase search tool asynchronously.
    ///
    /// `project_id` determines which project's vector table to search and
    /// which scope settings (reranking / agent review) to apply.
    /// `on_chunk` is used to send real-time progress events (as JSON
    /// strings via the `stdout` stream) so the UI can show what the
    /// agent review loop is doing.
    pub async fn execute_search(
        &self,
        args: &Value,
        project_id: Option<&str>,
        on_chunk: &BashStreamCallback,
    ) -> napi::Result<Value> {
        let project_id = project_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "projectId is required for tool \"codebase-search\". ".to_string(),
                )
            })?
            .to_string();

        let query = args.get("query").and_then(Value::as_str).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "query is required for tool \"codebase-search\"".to_string(),
            )
        })?;

        let top_n = args
            .get("topN")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_TOP_N)
            .min(MAX_TOP_N);

        if query.trim().is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "query must be a non-empty string for tool \"codebase-search\"".to_string(),
            ));
        }

        // Resolve storage info and project scope settings.
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = PathBuf::from(&storage_info.database_path);

        let (scope, settings) = {
            let db_path = database_path.clone();
            let pid = project_id.clone();
            tokio::task::spawn_blocking(move || {
                let scope =
                    crate::storage::services::system_settings::get_codebase_project_scope_settings(
                        &db_path, &pid,
                    )?;
                let settings = load_codebase_settings(&db_path)?;
                Ok::<_, Error>((scope, settings))
            })
            .await
            .map_err(|e| Error::from_reason(format!("Failed to load project scope: {e}")))?
        }?;

        // Verify codebase is enabled.
        let is_enabled = scope.enabled.unwrap_or(false);
        if !is_enabled {
            return Err(Error::new(
                Status::GenericFailure,
                "Codebase search is not enabled for this project. Enable it in the project codebase settings."
                    .to_string(),
            ));
        }

        // Verify the index has at least one chunk.
        let has_index = {
            let db_path = database_path.clone();
            let pid = project_id.clone();
            tokio::task::spawn_blocking(move || {
                match crate::storage::services::codebase_index::get_index_stats(&db_path, &pid) {
                    Ok(stats) => stats.total_chunks > 0,
                    Err(_) => false,
                }
            })
            .await
            .map_err(|e| Error::from_reason(format!("Failed to check index stats: {e}")))?
        };

        if !has_index {
            return Err(Error::new(
                Status::GenericFailure,
                "Codebase index is empty. Please embed the project first before searching."
                    .to_string(),
            ));
        }

        // Embed the query.
        let embedding_config = crate::api::embedding::EmbeddingConfig::from_settings(
            &settings.embedding_type,
            &settings.embedding_model_name,
            &settings.embedding_base_url,
            &settings.embedding_api_key,
            settings.embedding_dimensions,
        );

        let query_vectors =
            crate::api::embedding::embed_batch(&embedding_config, &[query.to_string()])
                .await
                .map_err(|e| Error::from_reason(format!("Failed to embed query: {}", e.reason)))?;

        let query_vector = query_vectors
            .into_iter()
            .next()
            .ok_or_else(|| Error::from_reason("Embedding API returned no vectors for the query"))?;

        // Perform vector search. Fetch more results than top_n so reranking
        // and agent review have a larger pool to work with.
        let search_limit = top_n.max(settings.reranking_top_n as usize).min(MAX_TOP_N) * 3;
        let search_limit = search_limit.min(MAX_TOP_N);

        let initial_results = {
            let db_path = database_path.clone();
            let pid = project_id.clone();
            let qv = query_vector.clone();
            tokio::task::spawn_blocking(move || {
                crate::storage::services::codebase_index::search_vectors(
                    &db_path,
                    &pid,
                    &qv,
                    search_limit,
                )
            })
            .await
            .map_err(|e| Error::from_reason(format!("Search task failed: {e}")))?
        }?;

        if initial_results.is_empty() {
            return Ok(json!({
                "query": query,
                "results": [],
                "totalResults": 0,
                "message": "No matching code chunks found. Try refining your query or re-embedding the project."
            }));
        }

        let enable_reranking = scope.enable_reranking.unwrap_or(false);
        let enable_agent_review = scope.enable_agent_review.unwrap_or(false);

        // Determine the processing pipeline.
        //
        // - If agent review is enabled, it subsumes reranking (the agent
        //   judges relevance, which is strictly more powerful than a
        //   reranking model). So we skip reranking when agent review is on.
        // - If only reranking is enabled, apply reranking.
        // - If neither is enabled, return results as-is (already sorted by
        //   cosine similarity).
        let initial_count = initial_results.len();

        let pipeline: PipelineOutcome = if enable_agent_review {
            // Agent review path.
            let db_path = database_path.clone();
            let pid = project_id.clone();
            let emb_config = embedding_config.clone();

            // Build a progress callback that forwards review progress
            // events to the frontend via the on_chunk stream. Each event
            // is a JSON object sent as a stdout chunk.
            let on_progress = |progress: crate::api::codebase_review::ReviewProgress| {
                let progress_json = json!({
                    "type": "codebase_review_progress",
                    "phase": progress.phase.as_str(),
                    "attempt": progress.attempt,
                    "query": progress.query,
                    "totalCount": progress.total_count,
                    "relevantCount": progress.relevant_count,
                    "refinedQuery": progress.refined_query,
                });
                let chunk = BashStreamChunk {
                    stream: "stdout".to_string(),
                    data: format!("{}\n", progress_json.to_string()),
                };
                let _ = on_chunk.call(chunk, ThreadsafeFunctionCallMode::NonBlocking);
            };

            let review_result = crate::api::codebase_review::run_agent_review(
                query.to_string(),
                initial_results,
                move |refined_query: String| {
                    let db_path = db_path.clone();
                    let pid = pid.clone();
                    let emb_config = emb_config.clone();
                    let limit = search_limit;
                    async move {
                        re_search_with_refined_query(
                            &db_path,
                            &pid,
                            &emb_config,
                            &refined_query,
                            limit,
                        )
                        .await
                    }
                },
                on_progress,
            )
            .await
            .map_err(|e| Error::from_reason(format!("Agent review failed: {}", e.reason)))?;

            // Truncate to top_n after review.
            let mut results = review_result.results;
            results.truncate(top_n);
            PipelineOutcome {
                results,
                pipeline_type: PipelineType::AgentReview,
                attempts: review_result.attempts,
                refined_query: if review_result.effective_query != query {
                    Some(review_result.effective_query)
                } else {
                    None
                },
                initial_count,
            }
        } else if enable_reranking {
            // Reranking-only path.
            let reranking_config = build_reranking_config(&settings);
            let rerank_docs: Vec<crate::api::reranking::RerankDocument> = initial_results
                .iter()
                .enumerate()
                .map(|(i, r)| crate::api::reranking::RerankDocument {
                    index: i,
                    text: r.content.clone(),
                })
                .collect();

            let reranked =
                match crate::api::reranking::rerank(&reranking_config, query, &rerank_docs).await {
                    Ok(rerank_results) => {
                        let reranked: Vec<crate::storage::services::codebase_index::SearchResult> =
                            rerank_results
                                .iter()
                                .filter_map(|rr| initial_results.get(rr.index).cloned())
                                .take(top_n)
                                .collect();
                        if reranked.is_empty() {
                            initial_results.into_iter().take(top_n).collect()
                        } else {
                            reranked
                        }
                    }
                    Err(_e) => {
                        // Reranking failed — fall back to original cosine ordering.
                        initial_results.into_iter().take(top_n).collect()
                    }
                };
            PipelineOutcome {
                results: reranked,
                pipeline_type: PipelineType::Reranking,
                attempts: 1,
                refined_query: None,
                initial_count,
            }
        } else {
            // No post-processing — return top_n by cosine similarity.
            PipelineOutcome {
                results: initial_results.into_iter().take(top_n).collect(),
                pipeline_type: PipelineType::Cosine,
                attempts: 1,
                refined_query: None,
                initial_count,
            }
        };

        let final_results = pipeline.results;
        let final_count = final_results.len();

        // Build the response JSON.
        let results_json: Vec<Value> = final_results
            .iter()
            .map(|r| {
                json!({
                    "filePath": r.file_path,
                    "relativePath": r.relative_path,
                    "chunkIndex": r.chunk_index,
                    "startLine": r.start_line,
                    "endLine": r.end_line,
                    "content": r.content,
                    "score": r.score,
                })
            })
            .collect();

        let total = results_json.len();

        Ok(json!({
            "query": query,
            "results": results_json,
            "totalResults": total,
            "topN": top_n,
            "pipeline": {
                "type": pipeline.pipeline_type.as_str(),
                "agentReview": enable_agent_review,
                "reranking": enable_reranking,
                "attempts": pipeline.attempts,
                "refinedQuery": pipeline.refined_query,
                "initialCount": pipeline.initial_count,
                "finalCount": final_count,
            }
        }))
    }
}

/// Re-search with a refined query (used by the agent review loop).
async fn re_search_with_refined_query(
    database_path: &std::path::Path,
    project_id: &str,
    embedding_config: &crate::api::embedding::EmbeddingConfig,
    refined_query: &str,
    limit: usize,
) -> Result<Vec<crate::storage::services::codebase_index::SearchResult>> {
    let query_vectors =
        crate::api::embedding::embed_batch(embedding_config, &[refined_query.to_string()])
            .await
            .map_err(|e| {
                Error::from_reason(format!("Failed to embed refined query: {}", e.reason))
            })?;

    let query_vector = query_vectors
        .into_iter()
        .next()
        .ok_or_else(|| Error::from_reason("Embedding API returned no vectors for refined query"))?;

    let db_path = database_path.to_path_buf();
    let pid = project_id.to_string();
    let qv = query_vector;
    tokio::task::spawn_blocking(move || {
        crate::storage::services::codebase_index::search_vectors(&db_path, &pid, &qv, limit)
    })
    .await
    .map_err(|e| Error::from_reason(format!("Re-search task failed: {e}")))?
}

/// Parsed codebase settings from the system_settings JSON.
/// (Duplicated from exports/codebase.rs to avoid circular module deps.)
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CodebaseSettings {
    embedding_type: String,
    embedding_model_name: String,
    embedding_base_url: String,
    embedding_api_key: String,
    embedding_dimensions: i32,
    reranking_model_name: String,
    reranking_base_url: String,
    reranking_api_key: String,
    reranking_context_length: i32,
    reranking_top_n: i32,
}

fn load_codebase_settings(database_path: &std::path::Path) -> Result<CodebaseSettings> {
    let raw = crate::storage::services::system_settings::get_system_setting_value(
        database_path,
        "codebase_settings",
    )?
    .unwrap_or_default();
    let settings: CodebaseSettings = serde_json::from_str(&raw).map_err(|error| {
        Error::from_reason(format!("Failed to parse codebase settings: {error}"))
    })?;
    Ok(settings)
}

fn build_reranking_config(settings: &CodebaseSettings) -> crate::api::reranking::RerankingConfig {
    crate::api::reranking::RerankingConfig::from_settings(
        &settings.reranking_model_name,
        &settings.reranking_base_url,
        &settings.reranking_api_key,
        settings.reranking_context_length,
        settings.reranking_top_n,
    )
}

/// The type of post-processing pipeline applied to search results.
enum PipelineType {
    /// No post-processing — results returned in cosine similarity order.
    Cosine,
    /// Reranking model applied to reorder results.
    Reranking,
    /// Agent review applied — the basic model judged relevance and
    /// potentially refined the query and re-searched.
    AgentReview,
}

impl PipelineType {
    fn as_str(&self) -> &'static str {
        match self {
            PipelineType::Cosine => "cosine",
            PipelineType::Reranking => "reranking",
            PipelineType::AgentReview => "agent_review",
        }
    }
}

/// The outcome of a post-processing pipeline, carrying both the final
/// results and metadata about what happened.
struct PipelineOutcome {
    results: Vec<crate::storage::services::codebase_index::SearchResult>,
    pipeline_type: PipelineType,
    /// Number of review/search attempts made (1 = single pass, up to 3
    /// for agent review with query refinement).
    attempts: u32,
    /// If the agent refined the query, the refined query string.
    refined_query: Option<String>,
    /// Number of results from the initial vector search (before
    /// post-processing).
    initial_count: usize,
}
