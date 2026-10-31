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
    // Only structural identifiers, paths and enums are trimmed. Payload strings
    // (JavaScript, selectors, text, regexes, response bodies and form values) are
    // validated and forwarded verbatim, including significant surrounding spaces.
    for field in [
        "instanceId",
        "frameId",
        "fromFrameId",
        "toFrameId",
        "ref",
        "fromRef",
        "toRef",
        "url",
        "action",
        "format",
        "level",
        "state",
        "contentType",
        "fileName",
        "domain",
        "sourcePath",
        "filePath",
        "requestFilePath",
        "responseFilePath",
        "baseFilePath",
        "currentFilePath",
        "colorScheme",
        "networkConditions",
        "viewport",
        "nodeType",
        "sortBy",
        "insightId",
        "position",
    ] {
        if let Some(Value::String(value)) = normalized.get_mut(field) {
            *value = value.trim().to_string();
        }
    }
    if tool_name == "emulate" {
        // These resets already have concrete renderer/CDP equivalents.
        if normalized.get("colorScheme").is_some_and(Value::is_null) {
            normalized.insert("colorScheme".to_string(), json!("auto"));
        }
        if normalized
            .get("cpuThrottlingRate")
            .is_some_and(Value::is_null)
        {
            normalized.insert("cpuThrottlingRate".to_string(), json!(1));
        }
    }
    if tool_name == "fill_form" {
        if let Some(Value::Array(elements)) = normalized.get_mut("elements") {
            for element in elements {
                if let Some(Value::String(value)) = element.get_mut("ref") {
                    *value = value.trim().to_string();
                }
            }
        }
    }
    // Validate exactly the values that will cross the Electron bridge.
    let input = Value::Object(normalized.clone());
    let args = &input;
    if let Some(frame_id) = optional_non_empty_string(args, "frameId")? {
        if !matches!(
            tool_name,
            "evaluate"
                | "get_tab_content"
                | "wait"
                | "click"
                | "type"
                | "fill_form"
                | "hover"
                | "select_option"
                | "upload-file"
                | "devtools"
                | "scroll"
                | "press_key"
                | "get_css_styles"
                | "audit"
        ) {
            return Err(Error::new(
                Status::InvalidArg,
                "frameId is not supported for this browser tool".to_string(),
            ));
        }
        validate_frame_id(frame_id)?;
        if tool_name == "devtools"
            && !matches!(
                args.get("action")
                    .and_then(Value::as_str)
                    .unwrap_or("snapshot"),
                "snapshot" | "ax" | "console" | "network"
            )
        {
            return Err(Error::new(
                Status::InvalidArg,
                "frameId supports only devtools snapshot/ax/console/network".to_string(),
            ));
        }
        normalized.insert("frameId".to_string(), json!(frame_id));
    }

    match tool_name {
        "create" => {
            if let Some(url) = optional_non_empty_string(args, "url")? {
                validate_web_url(url)?;
            }
        }
        "navigate" => {
            optional_non_empty_string(args, "instanceId")?;
            optional_boolean(args, "reload")?;
            optional_boolean(args, "ignoreCache")?;
            let reloading = args.get("reload").and_then(Value::as_bool).unwrap_or(false);
            // Empty optional navigation fields are commonly emitted as placeholders.
            // Treat them as omitted, but still require a URL for normal navigation.
            let url = match args.get("url") {
                Some(Value::String(value)) if value.trim().is_empty() => None,
                _ => optional_non_empty_string(args, "url")?,
            };
            if url.is_none() {
                normalized.remove("url");
            }
            if reloading {
                if url.is_some() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "url cannot be combined with reload=true for browser-navigate".to_string(),
                    ));
                }
            } else {
                let url = url.ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "url is required for browser-navigate unless reload=true".to_string(),
                    )
                })?;
                validate_web_url(url)?;
            }
            if let Some(init_script) = args.get("initScript") {
                if !init_script.is_null() && !init_script.is_string() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "initScript must be a string for browser-navigate".to_string(),
                    ));
                }
                if init_script.is_null()
                    || init_script
                        .as_str()
                        .is_some_and(|value| value.trim().is_empty())
                {
                    normalized.remove("initScript");
                }
            }
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
            let x = optional_number(args, "x")?;
            let y = optional_number(args, "y")?;
            let has_element_target = selector.is_some() || text.is_some() || ref_value.is_some();
            if x.is_some() != y.is_some() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "x and y must be provided together for browser-click".to_string(),
                ));
            }
            if x.is_some() && has_element_target {
                return Err(Error::new(
                    Status::InvalidArg,
                    "x/y coordinates are mutually exclusive with selector/text/ref for browser-click".to_string(),
                ));
            }
            if x.is_none() && !has_element_target {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector, text, ref, or x+y is required for browser-click".to_string(),
                ));
            }
            if x.is_some() && args.get("frameId").is_some_and(|value| !value.is_null()) {
                return Err(Error::new(
                    Status::InvalidArg,
                    "x/y coordinate clicks are not supported with frameId for browser-click; use selector/text/ref".to_string(),
                ));
            }
            optional_boolean(args, "exact")?;
            optional_boolean(args, "dblClick")?;
            validate_observation_args(args, tool_name, &mut normalized)?;
        }
        "screenshot" => {
            optional_non_empty_string(args, "instanceId")?;
            optional_boolean(args, "fullPage")?;
            if let Some(format) = optional_non_empty_string(args, "format")? {
                if !matches!(format, "png" | "jpeg" | "webp") {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "format must be one of png, jpeg, or webp for browser-screenshot"
                            .to_string(),
                    ));
                }
            }
            if let Some(quality) = args.get("quality") {
                if !quality.is_null() {
                    let value = quality.as_u64().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "quality must be an integer between 0 and 100 for browser-screenshot"
                                .to_string(),
                        )
                    })?;
                    if value > 100 {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "quality must be between 0 and 100 for browser-screenshot".to_string(),
                        ));
                    }
                }
            }
            let selector = optional_non_empty_string(args, "selector")?;
            let ref_value = optional_non_empty_string(args, "ref")?;
            optional_boolean(args, "exact")?;
            let full_page = args
                .get("fullPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if (selector.is_some() || ref_value.is_some()) && full_page {
                return Err(Error::new(
                    Status::InvalidArg,
                    "fullPage cannot be combined with selector/ref for browser-screenshot"
                        .to_string(),
                ));
            }
            if let Some(path) = optional_non_empty_string(args, "filePath")? {
                validate_absolute_path(path, "filePath")?;
            }
        }
        "devtools" => {
            optional_non_empty_string(args, "instanceId")?;
            let action = optional_non_empty_string(args, "action")?.unwrap_or("snapshot");
            if !matches!(
                action,
                "snapshot"
                    | "console"
                    | "console_message"
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
                    "action must be one of snapshot, console, console_message, open, network, network_detail, network_clear, networkDetails, networkState, route, routeClear, storageSave, storageRestore, cookies, cookieDelete, ax, trace, or dialog for browser-devtools"
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
            optional_boolean(args, "includePreserved")?;
            optional_boolean(args, "includeHeaders")?;
            if let Some(value) = optional_bounded_u64(args, "pageIdx", 0, 1000)? {
                normalized.insert("pageIdx".to_string(), json!(value));
            }
            if let Some(value) = optional_bounded_u64(args, "pageSize", 1, 1000)? {
                normalized.insert("pageSize".to_string(), json!(value));
            }
            if let Some(limit) = optional_bounded_u64(args, "limit", 1, 200)? {
                normalized.insert("limit".to_string(), json!(limit));
            }
            validate_string_array(args, "types", 30)?;
            validate_string_array(args, "resourceTypes", 30)?;
            validate_string_array(args, "methods", 30)?;
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
                if response.get("promptText").is_some() {
                    required_string(response, "promptText", "devtools")?;
                }
            }
            let max_content_length = bounded_u64(
                args,
                "maxContentLength",
                DEFAULT_MAX_CONTENT_LENGTH,
                MIN_MAX_CONTENT_LENGTH,
                MAX_MAX_CONTENT_LENGTH,
            )?;
            // networkDetails：requestId 必填，maxBodyBytes 限界，body 落盘路径校验。
            if action == "networkDetails" {
                required_non_empty_string(args, "requestId", "devtools")?;
                let max_body_bytes = bounded_u64(args, "maxBodyBytes", 131_072, 1024, 1_048_576)?;
                normalized.insert("maxBodyBytes".to_string(), json!(max_body_bytes));
                for field in ["requestFilePath", "responseFilePath"] {
                    if let Some(path) = optional_non_empty_string(args, field)? {
                        validate_absolute_path(path, field)?;
                    }
                }
            }
            // console_message：msgid 必填且为正整数。
            if action == "console_message" {
                let msgid = args.get("msgid").ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "msgid is required for browser-devtools console_message".to_string(),
                    )
                })?;
                if !msgid.as_u64().is_some_and(|value| value > 0) {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "msgid must be a positive integer for browser-devtools".to_string(),
                    ));
                }
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
                if args.get("body").is_some() {
                    required_string(args, "body", "devtools")?;
                }
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
                let id = request_id.as_u64().or_else(|| {
                    let value = request_id.as_str()?.trim();
                    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                        return None;
                    }
                    value.parse::<u64>().ok()
                }).filter(|value| (1..=MAX_SAFE_RECORD_ID).contains(value)).ok_or_else(|| Error::new(
                    Status::InvalidArg,
                    "requestId must be a positive safe integer record id (1-9007199254740991) for browser-devtools network_detail".to_string(),
                ))?;
                normalized.insert("requestId".to_string(), json!(id));
            }
            normalized.insert("action".to_string(), json!(action));
            normalized.insert("maxContentLength".to_string(), json!(max_content_length));
        }
        "evaluate" => {
            optional_non_empty_string(args, "instanceId")?;
            let expression = optional_non_empty_string(args, "expression")?;
            let function = optional_non_empty_string(args, "function")?;
            let source_path = optional_non_empty_string(args, "sourcePath")?;
            let provided = [
                expression.is_some(),
                function.is_some(),
                source_path.is_some(),
            ]
            .iter()
            .filter(|value| **value)
            .count();
            if provided == 0 {
                return Err(Error::new(
                    Status::InvalidArg,
                    "One of expression, function, or sourcePath is required for browser-evaluate"
                        .to_string(),
                ));
            }
            if provided > 1 {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Provide only one of expression, function, or sourcePath for browser-evaluate"
                        .to_string(),
                ));
            }
            if let Some(path) = source_path {
                validate_absolute_path(path, "sourcePath")?;
            }
            if let Some(format) = optional_non_empty_string(args, "format")? {
                if !matches!(format, "script" | "function") {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "format must be script or function for browser-evaluate".to_string(),
                    ));
                }
            }
            if let Some(call_args) = args.get("args") {
                if !call_args.is_null() && !call_args.is_array() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "args must be an array for browser-evaluate".to_string(),
                    ));
                }
            }
            optional_boolean(args, "waitForStableDom")?;
            if let Some(path) = optional_non_empty_string(args, "filePath")? {
                validate_absolute_path(path, "filePath")?;
            }
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
            validate_observation_args(args, tool_name, &mut normalized)?;
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
        "drag" => {
            optional_non_empty_string(args, "instanceId")?;
            if args.get("frameId").is_some_and(|value| !value.is_null()) {
                return Err(Error::new(
                    Status::InvalidArg,
                    "drag does not take frameId; use fromFrameId/toFrameId instead".to_string(),
                ));
            }
            let from_selector = optional_non_empty_string(args, "fromSelector")?;
            let from_text = optional_non_empty_string(args, "fromText")?;
            let from_ref = optional_non_empty_string(args, "fromRef")?;
            if from_selector.is_none() && from_text.is_none() && from_ref.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either fromSelector, fromText, or fromRef is required for browser-drag"
                        .to_string(),
                ));
            }
            let to_selector = optional_non_empty_string(args, "toSelector")?;
            let to_text = optional_non_empty_string(args, "toText")?;
            let to_ref = optional_non_empty_string(args, "toRef")?;
            if to_selector.is_none() && to_text.is_none() && to_ref.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either toSelector, toText, or toRef is required for browser-drag".to_string(),
                ));
            }
            optional_boolean(args, "fromExact")?;
            optional_boolean(args, "toExact")?;
            for field in ["fromFrameId", "toFrameId"] {
                if let Some(frame_id) = optional_non_empty_string(args, field)? {
                    validate_frame_id(frame_id)?;
                }
            }
        }
        "fill_form" => {
            optional_non_empty_string(args, "instanceId")?;
            let elements = args
                .get("elements")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "elements must be a non-empty array for browser-fill_form".to_string(),
                    )
                })?;
            if elements.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "elements must not be empty for browser-fill_form".to_string(),
                ));
            }
            if elements.len() > 50 {
                return Err(Error::new(
                    Status::InvalidArg,
                    "elements supports at most 50 items for browser-fill_form".to_string(),
                ));
            }
            for item in elements {
                let entry = item.as_object().ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "each elements item must be an object for browser-fill_form".to_string(),
                    )
                })?;
                for field in ["selector", "text", "ref"] {
                    optional_non_empty_string(item, field)?;
                }
                let has_target = ["selector", "text", "ref"].iter().any(|key| {
                    entry
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                });
                if !has_target {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "each elements item requires selector, text, or ref for browser-fill_form"
                            .to_string(),
                    ));
                }
                if !entry.get("value").is_some_and(Value::is_string) {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "each elements item requires a string value for browser-fill_form"
                            .to_string(),
                    ));
                }
                if entry
                    .get("submit")
                    .is_some_and(|value| !value.is_null() && !value.is_boolean())
                {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "submit must be a boolean for browser-fill_form".to_string(),
                    ));
                }
            }
            validate_observation_args(args, tool_name, &mut normalized)?;
        }
        "back" | "forward" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "press_key" => {
            optional_non_empty_string(args, "instanceId")?;
            required_non_empty_string(args, "key", tool_name)?;
            validate_observation_args(args, tool_name, &mut normalized)?;
        }
        "scroll" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let ref_value = optional_non_empty_string(args, "ref")?;
            if selector.is_some() && ref_value.is_some() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "selector and ref are mutually exclusive for browser-scroll".to_string(),
                ));
            }
            let position = optional_non_empty_string(args, "position")?;
            let delta = match args.get("deltaY") {
                None | Some(Value::Null) => None,
                Some(value) => Some(
                    value
                        .as_f64()
                        .filter(|number| number.is_finite())
                        .ok_or_else(|| {
                            Error::new(
                                Status::InvalidArg,
                                "deltaY must be an integer for browser-scroll".to_string(),
                            )
                        })?
                        .round() as i64,
                ),
            };
            match (delta, position) {
                (Some(_), Some(_)) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "deltaY and position are mutually exclusive for browser-scroll"
                            .to_string(),
                    ));
                }
                (None, None) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "Either deltaY or position is required for browser-scroll".to_string(),
                    ));
                }
                (Some(delta), None) => {
                    if delta == 0 || delta.abs() > MAX_SCROLL_DELTA {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "deltaY must be a non-zero integer between -{MAX_SCROLL_DELTA} and {MAX_SCROLL_DELTA}"
                            ),
                        ));
                    }
                    normalized.insert("deltaY".to_string(), json!(delta));
                }
                (None, Some(position)) => {
                    if !matches!(position, "top" | "bottom") {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "position must be top or bottom for browser-scroll".to_string(),
                        ));
                    }
                }
            }
            validate_observation_args(args, tool_name, &mut normalized)?;
        }
        "select_option" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let text = optional_non_empty_string(args, "text")?;
            let frame_ref = optional_non_empty_string(args, "ref")?;
            if selector.is_none()
                && text.is_none()
                && !(args.get("frameId").is_some_and(Value::is_string) && frame_ref.is_some())
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector, text, or a frame-scoped ref is required for browser-select_option".to_string(),
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
            validate_observation_args(args, tool_name, &mut normalized)?;
        }
        "close" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "focus" => {
            required_non_empty_string(args, "instanceId", tool_name)?;
        }
        "request_share" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "emulate" => {
            optional_non_empty_string(args, "instanceId")?;
            if let Some(scheme) = optional_non_empty_string(args, "colorScheme")? {
                if !matches!(scheme, "dark" | "light" | "auto") {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "colorScheme must be dark, light, or auto for browser-emulate".to_string(),
                    ));
                }
            }
            if let Some(rate) = args.get("cpuThrottlingRate") {
                if !rate.is_null() {
                    let value = rate.as_f64().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "cpuThrottlingRate must be a number for browser-emulate".to_string(),
                        )
                    })?;
                    if !(1.0..=20.0).contains(&value) {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "cpuThrottlingRate must be between 1 and 20 for browser-emulate"
                                .to_string(),
                        ));
                    }
                }
            }
            if let Some(headers) = args.get("extraHttpHeaders") {
                if !headers.is_null() {
                    let obj = headers.as_object().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "extraHttpHeaders must be an object for browser-emulate".to_string(),
                        )
                    })?;
                    for value in obj.values() {
                        if !value.is_string() {
                            return Err(Error::new(
                                Status::InvalidArg,
                                "extraHttpHeaders values must be strings for browser-emulate"
                                    .to_string(),
                            ));
                        }
                    }
                }
            }
            if let Some(geo) = args.get("geolocation") {
                if !geo.is_null() {
                    let obj = geo.as_object().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "geolocation must be an object for browser-emulate".to_string(),
                        )
                    })?;
                    let lat = obj.get("latitude").and_then(Value::as_f64).ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "geolocation.latitude is required for browser-emulate".to_string(),
                        )
                    })?;
                    let lng = obj
                        .get("longitude")
                        .and_then(Value::as_f64)
                        .ok_or_else(|| {
                            Error::new(
                                Status::InvalidArg,
                                "geolocation.longitude is required for browser-emulate".to_string(),
                            )
                        })?;
                    if let Some(accuracy) = geo.get("accuracy") {
                        if !accuracy.as_f64().is_some_and(|value| value >= 0.0) {
                            return Err(Error::new(
                                Status::InvalidArg,
                                "geolocation.accuracy must be a non-negative number".to_string(),
                            ));
                        }
                    }
                    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "geolocation latitude/longitude out of range for browser-emulate"
                                .to_string(),
                        ));
                    }
                }
            }
            if let Some(preset) = optional_non_empty_string(args, "networkConditions")? {
                if !matches!(
                    preset,
                    "Offline" | "Slow 3G" | "Fast 3G" | "Slow 4G" | "Fast 4G"
                ) {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "networkConditions must be one of Offline, Slow 3G, Fast 3G, Slow 4G, or Fast 4G for browser-emulate"
                            .to_string(),
                    ));
                }
            }
            for field in ["userAgent", "viewport"] {
                if let Some(value) = args.get(field) {
                    if !value.is_null() && !value.is_string() {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!("{field} must be a string for browser-emulate"),
                        ));
                    }
                }
            }
        }
        "resize_page" => {
            optional_non_empty_string(args, "instanceId")?;
            let width = args.get("width").and_then(Value::as_u64).ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "width is required for browser-resize_page".to_string(),
                )
            })?;
            let height = args.get("height").and_then(Value::as_u64).ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "height is required for browser-resize_page".to_string(),
                )
            })?;
            if !(50..=8000).contains(&width) || !(50..=8000).contains(&height) {
                return Err(Error::new(
                    Status::InvalidArg,
                    "width and height must be between 50 and 8000 for browser-resize_page"
                        .to_string(),
                ));
            }
        }
        "performance_start_trace" => {
            optional_non_empty_string(args, "instanceId")?;
            validate_string_array(args, "categories", 30)?;
        }
        "performance_stop_trace" => {
            optional_non_empty_string(args, "instanceId")?;
            if let Some(path) = optional_non_empty_string(args, "filePath")? {
                validate_absolute_path(path, "filePath")?;
            }
        }
        "performance_analyze_insight" => {
            optional_non_empty_string(args, "instanceId")?;
            let insight_id = required_non_empty_string(args, "insightId", tool_name)?;
            if !matches!(
                insight_id,
                "long-tasks"
                    | "render-blocking"
                    | "lcp"
                    | "cls"
                    | "document-latency"
                    | "third-parties"
            ) {
                return Err(Error::new(
                    Status::InvalidArg,
                    "insightId must be one of long-tasks, render-blocking, lcp, cls, document-latency, or third-parties for browser-performance_analyze_insight"
                        .to_string(),
                ));
            }
        }
        "get_css_styles" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let ref_value = optional_non_empty_string(args, "ref")?;
            if selector.is_none() && ref_value.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector or ref is required for browser-get_css_styles".to_string(),
                ));
            }
            if let Some(value) = optional_bounded_u64(args, "pageIdx", 0, 1000)? {
                normalized.insert("pageIdx".to_string(), json!(value));
            }
            if let Some(value) = optional_bounded_u64(args, "pageSize", 1, 100)? {
                normalized.insert("pageSize".to_string(), json!(value));
            }
        }
        "audit" => {
            optional_non_empty_string(args, "instanceId")?;
            if let Some(categories) = args.get("categories") {
                if !categories.is_null() {
                    let list = categories.as_array().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "categories must be an array for browser-audit".to_string(),
                        )
                    })?;
                    for item in list {
                        let value = item.as_str().ok_or_else(|| {
                            Error::new(
                                Status::InvalidArg,
                                "categories items must be strings for browser-audit".to_string(),
                            )
                        })?;
                        if !matches!(value, "accessibility" | "seo" | "best-practices") {
                            return Err(Error::new(
                                Status::InvalidArg,
                                "categories items must be accessibility, seo, or best-practices for browser-audit"
                                    .to_string(),
                            ));
                        }
                    }
                }
            }
        }
        "take_heapsnapshot" => {
            optional_non_empty_string(args, "instanceId")?;
            let path = required_non_empty_string(args, "filePath", tool_name)?;
            validate_absolute_path(path, "filePath")?;
        }
        "get_heapsnapshot_summary" | "get_heapsnapshot_duplicate_strings" => {
            let path = required_non_empty_string(args, "filePath", tool_name)?;
            validate_absolute_path(path, "filePath")?;
            if let Some(value) = optional_bounded_u64(args, "topN", 1, 200)? {
                normalized.insert("topN".to_string(), json!(value));
            }
        }
        "query_heapsnapshot_objects" => {
            let path = required_non_empty_string(args, "filePath", tool_name)?;
            validate_absolute_path(path, "filePath")?;
            optional_non_empty_string(args, "className")?;
            optional_non_empty_string(args, "nodeType")?;
            if let Some(value) = args.get("minSelfSize") {
                if !value.is_null() && value.as_u64().is_none() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "minSelfSize must be a non-negative integer for browser-query_heapsnapshot_objects"
                            .to_string(),
                    ));
                }
            }
            optional_boolean(args, "isDetached")?;
            if let Some(sort_by) = optional_non_empty_string(args, "sortBy")? {
                if !matches!(sort_by, "selfSize" | "id") {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "sortBy must be selfSize or id for browser-query_heapsnapshot_objects"
                            .to_string(),
                    ));
                }
            }
            if let Some(value) = optional_bounded_u64(args, "pageIdx", 0, 100_000)? {
                normalized.insert("pageIdx".to_string(), json!(value));
            }
            if let Some(value) = optional_bounded_u64(args, "pageSize", 1, 200)? {
                normalized.insert("pageSize".to_string(), json!(value));
            }
        }
        "get_heapsnapshot_object_details"
        | "get_heapsnapshot_edges"
        | "get_heapsnapshot_retainers"
        | "get_heapsnapshot_retaining_paths" => {
            let path = required_non_empty_string(args, "filePath", tool_name)?;
            validate_absolute_path(path, "filePath")?;
            if args.get("nodeIndex").and_then(Value::as_u64).is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("nodeIndex is required for browser-{tool_name}"),
                ));
            }
            if let Some(value) = optional_bounded_u64(args, "limit", 1, 500)? {
                normalized.insert("limit".to_string(), json!(value));
            }
            if let Some(value) = optional_bounded_u64(args, "maxDepth", 1, 30)? {
                normalized.insert("maxDepth".to_string(), json!(value));
            }
            if let Some(value) = optional_bounded_u64(args, "maxPaths", 1, 20)? {
                normalized.insert("maxPaths".to_string(), json!(value));
            }
        }
        "compare_heapsnapshots" => {
            let base = required_non_empty_string(args, "baseFilePath", tool_name)?;
            validate_absolute_path(base, "baseFilePath")?;
            let current = required_non_empty_string(args, "currentFilePath", tool_name)?;
            validate_absolute_path(current, "currentFilePath")?;
            if let Some(value) = optional_bounded_u64(args, "topN", 1, 200)? {
                normalized.insert("topN".to_string(), json!(value));
            }
        }
        "screencast_start" => {
            optional_non_empty_string(args, "instanceId")?;
            if let Some(path) = optional_non_empty_string(args, "filePath")? {
                validate_absolute_path(path, "filePath")?;
            }
            if let Some(quality) = args.get("quality") {
                if !quality.is_null() {
                    let value = quality.as_u64().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "quality must be an integer between 1 and 100 for browser-screencast_start"
                                .to_string(),
                        )
                    })?;
                    if !(1..=100).contains(&value) {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "quality must be between 1 and 100 for browser-screencast_start"
                                .to_string(),
                        ));
                    }
                }
            }
            if let Some(value) = optional_bounded_u64(args, "maxWidth", 64, 3840)? {
                normalized.insert("maxWidth".to_string(), json!(value));
            }
            if let Some(value) = optional_bounded_u64(args, "maxFrames", 1, 6000)? {
                normalized.insert("maxFrames".to_string(), json!(value));
            }
            if let Some(value) = optional_bounded_u64(args, "maxDurationMs", 1000, 600_000)? {
                normalized.insert("maxDurationMs".to_string(), json!(value));
            }
        }
        "screencast_stop" | "list_page_tools" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "call_page_tool" => {
            optional_non_empty_string(args, "instanceId")?;
            required_non_empty_string(args, "name", tool_name)?;
        }
        "frames" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "list" => {}
        "get_tab_content" => {
            optional_non_empty_string(args, "instanceId")?;
            optional_boolean(args, "includeTimes")?;
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
        .filter(|value| !value.trim().is_empty())
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
                Ok(Some(value.as_str()))
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

/// 动作后观察参数（observe / observeTimeoutMs / expect，issue #236）的校验与归一。
/// 空字符串、null 与空对象一律视为未提供，避免结构化输出里的占位字段变成伪条件。
fn validate_observation_args(
    args: &Value,
    tool_name: &str,
    normalized: &mut serde_json::Map<String, Value>,
) -> napi::Result<()> {
    match args.get("observe") {
        None | Some(Value::Null) => {
            normalized.remove("observe");
        }
        Some(Value::String(raw)) => {
            let mode = raw.trim();
            if !matches!(mode, "none" | "brief" | "snapshot") {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "observe must be one of none, brief, or snapshot for browser-{tool_name}"
                    ),
                ));
            }
            normalized.insert("observe".to_string(), json!(mode));
        }
        Some(_) => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("observe must be a string for browser-{tool_name}"),
            ));
        }
    }
    match args.get("observeTimeoutMs") {
        None | Some(Value::Null) => {
            normalized.remove("observeTimeoutMs");
        }
        Some(_) => {
            let timeout = bounded_u64(args, "observeTimeoutMs", 1_500, 100, 10_000)?;
            normalized.insert("observeTimeoutMs".to_string(), json!(timeout));
        }
    }
    let expect = match args.get("expect") {
        None | Some(Value::Null) => None,
        Some(Value::Object(expect)) => Some(expect),
        Some(_) => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("expect must be an object for browser-{tool_name}"),
            ));
        }
    };
    let Some(expect) = expect else {
        normalized.remove("expect");
        return Ok(());
    };
    let mut cleaned = serde_json::Map::new();
    for field in ["urlIncludes", "selector", "text"] {
        match expect.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(value)) => {
                let value = value.trim();
                if !value.is_empty() {
                    cleaned.insert(field.to_string(), json!(value));
                }
            }
            Some(_) => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("expect.{field} must be a string for browser-{tool_name}"),
                ));
            }
        }
    }
    if cleaned.is_empty() {
        normalized.remove("expect");
    } else {
        normalized.insert("expect".to_string(), Value::Object(cleaned));
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

fn optional_bounded_u64(
    args: &Value,
    field: &str,
    minimum: u64,
    maximum: u64,
) -> napi::Result<Option<u64>> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let number = value.as_u64().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("{field} must be a positive integer"),
                )
            })?;
            if !(minimum..=maximum).contains(&number) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("{field} must be between {minimum} and {maximum}"),
                ));
            }
            Ok(Some(number))
        }
    }
}

fn optional_number(args: &Value, field: &str) -> napi::Result<Option<f64>> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_f64().map(Some).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} must be a number when provided"),
            )
        }),
    }
}

fn validate_string_array(args: &Value, field: &str, maximum: usize) -> napi::Result<()> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(()),
        Some(value) => {
            let list = value.as_array().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("{field} must be an array of strings"),
                )
            })?;
            if list.len() > maximum {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("{field} supports at most {maximum} items"),
                ));
            }
            for item in list {
                if !item.is_string() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!("{field} items must be strings"),
                    ));
                }
            }
            Ok(())
        }
    }
}

fn validate_absolute_path(path: &str, field: &str) -> napi::Result<()> {
    if std::path::Path::new(path).is_absolute() {
        Ok(())
    } else {
        Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be an absolute path"),
        ))
    }
}

fn validate_frame_id(frame_id: &str) -> napi::Result<()> {
    let pattern =
        regex::Regex::new(r"^frame-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
            .expect("frame id pattern is static");
    if pattern.is_match(frame_id) {
        Ok(())
    } else {
        Err(Error::new(
            Status::InvalidArg,
            "Invalid frameId; use browser-frames first".to_string(),
        ))
    }
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
            "Unknown tool: \"{tool_name}\" for MCP server \"browser\". Available tools: [browser-create, browser-navigate, browser-click, browser-hover, browser-type, browser-fill_form, browser-drag, browser-select_option, browser-press_key, browser-scroll, browser-screenshot, browser-wait, browser-devtools, browser-close, browser-focus, browser-list, browser-evaluate, browser-upload-file, browser-back, browser-forward, browser-get_tab_content, browser-frames, browser-request_share, browser-emulate, browser-resize_page, browser-performance_start_trace, browser-performance_stop_trace, browser-performance_analyze_insight, browser-get_css_styles, browser-audit, browser-take_heapsnapshot, browser-get_heapsnapshot_summary, browser-query_heapsnapshot_objects, browser-get_heapsnapshot_object_details, browser-get_heapsnapshot_edges, browser-get_heapsnapshot_retainers, browser-get_heapsnapshot_retaining_paths, browser-get_heapsnapshot_duplicate_strings, browser-compare_heapsnapshots, browser-screencast_start, browser-screencast_stop, browser-list_page_tools, browser-call_page_tool]"
        ),
    )
}
