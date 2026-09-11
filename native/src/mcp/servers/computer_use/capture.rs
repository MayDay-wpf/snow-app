//! 屏幕捕获：xcap 封装。
//!
//! 多显示器支持：显示器列表按「主屏优先、再按位置排序」编号（index 0
//! 恒为主屏），坐标系统一使用全局虚拟桌面坐标（主屏左上角为原点，可
//! 为负值）。截图可选显示器内逻辑坐标区域裁剪；返回时附带
//! pixel-to-screen 换算系数，模型可将图中像素坐标换算回屏幕坐标。
//! 同步实现，仅在 spawn_blocking 上下文调用。

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, ImageFormat, Rgba};
use serde_json::{json, Value};
use xcap::Monitor;

use super::input;
use super::platform;

/// XCapError -> String 统一转换（模块内 Result<T, String> 用）。
fn xerr(error: xcap::XCapError) -> String {
    format!("{error}")
}

/// 截图输出：编码后的图像 + 换算元数据。
pub struct ScreenshotOutput {
    pub mime_type: String,
    pub base64_data: String,
    pub image_width: u32,
    pub image_height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub display_index: usize,
    pub region: Option<(u32, u32, u32, u32)>,
    pub pixel_to_screen_scale: f64,
    pub cursor: Option<CursorPosition>,
}

/// 截图时的光标位置：全局坐标 + 输出图像内的像素坐标（不在图内为 None）。
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
    pub image_x: Option<i64>,
    pub image_y: Option<i64>,
}

/// 光标标记：亮色十字 + 黑色描边，任意背景上都可见。
const CURSOR_MARKER_COLOR: [u8; 4] = [255, 45, 85, 255];
const CURSOR_MARKER_HALO: [u8; 4] = [0, 0, 0, 255];
const CURSOR_MARKER_ARM: i32 = 14;
const CURSOR_MARKER_GAP: i32 = 5;

fn paint_pixel(image: &mut image::RgbaImage, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 || x >= image.width() as i32 || y >= image.height() as i32 {
        return;
    }
    image.put_pixel(x as u32, y as u32, Rgba(color));
}

/// 在光标所在像素画十字标记：系统截图不含鼠标指针，模型看不到光标，
/// 标记提供了带已知全局坐标的视觉锚点（按相对偏移量定位比绝对估算准）。
fn draw_cursor_marker(image: &mut image::RgbaImage, center_x: i64, center_y: i64) {
    let center_x = center_x as i32;
    let center_y = center_y as i32;
    for (color, radius) in [(CURSOR_MARKER_HALO, 2), (CURSOR_MARKER_COLOR, 0)] {
        for offset in -CURSOR_MARKER_ARM..=CURSOR_MARKER_ARM {
            if offset.abs() < CURSOR_MARKER_GAP {
                continue;
            }
            for thickness in -radius..=radius {
                paint_pixel(image, center_x + offset, center_y + thickness, color);
                paint_pixel(image, center_x + thickness, center_y + offset, color);
            }
        }
    }
    for dx in -1..=1 {
        for dy in -1..=1 {
            paint_pixel(image, center_x + dx, center_y + dy, CURSOR_MARKER_HALO);
        }
    }
    paint_pixel(image, center_x, center_y, CURSOR_MARKER_COLOR);
}

/// 读取光标并换算为输出图像内的像素坐标（相对截图区域，不在区域内时为 None）。
fn cursor_position_on_image(
    monitor: &Monitor,
    region: (u32, u32, u32, u32),
    pixel_to_screen_scale: f64,
) -> Option<CursorPosition> {
    let (cursor_x, cursor_y) = input::mouse_location().ok()?;
    let (region_x, region_y, region_width, region_height) = region;
    let relative_x = i64::from(cursor_x) - i64::from(monitor.x().ok()?) - i64::from(region_x);
    let relative_y = i64::from(cursor_y) - i64::from(monitor.y().ok()?) - i64::from(region_y);
    let inside = pixel_to_screen_scale > 0.0
        && relative_x >= 0
        && relative_y >= 0
        && relative_x < i64::from(region_width)
        && relative_y < i64::from(region_height);
    let (image_x, image_y) = if inside {
        (
            Some((relative_x as f64 / pixel_to_screen_scale).round() as i64),
            Some((relative_y as f64 / pixel_to_screen_scale).round() as i64),
        )
    } else {
        (None, None)
    };
    Some(CursorPosition {
        x: cursor_x,
        y: cursor_y,
        image_x,
        image_y,
    })
}

/// 列出显示器（primary 优先，再按 (x, y) 排序，index 即工具 display 参数）。
pub fn list_displays() -> Result<Vec<Value>, String> {
    let monitors = fetch_monitors()?;
    let mut entries: Vec<Value> = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        entries.push(json!({
            "index": index,
            "id": monitor.id().map_err(xerr)?,
            "name": monitor.friendly_name().map_err(xerr)?,
            "x": monitor.x().map_err(xerr)?,
            "y": monitor.y().map_err(xerr)?,
            "width": monitor.width().map_err(xerr)?,
            "height": monitor.height().map_err(xerr)?,
            "scaleFactor": monitor.scale_factor().map_err(xerr)?,
            "primary": monitor.is_primary().map_err(xerr)?,
            "builtin": monitor.is_builtin().unwrap_or(false),
        }));
    }
    Ok(entries)
}

/// 主显示器尺寸（逻辑点，与键鼠工具坐标系一致）。
pub fn primary_display_size() -> Result<(u32, u32), String> {
    let monitors = fetch_monitors()?;
    let monitor = monitors
        .first()
        .ok_or_else(|| "No displays were found".to_string())?;
    Ok((
        monitor.width().map_err(xerr)?,
        monitor.height().map_err(xerr)?,
    ))
}

/// 检查指定坐标是否落在任一显示器边界内（含容差），返回覆盖它的显示器。
pub fn display_containing_point(x: i32, y: i32) -> Result<Option<usize>, String> {
    const EDGE_TOLERANCE: i32 = 2;
    let monitors = fetch_monitors()?;
    for (index, monitor) in monitors.iter().enumerate() {
        let mx = monitor.x().map_err(xerr)?;
        let my = monitor.y().map_err(xerr)?;
        let mw = monitor.width().map_err(xerr)? as i32;
        let mh = monitor.height().map_err(xerr)? as i32;
        if x >= mx - EDGE_TOLERANCE
            && x <= mx + mw + EDGE_TOLERANCE
            && y >= my - EDGE_TOLERANCE
            && y <= my + mh + EDGE_TOLERANCE
        {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

/// 校验目标坐标在虚拟桌面内，越界时报错并列出显示器矩形，帮助模型自纠。
pub fn ensure_point_on_desktop(x: i32, y: i32) -> Result<(), String> {
    if display_containing_point(x, y)?.is_some() {
        return Ok(());
    }
    Err(format!(
        "Coordinate ({x}, {y}) is outside every display. Valid display rectangles: {}",
        display_rectangles_description()?
    ))
}

fn display_rectangles_description() -> Result<String, String> {
    let monitors = fetch_monitors()?;
    let parts: Vec<String> = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            format!(
                "display {} [{},{} {}x{}]",
                index,
                monitor.x().unwrap_or(0),
                monitor.y().unwrap_or(0),
                monitor.width().unwrap_or(0),
                monitor.height().unwrap_or(0)
            )
        })
        .collect();
    Ok(parts.join(", "))
}

fn fetch_monitors() -> Result<Vec<Monitor>, String> {
    Monitor::all()
        .map_err(|error| {
            format!(
                "Failed to enumerate displays: {error}. {}",
                platform::screen_capture_permission_hint()
            )
        })
        .map(|mut monitors| {
            // 主屏优先，再按 (x, y) 排序，保证 index 稳定（0 = 主屏）
            monitors.sort_by(|a, b| {
                let primary_diff = b.is_primary().unwrap_or(false) as i32
                    - a.is_primary().unwrap_or(false) as i32;
                if primary_diff != 0 {
                    return primary_diff.cmp(&0);
                }
                let ax = (a.x().unwrap_or(0), a.y().unwrap_or(0));
                let bx = (b.x().unwrap_or(0), b.y().unwrap_or(0));
                ax.cmp(&bx)
            });
            monitors
        })
}

fn resolve_display(display_index: u32) -> Result<Monitor, String> {
    let monitors = fetch_monitors()?;
    monitors
        .get(display_index as usize)
        .cloned()
        .ok_or_else(|| {
            format!(
                "Display index {display_index} does not exist. Available displays: {}",
                display_rectangles_description().unwrap_or_default()
            )
        })
}

/// 截图并编码。
///
/// * `display_index` — 显示器索引（list_displays 顺序）
/// * `region` — 显示器内**逻辑坐标**区域 (x, y, width, height)；None 全屏
/// * `max_width` — 最终图像最大宽度（等比缩小，默认 1280）
/// * `png` — true 输出 PNG（无损、体积大），false 输出 JPEG（默认）
pub fn capture_screen(
    display_index: u32,
    region: Option<(u32, u32, u32, u32)>,
    max_width: u32,
    png: bool,
) -> Result<ScreenshotOutput, String> {
    // macOS 权限预检：无屏幕录制权限时截图会返回黑屏或失败，
    // 主动触发授权弹窗并返回可行动的错误信息。
    if !platform::has_screen_capture_permission() {
        platform::request_screen_capture_permission();
        return Err(platform::screen_capture_permission_hint());
    }

    let monitor = resolve_display(display_index)?;
    let monitor_width = monitor.width().map_err(xerr)?;
    let monitor_height = monitor.height().map_err(xerr)?;

    // 提前校验区域（xcap 内部也校验，这里给出带屏幕尺寸的清晰错误）
    if let Some((rx, ry, rw, rh)) = region {
        if rw == 0 || rh == 0 {
            return Err("Region width and height must be positive".to_string());
        }
        if rx.saturating_add(rw) > monitor_width || ry.saturating_add(rh) > monitor_height {
            return Err(format!(
                "Region (x={rx}, y={ry}, width={rw}, height={rh}) exceeds display {display_index} bounds ({monitor_width}x{monitor_height}). Region uses display-local LOGICAL coordinates."
            ));
        }
    }

    let (image, region_or_full) = match region {
        Some((rx, ry, rw, rh)) => (
            monitor
                .capture_region(rx, ry, rw, rh)
                .map_err(|error| format!("Failed to capture region: {error}"))?,
            (rx, ry, rw, rh),
        ),
        None => (
            monitor
                .capture_image()
                .map_err(|error| format!("Failed to capture display: {error}"))?,
            (0, 0, monitor_width, monitor_height),
        ),
    };
    let original_width = image.width();
    let original_height = image.height();

    // 等比缩小到 max_width（只缩不放，保持像素密度信息）
    let scale_down = if original_width > max_width {
        f64::from(max_width) / f64::from(original_width)
    } else {
        1.0
    };
    let image_width = (f64::from(original_width) * scale_down).round().max(1.0) as u32;
    let image_height = (f64::from(original_height) * scale_down).round().max(1.0) as u32;

    let dynamic = DynamicImage::ImageRgba8(image);
    let mut resized = if scale_down < 1.0 {
        dynamic.resize_exact(image_width, image_height, FilterType::Lanczos3)
    } else {
        dynamic
    };

    // 图像像素 -> 屏幕逻辑坐标换算系数：
    // screenX = monitor.x + region.x + pixelX * pixel_to_screen_scale
    let pixel_to_screen_scale = f64::from(region_or_full.2) / f64::from(image_width);

    // 系统截图不含鼠标指针：先把光标换算到图内像素，再画十字标记
    let cursor = cursor_position_on_image(&monitor, region_or_full, pixel_to_screen_scale);
    if let (Some(cursor), Some(frame)) = (cursor.as_ref(), resized.as_mut_rgba8()) {
        if let (Some(image_x), Some(image_y)) = (cursor.image_x, cursor.image_y) {
            draw_cursor_marker(frame, image_x, image_y);
        }
    }

    let (mime_type, base64_data) = if png {
        let mut buffer = Vec::new();
        resized
            .write_to(&mut std::io::Cursor::new(&mut buffer), ImageFormat::Png)
            .map_err(|error| format!("Failed to encode PNG: {error}"))?;
        ("image/png", BASE64_STANDARD.encode(buffer))
    } else {
        // JPEG 不支持 alpha：转 RGB 后用可控质量编码
        let rgb = resized.to_rgb8();
        let mut buffer = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 82);
        encoder
            .encode(rgb.as_raw(), image_width, image_height, ExtendedColorType::Rgb8)
            .map_err(|error| format!("Failed to encode JPEG: {error}"))?;
        ("image/jpeg", BASE64_STANDARD.encode(buffer))
    };

    Ok(ScreenshotOutput {
        mime_type: mime_type.to_string(),
        base64_data,
        image_width,
        image_height,
        original_width,
        original_height,
        display_index: display_index as usize,
        region: region.map(|(rx, ry, rw, rh)| (rx, ry, rw, rh)),
        pixel_to_screen_scale,
        cursor,
    })
}
