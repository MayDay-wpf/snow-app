use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::models::*;
use super::services;

pub fn list_custom_commands(project_id: Option<String>) -> Result<Vec<CustomCommandRecord>> {
    let database_path = ensure_database_file()?;
    services::custom_commands::list_custom_commands(&database_path, project_id)
}

pub fn upsert_custom_command(item: CustomCommandInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::custom_commands::upsert_custom_command(&database_path, &item)
}

pub fn delete_custom_command(command_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::custom_commands::delete_custom_command(&database_path, &command_id)
}
