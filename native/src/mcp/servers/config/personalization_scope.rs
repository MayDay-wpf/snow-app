use super::*;

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

/// personalization scope：全局规则/角色定义文件（~/.snow/ROLE.md）。
/// ROLE.md 是纯文本 markdown（非 JSON），key = "role"，值为规则全文：
/// - list：返回键规格 + configured/长度/预览（不返回全文，避免上下文膨胀）；
/// - get：返回规则全文（文件不存在时返回 null）；
/// - set：备份后原子写入全文（值必须是字符串）；
/// - delete：需 confirmed，删除文件即恢复默认（应用对缺失 ROLE.md 有内置回退）。
pub(crate) fn execute_personalization_scope(tool_name: &str, args: &Value) -> napi::Result<Value> {
    match tool_name {
        TOOL_LIST => list_personalization_role(),
        TOOL_GET => get_personalization_role(args),
        TOOL_SET => set_personalization_role(args),
        TOOL_DELETE => delete_personalization_role(args),
        _ => Err(Error::new(
            Status::GenericFailure,
            format!(
                "Unknown action: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available actions: [list, get, set, delete]"
            ),
        )),
    }
}

/// ~/.snow/ROLE.md 的完整路径。
fn role_file_path() -> PathBuf {
    ConfigService::snow_dir().join(ROLE_FILE_NAME)
}

/// 读取 ROLE.md 全文；文件不存在时返回 None。
fn read_role_file() -> napi::Result<Option<String>> {
    let file_path = role_file_path();
    match fs::read_to_string(&file_path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::new(
            Status::GenericFailure,
            format!("Failed to read {}: {error}", file_path.display()),
        )),
    }
}

/// 原子写入 ROLE.md（临时文件 + rename，崩溃不损坏目标文件）。
fn atomic_write_role(content: &str) -> napi::Result<()> {
    let file_path = role_file_path();
    let tmp_path = file_path.with_extension("role.tmp");
    fs::write(&tmp_path, content).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write {}: {error}", tmp_path.display()),
        )
    })?;
    fs::rename(&tmp_path, &file_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        Error::new(
            Status::GenericFailure,
            format!("Failed to replace {}: {error}", file_path.display()),
        )
    })
}

/// config-manage action=list personalization：返回键规格（role）+ configured/长度/预览。
fn list_personalization_role() -> napi::Result<Value> {
    let content = read_role_file()?;
    let (configured, length, preview) = match &content {
        Some(text) => {
            let preview: String = text.chars().take(ROLE_PREVIEW_LEN).collect();
            (true, text.len(), preview)
        }
        None => (false, 0, String::new()),
    };
    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "file": ROLE_FILE_NAME,
        "keys": [{
            "key": PERSONALIZATION_ROLE_KEY,
            "type": "string",
            "sensitive": false,
            "configured": configured,
            "length": length,
            "preview": preview,
            "value": Value::Null,
        }],
        "note": "Use config-manage action=get scope=personalization key=role to read the full rules; config-manage action=set key=role writes the whole file (markdown text); config-manage action=delete removes ROLE.md and restores defaults.",
    }))
}

/// config-manage action=get personalization：key=role 返回规则全文（文件不存在时返回 null）。
fn get_personalization_role(args: &Value) -> napi::Result<Value> {
    let key_name = required_string(args, "key")?;
    if key_name != PERSONALIZATION_ROLE_KEY {
        return Err(invalid_personalization_key_error(key_name));
    }
    let display = match read_role_file()? {
        Some(text) => Value::String(text),
        None => Value::Null,
    };
    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "key": PERSONALIZATION_ROLE_KEY,
        "value": display,
    }))
}

/// config-manage action=set personalization：key=role value=<字符串> 备份后原子写入全文。
fn set_personalization_role(args: &Value) -> napi::Result<Value> {
    let key_name = required_string(args, "key")?;
    if key_name != PERSONALIZATION_ROLE_KEY {
        return Err(invalid_personalization_key_error(key_name));
    }
    let value = args.get("value").cloned().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "value is required for action=set".to_string(),
        )
    })?;
    if !value.is_string() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Invalid value type for key `{}` (expected string)",
                PERSONALIZATION_ROLE_KEY
            ),
        ));
    }
    let content = value.as_str().unwrap_or_default().to_string();

    let file_path = role_file_path();
    let backup = ConfigService::backup_file(&file_path)?;
    atomic_write_role(&content)?;
    // 写入成功：删除本次写前备份（临时安全网不再需要）。
    ConfigService::cleanup_backup(backup);

    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "key": PERSONALIZATION_ROLE_KEY,
        "value": content,
    }))
}

/// config-manage action=delete personalization：key=role 需 confirmed，删除 ROLE.md（恢复默认）。
fn delete_personalization_role(args: &Value) -> napi::Result<Value> {
    // 破坏性操作二次确认（统一在 execute_async 入口检查；此处防御性兜底）。
    require_delete_confirmation(args)?;
    let key_name = required_string(args, "key")?;
    if key_name != PERSONALIZATION_ROLE_KEY {
        return Err(invalid_personalization_key_error(key_name));
    }
    let file_path = role_file_path();
    if !file_path.exists() {
        return Ok(json!({
            "scope": SCOPE_PERSONALIZATION,
            "key": PERSONALIZATION_ROLE_KEY,
            "deleted": false,
        }));
    }
    let backup = ConfigService::backup_file(&file_path)?;
    fs::remove_file(&file_path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to delete {}: {error}", file_path.display()),
        )
    })?;
    // 删除成功：清理本次写前备份。
    ConfigService::cleanup_backup(backup);
    Ok(json!({
        "scope": SCOPE_PERSONALIZATION,
        "key": PERSONALIZATION_ROLE_KEY,
        "deleted": true,
    }))
}

/// personalization scope 键白名单错误。
fn invalid_personalization_key_error(key: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!(
            "Unknown config key: \"{key}\" in scope \"{SCOPE_PERSONALIZATION}\". Available keys: [{PERSONALIZATION_ROLE_KEY}]"
        ),
    )
}
