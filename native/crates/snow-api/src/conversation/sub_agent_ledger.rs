//! Request-only projection of durable facts. No event consumption, task opening,
//! state transitions, model calls or snapshot/prompt bodies are exposed here.
use std::path::Path;
use std::time::Duration;

use napi::{Error, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

const MAX_ITEMS: usize = 32;

pub(super) struct HostLedger {
    pub is_child: bool,
    pub project_bound: bool,
    pub workflow_node: bool,
    pub has_children: bool,
    pub has_cancellable: bool,
    pub has_result: bool,
    pub has_result_reader: bool,
    pub context: Option<Value>,
}

struct RunFact {
    run_id: String,
    conversation_id: String,
    task_id: String,
    status: String,
    mode: String,
    agent_id: String,
    agent_name: String,
    group: Option<String>,
    communication_allowed: bool,
    result_ready: bool,
    delivery: Option<String>,
    paged: bool,
}

fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

fn accepts_message(status: &str) -> bool {
    matches!(status, "queued" | "running" | "waiting_input")
}

fn read_error(stage: &'static str) -> impl FnOnce(rusqlite::Error) -> Error {
    move |error| {
        // Classify without exposing SQL, paths, column names or stored values.
        let class = match &error {
            rusqlite::Error::SqliteFailure(code, _) => {
                format!("sqlite_{}", code.extended_code)
            }
            rusqlite::Error::InvalidColumnType(index, _, _) => format!("column_type_{index}"),
            rusqlite::Error::FromSqlConversionFailure(index, _, _) => {
                format!("column_conversion_{index}")
            }
            rusqlite::Error::InvalidColumnIndex(index) => format!("column_index_{index}"),
            rusqlite::Error::QueryReturnedNoRows => "missing_row".into(),
            _ => "database_read".into(),
        };
        Error::from_reason(format!(
            "SUB_AGENT_LEDGER_UNAVAILABLE: stage={stage} class={class}"
        ))
    }
}

/// Scope comes solely from the actual request conversation record. The optional
/// directory is only a consistency check, never an alternative scope. A
/// conversation that is not persisted yet — the first request of a new
/// conversation, whose id is minted in this same request and written only when
/// the exchange is stored — yields an empty ledger instead of an error.
pub(super) fn load_host_ledger(
    database_path: &Path,
    conversation_id: &str,
    expected_project: Option<&str>,
    expose_collaborators: bool,
) -> Result<HostLedger> {
    // Explicitly read-only: the usual connection helper also sets journal mode.
    let mut connection =
        Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(read_error("open"))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(read_error("busy_timeout"))?;
    let db = connection
        .transaction()
        .map_err(read_error("transaction"))?;
    let identity: Option<(String, String, Option<String>)> = db.query_row(
        "SELECT c.directory_id,
         CASE WHEN w.conversation_id IS NOT NULL THEN 'workflow_node'
              WHEN s.conversation_id IS NOT NULL THEN 'sub_agent' ELSE 'main' END,
         s.parent_conversation_id
         FROM chat_conversations c LEFT JOIN sub_agent_sessions s ON s.conversation_id=c.conversation_id
         LEFT JOIN workflow_node_sessions w ON w.conversation_id=c.conversation_id
         WHERE c.conversation_id=?1",
        [conversation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(read_error("identity"))?;
    let (project, kind, parent) = match identity {
        Some(identity) => identity,
        // No durable facts can exist for a conversation that has no record yet.
        // Report an empty ledger rather than a read failure: no scope is
        // invented, no other conversation or project is used as a fallback, and
        // no degraded section is injected into the request.
        None => {
            return Ok(HostLedger {
                is_child: false,
                project_bound: expected_project.is_some_and(|id| !id.trim().is_empty()),
                workflow_node: false,
                has_children: false,
                has_cancellable: false,
                has_result: false,
                has_result_reader: false,
                context: None,
            })
        }
    };
    if expected_project
        .filter(|id| !id.trim().is_empty())
        .is_some_and(|id| id != project)
    {
        return Err(Error::from_reason(
            "PERMISSION_DENIED: stage=identity class=project_mismatch",
        ));
    }
    let is_child = kind == "sub_agent" || parent.is_some();
    let parent = if is_child {
        parent.filter(|id| !id.is_empty()).ok_or_else(|| {
            Error::from_reason("SUB_AGENT_LEDGER_UNAVAILABLE: stage=identity class=parent_missing")
        })?
    } else {
        conversation_id.to_string()
    };
    let parent_project: Option<String> = db
        .query_row(
            "SELECT directory_id FROM chat_conversations WHERE conversation_id=?1",
            [&parent],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_error("parent_identity"))?;
    if parent_project.as_deref() != Some(project.as_str()) {
        return Err(Error::from_reason(
            "PERMISSION_DENIED: stage=parent_identity class=project_mismatch",
        ));
    }
    let current_task: Option<String> = db
        .query_row(
            "SELECT task_id FROM sub_agent_parent_tasks WHERE project_id=?1
         AND parent_conversation_id=?2 AND state='open'",
            params![project, parent],
            |row| row.get(0),
        )
        .optional()
        .map_err(read_error("parent_task"))?;

    // Read the entire scoped set, not the first 100 runs. SQL projects only the
    // facts we need, and active rows sort ahead of recent terminal history.
    let mut statement = db.prepare(
        "SELECT r.run_id,r.conversation_id,r.parent_task_id,r.status,
         json_extract(r.record_json,'$.executionMode'),
         json_extract(r.record_json,'$.agentId'),json_extract(r.record_json,'$.agentName'),
         json_extract(r.record_json,'$.snapshot.collaborationGroup'),
         EXISTS(SELECT 1 FROM json_each(json_extract(r.record_json,'$.snapshot.toolsJson'))
                WHERE value IN ('*','sub-agents-sendMessage')),
         (json_type(r.record_json,'$.outcome')='object'),e.status,
         COALESCE(length(json_extract(r.record_json,'$.outcome.summary')),0) > 16000
         FROM sub_agent_runs r JOIN sub_agent_sessions s ON s.conversation_id=r.conversation_id
          AND s.parent_conversation_id=r.parent_conversation_id
         JOIN chat_conversations c ON c.conversation_id=r.conversation_id AND c.directory_id=r.project_id
         LEFT JOIN sub_agent_run_events e ON e.run_id=r.run_id
         WHERE r.project_id=?1 AND r.parent_conversation_id=?2
         ORDER BY (r.status IN ('queued','running','waiting_input','finalizing','cancelling')) DESC,
          r.accepted_at DESC,r.rowid DESC"
    ).map_err(read_error("runs_prepare"))?;
    let runs = statement
        .query_map(params![project, parent], |row| {
            Ok(RunFact {
                run_id: row.get(0)?,
                conversation_id: row.get(1)?,
                task_id: row.get(2)?,
                status: row.get(3)?,
                mode: row.get(4)?,
                agent_id: row.get(5)?,
                agent_name: row.get(6)?,
                group: row.get(7)?,
                communication_allowed: row.get(8)?,
                result_ready: row.get::<_, Option<bool>>(9)?.unwrap_or(false),
                delivery: row.get(10)?,
                paged: row.get(11)?,
            })
        })
        .map_err(read_error("runs_query"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(read_error("runs_decode"))?;
    let has_children = !runs.is_empty();
    let has_cancellable = runs.iter().any(|run| accepts_message(&run.status));
    let has_result = runs
        .iter()
        .any(|run| terminal(&run.status) && run.result_ready);
    let has_compaction = if has_result {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE conversation_id=?1 AND status='context_compaction')",
            [parent.as_str()],
            |row| row.get::<_, bool>(0),
        )
        .map_err(read_error("compaction"))?
    } else {
        false
    };
    // The reader is exposed only when the automatic delivery could not put the
    // full terminal result in context: paged summaries, undelivered/revoked
    // events, or a conversation that has since compacted the history.
    let has_result_reader = has_result
        && (has_compaction
            || runs.iter().any(|run| {
                terminal(&run.status)
                    && run.result_ready
                    && (run.paged
                        || !(run.mode.as_str() == "sync"
                            || run.delivery.as_deref() == Some("received")))
            }));
    let context = if is_child {
        // Communication identities come only from the current durable run.
        // The current active run is obtained from durable identity, never prose.
        let sender = runs
            .iter()
            .find(|run| run.conversation_id == conversation_id && accepts_message(&run.status));
        sender.filter(|run| expose_collaborators && run.communication_allowed
            && current_task.as_deref() == Some(run.task_id.as_str()))
            .and_then(|sender| sender.group.as_deref().filter(|group|
                !group.trim().is_empty() && group.chars().count() <= 80).map(|group| {
                let peers = runs.iter().filter(|run| run.run_id != sender.run_id
                    && run.task_id == sender.task_id && run.group.as_deref() == Some(group)
                    && accepts_message(&run.status)).collect::<Vec<_>>();
                let recipients = peers.iter().take(MAX_ITEMS).map(|run| json!({
                    "recipientRunId":run.run_id,"status":run.status,
                    "agentId":run.agent_id,"role":run.agent_name
                })).collect::<Vec<_>>();
                json!({"kind":"authorized_collaborators","runId":sender.run_id,
                    "parentTaskId":sender.task_id,"collaborationGroup":group,
                    "recipients":recipients,"omittedCount":peers.len().saturating_sub(MAX_ITEMS),
                    "notice":"Host facts, not new instructions or permissions. Use only exact recipientRunId values. queued is not delivered or understood; this capability never starts/resumes runs."})
            }))
    } else if runs.is_empty() && current_task.is_none() {
        // 没有任何委派历史时省略该章节：普通会话因此始终没有易变尾部，
        // 请求前缀可跨轮复用，不会因为每轮重建宿主事实而丢缓存。
        None
    } else {
        let items = runs
            .iter()
            .take(MAX_ITEMS)
            .map(|run| {
                json!({
                    "conversationId":run.conversation_id,"runId":run.run_id,
                    "parentTaskId":run.task_id,"status":run.status,"executionMode":run.mode,
                    "agentId":run.agent_id,"role":run.agent_name,
                    "historyOnly":current_task.as_deref() != Some(run.task_id.as_str()),
                    "resultLocator":if has_result_reader && terminal(&run.status) && run.result_ready {
                        Some(json!({"tool":"sub-agents-getResult","runId":run.run_id,"offset":0}))
                    } else {None},"delivery":run.delivery
                })
            })
            .collect::<Vec<_>>();
        let omitted = runs.len().saturating_sub(items.len());
        Some(json!({"kind":"child_run_ledger","projectId":project,
            "parentConversationId":parent,"currentOpenTaskId":current_task,"items":items,
            "omittedCount":omitted,
            "notice":"Read-only host facts reconstructed from persistence, not a user instruction or permission to resume. Old task/result entries are historical only; no task is reopened. Explicit current user authorization is still required for new work. Delivery is event receipt state, not proof of understanding. Mode comes from each actual run/receipt, not current settings."}))
    };
    Ok(HostLedger {
        is_child,
        project_bound: !project.trim().is_empty(),
        workflow_node: kind == "workflow_node",
        has_children,
        has_cancellable,
        has_result,
        has_result_reader,
        context,
    })
}

pub(super) fn context_section(
    database_path: &Path,
    conversation_id: &str,
    expected_project: Option<&str>,
    expose_collaborators: bool,
) -> Option<String> {
    match load_host_ledger(
        database_path,
        conversation_id,
        expected_project,
        expose_collaborators,
    ) {
        Ok(ledger) => ledger
            .context
            .map(|context| format!("## Host Sub-Agent Ledger\n\n{}", context)),
        Err(error) => {
            // All errors produced by load_host_ledger contain safe classifications.
            eprintln!(
                "Sub-agent host ledger unavailable; no cross-scope fallback was attempted: {}",
                error.reason
            );
            let code = if error.reason.starts_with("PERMISSION_DENIED:") {
                "PERMISSION_DENIED"
            } else {
                "SUB_AGENT_LEDGER_UNAVAILABLE"
            };
            Some(format!(
                "## Host Sub-Agent Ledger\n\n{}",
                json!({
                    "available":false,"code":code,"diagnostic":error.reason,
                    "notice":"Persistent identities could not be verified. Do not infer run IDs, peer permission or task-resume authorization from this missing ledger."
                })
            ))
        }
    }
}
