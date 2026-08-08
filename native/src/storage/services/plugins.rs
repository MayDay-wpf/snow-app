use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::super::database;
use super::super::{
    PluginComponentInput, PluginComponentRecord, PluginInput, PluginRecord,
    PluginRuntimeDeclaration,
};

pub fn list_plugins(database_path: &Path) -> Result<Vec<PluginRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_plugins(&connection))
        .map_err(|error| database::database_error(database_path, "list plugins", error))
}

pub fn upsert_plugins(database_path: &Path, items: &[PluginInput]) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            for item in items {
                upsert_plugin(&transaction, item)?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "upsert plugins", error))
}

pub fn set_plugin_state(database_path: &Path, plugin_id: &str, state: &str) -> Result<()> {
    if !matches!(
        state,
        "enabled" | "disabled" | "update-available" | "broken"
    ) {
        return Err(Error::from_reason("Plugin state is invalid"));
    }
    database::open_connection(database_path)
        .and_then(|connection| {
            let changed = connection.execute(
                "UPDATE plugins
                    SET state = ?2,
                        desired_state = CASE
                            WHEN ?2 IN ('enabled', 'disabled') THEN ?2
                            ELSE desired_state
                        END,
                        updated_at = datetime('now', 'localtime')
                  WHERE plugin_id = ?1",
                params![plugin_id, state],
            )?;
            if changed == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "set plugin state", error))
}

pub fn delete_plugin(database_path: &Path, plugin_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let changed =
                connection.execute("DELETE FROM plugins WHERE plugin_id = ?1", [plugin_id])?;
            if changed == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete plugin", error))
}

pub(crate) fn upsert_plugin(
    transaction: &Transaction<'_>,
    item: &PluginInput,
) -> rusqlite::Result<()> {
    validate_plugin(item).map_err(invalid_input)?;
    transaction.execute(
        "INSERT INTO plugins (
           plugin_id, name, version, provider, source_path, manifest_path, scope, project_id,
           state, desired_state, capabilities_json, runtime_json, content_hash, imported_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12,
           datetime('now', 'localtime'), datetime('now', 'localtime')
         ) ON CONFLICT(plugin_id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           provider = excluded.provider,
           source_path = excluded.source_path,
           manifest_path = excluded.manifest_path,
           scope = excluded.scope,
           project_id = excluded.project_id,
           state = excluded.state,
           desired_state = CASE
             WHEN excluded.state IN ('enabled', 'disabled') THEN excluded.state
             ELSE plugins.desired_state
           END,
           capabilities_json = excluded.capabilities_json,
           runtime_json = excluded.runtime_json,
           content_hash = excluded.content_hash,
           updated_at = datetime('now', 'localtime')",
        params![
            item.plugin_id,
            item.name,
            item.version,
            item.provider,
            item.source_path,
            item.manifest_path,
            item.scope,
            item.project_id,
            item.state,
            serde_json::to_string(&item.capabilities).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&item.runtime).unwrap_or_else(|_| "null".to_string()),
            item.content_hash,
        ],
    )?;
    transaction.execute(
        "DELETE FROM plugin_components WHERE plugin_id = ?1",
        [&item.plugin_id],
    )?;
    for component in &item.components {
        insert_component(transaction, &item.plugin_id, component)?;
    }
    Ok(())
}

fn validate_plugin(item: &PluginInput) -> std::result::Result<(), String> {
    if item.plugin_id.trim().is_empty()
        || item.name.trim().is_empty()
        || item.provider.trim().is_empty()
        || item.source_path.trim().is_empty()
        || item.manifest_path.trim().is_empty()
        || item.content_hash.trim().is_empty()
    {
        return Err("Plugin identity and source fields are required".to_string());
    }
    if item.scope != "global" && item.scope != "project" {
        return Err("Plugin scope must be global or project".to_string());
    }
    if !matches!(
        item.state.as_str(),
        "enabled" | "disabled" | "update-available" | "broken"
    ) {
        return Err("Plugin state is invalid".to_string());
    }
    if let Some(runtime) = &item.runtime {
        if runtime.entry.trim().is_empty()
            || !(1_000..=300_000).contains(&runtime.timeout_ms)
            || runtime.permissions.iter().any(|permission| {
                !matches!(permission.as_str(), "storage" | "network" | "child-process")
            })
        {
            return Err("Plugin runtime declaration is invalid".to_string());
        }
    }
    Ok(())
}

fn insert_component(
    transaction: &Transaction<'_>,
    plugin_id: &str,
    component: &PluginComponentInput,
) -> rusqlite::Result<()> {
    if component.component_id.trim().is_empty()
        || component.component_type.trim().is_empty()
        || component.logical_id.trim().is_empty()
        || component.origin_path.trim().is_empty()
        || component.content_hash.trim().is_empty()
        || !matches!(component.status.as_str(), "supported" | "unsupported")
    {
        return Err(invalid_input(
            "Plugin component is incomplete or invalid".to_string(),
        ));
    }
    transaction.execute(
        "INSERT INTO plugin_components (
           component_id, plugin_id, component_type, logical_id, target_id, target_path,
           origin_path, content_hash, status, unsupported_reason, sort_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            component.component_id,
            plugin_id,
            component.component_type,
            component.logical_id,
            component.target_id,
            component.target_path,
            component.origin_path,
            component.content_hash,
            component.status,
            component.unsupported_reason,
            component.sort_order,
        ],
    )?;
    Ok(())
}

fn invalid_input(message: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        message,
    )))
}

fn query_plugins(connection: &Connection) -> rusqlite::Result<Vec<PluginRecord>> {
    let mut statement = connection
        .prepare("SELECT plugin_id FROM plugins ORDER BY updated_at DESC, plugin_id ASC")?;
    let plugin_ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    plugin_ids
        .iter()
        .map(|plugin_id| {
            query_plugin(connection, plugin_id)
                .and_then(|record| record.ok_or(rusqlite::Error::QueryReturnedNoRows))
        })
        .collect()
}

fn query_plugin(
    connection: &Connection,
    plugin_id: &str,
) -> rusqlite::Result<Option<PluginRecord>> {
    let row = connection
        .query_row(
            "SELECT plugin_id, name, version, provider, source_path, manifest_path, scope, project_id,
                    state, desired_state, capabilities_json, runtime_json, content_hash, imported_at, updated_at
               FROM plugins WHERE plugin_id = ?1",
            [plugin_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?, row.get::<_, String>(13)?, row.get::<_, String>(14)?,
                ))
            },
        )
        .optional()?;
    let Some((
        plugin_id,
        name,
        version,
        provider,
        source_path,
        manifest_path,
        scope,
        project_id,
        state,
        desired_state,
        capabilities_json,
        runtime_json,
        content_hash,
        imported_at,
        updated_at,
    )) = row
    else {
        return Ok(None);
    };
    let capabilities = serde_json::from_str::<Vec<String>>(&capabilities_json).unwrap_or_default();
    let runtime =
        serde_json::from_str::<Option<PluginRuntimeDeclaration>>(&runtime_json).unwrap_or_default();
    let mut statement = connection.prepare(
        "SELECT component_id, component_type, logical_id, target_id, target_path, origin_path,
                content_hash, status, unsupported_reason, sort_order
           FROM plugin_components WHERE plugin_id = ?1 ORDER BY sort_order ASC, component_id ASC",
    )?;
    let components = statement
        .query_map([&plugin_id], |row| {
            Ok(PluginComponentRecord {
                component_id: row.get(0)?,
                plugin_id: plugin_id.clone(),
                component_type: row.get(1)?,
                logical_id: row.get(2)?,
                target_id: row.get(3)?,
                target_path: row.get(4)?,
                origin_path: row.get(5)?,
                content_hash: row.get(6)?,
                status: row.get(7)?,
                unsupported_reason: row.get(8)?,
                sort_order: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(PluginRecord {
        plugin_id,
        name,
        version,
        provider,
        source_path,
        manifest_path,
        scope,
        project_id,
        state,
        desired_state,
        capabilities,
        runtime,
        content_hash,
        imported_at,
        updated_at,
        components,
    }))
}
