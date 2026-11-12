use rusqlite::Connection;

/// Schema 56. Task timestamps are UTC RFC3339, independent of legacy local-time tables.
pub fn ensure_image_generation_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS image_generation_batches (
            conversation_id TEXT NOT NULL,
            conversation_ref TEXT GENERATED ALWAYS AS (NULLIF(conversation_id, '')) VIRTUAL
                REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
            batch_id TEXT NOT NULL,
            sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
            notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (conversation_id, batch_id)
        );
        CREATE INDEX IF NOT EXISTS idx_image_generation_batches_conversation
            ON image_generation_batches(conversation_id, created_at, batch_id);
        CREATE TABLE IF NOT EXISTS image_generation_tasks (
            task_id TEXT PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL DEFAULT '',
            call_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'registered'
                CHECK (status IN ('registered', 'queued', 'running', 'completed', 'failed', 'cancelled')),
            asynchronous INTEGER NOT NULL DEFAULT 0 CHECK (asynchronous IN (0, 1)),
            result_json TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
            owner_instance TEXT NOT NULL,
            FOREIGN KEY (conversation_id, batch_id)
                REFERENCES image_generation_batches(conversation_id, batch_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_image_generation_tasks_batch
            ON image_generation_tasks(conversation_id, batch_id, created_at, task_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_image_generation_tasks_interaction
            ON image_generation_tasks(conversation_id, interaction_id) WHERE interaction_id <> '';
        CREATE INDEX IF NOT EXISTS idx_image_generation_tasks_recovery
            ON image_generation_tasks(status, owner_instance);
        CREATE INDEX IF NOT EXISTS idx_image_generation_tasks_call_anchor
            ON image_generation_tasks(conversation_id, call_id, interaction_id) WHERE call_id <> '';
        DROP INDEX IF EXISTS idx_image_generation_tasks_call;
        CREATE TRIGGER IF NOT EXISTS delete_conversation_image_generation
        AFTER DELETE ON chat_conversations
        BEGIN
            DELETE FROM image_generation_batches WHERE conversation_id = OLD.conversation_id;
        END;",
    )?;
    // Also upgrade an early schema-56 table created before the nullable conversation FK existed.
    // VIRTUAL maps the independent empty conversation to NULL without exposing extra API fields.
    let has_conversation_ref = {
        let mut statement = connection.prepare("PRAGMA table_xinfo(image_generation_batches)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        columns.iter().any(|name| name == "conversation_ref")
    };
    if !has_conversation_ref {
        connection.execute_batch(
            "ALTER TABLE image_generation_batches ADD COLUMN conversation_ref TEXT
             GENERATED ALWAYS AS (NULLIF(conversation_id, '')) VIRTUAL
             REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE;",
        )?;
    }
    Ok(())
}
