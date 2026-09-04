use std::path::Path;

use napi::bindgen_prelude::*;

use super::{
    get_system_setting_value, normalize_required_value, set_system_setting, update_disabled_set,
    CodebaseProjectScopeSettings, McpGlobalScopeSettings, McpProjectScopeSettings,
    SkillsProjectScopeSettings, ToolApprovalProjectScopeSettings, GLOBAL_MCP_SETTING_CODE,
    GLOBAL_MCP_SETTING_NAME, PROJECT_CODEBASE_SETTING_CODE_PREFIX,
    PROJECT_CODEBASE_SETTING_NAME, PROJECT_MCP_SETTING_CODE_PREFIX, PROJECT_MCP_SETTING_NAME,
    PROJECT_SKILLS_SETTING_CODE_PREFIX, PROJECT_SKILLS_SETTING_NAME,
    PROJECT_TOOL_APPROVAL_SETTING_CODE_PREFIX, PROJECT_TOOL_APPROVAL_SETTING_NAME,
};

pub fn get_mcp_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<McpProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_mcp_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(McpProjectScopeSettings {
            project_id: normalized_project_id,
            ..McpProjectScopeSettings::default()
        });
    };

    let mut settings =
        serde_json::from_str::<McpProjectScopeSettings>(&raw_value).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project MCP scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project MCP scope setting identity does not match the requested project".to_string(),
        ));
    }

    Ok(settings)
}

pub fn set_mcp_project_server_enabled(
    database_path: &Path,
    project_id: &str,
    server_id: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_server_id = normalize_required_value(server_id, "MCP server id")?;
    let mut settings = get_mcp_project_scope_settings(database_path, project_id)?;
    settings.set_server_enabled(&normalized_server_id, enabled);
    write_mcp_project_scope_settings(database_path, &settings)
}

pub fn set_mcp_project_tool_enabled(
    database_path: &Path,
    project_id: &str,
    tool_name: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_tool_name = normalize_required_value(tool_name, "MCP tool name")?;
    let mut settings = get_mcp_project_scope_settings(database_path, project_id)?;
    settings.set_tool_enabled(&normalized_tool_name, enabled);
    write_mcp_project_scope_settings(database_path, &settings)
}

/// 批量启停项目作用域下的工具：一次读改写，避免逐工具多次写库。
pub fn set_mcp_project_tools_enabled(
    database_path: &Path,
    project_id: &str,
    tool_names: &[String],
    enabled: bool,
) -> Result<()> {
    let mut settings = get_mcp_project_scope_settings(database_path, project_id)?;
    for tool_name in tool_names {
        let normalized_tool_name = normalize_required_value(tool_name, "MCP tool name")?;
        settings.set_tool_enabled(&normalized_tool_name, enabled);
    }
    write_mcp_project_scope_settings(database_path, &settings)
}

fn write_mcp_project_scope_settings(
    database_path: &Path,
    settings: &McpProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_mcp_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project MCP scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_MCP_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

/// 全局 MCP 工具级 scope：无记录时返回默认（空黑名单 = 全部启用）。
pub fn get_mcp_global_scope_settings(database_path: &Path) -> Result<McpGlobalScopeSettings> {
    let Some(raw_value) = get_system_setting_value(database_path, GLOBAL_MCP_SETTING_CODE)? else {
        return Ok(McpGlobalScopeSettings::default());
    };

    let settings = serde_json::from_str::<McpGlobalScopeSettings>(&raw_value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse global MCP scope settings: {error}"),
        )
    })?;
    Ok(settings)
}

pub fn set_mcp_global_tool_enabled(
    database_path: &Path,
    tool_name: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_tool_name = normalize_required_value(tool_name, "MCP tool name")?;
    let mut settings = get_mcp_global_scope_settings(database_path)?;
    update_disabled_set(&mut settings.disabled_tool_names, &normalized_tool_name, enabled);
    write_mcp_global_scope_settings(database_path, &settings)
}

/// 批量启停全局作用域下的工具：一次读改写，避免逐工具多次写库。
pub fn set_mcp_global_tools_enabled(
    database_path: &Path,
    tool_names: &[String],
    enabled: bool,
) -> Result<()> {
    let mut settings = get_mcp_global_scope_settings(database_path)?;
    for tool_name in tool_names {
        let normalized_tool_name = normalize_required_value(tool_name, "MCP tool name")?;
        update_disabled_set(
            &mut settings.disabled_tool_names,
            &normalized_tool_name,
            enabled,
        );
    }
    write_mcp_global_scope_settings(database_path, &settings)
}

fn write_mcp_global_scope_settings(
    database_path: &Path,
    settings: &McpGlobalScopeSettings,
) -> Result<()> {
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize global MCP scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        GLOBAL_MCP_SETTING_NAME,
        GLOBAL_MCP_SETTING_CODE,
        &setting_value,
    )
}

pub fn get_skills_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<SkillsProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_skills_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(SkillsProjectScopeSettings {
            project_id: normalized_project_id,
            ..SkillsProjectScopeSettings::default()
        });
    };

    let mut settings =
        serde_json::from_str::<SkillsProjectScopeSettings>(&raw_value).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project Skills scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project Skills scope setting identity does not match the requested project"
                .to_string(),
        ));
    }

    Ok(settings)
}

pub fn set_skills_project_skill_enabled(
    database_path: &Path,
    project_id: &str,
    skill_key: &str,
    enabled: bool,
) -> Result<()> {
    let normalized_skill_key = normalize_required_value(skill_key, "Skill key")?;
    let mut settings = get_skills_project_scope_settings(database_path, project_id)?;
    settings.set_skill_enabled(&normalized_skill_key, enabled);
    write_skills_project_scope_settings(database_path, &settings)
}

fn write_skills_project_scope_settings(
    database_path: &Path,
    settings: &SkillsProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_skills_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project Skills scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_SKILLS_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

fn project_mcp_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_MCP_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

fn project_skills_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_SKILLS_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

pub fn get_codebase_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<CodebaseProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_codebase_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(CodebaseProjectScopeSettings {
            project_id: normalized_project_id,
            ..CodebaseProjectScopeSettings::default()
        });
    };

    let mut settings =
        serde_json::from_str::<CodebaseProjectScopeSettings>(&raw_value).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project Codebase scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project Codebase scope setting identity does not match the requested project"
                .to_string(),
        ));
    }

    Ok(settings)
}

pub fn set_codebase_project_enabled(
    database_path: &Path,
    project_id: &str,
    enabled: bool,
) -> Result<()> {
    let mut settings = get_codebase_project_scope_settings(database_path, project_id)?;
    settings.set_enabled(enabled);
    write_codebase_project_scope_settings(database_path, &settings)
}

pub fn set_codebase_project_agent_review(
    database_path: &Path,
    project_id: &str,
    enabled: bool,
) -> Result<()> {
    let mut settings = get_codebase_project_scope_settings(database_path, project_id)?;
    settings.set_agent_review(enabled);
    write_codebase_project_scope_settings(database_path, &settings)
}

pub fn set_codebase_project_reranking(
    database_path: &Path,
    project_id: &str,
    enabled: bool,
) -> Result<()> {
    let mut settings = get_codebase_project_scope_settings(database_path, project_id)?;
    settings.set_reranking(enabled);
    write_codebase_project_scope_settings(database_path, &settings)
}

fn write_codebase_project_scope_settings(
    database_path: &Path,
    settings: &CodebaseProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_codebase_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project Codebase scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_CODEBASE_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

fn project_codebase_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_CODEBASE_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}

pub fn get_tool_approval_project_scope_settings(
    database_path: &Path,
    project_id: &str,
) -> Result<ToolApprovalProjectScopeSettings> {
    let normalized_project_id = normalize_required_value(project_id, "Project id")?;
    let setting_code = project_tool_approval_setting_code(&normalized_project_id);
    let Some(raw_value) = get_system_setting_value(database_path, &setting_code)? else {
        return Ok(ToolApprovalProjectScopeSettings {
            project_id: normalized_project_id,
            ..ToolApprovalProjectScopeSettings::default()
        });
    };

    let mut settings = serde_json::from_str::<ToolApprovalProjectScopeSettings>(&raw_value)
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse project Tool approval scope settings: {error}"),
            )
        })?;
    settings.normalize();
    if settings.project_id.is_empty() {
        settings.project_id = normalized_project_id.clone();
    }
    if settings.project_id != normalized_project_id {
        return Err(Error::new(
            Status::GenericFailure,
            "Project Tool approval scope setting identity does not match the requested project"
                .to_string(),
        ));
    }

    Ok(settings)
}

pub fn list_tool_approval_project_approved_tools(
    database_path: &Path,
    project_id: &str,
) -> Result<Vec<String>> {
    let settings = get_tool_approval_project_scope_settings(database_path, project_id)?;
    Ok(settings.approved_tool_names.into_iter().collect())
}

pub fn set_tool_approval_project_tool_approved(
    database_path: &Path,
    project_id: &str,
    tool_name: &str,
    approved: bool,
) -> Result<()> {
    let normalized_tool_name = normalize_required_value(tool_name, "Tool name")?;
    let mut settings = get_tool_approval_project_scope_settings(database_path, project_id)?;
    settings.set_tool_approved(&normalized_tool_name, approved);
    write_tool_approval_project_scope_settings(database_path, &settings)
}

/// 批量设置项目级工具授权。一次读-改-写完成全部工具，避免逐条调用
/// 时并发读-改-写互相覆盖（丢失更新）。
pub fn set_tool_approval_project_tools_approved(
    database_path: &Path,
    project_id: &str,
    tool_names: &[String],
    approved: bool,
) -> Result<()> {
    let mut settings = get_tool_approval_project_scope_settings(database_path, project_id)?;
    for tool_name in tool_names {
        let normalized = tool_name.trim();
        if !normalized.is_empty() {
            settings.set_tool_approved(normalized, approved);
        }
    }
    write_tool_approval_project_scope_settings(database_path, &settings)
}

fn write_tool_approval_project_scope_settings(
    database_path: &Path,
    settings: &ToolApprovalProjectScopeSettings,
) -> Result<()> {
    let setting_code = project_tool_approval_setting_code(&settings.project_id);
    let setting_value = serde_json::to_string(settings).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize project Tool approval scope settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        PROJECT_TOOL_APPROVAL_SETTING_NAME,
        &setting_code,
        &setting_value,
    )
}

fn project_tool_approval_setting_code(project_id: &str) -> String {
    format!(
        "{PROJECT_TOOL_APPROVAL_SETTING_CODE_PREFIX}{}",
        blake3::hash(project_id.as_bytes()).to_hex()
    )
}
