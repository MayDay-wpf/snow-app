use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use futures::{Stream, StreamExt};
use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use snow_storage_core::app_logs::{insert_app_log, log_api_warning, AppLogInput};

pub const DEFAULT_MAX_RETRIES: u32 = 5;
pub const DEFAULT_BASE_DELAY_MS: u64 = 3000;
pub const DEFAULT_STREAM_IDLE_TIMEOUT_SEC: u64 = 60;
/// 档案 `maxRetries` 的上限。超出部分按此值截断，防止误配极端值导致单个请求被连续重试。
pub const MAX_RETRIES_LIMIT: u32 = 20;
/// 档案固定重试间隔（`retryDelayMs`）的上限（毫秒）。
pub const MAX_RETRY_DELAY_MS: u64 = 60_000;
pub const RETRY_POLICY_SETTING_CODE: &str = "retry_policy";
/// 空响应（正文与工具全空）重试类别的策略 id。与其它类别不同，它不是
/// 「错误文案关键词」类别，而是由流式收尾阶段直接判定的条件开关，因此它的
/// keywords 为空数组（不参与 `is_retriable_error` 的文案匹配）。
pub const EMPTY_RESPONSE_CATEGORY_ID: &str = "emptyResponse";

/// 阶段感知流恢复的可见正文保留阈值缺省值（Unicode 字符数）。
/// transport 中断时仅用户可见 content 达到该阈值才可保留 partial；
/// thinking 与任意 finalized/pending 工具状态都不参与可用正文阈值。
/// 实际值来自 API 档案配置 `partial_retry_max_chars`，未配置时用此缺省。
pub const DEFAULT_PARTIAL_RETRY_MAX_CHARS: usize = 1000;

/// 辅助请求（摘要 / 提交信息 / 主题调色板）的固定重试次数：不跟随 API 档案的
/// `maxRetries`（该值面向正式对话，默认 5 次且指数退避）。辅助生成失败时应更快
/// 放弃，避免后台长时间占用上游配额。
pub const AUXILIARY_MAX_RETRIES: i32 = 3;

/// 把辅助请求的固定重试次数写入档案的内存副本（不写库、不影响其他请求）。
pub fn apply_auxiliary_retries(config: &mut snow_storage_core::models::ApiConfigRecord) {
    config.max_retries = Some(AUXILIARY_MAX_RETRIES);
}

pub struct RetryOptions {
    pub max_retries: u32,
    /// 固定重试间隔（毫秒）。`Some` = 每次重试固定等待该值（封顶 `MAX_RETRY_DELAY_MS`）；
    /// `None` = 档案留 0 或未填写，走指数退避（`DEFAULT_BASE_DELAY_MS × 2^attempt`，封顶 30s）。
    pub retry_delay_ms: Option<u64>,
    /// mid-stream 中断时保留 partial 的纯文本阈值（字符数），来自 API 档案配置。
    pub partial_retry_max_chars: usize,
    pub retry_always: bool,
    pub match_keywords: Vec<String>,
    /// 空响应（正文与工具全空，思考不计）是否重试。默认开启；由重试策略的
    /// `emptyResponse` 类别控制，`retry_always` 打开时一并生效。
    pub retry_empty_response: bool,
}

pub struct RetryCategoryDefaults {
    pub id: &'static str,
    pub keywords: &'static [&'static str],
}

pub const DEFAULT_RETRY_CATEGORIES: &[RetryCategoryDefaults] = &[
    RetryCategoryDefaults {
        id: "overloaded",
        keywords: &["overloaded", "529"],
    },
    RetryCategoryDefaults {
        id: "network",
        keywords: &[
            "error sending request",
            "error trying to connect",
            "network",
            "econnrefused",
            "econnreset",
            "etimedout",
            "timeout",
            "connection refused",
            "connection closed",
            "connection aborted",
            "connection reset",
            "socket hang up",
            "dns error",
            "dns lookup",
            "failed to lookup",
            "tls handshake",
            "handshake error",
            "ehostunreach",
            "enetunreach",
            "network is unreachable",
            "no route to host",
            "unexpected eof",
            "end of file",
            "http2 error",
            "h2 error",
            "stream error",
            "tunnel",
            "proxy error",
        ],
    },
    RetryCategoryDefaults {
        id: "rateLimit",
        // `rate_limit`（下划线）是 OpenAI 系错误体的标准 type 名（`rate_limit_error`）；
        // 只匹配带空格的 `rate limit` 时，若中转商只回传 type 而不回传 message
        // 就会漏判。两种写法都收录。
        keywords: &["rate limit", "rate_limit", "too many requests", "429"],
    },
    RetryCategoryDefaults {
        id: "serverError",
        keywords: &[
            // 通用 5xx
            "500",
            "502",
            "503",
            "504",
            // Cloudflare 5xx（中转/网关侧，长请求场景高频）：
            // 520 源站返回空/未知响应、521 源站宕机、522 连接超时、
            // 523 源站不可达、524 等待超时（125s 读超时）、525 SSL 握手失败、
            // 530 源站 DNS 错误。
            // 526（源站证书无效）是配置类永久错误，重试无意义，故不收录。
            "520",
            "521",
            "522",
            "523",
            "524",
            "525",
            "530",
            "server_error",
            "internal server error",
            "bad gateway",
            "service unavailable",
            "gateway timeout",
        ],
    },
    RetryCategoryDefaults {
        id: "unavailable",
        keywords: &["unavailable"],
    },
    RetryCategoryDefaults {
        id: "terminated",
        keywords: &["terminated"],
    },
    RetryCategoryDefaults {
        id: "stream",
        keywords: &[
            "stream ended",
            "stream terminated",
            "incomplete data",
            "reader error",
        ],
    },
    RetryCategoryDefaults {
        id: "idleTimeout",
        keywords: &["stream idle timeout"],
    },
    RetryCategoryDefaults {
        id: "nonSse",
        keywords: &["non-sse response"],
    },
    // 条件型类别：keywords 为空，不参与错误文案匹配，仅作为重试策略里的开关。
    RetryCategoryDefaults {
        id: EMPTY_RESPONSE_CATEGORY_ID,
        keywords: &[],
    },
];

fn default_retry_keywords() -> Vec<String> {
    DEFAULT_RETRY_CATEGORIES
        .iter()
        .flat_map(|category| category.keywords)
        .map(|keyword| keyword.to_string())
        .collect()
}

fn split_keywords(raw: &str) -> Vec<String> {
    raw.split([',', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
        .collect()
}

fn load_global_retry_policy() -> (bool, Vec<String>, bool) {
    let raw = snow_storage_core::bootstrap::ensure_database_file()
        .ok()
        .and_then(|database_path| {
            snow_storage_core::system_settings::get_system_setting_value(
                &database_path,
                RETRY_POLICY_SETTING_CODE,
            )
            .ok()
            .flatten()
        })
        .unwrap_or_default();
    resolve_retry_rules(&raw)
}

/// 解析重试策略，返回 `(retry_always, keywords, retry_empty_response)`。
/// `retry_empty_response` 来自 `emptyResponse` 类别的 enabled 开关，缺省为
/// `true`，保证旧策略数据（无该类别）行为与之前完全一致。
fn resolve_retry_rules(policy_json: &str) -> (bool, Vec<String>, bool) {
    let parsed: Value = serde_json::from_str(policy_json).unwrap_or(Value::Null);
    if !parsed.is_object() {
        return (false, default_retry_keywords(), true);
    }
    let retry = &parsed;

    let always = retry
        .get("always")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let categories = retry.get("categories");
    let mut keywords = Vec::new();
    let mut retry_empty_response = true;

    for category in DEFAULT_RETRY_CATEGORIES {
        let entry = categories.and_then(|value| value.get(category.id));
        let enabled = entry
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if category.id == EMPTY_RESPONSE_CATEGORY_ID {
            retry_empty_response = enabled;
        }
        if !enabled {
            continue;
        }
        let custom = entry
            .and_then(|value| value.get("keywords"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        match custom {
            Some(list) => keywords.extend(split_keywords(list)),
            None => keywords.extend(category.keywords.iter().map(|keyword| (*keyword).to_string())),
        }
    }

    if let Some(custom) = retry.get("customKeywords").and_then(Value::as_str) {
        keywords.extend(split_keywords(custom));
    }

    (always, keywords, retry_empty_response)
}

pub fn retry_defaults_json() -> String {
    let categories: Vec<Value> = DEFAULT_RETRY_CATEGORIES
        .iter()
        .map(|category| {
            json!({
                "id": category.id,
                "keywords": category.keywords,
            })
        })
        .collect();
    json!({ "categories": categories }).to_string()
}

impl Default for RetryOptions {
    fn default() -> Self {
        Self {
            max_retries: DEFAULT_MAX_RETRIES,
            retry_delay_ms: None,
            partial_retry_max_chars: DEFAULT_PARTIAL_RETRY_MAX_CHARS,
            retry_always: false,
            match_keywords: default_retry_keywords(),
            retry_empty_response: true,
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
            .map(|v| (v as u32).min(MAX_RETRIES_LIMIT))
            .unwrap_or(DEFAULT_MAX_RETRIES);
        let retry_delay_ms = retry_base_delay_ms
            .filter(|&v| v > 0)
            .map(|v| (v as u64).min(MAX_RETRY_DELAY_MS));
        let partial_retry_max_chars = partial_retry_max_chars
            .filter(|&v| v > 0)
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_PARTIAL_RETRY_MAX_CHARS);
        let (retry_always, match_keywords, retry_empty_response) = load_global_retry_policy();
        Self {
            max_retries,
            retry_delay_ms,
            partial_retry_max_chars,
            retry_always,
            match_keywords,
            retry_empty_response,
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
    /// Provider 以 `completed`/`failed` 正常收尾，但正文、思考与工具调用全为空，
    /// 且空响应重试预算已耗尽（见 `should_retry_empty_response`）。
    /// 非 transport：不参与传输中断判定，也不触发传输恢复重试。
    EmptyResponse,
}

impl StreamInterruptionReason {
    pub const fn as_code(self) -> &'static str {
        match self {
            Self::UnexpectedEof => "unexpected_eof",
            Self::ReadError => "read_error",
            Self::IdleTimeout => "idle_timeout",
            Self::ExplicitIncomplete => "explicit_incomplete",
            Self::OutputLimit => "output_limit",
            Self::EmptyResponse => "empty_response",
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

/// 空响应重试预算耗尽后的终态标记。
///
/// Provider 正常收尾、但**没有用户可见正文、也没有工具/推理状态**时，落库结果
/// 与「正常完成」完全同形（`status=completed` 且 `interruption_reason` /
/// `recovery_outcome` 均为空），前端只能看到一个空白气泡，日志里也只剩一条
/// WARN。这里把该终态显式化：补上 `empty_response` 原因与 `retry_exhausted`
/// 结果，让日志、DB 与前端提示都能区分「上游返回空」与「正常完成」。
///
/// 判定口径（三者缺一不可）：
/// - `interruption_reason` 原本为空：真实传输中断 / 服务商明确未完成
///   （`incomplete`）等既有终态一律原样透传，不改变它们的语义与恢复结果；
/// - `has_response_payload == false`：正文与工具/推理状态都为空。thinking
///   不计入有效载荷（见 `attempt_has_payload`），否则「只有思考、没有正文」
///   的残缺结果会被误判为正常完成；
/// - `final_status` 不是取消态：`cancelled` 是用户主动停止，取消路径会清空
///   中断原因与工具调用，零载荷本就是预期结果。补标记会让前端把用户自己的
///   打断渲染成「重试已耗尽 / 响应未完整结束」告警（与
///   `classify_final_stream_warning` 的 cancelled 豁免口径保持一致）。
///
/// 与早期版本的区别：此前只认 `completed`，导致 `failed` / `network_error`
/// 等非完成态的零载荷响应既不打标记、界面也无提示（只剩一条 WARN）。现在
/// 这些非取消态的零载荷终态同样会被标记，前端据此渲染明确的失败提示。
pub fn resolve_empty_response_terminal(
    final_status: &str,
    interruption_reason: Option<StreamInterruptionReason>,
    recovery_outcome: Option<StreamRecoveryOutcome>,
    has_response_payload: bool,
) -> (
    Option<StreamInterruptionReason>,
    Option<StreamRecoveryOutcome>,
) {
    // 用户主动取消：零载荷是预期结果，不补标记（避免误报告警）。
    if final_status == "cancelled" || final_status == "canceled" {
        return (interruption_reason, recovery_outcome);
    }

    if interruption_reason.is_none() && !has_response_payload {
        return (
            Some(StreamInterruptionReason::EmptyResponse),
            Some(StreamRecoveryOutcome::RetryExhausted),
        );
    }

    (interruption_reason, recovery_outcome)
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

/// 一次尝试是否产生了「有效载荷」。
///
/// 有效载荷只认 **用户可见正文** 与 **工具/推理状态**：thinking 不计入。
/// 上游先流出一段思考、随后正文与工具全空就收尾时，用户实际什么也没得到；
/// 若把 thinking 算作载荷，这种尝试既不会触发空响应重试、也不会被标记为
/// `empty_response`，最终只能落一个「只有思考、没有正文」的残缺结果。
pub fn attempt_has_payload(
    content_chunks: &[String],
    _thinking_chunks: &[String],
    has_tool_state: bool,
) -> bool {
    has_tool_state
        || content_chunks.iter().any(|chunk| !chunk.trim().is_empty())
}

pub const EMPTY_RESPONSE_RETRY_ERROR: &str =
    "AI returned an empty response (no content, thinking or tool calls)";

/// 判定一次「零载荷」尝试是否应触发空响应重试。
///
/// 两个前提缺一不可：
/// 1. 该尝试确实没有有效载荷（`has_payload == false`）；
/// 2. 重试预算未耗尽，且重试策略允许空响应重试（`retry_empty_response`，
///    由设置里的 `emptyResponse` 类别控制；`always` 打开时一并生效）。
pub fn should_retry_empty_response(attempt: u32, options: &RetryOptions, has_payload: bool) -> bool {
    !has_payload
        && (options.retry_empty_response || options.retry_always)
        && attempt < options.max_retries
}

/// 关键词是否为纯数字（HTTP 状态码类关键词）。
fn is_numeric_keyword(keyword: &str) -> bool {
    !keyword.is_empty() && keyword.bytes().all(|byte| byte.is_ascii_digit())
}

/// 数字关键词按「完整数字」匹配：前后不得紧邻其他数字。
///
/// 裸子串匹配会让随机数字里的片段造成误判——例如会话 ID
/// `conv-1791567107342905000-22828` 含子串 `500`，会把一个永久性的
/// 400 Bad Request 误判成可重试的 5xx 并反复重试。真实状态码在错误文本里
/// 总是被空格、括号、换行或标点包围，因此要求数字边界不会漏掉任何真实状态码，
/// 只会消除「大数字内部的片段」这类误报。
fn contains_numeric_keyword(message: &str, keyword: &str) -> bool {
    let bytes = message.as_bytes();
    message.match_indices(keyword).any(|(index, _)| {
        let before_ok = index == 0 || !bytes[index - 1].is_ascii_digit();
        let end = index + keyword.len();
        let after_ok = end >= bytes.len() || !bytes[end].is_ascii_digit();
        before_ok && after_ok
    })
}

pub fn is_retriable_error(error: &Error, options: &RetryOptions) -> bool {
    let message = error.reason.to_lowercase();

    if message.contains("aborted") || message.contains("cancel") {
        return false;
    }

    if options.retry_always {
        return true;
    }

    options.match_keywords.iter().any(|keyword| {
        if is_numeric_keyword(keyword) {
            contains_numeric_keyword(&message, keyword)
        } else {
            message.contains(keyword.as_str())
        }
    })
}

/// Check if an error should trigger a retry, given the current attempt count.
/// Returns `true` if the caller should wait and retry, `false` if the error
/// should be propagated immediately.
pub fn should_retry(error: &Error, attempt: u32, options: &RetryOptions) -> bool {
    if attempt >= options.max_retries {
        return false;
    }
    is_retriable_error(error, options)
}

/// 第 `attempt` 次重试前的退避时长（毫秒）。
///
/// 档案填了大于 0 的固定间隔（`retry_delay_ms`）时直接使用该值（已在 `from_config`
/// 中限制为不超过 `MAX_RETRY_DELAY_MS`）；留 0 或未填写时按
/// `DEFAULT_BASE_DELAY_MS × 2^attempt` 指数退避，上限 30s。与
/// `wait_before_retry` 同源，保证下发给前端做倒计时的时长与实际等待时间一致——
/// 两处算法必须同源，否则倒计时会在到点后继续等待或提前归零。
pub fn retry_backoff_ms(options: &RetryOptions, attempt: u32) -> i64 {
    const MAX_BACKOFF_MS: u64 = 30_000;
    match options.retry_delay_ms {
        Some(delay) => delay.min(i64::MAX as u64) as i64,
        None => DEFAULT_BASE_DELAY_MS
            .saturating_mul(1u64 << attempt.min(4))
            .min(MAX_BACKOFF_MS) as i64,
    }
}

/// Wait for the retry delay, respecting the cancel token.
///
/// The delay comes from `retry_backoff_ms`: a fixed value when the profile
/// configures one, otherwise exponential growth (`base × 2^attempt`, capped at
/// 30s) so a recovering network gets progressively more time to come back
/// before the retry budget is exhausted. `attempt` is the number of failures
/// already seen (0 = first retry).
///
/// Returns after either the delay elapses or cancellation is observed. Stream
/// collectors immediately restart their attempt loop, whose cancellation-first
/// entry check returns the Provider-specific `cancelled` result.
pub async fn wait_before_retry(
    options: &RetryOptions,
    cancel_token: &CancellationToken,
    attempt: u32,
) -> Result<()> {
    let delay = Duration::from_millis(retry_backoff_ms(options, attempt).max(0) as u64);
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

// ---------------------------------------------------------------------------
// 重试留痕（单一来源）
// ---------------------------------------------------------------------------
//
// 每一条 API 路径（chat / responses / anthropic / gemini / interactions /
// vision / 文件搜索 / 模型列表）在**真正发起一次重试之前**都必须调用这里的
// 入口写一条日志，否则「上游抖动过、重试了几次、最后一次是什么错误」事后
// 完全无法对账：重试成功时终态是正常完成，重试耗尽时终态只有一个错误，
// 中间过程全部丢失。
//
// 统一约定：
// - message 固定为 [`RETRY_LOG_MESSAGE`]，所有路径共用同一字符串，
//   单条件检索即可拿到全局重试流水；
// - 差异全部收敛到 context 的 `key=value` 字段（provider / request_method /
//   attempt / cause / backoff_ms / endpoint / error）；
// - `error` 写入前截断（上游 5xx 常返回整页 Cloudflare HTML，7KB 级别的
//   正文会把日志淹没），同时用 `error_chars` 保留原始长度以便判断是否截断。

/// 所有路径统一的重试日志 message（单条件检索入口）。
pub const RETRY_LOG_MESSAGE: &str = "AI request retrying";

/// 重试日志中上游错误正文的最大字符数（超出部分截断并标注原始长度）。
const RETRY_LOG_ERROR_MAX_CHARS: usize = 600;

fn truncate_error_for_log(error: &str) -> String {
    let mut truncated: String = error.chars().take(RETRY_LOG_ERROR_MAX_CHARS).collect();
    if error.chars().count() > RETRY_LOG_ERROR_MAX_CHARS {
        truncated.push_str("...");
    }
    truncated
}

fn build_retry_log_context(
    provider: &str,
    request_method: &str,
    cause: &str,
    attempt: u32,
    endpoint: &str,
    error: &str,
    backoff_ms: i64,
) -> String {
    format!(
        "provider={provider}, request_method={request_method}, attempt={}, cause={cause}, backoff_ms={backoff_ms}, error_chars={}, endpoint={endpoint}, error={}",
        attempt + 1,
        error.chars().count(),
        truncate_error_for_log(error),
    )
}

/// 记录一次重试（异步路径统一入口）。
///
/// `attempt` 为本次失败对应的尝试序号（0 表示第一次失败，即将发起第 1 次
/// 重试），与 `wait_before_retry` 的口径一致；`cause` 是稳定的分类标识
/// （`http_status` / `connect_error` / `empty_response` / `read_error` /
/// `idle_timeout` / `unexpected_eof` / `connect` 等）。
#[allow(clippy::too_many_arguments)]
pub async fn log_retry_attempt(
    database_path: &Path,
    func: &str,
    provider: &str,
    request_method: &str,
    cause: &str,
    attempt: u32,
    endpoint: &str,
    error: &str,
    backoff_ms: i64,
) {
    log_api_warning(
        database_path,
        func,
        RETRY_LOG_MESSAGE,
        &build_retry_log_context(
            provider,
            request_method,
            cause,
            attempt,
            endpoint,
            error,
            backoff_ms,
        ),
    )
    .await;
}

/// 解析本地日志数据库路径（best-effort）。
///
/// 供未携带 `database_path` 句柄的路径（视觉、文件搜索、模型列表）写重试
/// 日志使用：存储初始化本身是阻塞操作，放到阻塞线程池执行；任何失败都返回
/// `None` —— 日志永远不能影响主请求流程。
pub async fn retry_log_database_path() -> Option<PathBuf> {
    tokio::task::spawn_blocking(snow_storage_core::bootstrap::ensure_database_file)
        .await
        .ok()
        .and_then(std::result::Result::ok)
}

/// [`log_retry_attempt`] 的 best-effort 变体：自行解析数据库路径，解析失败
/// 时静默跳过。供未持有 `database_path` 句柄的路径使用。
#[allow(clippy::too_many_arguments)]
pub async fn log_retry_attempt_best_effort(
    func: &str,
    provider: &str,
    request_method: &str,
    cause: &str,
    attempt: u32,
    endpoint: &str,
    error: &str,
    backoff_ms: i64,
) {
    if let Some(database_path) = retry_log_database_path().await {
        log_retry_attempt(
            &database_path,
            func,
            provider,
            request_method,
            cause,
            attempt,
            endpoint,
            error,
            backoff_ms,
        )
        .await;
    }
}

/// [`log_retry_attempt`] 的同步版本：供 `with_retry_sync` 这类阻塞代码路径
/// 使用（调用方本身已在 `spawn_blocking` 中，不能再 await）。
#[allow(clippy::too_many_arguments)]
pub fn log_retry_attempt_sync(
    func: &str,
    provider: &str,
    request_method: &str,
    cause: &str,
    attempt: u32,
    endpoint: &str,
    error: &str,
    backoff_ms: i64,
) {
    if snow_runtime::ephemeral::is_active() {
        return;
    }
    let Ok(database_path) = snow_storage_core::bootstrap::ensure_database_file() else {
        return;
    };
    let _ = insert_app_log(
        &database_path,
        &AppLogInput {
            level: "WARN".to_string(),
            module: "api".to_string(),
            func: func.to_string(),
            line: None,
            message: RETRY_LOG_MESSAGE.to_string(),
            input: None,
            output: None,
            duration: None,
            context: Some(build_retry_log_context(
                provider,
                request_method,
                cause,
                attempt,
                endpoint,
                error,
                backoff_ms,
            )),
            error: None,
            source: "main".to_string(),
        },
    );
}

pub const STREAM_IDLE_TIMEOUT_MESSAGE: &str =
    "Stream idle timeout: no data received within the configured period";

/// 失败终态是否由传输层空闲超时造成（发送阶段首字节窗口与读体阶段共用同一文案前缀）。
pub fn is_stream_idle_timeout(error: &Error) -> bool {
    error.reason.starts_with(STREAM_IDLE_TIMEOUT_MESSAGE)
}

/// 首字节窗口按请求体体积放宽的速率：每 128 KiB 请求体追加 1 秒（约 8 秒/MB，
/// 对应 1 Mbps 级上行链路）。上传请求体与上游预填充都发生在首字节之前，
/// 固定窗口会让大请求（多图 / 长历史）稳定越线。
const FIRST_BYTE_BYTES_PER_EXTRA_SEC: usize = 128 * 1024;
/// 同一请求每发生一次空闲超时，首字节窗口按倍数放大，最多放大到该倍数。
const FIRST_BYTE_MAX_ESCALATION: u32 = 4;
/// 首字节窗口的上限（秒）；档案配置的空闲超时更大时以档案为准。
const FIRST_BYTE_TIMEOUT_CAP_SEC: u64 = 900;

/// 单次流式请求的超时口径。
///
/// - `idle`：收到首个数据块之后，相邻数据块的最大间隔（档案 `streamIdleTimeoutSec`）。
/// - 首字节窗口：发送阶段（上传请求体 + 等待响应头）与读体阶段首个数据块之前
///   的等待上限。在 `idle` 基础上按请求体体积放宽，并随本请求已发生的空闲超时
///   次数递增——同一 payload 原样重发时窗口不变只会必然再次超时，这正是大附件
///   会话被盲重试耗尽、永久卡死的根因（Issue #223）。
pub struct StreamTimeouts {
    idle: Duration,
    first_byte_base: Duration,
    first_byte_cap: Duration,
    payload_bytes: usize,
    idle_timeouts: AtomicU32,
}

impl StreamTimeouts {
    pub fn new(stream_idle_timeout_sec: u64, payload_bytes: usize) -> Self {
        let extra_sec = (payload_bytes / FIRST_BYTE_BYTES_PER_EXTRA_SEC) as u64;
        let cap_sec = FIRST_BYTE_TIMEOUT_CAP_SEC.max(stream_idle_timeout_sec);
        Self {
            idle: Duration::from_secs(stream_idle_timeout_sec),
            first_byte_base: Duration::from_secs(
                stream_idle_timeout_sec.saturating_add(extra_sec).min(cap_sec),
            ),
            first_byte_cap: Duration::from_secs(cap_sec),
            payload_bytes,
            idle_timeouts: AtomicU32::new(0),
        }
    }

    /// 以请求体序列化后的字节数构造（与实际发送的 JSON 体积一致）。
    pub fn for_payload(stream_idle_timeout_sec: u64, payload: &Value) -> Self {
        let payload_bytes = serde_json::to_vec(payload).map_or(0, |body| body.len());
        Self::new(stream_idle_timeout_sec, payload_bytes)
    }

    pub fn idle(&self) -> Duration {
        self.idle
    }

    /// 当前首字节窗口：基础窗口 ×（已发生空闲超时次数 + 1），封顶。
    pub fn first_byte(&self) -> Duration {
        let factor = self
            .idle_timeouts
            .load(Ordering::Relaxed)
            .saturating_add(1)
            .min(FIRST_BYTE_MAX_ESCALATION);
        self.first_byte_base
            .saturating_mul(factor)
            .min(self.first_byte_cap)
    }

    /// 发送阶段等待响应头超时：记录一次空闲超时并返回带处置提示的错误。
    /// 文案以 [`STREAM_IDLE_TIMEOUT_MESSAGE`] 开头，保证重试关键词与
    /// [`send_failure_cause`] 的分类不变。
    pub fn send_timeout_error(&self) -> Error {
        let window = self.first_byte();
        self.idle_timeouts.fetch_add(1, Ordering::Relaxed);
        Error::from_reason(format!(
            "{STREAM_IDLE_TIMEOUT_MESSAGE} (no response within {}s for a {:.1} MB request body; large image attachments or a long history can exceed the upstream's first-byte window: remove large attachments, compact the conversation, or raise streamIdleTimeoutSec)",
            window.as_secs(),
            self.payload_bytes as f64 / (1024.0 * 1024.0),
        ))
    }

    /// 读体阶段空闲超时：记录一次空闲超时并返回重试提示文案。
    pub fn read_timeout_reason(&self) -> String {
        self.idle_timeouts.fetch_add(1, Ordering::Relaxed);
        STREAM_IDLE_TIMEOUT_MESSAGE.to_string()
    }
}

/// 发送阶段（建连 + 等待响应头）失败的留痕分类。
///
/// 等待超时（半开连接，响应头迟迟不来）归入 `idle_timeout`，与读体阶段的空闲超时
/// 同口径；其余 DNS / TCP / TLS 等连接层错误为 `connect_error`。
pub fn send_failure_cause(error: &Error) -> &'static str {
    if error.reason.starts_with(STREAM_IDLE_TIMEOUT_MESSAGE) {
        "idle_timeout"
    } else {
        "connect_error"
    }
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

/// 同步重试路径（[`with_retry_sync`]）的留痕上下文。
///
/// 该结构体把「谁在重试、往哪个端点重试」收敛为显式参数：同步路径没有
/// `database_path` 句柄，日志走 [`log_retry_attempt_sync`] 自行解析数据库
/// 路径，因此端点与 provider 必须由调用方在构造时给出。
pub struct RetryLogContext<'a> {
    /// 日志 func 字段（与对应导出函数的函数名保持一致，便于按功能过滤）。
    pub func: &'a str,
    /// 协议标签（chat / responses / anthropic / gemini / interactions）。
    pub provider: &'a str,
    /// 请求方式标签（与 provider 一致，保留独立字段以对齐流式路径的格式）。
    pub request_method: &'a str,
    /// 完整请求 URL。
    pub endpoint: &'a str,
}

/// Wrap a sync function with retry logic (for blocking code paths like
/// `reqwest::blocking` and the model-list client).
///
/// 每次真正重试之前都通过 `log_context` 写一条重试日志，保证同步路径与
/// 流式路径拥有同一份可观测口径（见 [`RETRY_LOG_MESSAGE`]）。
pub fn with_retry_sync<F, T>(f: F, options: &RetryOptions, log_context: &RetryLogContext<'_>) -> Result<T>
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

                log_retry_attempt_sync(
                    log_context.func,
                    log_context.provider,
                    log_context.request_method,
                    "request_error",
                    attempt,
                    log_context.endpoint,
                    &error.reason,
                    retry_backoff_ms(options, attempt),
                );
                std::thread::sleep(Duration::from_millis(
                    retry_backoff_ms(options, attempt).max(0) as u64,
                ));
                attempt += 1;
            }
        }
    }
}
