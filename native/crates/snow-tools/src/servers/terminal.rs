use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use crate::contract::{McpService, McpTool};

const SERVER_ID: &str = "terminal";
const TOOL_NAME: &str = "manage";
const TOOL_FULL_NAME: &str = "terminal-manage";
const ACTIONS: &[&str] = &[
    "open", "send", "read", "wait", "list", "focus", "resize", "close",
];
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_WAIT_READ_MS: u64 = 60_000;

const MANAGE_DESCRIPTION: &str = "Control interactive terminal tabs (live PTY sessions in the right panel) with one tool: required field \"action\" - one of open | send | read | wait | list | focus | resize | close. Unlike bash-terminal-execute (one-shot command that exits), a terminal tab keeps a persistent login shell alive across calls - use it for dev servers, watchers, REPLs, interactive prompts and TUIs.\n\nACTIONS:\n- open: open a new tab and return its tabId. Optional cwd (defaults to the active project directory; SSH projects open a remote shell) and shellPath (custom shell executable such as /bin/zsh or wsl.exe; defaults to the terminal settings or the system login shell).\n- send: type into the PTY as if the user typed it. Exactly one of: input (free text; a trailing newline is appended automatically so the command executes) or keys (ordered named keys: enter, tab, backspace, esc, up, down, left, right, home, end, pageup, pagedown, insert, delete, ctrl+c, ctrl+d, ctrl+z, f1-f12; mapped to terminal bytes, NO newline appended, unknown names are sent verbatim). Tab completion, history and prompts work normally.\n- read: the currently visible screen text (ANSI stripped, not the full scrollback). Optional waitMs (0-60000, default 0) waits for more output before reading.\n- wait: block until the tab produces no new output for idleMs (100-5000, default 500) or timeoutMs elapses (>= 1000, default 30000, no upper limit for long builds). Returns only the output produced since the last delivered checkpoint (incremental); use read for the full current screen.\n- list: all open terminal tabs with tabId, title, cwd and active state.\n- focus: bring the tab given by tabId (required) to the foreground.\n- resize: set the PTY size; cols (1-500) and rows (1-200) are required.\n- close: close the tab and kill its PTY process.\n\ntabId: optional for send / read / wait / resize / close - omit it (or pass \"current\") to target the most recently focused terminal tab.\n\nEXAMPLES:\n- {action:\"open\"}\n- {action:\"send\", input:\"npm run dev\"}\n- {action:\"wait\", idleMs:1000}\n- {action:\"send\", keys:[\"ctrl+c\"]}\n- {action:\"close\", tabId:\"...\"}";

#[napi(object)]
pub struct TerminalCommand {
    pub operation: String,
    pub args_json: String,
}

pub type TerminalCommandCallback =
    ThreadsafeFunction<TerminalCommand, Promise<String>, TerminalCommand, Status, false>;

pub struct TerminalService;

impl TerminalService {
    pub fn new() -> Self {
        TerminalService
    }

    /// 按 action 校验参数后交给 Electron 终端桥；operation 即 action 名。
    pub async fn execute_async(
        &self,
        args: &Value,
        on_command: &TerminalCommandCallback,
    ) -> napi::Result<Value> {
        let action = parse_action(args)?;
        let normalized_args = validate_and_normalize_args(action, args)?;
        let command = TerminalCommand {
            operation: action.to_string(),
            args_json: serde_json::to_string(&normalized_args).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize terminal command: {error}"),
                )
            })?,
        };

        let promise = on_command
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch terminal command to Electron: {error}"),
                )
            })?;
        let result_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Terminal command failed: {error}"),
            )
        })?;

        serde_json::from_str(&result_json).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Terminal command returned invalid JSON: {error}"),
            )
        })
    }
}

impl McpService for TerminalService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_NAME.to_string(),
            description: MANAGE_DESCRIPTION.to_string(),
            input_schema: manage_input_schema(),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        if tool_name == TOOL_NAME {
            return Err(Error::new(
                Status::GenericFailure,
                "Terminal tools must be executed through the asynchronous Electron command bridge"
                    .to_string(),
            ));
        }
        Err(unknown_tool_error(tool_name))
    }
}

fn manage_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ACTIONS,
                "description": "Terminal operation to run; each action's arguments are listed in the tool description."
            },
            "tabId": {
                "type": "string",
                "description": "Target terminal tab ID. Required for focus; optional for send/read/wait/resize/close (omit or use current for the most recently focused tab)."
            },
            "cwd": {
                "type": "string",
                "description": "open: working directory of the new session. Defaults to the project root."
            },
            "shellPath": {
                "type": "string",
                "description": "open: custom shell executable (e.g. /bin/zsh, wsl.exe). Omit for the configured / system default login shell."
            },
            "input": {
                "type": "string",
                "description": "send: text to type; a trailing newline is appended automatically when missing. Mutually exclusive with keys."
            },
            "keys": {
                "type": "array",
                "items": { "type": "string" },
                "description": "send: ordered named keys (enter, tab, backspace, esc, up, down, left, right, home, end, pageup, pagedown, insert, delete, ctrl+c, ctrl+d, ctrl+z, f1-f12); no newline appended. Mutually exclusive with input."
            },
            "waitMs": {
                "type": "number",
                "description": "read: wait this many ms for more output before reading (default 0).",
                "default": 0,
                "minimum": 0,
                "maximum": MAX_WAIT_READ_MS
            },
            "timeoutMs": {
                "type": "number",
                "description": "wait: maximum wait in ms (default 30000, minimum 1000, no upper limit).",
                "default": DEFAULT_TIMEOUT_MS,
                "minimum": MIN_TIMEOUT_MS
            },
            "idleMs": {
                "type": "number",
                "description": "wait: quiet period in ms that counts as idle (default 500).",
                "default": 500,
                "minimum": 100,
                "maximum": 5000
            },
            "cols": {
                "type": "number",
                "description": "resize: number of columns (required for resize).",
                "minimum": 1,
                "maximum": 500
            },
            "rows": {
                "type": "number",
                "description": "resize: number of rows (required for resize).",
                "minimum": 1,
                "maximum": 200
            }
        },
        "required": ["action"]
    })
}

fn parse_action(args: &Value) -> napi::Result<&'static str> {
    let raw = args
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "action is required for {TOOL_FULL_NAME} ({})",
                    ACTIONS.join(" | ")
                ),
            )
        })?;
    ACTIONS
        .iter()
        .copied()
        .find(|action| *action == raw)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "Unknown action \"{raw}\" for {TOOL_FULL_NAME}. Valid actions: {}",
                    ACTIONS.join(" | ")
                ),
            )
        })
}

fn validate_and_normalize_args(action: &str, args: &Value) -> napi::Result<Value> {
    let object = args.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Arguments for {TOOL_FULL_NAME} must be a JSON object"),
        )
    })?;
    let mut normalized = object.clone();
    // action 已转成 operation，不再下发给终端桥
    normalized.remove("action");

    match action {
        "open" => {
            optional_non_empty_string(args, "cwd")?;
            // SSH 工作区的 shellPath 是远端路径，不能用 App Host 本地文件
            // 系统校验（SSH PTY 实际启动远端 $SHELL）；本地仍严格校验。
            let is_ssh_cwd = args
                .get("cwd")
                .and_then(Value::as_str)
                .is_some_and(|cwd| cwd.trim_start().starts_with("ssh://"));
            match args.get("shellPath") {
                None | Some(Value::Null) => {}
                Some(Value::String(value)) => {
                    let trimmed = value.trim();
                    if trimmed.is_empty() {
                        // 空白字符串按“未指定”规范化（shellPath 可选）
                        normalized.insert("shellPath".to_string(), Value::Null);
                    } else {
                        if !is_ssh_cwd {
                            validate_shell_path(trimmed)?;
                        }
                        normalized
                            .insert("shellPath".to_string(), Value::String(trimmed.to_string()));
                    }
                }
                Some(_) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "shellPath must be a string when provided".to_string(),
                    ));
                }
            }
        }
        "send" => {
            optional_non_empty_string(args, "tabId")?;
            let has_input = args
                .get("input")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            let has_keys = args.get("keys").is_some_and(|value| !value.is_null());
            if has_input && has_keys {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("input and keys are mutually exclusive for {TOOL_FULL_NAME} action=send"),
                ));
            }
            if has_keys {
                validate_keys_array(args)?;
            } else if !has_input {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("input or keys is required for {TOOL_FULL_NAME} action=send"),
                ));
            }
            if let Some(input_str) = normalized.get("input").and_then(Value::as_str) {
                let trimmed = input_str.trim_start_matches(['\n', '\r']);
                if !trimmed.ends_with('\n') && !trimmed.ends_with('\r') {
                    normalized.insert("input".to_string(), Value::String(format!("{trimmed}\n")));
                }
            }
        }
        "read" => {
            optional_non_empty_string(args, "tabId")?;
            let wait_ms = bounded_u64(args, "waitMs", 0, 0, MAX_WAIT_READ_MS)?;
            normalized.insert("waitMs".to_string(), json!(wait_ms));
        }
        "resize" => {
            optional_non_empty_string(args, "tabId")?;
            for field in ["cols", "rows"] {
                if args.get(field).map_or(true, Value::is_null) {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!("{field} is required for {TOOL_FULL_NAME} action=resize"),
                    ));
                }
            }
            let cols = bounded_u64(args, "cols", 80, 1, 500)?;
            let rows = bounded_u64(args, "rows", 24, 1, 200)?;
            normalized.insert("cols".to_string(), json!(cols));
            normalized.insert("rows".to_string(), json!(rows));
        }
        "wait" => {
            optional_non_empty_string(args, "tabId")?;
            let timeout =
                optional_u64_with_min(args, "timeoutMs", DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS)?;
            let idle_ms = bounded_u64(args, "idleMs", 500, 100, 5000)?;
            normalized.insert("timeoutMs".to_string(), json!(timeout));
            normalized.insert("idleMs".to_string(), json!(idle_ms));
        }
        "close" => {
            optional_non_empty_string(args, "tabId")?;
        }
        "focus" => {
            required_non_empty_string(args, "tabId", action)?;
        }
        "list" => {}
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unknown action \"{action}\" for {TOOL_FULL_NAME}"),
            ))
        }
    }

    Ok(Value::Object(normalized))
}

fn required_non_empty_string<'a>(
    args: &'a Value,
    field: &str,
    action: &str,
) -> napi::Result<&'a str> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} is required for {TOOL_FULL_NAME} action={action}"),
            )
        })
}

fn optional_non_empty_string<'a>(args: &'a Value, field: &str) -> napi::Result<Option<&'a str>> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Err(Error::new(
                    Status::InvalidArg,
                    format!("{field} must not be empty when provided"),
                ))
            } else {
                Ok(Some(trimmed))
            }
        }
        Some(_) => Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be a string when provided"),
        )),
    }
}

/// 含路径分隔符的 shellPath 必须存在，避免 PTY 静默回退到默认 shell；
/// 纯文件名交给 PTY 层按 PATH 解析。
fn validate_shell_path(path: &str) -> napi::Result<()> {
    let has_separator = path.contains('/') || path.contains('\\');
    if has_separator && !std::path::Path::new(path).exists() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("shellPath does not exist: {path}"),
        ));
    }
    Ok(())
}

/// send 的 keys：非空字符串数组，数量有上限。
fn validate_keys_array(args: &Value) -> napi::Result<()> {
    const MAX_KEYS: usize = 64;
    match args.get("keys") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("keys must not be empty for {TOOL_FULL_NAME} action=send"),
                ));
            }
            if items.len() > MAX_KEYS {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("keys must contain at most {MAX_KEYS} entries"),
                ));
            }
            for item in items {
                let Some(text) = item.as_str() else {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "keys entries must be strings".to_string(),
                    ));
                };
                if text.trim().is_empty() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "keys entries must not be empty".to_string(),
                    ));
                }
            }
            Ok(())
        }
        Some(_) => Err(Error::new(
            Status::InvalidArg,
            "keys must be an array of strings".to_string(),
        )),
    }
}

fn bounded_u64(
    args: &Value,
    field: &str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> napi::Result<u64> {
    let value = match args.get(field) {
        None | Some(Value::Null) => default,
        Some(value) => value.as_u64().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} must be a positive integer"),
            )
        })?,
    };

    if !(minimum..=maximum).contains(&value) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be between {minimum} and {maximum}"),
        ));
    }
    Ok(value)
}

/// 仅有下限的整数参数（wait 的 timeoutMs，长构建可能持续数小时）。
fn optional_u64_with_min(
    args: &Value,
    field: &str,
    default: u64,
    minimum: u64,
) -> napi::Result<u64> {
    let value = match args.get(field) {
        None | Some(Value::Null) => default,
        Some(value) => value.as_u64().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} must be a positive integer"),
            )
        })?,
    };

    if value < minimum {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be at least {minimum}"),
        ));
    }
    Ok(value)
}

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"terminal\". Available tools: [{TOOL_FULL_NAME}]"
        ),
    )
}
