use std::path::Path;

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use super::{
    get_system_setting_value, set_system_setting, DEFAULT_PRIVACY_SETTING_CODE,
    DEFAULT_PRIVACY_SETTING_NAME,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacyApiConfig {
    pub url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacyToolResultsConfig {
    pub tools: Vec<String>,
}

/// 用户自定义脱敏规则（Rust regex 语法）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacyCustomRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    /// 遮罩的捕获组序号，0 为整段匹配。
    pub group: u32,
    /// 替换文本；为空时按字符数替换为 *。
    pub replacement: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySettings {
    pub enabled: bool,
    pub mode: String,
    pub api: PrivacyApiConfig,
    pub tool_results: PrivacyToolResultsConfig,
    /// 已关闭的本地脱敏规则 id；缺省为空即全部启用。
    pub disabled_rules: Vec<String>,
    pub custom_rules: Vec<PrivacyCustomRule>,
}

impl PrivacySettings {
    fn normalize(&mut self) {
        self.mode = self.mode.trim().to_string();
        if self.mode.is_empty() {
            self.mode = "local".to_string();
        }
        self.api.url = self.api.url.trim().to_string();
        self.api.api_key = self.api.api_key.trim().to_string();
        self.api.model = self.api.model.trim().to_string();
        if self.api.model.is_empty() {
            self.api.model = "openai/privacy-filter".to_string();
        }
        self.tool_results.tools = normalize_names(&self.tool_results.tools);
        self.disabled_rules = normalize_names(&self.disabled_rules);
        for rule in &mut self.custom_rules {
            rule.id = rule.id.trim().to_string();
            rule.name = rule.name.trim().to_string();
        }
        self.custom_rules.retain(|rule| !rule.id.is_empty() && !rule.pattern.is_empty());
    }
}

fn normalize_names(names: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for name in names {
        let name = name.trim();
        if !name.is_empty() && !result.iter().any(|item| item == name) {
            result.push(name.to_string());
        }
    }
    result
}

pub fn get_privacy_settings(database_path: &Path) -> Result<PrivacySettings> {
    let Some(raw_value) = get_system_setting_value(database_path, DEFAULT_PRIVACY_SETTING_CODE)?
    else {
        return Ok(PrivacySettings::default());
    };

    let mut settings = serde_json::from_str::<PrivacySettings>(&raw_value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse privacy settings: {error}"),
        )
    })?;
    settings.normalize();
    Ok(settings)
}

pub fn set_privacy_settings(database_path: &Path, settings: &PrivacySettings) -> Result<()> {
    let mut normalized = settings.clone();
    normalized.normalize();
    let setting_value = serde_json::to_string(&normalized).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize privacy settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        DEFAULT_PRIVACY_SETTING_NAME,
        DEFAULT_PRIVACY_SETTING_CODE,
        &setting_value,
    )
}
