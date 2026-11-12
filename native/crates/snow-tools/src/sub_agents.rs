use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::contract::{McpService, McpTool};

const SERVER_ID: &str = "sub-agents";

/// Only explicitly authorized child communication; never implicitly delegated.
pub const SUB_AGENT_COMMS_TOOL_FULL_NAMES: &[&str] = &["sub-agents-sendMessage"];

/// Parent-only management capabilities. Retired names stay reserved below.
pub const SUB_AGENT_MAIN_TOOL_FULL_NAMES: &[&str] = &[
    "sub-agents-activate",
    "sub-agents-continue",
    "sub-agents-getResult",
    "sub-agents-cancel",
];

/// One source for save, collection and execution restrictions. Retired names
/// cannot be resurrected through old configurations or the built-in wildcard.
pub const SUB_AGENT_RESERVED_TOOL_FULL_NAMES: &[&str] = &[
    "sub-agents-activate",
    "sub-agents-listSubAgents",
    "sub-agents-listTeammates",
    "sub-agents-continue",
    "sub-agents-getResult",
    "sub-agents-wait",
    "sub-agents-cancel",
    "app-control-conversation",
    "workflow-workflow-generate",
    "workflow-workflow-resume",
];

pub fn is_sub_agent_reserved_tool(full_name: &str) -> bool {
    SUB_AGENT_RESERVED_TOOL_FULL_NAMES.contains(&full_name)
}

pub fn sub_agent_comms_tools() -> Vec<McpTool> {
    vec![McpTool {
        server_id: SERVER_ID.into(),
        name: "sendMessage".into(),
        description: "Queue a message to an explicitly authorized collaborator using the exact recipientRunId supplied by the host collaborator ledger. Do not infer identities from prose or reuse a previous run. The host validates same project, parent, task and nonempty collaborationGroup and current configuration permission. A queued receipt is not delivery or understanding; terminal/finalizing/cancelling runs reject new messages. This capability never resumes or starts a run.".into(),
        input_schema: json!({"type":"object","properties":{
            "recipientRunId":{"type":"string","minLength":1,"description":"Exact current collaborator run identity supplied by the host."},
            "message":{"type":"string","minLength":1},
            "requestId":{"type":"string","minLength":1,"maxLength":160,"description":"Stable logical send identity; reuse after an unknown receipt. The host derives one when omitted."}
        },"required":["recipientRunId","message"],"additionalProperties":false}),
    }]
}

fn acceptance_schema() -> Value {
    json!({"type":"array","maxItems":20,
        "description":"Optional acceptance criteria. The child reports every item in a fenced acceptance JSON block with evidence IDs from actual tool results. Host validation proves execution-log provenance, not relevance or business correctness; the parent verifies supporting results.",
        "items":{"type":"object","properties":{
            "id":{"type":"string","description":"Stable short criterion identity."},
            "description":{"type":"string","description":"What must actually be true."},
            "required":{"type":"boolean","description":"Defaults to true."}
        },"required":["id","description"],"additionalProperties":false}})
}

fn operation_properties() -> Value {
    json!({
        "executionMode":{"type":"string","enum":["sync","async"],"description":"Execution mode for THIS dispatch. sync: the call blocks until the child finishes and returns its final result; choose it when your next step depends on that result. async: the call returns an accepted receipt immediately so you can keep working, and the host delivers the result to this conversation when the child finishes; choose it for long, independent work that can overlap with your own. Omit to use the default stated in this tool's description. A busy continue target keeps its original run mode and only queues the message."},
        "requestId":{"type":"string","minLength":1,"maxLength":160,"description":"Stable logical operation identity. Host-derived when omitted; reuse after an unknown receipt, use a new identity only for an intentional new operation."},
        "collaborationGroup":{"type":"string","minLength":1,"maxLength":80,"description":"Explicit collaboration authorization for THIS new run, intersected with configured communication permission. Omission grants no peer communication and never inherits an old group. Use the same group only for collaborators in this parent task."},
        "acceptance":acceptance_schema()
    })
}

pub struct SubAgentsService;

impl SubAgentsService {
    pub fn new() -> Self {
        SubAgentsService
    }
}

impl McpService for SubAgentsService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        let mut activate = operation_properties();
        activate["agentId"] = json!({"type":"string","description":"Configured sub-agent identity from the available agent list. Prefer the matching specialist over the built-in generic fallback."});
        activate["prompt"] = json!({"type":"string","description":"Fully self-contained task, paths, frozen contracts, permitted files/tools, constraints and verification responsibilities. The child cannot access parent history."});
        activate["summary"] = json!({"type":"string","description":"Short specific task label in the user's language, used as the child conversation title."});
        let mut continuation = operation_properties();
        continuation["conversationId"] = json!({"type":"string","minLength":1,"description":"Exact child conversation identity supplied by the host child-run ledger or a previous activation receipt."});
        continuation["message"] = json!({"type":"string","minLength":1,"description":"Explicit follow-up task or message for this child."});
        let mut tools = vec![
            McpTool { server_id: SERVER_ID.into(), name: "activate".into(),
                description: "Delegate one independent task to one sub-agent with restricted tools and a self-contained prompt. For independent parallel work issue separate calls in the same batch. Children cannot recursively delegate. Final summaries contain final-turn text, not a full transcript; open the child conversation for intermediate reports. Optional acceptance evidence needs parent review. Read the actual receipt: accepted means durable acceptance, not completion; the host delivers eligible completion events without polling.".into(),
                input_schema: json!({"type":"object","properties":activate,"required":["agentId","summary","prompt"],"additionalProperties":false}) },
            McpTool { server_id: SERVER_ID.into(), name: "continue".into(),
                description: "Parent-only explicit follow-up to an existing child in this conversation. A busy target only queues a message for its current run; a terminal child starts a new run only for this explicit request. Old ledger/task information is not permission to resume. Original configuration and conversation history are retained, but collaboration requires a new explicit collaborationGroup. Optional acceptance refines/adds criteria while preserving recorded item statuses. For independent follow-ups issue separate calls in the same batch. Trust actual receipt kind/executionMode rather than current settings; queued is not delivered or understood.".into(),
                input_schema: json!({"type":"object","properties":continuation,"required":["conversationId","message"],"additionalProperties":false}) },
            McpTool { server_id: SERVER_ID.into(), name: "getResult".into(),
                description: "Read an immutable terminal result or another summary page using an exact runId from the host ledger/receipt. Not a progress query. Terminal errors, acceptance and delivery metadata remain present; summary is final-turn text, not the full transcript. Evidence IDs establish provenance, not semantic correctness. UI/read queries do not acknowledge model delivery or reopen old tasks. The host delivers eligible completion events automatically; no polling or waiting is required.".into(),
                input_schema: json!({"type":"object","properties":{
                    "runId":{"type":"string","minLength":1},"offset":{"type":"integer","minimum":0},
                    "limit":{"type":"integer","minimum":1,"maximum":64000,"default":16000}},"required":["runId"],"additionalProperties":false}) },
            McpTool { server_id: SERVER_ID.into(), name: "cancel".into(),
                description: "Request cancellation of an actually cancellable run using its exact runId. requested is not confirmation of stopped execution; confirmed means cancelled, already_terminal preserves the result, too_late means finalizing won. The first accepted cancellation source/time is retained; historical missing attribution is unknown. Never claim that cancellation undoes files or external effects.".into(),
                input_schema: json!({"type":"object","properties":{"runId":{"type":"string","minLength":1}},"required":["runId"],"additionalProperties":false}) },
        ];
        tools.extend(sub_agent_comms_tools());
        tools
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "activate" | "continue" | "cancel" | "getResult" | "sendMessage" => Err(Error::new(
                Status::GenericFailure,
                format!("sub-agents {tool_name} requires the authorized Electron runtime bridge"),
            )),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!("Unknown sub-agents tool: {tool_name}"),
            )),
        }
    }
}
