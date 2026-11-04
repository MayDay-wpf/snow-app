use std::path::Path;

use crate::storage::services::chat_conversations::ChatContextMessage;

pub mod context;
mod history_trim;
pub mod image_optimize;
pub mod images;
pub mod stream;
pub mod sub_agent;
mod sub_agent_ledger;
pub mod tags;
pub mod tail_guard;
pub mod tool_messages;

pub use context::{prepare_context_request, PreparedConversationRequest};
pub use images::ChatImage;
pub use stream::create_response_stream;
pub use sub_agent::{resolve_request_tools, resolve_request_tools_optional, should_resolve_tools};
pub use tags::{parse_chat_message_content, ParsedChatMessageContent};

pub struct ConversationContextRequest<'a> {
    pub database_path: &'a Path,
    pub conversation_id: Option<&'a str>,
    pub previous_response_id: Option<&'a str>,
    pub messages: &'a [ChatContextMessage],
    pub directory_id: Option<&'a str>,
    /// Optional actual analysis worktree; does not change configuration scope.
    pub analysis_workspace_root: Option<&'a str>,
    /// Final request tools, after project switches and sub-agent whitelist.
    /// Empty when tools are disabled or compaction is active; discovery failures propagate.
    pub allowed_tools: &'a [crate::mcp::tools::McpTool],
    pub context_compaction: bool,
    /// Internal auto-compaction resume mode: the latest `context_compaction`
    /// boundary message already persisted in the database is the current
    /// context (loaded by `load_context_messages`), so the caller-supplied
    /// FIRST `messages` entry is a handoff placeholder and is never sent to
    /// the API nor persisted as a normal user message. Entries after the
    /// placeholder are protected messages (the last user task message
    /// captured before compaction): they are injected into the request and
    /// persisted as normal user messages so the AI never forgets the task.
    /// Prevents the compaction handoff from being injected twice into the
    /// resume request.
    pub resume_after_compaction: bool,
    /// 重试失败回合（子代理「重试」）：该回合的上下文已在库内，允许空请求消息。
    pub retry_failed_response: bool,
    /// When true, skip loading conversation history and injecting the built-in
    /// system prompt. Used by lightweight single-shot completions such as the
    /// AI commit-message generator.
    pub skip_context: bool,
    /// When true, replace the built-in system prompt with the Goal Mode prompt.
    pub goal_mode: bool,
    /// When true, replace the built-in system prompt with the WorkTree prompt.
    pub worktree_mode: bool,
    /// When true, replace the built-in system prompt with the WorkFlow prompt.
    pub workflow_mode: bool,
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
    /// SSH workspace counterpart of the local `role.overrideRoleIds` switch
    /// ("override built-in prompt"), resolved by the Electron main process.
    pub remote_override_builtin_prompt: Option<bool>,
    /// Explicit effective workspace execution root (e.g. worktree directory path).
    pub execution_workspace_root: Option<&'a str>,
    /// Selected or preselected worktree ID for the conversation.
    pub worktree_id: Option<&'a str>,
}
