//! 终端探测与 shell 参数的 napi 导出壳。

pub use snow_process::terminal::*;

use napi_derive::napi;

#[napi]
pub async fn detect_terminals() -> napi::Result<Vec<DetectedTerminal>> {
    snow_process::terminal::detect_terminals().await
}

#[napi]
pub async fn resolve_login_path_for_terminal() -> Option<String> {
    snow_process::terminal::resolve_login_path_for_terminal().await
}
