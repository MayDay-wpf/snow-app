use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

mod validation;

const SERVER_ID: &str = "browser";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_CONTENT_LENGTH: u64 = 20_000;
const MIN_MAX_CONTENT_LENGTH: u64 = 1_000;
const MAX_MAX_CONTENT_LENGTH: u64 = 100_000;
const MAX_WAIT_TIME_MS: u64 = 30_000;
/// browser-scroll 单次 deltaY 的绝对值上限（防止误滚到极端值）。
const MAX_SCROLL_DELTA: i64 = 20_000;
// Record ids cross the JSON bridge into JavaScript numbers.
const MAX_SAFE_RECORD_ID: u64 = 9_007_199_254_740_991;

/** 省略 instanceId 时的目标语义（issue #253）：Agent 工作标签，而非用户最近聚焦的标签。 */
const INSTANCE_ID_DESCRIPTION: &str = "Optional browser instance ID. Omit it or use current to target the agent's working browser tab (set by browser-create / browser-focus; the user switching tabs does not change it).";

/** 动作类工具描述共用的回执语义说明（issue #236）。 */
const ACTION_RECEIPT_NOTE: &str = " success=true means only that the input event was dispatched, not that the site handled it. The top-level url/title are read after the action, before holds the pre-action page, and observation reports the post-action state (changed/unchanged/navigating/blocked/expect-timeout) from a bounded wait that never waits for network-idle. An observation or wait timeout never means the action failed; verify the page state instead of repeating a side-effecting action. URL query/fragment are redacted by policy: urlRedaction marks that they were hidden.";

#[napi(object)]
pub struct BrowserCommand {
    pub operation: String,
    pub args_json: String,
}

pub type BrowserCommandCallback =
    ThreadsafeFunction<BrowserCommand, Promise<String>, BrowserCommand, Status, false>;

/// 会产生页面副作用的动作共用的「动作后观察」参数：
/// observe / observeTimeoutMs / expect（issue #236）。
fn observation_schema_properties() -> Value {
    json!({
        "observe": {
            "type": "string",
            "enum": ["none", "brief", "snapshot"],
            "description": "Post-action observation after the input event is dispatched (default brief). none keeps the original low-latency receipt (observation.mode=none); brief waits up to observeTimeoutMs for a URL/title/DOM change and reports status changed/unchanged/navigating/blocked; snapshot also returns condensed page text. Observation never waits for network-idle and never retries the action.",
            "default": "brief"
        },
        "observeTimeoutMs": {
            "type": "integer",
            "description": "Bounded observation window in milliseconds (default 1500; default 5000 when expect is set; range 100-10000).",
            "minimum": 100,
            "maximum": 10000
        },
        "expect": {
            "type": "object",
            "description": "Optional explicit completion condition evaluated during the observation window (all provided fields must hold). Use it instead of sleeping or repeating the action; a miss is reported as observation.status=expect-timeout and does not mean the action failed.",
            "properties": {
                "urlIncludes": {
                    "type": "string",
                    "description": "Substring that the current URL must contain."
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector that must exist in the page."
                },
                "text": {
                    "type": "string",
                    "description": "Visible page text that must appear."
                }
            }
        }
    })
}

fn with_observation_schema(mut schema: Value) -> Value {
    let extra = observation_schema_properties();
    if let (Some(properties), Value::Object(extra)) = (
        schema.get_mut("properties").and_then(Value::as_object_mut),
        extra,
    ) {
        for (key, value) in extra {
            properties.insert(key, value);
        }
    }
    schema
}

pub struct BrowserService;

impl BrowserService {
    pub fn new() -> Self {
        BrowserService
    }

    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_command: &BrowserCommandCallback,
    ) -> napi::Result<Value> {
        let normalized_args = validation::validate_and_normalize_args(tool_name, args)?;
        let command = BrowserCommand {
            operation: tool_name.to_string(),
            args_json: serde_json::to_string(&normalized_args).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize browser command: {error}"),
                )
            })?,
        };

        let promise = on_command
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch browser command to Electron: {error}"),
                )
            })?;
        let result_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Browser command failed: {error}"),
            )
        })?;

        serde_json::from_str(&result_json).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Browser command returned invalid JSON: {error}"),
            )
        })
    }
}

impl McpService for BrowserService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        let mut tools = vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "create".to_string(),
                description: "Create a new embedded browser tab in the right panel (each browser tab hosts one page and its instanceId is the tab ID). Returns an instanceId for explicitly targeting it later. The new tab becomes the agent's working tab: later browser calls that omit instanceId target it until browser-focus selects another tab. Optionally opens an initial URL. Tabs created this way count as shared with the agent and use an isolated session by default (their own cookies/storage, no access to the user's login state).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Optional initial URL (http://, https://, or file://). If omitted, the configured browser homepage is used."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "navigate".to_string(),
                description: "Navigate an embedded browser instance to a URL (http://, https://, or file://) and wait asynchronously for loading to finish, or reload the current page with reload=true (optionally ignoreCache=true). initScript injects JavaScript before any other script runs in the next document (one-shot, credential access blocked). Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "url": {
                            "type": "string",
                            "description": "URL to visit (http://, https://, or file://). Omit when reload=true."
                        },
                        "reload": {
                            "type": "boolean",
                            "description": "Reload the current page instead of navigating to url (default false).",
                            "default": false
                        },
                        "ignoreCache": {
                            "type": "boolean",
                            "description": "Bypass the cache when reloading (reload=true only).",
                            "default": false
                        },
                        "initScript": {
                            "type": "string",
                            "description": "JavaScript to execute before any other script of the next document (one-shot; credential/storage access is blocked)."
                        },
                        "timeoutMs": {
                            "type": "integer",
                            "description": "Navigation timeout in milliseconds (default 30000, range 1000-120000).",
                            "default": DEFAULT_TIMEOUT_MS,
                            "minimum": MIN_TIMEOUT_MS,
                            "maximum": MAX_TIMEOUT_MS
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "click".to_string(),
                description: "Click page content in an embedded browser with a real Electron mouse input event. Target an element with a CSS selector, visible text, or an accessibility ref (uid=... from browser-devtools action=ax), or click viewport coordinates with x and y. Set dblClick to double-click. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the element to click."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot) for deterministic element targeting."
                        },
                        "x": {
                            "type": "number",
                            "description": "Viewport x coordinate to click (main frame only; provide both x and y instead of selector/text/ref)."
                        },
                        "y": {
                            "type": "number",
                            "description": "Viewport y coordinate to click (main frame only; provide both x and y instead of selector/text/ref)."
                        },
                        "dblClick": {
                            "type": "boolean",
                            "description": "Whether to double-click the target (default false).",
                            "default": false
                        },
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screenshot".to_string(),
                description: "Capture an embedded browser page or a single element as an image (CDP, including off-screen content). Pass selector or ref to capture only that element, format/quality to choose the output type, and filePath to save the image to a file instead of returning it inline. Omit instanceId to capture the agent's working browser tab. Returns page metadata and, when filePath is omitted, an image content block containing base64 image data.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "fullPage": {
                            "type": "boolean",
                            "description": "Capture the full scrollable page instead of only the viewport (default false).",
                            "default": false
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector; capture only that element (mutually exclusive with fullPage)."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot); capture only that element (mutually exclusive with fullPage)."
                        },
                        "format": {
                            "type": "string",
                            "enum": ["png", "jpeg", "webp"],
                            "description": "Image format (default png).",
                            "default": "png"
                        },
                        "quality": {
                            "type": "integer",
                            "description": "Compression quality 0-100 for jpeg/webp formats (ignored for png).",
                            "minimum": 0,
                            "maximum": 100
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path; save the image to this file instead of returning base64 data inline."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "devtools".to_string(),
                description: "Inspect developer-tools-related information for an embedded browser. Omit instanceId to inspect the agent's working browser tab. Use action=snapshot for page metadata and text, action=ax for a compact, ref-addressable accessibility tree that keeps control values and states (verbose=true returns every node and AX property), action=console for captured console messages (filterable by level/types, paginated with pageIdx/pageSize, includePreserved covers the last 3 navigations, clearConsole clears after returning), action=console_message for one message by msgid, action=network for a compact request list (id/method/url/status/duration/resourceType/source; filterable by regexp/resourceTypes/methods, paginated, includePreserved covers the last 3 navigations; request/response headers are omitted by default, pass includeHeaders=true to include them; CDP records include a numeric id and a requestId string), action=network_detail for full details of a single request by numeric id, action=network_clear to clear all recorded requests, action=networkDetails for full request/response headers and bodies of one request (requestFilePath/responseFilePath save bodies to files), action=networkState to simulate offline/online, action=route to mock network responses (intercept and fulfill matching requests), action=routeClear to remove all route mocks, action=storageSave to save login state (cookies + localStorage) as an encrypted file, action=storageRestore to restore login state from an encrypted file, action=cookies to list session cookies (values masked by default), action=cookieDelete to remove one cookie, action=dialog to list and respond to pending JavaScript dialogs (alert/confirm/prompt), or action=open to open Electron DevTools for the page.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "action": {
                            "type": "string",
                            "enum": ["snapshot", "console", "console_message", "open", "network", "network_detail", "network_clear", "networkDetails", "networkState", "route", "routeClear", "storageSave", "storageRestore", "cookies", "cookieDelete", "ax", "trace", "dialog"],
                            "description": "Developer tools action (default snapshot).",
                            "default": "snapshot"
                        },
                        "durationMs": {
                            "type": "integer",
                            "description": "Trace recording duration in milliseconds (trace action only, default 3000, range 1000-30000).",
                            "default": 3000,
                            "minimum": 1000,
                            "maximum": 30000
                        },
                        "verbose": {
                            "type": "boolean",
                            "description": "Include every accessibility node and all AX properties (ax action only). Default false keeps interactive/structural roles with control values and states (checked/selected/expanded/disabled) plus table row cell text.",
                            "default": false
                        },
                        "maxNodes": {
                            "type": "integer",
                            "description": "Maximum accessibility tree nodes to return (ax action only, default 200, range 1-1000).",
                            "default": 200,
                            "minimum": 1,
                            "maximum": 1000
                        },
                        "clearConsole": {
                            "type": "boolean",
                            "description": "Clear captured console messages after returning them (console action only).",
                            "default": false
                        },
                        "level": {
                            "type": "string",
                            "enum": ["verbose", "info", "warning", "error"],
                            "description": "Minimum console level to return (console action only). Each level includes more severe levels. Defaults to info."
                        },
                        "filter": {
                            "type": "string",
                            "description": "Only return network requests whose URL matches this regexp (network action only)."
                        },
                        "static": {
                            "type": "boolean",
                            "description": "Whether to include successful static resources (images, fonts, scripts, stylesheets) in network listing (default false).",
                            "default": false
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of network requests to return (network action only, default 50, range 1-200).",
                            "default": 50,
                            "minimum": 1,
                            "maximum": 200
                        },
                        "pageIdx": {
                            "type": "integer",
                            "description": "Zero-based page index for console/network listings (default 0).",
                            "minimum": 0,
                            "maximum": 1000
                        },
                        "pageSize": {
                            "type": "integer",
                            "description": "Page size for console/network listings (when omitted all records are returned, up to 1000).",
                            "minimum": 1,
                            "maximum": 1000
                        },
                        "includePreserved": {
                            "type": "boolean",
                            "description": "Include records preserved from the previous navigations (console/network actions; keeps the last 3 navigations).",
                            "default": false
                        },
                        "types": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Only return console messages whose type/kind matches one of these values (console action only), e.g. [\"error\", \"warning\"]."
                        },
                        "resourceTypes": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Only return network requests of these resource types (network action only), e.g. [\"XHR\", \"Fetch\", \"Document\"]."
                        },
                        "methods": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Only return network requests sent with these HTTP methods (network action only), case-insensitive, e.g. [\"OPTIONS\"] to inspect CORS preflight requests."
                        },
                        "includeHeaders": {
                            "type": "boolean",
                            "description": "Include full requestHeaders and responseHeaders in the network list (network action only, default false keeps the compact list). Bodies are always read via networkDetails.",
                            "default": false
                        },
                        "msgid": {
                            "type": "integer",
                            "description": "Numeric id of the console message to retrieve (console_message action only; required for that action; use action=console to obtain ids)."
                        },
                        "requestId": {
                            "type": ["integer", "string"],
                            "description": "For network_detail: positive safe integer record id (1-9007199254740991) from network; a trimmed decimal string is accepted and normalized to integer with the same runtime bound. For networkDetails: non-empty CDP requestId string, preserved as a string."
                        },
                        "maxBodyBytes": {
                            "type": "integer",
                            "description": "Maximum request/response body bytes to return (networkDetails action only, default 131072, range 1024-1048576).",
                            "default": 131072,
                            "minimum": 1024,
                            "maximum": 1048576
                        },
                        "requestFilePath": {
                            "type": "string",
                            "description": "Absolute path to save the request body to (networkDetails action only; body is written to the file instead of being returned)."
                        },
                        "responseFilePath": {
                            "type": "string",
                            "description": "Absolute path to save the response body to (networkDetails action only; body is written to the file instead of being returned)."
                        },
                        "state": {
                            "type": "string",
                            "enum": ["online", "offline"],
                            "description": "Network state to simulate (networkState action only; required for that action): offline makes all network requests fail, online restores connectivity."
                        },
                        "pattern": {
                            "type": "string",
                            "description": "URL pattern to mock (route action only; required for that action). Plain text = substring match; /regex/ = regular expression match. Example: \"/api/users\" or \"/.*\\.png\""
                        },
                        "status": {
                            "type": "integer",
                            "description": "HTTP status code for the mocked response (route action only, default 200).",
                            "minimum": 100,
                            "maximum": 599
                        },
                        "body": {
                            "type": "string",
                            "description": "Response body (text or JSON string) for the mocked response (route action only)."
                        },
                        "contentType": {
                            "type": "string",
                            "description": "Content-Type header for the mocked response (route action only), e.g. \"application/json\"."
                        },
                        "headers": {
                            "type": "object",
                            "description": "Additional response headers as name-value pairs (route action only).",
                            "additionalProperties": { "type": "string" }
                        },
                        "dialogResponse": {
                            "type": "object",
                            "description": "Response for the dialog action: { accept: boolean, promptText?: string, dialogId?: string }. When provided, it answers pending dialogs instead of listing them. dialogId targets one dialog returned by the list; without it every pending dialog receives the same response.",
                            "properties": {
                                "accept": {
                                    "type": "boolean",
                                    "description": "true to accept (OK) the dialog, false to dismiss (Cancel)."
                                },
                                "promptText": {
                                    "type": "string",
                                    "description": "Text to enter for prompt dialogs."
                                },
                                "dialogId": {
                                    "type": "string",
                                    "description": "Optional dialogId from the dialog list; answers only that dialog. Omit to answer all pending dialogs with the same response."
                                }
                            },
                            "required": ["accept"]
                        },
                        "maxContentLength": {
                            "type": "integer",
                            "description": "Maximum page text length for snapshot (default 20000, range 1000-100000).",
                            "default": DEFAULT_MAX_CONTENT_LENGTH,
                            "minimum": MIN_MAX_CONTENT_LENGTH,
                            "maximum": MAX_MAX_CONTENT_LENGTH
                        },
                        "fileName": {
                            "type": "string",
                            "description": "State file name for storageSave/storageRestore (letters, digits, dot, dash, underscore; max 100 chars). Required for storageRestore; storageSave generates one when omitted."
                        },
                        "domain": {
                            "type": "string",
                            "description": "Cookie domain filter (cookies action only; required for cookieDelete together with name), e.g. \".github.com\"."
                        },
                        "showValues": {
                            "type": "boolean",
                            "description": "Return cookie values in plaintext (cookies action only, default false = masked). WARNING: plaintext output contains sensitive credentials.",
                            "default": false
                        },
                        "name": {
                            "type": "string",
                            "description": "Cookie name to delete (cookieDelete action only; required for that action, combined with domain)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "wait".to_string(),
                description: "Wait for a condition on the page: fixed time, text to appear/disappear, or element (CSS selector) to appear/disappear. Inspired by Playwright's browser_wait_for. Returns status=satisfied/elapsed/timed-out: a timed-out wait means the condition was not met, not that the preceding action failed, so verify the page state before repeating a side-effecting action. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "time": {
                            "type": "integer",
                            "description": "Time to wait in milliseconds (maximum 30000). Mutually exclusive with text/textGone/selector/selectorGone.",
                            "minimum": 100,
                            "maximum": MAX_WAIT_TIME_MS
                        },
                        "text": {
                            "type": "string",
                            "description": "Text to wait for to appear on the page. Polls every 100ms until the text is found or the timeout elapses. Mutually exclusive with time."
                        },
                        "textGone": {
                            "type": "string",
                            "description": "Text to wait for to disappear from the page. Polls every 100ms until the text is gone or the timeout elapses. Mutually exclusive with time."
                        },
                        "selector": {
                            "type": "string",
                            "description": "CSS selector to wait for to exist in the DOM (e.g. after a SPA renders). Polls every 100ms until the element is found or the timeout elapses. Mutually exclusive with time."
                        },
                        "selectorGone": {
                            "type": "string",
                            "description": "CSS selector to wait for to disappear from the DOM (e.g. a loading spinner). Polls every 100ms until the element is gone or the timeout elapses. Mutually exclusive with time."
                        },
                        "timeoutMs": {
                            "type": "integer",
                            "description": "Maximum time to wait for text/textGone/selector/selectorGone conditions in milliseconds (default 30000, range 1000-120000). Ignored for fixed time waits.",
                            "default": DEFAULT_TIMEOUT_MS,
                            "minimum": MIN_TIMEOUT_MS,
                            "maximum": MAX_TIMEOUT_MS
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "press_key".to_string(),
                description: "Press a keyboard key on the page. Use for shortcuts, Enter, Escape, Tab, Arrow keys, etc. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "key": {
                            "type": "string",
                            "description": "Name of the key to press (e.g. \"Enter\", \"Escape\", \"Tab\", \"ArrowLeft\", \"a\", \"F1\"). Supports key combinations with \"+\" (e.g. \"Control+a\", \"Shift+ArrowDown\")."
                        }
                    },
                    "required": ["key"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "scroll".to_string(),
                description: "Scroll the page or an inner scroll container (feeds, virtual lists, overflow panels) and report whether it actually moved. Provide exactly one of deltaY (pixels, positive scrolls down) or position (top / bottom). Target the container with selector (CSS, pierces open shadow roots) or ref (uid from browser-devtools action=ax); a target that cannot scroll itself resolves to its nearest scrollable ancestor. Without selector/ref the document is scrolled, or, when the document itself cannot scroll, the largest visible scroll container (container.auto=true). Returns moved, before/after {scrollTop, scrollHeight, clientHeight}, atTop/atBottom and the scrolled container (tag/id/class). Prefer this over browser-press_key PageDown/End (which only scroll the document) and over browser-evaluate scroll scripts. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector of the scroll container (or an element inside it). Mutually exclusive with ref."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot) of the scroll container or an element inside it. Mutually exclusive with selector."
                        },
                        "deltaY": {
                            "type": "integer",
                            "description": "Vertical scroll distance in pixels (positive scrolls down, negative scrolls up; non-zero, absolute value at most 20000). Mutually exclusive with position.",
                            "minimum": -MAX_SCROLL_DELTA,
                            "maximum": MAX_SCROLL_DELTA
                        },
                        "position": {
                            "type": "string",
                            "enum": ["top", "bottom"],
                            "description": "Scroll straight to the top or bottom of the container. Mutually exclusive with deltaY."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "hover".to_string(),
                description: "Hover over an element on the page with a real mouse move event. Target an element with a CSS selector or visible text. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the element to hover."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "select_option".to_string(),
                description: "Select option(s) in a dropdown (<select>) element. Target the element with a CSS selector or visible text. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the select element."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate the select element when selector is not provided."
                        },
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        },
                        "values": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Array of option values to select. Can be a single value or multiple values for multi-select."
                        }
                    },
                    "required": ["values"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "close".to_string(),
                description: "Close an embedded browser tab and destroy its webview. Omit instanceId to close the agent's working browser tab (later calls without instanceId then fail until browser-focus or browser-create selects a new working tab). Use browser-list if the target tab ID is unknown.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID to close. Omit it or use current to close the agent's working browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "focus".to_string(),
                description: "Switch to (activate) an embedded browser tab by its instance ID, bringing it to the foreground, and make it the agent's working tab: later browser calls that omit instanceId target it (the user switching tabs does not change this). Use browser-list if the target tab ID is unknown.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "The browser instance ID to switch to."
                        }
                    },
                    "required": ["instanceId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list".to_string(),
                description: "List all open embedded browser tabs with their instance IDs, titles, URLs, active state, agentTarget (true for the agent's working tab that calls without instanceId target) and agent access flags (shared / isolated / origin). Tabs the user has not shared with the agent only expose their instanceId and a placeholder title (url is null); call browser-request_share to ask the user to share such a tab. If the user has provided an instanceId, pass it directly to the appropriate browser tool; listing tabs first is unnecessary.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "evaluate".to_string(),
                description: "Evaluate JavaScript in an embedded browser page and return the serialized result. Prefer dedicated browser tools for page content, inspection, and interaction; use this tool when custom JavaScript is needed. Provide the source via expression (inline) or sourcePath (a local file); with format=function the source is treated as a function and args are passed to it (JSON-serializable). waitForStableDom (default true) waits for the DOM to settle before evaluating; filePath saves the result JSON to a file instead of returning it. Credential/storage access (cookies, localStorage, etc.) is blocked; use browser-devtools cookies for those. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "expression": {
                            "type": "string",
                            "description": "JavaScript source to evaluate (e.g. \"document.title\" or an async IIFE). With format=function, a function declaration such as \"(el) => el.innerText\"."
                        },
                        "function": {
                            "type": "string",
                            "description": "Alias of expression for function-style scripts; provide only one of expression, function, or sourcePath."
                        },
                        "format": {
                            "type": "string",
                            "enum": ["script", "function"],
                            "description": "How to interpret the source: script evaluates it as-is (default); function treats it as a function declaration and applies args.",
                            "default": "script"
                        },
                        "args": {
                            "type": "array",
                            "items": {},
                            "description": "JSON-serializable arguments passed to the function when format=function."
                        },
                        "sourcePath": {
                            "type": "string",
                            "description": "Absolute path of a local JavaScript file to load as the source (mutually exclusive with expression/function)."
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path; save the result as JSON to this file instead of returning it."
                        },
                        "waitForStableDom": {
                            "type": "boolean",
                            "description": "Wait for the DOM to settle before evaluating (default true; pass false for pure reads).",
                            "default": true
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "type".to_string(),
                description: "Type text into an editable element (or fill a form control) in an embedded browser. Target the element with a CSS selector, visible text, or an accessibility ref (uid=... from browser-devtools action=ax; same locating rules as browser-click). Supports inputs, textareas, contenteditable, checkboxes and radios (value \"true\"/\"false\") and <select> (value or label). By default the value is set at once and input/change events are fired; pass delayMs to type character by character for key handlers. In delayMs mode the target must hold keyboard focus: focus is verified before the first and every following keystroke, and the call fails (reporting how many characters were typed and where focus went) instead of typing into another element; submit sends Enter only while the target is still focused. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the target element."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot) for deterministic element targeting."
                        },
                        "value": {
                            "type": "string",
                            "description": "Text to type into the element. For checkbox/radio pass \"true\" to check or \"false\" to uncheck; for <select> pass the option value or label to select."
                        },
                        "submit": {
                            "type": "boolean",
                            "description": "Whether to submit the containing form after typing (default false).",
                            "default": false
                        },
                        "delayMs": {
                            "type": "integer",
                            "description": "When greater than 0, type one character at a time with this delay in milliseconds (default 0 = set value at once).",
                            "default": 0,
                            "minimum": 0,
                            "maximum": 1000
                        }
                    },
                    "required": ["value"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "upload-file".to_string(),
                description: "Upload file(s) to a file input element. Target with a CSS selector, visible text, or accessibility ref. Files are injected directly via CDP (no file chooser dialog). Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the file input element."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot)."
                        },
                        "files": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Absolute paths to the files to upload."
                        }
                    },
                    "required": ["files"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "drag".to_string(),
                description: "Drag an element onto another element with a real mouse input sequence (HTML5 drag-and-drop and pointer-drag widgets). Locate the source with fromSelector/fromText/fromRef and the drop target with toSelector/toText/toRef; fromFrameId/toFrameId optionally target specific frames from browser-frames. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "fromSelector": {
                            "type": "string",
                            "description": "CSS selector of the element to drag."
                        },
                        "fromText": {
                            "type": "string",
                            "description": "Visible text of the element to drag when fromSelector is not provided."
                        },
                        "fromRef": {
                            "type": "string",
                            "description": "Accessibility ref (uid from browser-devtools action=ax) of the element to drag."
                        },
                        "fromExact": {
                            "type": "boolean",
                            "description": "Whether fromText matching must be exact (default false).",
                            "default": false
                        },
                        "fromFrameId": {
                            "type": "string",
                            "description": "Optional frameId (from browser-frames) containing the source element."
                        },
                        "toSelector": {
                            "type": "string",
                            "description": "CSS selector of the drop target element."
                        },
                        "toText": {
                            "type": "string",
                            "description": "Visible text of the drop target element when toSelector is not provided."
                        },
                        "toRef": {
                            "type": "string",
                            "description": "Accessibility ref (uid from browser-devtools action=ax) of the drop target element."
                        },
                        "toExact": {
                            "type": "boolean",
                            "description": "Whether toText matching must be exact (default false).",
                            "default": false
                        },
                        "toFrameId": {
                            "type": "string",
                            "description": "Optional frameId (from browser-frames) containing the drop target element."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "fill_form".to_string(),
                description: "Fill multiple form elements in one call (inputs, textareas, checkboxes, radios, selects, contenteditable). Each elements entry locates its target with selector/text/ref and provides a value; checkbox/radio use \"true\"/\"false\", selects accept the option value or label, and submit=true submits the containing form. Failures are reported per element without aborting the remaining ones. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "elements": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "selector": {
                                        "type": "string",
                                        "description": "CSS selector for this element."
                                    },
                                    "text": {
                                        "type": "string",
                                        "description": "Visible text to locate this element when selector is not provided."
                                    },
                                    "ref": {
                                        "type": "string",
                                        "description": "Accessibility ref (uid from browser-devtools action=ax) for this element."
                                    },
                                    "value": {
                                        "type": "string",
                                        "description": "Value to fill. checkbox/radio: \"true\"/\"false\"; select: option value or label."
                                    },
                                    "submit": {
                                        "type": "boolean",
                                        "description": "Whether to submit the containing form after filling this element (default false).",
                                        "default": false
                                    }
                                },
                                "required": ["value"]
                            },
                            "description": "Form elements to fill, applied in order."
                        }
                    },
                    "required": ["elements"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "back".to_string(),
                description: "Go back to the previous page in the browser history and wait for navigation. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "forward".to_string(),
                description: "Go forward in the browser history and wait for navigation. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "emulate".to_string(),
                description: "Emulate browser features on the target page (CDP Emulation/Network domains): color scheme, CPU throttling, geolocation, extra HTTP headers, network conditions, user agent and viewport. Omitted fields are unchanged; null clears an override (colorScheme maps to auto, cpuThrottlingRate maps to 1). Empty userAgent/viewport also clear their overrides. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "colorScheme": {
                            "type": ["string", "null"],
                            "enum": ["dark", "light", "auto"],
                            "description": "Emulate prefers-color-scheme; auto or null clears the override."
                        },
                        "cpuThrottlingRate": {
                            "type": ["number", "null"],
                            "description": "CPU slowdown factor (range 1-20); 1 or null disables throttling.",
                            "minimum": 1,
                            "maximum": 20
                        },
                        "extraHttpHeaders": {
                            "type": ["object", "null"],
                            "additionalProperties": { "type": "string" },
                            "description": "Extra HTTP headers sent with every page request; null clears them."
                        },
                        "geolocation": {
                            "type": ["object", "null"],
                            "properties": {
                                "latitude": { "type": "number", "minimum": -90, "maximum": 90 },
                                "longitude": { "type": "number", "minimum": -180, "maximum": 180 },
                                "accuracy": { "type": "number", "minimum": 0 }
                            },
                            "required": ["latitude", "longitude"],
                            "description": "Geolocation override; null clears it."
                        },
                        "networkConditions": {
                            "type": ["string", "null"],
                            "enum": ["Offline", "Slow 3G", "Fast 3G", "Slow 4G", "Fast 4G"],
                            "description": "Network throttling preset; null restores online."
                        },
                        "userAgent": {
                            "type": ["string", "null"],
                            "description": "User agent override; an empty string clears it."
                        },
                        "viewport": {
                            "type": ["string", "null"],
                            "description": "Device viewport \"<width>x<height>[x<devicePixelRatio>][,mobile][,touch][,landscape]\"; an empty string clears it."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "resize_page".to_string(),
                description: "Resize the page viewport to the given dimensions (device metrics override). Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "width": {
                            "type": "integer",
                            "description": "Viewport width in pixels (50-8000).",
                            "minimum": 50,
                            "maximum": 8000
                        },
                        "height": {
                            "type": "integer",
                            "description": "Viewport height in pixels (50-8000).",
                            "minimum": 50,
                            "maximum": 8000
                        }
                    },
                    "required": ["width", "height"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "performance_start_trace".to_string(),
                description: "Start recording a performance trace (CDP Tracing) on the target page. Navigate or reload BEFORE starting when you want to capture load performance. Stop with performance_stop_trace to receive Core Web Vitals, long tasks and actionable insights. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "categories": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional trace categories (defaults to devtools.timeline, v8.execute, blink.user_timing, loading and latencyInfo)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "performance_stop_trace".to_string(),
                description: "Stop the active performance trace and return Core Web Vitals (FCP/LCP/CLS/load/DCL/first response), long-task statistics and insights (long-tasks, render-blocking, lcp, cls, document-latency, third-parties). filePath optionally saves the raw trace (.json or .json.gz) for Perfetto/DevTools. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path to save the raw trace data (.json, or .json.gz for compression)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "performance_analyze_insight".to_string(),
                description: "Return full details of one insight from the last stopped trace: long-tasks, render-blocking, lcp, cls, document-latency or third-parties. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "insightId": {
                            "type": "string",
                            "description": "Insight id from the performance_stop_trace result."
                        }
                    },
                    "required": ["insightId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_css_styles".to_string(),
                description: "Inspect the CSS cascade for an element: matched rules from all origins with source locations and media queries, inline style, inherited rules and computed values; overridden declarations are marked overloaded. Locate the element with selector or an accessibility ref (uid from browser-devtools action=ax). Rules are paginated (10 per page by default). Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "selector": {
                            "type": "string",
                            "description": "CSS selector of the element to inspect."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Accessibility ref (uid from browser-devtools action=ax) of the element to inspect."
                        },
                        "pageIdx": {
                            "type": "integer",
                            "description": "Zero-based page index for the matched rules list (default 0).",
                            "minimum": 0,
                            "maximum": 1000
                        },
                        "pageSize": {
                            "type": "integer",
                            "description": "Matched rules per page (default 10, range 1-100).",
                            "minimum": 1,
                            "maximum": 100
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "audit".to_string(),
                description: "Audit the current page: axe-core accessibility scan (violations with impact, help and failing targets), lightweight SEO checks (title, meta description, h1, lang, viewport, canonical, Open Graph) and best-practice checks (secure context, doctype, charset, duplicate ids, image alt). Also reports the console error count. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "categories": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": ["accessibility", "seo", "best-practices"]
                            },
                            "description": "Categories to run (default all three)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "take_heapsnapshot".to_string(),
                description: "Capture a V8 heap snapshot of the page and save it to filePath (.heapsnapshot). Analyze it with the get_heapsnapshot_* tools and compare_heapsnapshots. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path to save the .heapsnapshot file."
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_summary".to_string(),
                description: "Summarize a .heapsnapshot file: node/edge counts, total self size, detached node count, top constructors and node types by size.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "topN": {
                            "type": "integer",
                            "description": "Number of constructors to list (default 30).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "query_heapsnapshot_objects".to_string(),
                description: "Query objects inside a .heapsnapshot file by constructor name (plain text substring or /regex/), node type, minimum self size and detachedness; results carry nodeIndex values for follow-up calls.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "className": {
                            "type": "string",
                            "description": "Constructor name filter: substring match, or /regex/ for a regular expression."
                        },
                        "nodeType": {
                            "type": "string",
                            "description": "V8 node type filter, e.g. object, closure, string, array, code."
                        },
                        "minSelfSize": {
                            "type": "integer",
                            "description": "Minimum self size in bytes.",
                            "minimum": 0
                        },
                        "isDetached": {
                            "type": "boolean",
                            "description": "Only return detached DOM nodes."
                        },
                        "sortBy": {
                            "type": "string",
                            "enum": ["selfSize", "id"],
                            "description": "Sort order (default selfSize descending)."
                        },
                        "pageIdx": {
                            "type": "integer",
                            "description": "Zero-based page index (default 0).",
                            "minimum": 0
                        },
                        "pageSize": {
                            "type": "integer",
                            "description": "Rows per page (default 20, maximum 200).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_object_details".to_string(),
                description: "Describe one object inside a .heapsnapshot file by nodeIndex (id, constructor, type, self size, edge count, detachedness, retainer count).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "integer",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_edges".to_string(),
                description: "List outgoing references (edges) of one object inside a .heapsnapshot file by nodeIndex.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "integer",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum edges to return (default 50, maximum 500).",
                            "minimum": 1,
                            "maximum": 500
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_retainers".to_string(),
                description: "List objects retaining one object inside a .heapsnapshot file (reverse references) by nodeIndex.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "integer",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum retainers to return (default 50, maximum 500).",
                            "minimum": 1,
                            "maximum": 500
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_retaining_paths".to_string(),
                description: "Trace retaining paths from one object inside a .heapsnapshot file towards GC roots (why is it not collected) by nodeIndex.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "integer",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        },
                        "maxDepth": {
                            "type": "integer",
                            "description": "Maximum path depth (default 6, maximum 30).",
                            "minimum": 1,
                            "maximum": 30
                        },
                        "maxPaths": {
                            "type": "integer",
                            "description": "Maximum number of paths to return (default 5, maximum 20).",
                            "minimum": 1,
                            "maximum": 20
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_duplicate_strings".to_string(),
                description: "List the most wasteful duplicate strings inside a .heapsnapshot file (value, occurrences, wasted bytes).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "topN": {
                            "type": "integer",
                            "description": "Number of entries to list (default 20, maximum 200).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "compare_heapsnapshots".to_string(),
                description: "Compare two .heapsnapshot files and report the biggest constructor growth and shrink (leak hunting between two points in time).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "baseFilePath": {
                            "type": "string",
                            "description": "Absolute path of the earlier .heapsnapshot file."
                        },
                        "currentFilePath": {
                            "type": "string",
                            "description": "Absolute path of the later .heapsnapshot file."
                        },
                        "topN": {
                            "type": "integer",
                            "description": "Entries per direction (default 30, maximum 200).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["baseFilePath", "currentFilePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screencast_start".to_string(),
                description: "Start recording the page as a video (CDP screencast frames, combined into a MJPEG AVI on stop). Recording auto-stops at maxFrames or maxDurationMs. Stop with screencast_stop. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path for the resulting .avi file (defaults to the app recordings folder)."
                        },
                        "quality": {
                            "type": "integer",
                            "description": "JPEG frame quality (default 70, range 1-100).",
                            "minimum": 1,
                            "maximum": 100
                        },
                        "maxWidth": {
                            "type": "integer",
                            "description": "Optional maximum frame width in pixels.",
                            "minimum": 64,
                            "maximum": 3840
                        },
                        "maxFrames": {
                            "type": "integer",
                            "description": "Frame cap before auto-stop (default 1200, maximum 6000).",
                            "minimum": 1,
                            "maximum": 6000
                        },
                        "maxDurationMs": {
                            "type": "integer",
                            "description": "Duration cap before auto-stop in milliseconds (default 120000, maximum 600000).",
                            "minimum": 1000,
                            "maximum": 600000
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screencast_stop".to_string(),
                description: "Stop the active screencast and produce the MJPEG AVI file (returns file path, frame count, duration, size and fps). Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list_page_tools".to_string(),
                description: "List tools exposed by the page itself (WebMCP-style): the page registers window.__snowPageTools as an array or record of { name, description?, parameters?, run(args) }. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "call_page_tool".to_string(),
                description: "Execute a page-registered tool (window.__snowPageTools) by name with JSON parameters and return its JSON-serializable result. Use list_page_tools first. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "name": {
                            "type": "string",
                            "description": "Name of the page tool to execute."
                        },
                        "params": {
                            "description": "JSON-serializable parameters passed to the tool's run(args) function."
                        }
                    },
                    "required": ["name"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_tab_content".to_string(),
                description: "Extract the visible text content (document.body.innerText) of a browser tab, together with its URL and title. Also returns a compact `times` array (DOM metadata, kept separate from the body text) collected from <time>, relative-time and [datetime] elements: visible text, verbatim datetime attribute, timezone marker and nearby context, including dates that never reach the visible text. Useful for reading article text or page content without a screenshot. Omit instanceId to use the agent's working browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": INSTANCE_ID_DESCRIPTION
                        },
                        "maxLength": {
                            "type": "integer",
                            "description": "Maximum number of characters to return (default 20000, range 1000-100000).",
                            "default": DEFAULT_MAX_CONTENT_LENGTH,
                            "minimum": MIN_MAX_CONTENT_LENGTH,
                            "maximum": MAX_MAX_CONTENT_LENGTH
                        },
                        "includeTimes": {
                            "type": "boolean",
                            "description": "Include the `times` array derived from DOM time elements (default true); set false for body text only. Each entry keeps the visible text (empty when the element is not rendered, then marked `hidden`), the raw datetime attribute and nearby context; a missing datetime is null and an unparseable one is marked `datetimeInvalid`, never guessed. timezone is the raw Z/offset, or `unstated` when the attribute carries none. Entries whose visible text already contains a complete date present in the body are skipped; timesTotal/timesTruncated report the cap.",
                            "default": true
                        }
                    }
                }),
            },
        ];
        tools.push(McpTool {
            server_id: SERVER_ID.to_string(),
            name: "frames".to_string(),
            description: "Enumerate attached frames of an embedded browser, including cross-origin frames. Returns opaque document-scoped frameId and parentFrameId, main-frame flag and redacted URL/name. Re-enumerate after navigation or detachment; stale IDs never fall back to the main frame. Does not read cookies or authentication storage.".to_string(),
            input_schema: json!({"type": "object", "properties": {"instanceId": {"type": "string", "description": INSTANCE_ID_DESCRIPTION}}}),
        });
        tools.push(McpTool {
            server_id: SERVER_ID.to_string(),
            name: "request_share".to_string(),
            description: "Ask the user to share a browser tab with the agent. Only tabs explicitly shared by the user (or tabs the agent created itself) can be driven by the other browser tools; this tool shows an in-app confirmation on the tab and waits for the user's answer. Returns { shared: true } when granted, or { shared: false, reason: \"denied\" | \"domain-blocked\" } when the user declined, did not answer in time, or the tab URL is excluded by the browser agent domain policy. Returns an error when browser agent access is turned off in settings. Omit instanceId to target the agent's working browser tab.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": {
                        "type": "string",
                        "description": INSTANCE_ID_DESCRIPTION
                    }
                }
            }),
        });
        for tool in &mut tools {
            if matches!(
                tool.name.as_str(),
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
                tool.input_schema["properties"]["frameId"] = json!({
                    "type": "string",
                    "pattern": "^frame-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                    "description": "Optional opaque frameId from browser-frames. Omit for the main frame. IDs are bound to this tab/document; stale IDs fail without fallback. For devtools only snapshot/ax/console/network support frameId. When frameId is set and the tool accepts ref, ref must come from that frame's browser-devtools action=ax snapshot. Frame AX never returns input values."
                });
                if matches!(tool.name.as_str(), "hover" | "select_option") {
                    tool.input_schema["properties"]["ref"] = json!({"type": "string", "description": "Optional frame AX ref; requires frameId from the same snapshot."});
                }
                tool.description.push_str(" Optional frameId selects a document-scoped frame from browser-frames; stale IDs fail without fallback. Frame results and URLs are redacted.");
            }
        }
        for tool in &mut tools {
            // 动作类工具附带 observe/observeTimeoutMs/expect（issue #236），
            // 并在描述里明确 success 只代表派发成功。
            if matches!(
                tool.name.as_str(),
                "click" | "type" | "fill_form" | "select_option" | "press_key" | "scroll"
            ) {
                let schema = std::mem::take(&mut tool.input_schema);
                tool.input_schema = with_observation_schema(schema);
                tool.description.push_str(ACTION_RECEIPT_NOTE);
            }
            let schema = &mut tool.input_schema;
            match tool.name.as_str() {
                "navigate" => {
                    // Empty/null URL remains a compatibility placeholder on reload.
                    schema["properties"]["url"]["type"] = json!(["string", "null"]);
                    schema["properties"]["initScript"]["type"] = json!(["string", "null"]);
                }
                "devtools" => {
                    schema["properties"]["msgid"]["minimum"] = json!(1);
                    schema["properties"]["fileName"]["pattern"] = json!("^[A-Za-z0-9._-]{1,100}$");
                    schema["properties"]["fileName"]["maxLength"] = json!(100);
                    for field in ["types", "resourceTypes"] {
                        schema["properties"][field]["maxItems"] = json!(30);
                    }
                }
                "fill_form" => schema["properties"]["elements"]["maxItems"] = json!(50),
                "select_option" => schema["properties"]["values"]["minItems"] = json!(1),
                "upload-file" => schema["properties"]["files"]["minItems"] = json!(1),
                "performance_start_trace" => {
                    schema["properties"]["categories"]["maxItems"] = json!(30)
                }
                "performance_analyze_insight" => {
                    schema["properties"]["insightId"]["enum"] = json!([
                        "long-tasks",
                        "render-blocking",
                        "lcp",
                        "cls",
                        "document-latency",
                        "third-parties"
                    ])
                }
                "query_heapsnapshot_objects" => {
                    schema["properties"]["pageIdx"]["maximum"] = json!(100_000)
                }
                _ => {}
            }
        }
        tools
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "create"
            | "navigate"
            | "click"
            | "screenshot"
            | "devtools"
            | "close"
            | "focus"
            | "list"
            | "evaluate"
            | "type"
            | "fill_form"
            | "drag"
            | "wait"
            | "press_key"
            | "scroll"
            | "select_option"
            | "hover"
            | "upload-file"
            | "back"
            | "forward"
            | "get_tab_content"
            | "frames"
            | "emulate"
            | "resize_page"
            | "performance_start_trace"
            | "performance_stop_trace"
            | "performance_analyze_insight"
            | "get_css_styles"
            | "audit"
            | "take_heapsnapshot"
            | "get_heapsnapshot_summary"
            | "query_heapsnapshot_objects"
            | "get_heapsnapshot_object_details"
            | "get_heapsnapshot_edges"
            | "get_heapsnapshot_retainers"
            | "get_heapsnapshot_retaining_paths"
            | "get_heapsnapshot_duplicate_strings"
            | "compare_heapsnapshots"
            | "screencast_start"
            | "screencast_stop"
            | "list_page_tools"
            | "call_page_tool"
            | "request_share" => Err(Error::new(
                Status::GenericFailure,
                "Browser tools must be executed through the asynchronous Electron command bridge"
                    .to_string(),
            )),
            _ => Err(validation::unknown_tool_error(tool_name)),
        }
    }
}
