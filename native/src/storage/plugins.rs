use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::models::*;
use super::services;

pub fn list_plugins() -> Result<Vec<PluginRecord>> {
    let database_path = ensure_database_file()?;
    services::plugins::list_plugins(&database_path)
}

pub fn upsert_plugins(items: Vec<PluginInput>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugins::upsert_plugins(&database_path, &items)
}

pub fn set_plugin_state(plugin_id: String, state: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugins::set_plugin_state(&database_path, &plugin_id, &state)
}

pub fn delete_plugin(plugin_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugins::delete_plugin(&database_path, &plugin_id)
}

pub fn list_plugin_marketplaces() -> Result<Vec<PluginMarketplaceRecord>> {
    let database_path = ensure_database_file()?;
    services::plugin_marketplaces::list_plugin_marketplaces(&database_path)
}

pub fn upsert_plugin_marketplace(item: PluginMarketplaceInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugin_marketplaces::upsert_plugin_marketplace(&database_path, &item)
}

pub fn delete_plugin_marketplace(marketplace_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::plugin_marketplaces::delete_plugin_marketplace(&database_path, &marketplace_id)
}
