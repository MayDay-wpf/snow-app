use std::fs;

use napi::bindgen_prelude::*;

/// 判断命令是否是 WSL 命令（首 token 为 `wsl` / `wsl.exe`）。detach 场景下
/// taskkill /PID 只能杀掉 wsl.exe 壳进程，WSL 实例内的 Linux 进程需要
/// 通过 pkill / wsl --terminate 停止，hint 提示据此区分。
pub(crate) fn is_wsl_command(command: &str) -> bool {
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
pub(crate) fn create_detach_log_path(
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
