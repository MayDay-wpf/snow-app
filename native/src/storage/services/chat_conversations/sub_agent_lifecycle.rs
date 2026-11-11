//! ADR17 lifecycle helpers; payloads remain in the existing run message queue.
use super::*;

pub(super) fn ensure_message_metadata(db: &Connection) -> rusqlite::Result<()> {
    let has_delivery: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sub_agent_run_messages') WHERE name='delivery_status')",
        [], |row| row.get(0),
    )?;
    if !has_delivery {
        db.execute_batch("ALTER TABLE sub_agent_run_messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK(delivery_status IN ('queued','consumed','undelivered'));
          UPDATE sub_agent_run_messages SET delivery_status=CASE WHEN consumed=1 THEN 'consumed' WHEN EXISTS(SELECT 1 FROM sub_agent_runs r WHERE r.run_id=sub_agent_run_messages.run_id AND r.status IN ('completed','failed','cancelled','interrupted')) THEN 'undelivered' ELSE 'queued' END;")?;
    }
    // Either endpoint can move independently to the other database. These are
    // real external identities, deliberately not local FKs or fabricated runs.
    // Body ownership stays on sub_agent_run_messages.run_id (its existing FK).
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS sub_agent_peer_message_requests (
       sender_run_id TEXT NOT NULL,
       request_id TEXT NOT NULL,
       message_id TEXT NOT NULL UNIQUE,
       payload_hash TEXT NOT NULL,
       receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
       storage_moving INTEGER NOT NULL DEFAULT 0 CHECK(storage_moving IN (0,1)),
       PRIMARY KEY(sender_run_id,request_id)
     );",
    )?;
    let needs_rebuild: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('sub_agent_peer_message_requests'))
          OR NOT EXISTS(SELECT 1 FROM pragma_table_info('sub_agent_peer_message_requests') WHERE name='storage_moving')",
        [], |row| row.get(0),
    )?;
    db.execute_batch("SAVEPOINT sub_agent_peer_metadata_schema;")?;
    let result = (|| {
        db.execute_batch(
            "DROP TRIGGER IF EXISTS sub_agent_peer_sender_delete;
            DROP TRIGGER IF EXISTS sub_agent_peer_message_delete;",
        )?;
        if needs_rebuild {
            db.execute_batch("CREATE TABLE sub_agent_peer_message_requests_v2 (
               sender_run_id TEXT NOT NULL, request_id TEXT NOT NULL,
               message_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
               receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
               storage_moving INTEGER NOT NULL DEFAULT 0 CHECK(storage_moving IN (0,1)),
               PRIMARY KEY(sender_run_id,request_id));
             INSERT INTO sub_agent_peer_message_requests_v2(sender_run_id,request_id,message_id,payload_hash,receipt_json)
               SELECT sender_run_id,request_id,message_id,payload_hash,receipt_json FROM sub_agent_peer_message_requests;
             DROP TABLE sub_agent_peer_message_requests;
             ALTER TABLE sub_agent_peer_message_requests_v2 RENAME TO sub_agent_peer_message_requests;")?;
        }
        // A move stages only metadata inside the same Immediate transaction;
        // it never deletes a sibling's input. Real deletion/rollback retains
        // the original cascading cleanup semantics in each owning database.
        db.execute_batch("CREATE TRIGGER sub_agent_peer_sender_delete
          BEFORE DELETE ON sub_agent_runs BEGIN
            SELECT CASE WHEN EXISTS(
              SELECT 1 FROM sub_agent_peer_message_requests peer WHERE peer.storage_moving=0
                AND (peer.sender_run_id=OLD.run_id OR json_extract(peer.receipt_json,'$.runId')=OLD.run_id)
                AND (NOT EXISTS(SELECT 1 FROM sub_agent_runs sender WHERE sender.run_id=peer.sender_run_id)
                  OR NOT EXISTS(SELECT 1 FROM sub_agent_runs recipient WHERE recipient.run_id=json_extract(peer.receipt_json,'$.runId'))
                  OR NOT EXISTS(SELECT 1 FROM sub_agent_run_messages message WHERE message.message_id=peer.message_id
                    AND message.run_id=json_extract(peer.receipt_json,'$.runId')))
            ) THEN RAISE(ABORT,'PEER_ENDPOINT_EXTERNAL: restore/co-locate both peer endpoints and their message before permanent deletion or rollback; no cross-store deletion was performed') END;
            DELETE FROM sub_agent_run_messages WHERE message_id IN (
              SELECT message_id FROM sub_agent_peer_message_requests
              WHERE sender_run_id=OLD.run_id AND storage_moving=0);
            DELETE FROM sub_agent_peer_message_requests WHERE storage_moving=0
              AND (sender_run_id=OLD.run_id OR json_extract(receipt_json,'$.runId')=OLD.run_id);
          END;
          CREATE TRIGGER sub_agent_peer_message_delete
          AFTER DELETE ON sub_agent_run_messages BEGIN
            DELETE FROM sub_agent_peer_message_requests WHERE message_id=OLD.message_id AND storage_moving=0;
          END;")
    })();
    match result {
        Ok(()) => db.execute_batch("RELEASE sub_agent_peer_metadata_schema;"),
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK TO sub_agent_peer_metadata_schema; RELEASE sub_agent_peer_metadata_schema;");
            Err(error)
        }
    }
}

pub(super) fn collaboration_group(value: &Value) -> Result<Option<&str>> {
    let group = optional_text(value, "collaborationGroup")?;
    if group.is_some_and(|group| group.chars().count() > 80) {
        return Err(fault(
            "VALIDATION_ERROR",
            "collaborationGroup exceeds 80 characters",
        ));
    }
    Ok(group)
}

pub(super) fn consumable(run: &Value) -> Result<()> {
    if !matches!(status(run)?, "queued" | "running" | "waiting_input") {
        return Err(fault(
            "MESSAGE_NOT_ACCEPTED",
            "exact target run no longer consumes messages",
        ));
    }
    Ok(())
}

pub(super) fn peer_message(db: &Connection, command: &Value) -> Result<Value> {
    let (project, parent) = scope(command)?;
    let sender_id = id(command, "senderRunId")?;
    let recipient_id = id(command, "recipientRunId")?;
    let request = id(command, "requestId")?;
    if request.chars().count() > 160 || sender_id == recipient_id {
        return Err(fault("VALIDATION_ERROR", "invalid peer request identity"));
    }
    let sender = load_run(db, sender_id)?;
    check_owner(&sender, command)?;
    if text(&sender, "projectId")? != project || text(&sender, "parentConversationId")? != parent {
        return Err(fault("PERMISSION_DENIED", "peer sender is outside scope"));
    }
    check_child(db, project, parent, id(&sender, "conversationId")?)?;
    check_gate(db, parent)?;
    check_gate(db, id(&sender, "conversationId")?)?;
    check_execution_gate(db, &sender)?;
    // An already accepted peer request remains replayable when its exact
    // recipient is cold. Only a NEW send requires both live consumable runs.
    let message = id(command, "message")?;
    let hash = request_hash(
        &json!({"senderRunId":sender_id,"recipientRunId":recipient_id,"message":message}),
    );
    let old: Option<(String, String)> = db.query_row(
        "SELECT payload_hash,receipt_json FROM sub_agent_peer_message_requests WHERE sender_run_id=?1 AND request_id=?2",
        params![sender_id,request], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(persistence)?;
    if let Some((previous_hash, raw)) = old {
        if previous_hash != hash {
            return Err(fault(
                "REQUEST_CONFLICT",
                "peer requestId has a different payload",
            ));
        }
        let mut receipt = decode(raw)?;
        receipt["created"] = json!(false);
        return Ok(receipt);
    }
    let recipient = load_run(db, recipient_id)?;
    if text(&recipient, "projectId")? != project
        || text(&recipient, "parentConversationId")? != parent
    {
        return Err(fault(
            "PERMISSION_DENIED",
            "peer recipient is outside scope",
        ));
    }
    check_child(db, project, parent, id(&recipient, "conversationId")?)?;
    check_gate(db, id(&recipient, "conversationId")?)?;
    check_execution_gate(db, &recipient)?;
    if sender["parentTaskId"] != recipient["parentTaskId"] {
        return Err(fault(
            "PERMISSION_DENIED",
            "peer runs belong to different tasks",
        ));
    }
    task_open(db, project, parent, id(&sender, "parentTaskId")?)?;
    let group = collaboration_group(&sender["snapshot"])?;
    if group.is_none() || group != collaboration_group(&recipient["snapshot"])? {
        return Err(fault(
            "PERMISSION_DENIED",
            "peer runs lack the same explicit collaboration group",
        ));
    }
    let tools: Value = serde_json::from_str(text(&sender["snapshot"], "toolsJson")?)
        .map_err(|_| fault("PERSISTENCE_ERROR", "invalid persisted sender tools"))?;
    let permitted = tools.as_array().is_some_and(|tools| {
        tools.iter().any(|tool| {
            tool.as_str() == Some("sub-agents-sendMessage")
                || (tool.as_str() == Some("*")
                    && sender["snapshot"]["agentId"] == "agent_general"
                    && tools.len() == 1)
        })
    });
    if !permitted {
        return Err(fault(
            "PERMISSION_DENIED",
            "sender tools do not allow peer messaging",
        ));
    }
    consumable(&sender)?;
    consumable(&recipient)?;
    let message_id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp_millis();
    db.execute(
        "INSERT INTO sub_agent_run_messages(message_id,run_id,text,created_at) VALUES(?1,?2,?3,?4)",
        params![message_id, recipient_id, message, now],
    )
    .map_err(persistence)?;
    let receipt = json!({"success":true,"kind":"message_queued","runId":recipient_id,
        "conversationId":recipient["conversationId"],"messageId":message_id,"requestId":request,
        "queuedAt":now,"created":true,"executionMode":recipient["executionMode"],"deliveryStatus":"queued"});
    db.execute("INSERT INTO sub_agent_peer_message_requests(sender_run_id,request_id,message_id,payload_hash,receipt_json) VALUES(?1,?2,?3,?4,?5)",
        params![sender_id,request,message_id,hash,receipt.to_string()]).map_err(persistence)?;
    Ok(receipt)
}

pub(super) fn message_source(db: &Connection, message_id: &str, message: &mut Value) -> Result<()> {
    let sender: Option<String> = db
        .query_row(
            "SELECT sender_run_id FROM sub_agent_peer_message_requests WHERE message_id=?1",
            [message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(persistence)?;
    if let Some(sender) = sender {
        message["senderRunId"] = json!(sender);
    }
    Ok(())
}

/// 读取并发上限：缺省或非法值回退默认，并夹到 [min, max]。
fn limit_setting(
    db: &Connection,
    code: &str,
    fallback: i64,
    min: i64,
    max: i64,
) -> Result<i64> {
    let raw: Option<String> = db
        .query_row(
            "SELECT setting_value FROM system_settings WHERE setting_code=?1",
            [code],
            |row| row.get(0),
        )
        .optional()
        .map_err(persistence)?;
    Ok(raw
        .as_deref()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
        .clamp(min, max))
}

/// 两层限制：单会话上限 + 跨会话全局上限（0 表示不限制）。
/// 单会话上限为 0 时不再限制会话内并发；否则不允许超过全局上限，取两者较小值。
pub(super) fn has_capacity(db: &Connection, project: &str, parent: &str) -> Result<bool> {
    let global_max = limit_setting(db, "sub_agent_global_max_concurrency", 0, 0, 2000)?;
    let session_max = limit_setting(db, "sub_agent_max_concurrency", 0, 0, 2000)?;
    let session_limit = if session_max > 0 && global_max > 0 {
        session_max.min(global_max)
    } else {
        session_max
    };
    if session_limit > 0 {
        let occupied: i64 = db.query_row(
            "SELECT COUNT(*) FROM sub_agent_runs WHERE project_id=?1 AND parent_conversation_id=?2
             AND status IN ('running','finalizing','cancelling')",
            params![project, parent],
            |row| row.get(0),
        ).map_err(persistence)?;
        if occupied >= session_limit {
            return Ok(false);
        }
    }
    if global_max == 0 {
        return Ok(true);
    }
    let total: i64 = db.query_row(
        "SELECT COUNT(*) FROM sub_agent_runs WHERE status IN ('running','finalizing','cancelling')",
        [], |row| row.get(0),
    ).map_err(persistence)?;
    Ok(total < global_max)
}

pub(super) fn close_if_idle(db: &Connection, command: &Value) -> Result<Value> {
    let (project, parent) = scope(command)?;
    let task = id(command, "parentTaskId")?;
    check_gate(db, parent)?;
    let busy: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sub_agent_runs r WHERE r.project_id=?1 AND r.parent_conversation_id=?2 AND r.parent_task_id=?3 AND
          (r.status IN ('queued','running','waiting_input','finalizing','cancelling') OR EXISTS(
            SELECT 1 FROM sub_agent_run_events e LEFT JOIN sub_agent_event_receipts receipt ON receipt.event_id=e.event_id
            WHERE e.run_id=r.run_id AND (e.status='pending' OR (e.status='received' AND COALESCE(receipt.wake_pending,0)=1)))))",
        params![project,parent,task], |row| row.get(0),
    ).map_err(persistence)?;
    if !busy {
        db.execute("UPDATE sub_agent_parent_tasks SET state='closed' WHERE project_id=?1 AND parent_conversation_id=?2 AND task_id=?3 AND state='open'",
            params![project,parent,task]).map_err(persistence)?;
    }
    let closed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sub_agent_parent_tasks WHERE project_id=?1 AND parent_conversation_id=?2 AND task_id=?3 AND state='closed')",
        params![project,parent,task], |row| row.get(0),
    ).map_err(persistence)?;
    Ok(json!({"success":true,"kind":"parent_idle","closed":closed}))
}

pub(super) fn undelivered(db: &Connection, run_id: &str) -> Result<Vec<String>> {
    let mut statement = db.prepare("SELECT message_id FROM sub_agent_run_messages WHERE run_id=?1 AND consumed=0 ORDER BY created_at,message_id").map_err(persistence)?;
    let ids = statement
        .query_map([run_id], |row| row.get::<_, String>(0))
        .map_err(persistence)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(persistence)?;
    Ok(ids)
}

pub(super) fn summary_page(
    outcome: &mut Value,
    run_id: &str,
    offset: usize,
    limit: usize,
) -> Result<Value> {
    let summary = text(outcome, "summary")?;
    let total = summary.chars().count();
    let page: String = summary.chars().skip(offset).take(limit).collect();
    let end = offset.saturating_add(page.chars().count());
    outcome["summary"] = json!(page);
    Ok(
        json!({"runId":run_id,"text":page,"offset":offset,"total":total,
        "nextOffset":if end < total {Some(end)} else {None}}),
    )
}
