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

#[napi(object)]
pub struct BrowserCommand {
    pub operation: String,
    pub args_json: String,
}

pub type BrowserCommandCallback =
    ThreadsafeFunction<BrowserCommand, Promise<String>, BrowserCommand, Status, false>;

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
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "create".to_string(),
                description: "Create an embedded Electron browser instance in the right panel. Returns an instanceId for explicitly targeting it later. Optionally opens an initial URL.".to_string(),
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
                description: "Navigate an embedded browser instance to a URL (http://, https://, or file://) and wait asynchronously for loading to finish. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "url": {
                            "type": "string",
                            "description": "URL to visit (http://, https://, or file://)."
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Navigation timeout in milliseconds (default 30000, range 1000-120000).",
                            "default": DEFAULT_TIMEOUT_MS,
                            "minimum": MIN_TIMEOUT_MS,
                            "maximum": MAX_TIMEOUT_MS
                        }
                    },
                    "required": ["url"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "click".to_string(),
                description: "Click page content in an embedded browser with a real Electron mouse input event. Target an element with a CSS selector, visible text, or an accessibility ref (uid=... from browser-devtools action=ax). Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
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
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] },
                        { "required": ["ref"] }
                    ]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screenshot".to_string(),
                description: "Capture an embedded browser page as PNG. Omit instanceId to capture the most recently focused browser tab, including a browser opened by the user. Returns page metadata and an image content block containing base64 PNG data.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "fullPage": {
                            "type": "boolean",
                            "description": "Capture the full scrollable page instead of only the viewport (default false).",
                            "default": false
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "devtools".to_string(),
                description: "Inspect developer-tools-related information for an embedded browser. Omit instanceId to inspect the most recently focused browser tab, including a browser opened by the user. Use action=snapshot for page metadata and text, action=console for captured console messages (optionally filtered by level), action=network for recorded network requests (CDP records include requestId for details), action=network_detail for full details of a single request by id, action=network_clear to clear all recorded requests, action=networkDetails for full request/response headers and bodies of one request, action=networkState to simulate offline/online, action=route to mock network responses (intercept and fulfill matching requests), action=routeClear to remove all route mocks, action=storageSave to save login state (cookies + localStorage) as an encrypted file, action=storageRestore to restore login state from an encrypted file, action=cookies to list session cookies (values masked by default), action=cookieDelete to remove one cookie, action=dialog to list and respond to pending JavaScript dialogs (alert/confirm/prompt), or action=open to open Electron DevTools for the page.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "action": {
                            "type": "string",
                            "enum": ["snapshot", "console", "open", "network", "network_detail", "network_clear", "networkDetails", "networkState", "route", "routeClear", "storageSave", "storageRestore", "cookies", "cookieDelete", "ax", "trace", "dialog"],
                            "description": "Developer tools action (default snapshot).",
                            "default": "snapshot"
                        },
                        "durationMs": {
                            "type": "number",
                            "description": "Trace recording duration in milliseconds (trace action only, default 3000, range 1000-30000).",
                            "default": 3000,
                            "minimum": 1000,
                            "maximum": 30000
                        },
                        "verbose": {
                            "type": "boolean",
                            "description": "Include all accessibility nodes and input values (ax action only, default false = interactive/structural roles only).",
                            "default": false
                        },
                        "maxNodes": {
                            "type": "number",
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
                            "type": "number",
                            "description": "Maximum number of network requests to return (network action only, default 50, range 1-200).",
                            "default": 50,
                            "minimum": 1,
                            "maximum": 200
                        },
                        "requestId": {
                            "type": "string",
                            "description": "Network request reference. For networkDetails: CDP request id from the network list (string). For network_detail: the numeric id of the request to retrieve full details for (use network action first to obtain ids)."
                        },
                        "maxBodyBytes": {
                            "type": "number",
                            "description": "Maximum request/response body bytes to return (networkDetails action only, default 131072, range 1024-1048576).",
                            "default": 131072,
                            "minimum": 1024,
                            "maximum": 1048576
                        },
                        "state": {
                            "type": "string",
                            "enum": ["online", "offline"],
                            "description": "Network state to simulate (networkState action only): offline makes all network requests fail, online restores connectivity."
                        },
                        "pattern": {
                            "type": "string",
                            "description": "URL pattern to mock (route action only). Plain text = substring match; /regex/ = regular expression match. Example: \"/api/users\" or \"/.*\\.png\""
                        },
                        "status": {
                            "type": "number",
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
                            "description": "Response for the dialog action: { accept: boolean, promptText?: string }. When provided, the most recent pending dialog is answered instead of listing dialogs.",
                            "properties": {
                                "accept": {
                                    "type": "boolean",
                                    "description": "true to accept (OK) the dialog, false to dismiss (Cancel)."
                                },
                                "promptText": {
                                    "type": "string",
                                    "description": "Text to enter for prompt dialogs."
                                }
                            },
                            "required": ["accept"]
                        },
                        "maxContentLength": {
                            "type": "number",
                            "description": "Maximum page text length for snapshot (default 20000, range 1000-100000).",
                            "default": DEFAULT_MAX_CONTENT_LENGTH,
                            "minimum": MIN_MAX_CONTENT_LENGTH,
                            "maximum": MAX_MAX_CONTENT_LENGTH
                        },
                        "fileName": {
                            "type": "string",
                            "description": "State file name for storageSave/storageRestore (letters, digits, dot, dash, underscore; max 100 chars). storageSave generates one when omitted."
                        },
                        "domain": {
                            "type": "string",
                            "description": "Cookie domain filter (cookies action only), e.g. \".github.com\"."
                        },
                        "showValues": {
                            "type": "boolean",
                            "description": "Return cookie values in plaintext (cookies action only, default false = masked). WARNING: plaintext output contains sensitive credentials.",
                            "default": false
                        },
                        "name": {
                            "type": "string",
                            "description": "Cookie name to delete (cookieDelete action only, combined with domain)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "wait".to_string(),
                description: "Wait for a condition on the page: fixed time, text to appear/disappear, or element (CSS selector) to appear/disappear. Inspired by Playwright's browser_wait_for. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "time": {
                            "type": "number",
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
                            "type": "number",
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
                description: "Press a keyboard key on the page. Use for shortcuts, Enter, Escape, Tab, Arrow keys, etc. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
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
                name: "hover".to_string(),
                description: "Hover over an element on the page with a real mouse move event. Target an element with a CSS selector or visible text. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
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
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] }
                    ]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "select_option".to_string(),
                description: "Select option(s) in a dropdown (<select>) element. Target the element with a CSS selector or visible text. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
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
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] }
                    ],
                    "required": ["values"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "close".to_string(),
                description: "Close an embedded browser tab and destroy its webview. Omit instanceId to close the most recently focused browser tab. Use the list tool to see available browser tabs and their IDs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID to close. Omit it or use current to close the most recently focused browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "focus".to_string(),
                description: "Switch to (activate) an embedded browser tab by its instance ID, bringing it to the foreground. Use the list tool to see available browser tabs and their IDs.".to_string(),
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
                description: "List all open embedded browser tabs with their instance IDs, titles, URLs, and active state. Use this to discover available tabs before closing or switching.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "evaluate".to_string(),
                description: "Evaluate a JavaScript expression in an embedded browser page and return the serialized result. Use for inspecting page state, reading variables, or exercising the page directly. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "expression": {
                            "type": "string",
                            "description": "JavaScript expression to evaluate in the page (e.g. \"document.title\" or \"(() => ({ url: location.href, ready: document.readyState }))()\")."
                        }
                    },
                    "required": ["expression"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "type".to_string(),
                description: "Type text into an editable element in an embedded browser. Target the element with a CSS selector, visible text, or an accessibility ref (uid=... from browser-devtools action=ax; same locating rules as browser-click). By default the value is set at once and input/change events are fired; pass delayMs to type character by character for key handlers. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
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
                            "description": "Text to type into the element."
                        },
                        "submit": {
                            "type": "boolean",
                            "description": "Whether to submit the containing form after typing (default false).",
                            "default": false
                        },
                        "delayMs": {
                            "type": "number",
                            "description": "When greater than 0, type one character at a time with this delay in milliseconds (default 0 = set value at once).",
                            "default": 0,
                            "minimum": 0,
                            "maximum": 1000
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] },
                        { "required": ["ref"] }
                    ],
                    "required": ["value"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "upload-file".to_string(),
                description: "Upload file(s) to a file input element. Target with a CSS selector, visible text, or accessibility ref. Files are injected directly via CDP (no file chooser dialog). Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
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
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] },
                        { "required": ["ref"] }
                    ],
                    "required": ["files"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "back".to_string(),
                description: "Go back to the previous page in the browser history and wait for navigation. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "forward".to_string(),
                description: "Go forward in the browser history and wait for navigation. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "open_tab".to_string(),
                description: "Open a new tab inside an embedded browser instance and navigate it to a URL. The new tab becomes the active tab of that instance. Omit instanceId to use the most recently focused browser instance.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "url": {
                            "type": "string",
                            "description": "URL to open in the new tab (http://, https://, or file://)."
                        }
                    },
                    "required": ["url"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list_tabs".to_string(),
                description: "List all tabs inside an embedded browser instance with their tab IDs, titles, URLs, and active state. Use this to discover tabs before switching or closing them. Omit instanceId to use the most recently focused browser instance.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "close_tab".to_string(),
                description: "Close a tab inside an embedded browser instance by its tab ID (from browser-list_tabs). Closing the last tab of an instance opens a fresh homepage tab instead, so the instance always keeps at least one tab. Omit instanceId to use the most recently focused browser instance.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "tabId": {
                            "type": "string",
                            "description": "The tab ID to close (from browser-list_tabs)."
                        }
                    },
                    "required": ["tabId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "focus_tab".to_string(),
                description: "Switch to (activate) a tab inside an embedded browser instance by its tab ID (from browser-list_tabs), bringing it to the foreground. Subsequent page-level operations (navigate, click, screenshot, etc.) act on this tab. Omit instanceId to use the most recently focused browser instance.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "tabId": {
                            "type": "string",
                            "description": "The tab ID to activate (from browser-list_tabs)."
                        }
                    },
                    "required": ["tabId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_tab_content".to_string(),
                description: "Extract the visible text content (document.body.innerText) of the active tab in an embedded browser instance, together with its URL and title. Useful for reading article text or page content without a screenshot. Omit instanceId to use the most recently focused browser instance.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "maxLength": {
                            "type": "number",
                            "description": "Maximum number of characters to return (default 20000, range 1000-100000).",
                            "default": DEFAULT_MAX_CONTENT_LENGTH,
                            "minimum": MIN_MAX_CONTENT_LENGTH,
                            "maximum": MAX_MAX_CONTENT_LENGTH
                        }
                    }
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "create" | "navigate" | "click" | "screenshot" | "devtools" | "close" | "focus"
            | "list" | "evaluate" | "type" | "wait" | "press_key"
            | "select_option" | "hover" | "upload-file" | "back"
            | "forward" | "open_tab"
            | "list_tabs" | "close_tab" | "focus_tab" | "get_tab_content" => Err(Error::new(
                Status::GenericFailure,
                "Browser tools must be executed through the asynchronous Electron command bridge"
                    .to_string(),
            )),
            _ => Err(validation::unknown_tool_error(tool_name)),
        }
    }
}
