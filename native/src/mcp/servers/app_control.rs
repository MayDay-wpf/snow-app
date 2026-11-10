use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

pub const SERVER_ID: &str = "app-control";

const TOOL_SET_MODE: &str = "setMode";
const TOOL_OPEN_SETTINGS: &str = "openSettings";
const TOOL_CONVERSATION: &str = "conversation";

#[napi(object)]
pub struct AppControlCommand {
    /// Action identifier: "get_blocked_patterns" | "update_blocked_patterns" | "set_mode" | "open_settings" | "create_scheduled_task" | "update_scheduled_task" | "delete_scheduled_task" | "run_scheduled_task_now" | "cancel_scheduled_task_run" | "create_project" | "create_conversation" | "send_conversation_message" | "activate_conversation"
    pub action: String,
    /// JSON-encoded action payload
    pub payload_json: String,
}

pub type AppControlCallback =
    ThreadsafeFunction<AppControlCommand, Promise<String>, AppControlCommand, Status, false>;

pub struct AppControlService;

impl AppControlService {
    pub fn new() -> Self {
        AppControlService
    }

    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_app_control: &AppControlCallback,
    ) -> napi::Result<Value> {
        let (action, payload) = match tool_name {
            TOOL_SET_MODE => validate_set_mode_args(args)?,
            TOOL_OPEN_SETTINGS => validate_open_settings_args(args)?,
            TOOL_CONVERSATION => validate_conversation_args(args)?,
            _ => return Err(unknown_tool_error(tool_name)),
        };

        self.dispatch(action, payload, on_app_control).await
    }

    /// 把已校验的动作转发给渲染层执行（config-manage 的 action=set 路由也复用此入口）。
    pub async fn dispatch(
        &self,
        action: String,
        payload: Value,
        on_app_control: &AppControlCallback,
    ) -> napi::Result<Value> {
        let command = AppControlCommand {
            action,
            payload_json: serde_json::to_string(&payload).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize app control payload: {error}"),
                )
            })?,
        };

        let promise = on_app_control
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch app control command to Electron: {error}"),
                )
            })?;
        let result_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("App control command failed: {error}"),
            )
        })?;

        let result: Value = serde_json::from_str(&result_json).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("App control returned invalid JSON: {error}"),
            )
        })?;

        Ok(result)
    }
}

impl McpService for AppControlService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_SET_MODE.to_string(),
                description: "Enable or disable WorkTree Mode or Goal Mode in the Snow App. WorkTree Mode isolates implementation on a local Git branch or worktree. Goal Mode enables autonomous long-running execution with a token budget. The two modes are mutually exclusive.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["goal", "worktree"],
                            "description": "Which mode to toggle: \"goal\" for Goal Mode or \"worktree\" for WorkTree Mode. The two modes are mutually exclusive."
                        },
                        "enabled": {
                            "type": "boolean",
                            "description": "true to enable the mode, false to disable it."
                        }
                    },
                    "required": ["mode", "enabled"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_OPEN_SETTINGS.to_string(),
                description: "Open a specific settings page in the Snow App UI. Available pages: api-settings, imagegen-settings, image-library, proxy-browser-settings, codebase-settings, system-prompt-settings, personalization-settings, custom-headers-settings, mcp-settings, lsp-settings, skills-settings, sub-agent-settings, sensitive-command-settings, custom-commands-settings, hooks-settings, theme-settings, terminal-settings, browser-settings, keyboard-shortcuts-settings, privacy-settings, usage-settings, system-logs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "page": {
                            "type": "string",
                            "enum": [
                                "api-settings",
                                "imagegen-settings",
                                "image-library",
                                "proxy-browser-settings",
                                "codebase-settings",
                                "system-prompt-settings",
                                "personalization-settings",
                                "custom-headers-settings",
                                "mcp-settings",
                                "lsp-settings",
                                "skills-settings",
                                "sub-agent-settings",
                                "sensitive-command-settings",
                                "custom-commands-settings",
                                "hooks-settings",
                                "theme-settings",
                                "terminal-settings",
                                "browser-settings",
                                "keyboard-shortcuts-settings",
                                "privacy-settings",
                                "usage-settings",
                                "system-logs"
                            ],
                            "description": "The settings page identifier to open."
                        }
                    },
                    "required": ["page"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_CONVERSATION.to_string(),
                description: "Orchestrate top-level conversations of the CURRENT project. action=\"create\": new conversation with `title`; optional `text` is written as an initial user message WITHOUT an AI reply unless `autoReply=true`; returns conversationId. action=\"send\": deliver `text` to `conversationId` (starts a turn when idle, queued when busy; returns started | queued; sub-agent/WorkFlow conversations are rejected). action=\"activate\": switch the UI to `conversationId`.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["create", "send", "activate"],
                            "description": "Operation to perform."
                        },
                        "title": {
                            "type": "string",
                            "description": "create: title of the new conversation."
                        },
                        "text": {
                            "type": "string",
                            "description": "create: optional initial user message; send: message to deliver."
                        },
                        "autoReply": {
                            "type": "boolean",
                            "description": "create: start one AI turn with `text` right after creation (requires `text`). Default false."
                        },
                        "conversationId": {
                            "type": "string",
                            "description": "send/activate: target conversation id (must belong to the current project)."
                        }
                    },
                    "required": ["action"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_SET_MODE | TOOL_OPEN_SETTINGS | TOOL_CONVERSATION => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "{SERVER_ID}-{tool_name} must be executed through the asynchronous Electron app control bridge"
                ),
            )),
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

/// config-manage 的 action=set 中必须由渲染层执行的目标，命中时返回 (action, payload)，否则交给 config 服务。
pub fn route_config_set(
    args: &Value,
    project_id: Option<&str>,
) -> Option<napi::Result<(String, Value)>> {
    let scope = args.get("scope").and_then(Value::as_str).map(str::trim)?;
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let value = decode_config_value(args.get("value"));
    match (scope, key) {
        ("appSettings", "blockedPatterns") => Some(blocked_patterns_payload(&value)),
        ("scheduledTasks", "new") => Some(validate_create_scheduled_task_args(&value)),
        ("scheduledTasks", "") => Some(Err(Error::new(
            Status::InvalidArg,
            "scheduledTasks requires key = \"new\" (create) or an existing task id (update / pause / runNow / cancelRun)".to_string(),
        ))),
        ("scheduledTasks", task_id) => Some(
            validate_manage_scheduled_task_args(task_id, &value)
                .map(|(action, payload)| (action, with_project_id(payload, project_id))),
        ),
        ("workspace", "directories")
            if value.get("action").and_then(Value::as_str).map(str::trim) == Some("create") =>
        {
            Some(validate_create_project_args(&value))
        }
        _ => None,
    }
}

/// 兼容模型把 value 序列化成 JSON 字符串的情况。
pub(crate) fn decode_config_value(raw: Option<&Value>) -> Value {
    match raw {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text.trim())
            .unwrap_or_else(|_| Value::String(text.clone())),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}

/// value：数组 = 整体替换；{add|remove|replace: [...]}；或 {operation, patterns}。
fn blocked_patterns_payload(value: &Value) -> napi::Result<(String, Value)> {
    let invalid = || {
        Error::new(
            Status::InvalidArg,
            "blockedPatterns value must be an array (full replace), {add: [...]}, {remove: [...]}, {replace: [...]} or {operation: \"add\"|\"remove\"|\"replace\", patterns: [...]}".to_string(),
        )
    };
    let (operation, patterns) = match value {
        Value::Array(_) => ("replace", value),
        Value::Object(map) => match map.get("operation").and_then(Value::as_str) {
            Some(operation) => (operation.trim(), map.get("patterns").ok_or_else(invalid)?),
            None => {
                let present: Vec<&str> = ["add", "remove", "replace"]
                    .into_iter()
                    .filter(|operation| map.contains_key(*operation))
                    .collect();
                if present.len() != 1 {
                    return Err(invalid());
                }
                (present[0], map.get(present[0]).ok_or_else(invalid)?)
            }
        },
        _ => return Err(invalid()),
    };
    if !matches!(operation, "add" | "remove" | "replace") {
        return Err(invalid());
    }
    let items = patterns.as_array().ok_or_else(invalid)?;
    let mut normalized = Vec::with_capacity(items.len());
    for item in items {
        let pattern = item
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "blockedPatterns must contain only non-empty strings".to_string(),
                )
            })?;
        normalized.push(pattern.to_string());
    }

    Ok((
        "update_blocked_patterns".to_string(),
        json!({ "operation": operation, "patterns": normalized }),
    ))
}

fn validate_set_mode_args(args: &Value) -> napi::Result<(String, Value)> {
    let mode = args
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "mode is required for setMode (\"goal\" or \"worktree\")".to_string(),
            )
        })?;

    if mode != "goal" && mode != "worktree" {
        return Err(Error::new(
            Status::InvalidArg,
            format!("mode must be \"goal\" or \"worktree\", received \"{mode}\""),
        ));
    }

    let enabled = args
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "enabled is required and must be a boolean for setMode".to_string(),
            )
        })?;

    Ok((
        "set_mode".to_string(),
        json!({ "mode": mode, "enabled": enabled }),
    ))
}

const VALID_SETTINGS_PAGES: &[&str] = &[
    "api-settings",
    "imagegen-settings",
    "image-library",
    "proxy-browser-settings",
    "codebase-settings",
    "system-prompt-settings",
    "personalization-settings",
    "custom-headers-settings",
    "mcp-settings",
    "lsp-settings",
    "skills-settings",
    "sub-agent-settings",
    "sensitive-command-settings",
    "custom-commands-settings",
    "hooks-settings",
    "theme-settings",
    "terminal-settings",
    "browser-settings",
    "keyboard-shortcuts-settings",
    "privacy-settings",
    "usage-settings",
    "system-logs",
];

fn validate_open_settings_args(args: &Value) -> napi::Result<(String, Value)> {
    let page = args
        .get("page")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "page is required for openSettings".to_string(),
            )
        })?;

    if !VALID_SETTINGS_PAGES.contains(&page) {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Unknown settings page: \"{page}\". Valid pages: [{}]",
                VALID_SETTINGS_PAGES.join(", ")
            ),
        ));
    }

    Ok(("open_settings".to_string(), json!({ "page": page })))
}

/// Minimum interval (1 minute) for interval-mode recurring tasks.
const MIN_SCHEDULED_INTERVAL_MS: i64 = 60_000;
/// Maximum interval (366 days) for interval-mode recurring tasks. Keeps the
/// computed `nextRunAt` far inside the JS `Date` range so
/// `new Date(ms).toISOString()` can never throw; anything longer should use
/// "daily" or "once" instead.
const MAX_SCHEDULED_INTERVAL_MS: i64 = 366 * 24 * 60 * 60 * 1000;
/// Maximum length of an idempotency id supplied by the model.
const MAX_SCHEDULED_TASK_ID_LEN: usize = 128;

fn validate_create_scheduled_task_args(args: &Value) -> napi::Result<(String, Value)> {
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "name is required and must be a non-empty string for scheduledTasks"
                    .to_string(),
            )
        })?;

    // 工作流模式：prompt 可省略（渲染端用节点摘要填充）
    let workflow = match args.get("workflow") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(normalize_scheduled_workflow(raw)?),
    };

    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if prompt.is_none() && workflow.is_none() {
        return Err(Error::new(
            Status::InvalidArg,
            "prompt is required and must be a non-empty string for scheduledTasks (or pass `workflow` for a workflow task)"
                .to_string(),
        ));
    }

    // Optional idempotency id: when the model retries a timed-out tool call
    // with the same id, the renderer returns the already-created task instead
    // of a duplicate. Trimmed; empty/absent means "no id" (fresh UUID).
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(id) = id {
        if id.chars().count() > MAX_SCHEDULED_TASK_ID_LEN {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "id must be at most {MAX_SCHEDULED_TASK_ID_LEN} characters for scheduledTasks"
                ),
            ));
        }
    }

    let schedule = args
        .get("schedule")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "schedule is required and must be an object for scheduledTasks".to_string(),
            )
        })?;
    let normalized = normalize_schedule(schedule)?;

    // Optional per-task configuration fields. Values are trimmed here, and empty
    // strings are omitted. basicModel is retained for display/config alignment;
    // model remains the advanced model used by the task's fired conversation.
    let mut payload = serde_json::Map::new();
    if let Some(id) = id {
        payload.insert("id".to_string(), json!(id));
    }
    payload.insert("name".to_string(), json!(name));
    if let Some(prompt) = prompt {
        payload.insert("prompt".to_string(), json!(prompt));
    }
    payload.insert("schedule".to_string(), Value::Object(normalized));
    if let Some(workflow) = workflow {
        payload.insert("workflow".to_string(), workflow);
    }
    for (key, value) in [
        (
            "apiProfile",
            args.get("apiProfile")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ),
        (
            "basicModel",
            args.get("basicModel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ),
        (
            "model",
            args.get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ),
        (
            "thinkingStrength",
            args.get("thinkingStrength")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ),
    ] {
        if let Some(value) = value {
            payload.insert(key.to_string(), json!(value));
        }
    }

    // Optional pre-script fields (validated here for an actionable model error;
    // the renderer-side store applies the same constraints as single source
    // of truth).
    if let Some(pre_script) = args
        .get("preScript")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        payload.insert("preScript".to_string(), json!(pre_script));

        if let Some(timeout_ms) = args.get("preScriptTimeoutMs").and_then(Value::as_i64) {
            if !(1000..=300_000).contains(&timeout_ms) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("preScriptTimeoutMs must be 1000-300000 ms, received {timeout_ms}"),
                ));
            }
            payload.insert("preScriptTimeoutMs".to_string(), json!(timeout_ms));
        }

        if let Some(run_on_error) = args.get("runOnScriptError").and_then(Value::as_bool) {
            payload.insert("runOnScriptError".to_string(), json!(run_on_error));
        }
    }

    Ok((
        "create_scheduled_task".to_string(),
        Value::Object(payload),
    ))
}

/// key=<taskId> 允许的写字段。
const SCHEDULED_TASK_UPDATE_FIELDS: &[&str] = &[
    "name",
    "prompt",
    "schedule",
    "workflow",
    "apiProfile",
    "basicModel",
    "model",
    "thinkingStrength",
    "preScript",
    "preScriptTimeoutMs",
    "runOnScriptError",
    "paused",
];

/// key=<taskId> 的写操作：value={action:"runNow"|"cancelRun"} 或字段修改（含 paused）。
fn validate_manage_scheduled_task_args(
    task_id: &str,
    value: &Value,
) -> napi::Result<(String, Value)> {
    let invalid = |message: String| Error::new(Status::InvalidArg, message);
    if task_id.chars().count() > MAX_SCHEDULED_TASK_ID_LEN {
        return Err(invalid(format!(
            "task id must be at most {MAX_SCHEDULED_TASK_ID_LEN} characters"
        )));
    }
    let object = value.as_object().ok_or_else(|| {
        invalid("scheduledTasks value must be an object (fields to update, or {action: \"runNow\" | \"cancelRun\"})".to_string())
    })?;

    if let Some(action) = object.get("action") {
        let action = action.as_str().map(str::trim).unwrap_or("");
        let routed = match action {
            "runNow" => "run_scheduled_task_now",
            "cancelRun" => "cancel_scheduled_task_run",
            other => {
                return Err(invalid(format!(
                    "action must be \"runNow\" or \"cancelRun\", received \"{other}\""
                )))
            }
        };
        if object.len() > 1 {
            return Err(invalid(
                "action cannot be combined with other fields; send updates in a separate call"
                    .to_string(),
            ));
        }
        return Ok((routed.to_string(), json!({ "taskId": task_id })));
    }

    if let Some(unknown) = object
        .keys()
        .find(|key| !SCHEDULED_TASK_UPDATE_FIELDS.contains(&key.as_str()))
    {
        return Err(invalid(format!(
            "Unknown scheduledTasks field \"{unknown}\". Updatable fields: [{}], or {{action: \"runNow\" | \"cancelRun\"}}",
            SCHEDULED_TASK_UPDATE_FIELDS.join(", ")
        )));
    }

    let mut payload = serde_json::Map::new();
    payload.insert("taskId".to_string(), json!(task_id));
    for key in ["name", "prompt"] {
        if let Some(raw) = object.get(key) {
            let text = raw
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid(format!("{key} must be a non-empty string")))?;
            payload.insert(key.to_string(), json!(text));
        }
    }
    if let Some(raw) = object.get("schedule") {
        let schedule = raw
            .as_object()
            .ok_or_else(|| invalid("schedule must be an object".to_string()))?;
        payload.insert(
            "schedule".to_string(),
            Value::Object(normalize_schedule(schedule)?),
        );
    }
    match object.get("workflow") {
        None => {}
        Some(Value::Null) => {
            payload.insert("workflow".to_string(), Value::Null);
        }
        Some(raw) => {
            payload.insert("workflow".to_string(), normalize_scheduled_workflow(raw)?);
        }
    }
    // 运行配置：省略 = 保持，null / "" = 清除
    for key in ["apiProfile", "basicModel", "model", "thinkingStrength", "preScript"] {
        match object.get(key) {
            None => {}
            Some(Value::Null) => {
                payload.insert(key.to_string(), json!(""));
            }
            Some(Value::String(text)) => {
                payload.insert(key.to_string(), json!(text.trim()));
            }
            Some(_) => return Err(invalid(format!("{key} must be a string or null"))),
        }
    }
    if let Some(raw) = object.get("preScriptTimeoutMs") {
        let timeout_ms = raw
            .as_i64()
            .filter(|ms| (1000..=300_000).contains(ms))
            .ok_or_else(|| invalid("preScriptTimeoutMs must be an integer 1000-300000".to_string()))?;
        payload.insert("preScriptTimeoutMs".to_string(), json!(timeout_ms));
    }
    for key in ["runOnScriptError", "paused"] {
        if let Some(raw) = object.get(key) {
            let flag = raw
                .as_bool()
                .ok_or_else(|| invalid(format!("{key} must be a boolean")))?;
            payload.insert(key.to_string(), json!(flag));
        }
    }
    if payload.len() == 1 {
        return Err(invalid(format!(
            "No fields to update. Updatable fields: [{}], or {{action: \"runNow\" | \"cancelRun\"}}",
            SCHEDULED_TASK_UPDATE_FIELDS.join(", ")
        )));
    }

    Ok(("update_scheduled_task".to_string(), Value::Object(payload)))
}

/// config-manage 的 action=delete 中由渲染层执行的目标（当前仅定时任务）。
pub fn route_config_delete(
    args: &Value,
    project_id: Option<&str>,
) -> Option<napi::Result<(String, Value)>> {
    let scope = args.get("scope").and_then(Value::as_str).map(str::trim)?;
    if scope != "scheduledTasks" {
        return None;
    }
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if args.get("confirmed").and_then(Value::as_bool) != Some(true) {
        return Some(Err(Error::new(
            Status::InvalidArg,
            format!(
                "action=delete is destructive and requires explicit user confirmation. Before calling it, use the `askUserQuestion` tool from the `user-interaction` server to show the user which scheduled task will be deleted (scope=`scheduledTasks`, key=`{key}`) together with its run history, wait for approval, then retry with `confirmed: true`."
            ),
        )));
    }
    if key.is_empty() {
        return Some(Err(Error::new(
            Status::InvalidArg,
            "scheduledTasks delete requires key = task id".to_string(),
        )));
    }
    Some(Ok((
        "delete_scheduled_task".to_string(),
        with_project_id(json!({ "taskId": key }), project_id),
    )))
}

/// 注入会话所属项目，渲染端据此限制可操作的任务范围。
fn with_project_id(mut payload: Value, project_id: Option<&str>) -> Value {
    if let (Some(project_id), Value::Object(map)) = (
        project_id.map(str::trim).filter(|id| !id.is_empty()),
        &mut payload,
    ) {
        map.insert("projectId".to_string(), json!(project_id));
    }
    payload
}

/// 工作流画布自动布局间距（节点宽约 160px）。
const WORKFLOW_LAYOUT_X: f64 = 240.0;
const WORKFLOW_LAYOUT_Y: f64 = 140.0;

fn trimmed_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 规范化定时任务工作流：拓扑校验复用 workflow::validate_graph，缺坐标时按层自动布局。
fn normalize_scheduled_workflow(raw: &Value) -> napi::Result<Value> {
    let invalid = |message: String| Error::new(Status::InvalidArg, message);
    let raw = match raw {
        Value::String(text) => serde_json::from_str::<Value>(text.trim())
            .map_err(|_| invalid("workflow must be a JSON object".to_string()))?,
        other => other.clone(),
    };
    let object = raw.as_object().ok_or_else(|| {
        invalid("workflow must be an object {contextMode?, nodes, edges?}".to_string())
    })?;

    let context_mode = match object
        .get("contextMode")
        .and_then(Value::as_str)
        .map(str::trim)
    {
        None | Some("") => "handoff",
        Some(mode @ ("handoff" | "none" | "shared")) => mode,
        Some(other) => {
            return Err(invalid(format!(
                "workflow.contextMode must be \"handoff\", \"none\" or \"shared\", received \"{other}\""
            )))
        }
    };

    let raw_nodes = object
        .get("nodes")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| invalid("workflow.nodes must be a non-empty array".to_string()))?;
    let mut nodes: Vec<serde_json::Map<String, Value>> = Vec::with_capacity(raw_nodes.len());
    let mut positions: Vec<Option<(f64, f64)>> = Vec::with_capacity(raw_nodes.len());
    for (index, node) in raw_nodes.iter().enumerate() {
        let id = trimmed_field(node, "id")
            .ok_or_else(|| invalid(format!("workflow.nodes[{index}].id is required")))?;
        let prompt = trimmed_field(node, "prompt").ok_or_else(|| {
            invalid(format!("workflow.nodes[{index}] (\"{id}\") requires a non-empty prompt"))
        })?;
        let label = trimmed_field(node, "label")
            .or_else(|| trimmed_field(node, "name"))
            .unwrap_or(id);
        let mut item = serde_json::Map::new();
        item.insert("id".to_string(), json!(id));
        item.insert("label".to_string(), json!(label));
        item.insert("prompt".to_string(), json!(prompt));
        for key in ["apiProfile", "basicModel", "model", "thinkingStrength"] {
            if let Some(value) = trimmed_field(node, key) {
                item.insert(key.to_string(), json!(value));
            }
        }
        positions.push(node.get("position").and_then(|position| {
            Some((position.get("x")?.as_f64()?, position.get("y")?.as_f64()?))
        }));
        nodes.push(item);
    }

    let raw_edges: &[Value] = match object.get("edges") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return Err(invalid("workflow.edges must be an array".to_string())),
    };
    let mut seen_edges = std::collections::HashSet::new();
    let mut edges: Vec<Value> = Vec::with_capacity(raw_edges.len());
    for (index, edge) in raw_edges.iter().enumerate() {
        let source = trimmed_field(edge, "source")
            .ok_or_else(|| invalid(format!("workflow.edges[{index}].source is required")))?;
        let target = trimmed_field(edge, "target")
            .ok_or_else(|| invalid(format!("workflow.edges[{index}].target is required")))?;
        let delay_ms = match edge.get("delayMs") {
            None | Some(Value::Null) => 0,
            Some(value) => value.as_i64().ok_or_else(|| {
                invalid(format!(
                    "workflow.edges[{index}].delayMs must be an integer number of milliseconds"
                ))
            })?,
        };
        if !(0..=MAX_SCHEDULED_INTERVAL_MS).contains(&delay_ms) {
            return Err(invalid(format!(
                "workflow.edges[{index}].delayMs must be 0-{MAX_SCHEDULED_INTERVAL_MS} ms, received {delay_ms}"
            )));
        }
        if seen_edges.insert(format!("{source}->{target}")) {
            edges.push(json!({ "source": source, "target": target, "delayMs": delay_ms }));
        }
    }

    let node_values: Vec<Value> = nodes.iter().cloned().map(Value::Object).collect();
    let (order, errors) = super::workflow::validate_graph(&node_values, &edges);
    if !errors.is_empty() {
        return Err(invalid(format!("Invalid workflow: {}", errors.join("; "))));
    }

    if positions.iter().all(Option::is_some) {
        for (item, position) in nodes.iter_mut().zip(positions) {
            if let Some((x, y)) = position {
                item.insert("position".to_string(), json!({ "x": x, "y": y }));
            }
        }
    } else {
        // 任一节点缺坐标：按最长路径分层，左到右排布
        let mut depth: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for id in &order {
            let level = edges
                .iter()
                .filter(|edge| edge.get("target").and_then(Value::as_str) == Some(id.as_str()))
                .filter_map(|edge| edge.get("source").and_then(Value::as_str))
                .filter_map(|source| depth.get(source).map(|level| level + 1))
                .max()
                .unwrap_or(0);
            depth.insert(id.clone(), level);
        }
        let mut rows: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
        for item in nodes.iter_mut() {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let level = depth.get(&id).copied().unwrap_or(0);
            let row = rows.entry(level).or_insert(0);
            item.insert(
                "position".to_string(),
                json!({
                    "x": level as f64 * WORKFLOW_LAYOUT_X,
                    "y": *row as f64 * WORKFLOW_LAYOUT_Y,
                }),
            );
            *row += 1;
        }
    }

    Ok(json!({
        "contextMode": context_mode,
        "nodes": nodes,
        "edges": edges,
    }))
}

fn validate_create_project_args(args: &Value) -> napi::Result<(String, Value)> {
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "name is required and must be a non-empty string for workspace action=create".to_string(),
            )
        })?;

    if name.contains(['/', '\\']) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("name must not contain path separators, received \"{name}\""),
        ));
    }

    // parentPath 可选：未提供时由渲染层弹出目录选择框让用户指定保存位置。
    let parent_path = args
        .get("parentPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut payload = serde_json::Map::new();
    payload.insert("name".to_string(), json!(name));
    if let Some(parent_path) = parent_path {
        payload.insert("parentPath".to_string(), json!(parent_path));
    }

    Ok(("create_project".to_string(), Value::Object(payload)))
}

fn validate_conversation_args(args: &Value) -> napi::Result<(String, Value)> {
    match args.get("action").and_then(Value::as_str).map(str::trim) {
        Some("create") => validate_create_conversation_args(args),
        Some("send") => validate_send_conversation_message_args(args),
        Some("activate") => validate_activate_conversation_args(args),
        other => Err(Error::new(
            Status::InvalidArg,
            format!(
                "action must be \"create\", \"send\" or \"activate\" for {SERVER_ID}-{TOOL_CONVERSATION}, received {other:?}"
            ),
        )),
    }
}

fn validate_create_conversation_args(args: &Value) -> napi::Result<(String, Value)> {
    let title = required_trimmed_str(args, "title", "conversation action=create")?;
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let auto_reply = args
        .get("autoReply")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if auto_reply && text.is_none() {
        return Err(Error::new(
            Status::InvalidArg,
            "text is required when autoReply is true for conversation action=create".to_string(),
        ));
    }

    let mut payload = serde_json::Map::new();
    payload.insert("title".to_string(), json!(title));
    if let Some(text) = text {
        payload.insert("text".to_string(), json!(text));
    }
    payload.insert("autoReply".to_string(), json!(auto_reply));

    Ok(("create_conversation".to_string(), Value::Object(payload)))
}

fn validate_send_conversation_message_args(args: &Value) -> napi::Result<(String, Value)> {
    let conversation_id = required_trimmed_str(args, "conversationId", "conversation action=send")?;
    let text = required_trimmed_str(args, "text", "conversation action=send")?;

    Ok((
        "send_conversation_message".to_string(),
        json!({ "conversationId": conversation_id, "text": text }),
    ))
}

fn validate_activate_conversation_args(args: &Value) -> napi::Result<(String, Value)> {
    let conversation_id = required_trimmed_str(args, "conversationId", "conversation action=activate")?;

    Ok((
        "activate_conversation".to_string(),
        json!({ "conversationId": conversation_id }),
    ))
}

/// 读取必填非空字符串参数（去首尾空白）。
fn required_trimmed_str(args: &Value, key: &str, tool: &str) -> napi::Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} is required and must be a non-empty string for {tool}"),
            )
        })
}

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [{SERVER_ID}-{TOOL_SET_MODE}, {SERVER_ID}-{TOOL_OPEN_SETTINGS}, {SERVER_ID}-{TOOL_CONVERSATION}]"
        ),
    )
}

/// 校验并规范化 schedule（新建与修改共用）。
fn normalize_schedule(
    schedule: &serde_json::Map<String, Value>,
) -> napi::Result<serde_json::Map<String, Value>> {
    let schedule_type = schedule
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "schedule.type is required (\"once\" or \"recurring\")".to_string(),
            )
        })?;

    // Build a normalized schedule payload. We pass the (validated) schedule
    // through verbatim so the renderer-side store can apply the same validation
    // (single source of truth). We still validate here so the model gets an
    // actionable error before dispatching to Electron.
    let mut normalized = serde_json::Map::new();
    normalized.insert("type".to_string(), json!(schedule_type));

    match schedule_type {
        "once" => {
            let execute_at = schedule
                .get("executeAt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "schedule.executeAt is required (ISO 8601 timestamp) when type is \"once\""
                            .to_string(),
                    )
                })?;
            // Best-effort ISO 8601 timestamp sanity check; the renderer
            // validates strictly (it must support the same formats JS Date.parse does).
            if chrono::DateTime::parse_from_rfc3339(execute_at).is_err() {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "schedule.executeAt must be an ISO 8601 timestamp WITH a timezone offset (e.g. \"2026-08-12T10:00:00Z\" or \"2026-08-12T10:00:00+08:00\"), received \"{execute_at}\""
                    ),
                ));
            }
            normalized.insert("executeAt".to_string(), json!(execute_at));
        }
        "recurring" => {
            let mode = schedule
                .get("mode")
                .and_then(Value::as_str)
                .map(str::trim)
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "schedule.mode is required (\"interval\" or \"daily\") when type is \"recurring\"".to_string(),
                    )
                })?;
            normalized.insert("mode".to_string(), json!(mode));

            match mode {
                "interval" => {
                    let interval_ms = match schedule.get("intervalMs") {
                        Some(Value::Number(number)) => {
                            number.as_i64().ok_or_else(|| {
                                Error::new(
                                    Status::InvalidArg,
                                    "schedule.intervalMs must be an integer number of milliseconds (no fractions) when mode is \"interval\""
                                        .to_string(),
                                )
                            })?
                        }
                        _ => {
                            return Err(Error::new(
                                Status::InvalidArg,
                                "schedule.intervalMs is required (integer number of milliseconds) when mode is \"interval\""
                                    .to_string(),
                            ))
                        }
                    };
                    if interval_ms < MIN_SCHEDULED_INTERVAL_MS {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "schedule.intervalMs must be >= {MIN_SCHEDULED_INTERVAL_MS} (1 minute), received {interval_ms}"
                            ),
                        ));
                    }
                    if interval_ms > MAX_SCHEDULED_INTERVAL_MS {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "schedule.intervalMs must be <= {MAX_SCHEDULED_INTERVAL_MS} (366 days), received {interval_ms}"
                            ),
                        ));
                    }
                    normalized.insert("intervalMs".to_string(), json!(interval_ms));
                }
                "daily" => {
                    let hour = schedule
                        .get("hour")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| {
                            Error::new(
                                Status::InvalidArg,
                                "schedule.hour is required (0-23) when mode is \"daily\""
                                    .to_string(),
                            )
                        })?;
                    let minute =
                        schedule
                            .get("minute")
                            .and_then(Value::as_i64)
                            .ok_or_else(|| {
                                Error::new(
                                    Status::InvalidArg,
                                    "schedule.minute is required (0-59) when mode is \"daily\""
                                        .to_string(),
                                )
                            })?;
                    if !(0..=23).contains(&hour) {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!("schedule.hour must be 0-23, received {hour}"),
                        ));
                    }
                    if !(0..=59).contains(&minute) {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!("schedule.minute must be 0-59, received {minute}"),
                        ));
                    }
                    normalized.insert("hour".to_string(), json!(hour));
                    normalized.insert("minute".to_string(), json!(minute));
                }
                other => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!(
                            "schedule.mode must be \"interval\" or \"daily\", received \"{other}\""
                        ),
                    ));
                }
            }
        }
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("schedule.type must be \"once\" or \"recurring\", received \"{other}\""),
            ));
        }
    }

    // 应用关闭后仍执行：仅在显式为 true 时写入
    if schedule.get("wakeWhenClosed").and_then(Value::as_bool) == Some(true) {
        normalized.insert("wakeWhenClosed".to_string(), json!(true));
    }

    Ok(normalized)
}