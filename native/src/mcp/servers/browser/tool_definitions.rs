//! 浏览器工具清单：按域合并成 action 驱动工具，压缩注入上下文。
//! 合并工具在派发前由 `resolve_operation` 还原为原 operation，
//! Electron 侧按 operation 分发的链路保持不变。

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::mcp::tools::McpTool;

use super::{
    DEFAULT_MAX_CONTENT_LENGTH, DEFAULT_TIMEOUT_MS, MAX_MAX_CONTENT_LENGTH, MAX_SCROLL_DELTA,
    MAX_TIMEOUT_MS, MAX_WAIT_TIME_MS, MIN_MAX_CONTENT_LENGTH, MIN_TIMEOUT_MS, SERVER_ID,
};

/// action 名 -> 内部 operation 名。
pub(crate) type ActionMap = &'static [(&'static str, &'static str)];

const TAB_ACTIONS: ActionMap = &[
    ("create", "create"),
    ("list", "list"),
    ("focus", "focus"),
    ("close", "close"),
    ("frames", "frames"),
];

const PAGE_ACTIONS: ActionMap = &[
    ("navigate", "navigate"),
    ("back", "back"),
    ("forward", "forward"),
    ("content", "get_tab_content"),
    ("screenshot", "screenshot"),
    ("wait", "wait"),
];

const INTERACT_ACTIONS: ActionMap = &[
    ("click", "click"),
    ("type", "type"),
    ("fill_form", "fill_form"),
    ("select_option", "select_option"),
    ("hover", "hover"),
    ("press_key", "press_key"),
    ("scroll", "scroll"),
    ("drag", "drag"),
    ("upload-file", "upload-file"),
];

const INSPECT_ACTIONS: ActionMap = &[
    ("evaluate", "evaluate"),
    ("css_styles", "get_css_styles"),
    ("audit", "audit"),
];

const EMULATE_ACTIONS: ActionMap = &[("emulate", "emulate"), ("resize", "resize_page")];

const PERF_ACTIONS: ActionMap = &[
    ("trace_start", "performance_start_trace"),
    ("trace_stop", "performance_stop_trace"),
    ("insight", "performance_analyze_insight"),
    ("screencast_start", "screencast_start"),
    ("screencast_stop", "screencast_stop"),
];

const HEAP_ACTIONS: ActionMap = &[
    ("take", "take_heapsnapshot"),
    ("summary", "get_heapsnapshot_summary"),
    ("query", "query_heapsnapshot_objects"),
    ("details", "get_heapsnapshot_object_details"),
    ("edges", "get_heapsnapshot_edges"),
    ("retainers", "get_heapsnapshot_retainers"),
    ("paths", "get_heapsnapshot_retaining_paths"),
    ("strings", "get_heapsnapshot_duplicate_strings"),
    ("compare", "compare_heapsnapshots"),
];

const PAGE_TOOL_ACTIONS: ActionMap = &[("list", "list_page_tools"), ("call", "call_page_tool")];

/// 合并工具的 action 表；未合并的工具（devtools / request_share）返回 None。
pub(crate) fn tool_actions(tool_name: &str) -> Option<ActionMap> {
    match tool_name {
        "tab" => Some(TAB_ACTIONS),
        "page" => Some(PAGE_ACTIONS),
        "interact" => Some(INTERACT_ACTIONS),
        "inspect" => Some(INSPECT_ACTIONS),
        "emulate" => Some(EMULATE_ACTIONS),
        "perf" => Some(PERF_ACTIONS),
        "heap" => Some(HEAP_ACTIONS),
        "page-tools" => Some(PAGE_TOOL_ACTIONS),
        _ => None,
    }
}

fn action_names(actions: ActionMap) -> Vec<&'static str> {
    actions.iter().map(|(name, _)| *name).collect()
}

/// 合并工具的 `action` 解成实际 operation；非合并工具原样返回。
pub(crate) fn resolve_operation(tool_name: &str, args: &Value) -> napi::Result<String> {
    let Some(actions) = tool_actions(tool_name) else {
        return Ok(tool_name.to_string());
    };
    let available = action_names(actions).join(", ");
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if action.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("action is required for browser-{tool_name}: {available}"),
        ));
    }
    match actions.iter().find(|(name, _)| *name == action) {
        Some((_, operation)) => Ok((*operation).to_string()),
        None => Err(Error::new(
            Status::InvalidArg,
            format!("Unknown action \"{action}\" for browser-{tool_name}. Available actions: {available}"),
        )),
    }
}

const INSTANCE_ID_DESCRIPTION: &str = "Optional browser instance ID. Omit or \"current\" to target the agent's working tab (set by tab create/focus; the user switching tabs does not change it).";

fn instance_id_schema() -> Value {
    json!({"type": "string", "description": INSTANCE_ID_DESCRIPTION})
}

fn frame_id_schema() -> Value {
    json!({
        "type": "string",
        "pattern": "^frame-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        "description": "Optional opaque frameId from a tab frames call (stale IDs fail without fallback). Omit for the main frame."
    })
}

fn observation_props() -> Value {
    json!({
        "observe": {
            "type": "string",
            "enum": ["none", "brief", "snapshot"],
            "description": "Post-action observation (default brief). none returns the low-latency receipt; brief waits up to observeTimeoutMs for a URL/title/DOM change; snapshot also returns condensed page text. Never waits for network-idle and never retries the action.",
            "default": "brief"
        },
        "observeTimeoutMs": {
            "type": "integer",
            "description": "Observation window in ms (default 1500, 5000 when expect is set; range 100-10000).",
            "minimum": 100,
            "maximum": 10000
        },
        "expect": {
            "type": "object",
            "description": "Completion condition evaluated during the observation window; all provided fields must hold.",
            "properties": {
                "urlIncludes": {"type": "string", "description": "Substring the current URL must contain."},
                "selector": {"type": "string", "description": "CSS selector that must exist in the page."},
                "text": {"type": "string", "description": "Visible page text that must appear."}
            }
        }
    })
}

fn extend(props: &mut Value, extra: Value) {
    if let (Some(map), Value::Object(extra)) = (props.as_object_mut(), extra) {
        map.extend(extra);
    }
}

fn plain(name: &str, description: &str, props: Value, required: &[&str]) -> McpTool {
    McpTool {
        server_id: SERVER_ID.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        input_schema: json!({
            "type": "object",
            "properties": props,
            "required": required
        }),
    }
}

/// 合并工具：自动补 `action`（enum 来自 action 表）。
fn merged(
    name: &str,
    description: &str,
    actions: ActionMap,
    mut props: Value,
    required: &[&str],
) -> McpTool {
    extend(
        &mut props,
        json!({
            "action": {
                "type": "string",
                "enum": action_names(actions),
                "description": "Operation to run; each action's arguments are listed in the tool description."
            }
        }),
    );
    plain(name, description, props, required)
}

pub(crate) fn definitions() -> Vec<McpTool> {
    vec![
        tab_tool(),
        page_tool(),
        interact_tool(),
        devtools_tool(),
        inspect_tool(),
        emulate_tool(),
        perf_tool(),
        heap_tool(),
        page_tools_tool(),
        request_share_tool(),
    ]
}

fn tab_tool() -> McpTool {
    merged(
        "tab",
        "Manage embedded browser tabs (each tab hosts one page and its instanceId is the tab ID). Actions: create (open a tab, optional url, returns its instanceId and makes it the agent's working tab), list (open tabs with titles, URLs, active and sharing state), focus (activate a tab and make it the working tab; requires instanceId), close (destroy a tab; later calls without instanceId fail until focus/create), frames (enumerate frameIds and parentFrameIds; re-enumerate after navigation). Omit instanceId to target the agent's working tab.",
        TAB_ACTIONS,
        json!({
            "instanceId": instance_id_schema(),
            "url": {
                "type": ["string", "null"],
                "description": "create: initial URL (http://, https://, file://); omit to use the configured homepage."
            }
        }),
        &["action"],
    )
}

fn page_tool() -> McpTool {
    merged(
        "page",
        "Navigate, read, screenshot or wait on a page. Actions: navigate (url; reload=true reloads the current page, ignoreCache, initScript, timeoutMs), back, forward, content (visible document.body.innerText plus a times array collected from <time>/[datetime] elements), screenshot (viewport, fullPage, or a single selector/ref; format/quality/filePath), wait (time, or text/textGone/selector/selectorGone polled until timeoutMs). A wait timeout means the condition was not met, not that the previous action failed. Omit instanceId to target the agent's working tab.",
        PAGE_ACTIONS,
        json!({
            "instanceId": instance_id_schema(),
            "frameId": frame_id_schema(),
            "url": {
                "type": ["string", "null"],
                "description": "navigate: target URL (http://, https://, file://). Omit when reload=true."
            },
            "reload": {
                "type": "boolean",
                "description": "navigate: reload the current page instead of navigating (default false).",
                "default": false
            },
            "ignoreCache": {
                "type": "boolean",
                "description": "navigate: bypass the cache when reloading (reload=true only).",
                "default": false
            },
            "initScript": {
                "type": ["string", "null"],
                "description": "navigate: JavaScript injected before any other script of the next document (one-shot; credential/storage access blocked)."
            },
            "timeoutMs": {
                "type": "integer",
                "description": "navigate/wait: timeout in ms (default 30000, range 1000-120000).",
                "default": DEFAULT_TIMEOUT_MS,
                "minimum": MIN_TIMEOUT_MS,
                "maximum": MAX_TIMEOUT_MS
            },
            "maxLength": {
                "type": "integer",
                "description": "content: maximum characters returned (default 20000, range 1000-100000).",
                "default": DEFAULT_MAX_CONTENT_LENGTH,
                "minimum": MIN_MAX_CONTENT_LENGTH,
                "maximum": MAX_MAX_CONTENT_LENGTH
            },
            "includeTimes": {
                "type": "boolean",
                "description": "content: include the times array derived from DOM time elements (default true); entries keep visible text, verbatim datetime, timezone marker and nearby context.",
                "default": true
            },
            "fullPage": {
                "type": "boolean",
                "description": "screenshot: capture the full scrollable page instead of the viewport (default false).",
                "default": false
            },
            "selector": {
                "type": "string",
                "description": "screenshot: capture only this element (mutually exclusive with fullPage); wait: CSS selector that must exist (mutually exclusive with time)."
            },
            "ref": {
                "type": "string",
                "description": "screenshot: accessibility ref (uid from devtools action=ax) of the element to capture."
            },
            "format": {
                "type": "string",
                "enum": ["png", "jpeg", "webp"],
                "description": "screenshot: image format (default png).",
                "default": "png"
            },
            "quality": {
                "type": "integer",
                "description": "screenshot: compression quality 0-100 for jpeg/webp (ignored for png).",
                "minimum": 0,
                "maximum": 100
            },
            "filePath": {
                "type": "string",
                "description": "screenshot: absolute path; write the image to this file instead of returning base64 inline."
            },
            "time": {
                "type": "integer",
                "description": "wait: fixed wait in ms (maximum 30000); mutually exclusive with the text/selector conditions.",
                "minimum": 100,
                "maximum": MAX_WAIT_TIME_MS
            },
            "text": {
                "type": "string",
                "description": "wait: visible text that must appear (polled every 100ms until timeoutMs)."
            },
            "textGone": {
                "type": "string",
                "description": "wait: visible text that must disappear."
            },
            "selectorGone": {
                "type": "string",
                "description": "wait: CSS selector that must disappear (e.g. a loading spinner)."
            }
        }),
        &["action"],
    )
}

fn interact_tool() -> McpTool {
    let mut props = json!({
        "instanceId": instance_id_schema(),
        "frameId": frame_id_schema(),
        "selector": {
            "type": "string",
            "description": "CSS selector of the target element."
        },
        "text": {
            "type": "string",
            "description": "Visible text used to locate the target when selector is omitted."
        },
        "ref": {
            "type": "string",
            "description": "Accessibility ref (uid from devtools action=ax) for deterministic targeting."
        },
        "x": {
            "type": "number",
            "description": "click: viewport x coordinate (main frame only; provide both x and y instead of selector/text/ref)."
        },
        "y": {
            "type": "number",
            "description": "click: viewport y coordinate (main frame only)."
        },
        "dblClick": {
            "type": "boolean",
            "description": "click: double-click the target (default false).",
            "default": false
        },
        "exact": {
            "type": "boolean",
            "description": "Whether text matching must be exact (default false).",
            "default": false
        },
        "value": {
            "type": "string",
            "description": "type: text to enter; checkbox/radio pass \"true\"/\"false\"; select pass the option value or label."
        },
        "submit": {
            "type": "boolean",
            "description": "type: submit the containing form after typing (default false).",
            "default": false
        },
        "delayMs": {
            "type": "integer",
            "description": "type: when > 0 type one character at a time with this delay (target must keep focus; 0 sets the value at once).",
            "default": 0,
            "minimum": 0,
            "maximum": 1000
        },
        "elements": {
            "type": "array",
            "minItems": 1,
            "maxItems": 50,
            "description": "fill_form: elements to fill, applied in order; each entry locates its target with selector/text/ref and provides a value. checkbox/radio use \"true\"/\"false\", select accepts the option value or label, submit=true submits the containing form. Failures are reported per element.",
            "items": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS selector for this element."},
                    "text": {"type": "string", "description": "Visible text to locate this element when selector is not provided."},
                    "ref": {"type": "string", "description": "Accessibility ref (uid from devtools action=ax) for this element."},
                    "value": {"type": "string", "description": "Value to fill. checkbox/radio: \"true\"/\"false\"; select: option value or label."},
                    "submit": {"type": "boolean", "description": "Submit the containing form after filling this element (default false).", "default": false}
                },
                "required": ["value"]
            }
        },
        "values": {
            "type": "array",
            "minItems": 1,
            "items": {"type": "string"},
            "description": "select_option: option values to select (one or many for multi-select)."
        },
        "key": {
            "type": "string",
            "description": "press_key: key name such as \"Enter\", \"Escape\", \"Tab\", \"ArrowLeft\", \"a\", \"F1\"; combinations use \"+\" (e.g. \"Control+a\")."
        },
        "deltaY": {
            "type": "integer",
            "description": "scroll: vertical distance in pixels (positive scrolls down; non-zero, absolute value at most 20000). Mutually exclusive with position.",
            "minimum": -MAX_SCROLL_DELTA,
            "maximum": MAX_SCROLL_DELTA
        },
        "position": {
            "type": "string",
            "enum": ["top", "bottom"],
            "description": "scroll: jump to the top or bottom of the container. Mutually exclusive with deltaY."
        },
        "files": {
            "type": "array",
            "minItems": 1,
            "items": {"type": "string"},
            "description": "upload-file: absolute paths of the files to upload (injected via CDP, no file chooser)."
        },
        "fromSelector": {"type": "string", "description": "drag: CSS selector of the element to drag."},
        "fromText": {"type": "string", "description": "drag: visible text of the element to drag when fromSelector is omitted."},
        "fromRef": {"type": "string", "description": "drag: accessibility ref (uid from devtools action=ax) of the element to drag."},
        "fromExact": {"type": "boolean", "description": "drag: exact fromText matching (default false).", "default": false},
        "fromFrameId": {"type": "string", "description": "drag: frameId containing the source element."},
        "toSelector": {"type": "string", "description": "drag: CSS selector of the drop target."},
        "toText": {"type": "string", "description": "drag: visible text of the drop target when toSelector is omitted."},
        "toRef": {"type": "string", "description": "drag: accessibility ref (uid from devtools action=ax) of the drop target."},
        "toExact": {"type": "boolean", "description": "drag: exact toText matching (default false).", "default": false},
        "toFrameId": {"type": "string", "description": "drag: frameId containing the drop target."}
    });
    extend(&mut props, observation_props());
    merged(
        "interact",
        "Real input events on a page. Actions: click (selector/text/ref, or x+y; dblClick, exact), type (value into inputs, textareas, contenteditable, checkbox/radio, select; delayMs types key by key and requires focus; submit presses Enter), fill_form (elements[] applied in order, per-element failures), select_option (values[]), hover, press_key (key, supports \"+\" combinations), scroll (deltaY or position, optional selector/ref container resolving to the nearest scrollable ancestor), drag (from* to to*), upload-file (files[] absolute paths). success=true only means the input event was dispatched; an observation timeout never means the action failed - verify the page state instead of repeating a side-effecting action.",
        INTERACT_ACTIONS,
        props,
        &["action"],
    )
}

fn devtools_tool() -> McpTool {
    plain(
        "devtools",
        "Inspect developer-tools data of the agent's working tab or an explicit instanceId. action=snapshot (page metadata and text; maxContentLength), ax (compact, ref-addressable accessibility tree keeping control values and states; verbose, maxNodes), console (captured messages; level, types, pageIdx/pageSize, includePreserved, clearConsole), console_message (one message by msgid), network (compact request list; filter, resourceTypes, methods, includeHeaders, includePreserved, pagination), network_detail (one request by numeric requestId), network_clear, networkDetails (full headers and bodies of one CDP requestId; maxBodyBytes, requestFilePath/responseFilePath), networkState (online/offline), route (mock responses: pattern, status, body, contentType, headers), routeClear, storageSave/storageRestore (cookies and localStorage to an encrypted file; fileName), cookies (values masked unless showValues=true), cookieDelete (domain+name), trace (durationMs), dialog (list or answer pending dialogs with dialogResponse), open (Electron DevTools).",
        json!({
            "instanceId": instance_id_schema(),
            "frameId": frame_id_schema(),
            "action": {
                "type": "string",
                "enum": [
                    "snapshot", "console", "console_message", "open", "network", "network_detail",
                    "network_clear", "networkDetails", "networkState", "route", "routeClear",
                    "storageSave", "storageRestore", "cookies", "cookieDelete", "ax", "trace", "dialog"
                ],
                "description": "Developer tools action (default snapshot).",
                "default": "snapshot"
            },
            "durationMs": {
                "type": "integer",
                "description": "trace: recording duration in ms (default 3000, range 1000-30000).",
                "default": 3000,
                "minimum": 1000,
                "maximum": 30000
            },
            "verbose": {
                "type": "boolean",
                "description": "ax: return every node and all AX properties (default false keeps interactive/structural roles with values, states and table cell text).",
                "default": false
            },
            "maxNodes": {
                "type": "integer",
                "description": "ax: maximum nodes returned (default 200, range 1-1000).",
                "default": 200,
                "minimum": 1,
                "maximum": 1000
            },
            "clearConsole": {
                "type": "boolean",
                "description": "console: clear captured messages after returning them (default false).",
                "default": false
            },
            "level": {
                "type": "string",
                "enum": ["verbose", "info", "warning", "error"],
                "description": "console: minimum level returned (default info)."
            },
            "filter": {
                "type": "string",
                "description": "network: only requests whose URL matches this regexp."
            },
            "static": {
                "type": "boolean",
                "description": "network: include successful static resources (images, fonts, scripts, stylesheets; default false).",
                "default": false
            },
            "limit": {
                "type": "integer",
                "description": "network: maximum requests returned (default 50, range 1-200).",
                "default": 50,
                "minimum": 1,
                "maximum": 200
            },
            "pageIdx": {
                "type": "integer",
                "description": "console/network: zero-based page index (default 0).",
                "minimum": 0,
                "maximum": 1000
            },
            "pageSize": {
                "type": "integer",
                "description": "console/network: page size (omitted returns all records, up to 1000).",
                "minimum": 1,
                "maximum": 1000
            },
            "includePreserved": {
                "type": "boolean",
                "description": "console/network: include records preserved from the last 3 navigations (default false).",
                "default": false
            },
            "types": {
                "type": "array",
                "maxItems": 30,
                "items": {"type": "string"},
                "description": "console: only messages whose type matches, e.g. [\"error\", \"warning\"]."
            },
            "resourceTypes": {
                "type": "array",
                "maxItems": 30,
                "items": {"type": "string"},
                "description": "network: only these resource types, e.g. [\"XHR\", \"Fetch\", \"Document\"]."
            },
            "methods": {
                "type": "array",
                "items": {"type": "string"},
                "description": "network: only these HTTP methods (case-insensitive), e.g. [\"OPTIONS\"]."
            },
            "includeHeaders": {
                "type": "boolean",
                "description": "network: include full request/response headers (default false keeps the compact list).",
                "default": false
            },
            "msgid": {
                "type": "integer",
                "minimum": 1,
                "description": "console_message: numeric message id from a console call."
            },
            "requestId": {
                "type": ["integer", "string"],
                "description": "network_detail: positive safe integer record id (1-9007199254740991) from network. networkDetails: non-empty CDP requestId string."
            },
            "maxBodyBytes": {
                "type": "integer",
                "description": "networkDetails: maximum body bytes returned (default 131072, range 1024-1048576).",
                "default": 131072,
                "minimum": 1024,
                "maximum": 1048576
            },
            "requestFilePath": {
                "type": "string",
                "description": "networkDetails: absolute path to save the request body to."
            },
            "responseFilePath": {
                "type": "string",
                "description": "networkDetails: absolute path to save the response body to."
            },
            "state": {
                "type": "string",
                "enum": ["online", "offline"],
                "description": "networkState: offline makes all requests fail, online restores connectivity."
            },
            "pattern": {
                "type": "string",
                "description": "route: URL pattern to mock. Plain text = substring match; /regex/ = regular expression, e.g. \"/api/users\"."
            },
            "status": {
                "type": "integer",
                "description": "route: HTTP status of the mocked response (default 200, range 100-599).",
                "minimum": 100,
                "maximum": 599
            },
            "body": {
                "type": "string",
                "description": "route: response body (text or JSON string)."
            },
            "contentType": {
                "type": "string",
                "description": "route: Content-Type of the mocked response, e.g. \"application/json\"."
            },
            "headers": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "route: additional response headers."
            },
            "dialogResponse": {
                "type": "object",
                "description": "dialog: answers pending dialogs instead of listing them. Omit dialogId to answer all pending dialogs with the same response.",
                "properties": {
                    "accept": {"type": "boolean", "description": "true accepts (OK), false dismisses (Cancel)."},
                    "promptText": {"type": "string", "description": "Text to enter for prompt dialogs."},
                    "dialogId": {"type": "string", "description": "Answer only this dialog id from the list."}
                },
                "required": ["accept"]
            },
            "maxContentLength": {
                "type": "integer",
                "description": "snapshot: maximum page text length (default 20000, range 1000-100000).",
                "default": DEFAULT_MAX_CONTENT_LENGTH,
                "minimum": MIN_MAX_CONTENT_LENGTH,
                "maximum": MAX_MAX_CONTENT_LENGTH
            },
            "fileName": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._-]{1,100}$",
                "maxLength": 100,
                "description": "storageSave/storageRestore: state file name (letters, digits, dot, dash, underscore; max 100 chars). Required for storageRestore."
            },
            "domain": {
                "type": "string",
                "description": "cookies: domain filter, e.g. \".github.com\"; required for cookieDelete together with name."
            },
            "showValues": {
                "type": "boolean",
                "description": "cookies: return plaintext values (default false = masked). WARNING: plaintext output contains credentials.",
                "default": false
            },
            "name": {
                "type": "string",
                "description": "cookieDelete: cookie name to delete (with domain)."
            }
        }),
        &[],
    )
}

fn inspect_tool() -> McpTool {
    merged(
        "inspect",
        "Read, evaluate or audit a page. Actions: evaluate (JavaScript via expression, function+args or sourcePath; waitForStableDom=false for pure reads; filePath saves the JSON result; credential and storage access is blocked - use devtools cookies instead), css_styles (full cascade for selector/ref with sources, media queries, inherited and computed values; pageIdx/pageSize), audit (axe-core accessibility, SEO and best-practice checks plus the console error count; categories).",
        INSPECT_ACTIONS,
        json!({
            "instanceId": instance_id_schema(),
            "frameId": frame_id_schema(),
            "expression": {
                "type": "string",
                "description": "evaluate: JavaScript source, e.g. \"document.title\" or an async IIFE; with format=function a function declaration such as \"(el) => el.innerText\"."
            },
            "function": {
                "type": "string",
                "description": "evaluate: alias of expression for function-style scripts (provide only one of expression, function, sourcePath)."
            },
            "format": {
                "type": "string",
                "enum": ["script", "function"],
                "description": "evaluate: script evaluates as-is (default), function applies args to the declaration.",
                "default": "script"
            },
            "args": {
                "type": "array",
                "items": {},
                "description": "evaluate: JSON-serializable arguments passed when format=function."
            },
            "sourcePath": {
                "type": "string",
                "description": "evaluate: absolute path of a local JavaScript file to load as the source (mutually exclusive with expression/function)."
            },
            "filePath": {
                "type": "string",
                "description": "evaluate: absolute path; save the result as JSON there instead of returning it."
            },
            "waitForStableDom": {
                "type": "boolean",
                "description": "evaluate: wait for the DOM to settle before evaluating (default true).",
                "default": true
            },
            "selector": {
                "type": "string",
                "description": "css_styles: CSS selector of the element to inspect."
            },
            "ref": {
                "type": "string",
                "description": "css_styles: accessibility ref (uid from devtools action=ax) of the element."
            },
            "pageIdx": {
                "type": "integer",
                "description": "css_styles: zero-based page index for the matched rules (default 0).",
                "minimum": 0,
                "maximum": 1000
            },
            "pageSize": {
                "type": "integer",
                "description": "css_styles: matched rules per page (default 10, range 1-100).",
                "minimum": 1,
                "maximum": 100
            },
            "categories": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["accessibility", "seo", "best-practices"]
                },
                "description": "audit: categories to run (default all three)."
            }
        }),
        &["action"],
    )
}

fn emulate_tool() -> McpTool {
    merged(
        "emulate",
        "Emulate page features or resize the viewport. Actions: emulate (colorScheme, cpuThrottlingRate, geolocation, extraHttpHeaders, networkConditions, userAgent, viewport; omitted fields stay unchanged, null clears an override), resize (width/height device metrics override).",
        EMULATE_ACTIONS,
        json!({
            "instanceId": instance_id_schema(),
            "colorScheme": {
                "type": ["string", "null"],
                "enum": ["dark", "light", "auto"],
                "description": "emulate: prefers-color-scheme; auto or null clears the override."
            },
            "cpuThrottlingRate": {
                "type": ["number", "null"],
                "description": "emulate: CPU slowdown factor (1-20; 1 or null disables throttling).",
                "minimum": 1,
                "maximum": 20
            },
            "extraHttpHeaders": {
                "type": ["object", "null"],
                "additionalProperties": {"type": "string"},
                "description": "emulate: extra HTTP headers on every request; null clears them."
            },
            "geolocation": {
                "type": ["object", "null"],
                "description": "emulate: geolocation override; null clears it.",
                "properties": {
                    "latitude": {"type": "number", "minimum": -90, "maximum": 90},
                    "longitude": {"type": "number", "minimum": -180, "maximum": 180},
                    "accuracy": {"type": "number", "minimum": 0}
                },
                "required": ["latitude", "longitude"]
            },
            "networkConditions": {
                "type": ["string", "null"],
                "enum": ["Offline", "Slow 3G", "Fast 3G", "Slow 4G", "Fast 4G"],
                "description": "emulate: network throttling preset; null restores online."
            },
            "userAgent": {
                "type": ["string", "null"],
                "description": "emulate: user agent override; an empty string clears it."
            },
            "viewport": {
                "type": ["string", "null"],
                "description": "emulate: \"<width>x<height>[x<devicePixelRatio>][,mobile][,touch][,landscape]\"; an empty string clears it."
            },
            "width": {
                "type": "integer",
                "description": "resize: viewport width in pixels (50-8000).",
                "minimum": 50,
                "maximum": 8000
            },
            "height": {
                "type": "integer",
                "description": "resize: viewport height in pixels (50-8000).",
                "minimum": 50,
                "maximum": 8000
            }
        }),
        &["action"],
    )
}

fn perf_tool() -> McpTool {
    merged(
        "perf",
        "Performance tracing and screencast recording. Actions: trace_start (categories; navigate or reload before starting to capture load performance), trace_stop (Core Web Vitals, long tasks and insights; filePath saves the raw trace), insight (full details of one insightId from trace_stop), screencast_start (record frames into an MJPEG AVI; filePath, quality, maxWidth, maxFrames, maxDurationMs; auto-stops at the caps), screencast_stop (returns path, frames, duration, size, fps).",
        PERF_ACTIONS,
        json!({
            "instanceId": instance_id_schema(),
            "categories": {
                "type": "array",
                "maxItems": 30,
                "items": {"type": "string"},
                "description": "trace_start: trace categories (defaults to devtools.timeline, v8.execute, blink.user_timing, loading and latencyInfo)."
            },
            "filePath": {
                "type": "string",
                "description": "trace_stop: absolute path for the raw trace (.json or .json.gz). screencast_start: absolute path for the resulting .avi (defaults to the app recordings folder)."
            },
            "insightId": {
                "type": "string",
                "enum": [
                    "long-tasks", "render-blocking", "lcp", "cls", "document-latency", "third-parties"
                ],
                "description": "insight: insight id from the trace_stop result."
            },
            "quality": {
                "type": "integer",
                "description": "screencast_start: JPEG frame quality (default 70, range 1-100).",
                "minimum": 1,
                "maximum": 100
            },
            "maxWidth": {
                "type": "integer",
                "description": "screencast_start: maximum frame width in pixels (64-3840).",
                "minimum": 64,
                "maximum": 3840
            },
            "maxFrames": {
                "type": "integer",
                "description": "screencast_start: frame cap before auto-stop (default 1200, maximum 6000).",
                "minimum": 1,
                "maximum": 6000
            },
            "maxDurationMs": {
                "type": "integer",
                "description": "screencast_start: duration cap before auto-stop in ms (default 120000, maximum 600000).",
                "minimum": 1000,
                "maximum": 600000
            }
        }),
        &["action"],
    )
}

fn heap_tool() -> McpTool {
    merged(
        "heap",
        "Capture and analyze V8 heap snapshots. Actions: take (capture the tab into filePath; needs instanceId or the working tab), summary (counts, sizes, detached nodes, top constructors; topN), query (objects filtered by className text or /regex/, nodeType, minSelfSize, isDetached, sortBy; returns nodeIndex values; pageIdx/pageSize), details (one nodeIndex), edges (outgoing references; limit), retainers (reverse references; limit), paths (retaining paths towards GC roots; maxDepth, maxPaths), strings (wasteful duplicate strings; topN), compare (baseFilePath vs currentFilePath growth and shrink; topN).",
        HEAP_ACTIONS,
        json!({
            "instanceId": {
                "type": "string",
                "description": "take: browser instance ID; omit for the agent's working tab. Other actions read the file only."
            },
            "filePath": {
                "type": "string",
                "description": "take: absolute path to save the .heapsnapshot file. summary/query/details/edges/retainers/paths/strings: absolute path of the .heapsnapshot file."
            },
            "nodeIndex": {
                "type": "integer",
                "minimum": 0,
                "description": "details/edges/retainers/paths: node index from a query call."
            },
            "topN": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "summary/strings/compare: entries per list (summary and compare default 30, strings default 20; maximum 200)."
            },
            "className": {
                "type": "string",
                "description": "query: constructor name filter (substring, or /regex/)."
            },
            "nodeType": {
                "type": "string",
                "description": "query: V8 node type filter, e.g. object, closure, string, array, code."
            },
            "minSelfSize": {
                "type": "integer",
                "minimum": 0,
                "description": "query: minimum self size in bytes."
            },
            "isDetached": {
                "type": "boolean",
                "description": "query: only return detached DOM nodes."
            },
            "sortBy": {
                "type": "string",
                "enum": ["selfSize", "id"],
                "description": "query: sort order (default selfSize descending)."
            },
            "pageIdx": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100000,
                "description": "query: zero-based page index (default 0)."
            },
            "pageSize": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "query: rows per page (default 20, maximum 200)."
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500,
                "description": "edges/retainers: maximum entries returned (default 50, maximum 500)."
            },
            "maxDepth": {
                "type": "integer",
                "minimum": 1,
                "maximum": 30,
                "description": "paths: maximum path depth (default 6, maximum 30)."
            },
            "maxPaths": {
                "type": "integer",
                "minimum": 1,
                "maximum": 20,
                "description": "paths: maximum paths returned (default 5, maximum 20)."
            },
            "baseFilePath": {
                "type": "string",
                "description": "compare: absolute path of the earlier .heapsnapshot file."
            },
            "currentFilePath": {
                "type": "string",
                "description": "compare: absolute path of the later .heapsnapshot file."
            }
        }),
        &["action"],
    )
}

fn page_tools_tool() -> McpTool {
    merged(
        "page-tools",
        "Tools the page registers itself (WebMCP-style window.__snowPageTools). Actions: list (registered tools with name, description and parameters), call (run a page tool by name with JSON params).",
        PAGE_TOOL_ACTIONS,
        json!({
            "instanceId": instance_id_schema(),
            "name": {
                "type": "string",
                "description": "call: name of the page tool to execute."
            },
            "params": {
                "description": "call: JSON-serializable parameters passed to the page tool's run(args)."
            }
        }),
        &["action"],
    )
}

fn request_share_tool() -> McpTool {
    plain(
        "request_share",
        "Ask the user to share a browser tab with the agent: shows an in-app confirmation on the tab and waits for the answer. Only shared tabs (or tabs the agent created) can be driven by other browser tools. Returns { shared: true }, or { shared: false, reason: \"denied\" | \"domain-blocked\" } when declined, unanswered in time or blocked by the domain policy. Errors when browser agent access is disabled in settings. Omit instanceId to target the agent's working tab.",
        json!({
            "instanceId": instance_id_schema()
        }),
        &[],
    )
}
