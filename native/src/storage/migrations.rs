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

use super::services::chat_conversations::backfill_sub_agent_dispatch_identity;
use super::services::project_collections::collection_color_for_index;

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
    migrate_system_prompt_scope(connection)?;
    migrate_chat_conversations_modes(connection)?;
    migrate_chat_conversations_workflow_mode(connection)?;
    migrate_chat_conversations_runtime_config(connection)?;
    migrate_chat_conversations_run_stats(connection)?;
    migrate_sub_agent_configs_project_id(connection)?;
    migrate_sub_agent_configs_model(connection)?;
    migrate_builtin_general_agent_defaults(connection)?;
    migrate_scheduled_tasks_pre_script(connection)?;
    migrate_scheduled_tasks_workflow(connection)?;
    migrate_api_configs_partial_retry_max_chars(connection)?;
    migrate_api_configs_config_json(connection)?;
    migrate_api_configs_sort_order(connection)?;
    migrate_chat_messages_interruption_metadata(connection)?;
    migrate_chat_messages_thinking_stats(connection)?;
    migrate_chat_messages_token_usage(connection)?;
    migrate_chat_messages_retry_metadata(connection)?;
    migrate_chat_messages_tool_corrections(connection)?;
    add_column_if_missing(connection, "chat_messages", "origin", "TEXT NOT NULL DEFAULT 'unknown'")?;
    migrate_chat_messages_cancelled_terminal_cleanup(connection)?;
    purge_assistant_raw_json_blobs(connection)?;
    drop_tables_referencing_sub_agent_configs_legacy(connection)?;
    migrate_project_collections(connection)?;
    migrate_workflow_node_sessions_flow_checkpoint_id(connection)?;
    migrate_project_memories_response_id(connection)?;
    migrate_workspace_directory_path_health(connection)?;
    migrate_userscripts_client_fields(connection)?;
    migrate_userscripts_icon(connection)?;
    migrate_userscripts_source_repo(connection)?;
    migrate_git_worktrees(connection)?;
    migrate_app_logs_conversation_id(connection)?;
    migrate_file_review_annotations(connection)?;
    migrate_team_join_approval(connection)?;
    migrate_team_host_member(connection)?;
    // 模型注册表：旧 system_settings JSON / 自检快照与代码库内联字段迁入模型表
    // （幂等，已迁移时为空操作；表由 create_schema 提前建好）。
    super::services::model_registry::migrate_legacy_model_settings(connection)?;
    super::services::system_settings::migrate_codebase_inline_models_with_connection(connection)?;
    Ok(())
}

/// Schema version that introduced the sub-agent dispatch identity backfill.
const SUB_AGENT_DISPATCH_IDENTITY_VERSION: i64 = 66;

/// One-time backfill of persisted sub-agent dispatch identity (issue #318):
/// tool calls stored before host identity existed could never resolve a
/// rollback boundary, so every turn containing them stayed unrollbackable.
///
/// Must run after `ensure_sub_agent_run_tables` (it reads the durable run,
/// request and rollback-gate tables) and before `user_version` is bumped, so
/// it fires exactly once per upgraded database. The attribution rules live
/// next to the rollback gate in `backfill_sub_agent_dispatch_identity`; they
/// are idempotent, so re-running is a safe no-op.
pub(crate) fn migrate_sub_agent_dispatch_identity(connection: &Connection) -> rusqlite::Result<()> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version >= SUB_AGENT_DISPATCH_IDENTITY_VERSION {
        return Ok(());
    }
    backfill_sub_agent_dispatch_identity(connection)
}

/// Idempotent `ALTER TABLE ... ADD COLUMN`: a no-op when the column already
/// exists (fresh databases get it from `CREATE TABLE`).
fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if !columns.iter().any(|name| name == column) {
        connection.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

/// 团队加入审核：成员表新增设备标识（黑名单依据）与重连令牌，团队表保存
/// 本机（队员）的重连令牌，并新增团队黑名单表。
fn migrate_team_join_approval(connection: &Connection) -> rusqlite::Result<()> {
    add_column_if_missing(
        connection,
        "teams",
        "member_token",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(
        connection,
        "team_members",
        "client_id",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(connection, "team_members", "token", "TEXT NOT NULL DEFAULT ''")?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS team_blocklist (
           id TEXT PRIMARY KEY NOT NULL,
           team_id TEXT NOT NULL,
           client_id TEXT NOT NULL,
           name TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(team_id, client_id)
         );
         CREATE INDEX IF NOT EXISTS idx_team_blocklist_team
           ON team_blocklist(team_id, created_at ASC, id ASC);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_token
           ON team_members(token) WHERE token <> '';",
    )
}

/// 队长也是团队成员（一台设备只代表一个人）：为旧的队长团队补齐成员记录。
///
/// 新建团队时 `create_team` 会直接写入队长成员记录；此迁移只补历史数据，
/// 幂等且不会重复插入。
fn migrate_team_host_member(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO team_members (
            id, team_id, peer_id, name, color, role, online, joined_at, last_seen,
            client_id, token
         )
         SELECT 'tm-' || lower(hex(randomblob(12))), t.team_id, t.self_peer_id,
                t.self_name, t.self_color, 'host', 1, t.created_at, t.updated_at, '', ''
           FROM teams t
          WHERE t.role = 'host' AND t.self_peer_id <> ''
            AND NOT EXISTS (
                SELECT 1 FROM team_members m
                 WHERE m.team_id = t.team_id AND m.peer_id = t.self_peer_id
            )",
        [],
    )?;
    Ok(())
}

/// Additive and idempotent: existing Diff comments and source files are untouched.
fn migrate_file_review_annotations(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS file_review_annotations (
           id TEXT PRIMARY KEY NOT NULL,
           annotation_id TEXT NOT NULL,
           source_key TEXT NOT NULL,
           file_path TEXT NOT NULL,
           anchor_json TEXT NOT NULL CHECK(length(CAST(anchor_json AS BLOB)) <= 32768),
           content TEXT NOT NULL CHECK(length(CAST(content AS BLOB)) BETWEEN 1 AND 8192),
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_file_review_annotations_identity
           ON file_review_annotations(source_key, file_path, annotation_id);
         CREATE INDEX IF NOT EXISTS idx_file_review_annotations_file
           ON file_review_annotations(source_key, file_path, created_at, id);",
    )
}

/// Adds exact conversation ownership to app_logs for reliable per-session diagnostics.
/// Existing rows receive the empty value and remain searchable through ordinary filters.
fn migrate_app_logs_conversation_id(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(app_logs)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if !columns.iter().any(|column| column == "conversation_id") {
        connection.execute(
            "ALTER TABLE app_logs ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_logs_conversation_created
           ON app_logs(conversation_id, created_at DESC, id DESC)",
        [],
    )?;
    Ok(())
}
/// Creates persistent worktree registry and per-conversation bindings. Bindings
/// intentionally do not reference chat_conversations so they survive moving a
/// conversation to the cold archive database and can be used after restore.
fn migrate_git_worktrees(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS git_worktrees (
           worktree_id TEXT PRIMARY KEY NOT NULL,
           directory_id TEXT NOT NULL,
           repository_path TEXT NOT NULL,
           worktree_path TEXT NOT NULL,
           branch_name TEXT,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(directory_id, worktree_path)
         );
         CREATE INDEX IF NOT EXISTS idx_git_worktrees_directory
           ON git_worktrees(directory_id);
         CREATE TABLE IF NOT EXISTS conversation_worktree_bindings (
           conversation_id TEXT PRIMARY KEY NOT NULL,
           worktree_id TEXT NOT NULL,
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_conversation_worktree_bindings_worktree
           ON conversation_worktree_bindings(worktree_id);",
    )
}

/// Adds the client-script columns (`target` / `view_json` / `surface_json` /
/// `scope` / `sandbox`) to `userscripts` for databases created before the
/// desktop-UI userscript engine existed, then (re)creates
/// `idx_userscripts_target`.
///
/// Existing rows are legacy browser userscripts, so the `browser` default is
/// already correct and no backfill is needed. Idempotent: every column is
/// checked against `PRAGMA table_info` first, and fresh databases get all of
/// them from the `CREATE TABLE` statement in `create_schema`.
///
/// The index MUST live here rather than in the `create_schema` batch: on an
/// old database the `userscripts` table already exists and the batch's
/// `CREATE TABLE IF NOT EXISTS` does not add the `target` column, so creating
/// the index there fails with "no such column: target" before this migration
/// has a chance to add it.
fn migrate_userscripts_client_fields(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(userscripts)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    const ADDITIONS: &[(&str, &str)] = &[
        ("target", "TEXT NOT NULL DEFAULT 'browser'"),
        ("view_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("surface_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("scope", "TEXT NOT NULL DEFAULT ''"),
        ("sandbox", "INTEGER NOT NULL DEFAULT 1"),
        ("privacy_json", "TEXT NOT NULL DEFAULT '[]'"),
    ];
    for (name, definition) in ADDITIONS {
        if columns.iter().any(|column| column == name) {
            continue;
        }
        connection.execute(
            &format!("ALTER TABLE userscripts ADD COLUMN {name} {definition}"),
            [],
        )?;
    }

    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_userscripts_target
           ON userscripts(target, enabled)",
        [],
    )?;
    Ok(())
}

/// Adds the `icon` column (`@icon` / `@iconURL` metadata, shown in the script
/// list) to `userscripts`. Idempotent: checked against `PRAGMA table_info`
/// first; fresh databases get it from the `CREATE TABLE` statement.
fn migrate_userscripts_icon(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(userscripts)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if columns.iter().any(|column| column == "icon") {
        return Ok(());
    }
    connection.execute(
        "ALTER TABLE userscripts ADD COLUMN icon TEXT NOT NULL DEFAULT ''",
        [],
    )?;
    Ok(())
}

/// Adds the `source_repo` column (the GitHub repository a script was installed
/// from through the plugin market or the community channel) to `userscripts`.
///
/// Existing rows keep the empty value — locally authored scripts have no
/// upstream repository. Idempotent: checked against `PRAGMA table_info` first;
/// fresh databases get it from the `CREATE TABLE` statement.
fn migrate_userscripts_source_repo(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(userscripts)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if columns.iter().any(|column| column == "source_repo") {
        return Ok(());
    }
    connection.execute(
        "ALTER TABLE userscripts ADD COLUMN source_repo TEXT NOT NULL DEFAULT ''",
        [],
    )?;
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


/// Adds the `sort_order` column to `api_configs` and backfills it for databases
/// created before API profiles could be reordered.
///
/// The legacy list was ordered "active first, then display name", so the
/// backfill walks exactly that legacy order and writes 0..n-1 — upgrading users
/// keep the list they are used to until they reorder it themselves.
///
/// Idempotent: a database that already carries a user-defined order (any
/// non-zero `sort_order`) is left untouched, so re-running never clobbers it.
/// Fresh databases get the column from the `CREATE TABLE` statement in
/// `create_schema`.
fn migrate_api_configs_sort_order(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(api_configs)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if !columns.iter().any(|column| column == "sort_order") {
        connection.execute(
            "ALTER TABLE api_configs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // 单行库（全新数据库的默认档案）无需回填；已存在非 0 排序号说明用户已自定义顺序。
    let needs_backfill: bool = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM api_configs) > 1
            AND NOT EXISTS (SELECT 1 FROM api_configs WHERE sort_order <> 0)",
        [],
        |row| row.get(0),
    )?;
    if !needs_backfill {
        return Ok(());
    }

    let mut statement = connection.prepare(
        "SELECT profile_name
           FROM api_configs
          ORDER BY is_active DESC, display_name COLLATE NOCASE ASC, profile_name ASC",
    )?;
    let profiles: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    for (index, profile_name) in profiles.iter().enumerate() {
        connection.execute(
            "UPDATE api_configs SET sort_order = ?1 WHERE profile_name = ?2",
            params![index as i64, profile_name],
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

/// Adds the per-request token usage columns to `chat_messages` for databases
/// created before rollback-aware token snapshots existed. Each completed
/// assistant row records the usage of its own API request, so truncating a
/// conversation can restore the conversation-level snapshot from the latest
/// remaining assistant row instead of zeroing it.
///
/// Idempotent: each column is checked independently (fresh databases get the
/// columns from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_messages_token_usage(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_messages)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (name, definition) in [
        ("input_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("output_tokens", "INTEGER NOT NULL DEFAULT 0"),
        (
            "cache_creation_input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        ("cache_read_input_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(
                &format!("ALTER TABLE chat_messages ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }

    Ok(())
}

/// Adds the automatic-retry metadata columns to `chat_messages` for databases
/// created before the retry-exhausted notice became persistent.
///
/// A response that ends with no content/thinking/tool calls after the empty
/// response retry budget was exhausted records how many retries were attempted
/// and the upstream error of the last one, so the chat UI can still explain the
/// failure (「重试已耗尽 (N)」+ 错误详情) after a reload. Existing rows keep
/// `0` / `''` and therefore render exactly as before.
///
/// Idempotent: each column is checked independently so partially migrated and
/// repeatedly migrated databases are both safe (fresh databases get the columns
/// from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_messages_retry_metadata(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_messages)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (name, definition) in [
        ("retry_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("retry_error", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(
                &format!("ALTER TABLE chat_messages ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }

    Ok(())
}

/// Adds the tool-correction state column to `chat_messages` for databases
/// created before the correction tree became persistent.
///
/// The column stores a JSON object keyed by tool call id; each value is the
/// serialized `ToolCorrectionState` of that call. It only feeds the history
/// replay of the correction tree (audit), never the provider payload. Existing
/// rows keep `{}` and therefore render exactly as before.
///
/// Idempotent: the column is checked before the ALTER (fresh databases get the
/// column from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_messages_tool_corrections(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_messages)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "tool_corrections_json") {
        connection.execute(
            "ALTER TABLE chat_messages ADD COLUMN tool_corrections_json TEXT NOT NULL DEFAULT '{}'",
            [],
        )?;
    }

    Ok(())
}

/// 清理历史误标：用户主动取消（`status='cancelled'`）的回复曾被补上
/// `empty_response` / `retry_exhausted` 终态，重载后前端据此渲染「重试已耗尽」
/// 告警。取消是用户意图而非上游返回空（见 `api/retry.rs` 的
/// `resolve_empty_response_terminal`），这里把该组合清空。
///
/// 幂等：只命中「cancelled 且仍带中断原因」的行；修复后的版本不再产生这种组合，
/// 重复执行是安全 no-op。重试元数据（`retry_attempts` / `retry_error`）是
/// 「取消前确实重试过」的真实事实，保持原样。
fn migrate_chat_messages_cancelled_terminal_cleanup(
    connection: &Connection,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE chat_messages
            SET interruption_reason = '',
                recovery_outcome = ''
          WHERE status IN ('cancelled', 'canceled')
            AND interruption_reason <> ''",
        [],
    )?;
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
            SET is_active = 0
          WHERE prompt_id LIKE 'claude-code:%:command:%'
             OR prompt_id LIKE 'opencode:%:command:%'
             OR prompt_id LIKE 'opencode:%:agent:%'",
        [],
    )?;

    Ok(())
}

/// Adds the per-conversation mode override columns to `chat_conversations`
/// for databases created by older app versions.
///
/// The mode flags are 0/1 booleans and the token budget is an integer.
/// Existing rows keep NULL flags; reads treat NULL as disabled
/// (synonymous with 0) so legacy conversations open with all modes off.
///
/// Idempotent: no-op when the columns are already present (fresh databases
/// get them from the `CREATE TABLE` statement in `create_schema`).
fn migrate_chat_conversations_modes(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let missing: Vec<(&str, &str)> = [
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
        ("run_ttft_sum_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("run_request_count", "INTEGER NOT NULL DEFAULT 0"),
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

/// 刷新内置通用子代理（agent_general）的默认配置：系统提示词与工具清单
/// （2026-09-24 刷新提示词；2026-10-05 追加工具清单刷新）。
///
/// 内置行由 `seed_default_sub_agent_configs` 的 `INSERT OR IGNORE` 写入，
/// 只对全新数据库生效——老库里系统提示词曾是 grep-first（与 LSP 语义路由
/// 冲突），`tools_json` 可能残留历史显式清单（违反「全局子代理只能
/// `[\"*\"]` / `[]`」的约定，且会随内置 MCP 工具增减而腐烂）。内置行不允许
/// 用户编辑（config 域拒绝修改/删除 `agent_general`），可安全刷新为当前
/// 默认值；`<>` 守卫保证幂等，全新数据库上行为 0 行更新，属正常空操作。
fn migrate_builtin_general_agent_defaults(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE sub_agent_configs
            SET system_prompt = ?1,
                tools_json = ?2,
                updated_at = datetime('now', 'localtime')
          WHERE agent_id = 'agent_general'
            AND builtin = 1
            AND project_id = ''
            AND (system_prompt <> ?1 OR tools_json <> ?2)",
        [
            crate::storage::services::sub_agent_configs::DEFAULT_GENERAL_AGENT_SYSTEM_PROMPT,
            crate::storage::services::sub_agent_configs::DEFAULT_GENERAL_AGENT_TOOLS_JSON,
        ],
    )?;
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

/// 定时任务工作流：定义与运行状态两列（幂等）。
fn migrate_scheduled_tasks_workflow(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(scheduled_tasks)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for column in ["workflow_json", "workflow_run_json"] {
        if !columns.iter().any(|existing| existing == column) {
            connection.execute(
                &format!(
                    "ALTER TABLE scheduled_tasks ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                ),
                [],
            )?;
        }
    }

    Ok(())
}

/// Historically every assistant response stored `serde_json::to_string(raw_events)`
/// — the complete streaming chunk array — into `chat_messages.raw_json`. Each
/// token produced a chunk repeating `id` / `model` / `system_fingerprint`,
/// so a single long response could balloon to several MB, and the table
/// dominated the database (>450 MB for ~3000 rows in practice).
///
/// Tool-role metadata still carries call identities, and assistant objects now
/// carry persisted task-end references (`__snowTaskHistory`). Only the legacy
/// streaming array format is disposable; object metadata must survive regardless
/// of its size. Invalid JSON is preserved rather than guessed to be a legacy blob.
///
/// Idempotent: once cleared the rows match `{}` (or are empty) and the
/// `WHERE` clause no longer matches them, so re-running is a no-op.
fn purge_assistant_raw_json_blobs(connection: &Connection) -> rusqlite::Result<()> {
    // The size threshold limits cleanup to large legacy streaming arrays.
    // CASE guards json_type from malformed JSON without relying on AND order.
    let purged = connection.execute(
        "UPDATE chat_messages
            SET raw_json = '{}'
          WHERE role = 'assistant'
            AND length(raw_json) > 2048
            AND CASE WHEN json_valid(raw_json)
                     THEN json_type(raw_json) = 'array'
                     ELSE 0 END",
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
/// `collection_members`) on databases created by older app versions, and adds
/// the `color` column (unified dot color of a linked project group) plus the
/// `linked` member flag (per-member opt-out from the linked group while the
/// project stays inside the collection).
///
/// Collections are pure metadata (name + member `directory_id`s) and do not
/// exist on disk, so a fresh install gets them from `create_schema` and this
/// migration only matters for existing databases. Idempotent: `CREATE TABLE
/// IF NOT EXISTS` plus a `PRAGMA table_info` guard make re-runs a safe no-op.
/// Pre-existing collections (created before colors existed) are backfilled
/// from the shared palette so their dots stay stable across restarts.
fn migrate_project_collections(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_collections (
           id TEXT PRIMARY KEY NOT NULL,
           collection_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           color TEXT NOT NULL DEFAULT '',
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
CREATE TABLE IF NOT EXISTS collection_members (
           id TEXT PRIMARY KEY NOT NULL,
           collection_id TEXT NOT NULL,
           directory_id TEXT NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 0,
           linked INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           UNIQUE(collection_id, directory_id)
         );
          CREATE INDEX IF NOT EXISTS idx_collection_members_collection
            ON collection_members(collection_id, sort_order);",
    )?;

    let mut statement = connection.prepare("PRAGMA table_info(collection_members)")?;
    let member_columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if !member_columns.iter().any(|column| column == "linked") {
        connection.execute(
            "ALTER TABLE collection_members ADD COLUMN linked INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }

    let mut statement = connection.prepare("PRAGMA table_info(project_collections)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    if !columns.iter().any(|column| column == "color") {
        connection.execute(
            "ALTER TABLE project_collections ADD COLUMN color TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    let colorless: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT collection_id FROM project_collections WHERE color = '' ORDER BY sort_order ASC, id ASC")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (index, collection_id) in colorless.iter().enumerate() {
        connection.execute(
            "UPDATE project_collections SET color = ?1 WHERE collection_id = ?2",
            params![collection_color_for_index(index), collection_id],
        )?;
    }

    Ok(())
}

/// Adds the `response_id` column to `project_memories` for databases created
/// by older app versions.
///
/// The column anchors each memory to the assistant response whose tool call
/// saved it (same pattern as `todo_items.response_id`), so a rollback can
/// list and clean exactly the memories written during the rolled-back turns.
/// Idempotent: fresh databases get the column from `CREATE TABLE`.
fn migrate_project_memories_response_id(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(project_memories)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "response_id") {
        connection.execute(
            "ALTER TABLE project_memories ADD COLUMN response_id TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

fn migrate_workspace_directory_path_health(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(workspace_directories)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let additions: [(&str, &str); 4] = [
        ("fs_identity", "TEXT NOT NULL DEFAULT ''"),
        ("path_state", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("path_checked_at", "TEXT"),
        ("last_known_path", "TEXT NOT NULL DEFAULT ''"),
    ];

    for (column, definition) in additions {
        if !columns.iter().any(|existing| existing == column) {
            connection.execute(
                &format!("ALTER TABLE workspace_directories ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }

    connection.execute(
        "UPDATE workspace_directories
            SET last_known_path = path
          WHERE last_known_path = ''
            AND path <> ''",
        [],
    )?;

    Ok(())
}