//! 路径解析辅助（内置工具共用）。

/// 展开开头的 `~`（`~/x`、`~\x`、单独的 `~`）为用户主目录。
///
/// 内置文档、技能与提示词普遍以 `~/.snowapp/...` 记录路径；工具层若不展开，
/// 这类路径会被当成相对路径落到工作目录下，运行期报「找不到指定路径」。
/// 非 `~` 开头的路径原样返回，无法解析主目录时也不改动输入。
pub fn expand_home_dir(path: &str) -> String {
    let rest = if path == "~" {
        ""
    } else if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        rest
    } else {
        return path.to_string();
    };

    let Some(home) = dirs_next::home_dir() else {
        return path.to_string();
    };
    let home = home.to_string_lossy();
    let home = home.trim_end_matches(|character| character == '/' || character == '\\');
    if rest.is_empty() {
        return home.to_string();
    }
    format!("{home}/{rest}")
}
