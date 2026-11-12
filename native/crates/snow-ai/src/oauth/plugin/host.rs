//! 主进程插件宿主回调：Rust 以 JSON 消息异步调用 oauth.mjs 中的钩子。

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use napi::{bindgen_prelude::*, threadsafe_function::ThreadsafeFunction};
use serde_json::{json, Value};

/// 入参为 JSON 字符串，返回 Promise<JSON 字符串>：`{ ok, result?, error? }`。
pub type OAuthPluginCallback = ThreadsafeFunction<String, Promise<String>, String, Status, false>;

static HANDLER: OnceLock<Mutex<Option<Arc<OAuthPluginCallback>>>> = OnceLock::new();

fn handler_slot() -> &'static Mutex<Option<Arc<OAuthPluginCallback>>> {
    HANDLER.get_or_init(|| Mutex::new(None))
}

fn current_handler() -> Option<Arc<OAuthPluginCallback>> {
    handler_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

pub fn set_handler(handler: Option<OAuthPluginCallback>) {
    *handler_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = handler.map(Arc::new);
}

async fn invoke(handler: &OAuthPluginCallback, message: String) -> Result<Value> {
    let promise = handler
        .call_async_catch(message)
        .await
        .map_err(|error| Error::from_reason(error.to_string()))?;
    let reply = promise
        .await
        .map_err(|error| Error::from_reason(error.to_string()))?;
    serde_json::from_str::<Value>(&reply)
        .map_err(|error| Error::from_reason(format!("Invalid OAuth plugin reply: {error}")))
}

/// 调用插件钩子；超时、宿主缺失或钩子抛错都返回错误。
pub async fn call(method: &str, provider: &str, ctx: Value, timeout: Duration) -> Result<Value> {
    let handler = current_handler()
        .ok_or_else(|| Error::from_reason("OAuth plugin host is not available"))?;
    let message = json!({ "method": method, "provider": provider, "ctx": ctx }).to_string();
    let reply = tokio::time::timeout(timeout, invoke(&handler, message))
        .await
        .map_err(|_| {
            Error::from_reason(format!(
                "OAuth plugin hook '{method}' timed out after {}s",
                timeout.as_secs()
            ))
        })??;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
    }
    let message = reply
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("OAuth plugin hook failed");
    Err(Error::from_reason(message.to_string()))
}
