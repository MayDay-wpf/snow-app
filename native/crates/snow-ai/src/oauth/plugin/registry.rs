//! 插件 provider 注册表：主进程推送插件声明，Rust 侧同步读取（请求头模板等）。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde::Deserialize;
use serde_json::Value;

use super::host;
use crate::oauth::provider::OAuthProviderId;

const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_MAX_CONTEXT_TOKENS: i32 = 200_000;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginHooks {
    pub authorize: bool,
    pub poll: bool,
    pub refresh: bool,
    pub models: bool,
    pub quota: bool,
    pub transform_request: bool,
    /// 非 SSE 整段响应改写。
    pub transform_response: bool,
    /// SSE 事件逐条改写。
    pub on_response_chunk: bool,
    /// 插件接管传输层。
    pub fetch: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginProviderSpec {
    pub id: String,
    pub plugin_id: String,
    pub display_name: String,
    pub description: String,
    pub icon: String,
    pub flow: String,
    pub callback_ports: Vec<u16>,
    pub callback_path: String,
    pub redirect_host: String,
    pub base_url: String,
    pub request_method: String,
    pub default_model: String,
    pub max_context_tokens: Option<i32>,
    pub max_tokens: Option<i32>,
    pub supports_vision: bool,
    pub header_scheme_name: String,
    /// 固定身份请求头，登录时写入同名自定义请求头方案。
    pub headers: HashMap<String, String>,
    /// 每次请求按账号渲染的请求头模板（{{accessToken}} / {{accountId}} / {{data.x}} 等）。
    pub request_headers: HashMap<String, String>,
    pub refresh_lead_secs: i64,
    /// 渲染层自定义登录面板入口（相对插件目录）。
    pub panel_entry: String,
    /// 自定义登录面板标题；为空时用 provider 名称。
    pub panel_title: String,
    pub hooks: PluginHooks,
}

impl PluginProviderSpec {
    pub fn flow(&self) -> &str {
        match self.flow.trim() {
            "device" => "device",
            "manual" => "manual",
            "panel" => "panel",
            _ => "redirect",
        }
    }

    pub fn has_panel(&self) -> bool {
        !self.panel_entry.trim().is_empty()
    }

    pub fn redirect_host(&self) -> &str {
        let host = self.redirect_host.trim();
        if host.is_empty() {
            "127.0.0.1"
        } else {
            host
        }
    }

    pub fn callback_path(&self) -> String {
        let path = self.callback_path.trim();
        if path.is_empty() {
            "/callback".to_string()
        } else if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        }
    }

    pub fn request_method(&self) -> &str {
        match self.request_method.trim() {
            "responses" => "responses",
            "anthropic" => "anthropic",
            "gemini" => "gemini",
            _ => "chat",
        }
    }

    pub fn max_context_tokens(&self) -> i32 {
        self.max_context_tokens
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MAX_CONTEXT_TOKENS)
    }

    pub fn label(&self) -> &str {
        let name = self.display_name.trim();
        if name.is_empty() {
            self.id.as_str()
        } else {
            name
        }
    }

    pub fn source(&self) -> String {
        format!("oauth-{}", self.id)
    }
}

static REGISTRY: LazyLock<RwLock<Vec<Arc<PluginProviderSpec>>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));

/// 小写字母数字与 . _ -，且不能占用内置 provider id。
pub fn is_valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
        && OAuthProviderId::parse(id).is_none()
}

pub fn parse_specs(raw: &str) -> Result<Vec<PluginProviderSpec>> {
    let specs: Vec<PluginProviderSpec> = serde_json::from_str(raw)
        .map_err(|error| Error::from_reason(format!("Invalid OAuth plugin providers: {error}")))?;
    let mut seen = Vec::<String>::new();
    Ok(specs
        .into_iter()
        .filter(|spec| is_valid_provider_id(&spec.id))
        .filter(|spec| {
            if seen.contains(&spec.id) {
                return false;
            }
            seen.push(spec.id.clone());
            true
        })
        .collect())
}

pub fn replace_all(specs: Vec<PluginProviderSpec>) -> usize {
    let count = specs.len();
    *REGISTRY.write().unwrap_or_else(|poisoned| poisoned.into_inner()) =
        specs.into_iter().map(Arc::new).collect();
    count
}

pub fn list() -> Vec<Arc<PluginProviderSpec>> {
    REGISTRY
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

pub fn get(id: &str) -> Option<Arc<PluginProviderSpec>> {
    REGISTRY
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .find(|spec| spec.id == id)
        .cloned()
}

fn insert(spec: Arc<PluginProviderSpec>) {
    let mut specs = REGISTRY.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    specs.retain(|existing| existing.id != spec.id);
    specs.push(spec);
}

/// 注册表缺失时（如启动后尚未同步）向主进程按 id 索取声明。
pub async fn ensure(id: &str) -> Result<Arc<PluginProviderSpec>> {
    let id = id.trim();
    if let Some(spec) = get(id) {
        return Ok(spec);
    }
    let missing = || {
        Error::from_reason(format!(
            "OAuth plugin provider '{id}' is not installed or is disabled"
        ))
    };
    if !is_valid_provider_id(id) {
        return Err(missing());
    }
    let value = host::call("describe", id, Value::Null, DESCRIBE_TIMEOUT).await?;
    if value.is_null() {
        return Err(missing());
    }
    let spec: PluginProviderSpec = serde_json::from_value(value)
        .map_err(|error| Error::from_reason(format!("Invalid OAuth plugin provider: {error}")))?;
    if spec.id != id {
        return Err(missing());
    }
    let spec = Arc::new(spec);
    insert(Arc::clone(&spec));
    Ok(spec)
}
