//! Outbound request tail guard shared by the chat and gemini protocols.
//!
//! Gemini rejects a request whose final turn is a model turn
//! (`Requests ending with a model turn are not supported.`), and relays that
//! translate OpenAI-style payloads inherit that rule. The guard keeps every
//! outbound payload ending on a user turn.

use serde_json::{json, Value};

/// Neutral continuation turn appended when the payload would otherwise end
/// with a model turn. The trailing model turn already carries the model's own
/// text, so the request asks it to continue from there.
pub const CONTINUATION_TEXT: &str = "Continue.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TailGuardOutcome {
    /// Model turns dropped because they carried no visible text.
    pub dropped_model_turns: usize,
    /// Whether a continuation user turn was appended.
    pub appended_user: bool,
}

impl TailGuardOutcome {
    pub fn fired(&self) -> bool {
        self.dropped_model_turns > 0 || self.appended_user
    }
}

/// Guard an OpenAI-shaped chat payload (`messages`) in place.
pub fn guard_chat_payload(payload: &mut Value) -> TailGuardOutcome {
    guard_payload(
        payload,
        "messages",
        "assistant",
        json!({ "role": "user", "content": CONTINUATION_TEXT }),
    )
}

/// Guard a Gemini-shaped payload (`contents`) in place.
pub fn guard_gemini_payload(payload: &mut Value) -> TailGuardOutcome {
    guard_payload(
        payload,
        "contents",
        "model",
        json!({ "role": "user", "parts": [{ "text": CONTINUATION_TEXT }] }),
    )
}

fn guard_payload(
    payload: &mut Value,
    field: &str,
    model_role: &str,
    continuation: Value,
) -> TailGuardOutcome {
    let Some(messages) = payload.get_mut(field).and_then(Value::as_array_mut) else {
        return TailGuardOutcome::default();
    };

    let mut outcome = TailGuardOutcome::default();
    while messages
        .last()
        .is_some_and(|message| is_model_turn(message, model_role) && !has_visible_text(message))
    {
        messages.pop();
        outcome.dropped_model_turns += 1;
    }

    if messages
        .last()
        .is_some_and(|message| is_model_turn(message, model_role))
    {
        messages.push(continuation);
        outcome.appended_user = true;
    }

    outcome
}

fn is_model_turn(message: &Value, model_role: &str) -> bool {
    message.get("role").and_then(Value::as_str) == Some(model_role)
}

/// Whether a turn carries text a user or model would see. `content` covers the
/// OpenAI shape (string or multimodal parts), `parts` the Gemini shape.
fn has_visible_text(message: &Value) -> bool {
    if let Some(content) = message.get("content") {
        if content.is_string() {
            return !content.as_str().unwrap_or("").trim().is_empty();
        }
        if content.as_array().is_some_and(|parts| parts_have_visible_text(parts)) {
            return true;
        }
    }
    message
        .get("parts")
        .and_then(Value::as_array)
        .is_some_and(|parts| parts_have_visible_text(parts))
}

fn parts_have_visible_text(parts: &[Value]) -> bool {
    parts.iter().any(|part| {
        part.get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    })
}
