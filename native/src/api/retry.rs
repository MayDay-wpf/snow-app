use std::time::Duration;

use napi::bindgen_prelude::*;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_MAX_RETRIES: u32 = 5;
pub const DEFAULT_BASE_DELAY_MS: u64 = 3000;
pub const DEFAULT_STREAM_IDLE_TIMEOUT_SEC: u64 = 60;

pub struct RetryOptions {
    pub max_retries: u32,
    pub base_delay_ms: u64,
}

impl Default for RetryOptions {
    fn default() -> Self {
        Self {
            max_retries: DEFAULT_MAX_RETRIES,
            base_delay_ms: DEFAULT_BASE_DELAY_MS,
        }
    }
}

impl RetryOptions {
    pub fn from_config(max_retries: Option<i32>, retry_base_delay_ms: Option<i32>) -> Self {
        let max_retries = max_retries
            .filter(|&v| v > 0)
            .map(|v| v as u32)
            .unwrap_or(DEFAULT_MAX_RETRIES);
        let base_delay_ms = retry_base_delay_ms
            .filter(|&v| v > 0)
            .map(|v| v as u64)
            .unwrap_or(DEFAULT_BASE_DELAY_MS);
        Self {
            max_retries,
            base_delay_ms,
        }
    }
}

/// Resolve the stream idle timeout (seconds) from the API config value.
/// Falls back to a sensible default when the value is missing or invalid
/// so the stream always has an idle guard — a stalled upstream will not
/// hang the agent loop indefinitely.
pub fn resolve_stream_idle_timeout_sec(stream_idle_timeout_sec: Option<i32>) -> u64 {
    stream_idle_timeout_sec
        .filter(|&v| v > 0)
        .map(|v| v as u64)
        .unwrap_or(DEFAULT_STREAM_IDLE_TIMEOUT_SEC)
}

pub fn is_retriable_error(error: &Error) -> bool {
    let message = error.reason.to_lowercase();

    if message.contains("aborted") || message.contains("cancel") {
        return false;
    }

    // Overloaded
    if message.contains("overloaded") || message.contains("529") {
        return true;
    }

    // Network errors — reqwest surfaces connect-layer failures as
    // "error sending request for url (...): <cause>" where <cause> can be a
    // DNS failure, refused/reset connection, TLS handshake error, timeout,
    // HTTP/2 stream error, or a plain "connection closed before message
    // completed". Match both the top-level wrapper and the common causes so
    // transient network failures are retried instead of failing the turn.
    if message.contains("error sending request")
        || message.contains("error trying to connect")
        || message.contains("network")
        || message.contains("econnrefused")
        || message.contains("econnreset")
        || message.contains("etimedout")
        || message.contains("timeout")
        || message.contains("connection refused")
        || message.contains("connection closed")
        || message.contains("connection aborted")
        || message.contains("connection reset")
        || message.contains("socket hang up")
        || message.contains("dns error")
        || message.contains("dns lookup")
        || message.contains("failed to lookup")
        || message.contains("tls handshake")
        || message.contains("handshake error")
        || message.contains("ehostunreach")
        || message.contains("enetunreach")
        || message.contains("network is unreachable")
        || message.contains("no route to host")
        || message.contains("unexpected eof")
        || message.contains("end of file")
        || message.contains("http2 error")
        || message.contains("h2 error")
        || message.contains("stream error")
        || message.contains("tunnel")
        || message.contains("proxy error")
    {
        return true;
    }

    // Rate limit errors
    if message.contains("rate limit")
        || message.contains("too many requests")
        || message.contains("429")
    {
        return true;
    }

    // Server errors (5xx and terminal Responses API server failures)
    if message.contains("500")
        || message.contains("502")
        || message.contains("503")
        || message.contains("504")
        || message.contains("server_error")
        || message.contains("internal server error")
        || message.contains("bad gateway")
        || message.contains("service unavailable")
        || message.contains("gateway timeout")
    {
        return true;
    }

    // Temporary unavailable
    if message.contains("unavailable") {
        return true;
    }

    // Connection terminated by server
    if message.contains("terminated") {
        return true;
    }

    // Stream errors
    if message.contains("stream ended")
        || message.contains("stream terminated")
        || message.contains("incomplete data")
        || message.contains("reader error")
    {
        return true;
    }

    // Stream idle timeout — a stalled upstream is treated as retriable so the
    // agent loop re-issues the request with the original parameters.
    if message.contains("stream idle timeout") {
        return true;
    }

    // Non-SSE response body — the server returned HTTP 200 but the body is
    // not a valid SSE stream (e.g. a JSON error envelope from a relay).
    // This is surfaced by `non_sse_response_error` when the stream ends
    // with accumulated bytes that produced no SSE events. Relays that wrap
    // upstream errors this way are retried so transient relay failures can
    // recover once the relay's quota/rate window resets.
    if message.contains("non-sse response") {
        return true;
    }

    false
}

/// Check if an error should trigger a retry, given the current attempt count.
/// Returns `true` if the caller should wait and retry, `false` if the error
/// should be propagated immediately.
pub fn should_retry(error: &Error, attempt: u32, options: &RetryOptions) -> bool {
    if attempt >= options.max_retries {
        return false;
    }
    is_retriable_error(error)
}

/// Wait for the retry delay, respecting the cancel token.
///
/// The delay grows exponentially with the attempt count
/// (`base_delay_ms × 2^attempt`, capped at 30s) so a recovering network gets
/// progressively more time to come back before the retry budget is
/// exhausted. `attempt` is the number of failures already seen (0 = first
/// retry).
///
/// Returns `Err` if cancelled during the wait.
pub async fn wait_before_retry(
    options: &RetryOptions,
    cancel_token: &CancellationToken,
    attempt: u32,
) -> Result<()> {
    const MAX_BACKOFF_MS: u64 = 30_000;
    let backoff = options.base_delay_ms.saturating_mul(1u64 << attempt.min(4));
    let delay = Duration::from_millis(backoff.min(MAX_BACKOFF_MS));
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => {
            Err(Error::from_reason("Request aborted"))
        }
        _ = sleep(delay) => {
            Ok(())
        }
    }
}

/// Build the error used when the stream has been idle (no data received)
/// for longer than the configured `stream_idle_timeout_sec`. The message is
/// phrased so `is_retriable_error` recognises it as a retriable condition.
pub fn stream_idle_timeout_error() -> Error {
    Error::from_reason("Stream idle timeout: no data received within the configured period")
}

/// Build the error used when the HTTP response has a 2xx status code but the
/// body is **not** a valid SSE stream — e.g. a relay that returns a JSON error
/// envelope (such as a quota-exhausted message) with HTTP 200 instead of a
/// proper SSE event stream.
///
/// The message includes the raw body so the caller can see the actual error,
/// and is phrased so `is_retriable_error` recognises it as a retriable
/// condition via the "non-sse response" marker.
pub fn non_sse_response_error(body: &str) -> Error {
    let truncated = if body.len() > 1000 {
        &body[..1000]
    } else {
        body
    };
    Error::from_reason(format!(
        "Non-SSE response: stream ended without any SSE events (body: {truncated})"
    ))
}

/// Wrap an async function with retry logic.
///
/// Each invocation of `f` should produce a fresh future. The function is
/// retried up to `options.max_retries` times when the error is retriable.
pub async fn with_retry<F, Fut, T>(
    f: F,
    options: &RetryOptions,
    cancel_token: Option<&CancellationToken>,
) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut attempt: u32 = 0;

    loop {
        if let Some(token) = cancel_token {
            if token.is_cancelled() {
                return Err(Error::from_reason("Request aborted"));
            }
        }

        match f().await {
            Ok(result) => return Ok(result),
            Err(error) => {
                if error.reason.contains("abort") || error.reason.contains("Abort") {
                    return Err(error);
                }

                if !should_retry(&error, attempt, options) {
                    return Err(error);
                }

                let delay = Duration::from_millis(options.base_delay_ms);
                if let Some(token) = cancel_token {
                    tokio::select! {
                        biased;
                        _ = token.cancelled() => {
                            return Err(Error::from_reason("Request aborted"));
                        }
                        _ = sleep(delay) => {}
                    }
                } else {
                    sleep(delay).await;
                }

                attempt += 1;
            }
        }
    }
}

/// Wrap a sync function with retry logic (for blocking code paths like
/// `reqwest::blocking`).
pub fn with_retry_sync<F, T>(f: F, options: &RetryOptions) -> Result<T>
where
    F: Fn() -> Result<T>,
{
    let mut attempt: u32 = 0;

    loop {
        match f() {
            Ok(result) => return Ok(result),
            Err(error) => {
                if error.reason.contains("abort") || error.reason.contains("Abort") {
                    return Err(error);
                }

                if !should_retry(&error, attempt, options) {
                    return Err(error);
                }

                std::thread::sleep(Duration::from_millis(options.base_delay_ms));
                attempt += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_retriable_error;
    use napi::Error;

    #[test]
    fn terminal_server_error_is_retriable() {
        let error =
            Error::from_reason("Temporary upstream failure (type=server_error, code=server_error)");
        assert!(is_retriable_error(&error));
    }

    #[test]
    fn invalid_request_error_is_not_retriable() {
        let error = Error::from_reason(
            "Unsupported parameter (type=invalid_request_error, code=invalid_request_error)",
        );
        assert!(!is_retriable_error(&error));
    }
}
