use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use napi::bindgen_prelude::*;
use rusqlite::Connection;

use super::{migrations, services};

const SNOWFLAKE_EPOCH_MS: u64 = 1_704_067_200_000;
const SNOWFLAKE_WORKER_ID_BITS: u64 = 10;
const SNOWFLAKE_SEQUENCE_BITS: u64 = 12;
const SNOWFLAKE_WORKER_ID_MASK: u64 = (1 << SNOWFLAKE_WORKER_ID_BITS) - 1;
const SNOWFLAKE_SEQUENCE_MASK: u64 = (1 << SNOWFLAKE_SEQUENCE_BITS) - 1;
const SNOWFLAKE_TIMESTAMP_SHIFT: u64 = SNOWFLAKE_WORKER_ID_BITS + SNOWFLAKE_SEQUENCE_BITS;

#[derive(Debug, Default)]
struct SnowflakeState {
    last_timestamp_ms: u64,
    sequence: u64,
}

static SNOWFLAKE_STATE: OnceLock<Mutex<SnowflakeState>> = OnceLock::new();

pub fn create_snowflake_id() -> String {
    let state_lock = SNOWFLAKE_STATE.get_or_init(|| Mutex::new(SnowflakeState::default()));
    let mut state = state_lock
        .lock()
        .expect("snowflake id generator mutex poisoned");
    let mut timestamp_ms = current_timestamp_ms().max(SNOWFLAKE_EPOCH_MS);

    if timestamp_ms < state.last_timestamp_ms {
        timestamp_ms = state.last_timestamp_ms;
    }

    if timestamp_ms == state.last_timestamp_ms {
        state.sequence = (state.sequence + 1) & SNOWFLAKE_SEQUENCE_MASK;
        if state.sequence == 0 {
            timestamp_ms = wait_next_millis(state.last_timestamp_ms);
        }
    } else {
        state.sequence = 0;
    }

    state.last_timestamp_ms = timestamp_ms;

    let worker_id = (std::process::id() as u64) & SNOWFLAKE_WORKER_ID_MASK;
    let snowflake_id = ((timestamp_ms - SNOWFLAKE_EPOCH_MS) << SNOWFLAKE_TIMESTAMP_SHIFT)
        | (worker_id << SNOWFLAKE_SEQUENCE_BITS)
        | state.sequence;

    format!("{snowflake_id:019}")
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(SNOWFLAKE_EPOCH_MS)
}

fn wait_next_millis(last_timestamp_ms: u64) -> u64 {
    loop {
        let timestamp_ms = current_timestamp_ms().max(SNOWFLAKE_EPOCH_MS);
        if timestamp_ms > last_timestamp_ms {
            return timestamp_ms;
        }
        std::hint::spin_loop();
    }
}

/// Opens a SQLite connection with foreign-key enforcement, WAL mode, and a
/// busy timeout to prevent integrity violations and "database is locked"
/// errors under concurrent `spawn_blocking` tasks.
///
/// WAL (Write-Ahead Logging) allows readers and a writer to operate
/// simultaneously, eliminating most reader-writer contention. The busy
/// timeout (5 seconds) makes writers wait instead of failing immediately
/// when another writer holds the lock.
///
/// Every service function should call this instead of `Connection::open`
/// to ensure consistent concurrency behaviour across the codebase.
pub fn open_connection(database_path: impl AsRef<Path>) -> rusqlite::Result<Connection> {
    let connection = Connection::open(database_path)?;
    // SQLite disables foreign keys for every new connection unless enabled
    // explicitly. Schema-level ON DELETE CASCADE clauses rely on this.
    connection.pragma_update(None, "foreign_keys", "ON")?;
    // busy_timeout MUST be set before any pragma that acquires a write lock
    // (e.g. journal_mode=WAL). Otherwise concurrent connections will get
    // "database is locked" immediately instead of waiting.
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

pub fn ensure_database(database_path: &Path) -> Result<()> {
    // First attempt: normal open + schema creation.
    match open_connection(database_path)
        .and_then(|connection| create_schema(&connection))
    {
        Ok(()) => Ok(()),
        Err(first_error) => {
            // If the error looks like corruption, attempt recovery before
            // surfacing the failure to the caller. This prevents a permanent
            // "database disk image is malformed" brick on startup.
            if is_corruption_error(&first_error) {
                eprintln!(
                    "Snow App database corruption detected ({}). Attempting recovery...",
                    first_error
                );
                match recover_database(database_path) {
                    Ok(()) => {
                        eprintln!("Snow App database recovered successfully.");
                        Ok(())
                    }
                    Err(recover_error) => {
                        // Recovery failed — surface the original error so the
                        // caller sees the root cause, but log the recovery
                        // failure too.
                        eprintln!(
                            "Snow App database recovery failed: {}",
                            recover_error
                        );
                        Err(database_error(database_path, "initialize", first_error))
                    }
                }
            } else {
                Err(database_error(database_path, "initialize", first_error))
            }
        }
    }
}

/// Returns true when a rusqlite error indicates the database file is
/// physically corrupted (b-tree page corruption, invalid page numbers, etc.).
fn is_corruption_error(error: &rusqlite::Error) -> bool {
    // Check SQLite primary error code first — more reliable than string matching.
    if let rusqlite::Error::SqliteFailure(err_code, _) = error {
        match err_code.code {
            rusqlite::ErrorCode::DatabaseCorrupt => return true,
            rusqlite::ErrorCode::NotADatabase => return true,
            _ => {}
        }
    }
    // Fall back to string matching for edge cases where the error code
    // doesn't directly map but the message mentions corruption.
    let message = error.to_string().to_lowercase();
    message.contains("malformed") || message.contains("not a database")
}

/// Attempts to recover data from a corrupted SQLite database by dumping all
/// recoverable rows into a new database file, then atomically replacing the
/// corrupted file. The old file is preserved with a `.corrupt.bak` suffix.
fn recover_database(database_path: &Path) -> Result<()> {
    let parent = database_path
        .parent()
        .ok_or_else(|| Error::from_reason("Cannot determine database parent directory"))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let backup_path = parent.join(format!(
        "{}.corrupt.{timestamp}.bak",
        database_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("snowapp.db")
    ));

    let recovered_path = parent.join(format!(
        "{}.recovered",
        database_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("snowapp.db")
    ));

    // Remove any stale recovered file from a previous failed attempt.
    let _ = fs::remove_file(&recovered_path);

    // Open the corrupted database in read-only mode and run the SQLite
    // `.recover` equivalent: iterate every table, dump CREATE + INSERT
    // statements into the new database.
    let recovered_conn = open_connection(&recovered_path)
        .map_err(|e| Error::from_reason(format!("Failed to create recovered database: {e}")))?;

    // Step 1: Use the corrupt database's schema. We open a separate read-only
    // connection to iterate tables and copy data row by row, tolerating
    // per-row errors (corrupted rows are simply skipped).
    let read_only_conn = Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| {
        Error::from_reason(format!("Failed to open corrupted database read-only: {e}"))
    })?;

    // Set a busy timeout so we don't fail if another connection holds a lock.
    let _ = read_only_conn.busy_timeout(Duration::from_secs(5));

    // Build the schema in the recovered database first (using our own
    // create_schema, which is idempotent with CREATE TABLE IF NOT EXISTS).
    create_schema(&recovered_conn).map_err(|e| {
        Error::from_reason(format!("Failed to create schema in recovered database: {e}"))
    })?;

    // Copy data from each table.
    let table_names: Vec<String> = read_only_conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(|e| Error::from_reason(format!("Failed to list tables: {e}")))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| Error::from_reason(format!("Failed to query table names: {e}")))?
        .filter_map(|r| r.ok())
        .collect();

    for table_name in &table_names {
        // Skip internal tables.
        if table_name.starts_with("sqlite_") {
            continue;
        }

        // Read column names for this table from the corrupted database.
        let columns_result: rusqlite::Result<Vec<String>> = read_only_conn
            .prepare(&format!("SELECT * FROM \"{table_name}\" LIMIT 0"))
            .and_then(|stmt| {
                let count = stmt.column_count();
                Ok((0..count)
                    .map(|i| stmt.column_name(i).unwrap_or("").to_string())
                    .collect())
            });

        let columns = match columns_result {
            Ok(cols) if !cols.is_empty() => cols,
            _ => continue, // Can't determine columns, skip this table.
        };

        let column_list = columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");

        // Read all rows from the corrupted database, tolerating errors.
        let select_result = read_only_conn.prepare(&format!("SELECT {column_list} FROM \"{table_name}\""));

        if let Ok(mut select_stmt) = select_result {
            // We iterate rows, skipping any that trigger corruption errors.
            let column_count = columns.len();
            let mut recovered_count = 0u64;
            let mut skipped_count = 0u64;

            // Use query_map for clean rows, but fall back to manual iteration
            // so we can continue past errors.
            let rows_result = select_stmt.query([]);

            if let Ok(mut rows) = rows_result {
                loop {
                    match rows.next() {
                        Ok(Some(row)) => {
                            // Read each column value, trying multiple types
                            // to handle diverse column types gracefully.
                            let mut values: Vec<String> = Vec::with_capacity(column_count);
                            for i in 0..column_count {
                                let cell = row.get::<_, rusqlite::types::Value>(i);
                                let formatted = match cell {
                                    Ok(rusqlite::types::Value::Null) | Err(_) => "NULL".to_string(),
                                    Ok(rusqlite::types::Value::Integer(v)) => v.to_string(),
                                    Ok(rusqlite::types::Value::Real(v)) => v.to_string(),
                                    Ok(rusqlite::types::Value::Text(s)) => {
                                        format!("'{}'", s.replace('\'', "''"))
                                    }
                                    Ok(rusqlite::types::Value::Blob(bytes)) => {
                                        let hex: String =
                                            bytes.iter().map(|b| format!("{b:02x}")).collect();
                                        format!("X'{hex}'")
                                    }
                                };
                                values.push(formatted);
                            }

                            let value_list = values.join(", ");
                            let insert_sql = format!(
                                "INSERT OR IGNORE INTO \"{table_name}\" ({column_list}) VALUES ({value_list})"
                            );

                            if let Err(e) = recovered_conn.execute(&insert_sql, []) {
                                eprintln!(
                                    "Recovery: failed to insert row into {table_name}: {e}"
                                );
                                skipped_count += 1;
                            } else {
                                recovered_count += 1;
                            }
                        }
                        Ok(None) => break, // End of cursor.
                        Err(e) => {
                            // Row read error — likely corruption. Log and
                            // try to continue to the next row.
                            eprintln!(
                                "Recovery: skipping corrupted row in {table_name}: {e}"
                            );
                            skipped_count += 1;
                            // If the error is fatal (cursor is dead), break.
                            if e.to_string().to_lowercase().contains("malformed") {
                                break;
                            }
                            // For non-fatal errors, the cursor may still be
                            // usable — but rusqlite doesn't let us resume
                            // easily, so break to avoid an infinite loop.
                            break;
                        }
                    }
                }

                eprintln!(
                    "Recovery: table '{table_name}' — {recovered_count} rows recovered, {skipped_count} skipped"
                );
            }
        }
    }

    // Run post-schema migrations on the recovered database to ensure it has
    // all columns/indexes the current schema expects.
    migrations::run_post_schema_migrations(&recovered_conn).map_err(|e| {
        Error::from_reason(format!("Failed to run migrations on recovered database: {e}"))
    })?;

    let _ = recovered_conn.pragma_update(None, "user_version", 26);
    drop(recovered_conn);
    drop(read_only_conn);

    // Remove WAL/SHM sidecar files of the corrupted database.
    let wal_path = PathBuf::from(format!("{}-wal", database_path.display()));
    let shm_path = PathBuf::from(format!("{}-shm", database_path.display()));
    let _ = fs::remove_file(&wal_path);
    let _ = fs::remove_file(&shm_path);

    // Atomically replace the corrupted database with the recovered one.
    // First, rename the corrupted file to a backup.
    fs::rename(database_path, &backup_path).map_err(|e| {
        Error::from_reason(format!(
            "Failed to back up corrupted database to '{}': {e}",
            backup_path.display()
        ))
    })?;

    // Then move the recovered file into place.
    fs::rename(&recovered_path, database_path).map_err(|e| {
        // If the rename fails, try to restore the backup so we don't leave
        // the user with no database at all.
        let _ = fs::rename(&backup_path, database_path);
        Error::from_reason(format!(
            "Failed to move recovered database into place: {e}"
        ))
    })?;

    eprintln!(
        "Recovery complete. Corrupted database backed up to '{}'",
        backup_path.display()
    );

    Ok(())
}

fn create_schema(connection: &Connection) -> rusqlite::Result<()> {
    // Pre-schema migrations run BEFORE CREATE TABLE so that tables with
    // incompatible legacy structures (e.g. INTEGER primary keys) can be
    // dropped and recreated with the current schema.
    migrations::run_pre_schema_migrations(connection)?;

    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS system_settings (
           id TEXT PRIMARY KEY NOT NULL,
           setting_name TEXT NOT NULL,
           setting_code TEXT NOT NULL UNIQUE,
           setting_value TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );

         CREATE TABLE IF NOT EXISTS api_configs (
           id TEXT PRIMARY KEY NOT NULL,
           profile_name TEXT NOT NULL UNIQUE,
           display_name TEXT NOT NULL,
           is_active INTEGER NOT NULL DEFAULT 0,
           base_url TEXT NOT NULL DEFAULT '',
           base_url_mode TEXT NOT NULL DEFAULT 'auto',
           api_key TEXT NOT NULL DEFAULT '',
           request_method TEXT NOT NULL DEFAULT 'chat',
           advanced_model TEXT NOT NULL DEFAULT '',
           basic_model TEXT NOT NULL DEFAULT '',
           supports_vision INTEGER NOT NULL DEFAULT 1,
           vision_base_url TEXT NOT NULL DEFAULT '',
           vision_base_url_mode TEXT NOT NULL DEFAULT 'auto',
           vision_api_key TEXT NOT NULL DEFAULT '',
           vision_request_method TEXT NOT NULL DEFAULT 'chat',
           vision_model TEXT NOT NULL DEFAULT '',
           max_context_tokens INTEGER,
           max_tokens INTEGER,
           stream_idle_timeout_sec INTEGER,
           enable_auto_compress INTEGER NOT NULL DEFAULT 1,
           auto_compress_threshold INTEGER,
           max_retries INTEGER NOT NULL DEFAULT 5,
           retry_base_delay_ms INTEGER NOT NULL DEFAULT 3000,
           system_prompt_ids_json TEXT NOT NULL DEFAULT '',
           custom_header_scheme_id TEXT NOT NULL DEFAULT '',
           config_json TEXT NOT NULL DEFAULT '{}',
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );

CREATE INDEX IF NOT EXISTS idx_api_configs_active
           ON api_configs(is_active);
         CREATE INDEX IF NOT EXISTS idx_api_configs_source
           ON api_configs(source);

         CREATE TABLE IF NOT EXISTS system_prompts (
           id TEXT PRIMARY KEY NOT NULL,
           prompt_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           content TEXT NOT NULL DEFAULT '',
           is_active INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           scope TEXT NOT NULL DEFAULT 'global',
           project_id TEXT,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_system_prompts_active
           ON system_prompts(is_active);

         CREATE TABLE IF NOT EXISTS custom_header_schemes (
           id TEXT PRIMARY KEY NOT NULL,
           scheme_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           headers_json TEXT NOT NULL DEFAULT '{}',
           is_active INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_custom_header_schemes_active
           ON custom_header_schemes(is_active);

         CREATE TABLE IF NOT EXISTS workspace_directories (
           id TEXT PRIMARY KEY NOT NULL,
           directory_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           path TEXT NOT NULL DEFAULT '',
           kind TEXT NOT NULL DEFAULT 'local',
           is_active INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_workspace_directories_active
           ON workspace_directories(is_active);
         CREATE INDEX IF NOT EXISTS idx_workspace_directories_kind
           ON workspace_directories(kind);

         CREATE TABLE IF NOT EXISTS mcp_server_configs (
           id TEXT PRIMARY KEY NOT NULL,
           server_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           transport_type TEXT NOT NULL DEFAULT 'stdio',
           url TEXT NOT NULL DEFAULT '',
           command TEXT NOT NULL DEFAULT '',
           args_json TEXT NOT NULL DEFAULT '[]',
           env_json TEXT NOT NULL DEFAULT '{}',
           headers_json TEXT NOT NULL DEFAULT '{}',
           enabled INTEGER NOT NULL DEFAULT 1,
           timeout_ms INTEGER,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_mcp_server_configs_enabled
           ON mcp_server_configs(enabled);
         CREATE INDEX IF NOT EXISTS idx_mcp_server_configs_source
           ON mcp_server_configs(source);

         CREATE TABLE IF NOT EXISTS import_resources (
           resource_id TEXT PRIMARY KEY NOT NULL,
           resource_type TEXT NOT NULL,
           scope TEXT NOT NULL,
           project_id TEXT,
           target_id TEXT NOT NULL,
           target_path TEXT NOT NULL DEFAULT '',
           management TEXT NOT NULL DEFAULT 'snapshot',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_import_resources_target
           ON import_resources(resource_type, scope, target_id);

         CREATE TABLE IF NOT EXISTS import_resource_sources (
           source_id TEXT PRIMARY KEY NOT NULL,
           resource_id TEXT NOT NULL,
           provider TEXT NOT NULL,
           scope TEXT NOT NULL,
           origin_path TEXT NOT NULL,
           project_id TEXT,
           imported_hash TEXT NOT NULL,
           current_hash TEXT NOT NULL,
           last_scanned_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(resource_id) REFERENCES import_resources(resource_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_import_resource_sources_resource
           ON import_resource_sources(resource_id);

         CREATE TABLE IF NOT EXISTS plugins (
           plugin_id TEXT PRIMARY KEY NOT NULL,
           name TEXT NOT NULL,
           version TEXT NOT NULL DEFAULT '',
           provider TEXT NOT NULL,
           source_path TEXT NOT NULL,
           manifest_path TEXT NOT NULL,
           scope TEXT NOT NULL,
           project_id TEXT,
           state TEXT NOT NULL DEFAULT 'enabled',
           desired_state TEXT NOT NULL DEFAULT 'enabled',
           capabilities_json TEXT NOT NULL DEFAULT '[]',
           runtime_json TEXT NOT NULL DEFAULT 'null',
           content_hash TEXT NOT NULL,
           imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_plugins_provider_source
           ON plugins(provider, source_path);

         CREATE TABLE IF NOT EXISTS plugin_marketplaces (
           marketplace_id TEXT PRIMARY KEY NOT NULL,
           name TEXT NOT NULL UNIQUE,
           display_name TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           source_type TEXT NOT NULL,
           source_path TEXT NOT NULL,
           ref_name TEXT,
           cache_path TEXT,
           manifest_path TEXT NOT NULL,
           content_hash TEXT NOT NULL,
           added_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );

         CREATE TABLE IF NOT EXISTS plugin_components (
           component_id TEXT PRIMARY KEY NOT NULL,
           plugin_id TEXT NOT NULL,
           component_type TEXT NOT NULL,
           logical_id TEXT NOT NULL,
           target_id TEXT NOT NULL DEFAULT '',
           target_path TEXT NOT NULL DEFAULT '',
           origin_path TEXT NOT NULL,
           content_hash TEXT NOT NULL,
           status TEXT NOT NULL,
           unsupported_reason TEXT,
           sort_order INTEGER NOT NULL DEFAULT 0,
           FOREIGN KEY(plugin_id) REFERENCES plugins(plugin_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_plugin_components_plugin
           ON plugin_components(plugin_id, sort_order);

         CREATE TABLE IF NOT EXISTS sub_agent_configs (
           id TEXT PRIMARY KEY NOT NULL,
           agent_id TEXT NOT NULL,
           name TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           system_prompt TEXT NOT NULL DEFAULT '',
           tools_json TEXT NOT NULL DEFAULT '[]',
           config_profile TEXT NOT NULL DEFAULT '',
           builtin INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           project_id TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(agent_id, project_id)
         );
         CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_builtin
           ON sub_agent_configs(builtin);
         CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_source
           ON sub_agent_configs(source);

         CREATE TABLE IF NOT EXISTS sensitive_command_configs (
           id TEXT PRIMARY KEY NOT NULL,
           command_id TEXT NOT NULL UNIQUE,
           pattern TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           enabled INTEGER NOT NULL DEFAULT 1,
           is_preset INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_sensitive_command_configs_enabled
           ON sensitive_command_configs(enabled);
         CREATE INDEX IF NOT EXISTS idx_sensitive_command_configs_source
           ON sensitive_command_configs(source);

         CREATE TABLE IF NOT EXISTS chat_conversations (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL UNIQUE,
           title TEXT NOT NULL DEFAULT '',
           summary TEXT NOT NULL DEFAULT '',
           last_message_preview TEXT NOT NULL DEFAULT '',
            message_count INTEGER NOT NULL DEFAULT 0,
            model TEXT NOT NULL DEFAULT '',
            api_profile_name TEXT NOT NULL DEFAULT '',
            last_response_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_duration_ms INTEGER NOT NULL DEFAULT 0,
            directory_id TEXT NOT NULL DEFAULT '',
             forked_from_conversation_id TEXT NOT NULL DEFAULT '',
             fork_message_count INTEGER NOT NULL DEFAULT 0,
              emoji TEXT NOT NULL DEFAULT '',
              -- Per-conversation Plan/Goal Mode overrides. NULL flags are
              -- legacy/unset rows and are read as disabled (synonymous
              -- with 0); a NULL goal_mode_token_budget falls back to the
              -- global default budget.
              plan_mode INTEGER,
             goal_mode INTEGER,
             goal_mode_token_budget INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
          );
          CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at
           ON chat_conversations(updated_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_chat_conversations_status
           ON chat_conversations(status);

         CREATE TABLE IF NOT EXISTS sub_agent_sessions (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL UNIQUE,
           parent_conversation_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           agent_name TEXT NOT NULL DEFAULT '',
           run_status TEXT NOT NULL DEFAULT 'running',
           error_message TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
           FOREIGN KEY(parent_conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_sub_agent_sessions_parent
           ON sub_agent_sessions(parent_conversation_id, created_at ASC, id ASC);
         CREATE INDEX IF NOT EXISTS idx_sub_agent_sessions_status
           ON sub_agent_sessions(run_status);

         CREATE TABLE IF NOT EXISTS chat_messages (
           id TEXT PRIMARY KEY NOT NULL,
           message_id TEXT NOT NULL UNIQUE,
           conversation_id TEXT NOT NULL,
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           model TEXT NOT NULL DEFAULT '',
           response_id TEXT NOT NULL DEFAULT '',
           checkpoint_id TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'sent',
           raw_json TEXT NOT NULL DEFAULT '{}',
           thinking TEXT NOT NULL DEFAULT '',
           thinking_blocks_json TEXT NOT NULL DEFAULT '[]',
           tool_calls_json TEXT NOT NULL DEFAULT '[]',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id
           ON chat_messages(conversation_id, id ASC);
         CREATE INDEX IF NOT EXISTS idx_chat_messages_response_id
           ON chat_messages(response_id);

         CREATE TABLE IF NOT EXISTS todo_items (
           id TEXT PRIMARY KEY NOT NULL,
           session_id TEXT NOT NULL,
           content TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           response_id TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           parent_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_todo_items_session
           ON todo_items(session_id);

         CREATE TABLE IF NOT EXISTS usage_records (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL DEFAULT '',
           response_id TEXT NOT NULL DEFAULT '',
           model TEXT NOT NULL DEFAULT '',
           api_profile_name TEXT NOT NULL DEFAULT '',
           api_config_id TEXT NOT NULL DEFAULT '',
           request_method TEXT NOT NULL DEFAULT '',
           input_tokens INTEGER NOT NULL DEFAULT 0,
           output_tokens INTEGER NOT NULL DEFAULT 0,
           cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
           cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT '',
           is_sub_agent INTEGER NOT NULL DEFAULT 0,
           directory_id TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_usage_records_created_at
           ON usage_records(created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_usage_records_conversation_id
           ON usage_records(conversation_id, id DESC);
         CREATE INDEX IF NOT EXISTS idx_usage_records_model
           ON usage_records(model);
         CREATE INDEX IF NOT EXISTS idx_usage_records_api_profile_name
           ON usage_records(api_profile_name);

         CREATE TABLE IF NOT EXISTS app_logs (
           id TEXT PRIMARY KEY NOT NULL,
           level TEXT NOT NULL DEFAULT 'INFO',
           module TEXT NOT NULL DEFAULT '',
           func TEXT NOT NULL DEFAULT '',
           line INTEGER,
           message TEXT NOT NULL DEFAULT '',
           input TEXT NOT NULL DEFAULT '',
           output TEXT NOT NULL DEFAULT '',
           duration TEXT NOT NULL DEFAULT '',
           context TEXT NOT NULL DEFAULT '',
           error TEXT NOT NULL DEFAULT '',
           source TEXT NOT NULL DEFAULT 'main',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_app_logs_created_at
           ON app_logs(created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_app_logs_level
           ON app_logs(level);
         CREATE INDEX IF NOT EXISTS idx_app_logs_module
           ON app_logs(module);

         CREATE TABLE IF NOT EXISTS memos (
           id TEXT PRIMARY KEY NOT NULL,
           memo_id TEXT NOT NULL UNIQUE,
           directory_id TEXT NOT NULL DEFAULT '',
           content TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'pending',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_memos_directory_status_created
           ON memos(directory_id, status, created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_memos_directory_created
           ON memos(directory_id, created_at DESC, id DESC);
    ",
    )?;

    // Ensure the codebase embed sessions table exists. Defined in a separate
    // module so the schema lives next to its CRUD functions.
    services::codebase_embed_sessions::ensure_sessions_table(connection)?;
    services::remote_drafts::ensure_remote_drafts_table(connection)?;

    // Ensure the image library table exists (generated images index).
    services::image_library::ensure_image_library_table(connection)?;

    // Post-schema migrations run AFTER CREATE TABLE to add columns that
    // older databases lack but fresh databases already have. Each migration
    // is idempotent. Includes the local per-conversation Plan/Goal Mode
    // columns and the sub-agent project_id rebuild (see migrations.rs).
    migrations::run_post_schema_migrations(connection)?;

    connection.pragma_update(None, "user_version", 26)?;

    Ok(())
}

pub fn database_error(database_path: &Path, action: &str, error: rusqlite::Error) -> Error {
    Error::from_reason(format!(
        "Failed to {action} Snow App sqlite database at '{}': {error}",
        database_path.display()
    ))
}
