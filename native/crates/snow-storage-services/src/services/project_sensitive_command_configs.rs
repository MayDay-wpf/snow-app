use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use super::super::database;
use super::super::{
    ProjectSensitiveCommandConfigInput, ProjectSensitiveCommandConfigRecord,
    SensitiveCommandConfigRecord,
};
use super::{sensitive_command_configs, system_settings};

const PROJECT_SENSITIVE_COMMAND_SETTING_NAME: &str = "Project sensitive command scope";
const PROJECT_SENSITIVE_COMMAND_SETTING_CODE_PREFIX: &str = "project_sensitive_command_scope_";
const PROJECT_SENSITIVE_COMMAND_SOURCE: &str = "project";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ProjectSensitiveCommandSettings {
    project_id: String,
    global_enabled_overrides: BTreeMap<String, bool>,
    custom_commands: Vec<ProjectSensitiveCommandConfig>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ProjectSensitiveCommandConfig {
    command_id: String,
    pattern: String,
    description: String,
    enabled: bool,
    sort_order: i32,
}

pub fn list_project_sensitive_command_configs(
    database_path: &Path,
    project_id: &str,
) -> Result<Vec<ProjectSensitiveCommandConfigRecord>> {
    let global_commands = sensitive_command_configs::list_sensitive_command_configs(database_path)?;
    let settings = get_project_sensitive_command_settings(database_path, project_id)?;

    Ok(merge_project_sensitive_command_configs(
        &global_commands,
        &settings,
    ))
}

pub fn set_project_sensitive_command_enabled(
    database_path: &Path,
    project_id: &str,
    command_id: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_command_id = normalize_required_value(command_id, "Sensitive command id")?;
    let global_commands = sensitive_command_configs::list_sensitive_command_configs(database_path)?;
    let mut settings = get_project_sensitive_command_settings(database_path, project_id)?;

    if let Some(global_command) = global_commands
        .iter()
        .find(|command| command.command_id == normalized_command_id)
    {
        if enabled == global_command.enabled {
            settings
                .global_enabled_overrides
                .remove(&normalized_command_id);
        } else {
            settings
                .global_enabled_overrides
                .insert(normalized_command_id, enabled);
        }
        return write_project_sensitive_command_settings(database_path, &settings);
    }

    let Some(command) = settings
        .custom_commands
        .iter_mut()
        .find(|command| command.command_id == normalized_command_id)
    else {
        return Err(Error::new(
            Status::InvalidArg,
            "Sensitive command does not exist in this project".to_string(),
        ));
    };

    command.enabled = enabled;
    write_project_sensitive_command_settings(database_path, &settings)
}

pub fn upsert_project_sensitive_command_config(
    database_path: &Path,
    project_id: &str,
    item: &ProjectSensitiveCommandConfigInput,
) -> Result<()> {
    let pattern = normalize_required_value(&item.pattern, "Sensitive command pattern")?;
    let description = item.description.trim().to_string();
    let global_commands = sensitive_command_configs::list_sensitive_command_configs(database_path)?;
    let mut settings = get_project_sensitive_command_settings(database_path, project_id)?;
    let command_id = if item.command_id.trim().is_empty() {
        format!("project-{}", database::create_snowflake_id())
    } else {
        item.command_id.trim().to_string()
    };

    if global_commands
        .iter()
        .any(|command| command.command_id == command_id)
    {
        return Err(Error::new(
            Status::InvalidArg,
            "Project sensitive command id conflicts with a global rule".to_string(),
        ));
    }

    let duplicate_global_pattern = global_commands
        .iter()
        .any(|command| command.pattern.trim() == pattern);
    let duplicate_project_pattern = settings
        .custom_commands
        .iter()
        .any(|command| command.command_id != command_id && command.pattern.trim() == pattern);
    if duplicate_global_pattern || duplicate_project_pattern {
        return Err(Error::new(
            Status::InvalidArg,
            "Sensitive command pattern already exists".to_string(),
        ));
    }

    if let Some(command) = settings
        .custom_commands
        .iter_mut()
        .find(|command| command.command_id == command_id)
    {
        command.pattern = pattern;
        command.description = description;
        command.enabled = item.enabled;
        command.sort_order = item.sort_order;
    } else {
        settings
            .custom_commands
            .push(ProjectSensitiveCommandConfig {
                command_id,
                pattern,
                description,
                enabled: item.enabled,
                sort_order: item.sort_order,
            });
    }

    write_project_sensitive_command_settings(database_path, &settings)
}

pub fn delete_project_sensitive_command_config(
    database_path: &Path,
    project_id: &str,
    command_id: &str,
) -> Result<()> {
    let normalized_command_id = normalize_required_value(command_id, "Sensitive command id")?;
    let mut settings = get_project_sensitive_command_settings(database_path, project_id)?;
    let previous_len = settings.custom_commands.len();
    settings
        .custom_commands
        .retain(|command| command.command_id != normalized_command_id);

    if settings.custom_commands.len() == previous_len {
        return Err(Error::new(
            Status::InvalidArg,
            "Inherited sensitive command rules cannot be deleted from a project".to_string(),
        ));
    }

    write_project_sensitive_command_settings(database_path, &settings)
}

fn get_project_sensitive_command_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<ProjectSensitiveCommandSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_sensitive_command_setting_code(&normalized_project_id);
    let Some(raw_value) = system_settings::get_system_setting_value(database_path, &setting_code)?
    else {
        return Ok(ProjectSensitiveCommandSettings {
            project_id: normalized_project_id,
            ..ProjectSensitiveCommandSettings::default()
        });
    };

    let mut settings = serde_json::from_str::<ProjectSensitiveCommandSettings>(&raw_value)
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project sensitive command settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project sensitive command setting identity does not match the requested project"
                .to_string(),
        ));
    }

    Ok(settings)
}

fn write_project_sensitive_command_settings(
    database_path: &Path,
    settings: &ProjectSensitiveCommandSettings,
) -> Result<()> {
    let setting_code = project_sensitive_command_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project sensitive command settings: {error}"),
        )
    })?;
    system_settings::set_system_setting(
        database_path,
        PROJECT_SENSITIVE_COMMAND_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

fn merge_project_sensitive_command_configs(
    global_commands: &[SensitiveCommandConfigRecord],
    settings: &ProjectSensitiveCommandSettings,
) -> Vec<ProjectSensitiveCommandConfigRecord> {
    let mut commands = Vec::with_capacity(global_commands.len() + settings.custom_commands.len());

    commands.extend(global_commands.iter().map(|command| {
        ProjectSensitiveCommandConfigRecord {
            command_id: command.command_id.clone(),
            pattern: command.pattern.clone(),
            description: command.description.clone(),
            enabled: settings
                .global_enabled_overrides
                .get(&command.command_id)
                .copied()
                .unwrap_or(command.enabled),
            inherited: true,
            global_enabled: command.enabled,
            is_preset: command.is_preset,
            sort_order: command.sort_order,
            source: command.source.clone(),
        }
    }));
    commands.extend(settings.custom_commands.iter().map(|command| {
        ProjectSensitiveCommandConfigRecord {
            command_id: command.command_id.clone(),
            pattern: command.pattern.clone(),
            description: command.description.clone(),
            enabled: command.enabled,
            inherited: false,
            global_enabled: false,
            is_preset: false,
            sort_order: command.sort_order,
            source: PROJECT_SENSITIVE_COMMAND_SOURCE.to_string(),
        }
    }));

    commands
}

impl ProjectSensitiveCommandSettings {
    fn normalize(&mut self) {
        self.project_id = self.project_id.trim().to_string();
        self.global_enabled_overrides = self
            .global_enabled_overrides
            .iter()
            .filter_map(|(command_id, enabled)| {
                let command_id = command_id.trim();
                (!command_id.is_empty()).then(|| (command_id.to_string(), *enabled))
            })
            .collect();

        let mut seen_command_ids = BTreeSet::new();
        self.custom_commands.retain_mut(|command| {
            command.command_id = command.command_id.trim().to_string();
            command.pattern = command.pattern.trim().to_string();
            command.description = command.description.trim().to_string();
            !command.command_id.is_empty()
                && !command.pattern.is_empty()
                && seen_command_ids.insert(command.command_id.clone())
        });
    }
}

fn project_sensitive_command_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_SENSITIVE_COMMAND_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

fn normalize_required_value(value: &str, label: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} is required"),
        ));
    }

    Ok(normalized.to_string())
}
