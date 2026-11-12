//! Task-local opt-in for non-persistent, text-only auxiliary completions.
//! The flag is scoped to this future, never global and never inherited by
//! unrelated chat requests. `run` also enforces the existing skip-context
//! contract (no history, built-in prompts, tools, image parsing or exchanges).
use crate::api::responses::ResponsesApiRequest;
use std::future::Future;

tokio::task_local! {
    static EPHEMERAL: bool;
}

pub fn is_active() -> bool {
    EPHEMERAL.try_with(|value| *value).unwrap_or(false)
}

pub fn scope_sync<T>(call: impl FnOnce() -> T) -> T {
    EPHEMERAL.sync_scope(true, call)
}
pub async fn scope<T>(future: impl Future<Output = T>) -> T {
    EPHEMERAL.scope(true, future).await
}

pub async fn run<T, F, Fut>(mut request: ResponsesApiRequest, call: F) -> T
where
    F: FnOnce(ResponsesApiRequest) -> Fut,
    Fut: Future<Output = T>,
{
    request.skip_context = Some(true);
    request.disable_tools = Some(true);
    request.conversation_id = None;
    request.previous_response_id = None;
    request.sub_agent_tools_json = None;
    request.sub_agent_system_prompt = None;
    request.sub_agent_config_profile = None;
    request.allowed_tools_json = None;
    request.context_compaction = None;
    request.resume_after_compaction = None;
    EPHEMERAL.scope(true, call(request)).await
}
