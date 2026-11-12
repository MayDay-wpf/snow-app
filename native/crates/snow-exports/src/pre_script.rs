use std::process::Stdio;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use tokio::time::timeout;

use super::terminal::{
    detect_shell_family, is_windows_wsl_shell, load_terminal_shell_path, resolve_login_path,
    resolve_shell_and_args,
};

/// 前置脚本 stdout/stderr 单通道截断上限（按字符），防止脚本洪水输出撑爆内存。
const MAX_OUTPUT_CHARS: usize = 8192;
const DEFAULT_TIMEOUT_MS: i64 = 60_000;
const MIN_TIMEOUT_MS: i64 = 1_000;
const MAX_TIMEOUT_MS: i64 = 300_000;

#[napi(object)]
pub struct PreScriptResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// 执行定时任务的前置脚本（shell 命令），用于在触发 AI Loop 前判断本次是否需要运行。
///
/// 全程异步：进程 spawn 与输出收集都在 tokio 运行时进行，不阻塞 Node.js 事件循环。
/// - command: shell 命令文本（多行亦可，交由用户 shell 解释）
/// - cwd: 工作目录（任务所属项目路径）
/// - timeout_ms: 超时毫秒数（默认 60000，范围 1000-300000），超时后 kill 子进程
/// - env_json: 可选 JSON 对象字符串（形如 {"KEY":"value"}），注入为子进程环境变量
#[napi]
pub async fn run_pre_script(
    command: String,
    cwd: String,
    timeout_ms: Option<i64>,
    env_json: Option<String>,
) -> napi::Result<PreScriptResult> {
    let shell_path = load_terminal_shell_path().await?;
    let (shell, shell_args) = resolve_shell_and_args(&shell_path, &command, Some(&cwd)).await?;

    let shell_family = detect_shell_family(&shell);

    // login PATH 对 Windows 注入注册表 + 继承的合并 PATH（powershell/cmd 需要）；
    // WSL 跳过，由 `bash -lc` 自行从 .profile 加载 Linux PATH（冒号分隔，注入会破坏）。
    let login_path = if shell_family == "wsl" {
        None
    } else {
        resolve_login_path().await
    };

    let extra_env = parse_env_json(env_json.as_deref());

    let mut process = crate::utils::process::cmd_async(&shell);
    process
        .args(&shell_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        // 同 bash 工具：剥离 Electron 注入的 NODE_ENV，避免 npm 误判
        // production 模式而跳过 devDependencies。
        .env_remove("NODE_ENV");
    // Windows 宿主 + WSL shell 时，工作目录只能通过 `--cd` 参数传递：
    // 把 Linux 路径（/home/...）或 WSL UNC 路径设置为 Windows 子进程的
    // current_dir，会在启动 wsl.exe 前被 Windows 拒绝（os error 267）。
    // 与 bash MCP 工具、集成终端 ptyManager.ts 的处理保持一致。
    if !is_windows_wsl_shell(&shell_family) {
        process.current_dir(&cwd);
    }
    if let Some(path) = login_path {
        process.env("PATH", path);
    }
    for (key, value) in extra_env {
        process.env(key, value);
    }

    let effective_timeout = timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) as u64;

    let child = process.spawn().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to spawn pre-script: {error}"),
        )
    })?;

    let output_future = child.wait_with_output();
    tokio::pin!(output_future);

    match timeout(Duration::from_millis(effective_timeout), &mut output_future).await {
        Ok(Ok(output)) => Ok(PreScriptResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: truncate(&output.stdout),
            stderr: truncate(&output.stderr),
            timed_out: false,
        }),
        Ok(Err(error)) => Err(Error::new(
            Status::GenericFailure,
            format!("Pre-script failed: {error}"),
        )),
        Err(_) => {
            // 超时：child 已被 wait_with_output 移动进 future；显式 drop 触发
            // kill_on_drop(true) 终止子进程并回收，避免孤儿进程残留。
            drop(output_future);
            Ok(PreScriptResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("Timed out after {effective_timeout}ms"),
                timed_out: true,
            })
        }
    }
}

/// 解析可选的 JSON 环境变量注入（形如 {"KEY":"value"}）；非对象或解析失败时返回空。
fn parse_env_json(env_json: Option<&str>) -> Vec<(String, String)> {
    let Some(json) = env_json else {
        return Vec::new();
    };
    let json = json.trim();
    if json.is_empty() {
        return Vec::new();
    }
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(key, value)| {
            let value = value.as_str()?;
            if key.is_empty() {
                None
            } else {
                Some((key, value.to_string()))
            }
        })
        .collect()
}

/// 按字符截断输出（避免拆散多字节字符），超出部分丢弃。
fn truncate(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.chars().take(MAX_OUTPUT_CHARS).collect()
}
