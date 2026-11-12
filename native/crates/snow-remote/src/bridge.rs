//! Rust → Node → Renderer 的桥接层。
//!
//! 远控的绝大部分请求（静态资源、附件、图片、鉴权）都在 Rust 内部完成；
//! 只有需要桌面 UI 实时状态的操作（发送消息、审批、模型切换等）才通过
//! 这里注册的 ThreadsafeFunction 派发给 Node 主进程，由其执行
//! executeJavaScript 调用渲染进程的 window.__snowRemoteControl 桥。

use std::sync::OnceLock;
use std::time::Duration;

use napi::bindgen_prelude::{Promise, Status};
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::Value;

/// 派发给 Node 的单次桥调用。
#[napi(object)]
pub struct RemoteBridgeRequest {
    pub action: String,
    pub args_json: String,
}

/// Node 侧返回 JSON 字符串：`{ ok: true, value }` 或 `{ ok: false, error }`。
pub type RemoteBridgeCallback =
    ThreadsafeFunction<RemoteBridgeRequest, Promise<String>, RemoteBridgeRequest, Status, false>;

/// 等待 Node 端 executeJavaScript 返回的上限；Node 侧自身有 10 秒超时，
/// 这里再留余量，避免请求永久挂起。长耗时动作（如 AI 生成提交信息）
/// 通过 [`call_with_timeout`] 单独放宽。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(12);

static BRIDGE: OnceLock<RemoteBridgeCallback> = OnceLock::new();

/// 注册渲染进程桥；重复注册时保留首次注册的回调。
pub fn register(callback: RemoteBridgeCallback) {
    let _ = BRIDGE.set(callback);
}

/// 桥是否已注册：/health 的 rendererReady 字段据此上报。
pub fn is_registered() -> bool {
    BRIDGE.get().is_some()
}

/// 桥调用失败的类型。
pub enum BridgeError {
    /// 桥尚未注册（主窗口未就绪）。
    NotReady,
    /// 基础设施故障：Node 端异常、超时或返回格式非法。
    Dispatch,
    /// 渲染进程业务错误（原 RENDERER_ERROR 语义），文案可透传给手机端。
    Renderer(String),
}

/// 调用渲染进程桥方法并等待结果（默认超时）。
pub async fn call(action: &str, args: Value) -> Result<Value, BridgeError> {
    call_with_timeout(action, args, DEFAULT_TIMEOUT).await
}

/// 调用渲染进程桥方法并等待结果，允许长耗时动作使用更长的等待上限。
pub async fn call_with_timeout(
    action: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, BridgeError> {
    let Some(callback) = BRIDGE.get() else {
        return Err(BridgeError::NotReady);
    };
    let request = RemoteBridgeRequest {
        action: action.to_string(),
        args_json: serde_json::to_string(&args).unwrap_or_else(|_| "[]".to_string()),
    };
    let promise = callback
        .call_async_catch(request)
        .await
        .map_err(|_| BridgeError::Dispatch)?;
    let raw = tokio::time::timeout(timeout, promise)
        .await
        .map_err(|_| BridgeError::Dispatch)?
        .map_err(|_| BridgeError::Dispatch)?;
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|_| BridgeError::Dispatch)?;
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(parsed.get("value").cloned().unwrap_or(Value::Null));
    }
    let message = parsed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Snow 暂时无法处理该请求")
        .to_string();
    // 渲染进程业务错误（kind=renderer）透传文案；其余为下层故障。
    if parsed.get("kind").and_then(Value::as_str) == Some("infra") {
        return Err(BridgeError::Dispatch);
    }
    Err(BridgeError::Renderer(message))
}
