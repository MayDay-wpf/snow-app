use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::services;

pub fn write_app_log(input: services::app_logs::AppLogInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::app_logs::insert_app_log(&database_path, &input)
}

pub fn list_app_logs(
    level: String,
    module: String,
    since: String,
    until: String,
    limit: i32,
    offset: i32,
) -> Result<services::app_logs::AppLogPage> {
    let database_path = ensure_database_file()?;
    services::app_logs::list_app_logs(
        &database_path,
        &level,
        &module,
        &since,
        &until,
        limit,
        offset,
    )
}

pub fn clear_app_logs() -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::app_logs::clear_app_logs(&database_path)
}
