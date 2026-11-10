//! config 服务 `privacy` 作用域：隐私过滤设置（单例）。
//!
//! 真源是 system_settings 的 `privacy_settings`（与 UI「隐私」设置页同源）：
//! `{enabled, mode, api:{url, apiKey, model}, toolResults:{tools}}`。
//!
//! - `mode`：`local`（本地过滤）或 `api`（调用外部脱敏服务）。
//! - `api.apiKey`：读取时掩码；写入时省略或传空字符串表示**保留旧值**
//!   （与 apiProfiles 域一致），避免 AI 用占位符覆盖真实密钥。
//! - `toolResults.tools`：需要脱敏的工具名单，提供时整体替换。
//! - `disabledRules`：关闭的本地脱敏规则 id，提供时整体替换（id 见 `availableRules`）。
//! - `customRules`：自定义正则规则，整体替换；`upsertCustomRules` 按 id/name 增量写入，
//!   `removeCustomRules` 按 id/name 删除。
//!
//! ⚠️ 启用后工具结果会经过隐私过滤（本地或远端），会改变后续请求内容；
//! 本域不提供 delete（用 `enabled=false` 关闭）。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::mcp::privacy_mask::custom_rules;
use crate::storage::services::system_settings::PrivacySettings;

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const PRIVACY_KEY: &str = "settings";
const SUPPORTED_MODES: &[&str] = &["local", "api"];
const CUSTOM_RULE_FORMAT: &str = "{id?, name, pattern (Rust regex, use (?i) for case-insensitive), group? (capture group to mask, default 0 = whole match), replacement? (empty = mask with *), enabled? (default true)}";

fn mask_secret(value: &str) -> Value {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return json!("");
    }
    if chars.len() <= 8 {
        return json!("****");
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    json!(format!("{head}****{tail}"))
}

fn settings_view(settings: &PrivacySettings) -> Value {
    json!({
        "enabled": settings.enabled,
        "mode": settings.mode,
        "api": {
            "url": settings.api.url,
            "apiKey": mask_secret(&settings.api.api_key),
            "model": settings.api.model,
        },
        "toolResults": {
            "tools": settings.tool_results.tools,
        },
        "disabledRules": settings.disabled_rules,
        "availableRules": crate::mcp::privacy_mask::PRIVACY_RULES
            .iter()
            .map(|rule| rule.id)
            .collect::<Vec<_>>(),
        "customRules": custom_rules::rules_view(&settings.custom_rules),
        "customRuleFormat": CUSTOM_RULE_FORMAT,
    })
}

fn invalid_arg(message: String) -> Error {
    Error::new(Status::InvalidArg, message)
}

fn apply_settings(value: &Value) -> Result<Value> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "privacy value must be an object like { enabled: true, mode: \"local\", toolResults: { tools: [...] } }"
                .to_string(),
        ));
    };

    let mut settings = crate::storage::get_privacy_settings()?;

    if let Some(enabled) = patch.get("enabled") {
        settings.enabled = enabled.as_bool().ok_or_else(|| {
            Error::new(Status::InvalidArg, "enabled must be a boolean".to_string())
        })?;
    }

    if let Some(mode) = patch.get("mode") {
        let mode = mode
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "mode must be a non-empty string".to_string(),
                )
            })?;
        if !SUPPORTED_MODES.contains(&mode) {
            return Err(Error::new(
                Status::InvalidArg,
                format!("mode must be one of: {}", SUPPORTED_MODES.join(", ")),
            ));
        }
        settings.mode = mode.to_string();
    }

    if let Some(api) = patch.get("api") {
        let api = api.as_object().ok_or_else(|| {
            Error::new(Status::InvalidArg, "api must be an object".to_string())
        })?;
        if let Some(url) = api.get("url") {
            settings.api.url = url
                .as_str()
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
        }
        if let Some(model) = api.get("model") {
            settings.api.model = model
                .as_str()
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
        }
        match api.get("apiKey").and_then(Value::as_str).map(str::trim) {
            // 省略或空白 = 保留旧密钥，避免用占位符覆盖真实值。
            None | Some("") => {}
            Some(api_key) => settings.api.api_key = api_key.to_string(),
        }
    }

    if let Some(tool_results) = patch.get("toolResults") {
        let tool_results = tool_results.as_object().ok_or_else(|| {
            Error::new(Status::InvalidArg, "toolResults must be an object".to_string())
        })?;
        if let Some(tools) = tool_results.get("tools") {
            let tools = tools.as_array().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "toolResults.tools must be an array of tool names".to_string(),
                )
            })?;
            let mut names = Vec::new();
            for item in tools {
                let name = item
                    .as_str()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "toolResults.tools must be an array of tool names".to_string(),
                        )
                    })?;
                names.push(name.to_string());
            }
            settings.tool_results.tools = names;
        }
    }

    if let Some(disabled_rules) = patch.get("disabledRules") {
        let items = disabled_rules.as_array().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "disabledRules must be an array of rule ids".to_string(),
            )
        })?;
        let mut ids = Vec::new();
        for item in items {
            let id = item.as_str().map(str::trim).unwrap_or_default();
            if !crate::mcp::privacy_mask::PRIVACY_RULES
                .iter()
                .any(|rule| rule.id == id)
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Unknown privacy rule id: {id}"),
                ));
            }
            ids.push(id.to_string());
        }
        settings.disabled_rules = ids;
    }

    // 自定义规则：先整体替换，再增量 upsert，最后删除。
    if let Some(rules) = patch.get("customRules") {
        settings.custom_rules =
            custom_rules::parse_rules(rules, &settings.custom_rules).map_err(invalid_arg)?;
    }
    if let Some(rules) = patch.get("upsertCustomRules") {
        settings.custom_rules =
            custom_rules::upsert_rules(settings.custom_rules, rules).map_err(invalid_arg)?;
    }
    if let Some(keys) = patch.get("removeCustomRules") {
        settings.custom_rules =
            custom_rules::remove_rules(settings.custom_rules, keys).map_err(invalid_arg)?;
    }

    crate::storage::set_privacy_settings(settings.clone())?;

    Ok(json!({
        "scope": "privacy",
        "key": PRIVACY_KEY,
        "value": settings_view(&settings),
    }))
}

/// Dispatches the `config-manage` list/get/set/delete actions for the `privacy` scope.
pub(crate) fn execute_privacy_scope(
    tool_name: &str,
    args: &Value,
    _db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => Ok(json!({
            "scope": "privacy",
            "file": null,
            "keys": [{
                "key": PRIVACY_KEY,
                "type": "object",
                "sensitive": true,
                "configured": true,
                "value": settings_view(&crate::storage::get_privacy_settings()?),
            }],
        })),
        TOOL_GET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != PRIVACY_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("privacy only defines the key \"{PRIVACY_KEY}\""),
                ));
            }
            Ok(json!({
                "scope": "privacy",
                "key": key,
                "value": settings_view(&crate::storage::get_privacy_settings()?),
            }))
        }
        TOOL_SET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != PRIVACY_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("privacy only defines the key \"{PRIVACY_KEY}\""),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for action=set".to_string(),
                )
            })?;
            apply_settings(&value)
        }
        TOOL_DELETE => Err(Error::new(
            Status::InvalidArg,
            "privacy does not support delete; use action=set with {\"enabled\": false} to turn filtering off"
                .to_string(),
        )),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope privacy: {other}"),
        )),
    }
}
