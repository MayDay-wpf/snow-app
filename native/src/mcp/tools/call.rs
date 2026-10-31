use super::*;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::Value;
use uuid::Uuid;

use super::super::builtin::{execute_builtin_tool, sanitize_tool_full_name};
use super::super::servers::app_control::{
    route_config_delete, route_config_set, AppControlCallback, AppControlService,
};
use super::super::servers::bash::{BashService, BashStreamCallback, BashStreamChunk};
use super::super::servers::browser::{BrowserCommandCallback, BrowserService};
use super::super::servers::codebase::CodebaseService;
use super::super::servers::config::ConfigService;
use super::super::servers::decision::DecisionService;
use super::super::servers::filesystem::FilesystemService;
use super::super::servers::grep::GrepService;
use super::super::servers::imagegen::ImageGenService;
use super::super::servers::lsp::LspService;
use super::super::servers::memory::MemoryService;
use super::super::servers::remote_workspace::{is_ssh_path, RemoteWorkspaceCallback};
use super::super::servers::skills::SkillsService;
use super::super::servers::sub_agents::is_sub_agent_reserved_tool;
use super::super::servers::terminal::{TerminalCommandCallback, TerminalService};
use super::super::servers::todo::TodoService;
use super::super::servers::user_interaction::{UserInteractionService, UserQuestionCallback};
use super::super::servers::websearch::{WebSearchCommandCallback, WebSearchService};
use super::collect::ensure_project_tool_enabled;
use super::result_limit::limit_tool_result;
use super::worktree_execution::{
    force_worktree_execution_args, is_builtin_mcp_tool, load_conversation_worktree_binding,
};

/// Register a cancellation token for a remote (SSH) tool execution and emit
/// its id as a `tool_execution` stream chunk so the frontend can abort the
/// pending Electron-side command (per-tool stop button / session stop).
/// Returns the id and token; the caller must `unregister_tool_execution` when
/// the execution settles.
fn register_remote_tool_execution(
    on_chunk: &BashStreamCallback,
) -> (String, tokio_util::sync::CancellationToken) {
    let tool_execution_id = Uuid::new_v4().to_string();
    let cancel_token = crate::api::cancel::register_tool_execution(&tool_execution_id);
    on_chunk.call(
        BashStreamChunk {
            stream: "tool_execution".to_string(),
            data: tool_execution_id.clone(),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    (tool_execution_id, cancel_token)
}

/// 非内置（外部）工具登记为可中止执行：发出 execution id，供停止按钮中止。
pub(crate) fn begin_external_tool_execution(
    tool_full_name: &str,
    on_chunk: &BashStreamCallback,
) -> Option<(String, tokio_util::sync::CancellationToken)> {
    if is_builtin_mcp_tool(&sanitize_tool_full_name(tool_full_name)) {
        return None;
    }
    Some(register_remote_tool_execution(on_chunk))
}

/// Only errors from an invoked service are tool feedback. Context, authorization,
/// checkpoint, join, serialization and privacy failures retain their host boundary.
trait SubAgentToolFeedback {
    fn tool_feedback(self, delegated: bool) -> napi::Result<Value>;
    fn validation_feedback(self, delegated: bool) -> napi::Result<Value>;
}
impl SubAgentToolFeedback for napi::Result<Value> {
    // Metadata-oriented services must not turn an unclassified storage/config
    // failure into a model-repairable operation. Their argument errors may retry.
    fn validation_feedback(self, delegated: bool) -> napi::Result<Value> {
        match self {
            Err(error) if error.status != Status::InvalidArg => Err(error),
            result => result.tool_feedback(delegated),
        }
    }

    fn tool_feedback(self, delegated: bool) -> napi::Result<Value> {
        if !delegated {
            return self;
        }
        let error = match self {
            Ok(result) => return Ok(result),
            Err(error) => error,
        };
        if !matches!(error.status, Status::GenericFailure | Status::InvalidArg) {
            return Err(error);
        }
        let reason = error.reason.trim();
        let payload = serde_json::from_str::<Value>(reason).ok();
        let code = payload
            .as_ref()
            .and_then(|value| {
                value
                    .get("code")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("error").and_then(Value::as_str))
            })
            .unwrap_or(reason);
        let protected = [
            "[SELF-PROTECTION]",
            "PERMISSION_DENIED",
            "TOOL_EXECUTION_DENIED",
            "SENSITIVE_COMMAND_DETECTED",
            "OWNER_MISMATCH",
            "PERSISTENCE_ERROR",
            "HOST_OPERATION_FAILED",
            "INVALID_TRANSITION",
            "CONFIGURATION_ERROR",
            "CONVERSATION_DELETING",
            "DELETE_PENDING",
            "ROLLBACK_",
            "RUN_CANCELLED",
        ]
        .iter()
        .any(|prefix| reason.starts_with(prefix) || code.starts_with(prefix))
            || payload.as_ref().is_some_and(|value| {
                [
                    "requiresConfirmation",
                    "requiresApproval",
                    "cancelled",
                    "denied",
                    "skipped",
                ]
                .iter()
                .any(|field| value.get(*field).and_then(Value::as_bool) == Some(true))
            });
        if protected {
            return Err(error);
        }
        let mut feedback = match payload {
            Some(Value::Object(object)) => object,
            _ => serde_json::Map::new(),
        };
        feedback.insert("success".into(), Value::Bool(false));
        if !feedback.contains_key("error") {
            feedback.insert("error".into(), Value::String(error.reason.clone()));
        }
        Ok(Value::Object(feedback))
    }
}

/// Execute an MCP tool and capture incremental checkpoint state immediately
pub async fn call_mcp_tool(
    tool_full_name: String,
    args_json: String,
    project_id: Option<String>,
    checkpoint_ids: Vec<String>,
    checkpoint_work_dir: Option<String>,
    sensitive_authorization_token: Option<String>,
    on_chunk: BashStreamCallback,
    on_browser_command: BrowserCommandCallback,
    on_websearch_command: WebSearchCommandCallback,
    on_user_question: UserQuestionCallback,
    on_app_control: AppControlCallback,
    on_remote_workspace_command: RemoteWorkspaceCallback,
    on_terminal_command: TerminalCommandCallback,
    sub_agent_allowed_tools: Option<Vec<String>>,
    conversation_id: Option<String>,
) -> napi::Result<String> {
    // Sanitize: AI may copy "[Tool: server-tool#callId]" from conversation
    // history or leak internal XML tags into the tool name. Normalize
    // before any matching or whitelist check.
    let tool_full_name = sanitize_tool_full_name(&tool_full_name);
    let is_sub_agent_call = sub_agent_allowed_tools.is_some();
    let requires_workspace_context = tool_full_name.starts_with("terminal-")
        || tool_full_name.starts_with("lsp-")
        || matches!(
            tool_full_name.as_str(),
            "filesystem-read"
                | "filesystem-replace_edit"
                | "filesystem-create"
                | "filesystem-copy"
                | "grep-search"
                | "grep-find"
                | "bash-terminal-execute"
        );
    // Workspace tools must never resolve relative paths against the Electron
    // process working directory. A conversation id is the normal anchor; a
    // request-scoped project id (the desktop pet's stateless side channel)
    // anchors paths to the project root instead.
    let has_conversation = conversation_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    let has_project = project_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    if requires_workspace_context && !has_conversation && !has_project {
        return Err(Error::new(
            Status::GenericFailure,
            "Workspace tool execution requires a conversation id or project id; refusing to use the process working directory".to_string(),
        ));
    }

    let args = parse_tool_args(&tool_full_name, &args_json)?;
    let conversation_modes = if let Some(conversation_id) = conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let conversation_id = conversation_id.to_string();
        Some(
            tokio::task::spawn_blocking(move || {
                crate::storage::get_conversation_modes(&conversation_id)
            })
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to resolve conversation workspace mode: {error}"),
                )
            })??,
        )
    } else {
        None
    };
    let worktree_mode = conversation_modes
        .as_ref()
        .is_some_and(|modes| modes.worktree_mode.unwrap_or(false));
    let worktree_binding = if worktree_mode || (requires_workspace_context && has_conversation) {
        let conversation_id = conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "WorkTree execution requires a conversation id; refusing to use an unbound workspace".to_string(),
                )
            })?
            .to_string();
        let directory_id = project_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "Workspace tool execution requires the conversation's project directory id"
                        .to_string(),
                )
            })?;
        let binding =
            load_conversation_worktree_binding(conversation_id, directory_id.to_string()).await?;
        if worktree_mode && binding.is_none() {
            return Err(Error::new(
                Status::GenericFailure,
                "WorkTree mode is enabled but this conversation has no persisted worktree binding. Bind a worktree before using WorkTree mode.".to_string(),
            ));
        }
        if worktree_mode && !is_builtin_mcp_tool(&tool_full_name) {
            return Err(Error::new(
                Status::GenericFailure,
                format!("External MCP tool '{tool_full_name}' was blocked: WorkTree mode cannot safely restrict arbitrary tool paths or side effects. Disable WorkTree mode or use a built-in tool with supported workspace scoping."),
            ));
        }
        binding
    } else {
        None
    };
    let args = if let Some(binding) = worktree_binding.as_ref() {
        force_worktree_execution_args(&tool_full_name, args, binding)?
    } else {
        // bash 未填 workingDirectory 时兜底为当前会话项目目录。WorkTree
        // 分支在上面先强制设置为 canonical worktree_path，不会走项目根 fallback。
        default_bash_working_directory(&tool_full_name, args, project_id.as_deref()).await?
    };
    let checkpoint_work_dir = worktree_binding
        .as_ref()
        .map(|binding| binding.path.clone())
        .or(checkpoint_work_dir);

    // 子代理白名单中显式列出的工具豁免项目级启停（通配符不豁免）；
    // 保留工具任何情况下都不对子代理开放。
    if is_sub_agent_call && is_sub_agent_reserved_tool(&tool_full_name) {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Tool is reserved for the main conversation and unavailable to sub-agents: {tool_full_name}"),
        ));
    }
    let project_override = sub_agent_allowed_tools
        .as_ref()
        .is_some_and(|tools| tools.iter().any(|name| name == &tool_full_name));
    ensure_project_tool_enabled(project_id.as_deref(), &tool_full_name, project_override).await?;

    if let Some(ref allowed_tools) = sub_agent_allowed_tools {
        let explicitly_allowed = allowed_tools.iter().any(|name| name == &tool_full_name);
        // Communication requires the explicit runtime token produced by the
        // configured-capability/current-delegation intersection. A bare wildcard
        // must not restore the retired implicit teammate-tool exemption.
        let wildcard_allowed = allowed_tools.iter().any(|name| name == "*")
            && !SUB_AGENT_COMMS_TOOL_FULL_NAMES.contains(&tool_full_name.as_str());
        if !explicitly_allowed && !wildcard_allowed {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Sub-agent tool is not in the allowed whitelist: {tool_full_name}"),
            ));
        }
    }

    let (args, uses_remote_workspace) =
        prepare_remote_workspace_args(&tool_full_name, args, project_id.as_deref()).await?;

    // 本地（非 SSH）filesystem / grep 工具：将相对路径（如 "."）
    // 解析到当前项目根目录，避免其被解析为 Electron 进程的工作目录。
    let mut args = if uses_remote_workspace {
        args
    } else {
        let mut resolved =
            resolve_local_workspace_args(&tool_full_name, args, project_id.as_deref()).await?;
        if tool_full_name == "filesystem-copy" {
            if let Some(source) = resolved
                .get("sourceFilePath")
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                let source_args = serde_json::json!({"filePath": source});
                let source_args = resolve_local_workspace_args(
                    "filesystem-read",
                    source_args,
                    project_id.as_deref(),
                )
                .await?;
                resolved["sourceFilePath"] = source_args["filePath"].clone();
            }
        }
        resolved
    };
    if tool_full_name == "bash-terminal-execute" {
        // Host identity only; never trust a model-provided sessionId.
        args["sessionId"] = conversation_id
            .as_deref()
            .map(Value::from)
            .unwrap_or(Value::Null);
    }

    // 先定 checkpoint 影响范围再捕获：None 的工具不校验
    // checkpointWorkDir，Skill / 外部 MCP 等不因缺失上下文被阻断。
    let checkpoint_scope = tool_checkpoint_scope(&tool_full_name);
    // 外部 MCP 不取 checkpoint 锁、也不记录变更：只提示本次调用无回滚保护。
    if !is_builtin_mcp_tool(&tool_full_name) && !checkpoint_ids.is_empty() {
        let locale = crate::i18n::app_locale().await;
        emit_stream_chunk(
            &on_chunk,
            "stdout",
            crate::i18n::fill(
                locale.checkpoint_text(crate::i18n::CheckpointText::UnknownToolScope),
                &[&tool_full_name],
            ),
        );
    }
    let skip_checkpoint_capture = tool_full_name == "bash-terminal-execute"
        && args
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(is_readonly_bash_command);

    // 执行级锁覆盖 before、真实工具执行和 after（文件工具共享读锁），不能
    // 只锁两次扫描本身；否则同项目的另一个会话可在中间落盘，其结果会被当前
    // 会话误认为自己的变更。bash 与外部 MCP 例外：执行期间不持锁——跨会话
    // 命令并行运行，慢速外部请求也不再阻塞其他会话的文件编辑与回滚；bash
    // 的 before/after 扫描内部的短时共享读锁 + 回滚纪元保证变更记录不与
    // 回滚混淆。
    let checkpoint_operation_guard = if skip_checkpoint_capture {
        ToolCheckpointOperationGuard::None
    } else {
        acquire_tool_checkpoint_operation_guard(
            &tool_full_name,
            checkpoint_scope,
            &args,
            checkpoint_work_dir.as_deref(),
        )
        .await?
    };
    let checkpoint_ids = match checkpoint_scope {
        ToolCheckpointScope::File | ToolCheckpointScope::Worktree => {
            if skip_checkpoint_capture {
                Vec::new()
            } else {
                checkpoint_ids
            }
        }
        ToolCheckpointScope::None => Vec::new(),
    };

    let checkpoint_capture = if uses_remote_workspace {
        // SSH 工具：checkpoint 捕获经 Electron SFTP 完成（异步）。
        capture_checkpoint_before_tool_remote(
            &tool_full_name,
            &args,
            checkpoint_ids,
            checkpoint_work_dir,
            &on_remote_workspace_command,
            &on_chunk,
        )
        .await?
    } else {
        let checkpoint_tool_name = tool_full_name.clone();
        let checkpoint_args = args.clone();
        tokio::task::spawn_blocking(move || {
            capture_checkpoint_before_tool(
                &checkpoint_tool_name,
                &checkpoint_args,
                checkpoint_ids,
                checkpoint_work_dir,
            )
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to capture checkpoint before tool execution: {error}"),
            )
        })??
    };

    let returns_plain_text = tool_full_name == "skills-skill-execute";
    let masking_tool_name = tool_full_name.clone();
    let result = if tool_full_name == "bash-terminal-execute" {
        let tracking =
            super::file_tracking::TerminalTracking::begin(&args, uses_remote_workspace).await;
        let terminal_result = BashService::new()
            .execute_terminal_stream(
                &args,
                project_id.as_deref(),
                sensitive_authorization_token.as_deref(),
                on_chunk,
                &on_remote_workspace_command,
            )
            .await;
        // Even nonzero, timeout and N-API errors get an after scan. Collection
        // failures never replace the executor's output/status/security error.
        let mut file_tracking = tracking.finish().await;
        if let ToolCheckpointCapture::Worktree(Some(capture)) = checkpoint_capture {
            let after_result = if uses_remote_workspace {
                // on_chunk 已被流式执行器占用，after 阶段不发提示
                capture_checkpoint_after_tool_remote(
                    ToolCheckpointCapture::Worktree(Some(capture)),
                    &on_remote_workspace_command,
                    None,
                )
                .await
            } else {
                // Worktree 的 after 软失败：记录失败不覆盖已完成的命令结果。
                tokio::task::spawn_blocking(move || {
                    capture_checkpoint_after_tool(ToolCheckpointCapture::Worktree(Some(capture)))
                })
                .await
                .map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to capture checkpoint after tool execution: {error}"),
                    )
                })
                .and_then(|result| result)
            };
            if after_result.is_err() {
                if let Some(reasons) = file_tracking["reasons"].as_array_mut() {
                    reasons.push(Value::String("checkpoint-after-failed".into()));
                }
            }
        }
        let mut result = terminal_result
            .map_err(|mut error| {
                // Sensitive-command errors are themselves JSON parsed by the host.
                // Preserve that shape, status and all existing safety fields.
                if let Ok(Value::Object(mut payload)) = serde_json::from_str::<Value>(&error.reason)
                {
                    payload.insert("fileTracking".into(), file_tracking.clone());
                    error.reason = Value::Object(payload).to_string();
                } else if !error.reason.starts_with("[SELF-PROTECTION]") {
                    error.reason = serde_json::json!({
                        "error": error.reason,
                        "fileTracking": file_tracking.clone(),
                    })
                    .to_string();
                }
                error
            })
            .tool_feedback(is_sub_agent_call)?;
        result["fileTracking"] = file_tracking;
        result
    } else if tool_full_name == "grep-search" {
        // Register a cancellable tool execution only for the SSH branch; the
        // local ripgrep/native search has its own 30s timeout and cannot be
        // aborted through the exec-channel registry.
        let remote_cancel = if args
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(is_ssh_path)
        {
            Some(register_remote_tool_execution(&on_chunk))
        } else {
            None
        };
        let search_result = GrepService::new()
            .execute_search(
                &args,
                &on_remote_workspace_command,
                remote_cancel.as_ref().map(|(_, token)| token),
            )
            .await;
        if let Some((tool_execution_id, _)) = remote_cancel {
            crate::api::cancel::unregister_tool_execution(&tool_execution_id);
        }
        annotate_grep_result_with_semantic_routing(
            search_result.tool_feedback(is_sub_agent_call)?,
            &args,
            project_id.as_deref(),
            sub_agent_allowed_tools.as_deref(),
        )
        .await
    } else if tool_full_name == "grep-find" {
        // 本地遍历自带 30s 超时；只有 SSH 分支需要注册可取消执行。
        let remote_cancel = if args
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(is_ssh_path)
        {
            Some(register_remote_tool_execution(&on_chunk))
        } else {
            None
        };
        let find_result = GrepService::new()
            .execute_find(
                &args,
                &on_remote_workspace_command,
                remote_cancel.as_ref().map(|(_, token)| token),
            )
            .await;
        if let Some((tool_execution_id, _)) = remote_cancel {
            crate::api::cancel::unregister_tool_execution(&tool_execution_id);
        }
        find_result.tool_feedback(is_sub_agent_call)?
    } else if uses_remote_workspace {
        let filesystem_tool = tool_full_name.strip_prefix("filesystem-").ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("Unsupported remote workspace MCP tool: {tool_full_name}"),
            )
        })?;
        let (tool_execution_id, cancel_token) = register_remote_tool_execution(&on_chunk);
        let fs_result = FilesystemService::new()
            .execute_async(
                filesystem_tool,
                &args,
                &on_remote_workspace_command,
                Some(&cancel_token),
            )
            .await;
        crate::api::cancel::unregister_tool_execution(&tool_execution_id);
        // 无论工具成败都执行 after 捕获（与本地 builtin 分支一致）；
        // after 失败优先于工具错误上报。
        capture_checkpoint_after_tool_remote(
            checkpoint_capture,
            &on_remote_workspace_command,
            Some(&on_chunk),
        )
        .await?;
        fs_result.tool_feedback(is_sub_agent_call)?
    } else if tool_full_name == "todo-todo-manage" {
        // 会话隔离键由分发层注入当前会话 ID（与 memory 相同模式），
        // 模型传入的 sessionId 参数一律忽略，无法跨会话读写。
        TodoService::new()
            .execute_async(&args, conversation_id.as_deref())
            .await
            .validation_feedback(is_sub_agent_call)?
    } else if let Some(memory_tool) = tool_full_name.strip_prefix("memory-") {
        // 项目记忆工具集：project_id 由调用链注入（当前会话项目），
        // 工具参数不携带 projectId，模型无法跨项目读写；conversation_id
        // 同理由调用链注入（memory-save 的溯源锚点，AI 不可填写）。
        MemoryService::new()
            .execute_async(
                memory_tool,
                &args,
                project_id.as_deref(),
                conversation_id.as_deref(),
            )
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if tool_full_name == "websearch-websearch-search" {
        WebSearchService::new()
            .execute_async("websearch-search", &args, &on_websearch_command)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if tool_full_name == "websearch-websearch-fetch" {
        WebSearchService::new()
            .execute_fetch(&args)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if tool_full_name == "imagegen-generate" {
        // Main injects the interaction anchor; conversation ownership is always the real executor scope.
        let interaction_id = args
            .get("__snowImageGeneration")
            .and_then(|context| context.get("interactionId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        args["__snowImageGeneration"] = serde_json::json!({
            "conversationId": conversation_id.as_deref().unwrap_or(""),
            "interactionId": interaction_id,
        });
        ImageGenService::new()
            .execute_generate(&args, on_chunk)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if tool_full_name == "imagegen-image-describe" {
        ImageGenService::new()
            .execute_describe(&args, conversation_id.as_deref())
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if tool_full_name == "decision-evaluate" {
        // 图片路径只允许落在当前工作区：WorkTree 模式限定为绑定的 worktree。
        let workspace_roots = match worktree_binding.as_ref() {
            Some(binding) => vec![binding.path.clone()],
            None => resolve_local_workspace_roots(project_id.as_deref()).await?,
        };
        let usage_scope = crate::api::decision_model::DecisionUsageScope {
            model_name: String::new(),
            conversation_id: conversation_id
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
            directory_id: project_id
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
        };
        DecisionService::new()
            .execute_evaluate(&args, &workspace_roots, usage_scope)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if let Some(tool_name) = tool_full_name.strip_prefix("browser-") {
        BrowserService::new()
            .execute_async(tool_name, &args, &on_browser_command)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if let Some(tool_name) = tool_full_name.strip_prefix("terminal-") {
        TerminalService::new()
            .execute_async(tool_name, &args, &on_terminal_command)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if tool_full_name == "user-interaction-askUserQuestion" {
        UserInteractionService::new()
            .execute_async(&args, &on_user_question)
            .await?
    } else if tool_full_name == "config-logs-read" {
        let conversation_id = conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "Reading Snow App logs requires the current conversation ID",
                )
            })?;
        let mut scoped_args = args.clone();
        scoped_args["conversationId"] = serde_json::json!(conversation_id);
        let service = super::super::servers::app_logs::AppLogsService::new();
        tokio::task::spawn_blocking(move || {
            super::super::service::McpService::execute(&service, "logs-read", &scoped_args)
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("App log query task failed: {error}"),
            )
        })??
    } else if let Some(app_control_tool) = tool_full_name.strip_prefix("app-control-") {
        AppControlService::new()
            .execute_async(app_control_tool, &args, &on_app_control)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if let Some(routed) = match tool_full_name.as_str() {
        "config-set" => route_config_set(&args, project_id.as_deref()),
        "config-delete" => route_config_delete(&args, project_id.as_deref()),
        _ => None,
    } {
        // 依赖渲染层状态的 config 写操作（定时任务/新建项目/站点拦截）走 app-control 桥。
        let (action, payload) = routed?;
        AppControlService::new()
            .dispatch(action, payload, &on_app_control)
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if let Some(config_tool) = tool_full_name.strip_prefix("config-") {
        // 传入运行时已知的当前会话 projectId（directoryId）。ConfigService
        // 内部会将其注入到支持项目级作用域的调用（hooks/subAgents/skills/
        // settings 项目键），并让 config-list 返回 currentProjectId，
        // 修复 AI 无法获知当前会话项目ID导致项目级配置落到全局的问题。
        ConfigService::new()
            .execute_async(config_tool, &args, project_id.clone())
            .await
            .validation_feedback(is_sub_agent_call)?
    } else if tool_full_name == "skills-skill-execute" {
        SkillsService::new()
            .execute(&args, project_id.as_deref())
            .await
            .validation_feedback(is_sub_agent_call)?
    } else if tool_full_name == "codebase-search" {
        CodebaseService::new()
            .execute_search(
                &args,
                project_id.as_deref(),
                conversation_id.as_deref(),
                &on_chunk,
            )
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if let Some(lsp_tool) = tool_full_name.strip_prefix("lsp-") {
        let service = LspService::new();
        service
            .execute_lsp_tool(lsp_tool, &args, project_id.as_deref())
            .await
            .tool_feedback(is_sub_agent_call)?
    } else if let Some(filesystem_tool) = tool_full_name.strip_prefix("filesystem-") {
        // 本地文件系统工具走异步执行路径：编辑成功后（auto-format 开启时）
        // 需要异步调用 Prettier 格式化，同步 execute_builtin_tool 无法完成。
        // 远程工作区（SSH）已在 uses_remote_workspace 分支处理，此处不重复；
        // execute_async 内部对 ssh:// 路径仍会转发，保持行为一致。
        let filesystem_result = FilesystemService::new()
            .execute_async(filesystem_tool, &args, &on_remote_workspace_command, None)
            .await;
        // 工具执行后（含自动格式化）捕获检查点，与同步默认分支语义一致；
        // 无论工具成功与否都先完成 after 捕获再传播结果。
        tokio::task::spawn_blocking(move || capture_checkpoint_after_tool(checkpoint_capture))
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to capture checkpoint after tool execution: {error}"),
                )
            })??;
        filesystem_result.tool_feedback(is_sub_agent_call)?
    } else if let Some(result) = super::super::external::call_tool(
        project_id.as_deref(),
        &tool_full_name,
        &args,
        project_override,
    )
    .await?
    {
        result
    } else {
        tokio::task::spawn_blocking(move || {
            let result =
                execute_builtin_tool(&tool_full_name, &args).tool_feedback(is_sub_agent_call);
            capture_checkpoint_after_tool(checkpoint_capture)?;
            result
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to execute MCP tool: {error}"),
            )
        })??
    };

    // result 已包含 after 捕获结果；现在才释放执行级锁。隐私遮罩和序列化不再
    // 访问工作区，无需继续阻塞同项目的其他并行工具。
    drop(checkpoint_operation_guard);

    if returns_plain_text && result.get("success").and_then(Value::as_bool) != Some(false) {
        let plain_text = result.as_str().map(str::to_string).ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "Skill execution returned an invalid text result".to_string(),
            )
        })?;
        let masked =
            super::super::privacy_mask::mask_tool_result_if_needed(&masking_tool_name, &plain_text)
                .await?;
        return Ok(limit_tool_result(&masking_tool_name, masked).await);
    }

    // Image generation already masked its free text before persisting the task.
    // Never send its routing UUIDs, image refs or snapshot JSON through a text masker/truncator.
    if masking_tool_name == "imagegen-generate" {
        return serialize_tool_result(&result);
    }
    let serialized = persist_result_images(result).await?;
    let masked =
        super::super::privacy_mask::mask_tool_result_if_needed(&masking_tool_name, &serialized)
            .await?;
    Ok(limit_tool_result(&masking_tool_name, masked).await)
}

fn serialize_tool_result(result: &Value) -> napi::Result<String> {
    serde_json::to_string(result).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize result: {error}"),
        )
    })
}

/// 顶层 `content` 数组里带真实 base64 的 MCP 图片块。
fn has_inline_image_blocks(result: &Value) -> bool {
    result
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| blocks.iter().any(is_inline_image_block))
}

fn is_inline_image_block(block: &Value) -> bool {
    block.get("type").and_then(Value::as_str) == Some("image")
        && block
            .get("data")
            .and_then(Value::as_str)
            .is_some_and(|data| !data.is_empty() && data != INLINE_IMAGE_PLACEHOLDER)
}

/// 与前端 `IMAGE_DATA_PLACEHOLDER` 一致：图片已落盘，`path` 指向 upload 引用。
const INLINE_IMAGE_PLACEHOLDER: &str = "[attached as multimodal image]";

/// 工具结果里的图片 base64（MCP 图片块 / `@@image:data:` 标签）落盘为 upload
/// 引用后再交给渲染进程：会话内存、数据库与后续请求都只携带短路径，视觉负载
/// 在组装模型请求时由 payload 层按路径读盘。落盘失败时保留原始内容。
async fn persist_result_images(mut result: Value) -> napi::Result<String> {
    if has_inline_image_blocks(&result) {
        result = super::collect::with_database_path(move |database_path| {
            if let Some(blocks) = result.get_mut("content").and_then(Value::as_array_mut) {
                for block in blocks.iter_mut().filter(|block| is_inline_image_block(block)) {
                    let data = block.get("data").and_then(Value::as_str).unwrap_or("");
                    if let Ok(Some(path)) =
                        crate::api::conversation::images::persist_base64_image_data(
                            data,
                            &database_path,
                        )
                    {
                        block["data"] = Value::String(INLINE_IMAGE_PLACEHOLDER.to_string());
                        block["path"] = Value::String(path);
                    }
                }
            }
            Ok(result)
        })
        .await?;
    }
    let serialized = serialize_tool_result(&result)?;
    if !serialized.contains("@@image:data:") {
        return Ok(serialized);
    }
    super::collect::with_database_path(move |database_path| {
        Ok(
            match crate::api::conversation::images::persist_inline_images_to_disk(
                &serialized,
                &database_path,
            ) {
                Ok(persisted) => persisted,
                Err(_) => serialized,
            },
        )
    })
    .await
}

/// 语义路由纠偏（2026-09-24，配合 LSP 系统提示词章节与 grep-search 描述注入）：
/// 当 `pattern` 是裸标识符（典型「找符号」查询）且项目 LSP 语义工具实际可用时，
/// 在 grep 结果里附加 `semanticRoutingHint` 字段，指向 lsp-* 替代工具。
///
/// 根因：grep 无法区分真实引用与同名符号（其他模块的同名常量、注释、字符串
/// 字面量），模型拿到「看起来有结果」的匹配集就继续走；提示词层的 MUST 规则
/// 实测无法稳定改变这条路径依赖（`lsp/mod.rs` 记录：grep 941 次 vs lsp-* 145 次），
/// 因此在**结果返回的那一刻**给出可行动的纠正。判据刻意收窄（仅裸标识符 +
/// LSP 可用），正则/路径/中文/字面量停用词一概不触发，不影响字面文本搜索。
/// 前端渲染忽略额外字段，模型侧只多一行 JSON。
async fn annotate_grep_result_with_semantic_routing(
    result: Value,
    args: &Value,
    project_id: Option<&str>,
    allowed_tools: Option<&[String]>,
) -> Value {
    let Some(pattern) = args.get("pattern").and_then(Value::as_str) else {
        return result;
    };
    if !looks_like_bare_symbol(pattern) {
        return result;
    }
    let analysis_root = match args.get("workspaceRoot") {
        Some(Value::String(root)) => Some(std::path::Path::new(root)),
        Some(_) => return result,
        None => None,
    };
    let visible =
        super::collect::visible_lsp_tool_names(project_id, allowed_tools, analysis_root).await;
    let snapshot = super::super::servers::lsp::prompt_context::ToolSnapshot::from_names(visible);
    let Some(hint) = snapshot.grep_hint() else {
        return result;
    };
    let mut map = match result {
        Value::Object(map) => map,
        other => return other,
    };
    map.insert("semanticRoutingHint".to_string(), Value::String(hint));
    Value::Object(map)
}

/// Heuristic for queries that may be semantic; a bare identifier can also be
/// literal text, so the annotation is advisory rather than a forced reroute.
fn looks_like_bare_symbol(pattern: &str) -> bool {
    const LITERAL_STOPWORDS: &[&str] = &[
        "todo",
        "fixme",
        "hack",
        "note",
        "import",
        "export",
        "return",
        "function",
        "const",
        "class",
        "async",
        "await",
        "interface",
        "struct",
        "impl",
        "pub",
        "use",
        "mod",
        "let",
        "var",
        "type",
        "enum",
        "true",
        "false",
        "null",
        "none",
        "undefined",
        "console",
        "print",
        "select",
        "where",
    ];
    let trimmed = pattern.trim();
    if trimmed.len() < 3 || trimmed.len() > 64 {
        return false;
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
        return false;
    }
    !LITERAL_STOPWORDS.contains(&trimmed.to_ascii_lowercase().as_str())
}
