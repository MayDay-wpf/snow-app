use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use napi::bindgen_prelude::*;
use tokio_util::sync::CancellationToken;

static CANCEL_REGISTRY: Mutex<Option<HashMap<String, CancellationToken>>> = Mutex::new(None);

/// Stream IDs that received a cancel call *before* the token was registered.
/// `create_and_register` checks this set and, if present, creates an
/// already-cancelled token so the stream aborts immediately.
static PRE_CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Separate registry for conversation-summary cancellation tokens, keyed by
/// conversation id. Unlike streams, summary generation is a non-streaming
/// HTTP request with no stream id, so it gets its own registry. This allows
/// `handleAbort` / `handleRollback` to cancel an in-flight summary by
/// conversation id so the summary's `update_conversation_summary` write
/// transaction is skipped, releasing the database lock for a subsequent
/// delete/truncate.
static SUMMARY_REGISTRY: Mutex<Option<HashMap<String, CancellationToken>>> = Mutex::new(None);

fn with_registry<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, CancellationToken>) -> R,
{
    let mut guard = CANCEL_REGISTRY
        .lock()
        .expect("Cancel registry mutex poisoned");
    let registry = guard.get_or_insert_with(HashMap::new);
    f(registry)
}

fn with_pre_cancelled<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashSet<String>) -> R,
{
    let mut guard = PRE_CANCELLED
        .lock()
        .expect("Pre-cancelled set mutex poisoned");
    let set = guard.get_or_insert_with(HashSet::new);
    f(set)
}

fn with_summary_registry<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, CancellationToken>) -> R,
{
    let mut guard = SUMMARY_REGISTRY
        .lock()
        .expect("Summary registry mutex poisoned");
    let registry = guard.get_or_insert_with(HashMap::new);
    f(registry)
}

/// Register a cancellation token for the given stream id.
/// If a token already exists for the same id it is replaced.
pub fn register_stream(stream_id: &str, token: CancellationToken) {
    with_registry(|registry| {
        registry.insert(stream_id.to_string(), token);
    });
}

/// Trigger cancellation for the given stream id and remove the token from the registry.
///
/// If the token has not been registered yet (the stream is still in the
/// initial HTTP request phase), the id is added to a pre-cancelled set so
/// that `create_and_register` will produce an already-cancelled token.
///
/// Returns `true` if a token was found and cancelled, `false` otherwise.
pub fn cancel_stream(stream_id: &str) -> bool {
    let cancelled = with_registry(|registry| {
        if let Some(token) = registry.remove(stream_id) {
            token.cancel();
            true
        } else {
            false
        }
    });

    if !cancelled {
        with_pre_cancelled(|set| {
            set.insert(stream_id.to_string());
        });
    }

    cancelled
}

/// Remove the token from the registry without cancelling it.
/// Called when the stream finishes normally.
pub fn unregister_stream(stream_id: &str) {
    with_registry(|registry| {
        registry.remove(stream_id);
    });
    with_pre_cancelled(|set| {
        set.remove(stream_id);
    });
}

/// Get a clone of the token for the given stream id, if it exists.
pub fn get_token(stream_id: &str) -> Option<CancellationToken> {
    with_registry(|registry| registry.get(stream_id).cloned())
}

/// Validate that a stream id is a non-empty trimmed string.
pub fn validate_stream_id(stream_id: &str) -> Result<String> {
    let trimmed = stream_id.trim();
    if trimmed.is_empty() {
        return Err(napi::Error::from_reason("Stream ID is required"));
    }
    Ok(trimmed.to_string())
}

/// Convenience function to create and register a new token for a stream.
///
/// If the stream id is in the pre-cancelled set (cancel was called before
/// the token existed), the returned token is already cancelled so the stream
/// loop exits immediately on the first `tokio::select!` iteration.
pub fn create_and_register(stream_id: &str) -> CancellationToken {
    let was_pre_cancelled = with_pre_cancelled(|set| set.remove(stream_id));

    let token = CancellationToken::new();
    if was_pre_cancelled {
        token.cancel();
    }
    register_stream(stream_id, token.clone());
    token
}

/// Register a cancellation token for a conversation's summary generation.
/// Called at the start of `generate_conversation_summary` in the NAPI layer.
/// If a token already exists for the same conversation id it is replaced.
pub fn register_summary(conversation_id: &str, token: CancellationToken) {
    with_summary_registry(|registry| {
        registry.insert(conversation_id.to_string(), token);
    });
}

/// Trigger cancellation for a conversation's in-flight summary and remove
/// the token from the registry. Returns `true` if a token was found and
/// cancelled, `false` otherwise (e.g. the summary already finished).
pub fn cancel_summary(conversation_id: &str) -> bool {
    with_summary_registry(|registry| {
        if let Some(token) = registry.remove(conversation_id) {
            token.cancel();
            true
        } else {
            false
        }
    })
}

/// Remove the summary token from the registry without cancelling it.
/// Called when the summary finishes normally (success or error).
pub fn unregister_summary(conversation_id: &str) {
    with_summary_registry(|registry| {
        registry.remove(conversation_id);
    });
}

// ============================================================================
// Tool execution cancellation (bash subprocesses and similar long-running
// tools).  Each in-flight tool execution gets its own UUID, stored under a
// dedicated prefix so it can never collide with a stream id.  Session aborts
// and the per-tool UI stop button both cancel by this id, which races the
// child process wait in the executing service and kills the process tree.
// ============================================================================

const TOOL_EXECUTION_PREFIX: &str = "tool:";

/// Register a fresh cancellation token for a tool execution.  If a cancel
/// was already requested before registration (pre-cancelled), the returned
/// token is created already-cancelled so the execution aborts immediately.
pub fn register_tool_execution(tool_execution_id: &str) -> CancellationToken {
    create_and_register(&format!("{TOOL_EXECUTION_PREFIX}{tool_execution_id}"))
}

/// Trigger cancellation for a tool execution and remove its token from the
/// registry.  Returns `true` if a token was found and cancelled.
pub fn cancel_tool_execution(tool_execution_id: &str) -> bool {
    cancel_stream(&format!("{TOOL_EXECUTION_PREFIX}{tool_execution_id}"))
}

/// Remove the tool-execution token without cancelling it.  Called when the
/// execution finishes normally (success, timeout or error).
pub fn unregister_tool_execution(tool_execution_id: &str) {
    unregister_stream(&format!("{TOOL_EXECUTION_PREFIX}{tool_execution_id}"));
}
