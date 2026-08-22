//! Google Interactions API SSE event parsing and stream processing.

use std::collections::BTreeMap;

use regex::Regex;
use serde_json::{json, Value};

use crate::api::common::{read_first_i64, truncate_utf8_safe};
use crate::storage::services::chat_conversations::ChatTokenUsage;

const MAX_PROVIDER_FAILURE_CODE_BYTES: usize = 128;
const MAX_PROVIDER_FAILURE_MESSAGE_BYTES: usize = 768;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InteractionsProviderFailure {
    code: Option<String>,
    message: String,
}

impl InteractionsProviderFailure {
    fn from_error_event(event: &Value) -> Self {
        let error = event.get("error").unwrap_or(event);
        let code = error
            .get("code")
            .and_then(provider_error_code)
            .map(|value| bounded_provider_detail(&value, MAX_PROVIDER_FAILURE_CODE_BYTES))
            .filter(|value| !value.is_empty());
        let message = error
            .get("message")
            .or_else(|| event.get("message"))
            .and_then(Value::as_str)
            .map(|value| bounded_provider_detail(value, MAX_PROVIDER_FAILURE_MESSAGE_BYTES))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| String::from("Interactions API request failed"));
        Self { code, message }
    }

    fn failed_status() -> Self {
        Self {
            code: None,
            message: String::from("Interactions API interaction failed"),
        }
    }

    fn from_terminal_event(event: &Value, interaction: &Value) -> Self {
        if event
            .get("error")
            .is_some_and(|provider_error| !provider_error.is_null())
            || event.get("message").and_then(Value::as_str).is_some()
        {
            return Self::from_error_event(event);
        }
        if interaction
            .get("error")
            .is_some_and(|provider_error| !provider_error.is_null())
            || interaction.get("message").and_then(Value::as_str).is_some()
        {
            return Self::from_error_event(interaction);
        }
        Self::failed_status()
    }

    fn invalid_tool_arguments() -> Self {
        Self {
            code: None,
            message: String::from(
                "Interactions API stream ended with incomplete or invalid tool arguments",
            ),
        }
    }

    pub(super) fn reason(&self) -> String {
        match self.code.as_deref() {
            Some(code) => format!("Interactions API error ({code}): {}", self.message),
            None => self.message.clone(),
        }
    }
}

fn provider_error_code(value: &Value) -> Option<String> {
    match value {
        Value::String(code) => Some(code.clone()),
        Value::Number(code) => Some(code.to_string()),
        _ => None,
    }
}

fn bounded_provider_detail(value: &str, max_bytes: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = redact_provider_detail(&normalized);
    if redacted.len() <= max_bytes {
        return redacted;
    }
    let visible = truncate_utf8_safe(&redacted, max_bytes.saturating_sub(3));
    format!("{visible}...")
}

fn redact_provider_detail(value: &str) -> String {
    const PATTERNS: &[(&str, &str)] = &[
        (
            r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}",
            "${1} [REDACTED]",
        ),
        (
            r#"(?i)([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|signature)=)[^&\s\"'<>]+"#,
            "${1}[REDACTED]",
        ),
        (
            r#"(?i)([\"']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|cookie)[\"']?\s*[:=]\s*[\"'])([^\"']*)([\"'])"#,
            "${1}[REDACTED]${3}",
        ),
        (
            r#"(?i)(\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|cookie)\b\s*[:=]\s*)[^\s,;&}\]\"'\[]+"#,
            "${1}[REDACTED]",
        ),
        (
            r#"(?i)((?:^|[,{;]\s*)[\"']?(?:prompt|input|contents?)[\"']?\s*[:=]\s*[\"'])([^\"']*)([\"'])"#,
            "${1}[REDACTED]${3}",
        ),
        (
            r#"(?i)((?:^|[,{;]\s*)[\"']?(?:prompt|input|contents?)[\"']?\s*[:=]\s*)[^,;}\]\"'\[]+"#,
            "${1}[REDACTED]",
        ),
    ];

    PATTERNS
        .iter()
        .fold(value.to_string(), |redacted, (pattern, replacement)| {
            Regex::new(pattern)
                .expect("provider redaction regex")
                .replace_all(&redacted, *replacement)
                .into_owned()
        })
}

pub(super) fn bounded_provider_error_response(value: &str) -> String {
    if let Ok(event) = serde_json::from_str::<Value>(value) {
        return InteractionsProviderFailure::from_error_event(&event).reason();
    }

    let detail = bounded_provider_detail(value, MAX_PROVIDER_FAILURE_MESSAGE_BYTES);
    if detail.is_empty() {
        String::from("Interactions API request failed")
    } else {
        detail
    }
}

#[derive(Debug, Default)]
pub(super) struct InteractionsToolCallState {
    pending_by_index: BTreeMap<u64, PendingToolCall>,
    finalized_by_index: BTreeMap<u64, Value>,
    direct_calls: Vec<Value>,
}

#[derive(Debug, Default)]
struct PendingToolCall {
    metadata: Option<Value>,
    raw_arguments: String,
    arguments_object: Option<Value>,
    stop_arguments_object: Option<Value>,
    saw_empty_arguments_object: bool,
    invalid_arguments: bool,
    stopped: bool,
}

impl InteractionsToolCallState {
    pub(super) fn has_tool_state(&self) -> bool {
        !self.pending_by_index.is_empty()
            || !self.finalized_by_index.is_empty()
            || !self.direct_calls.is_empty()
    }

    pub(super) fn has_pending_tool_fragments(&self) -> bool {
        !self.pending_by_index.is_empty()
    }

    pub(super) fn clear(&mut self) {
        self.pending_by_index.clear();
        self.finalized_by_index.clear();
        self.direct_calls.clear();
    }

    pub(super) fn finalized_tool_calls(&self) -> Vec<Value> {
        let mut calls = self
            .finalized_by_index
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for direct in &self.direct_calls {
            if !calls
                .iter()
                .any(|call| same_tool_call_identity(call, direct))
            {
                calls.push(direct.clone());
            }
        }
        calls
    }

    fn register_step(&mut self, index: u64, step: &Value, stopped: bool) {
        if !is_function_call(step) && !self.pending_by_index.contains_key(&index) {
            return;
        }
        let pending = self.pending_by_index.entry(index).or_default();
        if is_function_call(step) {
            if let Some(metadata) = pending.metadata.as_mut() {
                merge_tool_call_values(metadata, step);
            } else {
                pending.metadata = Some(step.clone());
            }
            observe_arguments(pending, step, stopped);
        }
        pending.stopped |= stopped;
        self.try_finalize(index);
    }

    fn append_arguments(&mut self, index: u64, fragment: &str) {
        if !fragment.is_empty() {
            self.pending_by_index
                .entry(index)
                .or_default()
                .raw_arguments
                .push_str(fragment);
        }
    }

    fn stop_index(&mut self, index: u64) {
        let Some(pending) = self.pending_by_index.get_mut(&index) else {
            return;
        };
        pending.stopped = true;
        self.try_finalize(index);
    }

    fn add_complete_indexed_call(&mut self, index: u64, call: &Value) {
        if let Some(call) = materialize_complete_call(call) {
            self.pending_by_index.remove(&index);
            self.store_finalized_index(index, call);
        } else if is_function_call(call) {
            self.register_step(index, call, true);
        }
    }

    fn add_complete_direct_call(&mut self, call: &Value) {
        let Some(call) = materialize_complete_call(call) else {
            return;
        };
        if let Some(existing) = self
            .direct_calls
            .iter_mut()
            .find(|existing| same_tool_call_identity(existing, &call))
        {
            update_finalized_call(existing, call);
        } else {
            self.direct_calls.push(call);
        }
    }

    fn try_finalize(&mut self, index: u64) {
        let call = self
            .pending_by_index
            .get(&index)
            .and_then(materialize_pending_call);
        if let Some(call) = call {
            self.pending_by_index.remove(&index);
            self.store_finalized_index(index, call);
        }
    }

    fn store_finalized_index(&mut self, index: u64, call: Value) {
        if let Some(existing) = self.finalized_by_index.get_mut(&index) {
            update_finalized_call(existing, call);
        } else {
            self.finalized_by_index.insert(index, call);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn process_interactions_sse_event_block(
    event_block: &str,
    raw_events: &mut Vec<Value>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut InteractionsToolCallState,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
    stream_finished: &mut bool,
    provider_failure: &mut Option<InteractionsProviderFailure>,
) {
    let mut found_data = false;
    let mut sse_event_name: Option<String> = None;

    for line in event_block.lines() {
        let trimmed = line.trim_start();
        if let Some(name) = trimmed.strip_prefix("event:") {
            sse_event_name = Some(name.trim().to_string());
            continue;
        }
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        found_data = true;
        let data = data.trim_start();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            if let Some(failure) = finish_interaction(
                tool_calls,
                response_status,
                stream_finished,
                "completed",
                None,
            ) {
                *provider_failure = Some(failure);
            }
            return;
        }

        let event = match serde_json::from_str::<Value>(data) {
            Ok(event) => event,
            Err(error) => {
                eprintln!("Interactions stream event parse error: {error}");
                continue;
            }
        };
        let result = process_interactions_event(
            &event,
            sse_event_name.as_deref(),
            content_chunks,
            thinking_chunks,
            tool_calls,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
            stream_finished,
        );
        if let Err(failure) = result {
            *response_status = String::from("failed");
            *stream_finished = true;
            tool_calls.clear();
            *provider_failure = Some(failure);
            return;
        }
        raw_events.push(event);
        if *stream_finished {
            return;
        }
    }

    if found_data {
        return;
    }
    let data = event_block.trim();
    if data.is_empty() || data.starts_with(':') {
        return;
    }
    if let Ok(event) = serde_json::from_str::<Value>(data) {
        let result = process_interactions_event(
            &event,
            None,
            content_chunks,
            thinking_chunks,
            tool_calls,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
            stream_finished,
        );
        if let Err(failure) = result {
            *response_status = String::from("failed");
            *stream_finished = true;
            tool_calls.clear();
            *provider_failure = Some(failure);
            return;
        }
        raw_events.push(event);
    }
}

#[allow(clippy::too_many_arguments)]
fn process_interactions_event(
    event: &Value,
    sse_event_name: Option<&str>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut InteractionsToolCallState,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
    stream_finished: &mut bool,
) -> std::result::Result<(), InteractionsProviderFailure> {
    let interaction = event.get("interaction").unwrap_or(event);
    capture_metadata(event, interaction, response_id, response_model);
    if let Some(usage) = event
        .get("usage_metadata")
        .or_else(|| event.get("usage"))
        .or_else(|| interaction.get("usage_metadata"))
        .or_else(|| interaction.get("usage"))
    {
        extract_interactions_token_usage(usage, token_usage);
    }

    let event_type = event_type(event, sse_event_name);
    if event_type == Some("error")
        || event
            .get("error")
            .is_some_and(|provider_error| !provider_error.is_null())
    {
        return Err(InteractionsProviderFailure::from_error_event(event));
    }
    let index = event.get("index").and_then(Value::as_u64);
    match event_type {
        Some("step.start") => {
            if let Some(step) = event.get("step") {
                process_step_content(step, content_chunks, thinking_chunks);
                if let Some(index) = index {
                    tool_calls.register_step(index, step, false);
                }
            }
        }
        Some("step.delta") => process_top_level_delta(
            event,
            index,
            content_chunks,
            thinking_chunks,
            tool_calls,
            tool_args_delta,
        ),
        Some("step.stop") | Some("step.completed") => {
            if let Some(step) = event.get("step") {
                process_step_content(step, content_chunks, thinking_chunks);
                if let Some(index) = index {
                    tool_calls.register_step(index, step, true);
                } else {
                    process_complete_calls(step, tool_calls);
                }
            } else if let Some(index) = index {
                tool_calls.stop_index(index);
            }
        }
        _ => process_compatibility_event(
            event,
            interaction,
            content_chunks,
            thinking_chunks,
            tool_calls,
            tool_args_delta,
        ),
    }

    if let Some(status) = interaction_terminal(event, interaction, sse_event_name) {
        let terminal_failure = (status == "failed")
            .then(|| InteractionsProviderFailure::from_terminal_event(event, interaction));
        if let Some(failure) = finish_interaction(
            tool_calls,
            response_status,
            stream_finished,
            status,
            terminal_failure,
        ) {
            return Err(failure);
        }
    }
    Ok(())
}

fn event_type<'a>(event: &'a Value, sse_event_name: Option<&'a str>) -> Option<&'a str> {
    event
        .get("event_type")
        .and_then(Value::as_str)
        .or_else(|| {
            event.get("type").and_then(Value::as_str).filter(|value| {
                value.starts_with("step.") || value.starts_with("interaction.") || *value == "error"
            })
        })
        .or(sse_event_name)
}

fn terminal_status(status: Option<&str>) -> Option<&str> {
    match status {
        Some("completed") | Some("succeeded") | Some("finished") | Some("requires_action") => {
            Some("completed")
        }
        Some("failed") | Some("error") => Some("failed"),
        Some("cancelled") | Some("canceled") => Some("cancelled"),
        _ => None,
    }
}

fn interaction_terminal<'a>(
    event: &'a Value,
    interaction: &'a Value,
    sse_event_name: Option<&'a str>,
) -> Option<&'a str> {
    match event_type(event, sse_event_name) {
        Some("interaction.completed") | Some("completed") | Some("done") => {
            return Some("completed")
        }
        Some("interaction.failed") | Some("interaction.error") => return Some("failed"),
        Some("interaction.cancelled") | Some("interaction.canceled") => return Some("cancelled"),
        _ => {}
    }

    if event_type(event, sse_event_name) == Some("interaction.status_update") {
        if let Some(status) = terminal_status(event.get("status").and_then(Value::as_str)) {
            return Some(status);
        }
    }

    if event.get("interaction").is_none() && event.get("steps").is_none() {
        return None;
    }
    terminal_status(interaction.get("status").and_then(Value::as_str))
}

fn finish_interaction(
    tool_calls: &mut InteractionsToolCallState,
    response_status: &mut String,
    stream_finished: &mut bool,
    status: &str,
    provider_failure: Option<InteractionsProviderFailure>,
) -> Option<InteractionsProviderFailure> {
    let failure = match status {
        "completed" if tool_calls.has_pending_tool_fragments() => {
            // A terminal with malformed or unfinished arguments is a provider
            // failure, never an executable empty-argument call.
            *response_status = String::from("failed");
            tool_calls.clear();
            Some(InteractionsProviderFailure::invalid_tool_arguments())
        }
        "completed" => {
            *response_status = String::from("completed");
            None
        }
        "cancelled" => {
            *response_status = String::from("cancelled");
            tool_calls.clear();
            None
        }
        _ => {
            *response_status = String::from("failed");
            tool_calls.clear();
            Some(provider_failure.unwrap_or_else(InteractionsProviderFailure::failed_status))
        }
    };
    *stream_finished = true;
    failure
}

fn capture_metadata(
    event: &Value,
    interaction: &Value,
    response_id: &mut String,
    response_model: &mut String,
) {
    if response_id.is_empty() {
        if let Some(id) = event
            .get("interaction_id")
            .or_else(|| interaction.get("id"))
            .or_else(|| event.get("id"))
            .and_then(Value::as_str)
        {
            *response_id = id.to_string();
        }
    }
    if response_model.is_empty() {
        if let Some(model) = event
            .get("model")
            .or_else(|| interaction.get("model"))
            .and_then(Value::as_str)
        {
            *response_model = model.to_string();
        }
    }
}

fn process_top_level_delta(
    event: &Value,
    index: Option<u64>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut InteractionsToolCallState,
    tool_args_delta: &mut String,
) {
    // CLIProxyAPI has emitted both canonical top-level `delta` events and
    // compatibility envelopes with the same delta nested below `step`.
    // Treat both shapes identically; otherwise the step.start placeholder is
    // finalized with `{}` while the real arguments fragment is discarded.
    let delta = event
        .get("delta")
        .or_else(|| event.get("step").and_then(|step| step.get("delta")));
    let Some(delta) = delta else {
        return;
    };
    process_delta_content(delta, "", content_chunks, thinking_chunks);

    let fragment = match delta.get("type").and_then(Value::as_str).unwrap_or("") {
        "arguments_delta" => delta.get("arguments").and_then(Value::as_str),
        "arguments" => delta
            .get("partial_arguments")
            .or_else(|| delta.get("arguments"))
            .and_then(Value::as_str),
        _ => None,
    };
    let index = index.or_else(|| {
        event
            .get("step")
            .and_then(|step| step.get("index"))
            .and_then(Value::as_u64)
    });
    if let (Some(index), Some(fragment)) = (index, fragment) {
        tool_args_delta.push_str(fragment);
        tool_calls.append_arguments(index, fragment);
    }
}

fn process_compatibility_event(
    event: &Value,
    interaction: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut InteractionsToolCallState,
    tool_args_delta: &mut String,
) {
    if let Some(step) = event.get("step") {
        process_step_content(step, content_chunks, thinking_chunks);
        if let Some(index) = event.get("index").and_then(Value::as_u64) {
            if let Some(fragment) = step
                .get("delta")
                .and_then(|delta| {
                    delta
                        .get("arguments")
                        .or_else(|| delta.get("partial_arguments"))
                        .or_else(|| delta.get("args"))
                })
                .and_then(Value::as_str)
            {
                tool_args_delta.push_str(fragment);
                tool_calls.append_arguments(index, fragment);
            }
            let stopped = step_is_complete(step);
            tool_calls.register_step(index, step, stopped);
        } else if step_is_complete(step) {
            process_complete_calls(step, tool_calls);
        }
    } else if let Some(delta) = event.get("delta") {
        process_delta_content(delta, "", content_chunks, thinking_chunks);
    } else if let Some(text) = event.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            content_chunks.push(text.to_string());
        }
    }

    process_steps_array(event, content_chunks, thinking_chunks, tool_calls);
    if event.get("interaction").is_some() {
        process_steps_array(interaction, content_chunks, thinking_chunks, tool_calls);
    }
    process_complete_calls(event, tool_calls);
}

fn step_is_complete(step: &Value) -> bool {
    step.get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "completed" | "succeeded" | "finished"))
        || step
            .get("finish_reason")
            .or_else(|| step.get("finishReason"))
            .and_then(Value::as_str)
            .is_some_and(|reason| !reason.is_empty())
}

fn process_steps_array(
    value: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut InteractionsToolCallState,
) {
    let Some(steps) = value.get("steps").and_then(Value::as_array) else {
        return;
    };
    for (position, step) in steps.iter().enumerate() {
        process_step_content(step, content_chunks, thinking_chunks);
        if is_function_call(step) {
            let index = step
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(position as u64);
            tool_calls.add_complete_indexed_call(index, step);
        }
    }
}

fn process_step_content(
    step: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
) {
    let step_type = step.get("type").and_then(Value::as_str).unwrap_or("");
    if let Some(delta) = step.get("delta") {
        process_delta_content(delta, step_type, content_chunks, thinking_chunks);
    }
    if let Some(text) = step.get("text").and_then(Value::as_str) {
        push_text(text, step_type, content_chunks, thinking_chunks);
    }
    if let Some(thought) = step.get("thought").and_then(Value::as_str) {
        if !thought.is_empty() {
            thinking_chunks.push(thought.to_string());
        }
    }
}

fn process_delta_content(
    delta: &Value,
    step_type: &str,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
) {
    let delta_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
    let effective_step_type = if matches!(delta_type, "thought_summary" | "thought" | "thinking") {
        "thought"
    } else {
        step_type
    };
    if let Some(text) = delta.get("text").and_then(Value::as_str).or_else(|| {
        delta
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
    }) {
        push_text(text, effective_step_type, content_chunks, thinking_chunks);
    }
    if let Some(thought) = delta.get("thought").and_then(Value::as_str) {
        if !thought.is_empty() {
            thinking_chunks.push(thought.to_string());
        }
    }
}

fn push_text(
    text: &str,
    step_type: &str,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
) {
    if text.is_empty() {
        return;
    }
    if matches!(step_type, "thought" | "thinking") {
        thinking_chunks.push(text.to_string());
    } else {
        content_chunks.push(text.to_string());
    }
}

fn process_complete_calls(value: &Value, tool_calls: &mut InteractionsToolCallState) {
    if is_function_call(value) {
        tool_calls.add_complete_direct_call(value);
    }
    if let Some(call) = value
        .get("tool_call")
        .or_else(|| value.get("function_call"))
        .or_else(|| value.get("functionCall"))
    {
        tool_calls.add_complete_direct_call(call);
    }
    if let Some(calls) = value.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            tool_calls.add_complete_direct_call(call);
        }
    }
    if let Some(candidates) = value.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            let Some(parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for part in parts {
                if let Some(call) = part
                    .get("functionCall")
                    .or_else(|| part.get("function_call"))
                {
                    tool_calls.add_complete_direct_call(call);
                }
            }
        }
    }
}

fn is_function_call(value: &Value) -> bool {
    let value_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    matches!(value_type, "function_call" | "tool_call")
        || (tool_call_name(value).is_some() && argument_value(value).is_some())
}

fn observe_arguments(pending: &mut PendingToolCall, call: &Value, stopped: bool) {
    let Some(arguments) = argument_value(call) else {
        return;
    };
    match arguments {
        Value::Object(arguments) => {
            if arguments.is_empty() {
                pending.saw_empty_arguments_object = true;
            } else {
                pending.arguments_object = Some(Value::Object(arguments.clone()));
            }
            if stopped {
                pending.stop_arguments_object = Some(Value::Object(arguments.clone()));
            }
        }
        Value::String(arguments) => {
            if !arguments.is_empty() {
                pending.raw_arguments.push_str(arguments);
            }
        }
        Value::Null => {}
        _ => pending.invalid_arguments = true,
    }
}

fn materialize_pending_call(pending: &PendingToolCall) -> Option<Value> {
    if !pending.stopped || pending.invalid_arguments {
        return None;
    }
    let metadata = pending.metadata.as_ref()?;
    let non_empty_stop_arguments = pending
        .stop_arguments_object
        .clone()
        .filter(|arguments| arguments.as_object().is_some_and(|value| !value.is_empty()));
    let arguments = if let Some(arguments) = non_empty_stop_arguments {
        arguments
    } else if !pending.raw_arguments.is_empty() {
        parse_arguments_object(&pending.raw_arguments)?
    } else if let Some(arguments) = pending.arguments_object.clone() {
        arguments
    } else if let Some(arguments) = pending.stop_arguments_object.clone() {
        arguments
    } else if pending.saw_empty_arguments_object {
        json!({})
    } else {
        return None;
    };
    materialize_call(metadata, arguments)
}

fn materialize_complete_call(call: &Value) -> Option<Value> {
    let arguments = match argument_value(call)? {
        Value::Object(arguments) => Value::Object(arguments.clone()),
        Value::String(arguments) => parse_arguments_object(arguments)?,
        _ => return None,
    };
    materialize_call(call, arguments)
}

fn materialize_call(call: &Value, arguments: Value) -> Option<Value> {
    if !arguments.is_object() {
        return None;
    }
    let mut call = call.as_object().cloned()?;
    let name = tool_call_name(&Value::Object(call.clone()))?.to_string();
    call.insert(
        "type".to_string(),
        Value::String("function_call".to_string()),
    );
    call.insert("name".to_string(), Value::String(name));
    call.insert("arguments".to_string(), arguments.clone());
    call.insert("args".to_string(), arguments);
    Some(Value::Object(call))
}

fn parse_arguments_object(raw: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    value.is_object().then_some(value)
}

fn argument_value(value: &Value) -> Option<&Value> {
    value
        .get("arguments")
        .or_else(|| value.get("args"))
        .or_else(|| value.get("input"))
        .or_else(|| {
            value
                .get("function")
                .and_then(|function| function.get("arguments"))
        })
        .or_else(|| {
            value
                .get("function")
                .and_then(|function| function.get("args"))
        })
        .or_else(|| {
            value
                .get("functionCall")
                .and_then(|function| function.get("arguments"))
        })
        .or_else(|| {
            value
                .get("functionCall")
                .and_then(|function| function.get("args"))
        })
        .or_else(|| {
            value
                .get("function_call")
                .and_then(|function| function.get("arguments"))
        })
        .or_else(|| {
            value
                .get("function_call")
                .and_then(|function| function.get("args"))
        })
}

fn tool_call_id(value: &Value) -> Option<&str> {
    value
        .get("id")
        .or_else(|| value.get("call_id"))
        .or_else(|| value.get("callId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn tool_call_name(value: &Value) -> Option<&str> {
    value
        .get("name")
        .or_else(|| {
            value
                .get("function")
                .and_then(|function| function.get("name"))
        })
        .or_else(|| {
            value
                .get("functionCall")
                .and_then(|function| function.get("name"))
        })
        .or_else(|| {
            value
                .get("function_call")
                .and_then(|function| function.get("name"))
        })
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
}

fn same_tool_call_identity(left: &Value, right: &Value) -> bool {
    match (tool_call_id(left), tool_call_id(right)) {
        (Some(left_id), Some(right_id)) => left_id == right_id,
        (Some(_), None) | (None, Some(_)) => false,
        (None, None) => {
            tool_call_name(left).is_some() && tool_call_name(left) == tool_call_name(right)
        }
    }
}

fn merge_tool_call_values(target: &mut Value, incoming: &Value) {
    let Some(target) = target.as_object_mut() else {
        *target = incoming.clone();
        return;
    };
    let Some(incoming) = incoming.as_object() else {
        return;
    };
    for (key, value) in incoming {
        if key != "arguments" && key != "args" && !value.is_null() {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn update_finalized_call(existing: &mut Value, incoming: Value) {
    let existing_has_arguments = argument_value(existing)
        .and_then(Value::as_object)
        .is_some_and(|arguments| !arguments.is_empty());
    let incoming_has_empty_arguments = argument_value(&incoming)
        .and_then(Value::as_object)
        .is_some_and(serde_json::Map::is_empty);
    if existing_has_arguments && incoming_has_empty_arguments {
        merge_tool_call_values(existing, &incoming);
    } else {
        *existing = incoming;
    }
}

fn extract_interactions_token_usage(usage: &Value, token_usage: &mut ChatTokenUsage) {
    let prompt = read_first_i64(
        usage,
        &[
            &["total_input_tokens"],
            &["prompt_token_count"],
            &["prompt_tokens"],
            &["input_tokens"],
        ],
    );
    if prompt > 0 {
        token_usage.input_tokens = prompt;
    }
    let mut candidates = read_first_i64(
        usage,
        &[
            &["total_output_tokens"],
            &["candidates_token_count"],
            &["completion_tokens"],
            &["output_tokens"],
        ],
    );
    // CLIProxyAPI reports thought and tool-use tokens separately from
    // total_output_tokens. Snow has no dedicated reasoning-token field, so
    // fold them into output usage to preserve the provider's total usage.
    if usage.get("total_output_tokens").is_some() {
        candidates += read_first_i64(usage, &[&["total_thought_tokens"]]);
        candidates += read_first_i64(usage, &[&["total_tool_use_tokens"]]);
    }
    if candidates > 0 {
        token_usage.output_tokens = candidates;
    }
    let cached = read_first_i64(
        usage,
        &[
            &["total_cached_tokens"],
            &["cached_content_token_count"],
            &["cachedContentTokenCount"],
            &["cache_read_input_tokens"],
        ],
    );
    if cached > 0 {
        token_usage.cache_read_input_tokens = cached;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Harness {
        raw: Vec<Value>,
        content: Vec<String>,
        thinking: Vec<String>,
        calls: InteractionsToolCallState,
        id: String,
        model: String,
        status: String,
        usage: ChatTokenUsage,
        args_delta: String,
        finished: bool,
        failure: Option<InteractionsProviderFailure>,
    }

    impl Default for Harness {
        fn default() -> Self {
            Self {
                raw: Vec::new(),
                content: Vec::new(),
                thinking: Vec::new(),
                calls: InteractionsToolCallState::default(),
                id: String::new(),
                model: String::new(),
                status: String::from("in_progress"),
                usage: ChatTokenUsage::default(),
                args_delta: String::new(),
                finished: false,
                failure: None,
            }
        }
    }

    impl Harness {
        fn process(&mut self, block: &str) {
            self.args_delta.clear();
            process_interactions_sse_event_block(
                block,
                &mut self.raw,
                &mut self.content,
                &mut self.thinking,
                &mut self.calls,
                &mut self.id,
                &mut self.model,
                &mut self.status,
                &mut self.usage,
                &mut self.args_delta,
                &mut self.finished,
                &mut self.failure,
            );
        }
    }

    #[test]
    fn parses_text_thought_metadata_and_usage() {
        let mut harness = Harness::default();
        harness.process(
            r#"data: {"id":"inter_1","model":"gemini-test","step":{"type":"text","delta":{"text":"hello","thought":"plan"}},"usage":{"input_tokens":2,"output_tokens":3}}"#,
        );
        assert_eq!(harness.id, "inter_1");
        assert_eq!(harness.model, "gemini-test");
        assert_eq!(harness.content, ["hello"]);
        assert_eq!(harness.thinking, ["plan"]);
        assert_eq!(harness.usage.input_tokens, 2);
        assert_eq!(harness.usage.output_tokens, 3);
    }

    #[test]
    fn parses_cli_proxy_nested_thought_summary_without_mixing_answer_text() {
        let mut harness = Harness::default();
        harness.process(
            r#"event: step.start
data: {"event_type":"step.start","index":0,"step":{"type":"thought"}}"#,
        );
        harness.process(r#"event: step.delta
data: {"event_type":"step.delta","index":0,"delta":{"content":{"text":"reasoning summary","type":"text"},"type":"thought_summary"}}"#);
        harness.process(
            r#"event: step.stop
data: {"event_type":"step.stop","index":0}"#,
        );
        harness.process(
            r#"event: step.start
data: {"event_type":"step.start","index":1,"step":{"type":"model_output"}}"#,
        );
        harness.process(
            r#"event: step.delta
data: {"event_type":"step.delta","index":1,"delta":{"text":"answer","type":"text"}}"#,
        );
        harness.process(
            r#"event: interaction.completed
data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}"#,
        );

        assert!(harness.finished);
        assert_eq!(harness.status, "completed");
        assert_eq!(harness.thinking, ["reasoning summary"]);
        assert_eq!(harness.content, ["answer"]);
    }

    #[test]
    fn parses_cli_proxy_completed_usage_totals() {
        let mut harness = Harness::default();
        harness.process(
            r#"event: interaction.completed
data: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"input_tokens_by_modality":{"text":6},"total_cached_tokens":2,"total_input_tokens":6,"total_output_tokens":1,"total_thought_tokens":95,"total_tokens":104,"total_tool_use_tokens":2}}}"#,
        );

        assert!(harness.finished);
        assert_eq!(harness.status, "completed");
        assert_eq!(harness.usage.input_tokens, 6);
        assert_eq!(harness.usage.output_tokens, 98);
        assert_eq!(harness.usage.cache_read_input_tokens, 2);
        assert_eq!(harness.usage.cache_creation_input_tokens, 0);
    }

    #[test]
    fn preserves_legacy_interactions_usage_aliases() {
        let mut harness = Harness::default();
        harness.process(
            r#"data: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"prompt_tokens":7,"completion_tokens":3,"cache_read_input_tokens":1}}}"#,
        );

        assert_eq!(harness.usage.input_tokens, 7);
        assert_eq!(harness.usage.output_tokens, 3);
        assert_eq!(harness.usage.cache_read_input_tokens, 1);
    }

    #[test]
    fn reconstructs_canonical_split_arguments() {
        let mut harness = Harness::default();
        harness.process(r#"event: step.start
data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_1","name":"filesystem-read","arguments":{}}}"#);
        harness.process(r#"event: step.delta
data: {"event_type":"step.delta","index":0,"delta":{"type":"arguments_delta","arguments":"{\"filePath\":\"D:/Desktop/"}}"#);
        assert_eq!(harness.args_delta, r#"{"filePath":"D:/Desktop/"#);
        harness.process(r#"event: step.delta
data: {"event_type":"step.delta","index":0,"delta":{"type":"arguments_delta","arguments":"code/package.json\"}"}}"#);
        harness.process(
            r#"event: step.stop
data: {"event_type":"step.stop","index":0}"#,
        );
        harness.process(
            r#"event: interaction.completed
data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}"#,
        );

        assert!(harness.finished);
        assert_eq!(harness.status, "completed");
        assert_eq!(
            harness.calls.finalized_tool_calls()[0]["arguments"],
            json!({"filePath": "D:/Desktop/code/package.json"})
        );
    }

    #[test]
    fn reconstructs_arguments_from_nested_step_delta_envelope() {
        let mut harness = Harness::default();
        harness.process(
            r#"event: step.start
data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_nested","name":"bash-terminal-execute","arguments":{}}}"#,
        );
        harness.process(
            r#"event: step.delta
data: {"event_type":"step.delta","step":{"index":0,"delta":{"type":"arguments_delta","arguments":"{\"command\":\"git status --short\"}"}}}"#,
        );
        harness.process(
            r#"event: step.stop
data: {"event_type":"step.stop","index":0}"#,
        );
        harness.process(
            r#"event: interaction.completed
data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}"#,
        );

        assert_eq!(harness.status, "completed");
        assert_eq!(
            harness.calls.finalized_tool_calls()[0]["arguments"],
            json!({"command": "git status --short"})
        );
    }

    #[test]
    fn accumulated_arguments_override_repeated_stop_placeholder() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_1","name":"filesystem-read","arguments":{}}}"#);
        harness.process(r#"data: {"event_type":"step.delta","index":0,"delta":{"type":"arguments_delta","arguments":"{\"filePath\":\"package.json\"}"}}"#);
        harness.process(r#"data: {"event_type":"step.stop","index":0,"step":{"type":"function_call","id":"call_1","name":"filesystem-read","arguments":{}}}"#);
        harness.process(
            r#"data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}"#,
        );

        let calls = harness.calls.finalized_tool_calls();
        assert_eq!(harness.status, "completed");
        assert_eq!(calls[0]["arguments"], json!({"filePath": "package.json"}));
    }

    #[test]
    fn repeated_empty_completed_step_does_not_erase_finalized_arguments() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_1","name":"filesystem-read","arguments":{}}}"#);
        harness.process(r#"data: {"event_type":"step.delta","index":0,"delta":{"type":"arguments_delta","arguments":"{\"filePath\":\"package.json\"}"}}"#);
        harness.process(r#"data: {"event_type":"step.stop","index":0}"#);
        harness.process(r#"data: {"event_type":"step.completed","index":0,"step":{"type":"function_call","id":"call_1","name":"filesystem-read","arguments":{},"status":"completed"}}"#);

        let calls = harness.calls.finalized_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["arguments"], json!({"filePath": "package.json"}));
        assert!(!harness.calls.has_pending_tool_fragments());
    }

    #[test]
    fn complete_compatibility_step_applies_nested_delta_before_finalization() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"index":2,"step":{"type":"function_call","id":"call_compat","name":"filesystem-read","arguments":{},"delta":{"arguments":"{\"filePath\":\"package.json\"}"},"status":"completed"}}"#);

        let calls = harness.calls.finalized_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "call_compat");
        assert_eq!(calls[0]["arguments"], json!({"filePath": "package.json"}));
        assert!(!harness.calls.has_pending_tool_fragments());
    }

    #[test]
    fn isolates_interleaved_indexes_and_supports_alias_delta() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"step.start","index":1,"step":{"type":"function_call","id":"call_todo","name":"todo-todo-manage","arguments":{}}}"#);
        harness.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_read","name":"filesystem-read","arguments":{}}}"#);
        harness.process(r#"data: {"event_type":"step.delta","index":1,"delta":{"type":"arguments_delta","arguments":"{\"action\":\"get\"}"}}"#);
        harness.process(r#"data: {"event_type":"step.delta","index":0,"delta":{"type":"arguments","partial_arguments":"{\"filePath\":\"package.json\"}"}}"#);
        harness.process(r#"data: {"event_type":"step.stop","index":1}"#);
        harness.process(r#"data: {"event_type":"step.stop","index":0}"#);

        let calls = harness.calls.finalized_tool_calls();
        assert_eq!(calls[0]["id"], "call_read");
        assert_eq!(calls[0]["arguments"], json!({"filePath": "package.json"}));
        assert_eq!(calls[1]["id"], "call_todo");
        assert_eq!(calls[1]["arguments"], json!({"action": "get"}));
    }

    #[test]
    fn retains_delta_before_start_for_stable_index() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"step.delta","index":4,"delta":{"type":"arguments_delta","arguments":"{\"action\":\"get\"}"}}"#);
        harness.process(r#"data: {"event_type":"step.start","index":4,"step":{"type":"function_call","id":"call_late","name":"todo-todo-manage","arguments":{}}}"#);
        harness.process(r#"data: {"event_type":"step.stop","index":4}"#);
        assert_eq!(
            harness.calls.finalized_tool_calls()[0]["arguments"],
            json!({"action": "get"})
        );
    }

    #[test]
    fn step_completion_does_not_finish_the_interaction() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_1","name":"filesystem-read","arguments":{}}}"#);
        harness.process(r#"event: step.completed
data: {"event_type":"step.completed","index":0,"step":{"type":"function_call","id":"call_1","name":"filesystem-read","arguments":{"filePath":"package.json"},"status":"completed"}}"#);
        assert!(!harness.finished);
        assert_eq!(harness.status, "in_progress");

        harness.process(
            r#"data: {"event_type":"step.start","index":1,"step":{"type":"text","text":"done"}}"#,
        );
        harness.process(
            r#"data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}"#,
        );
        assert!(harness.finished);
        assert_eq!(harness.content, ["done"]);
    }

    #[test]
    fn indexed_non_function_stop_without_step_does_not_create_tool_state() {
        for event_type in ["step.stop", "step.completed"] {
            let mut harness = Harness::default();
            harness.process(
                r#"data: {"event_type":"step.start","index":0,"step":{"type":"google_search","status":"in_progress"}}"#,
            );
            harness.process(&format!(
                "data: {}",
                json!({"event_type": event_type, "index": 0})
            ));

            assert!(!harness.calls.has_tool_state());
            assert!(!harness.calls.has_pending_tool_fragments());

            harness.process(
                r#"data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}"#,
            );
            assert!(harness.finished);
            assert_eq!(harness.status, "completed");
            assert!(harness.failure.is_none());
        }
    }

    #[test]
    fn malformed_truncated_and_non_object_arguments_never_execute() {
        for arguments in [r#"{"filePath":"package.json"#, "[]"] {
            let mut harness = Harness::default();
            harness.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_bad","name":"filesystem-read","arguments":{}}}"#);
            let event = json!({
                "event_type": "step.delta",
                "index": 0,
                "delta": {"type": "arguments_delta", "arguments": arguments}
            });
            harness.process(&format!("data: {event}"));
            harness.process(r#"data: {"event_type":"step.stop","index":0}"#);
            assert!(harness.calls.has_pending_tool_fragments());
            assert!(harness.calls.finalized_tool_calls().is_empty());

            harness.process(r#"data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}"#);
            assert_eq!(harness.status, "failed");
            assert!(harness.calls.finalized_tool_calls().is_empty());
        }
    }

    #[test]
    fn missing_or_unknown_index_does_not_attach_to_last_call() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_known","name":"filesystem-read","arguments":{}}}"#);
        harness.process(r#"data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\"filePath\":\"wrong\"}"}}"#);
        harness.process(r#"data: {"event_type":"step.delta","index":9,"delta":{"type":"arguments_delta","arguments":"{\"filePath\":\"unknown\"}"}}"#);
        harness.process(r#"data: {"event_type":"step.stop","index":0}"#);
        let finalized = harness.calls.finalized_tool_calls();
        assert_eq!(finalized.len(), 1);
        assert_eq!(finalized[0]["id"], "call_known");
        assert_eq!(finalized[0]["arguments"], json!({}));
        assert!(harness.calls.has_pending_tool_fragments());
    }

    #[test]
    fn parameterless_call_finalizes_with_empty_arguments() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_ping","name":"system-ping","arguments":{}}}"#);
        harness.process(r#"data: {"event_type":"step.stop","index":0}"#);
        let calls = harness.calls.finalized_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["arguments"], json!({}));
    }

    #[test]
    fn direct_steps_and_provider_aliases_remain_supported() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"event_type":"interaction.completed","interaction":{"id":"inter_direct","status":"completed","steps":[{"type":"function_call","id":"call_direct","name":"filesystem-read","arguments":{"filePath":"package.json"}}]}}"#);
        assert_eq!(
            harness.calls.finalized_tool_calls()[0]["arguments"],
            json!({"filePath": "package.json"})
        );

        let mut alias_harness = Harness::default();
        alias_harness.process(r#"data: {"functionCall":{"id":"call_alias","name":"config-get","args":{"action":"get"}}}"#);
        assert_eq!(
            alias_harness.calls.finalized_tool_calls()[0]["arguments"],
            json!({"action": "get"})
        );

        let mut candidate_harness = Harness::default();
        candidate_harness.process(r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"config-get","args":{"action":"get"}}}]}}]}"#);
        assert_eq!(candidate_harness.calls.finalized_tool_calls().len(), 1);
    }

    #[test]
    fn top_level_status_updates_are_authoritative_terminals() {
        let mut completed = Harness::default();
        completed.process(
            r#"data: {"event_type":"interaction.status_update","interaction_id":"inter_complete","status":"completed"}"#,
        );
        assert!(completed.finished);
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.id, "inter_complete");
        assert!(completed.failure.is_none());

        let mut failed = Harness::default();
        failed.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_done","name":"system-ping","arguments":{}}}"#);
        failed.process(r#"data: {"event_type":"step.stop","index":0}"#);
        failed.process(r#"data: {"event_type":"step.delta","index":1,"delta":{"type":"arguments_delta","arguments":"{\"filePath\":\"partial"}}"#);
        failed.process(r#"data: {"event_type":"interaction.status_update","status":"failed","message":"combined tools rejected api_key=status-secret"}"#);
        assert!(failed.finished);
        assert_eq!(failed.status, "failed");
        assert!(!failed.calls.has_tool_state());
        assert_eq!(
            failed
                .failure
                .as_ref()
                .map(InteractionsProviderFailure::reason),
            Some(String::from("combined tools rejected api_key=[REDACTED]"))
        );

        let mut cancelled = Harness::default();
        cancelled.process(r#"data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"call_cancel","name":"system-ping","arguments":{}}}"#);
        cancelled.process(r#"data: {"event_type":"step.stop","index":0}"#);
        cancelled
            .process(r#"data: {"event_type":"interaction.status_update","status":"cancelled"}"#);
        assert!(cancelled.finished);
        assert_eq!(cancelled.status, "cancelled");
        assert!(!cancelled.calls.has_tool_state());
        assert!(cancelled.failure.is_none());
    }

    #[test]
    fn error_event_preserves_only_bounded_code_and_message() {
        let mut harness = Harness::default();
        let long_message = format!("provider failure\n{}", "x".repeat(1_000));
        let event = json!({
            "event_type": "error",
            "error": {
                "code": "INVALID_ARGUMENT",
                "message": long_message,
                "details": {"api_key": "must-not-be-surfaced"}
            }
        });
        harness.process(&format!("data: {event}"));

        assert!(harness.finished);
        assert_eq!(harness.status, "failed");
        assert!(!harness.calls.has_tool_state());
        let reason = harness.failure.as_ref().unwrap().reason();
        assert!(reason.starts_with("Interactions API error (INVALID_ARGUMENT): provider failure "));
        assert!(reason.ends_with("..."));
        assert!(!reason.contains('\n'));
        assert!(!reason.contains("must-not-be-surfaced"));
        assert!(reason.len() < 1_000);
    }

    #[test]
    fn provider_failure_reason_redacts_message_secrets_and_structured_input() {
        let mut harness = Harness::default();
        let event = json!({
            "event_type": "error",
            "error": {
                "code": "api_key=code-secret",
                "message": "request rejected; authorization=auth-secret; prompt=\"private request\"; input=\"private input\"; Bearer bearer-secret",
                "details": {
                    "api_key": "details-secret",
                    "prompt": "details prompt"
                }
            }
        });
        harness.process(&format!("data: {event}"));

        let reason = harness.failure.as_ref().unwrap().reason();
        for secret in [
            "code-secret",
            "auth-secret",
            "private request",
            "private input",
            "bearer-secret",
            "details-secret",
            "details prompt",
        ] {
            assert!(!reason.contains(secret), "provider reason leaked {secret}");
        }
        assert!(reason.contains("[REDACTED]"));
        assert!(!reason.contains("[REDACTED]]"));
    }

    #[test]
    fn http_error_body_extracts_only_a_bounded_redacted_failure() {
        let body = json!({
            "error": {
                "code": "INVALID_ARGUMENT",
                "message": "invalid request api_key=body-secret",
                "details": {
                    "prompt": "private prompt",
                    "input": "private input"
                }
            }
        })
        .to_string();

        let reason = bounded_provider_error_response(&body);
        assert_eq!(
            reason,
            "Interactions API error (INVALID_ARGUMENT): invalid request api_key=[REDACTED]"
        );
        assert!(!reason.contains("body-secret"));
        assert!(!reason.contains("private prompt"));
        assert!(!reason.contains("private input"));
    }

    #[test]
    fn null_error_field_does_not_override_a_completed_terminal() {
        let mut harness = Harness::default();
        harness.process(
            r#"data: {"event_type":"interaction.status_update","status":"completed","error":null}"#,
        );

        assert!(harness.finished);
        assert_eq!(harness.status, "completed");
        assert!(harness.failure.is_none());
    }

    #[test]
    fn nested_terminal_status_and_error_event_name_alias_remain_supported() {
        let mut nested = Harness::default();
        nested.process(
            r#"data: {"interaction":{"id":"inter_nested","status":"completed"},"steps":[]}"#,
        );
        assert!(nested.finished);
        assert_eq!(nested.status, "completed");

        let mut nested_failed = Harness::default();
        nested_failed.process(r#"data: {"interaction":{"id":"inter_failed","status":"failed","error":{"code":"FAILED_PRECONDITION","message":"provider rejected token=nested-secret"}}}"#);
        assert!(nested_failed.finished);
        assert_eq!(nested_failed.status, "failed");
        assert_eq!(
            nested_failed
                .failure
                .as_ref()
                .map(InteractionsProviderFailure::reason),
            Some(String::from(
                "Interactions API error (FAILED_PRECONDITION): provider rejected token=[REDACTED]"
            ))
        );

        let mut error_alias = Harness::default();
        error_alias.process(
            r#"event: error
data: {"code":503,"message":"provider unavailable"}"#,
        );
        assert!(error_alias.finished);
        assert_eq!(error_alias.status, "failed");
        assert_eq!(
            error_alias
                .failure
                .as_ref()
                .map(InteractionsProviderFailure::reason),
            Some(String::from(
                "Interactions API error (503): provider unavailable"
            ))
        );
    }

    #[test]
    fn distinct_ids_preserve_repeated_calls_to_the_same_function() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"tool_calls":[{"id":"call_first","name":"filesystem-read","arguments":{"filePath":"one.txt"}},{"id":"call_second","name":"filesystem-read","arguments":{"filePath":"two.txt"}}]}"#);

        let calls = harness.calls.finalized_tool_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "call_first");
        assert_eq!(calls[0]["arguments"], json!({"filePath": "one.txt"}));
        assert_eq!(calls[1]["id"], "call_second");
        assert_eq!(calls[1]["arguments"], json!({"filePath": "two.txt"}));
    }

    #[test]
    fn an_id_less_call_does_not_merge_with_a_provider_identified_call() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"tool_calls":[{"id":"call_identified","name":"filesystem-read","arguments":{"filePath":"one.txt"}},{"name":"filesystem-read","arguments":{"filePath":"two.txt"}}]}"#);

        let calls = harness.calls.finalized_tool_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "call_identified");
        assert_eq!(calls[0]["arguments"], json!({"filePath": "one.txt"}));
        assert_eq!(calls[1]["arguments"], json!({"filePath": "two.txt"}));
    }

    #[test]
    fn complete_steps_envelope_preserves_text_thinking_and_terminal_status() {
        let mut harness = Harness::default();
        harness.process(r#"data: {"id":"inter_direct","status":"completed","steps":[{"type":"thought","text":"plan"},{"type":"text","text":"answer"}]}"#);

        assert!(harness.finished);
        assert_eq!(harness.status, "completed");
        assert_eq!(harness.thinking, ["plan"]);
        assert_eq!(harness.content, ["answer"]);
    }

    #[test]
    fn cancellation_and_attempt_reset_clear_all_tool_state() {
        let mut state = InteractionsToolCallState::default();
        state.register_step(
            0,
            &json!({
                "type": "function_call",
                "id": "call_done",
                "name": "system-ping",
                "arguments": {}
            }),
            true,
        );
        state.append_arguments(1, r#"{"filePath":"partial"#);
        assert!(state.has_tool_state());
        assert!(state.has_pending_tool_fragments());

        state.clear();
        assert!(!state.has_tool_state());
        assert!(!state.has_pending_tool_fragments());
        assert!(state.finalized_tool_calls().is_empty());
    }
}
