//! 隐私设置（隐私模式 API 配置）的 NAPI 类型与转发。

use super::*;

#[napi(object)]
pub struct PrivacyApiConfigNapi {
    pub url: String,
    pub api_key: String,
    pub model: String,
}

#[napi(object)]
pub struct PrivacyToolResultsConfigNapi {
    pub tools: Vec<String>,
}

#[napi(object)]
pub struct PrivacySettingsNapi {
    pub enabled: bool,
    pub mode: String,
    pub api: PrivacyApiConfigNapi,
    pub tool_results: PrivacyToolResultsConfigNapi,
    /// 省略时保留已存储的值（兼容旧调用方）。
    pub disabled_rules: Option<Vec<String>>,
    /// 省略时保留已存储的自定义规则。
    pub custom_rules: Option<Vec<PrivacyCustomRuleNapi>>,
}

#[napi(object)]
pub struct PrivacyCustomRuleNapi {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub group: u32,
    pub replacement: String,
    pub enabled: bool,
}

impl From<PrivacyCustomRule> for PrivacyCustomRuleNapi {
    fn from(rule: PrivacyCustomRule) -> Self {
        PrivacyCustomRuleNapi {
            id: rule.id,
            name: rule.name,
            pattern: rule.pattern,
            group: rule.group,
            replacement: rule.replacement,
            enabled: rule.enabled,
        }
    }
}

impl From<PrivacyCustomRuleNapi> for PrivacyCustomRule {
    fn from(rule: PrivacyCustomRuleNapi) -> Self {
        PrivacyCustomRule {
            id: rule.id,
            name: rule.name,
            pattern: rule.pattern,
            group: rule.group,
            replacement: rule.replacement,
            enabled: rule.enabled,
        }
    }
}

#[napi(object)]
pub struct PrivacyRuleInfoNapi {
    pub id: String,
    pub group: String,
    pub label: String,
    pub example: String,
}

impl From<PrivacySettings> for PrivacySettingsNapi {
    fn from(settings: PrivacySettings) -> Self {
        PrivacySettingsNapi {
            enabled: settings.enabled,
            mode: settings.mode,
            api: PrivacyApiConfigNapi {
                url: settings.api.url,
                api_key: settings.api.api_key,
                model: settings.api.model,
            },
            tool_results: PrivacyToolResultsConfigNapi {
                tools: settings.tool_results.tools,
            },
            disabled_rules: Some(settings.disabled_rules),
            custom_rules: Some(settings.custom_rules.into_iter().map(Into::into).collect()),
        }
    }
}

impl From<PrivacySettingsNapi> for PrivacySettings {
    fn from(settings: PrivacySettingsNapi) -> Self {
        PrivacySettings {
            enabled: settings.enabled,
            mode: settings.mode,
            api: PrivacyApiConfig {
                url: settings.api.url,
                api_key: settings.api.api_key,
                model: settings.api.model,
            },
            tool_results: PrivacyToolResultsConfig {
                tools: settings.tool_results.tools,
            },
            disabled_rules: settings.disabled_rules.unwrap_or_default(),
            custom_rules: settings
                .custom_rules
                .map(|rules| rules.into_iter().map(Into::into).collect())
                .unwrap_or_default(),
        }
    }
}

#[napi]
pub async fn get_privacy_settings() -> napi::Result<PrivacySettingsNapi> {
    let settings = tokio::task::spawn_blocking(crate::storage::get_privacy_settings)
        .await
        .map_err(map_spawn_error)??;
    Ok(settings.into())
}

#[napi]
pub async fn set_privacy_settings(settings: PrivacySettingsNapi) -> napi::Result<()> {
    let keep_rules = settings.disabled_rules.is_none();
    let keep_custom = settings.custom_rules.is_none();
    let mut settings: PrivacySettings = settings.into();
    tokio::task::spawn_blocking(move || {
        if !keep_custom {
            crate::mcp::privacy_mask::custom_rules::validate_rules(&settings.custom_rules)
                .map_err(|error| Error::new(Status::InvalidArg, error))?;
        }
        if keep_rules || keep_custom {
            let stored = crate::storage::get_privacy_settings()?;
            if keep_rules {
                settings.disabled_rules = stored.disabled_rules;
            }
            if keep_custom {
                settings.custom_rules = stored.custom_rules;
            }
        }
        crate::storage::set_privacy_settings(settings)
    })
    .await
    .map_err(map_spawn_error)?
}

/// 保存编辑器中的自定义规则 JSON（整体替换），返回规范化后的规则。
#[napi]
pub async fn save_privacy_custom_rules(content: String) -> napi::Result<Vec<PrivacyCustomRuleNapi>> {
    tokio::task::spawn_blocking(move || {
        let mut settings = crate::storage::get_privacy_settings()?;
        let rules = crate::mcp::privacy_mask::custom_rules::parse_rules_text(
            &content,
            &settings.custom_rules,
        )
        .map_err(|error| Error::new(Status::InvalidArg, error))?;
        settings.custom_rules = rules.clone();
        crate::storage::set_privacy_settings(settings)?;
        Ok(rules.into_iter().map(Into::into).collect())
    })
    .await
    .map_err(map_spawn_error)?
}

/// 按传入的规则状态（未保存的表单亦可）预览本地脱敏结果。
#[napi]
pub async fn preview_privacy_mask(
    sample: String,
    disabled_rules: Vec<String>,
    custom_rules: Vec<PrivacyCustomRuleNapi>,
) -> napi::Result<String> {
    let custom: Vec<PrivacyCustomRule> = custom_rules.into_iter().map(Into::into).collect();
    tokio::task::spawn_blocking(move || {
        crate::mcp::privacy_mask::mask_local_with(&sample, &disabled_rules, &custom)
    })
    .await
    .map_err(map_spawn_error)
}

/// 本地脱敏规则目录（静态数据，供隐私设置页渲染开关）。
#[napi]
pub async fn list_privacy_rules() -> napi::Result<Vec<PrivacyRuleInfoNapi>> {
    Ok(crate::mcp::privacy_mask::PRIVACY_RULES
        .iter()
        .map(|rule| PrivacyRuleInfoNapi {
            id: rule.id.to_string(),
            group: rule.group.to_string(),
            label: rule.label.to_string(),
            example: rule.example.to_string(),
        })
        .collect())
}
