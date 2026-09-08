use super::*;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

pub(crate) fn validate_and_normalize_args(tool_name: &str, args: &Value) -> napi::Result<Value> {
    let object = args.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Arguments for browser-{tool_name} must be a JSON object"),
        )
    })?;
    let mut normalized = object.clone();

    match tool_name {
        "create" => {
            if let Some(url) = optional_non_empty_string(args, "url")? {
                validate_web_url(url)?;
            }
        }
        "navigate" => {
            optional_non_empty_string(args, "instanceId")?;
            let url = required_non_empty_string(args, "url", tool_name)?;
            validate_web_url(url)?;
            let timeout = bounded_u64(
                args,
                "timeoutMs",
                DEFAULT_TIMEOUT_MS,
                MIN_TIMEOUT_MS,
                MAX_TIMEOUT_MS,
            )?;
            normalized.insert("timeoutMs".to_string(), json!(timeout));
        }
        "click" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let text = optional_non_empty_string(args, "text")?;
            let ref_value = optional_non_empty_string(args, "ref")?;
            if selector.is_none() && text.is_none() && ref_value.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector, text, or ref is required for browser-click".to_string(),
                ));
            }
            optional_boolean(args, "exact")?;
        }
        "screenshot" => {
            optional_non_empty_string(args, "instanceId")?;
            optional_boolean(args, "fullPage")?;
        }
        "devtools" => {
            optional_non_empty_string(args, "instanceId")?;
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("snapshot");
            if !matches!(
                action,
                "snapshot"
                    | "console"
                    | "open"
                    | "network"
                    | "network_detail"
                    | "network_clear"
                    | "networkDetails"
                    | "networkState"
                    | "route"
                    | "routeClear"
                    | "storageSave"
                    | "storageRestore"
                    | "cookies"
                    | "cookieDelete"
                    | "ax"
                    | "trace"
                    | "dialog"
            ) {
                return Err(Error::new(
                    Status::InvalidArg,
                    "action must be one of snapshot, console, open, network, network_detail, network_clear, networkDetails, networkState, route, routeClear, storageSave, storageRestore, cookies, cookieDelete, ax, trace, or dialog for browser-devtools"
                        .to_string(),
                ));
            }
            optional_boolean(args, "clearConsole")?;
            if let Some(level) = optional_non_empty_string(args, "level")? {
                if !matches!(level, "verbose" | "info" | "warning" | "error") {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "level must be one of verbose, info, warning, or error for browser-devtools"
                            .to_string(),
                    ));
                }
            }
            if let Some(filter) = optional_non_empty_string(args, "filter")? {
                if regex::Regex::new(filter).is_err() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "filter must be a valid regular expression for browser-devtools"
                            .to_string(),
                    ));
                }
            }
            optional_boolean(args, "static")?;
            let limit = bounded_u64(args, "limit", 50, 1, 200)?;
            if let Some(response) = args.get("dialogResponse") {
                if !response.is_object() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "dialogResponse must be an object for browser-devtools".to_string(),
                    ));
                }
                let accept = response.get("accept").and_then(Value::as_bool);
                if accept.is_none() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "dialogResponse.accept must be a boolean for browser-devtools".to_string(),
                    ));
                }
                optional_non_empty_string(response, "promptText")?;
            }
            let max_content_length = bounded_u64(
                args,
                "maxContentLength",
                DEFAULT_MAX_CONTENT_LENGTH,
                MIN_MAX_CONTENT_LENGTH,
                MAX_MAX_CONTENT_LENGTH,
            )?;
            // networkDetails：requestId 必填，maxBodyBytes 限界。
            if action == "networkDetails" {
                required_non_empty_string(args, "requestId", "devtools")?;
                let max_body_bytes = bounded_u64(args, "maxBodyBytes", 131_072, 1024, 1_048_576)?;
                normalized.insert("maxBodyBytes".to_string(), json!(max_body_bytes));
            }
            // networkState：state 必填且限枚举。
            if action == "networkState" {
                let state = required_non_empty_string(args, "state", "devtools")?;
                if !matches!(state, "online" | "offline") {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "state must be online or offline for browser-devtools networkState"
                            .to_string(),
                    ));
                }
            }
            // route：pattern 必填；status 限 100-599；headers 必须为字符串映射。
            if action == "route" {
                required_non_empty_string(args, "pattern", "devtools")?;
                optional_non_empty_string(args, "body")?;
                optional_non_empty_string(args, "contentType")?;
                if let Some(status) = args.get("status") {
                    if !status.is_null() {
                        let code = status.as_u64().ok_or_else(|| {
                            Error::new(
                                Status::InvalidArg,
                                "status must be an integer for browser-devtools route".to_string(),
                            )
                        })?;
                        if !(100..=599).contains(&code) {
                            return Err(Error::new(
                                Status::InvalidArg,
                                "status must be between 100 and 599 for browser-devtools route"
                                    .to_string(),
                            ));
                        }
                    }
                }
                if let Some(headers) = args.get("headers") {
                    if !headers.is_null() {
                        let obj = headers.as_object().ok_or_else(|| {
                            Error::new(
                                Status::InvalidArg,
                                "headers must be an object for browser-devtools route".to_string(),
                            )
                        })?;
                        for value in obj.values() {
                            if !value.is_string() {
                                return Err(Error::new(
                                    Status::InvalidArg,
                                    "headers values must be strings for browser-devtools route"
                                        .to_string(),
                                ));
                            }
                        }
                    }
                }
            }
            // storageSave/storageRestore：文件名白名单（防路径穿越；实际路径由主进程拼接）。
            let validate_state_file_name = |value: Option<&str>| -> napi::Result<()> {
                if let Some(name) = value {
                    let pattern = regex::Regex::new(r"^[A-Za-z0-9._-]{1,100}$")
                        .expect("state file name pattern is static");
                    if !pattern.is_match(name) {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "fileName must match [A-Za-z0-9._-]{1,100} (no path separators) for browser-devtools"
                                .to_string(),
                        ));
                    }
                }
                Ok(())
            };
            if action == "storageSave" {
                validate_state_file_name(optional_non_empty_string(args, "fileName")?)?;
            }
            if action == "storageRestore" {
                let file_name = required_non_empty_string(args, "fileName", "devtools")?;
                validate_state_file_name(Some(file_name))?;
            }
            // cookies：domain 可选，showValues 布尔。
            if action == "cookies" {
                optional_non_empty_string(args, "domain")?;
                optional_boolean(args, "showValues")?;
            }
            // cookieDelete：name + domain 必填（精确定位，避免误删）。
            if action == "cookieDelete" {
                required_non_empty_string(args, "name", "devtools")?;
                required_non_empty_string(args, "domain", "devtools")?;
            }
            // ax：verbose 布尔，maxNodes 限界（默认 200）。
            if action == "ax" {
                optional_boolean(args, "verbose")?;
                let max_nodes = bounded_u64(args, "maxNodes", 200, 1, 1000)?;
                normalized.insert("maxNodes".to_string(), json!(max_nodes));
            }
            // trace：durationMs 限界（默认 3000）。
            if action == "trace" {
                let duration_ms = bounded_u64(args, "durationMs", 3000, 1000, 30_000)?;
                normalized.insert("durationMs".to_string(), json!(duration_ms));
            }
            // network_detail：requestId 必填且为正整数（network 列表中的序号 id）。
            if action == "network_detail" {
                let request_id = args.get("requestId").ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "requestId is required for browser-devtools network_detail".to_string(),
                    )
                })?;
                if request_id.as_u64().is_none() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "requestId must be a positive integer for browser-devtools".to_string(),
                    ));
                }
            }
            normalized.insert("action".to_string(), json!(action));
            normalized.insert("limit".to_string(), json!(limit));
            normalized.insert("maxContentLength".to_string(), json!(max_content_length));
        }
        "evaluate" => {
            optional_non_empty_string(args, "instanceId")?;
            required_non_empty_string(args, "expression", tool_name)?;
        }
        "type" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let text = optional_non_empty_string(args, "text")?;
            let ref_value = optional_non_empty_string(args, "ref")?;
            if selector.is_none() && text.is_none() && ref_value.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector, text, or ref is required for browser-type".to_string(),
                ));
            }
            required_string(args, "value", tool_name)?;
            optional_boolean(args, "submit")?;
            let delay_ms = bounded_u64(args, "delayMs", 0, 0, 1000)?;
            normalized.insert("delayMs".to_string(), json!(delay_ms));
        }
        "wait" => {
            optional_non_empty_string(args, "instanceId")?;
            let time = args.get("time");
            let text = optional_non_empty_string(args, "text")?;
            let text_gone = optional_non_empty_string(args, "textGone")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let selector_gone = optional_non_empty_string(args, "selectorGone")?;
            let has_time = time.is_some() && !time.is_some_and(Value::is_null);
            let has_condition = text.is_some()
                || text_gone.is_some()
                || selector.is_some()
                || selector_gone.is_some();
            if !has_time && !has_condition {
                return Err(Error::new(
                    Status::InvalidArg,
                    "One of time, text, textGone, selector, or selectorGone is required for browser-wait".to_string(),
                ));
            }
            if has_time && has_condition {
                return Err(Error::new(
                    Status::InvalidArg,
                    "time is mutually exclusive with text/textGone/selector/selectorGone for browser-wait".to_string(),
                ));
            }
            if has_time {
                let wait_time = bounded_u64(args, "time", 0, 100, MAX_WAIT_TIME_MS)?;
                normalized.insert("time".to_string(), json!(wait_time));
            }
            if has_condition {
                let timeout = bounded_u64(
                    args,
                    "timeoutMs",
                    DEFAULT_TIMEOUT_MS,
                    MIN_TIMEOUT_MS,
                    MAX_TIMEOUT_MS,
                )?;
                normalized.insert("timeoutMs".to_string(), json!(timeout));
            }
        }
        "hover" | "upload-file" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let text = optional_non_empty_string(args, "text")?;
            let ref_value = optional_non_empty_string(args, "ref")?;
            if selector.is_none() && text.is_none() && ref_value.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Either selector, text, or ref is required for browser-{tool_name}"),
                ));
            }
            // hover：支持精确文本匹配。
            optional_boolean(args, "exact")?;
            if tool_name == "upload-file" {
                let files = args.get("files").and_then(Value::as_array).ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "files must be a non-empty string array for browser-upload-file"
                            .to_string(),
                    )
                })?;
                if files.is_empty() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "files must not be empty for browser-upload-file".to_string(),
                    ));
                }
                for item in files {
                    if !item.is_string() {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "files items must be strings for browser-upload-file".to_string(),
                        ));
                    }
                }
            }
        }
        "back" | "forward" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "press_key" => {
            optional_non_empty_string(args, "instanceId")?;
            required_non_empty_string(args, "key", tool_name)?;
        }
        "select_option" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let text = optional_non_empty_string(args, "text")?;
            if selector.is_none() && text.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector or text is required for browser-select_option".to_string(),
                ));
            }
            optional_boolean(args, "exact")?;
            let values = args.get("values").ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "values is required for browser-select_option".to_string(),
                )
            })?;
            let values_array = values.as_array().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "values must be an array of strings for browser-select_option".to_string(),
                )
            })?;
            if values_array.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "values must not be empty for browser-select_option".to_string(),
                ));
            }
            for value in values_array {
                if value.as_str().is_none() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "values must be an array of strings for browser-select_option".to_string(),
                    ));
                }
            }
        }
        "close" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "focus" => {
            required_non_empty_string(args, "instanceId", tool_name)?;
        }
        "list" => {}
        "get_tab_content" => {
            optional_non_empty_string(args, "instanceId")?;
            let max_length = bounded_u64(
                args,
                "maxLength",
                DEFAULT_MAX_CONTENT_LENGTH,
                MIN_MAX_CONTENT_LENGTH,
                MAX_MAX_CONTENT_LENGTH,
            )?;
            normalized.insert("maxLength".to_string(), json!(max_length));
        }
        _ => return Err(unknown_tool_error(tool_name)),
    }

    Ok(Value::Object(normalized))
}

fn required_string<'a>(args: &'a Value, field: &str, tool_name: &str) -> napi::Result<&'a str> {
    args.get(field).and_then(Value::as_str).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("{field} must be a string for browser-{tool_name}"),
        )
    })
}

fn required_non_empty_string<'a>(
    args: &'a Value,
    field: &str,
    tool_name: &str,
) -> napi::Result<&'a str> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} is required for browser-{tool_name}"),
            )
        })
}

fn optional_non_empty_string<'a>(args: &'a Value, field: &str) -> napi::Result<Option<&'a str>> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Err(Error::new(
                    Status::InvalidArg,
                    format!("{field} must not be empty when provided"),
                ))
            } else {
                Ok(Some(trimmed))
            }
        }
        Some(_) => Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be a string when provided"),
        )),
    }
}

fn optional_boolean(args: &Value, field: &str) -> napi::Result<()> {
    if args
        .get(field)
        .is_some_and(|value| !value.is_null() && !value.is_boolean())
    {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be a boolean when provided"),
        ));
    }
    Ok(())
}

fn bounded_u64(
    args: &Value,
    field: &str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> napi::Result<u64> {
    let value = match args.get(field) {
        None | Some(Value::Null) => default,
        Some(value) => value.as_u64().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} must be a positive integer"),
            )
        })?,
    };

    if !(minimum..=maximum).contains(&value) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be between {minimum} and {maximum}"),
        ));
    }
    Ok(value)
}

fn validate_web_url(url: &str) -> napi::Result<()> {
    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("file://") {
        return Ok(());
    }
    Err(Error::new(
        Status::InvalidArg,
        "Browser URLs must start with http://, https://, or file://".to_string(),
    ))
}

pub(crate) fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"browser\". Available tools: [browser-create, browser-navigate, browser-click, browser-hover, browser-type, browser-select_option, browser-press_key, browser-screenshot, browser-wait, browser-devtools, browser-close, browser-focus, browser-list, browser-evaluate, browser-upload-file, browser-back, browser-forward, browser-get_tab_content]"
        ),
    )
}
