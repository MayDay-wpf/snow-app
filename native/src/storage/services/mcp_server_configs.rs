use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{McpServerConfigInput, McpServerConfigRecord};

pub fn list_mcp_server_configs(database_path: &Path) -> Result<Vec<McpServerConfigRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_mcp_server_configs(&connection))
        .map_err(|error| database::database_error(database_path, "list MCP server configs", error))
}

pub fn upsert_mcp_server_config(database_path: &Path, item: &McpServerConfigInput) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| upsert_mcp_server_config_with_connection(&connection, item))
        .map_err(|error| database::database_error(database_path, "upsert MCP server config", error))
}

pub fn delete_mcp_server_config(database_path: &Path, server_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM mcp_server_configs WHERE server_id = ?1",
                [server_id],
            )?;
            super::import_resources::delete_mcp_tracking_for_target(
                &transaction,
                "global",
                None,
                server_id,
            )?;
            transaction.commit()?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete MCP server config", error))
}

pub(crate) fn query_mcp_server_configs(
    connection: &Connection,
) -> rusqlite::Result<Vec<McpServerConfigRecord>> {
    let mut statement = connection.prepare(
        "SELECT id,
                server_id,
                name,
                transport_type,
                url,
                command,
                args_json,
                env_json,
                headers_json,
                enabled,
                timeout_ms,
                sort_order,
                source,
                updated_at
           FROM mcp_server_configs
          ORDER BY sort_order ASC, id ASC",
    )?;

    let rows = statement.query_map([], |row| {
        let enabled: i64 = row.get(9)?;

        Ok(McpServerConfigRecord {
            id: row.get(0)?,
            server_id: row.get(1)?,
            name: row.get(2)?,
            transport_type: row.get(3)?,
            url: row.get(4)?,
            command: row.get(5)?,
            args_json: row.get(6)?,
            env_json: row.get(7)?,
            headers_json: row.get(8)?,
            enabled: enabled != 0,
            timeout_ms: row.get(10)?,
            sort_order: row.get(11)?,
            source: row.get(12)?,
            updated_at: row.get(13)?,
        })
    })?;

    rows.collect()
}

pub(crate) fn upsert_mcp_server_config_with_connection(
    connection: &Connection,
    item: &McpServerConfigInput,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO mcp_server_configs (
           id,
           server_id,
           name,
           transport_type,
           url,
           command,
           args_json,
           env_json,
           headers_json,
           enabled,
           timeout_ms,
           sort_order,
           source,
           created_at,
           updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now', 'localtime'), datetime('now', 'localtime')
         )
         ON CONFLICT(server_id) DO UPDATE SET
           name = excluded.name,
           transport_type = excluded.transport_type,
           url = excluded.url,
           command = excluded.command,
           args_json = excluded.args_json,
           env_json = excluded.env_json,
           headers_json = excluded.headers_json,
           enabled = excluded.enabled,
           timeout_ms = excluded.timeout_ms,
           sort_order = excluded.sort_order,
           source = excluded.source,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            item.server_id,
            item.name,
            item.transport_type,
            item.url,
            item.command,
            item.args_json,
            item.env_json,
            item.headers_json,
            item.enabled as i32,
            item.timeout_ms,
            item.sort_order,
            item.source,
        ],
    )?;

    Ok(())
}
