/// SSH 远程路径归一化与工作区归属判断（与具体工具无关的通用工具）。

/// 把 `ssh://authority/path` 归一化为 (authority, segments)。
/// 非 ssh 路径或无法解析时返回 None。
pub fn normalize_ssh_path(path: &str) -> Option<(String, Vec<String>)> {
    let normalized = path.trim().replace('\\', "/");
    let remainder = normalized.strip_prefix("ssh://")?;
    let (authority, raw_path) = remainder.split_once('/').unwrap_or((remainder, ""));
    if authority.is_empty() {
        return None;
    }

    let mut segments = Vec::new();
    for segment in raw_path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            value => segments.push(value.to_string()),
        }
    }

    Some((authority.to_string(), segments))
}

/// candidate 是否位于 root 之内（含相等）。
pub fn remote_segments_start_with(candidate: &[String], root: &[String]) -> bool {
    candidate.len() >= root.len()
        && root
            .iter()
            .zip(candidate.iter())
            .all(|(root_segment, candidate_segment)| root_segment == candidate_segment)
}
