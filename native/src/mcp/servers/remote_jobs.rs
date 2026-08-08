use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "remote-job";

pub struct RemoteJobsService;

impl RemoteJobsService {
    pub fn new() -> Self {
        Self
    }
}

impl McpService for RemoteJobsService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "start".to_string(),
                description: "Start a durable command on the active SSH workspace. The task keeps running after the SSH channel and the application disconnect. Use batch mode for builds, tests, installs, deployments, or commands with unknown duration. Use interactive mode only when a running task needs terminal input; interactive tasks require the signed Snow Agent PTY broker and can be attached while running. The result includes an idempotent jobId; never retry with a new jobId when the start result is uncertain.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Command to run on the remote POSIX host." },
                        "description": { "type": "string", "description": "Required short user-facing explanation in the user's language." },
                        "workingDirectory": { "type": "string", "description": "Required SSH workspace path or a path relative to the active SSH workspace." },
                        "timeout": { "type": "number", "description": "Optional maximum duration in milliseconds, capped at 30 minutes." },
                        "jobId": { "type": "string", "description": "Optional existing UUID idempotency key. Reuse the same value only for an exact retry of the same command." },
                        "backend": { "type": "string", "enum": ["snow-agent", "systemd-user", "tmux", "posix-detach"], "description": "Optional fixed backend. Omit to select a verified backend." },
                        "mode": { "type": "string", "enum": ["batch", "interactive"], "default": "batch", "description": "Optional execution mode. Interactive tasks can be attached while running and require the signed Snow Agent PTY broker." }
                    },
                    "required": ["command", "description", "workingDirectory"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "status".to_string(),
                description: "Query the persisted state of a durable Remote Job by jobId. Use after a disconnected or ambiguous start before attempting any retry.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "jobId": { "type": "string", "description": "Remote Job UUID returned by remote-job-start." }
                    },
                    "required": ["jobId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "read".to_string(),
                description: "Read incremental output and current state from a durable Remote Job. Continue with nextOffset to avoid rereading prior output; analyze failures from this output before changing source or retrying.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "jobId": { "type": "string", "description": "Remote Job UUID." },
                        "offset": { "type": "number", "minimum": 0, "description": "Byte offset, normally the prior nextOffset." },
                        "limit": { "type": "number", "minimum": 1, "description": "Maximum bytes to read, capped by the application." }
                    },
                    "required": ["jobId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "cancel".to_string(),
                description: "Request cancellation of a durable Remote Job and return its observed state. Do not claim side effects were rolled back; inspect the workspace after cancelling deployments, migrations, or other writes.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "jobId": { "type": "string", "description": "Remote Job UUID." }
                    },
                    "required": ["jobId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list".to_string(),
                description: "List persisted Remote Jobs. Optionally constrain the list to the active SSH workspace.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "workingDirectory": { "type": "string", "description": "Optional SSH workspace path." }
                    }
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "Remote Job tool {tool_name} must be executed through the asynchronous SSH dispatcher"
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_tool_declares_interactive_mode() {
        let start = RemoteJobsService::new()
            .tools()
            .into_iter()
            .find(|tool| tool.name == "start")
            .expect("remote-job-start tool");

        assert!(!start.description.contains("non-interactive"));
        assert_eq!(
            start.input_schema["properties"]["mode"]["enum"],
            serde_json::json!(["batch", "interactive"])
        );
        assert_eq!(
            start.input_schema["properties"]["mode"]["default"],
            serde_json::json!("batch")
        );
    }
}
