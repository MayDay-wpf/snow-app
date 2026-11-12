//! Range rollback metadata. This is a gate over existing runs/events, not a queue.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Tool-call entry marker written by the schema 66 backfill.
const LEGACY_DISPATCH_KEY: &str = "legacyDispatch";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct RequestRemoval {
    operation: String,
    request_id: String,
    message_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct RangePlan {
    fingerprint: String,
    removed_runs: Vec<String>,
    requests: Vec<RequestRemoval>,
    receipts: Vec<String>,
    runs: Vec<String>,
    workflow_nodes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    peer_messages: Vec<String>,
}
struct StoredMessage {
    id: String,
    message_id: String,
    role: String,
    calls: String,
    raw: String,
    content: String,
}
struct DispatchCall {
    message_id: String,
    /// Position inside the persisted tool-call array (exact JSON path anchor).
    index: usize,
    name: String,
    call_id: String,
    interaction_id: String,
    request_id: String,
    invalid_arguments: bool,
    /// Set only by the schema 66 backfill: no durable owner existed for it.
    legacy: bool,
}

pub(super) fn ensure_tables(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS sub_agent_rollback_gates (
      conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
      rollback_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      parent_conversation_id TEXT NOT NULL REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
      boundary_kind TEXT NOT NULL CHECK(boundary_kind IN ('message','response')),
      boundary_target TEXT NOT NULL,
      boundary_message_id TEXT NOT NULL,
      plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
      created_at INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'prepared' CHECK(phase IN ('prepared','restoring'))
    );")?;
    let has_phase: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sub_agent_rollback_gates') WHERE name='phase')",
        [], |row| row.get(0),
    )?;
    if !has_phase {
        db.execute_batch("ALTER TABLE sub_agent_rollback_gates ADD COLUMN phase TEXT NOT NULL DEFAULT 'prepared' CHECK(phase IN ('prepared','restoring'));")?;
    }
    Ok(())
}

fn load_messages(db: &Connection, conversation: &str) -> rusqlite::Result<Vec<StoredMessage>> {
    let mut statement = db.prepare(
        "SELECT id,message_id,role,tool_calls_json,raw_json,content
      FROM chat_messages WHERE conversation_id=?1 ORDER BY id",
    )?;
    let result = statement
        .query_map([conversation], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                message_id: row.get(1)?,
                role: row.get(2)?,
                calls: row.get(3)?,
                raw: row.get(4)?,
                content: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}
fn messages(db: &Connection, conversation: &str) -> Result<Vec<StoredMessage>> {
    load_messages(db, conversation).map_err(persistence)
}
fn string_field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
}
fn parsed(value: &Value) -> Option<Value> {
    match value {
        Value::String(raw) => serde_json::from_str(raw).ok(),
        value if value.is_object() || value.is_array() => Some(value.clone()),
        _ => None,
    }
}
fn calls(messages: &[StoredMessage]) -> Result<Vec<DispatchCall>> {
    let mut result = Vec::new();
    for message in messages
        .iter()
        .filter(|message| message.role.eq_ignore_ascii_case("assistant"))
    {
        if message.calls.trim().is_empty() {
            continue;
        }
        let entries: Value = serde_json::from_str(&message.calls)
            .map_err(|_| fault("ROLLBACK_UNRESOLVED", "persisted tool calls are not JSON"))?;
        for (index, entry) in entries.as_array().into_iter().flatten().enumerate() {
            let function = ["function", "function_call", "functionCall"]
                .iter()
                .find_map(|key| entry.get(*key))
                .unwrap_or(entry);
            let name = string_field(function, &["name"]).unwrap_or("");
            if !matches!(
                name,
                "sub-agents-activate"
                    | "sub-agents-continue"
                    | "sub-agents-sendMessage"
                    | "workflow-workflow-generate"
            ) {
                continue;
            }
            let arguments = function
                .get("arguments")
                .or_else(|| function.get("args"))
                .and_then(parsed)
                .unwrap_or(Value::Null);
            result.push(DispatchCall {
                message_id: message.id.clone(),
                index,
                name: name.to_string(),
                call_id: string_field(entry, &["call_id", "callId", "id"])
                    .or_else(|| string_field(function, &["call_id", "callId", "id"]))
                    .unwrap_or("")
                    .to_string(),
                interaction_id: string_field(entry, &["interactionId", "interaction_id"])
                    .unwrap_or("")
                    .to_string(),
                request_id: string_field(&arguments, &["requestId"])
                    .unwrap_or("")
                    .to_string(),
                invalid_arguments: !arguments.is_object(),
                legacy: entry.get(LEGACY_DISPATCH_KEY).and_then(Value::as_bool) == Some(true),
            });
        }
    }
    Ok(result)
}
struct PersistedToolResult {
    message_id: String,
    name: String,
    call_id: String,
    value: Value,
}

// Only host tool-result envelopes participate. Structured arrays are
// authoritative; only raw_json={} may use the exact legacy framed format.
fn persisted_tool_results(messages: &[StoredMessage]) -> Vec<PersistedToolResult> {
    let mut results = Vec::new();
    for message in messages
        .iter()
        .filter(|message| message.role.eq_ignore_ascii_case("tool"))
    {
        let structured = serde_json::from_str::<Value>(&message.raw).ok();
        let mut entries = structured
            .as_ref()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        if structured
            .as_ref()
            .is_some_and(|value| value.as_object().is_some_and(|object| object.is_empty()))
        {
            if let Some(framed) = message.content.strip_prefix("[Tool: ") {
                for segment in framed.split("\n\n[Tool: ") {
                    let Some((header, body)) = segment.split_once("]\n") else {
                        continue;
                    };
                    let Some((tool, call)) = header.split_once('#') else {
                        continue;
                    };
                    let end = ["\n\n[Hook Context]\n", "\n\n[Hook Warnings]\n"]
                        .iter()
                        .filter_map(|marker| body.find(marker))
                        .min()
                        .unwrap_or(body.len());
                    if let Ok(value) = serde_json::from_str::<Value>(&body[..end]) {
                        entries.push(json!({"name":tool,"callId":call,"result":value}));
                    }
                }
            }
        }
        for entry in entries {
            let Some(name) = entry["name"].as_str() else {
                continue;
            };
            let Some(call_id) =
                string_field(&entry, &["callId", "call_id"]).filter(|id| !id.is_empty())
            else {
                continue;
            };
            let Some(value) = entry.get("result").and_then(parsed) else {
                continue;
            };
            results.push(PersistedToolResult {
                message_id: message.id.clone(),
                name: name.to_string(),
                call_id: call_id.to_string(),
                value,
            });
        }
    }
    results
}
fn result_call_ids(
    messages: &[StoredMessage],
    operation: &str,
    request: &str,
    run: &str,
) -> BTreeSet<String> {
    let name = format!("sub-agents-{operation}");
    persisted_tool_results(messages)
        .into_iter()
        .filter(|result| result.name == name)
        .filter(|result| match result.value["requestId"].as_str() {
            Some(identity) => identity == request,
            None => {
                !run.is_empty()
                    && result.value["kind"] != "message_queued"
                    && (result.value["runId"].as_str() == Some(run)
                        || result.value.pointer("/run/runId").and_then(Value::as_str) == Some(run))
            }
        })
        .map(|result| result.call_id)
        .collect()
}
// Return a call index, not just its message: one assistant row can contain
// several dispatches, and covering one must not silently cover its siblings.
fn request_boundary(
    messages: &[StoredMessage],
    calls: &[DispatchCall],
    operation: &str,
    request: &str,
    run: &str,
    interaction: Option<&str>,
) -> Result<usize> {
    let result_ids = result_call_ids(messages, operation, request, run);
    let name = format!("sub-agents-{operation}");
    let matched: Vec<usize> = calls
        .iter()
        .enumerate()
        .filter(|(_, call)| call.name == name)
        .filter(|(_, call)| {
            call.request_id == request
                || (!call.interaction_id.is_empty()
                    && (interaction == Some(call.interaction_id.as_str())
                        || request == format!("{operation}:{}", call.interaction_id)))
                || (!call.call_id.is_empty() && result_ids.contains(&call.call_id))
        })
        .map(|(index, _)| index)
        .collect();
    if matched.len() != 1 {
        return Err(fault("ROLLBACK_UNRESOLVED", "dispatch has no unique persisted tool-call/request boundary; legacy attribution cannot be inferred from time"));
    }
    Ok(matched[0])
}

fn failed_before_dispatch(value: &Value, call: &DispatchCall) -> bool {
    // A failed legacy run still has conversationId/outcome; it is NOT proof
    // that dispatch never happened. Unknown/host-persistence failures also
    // remain unresolved, irrespective of a card's visual error status.
    if [
        "runId",
        "conversationId",
        "messageId",
        "outcome",
        "run",
        "queued",
        "acceptance",
        "agentName",
    ]
    .iter()
    .any(|key| value.get(*key).is_some_and(|value| !value.is_null()))
    {
        return false;
    }
    let Some(error) = value["error"]
        .as_str()
        .filter(|error| !error.trim().is_empty())
    else {
        return false;
    };
    if call.invalid_arguments && value.as_object().is_some_and(|object| object.len() == 1) {
        return true; // validateToolCall rejects these persisted arguments before execution.
    }
    if value["success"] != false
        || matches!(value["kind"].as_str(), Some("accepted" | "message_queued"))
        || value["created"] == true
    {
        return false;
    }
    if error == "HOOK_DECISION_REJECTED" {
        return value["message"].is_string();
    }
    if error == "TOOL_EXECUTION_DENIED" {
        return value["reason"].is_string()
            && value
                .get("toolName")
                .map_or(true, |name| name.as_str() == Some(call.name.as_str()));
    }
    // These are the actual toolFailure admission-error envelopes. A run
    // accepted before a later failure must already resolve through the durable
    // run/request pass; its missing attribution still fails closed there.
    matches!(
        (value["code"].as_str(), value["category"].as_str()),
        (
            Some(
                "VALIDATION_ERROR"
                    | "RUN_NOT_FOUND"
                    | "REQUEST_CONFLICT"
                    | "RUN_BUSY"
                    | "UNSUPPORTED_EXECUTION_MODE"
            ),
            Some("validation")
        ) | (Some("CONFIGURATION_ERROR"), Some("configuration"))
            | (Some("PERMISSION_DENIED"), Some("permission"))
    )
}
fn verify_dispatch_coverage(
    messages: &[StoredMessage],
    calls: &[DispatchCall],
    from: &str,
    covered: &BTreeSet<usize>,
) -> Result<()> {
    let results = persisted_tool_results(messages);
    for (index, call) in calls.iter().enumerate().filter(|(_, call)| {
        call.message_id.as_str() >= from
            && matches!(
                call.name.as_str(),
                "sub-agents-activate" | "sub-agents-continue"
            )
    }) {
        if covered.contains(&index) {
            continue;
        }
        // Proven at migration time (see backfill_dispatch_identity): no durable
        // run/request owned it and no dispatch could be in flight at startup.
        if call.legacy {
            continue;
        }
        let unique_identity = !call.call_id.is_empty()
            && calls
                .iter()
                .filter(|other| other.name == call.name && other.call_id == call.call_id)
                .count()
                == 1;
        let observed: Vec<_> = results
            .iter()
            .filter(|result| {
                result.name == call.name
                    && result.call_id == call.call_id
                    && result.message_id > call.message_id
            })
            .collect();
        if unique_identity
            && !observed.is_empty()
            && observed
                .iter()
                .all(|result| failed_before_dispatch(&result.value, call))
        {
            continue;
        }
        return Err(fault("ROLLBACK_UNRESOLVED", "dispatch in rollback range has no exact durable run/queued-request coverage or proven pre-dispatch failure; legacy sessions cannot be inferred"));
    }
    Ok(())
}

/// Schema 66 backfill for activate/continue tool calls persisted without host
/// identity (issue #318). It writes exact attribution only, never by time:
/// - `interactionId`: a durable request of this parent was derived from this
///   exact call (`tool-<callId>`, the renderer's tool-call identity), so
///   `request_boundary` resolves it uniquely;
/// - `legacyDispatch`: no durable run/request references the call and no
///   persisted result claims an accepted run. Migration runs at startup, when
///   no dispatch can be in flight, so such a call provably has no owner.
/// Ambiguous call ids stay unresolved (fail closed). Conversations holding a
/// rollback gate keep their fingerprinted history untouched.
pub fn backfill_dispatch_identity(db: &Connection) -> rusqlite::Result<()> {
    let conversations = {
        let mut statement = db.prepare(
            "SELECT DISTINCT conversation_id FROM chat_messages
              WHERE lower(role)='assistant'
                AND (instr(tool_calls_json,'sub-agents-activate')>0
                  OR instr(tool_calls_json,'sub-agents-continue')>0)
                AND conversation_id NOT IN (SELECT conversation_id FROM sub_agent_rollback_gates)",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for conversation in conversations {
        let stored = load_messages(db, &conversation)?;
        // Malformed tool-call history stays fail-closed for rollback.
        let Ok(dispatches) = calls(&stored) else {
            continue;
        };
        // (operation, request id, interaction of the accepted run)
        let requests = {
            let mut statement = db.prepare(
                "SELECT r.operation,r.request_id,
                   CASE WHEN json_extract(r.receipt_json,'$.kind')='accepted'
                     THEN json_extract(run.record_json,'$.interactionId') END
                 FROM sub_agent_run_requests r JOIN sub_agent_runs run ON run.run_id=r.run_id
                 WHERE r.parent_conversation_id=?1",
            )?;
            let rows = statement.query_map([&conversation], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let results = persisted_tool_results(&stored);
        for call in &dispatches {
            let Some(operation) = call
                .name
                .strip_prefix("sub-agents-")
                .filter(|operation| matches!(*operation, "activate" | "continue"))
            else {
                continue;
            };
            if call.legacy || !call.interaction_id.is_empty() {
                continue;
            }
            let interaction = (!call.call_id.is_empty()).then(|| format!("tool-{}", call.call_id));
            let derived = interaction
                .as_ref()
                .map(|interaction| format!("{operation}:{interaction}"));
            let mut explicit = false;
            let mut attributed = false;
            for (request_operation, request, run_interaction) in &requests {
                if request_operation != operation {
                    continue;
                }
                explicit |= !call.request_id.is_empty() && *request == call.request_id;
                attributed |= derived.as_deref() == Some(request.as_str())
                    || (interaction.is_some() && run_interaction.as_deref() == interaction.as_deref());
            }
            // An explicit requestId already resolves through the arguments.
            if explicit {
                continue;
            }
            let entry = format!("$[{}]", call.index);
            if attributed {
                let unique = dispatches
                    .iter()
                    .filter(|other| other.name == call.name && other.call_id == call.call_id)
                    .count()
                    == 1;
                if let (true, Some(interaction)) = (unique, interaction) {
                    db.execute(
                        "UPDATE chat_messages SET tool_calls_json=json_set(tool_calls_json,?2,?3) WHERE id=?1",
                        params![call.message_id, format!("{entry}.interactionId"), interaction],
                    )?;
                }
                continue;
            }
            let claims_run = !call.call_id.is_empty()
                && results.iter().any(|result| {
                    result.name == call.name
                        && result.call_id == call.call_id
                        && ["runId", "requestId", "run"]
                            .iter()
                            .any(|key| result.value.get(*key).is_some_and(|value| !value.is_null()))
                });
            if claims_run {
                continue;
            }
            db.execute(
                "UPDATE chat_messages SET tool_calls_json=json_set(tool_calls_json,?2,json('true')) WHERE id=?1",
                params![call.message_id, format!("{entry}.{LEGACY_DISPATCH_KEY}")],
            )?;
        }
    }
    Ok(())
}
fn boundary(db: &Connection, conversation: &str, kind: &str, target: &str) -> Result<String> {
    let row: Option<(String, String, String)> = db
        .query_row(
            "SELECT id,role,status FROM chat_messages WHERE conversation_id=?1
          AND ((?2='message' AND id=?3) OR (?2='response' AND response_id=?3)) ORDER BY id LIMIT 1",
            params![conversation, kind, target],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(persistence)?;
    let (message, role, status) = row.ok_or_else(|| {
        fault(
            "ROLLBACK_BOUNDARY_INVALID",
            "rollback boundary does not belong to this conversation",
        )
    })?;
    if status != "context_compaction" && (kind == "response" || role == "assistant") {
        let request: Option<String> = db.query_row(
            "SELECT id FROM chat_messages WHERE conversation_id=?1 AND id<?2 AND response_id='' ORDER BY id DESC LIMIT 1",
            params![conversation,message], |row| row.get(0),
        ).optional().map_err(persistence)?;
        Ok(request.unwrap_or(message))
    } else {
        Ok(message)
    }
}
fn build_plan(db: &Connection, conversation: &str, from: &str) -> Result<RangePlan> {
    let stored = messages(db, conversation)?;
    let dispatches = calls(&stored)?;
    let range: Vec<Value> = stored
        .iter()
        .filter(|message| message.id.as_str() >= from)
        .map(|message| {
            json!([
                message.id,
                message.message_id,
                message.role,
                message.calls,
                message.raw,
                message.content
            ])
        })
        .collect();
    let fingerprint = blake3::hash(
        serde_json::to_string(&range)
            .map_err(|_| fault("PERSISTENCE_ERROR", "range serialization failed"))?
            .as_bytes(),
    )
    .to_hex()
    .to_string();
    let mut statement = db.prepare("SELECT run_id,record_json FROM sub_agent_runs WHERE parent_conversation_id=?1 ORDER BY run_id").map_err(persistence)?;
    let runs = statement
        .query_map([conversation], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(persistence)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(persistence)?;
    let mut removed = BTreeSet::new();
    let mut stop = BTreeSet::new();
    let mut covered_dispatches = BTreeSet::new();
    for (run_id, raw) in runs {
        let run = decode(raw)?;
        let operation: Option<String> = db.query_row("SELECT operation FROM sub_agent_run_requests WHERE run_id=?1 AND json_extract(receipt_json,'$.kind')='accepted'",
            [&run_id], |row| row.get(0)).optional().map_err(persistence)?;
        let operation = operation.ok_or_else(|| {
            fault(
                "ROLLBACK_UNRESOLVED",
                "run has no accepted request identity",
            )
        })?;
        let dispatch = request_boundary(
            &stored,
            &dispatches,
            &operation,
            id(&run, "requestId")?,
            &run_id,
            run["interactionId"].as_str(),
        )?;
        covered_dispatches.insert(dispatch);
        if dispatches[dispatch].message_id.as_str() >= from {
            removed.insert(run_id.clone());
            stop.insert(run_id);
        }
    }
    let mut statement = db.prepare("SELECT operation,request_id,run_id,receipt_json FROM sub_agent_run_requests WHERE parent_conversation_id=?1 ORDER BY operation,request_id").map_err(persistence)?;
    let requests = statement
        .query_map([conversation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(persistence)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(persistence)?;
    let mut removed_requests = Vec::new();
    for (operation, request, run_id, raw) in requests {
        let receipt = decode(raw)?;
        let record = load_run(db, &run_id)?;
        let accepted = receipt["kind"] == "accepted";
        let dispatch = request_boundary(
            &stored,
            &dispatches,
            &operation,
            &request,
            if accepted { &run_id } else { "" },
            if accepted {
                record["interactionId"].as_str()
            } else {
                None
            },
        )?;
        covered_dispatches.insert(dispatch);
        if dispatches[dispatch].message_id.as_str() >= from {
            stop.insert(run_id);
            removed_requests.push(RequestRemoval {
                operation,
                request_id: request,
                message_id: if receipt["kind"] == "message_queued" {
                    Some(id(&receipt, "messageId")?.to_string())
                } else {
                    None
                },
            });
        }
    }
    // Every dispatch in the range must be accounted for, including legacy
    // calls for which no durable run/request row exists at all.
    verify_dispatch_coverage(&stored, &dispatches, from, &covered_dispatches)?;

    // A rollback inside a child must also wait for that child's actual owner,
    // while retaining its parent dispatch record and earlier child history.
    let mut statement = db
        .prepare("SELECT run_id FROM sub_agent_runs WHERE conversation_id=?1 ORDER BY run_id")
        .map_err(persistence)?;
    for run in statement
        .query_map([conversation], |row| row.get::<_, String>(0))
        .map_err(persistence)?
    {
        stop.insert(run.map_err(persistence)?);
    }
    let mut nodes = BTreeSet::new();
    for call in dispatches.iter().filter(|call| {
        call.message_id.as_str() >= from && call.name == "workflow-workflow-generate"
    }) {
        if call.call_id.is_empty() {
            return Err(fault(
                "ROLLBACK_UNRESOLVED",
                "workflow dispatch has no exact call identity",
            ));
        }
        let mut statement = db.prepare("SELECT conversation_id FROM workflow_node_sessions WHERE parent_conversation_id=?1 AND flow_id=?2 ORDER BY conversation_id").map_err(persistence)?;
        for node in statement
            .query_map(
                params![conversation, format!("tool-{}", call.call_id)],
                |row| row.get::<_, String>(0),
            )
            .map_err(persistence)?
        {
            nodes.insert(node.map_err(persistence)?);
        }
    }
    let node_ids = descendants(db, &nodes.into_iter().collect::<Vec<_>>())?;
    for run in deletion_runs(db, &node_ids)? {
        stop.insert(id(&run, "runId")?.to_string());
    }
    let mut statement = db.prepare("SELECT receipt.event_id FROM sub_agent_event_receipts receipt JOIN sub_agent_run_events e ON e.event_id=receipt.event_id
       JOIN sub_agent_runs r ON r.run_id=e.run_id WHERE r.parent_conversation_id=?1 AND EXISTS(
         SELECT 1 FROM chat_messages m WHERE m.conversation_id=?1 AND m.id>=?2
           AND (m.id=receipt.assistant_message_id OR m.message_id=receipt.assistant_message_id OR m.id=receipt.tool_message_id OR m.message_id=receipt.tool_message_id)) ORDER BY receipt.event_id").map_err(persistence)?;
    let receipts = statement
        .query_map(params![conversation, from], |row| row.get::<_, String>(0))
        .map_err(persistence)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(persistence)?;
    // Peer requests are intentionally separate from activate/continue request
    // parsing. Resolve their exact sender tool boundary, never a timestamp.
    let mut statement = db.prepare("SELECT peer.sender_run_id,peer.request_id,peer.message_id,peer.receipt_json,message.run_id,recipient.run_id
        FROM sub_agent_peer_message_requests peer JOIN sub_agent_runs sender ON sender.run_id=peer.sender_run_id
        LEFT JOIN sub_agent_run_messages message ON message.message_id=peer.message_id
        LEFT JOIN sub_agent_runs recipient ON recipient.run_id=json_extract(peer.receipt_json,'$.runId')
        WHERE sender.conversation_id=?1 ORDER BY peer.sender_run_id,peer.request_id").map_err(persistence)?;
    let peers = statement
        .query_map([conversation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(persistence)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(persistence)?;
    let mut peer_messages = Vec::new();
    for (sender, request, message, raw, local_message_run, local_recipient) in peers {
        let receipt = decode(raw)?;
        let recipient = receipt["runId"]
            .as_str()
            .filter(|run| !run.trim().is_empty())
            .ok_or_else(|| {
                fault(
                    "ROLLBACK_UNRESOLVED",
                    "peer receipt has no exact recipient run identity",
                )
            })?;
        if receipt["kind"] != "message_queued"
            || receipt["messageId"].as_str() != Some(message.as_str())
            || receipt["requestId"].as_str() != Some(request.as_str())
        {
            return Err(fault(
                "ROLLBACK_UNRESOLVED",
                "peer receipt does not match its persisted request/message identity",
            ));
        }
        let dispatch = request_boundary(&stored, &dispatches, "sendMessage", &request, "", None)?;
        if dispatches[dispatch].message_id.as_str() >= from {
            // Metadata remains visible when only the recipient was archived.
            // Never silently omit its dispatch or mutate the other database.
            if local_recipient.as_deref() != Some(recipient)
                || local_message_run.as_deref() != Some(recipient)
            {
                return Err(fault("ROLLBACK_UNRESOLVED", "peer endpoint or body is external: restore/co-locate the exact archived peer recipient and its message before rolling back this sendMessage dispatch"));
            }
            stop.insert(sender);
            stop.insert(recipient.to_string());
            peer_messages.push(message);
        }
    }
    Ok(RangePlan {
        fingerprint,
        removed_runs: removed.into_iter().collect(),
        requests: removed_requests,
        receipts,
        runs: stop.into_iter().collect(),
        workflow_nodes: node_ids,
        peer_messages,
    })
}

pub(super) fn conversation_gated(db: &Connection, conversation: &str) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sub_agent_rollback_gates g WHERE g.conversation_id=?1
       OR EXISTS(SELECT 1 FROM json_each(g.plan_json,'$.runs') j JOIN sub_agent_runs r ON r.run_id=j.value WHERE r.conversation_id=?1)
       OR EXISTS(SELECT 1 FROM json_each(g.plan_json,'$.workflow_nodes') j WHERE j.value=?1))",
        [conversation], |row| row.get(0)).map_err(persistence)
}
pub(super) fn execution_gated(db: &Connection, run: &str) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sub_agent_rollback_gates g,json_each(g.plan_json,'$.runs') j WHERE j.value=?1)",
        [run], |row| row.get(0)).map_err(persistence)
}
fn load_plan(raw: String) -> Result<RangePlan> {
    serde_json::from_str(&raw).map_err(|_| fault("PERSISTENCE_ERROR", "invalid rollback plan"))
}
fn run_records(db: &Connection, plan: &RangePlan) -> Result<Vec<Value>> {
    plan.runs.iter().map(|run| load_run(db, run)).collect()
}
fn ready(runs: &[Value]) -> bool {
    runs.iter()
        .all(|run| run["status"].as_str().is_some_and(terminal))
}

pub(super) fn release(db: &Connection, command: &Value) -> Result<Value> {
    let (project, parent) = scope(command)?;
    let conversation = id(command, "conversationId")?;
    let rollback = id(command, "rollbackId")?;
    if conversation != parent {
        check_child(db, project, parent, conversation)?;
    }
    let changed = db.execute(
        "DELETE FROM sub_agent_rollback_gates WHERE conversation_id=?1 AND rollback_id=?2 AND project_id=?3 AND parent_conversation_id=?4 AND phase='prepared'",
        params![conversation,rollback,project,parent],
    ).map_err(persistence)?;
    if changed != 1 {
        return Err(fault(
            "ROLLBACK_NOT_RELEASABLE",
            "only the same prepared rollback can be released; restoring gates must be retried",
        ));
    }
    // Releasing admission never reopens a task or revives a cancelled owner.
    Ok(json!({"success":true,"kind":"rollback_released","rollbackId":rollback}))
}

pub(super) fn mark_restoring(db: &Connection, command_value: &Value) -> Result<Value> {
    let mut receipt = command(db, command_value, false)?;
    if receipt["ready"] != true {
        return Err(fault(
            "ROLLBACK_PENDING",
            "execution owners have not settled",
        ));
    }
    let (project, parent) = scope(command_value)?;
    let changed = db.execute(
        "UPDATE sub_agent_rollback_gates SET phase='restoring' WHERE conversation_id=?1 AND rollback_id=?2 AND project_id=?3 AND parent_conversation_id=?4 AND phase IN ('prepared','restoring')",
        params![id(command_value,"conversationId")?,id(command_value,"rollbackId")?,project,parent],
    ).map_err(persistence)?;
    if changed != 1 {
        return Err(fault(
            "ROLLBACK_NOT_PREPARED",
            "rollback identity changed before restoring",
        ));
    }
    receipt["phase"] = json!("restoring");
    Ok(receipt)
}

pub(super) fn command(db: &Connection, command: &Value, prepare: bool) -> Result<Value> {
    let (project, parent) = scope(command)?;
    let conversation = id(command, "conversationId")?;
    if conversation != parent {
        check_child(db, project, parent, conversation)?;
    }
    if deleting(db, conversation)? {
        return Err(fault(
            "CONVERSATION_DELETING",
            "conversation is closing for deletion",
        ));
    }
    let (rollback_id, kind, target, from, plan) = if prepare {
        let message = optional_text(command, "fromMessageId")?;
        let response = optional_text(command, "fromResponseId")?;
        let (kind, target) = match (message, response) {
            (Some(message), None) => ("message", message),
            (None, Some(response)) => ("response", response),
            _ => {
                return Err(fault(
                    "VALIDATION_ERROR",
                    "exactly one rollback boundary is required",
                ))
            }
        };
        let from = boundary(db, conversation, kind, target)?;
        let plan = build_plan(db, conversation, &from)?;
        let previous: Option<(String,String,String,String,String,String)> = db.query_row(
            "SELECT rollback_id,project_id,parent_conversation_id,boundary_message_id,phase,plan_json FROM sub_agent_rollback_gates WHERE conversation_id=?1",
            [conversation], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
        ).optional().map_err(persistence)?;
        let rollback_id = match previous {
            Some((rollback, old_project, old_parent, old_boundary, phase, old_plan)) => {
                if phase == "restoring" && load_plan(old_plan)? != plan {
                    return Err(fault(
                        "ROLLBACK_RANGE_CHANGED",
                        "restoring range cannot be replaced; retain this gate for recovery",
                    ));
                }
                if old_project != project || old_parent != parent || old_boundary != from {
                    return Err(fault(
                        "ROLLBACK_CONFLICT",
                        "a different rollback boundary is already prepared",
                    ));
                }
                rollback
            }
            None => Uuid::new_v4().to_string(),
        };
        let raw = serde_json::to_string(&plan)
            .map_err(|_| fault("PERSISTENCE_ERROR", "rollback plan serialization failed"))?;
        db.execute("INSERT INTO sub_agent_rollback_gates(conversation_id,rollback_id,project_id,parent_conversation_id,boundary_kind,boundary_target,boundary_message_id,plan_json,created_at)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(conversation_id) DO UPDATE SET boundary_kind=excluded.boundary_kind,boundary_target=excluded.boundary_target,plan_json=excluded.plan_json",
          params![conversation,rollback_id,project,parent,kind,target,from,raw,Utc::now().timestamp_millis()]).map_err(persistence)?;
        // Close only old task identities; a subsequent user task is not a deletion.
        db.execute(
            "UPDATE sub_agent_parent_tasks SET state='closed' WHERE parent_conversation_id=?1",
            [conversation],
        )
        .map_err(persistence)?;
        for run in run_records(db, &plan)? {
            db.execute("UPDATE sub_agent_parent_tasks SET state='closed' WHERE project_id=?1 AND parent_conversation_id=?2 AND task_id=?3",
                params![id(&run,"projectId")?,id(&run,"parentConversationId")?,id(&run,"parentTaskId")?]).map_err(persistence)?;
            db.execute("UPDATE sub_agent_run_events SET status='revoked' WHERE run_id=?1 AND status='pending'",[id(&run,"runId")?]).map_err(persistence)?;
            db.execute("UPDATE sub_agent_event_receipts SET wake_pending=0 WHERE event_id IN(SELECT event_id FROM sub_agent_run_events WHERE run_id=?1)",[id(&run,"runId")?]).map_err(persistence)?;
        }
        (
            rollback_id,
            kind.to_string(),
            target.to_string(),
            from,
            plan,
        )
    } else {
        let rollback_id = id(command, "rollbackId")?;
        let row: Option<(String,String,String,String)> = db.query_row("SELECT boundary_kind,boundary_target,boundary_message_id,plan_json FROM sub_agent_rollback_gates
           WHERE conversation_id=?1 AND rollback_id=?2 AND project_id=?3 AND parent_conversation_id=?4",
           params![conversation,rollback_id,project,parent], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional().map_err(persistence)?;
        let (kind, target, from, raw) = row.ok_or_else(|| {
            fault(
                "ROLLBACK_NOT_PREPARED",
                "rollback preparation does not match scope",
            )
        })?;
        (rollback_id.to_string(), kind, target, from, load_plan(raw)?)
    };
    if boundary(db, conversation, &kind, &target)? != from
        || build_plan(db, conversation, &from)? != plan
    {
        return Err(fault(
            "ROLLBACK_RANGE_CHANGED",
            "rollback range changed; prepare the same boundary again before restoring files",
        ));
    }
    let runs = run_records(db, &plan)?;
    let phase: String = db.query_row(
        "SELECT phase FROM sub_agent_rollback_gates WHERE conversation_id=?1 AND rollback_id=?2 AND project_id=?3 AND parent_conversation_id=?4",
        params![conversation,rollback_id,project,parent], |row| row.get(0),
    ).map_err(persistence)?;
    Ok(
        json!({"success":true,"kind":"rollback","rollbackId":rollback_id,"boundaryMessageId":from,"ready":ready(&runs),"runs":runs,"phase":phase}),
    )
}

/// Called by every truncation path under the existing Immediate transaction.
/// Unrelated failed-model cleanup is not blocked by a different rollback gate.
pub(crate) fn guard_truncate(
    db: &Connection,
    conversation: &str,
    from: &str,
    requested: Option<(&str, &str)>,
) -> Result<()> {
    let gate: Option<(String,String,String,String)> = db.query_row(
        "SELECT boundary_kind,boundary_target,boundary_message_id,plan_json FROM sub_agent_rollback_gates WHERE conversation_id=?1",
        [conversation], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(persistence)?;
    let range_messages: Vec<_> = messages(db, conversation)?
        .into_iter()
        .filter(|message| message.id.as_str() >= from)
        .collect();
    // An existing prepared/restoring gate is authoritative even when the new
    // range contains no dispatch, receipt or durable child owner. Validate it
    // BEFORE the legacy no-delegation early return or whole-delete shortcut.
    if let Some((kind, target, prepared_from, raw)) = &gate {
        if boundary(db, conversation, kind, target)? != *prepared_from {
            return Err(fault(
                "ROLLBACK_BOUNDARY_INVALID",
                "the frozen rollback boundary no longer resolves to its prepared message",
            ));
        }
        if let Some((requested_kind, requested_target)) = requested {
            if from != prepared_from.as_str()
                || requested_kind != kind.as_str()
                || requested_target != target.as_str()
            {
                return Err(fault("ROLLBACK_BOUNDARY_INVALID", "explicit truncate must match the existing prepared/restoring rollback boundary"));
            }
        } else {
            // A retry cleanup can coexist only as a proven no-op beyond the
            // frozen boundary. Any actual suffix deletion changes the plan's
            // history fingerprint (or removes the boundary), so fail closed.
            let plan = load_plan(raw.clone())?;
            if !range_messages.is_empty()
                || from <= prepared_from.as_str()
                || build_plan(db, conversation, prepared_from)? != plan
            {
                return Err(fault("ROLLBACK_BOUNDARY_INVALID", "failed-model cleanup would alter a prepared/restoring rollback plan or boundary"));
            }
            return Ok(());
        }
    }
    let has_dispatch = !calls(&range_messages)?.is_empty();
    let has_receipt: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sub_agent_event_receipts receipt JOIN chat_messages m
       ON m.id=receipt.assistant_message_id OR m.message_id=receipt.assistant_message_id OR m.id=receipt.tool_message_id OR m.message_id=receipt.tool_message_id
       WHERE m.conversation_id=?1 AND m.id>=?2)",params![conversation,from],|row| row.get(0)).map_err(persistence)?;
    let exact_gate = gate
        .as_ref()
        .is_some_and(|(_, _, boundary, _)| boundary == from);
    let has_owner: bool = if requested.is_some() {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sub_agent_runs WHERE conversation_id=?1)",
            [conversation],
            |row| row.get(0),
        )
        .map_err(persistence)?
    } else {
        false
    };
    if !has_dispatch && !has_receipt && !has_owner && !exact_gate {
        return Ok(());
    }
    // First-message rollback uses whole-conversation deletion preparation only
    // when no scoped rollback is frozen. Deletion admission cannot bypass an
    // existing gate's restoring phase, exact plan revalidation or owner drain.
    if gate.is_none() && deleting(db, conversation)? {
        guard_sub_agent_physical_delete(db, &[conversation.to_string()])?;
        return Ok(());
    }
    let (kind, target, prepared_from, raw) = gate.ok_or_else(|| {
        fault(
            "ROLLBACK_NOT_PREPARED",
            "prepare_rollback is required before truncating delegated history",
        )
    })?;
    if prepared_from != from
        || boundary(db, conversation, &kind, &target)? != from
        || requested.is_some_and(|(requested_kind, requested_target)| {
            requested_kind != kind || requested_target != target
        })
    {
        return Err(fault(
            "ROLLBACK_BOUNDARY_INVALID",
            "truncate target and boundary do not match rollback preparation",
        ));
    }
    let phase: String = db
        .query_row(
            "SELECT phase FROM sub_agent_rollback_gates WHERE conversation_id=?1",
            [conversation],
            |row| row.get(0),
        )
        .map_err(persistence)?;
    if phase != "restoring" {
        return Err(fault(
            "ROLLBACK_NOT_RESTORING",
            "mark_rollback_restoring is required before restoring/truncating history",
        ));
    }
    let plan = load_plan(raw)?;
    if build_plan(db, conversation, from)? != plan {
        return Err(fault(
            "ROLLBACK_RANGE_CHANGED",
            "rollback cleanup range changed; prepare again",
        ));
    }
    if !ready(&run_records(db, &plan)?) {
        return Err(fault(
            "ROLLBACK_PENDING",
            "execution owners have not settled",
        ));
    }
    for event in &plan.receipts {
        db.execute(
            "UPDATE sub_agent_run_events SET status='revoked' WHERE event_id=?1",
            [event],
        )
        .map_err(persistence)?;
        db.execute(
            "DELETE FROM sub_agent_event_receipts WHERE event_id=?1",
            [event],
        )
        .map_err(persistence)?;
    }
    for message in &plan.peer_messages {
        // Message deletion cascades its source/deduplication metadata. The
        // recipient's settled outcome remains immutable, including non-consumption.
        db.execute(
            "DELETE FROM sub_agent_run_messages WHERE message_id=?1",
            [message],
        )
        .map_err(persistence)?;
    }
    for request in &plan.requests {
        if let Some(message) = &request.message_id {
            db.execute(
                "DELETE FROM sub_agent_run_messages WHERE message_id=?1",
                [message],
            )
            .map_err(persistence)?;
        }
        db.execute("DELETE FROM sub_agent_run_requests WHERE parent_conversation_id=?1 AND operation=?2 AND request_id=?3",
            params![conversation,request.operation,request.request_id]).map_err(persistence)?;
    }
    let mut children = BTreeSet::new();
    for run in &plan.removed_runs {
        let record = load_run(db, run)?;
        children.insert(id(&record, "conversationId")?.to_string());
        db.execute("DELETE FROM sub_agent_runs WHERE run_id=?1", [run])
            .map_err(persistence)?;
    }
    // Preserve earlier continue generations and all child conversation history.
    // Refresh only compatibility status; run/request/event rows above cascade together.
    for child in children {
        db.execute("UPDATE sub_agent_sessions SET run_status=COALESCE((SELECT status FROM sub_agent_runs WHERE conversation_id=?1 ORDER BY accepted_at DESC,rowid DESC LIMIT 1),'interrupted'),
           error_message=COALESCE((SELECT json_extract(record_json,'$.outcome.error.message') FROM sub_agent_runs WHERE conversation_id=?1 ORDER BY accepted_at DESC,rowid DESC LIMIT 1),'') WHERE conversation_id=?1",[child]).map_err(persistence)?;
    }
    // Workflow conversations are genuinely removed by the existing truncation path.
    // Its unchanged triggers/FKs remain enabled; prepare their exact settled tree.
    for node in &plan.workflow_nodes {
        db.execute("INSERT INTO sub_agent_deletion_gates(conversation_id,created_at) VALUES(?1,?2) ON CONFLICT(conversation_id) DO NOTHING",
            params![node,Utc::now().timestamp_millis()]).map_err(persistence)?;
    }
    for node in plan.workflow_nodes.iter().rev() {
        db.execute("DELETE FROM todo_items WHERE session_id=?1", [node])
            .map_err(persistence)?;
        db.execute(
            "DELETE FROM conversation_worktree_bindings WHERE conversation_id=?1",
            [node],
        )
        .map_err(persistence)?;
        db.execute(
            "DELETE FROM chat_conversations WHERE conversation_id=?1",
            [node],
        )
        .map_err(persistence)?;
    }
    if !plan.workflow_nodes.is_empty() {
        super::super::record_conversation_tombstones(db, &plan.workflow_nodes)
            .map_err(persistence)?;
        crate::project_memories::delete_prompt_snapshots(db, &plan.workflow_nodes)
            .map_err(persistence)?;
        crate::system_prompt_snapshots::delete_snapshots(
            db,
            &plan.workflow_nodes,
        )
        .map_err(persistence)?;
    }
    // A failed outer transaction rolls this deletion back too, retaining a retryable gate.
    db.execute(
        "DELETE FROM sub_agent_rollback_gates WHERE conversation_id=?1",
        [conversation],
    )
    .map_err(persistence)?;
    Ok(())
}
