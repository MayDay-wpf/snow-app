//! 平台权限预检与提示。
//!
//! macOS 上鼠标键盘模拟需要「辅助功能」授权、屏幕截图需要「屏幕录制」
//! 授权；未授权时 enigo/xcap 只会静默失败或返回黑屏，模型难以自查。
//! 在执行前主动预检并以明确错误信息指引用户到系统设置授权。

#[cfg(target_os = "macos")]
mod macos_permissions {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// 辅助功能权限（控制鼠标键盘的前提）。
    pub fn accessibility_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// 屏幕录制权限（截屏的前提）；只预检不弹窗。
    pub fn screen_capture_preflight() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// 触发系统屏幕录制授权弹窗（异步，不阻塞）。
    pub fn request_screen_capture() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }
}

/// 辅助功能（鼠标键盘控制）权限是否已授予。
#[cfg(target_os = "macos")]
pub fn has_input_permission() -> bool {
    macos_permissions::accessibility_trusted()
}

/// 屏幕捕获权限是否已授予。
#[cfg(target_os = "macos")]
pub fn has_screen_capture_permission() -> bool {
    macos_permissions::screen_capture_preflight()
}

/// 触发屏幕捕获授权弹窗（未授权时调用，帮助用户完成授权）。
#[cfg(target_os = "macos")]
pub fn request_screen_capture_permission() {
    macos_permissions::request_screen_capture();
}

#[cfg(not(target_os = "macos"))]
pub fn has_input_permission() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn has_screen_capture_permission() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture_permission() {}

/// 辅助功能权限缺失时的指引文案（模型可转述给用户）。
pub fn input_permission_hint() -> String {
    #[cfg(target_os = "macos")]
    {
        "macOS Accessibility permission is missing: open System Settings -> Privacy & Security -> Accessibility, add and enable Snow App, then retry. Without it all mouse/keyboard tools will silently fail.".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!(
            "Input simulation failed on {}: on Linux make sure an X11 session (DISPLAY env var) is available; Wayland input automation is not supported.",
            std::env::consts::OS,
        )
    }
}

/// 屏幕录制权限缺失时的指引文案。
pub fn screen_capture_permission_hint() -> String {
    #[cfg(target_os = "macos")]
    {
        "macOS Screen Recording permission is missing: open System Settings -> Privacy & Security -> Screen Recording, add and enable Snow App, then restart the app and retry. A capture request dialog has been triggered if not already granted.".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!(
            "Screen capture failed on {}: on Linux make sure an X11 session (DISPLAY env var) is available.",
            std::env::consts::OS,
        )
    }
}

/// 当前平台说明（截屏/输入能力边界），附加在 screen-info 结果中。
pub fn platform_notes() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS: input control requires Accessibility permission; screenshots require Screen Recording permission (both granted to Snow App in System Settings -> Privacy & Security). Coordinates are in logical points (Retina displays report scaleFactor > 1).",
        "windows" => "Windows: no extra permission needed. Coordinates are in pixels of the per-monitor DPI-aware desktop.",
        "linux" => "Linux: X11 session required (Wayland screen capture/input automation is not supported). Coordinates are in pixels of the X11 virtual desktop.",
        _ => "",
    }
}
