//! 团队队长常驻服务：把应用注册为系统级「登录自启」项。
//!
//! 队长关掉主窗口后由托盘常驻继续承载 WebSocket 服务；设备重启后，系统会以
//! `--team-host` 参数后台拉起应用（不显示窗口），使团队服务自动恢复。
//! Windows 走 HKCU 登录项（普通用户可写），macOS / Linux 分别走 launchd 与
//! systemd；注册表读写放到阻塞线程池，命令行注册全异步，不阻塞 Node 事件循环。

use std::collections::HashMap;
#[cfg(not(target_os = "windows"))]
use std::process::{Output, Stdio};
#[cfg(not(target_os = "windows"))]
use std::time::Duration as StdDuration;

use napi_derive::napi;

/// 单条系统命令的超时（仅 macOS / Linux 需要调用外部命令注册服务）。
#[cfg(not(target_os = "windows"))]
const COMMAND_TIMEOUT: StdDuration = StdDuration::from_secs(20);

#[napi(object)]
pub struct TeamServiceOptions {
    /// true 注册 / 覆盖常驻任务，false 清除。
    pub enabled: bool,
    /// 任务标识：launchd label / 计划任务名后缀 / systemd 单元名。
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    /// 额外环境变量（Linux 图形会话变量等）。
    pub env: Option<HashMap<String, String>>,
}

#[derive(Clone)]
struct LaunchSpec {
    label: String,
    program: String,
    args: Vec<String>,
    /// 额外环境变量；Windows 计划任务不支持，仅在 macOS / Linux 下使用。
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    env: Vec<(String, String)>,
}

/// 注册或清除队长常驻服务；返回是否处于已注册状态。
#[napi]
pub async fn sync_team_service(options: TeamServiceOptions) -> napi::Result<bool> {
    let label = sanitize_label(&options.label)?;
    if !options.enabled {
        platform::clear(&label).await?;
        return Ok(false);
    }
    let program = options.program.trim().to_string();
    if program.is_empty() {
        return Err(napi::Error::from_reason("Team service program is required"));
    }
    let mut env: Vec<(String, String)> = options.env.unwrap_or_default().into_iter().collect();
    env.sort();
    let spec = LaunchSpec {
        label,
        program,
        args: options.args,
        env,
    };
    platform::register(&spec).await?;
    Ok(true)
}

/// 标识只允许字母数字与 . _ -，防止路径穿越与命令注入。
fn sanitize_label(label: &str) -> napi::Result<String> {
    let label = label.trim();
    let valid = !label.is_empty()
        && label.len() <= 128
        && label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if valid {
        Ok(label.to_string())
    } else {
        Err(napi::Error::from_reason(format!(
            "Invalid team service label \"{label}\""
        )))
    }
}

/// 执行一条系统命令（仅 macOS / Linux 通过命令行注册服务时使用）。
#[cfg(not(target_os = "windows"))]
async fn run(program: &str, args: &[&str]) -> napi::Result<Output> {
    let mut command = crate::utils::process::cmd_async(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match tokio::time::timeout(COMMAND_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(napi::Error::from_reason(format!(
            "Failed to run {program}: {error}"
        ))),
        Err(_) => Err(napi::Error::from_reason(format!("{program} timed out"))),
    }
}

#[cfg(not(target_os = "windows"))]
fn ensure_success(name: &str, output: &Output) -> napi::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    Err(napi::Error::from_reason(format!(
        "{name} failed ({}): {detail}",
        output.status
    )))
}

/// 注册服务过程中的 I/O 错误（仅 macOS / Linux 注册服务时使用）。
#[cfg(not(target_os = "windows"))]
fn io_error(error: std::io::Error) -> napi::Error {
    napi::Error::from_reason(format!("Team service registration I/O error: {error}"))
}

/// 删除文件（不存在视为成功）；仅 macOS / Linux 注册服务时需要。
#[cfg(not(target_os = "windows"))]
async fn remove_if_exists(path: &std::path::Path) -> napi::Result<bool> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

/// XML 转义（仅 macOS 构建 plist 时使用）。
#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::PathBuf;

    use super::{ensure_success, io_error, remove_if_exists, run, xml_escape, LaunchSpec};

    fn plist_path(label: &str) -> napi::Result<PathBuf> {
        let home = dirs_next::home_dir()
            .ok_or_else(|| napi::Error::from_reason("Home directory not found"))?;
        Ok(home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{label}.plist")))
    }

    fn domain() -> String {
        // SAFETY: getuid 无副作用且总是成功。
        format!("gui/{}", unsafe { libc::getuid() })
    }

    async fn bootout(label: &str) {
        let target = format!("{}/{label}", domain());
        let _ = run("launchctl", &["bootout", &target]).await;
    }

    pub(super) async fn register(spec: &LaunchSpec) -> napi::Result<()> {
        let path = plist_path(&spec.label)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
        }
        tokio::fs::write(&path, build_plist(spec))
            .await
            .map_err(io_error)?;

        bootout(&spec.label).await;
        let path_str = path.to_string_lossy().to_string();
        let domain = domain();
        let output = run("launchctl", &["bootstrap", &domain, &path_str]).await?;
        if output.status.success() {
            return Ok(());
        }
        // bootout 尚未完全生效时 bootstrap 可能报 I/O 错误，稍候重试一次
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let output = run("launchctl", &["bootstrap", &domain, &path_str]).await?;
        ensure_success("launchctl bootstrap", &output)
    }

    pub(super) async fn clear(label: &str) -> napi::Result<()> {
        bootout(label).await;
        remove_if_exists(&plist_path(label)?).await?;
        Ok(())
    }

    fn build_plist(spec: &LaunchSpec) -> String {
        let args: String = std::iter::once(&spec.program)
            .chain(spec.args.iter())
            .map(|arg| format!("    <string>{}</string>\n", xml_escape(arg)))
            .collect();
        let env = if spec.env.is_empty() {
            String::new()
        } else {
            let entries: String = spec
                .env
                .iter()
                .map(|(key, value)| {
                    format!(
                        "    <key>{}</key>\n    <string>{}</string>\n",
                        xml_escape(key),
                        xml_escape(value)
                    )
                })
                .collect();
            format!("  <key>EnvironmentVariables</key>\n  <dict>\n{entries}  </dict>\n")
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args}  </array>
{env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
"#,
            label = xml_escape(&spec.label),
        )
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    use super::LaunchSpec;

    /// 登录自启项所在的注册表位置：HKCU 下当前用户可写，无需管理员权限
    /// （计划任务要求管理员，非提升进程会被系统直接拒绝）。
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    /// 按 Windows 命令行规则给参数加引号。
    fn quote_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.contains(|ch: char| matches!(ch, ' ' | '\t' | '"')) {
            return arg.to_string();
        }
        format!("\"{}\"", arg.replace('"', "\\\""))
    }

    /// 拼出登录自启项要执行的完整命令行。
    fn command_line(spec: &LaunchSpec) -> String {
        std::iter::once(&spec.program)
            .chain(spec.args.iter())
            .map(|arg| quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub(super) async fn register(spec: &LaunchSpec) -> napi::Result<()> {
        let name = spec.label.clone();
        let command = command_line(spec);
        spawn_registry(move || write_run_entry(&name, &command)).await
    }

    pub(super) async fn clear(label: &str) -> napi::Result<()> {
        let name = label.to_string();
        spawn_registry(move || remove_run_entry(&name)).await
    }

    /// 注册表读写是同步系统调用，放到阻塞线程池执行，避免占用 Node 事件循环。
    async fn spawn_registry(
        task: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> napi::Result<()> {
        tokio::task::spawn_blocking(task)
            .await
            .map_err(|error| {
                napi::Error::from_reason(format!("Team service registry task failed: {error}"))
            })?
            .map_err(|reason| napi::Error::from_reason(reason))
    }

    fn write_run_entry(name: &str, command: &str) -> Result<(), String> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(RUN_KEY)
            .map_err(|error| format!("Failed to open {RUN_KEY}: {error}"))?;
        key.set_value(name, &command)
            .map_err(|error| format!("Failed to write login item \"{name}\": {error}"))
    }

    fn remove_run_entry(name: &str) -> Result<(), String> {
        let key = match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
        {
            Ok(key) => key,
            // 键不存在说明从未注册过，视为已清除。
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Failed to open {RUN_KEY}: {error}")),
        };
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to remove login item \"{name}\": {error}")),
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::PathBuf;

    use super::{ensure_success, io_error, remove_if_exists, run, LaunchSpec};

    fn unit_dir() -> napi::Result<PathBuf> {
        let config = dirs_next::config_dir()
            .ok_or_else(|| napi::Error::from_reason("Config directory not found"))?;
        Ok(config.join("systemd").join("user"))
    }

    /// systemd 单元文件中的双引号值转义。
    fn quote_unit_value(value: &str) -> String {
        let escaped = value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$");
        format!("\"{escaped}\"")
    }

    async fn systemctl(args: &[&str]) -> napi::Result<()> {
        let mut full = vec!["--user"];
        full.extend_from_slice(args);
        let output = run("systemctl", &full).await?;
        ensure_success(&format!("systemctl --user {}", args.join(" ")), &output)
    }

    pub(super) async fn register(spec: &LaunchSpec) -> napi::Result<()> {
        let dir = unit_dir()?;
        tokio::fs::create_dir_all(&dir).await.map_err(io_error)?;

        let exec = std::iter::once(&spec.program)
            .chain(spec.args.iter())
            .map(|arg| quote_unit_value(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let env: String = spec
            .env
            .iter()
            .map(|(key, value)| {
                format!(
                    "Environment={}\n",
                    quote_unit_value(&format!("{key}={value}"))
                )
            })
            .collect();
        let service = format!(
            "[Unit]\nDescription=Snow App team host service\n\n[Service]\nType=simple\n{env}ExecStart={exec}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n"
        );
        let unit_name = format!("{}.service", spec.label);
        tokio::fs::write(dir.join(&unit_name), service)
            .await
            .map_err(io_error)?;

        systemctl(&["daemon-reload"]).await?;
        systemctl(&["enable", &unit_name]).await?;
        systemctl(&["restart", &unit_name]).await
    }

    pub(super) async fn clear(label: &str) -> napi::Result<()> {
        let unit_name = format!("{label}.service");
        let _ = run("systemctl", &["--user", "disable", "--now", &unit_name]).await;
        let dir = unit_dir()?;
        if remove_if_exists(&dir.join(&unit_name)).await? {
            let _ = run("systemctl", &["--user", "daemon-reload"]).await;
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::LaunchSpec;

    pub(super) async fn register(_spec: &LaunchSpec) -> napi::Result<()> {
        Err(napi::Error::from_reason(
            "Team host service is not supported on this platform",
        ))
    }

    pub(super) async fn clear(_label: &str) -> napi::Result<()> {
        Ok(())
    }
}
