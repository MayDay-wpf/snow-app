//! Wiki agent loop：复用 file_search_agent 的四协议 round 实现，挂载 Wiki 工具执行器。

use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::resolve_advanced_model;
use crate::api::conversation::context::resolve_configured_system_prompts;
use crate::api::file_search_agent::{
    push_follow_up, run_anthropic_round, run_chat_round, run_gemini_round, run_responses_round,
    AgentRound, AgentToolExecutor, ChatTokenUsage,
};
use crate::api::retry::RetryOptions;
use crate::api::usage::{resolve_directory_id, UsageContext};
use crate::mcp::builtin::get_builtin_tools;
use crate::mcp::tools::McpTool;
use crate::storage::ApiConfigRecord;

use super::store::normalize_project_path;
use super::PauseState;

/// 单轮模型请求上限。
const ROUND_TIMEOUT: Duration = Duration::from_secs(300);
/// 工具输出累计字符超过该值时折叠较早的输出。
const TOOL_OUTPUT_BUDGET: usize = 220_000;
const KEEP_RECENT_TOOL_OUTPUTS: usize = 6;
const OMITTED_OUTPUT: &str = "[earlier tool output omitted to save context]";

const NO_TOOL_PROMPT: &str = "You answered without reading any code. You MUST explore the workspace with the tools first (filesystem-read / grep-search / grep-find), verify against the real source, and only then produce the final answer in the required format.";
pub(crate) struct ModelContext {
    pub api_config: ApiConfigRecord,
    pub api_key: String,
    pub custom_headers: HashMap<String, String>,
    pub model: String,
    pub profile_name: String,
    retry_options: RetryOptions,
    tools: Vec<McpTool>,
    configured_system_prompts: Vec<String>,
    /// 用量记录归属
    usage: UsageContext,
}

/// 解析 API 档案与模型；`fallback` 为 true 时档案缺失回落到当前激活档案。
pub(crate) async fn resolve_model_context(
    profile: &str,
    model: &str,
    fallback: bool,
    project_path: &str,
) -> Result<ModelContext> {
    let profile = profile.trim().to_string();
    let project_path = normalize_project_path(project_path);
    let (context, directory_id) = tokio::task::spawn_blocking(move || {
        let requested = (!profile.is_empty()).then_some(profile.as_str());
        let context = if fallback {
            crate::api::config::get_api_request_context_with_fallback(requested)
        } else {
            crate::api::config::get_api_request_context_for_profile(requested)
        }?;
        let directory_id =
            resolve_directory_id(&context.database_path, &project_path);
        Ok::<_, Error>((context, directory_id))
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load API config: {error}")))??;

    let database_path = context.database_path;
    let api_config = context.api_config;
    let mut custom_headers = context.custom_headers;
    crate::api::common::expand_custom_header_session_id(&mut custom_headers, "");
    crate::api::oauth::provider::apply_request_headers(&api_config, &mut custom_headers);

    let api_key = api_config.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }
    let requested_model = model.trim();
    let model = resolve_advanced_model(
        (!requested_model.is_empty()).then_some(requested_model),
        &api_config.advanced_model,
    )?;
    let retry_options = RetryOptions::from_config(
        api_config.max_retries,
        api_config.retry_base_delay_ms,
        api_config.partial_retry_max_chars,
    );
    let tools: Vec<McpTool> = get_builtin_tools()
        .into_iter()
        .filter(|tool| {
            (tool.server_id == "filesystem" && tool.name == "read")
                || (tool.server_id == "grep" && (tool.name == "search" || tool.name == "find"))
        })
        .collect();
    let configured_system_prompts =
        resolve_configured_system_prompts(&api_config.system_prompt_ids_json, None).await;
    let usage = UsageContext {
        database_path,
        model: model.clone(),
        api_profile_name: api_config.profile_name.clone(),
        api_config_id: api_config.id.clone(),
        request_method: api_config.request_method.clone(),
        conversation_id: String::new(),
        directory_id,
    };
    Ok(ModelContext {
        profile_name: api_config.profile_name.clone(),
        api_config,
        api_key,
        custom_headers,
        model,
        retry_options,
        tools,
        configured_system_prompts,
        usage,
    })
}

fn user_message(method: &str, text: &str) -> Value {
    match method {
        "responses" => json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}],
        }),
        "gemini" | "interactions" => json!({"role": "user", "parts": [{"text": text}]}),
        _ => json!({"role": "user", "content": text}),
    }
}

/// 工具输出的位置：(消息下标, 内容块下标)。
fn tool_output_slots(messages: &[Value], method: &str) -> Vec<(usize, Option<usize>, usize)> {
    let mut slots = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        match method {
            "responses" => {
                if message.get("type").and_then(Value::as_str) == Some("function_call_output") {
                    let len = message.get("output").and_then(Value::as_str).map_or(0, str::len);
                    slots.push((index, None, len));
                }
            }
            "anthropic" => {
                if let Some(blocks) = message.get("content").and_then(Value::as_array) {
                    for (block_index, block) in blocks.iter().enumerate() {
                        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                            let len = block.get("content").and_then(Value::as_str).map_or(0, str::len);
                            slots.push((index, Some(block_index), len));
                        }
                    }
                }
            }
            "gemini" | "interactions" => {
                if let Some(parts) = message.get("parts").and_then(Value::as_array) {
                    for (part_index, part) in parts.iter().enumerate() {
                        if let Some(result) = part
                            .pointer("/functionResponse/response/result")
                            .and_then(Value::as_str)
                        {
                            slots.push((index, Some(part_index), result.len()));
                        }
                    }
                }
            }
            _ => {
                if message.get("role").and_then(Value::as_str) == Some("tool") {
                    let len = message.get("content").and_then(Value::as_str).map_or(0, str::len);
                    slots.push((index, None, len));
                }
            }
        }
    }
    slots
}

fn compact_tool_outputs(messages: &mut [Value], method: &str) {
    let slots = tool_output_slots(messages, method);
    let mut total: usize = slots.iter().map(|slot| slot.2).sum();
    if total <= TOOL_OUTPUT_BUDGET || slots.len() <= KEEP_RECENT_TOOL_OUTPUTS {
        return;
    }
    let compactable = slots.len() - KEEP_RECENT_TOOL_OUTPUTS;
    for &(index, inner, len) in slots.iter().take(compactable) {
        if total <= TOOL_OUTPUT_BUDGET {
            break;
        }
        if len <= OMITTED_OUTPUT.len() {
            continue;
        }
        let target = match (method, inner) {
            ("responses", _) => messages[index].get_mut("output"),
            ("anthropic", Some(block)) => messages[index]
                .get_mut("content")
                .and_then(|content| content.get_mut(block))
                .and_then(|block| block.get_mut("content")),
            ("gemini" | "interactions", Some(part)) => messages[index]
                .get_mut("parts")
                .and_then(|parts| parts.get_mut(part))
                .and_then(|part| part.pointer_mut("/functionResponse/response/result")),
            _ => messages[index].get_mut("content"),
        };
        if let Some(value) = target {
            *value = json!(OMITTED_OUTPUT);
            total -= len - OMITTED_OUTPUT.len();
        }
    }
}

async fn dispatch_round(
    ctx: &ModelContext,
    tools: &[McpTool],
    system_prompts: &[String],
    messages: &[Value],
    executor: &dyn AgentToolExecutor,
) -> Result<(AgentRound, ChatTokenUsage)> {
    let config = &ctx.api_config;
    match config.request_method.as_str() {
        "responses" => {
            run_responses_round(
                config, &ctx.api_key, &ctx.custom_headers, &ctx.model, system_prompts, messages,
                tools, &ctx.retry_options, executor,
            )
            .await
        }
        "anthropic" => {
            run_anthropic_round(
                config, &ctx.api_key, &ctx.custom_headers, &ctx.model, system_prompts, messages,
                tools, &ctx.retry_options, executor,
            )
            .await
        }
        "gemini" | "interactions" => {
            run_gemini_round(
                config, &ctx.api_key, &ctx.custom_headers, &ctx.model, system_prompts, messages,
                tools, &ctx.retry_options, executor,
            )
            .await
        }
        _ => {
            run_chat_round(
                config, &ctx.api_key, &ctx.custom_headers, &ctx.model, system_prompts, messages,
                tools, &ctx.retry_options, executor,
            )
            .await
        }
    }
}

/// 运行一次 agent，返回模型最终文本；`extra_tools` 为本次任务额外挂载的工具定义。
pub(crate) async fn run_agent(
    ctx: &ModelContext,
    own_system_prompt: &str,
    user_prompt: &str,
    pause: &PauseState,
    executor: &dyn AgentToolExecutor,
    extra_tools: &[McpTool],
) -> Result<String> {
    let mut tools = ctx.tools.clone();
    tools.extend(extra_tools.iter().cloned());
    // 与主流程一致：配置了系统提示词时它们占用 system，自身提示词并入首条 user 消息。
    let (system_prompts, first_user) = if ctx.configured_system_prompts.is_empty() {
        (vec![own_system_prompt.to_string()], user_prompt.to_string())
    } else {
        (
            ctx.configured_system_prompts.clone(),
            format!("{own_system_prompt}\n\n{user_prompt}"),
        )
    };
    let method = ctx.api_config.request_method.clone();
    let mut messages = vec![user_message(&method, &first_user)];

    let mut round = 0usize;
    loop {
        // 暂停时停在下一轮请求之前（进行中的请求照常完成）
        pause.wait_if_paused().await;
        let outcome = match tokio::time::timeout(
            ROUND_TIMEOUT,
            dispatch_round(ctx, &tools, &system_prompts, &messages, executor),
        )
        .await
        {
            Ok(Ok((outcome, usage))) => {
                ctx.usage.record(usage, "completed").await;
                outcome
            }
            Ok(Err(error)) => {
                ctx.usage.record(ChatTokenUsage::default(), "error").await;
                return Err(error);
            }
            Err(_) => {
                ctx.usage.record(ChatTokenUsage::default(), "error").await;
                return Err(Error::from_reason(format!(
                    "Wiki model request timed out ({}s)",
                    ROUND_TIMEOUT.as_secs()
                )));
            }
        };
        match outcome {
            AgentRound::Done(text) if round == 0 => {
                let answer = if text.trim().is_empty() { "(empty)" } else { text.as_str() };
                push_follow_up(&mut messages, &method, answer, NO_TOOL_PROMPT);
            }
            AgentRound::Done(text) => {
                if text.trim().is_empty() {
                    return Err(Error::from_reason("Model response has no text content"));
                }
                return Ok(text);
            }
            AgentRound::Continue(append) => {
                messages.extend(append);
                compact_tool_outputs(&mut messages, &method);
            }
        }
        round += 1;
    }
}
