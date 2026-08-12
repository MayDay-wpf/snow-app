use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;

use crate::prompt::goal_mode_system_prompt::build_goal_mode_system_prompt;
use crate::prompt::plan_mode_system_prompt::build_plan_mode_system_prompt;
use crate::prompt::system_prompt::build_system_prompt;
use crate::storage::services::chat_conversations::{
    get_conversation_modes, load_context_messages, resolve_conversation_id, ChatContextMessage,
};
use crate::storage::services::sub_agent_configs::list_sub_agent_configs;
use crate::storage::SubAgentConfigRecord;
use crate::storage::services::system_prompts::resolve_active_system_prompt_contents;
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::services::workspace_directories::get_workspace_directory_path;

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
                let mut line = format!(
                    "- `{}` — {}",
                    config.agent_id.trim(),
                    config.name.trim()
                );
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

pub fn prepare_context_request(
    request: ConversationContextRequest<'_>,
) -> Result<PreparedConversationRequest> {
    let mut current_messages = if request.resume_after_compaction {
        // Resume after auto-compaction: the handoff is already persisted as
        // the latest `context_compaction` boundary message and will be loaded
        // by `load_context_messages` below. The caller's placeholder message
        // must NOT be injected here — re-adding the same summary would
        // duplicate the handoff in the request payload and cause a redundant
        // copy to be persisted as a normal user message by
        // `store_chat_exchange`.
        Vec::new()
    } else if request.context_compaction {
        let handoff_prompt = if request.goal_mode {
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
    let system_prompt = if request.plan_mode {
        build_plan_mode_system_prompt(
            &working_directory,
            &shell_type,
            request.remote_role_content,
            request.remote_include_global_rules,
            &sub_agents_section,
        )
    } else if request.goal_mode {
        // Per-conversation budget isolation: the conversation's own override
        // wins; conversations without one use the built-in default. The
        // formerly-global budget setting is no longer written by the UI
        // (Plan/Goal Mode toggles are strictly per-conversation), so it must
        // not leak into conversations that never set a budget of their own.
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

    // --- Conversation context attachments: inject attached conversations
    //     as prefix context blocks (after the system prompt, before the
    //     conversation's own history). Non-recursive: only the attached
    //     conversation's own messages are rendered; its own attachments are
    //     not followed (prevents context explosion / cycles). ---
    let attached =
        crate::storage::services::context_attachments::list_context_attachments(
            request.database_path,
            &conversation_id,
        )?;
    if !attached.is_empty() {
        // 预算控制（可配置，见 read_attach_context_budgets）：每个附件按
        // 单附件预算渲染，但所有附件合计不得超过总预算 —— 累计实际注入
        // 长度，剩余预算耗尽后不再注入后续附件。
        let (single_budget, total_budget) =
            crate::storage::services::context_attachments::read_attach_context_budgets(
                request.database_path,
            );
        let mut used_chars: usize = 0;
        let mut injected: Vec<ChatContextMessage> = Vec::with_capacity(attached.len());
        for attachment in attached {
            let remaining = total_budget.saturating_sub(used_chars);
            if remaining == 0 {
                break;
            }
            let rendered = crate::storage::services::context_attachments::
                render_attachment_context_with_budget(
                    request.database_path,
                    &attachment.source_conversation_id,
                    single_budget.min(remaining),
                )?;
            let content = rendered.trim();
            if content.is_empty() {
                continue;
            }
            used_chars += content.len();
            injected.push(ChatContextMessage {
                role: "user".to_string(),
                content: content.to_string(),
                tool_calls_json: None,
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            });
        }
        if !injected.is_empty() {
            // Main-conversation path: the system prompt sits at messages[0],
            // so injected blocks go at index 1. Sub-agent / skip_context paths
            // keep the system prompt out of `messages` — inject at the front.
            let insert_at = if messages
                .first()
                .is_some_and(|msg| msg.role.trim() == "system" || msg.role.trim() == "developer")
            {
                1
            } else {
                0
            };
            messages.splice(insert_at..insert_at, injected);
        }
    }

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
            if content.is_empty() {
                return None;
            }

            Some(ChatContextMessage {
                role: message.role.trim().to_string(),
                content: content.to_string(),
                tool_calls_json: message.tool_calls_json.clone(),
                tool_results_json: message.tool_results_json.clone(),
                thinking: message.thinking.clone(),
                thinking_blocks_json: message.thinking_blocks_json.clone(),
            })
        })
        .collect()
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

