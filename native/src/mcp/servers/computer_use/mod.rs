//! Computer Use 内置 MCP 服务：AI 查看屏幕（截图）并控制鼠标键盘。
//!
//! 设计要点：
//! - 跨平台：xcap 截屏 + enigo 输入模拟（macOS / Windows / Linux X11）
//! - 全局互斥串行化所有键鼠操作，避免并发事件交错
//! - 工具面收敛为两个：`computer-use-screen`（action=info/screenshot 读屏）
//!   与 `computer-use-act`（全部键鼠输入 + steps 连续动作链）。原先 8 个
//!   单动作工具与 perform-actions 能力重叠，合并后省下约六成工具定义开销
//! - act 的每个动作都复用 chain::ChainAction，单动作与 steps 共用同一套
//!   参数校验与执行路径（steps 在单次互斥锁下原子执行）
//! - act 的 screenshotAfter：动作结束后在同一次调用内回传截图，省掉一次
//!   round-trip（动作与截图之间只隔一个很短的稳定等待）
//! - 坐标统一使用全局虚拟桌面坐标系，截图结果附带像素->屏幕换算系数
//! - 全部执行体走同步实现，由分发层（call.rs 默认分支）在
//!   spawn_blocking 线程池中调用，绝不阻塞 Node.js / NAPI 线程
//! - macOS 权限预检：辅助功能 / 屏幕录制缺失时返回可行动指引
//! - 失败分类与环境快照：所有对外错误经 error.rs 归类（code + NEXT +
//!   CONTEXT），动作工具回报 landedOnTarget / focusedWindow，让失败可归因、
//!   可恢复，模型不必靠原样重试摸索
//!
//! 安全边界：本服务器默认关闭，与 terminal/lsp 同一白名单机制
//! （system_settings DEFAULT_DISABLED_BUILTIN_SERVERS + collect.rs
//! DEFAULT_DISABLED_SERVER_IDS），需在 MCP 面板按项目显式启用，不受精简
//! 模式以外的任何隐式启用路径影响；`screen` 的 info 动作为只读，截图与
//! act 的全部动作均走用户审批流程。

mod capture;
mod chain;
mod error;
mod input;
mod platform;
mod window;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use capture::{list_displays, ScreenshotOutput};
use chain::ChainAction;
use error::{ErrorKind, Failure};

const SERVER_ID: &str = "computer-use";

/// act 支持的单动作名，与 chain 的 step type 完全同名（单动作 = 一个 step）。
const ACT_ACTIONS: [&str; 13] = [
    "move",
    "click",
    "drag",
    "scroll",
    "mouse-press",
    "mouse-release",
    "key-tap",
    "key-press",
    "key-release",
    "key-hold",
    "type",
    "wait",
    "steps",
];

/// steps 数组内允许的 step type（steps 不能再嵌套 steps）。
const ACT_STEP_TYPES: [&str; 12] = [
    "move",
    "click",
    "drag",
    "scroll",
    "mouse-press",
    "mouse-release",
    "key-tap",
    "key-press",
    "key-release",
    "key-hold",
    "type",
    "wait",
];

/// 所有键鼠动作共享的坐标系说明。
const COORDINATES_DOC: &str = "Coordinates are GLOBAL virtual-desktop pixels: the PRIMARY display's top-left corner is (0,0) and displays left/above it have negative x/y. Call computer-use-screen action=info first when you need the display layout or the current cursor position.";

/// 截图与动作配合的标准工作流。
const WORKFLOW_DOC: &str = "WORKFLOW: one screenshot (action=screenshot) -> locate ALL targets you need in that image -> convert pixel positions to screen coordinates with the formula in the text block -> chain the actions back-to-back WITHOUT re-screenshotting in between (prefer ONE action=steps call), or set screenshotAfter=true when you must see the screen right after the actions.";

/// 连续操作效率指引。
const EFFICIENCY_DOC: &str = "EFFICIENCY: every screenshot costs a full round-trip. Action results confirm success themselves, so do NOT re-screenshot between consecutive actions. Read the screen again ONLY when it visibly changed (new window/dialog/page appeared), an action failed, or you need a target that was not visible in the last image - and prefer screenshotAfter on the same act call over a separate screenshot. Example task 'send a chat message': ONE screenshot (locate the input box) -> ONE act call [type at x/y, key-tap enter] -> done.";

/// 动作落点判定说明（screen/act 结果里的字段）。
const LANDED_DOC: &str = "landedOnTarget reports whether the input actually reached a window: true = a foreground window covers the action point afterwards (the input was delivered), false = a window covers the point but is NOT the foreground window (the input may have been dropped, e.g. by an elevated window on Windows or a non-activating surface) and the result carries a warning, null = could not be determined. focusedWindow is the foreground window right after the actions: check it to confirm the input went to the window you intended. When landedOnTarget is false or a warning is present, do NOT retry blindly - screenshot, make sure the target window is in the foreground, then retry.";

/// 错误契约说明（挂在 screen 上，模型第一次调用就能看到）。
const ERROR_DOC: &str = "FAILURES: every error from this server is classified - it starts with a [code] (permission_denied | window_unavailable | desktop_unavailable | activation_blocked | capture_failed | timeout | driver_error), followed by NEXT: the concrete next step, then CONTEXT: a live environment snapshot (displays, cursor, permissions, foreground window) so you never need a separate screen call to triage a failure. Follow NEXT instead of repeating the same action.";

/// screenshotAfter 截图前的稳定等待（让 UI 完成一次绘制）。
const SCREENSHOT_SETTLE_MS: u64 = 180;

pub struct ComputerUseService;

impl ComputerUseService {
    pub fn new() -> Self {
        ComputerUseService
    }
}

impl McpService for ComputerUseService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screen".to_string(),
                description: format!(
                    "Read the computer-use environment and capture what is on screen.\n\nACTIONS:\n- info: displays (index, id, name, global position, size, scaleFactor, primary), current cursor position (global + display-local), platform permission status. Read-only, no side effects. Use it when starting a screen task, when unsure which display to capture, or after a permission / bounds error.\n- screenshot: capture one display (or a region of it) and return a base64 image you can SEE (multimodal), plus a text block with the exact pixel->screen conversion formula and the CURRENT MOUSE CURSOR position. When the cursor is inside the captured area a crosshair marks it: treat that crosshair as a reference point of known global coordinates and measure targets as pixel offsets from it (far more accurate than estimating absolute positions).\n\nPARAMS: display (index from info, 0 = primary), region {{x,y,width,height}} in DISPLAY-LOCAL LOGICAL pixels (crop to zoom into a dialog/toolbar), maxWidth (downscales the image to control token cost, default 1280), format jpeg|png (png is lossless but much larger - use it with a small region for tiny text).\n\n{COORDINATES_DOC}\n{WORKFLOW_DOC}\n{ERROR_DOC}"
                ),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["info", "screenshot"],
                            "description": "info = environment + cursor + permissions (read-only). screenshot = capture the screen as an image."
                        },
                        "display": {
                            "type": "number",
                            "description": "Display index from action=info (0 = primary). Default 0.",
                            "minimum": 0,
                            "default": 0
                        },
                        "region": {
                            "type": "object",
                            "description": "screenshot only: crop in display-local LOGICAL coordinates (top-left of the chosen display is 0,0).",
                            "properties": {
                                "x": {"type": "number", "minimum": 0},
                                "y": {"type": "number", "minimum": 0},
                                "width": {"type": "number", "minimum": 1},
                                "height": {"type": "number", "minimum": 1}
                            },
                            "required": ["x", "y", "width", "height"]
                        },
                        "maxWidth": {
                            "type": "number",
                            "description": "screenshot only: max image width in pixels after downscaling (aspect ratio preserved). Default 1280.",
                            "minimum": 200,
                            "maximum": 4000,
                            "default": 1280
                        },
                        "format": {
                            "type": "string",
                            "enum": ["jpeg", "png"],
                            "description": "screenshot only: jpeg (smaller, default) or png (lossless, larger).",
                            "default": "jpeg"
                        }
                    },
                    "required": ["action"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "act".to_string(),
                description: format!(
                    "Perform mouse/keyboard actions on the desktop. Every call runs under ONE global input lock; with action=steps the whole list is atomic (nothing can interleave) and the complete list is validated BEFORE anything runs.\n\nACTIONS (a single action takes exactly the same field names as the matching step type):\n- move {{x,y,durationMs}}: move the cursor without clicking. durationMs > 0 = smooth eased move, 0 (default) = instant teleport.\n- click {{x?,y?,button,clicks,holdMs,intervalMs,moveDurationMs}}: single (clicks=1), double (clicks=2, open file / select word), triple (clicks=3, select paragraph) or PRESS-AND-HOLD (holdMs > 0, e.g. long-press context menus / drag handles). x/y move-and-click in the same step (preferred over a separate move).\n- drag {{x?,y?,toX,toY,button,holdMs,durationMs,preMoveDurationMs,releaseAtEnd}}: press at the start point, hold, travel, release - files/emails, slider handles, text selection, canvas strokes, window edges. holdMs 500-800 for long-press-then-drag UIs; releaseAtEnd=false keeps the button pressed (finish with a mouse-release step).\n- scroll {{amount,axis,x?,y?}}: wheel notches, positive = down / right, negative = up / left. x/y hover the scrollable area first.\n- mouse-press {{button,x?,y?}} / mouse-release {{button}}: low-level primitives for gestures click/drag cannot express (press at A, travel, release at B; hold two buttons). ALWAYS finish every press with a matching release.\n- key-tap {{keys:[..]}}: one key or a chord pressed in order - [\"enter\"], [\"esc\"], [\"a\"], [\"ctrl\",\"shift\",\"t\"], [\"cmd\",\"c\"] on macOS (use ctrl on Windows/Linux). Submit an input right after typing with this step - no screenshot in between.\n- key-press {{key}} / key-release {{key}} / key-hold {{key,holdMs}}: low-level key control (hold an arrow key for continuous navigation, or modifier keys held across mouse steps).\n- type {{text,x?,y?}}: literal text through the OS text-input channel (any Unicode incl. CJK; NOT for shortcuts - use key-tap). x/y single-clicks an input to focus it in the same step. Very long text is slow - split it.\n- wait {{ms}}: pause so the UI can animate between steps (menus, dialogs).\n- steps {{actions:[{{type,..}}]}}: ordered list of the steps above, executed atomically in one call. Max {} steps.\n\nKey names: modifiers ctrl, alt/option, shift, win/cmd/meta; named keys enter/return, tab, esc, backspace, delete, insert, space, up, down, left, right, home, end, pageup, pagedown, f1-f20, capslock, printscr, pause, numpad0-9, volume/playback media keys; any other single character is typed as-is.\n\nscreenshotAfter: set true to receive a fresh screenshot of the screen AFTER the actions in the SAME call (also accepts display / region / maxWidth / format). Use it whenever the action is supposed to change the screen (opened a menu, navigated, submitted a form) instead of paying a second round-trip.\n\nRESULT: steps[] with per-step index/ok/detail/error, completed, failedIndex, cursor, landedOnTarget, focusedWindow; with screenshotAfter the result also carries a `content` array (text block + image). By default the chain STOPS at the first failing step (later steps usually assume earlier ones succeeded); set continueOnError=true to run all steps and collect every error. {LANDED_DOC}\n{COORDINATES_DOC}\n{EFFICIENCY_DOC}",
                    chain::MAX_CHAIN_ACTIONS
                ),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ACT_ACTIONS,
                            "description": "Which action to run. Use steps for multi-step sequences (atomic), single actions otherwise."
                        },
                        "x": {"type": "number", "description": "Global X (move target / click point / drag start / scroll or mouse-press hover / type focus click)."},
                        "y": {"type": "number", "description": "Global Y - always paired with x."},
                        "toX": {"type": "number", "description": "drag: end global X (required for drag)."},
                        "toY": {"type": "number", "description": "drag: end global Y (required for drag)."},
                        "button": {
                            "type": "string",
                            "enum": ["left", "middle", "right", "back", "forward"],
                            "description": "Mouse button for click / drag / mouse-press / mouse-release. Default left.",
                            "default": "left"
                        },
                        "clicks": {
                            "type": "number",
                            "minimum": 1,
                            "maximum": 3,
                            "description": "click: 1 = single (default), 2 = double, 3 = triple.",
                            "default": 1
                        },
                        "holdMs": {
                            "type": "number",
                            "description": "click: press-and-hold duration in ms (mutually exclusive with clicks > 1). drag: pause at the start point before traveling (default 120; 500-800 for long-press-then-drag UIs). key-hold: hold duration (default 500)."
                        },
                        "intervalMs": {
                            "type": "number",
                            "minimum": 10,
                            "maximum": 1000,
                            "description": "click: gap between successive multi-clicks. Default 90 - raise it if double clicks register as two singles.",
                            "default": 90
                        },
                        "moveDurationMs": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 5000,
                            "description": "click: smooth-move duration to (x, y) before clicking. 0 (default) = instant.",
                            "default": 0
                        },
                        "durationMs": {
                            "type": "number",
                            "description": "move: total smooth-move duration (0 = instant). drag: travel duration (omitted = auto, 150-800ms scaled by distance; 0 = instant)."
                        },
                        "preMoveDurationMs": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 5000,
                            "description": "drag: smooth-move duration to the start point. 0 (default) = instant.",
                            "default": 0
                        },
                        "releaseAtEnd": {
                            "type": "boolean",
                            "description": "drag: release the button at the end point. true (default); false keeps it pressed for multi-segment drags (release later with a mouse-release step).",
                            "default": true
                        },
                        "amount": {"type": "number", "description": "scroll: wheel notches; positive = down/right, negative = up/left."},
                        "axis": {
                            "type": "string",
                            "enum": ["vertical", "horizontal"],
                            "description": "scroll: axis. Default vertical.",
                            "default": "vertical"
                        },
                        "keys": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 1,
                            "maxItems": 8,
                            "description": "key-tap: ordered keys; the last is tapped while the preceding ones are held (chord). Single entry = plain tap."
                        },
                        "key": {"type": "string", "description": "key-press / key-release / key-hold: single key name."},
                        "text": {"type": "string", "description": "type: exact literal text to type (Unicode; for shortcuts use key-tap steps)."},
                        "ms": {
                            "type": "number",
                            "minimum": 10,
                            "maximum": 2000,
                            "description": "wait: pause duration in ms. Default 250.",
                            "default": 250
                        },
                        "actions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": chain::MAX_CHAIN_ACTIONS,
                            "description": "steps: ordered action list. Each item is one of the actions above plus \"type\" (e.g. {\"type\":\"type\",\"text\":\"hi\",\"x\":100,\"y\":200}, {\"type\":\"key-tap\",\"keys\":[\"enter\"]}, {\"type\":\"wait\",\"ms\":250}). Fields default to the same values as the matching single action.",
                            "items": {
                                "type": "object",
                                "required": ["type"],
                                "properties": {
                                    "type": {
                                        "type": "string",
                                        "enum": ACT_STEP_TYPES,
                                        "description": "Step type; same field names as the matching single action."
                                    }
                                }
                            }
                        },
                        "continueOnError": {
                            "type": "boolean",
                            "description": "false (default): stop at the first failing step and skip the rest. true: run all steps and report every error.",
                            "default": false
                        },
                        "screenshotAfter": {
                            "type": "boolean",
                            "description": "Capture a screenshot after the actions in the same call (result gains a `content` text+image array). Use instead of a separate screenshot when the action changes the screen.",
                            "default": false
                        },
                        "display": {
                            "type": "number",
                            "minimum": 0,
                            "description": "screenshotAfter: display index (0 = primary). Default 0."
                        },
                        "region": {
                            "type": "object",
                            "description": "screenshotAfter: crop in display-local logical coordinates.",
                            "properties": {
                                "x": {"type": "number", "minimum": 0},
                                "y": {"type": "number", "minimum": 0},
                                "width": {"type": "number", "minimum": 1},
                                "height": {"type": "number", "minimum": 1}
                            },
                            "required": ["x", "y", "width", "height"]
                        },
                        "maxWidth": {
                            "type": "number",
                            "minimum": 200,
                            "maximum": 4000,
                            "description": "screenshotAfter: max image width. Default 1280."
                        },
                        "format": {
                            "type": "string",
                            "enum": ["jpeg", "png"],
                            "description": "screenshotAfter: jpeg (default) or png."
                        }
                    },
                    "required": ["action"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            "screen" => execute_screen(args),
            "act" => execute_act(args),
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

// ---------- 工具执行 ----------

fn execute_screen(args: &Value) -> napi::Result<Value> {
    match required_str(args, "action")?.as_str() {
        "info" => execute_screen_info(),
        "screenshot" => execute_screenshot(args),
        other => Err(napi_error(format!(
            "action must be \"info\" or \"screenshot\", got \"{other}\""
        ))),
    }
}

fn execute_screen_info() -> napi::Result<Value> {
    let displays = list_displays().map_err(Failure::into_napi)?;
    let cursor = cursor_info(&displays);
    let main_display = match capture::primary_display_size() {
        Ok((width, height)) => json!({"width": width, "height": height}),
        Err(_) => Value::Null,
    };
    Ok(json!({
        "displays": displays,
        "cursor": cursor,
        "mainDisplay": main_display,
        "permissions": {
            "inputControl": platform::has_input_permission(),
            "screenCapture": platform::has_screen_capture_permission(),
        },
        "platform": std::env::consts::OS,
        "notes": platform::platform_notes(),
    }))
}

/// 光标位置：全局坐标 + 所在显示器及其屏内坐标（读取失败返回 null）。
fn cursor_info(displays: &[Value]) -> Value {
    let Ok((x, y)) = input::mouse_location() else {
        return Value::Null;
    };
    let display = capture::display_containing_point(x, y).ok().flatten();
    let display_local = display
        .and_then(|index| displays.get(index))
        .map(|monitor| {
            json!({
                "x": i64::from(x) - monitor.get("x").and_then(Value::as_i64).unwrap_or(0),
                "y": i64::from(y) - monitor.get("y").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .unwrap_or(Value::Null);
    json!({
        "x": x,
        "y": y,
        "display": match display {
            Some(index) => json!(index),
            None => Value::Null,
        },
        "displayLocal": display_local,
    })
}

/// 已校验的截图请求（screen.screenshot 与 act.screenshotAfter 共用）。
struct CaptureRequest {
    display: u32,
    region: Option<(u32, u32, u32, u32)>,
    max_width: u32,
    png: bool,
}

fn parse_capture_request(args: &Value, defaults: CaptureRequest) -> napi::Result<CaptureRequest> {
    let display = numeric_field(args, "display")
        .map(|value| value.round().clamp(0.0, 100.0) as u32)
        .unwrap_or(defaults.display);
    let region = match args.get("region") {
        None | Some(Value::Null) => defaults.region,
        Some(object @ Value::Object(_)) => {
            let x = bounded_u64(object, "x", 0, 0, 100_000) as u32;
            let y = bounded_u64(object, "y", 0, 0, 100_000) as u32;
            let width = bounded_u64(object, "width", 0, 1, 100_000) as u32;
            let height = bounded_u64(object, "height", 0, 1, 100_000) as u32;
            Some((x, y, width, height))
        }
        Some(_) => {
            return Err(napi_error(
                "region must be an object {x, y, width, height}".to_string(),
            ))
        }
    };
    let max_width = numeric_field(args, "maxWidth")
        .map(|value| value.round().clamp(200.0, 4000.0) as u32)
        .unwrap_or(defaults.max_width);
    let png = match args.get("format").and_then(Value::as_str) {
        Some(value) => value.trim().eq_ignore_ascii_case("png"),
        None => defaults.png,
    };
    Ok(CaptureRequest {
        display,
        region,
        max_width,
        png,
    })
}

fn execute_screenshot(args: &Value) -> napi::Result<Value> {
    let request = parse_capture_request(
        args,
        CaptureRequest {
            display: 0,
            region: None,
            max_width: 1280,
            png: false,
        },
    )?;
    let output = capture::capture_screen(
        request.display,
        request.region,
        request.max_width,
        request.png,
    )
    .map_err(Failure::into_napi)?;
    Ok(screenshot_result(&output))
}

/// 组装截图结果：content 数组（text + image block）+ 换算元数据。
fn screenshot_result(output: &ScreenshotOutput) -> Value {
    let displays = list_displays().unwrap_or_default();
    let monitor = displays
        .get(output.display_index)
        .cloned()
        .unwrap_or(Value::Null);

    // 图像像素坐标换算说明（模型据此把图中目标换算为屏幕坐标）
    let monitor_x = monitor.get("x").and_then(Value::as_i64).unwrap_or(0);
    let monitor_y = monitor.get("y").and_then(Value::as_i64).unwrap_or(0);
    let (region_x, region_y) = match output.region {
        Some((x, y, _, _)) => (x as i64, y as i64),
        None => (0, 0),
    };
    let scale = output.pixel_to_screen_scale;
    let cursor_note = match output.cursor.as_ref() {
        Some(cursor) => match (cursor.image_x, cursor.image_y) {
            (Some(image_x), Some(image_y)) => format!(
                " The crosshair marks the CURRENT MOUSE CURSOR at GLOBAL ({}, {}) = image pixel ({image_x}, {image_y}); measure a target as a pixel offset from the crosshair and apply the formula above - relative offsets are much more accurate than estimating absolute positions.",
                cursor.x, cursor.y
            ),
            _ => format!(
                " The current mouse cursor is at GLOBAL ({}, {}), OUTSIDE this capture (no crosshair is drawn).",
                cursor.x, cursor.y
            ),
        },
        None => String::new(),
    };
    let text = format!(
        "Screenshot of display {} ({}x{} logical). The attached image is {}x{} pixels ({}). To convert a pixel position (px, py) in this image to the GLOBAL screen coordinate used by the mouse actions: screenX = {} + px * {:.5}, screenY = {} + py * {:.5}. The act tool expects exactly these global coordinates.{}",
        output.display_index,
        monitor.get("width").and_then(Value::as_i64).unwrap_or(0),
        monitor.get("height").and_then(Value::as_i64).unwrap_or(0),
        output.image_width,
        output.image_height,
        output.mime_type,
        monitor_x + region_x,
        scale,
        monitor_y + region_y,
        scale,
        cursor_note,
    );

    // 光标位置：全局坐标 + 图内像素坐标（不在截取范围内为 null）
    let cursor = match output.cursor.as_ref() {
        Some(cursor) => json!({
            "x": cursor.x,
            "y": cursor.y,
            "imagePixel": match (cursor.image_x, cursor.image_y) {
                (Some(image_x), Some(image_y)) => json!({"x": image_x, "y": image_y}),
                _ => Value::Null,
            },
        }),
        None => Value::Null,
    };

    json!({
        "content": [
            {"type": "text", "text": text},
            {"type": "image", "mimeType": output.mime_type, "data": output.base64_data},
        ],
        "display": output.display_index,
        "monitor": monitor,
        "region": match output.region {
            Some((x, y, width, height)) => json!({"x": x, "y": y, "width": width, "height": height}),
            None => Value::Null,
        },
        "imageSize": {"width": output.image_width, "height": output.image_height},
        "originalSize": {"width": output.original_width, "height": output.original_height},
        "pixelToScreenScale": scale,
        "cursor": cursor,
    })
}

fn execute_act(args: &Value) -> napi::Result<Value> {
    let action = required_str(args, "action")?;
    let continue_on_error = optional_bool(args, "continueOnError", false);
    let actions = if action == "steps" {
        chain::parse_actions(args)?
    } else {
        chain::parse_actions(&single_action_args(args, &action)?)?
    };

    let (outcomes, cursor) =
        input::run_action_chain(&actions, continue_on_error).map_err(Failure::into_napi)?;

    let mut result = chain::format_result(actions.len(), &outcomes, cursor);
    attach_target_report(&mut result, focus_point(&actions));

    if optional_bool(args, "screenshotAfter", false) {
        let request = parse_capture_request(
            args,
            CaptureRequest {
                display: 0,
                region: None,
                max_width: 1280,
                png: false,
            },
        )?;
        // 给 UI 一个很短的稳定时间，避免截到动画中间态
        std::thread::sleep(std::time::Duration::from_millis(SCREENSHOT_SETTLE_MS));
        match capture::capture_screen(
            request.display,
            request.region,
            request.max_width,
            request.png,
        ) {
            Ok(output) => {
                // 图像块放顶层 content（供模型看图），screenshot 只留元数据
                let mut shot = screenshot_result(&output);
                if let Some(content) = shot.get_mut("content").and_then(Value::as_array_mut) {
                    result["content"] = Value::Array(std::mem::take(content));
                }
                if let Some(object) = shot.as_object_mut() {
                    object.remove("content");
                }
                result["screenshot"] = shot;
            }
            // 截图失败不能吞掉动作结果：只补一个字段说明原因
            Err(failure) => {
                result["screenshotError"] = json!(failure.describe());
            }
        }
    }

    Ok(result)
}

/// 单动作 = 一个 chain step：把 action 名映射为 step 的 type，
/// 其余字段名与 steps 内的字段完全一致（parse_action 忽略多余字段）。
fn single_action_args(args: &Value, action: &str) -> napi::Result<Value> {
    if !ACT_ACTIONS.contains(&action) {
        return Err(napi_error(format!(
            "unknown action \"{action}\". Supported: {} (use \"steps\" for a multi-step sequence)",
            ACT_ACTIONS.join(", ")
        )));
    }
    let mut step = args
        .as_object()
        .cloned()
        .ok_or_else(|| napi_error("arguments must be a JSON object".to_string()))?;
    step.remove("action");
    step.remove("screenshotAfter");
    step.remove("continueOnError");
    step.insert("type".to_string(), Value::String(action.to_string()));
    Ok(json!({ "actions": [Value::Object(step)] }))
}

/// 动作链中最后一个带坐标的落点（用于 landedOnTarget 判定）。
fn focus_point(actions: &[ChainAction]) -> Option<(i32, i32)> {
    let point = |x: &Option<i32>, y: &Option<i32>| match (x, y) {
        (Some(x), Some(y)) => Some((*x, *y)),
        _ => None,
    };
    actions.iter().rev().find_map(|action| match action {
        ChainAction::Move { x, y, .. } => Some((*x, *y)),
        ChainAction::Click { x, y, .. } => point(x, y),
        ChainAction::Drag { to, .. } => Some(*to),
        ChainAction::Scroll { x, y, .. } => point(x, y),
        ChainAction::MousePress { x, y, .. } => point(x, y),
        ChainAction::TypeText { x, y, .. } => point(x, y),
        _ => None,
    })
}

// ---------- 动作落点判定 ----------

/// 把「动作是否落在目标上」写入结果：
///
/// - `landedOnTarget`：true = 动作后前台窗口覆盖动作点（输入确实落到窗口上）；
///   false = 动作点上有窗口但前台窗口不是它（输入可能被系统丢弃）；
///   null = 无法确认（无桌面会话、缺少权限、点不在任何可枚举窗口上）。
/// - `focusedWindow`：动作结束时的前台窗口（app / title / bounds），
///   模型据此核对输入是否送到了预期的窗口。
/// - `warning`：仅当判定为「没落到目标上」时附加，给出 activation_blocked
///   的下一步动作，避免模型原样重试。
fn attach_target_report(result: &mut Value, point: Option<(i32, i32)>) {
    let focused = window::focused_window();
    let landed = point.and_then(|(x, y)| match focused.as_ref() {
        None => None,
        Some(window) if window.contains(x, y) => Some(true),
        Some(window) => match window::window_at_point(x, y) {
            // macOS 的焦点是应用级：目标点窗口与前台窗口同属一个应用也算命中
            Some(target) if !window.app.is_empty() && window.app == target.app => Some(true),
            Some(_) => Some(false),
            None => None,
        },
    });
    result["landedOnTarget"] = match landed {
        Some(landed) => json!(landed),
        None => Value::Null,
    };
    result["focusedWindow"] = match focused {
        Some(window) => window.to_json(),
        None => Value::Null,
    };
    if landed == Some(false) {
        result["warning"] = json!({
            "code": ErrorKind::ActivationBlocked.code(),
            "message": format!(
                "The input was dispatched, but no focused window covers the action point. {}",
                ErrorKind::ActivationBlocked.guidance()
            ),
        });
    }
}

// ---------- 参数辅助 ----------

fn napi_error(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
}

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"computer-use\". Available tools: [screen, act]"
        ),
    )
}

/// 读取可选的 (x, y) 点对：两者必须同时提供或同时省略。
fn optional_point_pair(args: &Value) -> napi::Result<(Option<i32>, Option<i32>)> {
    let x = optional_i32(args, "x")?;
    let y = optional_i32(args, "y")?;
    match (x, y) {
        (Some(_), None) | (None, Some(_)) => Err(napi_error(
            "x and y must be provided together".to_string(),
        )),
        pair => Ok(pair),
    }
}

fn required_i32(args: &Value, field: &str) -> napi::Result<i32> {
    let raw = numeric_field(args, field)
        .ok_or_else(|| napi_error(format!("{field} is required and must be a number")))?;
    i32::try_from(raw.round() as i64)
        .map_err(|_| napi_error(format!("{field} is out of the i32 range")))
}

fn optional_i32(args: &Value, field: &str) -> napi::Result<Option<i32>> {
    match numeric_field(args, field) {
        None => Ok(None),
        Some(raw) => Ok(Some(
            i32::try_from(raw.round() as i64)
                .map_err(|_| napi_error(format!("{field} is out of the i32 range")))?,
        )),
    }
}

/// 提取字段数值（模型可能传 1000 或 1000.0 两种 JSON 形式）。
fn numeric_field(args: &Value, field: &str) -> Option<f64> {
    match args.get(field) {
        None | Some(Value::Null) => None,
        Some(value) => value.as_f64(),
    }
}

/// 提取字段原始非负整数（用于「省略=默认、显式数值=精确控制」的参数，如 drag durationMs）。
fn raw_i64(args: &Value, field: &str) -> Option<u64> {
    numeric_field(args, field)
        .filter(|value| *value >= 0.0)
        .map(|value| value.round() as u64)
}

fn bounded_u64(args: &Value, field: &str, default: u64, minimum: u64, maximum: u64) -> u64 {
    // 兼容 100 与 1000.0 两种 JSON 数字形式
    numeric_field(args, field)
        .filter(|value| *value >= 0.0)
        .map(|value| value.round() as u64)
        .unwrap_or(default)
        .clamp(minimum, maximum)
}

fn optional_str<'a>(args: &'a Value, field: &str, default: &'a str) -> std::borrow::Cow<'a, str> {
    match args.get(field).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => std::borrow::Cow::Owned(value.trim().to_string()),
        _ => std::borrow::Cow::Borrowed(default),
    }
}

fn required_str(args: &Value, field: &str) -> napi::Result<String> {
    let value = args
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| napi_error(format!("{field} is required and must be a non-empty string")))?;
    Ok(value.to_string())
}

fn required_string_array(
    args: &Value,
    field: &str,
    min_items: usize,
    max_items: usize,
) -> napi::Result<Vec<String>> {
    let items = args
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| napi_error(format!("{field} is required and must be an array of strings")))?;
    if items.len() < min_items || items.len() > max_items {
        return Err(napi_error(format!(
            "{field} must contain between {min_items} and {max_items} entries"
        )));
    }
    let mut names = Vec::with_capacity(items.len());
    for item in items {
        let name = item
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                napi_error(format!("{field} entries must be non-empty strings"))
            })?;
        names.push(name.to_string());
    }
    Ok(names)
}

fn optional_bool(args: &Value, field: &str, default: bool) -> bool {
    args.get(field)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}
