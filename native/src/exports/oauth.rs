use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::api::oauth::plugin::{self, host::OAuthPluginCallback};
use crate::api::oauth::provider::{refresh_if_needed, OAuthProviderId};
use crate::api::oauth::quota::{self, QuotaSnapshot};
use crate::api::oauth::sessions::{self, LoginProvider};
use crate::storage::services::api_configs as api_configs_service;
use crate::storage::{ensure_database_file, ApiConfigRecord};

#[napi(object)]
pub struct OAuthProviderInfo {
    pub id: String,
    pub display_name: String,
    pub default_model: String,
    pub default_max_context_tokens: i32,
    /// redirect | manual | device
    pub flow: String,
    /// 插件提供的说明与图标（data: / https: URL），内置 provider 为空。
    pub description: Option<String>,
    pub icon: Option<String>,
    /// 来源插件 id；内置 provider 为空。
    pub plugin_id: Option<String>,
    /// 插件通过 `fetch` 接管传输层：原生流式、重试与工具归一化不再生效。
    pub takes_over_transport: bool,
    /// 插件渲染层自定义登录面板入口；为空时使用宿主默认面板。
    pub panel_entry: Option<String>,
    /// 自定义登录面板标题。
    pub panel_title: Option<String>,
}

#[napi(object)]
pub struct OAuthLoginStart {
    pub session_id: String,
    pub provider: String,
    pub auth_url: String,
    pub port: u32,
    pub manual_mode: bool,
    pub default_model: String,
    pub flow: String,
    pub user_code: Option<String>,
    pub instructions: Option<String>,
    /// 自定义面板上下文：state / PKCE / 插件会话。
    pub state: String,
    pub nonce: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_verifier: String,
    /// 插件 authorize() 返回的会话数据（JSON 字符串，无则为空）。
    pub plugin_session: Option<String>,
}

#[napi(object)]
pub struct OAuthLoginStatus {
    pub provider: String,
    pub status: String,
    pub error: Option<String>,
    pub profile_name: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub available_models: Vec<String>,
    pub auth_url: String,
    pub manual_mode: bool,
    pub flow: String,
    pub user_code: Option<String>,
    pub instructions: Option<String>,
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn to_status(view: sessions::OAuthStatusView) -> OAuthLoginStatus {
    let outcome = view.outcome;
    OAuthLoginStatus {
        provider: view.provider,
        status: view.status.to_string(),
        error: view.error,
        profile_name: outcome.as_ref().map(|outcome| outcome.profile_name.clone()),
        display_name: outcome.as_ref().map(|outcome| outcome.display_name.clone()),
        email: outcome.as_ref().map(|outcome| outcome.email.clone()),
        plan_type: outcome.as_ref().map(|outcome| outcome.plan_type.clone()),
        available_models: outcome
            .as_ref()
            .map(|outcome| outcome.available_models.clone())
            .unwrap_or_default(),
        auth_url: view.auth_url,
        manual_mode: view.manual_mode,
        flow: view.flow,
        user_code: non_empty(view.user_code),
        instructions: non_empty(view.instructions),
    }
}

/// 内置 provider 在前，插件 provider 按主进程推送顺序追加。
#[napi(js_name = "listOAuthProviders")]
pub fn list_oauth_providers() -> Vec<OAuthProviderInfo> {
    let builtin = OAuthProviderId::all().iter().map(|provider| OAuthProviderInfo {
        id: provider.as_str().to_string(),
        display_name: provider.display_name().to_string(),
        default_model: provider.default_model().to_string(),
        default_max_context_tokens: provider.default_max_context_tokens(),
        flow: "redirect".to_string(),
        description: None,
        icon: None,
        plugin_id: None,
        takes_over_transport: false,
        panel_entry: None,
        panel_title: None,
    });
    let plugins = plugin::registry::list().into_iter().map(|spec| OAuthProviderInfo {
        id: spec.id.clone(),
        display_name: spec.label().to_string(),
        default_model: spec.default_model.clone(),
        default_max_context_tokens: spec.max_context_tokens(),
        flow: spec.flow().to_string(),
        description: non_empty(spec.description.clone()),
        icon: non_empty(spec.icon.clone()),
        plugin_id: non_empty(spec.plugin_id.clone()),
        takes_over_transport: spec.hooks.fetch,
        panel_entry: non_empty(spec.panel_entry.clone()),
        panel_title: non_empty(spec.panel_title.clone()),
    });
    builtin.chain(plugins).collect()
}

/// 注册（或清除）OAuth 插件宿主回调，主进程启动时调用一次。
#[napi(js_name = "setOAuthPluginHandler")]
pub fn set_oauth_plugin_handler(handler: Option<OAuthPluginCallback>) {
    plugin::host::set_handler(handler);
}

/// 主进程推送当前启用的插件 provider 声明（JSON 数组），整体替换，返回生效数量。
#[napi(js_name = "setOAuthPluginProviders")]
pub fn set_oauth_plugin_providers(specs_json: String) -> Result<u32> {
    let specs = plugin::registry::parse_specs(&specs_json)?;
    Ok(plugin::registry::replace_all(specs) as u32)
}

/// OAuth 插件钩子：创建 / 更新自定义请求头方案，可同时绑定到插件档案（JSON 入参，返回 JSON）。
#[napi(js_name = "upsertOAuthPluginHeaderScheme")]
pub async fn upsert_oauth_plugin_header_scheme(payload_json: String) -> Result<String> {
    Ok(plugin::schemes::upsert(payload_json).await?.to_string())
}

/// OAuth 插件钩子：把请求头方案绑定到插件自己的 OAuth 档案（JSON 入参）。
#[napi(js_name = "bindOAuthPluginHeaderScheme")]
pub async fn bind_oauth_plugin_header_scheme(payload_json: String) -> Result<()> {
    plugin::schemes::bind(payload_json).await
}

/// OAuth 插件钩子：删除自定义请求头方案并清空相关档案绑定。
#[napi(js_name = "deleteOAuthPluginHeaderScheme")]
pub async fn delete_oauth_plugin_header_scheme(scheme_id: String) -> Result<bool> {
    plugin::schemes::remove(scheme_id).await
}

/// `fetch` 钩子的流式正文：主进程每读到一块就推入，返回 false 表示通道已关闭。
#[napi(js_name = "pushOAuthPluginStreamChunk")]
pub fn push_oauth_plugin_stream_chunk(stream_id: u32, chunk: Buffer) -> bool {
    plugin::stream::push(stream_id, chunk.to_vec())
}

/// `fetch` 钩子的流式正文结束（正常读完或读取出错），返回 false 表示通道已关闭。
#[napi(js_name = "endOAuthPluginStream")]
pub fn end_oauth_plugin_stream(stream_id: u32) -> bool {
    plugin::stream::close(stream_id)
}

#[napi(js_name = "startOAuthLogin")]
pub async fn start_oauth_login(
    provider: String,
    advanced_model: Option<String>,
    basic_model: Option<String>,
) -> Result<OAuthLoginStart> {
    let provider = LoginProvider::resolve(&provider).await?;
    let result = sessions::start_login(provider, advanced_model, basic_model).await?;
    Ok(OAuthLoginStart {
        session_id: result.session_id,
        provider: result.provider,
        auth_url: result.auth_url,
        port: result.port as u32,
        manual_mode: result.manual_mode,
        default_model: result.default_model,
        flow: result.flow,
        user_code: non_empty(result.user_code),
        instructions: non_empty(result.instructions),
        state: result.state,
        nonce: result.nonce,
        redirect_uri: result.redirect_uri,
        code_challenge: result.code_challenge,
        code_verifier: result.code_verifier,
        plugin_session: if result.plugin_session.is_null() {
            None
        } else {
            Some(result.plugin_session.to_string())
        },
    })
}

/// 自定义面板拿到令牌后提交，落库为对应插件档案并收敛登录会话。
#[napi(js_name = "submitOAuthLoginTokens")]
pub async fn submit_oauth_login_tokens(
    session_id: String,
    tokens_json: String,
) -> Result<OAuthLoginStatus> {
    let session_id = session_id.trim().to_string();
    let value: serde_json::Value = serde_json::from_str(&tokens_json)
        .map_err(|error| Error::from_reason(format!("Invalid OAuth token set: {error}")))?;
    let tokens = plugin::PluginTokens::from_value(&value)?;
    sessions::complete_with_tokens(&session_id, tokens).await?;
    sessions::get_status(&session_id)
        .map(to_status)
        .ok_or_else(|| Error::from_reason("Login session not found or expired"))
}

#[napi(js_name = "getOAuthLoginStatus")]
pub async fn get_oauth_login_status(session_id: String) -> Result<Option<OAuthLoginStatus>> {
    Ok(sessions::get_status(session_id.trim()).map(to_status))
}

#[napi(js_name = "submitOAuthCallback")]
pub async fn submit_oauth_callback(
    session_id: String,
    callback_url: String,
) -> Result<OAuthLoginStatus> {
    let session_id = session_id.trim().to_string();
    let Some(session) = sessions::get_session(&session_id) else {
        return Err(Error::from_reason("Login session not found or expired"));
    };

    let params = sessions::parse_callback_input(&callback_url);
    if params.is_empty() {
        return Err(Error::from_reason("The callback URL is empty or invalid"));
    }

    sessions::handle_callback_request(&session, &params)
        .await
        .map_err(Error::from_reason)?;

    sessions::get_status(&session_id)
        .map(to_status)
        .ok_or_else(|| Error::from_reason("Login session not found or expired"))
}

#[napi(js_name = "cancelOAuthLogin")]
pub async fn cancel_oauth_login(session_id: String) -> Result<bool> {
    Ok(sessions::cancel_login(session_id.trim()))
}

#[napi(object)]
pub struct OAuthQuotaBucket {
    pub key: String,
    pub label: String,
    pub remaining_percent: Option<f64>,
    pub reset_at_ms: Option<f64>,
}

#[napi(object)]
pub struct OAuthQuotaGroup {
    pub id: String,
    pub label: String,
    pub buckets: Vec<OAuthQuotaBucket>,
}

#[napi(object)]
pub struct OAuthQuotaSnapshot {
    pub provider: String,
    pub plan: Option<String>,
    pub groups: Vec<OAuthQuotaGroup>,
    pub fetched_at_ms: f64,
}

fn to_quota_snapshot(snapshot: QuotaSnapshot) -> OAuthQuotaSnapshot {
    OAuthQuotaSnapshot {
        provider: snapshot.provider,
        plan: snapshot.plan,
        groups: snapshot
            .groups
            .into_iter()
            .map(|group| OAuthQuotaGroup {
                id: group.id,
                label: group.label,
                buckets: group
                    .buckets
                    .into_iter()
                    .map(|bucket| OAuthQuotaBucket {
                        key: bucket.key,
                        label: bucket.label,
                        remaining_percent: bucket.remaining_percent,
                        reset_at_ms: bucket.reset_at_ms,
                    })
                    .collect(),
            })
            .collect(),
        fetched_at_ms: snapshot.fetched_at_ms,
    }
}

async fn load_api_config(profile_name: String) -> Result<ApiConfigRecord> {
    tokio::task::spawn_blocking(move || -> Result<ApiConfigRecord> {
        let database_path = ensure_database_file()?;
        api_configs_service::list_api_configs(&database_path)?
            .into_iter()
            .find(|config| config.profile_name == profile_name)
            .ok_or_else(|| Error::from_reason("API profile not found"))
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load API profile: {error}")))?
}

#[napi(js_name = "getOAuthQuota")]
pub async fn get_oauth_quota(profile_name: String) -> Result<OAuthQuotaSnapshot> {
    let config = load_api_config(profile_name.trim().to_string()).await?;
    let config = refresh_if_needed(config).await?;
    let snapshot = quota::fetch_snapshot(&config).await?;
    Ok(to_quota_snapshot(snapshot))
}
