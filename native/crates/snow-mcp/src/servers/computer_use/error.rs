//! computer-use 错误分类、可行动指引与环境快照。
//!
//! computer-use 是唯一直接操作用户真实桌面的内置服务，它的失败大多来自
//! 外部环境：窗口被关掉、焦点被系统抢走、目标应用权限不足、桌面会话断开。
//! enigo / xcap 的原始报错（平台错误码、英文短语）对模型没有指导意义，
//! 只会诱发「原样重试同一个动作」。因此本模块统一收口所有对外错误：
//!
//! 1. 归类到有限枚举（`code`），每类配一句「下一步做什么」（`NEXT`）；
//! 2. 附带一行结构化环境快照（`CONTEXT`：显示器、光标、权限、前台窗口），
//!    模型无需再补一次 screen-info 就能判断方向。
//!
//! 参数/用法错误（坐标越界、region 非法、互斥参数）不走分类：模型自己
//! 就能从报错改对，附环境快照只会浪费上下文。

use napi::{Error, Status};
use serde_json::{json, Value};

use super::capture;
use super::input;
use super::platform;
use super::window;

/// 有限错误分类。模型据此判断「是权限问题还是窗口没了」。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ErrorKind {
    /// 辅助功能 / 屏幕录制缺失，EACCES/EPERM，Windows UIPI 拒绝访问。
    PermissionDenied,
    /// 目标窗口关闭、重建、句柄失效。
    WindowUnavailable,
    /// 锁屏、Session 0、断开的远程桌面、无 X11 DISPLAY。
    DesktopUnavailable,
    /// 焦点未落到目标窗口（动作已派发但目标没收到）。
    ActivationBlocked,
    /// 截图为空、全黑、编码失败。
    CaptureFailed,
    /// 操作超时。
    Timeout,
    /// 其他底层驱动错误（保留原始信息）。
    DriverError,
}

impl ErrorKind {
    /// 稳定错误码：出现在错误消息首行与结果字段里。
    pub fn code(self) -> &'static str {
        match self {
            ErrorKind::PermissionDenied => "permission_denied",
            ErrorKind::WindowUnavailable => "window_unavailable",
            ErrorKind::DesktopUnavailable => "desktop_unavailable",
            ErrorKind::ActivationBlocked => "activation_blocked",
            ErrorKind::CaptureFailed => "capture_failed",
            ErrorKind::Timeout => "timeout",
            ErrorKind::DriverError => "driver_error",
        }
    }

    /// 每类错误一句「下一步做什么」：模型可直接执行，也可转述给用户。
    pub fn guidance(self) -> &'static str {
        match self {
            ErrorKind::PermissionDenied => "A required OS permission is missing (see the message for which one and where to enable it). Ask the user to grant it, and only retry AFTER they confirm - retrying now will fail the same way.",
            ErrorKind::WindowUnavailable => "The target window is gone (closed, rebuilt or its handle became invalid). Do NOT retry the same coordinates: take a fresh screenshot (or call screen-info) and locate the target again.",
            ErrorKind::DesktopUnavailable => "The desktop session is not usable right now (locked screen, disconnected remote session or no display available). Ask the user to unlock / reconnect the desktop, then retry.",
            ErrorKind::ActivationBlocked => "The input was dispatched but the target window did not receive it (it is not the foreground window, or an elevated window on Windows dropped it). Bring the target window to the front, verify with a screenshot, then retry.",
            ErrorKind::CaptureFailed => "The capture came back empty or failed to encode. Retry once; if it fails again, capture a smaller region (the `region` parameter) or another display.",
            ErrorKind::Timeout => "The operation timed out. Wait a moment and retry once; if it keeps timing out the target application is probably busy.",
            ErrorKind::DriverError => "The OS input/capture driver rejected the operation. Read the original error above, adjust the arguments (coordinates, key names, button) and retry.",
        }
    }
}

/// 失败发生的子系统：决定默认分类，以及「运行时事实」检测的范围。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    /// 键鼠输入（enigo）。
    Input,
    /// 屏幕捕获与编码（xcap + image）。
    Capture,
    /// 显示器枚举 / 桌面环境。
    Display,
}

/// 结构化失败：`kind` 为 None 表示参数/用法错误（不分类、不附环境快照）。
pub struct Failure {
    kind: Option<ErrorKind>,
    message: String,
}

impl Failure {
    /// 参数/用法错误：模型自己就能改，不附环境快照。
    pub fn usage(message: impl Into<String>) -> Self {
        Failure {
            kind: None,
            message: message.into(),
        }
    }

    /// 调用方已明确知道原因时直接指定分类（不做文本猜测）。
    pub fn of(kind: ErrorKind, message: impl Into<String>) -> Self {
        Failure {
            kind: Some(kind),
            message: message.into(),
        }
    }

    /// 按子系统归类：先看运行时事实（权限是否真的缺失），再看底层报错
    /// 文案特征，最后回落到该子系统的默认分类。
    pub fn classify(domain: Domain, message: impl Into<String>) -> Self {
        let message = message.into();
        let kind = classify_kind(domain, &message);
        Failure {
            kind: Some(kind),
            message,
        }
    }

    pub fn code(&self) -> Option<&'static str> {
        self.kind.map(ErrorKind::code)
    }

    /// 单行摘要（act 的步骤级错误用，避免重复环境快照）。
    pub fn labeled(&self) -> String {
        match self.kind {
            None => self.message.clone(),
            Some(kind) => format!("[{}] {}", kind.code(), self.message),
        }
    }

    /// 摘要 + 「下一步做什么」。
    pub fn describe(&self) -> String {
        match self.kind {
            None => self.message.clone(),
            Some(kind) => format!("{} NEXT: {}", self.labeled(), kind.guidance()),
        }
    }

    /// 完整错误文本（工具级）：摘要 + 一行结构化环境快照。
    pub fn render(&self) -> String {
        match self.kind {
            None => self.message.clone(),
            Some(_) => format!("{}\nCONTEXT: {}", self.describe(), environment_snapshot()),
        }
    }

    pub fn into_napi(self) -> Error {
        Error::new(Status::GenericFailure, self.render())
    }
}

/// 底层报错里出现即代表「系统权限/访问被拒绝」的片段
/// （EACCES/EPERM、Windows 0x80070005 = E_ACCESSDENIED/UIPI）。
const PERMISSION_MARKERS: [&str; 12] = [
    "eacces",
    "eperm",
    "permission denied",
    "operation not permitted",
    "not permitted",
    "access is denied",
    "access denied",
    "0x80070005",
    "not authorized",
    "uipi",
    "accessibility",
    "screen recording",
];

/// 底层报错里的超时特征。
const TIMEOUT_MARKERS: [&str; 4] = ["timed out", "timeout", "time out", "deadline exceeded"];

/// 底层报错里的「窗口已不存在/句柄失效」特征。
const WINDOW_MARKERS: [&str; 7] = [
    "window not found",
    "no such window",
    "invalid window",
    "invalid hwnd",
    "window handle",
    "window is closed",
    "window was destroyed",
];

fn classify_kind(domain: Domain, message: &str) -> ErrorKind {
    // 1. 运行时事实优先：权限缺失与底层文案无关，直接判权限问题
    let permission_missing = match domain {
        Domain::Input => !platform::has_input_permission(),
        Domain::Capture | Domain::Display => !platform::has_screen_capture_permission(),
    };
    if permission_missing {
        return ErrorKind::PermissionDenied;
    }

    // 2. 底层报错文案特征（enigo/xcap 透传的系统错误码与短语）
    let lower = message.to_ascii_lowercase();
    if PERMISSION_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return ErrorKind::PermissionDenied;
    }
    if TIMEOUT_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return ErrorKind::Timeout;
    }
    if WINDOW_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return ErrorKind::WindowUnavailable;
    }

    // 3. 回落到子系统默认分类
    match domain {
        Domain::Input => ErrorKind::DriverError,
        Domain::Capture => ErrorKind::CaptureFailed,
        Domain::Display => ErrorKind::DesktopUnavailable,
    }
}

/// 失败时的环境快照：显示器、光标、权限、前台窗口。
///
/// 每一项都容忍失败（取不到就是 null）：快照本身绝不能再抛错，
/// 否则真正的失败原因会被覆盖。
fn environment_snapshot() -> String {
    let displays = capture::list_displays().ok();
    let primary = displays
        .as_ref()
        .and_then(|list| list.first())
        .map(|monitor| {
            json!({
                "width": monitor.get("width").cloned().unwrap_or(Value::Null),
                "height": monitor.get("height").cloned().unwrap_or(Value::Null),
            })
        });
    json!({
        "platform": std::env::consts::OS,
        "displays": displays.as_ref().map(Vec::len),
        "primaryDisplay": primary,
        "cursor": input::mouse_location().ok().map(|(x, y)| json!({"x": x, "y": y})),
        "inputPermission": platform::has_input_permission(),
        "screenCapturePermission": platform::has_screen_capture_permission(),
        "focusedWindow": window::focused_window().map(|window| window.to_json()),
    })
    .to_string()
}
