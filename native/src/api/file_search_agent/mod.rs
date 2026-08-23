pub(crate) use std::collections::{BTreeMap, HashMap};

pub(crate) use futures::StreamExt;
pub(crate) use napi::bindgen_prelude::*;
pub(crate) use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
pub(crate) use napi_derive::napi;
pub(crate) use serde_json::{json, Value};
pub(crate) use tokio_util::sync::CancellationToken;

pub(crate) use crate::api::anthropic::payload::{
    apply_last_user_message_cache_control, build_anthropic_thinking,
    config_json_enables_one_m_context, get_persistent_user_id, has_one_m_context_marker,
    strip_one_m_context_marker,
};
pub(crate) use crate::api::chat::payload::build_chat_reasoning_effort;
pub(crate) use crate::api::config::{
    get_active_api_request_context, normalize_base_url, resolve_basic_model,
    resolve_sdk_api_base_url,
};
pub(crate) use crate::api::gemini::payload::{
    build_gemini_thinking_config, resolve_gemini_endpoint,
};
pub(crate) use crate::api::responses::payload::build_responses_reasoning;
pub(crate) use crate::api::retry::{non_sse_response_error, should_retry, RetryOptions};
pub(crate) use crate::api::sse::find_sse_separator;
pub(crate) use crate::api::summary::{
    build_anthropic_header_map, build_gemini_header_map, build_header_map,
    resolve_anthropic_endpoint, resolve_chat_endpoint,
};
pub(crate) use crate::mcp::builtin::get_builtin_tools;
pub(crate) use crate::mcp::servers::filesystem::FilesystemService;
pub(crate) use crate::mcp::servers::grep::GrepService;
pub(crate) use crate::mcp::service::McpService;
pub(crate) use crate::mcp::tools::{
    tools_as_anthropic_json, tools_as_gemini_json, tools_as_openai_chat_json,
    tools_as_openai_responses_json, McpTool,
};
pub(crate) use crate::storage::services::fs_explorer::{FileSearchLineMatch, FileSearchResult};

mod providers;

pub(crate) use providers::{
    run_anthropic_round, run_chat_round, run_gemini_round, run_responses_round,
};

/// 文件搜索 agent 最多执行的工具调用轮数（模型每次返回工具调用算一轮）。
const MAX_AGENT_ROUNDS: usize = 10;
/// 返回给前端的最大结果数量。
const MAX_RESULTS: usize = 100;
/// 单次工具输出回传给模型的最大字符数，避免上下文无限膨胀。
const MAX_TOOL_OUTPUT_CHARS: usize = 8000;
/// 消息历史最大条数（超出后丢弃最早的中间消息，保留首条用户消息）。
const MAX_MESSAGES: usize = 40;

/// 单轮 agent 运行的结果：要么拿到最终答案文本，要么需要追加消息继续循环。
pub(crate) enum AgentRound {
    Done(String),
    Continue(Vec<Value>),
}

/// 模型发起的一次工具调用（三种协议统一归一化）。
pub(crate) struct AgentToolCall {
    name: String,
    arguments_json: String,
    call_id: String,
}

/// 每次工具调用完成后推送给前端的进度信息，用于在搜索弹窗中展示过程。
#[napi(object)]
pub struct FileSearchAgentProgress {
    /// 当前工具调用轮次（1 起）。
    pub round: i64,
    /// 工具名（grep-search / filesystem-read）。
    pub tool: String,
    /// 模型传入的原始工具参数 JSON。
    pub args_json: String,
    /// 工具执行结果摘要（或错误信息）。
    pub result_preview: String,
}

pub type FileSearchAgentProgressCallback = ThreadsafeFunction<
    FileSearchAgentProgress,
    Unknown<'static>,
    FileSearchAgentProgress,
    Status,
    false,
>;

/// 首轮未调用任何工具就给出答案时，强制追问模型先实际搜索。
const NO_TOOL_FOLLOW_UP_PROMPT: &str = "Your previous answer was produced without any tool evidence. You MUST call the grep-search or filesystem-read tool at least once to actually search the workspace, and only then reply with the final JSON array of matching files.";

/// 运行自然语言文件搜索 agent：
/// 模型借助 `grep-search` / `filesystem-read` 两个 MCP 工具在工作区内查找
/// 与用户自然语言描述匹配的文件，最多执行 `MAX_AGENT_ROUNDS` 轮工具调用。
/// 请求方案与摘要生成保持一致：responses / anthropic / gemini / chat 四种。
/// `on_progress` 为可选的进度回调，每次工具调用完成后推送一条摘要。
pub async fn run_file_search_agent(
    query: String,
    workspace_path: String,
    cancel_token: CancellationToken,
    on_progress: Option<FileSearchAgentProgressCallback>,
) -> Result<Vec<FileSearchResult>> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() || workspace_path.trim().is_empty() {
        return Ok(Vec::new());
    }

    let context = get_active_api_request_context()?;
    let api_config = context.api_config;
    let custom_headers = context.custom_headers;

    let model = resolve_basic_model(None, &api_config.basic_model)?;

    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let retry_options = RetryOptions::from_config(
        api_config.max_retries,
        api_config.retry_base_delay_ms,
        api_config.partial_retry_max_chars,
    );
    let tools = build_agent_tools();
    let system_prompt = build_system_prompt(workspace_path.trim());
    let user_prompt = format!("Find files matching this description: {trimmed_query}");

    // 各协议的初始用户消息。协议内部的消息形状不同，后续轮次追加的消息
    // 也由各协议对应的 round 函数自行生成，互不通用。
    let mut messages: Vec<Value> = match api_config.request_method.as_str() {
        "responses" => vec![json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": user_prompt}],
        })],
        "anthropic" => vec![json!({"role": "user", "content": user_prompt})],
        "gemini" | "interactions" => {
            vec![json!({"role": "user", "parts": [{"text": user_prompt}]})]
        }
        _ => vec![json!({"role": "user", "content": user_prompt})],
    };

    let workspace_root = workspace_path.trim().to_string();

    for round in 0..MAX_AGENT_ROUNDS {
        let outcome = tokio::select! {
            _ = cancel_token.cancelled() => return Ok(Vec::new()),
            result = async {
                match api_config.request_method.as_str() {
                    "responses" => run_responses_round(
                        &api_config, &api_key, &custom_headers, &model, &system_prompt,
                        &messages, &tools, &retry_options, &workspace_root,
                        round, on_progress.as_ref(),
                    ).await,
                    "anthropic" => run_anthropic_round(
                        &api_config, &api_key, &custom_headers, &model, &system_prompt,
                        &messages, &tools, &retry_options, &workspace_root,
                        round, on_progress.as_ref(),
                    ).await,
                    "gemini" | "interactions" => run_gemini_round(
                        &api_config, &api_key, &custom_headers, &model, &system_prompt,
                        &messages, &tools, &retry_options, &workspace_root,
                        round, on_progress.as_ref(),
                    ).await,
                    _ => run_chat_round(
                        &api_config, &api_key, &custom_headers, &model, &system_prompt,
                        &messages, &tools, &retry_options, &workspace_root,
                        round, on_progress.as_ref(),
                    ).await,
                }
            } => result?,
        };

        match outcome {
            // 首轮未调用任何工具就给出答案：视为无依据回答，强制追问一轮，
            // 要求模型先实际使用工具搜索再作答。
            AgentRound::Done(text) if round == 0 => {
                push_no_tool_follow_up(&mut messages, api_config.request_method.as_str(), &text);
            }
            AgentRound::Done(text) => return parse_final_results(&text, &workspace_root),
            AgentRound::Continue(append) => {
                messages.extend(append);
                trim_messages(&mut messages);
            }
        }
    }

    // 达到轮数上限仍未给出最终答案时，返回空结果。
    Ok(Vec::new())
}

/// 首轮无工具调用的追问：把模型的无依据回答与"必须使用工具"的指令
/// 追加进消息历史，促使模型下一轮发起工具调用。
fn push_no_tool_follow_up(messages: &mut Vec<Value>, request_method: &str, text: &str) {
    let assistant_message = match request_method {
        "responses" => json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text}],
        }),
        "anthropic" => json!({
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        }),
        "gemini" | "interactions" => json!({"role": "model", "parts": [{"text": text}]}),
        _ => json!({"role": "assistant", "content": text}),
    };
    let follow_up = match request_method {
        "responses" => json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": NO_TOOL_FOLLOW_UP_PROMPT}],
        }),
        "gemini" | "interactions" => {
            json!({"role": "user", "parts": [{"text": NO_TOOL_FOLLOW_UP_PROMPT}]})
        }
        _ => json!({"role": "user", "content": NO_TOOL_FOLLOW_UP_PROMPT}),
    };
    messages.push(assistant_message);
    messages.push(follow_up);
}

// ---------------------------------------------------------------------------
// 流式 SSE 请求
// ---------------------------------------------------------------------------

/// 发送流式请求并按 SSE 事件逐条回调 `on_event`（每个 `data:` 行一个 JSON）。
/// 连接失败或非 2xx 状态时按重试策略重试；一旦开始读取流即不再重试。
/// 整个流结束仍未收到任何 `data:` 事件时返回 non-SSE 错误（部分网关会以
/// 200 + JSON 错误体响应流式请求）。
pub(crate) async fn send_streaming_sse_request(
    client: &reqwest::Client,
    endpoint: &str,
    headers: reqwest::header::HeaderMap,
    payload: &Value,
    retry_options: &RetryOptions,
    mut on_event: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    let mut attempt: u32 = 0;
    loop {
        let response = match client
            .post(endpoint)
            .headers(headers.clone())
            .json(payload)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let error = Error::from_reason(format!("API request failed: {}", error));
                if !should_retry(&error, attempt, retry_options) {
                    return Err(error);
                }
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(
                    retry_options.base_delay_ms,
                ))
                .await;
                continue;
            }
        };

        let status = response.status();
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            let error =
                Error::from_reason(format!("API request failed: {} {}", status, error_body));
            if !should_retry(&error, attempt, retry_options) {
                return Err(error);
            }
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(
                retry_options.base_delay_ms,
            ))
            .await;
            continue;
        }

        // 已进入流式读取阶段，中途失败不再重试（事件可能已部分消费）。
        let mut byte_buffer: Vec<u8> = Vec::new();
        let mut received_any_event = false;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                Error::from_reason(format!("API stream read failed: {}", error))
            })?;
            byte_buffer.extend_from_slice(&chunk);
            loop {
                let Some((separator_pos, separator_len)) = find_sse_separator(&byte_buffer) else {
                    break;
                };
                let event_bytes: Vec<u8> = byte_buffer.drain(..separator_pos).collect();
                byte_buffer.drain(..separator_len);
                let event_block = String::from_utf8_lossy(&event_bytes);
                if process_sse_event_block(&event_block, &mut on_event)? {
                    received_any_event = true;
                }
            }
        }
        // 处理流末尾残余（可能是不带尾随空行的最后一个事件）。
        if !byte_buffer.is_empty() {
            let event_block = String::from_utf8_lossy(&byte_buffer);
            if process_sse_event_block(&event_block, &mut on_event)? {
                received_any_event = true;
            }
        }
        if !received_any_event {
            let body = String::from_utf8_lossy(&byte_buffer).to_string();
            return Err(non_sse_response_error(&body));
        }
        return Ok(());
    }
}

/// 解析一个 SSE 事件块（两个空行之间的文本），逐行提取 `data:` 前缀的
/// JSON 并回调。返回是否至少处理了一个事件。
/// 兼容部分网关对 `stream: true` 仍返回完整 JSON（无 `data:` 前缀）的
/// 情况：整个块按 JSON 解析后作为单个事件回调。
fn process_sse_event_block(
    event_block: &str,
    on_event: &mut impl FnMut(Value) -> Result<()>,
) -> Result<bool> {
    let mut processed = false;
    for line in event_block.lines() {
        let trimmed = line.trim_start();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        processed = true;
        on_event(event)?;
    }

    // Fallback: 无 `data:` 行时，把整个块当完整 JSON 响应解析（例如
    // 网关忽略 stream 参数直接返回非流式响应，或 `: ping` 注释行）。
    if !processed {
        let trimmed_block = event_block.trim();
        if !trimmed_block.is_empty() && !trimmed_block.starts_with(':') && trimmed_block != "[DONE]"
        {
            if let Ok(event) = serde_json::from_str::<Value>(trimmed_block) {
                on_event(event)?;
                processed = true;
            }
        }
    }

    Ok(processed)
}

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

/// 执行模型发起的工具调用。工具错误不中断循环，而是作为文本结果回传给
/// 模型，让其自行调整策略；仅在工作区路径校验失败等场景返回硬错误。
/// 每次工具执行完成后（无论成败）都通过 `on_progress` 推送一条进度摘要。
pub(crate) async fn execute_agent_tool(
    name: &str,
    arguments_json: &str,
    workspace_root: &str,
    round: usize,
    on_progress: Option<&FileSearchAgentProgressCallback>,
) -> Result<String> {
    let args: Value = match serde_json::from_str(arguments_json) {
        Ok(args) => args,
        Err(error) => {
            let preview = format!("Error: failed to parse tool arguments: {error}");
            emit_progress(on_progress, round, name, arguments_json, &preview);
            return Ok(preview);
        }
    };

    let (output, preview) = match name {
        "grep-search" => {
            // 未指定搜索路径时默认搜索整个工作区；限定路径必须位于工作区内。
            let requested = args
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(workspace_root);
            let target = match resolve_workspace_path(workspace_root, requested) {
                Ok(path) => path,
                Err(message) => return Ok(format!("Error: {message}")),
            };
            let mut args = args;
            args["path"] = Value::String(target);
            match GrepService::new().execute_search_local(&args).await {
                Ok(output) => {
                    let preview = build_grep_preview(&args, &output);
                    (output, preview)
                }
                Err(error) => {
                    let preview = format!("Error: {}", error.reason);
                    emit_progress(on_progress, round, name, arguments_json, &preview);
                    return Ok(preview);
                }
            }
        }
        "filesystem-read" => {
            let Some(raw_path) = args.get("filePath").and_then(Value::as_str) else {
                let preview =
                    "Error: filePath is required for tool \"filesystem-read\"".to_string();
                emit_progress(on_progress, round, name, arguments_json, &preview);
                return Ok(preview);
            };
            let target = match resolve_workspace_path(workspace_root, raw_path) {
                Ok(path) => path,
                Err(message) => return Ok(format!("Error: {message}")),
            };
            let mut args = args;
            args["filePath"] = Value::String(target);
            let read_args = args.clone();
            let result = tokio::task::spawn_blocking(move || {
                FilesystemService::new().execute("read", &read_args)
            })
            .await
            .map_err(|error| {
                Error::from_reason(format!("Failed to execute filesystem-read: {error}"))
            })?;
            match result {
                Ok(output) => {
                    let preview = build_read_preview(&args, &output);
                    (output, preview)
                }
                Err(error) => {
                    let preview = format!("Error: {}", error.reason);
                    emit_progress(on_progress, round, name, arguments_json, &preview);
                    return Ok(preview);
                }
            }
        }
        other => {
            let preview = format!(
                "Error: unsupported tool \"{other}\". Available tools: [grep-search, filesystem-read]"
            );
            emit_progress(on_progress, round, name, arguments_json, &preview);
            return Ok(preview);
        }
    };

    emit_progress(on_progress, round, name, arguments_json, &preview);
    Ok(truncate_tool_output(&output))
}

/// 推送一条工具执行进度。
fn emit_progress(
    on_progress: Option<&FileSearchAgentProgressCallback>,
    round: usize,
    tool: &str,
    args_json: &str,
    result_preview: &str,
) {
    let Some(callback) = on_progress else {
        return;
    };
    let chunk = FileSearchAgentProgress {
        round: round as i64,
        tool: tool.to_string(),
        args_json: args_json.to_string(),
        result_preview: result_preview.to_string(),
    };
    let _ = callback.call(chunk, ThreadsafeFunctionCallMode::NonBlocking);
}

/// grep 结果摘要：匹配总数 + 涉及文件数。
fn build_grep_preview(args: &Value, output: &Value) -> String {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (total, files) = output
        .get("matches")
        .and_then(Value::as_array)
        .map(|matches| {
            let mut seen = std::collections::HashSet::new();
            for item in matches {
                if let Some(file) = item.get("file").and_then(Value::as_str) {
                    seen.insert(file.to_string());
                }
            }
            (matches.len(), seen.len())
        })
        .unwrap_or((0, 0));
    format!("grep \"{pattern}\" → {total} 处匹配 / {files} 个文件")
}

/// filesystem-read 结果摘要：文件读取显示行数，目录列举显示条目数。
fn build_read_preview(args: &Value, output: &Value) -> String {
    let path = args
        .get("filePath")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(total) = output.get("totalLines").and_then(Value::as_u64) {
        format!("读取 {}（共 {} 行）", path, total)
    } else {
        let items = output
            .get("content")
            .and_then(Value::as_str)
            .map(|content| content.lines().count())
            .unwrap_or(0);
        format!("列出 {}（{} 项）", path, items)
    }
}

fn truncate_tool_output(output: &Value) -> String {
    let serialized = serde_json::to_string(output).unwrap_or_else(|_| String::new());
    if serialized.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        serialized
            .chars()
            .take(MAX_TOOL_OUTPUT_CHARS)
            .collect::<String>()
    } else {
        serialized
    }
}

// ---------------------------------------------------------------------------
// 工具定义与提示词
// ---------------------------------------------------------------------------

/// agent 仅暴露只读工具：内容搜索（grep-search）与目录列举/文件读取
/// （filesystem-read），不暴露任何写工具。
fn build_agent_tools() -> Vec<McpTool> {
    get_builtin_tools()
        .into_iter()
        .filter(|tool| tool.server_id == "filesystem" || tool.server_id == "grep")
        .filter(|tool| tool.name == "read" || tool.name == "search")
        .collect()
}

fn build_system_prompt(workspace_path: &str) -> String {
    format!(
        "You are a file search agent working inside the workspace: {workspace_path}\n\
         Your ONLY task is to find files that match the user's natural language description.\n\n\
         SEARCH STRATEGY (follow it):\n\
         - You MUST call at least one tool before answering. Never guess file paths or invent results.\n\
         - Turn the user's description into concrete keywords: file names, function/class names, symbols, and content phrases. If the user describes in Chinese but the code is in English, also search with English keywords.\n\
         - Start with grep-search on the workspace root for the strongest keyword, then refine: use fileGlob to narrow to relevant file types, use filesystem-read on promising directories to inspect structure, and read promising files to verify matches.\n\
         - For grep-search: set isRegex=false when searching literal text or phrases with spaces; set caseSensitive=false when case may vary; prefer short distinctive keywords over long phrases.\n\
         - filesystem-read on a directory returns its entries, one per line, with a trailing \"/\" for subdirectories.\n\n\
         RULES:\n\
         - Only search inside the workspace. Never access paths outside it.\n\
         - When you have found the matching files (or are confident none match), stop calling tools and reply with ONLY a JSON array. No markdown code fences, no commentary, no explanations.\n\
         - Each element must be: {{\"path\": \"<absolute path>\", \"name\": \"<base name>\", \"isDirectory\": <true|false>, \"lineMatches\": [{{\"line\": <number>, \"text\": \"<matched line>\"}}]}}\n\
         - lineMatches is optional; include the matched lines that justify each result. name must be the file or directory base name.\n\
         - Prefer a few high-confidence results over many guesses. If nothing matches, reply with an empty JSON array: []"
    )
}

// ---------------------------------------------------------------------------
// 路径与结果解析
// ---------------------------------------------------------------------------

fn normalize_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        || (path.len() >= 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/')
}

/// 将模型返回的路径解析为工作区内的绝对路径；相对路径基于工作区根拼接，
/// 绝对路径必须位于工作区内部，否则返回错误。
fn resolve_workspace_path(
    workspace_root: &str,
    requested: &str,
) -> std::result::Result<String, String> {
    let root = workspace_root.trim_end_matches('/');
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("path is required".to_string());
    }

    let normalized = if is_absolute_path(requested) {
        normalize_slashes(requested)
    } else {
        let relative = normalize_slashes(requested);
        let relative = relative.trim_start_matches("./");
        format!("{}/{}", root, relative)
    };

    // 大小写不敏感的前缀校验（Windows 路径大小写不敏感，POSIX 下宽松匹配
    // 也不会带来越界风险——不存在的路径只会得到读取失败）。
    let root_lower = root.to_lowercase();
    let normalized_lower = normalized.to_lowercase();
    if normalized == root || normalized_lower.starts_with(&format!("{}/", root_lower)) {
        Ok(normalized)
    } else {
        Err(format!(
            "path \"{requested}\" is outside the workspace \"{root}\""
        ))
    }
}

/// 丢弃最早的中间消息，保留首条用户消息，控制上下文长度。
fn trim_messages(messages: &mut Vec<Value>) {
    if messages.len() <= MAX_MESSAGES {
        return;
    }
    let excess = messages.len() - MAX_MESSAGES;
    let mut rest = messages.split_off(1);
    rest.drain(..excess);
    *messages = vec![messages.remove(0)];
    messages.extend(rest);
}

/// 解析模型最终答案中的 JSON 数组，归一化为 FileSearchResult 列表。
/// 兼容多种模型输出形态：纯数组、{"files"|"results"|"matches": [...]} 包裹、
/// 附带解释文字的数组片段、以及不带数组括号的逐行 JSON 对象。
fn parse_final_results(text: &str, workspace_root: &str) -> Result<Vec<FileSearchResult>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let code_stripped = strip_code_fences(trimmed);
    let parsed = serde_json::from_str::<Value>(code_stripped).ok();
    let array = parsed
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| {
            // 兼容 {"files": [...]} / {"results": [...]} / {"matches": [...]} 包裹。
            parsed.as_ref().and_then(|value| {
                value
                    .get("files")
                    .or_else(|| value.get("results"))
                    .or_else(|| value.get("matches"))
                    .and_then(Value::as_array)
                    .cloned()
            })
        })
        .or_else(|| {
            // 模型偶发在 JSON 前后附带解释文字时，提取首个 [ ... ] 区间重试。
            extract_json_array(code_stripped)
                .and_then(|slice| serde_json::from_str::<Value>(slice).ok())
                .and_then(|value| value.as_array().cloned())
        });

    let mut results: Vec<FileSearchResult> = match array {
        Some(array) => array
            .iter()
            .filter_map(|item| parse_result_entry(item, workspace_root))
            .collect(),
        None => {
            // 最后兜底：逐行解析 JSON 对象（模型可能输出不带数组括号的多个对象）。
            parse_object_lines(code_stripped, workspace_root)
        }
    };
    results.truncate(MAX_RESULTS);

    Ok(results)
}

/// 解析单个 JSON 结果对象为 FileSearchResult。
fn parse_result_entry(item: &Value, workspace_root: &str) -> Option<FileSearchResult> {
    let raw_path = item
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())?;
    let path = resolve_workspace_path(workspace_root, raw_path).ok()?;

    let name = item
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(&path).to_string());

    let relative_path = relative_to_workspace(workspace_root, &path, raw_path);
    let is_directory = item
        .get("isDirectory")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let matched_name = item
        .get("matchedName")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let line_matches = parse_line_matches(item.get("lineMatches"));

    Some(FileSearchResult {
        path,
        relative_path,
        name,
        is_directory,
        matched_name,
        line_matches,
    })
}

/// 逐行解析 JSON 对象（模型未使用数组括号时的兜底）。
fn parse_object_lines(text: &str, workspace_root: &str) -> Vec<FileSearchResult> {
    let mut results = Vec::new();
    for line in text.lines() {
        if results.len() >= MAX_RESULTS {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(entry) = parse_result_entry(&value, workspace_root) {
                results.push(entry);
            }
        }
    }
    results
}

fn relative_to_workspace(workspace_root: &str, absolute: &str, raw: &str) -> String {
    let root = workspace_root.trim_end_matches('/');
    if let Some(rest) = absolute.strip_prefix(&format!("{}/", root)) {
        return rest.to_string();
    }
    if absolute == root {
        return String::new();
    }
    raw.to_string()
}

fn parse_line_matches(value: Option<&Value>) -> Vec<FileSearchLineMatch> {
    let Some(array) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    array
        .iter()
        .filter_map(|item| {
            let line = item.get("line").and_then(Value::as_i64)?;
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Some(FileSearchLineMatch { line, text })
        })
        .take(20)
        .collect()
}

/// 去除 ```json ... ``` 形式的 markdown 代码围栏。
fn strip_code_fences(text: &str) -> &str {
    let text = text.trim();
    let Some(stripped) = text.strip_prefix("```") else {
        return text;
    };
    let Some(newline) = stripped.find('\n') else {
        return "";
    };
    let body = &stripped[newline + 1..];
    match body.rfind("```") {
        Some(end) => body[..end].trim(),
        None => body.trim(),
    }
}

/// 提取文本中第一个 [ 到最后一个 ] 之间的片段（JSON 数组）。
fn extract_json_array(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    if end > start {
        Some(&text[start..=end])
    } else {
        None
    }
}
