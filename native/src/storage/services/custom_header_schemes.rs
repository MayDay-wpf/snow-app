use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{CustomHeaderSchemeInput, CustomHeaderSchemeRecord};

pub fn list_custom_header_schemes(database_path: &Path) -> Result<Vec<CustomHeaderSchemeRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_custom_header_schemes(&connection))
        .map_err(|error| {
            database::database_error(database_path, "list custom header schemes", error)
        })
}

pub fn upsert_custom_header_scheme(
    database_path: &Path,
    item: &CustomHeaderSchemeInput,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;

            if item.is_active {
                transaction.execute(
                    "UPDATE custom_header_schemes
                        SET is_active = 0,
                            updated_at = datetime('now', 'localtime')
                      WHERE is_active = 1",
                    [],
                )?;
            }

            upsert_custom_header_scheme_with_connection(&transaction, item)?;
            transaction.commit()
        })
        .map_err(|error| {
            database::database_error(database_path, "upsert custom header scheme", error)
        })
}

pub fn delete_custom_header_scheme(database_path: &Path, scheme_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM custom_header_schemes WHERE scheme_id = ?1",
                [scheme_id],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "delete custom header scheme", error)
        })
}

fn query_custom_header_schemes(
    connection: &Connection,
) -> rusqlite::Result<Vec<CustomHeaderSchemeRecord>> {
    let mut statement = connection.prepare(
        "SELECT id,
                scheme_id,
                name,
                headers_json,
                is_active,
                sort_order,
                updated_at
           FROM custom_header_schemes
          ORDER BY sort_order ASC, id ASC",
    )?;

    let rows = statement.query_map([], |row| {
        let is_active: i64 = row.get(4)?;

        Ok(CustomHeaderSchemeRecord {
            id: row.get(0)?,
            scheme_id: row.get(1)?,
            name: row.get(2)?,
            headers_json: row.get(3)?,
            is_active: is_active != 0,
            sort_order: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;

    rows.collect()
}

fn upsert_custom_header_scheme_with_connection(
    connection: &Connection,
    item: &CustomHeaderSchemeInput,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO custom_header_schemes (
           id,
           scheme_id,
           name,
           headers_json,
           is_active,
           sort_order,
           created_at,
           updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, datetime('now', 'localtime'), datetime('now', 'localtime')
         )
         ON CONFLICT(scheme_id) DO UPDATE SET
           name = excluded.name,
           headers_json = excluded.headers_json,
           is_active = excluded.is_active,
           sort_order = excluded.sort_order,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            item.scheme_id,
            item.name,
            item.headers_json,
            item.is_active as i32,
            item.sort_order,
        ],
    )?;

    Ok(())
}
