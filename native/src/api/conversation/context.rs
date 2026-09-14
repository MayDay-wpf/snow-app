use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;

use crate::prompt::goal_mode_system_prompt::build_goal_mode_system_prompt;
use crate::prompt::plan_mode_system_prompt::build_plan_mode_system_prompt;
use crate::prompt::system_prompt::build_system_prompt;
use crate::prompt::worktree_mode_system_prompt::build_worktree_mode_system_prompt;
use crate::prompt::workflow_mode_system_prompt::build_workflow_mode_system_prompt;
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
use crate::api::token_counter::count_tokens_bounded;

/// Fixed safety margin (tokens) subtracted from the context window by the
/// pre-send guard: covers tokenizer drift between `o200k_base` estimates and
/// provider-side counting, plus request envelope overhead (tool schemas,
/// role/format wrapping) that is not part of message contents.
const CONTEXT_GUARD_SAFETY_MARGIN_TOKENS: usize = 8_192;

/// Estimated cost (tokens) of one on-disk image reference
/// (`@@image:upload/...@@`) once the payload layer expands it into a
/// multimodal image part. Formal vision endpoints bill by pixel dimensions
/// (~1.1-1.6k tokens for typical sizes on Claude), so counting the tag's few
/// characters — or worse, any residual base64 — is wildly off in both
/// directions. A flat per-image estimate keeps the guard honest for both
/// vision-native endpoints and text-counting relays.
const CONTEXT_GUARD_VISION_IMAGE_TOKEN_ESTIMATE: usize = 1_600;

/// Cheaper estimate for text-only endpoints: those images are replaced by
/// textify descriptions (plus the imagegen reference block) after the guard,
/// costing a few hundred tokens instead of vision-native pricing.
const CONTEXT_GUARD_TEXTIFY_IMAGE_TOKEN_ESTIMATE: usize = 800;

/// Output reservation (tokens) used for a context-compaction request instead of
/// the profile's `max_tokens`.
///
/// Compaction produces a handoff SUMMARY, not a full answer, so reserving the
/// profile's full output budget (e.g. 384K on DeepSeek V4.1 Flash) is both
/// wrong and self-defeating: compaction is the only way out of an oversized
/// context, and reserving the full output window shrinks its input budget to
/// `maxContext − max_tokens − margin`, which can sit BELOW the very context it
/// must summarize. The request is then rejected by this guard, compaction
/// never runs, and the conversation is permanently stuck — every retry fails
/// with a context-window error while "/compact" cannot escape it.
///
/// Reserving a summary-sized budget keeps the guard's protection (the request
/// must still fit its input against the window) while leaving compaction able
/// to do its job. Sized to comfortably fit the handoff prompts
/// (`conversation/context.rs` builds documents of a few thousand tokens).
const CONTEXT_COMPACTION_OUTPUT_RESERVE_TOKENS: usize = 16_384;

/// Which persisted reasoning field the active provider actually serializes.
///
/// `thinking` and `thinking_blocks_json` are two mirrors of the SAME reasoning
/// text, but each provider puts exactly one of them on the wire:
/// - **chat** sends `thinking` as `reasoning_content` and never serializes
///   `thinking_blocks_json` (see `chat/payload.rs`).
/// - **anthropic / responses / gemini / interactions** replay
///   `thinking_blocks_json` because it carries the signatures / encrypted
///   content those APIs require; the plain `thinking` mirror is not sent
///   alongside them.
///
/// Counting both double-bills one reasoning trace. Measured on a real
/// conversation this inflated the estimate by ~197k tokens, which on its own
/// can push a sendable request over the guard's hard line.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReasoningPayload {
    /// Only `thinking` reaches the wire (chat completions).
    Text,
    /// `thinking_blocks_json` reaches the wire; `thinking` is a display mirror.
    /// Falls back to `thinking` for rows with no persisted blocks (e.g. Gemini
    /// turns whose signatures were never captured).
    Blocks,
}

impl ReasoningPayload {
    /// Map a profile's `request_method` to the field that provider serializes.
    pub fn for_request_method(request_method: &str) -> Self {
        match request_method.trim() {
            "chat" => ReasoningPayload::Text,
            _ => ReasoningPayload::Blocks,
        }
    }
}

/// Pre-send context window guard.
///
/// Counts the tokens of the FINAL request messages (system prompt, history,
/// attachments already persisted into contents, tool-call/result JSON and
/// thinking payloads) with the `o200k_base` tokenizer and rejects the request
/// locally when the estimate exceeds
/// `maxContextTokens − max_tokens − safety margin`.
///
/// Counting boundary: image base64 payloads have been persisted to disk at
/// this point (`@@image:upload/...@@` short tags), and `@@conversation:`
/// references expand later in the provider payload layer — neither is part of
/// the count here. That matches how formal multimodal endpoints bill images
/// (by pixel size, not base64 text), but relays that count `image_url`
/// contents as plain text can still slip past this guard with very large
/// screenshots; the failed-exchange slimming covers the retry loop in that
/// case.
///
/// Fails fast when an oversized request (most commonly caused by large
/// uploaded attachments, which expand far beyond the previous response's
/// usage numbers that auto-compaction thresholds rely on) would be sent
/// upstream and rejected with an opaque provider 400 "context window exceeds
/// limit". Failing here turns that into an actionable local error.
///
/// Disabled when `max_context_tokens` is unset/invalid (profiles without an
/// explicit context window keep the previous behavior), or when the
/// configuration is self-contradictory (`max_tokens` already consumes the
/// whole window) — such profiles keep the upstream-error behavior.
fn enforce_context_token_budget(
    messages: &[ChatContextMessage],
    max_context_tokens: Option<i32>,
    max_output_tokens: Option<i32>,
    auto_compress_threshold: Option<i32>,
    is_compaction: bool,
    supports_vision: bool,
    reasoning_payload: ReasoningPayload,
) -> Result<()> {
    let max_context = max_context_tokens
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0);
    let Some(max_context) = max_context else {
        return Ok(());
    };
    // The same helper the providers use to emit `max_tokens`, so the guard's
    // reservation and the outgoing payload can never disagree. For compaction
    // it caps the reservation at a summary-sized budget: reserving the
    // profile's full output window (e.g. 384K) would shrink compaction's input
    // budget below the very context it must summarize, deadlocking the one
    // path that can rescue an oversized conversation.
    let configured_output_reserve = resolve_effective_max_tokens(max_output_tokens, is_compaction)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(0);
    let output_reserve = configured_output_reserve;
    // Margin scales with the window (5%) but never drops below the fixed
    // floor, so small windows still keep a proportional reserve.
    let margin = (max_context / 20).max(CONTEXT_GUARD_SAFETY_MARGIN_TOKENS);
    let Some(budget) = max_context
        .checked_sub(output_reserve)
        .and_then(|value| value.checked_sub(margin))
        .filter(|value| *value > 0)
    else {
        // max_tokens >= maxContextTokens: misconfiguration the provider will
        // reject anyway; do not shadow it with a guard error.
        return Ok(());
    };

    let mut total: usize = 0;
    for message in messages {
        // On-disk image references (`@@image:upload/...@@`) expand into
        // multimodal image parts at the payload layer — bill them at the flat
        // per-image estimate instead of their tag text. Any residual inline
        // `@@image:data:` base64 (persist failure fallback) is still counted
        // as text below, which is the conservative direction.
        let image_refs = message.content.matches("@@image:upload/").count()
            + message
                .tool_results_json
                .as_deref()
                .map(|raw| raw.matches("@@image:upload/").count())
                .unwrap_or(0);
        let image_unit_cost = if supports_vision {
            CONTEXT_GUARD_VISION_IMAGE_TOKEN_ESTIMATE
        } else {
            CONTEXT_GUARD_TEXTIFY_IMAGE_TOKEN_ESTIMATE
        };
        total += image_refs * image_unit_cost;
        // Only the reasoning field the provider actually serializes is billed
        // (see ReasoningPayload): the two mirrors hold the same text, so
        // counting both double-bills one reasoning trace.
        let (thinking_payload, thinking_blocks_payload) = match reasoning_payload {
            ReasoningPayload::Text => (message.thinking.as_deref().unwrap_or(""), ""),
            ReasoningPayload::Blocks => {
                let blocks = message.thinking_blocks_json.as_deref().unwrap_or("");
                // Fall back to the display mirror for rows without persisted
                // blocks, so their reasoning is still accounted for.
                let thinking = if blocks.is_empty() {
                    message.thinking.as_deref().unwrap_or("")
                } else {
                    ""
                };
                (thinking, blocks)
            }
        };
        let payloads = [
            message.content.as_str(),
            message.tool_calls_json.as_deref().unwrap_or(""),
            message.tool_results_json.as_deref().unwrap_or(""),
            thinking_payload,
            thinking_blocks_payload,
        ];
        for payload in payloads {
            if payload.is_empty() {
                continue;
            }
            // Bounded counting stops early once the running budget is
            // exceeded, so oversized attachments never tokenize fully.
            let measured = count_tokens_bounded(payload, budget.saturating_sub(total));
            if measured.exceeded {
                let estimated = total.saturating_add(measured.estimated_total());
                // A profile whose auto-compaction threshold sits ABOVE this
                // guard's hard line cannot auto-recover: the guard rejects the
                // request before auto-compaction ever fires, so every message
                // in [budget, threshold) is a dead end for AUTO compaction.
                // Blaming attachments or telling the user to "/compact" without
                // saying why is misleading — the real fix is the profile.
                //
                // Manual /compact still works here: compaction requests reserve
                // a summary-sized output budget, so they get a much larger input
                // allowance than the normal request that just failed.
                let conflicting_threshold = auto_compress_threshold
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| *value > budget);
                let remedy = if is_compaction {
                    // Already compacting and still over budget: the context is
                    // genuinely too large to summarize.
                    "The context is too large even for compaction. Start a \
                     new conversation, or remove large attachments from \
                     recent messages before retrying."
                        .to_string()
                } else if let Some(threshold) = conflicting_threshold {
                    format!(
                        "Automatic compaction cannot help here: its threshold ({threshold} tokens) \
                         is above this guard's hard line ({budget} tokens), so it never fires before \
                         the request is rejected. Run /compact manually (compaction reserves only a \
                         summary-sized output budget, so it can still pass), then lower the \
                         auto-compaction threshold below {budget} tokens — or reduce max tokens / \
                         raise the max context window in that API profile — so it can also fire on \
                         its own. Removing attachments will not resolve the conflict."
                    )
                } else {
                    "Compact the conversation (/compact), start a new \
                     conversation, or remove large attachments before \
                     retrying."
                        .to_string()
                };
                return Err(Error::from_reason(format!(
                    "Context window guard: the prepared request is about {estimated} tokens, \
                     exceeding the available {budget}-token context budget (maxContextTokens \
                     {max_context} minus output reserve {output_reserve} and safety margin). \
                     {remedy}"
                )));
            }
            total += measured.counted;
        }
    }
    Ok(())
}

/// Effective `max_tokens` to send upstream for a request.
///
/// Compaction produces a handoff SUMMARY rather than a full answer, so it must
/// not claim the profile's entire output budget: on the wire that wastes the
/// provider's output allowance, and on the guard side it shrinks the input
/// window below the very context being summarized (see
/// [`CONTEXT_COMPACTION_OUTPUT_RESERVE_TOKENS`]). Every provider funnels its
/// `max_tokens` emission through this helper so the guard's reservation and the
/// outgoing payload always agree.
///
/// Returns `Some(cap)` for compaction even when the profile leaves `max_tokens`
/// unset — the guard already reserved that budget, so letting the provider pick
/// an unbounded default would silently reintroduce the deadlock.
pub fn resolve_effective_max_tokens(max_tokens: Option<i32>, is_compaction: bool) -> Option<i32> {
    if !is_compaction {
        return max_tokens;
    }

    let cap = CONTEXT_COMPACTION_OUTPUT_RESERVE_TOKENS as i32;
    Some(match max_tokens {
        Some(value) if value > 0 => value.min(cap),
        _ => cap,
    })
}

/// Rewrite inline `@@image:data:` base64 into on-disk `@@image:upload/...@@`
/// refs for every message in `messages`.
///
/// Images are charged by [`CONTEXT_GUARD_VISION_IMAGE_TOKEN_ESTIMATE`] once they
/// are disk refs; while still inline they are billed as raw base64 text, which
/// is orders of magnitude larger. Persisting first is what makes the guard's
/// estimate reflect the request the provider actually receives.
///
/// The rewrite is in-memory only — the payload layer reads the image back from
/// disk, and the stored conversation keeps whatever it had. Rows whose image
/// cannot be decoded are left untouched, which keeps the conservative
/// (over-counting) direction for genuinely broken data.
fn persist_images_in_history(
    messages: &mut [ChatContextMessage],
    database_path: &Path,
) -> Result<()> {
    for message in messages.iter_mut() {
        if message.content.contains("@@image:data:") {
            message.content = persist_inline_images_to_disk(&message.content, database_path)?;
        }
        // 工具结果同样可能内嵌图片 base64（filesystem-read 读图、网页抓图等）：
        // 不落盘就会被按纯文本全量计数（实测单条可达 22 万 token 级误拦）。
        if let Some(raw) = message.tool_results_json.as_deref() {
            if raw.contains("@@image:data:") {
                message.tool_results_json =
                    Some(persist_inline_images_to_disk(raw, database_path)?);
            }
        }
    }
    Ok(())
}

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
    // 工具轮把 tool 消息直接放进下一轮请求（内存态，未经持久层）：同样先落盘，
    // 否则内联 base64 会直达守卫被按文本计数。落盘后 payload 层从磁盘读回，
    // 发送行为不变。
    persist_images_in_history(&mut current_messages, request.database_path)?;
    if current_messages.is_empty() && !request.resume_after_compaction {
        return Err(Error::from_reason("Chat message content is required"));
    }

    // --- Lightweight mode: skip history loading and system-prompt injection ---
    if request.skip_context {
        enforce_context_token_budget(
            &current_messages,
            request.max_context_tokens,
            request.max_output_tokens,
            request.auto_compress_threshold,
            false,
            request.supports_vision,
            ReasoningPayload::for_request_method(request.request_method),
        )?;
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

    // History rows may still carry inline `@@image:data:` base64 — a tool result
    // whose image was persisted to `upload/` but whose stored text was never
    // rewritten, or a row written before that rewrite existed. The guard only
    // bills `@@image:upload/...@@` refs at the flat per-image estimate, so a
    // leftover inline tag is charged its full base64 text instead: measured on a
    // real conversation, one such tag (~329k characters) inflated the estimate by
    // ~225k tokens, which alone can push a sendable request over the hard line.
    //
    // Rewriting here (same helper the current-turn messages use) keeps the count
    // honest. This only touches the in-memory context copy: the payload layer
    // reads the image back from disk, and the stored conversation is unchanged.
    persist_images_in_history(&mut messages, request.database_path)?;

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
    } else if request.workflow_mode {
        build_workflow_mode_system_prompt(
            &working_directory,
            &shell_type,
            request.remote_role_content,
            request.remote_include_global_rules,
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
    // 项目记忆章节（2026-09-01，仿 LSP/imagegen 方案 B）：项目启用
    // builtin:memory（默认启用）且记忆库可用时，在系统提示词末尾追加
    // 「Project Memory」章节——importance 头部条目 + memory-search/save
    // 工具指引。查询失败静默降级为空串。子代理不注入：任务短且上下文
    // 昂贵，记忆操作由主会话统一决策。章节按会话冻结（首轮渲染后存入
    // 快照，之后每轮复用同一份文本）：会话中新增/修改记忆不改动提示词
    // 前缀，整个会话的 prompt cache 始终有效，新记忆只对之后新建的会话
    // 生效。
    let memory_section = if request.is_sub_agent {
        String::new()
    } else {
        crate::mcp::servers::memory::build_system_prompt_section(
            request.directory_id,
            Some(conversation_id.as_str()),
        )
        .await
    };
    let system_prompt = if memory_section.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n{memory_section}")
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

    // --- Pre-send context window guard: reject requests that already exceed
    //     the configured context budget locally, instead of paying an
    //     upstream 400 round-trip with an opaque provider error. ---
    enforce_context_token_budget(
        &messages,
        request.max_context_tokens,
        request.max_output_tokens,
        request.auto_compress_threshold,
        request.context_compaction,
        request.supports_vision,
        ReasoningPayload::for_request_method(request.request_method),
    )?;

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

    fn context_message(role: &str, content: &str) -> ChatContextMessage {
        ChatContextMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    #[test]
    fn context_guard_passes_small_messages_within_budget() {
        let messages = vec![context_message("system", "short system prompt")];
        enforce_context_token_budget(
            &messages,
            Some(200_000),
            Some(8_192),
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect("small request must pass");
    }

    #[test]
    fn context_guard_skipped_without_max_context_tokens() {
        // No configured context window → guard disabled, even for huge content.
        let huge = "x".repeat(4_000_000);
        let messages = vec![context_message("user", &huge)];
        enforce_context_token_budget(
            &messages,
            None,
            None,
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect("guard must be disabled when maxContextTokens is unset");
    }

    #[test]
    fn context_guard_skipped_on_contradictory_config() {
        // max_tokens >= maxContextTokens: nothing left for messages; the
        // provider will reject such profiles anyway, so the guard stays out.
        let messages = vec![context_message("user", "hello")];
        enforce_context_token_budget(
            &messages,
            Some(1_000),
            Some(1_000),
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect("contradictory config must not be shadowed by the guard");
    }

    #[test]
    fn context_guard_rejects_oversized_content() {
        // CJK text has a high token density (~1 token per character), so a
        // few hundred thousand characters comfortably exceed the budget.
        let huge = "上下文窗口超限测试载荷".repeat(60_000);
        let messages = vec![context_message("user", &huge)];
        let error = enforce_context_token_budget(
            &messages,
            Some(200_000),
            None,
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("oversized request must be rejected locally");
        assert!(error.to_string().contains("Context window guard"));
        assert!(error.to_string().contains("maxContextTokens 200000"));
    }

    #[test]
    fn context_guard_bills_disk_image_tags_at_flat_estimate() {
        // 40 upload tags * 1600 = 64k tokens + tiny text: well under the
        // ~181k budget of a 200k window. The base64 never exists inline, so
        // this must NOT be counted as text.
        let tags = "@@image:upload/2026-09-14/hash.png@@".repeat(40);
        let messages = vec![ChatContextMessage {
            role: "tool".to_string(),
            content: String::new(),
            tool_calls_json: None,
            tool_results_json: Some(tags),
            thinking: None,
            thinking_blocks_json: None,
        }];
        enforce_context_token_budget(
            &messages,
            Some(200_000),
            None,
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect("40 disk image refs must fit a 200k window");
    }

    #[test]
    fn context_guard_still_rejects_when_image_refs_alone_exceed_budget() {
        // 400 tags * 1600 = 640k > 200k window: even flat estimates must trip
        // the guard when image count alone blows the budget.
        let tags = "@@image:upload/2026-09-14/hash.png@@".repeat(400);
        let messages = vec![ChatContextMessage {
            role: "tool".to_string(),
            content: String::new(),
            tool_calls_json: None,
            tool_results_json: Some(tags),
            thinking: None,
            thinking_blocks_json: None,
        }];
        enforce_context_token_budget(
            &messages,
            Some(200_000),
            None,
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("400 image refs must exceed a 200k window");
    }

    #[test]
    fn context_guard_compaction_error_suggests_new_conversation() {
        let huge = "上下文窗口超限测试载荷".repeat(60_000);
        let messages = vec![context_message("user", &huge)];
        let error = enforce_context_token_budget(
            &messages,
            Some(200_000),
            None,
            None,
            true,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("oversized compaction request must be rejected");
        let message = error.to_string();
        assert!(message.contains("too large even for compaction"));
        assert!(
            !message.contains("/compact),"),
            "must not suggest compacting while a compaction is already running"
        );
    }

    #[test]
    fn context_guard_counts_tool_payloads_and_thinking() {
        // The content alone fits, but tool results + thinking push the total
        // over the budget — the guard must see every payload the providers
        // serialize into the request.
        let messages = vec![ChatContextMessage {
            role: "tool".to_string(),
            content: String::new(),
            tool_calls_json: None,
            tool_results_json: Some("tool result payload ".repeat(30_000)),
            thinking: Some("thinking payload ".repeat(30_000)),
            thinking_blocks_json: None,
        }];
        let error = enforce_context_token_budget(
            &messages,
            Some(150_000),
            None,
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("oversized tool payloads must be rejected");
        assert!(error.to_string().contains("Context window guard"));
    }

    #[test]
    fn context_guard_reports_threshold_conflict_instead_of_blaming_attachments() {
        // A profile with a 1M window, 384K output reserve and an 800K
        // auto-compaction threshold (the shipped default) can never recover:
        // the guard's hard line is 1M - 384K - 50K = 566K, which sits far
        // below the 800K threshold, so auto-compaction never runs before the
        // request is rejected. The error must name the conflict — telling the
        // user to remove attachments here sends them in circles.
        let huge = "上下文窗口超限测试载荷".repeat(200_000);
        let messages = vec![context_message("user", &huge)];
        let error = enforce_context_token_budget(
            &messages,
            Some(1_000_000),
            Some(384_000),
            Some(800_000),
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("oversized request must be rejected");
        let message = error.to_string();
        assert!(
            message.contains("Automatic compaction cannot help here"),
            "conflicting threshold must be reported as an auto-compaction conflict: {message}"
        );
        assert!(
            message.contains("566000"),
            "the guard hard line must be spelled out: {message}"
        );
        assert!(
            message.contains("800000"),
            "the offending threshold must be spelled out: {message}"
        );
        assert!(
            message.contains("/compact manually"),
            "manual compaction must be offered — it can still pass after the fix: {message}"
        );
        assert!(
            !message.contains("remove large attachments before"),
            "must not blame attachments when the profile itself is contradictory: {message}"
        );
    }

    #[test]
    fn context_guard_keeps_generic_remedy_when_threshold_is_within_budget() {
        // Same oversized payload, but the threshold (500K) sits BELOW the
        // 566K hard line, so auto-compaction can still run — the generic
        // remedy is correct here and no conflict may be reported.
        let huge = "上下文窗口超限测试载荷".repeat(200_000);
        let messages = vec![context_message("user", &huge)];
        let error = enforce_context_token_budget(
            &messages,
            Some(1_000_000),
            Some(384_000),
            Some(500_000),
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("oversized request must be rejected");
        let message = error.to_string();
        assert!(
            !message.contains("configuration conflict"),
            "a healthy threshold must not be reported as a conflict: {message}"
        );
        assert!(
            message.contains("/compact"),
            "the generic remedy must survive: {message}"
        );
    }

    /// Small-profile budgets used by the compaction-deadlock tests.
    ///
    /// Chosen so the numbers are easy to reason about and each case sits in a
    /// distinct band:
    ///   margin          = max(100_000 / 20, 8_192) = 8_192
    ///   normal budget   = 100_000 − 80_000 − 8_192 = 11_808
    ///   compaction budget = 100_000 − 16_384 − 8_192 = 75_424
    /// A ~30K-token payload therefore lands strictly between them: rejected as
    /// a normal request, accepted as a compaction. These mirror the user's real
    /// case (569K between 566K and 933,616) without burning minutes on the
    /// tokenizer.
    const DEADLOCK_MAX_CONTEXT: i32 = 100_000;
    const DEADLOCK_MAX_OUTPUT: i32 = 80_000;

    #[test]
    fn compaction_succeeds_exactly_where_a_normal_request_is_rejected() {
        // THE core regression test for the deadlock fix.
        //
        // A profile that reserves a huge output window (normal budget 11,808)
        // and a conversation that outgrew it: the normal request must be
        // rejected, yet the SAME payload must be accepted as a compaction
        // (budget 75,424). Before the fix both shared the output reserve, so
        // compaction failed too and the conversation could never recover.
        //
        // "word " tokenizes to ~1 token per repetition in o200k, so this is
        // roughly 30K tokens — safely inside (11,808, 75,424).
        let payload = "word ".repeat(30_000);
        let messages = vec![context_message("user", &payload)];

        let normal = enforce_context_token_budget(
            &messages,
            Some(DEADLOCK_MAX_CONTEXT),
            Some(DEADLOCK_MAX_OUTPUT),
            None,
            false,
            true,
            ReasoningPayload::Text,
        );
        assert!(
            normal.is_err(),
            "a 30K-token request must be rejected against the 11,808-token normal budget"
        );

        enforce_context_token_budget(
            &messages,
            Some(DEADLOCK_MAX_CONTEXT),
            Some(DEADLOCK_MAX_OUTPUT),
            None,
            true,
            true,
            ReasoningPayload::Text,
        )
        .expect(
            "the SAME request must be allowed as a compaction — otherwise the deadlock is back",
        );
    }

    #[test]
    fn compaction_budget_exceeds_the_normal_budget_for_the_same_profile() {
        // The invariant behind the fix, asserted on the reported budgets so it
        // survives any future re-tuning of the constants. The payload is
        // deliberately huge (over both budgets) so each branch reports its own
        // budget: 1M − 384K − 50K = 566,000 normally, and
        // 1M − 16,384 − 50K = 933,616 for compaction.
        let payload = "word ".repeat(1_500_000);
        let messages = vec![context_message("user", &payload)];

        let normal_msg = enforce_context_token_budget(
            &messages,
            Some(1_000_000),
            Some(384_000),
            None,
            false,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("the oversized normal request must be rejected")
        .to_string();
        assert!(
            normal_msg.contains("566000"),
            "normal requests reserve the full 384K output: {normal_msg}"
        );

        let compaction_msg = enforce_context_token_budget(
            &messages,
            Some(1_000_000),
            Some(384_000),
            None,
            true,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("this payload exceeds even the compaction budget")
        .to_string();
        assert!(
            compaction_msg.contains("933616"),
            "compaction must reserve only the summary budget, giving a 933,616-token input allowance: {compaction_msg}"
        );
        assert!(
            !compaction_msg.contains("566000"),
            "compaction must not share the normal request's output reserve: {compaction_msg}"
        );
    }

    #[test]
    fn compaction_reserves_the_cap_even_when_max_tokens_is_unset() {
        // The guard and the providers both derive the reservation from
        // `resolve_effective_max_tokens`. For compaction that helper injects the
        // 16,384 cap even when the profile sets no `max_tokens`, so a provider
        // never sends an unbounded `max_output_tokens`. The guard must reserve
        // the same amount, or a small window would pass here and be rejected
        // upstream.
        //
        // margin = max(40_000 / 20, 8_192) = 8_192
        // compaction budget = 40_000 − 16_384 − 8_192 = 15_424
        let payload = "word ".repeat(20_000); // ~20K tokens
        let messages = vec![context_message("user", &payload)];

        let error = enforce_context_token_budget(
            &messages,
            Some(40_000),
            None,
            None,
            true,
            true,
            ReasoningPayload::Text,
        )
        .expect_err("20K tokens must exceed the 15,424-token compaction budget")
        .to_string();
        assert!(
            error.contains("15424"),
            "an unset max_tokens must still reserve the 16,384 cap for compaction: {error}"
        );
        assert!(
            error.contains("output reserve 16384"),
            "the reserved cap must be reported as the output reserve: {error}"
        );
    }

    #[test]
    fn compaction_max_tokens_is_capped_and_never_unbounded() {
        assert_eq!(
            resolve_effective_max_tokens(Some(384_000), true),
            Some(CONTEXT_COMPACTION_OUTPUT_RESERVE_TOKENS as i32),
            "a 384K output profile must be capped for compaction"
        );
        assert_eq!(
            resolve_effective_max_tokens(None, true),
            Some(CONTEXT_COMPACTION_OUTPUT_RESERVE_TOKENS as i32),
            "an unset max_tokens must still be bounded for compaction — the guard reserved it"
        );
        assert_eq!(
            resolve_effective_max_tokens(Some(4_096), true),
            Some(4_096),
            "a smaller configured budget must be preserved"
        );
    }

    #[test]
    fn normal_requests_keep_their_full_output_budget() {
        assert_eq!(
            resolve_effective_max_tokens(Some(384_000), false),
            Some(384_000),
            "normal requests must keep the profile's output budget untouched"
        );
        assert_eq!(
            resolve_effective_max_tokens(None, false),
            None,
            "normal requests must not inject a max_tokens the profile left unset"
        );
    }

    #[test]
    fn chat_payload_bills_one_reasoning_field_not_two() {
        // `thinking` and `thinking_blocks_json` mirror the SAME reasoning text.
        // Chat Completions only serializes `thinking` (as `reasoning_content`),
        // so billing both double-counts it. Measured on a real conversation
        // that inflated the estimate by ~197k tokens — enough to trip the hard
        // line on its own.
        let reasoning = "推理过程示例".repeat(20_000); // ~5 chars * 20k
        let messages = vec![ChatContextMessage {
            role: "assistant".to_string(),
            content: "answer".to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: Some(reasoning.clone()),
            thinking_blocks_json: Some(reasoning),
        }];

        // A budget that fits exactly ONE copy of the reasoning text.
        let one_copy =
            count_tokens_bounded(&messages[0].thinking.clone().unwrap(), usize::MAX).counted;
        let budget = one_copy + 5_000; // margin floor is 8192, so allow slack

        enforce_context_token_budget(
            &messages,
            Some((budget + 50_000 + 8_192) as i32), // window = budget + output + margin
            None,
            None,
            false,
            false,
            ReasoningPayload::Text, // chat
        )
        .expect(
            "chat must bill reasoning once; billing both mirrors would double-count and reject this",
        );
    }

    #[test]
    fn blocks_payload_still_falls_back_to_text_when_blocks_absent() {
        // For anthropic/responses/gemini the blocks field is what ships, but
        // rows without persisted blocks (e.g. older rows, or turns whose
        // signatures were never captured) must still have their reasoning
        // accounted for — otherwise the guard would silently under-count.
        // The fallback text alone must therefore be enough to trip this budget.
        let reasoning = "退回文本镜像的推理".repeat(200_000);
        let messages = vec![ChatContextMessage {
            role: "assistant".to_string(),
            content: "answer".to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: Some(reasoning),
            thinking_blocks_json: None, // no blocks persisted
        }];

        let error = enforce_context_token_budget(
            &messages,
            Some(200_000),
            None,
            None,
            false,
            false,
            ReasoningPayload::Blocks, // anthropic-style
        )
        .expect_err("the fallback text must still be counted and trip this small budget");
        assert!(error.to_string().contains("Context window guard"));
    }

    #[test]
    fn reasoning_payload_maps_request_methods() {
        assert_eq!(
            ReasoningPayload::for_request_method("chat"),
            ReasoningPayload::Text
        );
        for method in ["anthropic", "responses", "gemini", "interactions"] {
            assert_eq!(
                ReasoningPayload::for_request_method(method),
                ReasoningPayload::Blocks,
                "{method} ships thinking_blocks_json, not the plain mirror"
            );
        }
    }
}
