use std::collections::HashSet;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;

use crate::prompt::common::read_active_role;
use crate::prompt::goal_mode_system_prompt::build_goal_mode_system_prompt;
use crate::prompt::system_prompt::build_system_prompt;
use crate::prompt::workflow_mode_system_prompt::build_workflow_mode_system_prompt;
use crate::prompt::worktree_mode_system_prompt::build_worktree_mode_system_prompt;
use crate::storage::initialize_app_storage;
use crate::storage::services::chat_conversations::{
    get_conversation_directory_id, get_conversation_modes, load_context_messages,
    resolve_conversation_id, ChatContextMessage,
};
use crate::storage::services::sub_agent_configs::list_sub_agent_configs;
use crate::storage::services::system_prompts::resolve_active_system_prompt_contents;
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::services::workspace_directories::get_workspace_directory_path;
use crate::storage::SubAgentConfigRecord;

use super::tool_messages::ensure_tool_pairing;
use super::{images::persist_inline_images_to_disk, ConversationContextRequest};
use crate::api::responses::ResponsesApiMessage;

pub struct PreparedConversationRequest {
    pub conversation_id: String,
    pub messages: Vec<ChatContextMessage>,
    pub current_messages: Vec<ChatContextMessage>,
    /// User-configured system prompt contents resolved from
    /// `system_prompt_ids_json`. Providers use this to decide whether to
    /// keep the built-in system prompt as a `system` message or demote it
    /// to a `user` message (matching Snow CLI PR #127): when non-empty, the
    /// user prompts take configured precedence and the built-in prompt is
    /// prepended as a leading `user` message. Child requests retain their
    /// existing ordered builtin/API/child composition in this list; host facts
    /// are always separate and never influence this precedence decision.
    pub user_system_prompts: Vec<String>,
    /// Request-scoped host facts that are stable for the whole conversation.
    /// Volatile facts (sub-agent run ledger) must go through the request tail
    /// instead: providers put this list into the system slot, so any change here
    /// invalidates the entire cached prompt prefix.
    pub host_system_prompts: Vec<String>,
}

/// 子代理与主流程使用同一套「替换 + 降级」：请求档案配置了系统提示词时由它们
/// 独占系统槽，Snow 内置协议与子代理自身提示词合并为一段返回，由调用方作为
/// system 消息交给各 provider 降级成开头的 user 消息；未配置时两者按顺序留在
/// 系统槽。返回 `(系统槽提示词, 待降级的内置提示词)`，全程按内容去重。
pub(crate) fn compose_sub_agent_system_prompts(
    builtin: &str,
    api_prompts: &[String],
    sub_agent_prompt: Option<&str>,
) -> (Vec<String>, Option<String>) {
    let mut seen = HashSet::new();
    let mut keep = |prompt: &str| {
        let normalized = prompt.trim();
        (!normalized.is_empty() && seen.insert(normalized.to_string()))
            .then(|| normalized.to_string())
    };
    let configured: Vec<String> = api_prompts
        .iter()
        .filter_map(|p| keep(p.as_str()))
        .collect();
    let own: Vec<String> = std::iter::once(builtin)
        .chain(sub_agent_prompt)
        .filter_map(|p| keep(p))
        .collect();

    if configured.is_empty() {
        (own, None)
    } else {
        let demoted = (!own.is_empty()).then(|| own.join("\n\n"));
        (configured, demoted)
    }
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

/// 构造与主流程一致的内置系统提示词（工作目录、模式、项目组、LSP、生图、项目记忆等章节）。
/// 不含历史消息与用户自定义系统提示词（后者由 `prepare_context_request` 单独解析）。
pub(crate) async fn build_builtin_system_prompt(
    request: &ConversationContextRequest<'_>,
    conversation_id: &str,
) -> String {
    let working_directory = if let Some(exec_root) = request.execution_workspace_root {
        exec_root.trim().to_string()
    } else if let Some(root) = request.analysis_workspace_root {
        crate::mcp::servers::lsp::prompt_context::resolve_analysis_workspace_root(
            request.directory_id,
            Some(Path::new(root)),
        )
        .await
        .ok()
        .flatten()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
    } else {
        let worktree_path = if let Some(wt_id) = request.worktree_id {
            crate::storage::services::git::get_worktree_by_id(request.database_path, wt_id)
                .ok()
                .flatten()
                .map(|w| w.worktree_path)
        } else if let Some(conv_id) = request.conversation_id {
            crate::storage::services::git::get_conversation_worktree(request.database_path, conv_id)
                .ok()
                .flatten()
                .map(|w| w.worktree_path)
        } else {
            None
        };

        if let Some(path) = worktree_path {
            path
        } else {
            request
                .directory_id
                .and_then(|id| {
                    get_workspace_directory_path(request.database_path, id)
                        .ok()
                        .flatten()
                })
                .unwrap_or_default()
        }
    };

    // Goal Mode / WorkFlow Mode: replace the built-in system prompt with the
    // mode-specific prompt that carries its own execution guidance.
    let shell_type = resolve_default_shell(request.database_path);
    let sub_agents_section = build_sub_agents_section(request.database_path, request.directory_id);
    // The final request list already includes project switches, sub-agent
    // whitelist and tool-less modes. Do not independently rediscover tools.
    let tool_snapshot =
        crate::mcp::servers::lsp::prompt_context::ToolSnapshot::from_tools(request.allowed_tools);
    let analysis_tools_section = if request.goal_mode || request.workflow_mode {
        crate::prompt::tool_hints::analysis_tools_lines(&tool_snapshot).join("\n")
    } else {
        String::new()
    };
    let active_role = read_active_role(
        &working_directory,
        request.remote_role_content,
        request.remote_include_global_rules,
        request.remote_override_builtin_prompt,
    );
    let system_prompt = if request.worktree_mode {
        build_worktree_mode_system_prompt(
            &working_directory,
            &shell_type,
            active_role.as_ref(),
            &sub_agents_section,
        )
    } else if request.workflow_mode {
        build_workflow_mode_system_prompt(
            &working_directory,
            &shell_type,
            active_role.as_ref(),
            &analysis_tools_section,
        )
    } else if request.goal_mode {
        // Per-conversation budget isolation: the conversation's own override
        // wins; conversations without one use the built-in default.
        let goal_token_budget = if !conversation_id.is_empty() {
            get_conversation_modes(request.database_path, conversation_id)
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
            active_role.as_ref(),
            &analysis_tools_section,
        )
    } else {
        build_system_prompt(
            &working_directory,
            &shell_type,
            active_role.as_ref(),
            &sub_agents_section,
        )
    };
    // 关联项目组章节（2026-10-02，仿 imagegen / Project Memory 方案 B）：
    // 项目属于「关联项目组」（合集收纳的 ≥ 2 个本地目录）时，注入组名与全部
    // 根目录，声明 grep / 文件搜索把组内目录当成同一个统一项目。WorkTree 模式
    // 运行在单一工作树上，不注入。查询失败静默降级为空串。
    let linked_projects_section = if request.worktree_mode {
        String::new()
    } else {
        crate::prompt::linked_projects::build_linked_projects_section(
            request.database_path,
            request.directory_id,
        )
        .await
    };
    let system_prompt = if linked_projects_section.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n{linked_projects_section}")
    };
    // Pure rendering of the exact tools serialized by this provider request.
    let lsp_section = tool_snapshot.system_prompt_section();
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
    // 范围。各模式统一注入。
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
            Some(conversation_id),
        )
        .await
    };
    let system_prompt = if memory_section.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n{memory_section}")
    };
    // 仓库 Wiki：项目已生成 Wiki 时告知 wiki.json 绝对路径（文本稳定，不破坏缓存前缀）。
    let wiki_project_path = request
        .directory_id
        .and_then(|id| {
            get_workspace_directory_path(request.database_path, id)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| working_directory.clone());
    let wiki_section = crate::api::repo_wiki::build_system_prompt_section(&wiki_project_path).await;
    let system_prompt = if wiki_section.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n{wiki_section}")
    };
    system_prompt
}

/// 解析 API 档案配置的用户系统提示词（`system_prompt_ids_json`，按会话工作目录解析），
/// 与主流程 `prepare_context_request` 使用同一套解析。每条提示词单独返回，各自成为一个
/// 系统提示词块。未配置或读取失败时返回空。数据库读取放在阻塞线程执行。
pub(crate) async fn resolve_configured_system_prompts(
    system_prompt_ids_json: &str,
    conversation_id: Option<&str>,
) -> Vec<String> {
    let system_prompt_ids_json = system_prompt_ids_json.to_string();
    let conversation_id = conversation_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let Ok(storage_info) = initialize_app_storage() else {
            return Vec::new();
        };
        let database_path = PathBuf::from(storage_info.database_path);
        let directory_id = conversation_id.as_deref().and_then(|id| {
            get_conversation_directory_id(&database_path, id)
                .ok()
                .flatten()
        });
        resolve_active_system_prompt_contents(
            &database_path,
            &system_prompt_ids_json,
            directory_id.as_deref(),
        )
    })
    .await
    .unwrap_or_default()
}

/// 与主流程一致地应用 API 档案的用户系统提示词：配置了提示词时，它们各自成为系统消息，
/// 请求原有的系统消息降级为其后的一条 user 消息；未配置时保持请求原样。
pub(crate) async fn apply_configured_system_prompts(
    messages: &mut Vec<ResponsesApiMessage>,
    system_prompt_ids_json: &str,
    conversation_id: Option<&str>,
) {
    let configured =
        resolve_configured_system_prompts(system_prompt_ids_json, conversation_id).await;
    if configured.is_empty() {
        return;
    }
    let demoted: Vec<String> = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.clone())
        .collect();
    messages.retain(|message| message.role != "system");
    let mut result: Vec<ResponsesApiMessage> = configured
        .into_iter()
        .map(|content| text_message("system", content))
        .collect();
    result.extend(
        demoted
            .into_iter()
            .map(|content| text_message("user", content)),
    );
    result.append(messages);
    *messages = result;
}

fn text_message(role: &str, content: String) -> ResponsesApiMessage {
    ResponsesApiMessage {
        role: role.to_string(),
        content,
        tool_results_json: None,
        thinking: None,
        thinking_blocks_json: None,
        tool_calls_json: None,
    }
}

pub async fn prepare_context_request(
    request: ConversationContextRequest<'_>,
) -> Result<PreparedConversationRequest> {
    // Ephemeral auxiliary requests must return before image persistence or
    // any conversation/system/ROLE lookup, including skip-context side effects.
    if crate::api::ephemeral::is_active() {
        // Route only caller-supplied metadata instructions through the provider
        // system slot (Interactions does not interpret a system-role input as
        // system_instruction). Never resolve configured or built-in prompts.
        let mut current_messages = Vec::new();
        let mut user_system_prompts = Vec::new();
        for message in normalize_messages(request.messages) {
            if matches!(message.role.as_str(), "system" | "developer") {
                user_system_prompts.push(message.content);
            } else {
                current_messages.push(message);
            }
        }
        if current_messages.is_empty() {
            return Err(Error::from_reason("Chat message content is required"));
        }
        return Ok(PreparedConversationRequest {
            conversation_id: String::new(),
            messages: current_messages.clone(),
            current_messages,
            user_system_prompts,
            host_system_prompts: Vec::new(),
        });
    }
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
            "Create a durable context handoff for the next assistant. You are in WorkTree Mode and the context window was exceeded. Preserve the original request branch, the confirmed repository status, the selected development branch or worktree, completed file changes, pending changes, build status, commit status, and the exact next Git-safe steps.\n\nProgress rules:\n- Judge what is done from actual evidence in the conversation (applied edits, tool results, build/commit output), NOT from TODO status. TODO items are often stale: work is finished but the item is still pending/inProgress.\n- Pending changes must list ONLY work that is genuinely not done. Never repeat completed work there and never ask the next assistant to re-check or re-verify it.\n- Add a `## TODO Sync` section listing every TODO item (id if visible in the latest TODO result, plus content) whose work is done but status is not completed, so the next assistant marks them completed immediately without re-investigating. Write \"None\" if all statuses are accurate.\n\nOutput ONLY the handoff document in Markdown. Do not call tools, address the user, or declare the work complete."
        } else if request.goal_mode {
            "Create a durable context handoff for the next assistant. You are in Goal Mode and the context window was exceeded, so this handoff MUST preserve the goal so work continues seamlessly.\n\nOutput ONLY the handoff document in Markdown. It MUST include ALL of the following sections:\n\n## Original Goal\nReproduce the user's original goal verbatim. This is the single most important piece of information — do not paraphrase or abbreviate it.\n\n## Success Criteria\nList every success criterion that defines goal completion. Mark each as [MET], [UNMET], or [UNCERTAIN] with brief evidence.\n\n## Completed Work\nBullet list of changes made so far, with exact file paths and function/symbol names. Judge completion from actual evidence in the conversation (applied edits, tool results, build output), NOT from TODO status: TODO items are often stale (work finished but still pending/inProgress).\n\n## Current State\nWhat the codebase looks like right now after your changes. What builds, what does not, what tests pass or fail.\n\n## Pending Tasks\nONLY work that is genuinely not done yet, ordered by priority. Never repeat completed work here and never ask the next assistant to re-check or re-verify it.\n\n## TODO Sync\nEvery TODO item (id if visible in the latest TODO result, plus content) whose work is done but status is not completed. The next assistant must mark them completed immediately without re-investigating. Write \"None\" if all statuses are accurate.\n\n## Key Decisions & Constraints\nArchitecture choices, constraints discovered, non-regression boundaries that must be respected.\n\n## Token Budget Status\nHow much of the token budget has been consumed (estimate), and how much remains.\n\n## Next Steps\nThe concrete next 1-3 actions the next assistant should take to continue toward the goal.\n\nRules:\n- Do NOT call tools.\n- Do NOT address the user conversationally.\n- Do NOT declare the goal complete — only the next assistant can do that after verifying.\n- Be concise but never omit information required to continue the work correctly."
        } else {
            "Create a durable context handoff for the next assistant. Output ONLY the handoff document in Markdown with these sections:\n\n## Objective\nThe user's requirements and constraints; keep exact wording where it matters.\n\n## Completed Work\nEvery change already done, with exact file paths and symbols. Judge completion from actual evidence in the conversation (applied edits, tool results, build output), NOT from TODO status: TODO items are often stale (work finished but still pending/inProgress).\n\n## Current State\nWhat builds or fails right now, plus exact commands or errors that still matter.\n\n## Remaining Work\nONLY work that is genuinely not done yet, in order. Never repeat completed work here and never ask the next assistant to re-check or re-verify it.\n\n## TODO Sync\nEvery TODO item (id if visible in the latest TODO result, plus content) whose work is done but status is not completed. The next assistant must mark them completed immediately without re-investigating. Write \"None\" if all statuses are accurate.\n\n## Key Context\nDecisions, architecture constraints, relevant files and symbols, edge cases.\n\n## Next Steps\nThe concrete next 1-3 actions.\n\nRules: be concise but do not omit information required to continue correctly. Do not call tools and do not address the user conversationally."
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
        // 工具结果同样可能内嵌图片 base64（filesystem-read 读图等）。前端在
        // 工具轮把 tool 消息直接放进下一轮请求（内存态，未经持久层），若只
        // persist content，base64 会直达守卫被按文本计数（百万 token 级误拦）。
        // 落盘后 payload 层构建 vision part 时从磁盘读回，发送行为不变。
        if let Some(raw) = message.tool_results_json.as_deref() {
            if raw.contains("@@image:data:") {
                message.tool_results_json =
                    Some(persist_inline_images_to_disk(raw, request.database_path)?);
            }
        }
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
            host_system_prompts: Vec::new(),
        });
    }

    // 随本次请求下发的 system/developer 文本（例如子代理内部续跑指令）只属于
    // 本次请求：既不写入系统槽（会重写整段缓存前缀），也不落库（会让历史看起来
    // 已经自带系统提示词，导致内置提示词之后被永久跳过）。
    let mut tail_instructions: Vec<String> = Vec::new();
    current_messages.retain(|message| {
        let system_class = matches!(message.role.trim(), "system" | "developer");
        if system_class {
            let content = message.content.trim();
            if !content.is_empty() {
                tail_instructions.push(content.to_string());
            }
        }
        !system_class
    });

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
    let system_prompt = build_builtin_system_prompt(&request, &conversation_id).await;
    // Rebuilt for every actual request (including post-compaction/restart); it is
    // request-only tail input, never persisted, never an acknowledgement or
    // task authorization.
    let ledger = super::sub_agent_ledger::context_section(
        request.database_path,
        &conversation_id,
        request.directory_id,
        request
            .allowed_tools
            .iter()
            .any(|tool| tool.full_name() == "sub-agents-sendMessage"),
    );
    let (user_system_prompts, demoted_sub_agent_prompt) = if request.is_sub_agent {
        compose_sub_agent_system_prompts(
            &system_prompt,
            &user_system_prompts,
            request.sub_agent_system_prompt,
        )
    } else {
        (user_system_prompts, None)
    };
    // Distinct host context is volatile by design (run status / delivery change on
    // every transition), so it is emitted as request-only tail input instead of a
    // system slot block: a system-slot change rewrites the cached prompt prefix and
    // makes every notification re-create the whole conversation context.
    let mut trailing_host_input: Vec<String> = ledger.into_iter().collect();
    let host_system_prompts: Vec<String> = Vec::new();

    // Main conversations retain the existing provider-specific built-in prompt
    // behavior. Sub-agents without configured prompts pass the unified ordered
    // prompt list directly to providers; with configured prompts their built-in
    // protocol becomes a system message that providers demote to a leading user
    // message, exactly like the main conversation.
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
    } else if let Some(demoted) = demoted_sub_agent_prompt {
        messages.insert(
            0,
            ChatContextMessage {
                role: "system".to_string(),
                content: demoted,
                tool_calls_json: None,
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
        );
    }

    // --- Conversation context attachments: 历史会话引用以 `@@conversation:`
    //     标签随用户消息内容进入请求，由各 provider 的 payload 构建层经
    //     parse_chat_message_content 展开为渲染后的上下文块（见 tags.rs）。 ---

    messages.extend(current_messages.iter().cloned());

    // --- Tool-pairing guard: ensure no orphan tool calls or results reach the
    //     AI API, which would reject the request outright. ---
    ensure_tool_pairing(&mut messages);

    // 历史图片按总量老化 / TODO 结果精简（仅请求副本）。
    super::history_trim::trim_history_for_request(&mut messages, request.database_path);

    // 请求尾部输入：易变宿主事实在前，本次请求的指令最后。仅在构建请求副本时
    // 追加，不参与工具配对/历史裁剪，也从不写入会话历史。
    trailing_host_input.extend(tail_instructions);
    if !trailing_host_input.is_empty() {
        messages.push(ChatContextMessage {
            role: "user".to_string(),
            content: trailing_host_input.join("\n\n"),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        });
    }

    Ok(PreparedConversationRequest {
        conversation_id,
        messages,
        current_messages,
        user_system_prompts,
        host_system_prompts,
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
