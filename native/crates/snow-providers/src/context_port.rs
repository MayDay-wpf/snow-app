//! 会话准备端口：请求上下文装配与工具解析由上层注入，providers 只负责协议。

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use napi::bindgen_prelude::Result;
use snow_tools::contract::McpTool;
use snow_tools::conversation::{ConversationContextRequest, PreparedConversationRequest};

use crate::responses::ResponsesApiRequest;

pub type PrepareFuture<'a> = Pin<
    Box<dyn Future<Output = Result<PreparedConversationRequest>> + Send + 'a>,
>;
pub type Preparer = for<'a> fn(ConversationContextRequest<'a>) -> PrepareFuture<'a>;

pub type ToolsFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<Vec<McpTool>>>> + Send + 'a>>;
pub type ToolsResolver = for<'a> fn(&'a ResponsesApiRequest) -> ToolsFuture<'a>;

static PREPARER: OnceLock<Preparer> = OnceLock::new();
static TOOLS_RESOLVER: OnceLock<ToolsResolver> = OnceLock::new();

pub fn register(preparer: Preparer, tools_resolver: ToolsResolver) {
    let _ = PREPARER.set(preparer);
    let _ = TOOLS_RESOLVER.set(tools_resolver);
}

pub fn prepare(request: ConversationContextRequest<'_>) -> PrepareFuture<'_> {
    match PREPARER.get() {
        Some(preparer) => preparer(request),
        None => Box::pin(async {
            Err(napi::Error::from_reason(
                "Conversation context preparer is not registered",
            ))
        }),
    }
}

pub fn resolve_tools(request: &ResponsesApiRequest) -> ToolsFuture<'_> {
    match TOOLS_RESOLVER.get() {
        Some(resolver) => resolver(request),
        None => Box::pin(async {
            Err(napi::Error::from_reason(
                "Request tools resolver is not registered",
            ))
        }),
    }
}
