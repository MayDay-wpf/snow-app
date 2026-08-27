use napi::bindgen_prelude::*;
use regex::RegexBuilder;

use super::ensure_database_file;
use super::models::*;
use super::services;

/// 列出子代理配置。project_id 为 None 时返回全部（全局 + 所有项目），
/// 指定时只返回该项目的子代理。
pub fn list_sub_agent_configs(project_id: Option<String>) -> Result<Vec<SubAgentConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::list_sub_agent_configs(&database_path, project_id.as_deref())
}

pub fn get_sub_agent_config(
    agent_id: String,
    project_id: Option<String>,
) -> Result<Option<SubAgentConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::get_sub_agent_config(
        &database_path,
        &agent_id,
        project_id.as_deref(),
    )
}

pub fn upsert_sub_agent_config(item: SubAgentConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::upsert_sub_agent_config(&database_path, &item)
}

pub fn delete_sub_agent_config(agent_id: String, project_id: Option<String>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sub_agent_configs::delete_sub_agent_config(
        &database_path,
        &agent_id,
        project_id.as_deref(),
    )
}

pub fn list_sensitive_command_configs() -> Result<Vec<SensitiveCommandConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::sensitive_command_configs::list_sensitive_command_configs(&database_path)
}

pub fn upsert_sensitive_command_config(item: SensitiveCommandConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sensitive_command_configs::upsert_sensitive_command_config(&database_path, &item)
}

pub fn delete_sensitive_command_config(command_id: String) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sensitive_command_configs::delete_sensitive_command_config(
        &database_path,
        &command_id,
    )
}

pub fn reset_sensitive_command_configs() -> Result<()> {
    let database_path = ensure_database_file()?;
    services::sensitive_command_configs::reset_sensitive_command_configs(&database_path)
}

pub fn list_project_sensitive_command_configs(
    project_id: String,
) -> Result<Vec<ProjectSensitiveCommandConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::list_project_sensitive_command_configs(
        &database_path,
        &project_id,
    )
}

pub fn set_project_sensitive_command_enabled(
    project_id: String,
    command_id: String,
    enabled: bool,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::set_project_sensitive_command_enabled(
        &database_path,
        &project_id,
        &command_id,
        enabled,
    )
}

pub fn upsert_project_sensitive_command_config(
    project_id: String,
    item: ProjectSensitiveCommandConfigInput,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::upsert_project_sensitive_command_config(
        &database_path,
        &project_id,
        &item,
    )
}

pub fn delete_project_sensitive_command_config(
    project_id: String,
    command_id: String,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::project_sensitive_command_configs::delete_project_sensitive_command_config(
        &database_path,
        &project_id,
        &command_id,
    )
}

/// 检查多个候选文本（原始命令 + 间接执行的脚本内容）是否命中敏感命令规则，
/// 命中脚本内容时在 description 后标注来源路径。
pub fn check_sensitive_command_match(
    candidates: Vec<(String, Option<String>)>,
    project_id: Option<String>,
) -> Result<Vec<SensitiveCommandMatchResult>> {
    let database_path = ensure_database_file()?;
    let configs = if let Some(project_id) = project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        services::project_sensitive_command_configs::list_project_sensitive_command_configs(
            &database_path,
            project_id,
        )?
        .into_iter()
        .map(|config| {
            (
                config.command_id,
                config.pattern,
                config.description,
                config.enabled,
            )
        })
        .collect::<Vec<_>>()
    } else {
        services::sensitive_command_configs::list_sensitive_command_configs(&database_path)?
            .into_iter()
            .map(|config| {
                (
                    config.command_id,
                    config.pattern,
                    config.description,
                    config.enabled,
                )
            })
            .collect::<Vec<_>>()
    };

    let mut matches = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (text, source) in candidates {
        for (command_id, pattern, description, enabled) in &configs {
            if !*enabled {
                continue;
            }

            // Sensitive command patterns are user-provided regular expressions.
            // Skip a malformed rule so one invalid configuration cannot disable
            // all remaining checks.
            //
            // Matching is case-insensitive: PowerShell/CMD are case-insensitive
            // (remove-item, Remove-Item, REMOVE-ITEM all execute identically),
            // so a case-sensitive rule can be trivially bypassed with a
            // different casing. A rule may still opt out with (?-i).
            let Ok(regex) = RegexBuilder::new(pattern)
                .case_insensitive(true)
                .build()
            else {
                continue;
            };
            if !regex.is_match(&text) {
                continue;
            }
            let dedup_key = (command_id.clone(), source.clone());
            if !seen.insert(dedup_key) {
                continue;
            }
            let description = match source {
                Some(ref path) => format!("{description} (via script {path})"),
                None => description.clone(),
            };
            matches.push(SensitiveCommandMatchResult {
                command_id: command_id.clone(),
                pattern: pattern.clone(),
                description,
            });
        }
    }

    Ok(matches)
}

pub fn list_hook_configs(
    scope: String,
    project_id: Option<String>,
) -> Result<Vec<HookConfigRecord>> {
    let database_path = ensure_database_file()?;
    services::hooks_configs::list_hook_configs(&database_path, &scope, project_id.as_deref())
}

pub fn upsert_hook_config(item: HookConfigInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::hooks_configs::upsert_hook_config(&database_path, &item)
}

pub fn delete_hook_config(
    hook_type: String,
    scope: String,
    project_id: Option<String>,
) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::hooks_configs::delete_hook_config(
        &database_path,
        &hook_type,
        &scope,
        project_id.as_deref(),
    )
}
