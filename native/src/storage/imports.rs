use napi::bindgen_prelude::*;

use super::database;
use super::ensure_database_file;
use super::models::*;
use super::services;

pub fn list_import_resources() -> Result<Vec<ImportResourceRecord>> {
    let database_path = ensure_database_file()?;
    services::import_resources::list_import_resources(&database_path)
}

pub fn upsert_import_resources(items: Vec<ImportResourceInput>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::import_resources::upsert_import_resources(&database_path, &items)
}

pub fn commit_import_transaction(input: ImportDatabaseTransactionInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    commit_import_transaction_at_path(&database_path, input)
}

fn commit_import_transaction_at_path(
    database_path: &std::path::Path,
    input: ImportDatabaseTransactionInput,
) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            for item in &input.mcp_servers {
                services::mcp_server_configs::upsert_mcp_server_config_with_connection(
                    &transaction,
                    item,
                )?;
            }
            for item in &input.project_mcp_servers {
                services::project_mcp_server_configs::upsert_project_mcp_server_config_with_connection(
                    &transaction,
                    &item.project_id,
                    &item.input,
                )?;
            }
            for item in &input.system_prompts {
                services::system_prompts::upsert_system_prompt_with_connection(&transaction, item)?;
            }
            for item in &input.plugins {
                services::plugins::upsert_plugin(&transaction, item)?;
            }
            for item in &input.import_resources {
                services::import_resources::upsert_resource(&transaction, item)?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "commit import transaction", error))
}

pub fn release_import_resource(input: ImportResourceReleaseInput) -> Result<ImportResourceRelease> {
    let database_path = ensure_database_file()?;
    services::import_resources::release_import_resource(&database_path, &input)
}
