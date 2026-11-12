use crate::api::reply_prediction::{
    predict_reply as predict_reply_impl, ReplyPredictionRequest, ReplyPredictionResult,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

// 独立于对话取消体系，只管回复预测请求。
static REQUESTS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
fn requests() -> &'static Mutex<HashMap<String, CancellationToken>> {
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RequestGuard(String);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = requests().lock() {
            map.remove(&self.0);
        }
    }
}

/// 用基础模型预测用户下一条消息（单发辅助请求）。
#[napi(ts_args_type = "request: ReplyPredictionRequest")]
pub async fn predict_reply(request: ReplyPredictionRequest) -> Result<ReplyPredictionResult> {
    let request_id = request.request_id.trim().to_string();
    if request_id.is_empty() || request_id.len() > 200 {
        return Err(Error::from_reason("Invalid reply prediction request ID"));
    }
    let token = CancellationToken::new();
    {
        let mut map = requests()
            .lock()
            .map_err(|_| Error::from_reason("Reply prediction state unavailable"))?;
        if let Some(previous) = map.insert(request_id.clone(), token.clone()) {
            previous.cancel();
        }
    }
    let _guard = RequestGuard(request_id);
    crate::utils::panic_guard::guard_panic(crate::api::ephemeral::scope(predict_reply_impl(
        request, token,
    )))
    .await
}

#[napi]
pub async fn abort_reply_prediction(request_id: String) -> Result<bool> {
    let token = requests()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&request_id));
    Ok(match token {
        Some(token) => {
            token.cancel();
            true
        }
        None => false,
    })
}
