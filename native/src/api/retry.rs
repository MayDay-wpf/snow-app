use std::time::Duration;

use futures::{Stream, StreamExt};
use napi::bindgen_prelude::*;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_MAX_RETRIES: u32 = 5;
pub const DEFAULT_BASE_DELAY_MS: u64 = 3000;
pub const DEFAULT_STREAM_IDLE_TIMEOUT_SEC: u64 = 60;

/// 阶段感知流恢复的可见正文保留阈值缺省值（Unicode 字符数）。
/// transport 中断时仅用户可见 content 达到该阈值才可保留 partial；
/// thinking 与任意 finalized/pending 工具状态都不参与可用正文阈值。
/// 实际值来自 API 档案配置 `partial_retry_max_chars`，未配置时用此缺省。
pub const DEFAULT_PARTIAL_RETRY_MAX_CHARS: usize = 1000;

pub struct RetryOptions {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    /// mid-stream 中断时保留 partial 的纯文本阈值（字符数），来自 API 档案配置。
    pub partial_retry_max_chars: usize,
}

impl Default for RetryOptions {
    fn default() -> Self {
        Self {
            max_retries: DEFAULT_MAX_RETRIES,
            base_delay_ms: DEFAULT_BASE_DELAY_MS,
            partial_retry_max_chars: DEFAULT_PARTIAL_RETRY_MAX_CHARS,
        }
    }
}

impl RetryOptions {
    pub fn from_config(
        max_retries: Option<i32>,
        retry_base_delay_ms: Option<i32>,
        partial_retry_max_chars: Option<i32>,
    ) -> Self {
        let max_retries = max_retries
            .filter(|&v| v > 0)
            .map(|v| v as u32)
            .unwrap_or(DEFAULT_MAX_RETRIES);
        let base_delay_ms = retry_base_delay_ms
            .filter(|&v| v > 0)
            .map(|v| v as u64)
            .unwrap_or(DEFAULT_BASE_DELAY_MS);
        let partial_retry_max_chars = partial_retry_max_chars
            .filter(|&v| v > 0)
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_PARTIAL_RETRY_MAX_CHARS);
        Self {
            max_retries,
            base_delay_ms,
            partial_retry_max_chars,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamInterruptionReason {
    UnexpectedEof,
    ReadError,
    IdleTimeout,
    ExplicitIncomplete,
    OutputLimit,
}

impl StreamInterruptionReason {
    pub const fn as_code(self) -> &'static str {
        match self {
            Self::UnexpectedEof => "unexpected_eof",
            Self::ReadError => "read_error",
            Self::IdleTimeout => "idle_timeout",
            Self::ExplicitIncomplete => "explicit_incomplete",
            Self::OutputLimit => "output_limit",
        }
    }

    pub const fn is_transport(self) -> bool {
        matches!(
            self,
            Self::UnexpectedEof | Self::ReadError | Self::IdleTimeout
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalStreamWarningDisposition {
    TransportInterrupted(StreamInterruptionReason),
    EmptyResponse,
    None,
}

pub fn classify_final_stream_warning(
    final_status: &str,
    interruption_reason: Option<StreamInterruptionReason>,
    has_response_payload: bool,
) -> FinalStreamWarningDisposition {
    if final_status == "cancelled" {
        return FinalStreamWarningDisposition::None;
    }

    match interruption_reason {
        Some(reason) if reason.is_transport() => {
            FinalStreamWarningDisposition::TransportInterrupted(reason)
        }
        _ if !has_response_payload => FinalStreamWarningDisposition::EmptyResponse,
        _ => FinalStreamWarningDisposition::None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamRecoveryOutcome {
    PartialThreshold,
    RetryExhausted,
    NonRetriable,
}

impl StreamRecoveryOutcome {
    pub const fn as_code(self) -> &'static str {
        match self {
            Self::PartialThreshold => "partial_threshold",
            Self::RetryExhausted => "retry_exhausted",
            Self::NonRetriable => "non_retriable",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StreamReadOutcome<T, E> {
    Data(T),
    ReadError(E),
    Eof,
    IdleTimeout,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEndCause {
    UnexpectedEof,
    ReadError,
    IdleTimeout,
}

impl StreamEndCause {
    pub const fn interruption_reason(self) -> StreamInterruptionReason {
        match self {
            Self::UnexpectedEof => StreamInterruptionReason::UnexpectedEof,
            Self::ReadError => StreamInterruptionReason::ReadError,
            Self::IdleTimeout => StreamInterruptionReason::IdleTimeout,
        }
    }

    const fn is_retriable(self) -> bool {
        matches!(self, Self::UnexpectedEof | Self::IdleTimeout)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreamAttemptProgress {
    pub visible_content_chars: usize,
    pub has_tool_state: bool,
    pub has_pending_tool_fragments: bool,
    pub provider_terminal: bool,
    pub user_cancelled: bool,
}

impl StreamAttemptProgress {
    const fn has_any_tool_state(self) -> bool {
        self.has_tool_state || self.has_pending_tool_fragments
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamRecoveryDecision {
    FinishProviderResult,
    Cancelled,
    Retry,
    KeepUsablePartial,
    SurfaceInterrupted,
}

impl StreamRecoveryDecision {
    pub const fn recovery_outcome(self) -> Option<StreamRecoveryOutcome> {
        match self {
            Self::KeepUsablePartial => Some(StreamRecoveryOutcome::PartialThreshold),
            Self::SurfaceInterrupted => Some(StreamRecoveryOutcome::RetryExhausted),
            Self::FinishProviderResult | Self::Cancelled | Self::Retry => None,
        }
    }
}

pub fn visible_content_char_count(content_chunks: &[String]) -> usize {
    content_chunks
        .iter()
        .map(|chunk| chunk.chars().count())
        .sum()
}

/// Read one stream item with a cancellation-first idle guard. Calling this
/// helper again after `Data` creates a fresh timeout and therefore resets the
/// idle deadline without Provider-specific timer bookkeeping.
pub async fn next_stream_item_with_idle<S, T, E>(
    stream: &mut S,
    cancel_token: &CancellationToken,
    idle_timeout: Duration,
) -> StreamReadOutcome<T, E>
where
    S: Stream<Item = std::result::Result<T, E>> + Unpin,
{
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => StreamReadOutcome::Cancelled,
        item = stream.next() => match item {
            Some(Ok(data)) => StreamReadOutcome::Data(data),
            Some(Err(error)) => StreamReadOutcome::ReadError(error),
            None => StreamReadOutcome::Eof,
        },
        _ = sleep(idle_timeout) => StreamReadOutcome::IdleTimeout,
    }
}

pub fn decide_stream_recovery(
    cause: StreamEndCause,
    attempt: u32,
    options: &RetryOptions,
    progress: StreamAttemptProgress,
) -> StreamRecoveryDecision {
    if progress.user_cancelled {
        return StreamRecoveryDecision::Cancelled;
    }
    if progress.provider_terminal {
        return StreamRecoveryDecision::FinishProviderResult;
    }
    if matches!(cause, StreamEndCause::ReadError) {
        return if attempt < options.max_retries {
            StreamRecoveryDecision::Retry
        } else {
            StreamRecoveryDecision::SurfaceInterrupted
        };
    }

    let usable_partial = progress.visible_content_chars >= options.partial_retry_max_chars
        && !progress.has_any_tool_state();
    if usable_partial {
        return StreamRecoveryDecision::KeepUsablePartial;
    }
    if cause.is_retriable() && attempt < options.max_retries {
        return StreamRecoveryDecision::Retry;
    }

    StreamRecoveryDecision::SurfaceInterrupted
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
/// Returns after either the delay elapses or cancellation is observed. Stream
/// collectors immediately restart their attempt loop, whose cancellation-first
/// entry check returns the Provider-specific `cancelled` result.
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
            Ok(())
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

/// Wrap a sync function with retry logic (for blocking code paths like
/// `reqwest::blocking` and the model-list client).
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
    use super::*;

    fn options() -> RetryOptions {
        RetryOptions {
            max_retries: 2,
            base_delay_ms: 1,
            partial_retry_max_chars: 5,
        }
    }

    #[test]
    fn opaque_typed_read_error_retries_with_budget() {
        let unknown_error = Error::from_reason("opaque provider body reader failure QUX-17");
        assert!(!is_retriable_error(&unknown_error));

        assert_eq!(
            decide_stream_recovery(
                StreamEndCause::ReadError,
                0,
                &options(),
                StreamAttemptProgress::default(),
            ),
            StreamRecoveryDecision::Retry
        );
    }

    #[test]
    fn read_error_retries_even_with_long_visible_content() {
        assert_eq!(
            decide_stream_recovery(
                StreamEndCause::ReadError,
                0,
                &options(),
                StreamAttemptProgress {
                    visible_content_chars: 50,
                    ..StreamAttemptProgress::default()
                },
            ),
            StreamRecoveryDecision::Retry
        );
    }

    #[test]
    fn read_error_retries_with_finalized_or_pending_tool_state() {
        for progress in [
            StreamAttemptProgress {
                has_tool_state: true,
                ..StreamAttemptProgress::default()
            },
            StreamAttemptProgress {
                has_pending_tool_fragments: true,
                ..StreamAttemptProgress::default()
            },
        ] {
            assert_eq!(
                decide_stream_recovery(StreamEndCause::ReadError, 0, &options(), progress),
                StreamRecoveryDecision::Retry
            );
        }
    }

    #[test]
    fn exhausted_read_error_surfaces_retry_exhausted_before_partial_threshold() {
        let decision = decide_stream_recovery(
            StreamEndCause::ReadError,
            options().max_retries,
            &options(),
            StreamAttemptProgress {
                visible_content_chars: 50,
                ..StreamAttemptProgress::default()
            },
        );

        assert_eq!(decision, StreamRecoveryDecision::SurfaceInterrupted);
        assert_eq!(
            decision.recovery_outcome(),
            Some(StreamRecoveryOutcome::RetryExhausted)
        );
        assert_eq!(
            StreamEndCause::ReadError.interruption_reason(),
            StreamInterruptionReason::ReadError
        );
    }

    #[test]
    fn cancellation_and_provider_terminal_precede_read_error_retry() {
        assert_eq!(
            decide_stream_recovery(
                StreamEndCause::ReadError,
                0,
                &options(),
                StreamAttemptProgress {
                    provider_terminal: true,
                    user_cancelled: true,
                    ..StreamAttemptProgress::default()
                },
            ),
            StreamRecoveryDecision::Cancelled
        );
        assert_eq!(
            decide_stream_recovery(
                StreamEndCause::ReadError,
                0,
                &options(),
                StreamAttemptProgress {
                    provider_terminal: true,
                    ..StreamAttemptProgress::default()
                },
            ),
            StreamRecoveryDecision::FinishProviderResult
        );
    }

    #[test]
    fn eof_and_idle_keep_long_partial_but_retry_short_partial() {
        for cause in [StreamEndCause::UnexpectedEof, StreamEndCause::IdleTimeout] {
            assert_eq!(
                decide_stream_recovery(
                    cause,
                    0,
                    &options(),
                    StreamAttemptProgress {
                        visible_content_chars: options().partial_retry_max_chars,
                        ..StreamAttemptProgress::default()
                    },
                ),
                StreamRecoveryDecision::KeepUsablePartial
            );
            assert_eq!(
                decide_stream_recovery(
                    cause,
                    0,
                    &options(),
                    StreamAttemptProgress {
                        visible_content_chars: options().partial_retry_max_chars - 1,
                        ..StreamAttemptProgress::default()
                    },
                ),
                StreamRecoveryDecision::Retry
            );
        }
    }

    #[test]
    fn attempt_equal_to_max_retries_is_exhausted_without_off_by_one() {
        let options = options();
        assert_eq!(
            decide_stream_recovery(
                StreamEndCause::ReadError,
                options.max_retries - 1,
                &options,
                StreamAttemptProgress::default(),
            ),
            StreamRecoveryDecision::Retry
        );
        assert_eq!(
            decide_stream_recovery(
                StreamEndCause::ReadError,
                options.max_retries,
                &options,
                StreamAttemptProgress::default(),
            ),
            StreamRecoveryDecision::SurfaceInterrupted
        );
    }

    #[test]
    fn historical_non_retriable_code_remains_stable() {
        assert_eq!(
            StreamRecoveryOutcome::NonRetriable.as_code(),
            "non_retriable"
        );
    }
}
