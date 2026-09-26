//! 语言服务器安装探测：扫描 PATH 判断命令是否可执行（无副作用，不启动进程）。
//!
//! 配置表的 enabled 只表示「启用该配置」，不代表服务器已安装——工具调用时
//! 才会 spawn（ENOENT → ServerMissing 降级错误）。探测让设置页/agent 提前
//! 看到真实安装状态（§8.6 安装状态识别）。

use std::path::{Path, PathBuf};

/// 单条探测结果。
#[derive(Clone, Debug)]
pub struct ProbeResult {
    pub command: String,
    pub installed: bool,
    pub path: Option<String>,
}

/// 按 PATHEXT 生成候选可执行文件（Windows）；非 Windows 直接返回原命令。
fn executable_candidates(command: &str) -> Vec<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    #[cfg(windows)]
    {
        // 命令已含路径分隔符：直接探测该路径。
        if trimmed.contains('\\') || trimmed.contains('/') {
            return vec![trimmed.to_string()];
        }
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let mut candidates = vec![trimmed.to_string()];
        for ext in pathext.split(';') {
            let ext = ext.trim();
            if !ext.is_empty() {
                candidates.push(format!("{trimmed}{ext}"));
            }
        }
        // PATHEXT 默认不含 .PS1，但 npm cmd-shim 会生成 .ps1 文件：显式兜底追加
        //（大小写不敏感去重），保证 probe 与 spawn 语义一致（A2）。
        if !candidates
            .iter()
            .any(|c| c.eq_ignore_ascii_case(&format!("{trimmed}.PS1")))
        {
            candidates.push(format!("{trimmed}.PS1"));
        }
        candidates
    }
    #[cfg(not(windows))]
    {
        vec![trimmed.to_string()]
    }
}

/// 检查命令是否真正可用（针对已知版本管理 shim 如 rust-analyzer 进行工具链完整性校验）。
pub fn is_executable_functional(full_path: &Path, command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed == "rust-analyzer"
        || trimmed.ends_with("/rust-analyzer")
        || trimmed.ends_with("\\rust-analyzer.exe")
        || trimmed.ends_with("\\rust-analyzer")
    {
        // 针对 rustup 等 shim 占位但组件实际未安装的情况（例如报错 "Unknown binary 'rust-analyzer'"）
        let Ok(output) = std::process::Command::new(full_path)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
        else {
            return false;
        };

        if !output.status.success() {
            return false;
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Unknown binary") || stderr.contains("is not installed") {
            return false;
        }
    }
    true
}

/// 获取合并了用户常用开发环境目录的 PATH 列表（增强 PATH 探测，提升 GUI 进程环境兼容性）。
pub fn get_augmented_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);

    if let Some(home) = home {
        #[cfg(windows)]
        {
            if let Some(app_data) = std::env::var_os("APPDATA") {
                dirs.push(PathBuf::from(app_data).join("npm"));
            }
            if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                dirs.push(
                    PathBuf::from(&local_app_data)
                        .join("Programs")
                        .join("Python")
                        .join("Launcher"),
                );
                dirs.push(
                    PathBuf::from(&local_app_data)
                        .join("Microsoft")
                        .join("WindowsApps"),
                );
            }
            dirs.push(home.join(".cargo").join("bin"));
            dirs.push(home.join("go").join("bin"));
        }

        #[cfg(not(windows))]
        {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".npm-global").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
            dirs.push(home.join("go").join("bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
        }
    }

    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|d| seen.insert(d.clone()) && d.is_dir())
        .collect()
}

/// 构造增强后的 PATH 环境变量 OsString。
pub fn augmented_path_os_string() -> std::ffi::OsString {
    let dirs = get_augmented_search_dirs();
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// 探测单个命令是否在 PATH 中可执行（含显式路径的情况）。
pub fn is_command_installed(command: &str) -> bool {
    resolve_command(command).is_some()
}

/// 解析命令的可执行路径（增强 PATH 扫描；失败返回 None）。
pub fn resolve_command(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 显式路径（含分隔符）：直接检查文件存在且可用。
    if trimmed.contains('\\') || trimmed.contains('/') {
        let path = Path::new(trimmed);
        return (path.is_file() && is_executable_functional(path, trimmed))
            .then(|| trimmed.to_string());
    }

    let candidates = executable_candidates(trimmed);
    for dir in get_augmented_search_dirs() {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() && is_executable_functional(&full, trimmed) {
                return Some(full.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// 批量探测（去重：同 command 只探测一次）。
pub fn probe_commands(commands: &[String]) -> Vec<ProbeResult> {
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();
    for command in commands {
        let trimmed = command.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        let path = resolve_command(trimmed);
        results.push(ProbeResult {
            command: trimmed.to_string(),
            installed: path.is_some(),
            path,
        });
    }
    results
}
