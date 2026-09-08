//! perform-actions 连续动作链：JSON 解析、前置校验与结果格式化。
//!
//! 解析阶段完成全部参数校验（含坐标桌面边界检查），任一步骤非法
//! 则整条链拒绝执行（不产生半执行状态）；执行副作用统一走
//! input::run_action_chain 的单次互斥锁，本模块无副作用。

use enigo::{Axis, Button, Key};
use serde_json::{json, Value};

use super::capture::ensure_point_on_desktop;
use super::input::{parse_button, parse_key};
use super::{
    bounded_u64, napi_error, optional_bool, optional_point_pair, optional_str, raw_i64,
    required_i32, required_str, required_string_array,
};

/// 单条动作链长度上限（防误用，同时限制最长持锁时间）。
pub const MAX_CHAIN_ACTIONS: usize = 32;

/// 结构化链动作（字段均为已校验的最终值）。
pub enum ChainAction {
    Move {
        x: i32,
        y: i32,
        duration_ms: u64,
    },
    Click {
        x: Option<i32>,
        y: Option<i32>,
        button: Button,
        clicks: u32,
        interval_ms: u64,
        hold_ms: u64,
        move_duration_ms: u64,
    },
    Drag {
        from: Option<(i32, i32)>,
        to: (i32, i32),
        button: Button,
        hold_ms: u64,
        pre_move_duration_ms: u64,
        duration: Option<u64>,
        release_at_end: bool,
    },
    Scroll {
        amount: i32,
        axis: Axis,
        x: Option<i32>,
        y: Option<i32>,
    },
    MousePress {
        button: Button,
        x: Option<i32>,
        y: Option<i32>,
    },
    MouseRelease {
        button: Button,
    },
    KeyTap {
        keys: Vec<Key>,
        names: Vec<String>,
    },
    KeyPress {
        key: Key,
        name: String,
    },
    KeyRelease {
        key: Key,
        name: String,
    },
    KeyHold {
        key: Key,
        name: String,
        hold_ms: u64,
    },
    TypeText {
        text: String,
        x: Option<i32>,
        y: Option<i32>,
    },
    Wait {
        ms: u64,
    },
}

/// 单步执行结果（detail 为动作摘要，error 为执行错误）。
pub struct ChainStepOutcome {
    pub detail: String,
    pub error: Option<String>,
}

/// 解析并校验整个动作链；任一步非法则报错且不执行任何动作。
pub fn parse_actions(args: &Value) -> napi::Result<Vec<ChainAction>> {
    let actions = args
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| napi_error("actions is required and must be an array".to_string()))?;
    if actions.is_empty() {
        return Err(napi_error(
            "actions must contain at least one action".to_string(),
        ));
    }
    if actions.len() > MAX_CHAIN_ACTIONS {
        return Err(napi_error(format!(
            "actions must contain at most {MAX_CHAIN_ACTIONS} entries (got {})",
            actions.len()
        )));
    }
    let mut parsed = Vec::with_capacity(actions.len());
    for (index, raw) in actions.iter().enumerate() {
        let action = parse_action(raw)
            .map_err(|error| napi_error(format!("actions[{index}]: {}", error.reason)))?;
        parsed.push(action);
    }
    Ok(parsed)
}

fn parse_action(raw: &Value) -> napi::Result<ChainAction> {
    let type_name = raw
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| napi_error("action \"type\" is required".to_string()))?;

    match type_name {
        "move" => {
            let x = required_i32(raw, "x")?;
            let y = required_i32(raw, "y")?;
            let duration_ms = bounded_u64(raw, "durationMs", 0, 0, 5000);
            ensure_point_on_desktop(x, y).map_err(napi_error)?;
            Ok(ChainAction::Move {
                x,
                y,
                duration_ms,
            })
        }
        "click" => {
            let (x, y) = optional_point_pair(raw)?;
            let button = parse_button(&optional_str(raw, "button", "left")).map_err(napi_error)?;
            let clicks = bounded_u64(raw, "clicks", 1, 1, 3) as u32;
            let hold_ms = bounded_u64(raw, "holdMs", 0, 0, 10_000);
            let interval_ms = bounded_u64(raw, "intervalMs", 90, 10, 1000);
            let move_duration_ms = bounded_u64(raw, "moveDurationMs", 0, 0, 5000);
            if hold_ms > 0 && clicks > 1 {
                return Err(napi_error(
                    "holdMs (long press) and clicks > 1 are mutually exclusive".to_string(),
                ));
            }
            if let (Some(x), Some(y)) = (x, y) {
                ensure_point_on_desktop(x, y).map_err(napi_error)?;
            }
            Ok(ChainAction::Click {
                x,
                y,
                button,
                clicks,
                interval_ms,
                hold_ms,
                move_duration_ms,
            })
        }
        "drag" => {
            let (x, y) = optional_point_pair(raw)?;
            let to_x = required_i32(raw, "toX")?;
            let to_y = required_i32(raw, "toY")?;
            let button = parse_button(&optional_str(raw, "button", "left")).map_err(napi_error)?;
            let hold_ms = bounded_u64(raw, "holdMs", 120, 0, 10_000);
            let pre_move_duration_ms = bounded_u64(raw, "preMoveDurationMs", 0, 0, 5000);
            let duration = raw_i64(raw, "durationMs").map(|ms| ms.clamp(0, 10_000));
            let release_at_end = optional_bool(raw, "releaseAtEnd", true);
            ensure_point_on_desktop(to_x, to_y).map_err(napi_error)?;
            if let (Some(x), Some(y)) = (x, y) {
                ensure_point_on_desktop(x, y).map_err(napi_error)?;
            }
            Ok(ChainAction::Drag {
                from: x.zip(y),
                to: (to_x, to_y),
                button,
                hold_ms,
                pre_move_duration_ms,
                duration,
                release_at_end,
            })
        }
        "scroll" => {
            let amount = required_i32(raw, "amount")?.clamp(-100, 100);
            let axis = parse_axis(&optional_str(raw, "axis", "vertical"))?;
            let (x, y) = optional_point_pair(raw)?;
            if let (Some(x), Some(y)) = (x, y) {
                ensure_point_on_desktop(x, y).map_err(napi_error)?;
            }
            Ok(ChainAction::Scroll { amount, axis, x, y })
        }
        "mouse-press" => {
            let button = parse_button(&optional_str(raw, "button", "left")).map_err(napi_error)?;
            let (x, y) = optional_point_pair(raw)?;
            if let (Some(x), Some(y)) = (x, y) {
                ensure_point_on_desktop(x, y).map_err(napi_error)?;
            }
            Ok(ChainAction::MousePress { button, x, y })
        }
        "mouse-release" => {
            let button = parse_button(&optional_str(raw, "button", "left")).map_err(napi_error)?;
            Ok(ChainAction::MouseRelease { button })
        }
        "key-tap" => {
            let names = required_string_array(raw, "keys", 1, 8)?;
            let mut keys = Vec::with_capacity(names.len());
            for (index, name) in names.iter().enumerate() {
                let key =
                    parse_key(name).map_err(|error| napi_error(format!("keys[{index}]: {error}")))?;
                keys.push(key);
            }
            Ok(ChainAction::KeyTap { keys, names })
        }
        "key-press" | "key-release" | "key-hold" => {
            let name = required_str(raw, "key")?;
            let key = parse_key(&name).map_err(napi_error)?;
            match type_name {
                "key-press" => Ok(ChainAction::KeyPress { key, name }),
                "key-release" => Ok(ChainAction::KeyRelease { key, name }),
                _ => {
                    let hold_ms = bounded_u64(raw, "holdMs", 500, 50, 10_000);
                    Ok(ChainAction::KeyHold { key, name, hold_ms })
                }
            }
        }
        "type" => {
            let text = required_str(raw, "text")?;
            if text.chars().count() > 10_000 {
                return Err(napi_error(
                    "text is too long (max 10000 characters); split it into multiple type steps"
                        .to_string(),
                ));
            }
            let (x, y) = optional_point_pair(raw)?;
            if let (Some(x), Some(y)) = (x, y) {
                ensure_point_on_desktop(x, y).map_err(napi_error)?;
            }
            Ok(ChainAction::TypeText { text, x, y })
        }
        "wait" => Ok(ChainAction::Wait {
            ms: bounded_u64(raw, "ms", 250, 10, 2000),
        }),
        other => Err(napi_error(format!(
            "unknown action type \"{other}\". Supported: move, click, drag, scroll, \
             mouse-press, mouse-release, key-tap, key-press, key-release, key-hold, type, wait"
        ))),
    }
}

fn parse_axis(name: &str) -> napi::Result<Axis> {
    match name {
        "vertical" => Ok(Axis::Vertical),
        "horizontal" => Ok(Axis::Horizontal),
        other => Err(napi_error(format!(
            "axis must be \"vertical\" or \"horizontal\", got \"{other}\""
        ))),
    }
}

/// 生成动作的人类可读摘要（进入步骤结果，供模型与用户核对）。
pub fn describe_action(action: &ChainAction) -> String {
    let button = |button: &Button| format!("{button:?}").to_ascii_lowercase();
    match action {
        ChainAction::Move {
            x,
            y,
            duration_ms,
        } => {
            if *duration_ms > 0 {
                format!("move to ({x}, {y}) over {duration_ms}ms")
            } else {
                format!("move to ({x}, {y})")
            }
        }
        ChainAction::Click {
            x,
            y,
            button: b,
            clicks,
            hold_ms,
            ..
        } => {
            let target = point_text(*x, *y);
            if *hold_ms > 0 {
                format!("long-press {} for {hold_ms}ms at {target}", button(b))
            } else if *clicks > 1 {
                format!("{} click x{clicks} at {target}", button(b))
            } else {
                format!("{} click at {target}", button(b))
            }
        }
        ChainAction::Drag {
            from,
            to,
            button: b,
            ..
        } => {
            let start = from
                .map(|(x, y)| format!("({x}, {y})"))
                .unwrap_or_else(|| "current position".to_string());
            format!("drag {} from {start} to ({}, {})", button(b), to.0, to.1)
        }
        ChainAction::Scroll {
            amount,
            axis,
            x,
            y,
        } => {
            let axis_name = if matches!(axis, Axis::Vertical) {
                "vertical"
            } else {
                "horizontal"
            };
            let at = match (x, y) {
                (Some(x), Some(y)) => format!(" at ({x}, {y})"),
                _ => String::new(),
            };
            format!("scroll {amount} {axis_name}{at}")
        }
        ChainAction::MousePress { button: b, x, y } => {
            format!("press {} at {}", button(b), point_text(*x, *y))
        }
        ChainAction::MouseRelease { button: b } => format!("release {}", button(b)),
        ChainAction::KeyTap { names, .. } => format!("key-tap {}", names.join("+")),
        ChainAction::KeyPress { name, .. } => format!("press key {name}"),
        ChainAction::KeyRelease { name, .. } => format!("release key {name}"),
        ChainAction::KeyHold { name, hold_ms, .. } => {
            format!("hold key {name} for {hold_ms}ms")
        }
        ChainAction::TypeText { text, x, y } => {
            let preview: String = text.chars().take(40).collect();
            let suffix = if text.chars().count() > 40 {
                "..."
            } else {
                ""
            };
            let at = match (x, y) {
                (Some(x), Some(y)) => format!(" at ({x}, {y})"),
                _ => String::new(),
            };
            format!("type \"{preview}{suffix}\"{at}")
        }
        ChainAction::Wait { ms } => format!("wait {ms}ms"),
    }
}

fn point_text(x: Option<i32>, y: Option<i32>) -> String {
    match (x, y) {
        (Some(x), Some(y)) => format!("({x}, {y})"),
        _ => "current position".to_string(),
    }
}

/// 组装 perform-actions 结果 JSON：逐步结果 + 失败定位 + 结束光标。
pub fn format_result(
    total: usize,
    outcomes: &[ChainStepOutcome],
    cursor: Option<(i32, i32)>,
) -> Value {
    let failed_index = outcomes
        .iter()
        .position(|outcome| outcome.error.is_some());
    let performed = outcomes.len();
    let completed = failed_index.is_none() && performed == total;

    let steps: Vec<Value> = outcomes
        .iter()
        .enumerate()
        .map(|(index, outcome)| {
            let mut step = json!({
                "index": index,
                "ok": outcome.error.is_none(),
                "detail": outcome.detail,
            });
            if let Some(error) = &outcome.error {
                step["error"] = json!(error);
            }
            step
        })
        .collect();

    let mut result = json!({
        "performed": performed,
        "total": total,
        "completed": completed,
        "failedIndex": failed_index,
        "steps": steps,
        "cursor": cursor.map(|(x, y)| json!({"x": x, "y": y})).unwrap_or(Value::Null),
    });
    if let Some(index) = failed_index {
        let outcome = &outcomes[index];
        let reason = outcome.error.as_deref().unwrap_or_default();
        result["error"] = if performed < total {
            json!(format!(
                "Action {index} ({}) failed and the chain was ABORTED: {reason}. Steps 0..{index} executed OK, steps {}..{} were skipped. Screenshot to recover, then re-send the remaining steps.",
                outcome.detail, index + 1, total
            ))
        } else {
            json!(format!(
                "Action {} ({}) failed: {reason}.",
                index, outcome.detail
            ))
        };
    }
    result
}
