use crate::api::prompt_optimization::{
    optimize_prompt_stream, PromptOptimizationRequest, PromptOptimizationResult,
};
use crate::api::responses::ResponsesApiStreamCallback;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

// Deliberately separate from api::cancel and all conversation cancellation.
static STREAMS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
fn streams() -> &'static Mutex<HashMap<String, CancellationToken>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reserve synchronously before starting the async native call. This closes
/// the abort-before-first-poll race without retaining cancellation tombstones.
#[napi]
pub fn prepare_prompt_optimization(stream_id: String) -> Result<bool> {
    if stream_id.is_empty() || stream_id.len() > 200 {
        return Err(Error::from_reason("Invalid prompt optimization stream ID"));
    }
    let mut streams = streams()
        .lock()
        .map_err(|_| Error::from_reason("Optimization state unavailable"))?;
    if streams.contains_key(&stream_id) {
        return Ok(false);
    }
    streams.insert(stream_id, CancellationToken::new());
    Ok(true)
}

#[napi]
pub fn abort_prompt_optimization(stream_id: String) -> bool {
    let token = streams()
        .lock()
        .ok()
        .and_then(|mut streams| streams.remove(&stream_id));
    if let Some(token) = token {
        token.cancel();
        true
    } else {
        false
    }
}

struct StreamGuard(String);
impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Ok(mut streams) = streams().lock() {
            streams.remove(&self.0);
        }
    }
}

#[napi(
    ts_args_type = "request: PromptOptimizationRequest, onChunk: (chunk: ResponsesApiStreamChunk) => void, onProgress?: (phase: string) => void",
    ts_return_type = "Promise<PromptOptimizationResult>"
)]
pub async fn optimize_prompt(
    request: PromptOptimizationRequest,
    on_chunk: ResponsesApiStreamCallback,
    on_progress: Option<crate::api::prompt_context::ProgressCallback>,
) -> Result<PromptOptimizationResult> {
    let token = streams()
        .lock()
        .map_err(|_| Error::from_reason("Optimization state unavailable"))?
        .get(&request.stream_id)
        .cloned()
        .ok_or_else(|| Error::from_reason("Prompt optimization cancelled or not prepared"))?;
    let _guard = StreamGuard(request.stream_id.clone());
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(Error::from_reason("Prompt optimization cancelled")),
        result = crate::api::ephemeral::scope(optimize_prompt_stream(request, on_chunk, token.clone(), on_progress)) => result,
    }
}

#[napi]
pub fn get_prompt_context_status(
    binding_json: String,
    api_profile: Option<String>,
    model: Option<String>,
    options_json: Option<String>,
) -> Result<String> {
    crate::api::ephemeral::scope_sync(|| {
        crate::api::prompt_context::access(
            &binding_json,
            api_profile.as_deref(),
            model.as_deref(),
            options_json.as_deref(),
            None,
            None,
        )
    })
}
#[napi]
pub fn grant_prompt_context_access(
    binding_json: String,
    api_profile: Option<String>,
    model: Option<String>,
    options_json: Option<String>,
    authorization_ticket: Option<String>,
) -> Result<String> {
    crate::api::ephemeral::scope_sync(|| {
        crate::api::prompt_context::access(
            &binding_json,
            api_profile.as_deref(),
            model.as_deref(),
            options_json.as_deref(),
            Some(true),
            authorization_ticket.as_deref(),
        )
    })
}
#[napi]
pub fn revoke_prompt_context_access(
    binding_json: String,
    api_profile: Option<String>,
    model: Option<String>,
    options_json: Option<String>,
) -> Result<bool> {
    crate::api::ephemeral::scope_sync(|| {
        crate::api::prompt_context::access(
            &binding_json,
            api_profile.as_deref(),
            model.as_deref(),
            options_json.as_deref(),
            Some(false),
            None,
        )
    })
    .map(|_| true)
}
#[napi]
pub fn get_prompt_context_source_preview(
    context_handle: String,
    source_id: String,
    owner_id: String,
) -> Result<String> {
    crate::api::ephemeral::scope_sync(|| {
        crate::api::prompt_context::preview(&context_handle, &source_id, &owner_id)
    })
}
