use std::collections::HashMap;
use std::process::Stdio;

use napi::{Error, Result};
use rmcp::model::ClientInfo;
use rmcp::service::{ClientLifecycleMode, ClientServiceExt, RunningService};
use tokio::process::Command;

use crate::exports::terminal::{detect_shell_family, resolve_login_path};
use crate::storage::McpServerConfigRecord;

use super::super::protocol::RemoteMcpTool;

pub(super) type StdioRunningClient = RunningService<rmcp::RoleClient, ClientInfo>;

pub(super) struct StdioMcpClient {
    client: StdioRunningClient,
}

impl StdioMcpClient {
    pub(super) async fn connect(config: &McpServerConfigRecord) -> Result<Self> {
        if config.command.trim().is_empty() {
            return Err(Error::from_reason(format!(
                "External MCP server {} has no command",
                config.name
            )));
        }

        // 优先尝试 2026-07-28 无状态协议。SDK 的 Auto 模式只对规范协商错误
        // （-32601 Method Not Found / -32022 Unsupported Protocol Version）
        // 自动降级或换版本重试；旧服务器若返回其他 JSON-RPC 错误（如 deepwiki
        // 的 -32600 "Unsupported protocol version"），需在下面用 legacy
        // initialize 握手手动重试一次。
        let auto_lifecycle = ClientLifecycleMode::Auto {
            preferred_versions: vec![rmcp::model::ProtocolVersion::V_2026_07_28],
            legacy_version: Some(rmcp::model::ProtocolVersion::V_2025_11_25),
        };

        let client_info = ClientInfo::default();

        // 旧 SDK 服务器（如 fastmcp 构建的 firecrawl-mcp）对带 `_meta` 的
        // `server/discover` 探测会静默不响应——既不返回 JSON-RPC 错误也不
        // 关闭连接，导致 Auto 协商无限挂起。加超时：超时视为服务器不支持
        // 2026-07-28 无状态协议，回退 legacy initialize 握手重连。
        const DISCOVER_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
        let auto_result = tokio::time::timeout(
            DISCOVER_PROBE_TIMEOUT,
            client_info
                .clone()
                .serve_with_lifecycle(spawn_transport(config).await?, auto_lifecycle),
        )
        .await;

        match auto_result {
            Ok(Ok(running)) => Ok(Self { client: running }),
            Ok(Err(error)) if super::should_retry_with_legacy_handshake(&error) => {
                // 旧子进程的管道已随 transport 关闭，重新 spawn 一个，
                // 改用 legacy 握手重连一次。
                match Self::connect_legacy(config).await {
                    Ok(client) => Ok(client),
                    // 重试失败时保留原始 Auto 错误（含版本协商诊断信息）
                    Err(_) => Err(Error::from_reason(format!(
                        "Failed to initialize external MCP stdio server {}: {error}",
                        config.name
                    ))),
                }
            }
            Ok(Err(error)) => Err(Error::from_reason(format!(
                "Failed to initialize external MCP stdio server {}: {error}",
                config.name
            ))),
            Err(_elapsed) => {
                // server/discover 探测超时：服务器静默不响应（如 fastmcp 构建的
                // firecrawl-mcp）。超时的 future 被 drop 时子进程随之终止，
                // connect_legacy 会重新 spawn 一个进程。
                match Self::connect_legacy(config).await {
                    Ok(client) => Ok(client),
                    Err(_) => Err(Error::from_reason(format!(
                        "Failed to initialize external MCP stdio server {}: Auto negotiate timed out (no response to server/discover), legacy initialize handshake also failed",
                        config.name
                    ))),
                }
            }
        }
    }

    /// 旧版本回退：直接以 legacy `initialize` 握手建立连接，跳过
    /// Auto 模式对 2026-07-28 无状态协议的 `server/discover` 探测。
    /// 当 Auto 协商降级后的连接不稳定（如旧 SDK 服务器调用时报
    /// Transport closed）时，用本方法重连可绕过协商探测路径。
    pub(super) async fn connect_legacy(config: &McpServerConfigRecord) -> Result<Self> {
        if config.command.trim().is_empty() {
            return Err(Error::from_reason(format!(
                "External MCP server {} has no command",
                config.name
            )));
        }

        let client_info = ClientInfo::default();
        let running = client_info
            .serve_with_lifecycle(
                spawn_transport(config).await?,
                ClientLifecycleMode::Initialize,
            )
            .await
            .map_err(|error| {
                Error::from_reason(format!(
                    "Failed to initialize external MCP stdio server {}: {error}",
                    config.name
                ))
            })?;

        Ok(Self { client: running })
    }

    pub(super) async fn list_all_tools(&self) -> Result<Vec<RemoteMcpTool>> {
        let tools = self.client.list_all_tools().await.map_err(|error| {
            Error::from_reason(format!("External MCP tools/list failed: {error}"))
        })?;
        Ok(tools.into_iter().map(rmcp_tool_to_remote).collect())
    }

    pub(super) async fn call_tool(
        &self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let params = rmcp::model::CallToolRequestParams::new(name.to_string());
        let params = if let Some(obj) = arguments.as_object() {
            params.with_arguments(obj.clone())
        } else {
            params
        };

        let result = self.client.call_tool(params).await.map_err(|error| {
            Error::from_reason(format!("External MCP tools/call failed: {error}"))
        })?;

        Ok(call_tool_result_to_value(result))
    }

    pub(super) async fn close(mut self) {
        let _ = self.client.close().await;
    }
}

/// Spawns the stdio subprocess for an external MCP server. Extracted so a
/// failed protocol negotiation can re-spawn a fresh child for the legacy
/// `initialize` handshake retry.
async fn spawn_transport(
    config: &McpServerConfigRecord,
) -> Result<rmcp::transport::TokioChildProcess> {
    let command_name = config.command.trim();
    let args = parse_string_array(&config.args_json, "args")?;
    let environment = parse_string_map(&config.env_json, "environment")?;

    // GUI 启动的 Electron（macOS Finder / Windows 资源管理器）进程 PATH 不完整，
    // 不含 Homebrew/nvm 等路径，导致 npx 等命令无法解析。注入 login shell
    // （Unix 上冒号分隔）或注册表（Windows 上分号分隔）的 PATH。
    // WSL 命令跳过：resolve_login_path 在 Windows 上返回的是 Windows 注册表
    // PATH（分号分隔），注入会覆盖 WSL 内有效的 Linux PATH（冒号分隔）；
    // WSL 通过 bash -l 自行从 .profile 加载正确的 Linux PATH。
    let login_path = if detect_shell_family(command_name) != "wsl" {
        resolve_login_path().await
    } else {
        None
    };

    // Windows 上 Rust 的 Command（CreateProcess）不会按 PATHEXT 搜索
    // .cmd/.bat 文件。npx、uvx 等命令实际是 npx.cmd、uvx.bat，直接
    // Command::new("npx") 会报 "program not found"。这里先用 login PATH
    // 做 PATHEXT 解析，若命中 .cmd/.bat 则自动套 cmd /c 包装。
    #[cfg(target_os = "windows")]
    let (actual_command, prefix_args) = {
        let fallback_path = std::env::var("PATH").unwrap_or_default();
        let path_env = login_path.as_deref().unwrap_or(&fallback_path);
        resolve_windows_command(command_name, path_env)
    };
    #[cfg(not(target_os = "windows"))]
    let (actual_command, prefix_args) = (command_name.to_string(), Vec::<String>::new());

    let mut command = Command::new(&actual_command);
    command.args(&prefix_args);
    command.args(args);

    if let Some(path) = login_path {
        command.env("PATH", path);
    }

    // 配置里显式声明的 env 最后注入，覆盖 login PATH（如用户自定义 PATH）。
    command.envs(environment);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    // Use the builder so we can pipe stderr for diagnostics while keeping
    // stdin/stdout piped (the defaults).
    let (transport, stderr_opt) = rmcp::transport::TokioChildProcess::builder(command)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            Error::from_reason(format!(
                "Failed to start external MCP server {}: {error}",
                config.name
            ))
        })?;

    // 排空子进程 stderr：不读取的话，管道缓冲（约 64KB）写满后子进程会
    // 阻塞，且服务器启动/调用失败的诊断日志会丢失。这里把 stderr 转发
    // 到应用日志，方便排查 spawn/握手/调用失败（如 issue #51 场景）。
    if let Some(stderr) = stderr_opt {
        let server_name = config.name.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = stderr;
            let mut buffer = vec![0u8; 4096];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buffer[..n]);
                        eprintln!("[External MCP {} stderr] {}", server_name, text.trim_end());
                    }
                }
            }
        });
    }

    Ok(transport)
}

fn rmcp_tool_to_remote(tool: rmcp::model::Tool) -> RemoteMcpTool {
    let name = tool.name.to_string();
    let description = tool
        .description
        .as_deref()
        .unwrap_or_default()
        .to_string();
    let input_schema = serde_json::to_value(tool.input_schema.as_ref()).unwrap_or_else(|_| {
        serde_json::json!({ "type": "object", "properties": {} })
    });
    RemoteMcpTool {
        name,
        description,
        input_schema,
    }
}

fn call_tool_result_to_value(result: rmcp::model::CallToolResult) -> serde_json::Value {
    serde_json::to_value(&result).unwrap_or_else(|_| {
        serde_json::json!({ "content": [], "isError": false })
    })
}

fn parse_string_array(value: &str, field: &str) -> Result<Vec<String>> {
    serde_json::from_str(value).map_err(|error| {
        Error::from_reason(format!("Invalid external MCP {field} JSON: {error}"))
    })
}

fn parse_string_map(value: &str, field: &str) -> Result<HashMap<String, String>> {
    serde_json::from_str(value).map_err(|error| {
        Error::from_reason(format!("Invalid external MCP {field} JSON: {error}"))
    })
}

/// On Windows, resolves a bare command name against PATH + PATHEXT.
/// Rust's `std::process::Command` (CreateProcess) only finds `.exe`
/// files — it does NOT search PATHEXT for `.cmd`/`.bat`. So commands
/// like `npx` (npx.cmd) or `uvx` (uvx.bat) fail with "program not
/// found" unless wrapped in `cmd /c`.
///
/// Returns `(executable, prefix_args)`:
/// - `.cmd`/`.bat` → `("cmd", ["/c", resolved_path])`
/// - `.exe` or other → `(resolved_path, [])`
/// - not found → `(command_name, [])` (let CreateProcess fail with a clear error)
#[cfg(target_os = "windows")]
fn resolve_windows_command(command_name: &str, path_env: &str) -> (String, Vec<String>) {
    use std::path::PathBuf;

    let lower = command_name.to_lowercase();
    let has_path_sep = command_name.contains('\\') || command_name.contains('/');

    // Already a .cmd/.bat file — must wrap with cmd /c
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        return (
            "cmd".to_string(),
            vec!["/c".to_string(), command_name.to_string()],
        );
    }

    // Already has a path separator or .exe extension — use as-is
    if has_path_sep || lower.ends_with(".exe") {
        return (command_name.to_string(), Vec::new());
    }

    // Bare command name — search PATH with PATHEXT extensions
    let pathext: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC".to_string())
        .split(';')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    for dir in path_env.split(';') {
        if dir.is_empty() {
            continue;
        }
        for ext in &pathext {
            let candidate = PathBuf::from(dir).join(format!("{}{}", command_name, ext));
            if candidate.exists() {
                let resolved = candidate.to_string_lossy().to_string();
                if ext == ".cmd" || ext == ".bat" {
                    return ("cmd".to_string(), vec!["/c".to_string(), resolved]);
                }
                return (resolved, Vec::new());
            }
        }
    }

    // Not found in PATH — return as-is and let CreateProcess produce the error
    (command_name.to_string(), Vec::new())
}
