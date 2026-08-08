use std::path::PathBuf;
use std::sync::OnceLock;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;

#[napi(object)]
pub struct DetectedTerminal {
    pub name: String,
    pub path: String,
    pub family: String,
}

const POWERSHELL_CORE_PATHS: &[&str] = &[
    r"C:\Program Files\PowerShell\7\pwsh.exe",
    r"C:\Program Files\PowerShell\6\pwsh.exe",
];

/// Well-known Git Bash installation roots across common drives.
/// Each entry is (drive_letter) — we build `<drive>:\Program Files\Git` and
/// `<drive>:\Program Files (x86)\Git` from them.
const GIT_BASH_DRIVES: &[char] = &['C', 'D'];

fn is_windows() -> bool {
    cfg!(target_os = "windows")
}

fn check_executable_in_path(exe: &str, path_env: &str) -> Option<String> {
    let sep = if is_windows() { ';' } else { ':' };
    let extensions: &[&str] = if is_windows() {
        &["", ".exe", ".bat", ".cmd"]
    } else {
        &[""]
    };

    for dir in path_env.split(sep) {
        if dir.is_empty() {
            continue;
        }
        for ext in extensions {
            let mut candidate = PathBuf::from(dir);
            candidate.push(format!("{}{}", exe, ext));
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Try to locate Git Bash by deriving the Git root from `git.exe` in PATH.
/// If `git.exe` is at `<root>\cmd\git.exe`, then `bash.exe` is at
/// `<root>\bin\bash.exe`.
fn find_git_bash_from_git_in_path(path_env: &str) -> Option<String> {
    let git_exe = check_executable_in_path("git", path_env)?;
    // git_exe = <root>\cmd\git.exe  →  parent.parent = <root>
    let git_path = PathBuf::from(&git_exe);
    let root = git_path
        .parent() // <root>\cmd
        .and_then(|p| p.parent())?; // <root>
    let bash = root.join("bin").join("bash.exe");
    if bash.exists() {
        Some(bash.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Check well-known Git Bash installation directories across drives.
fn find_git_bash_well_known() -> Option<String> {
    for drive in GIT_BASH_DRIVES {
        for prog in &["Program Files", "Program Files (x86)"] {
            let bash = PathBuf::from(format!("{}:\\{}\\Git\\bin\\bash.exe", drive, prog));
            if bash.exists() {
                return Some(bash.to_string_lossy().to_string());
            }
        }
    }
    None
}

pub(crate) fn detect_windows_terminals() -> Vec<DetectedTerminal> {
    let mut results: Vec<DetectedTerminal> = Vec::new();
    let path_env = std::env::var("PATH").unwrap_or_default();

    // PowerShell Core (pwsh.exe) at well-known paths
    for core_path in POWERSHELL_CORE_PATHS {
        if PathBuf::from(core_path).exists() {
            results.push(DetectedTerminal {
                name: "PowerShell Core".to_string(),
                path: core_path.to_string(),
                family: "powershell".to_string(),
            });
        }
    }

    // Windows built-in candidates via PATH lookup
    let windows_candidates: &[(&str, &str, &str)] = &[
        ("PowerShell", "powershell.exe", "powershell"),
        ("Command Prompt", "cmd.exe", "cmd"),
        ("WSL Bash", "wsl.exe", "wsl"),
    ];

    for (name, exe, family) in windows_candidates {
        if let Some(found) = check_executable_in_path(exe, &path_env) {
            results.push(DetectedTerminal {
                name: name.to_string(),
                path: found,
                family: family.to_string(),
            });
        }
    }

    // Git Bash — try deriving from git.exe location in PATH first
    if let Some(bash_path) = find_git_bash_from_git_in_path(&path_env) {
        let already_listed = results.iter().any(|r| r.path == bash_path);
        if !already_listed {
            results.push(DetectedTerminal {
                name: "Git Bash".to_string(),
                path: bash_path,
                family: "posix".to_string(),
            });
        }
    }

    // Git Bash — fallback to well-known installation paths
    if !results.iter().any(|r| r.name == "Git Bash") {
        if let Some(bash_path) = find_git_bash_well_known() {
            results.push(DetectedTerminal {
                name: "Git Bash".to_string(),
                path: bash_path,
                family: "posix".to_string(),
            });
        }
    }

    // COMSPEC fallback
    if let Ok(comspec) = std::env::var("COMSPEC") {
        if !comspec.is_empty() && PathBuf::from(&comspec).exists() {
            let already_listed = results.iter().any(|r| r.path == comspec);
            if !already_listed {
                results.push(DetectedTerminal {
                    name: "Command Prompt".to_string(),
                    path: comspec,
                    family: "cmd".to_string(),
                });
            }
        }
    }

    results
}

pub(crate) fn detect_posix_terminals() -> Vec<DetectedTerminal> {
    let mut results: Vec<DetectedTerminal> = Vec::new();
    let path_env = std::env::var("PATH").unwrap_or_default();

    let posix_candidates: &[(&str, &str, &str)] = &[
        ("zsh", "zsh", "posix"),
        ("bash", "bash", "posix"),
        ("fish", "fish", "posix"),
        ("sh", "sh", "posix"),
    ];

    for (name, exe, family) in posix_candidates {
        if let Some(found) = check_executable_in_path(exe, &path_env) {
            let already_listed = results.iter().any(|r| r.path == found);
            if !already_listed {
                results.push(DetectedTerminal {
                    name: name.to_string(),
                    path: found,
                    family: family.to_string(),
                });
            }
        }
    }

    // $SHELL fallback
    if let Ok(shell_env) = std::env::var("SHELL") {
        if !shell_env.is_empty() && PathBuf::from(&shell_env).exists() {
            let already_listed = results.iter().any(|r| r.path == shell_env);
            if !already_listed {
                results.push(DetectedTerminal {
                    name: "Default shell ($SHELL)".to_string(),
                    path: shell_env,
                    family: "posix".to_string(),
                });
            }
        }
    }

    results
}

#[napi]
pub async fn detect_terminals() -> napi::Result<Vec<DetectedTerminal>> {
    // 文件系统 I/O 操作使用 spawn_blocking 避免阻塞 Node.js 主线程
    tokio::task::spawn_blocking(|| {
        let terminals = if is_windows() {
            detect_windows_terminals()
        } else {
            detect_posix_terminals()
        };
        Ok(terminals)
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to detect terminals: {}", e),
        )
    })?
}
pub(crate) async fn detect_default_terminal() -> napi::Result<Option<DetectedTerminal>> {
    let terminals = detect_terminals().await?;
    Ok(terminals.into_iter().next())
}

// ============================================================================
// 终端 Shell 解析逻辑（供 bash MCP 服务和 hooks 执行器共用）
// ============================================================================

pub(crate) const TERMINAL_SETTINGS_CODE: &str = "terminal_settings";

#[derive(Deserialize)]
pub(crate) struct TerminalSettingsJson {
    #[serde(rename = "shellPath")]
    pub shell_path: String,
}

/// 从 system_settings.terminal_settings 读取 shellPath。
/// shellPath 为空时返回空字符串，由调用方决定回退策略。
/// 同步版本供 spawn_blocking 线程上的同步调用方（如 git 执行器）使用。
pub(crate) fn load_terminal_shell_path_sync() -> napi::Result<String> {
    let setting_json = crate::storage::get_system_setting_value(TERMINAL_SETTINGS_CODE.to_string())
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read terminal settings: {error}"),
            )
        })?;

    match setting_json {
        Some(json) => {
            let settings: TerminalSettingsJson = serde_json::from_str(&json).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse terminal settings: {error}"),
                )
            })?;
            Ok(settings.shell_path)
        }
        None => Ok(String::new()),
    }
}

/// 从 system_settings.terminal_settings 读取 shellPath（异步版本，
/// 在阻塞线程池上执行，供 async 上下文调用）。
pub(crate) async fn load_terminal_shell_path() -> napi::Result<String> {
    tokio::task::spawn_blocking(load_terminal_shell_path_sync)
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read terminal settings: {error}"),
            )
        })?
}

/// 根据 shellPath 解析实际要启动的 shell 可执行文件及参数。
/// shellPath 为空时自动检测默认终端；检测失败时使用平台回退（cmd / sh）。
/// `cwd` 为工作目录；WSL 等需要通过参数传递目录的 shell 会使用它构造
/// `--cd` 参数，而 powershell/cmd/posix 仍由调用方通过 `current_dir` 设置。
pub(crate) async fn resolve_shell_and_args(
    shell_path: &str,
    command: &str,
    cwd: Option<&str>,
) -> napi::Result<(String, Vec<String>)> {
    if shell_path.is_empty() {
        if let Some(detected) = detect_default_terminal().await? {
            return build_shell_args(&detected.path, &detected.family, command, cwd);
        }
        return fallback_shell_args(command);
    }

    let family = detect_shell_family(shell_path);
    build_shell_args(shell_path, &family, command, cwd)
}

pub(crate) fn detect_shell_family(shell_path: &str) -> String {
    let lower = shell_path.to_lowercase();
    let file_name = std::path::Path::new(shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();

    if file_name.contains("pwsh")
        || file_name.contains("powershell")
        || lower.contains("pwsh")
        || lower.contains("powershell")
    {
        "powershell".to_string()
    } else if file_name.contains("cmd") || lower.contains("cmd.exe") {
        "cmd".to_string()
    } else if file_name.contains("wsl") || lower.contains("wsl.exe") {
        "wsl".to_string()
    } else if lower.contains("git") && (file_name.contains("bash") || file_name.contains("sh")) {
        // Git Bash (MSYS2/MinGW)：路径通常位于 <root>\Git\bin\bash.exe、
        // <root>\Git\usr\bin\bash.exe 或 git-bash.exe，属于 Windows 上的
        // POSIX 兼容环境。判断放在 wsl 之后、posix 默认之前。
        "gitbash".to_string()
    } else {
        "posix".to_string()
    }
}

pub(crate) fn build_shell_args(
    shell: &str,
    family: &str,
    command: &str,
    cwd: Option<&str>,
) -> napi::Result<(String, Vec<String>)> {
    match family {
        "powershell" => {
            // 注入 UTF-8 输出编码，避免中文路径/输出乱码
            let utf8_command = format!(
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
                command
            );
            Ok((
                shell.to_string(),
                vec![
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    utf8_command,
                ],
            ))
        }
        "cmd" => {
            let utf8_command = format!("chcp 65001>nul && {}", command);
            Ok((shell.to_string(), vec!["/C".to_string(), utf8_command]))
        }
        "wsl" => {
            // WSL 不会继承 Windows 进程的 cwd 作为 Linux 工作目录，必须通过
            // `--cd` 显式传递（wsl.exe 接受 Windows 路径并自动转换为 /mnt/...）。
            // 使用 `bash -lc` 以登录 shell 方式运行命令，确保 .profile 中设置的
            // PATH（如 nvm 管理的 node）被正确加载。
            let mut args: Vec<String> = Vec::new();
            if let Some(dir) = cwd.map(str::trim).filter(|d| !d.is_empty()) {
                args.push("--cd".to_string());
                args.push(dir.to_string());
            }
            args.push("-e".to_string());
            args.push("bash".to_string());
            args.push("-lc".to_string());
            args.push(command.to_string());
            Ok((shell.to_string(), args))
        }
        _ => Ok((
            shell.to_string(),
            vec!["-c".to_string(), command.to_string()],
        )),
    }
}

pub(crate) fn fallback_shell_args(command: &str) -> napi::Result<(String, Vec<String>)> {
    if cfg!(target_os = "windows") {
        let utf8_command = format!("chcp 65001>nul && {}", command);
        Ok(("cmd".to_string(), vec!["/C".to_string(), utf8_command]))
    } else {
        Ok((
            "sh".to_string(),
            vec!["-c".to_string(), command.to_string()],
        ))
    }
}

// ============================================================================
// PATH 解析（修复 macOS GUI 应用 PATH 缺失问题）
// ============================================================================

/// 缓存登录 shell 解析出的 PATH，避免每次执行命令都 fork 一个 shell。
/// Electron 应用进程生命周期内 PATH 变化极少，缓存是安全的。
static LOGIN_PATH_CACHE: OnceLock<String> = OnceLock::new();

/// 展开 Windows 路径中的 `%VAR%` 环境变量引用（如 `%SystemRoot%`）。
/// 仅展开已知变量，未知引用保持原样。
#[cfg(target_os = "windows")]
fn expand_env_vars(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            // 收集 % 之间的变量名
            let mut var_name = String::new();
            let mut found_close = false;
            while let Some(&next) = chars.peek() {
                if next == '%' {
                    chars.next();
                    found_close = true;
                    break;
                }
                var_name.push(next);
                chars.next();
            }
            if found_close && !var_name.is_empty() {
                // 查找环境变量（大小写不敏感查找）
                let val = std::env::vars().find(|(k, _)| k.eq_ignore_ascii_case(&var_name));
                if let Some((_, v)) = val {
                    result.push_str(&v);
                } else {
                    // 未知变量，保留原样
                    result.push('%');
                    result.push_str(&var_name);
                    result.push('%');
                }
            } else {
                // 没有闭合 % 或空变量名，保留原始 %
                result.push('%');
                result.push_str(&var_name);
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/// 从 Windows 注册表读取 User PATH 和 System PATH 并合并。
/// 注册表是 Windows PATH 的权威来源，比进程继承的 PATH 更可靠。
/// Electron GUI 应用有时会继承到不完整的 PATH（如从 explorer.exe 启动），
/// 读取注册表可以确保拿到完整的系统 PATH。
#[cfg(target_os = "windows")]
fn read_registry_path() -> Option<String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // System PATH
    let system_path: Option<String> = hklm
        .open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            KEY_READ,
        )
        .ok()
        .and_then(|key| key.get_value("Path").ok());

    // User PATH
    let user_path: Option<String> = hkcu
        .open_subkey_with_flags(r"Environment", KEY_READ)
        .ok()
        .and_then(|key| key.get_value("Path").ok());

    let system_path = system_path.map(|p| expand_env_vars(&p)).unwrap_or_default();
    let user_path = user_path.map(|p| expand_env_vars(&p)).unwrap_or_default();

    // 合并：System PATH 在前，User PATH 在后（与 Windows 默认行为一致）
    let combined = match (system_path.is_empty(), user_path.is_empty()) {
        (true, true) => return None,
        (true, false) => user_path,
        (false, true) => system_path,
        (false, false) => format!("{};{}", system_path, user_path),
    };

    if combined.trim().is_empty() {
        None
    } else {
        Some(combined)
    }
}

pub(crate) async fn resolve_login_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(cached) = LOGIN_PATH_CACHE.get() {
            if !cached.is_empty() {
                return Some(cached.clone());
            }
        }

        // 注册表读取是同步 I/O，用 spawn_blocking 避免阻塞 tokio 运行时
        let path = tokio::task::spawn_blocking(|| read_registry_path())
            .await
            .ok()
            .flatten();

        if let Some(ref p) = path {
            let _ = LOGIN_PATH_CACHE.set(p.clone());
        }
        path
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(cached) = LOGIN_PATH_CACHE.get() {
            if !cached.is_empty() {
                return Some(cached.clone());
            }
        }

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::process::Command::new(&shell)
                .args(["-l", "-i", "-c", "echo $PATH"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output(),
        )
        .await;

        let path = match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // 交互式 shell 可能会在 .zshrc 中往 stdout 打印额外内容
                //（如 motd、nvm 提示等），echo $PATH 不一定在第一行。
                // 取最后一个非空行作为 PATH 值。
                let path = stdout
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .last()
                    .unwrap_or("")
                    .to_string();
                if path.is_empty() {
                    return None;
                }
                path
            }
            _ => return None,
        };

        let _ = LOGIN_PATH_CACHE.set(path.clone());
        Some(path)
    }
}
