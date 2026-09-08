//! Computer Use 内置 MCP 服务：AI 查看屏幕（截图）并控制鼠标键盘。
//!
//! 设计要点：
//! - 跨平台：xcap 截屏 + enigo 输入模拟（macOS / Windows / Linux X11）
//! - 全局互斥串行化所有键鼠操作，避免并发事件交错
//! - 鼠标手势覆盖：点按、双击、三击、长按、长按拖拽、平滑拖拽、
//!   滚动，以及 mouse-button 底层原语组合任意自定义手势
//! - perform-actions 连续动作链：单次互斥锁下原子执行多步骤组合
//!   （点击聚焦 -> 输入 -> 回车等一次完成，步骤间不插入其他事件）
//! - 坐标统一使用全局虚拟桌面坐标系，截图结果附带像素->屏幕换算系数
//! - 全部执行体走同步实现，由分发层（call.rs 默认分支）在
//!   spawn_blocking 线程池中调用，绝不阻塞 Node.js / NAPI 线程
//! - macOS 权限预检：辅助功能 / 屏幕录制缺失时返回可行动指引
//!
//! 安全边界：本服务器默认关闭，与 terminal/lsp 同一白名单机制
//! （system_settings DEFAULT_DISABLED_BUILTIN_SERVERS + collect.rs
//! DEFAULT_DISABLED_SERVER_IDS），需在 MCP 面板按项目显式启用，
//! 不受精简模式以外的任何隐式启用路径影响；screen-info 为只读工具，
//! 其余键鼠控制工具均走用户审批流程。

mod capture;
mod chain;
mod input;
mod platform;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use capture::{ensure_point_on_desktop, list_displays, ScreenshotOutput};
use enigo::{Axis, Button};
use input::{parse_button, parse_key};

const SERVER_ID: &str = "computer-use";

/// 所有键鼠工具共享的坐标系说明。
const COORDINATES_DOC: &str = "Coordinates are GLOBAL virtual-desktop pixels: the PRIMARY display's top-left corner is (0,0) and displays left/above it have negative x/y. Call computer-use-screen-info first to learn the display layout and current cursor position.";

/// 截图与鼠标工具配合的标准工作流：一次截图定位全部目标，然后连续执行动作链。
const WORKFLOW_DOC: &str = "WORKFLOW: screenshot -> locate ALL targets you need in that one image -> convert pixel positions to screen coordinates (formula in the screenshot text block) -> chain the actions back-to-back WITHOUT re-screenshotting in between (prefer ONE perform-actions call for multi-step sequences).";

/// 连续操作效率指引：动作工具的结果自带成功确认，动作之间不插入截图。
const EFFICIENCY_DOC: &str = "EFFICIENCY: every screenshot costs a full round-trip. Action tools (mouse-click, type-text, key-tap, perform-actions) report success in their own result - do NOT re-screenshot between consecutive actions. Screenshot again ONLY when the screen visibly changed (new window/dialog/page appeared), an action failed, or you need to locate a target that was not visible in the last screenshot. Example task 'send a chat message': ONE screenshot (locate the input box) -> perform-actions [type at x/y, key-tap enter] -> done, no screenshot in between.";

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
                name: "screen-info".to_string(),
                description: "Read the computer-use environment: the list of displays (index, id, name, global position, size, scaleFactor, primary), the current mouse cursor position, and platform permission status. Read-only, no side effects. ALWAYS call this first when starting a screen task, when you are unsure which display to capture, or when mouse/keyboard tools fail with a permission or bounds error.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screenshot".to_string(),
                description: format!("Capture a screenshot of one display (or a region of it) and return a base64 image the model can SEE (multimodal), plus a text block describing how to map image pixels back to screen coordinates. {COORDINATES_DOC} The optional `region` uses DISPLAY-LOCAL LOGICAL coordinates (top-left of the chosen display is 0,0). `maxWidth` downscales the image to control token cost (default 1280). `format` png is lossless but much larger - use it with a small region when you need a sharp close-up of tiny text. {WORKFLOW_DOC} {EFFICIENCY_DOC}"),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "display": {
                            "type": "number",
                            "description": "Display index from screen-info / the display list order (0 = primary). Default 0.",
                            "minimum": 0,
                            "default": 0
                        },
                        "region": {
                            "type": "object",
                            "description": "Optional crop in display-local LOGICAL coordinates. Use it to zoom into a UI area (e.g. a dialog, a toolbar) without changing display.",
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
                            "description": "Max image width in pixels after downscaling (aspect ratio preserved). Default 1280.",
                            "minimum": 200,
                            "maximum": 4000,
                            "default": 1280
                        },
                        "format": {
                            "type": "string",
                            "enum": ["jpeg", "png"],
                            "description": "Image format: jpeg (smaller, default) or png (lossless, larger).",
                            "default": "jpeg"
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "mouse-move".to_string(),
                description: format!("Move the mouse cursor to global screen coordinates without clicking. Use before a mouse-button press, or when you only need to hover. Set durationMs > 0 for a smooth human-like eased move; 0 (default) teleports instantly. {COORDINATES_DOC}"),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "x": {"type": "number", "description": "Target global X."},
                        "y": {"type": "number", "description": "Target global Y."},
                        "durationMs": {
                            "type": "number",
                            "description": "Total move duration for smooth interpolated motion. 0 (default) = instant teleport.",
                            "minimum": 0,
                            "maximum": 5000,
                            "default": 0
                        }
                    },
                    "required": ["x", "y"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "mouse-click".to_string(),
                description: format!("Click the mouse: single (clicks=1), double (clicks=2, e.g. open file / select word), triple (clicks=3, e.g. select paragraph), or PRESS-AND-HOLD (holdMs > 0, e.g. long-press context menus / drag handles on touch-like UIs). Pass x/y to move-and-click in one step - preferred over a separate mouse-move call (durationMs controls that move). {COORDINATES_DOC} {WORKFLOW_DOC}"),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "x": {"type": "number", "description": "Optional global X to move to before clicking. Omit to click at the current cursor position."},
                        "y": {"type": "number", "description": "Optional global Y to move to before clicking. Must be provided together with x."},
                        "button": {
                            "type": "string",
                            "enum": ["left", "middle", "right", "back", "forward"],
                            "description": "Mouse button. left (default) selects/activates, right opens context menus, middle often opens links in a new tab or pans.",
                            "default": "left"
                        },
                        "clicks": {
                            "type": "number",
                            "minimum": 1,
                            "maximum": 3,
                            "description": "Number of clicks in one gesture: 1 = single click (default), 2 = double click, 3 = triple click.",
                            "default": 1
                        },
                        "holdMs": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 10000,
                            "description": "Press and hold duration in ms before release (long press). 0 (default) = normal quick click. Mutually exclusive with clicks > 1.",
                            "default": 0
                        },
                        "intervalMs": {
                            "type": "number",
                            "minimum": 10,
                            "maximum": 1000,
                            "description": "Gap between successive clicks when clicks > 1. Default 90 - raise it if double clicks register as two singles.",
                            "default": 90
                        },
                        "moveDurationMs": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 5000,
                            "description": "Smooth-move duration to (x, y) before clicking. 0 (default) = instant.",
                            "default": 0
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "mouse-drag".to_string(),
                description: format!("Drag with the mouse: move to the start point, press the button, hold, then travel to the end point and release. Use for moving files/emails, slider handles, text selection, canvas strokes and window edges. LONG-PRESS DRAG: set a large holdMs (e.g. 500-800) when the target only allows dragging after a long press (phone-link emulators, launcher icon rearrange). releaseAtEnd=false keeps the button pressed so you can continue with further mouse-move steps (custom multi-segment drags) - finish with mouse-button action=release. {COORDINATES_DOC}"),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "x": {"type": "number", "description": "Optional start global X. Omit to start from the current cursor position."},
                        "y": {"type": "number", "description": "Optional start global Y. Must be provided together with x."},
                        "toX": {"type": "number", "description": "End global X (required)."},
                        "toY": {"type": "number", "description": "End global Y (required)."},
                        "button": {
                            "type": "string",
                            "enum": ["left", "middle", "right", "back", "forward"],
                            "description": "Button to hold during the drag. Default left; right-drag is common for e.g. browser links to context menus.",
                            "default": "left"
                        },
                        "holdMs": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 10000,
                            "description": "Keep the button pressed at the start point for this long before moving (lets the app register the press). Default 120; set 500-800 for long-press-then-drag UIs; 0 for the fastest drags.",
                            "default": 120
                        },
                        "durationMs": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 10000,
                            "description": "Travel duration from start to end (smooth interpolated). Omit = auto (scaled by distance, 150-800ms); 0 = instant travel."
                        },
                        "preMoveDurationMs": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 5000,
                            "description": "Smooth-move duration to the start point (x, y). 0 (default) = instant.",
                            "default": 0
                        },
                        "releaseAtEnd": {
                            "type": "boolean",
                            "description": "Release the button after reaching the end point. true (default); false keeps it pressed for multi-segment drags (release later via mouse-button).",
                            "default": true
                        }
                    },
                    "required": ["toX", "toY"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "mouse-scroll".to_string(),
                description: format!("Scroll the mouse wheel. Positive amount scrolls DOWN (or RIGHT for horizontal axis), negative scrolls UP / LEFT. Unit = wheel notches (one notch is roughly 3 lines). Optionally pass x/y to move the cursor over the target scrollable area first. {COORDINATES_DOC}"),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "amount": {"type": "number", "description": "Wheel notches to scroll. Positive = down/right, negative = up/left."},
                        "axis": {
                            "type": "string",
                            "enum": ["vertical", "horizontal"],
                            "description": "Scroll axis. Default vertical.",
                            "default": "vertical"
                        },
                        "x": {"type": "number", "description": "Optional global X to move to before scrolling (hover the scrollable region)."},
                        "y": {"type": "number", "description": "Optional global Y to move to before scrolling."}
                    },
                    "required": ["amount"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "mouse-button".to_string(),
                description: format!("Low-level mouse button control: press or release without extra semantics. Pair with mouse-move to compose gestures mouse-click / mouse-drag cannot express (e.g. press at A, travel through several points while held, release at B; or hold two buttons). ALWAYS finish every press with a matching release, otherwise the desktop stays stuck. {COORDINATES_DOC}"),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["press", "release"],
                            "description": "press = button down (optionally after moving to x/y), release = button up."
                        },
                        "button": {
                            "type": "string",
                            "enum": ["left", "middle", "right", "back", "forward"],
                            "description": "Mouse button. Default left.",
                            "default": "left"
                        },
                        "x": {"type": "number", "description": "Optional global X to move to before pressing (ignored on release)."},
                        "y": {"type": "number", "description": "Optional global Y to move to before pressing."}
                    },
                    "required": ["action"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "key-tap".to_string(),
                description: "Tap a key or a key combination (chord). Pass a single key (e.g. [\"enter\"], [\"esc\"], [\"a\"]) or a combination pressed in order (e.g. [\"ctrl\",\"shift\",\"t\"], [\"cmd\",\"c\"] on macOS - use ctrl on Windows/Linux). Modifier keys: ctrl, alt/option, shift, win/cmd/meta. Named keys: enter/return, tab, esc, backspace, delete, insert, space, up, down, left, right, home, end, pageup, pagedown, f1-f20, capslock, printscr, pause, numpad0-9, volume/playback media keys. Any other single character is typed as-is. After typing text into an input, submit it directly with key-tap (e.g. [\"enter\"], or [\"ctrl\",\"enter\"] where the app requires it) - no screenshot in between.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "keys": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Ordered keys. The last key is tapped while the preceding ones are held (chord); a single entry is a plain tap.",
                            "minItems": 1,
                            "maxItems": 8
                        }
                    },
                    "required": ["keys"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "key-button".to_string(),
                description: "Low-level keyboard key control: press, release, or hold a single key for a duration (action=hold = press, wait holdMs, release - e.g. hold an arrow key for continuous navigation, or hold keys that toggle while pressed). Use press/release pairs with mouse-move for key-while-mouse gestures (e.g. hold shift while extending a selection with clicks); ALWAYS release what you press.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["press", "release", "hold"],
                            "description": "press = key down, release = key up, hold = press + wait holdMs + release."
                        },
                        "key": {
                            "type": "string",
                            "description": "Single key name (same names as key-tap)."
                        },
                        "holdMs": {
                            "type": "number",
                            "minimum": 50,
                            "maximum": 10000,
                            "description": "Hold duration for action=hold. Default 500.",
                            "default": 500
                        }
                    },
                    "required": ["action", "key"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "type-text".to_string(),
                description: format!("Type literal text through the OS text-input channel (supports any Unicode incl. CJK - no per-key layout mapping, so do NOT use it for shortcuts; use key-tap for those). Pass x/y to single-click an input field and focus it in the SAME call (focus + type in one step). To submit after typing (chat message, search query), call key-tap right after - no screenshot in between. Text longer than a few hundred chars may be slow - prefer clipboard-style batch entry by typing once into a field. {COORDINATES_DOC}"),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "The exact text to type."
                        },
                        "x": {
                            "type": "number",
                            "description": "Optional global X: single-click here first to focus the target input."
                        },
                        "y": {
                            "type": "number",
                            "description": "Optional global Y for the focus click."
                        }
                    },
                    "required": ["text"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "perform-actions".to_string(),
                description: format!(
                    "Execute a SEQUENCE of mouse/keyboard actions in ONE atomic call under a single input lock - nothing can interleave between steps. Use it whenever consecutive actions belong together (click an input -> type -> tap enter; open a menu -> click an item; press shift -> click -> release shift; drag -> click) instead of issuing one tool call per action. ALL steps are validated BEFORE anything runs - an invalid step rejects the whole call with nothing executed. By default the chain STOPS at the first failing step (the remaining steps usually assume the earlier ones succeeded); set continueOnError=true to run all steps and collect every error. The result lists per-step outcomes (index, detail, ok, error), which steps were skipped, and the final cursor position. Insert a wait step to let the UI animate between actions (menus, dialogs). Max {} steps. {COORDINATES_DOC}",
                    chain::MAX_CHAIN_ACTIONS
                ),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "actions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": chain::MAX_CHAIN_ACTIONS,
                            "description": "Ordered action list. Each item: {\"type\":\"move\",\"x\":..,\"y\":..,\"durationMs\":..} | {\"type\":\"click\",\"x\":..,\"y\":..,\"button\":..,\"clicks\":..,\"holdMs\":..,\"intervalMs\":..,\"moveDurationMs\":..} | {\"type\":\"drag\",\"x\":..,\"y\":..,\"toX\":..,\"toY\":..,\"button\":..,\"holdMs\":..,\"durationMs\":..,\"preMoveDurationMs\":..,\"releaseAtEnd\":..} | {\"type\":\"scroll\",\"amount\":..,\"axis\":..,\"x\":..,\"y\":..} | {\"type\":\"mouse-press\",\"button\":..,\"x\":..,\"y\":..} | {\"type\":\"mouse-release\",\"button\":..} | {\"type\":\"key-tap\",\"keys\":[..]} | {\"type\":\"key-press\",\"key\":\"..\"} | {\"type\":\"key-release\",\"key\":\"..\"} | {\"type\":\"key-hold\",\"key\":\"..\",\"holdMs\":..} | {\"type\":\"type\",\"text\":\"..\",\"x\":..,\"y\":..} | {\"type\":\"wait\",\"ms\":..}. Fields default to the same values as the matching single-action tool. x/y pairs must be given together; for click/type they mean move+single-click first (focus), for scroll/mouse-press they mean hover first, for drag they set the start point. Example: [{\"type\":\"type\",\"text\":\"hello\",\"x\":100,\"y\":200},{\"type\":\"wait\",\"ms\":250},{\"type\":\"key-tap\",\"keys\":[\"enter\"]}].",
                            "items": {
                                "type": "object",
                                "required": ["type"],
                                "properties": {
                                    "type": {
                                        "type": "string",
                                        "enum": ["move", "click", "drag", "scroll", "mouse-press", "mouse-release", "key-tap", "key-press", "key-release", "key-hold", "type", "wait"]
                                    },
                                    "x": {"type": "number", "description": "Global X (move target / click point / drag start / scroll or mouse-press hover)."},
                                    "y": {"type": "number", "description": "Global Y - always paired with x."},
                                    "toX": {"type": "number", "description": "drag: end global X (required for drag)."},
                                    "toY": {"type": "number", "description": "drag: end global Y."},
                                    "button": {
                                        "type": "string",
                                        "enum": ["left", "middle", "right", "back", "forward"],
                                        "description": "Mouse button for click / drag / mouse-press / mouse-release. Default left.",
                                        "default": "left"
                                    },
                                    "clicks": {
                                        "type": "number", "minimum": 1, "maximum": 3,
                                        "description": "click: 1 = single (default), 2 = double, 3 = triple.",
                                        "default": 1
                                    },
                                    "holdMs": {
                                        "type": "number",
                                        "description": "click: press-and-hold duration in ms (mutually exclusive with clicks > 1). drag: pause at the start point before traveling (default 120; 500-800 for long-press-then-drag UIs). key-hold: hold duration (default 500)."
                                    },
                                    "intervalMs": {
                                        "type": "number", "minimum": 10, "maximum": 1000,
                                        "description": "click: gap between successive multi-clicks. Default 90.",
                                        "default": 90
                                    },
                                    "moveDurationMs": {
                                        "type": "number", "minimum": 0, "maximum": 5000,
                                        "description": "click: smooth-move duration to (x, y) before clicking. 0 (default) = instant.",
                                        "default": 0
                                    },
                                    "durationMs": {
                                        "type": "number", "minimum": 0, "maximum": 10000,
                                        "description": "move: total smooth-move duration (0 = instant). drag: travel duration (omit = auto, 150-800ms scaled by distance; 0 = instant)."
                                    },
                                    "preMoveDurationMs": {
                                        "type": "number", "minimum": 0, "maximum": 5000,
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
                                        "description": "scroll axis. Default vertical.",
                                        "default": "vertical"
                                    },
                                    "keys": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "minItems": 1,
                                        "maxItems": 8,
                                        "description": "key-tap: ordered keys; the last is tapped while the preceding are held (same names as the key-tap tool)."
                                    },
                                    "key": {"type": "string", "description": "Single key name for key-press / key-release / key-hold (same names as the key-tap tool)."},
                                    "text": {"type": "string", "description": "type: exact literal text to type (Unicode; not for shortcuts - use key-tap steps)."},
                                    "ms": {
                                        "type": "number", "minimum": 10, "maximum": 2000,
                                        "description": "wait: pause duration in ms (default 250). Use between steps when the UI needs time (menus, animations).",
                                        "default": 250
                                    }
                                }
                            }
                        },
                        "continueOnError": {
                            "type": "boolean",
                            "description": "false (default): stop at the first failing step and skip the rest. true: run all steps and report every error.",
                            "default": false
                        }
                    },
                    "required": ["actions"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            "screen-info" => execute_screen_info(),
            "screenshot" => execute_screenshot(args),
            "mouse-move" => execute_mouse_move(args),
            "mouse-click" => execute_mouse_click(args),
            "mouse-drag" => execute_mouse_drag(args),
            "mouse-scroll" => execute_mouse_scroll(args),
            "mouse-button" => execute_mouse_button(args),
            "key-tap" => execute_key_tap(args),
            "key-button" => execute_key_button(args),
            "type-text" => execute_type_text(args),
            "perform-actions" => execute_perform_actions(args),
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

// ---------- 工具执行 ----------

fn execute_screen_info() -> napi::Result<Value> {
    let displays = list_displays().map_err(napi_error)?;
    let cursor = match input::mouse_location() {
        Ok((x, y)) => json!({"x": x, "y": y}),
        Err(_) => Value::Null,
    };
    let main_display = match input::main_display_size() {
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

fn execute_screenshot(args: &Value) -> napi::Result<Value> {
    let display = bounded_u64(args, "display", 0, 0, 100) as u32;
    let region = match args.get("region") {
        None | Some(Value::Null) => None,
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
    let max_width = bounded_u64(args, "maxWidth", 1280, 200, 4000) as u32;
    let png = optional_str(args, "format", "jpeg") == "png";

    let output = capture::capture_screen(display, region, max_width, png).map_err(napi_error)?;
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
    let text = format!(
        "Screenshot of display {} ({}x{} logical). The attached image is {}x{} pixels ({}). To convert a pixel position (px, py) in this image to the GLOBAL screen coordinate used by the mouse tools: screenX = {} + px * {:.5}, screenY = {} + py * {:.5}. Mouse tools expect exactly these global coordinates.",
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
    );

    // 光标位置（全局坐标 + 若在截取区域内，给出图中像素位置）
    let cursor = match input::mouse_location() {
        Ok((cursor_x, cursor_y)) => {
            let local_x = i64::from(cursor_x) - monitor_x;
            let local_y = i64::from(cursor_y) - monitor_y;
            let in_capture = output.region.map_or(true, |(rx, ry, rw, rh)| {
                local_x >= i64::from(rx)
                    && local_y >= i64::from(ry)
                    && local_x <= i64::from(rx + rw)
                    && local_y <= i64::from(ry + rh)
            }) && local_x >= 0
                && local_y >= 0;
            let image_pixel = if in_capture && scale > 0.0 {
                json!({
                    "x": (local_x as f64 / scale).round(),
                    "y": (local_y as f64 / scale).round(),
                })
            } else {
                Value::Null
            };
            json!({
                "x": cursor_x,
                "y": cursor_y,
                "imagePixel": image_pixel,
            })
        }
        Err(_) => Value::Null,
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

fn execute_mouse_move(args: &Value) -> napi::Result<Value> {
    let x = required_i32(args, "x")?;
    let y = required_i32(args, "y")?;
    let duration = bounded_u64(args, "durationMs", 0, 0, 5000);
    ensure_point_on_desktop(x, y).map_err(napi_error)?;

    let (final_x, final_y) = if duration > 0 {
        input::smooth_move_mouse(x, y, duration)
    } else {
        input::move_mouse_instant(x, y)
    }
    .map_err(napi_error)?;

    Ok(json!({
        "moved": true,
        "x": final_x,
        "y": final_y,
        "motion": if duration > 0 { "smooth" } else { "instant" },
    }))
}

fn execute_mouse_click(args: &Value) -> napi::Result<Value> {
    let (target_x, target_y) = optional_point_pair(args)?;
    let button = parse_button(&optional_str(args, "button", "left")).map_err(napi_error)?;
    let clicks = bounded_u64(args, "clicks", 1, 1, 3) as u32;
    let hold_ms = bounded_u64(args, "holdMs", 0, 0, 10_000);
    let interval_ms = bounded_u64(args, "intervalMs", 90, 10, 1000);
    let move_duration = bounded_u64(args, "moveDurationMs", 0, 0, 5000);

    if hold_ms > 0 && clicks > 1 {
        return Err(napi_error(
            "holdMs (long press) and clicks > 1 are mutually exclusive: a long press is a single press-hold-release gesture"
                .to_string(),
        ));
    }
    if let (Some(x), Some(y)) = (target_x, target_y) {
        ensure_point_on_desktop(x, y).map_err(napi_error)?;
    }

    let (final_x, final_y) = input::click_mouse(
        target_x,
        target_y,
        button,
        clicks,
        interval_ms,
        hold_ms,
        move_duration,
    )
    .map_err(napi_error)?;

    Ok(json!({
        "clicked": true,
        "x": final_x,
        "y": final_y,
        "button": format!("{button:?}").to_ascii_lowercase(),
        "clicks": clicks,
        "holdMs": hold_ms,
    }))
}

fn execute_mouse_drag(args: &Value) -> napi::Result<Value> {
    let (from_x, from_y) = optional_point_pair(args)?;
    let to_x = required_i32(args, "toX")?;
    let to_y = required_i32(args, "toY")?;
    let button = parse_button(&optional_str(args, "button", "left")).map_err(napi_error)?;
    let hold_ms = bounded_u64(args, "holdMs", 120, 0, 10_000);
    let requested_duration = raw_i64(args, "durationMs");
    let pre_move_duration = bounded_u64(args, "preMoveDurationMs", 0, 0, 5000);
    let release_at_end = optional_bool(args, "releaseAtEnd", true);

    ensure_point_on_desktop(to_x, to_y).map_err(napi_error)?;
    if let (Some(x), Some(y)) = (from_x, from_y) {
        ensure_point_on_desktop(x, y).map_err(napi_error)?;
    }

    // 拖动时长：省略 = 按距离自适应（150-800ms）；显式 0 = 瞬移
    let drag_duration = match requested_duration {
        None => {
            let start_x = f64::from(from_x.unwrap_or(0));
            let start_y = f64::from(from_y.unwrap_or(0));
            let distance = ((f64::from(to_x) - start_x).hypot(f64::from(to_y) - start_y)) as u64;
            distance.clamp(150, 800)
        }
        Some(explicit) => explicit.clamp(0, 10_000),
    };

    let (final_x, final_y) = input::drag_mouse(
        from_x.zip(from_y),
        (to_x, to_y),
        button,
        hold_ms,
        pre_move_duration,
        drag_duration,
        release_at_end,
    )
    .map_err(napi_error)?;

    Ok(json!({
        "dragged": true,
        "x": final_x,
        "y": final_y,
        "button": format!("{button:?}").to_ascii_lowercase(),
        "holdMs": hold_ms,
        "durationMs": drag_duration,
        "released": release_at_end,
    }))
}

fn execute_mouse_scroll(args: &Value) -> napi::Result<Value> {
    let amount = required_i32(args, "amount")?.clamp(-100, 100);
    let axis_name = optional_str(args, "axis", "vertical");
    let axis = match axis_name.as_ref() {
        "vertical" => Axis::Vertical,
        "horizontal" => Axis::Horizontal,
        other => {
            return Err(napi_error(format!(
                "axis must be \"vertical\" or \"horizontal\", got \"{other}\""
            )))
        }
    };
    let (target_x, target_y) = optional_point_pair(args)?;
    if let (Some(x), Some(y)) = (target_x, target_y) {
        ensure_point_on_desktop(x, y).map_err(napi_error)?;
        input::move_mouse_instant(x, y).map_err(napi_error)?;
    }

    input::scroll_mouse(amount, axis).map_err(napi_error)?;

    Ok(json!({
        "scrolled": true,
        "amount": amount,
        "axis": if matches!(axis, Axis::Vertical) { "vertical" } else { "horizontal" },
    }))
}

fn execute_mouse_button(args: &Value) -> napi::Result<Value> {
    let action_press = match required_str(args, "action")?.as_str() {
        "press" => true,
        "release" => false,
        other => {
            return Err(napi_error(format!(
                "action must be \"press\" or \"release\", got \"{other}\""
            )))
        }
    };
    let button = parse_button(&optional_str(args, "button", "left")).map_err(napi_error)?;
    let (target_x, target_y) = optional_point_pair(args)?;
    if let (Some(x), Some(y)) = (target_x, target_y) {
        ensure_point_on_desktop(x, y).map_err(napi_error)?;
    }

    let (final_x, final_y) = input::mouse_button(
        action_press,
        button,
        target_x,
        target_y,
        0,
    )
    .map_err(napi_error)?;

    Ok(json!({
        "action": if action_press { "press" } else { "release" },
        "button": format!("{button:?}").to_ascii_lowercase(),
        "x": final_x,
        "y": final_y,
    }))
}

fn execute_key_tap(args: &Value) -> napi::Result<Value> {
    let names = required_string_array(args, "keys", 1, 8)?;
    let mut keys = Vec::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let key = parse_key(name).map_err(|error| {
            napi_error(format!("keys[{index}]: {error}"))
        })?;
        keys.push(key);
    }
    input::tap_keys(&keys).map_err(napi_error)?;

    Ok(json!({
        "tapped": true,
        "keys": names,
    }))
}

fn execute_key_button(args: &Value) -> napi::Result<Value> {
    let action = required_str(args, "action")?;
    let key_name = required_str(args, "key")?;
    let key = parse_key(&key_name).map_err(napi_error)?;

    match action.as_str() {
        "press" => {
            input::key_button(key, true).map_err(napi_error)?;
            Ok(json!({"action": "press", "key": key_name}))
        }
        "release" => {
            input::key_button(key, false).map_err(napi_error)?;
            Ok(json!({"action": "release", "key": key_name}))
        }
        "hold" => {
            let hold_ms = bounded_u64(args, "holdMs", 500, 50, 10_000);
            input::key_button(key, true).map_err(napi_error)?;
            std::thread::sleep(std::time::Duration::from_millis(hold_ms));
            input::key_button(key, false).map_err(napi_error)?;
            Ok(json!({"action": "hold", "key": key_name, "holdMs": hold_ms}))
        }
        other => Err(napi_error(format!(
            "action must be \"press\", \"release\" or \"hold\", got \"{other}\""
        ))),
    }
}

fn execute_type_text(args: &Value) -> napi::Result<Value> {
    let text = required_str(args, "text")?;
    if text.is_empty() {
        return Err(napi_error("text must not be empty".to_string()));
    }
    if text.chars().count() > 10_000 {
        return Err(napi_error(
            "text is too long (max 10000 characters); split it into multiple type-text calls"
                .to_string(),
        ));
    }
    let (target_x, target_y) = optional_point_pair(args)?;
    if let (Some(x), Some(y)) = (target_x, target_y) {
        ensure_point_on_desktop(x, y).map_err(napi_error)?;
        input::click_mouse(Some(x), Some(y), Button::Left, 1, 90, 0, 0)
            .map_err(napi_error)?;
    }

    input::type_text(&text).map_err(napi_error)?;

    let preview: String = text.chars().take(50).collect();
    Ok(json!({
        "typed": text.chars().count(),
        "preview": preview,
    }))
}

fn execute_perform_actions(args: &Value) -> napi::Result<Value> {
    let actions = chain::parse_actions(args)?;
    let continue_on_error = optional_bool(args, "continueOnError", false);
    let (outcomes, cursor) = input::run_action_chain(&actions, continue_on_error)
        .map_err(napi_error)?;
    Ok(chain::format_result(actions.len(), &outcomes, cursor))
}

// ---------- 参数辅助 ----------

fn napi_error(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
}

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"computer-use\". Available tools: [screen-info, screenshot, mouse-move, mouse-click, mouse-drag, mouse-scroll, mouse-button, key-tap, key-button, type-text, perform-actions]"
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
    let raw = numeric_field(args, field).ok_or_else(|| {
        napi_error(format!("{field} is required and must be a number"))
    })?;
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
