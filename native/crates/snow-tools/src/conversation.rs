//! 会话请求契约：providers 与上层编排共享的请求/准备结果类型。

use std::path::Path;

use crate::contract::McpTool;
use snow_storage::chat_conversations::{ChatContextMessage, ContextFoldRecord};

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
    pub allowed_tools: &'a [McpTool],
    pub context_compaction: bool,
    /// 与 `context_compaction` 同时为 true：分层增量压缩（只折叠较早的消息区间）。
    pub context_fold: bool,
    /// Internal auto-compaction resume mode: the persisted compaction boundary is
    /// the current context; the first caller message is a handoff placeholder.
    pub resume_after_compaction: bool,
    /// 重试失败回合（子代理「重试」）：该回合的上下文已在库内，允许空请求消息。
    pub retry_failed_response: bool,
    /// Skip loading conversation history and the built-in system prompt.
    pub skip_context: bool,
    pub goal_mode: bool,
    pub worktree_mode: bool,
    pub workflow_mode: bool,
    /// True when the request belongs to a sub-agent runtime snapshot.
    pub is_sub_agent: bool,
    pub sub_agent_system_prompt: Option<&'a str>,
    /// JSON-encoded user system prompt ids for the active API profile.
    pub system_prompt_ids_json: &'a str,
    pub remote_role_content: Option<&'a str>,
    pub remote_include_global_rules: Option<bool>,
    pub remote_override_builtin_prompt: Option<bool>,
    /// Explicit effective workspace execution root (e.g. worktree directory path).
    pub execution_workspace_root: Option<&'a str>,
    /// Selected or preselected worktree ID for the conversation.
    pub worktree_id: Option<&'a str>,
}

pub struct PreparedConversationRequest {
    pub conversation_id: String,
    pub messages: Vec<ChatContextMessage>,
    pub current_messages: Vec<ChatContextMessage>,
    /// User-configured system prompt contents resolved from
    /// `system_prompt_ids_json`; providers use this to decide whether the
    /// built-in prompt stays in the system slot or is demoted to a leading
    /// `user` message.
    pub user_system_prompts: Vec<String>,
    /// Request-scoped host facts appended to a provider's system slot.
    pub host_system_prompts: Vec<String>,
    /// 分层增量压缩请求的折叠信息，随压缩结果落库；其它请求为 None。
    pub context_fold: Option<ContextFoldRecord>,
}
