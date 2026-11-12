//! 定时任务「关闭后仍执行」：把最近一次需要拉起应用的时间注册到系统调度
//! （macOS launchd / Windows 任务计划程序 / Linux systemd 用户定时器）。
//! 全程异步（tokio fs + process），不阻塞 Node 事件循环。

use std::collections::HashMap;
use std::process::{Output, Stdio};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Local, TimeDelta};
use napi_derive::napi;

/// 提前拉起应用的秒数，留出启动与恢复调度的时间。
const LAUNCH_LEAD_SECS: i64 = 60;
/// 注册时间至少晚于当前的秒数，避免落到已过去的时刻。
const MIN_AHEAD_SECS: i64 = 60;
/// 单条系统命令的超时。
const COMMAND_TIMEOUT: StdDuration = StdDuration::from_secs(20);

#[napi(object)]
pub struct ScheduledWakeOptions {
    /// 下次任务时间（RFC 3339）；为空表示清除注册。
    pub at: Option<String>,
    /// 注册标识：launchd label / 任务名后缀 / systemd 单元名。
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    /// 额外环境变量（Linux 图形会话变量等）。
    pub env: Option<HashMap<String, String>>,
}

#[napi(object)]
pub struct ScheduledWakeResult {
    pub registered: bool,
    /// 实际注册的拉起时间（RFC 3339，本地时区）。
    pub launch_at: Option<String>,
}

#[allow(dead_code)]
struct LaunchSpec {
    label: String,
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

/// 同步系统级唤醒注册：at 为空时清除，否则覆盖为新的拉起时间。
#[napi]
pub async fn sync_scheduled_wake(
    options: ScheduledWakeOptions,
) -> napi::Result<ScheduledWakeResult> {
    let label = sanitize_label(&options.label)?;
    let at = options
        .at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let Some(at) = at else {
        platform::clear(&label).await?;
        return Ok(ScheduledWakeResult {
            registered: false,
            launch_at: None,
        });
    };

    let program = options.program.trim().to_string();
    if program.is_empty() {
        return Err(napi::Error::from_reason("Wake program is required"));
    }

    let target = DateTime::parse_from_rfc3339(at)
        .map_err(|error| napi::Error::from_reason(format!("Invalid wake time \"{at}\": {error}")))?
        .with_timezone(&Local);
    let now = Local::now();
    let launch = (target - TimeDelta::seconds(LAUNCH_LEAD_SECS))
        .max(now + TimeDelta::seconds(MIN_AHEAD_SECS));

    let mut env: Vec<(String, String)> = options.env.unwrap_or_default().into_iter().collect();
    env.sort();
    let spec = LaunchSpec {
        label,
        program,
        args: options.args,
        env,
    };
    platform::register(&spec, launch).await?;

    Ok(ScheduledWakeResult {
        registered: true,
        launch_at: Some(launch.to_rfc3339()),
    })
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
            "Invalid wake label \"{label}\""
        )))
    }
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
fn io_error(error: std::io::Error) -> napi::Error {
    napi::Error::from_reason(format!("Wake registration I/O error: {error}"))
}

#[allow(dead_code)]
async fn remove_if_exists(path: &std::path::Path) -> napi::Result<bool> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

#[allow(dead_code)]
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

    use chrono::{DateTime, Datelike, Local, Timelike};

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

    pub(super) async fn register(spec: &LaunchSpec, launch: DateTime<Local>) -> napi::Result<()> {
        let path = plist_path(&spec.label)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
        }
        tokio::fs::write(&path, build_plist(spec, launch))
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

    fn build_plist(spec: &LaunchSpec, launch: DateTime<Local>) -> String {
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
{env}  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key>
    <integer>{month}</integer>
    <key>Day</key>
    <integer>{day}</integer>
    <key>Hour</key>
    <integer>{hour}</integer>
    <key>Minute</key>
    <integer>{minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
"#,
            label = xml_escape(&spec.label),
            month = launch.month(),
            day = launch.day(),
            hour = launch.hour(),
            minute = launch.minute(),
        )
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use chrono::{DateTime, Local};

    use super::{ensure_success, io_error, run, xml_escape, LaunchSpec};

    fn task_name(label: &str) -> String {
        format!("SnowApp\\{label}")
    }

    /// 按 Windows 命令行规则给参数加引号。
    fn quote_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.contains(|ch: char| matches!(ch, ' ' | '\t' | '"')) {
            return arg.to_string();
        }
        format!("\"{}\"", arg.replace('"', "\\\""))
    }

    pub(super) async fn register(spec: &LaunchSpec, launch: DateTime<Local>) -> napi::Result<()> {
        let xml = build_task_xml(spec, launch);
        // schtasks /XML 要求 UTF-16 LE（带 BOM）
        let mut bytes = vec![0xFF, 0xFE];
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = std::env::temp_dir().join(format!(
            "{}-{}.xml",
            spec.label,
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&path, bytes).await.map_err(io_error)?;
        let path_str = path.to_string_lossy().to_string();
        let name = task_name(&spec.label);
        let result = run(
            "schtasks",
            &["/Create", "/TN", &name, "/XML", &path_str, "/F"],
        )
        .await;
        let _ = tokio::fs::remove_file(&path).await;
        ensure_success("schtasks /Create", &result?)
    }

    pub(super) async fn clear(label: &str) -> napi::Result<()> {
        // 任务不存在时 schtasks 返回非零，忽略即可
        let name = task_name(label);
        let _ = run("schtasks", &["/Delete", "/TN", &name, "/F"]).await;
        Ok(())
    }

    fn build_task_xml(spec: &LaunchSpec, launch: DateTime<Local>) -> String {
        let arguments = spec
            .args
            .iter()
            .map(|arg| quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let user_id = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(domain), Ok(user)) if !domain.is_empty() && !user.is_empty() => {
                format!("      <UserId>{}</UserId>\n", xml_escape(&format!("{domain}\\{user}")))
            }
            (_, Ok(user)) if !user.is_empty() => {
                format!("      <UserId>{}</UserId>\n", xml_escape(&user))
            }
            _ => String::new(),
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Snow App scheduled task wake-up</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>{start}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
{user_id}      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
            start = launch.format("%Y-%m-%dT%H:%M:%S"),
            command = xml_escape(&spec.program),
            arguments = xml_escape(&arguments),
        )
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::PathBuf;

    use chrono::{DateTime, Local};

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

    pub(super) async fn register(spec: &LaunchSpec, launch: DateTime<Local>) -> napi::Result<()> {
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
            .map(|(key, value)| format!("Environment={}\n", quote_unit_value(&format!("{key}={value}"))))
            .collect();
        let service = format!(
            "[Unit]\nDescription=Snow App scheduled task wake-up\n\n[Service]\nType=exec\n{env}ExecStart={exec}\n"
        );
        let timer = format!(
            "[Unit]\nDescription=Snow App scheduled task wake-up timer\n\n[Timer]\nOnCalendar={calendar}\nPersistent=true\nAccuracySec=1s\nUnit={label}.service\n\n[Install]\nWantedBy=timers.target\n",
            calendar = launch.format("%Y-%m-%d %H:%M:%S"),
            label = spec.label,
        );
        tokio::fs::write(dir.join(format!("{}.service", spec.label)), service)
            .await
            .map_err(io_error)?;
        tokio::fs::write(dir.join(format!("{}.timer", spec.label)), timer)
            .await
            .map_err(io_error)?;

        let timer_unit = format!("{}.timer", spec.label);
        systemctl(&["daemon-reload"]).await?;
        systemctl(&["enable", &timer_unit]).await?;
        systemctl(&["restart", &timer_unit]).await
    }

    pub(super) async fn clear(label: &str) -> napi::Result<()> {
        let timer_unit = format!("{label}.timer");
        let _ = run("systemctl", &["--user", "disable", "--now", &timer_unit]).await;
        let dir = unit_dir()?;
        let removed_timer = remove_if_exists(&dir.join(&timer_unit)).await?;
        let removed_service = remove_if_exists(&dir.join(format!("{label}.service"))).await?;
        if removed_timer || removed_service {
            let _ = run("systemctl", &["--user", "daemon-reload"]).await;
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use chrono::{DateTime, Local};

    use super::LaunchSpec;

    pub(super) async fn register(_spec: &LaunchSpec, _launch: DateTime<Local>) -> napi::Result<()> {
        Err(napi::Error::from_reason(
            "Scheduled wake is not supported on this platform",
        ))
    }

    pub(super) async fn clear(_label: &str) -> napi::Result<()> {
        Ok(())
    }
}
