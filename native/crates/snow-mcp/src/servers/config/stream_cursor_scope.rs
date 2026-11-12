//! config 服务 `streamCursor` 作用域：流式指示器（主题设置的 streamCursor 字段）。
//!
//! 真源为 system_settings 主题设置，与「主题 → 流式指示器」同源。
//! 资源文件统一复制进 ~/.snowapp/stream-cursors/，路径记录在 svgPath。
//! 主要用途：让 AI 把用户的 HTML/canvas 原型改写成绘制脚本并直接装上。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

const TOOL_LIST: &str = "list";
const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const CURSOR_KEY: &str = "settings";

const ICON_TYPES: &[&str] = &["dot", "lucide", "snowbot", "custom", "image", "canvas"];

/// 与 src/renderer/components/sidebar/themeSettings/streamCursorIcons.ts 保持一致。
const LUCIDE_NAMES: &[&str] = &[
    "Loader2",
    "Loader",
    "LoaderPinwheel",
    "Aperture",
    "Cog",
    "Fan",
    "Sun",
    "CircleDashed",
    "LifeBuoy",
    "Compass",
    "Disc3",
    "RefreshCw",
    "Crosshair",
    "Shell",
    "Orbit",
    "Atom",
    "Snowflake",
    "Star",
    "Diamond",
];

const WRITABLE_FIELDS: &[&str] = &["iconType", "lucideName", "iconSize", "sourcePath", "script"];

const ICON_SIZE_MIN: f64 = 8.0;
const ICON_SIZE_MAX: f64 = 48.0;

const TYPES_NOTE: &str = "iconType: dot (pulsing dot, default) | lucide (built-in spinning icon, needs lucideName) | snowbot (built-in animated robot) | custom (SVG file, pulse animation) | image (any image incl. GIF, shown as-is without extra animation, height = iconSize, width keeps the aspect ratio) | canvas (JavaScript drawing script). iconSize is 8-48 CSS px. For custom/image/canvas pass value.sourcePath (absolute path; the file is copied into ~/.snowapp/stream-cursors/ and the previous asset is removed); canvas also accepts value.script (inline source) for small scripts.";

const CANVAS_CONTRACT: &str = "CANVAS SCRIPT CONTRACT (iconType=canvas): a classic (non-module) JavaScript file that defines a top-level `function draw(ctx, size, t, dark)`. The host calls it on every animation frame inside a dedicated Web Worker with an OffscreenCanvas: ctx is a CanvasRenderingContext2D that is already cleared and scaled for devicePixelRatio, so draw in CSS pixels inside [0, size] x [0, size]; size is the square edge in CSS px (8-48, user adjustable, so never hardcode it); t is elapsed seconds (multiply it to control speed); dark is true when the app uses the dark theme (use light ink on dark, dark ink on light). Not available: DOM, window, document, matchMedia, import/export, network, app APIs - only plain JS, Math and ctx. Do not start your own requestAnimationFrame loop, do not resize the canvas and do not paint a background (keep it transparent). CONVERTING AN HTML/CANVAS PROTOTYPE: read the prototype, keep its pure drawing helpers and presets verbatim, delete DOM setup (getElementById/createElement/querySelector, buttons, event handlers, rAF loops, canvas.width/style assignments, theme detection), then add draw() that calls the original paint routine; if the original paints at a fixed reference size `ref`, wrap it with ctx.save(); ctx.scale(size / ref, size / ref); ...; ctx.restore(); if it takes a theme flag, pass `dark`; if it has several states/variants, pick one in a constant at the top. Save the result with filesystem-create (e.g. next to the prototype as <name>-cursor.js), check it with `node --check <file>`, then install with config-manage action=set scope=streamCursor key=settings value={iconType:\"canvas\", sourcePath:\"/abs/path/<name>-cursor.js\"} (optionally iconSize). Runtime errors are shown under Settings > Theme > Streaming indicator and the chat indicator falls back to the pulsing dot.";

const APPLY_NOTE: &str = "The app is notified after a successful write, so the chat indicator and the theme settings page update immediately.";

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn lower(path: &str) -> String {
    path.trim().to_ascii_lowercase()
}

fn is_svg(path: &str) -> bool {
    lower(path).ends_with(".svg")
}

fn is_script(path: &str) -> bool {
    let p = lower(path);
    p.ends_with(".js") || p.ends_with(".mjs")
}

/// 已存资源能否沿用到目标类型（与设置页切换规则一致）。
fn asset_fits(icon_type: &str, path: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    match icon_type {
        "custom" => is_svg(path),
        "image" => !is_script(path),
        "canvas" => is_script(path),
        _ => false,
    }
}

fn infer_type_from_source(path: &str) -> &'static str {
    if is_script(path) {
        "canvas"
    } else if is_svg(path) {
        "custom"
    } else {
        "image"
    }
}

/// 粗检脚本是否声明了入口；真正的语法/运行错误由渲染层 Worker 回报。
fn validate_script(code: &str) -> Result<()> {
    if code.trim().is_empty() {
        return Err(invalid("Canvas script is empty"));
    }
    if !code.contains("draw") {
        return Err(invalid(
            "Canvas script must define a top-level function draw(ctx, size, t, dark)",
        ));
    }
    Ok(())
}

fn optional_text(patch: &Map<String, Value>, field: &str) -> Result<Option<String>> {
    match patch.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
        }
        Some(_) => Err(invalid(format!("{field} must be a string"))),
    }
}

fn ensure_key(args: &Value) -> Result<()> {
    let key = args.get("key").and_then(Value::as_str).unwrap_or("").trim();
    if key == CURSOR_KEY {
        Ok(())
    } else {
        Err(invalid(format!(
            "streamCursor only defines the key \"{CURSOR_KEY}\""
        )))
    }
}

fn snapshot(include_script: bool) -> Result<Value> {
    let settings = crate::storage::get_theme_settings()?;
    let cursor = &settings.stream_cursor;
    let mut value = json!({
        "iconType": cursor.icon_type,
        "lucideName": cursor.lucide_name,
        "svgPath": cursor.svg_path,
        "iconSize": cursor.icon_size,
    });
    if include_script && cursor.icon_type == "canvas" && !cursor.svg_path.is_empty() {
        let object = value.as_object_mut().expect("json object");
        match crate::storage::read_theme_stream_cursor_script(cursor.svg_path.clone()) {
            Ok(source) => {
                object.insert("script".to_string(), json!(source));
            }
            Err(error) => {
                object.insert("scriptError".to_string(), json!(error.reason));
            }
        }
    }
    Ok(value)
}

/// 把新资源复制/写入受管目录，返回落盘路径。
fn store_asset(icon_type: &str, source_path: Option<&str>, script: Option<&str>) -> Result<Option<String>> {
    if let Some(code) = script {
        if icon_type != "canvas" {
            return Err(invalid("value.script is only valid for iconType \"canvas\""));
        }
        validate_script(code)?;
        return crate::storage::write_theme_stream_cursor_script(code).map(Some);
    }
    let Some(source) = source_path else {
        return Ok(None);
    };
    if !Path::new(source).is_file() {
        return Err(invalid(format!("sourcePath does not exist or is not a file: {source}")));
    }
    let saved = match icon_type {
        "custom" => {
            if !is_svg(source) {
                return Err(invalid("iconType \"custom\" requires an .svg file; use \"image\" for other image formats"));
            }
            crate::storage::save_theme_stream_cursor_svg(source.to_string())?
        }
        "image" => {
            if is_script(source) {
                return Err(invalid("A script file cannot be used as an image; use iconType \"canvas\""));
            }
            crate::storage::save_theme_stream_cursor_image(source.to_string())?
        }
        "canvas" => {
            if !is_script(source) {
                return Err(invalid("iconType \"canvas\" requires a .js file"));
            }
            let code = std::fs::read_to_string(source).map_err(|error| {
                Error::from_reason(format!("Failed to read canvas script: {error}"))
            })?;
            validate_script(&code)?;
            crate::storage::save_theme_stream_cursor_script(source.to_string())?
        }
        other => {
            return Err(invalid(format!(
                "sourcePath only applies to iconType custom / image / canvas (got \"{other}\")"
            )));
        }
    };
    Ok(Some(saved))
}

fn apply(value: &Value) -> Result<Value> {
    let patch = value.as_object().ok_or_else(|| {
        invalid("streamCursor value must be an object like {iconType: \"canvas\", sourcePath: \"/abs/path/cursor.js\"}")
    })?;
    for field in patch.keys() {
        if !WRITABLE_FIELDS.contains(&field.as_str()) {
            return Err(invalid(format!(
                "{field} is not writable; allowed fields: {}",
                WRITABLE_FIELDS.join(", ")
            )));
        }
    }

    let source_path = optional_text(patch, "sourcePath")?;
    let script = match patch.get("script") {
        None | Some(Value::Null) => None,
        Some(Value::String(code)) => Some(code.as_str()),
        Some(_) => return Err(invalid("script must be a string")),
    };
    if source_path.is_some() && script.is_some() {
        return Err(invalid("Pass either sourcePath or script, not both"));
    }
    let requested_type = optional_text(patch, "iconType")?;
    if let Some(icon_type) = &requested_type {
        if !ICON_TYPES.contains(&icon_type.as_str()) {
            return Err(invalid(format!(
                "Unknown iconType \"{icon_type}\"; available: {}",
                ICON_TYPES.join(", ")
            )));
        }
    }
    let lucide_name = optional_text(patch, "lucideName")?;
    let icon_size = match patch.get("iconSize") {
        None | Some(Value::Null) => None,
        Some(size) => Some(
            size.as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| invalid("iconSize must be a number"))?
                .clamp(ICON_SIZE_MIN, ICON_SIZE_MAX),
        ),
    };

    let mut settings = crate::storage::get_theme_settings()?;
    let previous_path = settings.stream_cursor.svg_path.clone();
    let icon_type = requested_type
        .or_else(|| script.map(|_| "canvas".to_string()))
        .or_else(|| source_path.as_deref().map(|p| infer_type_from_source(p).to_string()))
        .or_else(|| lucide_name.as_ref().map(|_| "lucide".to_string()))
        .unwrap_or_else(|| settings.stream_cursor.icon_type.clone());

    // 资源写入前完成其余校验，避免失败时遗留文件。
    let resolved_lucide = if icon_type == "lucide" {
        let name = lucide_name
            .clone()
            .or_else(|| Some(settings.stream_cursor.lucide_name.clone()).filter(|n| !n.is_empty()))
            .unwrap_or_else(|| LUCIDE_NAMES[0].to_string());
        if !LUCIDE_NAMES.contains(&name.as_str()) {
            return Err(invalid(format!(
                "Unknown lucideName \"{name}\"; available: {}",
                LUCIDE_NAMES.join(", ")
            )));
        }
        name
    } else {
        String::new()
    };
    let needs_asset = matches!(icon_type.as_str(), "custom" | "image" | "canvas");
    if needs_asset && source_path.is_none() && script.is_none() && !asset_fits(&icon_type, &previous_path) {
        return Err(invalid(format!(
            "iconType \"{icon_type}\" needs an asset: pass value.sourcePath{}",
            if icon_type == "canvas" { " or value.script" } else { "" }
        )));
    }

    let new_asset = store_asset(&icon_type, source_path.as_deref(), script)?;

    {
        let cursor = &mut settings.stream_cursor;
        cursor.icon_type = icon_type.clone();
        cursor.lucide_name = resolved_lucide;
        if needs_asset {
            if let Some(path) = &new_asset {
                cursor.svg_path = path.clone();
            }
        } else {
            cursor.svg_path.clear();
        }
        if let Some(size) = icon_size {
            cursor.icon_size = size;
        }
    }

    if let Err(error) = crate::storage::set_theme_settings(settings) {
        if let Some(path) = new_asset {
            let _ = crate::storage::delete_theme_stream_cursor_svg(path);
        }
        return Err(error);
    }
    // 新资源替换成功后清理旧文件，与设置页行为一致。
    if new_asset.is_some() && !previous_path.is_empty() {
        let _ = crate::storage::delete_theme_stream_cursor_svg(previous_path);
    }

    Ok(json!({
        "scope": "streamCursor",
        "key": CURSOR_KEY,
        "note": APPLY_NOTE,
        "value": snapshot(false)?,
    }))
}

fn reset() -> Result<Value> {
    let mut settings = crate::storage::get_theme_settings()?;
    let previous_path = settings.stream_cursor.svg_path.clone();
    settings.stream_cursor.icon_type = "dot".to_string();
    settings.stream_cursor.lucide_name.clear();
    settings.stream_cursor.svg_path.clear();
    crate::storage::set_theme_settings(settings)?;
    let removed = !previous_path.is_empty()
        && crate::storage::delete_theme_stream_cursor_svg(previous_path.clone()).is_ok();
    Ok(json!({
        "scope": "streamCursor",
        "key": CURSOR_KEY,
        "deleted": true,
        "removedAsset": if removed { Value::String(previous_path) } else { Value::Null },
        "note": APPLY_NOTE,
        "value": snapshot(false)?,
    }))
}

/// Dispatches the `config-manage` list/get/set/delete actions for the `streamCursor` scope.
pub(crate) fn execute_stream_cursor_scope(tool_name: &str, args: &Value) -> Result<Value> {
    match tool_name {
        TOOL_LIST => Ok(json!({
            "scope": "streamCursor",
            "file": null,
            "note": TYPES_NOTE,
            "canvasContract": CANVAS_CONTRACT,
            "lucideNames": LUCIDE_NAMES,
            "keys": [{
                "key": CURSOR_KEY,
                "type": "object",
                "sensitive": false,
                "configured": true,
                "value": snapshot(false)?,
            }],
        })),
        TOOL_GET => {
            ensure_key(args)?;
            Ok(json!({
                "scope": "streamCursor",
                "key": CURSOR_KEY,
                "note": TYPES_NOTE,
                "canvasContract": CANVAS_CONTRACT,
                "value": snapshot(true)?,
            }))
        }
        TOOL_SET => {
            ensure_key(args)?;
            let value = args
                .get("value")
                .ok_or_else(|| invalid("value is required for action=set"))?;
            apply(value)
        }
        TOOL_DELETE => {
            ensure_key(args)?;
            reset()
        }
        other => Err(invalid(format!(
            "Unsupported config tool for scope streamCursor: {other}"
        ))),
    }
}
