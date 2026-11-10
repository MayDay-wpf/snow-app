use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::Value;

use super::super::service::McpService;
use super::super::tools::McpTool;

mod tool_definitions;
mod validation;

pub(crate) use tool_definitions::{resolve_operation, tool_actions};

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
        let (operation, normalized_args) =
            validation::validate_and_normalize_args(tool_name, args)?;
        let command = BrowserCommand {
            operation,
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
        tool_definitions::definitions()
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "tab" | "page" | "interact" | "devtools" | "inspect" | "emulate" | "perf" | "heap"
            | "page-tools" | "request_share" => Err(Error::new(
                Status::GenericFailure,
                "Browser tools must be executed through the asynchronous Electron command bridge"
                    .to_string(),
            )),
            _ => Err(validation::unknown_tool_error(tool_name)),
        }
    }
}
