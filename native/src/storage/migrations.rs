//! Database schema migrations for existing databases created by older app
//! versions.
//!
//! Migrations are split into two phases because of ordering constraints
//! relative to `CREATE TABLE IF NOT EXISTS`:
//!
//! 1. **Pre-schema** (`run_pre_schema_migrations`) — runs *before* the
//!    `CREATE TABLE` batch. Used when a table must be dropped and recreated
//!    because its fundamental structure (e.g. primary key column type)
//!    changed in an incompatible way.
//!
//! 2. **Post-schema** (`run_post_schema_migrations`) — runs *after* the
//!    `CREATE TABLE` batch. Used for additive changes (e.g. `ALTER TABLE
//!    ADD COLUMN`) that are idempotent: a no-op when the column already
//!    exists (fresh databases get it from `CREATE TABLE`).
//!
//! ## Adding a new migration
//!
//! 1. If the migration is **additive** (new column, new index), add a function
//!    and call it from `run_post_schema_migrations`.
//! 2. If the migration requires **rebuilding** a table, add a function and
//!    call it from `run_pre_schema_migrations`.
//! 3. Bump the `user_version` pragma in `database::create_schema` to the new
//!    version number.
//! 4. Each migration function MUST be idempotent — running it on a database
//!    that has already been migrated must be a safe no-op.

use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

/// Tables whose legacy schema used `INTEGER PRIMARY KEY`. When detected, the
/// table is dropped so `CREATE TABLE` can recreate it with a `TEXT PRIMARY KEY`
/// (snowflake ID) column.
///
/// This list is frozen — it only covers tables that existed before the
/// snowflake-ID migration. Tables added after that migration always use
/// `TEXT PRIMARY KEY` from creation and never need to appear here.
/// `api_configs` is intentionally excluded: its legacy columns must survive.
const LEGACY_INTEGER_PRIMARY_KEY_TABLES: &[&str] = &[
    "system_settings",
    "codebase_settings",
    "system_prompts",
    "custom_header_schemes",
    "workspace_directories",
    "mcp_server_configs",
    "sub_agent_configs",
    "sensitive_command_configs",
    "chat_conversations",
    "sub_agent_sessions",
    "chat_messages",
    "usage_records",
];

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Runs migrations that must execute **before** `CREATE TABLE IF NOT EXISTS`.
///
/// Currently this handles the one-time rebuild of legacy tables that used
/// `INTEGER PRIMARY KEY` so they can be recreated with `TEXT PRIMARY KEY`
/// (snowflake IDs). On databases already using TEXT primary keys this is a
/// fast no-op.
pub fn run_pre_schema_migrations(connection: &Connection) -> rusqlite::Result<()> {
    reset_legacy_integer_primary_key_tables(connection)?;
    // Must run before CREATE TABLE batch: the schema's idx_workflow_node_sessions_flow
    // references flow_id, so old tables lacking the column must be patched first.
    migrate_workflow_node_sessions_flow_id(connection)
}

/// Runs migrations that must execute **after** `CREATE TABLE IF NOT EXISTS`.
///
/// Each function below is idempotent and targets a specific additive schema
/// change (e.g. adding a column that old databases lack but fresh databases
/// already have via `CREATE TABLE`).
pub fn run_post_schema_migrations(connection: &Connection) -> rusqlite::Result<()> {
    migrate_chat_conversations_api_profile(connection)?;
    migrate_plugins_runtime(connection)?;
    migrate_plugins_desired_state(connection)?;
    migrate_system_prompt_scope(connection)?;
    migrate_chat_conversations_modes(connection)?;
    migrate_chat_conversations_workflow_mode(connection)?;
    migrate_chat_conversations_runtime_config(connection)?;
    migrate_chat_conversations_run_stats(connection)?;
    migrate_sub_agent_configs_project_id(connection)?;
    migrate_sub_agent_configs_model(connection)?;
    migrate_scheduled_tasks_pre_script(connection)?;
    migrate_api_configs_partial_retry_max_chars(connection)?;
    migrate_api_configs_config_json(connection)?;
    migrate_chat_messages_interruption_metadata(connection)?;
    migrate_chat_messages_thinking_stats(connection)?;
    purge_assistant_raw_json_blobs(connection)?;
    drop_tables_referencing_sub_agent_configs_legacy(connection)?;
    migrate_project_collections(connection)?;
    migrate_workflow_node_sessions_flow_checkpoint_id(connection)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Pre-schema migrations
// ---------------------------------------------------------------------------

/// Drops every table in [`LEGACY_INTEGER_PRIMARY_KEY_TABLES`] that still has
/// an `INTEGER` primary key named `id`, so the subsequent `CREATE TABLE`
/// batch can recreate them with `TEXT PRIMARY KEY`.
///
/// This is a destructive migration — it deletes all rows in the affected
/// tables. It is acceptable because the project had not been released when
/// the snowflake-ID migration was applied; development databases are expected
/// to be rebuilt.
fn reset_legacy_integer_primary_key_tables(connection: &Connection) -> rusqlite::Result<()> {
    let has_legacy_primary_key =
        LEGACY_INTEGER_PRIMARY_KEY_TABLES
            .iter()
            .try_fold(false, |found, table_name| {
                Ok::<bool, rusqlite::Error>(
                    found || has_integer_primary_key(connection, table_name)?,
                )
            })?;

    if !has_legacy_primary_key {
        return Ok(());
    }

    // Disable foreign keys during the drop so cascading constraints don't
    // fire while dependent tables are being removed in arbitrary order.
    // They are re-enabled immediately after, and the subsequent CREATE TABLE
    // batch will re-establish the schema with proper FK constraints.
    connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
    for table_name in LEGACY_INTEGER_PRIMARY_KEY_TABLES {
        connection.execute(&format!("DROP TABLE IF EXISTS {table_name}"), [])?;
    }
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;

    Ok(())
}

/// Returns `true` when `table_name` has a column named `id` that is both an
/// `INTEGER` type and part of the primary key.
fn has_integer_primary_key(connection: &Connection, table_name: &str) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let mut columns = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i32>(5)?,
        ))
    })?;

    columns.try_fold(false, |found, column| {
        let (column_name, column_type, primary_key_index) = column?;
        Ok(found
            || (column_name == "id"
                && primary_key_index > 0
                && column_type.eq_ignore_ascii_case("INTEGER")))
    })
}

// ---------------------------------------------------------------------------
// Post-schema migrations
// ---------------------------------------------------------------------------

/// Adds the `api_profile_name` column to `chat_conversations` for databases
/// created by older app versions.
///
/// The column binds a conversation to a specific API config profile so
/// different conversations can route to different providers/models. An empty
/// string means "follow the global active profile" (the legacy behaviour).
///
/// Idempotent: no-op when the column is already present (fresh databases get
/// it from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_conversations_api_profile(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let mut columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let has_api_profile_column = columns.try_fold(false, |found, column| {
        Ok::<bool, rusqlite::Error>(found || column? == "api_profile_name")
    })?;

    if !has_api_profile_column {
        connection.execute(
            "ALTER TABLE chat_conversations
                ADD COLUMN api_profile_name TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    Ok(())
}

/// Adds the `runtime_json` column to the `plugins` table for databases that
/// were created with an earlier plugin schema.
///
/// The column stores the serialized plugin runtime declaration (entry,
/// permissions, timeout). Idempotent: no-op when the column is already
/// present (fresh databases get it from `CREATE TABLE` in `create_schema`).
fn migrate_plugins_runtime(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(plugins)")?;
    let mut columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let has_runtime_column = columns.try_fold(false, |found, column| {
        Ok::<bool, rusqlite::Error>(found || column? == "runtime_json")
    })?;

    if !has_runtime_column {
        connection.execute(
            "ALTER TABLE plugins ADD COLUMN runtime_json TEXT NOT NULL DEFAULT 'null'",
            [],
        )?;
    }

    Ok(())
}

/// Adds the persisted requested state for Plugins. Runtime discovery can set a
/// Plugin to broken or update-available; this column preserves whether the
/// user intended it to be enabled when its source becomes available again.
fn migrate_plugins_desired_state(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(plugins)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "desired_state") {
        connection.execute(
            "ALTER TABLE plugins ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'enabled'",
            [],
        )?;
        connection.execute(
            "UPDATE plugins
                SET desired_state = CASE WHEN state = 'disabled' THEN 'disabled' ELSE 'enabled' END",
            [],
        )?;
    }

    Ok(())
}

/// Adds the `partial_retry_max_chars` column to `api_configs` for databases
/// created by older app versions.
///
/// The column stores the mid-stream retry keep-partial threshold (chars),
/// part of the unified retry policy sourced from the API profile. Idempotent:
/// no-op when the column is already present (fresh databases get it from the
/// `CREATE TABLE` statement in `create_schema`).
fn migrate_api_configs_partial_retry_max_chars(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(api_configs)")?;
    let mut columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let has_column = columns.try_fold(false, |found, column| {
        Ok::<bool, rusqlite::Error>(found || column? == "partial_retry_max_chars")
    })?;

    if !has_column {
        connection.execute(
            "ALTER TABLE api_configs
                ADD COLUMN partial_retry_max_chars INTEGER NOT NULL DEFAULT 1000",
            [],
        )?;
    }

    Ok(())
}

/// Adds the `config_json` canonical document to API profiles and folds legacy
/// scalar columns into its `snowcfg` object. Legacy columns remain shadow data.
fn migrate_api_configs_config_json(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(api_configs)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|column| column == "config_json") {
        connection.execute(
            "ALTER TABLE api_configs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'",
            [],
        )?;
    }

    let mut statement = connection.prepare(
        "SELECT CAST(id AS TEXT), config_json, base_url, base_url_mode, api_key,
                request_method, advanced_model, basic_model, supports_vision,
                vision_base_url, vision_base_url_mode, vision_api_key,
                vision_request_method, vision_model, max_context_tokens, max_tokens,
                stream_idle_timeout_sec, enable_auto_compress, auto_compress_threshold,
                max_retries, retry_base_delay_ms, partial_retry_max_chars,
                system_prompt_ids_json, custom_header_scheme_id, source
           FROM api_configs",
    )?;
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        String,
        String,
        String,
        String,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        i64,
        Option<i64>,
        i64,
        i64,
        i64,
        String,
        String,
        String,
    )> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
                row.get(14)?,
                row.get(15)?,
                row.get(16)?,
                row.get(17)?,
                row.get(18)?,
                row.get(19)?,
                row.get(20)?,
                row.get(21)?,
                row.get(22)?,
                row.get(23)?,
                row.get(24)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    for (
        id,
        raw_config_json,
        base_url,
        base_url_mode,
        api_key,
        request_method,
        advanced_model,
        basic_model,
        supports_vision,
        vision_base_url,
        vision_base_url_mode,
        vision_api_key,
        vision_request_method,
        vision_model,
        max_context_tokens,
        max_tokens,
        stream_idle_timeout_sec,
        enable_auto_compress,
        auto_compress_threshold,
        max_retries,
        retry_base_delay_ms,
        partial_retry_max_chars,
        system_prompt_ids_json,
        custom_header_scheme_id,
        source,
    ) in rows
    {
        let mut root = match serde_json::from_str::<Value>(&raw_config_json) {
            Ok(Value::Object(object)) => Value::Object(object),
            _ => json!({}),
        };
        let object = root.as_object_mut().expect("JSON root must be an object");
        if !matches!(object.get("snowcfg"), Some(Value::Object(_))) {
            object.insert("snowcfg".to_string(), json!({}));
        }
        let snowcfg = object
            .get_mut("snowcfg")
            .and_then(Value::as_object_mut)
            .expect("snowcfg must be an object");
        let set_text = |snowcfg: &mut Map<String, Value>, key: &str, value: &str| {
            if !value.trim().is_empty() || !snowcfg.contains_key(key) {
                snowcfg.insert(key.to_string(), Value::String(value.to_string()));
            }
        };
        set_text(snowcfg, "baseUrl", &base_url);
        set_text(snowcfg, "baseUrlMode", &base_url_mode);
        set_text(snowcfg, "apiKey", &api_key);
        set_text(snowcfg, "requestMethod", &request_method);
        set_text(snowcfg, "advancedModel", &advanced_model);
        set_text(snowcfg, "basicModel", &basic_model);
        snowcfg.insert("supportsVision".to_string(), json!(supports_vision != 0));
        set_text(snowcfg, "visionBaseUrl", &vision_base_url);
        set_text(snowcfg, "visionBaseUrlMode", &vision_base_url_mode);
        set_text(snowcfg, "visionApiKey", &vision_api_key);
        set_text(snowcfg, "visionRequestMethod", &vision_request_method);
        set_text(snowcfg, "visionModel", &vision_model);
        let set_optional = |snowcfg: &mut Map<String, Value>, key: &str, value: Option<i64>| {
            if let Some(value) = value {
                snowcfg.insert(key.to_string(), json!(value));
            } else {
                snowcfg.entry(key.to_string()).or_insert(Value::Null);
            }
        };
        set_optional(snowcfg, "maxContextTokens", max_context_tokens);
        set_optional(snowcfg, "maxTokens", max_tokens);
        set_optional(snowcfg, "streamIdleTimeoutSec", stream_idle_timeout_sec);
        snowcfg.insert(
            "enableAutoCompress".to_string(),
            json!(enable_auto_compress != 0),
        );
        set_optional(snowcfg, "autoCompressThreshold", auto_compress_threshold);
        snowcfg.insert("maxRetries".to_string(), json!(max_retries));
        snowcfg.insert("retryDelayMs".to_string(), json!(retry_base_delay_ms));
        snowcfg.insert(
            "partialRetryMaxChars".to_string(),
            json!(partial_retry_max_chars),
        );
        set_text(snowcfg, "systemPromptIdsJson", &system_prompt_ids_json);
        set_text(snowcfg, "customHeaderSchemeId", &custom_header_scheme_id);
        set_text(snowcfg, "source", &source);
        let canonical_json = serde_json::to_string(&root).unwrap_or_else(|_| "{\"snowcfg\":{}}".to_string());
        connection.execute(
            "UPDATE api_configs SET config_json = ?1 WHERE CAST(id AS TEXT) = ?2",
            params![canonical_json, id],
        )?;
    }
    Ok(())
}


/// Existing rows remain `NULL`, and each column is checked independently so
/// partially migrated and repeatedly migrated databases are both safe.
fn migrate_chat_messages_interruption_metadata(
    connection: &Connection,
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_messages)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "interruption_reason") {
        connection.execute(
            "ALTER TABLE chat_messages ADD COLUMN interruption_reason TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "recovery_outcome") {
        connection.execute(
            "ALTER TABLE chat_messages ADD COLUMN recovery_outcome TEXT",
            [],
        )?;
    }

    Ok(())
}

/// Adds the thinking-phase statistics columns (wall-clock duration between
/// the first and last thinking delta, and the thinking-only token count) to
/// `chat_messages` for databases created before the thinking block summary
/// existed. Older rows keep the NOT NULL DEFAULT 0 values, so they simply
/// render without thinking statistics until the next completed run writes
/// fresh stats.
///
/// Idempotent: each column is checked independently so partially migrated and
/// repeatedly migrated databases are both safe (fresh databases get the
/// columns from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_messages_thinking_stats(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_messages)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "thinking_duration_ms") {
        connection.execute(
            "ALTER TABLE chat_messages ADD COLUMN thinking_duration_ms INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "thinking_token_count") {
        connection.execute(
            "ALTER TABLE chat_messages ADD COLUMN thinking_token_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    Ok(())
}

/// Adds project scope metadata to prompts created before imported prompts
/// were isolated to their workspace. Existing imported prompt IDs encode the
/// workspace identity, allowing the migration to preserve their scope.
fn migrate_system_prompt_scope(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(system_prompts)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let added_scope = !columns.iter().any(|column| column == "scope");
    if added_scope {
        connection.execute(
            "ALTER TABLE system_prompts ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "project_id") {
        connection.execute("ALTER TABLE system_prompts ADD COLUMN project_id TEXT", [])?;
    }
    if added_scope {
        migrate_legacy_imported_system_prompts(connection)?;
    }
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_system_prompts_scope_active
           ON system_prompts(scope, project_id, is_active)",
        [],
    )?;

    Ok(())
}

fn migrate_legacy_imported_system_prompts(connection: &Connection) -> rusqlite::Result<()> {
    for prefix in [
        "codex:project:",
        "claude-code:project:",
        "opencode:project:",
    ] {
        connection.execute(
            "UPDATE system_prompts
                SET scope = 'project',
                    project_id = COALESCE(
                        (
                            SELECT directory_id
                              FROM workspace_directories
                             WHERE system_prompts.prompt_id LIKE ?1 || directory_id || ':%'
                             ORDER BY length(directory_id) DESC
                             LIMIT 1
                        ),
                        ''
                    )
              WHERE scope = 'global'
                AND project_id IS NULL
                AND prompt_id LIKE ?1 || '%'",
            [prefix],
        )?;
    }
    connection.execute(
        "UPDATE system_prompts
            SET scope = 'project',
                project_id = (
                    SELECT plugins.project_id
                      FROM plugin_components
                      JOIN plugins ON plugins.plugin_id = plugin_components.plugin_id
                     WHERE plugin_components.target_id = system_prompts.prompt_id
                       AND plugins.scope = 'project'
                       AND plugins.project_id IS NOT NULL
                     LIMIT 1
                )
          WHERE scope = 'global'
            AND project_id IS NULL
            AND EXISTS (
                SELECT 1
                  FROM plugin_components
                  JOIN plugins ON plugins.plugin_id = plugin_components.plugin_id
                 WHERE plugin_components.target_id = system_prompts.prompt_id
                   AND plugins.scope = 'project'
                   AND plugins.project_id IS NOT NULL
            )",
        [],
    )?;
    connection.execute(
        "UPDATE system_prompts
            SET is_active = 0
          WHERE prompt_id LIKE 'claude-code:%:command:%'
             OR prompt_id LIKE 'opencode:%:command:%'
             OR prompt_id LIKE 'opencode:%:agent:%'
             OR prompt_id IN (
                 SELECT target_id
                   FROM plugin_components
                  WHERE component_type IN ('command', 'agent')
             )",
        [],
    )?;

    Ok(())
}

/// Adds the per-conversation Plan/Goal Mode override columns to
/// `chat_conversations` for databases created by older app versions.
///
/// The mode flags are 0/1 booleans and the token budget is an integer.
/// Existing rows keep NULL flags; reads treat NULL as disabled
/// (synonymous with 0) so legacy conversations open with both modes off.
///
/// Idempotent: no-op when the columns are already present (fresh databases
/// get them from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_conversations_modes(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let missing: Vec<(&str, &str)> = [
        ("plan_mode", "INTEGER"),
        ("goal_mode", "INTEGER"),
        ("worktree_mode", "INTEGER"),
        ("workflow_mode", "INTEGER"),
        ("goal_mode_token_budget", "INTEGER"),
    ]
    .into_iter()
    .filter(|(name, _)| !columns.iter().any(|column| column == name))
    .collect();

    for (name, column_type) in missing {
        connection.execute(
            &format!("ALTER TABLE chat_conversations ADD COLUMN {name} {column_type}"),
            [],
        )?;
    }

    Ok(())
}

/// Adds the `workflow_mode` flag column to `chat_conversations` for databases
/// created before WorkFlow Mode existed. NULL is read as disabled.
///
/// Idempotent: no-op when the column is already present (fresh databases get
/// it from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_conversations_workflow_mode(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if columns.iter().any(|column| column == "workflow_mode") {
        return Ok(());
    }
    connection.execute(
        "ALTER TABLE chat_conversations ADD COLUMN workflow_mode INTEGER",
        [],
    )?;

    Ok(())
}

/// Adds the `flow_id` column to `workflow_node_sessions` so node runs are
/// keyed per workflow instance (interaction id), not just per parent
/// conversation — multiple flows in one conversation must stay isolated.
///
/// Idempotent: no-op when the column is already present (fresh databases get
/// it from the `CREATE TABLE` statement in `create_schema`).
fn migrate_workflow_node_sessions_flow_id(connection: &Connection) -> rusqlite::Result<()> {
    // No-op on fresh databases (table not yet created; create_schema adds flow_id).
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_node_sessions')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }

    let mut statement = connection.prepare("PRAGMA table_info(workflow_node_sessions)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if columns.iter().any(|column| column == "flow_id") {
        return Ok(());
    }
    connection.execute(
        "ALTER TABLE workflow_node_sessions ADD COLUMN flow_id TEXT NOT NULL DEFAULT ''",
        [],
    )?;

    Ok(())
}

/// Adds the `flow_checkpoint_id` column to `workflow_node_sessions` so every
/// node run records the flow-level file checkpoint taken before the flow's
/// first node executes. Rollback restores it to undo file changes made by
/// workflow nodes (nodes bypass the main agent loop, so without this column
/// their file edits had no snapshot at all).
///
/// Idempotent: no-op when the column is already present (fresh databases get
/// it from the `CREATE TABLE` statement in `create_schema`).
fn migrate_workflow_node_sessions_flow_checkpoint_id(
    connection: &Connection,
) -> rusqlite::Result<()> {
    // No-op on fresh databases (table not yet created; create_schema adds the column).
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_node_sessions')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }

    let mut statement = connection.prepare("PRAGMA table_info(workflow_node_sessions)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if columns
        .iter()
        .any(|column| column == "flow_checkpoint_id")
    {
        return Ok(());
    }
    connection.execute(
        "ALTER TABLE workflow_node_sessions ADD COLUMN flow_checkpoint_id TEXT NOT NULL DEFAULT ''",
        [],
    )?;

    Ok(())
}

/// Adds nullable per-conversation runtime configuration overrides for databases
/// created before thinking strength and Responses Fast Mode were persisted.
///
/// Existing conversations intentionally remain NULL in both columns so they
/// continue to inherit the bound API profile defaults. The migration is
/// idempotent and checks each column independently for partially migrated
/// databases.
fn migrate_chat_conversations_runtime_config(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "thinking_strength") {
        connection.execute(
            "ALTER TABLE chat_conversations ADD COLUMN thinking_strength TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "responses_fast_mode") {
        connection.execute(
            "ALTER TABLE chat_conversations ADD COLUMN responses_fast_mode INTEGER",
            [],
        )?;
    }

    Ok(())
}

/// Adds the run-level summary columns (cumulative token usage of the latest
/// AI run and its wall-clock duration) to databases created before the run
/// summary bar existed. Older rows keep the NOT NULL DEFAULT 0 values, so
/// they simply render without duration/token summary data until the next
/// completed run writes fresh stats.
fn migrate_chat_conversations_run_stats(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (name, definition) in [
        ("run_input_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("run_output_tokens", "INTEGER NOT NULL DEFAULT 0"),
        (
            "run_cache_creation_input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        ("run_cache_read_input_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("last_run_duration_ms", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(
                &format!(
                    "ALTER TABLE chat_conversations ADD COLUMN {name} {definition}"
                ),
                [],
            )?;
        }
    }

    Ok(())
}

/// Adds sub-agent project scoping to databases created before it existed.
///
/// Older databases have `sub_agent_configs` with a single-column
/// `UNIQUE(agent_id)` constraint and no `project_id` column. SQLite cannot
/// alter a UNIQUE constraint, so the table is rebuilt: rename → create with
/// the new schema (composite `UNIQUE(agent_id, project_id)`) → copy rows
/// (existing agents become global, `project_id = ''`) → drop the old table.
///
/// Idempotent: no-op when the column is already present.
fn migrate_sub_agent_configs_project_id(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(sub_agent_configs)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if columns.iter().any(|column| column == "project_id") {
        // 列已存在（全新数据库或已迁移）：只需确保 project 索引存在。
        // 注意：该索引不能放在主 execute_batch 中——旧库在此迁移执行前
        // 还没有 project_id 列，在 batch 里创建会报 no such column。
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_project
               ON sub_agent_configs(project_id);",
        )?;
        return Ok(());
    }

    connection.execute_batch(
        "ALTER TABLE sub_agent_configs RENAME TO sub_agent_configs_legacy;
         CREATE TABLE sub_agent_configs (
           id TEXT PRIMARY KEY NOT NULL,
           agent_id TEXT NOT NULL,
           name TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           system_prompt TEXT NOT NULL DEFAULT '',
           tools_json TEXT NOT NULL DEFAULT '[]',
           config_profile TEXT NOT NULL DEFAULT '',
           model TEXT NOT NULL DEFAULT '',
           builtin INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           project_id TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(agent_id, project_id)
         );
           INSERT INTO sub_agent_configs (
            id, agent_id, name, description, system_prompt, tools_json,
            config_profile, model, builtin, sort_order, source, project_id,
            created_at, updated_at
          )
          SELECT id, agent_id, name, description, system_prompt, tools_json,
                 config_profile, '', builtin, sort_order, source, '',
                 created_at, updated_at
           FROM sub_agent_configs_legacy;
         CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_builtin
           ON sub_agent_configs(builtin);
         CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_source
           ON sub_agent_configs(source);
         CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_project
           ON sub_agent_configs(project_id);
         DROP TABLE sub_agent_configs_legacy;",
    )?;

    Ok(())
}

/// Drops tables left behind by intermediate dev builds whose foreign keys
/// reference `sub_agent_configs_legacy` — a table that no longer exists once
/// [`migrate_sub_agent_configs_project_id`] has rebuilt `sub_agent_configs`.
///
/// With `PRAGMA foreign_keys = ON` (set by `database::open_connection`),
/// SQLite validates the whole foreign-key chain when preparing DML against a
/// related table: e.g. deleting a workspace directory cascades into the
/// orphan table (which references `workspace_directories`), whose dangling
/// `agent_id` FK then fails with "no such table: main.sub_agent_configs_legacy".
/// Reads still work, which makes the failure look like a delete-only bug.
///
/// The affected tables are orphaned leftovers (the current schema never
/// creates them), so dropping them is safe. Detection is generic so any
/// future table with a dangling FK to the legacy table is cleaned too.
///
/// Idempotent: no-op when no such table exists.
fn drop_tables_referencing_sub_agent_configs_legacy(
    connection: &Connection,
) -> rusqlite::Result<()> {
    let tables: Vec<String> = connection
        .prepare(
            "SELECT name
               FROM sqlite_master
              WHERE type = 'table'
                AND name != 'sub_agent_configs_legacy'
                AND sql LIKE '%sub_agent_configs_legacy%'",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for table in tables {
        connection.execute(&format!("DROP TABLE IF EXISTS \"{table}\""), [])?;
        eprintln!(
            "Dropped orphan table \"{table}\" with dangling foreign key to sub_agent_configs_legacy"
        );
    }

    Ok(())
}

/// Adds the optional independent model override for sub-agents.
///
/// Existing rows receive an empty string, which preserves the compatibility
/// rule: inherited agents use the parent runtime model, while fixed-profile
/// agents use that profile's advanced model. Idempotent on fresh or already
/// migrated databases.
fn migrate_sub_agent_configs_model(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(sub_agent_configs)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "model") {
        connection.execute(
            "ALTER TABLE sub_agent_configs ADD COLUMN model TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    Ok(())
}

/// Adds the pre-script configuration and skip-state columns to
/// `scheduled_tasks` for databases created by older app versions.
///
/// Without these columns, a task's pre-script (and its timeout / run-on-error
/// flag, plus skip counters) only lived in the renderer's memory and was
/// silently lost on restart. Idempotent: each column is checked independently
/// via `PRAGMA table_info`, so partially migrated and repeatedly migrated
/// databases are both safe (fresh databases get the columns from `CREATE
/// TABLE`).
fn migrate_scheduled_tasks_pre_script(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(scheduled_tasks)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "pre_script") {
        connection.execute("ALTER TABLE scheduled_tasks ADD COLUMN pre_script TEXT", [])?;
    }
    if !columns.iter().any(|column| column == "pre_script_timeout_ms") {
        connection.execute(
            "ALTER TABLE scheduled_tasks ADD COLUMN pre_script_timeout_ms INTEGER",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "run_on_script_error") {
        connection.execute(
            "ALTER TABLE scheduled_tasks ADD COLUMN run_on_script_error INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "skip_count") {
        connection.execute(
            "ALTER TABLE scheduled_tasks ADD COLUMN skip_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "last_skipped_at") {
        connection.execute(
            "ALTER TABLE scheduled_tasks ADD COLUMN last_skipped_at TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "last_skip_reason") {
        connection.execute(
            "ALTER TABLE scheduled_tasks ADD COLUMN last_skip_reason TEXT",
            [],
        )?;
    }

    Ok(())
}

/// Historically every assistant response stored `serde_json::to_string(raw_events)`
/// — the complete streaming chunk array — into `chat_messages.raw_json`. Each
/// token produced a chunk repeating `id` / `model` / `system_fingerprint`,
/// so a single long response could balloon to several MB, and the table
/// dominated the database (>450 MB for ~3000 rows in practice).
///
/// The column is only read back for tool-role messages (to reconstruct
/// `tool_call_id` on the next request) and for image-ref stripping (which
/// operates on the `[{name, callId, result}]` tool format only). Assistant
/// `raw_json` is never consulted, so it is safe to wipe.
///
/// Idempotent: once cleared the rows match `{}` (or are empty) and the
/// `WHERE` clause no longer matches them, so re-running is a no-op.
fn purge_assistant_raw_json_blobs(connection: &Connection) -> rusqlite::Result<()> {
    // Only target rows whose raw_json still contains the old SSE chunk
    // structure (a JSON array of objects with "choices" / "candidates" /
    // "type":"message_delta" etc.). The simplest portable guard is length:
    // tool-role raw_json is typically < 2 KB; assistant blobs were > 2 KB.
    // Using 2048 bytes as the threshold keeps tool messages untouched while
    // catching every legacy assistant blob.
    let purged = connection.execute(
        "UPDATE chat_messages
            SET raw_json = '{}'
          WHERE role = 'assistant'
            AND length(raw_json) > 2048",
        [],
    )?;

    // When rows were actually rewritten, the freed pages remain allocated
    // inside the SQLite file until VACUUM rebuilds the database. Running
    // VACUUM once after the purge shrinks the file back to its real size.
    // Because the UPDATE above is a no-op on already-migrated databases
    // (purged == 0), VACUUM only fires a single time per database.
    if purged > 0 {
        connection.execute_batch("VACUUM")?;
    }
    Ok(())
}

/// Creates the project collection tables (`project_collections` +
/// `collection_members`) on databases created by older app versions.
///
/// Collections are pure metadata (name + member `directory_id`s) and do not
/// exist on disk, so a fresh install gets them from `create_schema` and this
/// migration only matters for existing databases. Idempotent: `CREATE TABLE
/// IF NOT EXISTS` makes re-runs a safe no-op.
fn migrate_project_collections(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_collections (
           id TEXT PRIMARY KEY NOT NULL,
           collection_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS collection_members (
           id TEXT PRIMARY KEY NOT NULL,
           collection_id TEXT NOT NULL,
           directory_id TEXT NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(collection_id, directory_id)
         );
         CREATE INDEX IF NOT EXISTS idx_collection_members_collection
           ON collection_members(collection_id, sort_order);",
    )
}