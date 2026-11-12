//! 极简任务级开关：辅助请求不写持久化日志。

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
