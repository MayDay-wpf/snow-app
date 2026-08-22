use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;

use crate::prompt::goal_mode_system_prompt::build_goal_mode_system_prompt;
use crate::prompt::plan_mode_system_prompt::build_plan_mode_system_prompt;
use crate::prompt::system_prompt::build_system_prompt;
use crate::prompt::worktree_mode_system_prompt::build_worktree_mode_system_prompt;
use crate::storage::services::chat_conversations::{
    get_conversation_modes, load_context_messages, resolve_conversation_id, ChatContextMessage,
};
use crate::storage::services::sub_agent_configs::list_sub_agent_configs;
use crate::storage::services::system_prompts::resolve_active_system_prompt_contents;
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::services::workspace_directories::get_workspace_directory_path;
use crate::storage::SubAgentConfigRecord;

use super::tool_messages::ensure_tool_pairing;
use super::{images::persist_inline_images_to_disk, ConversationContextRequest};

pub struct PreparedConversationRequest {
    pub conversation_id: String,
    pub messages: Vec<ChatContextMessage>,
    pub current_messages: Vec<ChatContextMessage>,
    /// User-configured system prompt contents resolved from
    /// `system_prompt_ids_json`. Providers use this to decide whether to
    /// keep the built-in system prompt as a `system` message or demote it
    /// to a `user` message (matching Snow CLI PR #127): when non-empty, the
    /// user prompts occupy the `system` slot exclusively and the built-in
    /// prompt is prepended as a leading `user` message.
    pub user_system_prompts: Vec<String>,
}

/// 子代理默认携带的队友通信能力说明，追加到每个子代理系统提示词末尾，
/// 让子代理知道它可以用 sub-agents-listTeammates / sub-agents-sendMessage
/// 与同一会话的队友协作。放置在所有用户配置的提示词之后，作为最终
/// 权威规则（且不受用户是否配置 systemPrompt 影响）。
const SUB_AGENT_COMMS_PROMPT_SECTION: &str = r#"## Teammate Communication

You automatically carry two teammate communication tools scoped to the CURRENT conversation session:
- `sub-agents-listTeammates`: query the sub-agents currently running in the same session. Returns the `conversationId`, `agentId` and `agentName` of each online teammate (you are excluded).
- `sub-agents-sendMessage`: send a message to a teammate that is still running. The message is delivered as a Pending message and the target receives it automatically at the end of its current round; the queued text is prefixed with your identity (name + conversationId) so the recipient always knows where it came from.

Rules:
- Session isolation: only sub-agents spawned by the SAME parent conversation are visible or reachable. Teammates from other conversations are never exposed, and cross-session sends are rejected — do not try to guess other conversations' ids.
- Only send to teammates that are still running: `sub-agents-listTeammates` returns only running teammates, and sending to a finished teammate fails with an error.
- Use these tools to coordinate with parallel teammates (share partial findings, request input, or hand off follow-up work) when the task benefits from collaboration. Prefer concise, essential information over full context dumps."#;

pub(crate) fn compose_sub_agent_system_prompts(
    builtin: &str,
    api_prompts: &[String],
    sub_agent_prompt: Option<&str>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let candidates = std::iter::once(builtin)
        .chain(api_prompts.iter().map(String::as_str))
        .chain(sub_agent_prompt)
        .chain(std::iter::once(SUB_AGENT_COMMS_PROMPT_SECTION));

    candidates
        .filter_map(|prompt| {
            let normalized = prompt.trim();
            if normalized.is_empty() || !seen.insert(normalized.to_string()) {
                None
            } else {
                Some(normalized.to_string())
            }
        })
        .collect()
}

/// Renders the markdown list of currently usable sub-agents for injection into
/// the system prompt, so the model picks a real `agentId` from the `subAgents`
/// config instead of defaulting to `agent_general`.
///
/// Scope resolution mirrors activation: project-scoped sub-agents whose
/// `project_id` equals the conversation's `directory_id` come first and, on a
/// same `agentId`, override the global one (fallback chain: project → global).
/// Built-in + global agents are always included; sub-agents of other projects
/// are excluded. Returns an empty string when the list is empty or the
/// database query fails (the caller then keeps the built-in fallback rules).
fn build_sub_agents_section(database_path: &Path, directory_id: Option<&str>) -> String {
    let current_project = directory_id.map(str::trim).unwrap_or("").to_string();
    match list_sub_agent_configs(database_path, None) {
        Ok(configs) => {
            // 项目级优先、全局兜底：同 agentId 时项目级覆盖全局（与激活时一致）。
            let mut project_agents: Vec<&SubAgentConfigRecord> = Vec::new();
            let mut global_agents: Vec<&SubAgentConfigRecord> = Vec::new();
            for config in configs.iter() {
                if config.project_id.is_empty() {
                    global_agents.push(config);
                } else if !current_project.is_empty() && config.project_id == current_project {
                    project_agents.push(config);
                }
            }

            let mut rendered: Vec<String> = Vec::new();
            let mut seen: HashSet<&str> = HashSet::new();
            for config in project_agents.iter().chain(global_agents.iter()) {
                if !seen.insert(config.agent_id.as_str()) {
                    continue;
                }
                let mut line = format!("- `{}` — {}", config.agent_id.trim(), config.name.trim());
                if !config.description.trim().is_empty() {
                    line.push_str(&format!(": {}", config.description.trim()));
                }
                let scope_tag = if config.builtin {
                    " (built-in)"
                } else if config.project_id.is_empty() {
                    " (global)"
                } else {
                    " (project)"
                };
                line.push_str(scope_tag);
                rendered.push(line);
            }
            rendered.join("\n")
        }
        Err(_) => String::new(),
    }
}

pub async fn prepare_context_request(
    request: ConversationContextRequest<'_>,
) -> Result<PreparedConversationRequest> {
    let mut current_messages = if request.resume_after_compaction {
        // Resume after auto-compaction: the handoff is already persisted as
        // the latest `context_compaction` boundary message and will be loaded
        // by `load_context_messages` below. The caller's FIRST message is the
        // handoff placeholder and must NOT be injected here — re-adding the
        // same summary would duplicate the handoff in the request payload and
        // cause a redundant copy to be persisted as a normal user message by
        // `store_chat_exchange`. Messages after the placeholder are protected
        // messages (the last user task message captured before compaction):
        // they are injected into the request and persisted as normal user
        // messages so the AI never forgets the task after compaction.
        normalize_messages(request.messages)
            .into_iter()
            .skip(1)
            .collect()
    } else if request.context_compaction {
        let handoff_prompt = if request.worktree_mode {
            "Create a durable context handoff for the next assistant. You are in WorkTree Mode and the context window was exceeded. Preserve the original request branch, the confirmed repository status, the selected development branch or worktree, completed file changes, pending changes, build status, commit status, and the exact next Git-safe steps. Output ONLY the handoff document in Markdown. Do not call tools, address the user, or declare the work complete."
        } else if request.goal_mode {
            "Create a durable context handoff for the next assistant. You are in Goal Mode and the context window was exceeded, so this handoff MUST preserve the goal so work continues seamlessly.\n\nOutput ONLY the handoff document in Markdown. It MUST include ALL of the following sections:\n\n## Original Goal\nReproduce the user's original goal verbatim. This is the single most important piece of information — do not paraphrase or abbreviate it.\n\n## Success Criteria\nList every success criterion that defines goal completion. Mark each as [MET], [UNMET], or [UNCERTAIN] with brief evidence.\n\n## Completed Work\nBullet list of changes made so far, with exact file paths and function/symbol names.\n\n## Current State\nWhat the codebase looks like right now after your changes. What builds, what does not, what tests pass or fail.\n\n## Pending Tasks\nWhat remains to be done to achieve the goal, ordered by priority.\n\n## Key Decisions & Constraints\nArchitecture choices, constraints discovered, non-regression boundaries that must be respected.\n\n## Token Budget Status\nHow much of the token budget has been consumed (estimate), and how much remains.\n\n## Next Steps\nThe concrete next 1-3 actions the next assistant should take to continue toward the goal.\n\nRules:\n- Do NOT call tools.\n- Do NOT address the user conversationally.\n- Do NOT declare the goal complete — only the next assistant can do that after verifying.\n- Be concise but never omit information required to continue the work correctly."
        } else {
            "Create a durable context handoff for the next assistant. Output only the handoff document in Markdown. Preserve concrete objectives, user requirements, decisions, architecture constraints, relevant files and symbols, completed changes, current state, pending tasks, exact commands or errors, edge cases, and the next recommended steps. Be concise but do not omit information required to continue the work correctly. Do not call tools and do not address the user conversationally."
        };
        vec![ChatContextMessage {
            role: "user".to_string(),
            content: handoff_prompt.to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        }]
    } else {
        normalize_messages(request.messages)
    };
    for message in &mut current_messages {
        message.content = persist_inline_images_to_disk(&message.content, request.database_path)?;
    }
    if current_messages.is_empty() && !request.resume_after_compaction {
        return Err(Error::from_reason("Chat message content is required"));
    }

    // --- Lightweight mode: skip history loading and system-prompt injection ---
    if request.skip_context {
        ensure_tool_pairing(&mut current_messages);
        return Ok(PreparedConversationRequest {
            conversation_id: String::new(),
            messages: current_messages.clone(),
            current_messages,
            user_system_prompts: Vec::new(),
        });
    }

    let conversation_id = resolve_conversation_id(
        request.database_path,
        request.conversation_id,
        request.previous_response_id,
    )?;
    let mut messages = load_context_messages(request.database_path, &conversation_id)?;

    // Resolve user-configured system prompts (mirrors Snow CLI's
    // `getCustomSystemPromptForConfig`). They are NOT injected into
    // `messages` here; instead they are returned via
    // `PreparedConversationRequest.user_system_prompts` so each provider
    // can decide how to combine them with the built-in system prompt
    // (e.g. Anthropic demotes the built-in prompt to a user message when
    // user prompts are present, matching Snow CLI PR #127).
    let user_system_prompts = resolve_active_system_prompt_contents(
        request.database_path,
        request.system_prompt_ids_json,
        request.directory_id,
    );

    // Inject the built-in system prompt as the first message.
    let working_directory = request
        .directory_id
        .and_then(|id| {
            get_workspace_directory_path(request.database_path, id)
                .ok()
                .flatten()
        })
        .unwrap_or_default();

    // Plan Mode: replace the built-in system prompt with the Plan Mode prompt
    // that instructs the AI to analyze, plan, and get user approval before
    // executing any changes.
    let shell_type = resolve_default_shell(request.database_path);
    let sub_agents_section = build_sub_agents_section(request.database_path, request.directory_id);
    let system_prompt = if request.worktree_mode {
        build_worktree_mode_system_prompt(
            &working_directory,
            &shell_type,
            request.remote_role_content,
            request.remote_include_global_rules,
            &sub_agents_section,
        )
    } else if request.plan_mode {
        build_plan_mode_system_prompt(
            &working_directory,
            &shell_type,
            request.remote_role_content,
            request.remote_include_global_rules,
            &sub_agents_section,
        )
    } else if request.goal_mode {
        // Per-conversation budget isolation: the conversation's own override
        // wins; conversations without one use the built-in default.
        let goal_token_budget = if !conversation_id.is_empty() {
            get_conversation_modes(request.database_path, &conversation_id)
                .ok()
                .and_then(|modes| modes.goal_mode_token_budget)
                .unwrap_or(2000000)
        } else {
            2000000
        };
        build_goal_mode_system_prompt(
            &working_directory,
            &shell_type,
            goal_token_budget,
            request.remote_role_content,
            request.remote_include_global_rules,
        )
    } else {
        build_system_prompt(
            &working_directory,
            &shell_type,
            request.remote_role_content,
            request.remote_include_global_rules,
            &sub_agents_section,
        )
    };
    // LSP 优先指引（2026-08-15，方案 B）：项目启用了可用的外部 LSP 服务器
    // 时，在系统提示词末尾注入「Language Servers」章节（列出服务器及其
    // 会话运行状态，按合并能力分组指引优先使用 lsp-* 工具分析/搜索代码）。
    // 查询失败返回空字符串（静默降级，不打断请求）。追加在末尾：会话状态
    // 变化（installed → running）只影响提示词尾部，最小化 prompt cache
    // 前缀失效范围。普通 / Plan / Goal 三种模式统一注入。
    let lsp_section = crate::mcp::servers::lsp::build_system_prompt_section(
        request.directory_id,
        if working_directory.trim().is_empty() {
            None
        } else {
            Some(std::path::Path::new(&working_directory))
        },
    )
    .await;
    let system_prompt = if lsp_section.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n{lsp_section}")
    };
    // Image Generation 指引（2026-08-16，仿 LSP 方案 B）：配置了生图渠道且
    // 域 scope 允许时，在系统提示词末尾追加「Image Generation」章节，引导
    // 并行多次调用是唯一多图路径（≥2 个并行调用由 UI 自动合并为
    // ImageGenGallery 统一网格）。查询失败返回空字符串（静默降级，不打断
    // 请求）。追加在末尾：与 LSP 章节同理，最小化 prompt cache 前缀失效
    // 范围。普通 / Plan / Goal 三种模式统一注入。
    let imagegen_section =
        crate::mcp::servers::imagegen::build_system_prompt_section(request.directory_id).await;
    let system_prompt = if imagegen_section.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n{imagegen_section}")
    };
    let user_system_prompts = if request.is_sub_agent {
        compose_sub_agent_system_prompts(
            &system_prompt,
            &user_system_prompts,
            request.sub_agent_system_prompt,
        )
    } else {
        user_system_prompts
    };

    // Main conversations retain the existing provider-specific built-in prompt
    // behavior. Sub-agents pass the unified ordered prompt list directly to
    // providers, so inserting the built-in system message again would duplicate
    // Snow's protocol.
    if !request.is_sub_agent {
        let has_existing_system = messages
            .iter()
            .any(|msg| msg.role.trim() == "system" || msg.role.trim() == "developer");

        if !has_existing_system {
            messages.insert(
                0,
                ChatContextMessage {
                    role: "system".to_string(),
                    content: system_prompt,
                    tool_calls_json: None,
                    tool_results_json: None,
                    thinking: None,
                    thinking_blocks_json: None,
                },
            );
        }
    }

    // --- Conversation context attachments: 历史会话引用以 `@@conversation:`
    //     标签随用户消息内容进入请求，由各 provider 的 payload 构建层经
    //     parse_chat_message_content 展开为渲染后的上下文块（见 images.rs）。 ---

    messages.extend(current_messages.iter().cloned());

    // --- Tool-pairing guard: ensure no orphan tool calls or results reach the
    //     AI API, which would reject the request outright. ---
    ensure_tool_pairing(&mut messages);

    Ok(PreparedConversationRequest {
        conversation_id,
        messages,
        current_messages,
        user_system_prompts,
    })
}

fn normalize_messages(messages: &[ChatContextMessage]) -> Vec<ChatContextMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let content = message.content.trim();
            let role = message.role.trim();
            let has_structured_tool_data = match role {
                "assistant" => message
                    .tool_calls_json
                    .as_deref()
                    .is_some_and(has_json_entries),
                "tool" => message
                    .tool_results_json
                    .as_deref()
                    .is_some_and(has_json_entries),
                _ => false,
            };
            if content.is_empty() && !has_structured_tool_data {
                return None;
            }

            Some(ChatContextMessage {
                role: role.to_string(),
                content: content.to_string(),
                tool_calls_json: message.tool_calls_json.clone(),
                tool_results_json: message.tool_results_json.clone(),
                thinking: message.thinking.clone(),
                thinking_blocks_json: message.thinking_blocks_json.clone(),
            })
        })
        .collect()
}

fn has_json_entries(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.as_array().map(|entries| !entries.is_empty()))
        .unwrap_or(false)
}

/// Read the user's configured default shell type from the terminal settings
/// stored in the database. The shell type is derived from the configured
/// `shellPath` (e.g. "powershell", "cmd", "gitbash", "wsl", "posix") or an
/// empty string when unavailable.
///
/// The environment described in the system prompt must follow the terminal
/// settings rather than the local OS: the working directory can be a remote
/// SSH location, where commands actually execute in the configured (remote)
/// shell instead of the machine running Snow App.
fn resolve_default_shell(database_path: &std::path::Path) -> String {
    let raw = match get_system_setting_value(database_path, "terminal_settings") {
        Ok(Some(value)) => value,
        _ => return String::new(),
    };
    let shell_path = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|json| {
            json.get("shellPath")
                .and_then(|v| v.as_str().map(String::from))
        })
        .unwrap_or_default();

    if shell_path.trim().is_empty() {
        return String::new();
    }

    crate::exports::terminal::detect_shell_family(&shell_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(
        role: &str,
        content: &str,
        tool_calls_json: Option<&str>,
        tool_results_json: Option<&str>,
    ) -> ChatContextMessage {
        ChatContextMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls_json: tool_calls_json.map(str::to_string),
            tool_results_json: tool_results_json.map(str::to_string),
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    #[test]
    fn normalize_messages_keeps_empty_structured_tool_messages() {
        let normalized = normalize_messages(&[
            message("assistant", "", Some(r#"[{"id":"call-1"}]"#), None),
            message("tool", "", None, Some(r#"[{"callId":"call-1"}]"#)),
        ]);

        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0].role, "assistant");
        assert_eq!(normalized[1].role, "tool");
    }

    #[test]
    fn normalize_messages_drops_empty_or_malformed_structured_messages() {
        let normalized = normalize_messages(&[
            message("assistant", "", Some("[]"), None),
            message("tool", "", None, Some("not-json")),
            message("user", "", None, None),
        ]);

        assert!(normalized.is_empty());
    }
}
