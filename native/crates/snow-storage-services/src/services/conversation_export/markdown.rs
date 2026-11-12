use super::super::super::{ChatConversationRecord, ChatMessageRecord};
use super::{display_title, normalize_role, role_label};

// ============================================================================
// Markdown
// ============================================================================

pub(crate) fn render_markdown(
    conversation: &ChatConversationRecord,
    messages: &[ChatMessageRecord],
) -> String {
    let title = display_title(conversation);
    let mut output = String::new();

    output.push_str(&format!("# {title}\n\n"));
    output.push_str(&format!(
        "- **Model**: {}\n",
        if conversation.model.is_empty() {
            "N/A"
        } else {
            &conversation.model
        }
    ));
    output.push_str(&format!("- **Created**: {}\n", conversation.created_at));
    output.push_str(&format!("- **Updated**: {}\n", conversation.updated_at));
    output.push_str(&format!("- **Messages**: {}\n\n", messages.len()));
    output.push_str("---\n\n");

    for message in messages {
        let role = normalize_role(&message.role);
        let label = role_label(&role);
        output.push_str(&format!("## {label}\n\n"));

        if !message.content.is_empty() {
            output.push_str(&message.content);
            output.push_str("\n\n");
        }

        if !message.thinking.is_empty() {
            output.push_str("<details>\n<summary>Thinking</summary>\n\n");
            output.push_str(&message.thinking);
            output.push_str("\n\n</details>\n\n");
        }

        if !message.tool_calls_json.is_empty()
            && message.tool_calls_json != "[]"
            && message.tool_calls_json != "null"
        {
            output.push_str("<details>\n<summary>Tool calls</summary>\n\n");
            output.push_str("```json\n");
            output.push_str(&message.tool_calls_json);
            output.push_str("\n```\n\n</details>\n\n");
        }
    }

    output
}
