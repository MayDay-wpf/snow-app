//! 前台窗口探测（xcap::Window 封装）。
//!
//! 键鼠事件「派发成功」不等于「目标收到了」：点击坐标可能落在已关闭的窗口、
//! 被系统抢走焦点的窗口，或根本没有窗口的桌面上。这里提供两个轻量探测
//! （各自枚举一次窗口列表）：
//!
//! - [`focused_window`]：当前前台窗口（Windows 用 GetForegroundWindow、
//!   macOS 用活动应用、X11 用 _NET_ACTIVE_WINDOW，语义由 xcap 统一）；
//! - [`window_at_point`]：覆盖指定全局坐标的最上层窗口（xcap 返回的窗口
//!   列表按 z 序，最上层在前）。
//!
//! 探测失败（无桌面会话、缺少权限、平台不支持）一律返回 None，调用方据此
//! 判定为「无法确认」，绝不猜成 true。

use serde_json::{json, Value};
use xcap::Window;

/// 窗口快照；坐标与键鼠工具一致（全局虚拟桌面坐标系）。
pub struct WindowInfo {
    pub app: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl WindowInfo {
    /// 目标点是否落在窗口矩形内（左闭右开，与窗口命中测试一致）。
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    /// 进入工具结果 / 错误快照的精简表示。
    pub fn to_json(&self) -> Value {
        json!({
            "app": self.app,
            "title": self.title,
            "bounds": {
                "x": self.x,
                "y": self.y,
                "width": self.width,
                "height": self.height,
            },
        })
    }
}

fn covers_point(window: &Window, x: i32, y: i32) -> bool {
    match (window.x(), window.y(), window.width(), window.height()) {
        (Ok(window_x), Ok(window_y), Ok(width), Ok(height)) => {
            x >= window_x
                && x < window_x + width as i32
                && y >= window_y
                && y < window_y + height as i32
        }
        _ => false,
    }
}

/// 由 xcap 窗口构造快照；位置/尺寸读不到时返回 None（宁可判「无法确认」）。
/// 标题在缺少屏幕录制权限的 macOS 上可能为空，不影响落点判定，故不视为失败。
fn to_info(window: &Window) -> Option<WindowInfo> {
    Some(WindowInfo {
        app: window.app_name().unwrap_or_default(),
        title: window.title().unwrap_or_default(),
        x: window.x().ok()?,
        y: window.y().ok()?,
        width: window.width().ok()? as i32,
        height: window.height().ok()? as i32,
    })
}

/// 当前前台（焦点）窗口；无法枚举时为 None。
pub fn focused_window() -> Option<WindowInfo> {
    Window::all()
        .ok()?
        .iter()
        .find(|window| window.is_focused().unwrap_or(false))
        .and_then(to_info)
}

/// 覆盖目标点的最上层窗口；无法枚举或该点没有任何窗口时为 None。
pub fn window_at_point(x: i32, y: i32) -> Option<WindowInfo> {
    Window::all()
        .ok()?
        .iter()
        .find(|window| covers_point(window, x, y))
        .and_then(to_info)
}
