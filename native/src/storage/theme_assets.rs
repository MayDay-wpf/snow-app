use std::fs;

use napi::bindgen_prelude::*;

use super::ensure_storage_dir;
use super::paths;

/// 将用户选择的背景图文件复制到 ~/.snowapp/backgrounds/ 目录下，
/// 返回复制后的目标文件绝对路径。文件名使用时间戳 + 原始扩展名，
/// 避免覆盖已有文件。所有文件 I/O 均在调用方的 spawn_blocking 中执行。
pub fn save_theme_background_image(source_path: String) -> Result<String> {
    let trimmed_source = source_path.trim();
    if trimmed_source.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Background image source path is required".to_string(),
        ));
    }

    let source = std::path::Path::new(trimmed_source);
    if !source.exists() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Background image source file does not exist: {trimmed_source}"),
        ));
    }

    let storage_dir = ensure_storage_dir()?;
    let backgrounds_dir = storage_dir.join("backgrounds");
    fs::create_dir_all(&backgrounds_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create backgrounds directory at '{}': {error}",
            backgrounds_dir.display()
        ))
    })?;

    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .filter(|ext| {
            matches!(
                ext.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
            )
        })
        .unwrap_or_else(|| "png".to_string());

    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let random_suffix = uuid::Uuid::new_v4().simple().to_string();
    let dest_file_name = format!("bg-{timestamp}-{random_suffix}.{extension}");
    let dest_path = backgrounds_dir.join(&dest_file_name);

    fs::copy(source, &dest_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to copy background image to '{}': {error}",
            dest_path.display()
        ))
    })?;

    Ok(dest_path.to_string_lossy().into_owned())
}

/// 删除指定的背景图文件。传入空字符串时静默返回 Ok。
pub fn delete_theme_background_image(image_path: String) -> Result<()> {
    let trimmed = image_path.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let path = std::path::Path::new(trimmed);
    if !path.exists() {
        return Ok(());
    }

    // 安全检查：只允许删除 ~/.snowapp/backgrounds/ 目录下的文件，
    // 防止误删用户其他位置的文件。
    let storage_dir = paths::app_storage_dir()?;
    let backgrounds_dir = storage_dir.join("backgrounds");
    let canonical_backgrounds = backgrounds_dir.canonicalize().map_err(|error| {
        Error::from_reason(format!("Failed to resolve backgrounds directory: {error}"))
    })?;
    let canonical_target = path.canonicalize().map_err(|error| {
        Error::from_reason(format!("Failed to resolve target image path: {error}"))
    })?;

    if !canonical_target.starts_with(&canonical_backgrounds) {
        return Err(Error::new(
            Status::GenericFailure,
            "Refused to delete a file outside the backgrounds directory".to_string(),
        ));
    }

    fs::remove_file(&canonical_target).map_err(|error| {
        Error::from_reason(format!("Failed to delete background image: {error}"))
    })?;

    Ok(())
}

/// 将用户选择的 SVG 文件复制到 ~/.snowapp/stream-cursors/ 目录下，
/// 返回复制后的目标文件绝对路径。所有文件 I/O 均在调用方的 spawn_blocking 中执行。
pub fn save_theme_stream_cursor_svg(source_path: String) -> Result<String> {
    let trimmed_source = source_path.trim();
    if trimmed_source.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Stream cursor SVG source path is required".to_string(),
        ));
    }

    let source = std::path::Path::new(trimmed_source);
    if !source.exists() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Stream cursor SVG source file does not exist: {trimmed_source}"),
        ));
    }

    let storage_dir = ensure_storage_dir()?;
    let cursors_dir = storage_dir.join("stream-cursors");
    fs::create_dir_all(&cursors_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create stream-cursors directory at '{}': {error}",
            cursors_dir.display()
        ))
    })?;

    // 仅允许 .svg 扩展名，拒绝其他文件类型。
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .filter(|ext| ext == "svg")
        .unwrap_or_else(|| "svg".to_string());

    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let random_suffix = uuid::Uuid::new_v4().simple().to_string();
    let dest_file_name = format!("cursor-{timestamp}-{random_suffix}.{extension}");
    let dest_path = cursors_dir.join(&dest_file_name);

    fs::copy(source, &dest_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to copy stream cursor SVG to '{}': {error}",
            dest_path.display()
        ))
    })?;

    Ok(dest_path.to_string_lossy().into_owned())
}

/// 删除指定的流式光标 SVG 文件。传入空字符串时静默返回 Ok。
pub fn delete_theme_stream_cursor_svg(svg_path: String) -> Result<()> {
    let trimmed = svg_path.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let path = std::path::Path::new(trimmed);
    if !path.exists() {
        return Ok(());
    }

    // 安全检查：只允许删除 ~/.snowapp/stream-cursors/ 目录下的文件。
    let storage_dir = paths::app_storage_dir()?;
    let cursors_dir = storage_dir.join("stream-cursors");
    let canonical_cursors = cursors_dir.canonicalize().map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve stream-cursors directory: {error}"
        ))
    })?;
    let canonical_target = path.canonicalize().map_err(|error| {
        Error::from_reason(format!("Failed to resolve target SVG path: {error}"))
    })?;

    if !canonical_target.starts_with(&canonical_cursors) {
        return Err(Error::new(
            Status::GenericFailure,
            "Refused to delete a file outside the stream-cursors directory".to_string(),
        ));
    }

    fs::remove_file(&canonical_target).map_err(|error| {
        Error::from_reason(format!("Failed to delete stream cursor SVG: {error}"))
    })?;

    Ok(())
}
