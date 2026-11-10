//! lsp-config scope（DB-backed，lsp_server_configs 表）。
//!
//! 与原文件型语义对齐（全量替换、键级读写）：
//! - list：返回 keys 概览（schemaVersion / servers）与 configured 状态
//! - get：key=servers 返回 {lang: {...}} 聚合；key=schemaVersion 返回 1
//! - set：key=servers 全量替换（校验沿用 validate_lsp_servers）；保留旧 source 标记
//! - delete：清空表（破坏性操作，需 confirmed——外层统一处理）
//!
//! agent 用现有 config-manage action=set scope=lsp-config 即可配置语言服务器（命令/路径/
//! 扩展名），立即生效（ServerManager 每次工具调用从表 reload）。

use super::*;

use serde_json::{json, Value};

use crate::storage::LspServerConfigInput;

/// 表记录 → 原 lsp-config.json 的 servers.<lang> 结构。
fn record_to_server_json(record: &crate::storage::LspServerConfigRecord) -> Value {
    let args: Vec<String> = serde_json::from_str(&record.args_json).unwrap_or_default();
    let file_extensions: Vec<String> =
        serde_json::from_str(&record.file_extensions_json).unwrap_or_default();
    let mut server = serde_json::Map::new();
    server.insert("command".to_string(), json!(record.command));
    server.insert("args".to_string(), json!(args));
    server.insert("fileExtensions".to_string(), json!(file_extensions));
    // None 时跳过字段（校验要求 installCommand 为 string，null 会校验失败）。
    if let Some(cmd) = record.install_command.as_deref().filter(|s| !s.is_empty()) {
        server.insert("installCommand".to_string(), json!(cmd));
    }
    server.insert(
        "initializationOptions".to_string(),
        record
            .initialization_options_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or_else(|| json!({})),
    );
    Value::Object(server)
}

/// 表记录 → servers 聚合对象。
fn records_to_servers_json(
    records: &[crate::storage::LspServerConfigRecord],
) -> Value {
    let mut servers = serde_json::Map::new();
    for record in records {
        servers.insert(record.lang.clone(), record_to_server_json(record));
    }
    Value::Object(servers)
}

/// 从 args 提取 projectId（config-manage 的 set/get/delete 动作的项目级目标）。
fn project_id_of(args: &Value) -> Option<String> {
    args.get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn load_records(project_id: Option<&str>) -> napi::Result<Vec<crate::storage::LspServerConfigRecord>> {
    let result = match project_id {
        Some(pid) => crate::storage::list_project_lsp_server_configs(pid.to_string()),
        None => crate::storage::list_lsp_server_configs(),
    };
    result.map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read LSP server configs: {error}"),
        )
    })
}

/// 清空表（全量替换的第一步 / delete；项目级清项目配置）。
fn clear_table(project_id: Option<&str>) -> napi::Result<()> {
    let result = match project_id {
        Some(pid) => crate::storage::clear_project_lsp_server_configs(pid.to_string()),
        None => crate::storage::clear_lsp_server_configs(),
    };
    result.map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to clear LSP server configs: {error}"),
        )
    })
}

pub(crate) fn execute_lsp_config_scope(tool_name: &str, args: &Value) -> napi::Result<Value> {
    match tool_name {
        TOOL_LIST => list_lsp_config(args),
        TOOL_GET => get_lsp_config(args),
        TOOL_SET => set_lsp_config(args),
        TOOL_DELETE => delete_lsp_config(args),
        _ => Err(Error::new(
            Status::InvalidArg,
            format!(
                "Unknown config tool \"{tool_name}\" for scope \"lsp-config\". Available tools: [list, get, set, delete]"
            ),
        )),
    }
}

fn list_lsp_config(args: &Value) -> napi::Result<Value> {
    let project_id = project_id_of(args);
    let records = load_records(project_id.as_deref())?;
    let servers_value = records_to_servers_json(&records);
    let keys = vec![
        json!({
            "key": "schemaVersion",
            "configured": true,
        }),
        json!({
            "key": "servers",
            "configured": !records.is_empty(),
            "languages": records.iter().map(|r| r.lang.clone()).collect::<Vec<_>>(),
        }),
    ];
    Ok(json!({
        "scope": SCOPE_LSP_CONFIG,
        "projectId": project_id,
        "keys": keys,
        "servers": servers_value,
    }))
}

fn get_lsp_config(args: &Value) -> napi::Result<Value> {
    let scope_name = required_string(args, "scope")?;
    let key_name = required_string(args, "key")?;
    let project_id = project_id_of(args);
    let records = load_records(project_id.as_deref())?;

    let value = match key_name {
        "schemaVersion" => json!(1),
        "servers" => records_to_servers_json(&records),
        _ => {
            let scope = ConfigService::find_scope(SCOPE_LSP_CONFIG)
                .ok_or_else(|| invalid_scope_error(SCOPE_LSP_CONFIG))?;
            return Err(invalid_key_error(scope, &key_name));
        }
    };
    Ok(json!({
        "scope": scope_name,
        "key": key_name,
        "projectId": project_id,
        "value": value,
    }))
}

fn set_lsp_config(args: &Value) -> napi::Result<Value> {
    let scope_name = required_string(args, "scope")?;
    let key_name = required_string(args, "key")?;
    let project_id = project_id_of(args);
    let value = args.get("value").cloned().ok_or_else(|| {
        Error::new(Status::InvalidArg, "value is required for action=set".to_string())
    })?;

    match key_name {
        "schemaVersion" => {
            // schemaVersion 固定为 1（结构版本）；接受写入但不改变表内容。
            return Ok(json!({
                "scope": scope_name,
                "key": key_name,
                "projectId": project_id,
                "value": value,
            }));
        }
        "servers" => {}
        _ => {
            let scope = ConfigService::find_scope(SCOPE_LSP_CONFIG)
                .ok_or_else(|| invalid_scope_error(SCOPE_LSP_CONFIG))?;
            return Err(invalid_key_error(scope, &key_name));
        }
    }

    // 结构校验（与原文件型一致，深度校验）。
    ConfigService::validate_lsp_servers(&value)?;

    // 全量替换：清空后插入（保留旧记录的 source 标记，新语言用 manual）。
    let old_sources: std::collections::HashMap<String, String> = load_records(project_id.as_deref())?
        .into_iter()
        .map(|r| (r.lang.clone(), r.source.clone()))
        .collect();
    clear_table(project_id.as_deref())?;

    let servers = value
        .as_object()
        .ok_or_else(|| invalid_nested_field_error("lsp-config.servers", "object"))?;
    let mut sort_order = 0i32;
    for (lang, server) in servers {
        let obj = server.as_object().ok_or_else(|| {
            invalid_nested_field_error(&format!("lsp-config.servers.{lang}"), "object")
        })?;
        let command = obj
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let args = obj.get("args").cloned().unwrap_or_else(|| json!([]));
        let file_extensions = obj
            .get("fileExtensions")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let install_command = obj
            .get("installCommand")
            .and_then(Value::as_str)
            .map(str::to_string);
        let initialization_options = obj
            .get("initializationOptions")
            .cloned()
            .map(|v| v.to_string());

        let item = LspServerConfigInput {
            lang: lang.clone(),
            command,
            args_json: serde_json::to_string(&args).unwrap_or_else(|_| "[]".into()),
            file_extensions_json: serde_json::to_string(&file_extensions)
                .unwrap_or_else(|_| "[]".into()),
            install_command,
            initialization_options_json: initialization_options,
            enabled: true,
            sort_order,
            source: old_sources.get(lang).cloned().unwrap_or_else(|| "manual".to_string()),
        };
        let write_result = match project_id.as_deref() {
            Some(pid) => crate::storage::upsert_project_lsp_server_config(pid.to_string(), item),
            None => crate::storage::upsert_lsp_server_config(item),
        };
        write_result.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write LSP server config: {error}"),
            )
        })?;
        sort_order += 1;
    }

    Ok(json!({
        "scope": scope_name,
        "key": key_name,
        "projectId": project_id,
        "value": value,
    }))
}

fn delete_lsp_config(args: &Value) -> napi::Result<Value> {
    // 破坏性操作：confirmed 校验由外层 execute 统一处理。
    let scope_name = required_string(args, "scope")?;
    let project_id = project_id_of(args);
    clear_table(project_id.as_deref())?;
    Ok(json!({
        "scope": scope_name,
        "projectId": project_id,
        "deleted": true,
    }))
}
