//! 各协议（chat/responses/anthropic/gemini）的 agent 轮次实现。

use super::*;

// ---------------------------------------------------------------------------
// chat / completions 协议
// ---------------------------------------------------------------------------

pub(crate) async fn run_chat_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompts: &[String],
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    executor: &dyn AgentToolExecutor,
) -> Result<(AgentRound, ChatTokenUsage)> {
    let endpoint = resolve_chat_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    // 与主流程（api/chat/payload.rs）一致：单条系统提示词用字符串，多条作为同一条 system 消息的多个内容块。
    let system_content = match system_prompts {
        [only] => json!(only),
        many => json!(many
            .iter()
            .map(|text| json!({"type": "text", "text": text}))
            .collect::<Vec<_>>()),
    };
    let mut chat_messages = vec![json!({"role": "system", "content": system_content})];
    chat_messages.extend(messages.iter().cloned());

    let mut payload = json!({
        "model": model,
        "messages": chat_messages,
        "stream": true,
        // 与主流程一致：流式末尾携带用量，供用量记录统计
        "stream_options": {"include_usage": true},
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
    let mut usage = ChatTokenUsage::default();
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
        executor.label(),
        "chat",
        |event| {
            if let Some(event_usage) = event.get("usage").filter(|value| value.is_object()) {
                usage = extract_chat_token_usage(event_usage);
            }
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
    // 与主流程一致：DeepSeek V4 思考模式下，带 tool_calls 的 assistant
    // 消息必须回传 reasoning_content（空字符串也被接受），否则后续
    // 工具轮次请求会收到 400 "reasoning_content must be passed back"。
    message["reasoning_content"] = json!(reasoning_chunks.concat());

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
        return Ok((AgentRound::Done(text), usage));
    }

    let mut assistant_message = json!({
        "role": "assistant",
        "content": null,
        "tool_calls": message.get("tool_calls").cloned().unwrap_or(Value::Null),
    });
    // 与主流程一致：回传 reasoning_content，保持 DeepSeek 等思考模型的
    // 推理连续性。DeepSeek V4 思考模式要求带 tool_calls 的 assistant
    // 消息必须回传该字段（空字符串也被接受），缺失会导致 400。
    assistant_message["reasoning_content"] = json!(
        message
            .get("reasoning_content")
            .and_then(Value::as_str)
            .unwrap_or("")
    );
    let mut append = vec![assistant_message];
    for call in &tool_calls {
        let output = executor
            .execute(&call.name, &call.arguments_json)
            .await?;
        append.push(json!({
            "role": "tool",
            "tool_call_id": call.call_id,
            "content": output,
        }));
    }

    Ok((AgentRound::Continue(append), usage))
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

pub(crate) async fn run_responses_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompts: &[String],
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    executor: &dyn AgentToolExecutor,
) -> Result<(AgentRound, ChatTokenUsage)> {
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
    // 与主流程（api/responses/payload.rs）一致：多条系统提示词以空行合并进 instructions。
    payload["instructions"] = json!(system_prompts.join("\n\n"));
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
    let mut usage = ChatTokenUsage::default();
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
        executor.label(),
        "responses",
        |event| {
            // response.completed 的 response.usage，或完整响应形态的顶层 usage
            let usage_source = event
                .get("response")
                .filter(|response| response.get("usage").is_some_and(Value::is_object))
                .or_else(|| event.get("usage").is_some_and(Value::is_object).then_some(&event));
            if let Some(source) = usage_source {
                usage = extract_responses_token_usage(source);
            }
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
        return Ok((AgentRound::Done(text), usage));
    }

    let mut append = Vec::new();
    for call in &tool_calls {
        append.push(json!({
            "type": "function_call",
            "call_id": call.call_id,
            "name": call.name,
            "arguments": call.arguments_json,
        }));
        let output = executor
            .execute(&call.name, &call.arguments_json)
            .await?;
        append.push(json!({
            "type": "function_call_output",
            "call_id": call.call_id,
            "output": output,
        }));
    }

    Ok((AgentRound::Continue(append), usage))
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

pub(crate) async fn run_anthropic_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompts: &[String],
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    executor: &dyn AgentToolExecutor,
) -> Result<(AgentRound, ChatTokenUsage)> {
    let endpoint = resolve_anthropic_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    // `[1M]` 后缀是 Claude Code 生态的本地上下文能力声明：发送前剥离。
    // 1M 上下文生效条件：模型名带标记，或档案开关 snowcfg.enable1mContext
    // 开启（与主流程一致，开关兜底模型名标记）。
    let enable_one_m_context = has_one_m_context_marker(model)
        || config_json_enables_one_m_context(&api_config.config_json);
    let model = strip_one_m_context_marker(model);

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
    // 与主流程（api/anthropic/payload.rs）一致：每条系统提示词各自一个 text 块，最后一块带 cache_control。
    let last_system_index = system_prompts.len().saturating_sub(1);
    let system_blocks: Vec<Value> = system_prompts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            let mut block = json!({"type": "text", "text": text});
            if index == last_system_index {
                block["cache_control"] = json!({"type": "ephemeral", "ttl": "5m"});
            }
            block
        })
        .collect();
    payload["system"] = json!(system_blocks);
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
    let mut usage = ChatTokenUsage::default();
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_anthropic_header_map(api_key, custom_headers, enable_one_m_context)?,
        &payload,
        retry_options,
        executor.label(),
        "anthropic",
        |event| {
            match event.get("type").and_then(Value::as_str) {
                Some("message_start") => {
                    if let Some(start_usage) = event.pointer("/message/usage") {
                        apply_message_start_usage(start_usage, &mut usage);
                    }
                }
                Some("message_delta") => {
                    if let Some(delta_usage) = event.get("usage").filter(|v| v.is_object()) {
                        apply_message_delta_usage(delta_usage, &mut usage);
                    }
                }
                // 非流式完整响应：一次给出输入与输出用量
                _ => {
                    if let Some(full_usage) = event
                        .get("usage")
                        .filter(|_| event.get("content").is_some_and(Value::is_array))
                    {
                        apply_message_start_usage(full_usage, &mut usage);
                        apply_message_delta_usage(full_usage, &mut usage);
                    }
                }
            }
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
        return Ok((AgentRound::Done(text), usage));
    }

    let mut append = vec![json!({"role": "assistant", "content": assistant_blocks})];
    for call in &tool_calls {
        let output = executor
            .execute(&call.name, &call.arguments_json)
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

    Ok((AgentRound::Continue(append), usage))
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

pub(crate) async fn run_gemini_round(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompts: &[String],
    messages: &[Value],
    tools: &[McpTool],
    retry_options: &RetryOptions,
    executor: &dyn AgentToolExecutor,
) -> Result<(AgentRound, ChatTokenUsage)> {
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

    // 与主流程（api/gemini/payload.rs）一致：每条系统提示词各自一个 part。
    let system_parts: Vec<Value> = system_prompts
        .iter()
        .map(|text| json!({"text": text}))
        .collect();
    let payload = json!({
        "systemInstruction": {"parts": system_parts},
        "contents": messages,
        "tools": tools_as_gemini_json(tools),
        "generationConfig": generation_config,
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    // 流式请求（:streamGenerateContent?alt=sse）：合并所有 chunk 的
    // candidates[0].content.parts，还原为等价于非流式响应的 body。
    let mut parts: Vec<Value> = Vec::new();
    let mut usage = ChatTokenUsage::default();
    send_streaming_sse_request(
        &client,
        &endpoint,
        build_gemini_header_map(custom_headers)?,
        &payload,
        retry_options,
        executor.label(),
        "gemini",
        |event| {
            apply_gemini_event_usage(&event, &mut usage);
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
        return Ok((AgentRound::Done(String::new()), usage));
    };
    let Some(candidate) = candidates.first() else {
        return Ok((AgentRound::Done(String::new()), usage));
    };
    let Some(parts) = candidate
        .get("content")
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
    else {
        return Ok((AgentRound::Done(String::new()), usage));
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
        return Ok((AgentRound::Done(text), usage));
    }

    let mut append = vec![json!({"role": "model", "parts": model_parts})];
    for call in &tool_calls {
        let output = executor
            .execute(&call.name, &call.arguments_json)
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

    Ok((AgentRound::Continue(append), usage))
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
