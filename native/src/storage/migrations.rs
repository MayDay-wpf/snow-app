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

use rusqlite::Connection;

/// Tables whose legacy schema used `INTEGER PRIMARY KEY`. When detected, the
/// table is dropped so `CREATE TABLE` can recreate it with a `TEXT PRIMARY KEY`
/// (snowflake ID) column.
///
/// This list is frozen — it only covers tables that existed before the
/// snowflake-ID migration. Tables added after that migration always use
/// `TEXT PRIMARY KEY` from creation and never need to appear here.
const LEGACY_INTEGER_PRIMARY_KEY_TABLES: &[&str] = &[
    "system_settings",
    "api_configs",
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
    reset_legacy_integer_primary_key_tables(connection)
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
    migrate_sub_agent_configs_project_id(connection)?;
    migrate_sub_agent_configs_model(connection)?;
    purge_assistant_raw_json_blobs(connection)?;
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

/// Clears the `raw_json` column for assistant messages that still hold the full
/// SSE chunk array persisted by older app versions.
///
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

#[cfg(test)]
mod tests {
    use super::{migrate_sub_agent_configs_model, migrate_sub_agent_configs_project_id};
    use rusqlite::{params, Connection};

    fn create_legacy_sub_agent_configs(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE sub_agent_configs (
                   id TEXT PRIMARY KEY NOT NULL,
                   agent_id TEXT NOT NULL UNIQUE,
                   name TEXT NOT NULL,
                   description TEXT NOT NULL DEFAULT '',
                   system_prompt TEXT NOT NULL DEFAULT '',
                   tools_json TEXT NOT NULL DEFAULT '[]',
                   config_profile TEXT NOT NULL DEFAULT '',
                   builtin INTEGER NOT NULL DEFAULT 0,
                   sort_order INTEGER NOT NULL DEFAULT 0,
                   source TEXT NOT NULL DEFAULT 'manual',
                   created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                 );",
            )
            .expect("create legacy sub-agent table");
    }

    fn create_current_sub_agent_configs(connection: &Connection, include_model: bool) {
        let model_column = if include_model {
            "model TEXT NOT NULL DEFAULT '',"
        } else {
            ""
        };
        connection
            .execute_batch(&format!(
                "CREATE TABLE sub_agent_configs (
                   id TEXT PRIMARY KEY NOT NULL,
                   agent_id TEXT NOT NULL,
                   name TEXT NOT NULL,
                   description TEXT NOT NULL DEFAULT '',
                   system_prompt TEXT NOT NULL DEFAULT '',
                   tools_json TEXT NOT NULL DEFAULT '[]',
                   config_profile TEXT NOT NULL DEFAULT '',
                   {model_column}
                   builtin INTEGER NOT NULL DEFAULT 0,
                   sort_order INTEGER NOT NULL DEFAULT 0,
                   source TEXT NOT NULL DEFAULT 'manual',
                   project_id TEXT NOT NULL DEFAULT '',
                   created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   UNIQUE(agent_id, project_id)
                 );"
            ))
            .expect("create current sub-agent table");
    }

    #[test]
    fn legacy_sub_agent_migration_preserves_profile_and_adds_empty_snapshot_fields() {
        let connection = Connection::open_in_memory().expect("open database");
        create_legacy_sub_agent_configs(&connection);
        connection
            .execute(
                "INSERT INTO sub_agent_configs (
                   id, agent_id, name, config_profile
                 ) VALUES (?1, ?2, ?3, ?4)",
                params!["1", "legacy-agent", "Legacy", "fixed-profile"],
            )
            .expect("insert legacy agent");

        migrate_sub_agent_configs_project_id(&connection).expect("migrate project scope");
        migrate_sub_agent_configs_model(&connection).expect("migrate model");

        let values: (String, String, String) = connection
            .query_row(
                "SELECT config_profile, project_id, model
                   FROM sub_agent_configs
                  WHERE agent_id = 'legacy-agent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read migrated agent");
        assert_eq!(
            values,
            ("fixed-profile".into(), String::new(), String::new())
        );
    }

    #[test]
    fn model_migration_is_idempotent_and_adds_only_one_column() {
        let connection = Connection::open_in_memory().expect("open database");
        create_current_sub_agent_configs(&connection, false);

        migrate_sub_agent_configs_model(&connection).expect("first model migration");
        migrate_sub_agent_configs_model(&connection).expect("second model migration");

        let model_columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sub_agent_configs') WHERE name = 'model'",
                [],
                |row| row.get(0),
            )
            .expect("count model columns");
        assert_eq!(model_columns, 1);
    }

    #[test]
    fn model_migration_preserves_existing_value_and_default() {
        let connection = Connection::open_in_memory().expect("open database");
        create_current_sub_agent_configs(&connection, true);
        connection
            .execute(
                "INSERT INTO sub_agent_configs (id, agent_id, name, model)
                 VALUES ('1', 'custom', 'Custom', 'custom-model')",
                [],
            )
            .expect("insert custom model");
        connection
            .execute(
                "INSERT INTO sub_agent_configs (id, agent_id, name)
                 VALUES ('2', 'default', 'Default')",
                [],
            )
            .expect("insert default model");

        migrate_sub_agent_configs_model(&connection).expect("migrate existing model column");

        let custom: String = connection
            .query_row(
                "SELECT model FROM sub_agent_configs WHERE agent_id = 'custom'",
                [],
                |row| row.get(0),
            )
            .expect("read custom model");
        let default_model: String = connection
            .query_row(
                "SELECT model FROM sub_agent_configs WHERE agent_id = 'default'",
                [],
                |row| row.get(0),
            )
            .expect("read default model");
        assert_eq!(custom, "custom-model");
        assert!(default_model.is_empty());
    }
}
