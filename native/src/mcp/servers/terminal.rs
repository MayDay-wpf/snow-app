use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "terminal";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_WAIT_READ_MS: u64 = 60_000;

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

    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_command: &TerminalCommandCallback,
    ) -> napi::Result<Value> {
        let normalized_args = validate_and_normalize_args(tool_name, args)?;
        let command = TerminalCommand {
            operation: tool_name.to_string(),
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
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "open".to_string(),
                description: "Open a new terminal tab in the right panel with a live interactive PTY session. Returns a tabId for explicitly targeting it later. The terminal uses a persistent shell process (login shell) that stays alive across multiple send/read operations — unlike bash-terminal-execute which runs a single one-shot command and exits. If cwd is omitted, the active project's directory is used automatically — for SSH projects this opens a remote shell, for local projects it opens a local shell.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "cwd": {
                            "type": "string",
                            "description": "Working directory for the terminal session. Defaults to the project root."
                        },
                        "shellPath": {
                            "type": "string",
                            "description": "Optional path to a custom shell executable (e.g. /bin/zsh, wsl.exe). If omitted, the system default login shell is used."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "send".to_string(),
                description: "Send input text to a terminal tab's PTY (as if the user typed it). For commands, include a trailing newline (\\n) to press Enter — if you omit it, the backend will automatically append one so the command executes. Omit tabId to target the most recently focused terminal tab. The input is written to the shell's stdin and processed interactively — tab completion, history, and prompts all work normally.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "string",
                            "description": "Optional terminal tab ID. Omit it or use current to target the most recently focused terminal tab."
                        },
                        "input": {
                            "type": "string",
                            "description": "Text to send to the terminal. For executing a command, append a newline character."
                        }
                    },
                    "required": ["input"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "read".to_string(),
                description: "Read the current visible text content of a terminal tab's xterm screen buffer. Returns the rendered text (ANSI codes stripped) currently displayed in the terminal, including the prompt and any output. Omit tabId to read the most recently focused terminal tab. This captures what is currently on screen, not the full scrollback history.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "string",
                            "description": "Optional terminal tab ID. Omit it or use current to target the most recently focused terminal tab."
                        },
                        "waitMs": {
                            "type": "number",
                            "description": "Optional: wait this many milliseconds for additional output before reading the screen buffer (default 0 = read immediately). Useful for capturing command output that is still being produced.",
                            "default": 0,
                            "minimum": 0,
                            "maximum": MAX_WAIT_READ_MS
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "resize".to_string(),
                description: "Resize a terminal tab's PTY dimensions (columns and rows). This updates both the PTY process and the xterm display. Omit tabId to resize the most recently focused terminal tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "string",
                            "description": "Optional terminal tab ID. Omit it or use current to target the most recently focused terminal tab."
                        },
                        "cols": {
                            "type": "number",
                            "description": "Number of columns (character width). Must be at least 1.",
                            "minimum": 1,
                            "maximum": 500
                        },
                        "rows": {
                            "type": "number",
                            "description": "Number of rows (line height). Must be at least 1.",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["cols", "rows"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "wait".to_string(),
                description: "Wait for a terminal tab to become idle (no new output) for a specified quiet period. Useful for detecting when a long-running command has finished producing output. Returns the text that was produced during the wait period. Omit tabId to wait on the most recently focused terminal tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "string",
                            "description": "Optional terminal tab ID. Omit it or use current to target the most recently focused terminal tab."
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time to wait for idle state in milliseconds (default 30000, minimum 1000). No upper limit — long-running builds may take minutes or hours.",
                            "default": DEFAULT_TIMEOUT_MS,
                            "minimum": MIN_TIMEOUT_MS
                        },
                        "idleMs": {
                            "type": "number",
                            "description": "Quiet period (no output) in milliseconds that signals the terminal is idle (default 500).",
                            "default": 500,
                            "minimum": 100,
                            "maximum": 5000
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "close".to_string(),
                description: "Close a terminal tab and kill its PTY process. Omit tabId to close the most recently focused terminal tab. Use the list tool to see available terminal tabs and their IDs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "string",
                            "description": "Optional terminal tab ID to close. Omit it or use current to close the most recently focused terminal tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "focus".to_string(),
                description: "Switch to (activate) a terminal tab by its tab ID, bringing it to the foreground. Use the list tool to see available terminal tabs and their IDs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "string",
                            "description": "The terminal tab ID to switch to."
                        }
                    },
                    "required": ["tabId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list".to_string(),
                description: "List all open terminal tabs with their tab IDs, titles, working directories, and active state. Use this to discover available terminal tabs before closing or switching.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "open" | "send" | "read" | "resize" | "wait" | "close" | "focus" | "list" => {
                Err(Error::new(
                    Status::GenericFailure,
                    "Terminal tools must be executed through the asynchronous Electron command bridge"
                        .to_string(),
                ))
            }
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

fn validate_and_normalize_args(tool_name: &str, args: &Value) -> napi::Result<Value> {
    let object = args.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Arguments for terminal-{tool_name} must be a JSON object"),
        )
    })?;
    let mut normalized = object.clone();

    match tool_name {
        "open" => {
            optional_non_empty_string(args, "cwd")?;
            if let Some(path) = optional_non_empty_string(args, "shellPath")? {
                validate_shell_path(path)?;
            }
        }
        "send" => {
            optional_non_empty_string(args, "tabId")?;
            required_non_empty_string(args, "input", tool_name)?;
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
            required_non_empty_string(args, "tabId", tool_name)?;
        }
        "list" => {}
        _ => return Err(unknown_tool_error(tool_name)),
    }

    Ok(Value::Object(normalized))
}

fn required_non_empty_string<'a>(
    args: &'a Value,
    field: &str,
    tool_name: &str,
) -> napi::Result<&'a str> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} is required for terminal-{tool_name}"),
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

/// 校验 shellPath 指向真实存在的可执行文件：含路径分隔符的路径（绝对或
/// 相对）必须存在，否则直接拒绝——避免 PTY 静默回退到默认 shell 后智能体
/// 收到"成功"却与预期不符。纯文件名（如 `wsl.exe`、`bash`）允许，由 PTY
/// 层按 PATH 解析，无法在参数校验阶段确认。
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

/// Like `bounded_u64` but with only a lower bound (no upper limit).
/// Used for `timeoutMs` in terminal-wait where long-running builds
/// may take minutes or hours.
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
            "Unknown tool: \"{tool_name}\" for MCP server \"terminal\". Available tools: [terminal-open, terminal-send, terminal-read, terminal-resize, terminal-wait, terminal-close, terminal-focus, terminal-list]"
        ),
    )
}
