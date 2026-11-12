use napi::bindgen_prelude::*;

use super::super::super::{ChatConversationRecord, ChatMessageRecord};

// ============================================================================
// CSV
// ============================================================================

pub(crate) fn render_csv(
    _conversation: &ChatConversationRecord,
    messages: &[ChatMessageRecord],
) -> Result<String> {
    let mut writer = csv::Writer::from_writer(vec![]);

    // CSV header
    writer
        .write_record(&[
            "id",
            "role",
            "origin",
            "content",
            "thinking",
            "status",
            "model",
            "response_id",
            "checkpoint_id",
            "tool_calls_json",
            "created_at",
        ])
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write CSV header: {error}"),
            )
        })?;

    for message in messages {
        writer
            .write_record(&[
                &message.id,
                &message.role,
                &message.origin,
                &message.content,
                &message.thinking,
                &message.status,
                &message.model,
                &message.response_id,
                &message.checkpoint_id,
                &message.tool_calls_json,
                &message.created_at,
            ])
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to write CSV row: {error}"),
                )
            })?;
    }

    let bytes = writer.into_inner().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to finalize CSV: {error}"),
        )
    })?;

    String::from_utf8(bytes).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("CSV output is not valid UTF-8: {error}"),
        )
    })
}
