use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::exports::terminal::{
    detect_shell_family, load_terminal_shell_path, resolve_login_path, resolve_shell_and_args,
};
use crate::storage::services::app_logs::{insert_app_log, AppLogInput};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use regex::Regex;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::{
    execute_remote_workspace_command, is_ssh_path, resolve_remote_project_workspace,
    RemoteWorkspaceCallback,
};

fn set_inherited_env_default(process: &mut Command, key: &str, value: &str) {
    if value.is_empty() || std::env::var_os(key).is_some() {
        return;
    }
    process.env(key, value);
}

pub struct BashService;

#[napi(object)]
pub struct BashStreamChunk {
    pub stream: String,
    pub data: String,
}

pub type BashStreamCallback =
    ThreadsafeFunction<BashStreamChunk, Unknown<'static>, BashStreamChunk, Status, false>;

/// A live interactive bash session that keeps its stdin pipe open so the
/// user can send input after the process has started.  Sessions are stored
/// in a global registry keyed by a UUID so the frontend can write to them
/// via `write_interactive_stdin` without holding any Rust object across the
/// NAPI boundary.
struct InteractiveSession {
    stdin: tokio::process::ChildStdin,
}

static INTERACTIVE_SESSIONS: OnceLock<tokio::sync::Mutex<HashMap<String, InteractiveSession>>> =
    OnceLock::new();

fn interactive_sessions() -> &'static tokio::sync::Mutex<HashMap<String, InteractiveSession>> {
    INTERACTIVE_SESSIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// Write user-supplied input to a live interactive session's stdin.
/// The session is looked up by the UUID that was emitted as the
/// `interactive_session` stream chunk.  After writing, the stdin pipe is
/// **not** closed — the process may still need more input later.
pub async fn write_interactive_stdin(session_id: String, input: String) -> napi::Result<()> {
    let mut sessions = interactive_sessions().lock().await;
    let session = sessions.get_mut(&session_id).ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            format!("Interactive session not found or already terminated: {session_id}"),
        )
    })?;
    session
        .stdin
        .write_all(input.as_bytes())
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write to interactive session stdin: {e}"),
            )
        })?;
    Ok(())
}

/// Remove (and drop) a finished interactive session from the registry.
async fn remove_interactive_session(session_id: &str) {
    let mut sessions = interactive_sessions().lock().await;
    sessions.remove(session_id);
}

impl BashService {
    pub fn new() -> Self {
        BashService
    }
}

const SERVER_ID: &str = "bash";
const DEFAULT_TIMEOUT_MS: u64 = 30000;
const SENSITIVE_AUTHORIZATION_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
struct BashExecutionTimings {
    argument_parse_ms: u64,
    sensitive_check_ms: u64,
    remote_resolve_ms: u64,
    remote_dispatch_ms: u64,
    terminal_settings_ms: u64,
    shell_resolve_ms: u64,
    login_path_ms: u64,
    spawn_ms: u64,
    first_output_ms: Option<u64>,
    process_wait_ms: u64,
    pipe_drain_ms: u64,
    total_ms: u64,
}

struct BashExecutionLog<'a> {
    level: &'a str,
    message: &'a str,
    status: &'a str,
    route: &'a str,
    timeout_ms: u64,
    is_interactive: bool,
    detached: bool,
    session_id: Option<&'a str>,
    tool_execution_id: Option<&'a str>,
    exit_code: Option<i32>,
    captured_stdout_bytes: usize,
    captured_stderr_bytes: usize,
    timings: BashExecutionTimings,
}

fn log_bash_execution(entry: BashExecutionLog<'_>) {
    let duration = format!("{}ms", entry.timings.total_ms);
    let context = json!({
        "toolName": "bash-terminal-execute",
        "status": entry.status,
        "route": entry.route,
        "timeoutMs": entry.timeout_ms,
        "interactive": entry.is_interactive,
        "detached": entry.detached,
        "sessionId": entry.session_id,
        "toolExecutionId": entry.tool_execution_id,
        "exitCode": entry.exit_code,
        "capturedStdoutBytes": entry.captured_stdout_bytes,
        "capturedStderrBytes": entry.captured_stderr_bytes,
        "timings": {
            "argumentParseMs": entry.timings.argument_parse_ms,
            "sensitiveCheckMs": entry.timings.sensitive_check_ms,
            "remoteResolveMs": entry.timings.remote_resolve_ms,
            "remoteDispatchMs": entry.timings.remote_dispatch_ms,
            "terminalSettingsMs": entry.timings.terminal_settings_ms,
            "shellResolveMs": entry.timings.shell_resolve_ms,
            "loginPathMs": entry.timings.login_path_ms,
            "spawnMs": entry.timings.spawn_ms,
            "firstOutputMs": entry.timings.first_output_ms,
            "processWaitMs": entry.timings.process_wait_ms,
            "pipeDrainMs": entry.timings.pipe_drain_ms,
            "totalMs": entry.timings.total_ms,
        }
    })
    .to_string();
    let input = AppLogInput {
        level: entry.level.to_string(),
        module: "tool_execution".to_string(),
        func: "bash_terminal_execute".to_string(),
        line: None,
        message: entry.message.to_string(),
        input: None,
        output: None,
        duration: Some(duration),
        context: Some(context),
        error: None,
        source: "main".to_string(),
    };

    // Tool logging must never extend the command's critical path. Resolve the
    // cached database path and perform the SQLite insert on the blocking pool;
    // failures are intentionally ignored so diagnostics cannot break tools.
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(database_path) = crate::storage::ensure_database_file() {
            let _ = insert_app_log(&database_path, &input);
        }
    });
}

struct SensitiveCommandAuthorization {
    command: String,
    expires_at: Instant,
}

static SENSITIVE_COMMAND_AUTHORIZATIONS: OnceLock<
    tokio::sync::Mutex<HashMap<String, SensitiveCommandAuthorization>>,
> = OnceLock::new();

fn sensitive_command_authorizations(
) -> &'static tokio::sync::Mutex<HashMap<String, SensitiveCommandAuthorization>> {
    SENSITIVE_COMMAND_AUTHORIZATIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

pub async fn authorize_sensitive_command(command: String, token: String) -> napi::Result<()> {
    if command.trim().is_empty() || token.trim().is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Sensitive command and authorization token are required".to_string(),
        ));
    }

    let now = Instant::now();
    let mut authorizations = sensitive_command_authorizations().lock().await;
    authorizations.retain(|_, authorization| authorization.expires_at > now);
    authorizations.insert(
        token,
        SensitiveCommandAuthorization {
            command,
            expires_at: now + SENSITIVE_AUTHORIZATION_TTL,
        },
    );
    Ok(())
}

async fn consume_sensitive_command_authorization(command: &str, token: Option<&str>) -> bool {
    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return false;
    };

    let now = Instant::now();
    let mut authorizations = sensitive_command_authorizations().lock().await;
    authorizations.retain(|_, authorization| authorization.expires_at > now);
    authorizations
        .remove(token)
        .map(|authorization| authorization.command == command && authorization.expires_at > now)
        .unwrap_or(false)
}

impl McpService for BashService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: "terminal-execute".to_string(),
            description: "Execute terminal commands like npm, git, build scripts, etc. Commands ALWAYS run in the shell configured in Terminal settings (shellPath); when unset, the auto-detected default terminal is used (PowerShell -> CMD -> Git Bash -> COMSPEC on Windows). BEST PRACTICE: For file modifications, prefer filesystem tools first. Primary use cases: (1) Running build/test/lint scripts, (2) Version control operations, (3) Package management, (4) System utilities.\n\nLONG-RUNNING SERVICES (dev servers, watchers, databases): pass detach:true to run the command in the background. The call returns immediately with { pid, logPath }; the service keeps running and writes its output to the log file. Monitor it by reading logPath (filesystem-read), stop it with taskkill /PID <pid> (Windows) or kill <pid> (POSIX). Do NOT run a long-running service in the foreground: it blocks until the timeout and the whole process tree is force-killed.\n\nINTERACTIVE commands (password prompts, y/n confirmations): set isInteractive:true so the command is not killed by the timeout (24h upper bound) and the UI shows an input box.\n\ntimeout: default 30000ms. When a foreground command may legitimately run longer (builds, installs), pass an explicit larger timeout. Ignored when detach:true.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Terminal command to execute directly."
                    },
                    "description": {
                        "type": "string",
                        "description": "REQUIRED: A short, user-friendly explanation of what this command will do, so the user can understand it at a glance. MUST be written in the SAME language as the user's latest query."
                    },
                    "workingDirectory": {
                        "type": "string",
                        "description": "REQUIRED: Working directory where the command should be executed. Can be a local path (e.g., \"D:/projects/myapp\")."
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Timeout in milliseconds (default: 30000). Ignored when detach is true."
                    },
                    "isInteractive": {
                        "type": "boolean",
                        "description": "Set to true if the command requires user input (e.g., password prompts, y/n confirmations, interactive installers). Interactive commands bypass the timeout (24h limit) and show an input box in the UI. Default: false. Cannot be combined with detach."
                    },
                    "detach": {
                        "type": "boolean",
                        "description": "Run the command in the background and return immediately. Output is written to <workingDirectory>/.snow/logs/<name>-<timestamp>.log; the result contains { detached: true, pid, logPath, hint }. Use for long-running services: monitor via filesystem-read on logPath, stop via taskkill /PID <pid> (Windows) / kill <pid> (POSIX). Default: false. Cannot be combined with isInteractive; not supported for remote (SSH) workspaces."
                    },
                    "sessionId": {
                        "type": "string",
                        "description": "System-injected session identifier (do not supply). Exposed to the child process as SNOW_SESSION_ID so Trellis scripts can track the active task."
                    }
                },
                "required": ["command", "description", "workingDirectory", "timeout"]
            }),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "terminal-execute" => Err(Error::new(
                Status::GenericFailure,
                "The Bash tool must be executed through the asynchronous streaming executor"
                    .to_string(),
            )),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{}\" for MCP server \"bash\". Available tools: [bash-terminal-execute]",
                    tool_name
                ),
            )),
        }
    }
}

impl BashService {
    pub async fn execute_terminal_stream(
        &self,
        args: &Value,
        project_id: Option<&str>,
        sensitive_authorization_token: Option<&str>,
        on_chunk: BashStreamCallback,
        on_remote_workspace_command: &RemoteWorkspaceCallback,
    ) -> napi::Result<Value> {
        let execution_started = Instant::now();
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new(Status::InvalidArg, "command is required".to_string()))?
            .to_string();

        // A short user-facing explanation of the command, written by the
        // model in the user's language.  Required so the UI can always show
        // why a command is being executed.
        let description = args
            .get("description")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "description is required: provide a brief user-friendly explanation of the command in the user's language"
                        .to_string(),
                )
            })?
            .to_string();

        let working_directory = args
            .get("workingDirectory")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "workingDirectory is required".to_string(),
                )
            })?
            .to_string();

        let timeout = args
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        let executed_at = chrono::Local::now().to_rfc3339();

        // Optional session identity injected by the renderer (never supplied by
        // the model). Exposed to child processes as SNOW_SESSION_ID /
        // TRELLIS_CONTEXT_ID so Trellis scripts (active_task.py) can resolve
        // the current session — matching the Snow CLI contract.
        let session_id = args
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_string());

        // When isInteractive is true the command expects to receive user
        // input at runtime (password prompts, y/n confirmations, etc.).
        // Interactive commands bypass the sensitive-command gate because the
        // user is already expected to confirm each input manually in the UI.
        let is_interactive = args
            .get("isInteractive")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // When detach is true the command runs in the background: the call
        // returns immediately with { pid, logPath } and the process keeps
        // running, writing its output to a log file under
        // <workingDirectory>/.snow/logs/. This is the supported way to start
        // long-running services (dev servers, watchers, databases) without
        // blocking the agent until the timeout.
        let detach = args.get("detach").and_then(Value::as_bool).unwrap_or(false);
        let argument_parse_ms = execution_started.elapsed().as_millis() as u64;

        if detach && is_interactive {
            return Err(Error::new(
                Status::InvalidArg,
                "detach cannot be combined with isInteractive: a detached command has no stdin"
                    .to_string(),
            ));
        }

        let self_destruct = is_self_destructive_command(&command);
        if self_destruct.is_self_destructive {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "[SELF-PROTECTION] Command blocked: {}. {}",
                    self_destruct.reason, self_destruct.suggestion
                ),
            ));
        }

        // Sensitive commands require a short-lived, one-time authorization
        // token issued after explicit user confirmation. The token travels
        // outside the model-controlled tool arguments and is bound to this
        // exact command.
        //
        // Interactive commands skip the sensitive-command gate entirely
        // because the user is expected to confirm every input in the
        // interactive terminal UI — a separate confirmation dialog would be
        // redundant.
        let sensitive_check_started = Instant::now();
        let sensitive_matches = if is_interactive {
            Vec::new()
        } else {
            check_sensitive_commands(&command, project_id).await
        };
        let sensitive_authorized = sensitive_matches.is_empty()
            || consume_sensitive_command_authorization(&command, sensitive_authorization_token)
                .await;
        let sensitive_check_ms = sensitive_check_started.elapsed().as_millis() as u64;
        if !sensitive_authorized {
            let error_payload = json!({
                "error": "SENSITIVE_COMMAND_DETECTED",
                "message": "Command matched a sensitive command rule and requires confirmation",
                "command": command,
                "description": description,
                "matches": sensitive_matches,
            });
            return Err(Error::new(
                Status::GenericFailure,
                error_payload.to_string(),
            ));
        }

        let remote_resolve_started = Instant::now();
        let remote_working_directory = if is_ssh_path(&working_directory) {
            Some(working_directory.clone())
        } else {
            resolve_remote_project_workspace(project_id).await?
        };
        let remote_resolve_ms = remote_resolve_started.elapsed().as_millis() as u64;
        if let Some(remote_working_directory) = remote_working_directory {
            if detach {
                return Err(Error::new(
                    Status::InvalidArg,
                    "detach is not supported for remote (SSH) workspaces yet".to_string(),
                ));
            }
            let mut remote_args = args.clone();
            remote_args["workingDirectory"] = Value::String(remote_working_directory);
            // Register a cancellation token for the remote execution so the
            // stop button / session abort can settle the pending Electron
            // promise immediately (mirrors the local-process registration
            // further down). The id is streamed as a `tool_execution` chunk
            // so the frontend can target this call for cancellation.
            let tool_execution_id = Uuid::new_v4().to_string();
            let cancel_token = crate::api::cancel::register_tool_execution(&tool_execution_id);
            emit_stream_chunk(&on_chunk, "tool_execution", tool_execution_id.clone());
            let remote_dispatch_started = Instant::now();
            let result = execute_remote_workspace_command(
                on_remote_workspace_command,
                "bash-terminal-execute",
                &remote_args,
                Some(&cancel_token),
            )
            .await;
            let remote_dispatch_ms = remote_dispatch_started.elapsed().as_millis() as u64;
            crate::api::cancel::unregister_tool_execution(&tool_execution_id);

            let exit_code = result
                .as_ref()
                .ok()
                .and_then(|value| value.get("exitCode"))
                .and_then(Value::as_i64)
                .map(|value| value as i32);
            let (level, status, message) = match (&result, exit_code) {
                (Ok(_), Some(0) | None) => {
                    ("INFO", "completed", "Remote terminal command completed")
                }
                (Ok(_), Some(_)) => (
                    "WARN",
                    "non_zero_exit",
                    "Remote terminal command exited with a non-zero status",
                ),
                (Err(_), _) => ("ERROR", "failed", "Remote terminal command failed"),
            };
            log_bash_execution(BashExecutionLog {
                level,
                message,
                status,
                route: "remote",
                timeout_ms: timeout,
                is_interactive,
                detached: false,
                session_id: session_id.as_deref(),
                tool_execution_id: Some(&tool_execution_id),
                exit_code,
                captured_stdout_bytes: 0,
                captured_stderr_bytes: 0,
                timings: BashExecutionTimings {
                    argument_parse_ms,
                    sensitive_check_ms,
                    remote_resolve_ms,
                    remote_dispatch_ms,
                    total_ms: execution_started.elapsed().as_millis() as u64,
                    ..BashExecutionTimings::default()
                },
            });
            return result;
        }

        let terminal_settings_started = Instant::now();
        let shell_path = load_terminal_shell_path().await?;
        let terminal_settings_ms = terminal_settings_started.elapsed().as_millis() as u64;
        let shell_resolve_started = Instant::now();
        let (shell, shell_args) =
            resolve_shell_and_args(&shell_path, &command, Some(&working_directory)).await?;
        let shell_resolve_ms = shell_resolve_started.elapsed().as_millis() as u64;

        // resolve_login_path 在 Windows 上返回注册表中的 Windows PATH（分号分隔的
        // Windows 路径）。这对 powershell/cmd 有用，但注入给 WSL 会破坏 Linux 的 PATH
        //（Linux 用冒号分隔）。WSL 通过 `bash -lc` 自行从 .profile 加载 Linux PATH，
        // 因此跳过注入。
        let login_path_started = Instant::now();
        let login_path = if detect_shell_family(&shell) == "wsl" {
            None
        } else {
            resolve_login_path().await
        };
        let login_path_ms = login_path_started.elapsed().as_millis() as u64;

        let mut process = Command::new(&shell);
        process
            .args(&shell_args)
            .current_dir(&working_directory)
            .stdin(if is_interactive {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .kill_on_drop(!detach)
            .env("LANG", "en_US.UTF-8")
            .env("LC_ALL", "en_US.UTF-8");

        // detach 模式：stdout/stderr 直接重定向到 .snow/logs/ 下的日志文件，
        // 进程孤儿化后由子进程持有的句柄继续写入；前台模式用管道供流式
        // 输出。kill_on_drop(!detach) 保证任务返回后 detach 进程不会被连带
        // 终止。
        let detach_log_path = if detach {
            let path = create_detach_log_path(&working_directory, &command)?;
            let log_file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to open detach log file {}: {error}", path.display()),
                    )
                })?;
            process
                .stdout(Stdio::from(log_file.try_clone().map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to clone detach log handle: {error}"),
                    )
                })?))
                .stderr(Stdio::from(log_file));
            Some(path)
        } else {
            process.stdout(Stdio::piped()).stderr(Stdio::piped());
            None
        };

        // Snow platform contract: expose the current session identity and
        // workspace to child processes so Trellis can resolve an active task.
        // Inherited explicit values win over Snow's defaults.
        if let Some(ref session_id) = session_id {
            set_inherited_env_default(&mut process, "SNOW_SESSION_ID", session_id);
            set_inherited_env_default(
                &mut process,
                "TRELLIS_CONTEXT_ID",
                &format!("snow-{session_id}"),
            );
            set_inherited_env_default(&mut process, "SNOW_CWD", working_directory.trim());
            set_inherited_env_default(&mut process, "SNOW_PLATFORM", "snow-app");
        }

        if let Some(ref path) = login_path {
            process.env("PATH", path);
        }

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            process.creation_flags(CREATE_NO_WINDOW);
        }

        // On Unix, place the child in its own process group so that
        // kill_process_tree can terminate the entire tree with a
        // single kill(-pgid, SIGKILL).
        #[cfg(not(target_os = "windows"))]
        {
            process.process_group(0);
        }

        let spawn_started = Instant::now();
        let mut child = match process.spawn() {
            Ok(child) => child,
            Err(error) => {
                let spawn_ms = spawn_started.elapsed().as_millis() as u64;
                log_bash_execution(BashExecutionLog {
                    level: "ERROR",
                    message: "Terminal process failed to spawn",
                    status: "spawn_failed",
                    route: "local",
                    timeout_ms: timeout,
                    is_interactive,
                    detached: detach,
                    session_id: session_id.as_deref(),
                    tool_execution_id: None,
                    exit_code: None,
                    captured_stdout_bytes: 0,
                    captured_stderr_bytes: 0,
                    timings: BashExecutionTimings {
                        argument_parse_ms,
                        sensitive_check_ms,
                        remote_resolve_ms,
                        terminal_settings_ms,
                        shell_resolve_ms,
                        login_path_ms,
                        spawn_ms,
                        total_ms: execution_started.elapsed().as_millis() as u64,
                        ..BashExecutionTimings::default()
                    },
                });
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to spawn process: {error}"),
                ));
            }
        };
        let spawn_ms = spawn_started.elapsed().as_millis() as u64;

        // detach 模式：不等待、不注册取消 token、不读取输出。拿到 PID 后
        // 立即返回；child 在此 drop（kill_on_drop=false，进程孤儿化后继续
        // 运行，日志句柄由子进程持有继续写入）。返回值携带 pid / logPath /
        // hint，agent 据此监控日志与终止进程。
        if let Some(log_path) = detach_log_path {
            let pid = child.id().unwrap_or(0);
            // WSL 命令的 pid 是 wsl.exe 壳进程：taskkill /PID 只会杀掉壳，
            // WSL 实例内的 Linux 进程可能残留，需要额外给出 Linux 侧的
            // 停止方式（pkill / wsl --terminate）。
            let wsl_hint = if is_wsl_command(&command) {
                " Stop the Linux-side process with `wsl -d <distro> -- pkill -f <pattern>` or `wsl --terminate <distro>`, since taskkill only kills the wsl.exe wrapper."
            } else {
                ""
            };
            log_bash_execution(BashExecutionLog {
                level: "INFO",
                message: "Detached terminal process started",
                status: "detached",
                route: "local",
                timeout_ms: timeout,
                is_interactive,
                detached: true,
                session_id: session_id.as_deref(),
                tool_execution_id: None,
                exit_code: None,
                captured_stdout_bytes: 0,
                captured_stderr_bytes: 0,
                timings: BashExecutionTimings {
                    argument_parse_ms,
                    sensitive_check_ms,
                    remote_resolve_ms,
                    terminal_settings_ms,
                    shell_resolve_ms,
                    login_path_ms,
                    spawn_ms,
                    total_ms: execution_started.elapsed().as_millis() as u64,
                    ..BashExecutionTimings::default()
                },
            });
            return Ok(json!({
                "detached": true,
                "pid": pid,
                "logPath": log_path.to_string_lossy().replace('\\', "/"),
                "command": command,
                "workingDirectory": working_directory,
                "startedAt": executed_at,
                "exitCode": null,
                "hint": format!(
                    "Detached process started (PID {pid}). Monitor: read the log file with filesystem-read. Stop: taskkill /PID {pid} (Windows) or kill {pid} (POSIX).{wsl_hint}"
                )
            }));
        }

        let callback = Arc::new(on_chunk);

        // Register a cancellation token for this execution so the process can
        // be killed on demand instead of waiting for the timeout: the UI
        // shows a stop button and session aborts kill every in-flight bash
        // process.  The id is streamed to the frontend as a
        // `tool_execution` chunk (mirroring how `interactive_session` ids
        // are delivered) so the tool call can be targeted for cancellation.
        let tool_execution_id = Uuid::new_v4().to_string();
        let cancel_token = crate::api::cancel::register_tool_execution(&tool_execution_id);
        emit_stream_chunk(&callback, "tool_execution", tool_execution_id.clone());

        // For interactive sessions, take the stdin pipe and register the
        // session so the frontend can write user input via
        // `write_interactive_stdin`.  Emit a special stream chunk with
        // stream="interactive_session" and data=<session_id> so the
        // frontend knows the session ID to use.
        let interactive_session_id = if is_interactive {
            if let Some(stdin) = child.stdin.take() {
                let session_id = Uuid::new_v4().to_string();
                let mut sessions = interactive_sessions().lock().await;
                sessions.insert(session_id.clone(), InteractiveSession { stdin });
                drop(sessions);

                emit_stream_chunk(&callback, "interactive_session", session_id.clone());
                Some(session_id)
            } else {
                None
            }
        } else {
            None
        };

        let first_output_ms = Arc::new(OnceLock::new());
        let stdout_task = child.stdout.take().map(|stdout| {
            tokio::spawn(read_stream(
                stdout,
                "stdout",
                Arc::clone(&callback),
                Arc::clone(&first_output_ms),
                execution_started,
            ))
        });
        let stderr_task = child.stderr.take().map(|stderr| {
            tokio::spawn(read_stream(
                stderr,
                "stderr",
                Arc::clone(&callback),
                Arc::clone(&first_output_ms),
                execution_started,
            ))
        });

        // Interactive commands use a much longer timeout because they
        // wait for user input.  We use 24 hours as the upper bound.
        let effective_timeout = if is_interactive {
            Duration::from_secs(86400)
        } else {
            Duration::from_millis(timeout)
        };

        let process_wait_started = Instant::now();
        let wait_result = tokio::select! {
            // Cancellation and timeout are safety-critical. Prefer them over a
            // process that becomes ready at the same time, so a stop request
            // can never be lost to a successful child.wait() branch.
            biased;
            _ = cancel_token.cancelled() => {
                kill_process_tree(&mut child).await;
                ProcessWaitResult::Cancelled
            }
            _ = tokio::time::sleep(effective_timeout) => {
                kill_process_tree(&mut child).await;
                ProcessWaitResult::TimedOut
            }
            status = child.wait() => match status {
                Ok(status) => ProcessWaitResult::Completed(status.code().unwrap_or(1)),
                Err(error) => {
                    kill_process_tree(&mut child).await;
                    ProcessWaitResult::Failed(error.to_string())
                }
            },
        };
        let process_wait_ms = process_wait_started.elapsed().as_millis() as u64;

        // Clean up the interactive session after the process exits.
        if let Some(ref session_id) = interactive_session_id {
            remove_interactive_session(session_id).await;
        }

        // Drain the output pipes with a bounded wait in every outcome so a
        // tool call can never hang forever.
        //
        // On Windows a grandchild launched by the shell (e.g.
        // `Start-Process` starting a Django dev server) inherits the shell's
        // stdout/stderr pipe write handles. The pipe therefore never reaches
        // EOF while that grandchild is alive, even after the shell itself has
        // exited — an unbounded read would leave the tool call stuck in
        // "running" and wedge the agent loop. A short safety timeout turns
        // the drain into a bounded wait and lets the call complete with
        // whatever was captured.
        //
        // A user-initiated cancellation returns **immediately** instead of
        // draining the pipes: the frontend has already streamed the partial
        // output live, so waiting for the remaining bytes (up to 3s when a
        // grandchild survives and holds a pipe open) would only delay the
        // confirmation the UI shows.  The reader tasks are aborted so they
        // cannot linger in the background either.
        //
        // The cancellation token stays registered until the drain finishes:
        // once the shell exits while a grandchild still holds the pipes open,
        // this drain phase is the only part of the execution still pending,
        // so the stop button keeps targeting the execution (even though the
        // wait itself is bounded) instead of silently no-oping.
        let pipe_drain_started = Instant::now();
        let (stdout, stderr) = if matches!(
            wait_result,
            ProcessWaitResult::Cancelled | ProcessWaitResult::TimedOut
        ) {
            // A stop or timeout must not wait for inherited pipe handles.
            // The live stream already delivered the useful partial output;
            // abort both readers immediately after the process-tree kill.
            if let Some(task) = stdout_task {
                task.abort();
            }
            if let Some(task) = stderr_task {
                task.abort();
            }
            (String::new(), String::new())
        } else {
            // Drain stdout and stderr concurrently. A grandchild that keeps
            // one pipe open can therefore delay completion by at most the
            // single bounded safety timeout, never twice that timeout.
            tokio::join!(
                await_stream_task(stdout_task, Some(Duration::from_secs(3))),
                await_stream_task(stderr_task, Some(Duration::from_secs(3))),
            )
        };
        let pipe_drain_ms = pipe_drain_started.elapsed().as_millis() as u64;

        // No further cancellation can target this execution once the
        // process has settled and the pipe drain has finished.
        crate::api::cancel::unregister_tool_execution(&tool_execution_id);

        let (level, status, message, exit_code) = match &wait_result {
            ProcessWaitResult::Completed(0) => {
                ("INFO", "completed", "Terminal command completed", Some(0))
            }
            ProcessWaitResult::Completed(code) => (
                "WARN",
                "non_zero_exit",
                "Terminal command exited with a non-zero status",
                Some(*code),
            ),
            ProcessWaitResult::TimedOut => ("WARN", "timeout", "Terminal command timed out", None),
            ProcessWaitResult::Cancelled => {
                ("INFO", "cancelled", "Terminal command was cancelled", None)
            }
            ProcessWaitResult::Failed(_) => {
                ("ERROR", "failed", "Terminal process wait failed", None)
            }
        };
        log_bash_execution(BashExecutionLog {
            level,
            message,
            status,
            route: "local",
            timeout_ms: timeout,
            is_interactive,
            detached: false,
            session_id: session_id.as_deref(),
            tool_execution_id: Some(&tool_execution_id),
            exit_code,
            captured_stdout_bytes: stdout.len(),
            captured_stderr_bytes: stderr.len(),
            timings: BashExecutionTimings {
                argument_parse_ms,
                sensitive_check_ms,
                remote_resolve_ms,
                terminal_settings_ms,
                shell_resolve_ms,
                login_path_ms,
                spawn_ms,
                first_output_ms: first_output_ms.get().copied(),
                process_wait_ms,
                pipe_drain_ms,
                total_ms: execution_started.elapsed().as_millis() as u64,
                ..BashExecutionTimings::default()
            },
        });

        match wait_result {
            ProcessWaitResult::Completed(exit_code) => Ok(json!({
                "stdout": stdout,
                "stderr": stderr,
                "exitCode": exit_code,
                "command": command,
                "executedAt": executed_at,
                "interactive": is_interactive
            })),
            ProcessWaitResult::TimedOut => Err(Error::new(
                Status::GenericFailure,
                format!("Command timed out after {timeout}ms: {command}"),
            )),
            ProcessWaitResult::Cancelled => Err(Error::new(
                Status::GenericFailure,
                format!("Command was stopped by the user: {command}"),
            )),
            ProcessWaitResult::Failed(error) => Err(Error::new(
                Status::GenericFailure,
                format!("Failed to wait for process: {error}"),
            )),
        }
    }
}

enum ProcessWaitResult {
    Completed(i32),
    TimedOut,
    Cancelled,
    Failed(String),
}

/// Await a stream reader task.  When `safety_timeout` is provided
/// (used after a process-tree kill), the wait is bounded so we never
/// block indefinitely if a grandchild somehow survives and keeps a
/// pipe open.
async fn await_stream_task(
    task: Option<tokio::task::JoinHandle<String>>,
    safety_timeout: Option<Duration>,
) -> String {
    match task {
        Some(mut handle) => match safety_timeout {
            Some(dur) => {
                // Await by reference so the handle survives a timeout and can
                // be aborted afterwards. JoinHandle is Unpin, and `&mut F`
                // implements Future when F does, so `&mut handle` works here.
                match tokio::time::timeout(dur, &mut handle).await {
                    Ok(Ok(output)) => output,
                    // The drain timed out (a grandchild keeps a pipe write
                    // handle open and EOF never arrives). Abort the reader so
                    // the background task cannot linger forever.
                    _ => {
                        handle.abort();
                        String::new()
                    }
                }
            }
            None => handle.await.unwrap_or_default(),
        },
        None => String::new(),
    }
}

/// 判断命令是否是 WSL 命令（首 token 为 `wsl` / `wsl.exe`）。detach 场景下
/// taskkill /PID 只能杀掉 wsl.exe 壳进程，WSL 实例内的 Linux 进程需要
/// 通过 pkill / wsl --terminate 停止，hint 提示据此区分。
fn is_wsl_command(command: &str) -> bool {
    command.split_whitespace().next().is_some_and(|token| {
        token.eq_ignore_ascii_case("wsl") || token.eq_ignore_ascii_case("wsl.exe")
    })
}

/// 生成 detach 模式日志文件的完整路径并创建父目录。
///
/// 日志统一放在 `<workingDirectory>/.snow/logs/`（`.snow` 已被 .gitignore
/// 排除，不会污染项目 git 状态）。文件名形如
/// `<name>-<yyyyMMdd-HHmmss-SSS>.log`，毫秒时间戳避免同名命令在同一秒内
/// 启动时日志文件碰撞；`name` 取自命令首 token 的 basename（仅保留
/// `[A-Za-z0-9_-]`，最长 24 字符），空则回退为 `detached`。返回值为绝对
/// 路径，调用方负责以正斜杠形式呈现给 agent / 前端。
fn create_detach_log_path(
    working_directory: &str,
    command: &str,
) -> napi::Result<std::path::PathBuf> {
    let logs_dir = std::path::Path::new(working_directory)
        .join(".snow")
        .join("logs");
    fs::create_dir_all(&logs_dir).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to create detach log directory {}: {error}",
                logs_dir.display()
            ),
        )
    })?;

    let raw_name = command.split_whitespace().next().unwrap_or("detached");
    let base_name = raw_name.rsplit(['/', '\\']).next().unwrap_or(raw_name);
    let sanitized: String = base_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .take(24)
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let name = if sanitized.is_empty() {
        "detached".to_string()
    } else {
        sanitized
    };

    // 毫秒级时间戳：避免同一秒内连续启动同名 detach 命令时日志文件碰撞
    // （秒级精度下两个进程会 append 到同一个文件，日志互相混合）。
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    Ok(logs_dir.join(format!("{name}-{timestamp}.log")))
}

/// Kill the entire process tree rooted at `child`, not just the
/// immediate shell process. On Windows, `taskkill` is launched asynchronously
/// and bounded by a hard deadline; if it stalls, the shell is force-killed
/// immediately as a fallback. On Unix the dedicated process group is killed.
async fn kill_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            // /T = kill entire process tree, /F = force kill. Do not await this
            // command indefinitely: a broken taskkill must never block the
            // safety-critical cancellation path.
            let killer = tokio::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn();
            if let Ok(mut killer) = killer {
                let _ = tokio::time::timeout(Duration::from_millis(750), killer.wait()).await;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Negative PID kills the entire process group. The child was
            // spawned with process_group(0), so it leads its own group.
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &format!("-{pid}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }

    // Fallback is non-blocking. The bounded wait only reaps the direct child;
    // it can never keep the Electron event loop blocked.
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_millis(750), child.wait()).await;
}

async fn read_stream<R>(
    mut reader: R,
    stream: &'static str,
    on_chunk: Arc<BashStreamCallback>,
    first_output_ms: Arc<OnceLock<u64>>,
    execution_started: Instant,
) -> String
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut pending_utf8 = Vec::new();

    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };

        let _ = first_output_ms.set(execution_started.elapsed().as_millis() as u64);
        output.extend_from_slice(&buffer[..read]);
        pending_utf8.extend_from_slice(&buffer[..read]);
        emit_complete_utf8_chunks(&on_chunk, stream, &mut pending_utf8);
    }

    if !pending_utf8.is_empty() {
        emit_stream_chunk(
            &on_chunk,
            stream,
            String::from_utf8_lossy(&pending_utf8).into_owned(),
        );
    }

    strip_ansi_codes(&String::from_utf8_lossy(&output))
}

fn emit_complete_utf8_chunks(on_chunk: &BashStreamCallback, stream: &str, pending: &mut Vec<u8>) {
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                emit_stream_chunk(on_chunk, stream, text.to_string());
                pending.clear();
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    let text = String::from_utf8_lossy(&pending[..valid_up_to]).into_owned();
                    emit_stream_chunk(on_chunk, stream, text);
                    pending.drain(..valid_up_to);
                    continue;
                }

                if error.error_len().is_none() {
                    return;
                }

                let invalid_len = error.error_len().unwrap_or(1);
                let invalid = String::from_utf8_lossy(&pending[..invalid_len]).into_owned();
                emit_stream_chunk(on_chunk, stream, invalid);
                pending.drain(..invalid_len);
            }
        }
    }
}

fn emit_stream_chunk(on_chunk: &BashStreamCallback, stream: &str, data: String) {
    if data.is_empty() {
        return;
    }

    let cleaned = strip_ansi_codes(&data);
    if cleaned.is_empty() {
        return;
    }

    on_chunk.call(
        BashStreamChunk {
            stream: stream.to_string(),
            data: cleaned,
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

/// Strip ANSI escape sequences (CSI/SGR color codes, cursor movement,
/// OSC hyperlinks, etc.) from terminal output. These codes are emitted
/// by tools like `vite build` / `npm run build` when they detect a TTY
/// and would otherwise leak as raw `\x1b[...m` bytes into the model
/// context and the UI.
fn strip_ansi_codes(input: &str) -> String {
    static ANSI_RE: OnceLock<Regex> = OnceLock::new();
    let re = ANSI_RE.get_or_init(|| {
        // CSI sequences: ESC [ ... final byte in 0x40..=0x7E
        // OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \  (ST)
        // Other two-byte escapes (ESC + single char) that some tools emit.
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9AB]")
            .expect("invalid ANSI strip regex")
    });
    re.replace_all(input, "").into_owned()
}

// ============================================================================
// Security utilities (ported from snow-cli security.utils.ts)
// ============================================================================

/// Check if a command matches any user-configured sensitive command rules.
/// Uses spawn_blocking to avoid blocking the async runtime with SQLite I/O.
/// Returns a JSON array of matched rules (command_id, pattern, description).
async fn check_sensitive_commands(command: &str, project_id: Option<&str>) -> Vec<Value> {
    let command_owned = command.to_string();
    let project_id_owned = project_id.map(str::to_string);
    match tokio::task::spawn_blocking(move || {
        crate::storage::check_sensitive_command_match(command_owned, project_id_owned)
    })
    .await
    {
        Ok(Ok(matches)) => matches
            .into_iter()
            .map(|m| {
                json!({
                    "commandId": m.command_id,
                    "pattern": m.pattern,
                    "description": m.description,
                })
            })
            .collect(),
        Ok(Err(_)) | Err(_) => Vec::new(),
    }
}

/// Self-protection: detect commands that would kill the app's own process.
struct SelfDestructCheck {
    is_self_destructive: bool,
    reason: String,
    suggestion: String,
}

/// Returns a SelfDestructCheck indicating whether the command is self-destructive.
///
/// Since this runs inside the Electron app process, any command that terminates
/// Electron processes by name (e.g. killall, pkill, taskkill) will also kill the app.
fn is_self_destructive_command(command: &str) -> SelfDestructCheck {
    let lower = command.to_lowercase();
    let app_pid = std::process::id();

    // Windows CMD: taskkill targeting electron.exe
    if regex_matches(r"(?i)\btaskkill\b", command)
        && regex_matches(r"(?i)\belectron(\.exe)?\b", command)
    {
        return SelfDestructCheck {
            is_self_destructive: true,
            reason: "Command would terminate electron.exe processes, including this app itself"
                .to_string(),
            suggestion: format!(
                "This app is running as electron.exe (PID: {}). Use \"taskkill /PID <target_pid>\" for specific processes, excluding PID {}.",
                app_pid, app_pid
            ),
        };
    }

    // Unix: killall electron
    if regex_matches(r"(?i)\bkillall\s+(-\w+\s+)*electron\b", command) {
        return SelfDestructCheck {
            is_self_destructive: true,
            reason: "killall electron would terminate ALL Electron processes, including this app"
                .to_string(),
            suggestion: format!(
                "Use \"kill <specific_pid>\" to target individual processes, excluding PID {}.",
                app_pid
            ),
        };
    }

    // Unix: pkill electron / pkill -f electron
    if regex_matches(r"(?i)\bpkill\s+(-\w+\s+)*electron\b", command) {
        return SelfDestructCheck {
            is_self_destructive: true,
            reason: "pkill electron would terminate Electron processes, including this app"
                .to_string(),
            suggestion: format!(
                "Use \"kill <specific_pid>\" to target individual processes, excluding PID {}.",
                app_pid
            ),
        };
    }

    // Also protect against killing node processes
    if regex_matches(r"(?i)\bkillall\s+(-\w+\s+)*node\b", command) {
        return SelfDestructCheck {
            is_self_destructive: true,
            reason: "killall node would terminate ALL Node.js processes, including this app"
                .to_string(),
            suggestion: format!(
                "Use \"kill <specific_pid>\" to target individual processes, excluding PID {}.",
                app_pid
            ),
        };
    }

    if regex_matches(r"(?i)\bpkill\s+(-\w+\s+)*node\b", command) {
        return SelfDestructCheck {
            is_self_destructive: true,
            reason: "pkill node would terminate Node.js processes, including this app".to_string(),
            suggestion: format!(
                "Use \"kill <specific_pid>\" to target individual processes, excluding PID {}.",
                app_pid
            ),
        };
    }

    // Windows: Stop-Process targeting node/electron
    if lower.contains("stop-process")
        && (regex_matches(r"(?i)\bnode\b", command) || regex_matches(r"(?i)\belectron\b", command))
    {
        return SelfDestructCheck {
            is_self_destructive: true,
            reason: "Command would terminate Node.js/Electron processes, including this app itself"
                .to_string(),
            suggestion: format!(
                "This app (PID: {}) may be affected. Add a PID exclusion filter.",
                app_pid
            ),
        };
    }

    // Directly targeting the app's own PID
    let pid_str = app_pid.to_string();

    // Check for "kill <pid>" or "kill -9 <pid>" patterns
    let kill_pattern = format!(r"\bkill\s+(-\d+\s+)*{}\b", pid_str);
    let kill9_pattern = format!(r"\bkill\s+-9\s+{}\b", pid_str);
    let stop_process_pattern = format!(r"(?i)\bStop-Process\s+.*-Id\s+{}\b", pid_str);
    let taskkill_pattern = format!(r"(?i)\btaskkill\b.*/PID\s+{}\b", pid_str);

    let pid_patterns = [
        kill_pattern,
        kill9_pattern,
        stop_process_pattern,
        taskkill_pattern,
    ];

    for pattern in &pid_patterns {
        if regex_matches(pattern, command) {
            return SelfDestructCheck {
                is_self_destructive: true,
                reason: format!(
                    "Command directly targets this app process (PID: {})",
                    app_pid
                ),
                suggestion: format!(
                    "PID {} is the Snow App process. Killing it will terminate the current session.",
                    app_pid
                ),
            };
        }
    }

    let _ = lower; // suppress unused warning
    SelfDestructCheck {
        is_self_destructive: false,
        reason: String::new(),
        suggestion: String::new(),
    }
}

/// Helper: compile and test a regex pattern against a string
fn regex_matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern)
        .map(|r| r.is_match(text))
        .unwrap_or(false)
}
