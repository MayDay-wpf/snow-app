use std::collections::{BTreeMap, HashMap};

use futures::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::api::anthropic::payload::{
    apply_last_user_message_cache_control, build_anthropic_thinking, get_persistent_user_id,
};
use crate::api::chat::payload::build_chat_reasoning_effort;
use crate::api::config::{
    get_active_api_request_context, normalize_base_url, resolve_sdk_api_base_url,
};
use crate::api::gemini::payload::{build_gemini_thinking_config, resolve_gemini_endpoint};
use crate::api::responses::payload::build_responses_reasoning;
use crate::api::retry::{non_sse_response_error, should_retry, RetryOptions};
use crate::api::sse::find_sse_separator;
use crate::api::summary::{
    build_anthropic_header_map, build_gemini_header_map, build_header_map,
    resolve_anthropic_endpoint, resolve_chat_endpoint,
};
use crate::mcp::builtin::get_builtin_tools;
use crate::mcp::servers::filesystem::FilesystemService;
use crate::mcp::servers::grep::GrepService;
use crate::mcp::service::McpService;
use crate::mcp::tools::{
    tools_as_anthropic_json, tools_as_gemini_json, tools_as_openai_chat_json,
    tools_as_openai_responses_json, McpTool,
};
use crate::storage::services::fs_explorer::{FileSearchLineMatch, FileSearchResult};

/// 文件搜索 agent 最多执行的工具调用轮数（模型每次返回工具调用算一轮）。
const MAX_AGENT_ROUNDS: usize = 10;
/// 返回给前端的最大结果数量。
const MAX_RESULTS: usize = 100;
/// 单次工具输出回传给模型的最大字符数，避免上下文无限膨胀。
const MAX_TOOL_OUTPUT_CHARS: usize = 8000;
/// 消息历史最大条数（超出后丢弃最早的中间消息，保留首条用户消息）。
const MAX_MESSAGES: usize = 40;

/// 单轮 agent 运行的结果：要么拿到最终答案文本，要么需要追加消息继续循环。
enum AgentRound {
    Done(String),
    Continue(Vec<Value>),
}

/// 模型发起的一次工具调用（三种协议统一归一化）。
struct AgentToolCall {
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

    let model = api_config.basic_model.trim();
    if model.is_empty() {
        return Err(Error::from_reason(
            "Basic model not configured. Please configure a basic model in API settings.",
        ));
    }

    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let retry_options =
        RetryOptions::from_config(api_config.max_retries, api_config.retry_base_delay_ms);
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
        "gemini" => vec![json!({"role": "user", "parts": [{"text": user_prompt}]})],
        _ => vec![json!({"role": "user", "content": user_prompt})],
    };

    let workspace_root = workspace_path.trim().to_string();

    for round in 0..MAX_AGENT_ROUNDS {
        let outcome = tokio::select! {
            _ = cancel_token.cancelled() => return Ok(Vec::new()),
            result = async {
                match api_config.request_method.as_str() {
                    "responses" => run_responses_round(
                        &api_config, &api_key, &custom_headers, model, &system_prompt,
                        &messages, &tools, &retry_options, &workspace_root,
                        round, on_progress.as_ref(),
                    ).await,
                    "anthropic" => run_anthropic_round(
                        &api_config, &api_key, &custom_headers, model, &system_prompt,
                        &messages, &tools, &retry_options, &workspace_root,
                        round, on_progress.as_ref(),
                    ).await,
                    "gemini" => run_gemini_round(
                        &api_config, &api_key, &custom_headers, model, &system_prompt,
                        &messages, &tools, &retry_options, &workspace_root,
                        round, on_progress.as_ref(),
                    ).await,
                    _ => run_chat_round(
                        &api_config, &api_key, &custom_headers, model, &system_prompt,
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
        "gemini" => json!({"role": "model", "parts": [{"text": text}]}),
        _ => json!({"role": "assistant", "content": text}),
    };
    let follow_up = match request_method {
        "responses" => json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": NO_TOOL_FOLLOW_UP_PROMPT}],
        }),
        "gemini" => json!({"role": "user", "parts": [{"text": NO_TOOL_FOLLOW_UP_PROMPT}]}),
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
async fn send_streaming_sse_request(
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
// chat / completions 协议
// ---------------------------------------------------------------------------

async fn run_chat_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    workspace_root: &str,
    round: usize,
    on_progress: Option<&FileSearchAgentProgressCallback>,
) -> Result<AgentRound> {
    let endpoint = resolve_chat_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let mut chat_messages = vec![json!({"role": "system", "content": system_prompt})];
    chat_messages.extend(messages.iter().cloned());

    let mut payload = json!({
        "model": model,
        "messages": chat_messages,
        "stream": true,
        "tools": tools_as_openai_chat_json(tools),
        "tool_choice": "auto",
    });

    // 与主流程（api/chat/payload.rs）保持一致：
    // max_tokens 遵循用户配置、思考模型的 reasoning_effort 跟随
    // chatThinking 配置，避免 agent 请求与正常聊天行为产生差异。
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_tokens"] = json!(max_tokens);
        }
    }
    if let Some(reasoning_effort) = build_chat_reasoning_effort(&api_config.config_json) {
        payload["reasoning_effort"] = json!(reasoning_effort);
    }

    let client = crate::api::http_client::build_proxied_client().await?;

    // 流式请求：把 SSE 增量合并成等价于非流式响应的 message 对象。
    let mut content_chunks: Vec<String> = Vec::new();
    let mut reasoning_chunks: Vec<String> = Vec::new();
    let mut tool_calls_by_index: BTreeMap<usize, Value> = BTreeMap::new();
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
        |event| {
            merge_chat_stream_event(
                &event,
                &mut content_chunks,
                &mut reasoning_chunks,
                &mut tool_calls_by_index,
            );
            Ok(())
        },
    )
    .await?;

    let mut message = json!({
        "role": "assistant",
        "content": content_chunks.concat(),
        "tool_calls": tool_calls_by_index.into_values().collect::<Vec<_>>(),
    });
    if !reasoning_chunks.is_empty() {
        message["reasoning_content"] = json!(reasoning_chunks.concat());
    }

    let mut tool_calls: Vec<AgentToolCall> = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_string();
            let call_id = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            tool_calls.push(AgentToolCall {
                name,
                arguments_json: arguments,
                call_id,
            });
        }
    }
    tool_calls.retain(|call| !call.name.is_empty());

    if tool_calls.is_empty() {
        // 部分 OpenAI 兼容网关把 content 返回为数组（[{type, text}]），
        // 拼接所有 text 片段作为最终答案。
        let text = extract_chat_content_text(&message);
        return Ok(AgentRound::Done(text));
    }

    let mut assistant_message = json!({
        "role": "assistant",
        "content": null,
        "tool_calls": message.get("tool_calls").cloned().unwrap_or(Value::Null),
    });
    // 与主流程一致：回传 reasoning_content，保持 DeepSeek 等思考模型的
    // 推理连续性。
    if let Some(reasoning) = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        assistant_message["reasoning_content"] = json!(reasoning);
    }
    let mut append = vec![assistant_message];
    for call in &tool_calls {
        let output = execute_agent_tool(
            &call.name,
            &call.arguments_json,
            workspace_root,
            round,
            on_progress,
        )
        .await?;
        append.push(json!({
            "role": "tool",
            "tool_call_id": call.call_id,
            "content": output,
        }));
    }

    Ok(AgentRound::Continue(append))
}

/// 提取 chat 协议 message.content 的文本（兼容字符串与数组两种形态）。
fn extract_chat_content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<String>(),
        _ => String::new(),
    }
}

/// 合并 chat/completions 流式 delta：content 片段、reasoning_content 片段，
/// 以及按 index 合并的 tool_calls（id / name / 分段的 arguments）。
/// 兼容网关忽略 stream 参数时返回的完整响应形态（choices[].message）。
fn merge_chat_stream_event(
    event: &Value,
    content_chunks: &mut Vec<String>,
    reasoning_chunks: &mut Vec<String>,
    tool_calls_by_index: &mut BTreeMap<usize, Value>,
) {
    let Some(choices) = event.get("choices").and_then(Value::as_array) else {
        return;
    };
    for choice in choices {
        // 完整响应形态：message 一次性提供全部内容。
        if let Some(message) = choice.get("message") {
            content_chunks.clear();
            reasoning_chunks.clear();
            tool_calls_by_index.clear();
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    content_chunks.push(text.to_string());
                }
            } else if let Some(parts) = message.get("content").and_then(Value::as_array) {
                for part in parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            content_chunks.push(text.to_string());
                        }
                    }
                }
            }
            if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
                if !reasoning.is_empty() {
                    reasoning_chunks.push(reasoning.to_string());
                }
            }
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for (index, call) in calls.iter().enumerate() {
                    tool_calls_by_index.insert(index, call.clone());
                }
            }
            continue;
        }
        let Some(delta) = choice.get("delta") else {
            continue;
        };
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                content_chunks.push(text.to_string());
            }
        }
        if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
            if !reasoning.is_empty() {
                reasoning_chunks.push(reasoning.to_string());
            }
        }
        let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for call in calls {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let entry = tool_calls_by_index.entry(index).or_insert_with(|| {
                json!({
                    "id": "",
                    "type": "function",
                    "function": {"name": "", "arguments": ""},
                })
            });
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    entry["id"] = json!(id);
                }
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                if !name.is_empty() {
                    entry["function"]["name"] = json!(name);
                }
            }
            if let Some(arg) = call.pointer("/function/arguments").and_then(Value::as_str) {
                if !arg.is_empty() {
                    let current = entry["function"]["arguments"].as_str().unwrap_or("");
                    entry["function"]["arguments"] = json!(format!("{}{}", current, arg));
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// responses 协议
// ---------------------------------------------------------------------------

async fn run_responses_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    workspace_root: &str,
    round: usize,
    on_progress: Option<&FileSearchAgentProgressCallback>,
) -> Result<AgentRound> {
    let base_url = normalize_base_url(&api_config.base_url);
    if base_url.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    let endpoint = format!("{}/responses", resolved_base);

    let mut input = Vec::new();
    input.extend(messages.iter().cloned());

    let mut payload = json!({
        "model": model,
        "input": input,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
        "tools": tools_as_openai_responses_json(tools),
    });

    // 与主流程（api/responses/payload.rs）保持一致：系统提示词放
    // instructions 字段、max_output_tokens 遵循用户配置、
    // reasoning 跟随 responsesReasoning 配置，避免 agent 请求与正常聊天
    // 行为产生差异。
    payload["instructions"] = json!(system_prompt);
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_output_tokens"] = json!(max_tokens);
        }
    }
    if let Some(reasoning) = build_responses_reasoning(&api_config.config_json) {
        payload["reasoning"] = reasoning;
    }

    let client = crate::api::http_client::build_proxied_client().await?;

    // 流式请求：优先采用 response.completed 事件携带的完整响应对象；
    // 网关不发送该事件时，用 output_item.done / output_text.delta 累积结果。
    let mut output_items: Vec<Value> = Vec::new();
    let mut output_text = String::new();
    let mut completed_response: Option<Value> = None;
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
        |event| {
            merge_responses_stream_event(
                &event,
                &mut output_items,
                &mut output_text,
                &mut completed_response,
            );
            Ok(())
        },
    )
    .await?;

    let body = completed_response.unwrap_or_else(|| {
        json!({
            "output": output_items,
            "output_text": output_text,
        })
    });

    let mut tool_calls: Vec<AgentToolCall> = Vec::new();
    let mut text = String::new();
    if let Some(output) = body.get("output").and_then(Value::as_array) {
        for item in output {
            match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                "function_call" => {
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let arguments = item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or("{}")
                        .to_string();
                    let call_id = item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    tool_calls.push(AgentToolCall {
                        name,
                        arguments_json: arguments,
                        call_id,
                    });
                }
                "message" => {
                    // 只采纳 output_text 正文；reasoning 是模型内部思考，跳过。
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for part in content {
                            let part_type =
                                part.get("type").and_then(Value::as_str).unwrap_or_default();
                            if part_type == "output_text" {
                                if let Some(part_text) = part.get("text").and_then(Value::as_str) {
                                    text.push_str(part_text);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    tool_calls.retain(|call| !call.name.is_empty());

    if tool_calls.is_empty() {
        // 顶层 output_text 是最终 assistant 正文的拼接，作为兜底。
        if let Some(output_text) = body.get("output_text").and_then(Value::as_str) {
            text.push_str(output_text);
        }
        return Ok(AgentRound::Done(text));
    }

    let mut append = Vec::new();
    for call in &tool_calls {
        append.push(json!({
            "type": "function_call",
            "call_id": call.call_id,
            "name": call.name,
            "arguments": call.arguments_json,
        }));
        let output = execute_agent_tool(
            &call.name,
            &call.arguments_json,
            workspace_root,
            round,
            on_progress,
        )
        .await?;
        append.push(json!({
            "type": "function_call_output",
            "call_id": call.call_id,
            "output": output,
        }));
    }

    Ok(AgentRound::Continue(append))
}

/// 合并 responses 协议流式事件：累积 output_item.done 条目与 output_text
/// 增量，并捕获 response.completed 携带的完整响应对象（优先使用）。
/// 兼容网关忽略 stream 参数时返回的完整响应形态（顶层 output/output_text）。
fn merge_responses_stream_event(
    event: &Value,
    output_items: &mut Vec<Value>,
    output_text: &mut String,
    completed_response: &mut Option<Value>,
) {
    // 完整响应形态：顶层直接提供 output / output_text。
    if let Some(output) = event.get("output").and_then(Value::as_array) {
        *output_items = output.clone();
    }
    if let Some(text) = event.get("output_text").and_then(Value::as_str) {
        *output_text = text.to_string();
    }
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "response.output_item.done" => {
            if let Some(item) = event.get("item") {
                output_items.push(item.clone());
            }
        }
        "response.output_text.delta" => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                output_text.push_str(delta);
            }
        }
        "response.completed" => {
            if let Some(response) = event.get("response") {
                *completed_response = Some(response.clone());
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// anthropic 协议
// ---------------------------------------------------------------------------

async fn run_anthropic_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    workspace_root: &str,
    round: usize,
    on_progress: Option<&FileSearchAgentProgressCallback>,
) -> Result<AgentRound> {
    let endpoint = resolve_anthropic_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let mut payload = json!({
        "model": model,
        "stream": true,
        "messages": messages,
        "tools": tools_as_anthropic_json(tools),
    });

    // 与主流程（api/anthropic/payload.rs）保持一致：max_tokens 留空时不传该参数。
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_tokens"] = json!(max_tokens);
        }
    }

    // 与主流程（api/anthropic/payload.rs）保持一致：
    // system 以数组形式携带 cache_control 启用 prompt 缓存、携带
    // metadata.user_id 用于跟踪与缓存路由、thinking 跟随 thinking 配置，
    // 避免 agent 请求与正常聊天行为产生差异。
    payload["system"] = json!([{
        "type": "text",
        "text": system_prompt,
        "cache_control": { "type": "ephemeral", "ttl": "5m" },
    }]);
    payload["metadata"] = json!({ "user_id": get_persistent_user_id() });
    if let Some((thinking, effort)) = build_anthropic_thinking(&api_config.config_json) {
        payload["thinking"] = thinking;
        if let Some(effort) = effort {
            payload["output_config"] = json!({ "effort": effort });
        }
    }
    // 与主流程一致：给最后一条 user 消息的最后一个内容块加 cache_control，
    // 让多轮工具调用复用缓存前缀。
    apply_last_user_message_cache_control(&mut payload, false);

    let client = crate::api::http_client::build_proxied_client().await?;

    // 流式请求：按 index 合并 content blocks（text 拼接、tool_use 的 input
    // 用 input_json_delta 累积），最后还原为等价于非流式响应的 body。
    let mut blocks_by_index: BTreeMap<usize, Value> = BTreeMap::new();
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_anthropic_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
        |event| {
            merge_anthropic_stream_event(&event, &mut blocks_by_index);
            Ok(())
        },
    )
    .await?;

    let content_blocks: Vec<Value> = blocks_by_index
        .into_values()
        .map(|mut block| {
            // tool_use 的 input 在流式中以 partial_json 片段累积，结束时
            // 解析为 JSON 对象；解析失败（如片段被截断）则退回空对象。
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                if let Some(partial) = block.get("input").and_then(Value::as_str) {
                    block["input"] = serde_json::from_str(partial).unwrap_or_else(|_| json!({}));
                }
            }
            block
        })
        .collect();

    let mut tool_calls: Vec<AgentToolCall> = Vec::new();
    let mut text = String::new();
    let mut assistant_blocks: Vec<Value> = Vec::new();
    for block in &content_blocks {
        match block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "text" => {
                if let Some(block_text) = block.get("text").and_then(Value::as_str) {
                    text.push_str(block_text);
                    assistant_blocks.push(block.clone());
                }
            }
            "tool_use" => {
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                let arguments_json =
                    serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
                tool_calls.push(AgentToolCall {
                    name,
                    arguments_json,
                    call_id,
                });
                assistant_blocks.push(block.clone());
            }
            // thinking 块是模型内部推理，不参与上下文回传。
            "thinking" | "redacted_thinking" => {}
            _ => {}
        }
    }
    tool_calls.retain(|call| !call.name.is_empty());

    if tool_calls.is_empty() {
        return Ok(AgentRound::Done(text));
    }

    let mut append = vec![json!({"role": "assistant", "content": assistant_blocks})];
    for call in &tool_calls {
        let output = execute_agent_tool(
            &call.name,
            &call.arguments_json,
            workspace_root,
            round,
            on_progress,
        )
        .await?;
        append.push(json!({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": call.call_id,
                "content": output,
            }],
        }));
    }

    Ok(AgentRound::Continue(append))
}

/// 合并 anthropic 协议流式事件：content_block_start 登记块（只保留 text /
/// tool_use，thinking 块由上层解析逻辑忽略），content_block_delta 拼接
/// text 与 partial_json。
/// 兼容网关忽略 stream 参数时返回的完整响应形态（顶层 content 数组）。
fn merge_anthropic_stream_event(event: &Value, blocks_by_index: &mut BTreeMap<usize, Value>) {
    // 完整响应形态：顶层 content 数组一次性提供全部块。
    if let Some(content) = event.get("content").and_then(Value::as_array) {
        blocks_by_index.clear();
        for (index, block) in content.iter().enumerate() {
            blocks_by_index.insert(index, block.clone());
        }
        return;
    }
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "content_block_start" => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let block_type = event
                .pointer("/content_block/type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if block_type == "text" || block_type == "tool_use" {
                let mut block = event
                    .get("content_block")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if block_type == "tool_use" {
                    // 流式阶段 input 以字符串累积 partial_json 片段。
                    block["input"] = json!("");
                }
                blocks_by_index.insert(index, block);
            }
        }
        "content_block_delta" => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let Some(block) = blocks_by_index.get_mut(&index) else {
                return;
            };
            let delta_type = event
                .pointer("/delta/type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match delta_type {
                "text_delta" => {
                    if let Some(text) = event.pointer("/delta/text").and_then(Value::as_str) {
                        let current = block["text"].as_str().unwrap_or("");
                        block["text"] = json!(format!("{}{}", current, text));
                    }
                }
                "input_json_delta" => {
                    if let Some(partial) =
                        event.pointer("/delta/partial_json").and_then(Value::as_str)
                    {
                        let current = block["input"].as_str().unwrap_or("");
                        block["input"] = json!(format!("{}{}", current, partial));
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// gemini 协议
// ---------------------------------------------------------------------------

async fn run_gemini_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    workspace_root: &str,
    round: usize,
    on_progress: Option<&FileSearchAgentProgressCallback>,
) -> Result<AgentRound> {
    let endpoint = resolve_gemini_endpoint(api_config, model, api_key);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    // 与主流程（api/gemini/payload.rs）保持一致：
    // maxOutputTokens 遵循用户配置、thinkingConfig 跟随 geminiThinking
    // 配置，避免 agent 请求与正常聊天行为产生差异。
    let mut generation_config = json!({});
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            generation_config["maxOutputTokens"] = json!(max_tokens);
        }
    }
    if let Some(thinking_config) = build_gemini_thinking_config(&api_config.config_json) {
        generation_config["thinkingConfig"] = thinking_config;
    }

    let payload = json!({
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": messages,
        "tools": tools_as_gemini_json(tools),
        "generationConfig": generation_config,
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    // 流式请求（:streamGenerateContent?alt=sse）：合并所有 chunk 的
    // candidates[0].content.parts，还原为等价于非流式响应的 body。
    let mut parts: Vec<Value> = Vec::new();
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_gemini_header_map(custom_headers)?,
        &payload,
        retry_options,
        |event| {
            merge_gemini_stream_event(&event, &mut parts);
            Ok(())
        },
    )
    .await?;

    let body = json!({
        "candidates": [{
            "content": {"role": "model", "parts": parts},
        }],
    });

    let Some(candidates) = body.get("candidates").and_then(Value::as_array) else {
        return Ok(AgentRound::Done(String::new()));
    };
    let Some(candidate) = candidates.first() else {
        return Ok(AgentRound::Done(String::new()));
    };
    let Some(parts) = candidate
        .get("content")
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
    else {
        return Ok(AgentRound::Done(String::new()));
    };

    let mut tool_calls: Vec<AgentToolCall> = Vec::new();
    let mut text = String::new();
    let mut model_parts: Vec<Value> = Vec::new();
    for part in parts {
        // thought 标记的 part 是模型内部推理，跳过。
        if part
            .get("thought")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(part_text) = part.get("text").and_then(Value::as_str) {
            text.push_str(part_text);
            model_parts.push(part.clone());
        }
        if let Some(function_call) = part.get("functionCall") {
            let name = function_call
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let args = function_call
                .get("args")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let arguments_json = serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
            // gemini 协议没有 call_id，用序号生成占位 id。
            let call_id = format!("function-call-{}", tool_calls.len());
            tool_calls.push(AgentToolCall {
                name,
                arguments_json,
                call_id,
            });
            model_parts.push(part.clone());
        }
    }
    tool_calls.retain(|call| !call.name.is_empty());

    if tool_calls.is_empty() {
        return Ok(AgentRound::Done(text));
    }

    let mut append = vec![json!({"role": "model", "parts": model_parts})];
    for call in &tool_calls {
        let output = execute_agent_tool(
            &call.name,
            &call.arguments_json,
            workspace_root,
            round,
            on_progress,
        )
        .await?;
        append.push(json!({
            "role": "user",
            "parts": [{
                "functionResponse": {
                    "name": call.name,
                    "response": {"result": output},
                },
            }],
        }));
    }

    Ok(AgentRound::Continue(append))
}

/// 合并 gemini 协议流式事件：每个 chunk 的 candidates[0].content.parts
/// 依次追加（text 分块与 functionCall 各自成段，usageMetadata 等无 parts
/// 的 chunk 被忽略）。
fn merge_gemini_stream_event(event: &Value, parts: &mut Vec<Value>) {
    let Some(candidates) = event.get("candidates").and_then(Value::as_array) else {
        return;
    };
    let Some(candidate) = candidates.first() else {
        return;
    };
    let Some(chunk_parts) = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
    else {
        return;
    };
    parts.extend(chunk_parts.iter().cloned());
}

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

/// 执行模型发起的工具调用。工具错误不中断循环，而是作为文本结果回传给
/// 模型，让其自行调整策略；仅在工作区路径校验失败等场景返回硬错误。
/// 每次工具执行完成后（无论成败）都通过 `on_progress` 推送一条进度摘要。
async fn execute_agent_tool(
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
