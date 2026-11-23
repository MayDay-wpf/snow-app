//! 配置导出的建议文件名：单个用名称，多个用「首个名称等N个.json」。

/// 生成导出文件名（含 .json 后缀）。
pub(crate) fn build_export_file_name(first_label: &str, count: usize, fallback: &str) -> String {
    let label = if first_label.trim().is_empty() {
        sanitize(fallback)
    } else {
        sanitize(first_label)
    };
    if count <= 1 {
        format!("{label}.json")
    } else {
        format!("{label}等{count}个.json")
    }
}

/// 去掉文件系统非法字符并限制长度。
fn sanitize(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|value| match value {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            value if value.is_control() => '-',
            value => value,
        })
        .collect();
    let truncated: String = cleaned.trim().chars().take(60).collect();
    let trimmed = truncated.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "snow-config".to_string()
    } else {
        trimmed.to_string()
    }
}
