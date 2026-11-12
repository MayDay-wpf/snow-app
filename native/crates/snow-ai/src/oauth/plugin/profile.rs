//! 插件订阅档案的元数据（config_json.oauthPlugin）与插件返回的令牌集合。

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use crate::oauth::provider::now_epoch_secs;

/// 与内置 provider 的 `oauth` 键分开存放，内置逻辑不会误读插件档案。
pub const METADATA_KEY: &str = "oauthPlugin";

fn read_text(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn object_or_empty(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({})
    }
}

fn pick_fresh(fresh: &str, existing: &str) -> String {
    if fresh.trim().is_empty() {
        existing.to_string()
    } else {
        fresh.to_string()
    }
}

pub struct PluginTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub email: String,
    pub account_id: String,
    pub plan_type: String,
    pub data: Option<Value>,
}

impl PluginTokens {
    pub fn from_value(value: &Value) -> Result<PluginTokens> {
        let object = value
            .as_object()
            .ok_or_else(|| Error::from_reason("OAuth plugin returned no token set"))?;
        let access_token = read_text(object, "accessToken");
        if access_token.is_empty() {
            return Err(Error::from_reason(
                "OAuth plugin token set does not include an accessToken",
            ));
        }
        Ok(PluginTokens {
            access_token,
            refresh_token: read_text(object, "refreshToken"),
            expires_at: object.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
            email: read_text(object, "email"),
            account_id: read_text(object, "accountId"),
            plan_type: read_text(object, "planType"),
            data: object.get("data").filter(|data| data.is_object()).cloned(),
        })
    }
}

#[derive(Clone, Default)]
pub struct PluginProfileMetadata {
    pub provider: String,
    pub plugin_id: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub account_id: String,
    pub email: String,
    pub plan_type: String,
    pub data: Value,
}

impl PluginProfileMetadata {
    pub fn to_json(&self) -> Value {
        json!({
            "provider": self.provider,
            "pluginId": self.plugin_id,
            "refreshToken": self.refresh_token,
            "expiresAt": self.expires_at,
            "accountId": self.account_id,
            "email": self.email,
            "planType": self.plan_type,
            "data": object_or_empty(&self.data),
            "obtainedAt": now_epoch_secs(),
        })
    }

    pub fn from_value(value: &Value) -> Option<PluginProfileMetadata> {
        let object = value.as_object()?;
        let provider = read_text(object, "provider");
        if provider.is_empty() {
            return None;
        }
        Some(PluginProfileMetadata {
            provider,
            plugin_id: read_text(object, "pluginId"),
            refresh_token: read_text(object, "refreshToken"),
            expires_at: object.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
            account_id: read_text(object, "accountId"),
            email: read_text(object, "email"),
            plan_type: read_text(object, "planType"),
            data: object
                .get("data")
                .map(object_or_empty)
                .unwrap_or_else(|| json!({})),
        })
    }

    pub fn from_config_json(config_json: &str) -> Option<PluginProfileMetadata> {
        let parsed: Value = serde_json::from_str(config_json).ok()?;
        parsed
            .get(METADATA_KEY)
            .and_then(PluginProfileMetadata::from_value)
    }

    pub fn from_tokens(provider: &str, plugin_id: &str, tokens: &PluginTokens) -> Self {
        PluginProfileMetadata {
            provider: provider.to_string(),
            plugin_id: plugin_id.to_string(),
            refresh_token: tokens.refresh_token.clone(),
            expires_at: tokens.expires_at,
            account_id: tokens.account_id.clone(),
            email: tokens.email.clone(),
            plan_type: tokens.plan_type.clone(),
            data: tokens.data.clone().unwrap_or_else(|| json!({})),
        }
    }

    /// 刷新结果合并：空字段沿用旧值，data 浅合并。
    pub fn merged(&self, tokens: &PluginTokens) -> Self {
        let mut data = object_or_empty(&self.data);
        if let (Some(target), Some(Value::Object(fresh))) = (data.as_object_mut(), &tokens.data) {
            for (key, value) in fresh {
                target.insert(key.clone(), value.clone());
            }
        }
        PluginProfileMetadata {
            provider: self.provider.clone(),
            plugin_id: self.plugin_id.clone(),
            refresh_token: pick_fresh(&tokens.refresh_token, &self.refresh_token),
            expires_at: tokens.expires_at,
            account_id: pick_fresh(&tokens.account_id, &self.account_id),
            email: pick_fresh(&tokens.email, &self.email),
            plan_type: pick_fresh(&tokens.plan_type, &self.plan_type),
            data,
        }
    }

    /// 传给插件钩子的账号上下文。
    pub fn account_context(&self, access_token: &str, profile_name: &str, base_url: &str) -> Value {
        json!({
            "accessToken": access_token,
            "refreshToken": self.refresh_token,
            "expiresAt": self.expires_at,
            "accountId": self.account_id,
            "email": self.email,
            "planType": self.plan_type,
            "data": object_or_empty(&self.data),
            "profileName": profile_name,
            "baseUrl": base_url,
        })
    }
}

pub fn is_plugin_profile(config_json: &str) -> bool {
    PluginProfileMetadata::from_config_json(config_json).is_some()
}

pub fn merge_into_config(config_json: &str, metadata: &PluginProfileMetadata) -> String {
    let mut parsed: Value = serde_json::from_str(config_json).unwrap_or_else(|_| json!({}));
    if !parsed.is_object() {
        parsed = json!({});
    }
    if let Some(object) = parsed.as_object_mut() {
        object.insert(METADATA_KEY.to_string(), metadata.to_json());
    }
    parsed.to_string()
}
