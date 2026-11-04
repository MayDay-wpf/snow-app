use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;

use super::status::parse_porcelain_z;
use super::{run_git, GitStageResult};

fn ok(message: &str) -> Result<GitStageResult> {
    Ok(GitStageResult {
        success: true,
        message: message.to_string(),
    })
}

// 只带回 git 原文（Display 会多出 "GenericFailure, " 前缀）。
fn failed(e: Error) -> Result<GitStageResult> {
    Ok(GitStageResult {
        success: false,
        message: e.reason.clone(),
    })
}

/// 解析 git 输出受 `core.quotePath` 影响加的 C 风格双引号与转义。
pub fn unquote_c_style(s: &str) -> String {
    let trimmed = s.trim_matches(|c: char| c == '\r' || c == '\n');
    if !trimmed.starts_with('"') || !trimmed.ends_with('"') || trimmed.len() < 2 {
        return trimmed.to_string();
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut bytes = Vec::with_capacity(inner.len());
    let mut chars = inner.bytes().peekable();

    while let Some(b) = chars.next() {
        if b == b'\\' {
            match chars.next() {
                Some(b'\\') => bytes.push(b'\\'),
                Some(b'"') => bytes.push(b'"'),
                Some(b'n') => bytes.push(b'\n'),
                Some(b't') => bytes.push(b'\t'),
                Some(b'r') => bytes.push(b'\r'),
                Some(b'b') => bytes.push(0x08),
                Some(b'f') => bytes.push(0x0C),
                Some(b'v') => bytes.push(0x0B),
                Some(b'a') => bytes.push(0x07),
                Some(c @ b'0'..=b'7') => {
                    let mut val = (c - b'0') as u32;
                    let mut count = 1;
                    while count < 3 {
                        if let Some(&next_c @ b'0'..=b'7') = chars.peek() {
                            chars.next();
                            val = val * 8 + (next_c - b'0') as u32;
                            count += 1;
                        } else {
                            break;
                        }
                    }
                    bytes.push(val as u8);
                }
                Some(other) => {
                    bytes.push(b'\\');
                    bytes.push(other);
                }
                None => bytes.push(b'\\'),
            }
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes.clone())
        .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(windows)]
fn is_reserved_name(stem: &str) -> bool {
    let s = stem.to_ascii_uppercase();
    matches!(
        s.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

#[cfg(windows)]
fn is_win32_special_segment(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    // 尾随空格或尾随点
    if segment.ends_with(' ') || segment.ends_with('.') {
        return true;
    }
    // 保留设备名（裸名与带扩展名形式，如 CON, CON.txt, aux.json）
    let stem = match segment.find('.') {
        Some(idx) => &segment[..idx],
        None => segment,
    };
    is_reserved_name(stem)
}

/// 判断路径是否命中 Windows 保留设备名、尾随空格或尾随点等 Win32 特殊路径。
/// 仅 Windows 平台生效；非 Windows 平台恒为 false。
pub fn is_win32_special_path(path: &str) -> bool {
    #[cfg(windows)]
    {
        for segment in path.split(['/', '\\']) {
            if is_win32_special_segment(segment) {
                return true;
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

#[cfg(windows)]
fn to_win32_verbatim_path(repo_path: &str, rel_path: &str) -> String {
    let repo_clean = repo_path
        .trim_matches(|c: char| c == ' ' || c == '\r' || c == '\n')
        .replace('/', "\\");
    let rel_clean = rel_path
        .trim_matches(|c: char| c == '\r' || c == '\n')
        .replace('/', "\\");
    let full = format!(
        "{}\\{}",
        repo_clean.trim_end_matches('\\'),
        rel_clean.trim_start_matches('\\')
    );
    if full.starts_with(r"\\?\") {
        full
    } else if full.starts_with(r"\\") {
        format!(r"\\?\UNC\{}", &full[2..])
    } else {
        format!(r"\\?\{}", full)
    }
}

#[cfg(windows)]
fn remove_win32_special_file(verbatim_path: &str) -> std::io::Result<()> {
    let path = Path::new(verbatim_path);
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };

    if meta.permissions().readonly() {
        let mut perms = meta.permissions();
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(path, perms);
    }

    let direct_res = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };

    if direct_res.is_ok() {
        return Ok(());
    }

    let first_err = direct_res.unwrap_err();
    // 降级方案：先重命名为安全临时名，再删除
    let parent = path.parent().unwrap_or(path);
    let temp_name = format!(
        "{}\\snow_del_{}_{}",
        parent.display(),
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    );
    let temp_path = Path::new(&temp_name);
    if std::fs::rename(path, temp_path).is_ok() {
        let remove_res = if meta.is_dir() {
            std::fs::remove_dir_all(temp_path)
        } else {
            std::fs::remove_file(temp_path)
        };
        if remove_res.is_ok() {
            return Ok(());
        }
    }

    Err(first_err)
}

pub fn stage_files(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return ok("No files to stage");
    }

    let mut args = vec!["add", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));

    match run_git(repo_path, &args) {
        Ok(_) => ok("Files staged successfully"),
        Err(e) => failed(e),
    }
}

pub fn unstage_files(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return ok("No files to unstage");
    }

    let mut args = vec!["reset", "HEAD", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));

    match run_git(repo_path, &args) {
        Ok(_) => ok("Files unstaged successfully"),
        Err(e) => failed(e),
    }
}

pub fn stage_all(repo_path: &str) -> Result<GitStageResult> {
    match run_git(repo_path, &["add", "--all"]) {
        Ok(_) => ok("All changes staged"),
        Err(e) => failed(e),
    }
}

pub fn unstage_all(repo_path: &str) -> Result<GitStageResult> {
    match run_git(repo_path, &["reset", "HEAD"]) {
        Ok(_) => ok("All changes unstaged"),
        Err(e) => failed(e),
    }
}

pub fn discard_changes(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return ok("No files to discard");
    }

    // 解析潜在受 core.quotePath 影响的双引号与 C 风格转义
    let unquoted_paths: Vec<String> = file_paths.iter().map(|s| unquote_c_style(s)).collect();

    let mut normal_paths: Vec<String> = Vec::new();
    let mut special_paths: Vec<String> = Vec::new();

    for p in unquoted_paths {
        if is_win32_special_path(&p) {
            special_paths.push(p);
        } else {
            normal_paths.push(p);
        }
    }

    let status_output = match run_git(repo_path, &["status", "--porcelain=v1", "-z", "-uall"]) {
        Ok(s) => s,
        Err(e) => return failed(e),
    };
    let (_, entries) = parse_porcelain_z(&status_output);

    // 1. 处理普通路径（沿用原有分支逻辑不变）
    if !normal_paths.is_empty() {
        let normal_set: HashSet<String> = normal_paths.iter().map(|p| p.replace('\\', "/")).collect();
        let mut untracked: Vec<&str> = Vec::new();
        let mut tracked: Vec<&str> = Vec::new();

        for entry in &entries {
            let normalized_entry = entry.path.replace('\\', "/");
            if !normal_set.contains(&normalized_entry) {
                continue;
            }
            if entry.index == '?' {
                untracked.push(entry.path);
            } else {
                tracked.push(entry.path);
            }
        }

        // 状态里找不到的普通路径按已跟踪处理，由 checkout 自行报错。
        for p in &normal_paths {
            let norm = p.replace('\\', "/");
            if !untracked.iter().any(|u| u.replace('\\', "/") == norm)
                && !tracked.iter().any(|t| t.replace('\\', "/") == norm)
            {
                tracked.push(p.as_str());
            }
        }

        if !tracked.is_empty() {
            let mut args = vec!["checkout", "--"];
            args.extend(tracked.iter().copied());
            if let Err(e) = run_git(repo_path, &args) {
                return failed(e);
            }
        }

        if !untracked.is_empty() {
            let mut args = vec!["clean", "-f", "--"];
            args.extend(untracked.iter().copied());
            let output = match run_git(repo_path, &args) {
                Ok(out) => out,
                Err(e) => return failed(e),
            };

            // clean 对目录 / 嵌套仓库会静默跳过，按磁盘实际残留判定。
            let root = Path::new(repo_path);
            let remaining: Vec<&str> = untracked
                .iter()
                .copied()
                .filter(|p| root.join(p).symlink_metadata().is_ok())
                .collect();
            if !remaining.is_empty() {
                let mut message = format!("git clean did not remove: {}", remaining.join(", "));
                let output = output.trim();
                if !output.is_empty() {
                    message.push('\n');
                    message.push_str(output);
                }
                return Ok(GitStageResult {
                    success: false,
                    message,
                });
            }
        }
    }

    // 2. 处理 Windows 特殊路径（保留设备名、尾随空格、尾随点）
    if !special_paths.is_empty() {
        for p in &special_paths {
            let norm_p = p.replace('\\', "/");
            let entry_match = entries.iter().find(|e| e.path.replace('\\', "/") == norm_p);

            // 若路径已被索引跟踪，先从索引中移除
            let is_tracked = match entry_match {
                Some(e) => e.index != '?',
                None => true, // 状态列表中未找到时按已跟踪对待
            };

            if is_tracked {
                let update_index_args = [
                    "-c",
                    "core.protectNTFS=false",
                    "update-index",
                    "--force-remove",
                    "--",
                    p.as_str(),
                ];
                if let Err(e) = run_git(repo_path, &update_index_args) {
                    return failed(e);
                }
            }

            // 执行磁盘特殊删除（仅 Windows 平台）
            #[cfg(windows)]
            {
                let verbatim = to_win32_verbatim_path(repo_path, p);
                if let Err(e) = remove_win32_special_file(&verbatim) {
                    return Ok(GitStageResult {
                        success: false,
                        message: format!("Failed to delete special path '{}': {}", p, e),
                    });
                }
                if Path::new(&verbatim).symlink_metadata().is_ok() {
                    return Ok(GitStageResult {
                        success: false,
                        message: format!("Special file '{}' still exists after deletion attempt", p),
                    });
                }
            }
        }
    }

    ok("Changes discarded successfully")
}
