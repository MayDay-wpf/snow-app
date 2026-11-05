use napi::bindgen_prelude::*;

use crate::api::responses::ResponsesApiRequest;
use crate::mcp::tools::{
    collect_all_mcp_tools_for_workspace, collect_allowed_mcp_tools_for_workspace,
    collect_restricted_mcp_tools_for_workspace, McpTool,
};

/// Explicit child whitelists never inherit parent management or communication.
/// A request-scoped restricted list remains distinct from a child request.
pub async fn resolve_request_tools(request: &ResponsesApiRequest) -> Result<Vec<McpTool>> {
    let analysis_root = request
        .analysis_workspace_root
        .as_deref()
        .map(std::path::Path::new);
    // Plugin availability comes from the effective project configuration, not
    // conversation @ mentions. Explicit tool whitelists are applied separately.
    let active_plugin_ids = None;
    let search_conversation_id = if request.worktree_mode.unwrap_or(false) {
        None
    } else {
        request.conversation_id.as_deref()
    };
    match request.sub_agent_tools_json.as_deref() {
        Some(tools_json) => {
            // An empty child list must not fall through to the parent tool set.
            collect_allowed_mcp_tools_for_workspace(
                request.directory_id.as_deref(),
                analysis_root,
                if tools_json.trim().is_empty() {
                    "[]"
                } else {
                    tools_json
                },
                true,
                active_plugin_ids,
                search_conversation_id,
            )
            .await
        }
        None => match request.allowed_tools_json.as_deref() {
            Some(tools_json) if !tools_json.trim().is_empty() => {
                collect_restricted_mcp_tools_for_workspace(
                    request.directory_id.as_deref(),
                    analysis_root,
                    tools_json,
                    active_plugin_ids,
                    search_conversation_id,
                )
                .await
            }
            _ => {
                let mut tools = collect_all_mcp_tools_for_workspace(
                    request.directory_id.as_deref(),
                    analysis_root,
                    request.workflow_mode.unwrap_or(false),
                    active_plugin_ids,
                    // All model requests defer plugin tools until discovery.
                    true,
                    search_conversation_id,
                )
                .await?;
                apply_sub_agent_tool_policy(request, &mut tools).await?;
                Ok(tools)
            }
        },
    }
}

/// Intersect discovery with real persisted facts; never enable a disabled tool
/// or overwrite settings. The user setting is only the default execution mode:
/// each dispatch may choose its own, except workflow nodes, which are sync-only.
/// Existing runs keep their captured execution mode.
async fn apply_sub_agent_tool_policy(
    request: &ResponsesApiRequest,
    tools: &mut Vec<McpTool>,
) -> Result<()> {
    if !tools.iter().any(|tool| tool.server_id == "sub-agents") {
        // A missing management surface must not vanish without a trace: record the
        // request identity facts that decided it. Shape de-duplication keeps this
        // bounded across the many requests of one conversation.
        log_tool_policy(serde_json::json!({
            "reason": "no_sub_agents_tools_collected",
            "conversationPresent": request.conversation_id.as_deref().is_some_and(|id| !id.trim().is_empty()),
            "previousResponsePresent": request.previous_response_id.as_deref().is_some_and(|id| !id.trim().is_empty()),
            "projectBound": request.directory_id.as_deref().is_some_and(|id| !id.trim().is_empty()),
            "discovered": [],
            "retained": [],
        }));
        return Ok(());
    }
    let expected_project = request.directory_id.clone();
    // Computed before the blocking closure takes ownership of the project id.
    let request_project_bound = expected_project
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    let conversation_id = request
        .conversation_id
        .clone()
        .filter(|id| !id.trim().is_empty());
    let previous_response_id = request
        .previous_response_id
        .clone()
        .filter(|id| !id.trim().is_empty());
    let policy = tokio::task::spawn_blocking(move || -> Result<_> {
        use crate::storage::services::chat_conversations::{
            conversation_exists, find_conversation_id_by_response_id,
        };
        use crate::storage::services::system_settings;
        let storage = crate::storage::initialize_app_storage()?;
        let path = std::path::Path::new(&storage.database_path);
        let mode = system_settings::get_system_setting_value(path, "sub_agent_execution_mode")?;
        let asynchronous = match mode.as_deref() {
            None | Some("") | Some("sync") => false,
            Some("async") => true,
            _ => {
                return Err(Error::from_reason(
                    "CONFIGURATION_ERROR: invalid sub-agent execution mode setting",
                ))
            }
        };
        // Mirror the context layer's identity resolution (explicit id first, then
        // the last response id) without ever minting a conversation id here: a
        // tool-policy read must not fabricate durable identity.
        let resolved_conversation_id = match conversation_id.as_deref() {
            Some(id) => Some(id.to_string()),
            None => match previous_response_id.as_deref() {
                Some(response_id) => {
                    match find_conversation_id_by_response_id(path, response_id)? {
                        Some(id) => Some(id),
                        None if conversation_exists(path, response_id)? => {
                            Some(response_id.to_string())
                        }
                        None => None,
                    }
                }
                None => None,
            },
        };
        // No model-provided scope or fallback to another conversation/project.
        let ledger = resolved_conversation_id
            .as_deref()
            .map(|id| {
                super::sub_agent_ledger::load_host_ledger(
                    path,
                    id,
                    expected_project.as_deref(),
                    false,
                )
            })
            .transpose()?;
        Ok((asynchronous, ledger, resolved_conversation_id.is_some()))
    })
    .await
    .map_err(|_| Error::from_reason("SUB_AGENT_LEDGER_UNAVAILABLE: policy read failed"))??;
    let (asynchronous, ledger, identity_resolved) = policy;
    let is_child = ledger.as_ref().is_some_and(|facts| facts.is_child);
    // Workflow nodes run unattended inside a blocking workflow: they may delegate,
    // but only synchronously, so the node never settles before its children.
    let workflow_node = ledger.as_ref().is_some_and(|facts| facts.workflow_node);
    // A request without durable identity cannot prove child status, but it is still
    // a real project-bound main conversation: the context layer creates/attaches
    // that conversation on the same request. Delegation must therefore not vanish
    // merely because the first request of a session carries no conversation id yet.
    let supports_durable = ledger
        .as_ref()
        .map(|facts| facts.project_bound)
        .unwrap_or(request_project_bound);
    let has_children = ledger.as_ref().is_some_and(|facts| facts.has_children);
    let has_result = ledger.as_ref().is_some_and(|facts| facts.has_result);
    let has_result_reader = ledger
        .as_ref()
        .is_some_and(|facts| facts.has_result_reader);
    let has_cancellable = ledger.as_ref().is_some_and(|facts| facts.has_cancellable);
    let before = tools
        .iter()
        .filter(|tool| tool.server_id == "sub-agents")
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    tools.retain(|tool| {
        if tool.server_id != "sub-agents" {
            return true;
        }
        // A stored child cannot obtain management by omitting its whitelist.
        if is_child {
            return false;
        }
        match tool.name.as_str() {
            // 工具集必须保持稳定：按活跃运行/结果缓存增删工具会在每次派发与
            // 完成通知时改变请求工具列表，直接作废整段可缓存前缀。各工具自身
            // 会校验实时状态并返回结构化结果（无运行可取消等）。
            "activate" | "continue" | "getResult" | "cancel" => supports_durable,
            _ => false,
        }
    });
    // Only fixed tool names and policy facts: never log project paths or prompts.
    let retained = tools
        .iter()
        .filter(|tool| tool.server_id == "sub-agents")
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    log_tool_policy(serde_json::json!({
        "defaultMode":if asynchronous {"async"} else {"sync"},
        "workflowNode":workflow_node,
        "conversationPresent":request.conversation_id.as_deref().is_some_and(|id| !id.trim().is_empty()),
        "identityResolved":identity_resolved,
        "requestProjectBound":request_project_bound,
        "ledgerVerified":ledger.is_some(),"isChild":is_child,
        "supportsDurable":supports_durable,"hasChildren":has_children,
        "hasResult":has_result,"hasResultReader":has_result_reader,"hasCancellable":has_cancellable,
        "discovered":before,"retained":retained
    }));
    for tool in tools
        .iter_mut()
        .filter(|tool| tool.server_id == "sub-agents")
    {
        if matches!(tool.name.as_str(), "activate" | "continue") {
            let policy = if workflow_node {
                // The schema itself forbids async here, not just the prose.
                tool.input_schema["properties"]["executionMode"]["enum"] =
                    serde_json::json!(["sync"]);
                "Execution mode: this conversation is a workflow node, so only sync dispatch is supported. The call returns the child's final result; omit executionMode or pass \"sync\". Existing busy targets retain their original mode and only queue the message."
            } else if asynchronous {
                "Default execution mode (user setting): async. Choose per call with executionMode: sync when your next step depends on the result, async for long independent work. For async, trust the actual receipt executionMode/kind; accepted is not completion and host events deliver eligible results; do not poll. Existing busy targets retain their original mode and only queue the message."
            } else {
                "Default execution mode (user setting): sync. Choose per call with executionMode: sync when your next step depends on the result, async for long independent work. A sync dispatch returns its final result; no follow-up wait is needed. Existing busy targets retain their original mode and only queue the message. Trust the actual receipt executionMode/kind."
            };
            tool.description = format!("{policy}\n\n{}", tool.description);
        }
    }
    Ok(())
}

/// 每个模型请求都会重算一次工具策略，而形状绝大多数时候完全相同：同一形状只记录
/// 一次（最多记住 `MAX_LOGGED_SHAPES` 种形状），避免一次会话在 stderr 刷出成百上千
/// 行重复日志。形状再次变化时仍会立即输出，重启进程后重新开始记录。
/// 仅包含固定工具名与布尔事实，不记录项目路径或提示词。
fn log_tool_policy(payload: serde_json::Value) {
    const MAX_LOGGED_SHAPES: usize = 64;
    static LOGGED_SHAPES: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
        std::sync::Mutex::new(None);
    let signature = payload.to_string();
    let mut logged = match LOGGED_SHAPES.lock() {
        Ok(logged) => logged,
        Err(poisoned) => poisoned.into_inner(),
    };
    let shapes = logged.get_or_insert_with(std::collections::HashSet::new);
    if !shapes.insert(signature) {
        return;
    }
    if shapes.len() > MAX_LOGGED_SHAPES {
        // 形状数量保持有界：只保留最近记录过的形状，清空后当前形状可再次输出。
        shapes.clear();
    }
}

/// Explicit whitelists survive skip_context; compaction/tool-less requests do not.
pub fn should_resolve_tools(request: &ResponsesApiRequest) -> bool {
    !(request.context_compaction.unwrap_or(false)
        || request.disable_tools.unwrap_or(false)
        || (request.skip_context.unwrap_or(false) && !request.has_allowed_tools()))
}

/// Discovery failures never fabricate availability or fall back across scope.
pub async fn resolve_request_tools_optional(
    request: &ResponsesApiRequest,
) -> Result<Option<Vec<McpTool>>> {
    if !should_resolve_tools(request) {
        return Ok(None);
    }
    // A failed discovery is not a valid tool-less request. Surface the failure
    // before contacting the model; never invent permissions or hide availability.
    resolve_request_tools(request).await.map(Some)
}
