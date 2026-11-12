use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{SubAgentConfigInput, SubAgentConfigRecord};
pub(crate) use snow_storage_core::defaults::{
    DEFAULT_GENERAL_AGENT_SYSTEM_PROMPT, DEFAULT_GENERAL_AGENT_TOOLS_JSON,
};



/// 唯一允许使用通配符工具配置的内置子代理。
pub(crate) const BUILTIN_GENERAL_AGENT_ID: &str = "agent_general";

pub fn list_sub_agent_configs(
    database_path: &Path,
    project_id: Option<&str>,
) -> Result<Vec<SubAgentConfigRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_sub_agent_configs(&connection, project_id))
        .map_err(|error| database::database_error(database_path, "list sub-agent configs", error))
}

pub fn get_sub_agent_config(
    database_path: &Path,
    agent_id: &str,
    project_id: Option<&str>,
) -> Result<Option<SubAgentConfigRecord>> {
    let normalized_agent_id = agent_id.trim();
    if normalized_agent_id.is_empty() {
        return Err(Error::from_reason("Sub-agent id is required"));
    }
    let normalized_project_id = normalize_project_id(project_id);

    database::open_connection(database_path)
        .and_then(|connection| {
            let mut configs = query_sub_agent_configs(&connection, None)?;
            let found = configs.drain(..).find(|config| {
                config.agent_id == normalized_agent_id && config.project_id == normalized_project_id
            });
            Ok(found)
        })
        .map_err(|error| database::database_error(database_path, "get sub-agent config", error))
}

/// 子代理 toolsJson 的唯一保存校验（UI 与 config-manage 的 action=set 共用）：
/// 非空字符串数组、格式合法、不含保留工具、至少一个读取工具；
/// 通配符 `*` 只能单独出现且仅限内置 agent_general。
fn validate_sub_agent_tools(agent_id: &str, tools_json: &str) -> Result<()> {
    use snow_tools::sub_agents::is_sub_agent_reserved_tool;

    let tools: Vec<String> =
        serde_json::from_str(tools_json).map_err(|error| {
            Error::from_reason(format!(
                "Sub-agent toolsJson must be a valid JSON string array: {error}"
            ))
        })?;
    let tools = tools
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect::<std::collections::HashSet<_>>();
    if tools.is_empty() {
        return Err(Error::from_reason(
            "Sub-agent toolsJson must not be empty: at least one read tool (e.g. filesystem-read) is required",
        ));
    }
    if tools.contains("*") {
        if tools.len() != 1 {
            return Err(Error::from_reason(
                "Sub-agent wildcard \"*\" must be the only entry in toolsJson",
            ));
        }
        if agent_id.trim() != BUILTIN_GENERAL_AGENT_ID {
            return Err(Error::from_reason(
                "Only the built-in agent_general may use the wildcard tool configuration; list the tools explicitly",
            ));
        }
        return Ok(());
    }
    let is_valid_name = |name: &str| {
        name.split_once('-').is_some_and(|(server, tool)| !server.is_empty() && !tool.is_empty())
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    };
    if let Some(invalid) = tools.iter().find(|name| !is_valid_name(name.as_str())) {
        return Err(Error::from_reason(format!(
            "Sub-agent tool name is not a valid MCP tool full name: {invalid}"
        )));
    }
    if let Some(reserved) = tools
        .iter()
        .find(|name| is_sub_agent_reserved_tool(name.as_str()))
    {
        return Err(Error::from_reason(format!(
            "Tool is reserved for the main conversation and cannot be assigned to sub-agents: {reserved}"
        )));
    }
    const READ_TOOLS: &[&str] = &[
        "filesystem-read",
        "grep-search",
    ];
    if !tools.iter().any(|tool| READ_TOOLS.contains(&tool.as_str())) {
        return Err(Error::from_reason(format!(
            "Sub-agent toolsJson must include at least one read tool (e.g. filesystem-read); got: {}",
            tools.into_iter().collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(())
}

/// 项目级子代理：工具须在该项目**存在**（不要求启用，子代理显式勾选豁免项目
/// 启停）；不连接外部服务器，只校验服务器公开名。全局子代理运行时按对话项目解析。
/// 内置工具判定：server_id 属于内置服务器集合。
fn is_builtin_tool(full_name: &str) -> bool {
    snow_tools::contract::split_tool_full_name(full_name)
        .is_some_and(|(server, _)| snow_tools::contract::BUILTIN_SERVER_IDS.contains(&server))
}

fn validate_sub_agent_tools_exist(
    database_path: &Path,
    project_id: Option<&str>,
    tools_json: &str,
) -> Result<()> {
    use crate::mcp::external::public_server_name_map;
    use snow_tools::contract::split_tool_full_name;

    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let tools: Vec<String> = serde_json::from_str(tools_json).unwrap_or_default();
    let tools = tools
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty() && *name != "*")
        .collect::<Vec<_>>();
    if tools.is_empty() {
        return Ok(());
    }
    let configs = super::project_mcp_server_configs::list_effective_mcp_server_configs(
        database_path,
        Some(project_id),
    )?;
    let public_names = public_server_name_map(&configs);
    let known_server_names = configs
        .iter()
        .filter_map(|config| public_names.get(&config.server_id).cloned())
        .collect::<std::collections::HashSet<_>>();
    for name in tools {
        if is_builtin_tool(name) || name.starts_with("skills-") {
            continue;
        }
        let exists = split_tool_full_name(name)
            .is_some_and(|(server_name, _)| known_server_names.contains(server_name));
        if !exists {
            return Err(Error::from_reason(format!(
                "Selected sub-agent MCP tool does not exist in the current project: {name}"
            )));
        }
    }
    Ok(())
}

pub fn upsert_sub_agent_config(database_path: &Path, item: &SubAgentConfigInput) -> Result<()> {
    validate_sub_agent_tools(&item.agent_id, &item.tools_json)?;
    validate_sub_agent_tools_exist(database_path, item.project_id.as_deref(), &item.tools_json)?;
    database::open_connection(database_path)
        .and_then(|connection| upsert_sub_agent_config_with_connection(&connection, item))
        .map_err(|error| database::database_error(database_path, "upsert sub-agent config", error))
}

pub fn delete_sub_agent_config(
    database_path: &Path,
    agent_id: &str,
    project_id: Option<&str>,
) -> Result<()> {
    let normalized_project_id = normalize_project_id(project_id);
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "DELETE FROM sub_agent_configs
                  WHERE agent_id = ?1 AND project_id = ?2 AND builtin = 0",
                params![agent_id, normalized_project_id],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "delete sub-agent config", error))
}

pub fn seed_default_sub_agent_configs(database_path: &Path) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT OR IGNORE INTO sub_agent_configs (
                   id,
                   agent_id,
                   name,
                   description,
                   system_prompt,
                   tools_json,
                   config_profile,
                   model,
                   builtin,
                   sort_order,
                   source,
                   project_id,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, 'agent_general', 'General Purpose Agent', ?2, ?3, ?4, '', '', 1, 0, 'builtin', '', datetime('now', 'localtime'), datetime('now', 'localtime')
                 )",
                params![
                    database::create_snowflake_id(),
                    "General-purpose multi-step task execution agent. Has complete tool access for code search, file modification, command execution, and various operations.",
                    DEFAULT_GENERAL_AGENT_SYSTEM_PROMPT,
                    DEFAULT_GENERAL_AGENT_TOOLS_JSON,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| database::database_error(database_path, "seed default sub-agent configs", error))
}

/// 规范化 project_id：None/空白 → 空字符串（全局）；否则返回去空白后的值。
fn normalize_project_id(project_id: Option<&str>) -> String {
    match project_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(id) => id.to_string(),
        None => String::new(),
    }
}

fn query_sub_agent_configs(
    connection: &Connection,
    project_id: Option<&str>,
) -> rusqlite::Result<Vec<SubAgentConfigRecord>> {
    let normalized_project_id = normalize_project_id(project_id);
    let mut sql = String::from(
        "SELECT id,
                agent_id,
                name,
                description,
                system_prompt,
                tools_json,
                config_profile,
                model,
                builtin,
                sort_order,
                source,
                project_id,
                updated_at
           FROM sub_agent_configs",
    );
    if !normalized_project_id.is_empty() {
        sql.push_str(" WHERE project_id = ?1");
    }
    sql.push_str(" ORDER BY sort_order ASC, id ASC");

    let mut statement = connection.prepare(&sql)?;
    let rows = if normalized_project_id.is_empty() {
        statement.query_map([], map_sub_agent_config_row)?
    } else {
        statement.query_map(params![normalized_project_id], map_sub_agent_config_row)?
    };

    rows.collect()
}

fn map_sub_agent_config_row(row: &rusqlite::Row) -> rusqlite::Result<SubAgentConfigRecord> {
    let builtin: i64 = row.get(8)?;
    Ok(SubAgentConfigRecord {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        system_prompt: row.get(4)?,
        tools_json: row.get(5)?,
        config_profile: row.get(6)?,
        model: row.get(7)?,
        builtin: builtin != 0,
        sort_order: row.get(9)?,
        source: row.get(10)?,
        project_id: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn upsert_sub_agent_config_with_connection(
    connection: &Connection,
    item: &SubAgentConfigInput,
) -> rusqlite::Result<()> {
    let project_id = match item
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(id) => id.to_string(),
        None => String::new(),
    };
    connection.execute(
        "INSERT INTO sub_agent_configs (
           id,
           agent_id,
           name,
           description,
           system_prompt,
           tools_json,
           config_profile,
           model,
           builtin,
           sort_order,
           source,
           project_id,
           created_at,
           updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now', 'localtime'), datetime('now', 'localtime')
         )
         ON CONFLICT(agent_id, project_id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           system_prompt = excluded.system_prompt,
           tools_json = excluded.tools_json,
           config_profile = excluded.config_profile,
           model = excluded.model,
           builtin = excluded.builtin,
           sort_order = excluded.sort_order,
           source = excluded.source,
           updated_at = datetime('now', 'localtime')",
        params![
            database::create_snowflake_id(),
            item.agent_id,
            item.name,
            item.description,
            item.system_prompt,
            item.tools_json,
            item.config_profile,
            item.model,
            item.builtin as i32,
            item.sort_order,
            item.source,
            project_id,
        ],
    )?;

    Ok(())
}
