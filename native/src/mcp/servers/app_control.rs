use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::user_interaction::{UserQuestionCallback, UserQuestionCommand};

pub const SERVER_ID: &str = "app-control";

const TOOL_CREATE_MEMO: &str = "createMemo";
const TOOL_LIST_MEMOS: &str = "listMemos";
const TOOL_GET_MEMO: &str = "getMemo";
const TOOL_UPDATE_MEMO_STATUS: &str = "updateMemoStatus";
const TOOL_SET_MODE: &str = "setMode";
const TOOL_OPEN_SETTINGS: &str = "openSettings";
const TOOL_CREATE_SCHEDULED_TASK: &str = "createScheduledTask";
const TOOL_CREATE_PROJECT: &str = "createProject";
const TOOL_REQUEST_APPROVAL: &str = "requestApproval";

const APPROVE_OPTION: &str = "Approve and execute the plan";
const KEEP_PLANNING_OPTION: &str = "Keep planning";

#[napi(object)]
pub struct AppControlCommand {
    /// Action identifier: "create_memo" | "list_memos" | "get_memo" | "update_memo_status" | "set_mode" | "open_settings" | "create_scheduled_task" | "create_project"
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
        on_user_question: &UserQuestionCallback,
    ) -> napi::Result<Value> {
        if tool_name == TOOL_REQUEST_APPROVAL {
            return execute_request_approval(args, on_user_question).await;
        }

        let (action, payload) = match tool_name {
            TOOL_CREATE_MEMO => validate_create_memo_args(args)?,
            TOOL_LIST_MEMOS => validate_list_memos_args(args)?,
            TOOL_GET_MEMO => validate_get_memo_args(args)?,
            TOOL_UPDATE_MEMO_STATUS => validate_update_memo_status_args(args)?,
            TOOL_SET_MODE => validate_set_mode_args(args)?,
            TOOL_OPEN_SETTINGS => validate_open_settings_args(args)?,
            TOOL_CREATE_SCHEDULED_TASK => validate_create_scheduled_task_args(args)?,
            TOOL_CREATE_PROJECT => validate_create_project_args(args)?,
            _ => return Err(unknown_tool_error(tool_name)),
        };

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
                name: TOOL_CREATE_MEMO.to_string(),
                description: "Create a new memo (note) in the Snow App memo panel. The memo content supports plain text. Returns the created memo record.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "The text content for the new memo."
                        }
                    },
                    "required": ["content"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_LIST_MEMOS.to_string(),
                description: "List memos of the CURRENT project (the project the active conversation belongs to). Returns memo records with full content, status (pending/done) and timestamps. Optionally filter by status. Memos of other projects are never exposed.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["pending", "done"],
                            "description": "Optional status filter: \\\"pending\\\" or \\\"done\\\". Omit to list all memos."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_GET_MEMO.to_string(),
                description: "Read a single memo of the CURRENT project by memoId, returning its full content and status. Fails if the memo does not exist in the current project.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "memoId": {
                            "type": "string",
                            "description": "The memoId of the memo to read."
                        }
                    },
                    "required": ["memoId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_UPDATE_MEMO_STATUS.to_string(),
                description: "Update the status of a memo (pending/done) in the CURRENT project. Use \\\"done\\\" to close (complete) a memo after its content has been executed, \\\"pending\\\" to reopen it. Fails for memos of other projects.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "memoId": {
                            "type": "string",
                            "description": "The memoId of the memo to update."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "done"],
                            "description": "The new status: \\\"done\\\" closes the memo, \\\"pending\\\" reopens it."
                        }
                    },
                    "required": ["memoId", "status"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_SET_MODE.to_string(),
                description: "Enable or disable Plan Mode or Goal Mode in the Snow App. Plan Mode makes the agent plan before executing. Goal Mode enables autonomous long-running execution with a token budget. The two modes are mutually exclusive.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["plan", "goal"],
                            "description": "Which mode to toggle: \"plan\" for Plan Mode, \"goal\" for Goal Mode."
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
                description: "Open a specific settings page in the Snow App UI. Available pages: api-settings, imagegen-settings, image-library, proxy-browser-settings, codebase-settings, system-prompt-settings, personalization-settings, custom-headers-settings, mcp-settings, import-settings, skills-settings, sub-agent-settings, sensitive-command-settings, hooks-settings, theme-settings, terminal-settings, browser-settings, keyboard-shortcuts-settings, privacy-settings, usage-settings, system-logs.".to_string(),
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
                                "import-settings",
                                "skills-settings",
                                "sub-agent-settings",
                                "sensitive-command-settings",
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
                name: TOOL_CREATE_SCHEDULED_TASK.to_string(),
                description: "Create a new scheduled task in the Snow App. Tasks are saved in the local database and kept after restarting the app; executions missed while the app is closed are skipped. When a task fires, its prompt is sent to the AI Loop (a new chat conversation is created and auto-sent), giving the task access to all tools. A task is either \"once\" (executes a single time at a chosen start time) or \"recurring\" (repeats either at a fixed interval or every day at a fixed time). Optionally a preScript (shell command, run in the project directory) decides whether the AI Loop fires: exit code 0 = run, 1 = skip; or the last stdout line may be a JSON object {\"run\":bool,\"reason\":string,\"output\":string,\"prompt\":string} — \"output\" is injected into the {{SCRIPT_OUTPUT}} placeholder in the prompt, \"prompt\" fully overrides it, and \"reason\" is recorded when skipped (also written to app logs). Non-zero/non-1 exit, timeout or spawn failure counts as a script error: by default the AI Loop does not run (task recorded as error); set runOnScriptError=true to run anyway. Creation is idempotent when `id` is provided: retrying a call with the same id returns the already-created task instead of creating a duplicate.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Optional idempotency key (max 128 characters). When provided and a task with this id already exists, the existing task is returned instead of creating a duplicate — safe to reuse when retrying a timed-out or failed tool call."
                        },
                        "name": {
                            "type": "string",
                            "description": "A human-readable name for the task."
                        },
                        "prompt": {
                            "type": "string",
                            "description": "The prompt sent to the AI Loop on each execution. The task runs with access to all tools."
                        },
                        "schedule": {
                            "type": "object",
                            "description": "When the task runs.",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": ["once", "recurring"],
                                    "description": "\\\"once\\\" = execute a single time at executeAt; \\\"recurring\\\" = repeat."
                                },
                                "executeAt": {
                                    "type": "string",
                                    "description": "ISO 8601 timestamp (UTC) for the single execution. Required when type is \\\"once\\\"."
                                },
                                "mode": {
                                    "type": "string",
                                    "enum": ["interval", "daily"],
                                    "description": "Recurring mode: \\\"interval\\\" = every intervalMs; \\\"daily\\\" = every day at hour:minute. Required when type is \\\"recurring\\\"."
                                },
                                "intervalMs": {
                                    "type": "number",
                                    "description": "Milliseconds between executions. Required when mode is \\\"interval\\\". Minimum 60000 (1 minute)."
                                },
                                "hour": {
                                    "type": "integer",
                                    "description": "Hour of day (0-23) for a daily schedule. Required when mode is \\\"daily\\\"."
                                },
                                "minute": {
                                    "type": "integer",
                                    "description": "Minute of hour (0-59) for a daily schedule. Required when mode is \\\"daily\\\"."
                                }
                            },
                            "required": ["type"]
                        },
                        "apiProfile": {
                            "type": "string",
                            "description": "Optional API config profile name that serves this task's fired conversation. When omitted, the task uses the app's currently active profile."
                        },
                        "basicModel": {
                            "type": "string",
                            "description": "Optional base model id retained for display and configuration alignment with the selected API profile. It does not change task execution semantics; the advanced model used for execution remains the model field."
                        },
                        "model": {
                            "type": "string",
                            "description": "Optional model id used for the task's fired conversation. When omitted, the selected profile's default model is used."
                        },
                        "thinkingStrength": {
                            "type": "string",
                            "description": "Optional thinking strength override for the task's fired conversation, e.g. \"none\", \"low\", \"medium\", \"high\" (provider-dependent values accepted). Applied per-request in memory; the profile config is never mutated. When omitted, the selected profile's configured thinking strength is used."
                        },
                        "preScript": {
                            "type": "string",
                            "description": "Optional shell command run in the project directory before the AI Loop. Exit 0 = run the AI Loop, exit 1 = skip this round. The last stdout line may instead be a JSON object: {\"run\":false,\"reason\":\"...\"} skips and records the reason; {\"run\":true,\"output\":\"...\"} injects output into the {{SCRIPT_OUTPUT}} placeholder in the prompt; {\"prompt\":\"...\"} fully overrides the prompt. Skipped runs and their script output are recorded in the app logs."
                        },
                        "preScriptTimeoutMs": {
                            "type": "integer",
                            "description": "Pre-script timeout in ms (1000-300000, default 60000). On timeout the process is killed and the run is treated as a script error."
                        },
                        "runOnScriptError": {
                            "type": "boolean",
                            "description": "When true, a pre-script failure (exit other than 0/1, timeout, spawn error) still proceeds to the AI Loop with the failure noted in the prompt. Default false."
                        }
                    },
                    "required": ["name", "prompt", "schedule"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_CREATE_PROJECT.to_string(),
                description: "Create a new project (workspace directory) in the Snow App. The project folder is created on disk and registered as the active project. Provide `name` and an optional `parentPath`; when `parentPath` is omitted, the user is prompted to choose the save location interactively. Returns the created project record with its directoryId, name and path."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "The project (folder) name. Must not contain path separators or invalid characters."
                        },
                        "parentPath": {
                            "type": "string",
                            "description": "Optional absolute path of the parent directory where the project folder is created. When omitted, the user is asked to pick the save location."
                        }
                    },
                    "required": ["name"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_REQUEST_APPROVAL.to_string(),
                description: "Request the user's explicit approval to execute the completed implementation plan. In Plan Mode, call this dedicated tool after the plan is ready and before calling filesystem-replace_edit or filesystem-create. The tool returns a structured `approved` boolean; no wording or keyword in a normal chat response can unlock file editing. Call this tool by itself and wait for the user's decision."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "planSummary": {
                            "type": "string",
                            "minLength": 1,
                            "description": "A concise summary of the complete plan, including key changes and important risks, shown to the user before approval."
                        }
                    },
                    "required": ["planSummary"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_REQUEST_APPROVAL => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "{SERVER_ID}-{TOOL_REQUEST_APPROVAL} must be executed through the asynchronous Electron interaction bridge"
                ),
            )),
            TOOL_CREATE_MEMO | TOOL_SET_MODE | TOOL_OPEN_SETTINGS | TOOL_CREATE_SCHEDULED_TASK | TOOL_CREATE_PROJECT => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "{SERVER_ID}-{tool_name} must be executed through the asynchronous Electron app control bridge"
                ),
            )),
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

/// Execute the Plan Mode approval flow: show the plan summary to the user via
/// the interaction bridge and return a structured `approved` boolean.
async fn execute_request_approval(
    args: &Value,
    on_question: &UserQuestionCallback,
) -> napi::Result<Value> {
    let plan_summary = required_plan_summary(args)?;
    let command = UserQuestionCommand {
        question: plan_summary.clone(),
        options: vec![APPROVE_OPTION.to_string(), KEEP_PLANNING_OPTION.to_string()],
    };

    let promise = on_question
        .call_async_catch(command)
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to dispatch Plan Mode approval to Electron: {error}"),
            )
        })?;
    let answer_json = promise.await.map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Plan Mode approval failed: {error}"),
        )
    })?;
    let answer: Value = serde_json::from_str(&answer_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Plan Mode approval result must be valid JSON: {error}"),
        )
    })?;
    let answer = answer.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Plan Mode approval result must be a JSON object".to_string(),
        )
    })?;
    let cancelled = answer
        .get("cancelled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let selected_options = answer
        .get("selectedOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let approved = !cancelled
        && selected_options
            .iter()
            .any(|option| option.as_str() == Some(APPROVE_OPTION));

    Ok(json!({
        "approved": approved,
        "cancelled": cancelled,
        "planSummary": plan_summary,
    }))
}

fn required_plan_summary(args: &Value) -> napi::Result<String> {
    let summary = args
        .as_object()
        .and_then(|object| object.get("planSummary"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "planSummary is required for app-control-requestApproval".to_string(),
            )
        })?;

    Ok(summary.to_string())
}

fn validate_create_memo_args(args: &Value) -> napi::Result<(String, Value)> {
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "content is required and must be a non-empty string for createMemo".to_string(),
            )
        })?;

    Ok(("create_memo".to_string(), json!({ "content": content })))
}

fn validate_list_memos_args(args: &Value) -> napi::Result<(String, Value)> {
    let status = args.get("status").and_then(Value::as_str).map(str::trim);
    if let Some(status) = status {
        if status != "pending" && status != "done" {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "status must be \"pending\" or \"done\" for listMemos, received \"{status}\""
                ),
            ));
        }
    }
    let mut payload = serde_json::Map::new();
    if let Some(status) = status {
        payload.insert("status".to_string(), json!(status));
    }
    Ok(("list_memos".to_string(), Value::Object(payload)))
}

fn validate_get_memo_args(args: &Value) -> napi::Result<(String, Value)> {
    let memo_id = args
        .get("memoId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "memoId is required and must be a non-empty string for getMemo".to_string(),
            )
        })?;

    Ok(("get_memo".to_string(), json!({ "memoId": memo_id })))
}

fn validate_update_memo_status_args(args: &Value) -> napi::Result<(String, Value)> {
    let memo_id = args
        .get("memoId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "memoId is required and must be a non-empty string for updateMemoStatus".to_string(),
            )
        })?;
    let status = args
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "status is required for updateMemoStatus (\"pending\" or \"done\")".to_string(),
            )
        })?;
    if status != "pending" && status != "done" {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "status must be \"pending\" or \"done\" for updateMemoStatus, received \"{status}\""
            ),
        ));
    }

    Ok((
        "update_memo_status".to_string(),
        json!({ "memoId": memo_id, "status": status }),
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
                "mode is required for setMode (\"plan\" or \"goal\")".to_string(),
            )
        })?;

    if mode != "plan" && mode != "goal" {
        return Err(Error::new(
            Status::InvalidArg,
            format!("mode must be \"plan\" or \"goal\", received \"{mode}\""),
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
    "import-settings",
    "skills-settings",
    "sub-agent-settings",
    "sensitive-command-settings",
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
                "name is required and must be a non-empty string for createScheduledTask"
                    .to_string(),
            )
        })?;

    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "prompt is required and must be a non-empty string for createScheduledTask"
                    .to_string(),
            )
        })?;

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
                    "id must be at most {MAX_SCHEDULED_TASK_ID_LEN} characters for createScheduledTask"
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
                "schedule is required and must be an object for createScheduledTask".to_string(),
            )
        })?;

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

    // Optional per-task configuration fields. Values are trimmed here, and empty
    // strings are omitted. basicModel is retained for display/config alignment;
    // model remains the advanced model used by the task's fired conversation.
    let mut payload = serde_json::Map::new();
    if let Some(id) = id {
        payload.insert("id".to_string(), json!(id));
    }
    payload.insert("name".to_string(), json!(name));
    payload.insert("prompt".to_string(), json!(prompt));
    payload.insert("schedule".to_string(), Value::Object(normalized));
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

fn validate_create_project_args(args: &Value) -> napi::Result<(String, Value)> {
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "name is required and must be a non-empty string for createProject".to_string(),
            )
        })?;

    if name.contains(['/', '\\']) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("name must not contain path separators for createProject, received \"{name}\""),
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

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [{SERVER_ID}-{TOOL_CREATE_MEMO}, {SERVER_ID}-{TOOL_SET_MODE}, {SERVER_ID}-{TOOL_OPEN_SETTINGS}, {SERVER_ID}-{TOOL_CREATE_SCHEDULED_TASK}, {SERVER_ID}-{TOOL_CREATE_PROJECT}, {SERVER_ID}-{TOOL_REQUEST_APPROVAL}]"
        ),
    )
}