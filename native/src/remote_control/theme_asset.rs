//! 流式光标资源：手机端跟随桌面主题时按文件名读取 ~/.snowapp/stream-cursors/。
//!
//! 与桌面 theme-bg:// 协议读的是同一批文件（自定义 SVG / 图片 / canvas 脚本）。
//! 请求只接受单个文件名，路径分隔符、`.`、`..` 一律拒绝，避免越界读取。

use std::path::{Component, Path, PathBuf};

/// 资源路由前缀（`/api/theme-asset/<file-name>`）。
pub const THEME_ASSET_PATH_PREFIX: &str = "/api/theme-asset/";

/// 单个资源大小上限（与消息图片一致，10 MB）。
const MAX_THEME_ASSET_BYTES: u64 = 10 * 1024 * 1024;

const ASSET_CONTENT_TYPES: [(&str, &str); 8] = [
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("js", "text/javascript; charset=utf-8"),
];

/// 读取 stream-cursors 目录内的一个资源；文件名非法、类型未知或文件缺失时返回 None。
pub async fn read_theme_asset(file_name: &str) -> Option<(Vec<u8>, &'static str)> {
    let relative = single_file_name(file_name)?;
    let content_type = content_type_for(relative.extension()?)?;
    let directory = crate::storage::paths::app_storage_dir().ok()?;
    let path = directory.join("stream-cursors").join(relative);
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_THEME_ASSET_BYTES {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    Some((bytes, content_type))
}

/// 只接受单个普通文件名：多级路径、绝对路径、`.` / `..` 全部拒绝。
fn single_file_name(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return None;
    }
    let mut components = Path::new(trimmed).components();
    let Component::Normal(part) = components.next()? else {
        return None;
    };
    if components.next().is_some() {
        return None;
    }
    Some(PathBuf::from(part))
}

fn content_type_for(extension: &std::ffi::OsStr) -> Option<&'static str> {
    let normalized = extension.to_string_lossy().to_ascii_lowercase();
    ASSET_CONTENT_TYPES
        .iter()
        .find(|(suffix, _)| *suffix == normalized)
        .map(|(_, value)| *value)
}
