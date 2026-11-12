use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures::FutureExt;

use super::panic_hook::panic_message;

pub async fn guard_panic<T, F>(future: F) -> napi::Result<T>
where
    F: Future<Output = napi::Result<T>>,
{
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => Err(napi::Error::new(
            napi::Status::GenericFailure,
            format!("panic from Rust code: {}", panic_message(&*payload)),
        )),
    }
}
