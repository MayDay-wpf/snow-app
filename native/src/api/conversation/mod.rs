use std::path::Path;

use crate::storage::services::chat_conversations::ChatContextMessage;

pub mod context;
pub mod images;
pub mod stream;
pub mod sub_agent;
pub mod tool_messages;

pub use context::{prepare_context_request, PreparedConversationRequest};
pub use images::{parse_chat_message_content, ChatImage, ParsedChatMessageContent};
pub use stream::create_response_stream;
pub use sub_agent::resolve_sub_agent_tools;

pub struct ConversationContextRequest<'a> {
    pub database_path: &'a Path,
    pub conversation_id: Option<&'a str>,
    pub previous_response_id: Option<&'a str>,
    pub messages: &'a [ChatContextMessage],
    pub max_context_tokens: Option<i32>,
    pub directory_id: Option<&'a str>,
    pub context_compaction: bool,
    /// Internal auto-compaction resume mode: the latest `context_compaction`
    /// boundary message already persisted in the database is the current
    /// context (loaded by `load_context_messages`), so the caller-supplied
    /// `messages` are treated as a placeholder and never sent to the API nor
    /// persisted as normal user messages. Prevents the compaction handoff
    /// from being injected twice into the resume request.
    pub resume_after_compaction: bool,
    /// When true, skip loading conversation history and injecting the built-in
    /// system prompt. Used by lightweight single-shot completions such as the
    /// AI commit-message generator.
    pub skip_context: bool,
    /// When true, replace the built-in system prompt with the Plan Mode prompt.
    pub plan_mode: bool,
    /// When true, replace the built-in system prompt with the Goal Mode prompt.
    pub goal_mode: bool,
    /// True when the request belongs to a sub-agent runtime snapshot.
    pub is_sub_agent: bool,
    /// Sub-agent-specific system prompt captured at activation.
    pub sub_agent_system_prompt: Option<&'a str>,
    /// JSON-encoded list of user system prompt IDs configured for the active
    /// API profile. Empty string means "follow the active prompts that apply
    /// to the current workspace";
    /// `__DISABLED__` or an empty array opts out. Resolved into prompt
    /// contents and injected as leading `system` messages, mirroring
    /// Snow CLI's `getCustomSystemPromptForConfig`.
    pub system_prompt_ids_json: &'a str,
    /// Project ROLE.md content for an SSH (`ssh://`) workspace, injected by
    /// the Electron main process (Rust cannot perform SSH I/O). `None` for
    /// local workspaces, where the prompt builder reads the file directly.
    pub remote_role_content: Option<&'a str>,
    pub remote_include_global_rules: Option<bool>,
}
