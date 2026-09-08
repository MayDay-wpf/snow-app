//! 平台权限预检与提示。
//!
//! macOS 上鼠标键盘模拟需要「辅助功能」授权、屏幕截图需要「屏幕录制」
//! 授权；未授权时 enigo/xcap 只会静默失败或返回黑屏，模型难以自查。
//! 在执行前主动预检并以明确错误信息指引用户到系统设置授权。
//!
//! 另提供 run_on_main：macOS 26 起 HIToolbox/TSM 键盘布局 API（enigo
//! 按键时按需调用）带主队列断言，后台线程调用会触发
//! _dispatch_assert_queue_fail 直接 abort 进程；所有 enigo 底层调用
//! 必须经此转发到主队列执行。

#[cfg(target_os = "macos")]
mod main_queue {
    use std::ffi::c_void;
    use std::sync::mpsc;

    // 必须显式 #[link]：rustc 对 macOS cdylib 默认 -undefined dynamic_lookup，
    // 无 #[link] 的 extern 符号链接期不绑定，macOS 26 dyld 运行时将其解析为
    // NULL，调用即 SIGSEGV（PC=0）。显式链接 System 在链接期完成绑定。
    // 另：dispatch_get_main_queue 是 ALWAYS_INLINE 函数，无 out-of-line 导出
    // 符号（flat-namespace 运行时解析为 NULL），其内联实现即取
    // _dispatch_main_q 全局对象地址，此处等价直引。
    #[link(name = "System", kind = "dylib")]
    extern "C" {
        static _dispatch_main_q: c_void;
        fn dispatch_async_f(
            queue: *const c_void,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
        // 主线程上必须直接执行：向 main queue 提交后等待自身会死锁
        fn pthread_main_np() -> i32;
    }

    struct Ctx<F, R> {
        f: Option<F>,
        tx: Option<mpsc::Sender<R>>,
    }

    // context 指向调用方栈上的 Ctx；dispatch_async_f 提交后调用方
    // 在 recv() 上挂起，主线程独占访问，send 之后不再触碰 Ctx。
    extern "C" fn invoke<F: FnOnce() -> R, R>(raw: *mut c_void) {
        let ctx = unsafe { &mut *(raw as *mut Ctx<F, R>) };
        let f = ctx.f.take().expect("invoke runs once");
        let tx = ctx.tx.take().expect("sender kept until invoke");
        // 接收方可能已放弃等待（如进程关闭），发送失败直接忽略
        let _ = tx.send(f());
    }

    /// 在主 dispatch queue 上执行闭包并等待结果取回。
    ///
    /// 必须用 dispatch_async_f 提交、channel 回传等待：macOS 14+ 的
    /// dispatch_assert_queue$V2 对 sync 提交的 block 会递归检查提交者
    /// 是否也在期望队列上——从无队列身份的后台线程 dispatch_sync 后，
    /// 主队列 block 内的 HIToolbox/TSM 断言依然失败（macOS 26 直接
    /// abort 进程）。async 提交的 block 只以 main queue 为执行身份，
    /// 无提交者链，断言通过。
    pub fn run_on_main<F: FnOnce() -> R, R>(f: F) -> R {
        if unsafe { pthread_main_np() } != 0 {
            return f();
        }
        let (tx, rx) = mpsc::channel::<R>();
        let mut ctx = Ctx {
            f: Some(f),
            tx: Some(tx),
        };
        let raw = &mut ctx as *mut Ctx<F, R> as *mut c_void;
        unsafe {
            let main_queue = std::ptr::addr_of!(_dispatch_main_q);
            dispatch_async_f(main_queue, raw, invoke::<F, R>);
        }
        rx.recv()
            .expect("main queue must execute the submitted closure")
    }
}

/// 在主线程上执行闭包并等待结果（macOS）；其他平台直接执行。
#[cfg(target_os = "macos")]
pub use main_queue::run_on_main;

#[cfg(not(target_os = "macos"))]
pub fn run_on_main<F: FnOnce() -> R, R>(f: F) -> R {
    f()
}

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
