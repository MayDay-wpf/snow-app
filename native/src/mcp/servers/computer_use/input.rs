//! 键鼠输入控制：enigo 封装。
//!
//! 所有键鼠操作通过全局互斥锁串行执行（并发点击会互相干扰）；
//! 平滑移动用 ease-out 插值模拟人类轨迹。本模块全部为同步实现，
//! 只允许在 `tokio::task::spawn_blocking` 上下文中调用，绝不阻塞
//! Node.js / NAPI 线程。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

use super::platform;

/// 平滑移动的最小总时长；低于此值直接瞬移（无意义插值）。
const MIN_SMOOTH_DURATION_MS: u64 = 15;
/// 拖拽释放前的稳定等待，确保目标先处理完 press-move 事件。
const DRAG_RELEASE_SETTLE_MS: u64 = 50;

/// 解析鼠标按钮名。
pub fn parse_button(name: &str) -> Result<Button, String> {
    match name.trim().to_ascii_lowercase().as_str() {
        "left" | "l" => Ok(Button::Left),
        "middle" | "m" => Ok(Button::Middle),
        "right" | "r" => Ok(Button::Right),
        "back" | "side" => Ok(Button::Back),
        "forward" => Ok(Button::Forward),
        other => Err(format!(
            "Unknown mouse button \"{other}\". Supported: left, middle, right, back, forward"
        )),
    }
}

/// 解析按键名（单字符或命名键）到 enigo Key。
pub fn parse_key(name: &str) -> Result<Key, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Key name must not be empty".to_string());
    }

    // 单个 Unicode 字符（字母/数字/符号）直接按键
    if trimmed.chars().count() == 1 {
        return Ok(Key::Unicode(trimmed.chars().next().expect("checked length")));
    }

    // F1-F20 全平台可用；F21-F24 仅 Windows / Linux
    let lower = trimmed.to_ascii_lowercase();
    if let Some(num) = lower.strip_prefix('f').and_then(|rest| rest.parse::<u8>().ok()) {
        const FN_KEYS: [Key; 20] = [
            Key::F1, Key::F2, Key::F3, Key::F4, Key::F5, Key::F6, Key::F7, Key::F8, Key::F9,
            Key::F10, Key::F11, Key::F12, Key::F13, Key::F14, Key::F15, Key::F16, Key::F17,
            Key::F18, Key::F19, Key::F20,
        ];
        if (1..=20).contains(&num) {
            return Ok(FN_KEYS[(num - 1) as usize]);
        }
        #[cfg(not(target_os = "macos"))]
        if (21..=24).contains(&num) {
            const FN_KEYS_EXT: [Key; 4] = [Key::F21, Key::F22, Key::F23, Key::F24];
            return Ok(FN_KEYS_EXT[(num - 21) as usize]);
        }
        return Err(format!(
            "Unsupported function key F{num}. Supported: F1-F20 (F21-F24 on Windows/Linux)"
        ));
    }

    let key = match lower.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        "up" | "uparrow" => Key::UpArrow,
        "down" | "downarrow" => Key::DownArrow,
        "left" | "leftarrow" => Key::LeftArrow,
        "right" | "rightarrow" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "capslock" | "caps_lock" => Key::CapsLock,
        "ctrl" | "control" => Key::Control,
        "alt" | "option" | "opt" => Key::Alt,
        "shift" => Key::Shift,
        "win" | "windows" | "super" | "meta" | "cmd" | "command" => Key::Meta,
        "volumeup" => Key::VolumeUp,
        "volumedown" => Key::VolumeDown,
        "volumemute" => Key::VolumeMute,
        "medianexttrack" | "media_next" => Key::MediaNextTrack,
        "mediaprevtrack" | "media_prev" => Key::MediaPrevTrack,
        "mediaplaypause" | "media_playpause" => Key::MediaPlayPause,
        "numpad0" => Key::Numpad0,
        "numpad1" => Key::Numpad1,
        "numpad2" => Key::Numpad2,
        "numpad3" => Key::Numpad3,
        "numpad4" => Key::Numpad4,
        "numpad5" => Key::Numpad5,
        "numpad6" => Key::Numpad6,
        "numpad7" => Key::Numpad7,
        "numpad8" => Key::Numpad8,
        "numpad9" => Key::Numpad9,
        "numpad_add" | "numpadadd" | "add" => Key::Add,
        "numpad_subtract" | "numpadsubtract" | "subtract" => Key::Subtract,
        "numpad_multiply" | "numpadmultiply" | "multiply" => Key::Multiply,
        "numpad_divide" | "numpaddivide" | "divide" => Key::Divide,
        "numpad_decimal" | "numpaddecimal" | "decimal" => Key::Decimal,
        other => {
            // 平台限定键（enigo 在 macOS 上无这些变体）
            #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
            {
                if let Some(key) = match other {
                    "insert" => Some(Key::Insert),
                    "numlock" | "num_lock" => Some(Key::Numlock),
                    "scrolllock" | "scroll_lock" => Some(Key::ScrollLock),
                    "printscr" | "printscreen" | "print_screen" => Some(Key::PrintScr),
                    "pause" => Some(Key::Pause),
                    "mediastop" | "media_stop" => Some(Key::MediaStop),
                    _ => None,
                } {
                    return Ok(key);
                }
            }
            return Err(format!(
                "Unknown key name \"{other}\". Use a single character, a function key (f1-f20), or a named key (enter, tab, esc, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, ctrl, alt, shift, win/cmd/meta, capslock, numpad0-9, ...)"
            ));
        }
    };
    Ok(key)
}

struct InputController {
    enigo: Enigo,
}

impl InputController {
    fn new() -> Result<Self, String> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|error| format!("Failed to initialize input controller: {error}"))?;
        Ok(Self { enigo })
    }

    fn mouse_location(&self) -> Result<(i32, i32), String> {
        self.enigo
            .location()
            .map_err(|error| format!("Failed to read mouse location: {error}"))
    }

    fn main_display_size(&self) -> Result<(i32, i32), String> {
        self.enigo
            .main_display()
            .map_err(|error| format!("Failed to read main display size: {error}"))
    }

    fn move_to_instant(&mut self, x: i32, y: i32) -> Result<(), String> {
        self.enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|error| format!("Failed to move mouse to ({x}, {y}): {error}"))
    }

    /// ease-out cubic 插值移动，模拟人类轨迹；duration 过短或距离过近时瞬移。
    fn smooth_move_to(&mut self, to_x: i32, to_y: i32, duration_ms: u64) -> Result<(), String> {
        if duration_ms < MIN_SMOOTH_DURATION_MS {
            return self.move_to_instant(to_x, to_y);
        }
        let (from_x, from_y) = self.mouse_location()?;
        let dx = f64::from(to_x - from_x);
        let dy = f64::from(to_y - from_y);
        let distance = (dx * dx + dy * dy).sqrt();
        if distance < 1.5 {
            return self.move_to_instant(to_x, to_y);
        }

        // 约 4px 一步，10-90 步之间
        let steps = ((distance / 4.0).round() as u64).clamp(10, 90);
        let step_delay = (duration_ms / steps).max(1);
        for step in 1..=steps {
            let t = f64::from(step as u32) / steps as f64;
            let eased = 1.0 - (1.0 - t).powi(3);
            let x = from_x as f64 + dx * eased;
            let y = from_y as f64 + dy * eased;
            self.move_to_instant(x.round() as i32, y.round() as i32)?;
            std::thread::sleep(Duration::from_millis(step_delay));
        }
        Ok(())
    }

    fn button(&mut self, button: Button, direction: Direction) -> Result<(), String> {
        self.enigo
            .button(button, direction)
            .map_err(|error| format!("Failed to send mouse button event: {error}"))
    }

    /// N 次点击（N=1 单击，N=2 双击，N=3 三击）。
    /// hold_ms > 0 时每次为「按下-保持-释放」长按；否则为普通 click。
    fn click_times(
        &mut self,
        button: Button,
        times: u32,
        interval_ms: u64,
        hold_ms: u64,
    ) -> Result<(), String> {
        for index in 0..times {
            if index > 0 {
                std::thread::sleep(Duration::from_millis(interval_ms));
            }
            if hold_ms > 0 {
                self.button(button, Direction::Press)?;
                std::thread::sleep(Duration::from_millis(hold_ms));
                self.button(button, Direction::Release)?;
            } else {
                self.button(button, Direction::Click)?;
            }
        }
        Ok(())
    }

    /// 拖拽：移动到起点 -> 按下 -> 保持 hold_ms（长按拖拽）-> 平滑移动到终点 -> 释放。
    fn drag(
        &mut self,
        from: Option<(i32, i32)>,
        to: (i32, i32),
        button: Button,
        hold_ms: u64,
        pre_move_duration_ms: u64,
        drag_duration_ms: u64,
        release_at_end: bool,
    ) -> Result<(), String> {
        if let Some((x, y)) = from {
            self.smooth_move_to(x, y, pre_move_duration_ms)?;
        }
        self.button(button, Direction::Press)?;
        if hold_ms > 0 {
            std::thread::sleep(Duration::from_millis(hold_ms));
        }
        self.smooth_move_to(to.0, to.1, drag_duration_ms)?;
        if release_at_end {
            std::thread::sleep(Duration::from_millis(DRAG_RELEASE_SETTLE_MS));
            self.button(button, Direction::Release)?;
        }
        Ok(())
    }

    fn scroll(&mut self, amount: i32, axis: Axis) -> Result<(), String> {
        self.enigo
            .scroll(amount, axis)
            .map_err(|error| format!("Failed to scroll: {error}"))
    }

    fn key(&mut self, key: Key, direction: Direction) -> Result<(), String> {
        self.enigo
            .key(key, direction)
            .map_err(|error| format!("Failed to send key event: {error}"))
    }

    /// 组合键：顺序按下修饰键 -> Click 最后一个键 -> 逆序释放。
    /// 单键时直接 Click。
    fn tap_combination(&mut self, keys: &[Key]) -> Result<(), String> {
        if keys.len() == 1 {
            return self.key(keys[0], Direction::Click);
        }
        let (modifiers, last) = keys.split_at(keys.len() - 1);
        for key in modifiers {
            self.key(*key, Direction::Press)?;
        }
        self.key(last[0], Direction::Click)?;
        for key in modifiers.iter().rev() {
            self.key(*key, Direction::Release)?;
        }
        Ok(())
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        self.enigo
            .text(text)
            .map_err(|error| format!("Failed to type text: {error}"))
    }
}

/// 全局控制器：失败（如无 X11）时保持 None，下次调用重试初始化。
static CONTROLLER: OnceLock<Mutex<Option<InputController>>> = OnceLock::new();

/// 键鼠操作前置检查：平台权限（macOS 辅助功能）。
pub fn ensure_input_permission() -> Result<(), String> {
    if platform::has_input_permission() {
        Ok(())
    } else {
        Err(platform::input_permission_hint())
    }
}

/// 获取全局控制器并在互斥锁下执行闭包。所有键鼠操作串行化，
/// 避免 AI 的多次并发调用产生交错事件序列。
fn with_controller<R>(
    operation: impl FnOnce(&mut InputController) -> Result<R, String>,
) -> Result<R, String> {
    let mutex = CONTROLLER.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        match InputController::new() {
            Ok(controller) => *guard = Some(controller),
            Err(error) => {
                return Err(format!("{error}. {}", platform::input_permission_hint()));
            }
        }
    }
    let controller = guard
        .as_mut()
        .expect("input controller must be initialized above");
    operation(controller)
}

/// 当前鼠标全局坐标。
pub fn mouse_location() -> Result<(i32, i32), String> {
    ensure_input_permission()?;
    with_controller(|controller| controller.mouse_location())
}

/// 主显示器尺寸。
pub fn main_display_size() -> Result<(i32, i32), String> {
    ensure_input_permission()?;
    with_controller(|controller| controller.main_display_size())
}

/// 瞬移鼠标到全局坐标。
pub fn move_mouse_instant(x: i32, y: i32) -> Result<(i32, i32), String> {
    ensure_input_permission()?;
    with_controller(|controller| {
        controller.move_to_instant(x, y)?;
        controller.mouse_location()
    })
}

/// 平滑移动鼠标到全局坐标，返回最终位置。
pub fn smooth_move_mouse(x: i32, y: i32, duration_ms: u64) -> Result<(i32, i32), String> {
    ensure_input_permission()?;
    with_controller(|controller| {
        controller.smooth_move_to(x, y, duration_ms)?;
        controller.mouse_location()
    })
}

/// 点击（单击/双击/三击/长按），返回点击时鼠标位置。
#[allow(clippy::too_many_arguments)]
pub fn click_mouse(
    x: Option<i32>,
    y: Option<i32>,
    button: Button,
    clicks: u32,
    interval_ms: u64,
    hold_ms: u64,
    move_duration_ms: u64,
) -> Result<(i32, i32), String> {
    ensure_input_permission()?;
    with_controller(|controller| {
        if let (Some(x), Some(y)) = (x, y) {
            controller.smooth_move_to(x, y, move_duration_ms)?;
        }
        controller.click_times(button, clicks, interval_ms, hold_ms)?;
        controller.mouse_location()
    })
}

/// 拖拽（含长按拖拽），返回释放时鼠标位置。
#[allow(clippy::too_many_arguments)]
pub fn drag_mouse(
    from: Option<(i32, i32)>,
    to: (i32, i32),
    button: Button,
    hold_ms: u64,
    pre_move_duration_ms: u64,
    drag_duration_ms: u64,
    release_at_end: bool,
) -> Result<(i32, i32), String> {
    ensure_input_permission()?;
    with_controller(|controller| {
        controller.drag(
            from,
            to,
            button,
            hold_ms,
            pre_move_duration_ms,
            drag_duration_ms,
            release_at_end,
        )?;
        controller.mouse_location()
    })
}

/// 滚动。amount 单位为滚轮格（15° 档），正负号代表方向。
pub fn scroll_mouse(amount: i32, axis: Axis) -> Result<(), String> {
    ensure_input_permission()?;
    with_controller(|controller| controller.scroll(amount, axis))
}

/// 底层按下/释放鼠标按钮（自定义手势原语）。
pub fn mouse_button(
    action_press: bool,
    button: Button,
    x: Option<i32>,
    y: Option<i32>,
    move_duration_ms: u64,
) -> Result<(i32, i32), String> {
    ensure_input_permission()?;
    with_controller(|controller| {
        if let (Some(x), Some(y)) = (x, y) {
            controller.smooth_move_to(x, y, move_duration_ms)?;
        }
        controller.button(
            button,
            if action_press {
                Direction::Press
            } else {
                Direction::Release
            },
        )?;
        controller.mouse_location()
    })
}

/// 组合键点击。
pub fn tap_keys(keys: &[Key]) -> Result<(), String> {
    ensure_input_permission()?;
    with_controller(|controller| controller.tap_combination(keys))
}

/// 底层按键按下/释放（长按场景原语）。
pub fn key_button(key: Key, action_press: bool) -> Result<(), String> {
    ensure_input_permission()?;
    with_controller(|controller| {
        controller.key(
            key,
            if action_press {
                Direction::Press
            } else {
                Direction::Release
            },
        )
    })
}

/// 输入文本（Unicode，走系统文本通道，非逐键模拟）。
pub fn type_text(text: &str) -> Result<(), String> {
    ensure_input_permission()?;
    with_controller(|controller| controller.type_text(text))
}
