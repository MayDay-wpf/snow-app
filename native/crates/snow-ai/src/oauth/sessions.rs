use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::plugin::{self, login as plugin_login, login::PollOutcome, PluginTokens};
use super::provider::{self, OAuthProfileMetadata, OAuthProviderId};
use super::{anthropic, antigravity, chatgpt, codex, xai};
use snow_storage_core::bootstrap::ensure_database_file;

const LOGIN_SESSION_TIMEOUT_SECS: u64 = 15 * 60;
const DEVICE_POLL_DEFAULT_SECS: u64 = 5;
const DEVICE_POLL_MIN_SECS: u64 = 2;
const DEVICE_SLOW_DOWN_SECS: u64 = 5;

/// 登录对象：内置 provider 或插件注册的 provider。
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LoginProvider {
    Builtin(OAuthProviderId),
    Plugin(String),
}

impl LoginProvider {
    pub fn id(&self) -> String {
        match self {
            LoginProvider::Builtin(provider) => provider.as_str().to_string(),
            LoginProvider::Plugin(id) => id.clone(),
        }
    }

    pub async fn resolve(value: &str) -> Result<LoginProvider> {
        if let Some(provider) = OAuthProviderId::parse(value) {
            return Ok(LoginProvider::Builtin(provider));
        }
        let id = value.trim().to_ascii_lowercase();
        plugin::registry::ensure(&id)
            .await
            .map(|spec| LoginProvider::Plugin(spec.id.clone()))
            .map_err(|error| {
                Error::from_reason(format!(
                    "Unsupported OAuth provider: {} ({})",
                    value.trim(),
                    error.reason
                ))
            })
    }
}

#[derive(Clone)]
pub struct OAuthLoginSession {
    pub session_id: String,
    pub provider: LoginProvider,
    /// redirect | manual | device
    pub flow: String,
    pub state: String,
    pub nonce: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub callback_path: String,
    pub auth_url: String,
    pub local_port: u16,
    pub manual_mode: bool,
    pub user_code: String,
    pub instructions: String,
    /// 插件 authorize() 返回的会话数据，原样回传给 exchange()/poll()。
    pub plugin_session: Value,
    pub advanced_model: String,
    pub basic_model: String,
}

#[derive(Clone)]
pub struct OAuthLoginOutcome {
    pub provider: String,
    pub profile_name: String,
    pub display_name: String,
    pub email: String,
    pub plan_type: String,
    pub account_id: String,
    pub available_models: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OAuthLoginStatus {
    Pending,
    Success,
    Error,
    Cancelled,
}

impl OAuthLoginStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            OAuthLoginStatus::Pending => "pending",
            OAuthLoginStatus::Success => "success",
            OAuthLoginStatus::Error => "error",
            OAuthLoginStatus::Cancelled => "cancelled",
        }
    }
}

pub struct OAuthLoginEntry {
    pub session: OAuthLoginSession,
    pub status: OAuthLoginStatus,
    pub error: Option<String>,
    pub outcome: Option<OAuthLoginOutcome>,
    pub shutdown: Option<oneshot::Sender<()>>,
    pub completing: bool,
}

/// 登录完成的输入：浏览器回调（code + 全部参数）或设备码轮询得到的令牌。
pub enum CompletionInput {
    Callback {
        code: String,
        params: HashMap<String, String>,
    },
    Tokens(PluginTokens),
}

static SESSIONS: LazyLock<Mutex<HashMap<String, OAuthLoginEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, OAuthLoginEntry>> {
    SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct StartLoginResult {
    pub session_id: String,
    pub provider: String,
    pub auth_url: String,
    pub port: u16,
    pub manual_mode: bool,
    pub default_model: String,
    pub flow: String,
    pub user_code: String,
    pub instructions: String,
    /// 面板自定义登录所需上下文（PKCE / state / 插件会话）。
    pub state: String,
    pub nonce: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_verifier: String,
    pub plugin_session: Value,
}

async fn bind_first(ports: &[u16]) -> (Option<TcpListener>, u16) {
    for candidate in ports {
        if let Ok(bound) = TcpListener::bind(("127.0.0.1", *candidate)).await {
            return (Some(bound), *candidate);
        }
    }
    (None, ports.first().copied().unwrap_or(0))
}

/// 插件未声明端口时使用系统分配的空闲端口。
async fn bind_plugin_listener(ports: &[u16]) -> (Option<TcpListener>, u16) {
    if !ports.is_empty() {
        return bind_first(ports).await;
    }
    match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(bound) => {
            let port = bound.local_addr().map(|addr| addr.port()).unwrap_or(0);
            (Some(bound), port)
        }
        Err(_) => (None, 0),
    }
}

fn build_redirect_uri(host: &str, port: u16, path: &str) -> String {
    if port > 0 {
        format!("http://{host}:{port}{path}")
    } else {
        format!("http://{host}{path}")
    }
}

/// 登记会话、按需启动回调监听，并在超时后自动取消。
fn register_session(session: OAuthLoginSession, listener: Option<TcpListener>, timeout_secs: u64) {
    let session_id = session.session_id.clone();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    if let Some(listener) = listener {
        tokio::spawn(super::server::serve_callback(
            listener,
            session.clone(),
            shutdown_rx,
        ));
    } else {
        drop(shutdown_rx);
    }

    lock_sessions().insert(
        session_id.clone(),
        OAuthLoginEntry {
            session,
            status: OAuthLoginStatus::Pending,
            error: None,
            outcome: None,
            shutdown: Some(shutdown_tx),
            completing: false,
        },
    );

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(timeout_secs)).await;
        if is_pending(&session_id) {
            cancel_login(&session_id);
        }
    });
}

pub async fn start_login(
    provider: LoginProvider,
    advanced_model: Option<String>,
    basic_model: Option<String>,
) -> Result<StartLoginResult> {
    let advanced_model = advanced_model.unwrap_or_default().trim().to_string();
    let basic_model = basic_model.unwrap_or_default().trim().to_string();
    match provider {
        LoginProvider::Builtin(provider) => {
            start_builtin_login(provider, advanced_model, basic_model).await
        }
        LoginProvider::Plugin(id) => start_plugin_login(id, advanced_model, basic_model).await,
    }
}

async fn start_builtin_login(
    provider: OAuthProviderId,
    advanced_model: String,
    basic_model: String,
) -> Result<StartLoginResult> {
    let pkce = provider::generate_pkce()?;
    let state = provider::generate_state()?;
    let nonce = provider::generate_state()?;
    let session_id = uuid::Uuid::new_v4().to_string();

    let (listener, port) = bind_first(provider.callback_ports()).await;
    let manual_mode = listener.is_none();
    let callback_path = provider.callback_path().to_string();
    let redirect_uri = build_redirect_uri(provider.redirect_host(), port, &callback_path);
    let host_id = if provider == OAuthProviderId::ChatGpt {
        chatgpt::ensure_host_id().await?
    } else {
        String::new()
    };
    let auth_url =
        provider::build_authorize_url(provider, &redirect_uri, &pkce, &state, &nonce, &host_id)?;

    let session = OAuthLoginSession {
        session_id: session_id.clone(),
        provider: LoginProvider::Builtin(provider),
        flow: "redirect".to_string(),
        state: state.clone(),
        nonce: nonce.clone(),
        code_verifier: pkce.verifier.clone(),
        redirect_uri: redirect_uri.clone(),
        callback_path,
        auth_url: auth_url.clone(),
        local_port: if manual_mode { 0 } else { port },
        manual_mode,
        user_code: String::new(),
        instructions: String::new(),
        plugin_session: Value::Null,
        advanced_model,
        basic_model,
    };
    register_session(session, listener, LOGIN_SESSION_TIMEOUT_SECS);

    Ok(StartLoginResult {
        session_id,
        provider: provider.as_str().to_string(),
        auth_url,
        port,
        manual_mode,
        default_model: provider.default_model().to_string(),
        flow: "redirect".to_string(),
        user_code: String::new(),
        instructions: String::new(),
        state,
        nonce,
        redirect_uri,
        code_challenge: pkce.challenge,
        code_verifier: pkce.verifier,
        plugin_session: Value::Null,
    })
}

async fn start_plugin_login(
    provider_id: String,
    advanced_model: String,
    basic_model: String,
) -> Result<StartLoginResult> {
    let spec = plugin::registry::ensure(&provider_id).await?;
    let pkce = provider::generate_pkce()?;
    let state = provider::generate_state()?;
    let nonce = provider::generate_state()?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let flow = spec.flow().to_string();
    let callback_path = spec.callback_path();

    // panel 与 redirect 一样监听本机回调；面板也可自行完成登录。
    let listens_callback = flow == "redirect" || flow == "panel";
    let (listener, port) = if listens_callback {
        bind_plugin_listener(&spec.callback_ports).await
    } else {
        (None, spec.callback_ports.first().copied().unwrap_or(0))
    };
    let manual_mode = flow == "manual" || (listens_callback && listener.is_none());
    let default_redirect = if flow == "device" {
        String::new()
    } else {
        build_redirect_uri(spec.redirect_host(), port, &callback_path)
    };

    let authorized = if spec.hooks.authorize {
        plugin_login::authorize(
            &spec,
            &default_redirect,
            &state,
            &nonce,
            &pkce.verifier,
            &pkce.challenge,
        )
        .await?
    } else {
        plugin_login::AuthorizeResult {
            url: String::new(),
            redirect_uri: None,
            user_code: String::new(),
            instructions: String::new(),
            interval_secs: 0,
            expires_in_secs: 0,
            session: Value::Null,
        }
    };
    let redirect_uri = authorized
        .redirect_uri
        .clone()
        .unwrap_or(default_redirect);
    let timeout_secs = match authorized.expires_in_secs {
        0 => LOGIN_SESSION_TIMEOUT_SECS,
        expires => expires.min(LOGIN_SESSION_TIMEOUT_SECS * 2),
    };
    let session = OAuthLoginSession {
        session_id: session_id.clone(),
        provider: LoginProvider::Plugin(spec.id.clone()),
        flow: flow.clone(),
        state: state.clone(),
        nonce: nonce.clone(),
        code_verifier: pkce.verifier.clone(),
        redirect_uri: redirect_uri.clone(),
        callback_path,
        auth_url: authorized.url.clone(),
        local_port: if listener.is_some() { port } else { 0 },
        manual_mode,
        user_code: authorized.user_code.clone(),
        instructions: authorized.instructions.clone(),
        plugin_session: authorized.session.clone(),
        advanced_model,
        basic_model,
    };
    register_session(session.clone(), listener, timeout_secs);
    if flow == "device" {
        tokio::spawn(run_device_poll(session, authorized.interval_secs));
    }

    Ok(StartLoginResult {
        session_id,
        provider: spec.id.clone(),
        auth_url: authorized.url,
        port,
        manual_mode,
        default_model: spec.default_model.clone(),
        flow,
        user_code: authorized.user_code,
        instructions: authorized.instructions,
        state,
        nonce,
        redirect_uri,
        code_challenge: pkce.challenge,
        code_verifier: pkce.verifier,
        plugin_session: authorized.session,
    })
}

/// 设备码流程：按插件给出的间隔轮询，直到成功、出错、取消或超时。
async fn run_device_poll(session: OAuthLoginSession, interval_secs: u64) {
    let LoginProvider::Plugin(provider_id) = session.provider.clone() else {
        return;
    };
    let mut interval = match interval_secs {
        0 => DEVICE_POLL_DEFAULT_SECS,
        value => value.max(DEVICE_POLL_MIN_SECS),
    };
    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if !is_pending(&session.session_id) {
            return;
        }
        match plugin_login::poll(&session, &provider_id).await {
            Ok(PollOutcome::Pending { slow_down }) => {
                if slow_down {
                    interval += DEVICE_SLOW_DOWN_SECS;
                }
            }
            Ok(PollOutcome::Tokens(tokens)) => {
                let _ = complete_login(&session, CompletionInput::Tokens(tokens)).await;
                return;
            }
            Err(error) => {
                set_session_error(&session.session_id, error.reason.clone());
                return;
            }
        }
    }
}

pub struct OAuthStatusView {
    pub provider: String,
    pub status: &'static str,
    pub error: Option<String>,
    pub outcome: Option<OAuthLoginOutcome>,
    pub auth_url: String,
    pub manual_mode: bool,
    pub flow: String,
    pub user_code: String,
    pub instructions: String,
}

pub fn get_status(session_id: &str) -> Option<OAuthStatusView> {
    let sessions = lock_sessions();
    let entry = sessions.get(session_id)?;
    Some(OAuthStatusView {
        provider: entry.session.provider.id(),
        status: entry.status.as_str(),
        error: entry.error.clone(),
        outcome: entry.outcome.clone(),
        auth_url: entry.session.auth_url.clone(),
        manual_mode: entry.session.manual_mode,
        flow: entry.session.flow.clone(),
        user_code: entry.session.user_code.clone(),
        instructions: entry.session.instructions.clone(),
    })
}

pub fn get_session(session_id: &str) -> Option<OAuthLoginSession> {
    let sessions = lock_sessions();
    sessions.get(session_id).map(|entry| entry.session.clone())
}

/// 面板自行拿到令牌后提交：落库并收敛会话状态。
pub async fn complete_with_tokens(
    session_id: &str,
    tokens: PluginTokens,
) -> Result<OAuthLoginOutcome> {
    let Some(session) = get_session(session_id) else {
        return Err(Error::from_reason("Login session not found or expired"));
    };
    if !matches!(session.provider, LoginProvider::Plugin(_)) {
        return Err(Error::from_reason(
            "Only plugin OAuth providers support token completion",
        ));
    }
    complete_login(&session, CompletionInput::Tokens(tokens)).await
}

fn is_pending(session_id: &str) -> bool {
    lock_sessions()
        .get(session_id)
        .map(|entry| entry.status == OAuthLoginStatus::Pending)
        .unwrap_or(false)
}

pub fn cancel_login(session_id: &str) -> bool {
    let mut sessions = lock_sessions();
    let Some(entry) = sessions.get_mut(session_id) else {
        return false;
    };
    if entry.status != OAuthLoginStatus::Pending {
        return false;
    }
    if let Some(sender) = entry.shutdown.take() {
        let _ = sender.send(());
    }
    entry.status = OAuthLoginStatus::Cancelled;
    true
}

pub fn parse_callback_input(raw: &str) -> HashMap<String, String> {
    let trimmed = raw.trim();
    let mut params = HashMap::new();
    if trimmed.is_empty() {
        return params;
    }

    let query = trimmed
        .split_once('?')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let query = query.split('#').next().unwrap_or(query);

    if query.contains('=') {
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let decoded = url::form_urlencoded::parse(value.as_bytes())
                .map(|(value, _)| value.into_owned())
                .collect::<String>();
            if !key.is_empty() {
                params.insert(key.to_string(), decoded);
            }
        }
    } else {
        let state = trimmed
            .split_once('#')
            .map(|(_, state)| state.trim())
            .filter(|state| !state.is_empty());
        if !query.is_empty() {
            params.insert("raw_code".to_string(), query.to_string());
        }
        if let Some(state) = state {
            params.insert("state".to_string(), state.to_string());
        }
    }

    params
}

pub async fn handle_callback_request(
    session: &OAuthLoginSession,
    params: &HashMap<String, String>,
) -> std::result::Result<(), String> {
    if let Some(error) = params.get("error").filter(|value| !value.trim().is_empty()) {
        let description = params
            .get("error_description")
            .map(String::as_str)
            .unwrap_or("");
        let message = if description.trim().is_empty() {
            format!("Authorization failed: {error}")
        } else {
            format!("Authorization failed: {description}")
        };
        set_session_error(&session.session_id, message.clone());
        return Err(message);
    }

    let state = params.get("state").map(String::as_str).unwrap_or("");
    if !state.is_empty() && state != session.state {
        return Err("Authorization state mismatch; please restart the login".to_string());
    }

    let code = params
        .get("code")
        .or_else(|| params.get("raw_code"))
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Missing authorization code".to_string())?
        .to_string();

    complete_login(
        session,
        CompletionInput::Callback {
            code,
            params: params.clone(),
        },
    )
    .await
    .map(|_| ())
    .map_err(|error| error.reason.clone())
}

fn set_session_error(session_id: &str, message: String) {
    let mut sessions = lock_sessions();
    if let Some(entry) = sessions.get_mut(session_id) {
        if entry.status == OAuthLoginStatus::Pending {
            entry.status = OAuthLoginStatus::Error;
            entry.error = Some(message);
            if let Some(sender) = entry.shutdown.take() {
                let _ = sender.send(());
            }
        }
    }
}

fn finish_session(session_id: &str, result: &Result<OAuthLoginOutcome>) {
    let mut sessions = lock_sessions();
    let Some(entry) = sessions.get_mut(session_id) else {
        return;
    };
    entry.completing = false;
    match result {
        Ok(outcome) => {
            entry.status = OAuthLoginStatus::Success;
            entry.outcome = Some(outcome.clone());
            entry.error = None;
        }
        Err(error) => {
            if entry.status == OAuthLoginStatus::Pending {
                entry.status = OAuthLoginStatus::Error;
                entry.error = Some(error.reason.clone());
            }
        }
    }
    if let Some(sender) = entry.shutdown.take() {
        let _ = sender.send(());
    }
}

async fn complete_login(
    session: &OAuthLoginSession,
    input: CompletionInput,
) -> Result<OAuthLoginOutcome> {
    {
        let mut sessions = lock_sessions();
        let Some(entry) = sessions.get_mut(&session.session_id) else {
            return Err(Error::from_reason("Login session not found or expired"));
        };
        if matches!(entry.status, OAuthLoginStatus::Success) {
            if let Some(outcome) = entry.outcome.clone() {
                return Ok(outcome);
            }
        }
        if entry.completing {
            return Err(Error::from_reason("Login is already being completed"));
        }
        entry.completing = true;
    }

    let result = perform_login(session, input).await;
    finish_session(&session.session_id, &result);
    result
}

async fn perform_login(
    session: &OAuthLoginSession,
    input: CompletionInput,
) -> Result<OAuthLoginOutcome> {
    match (&session.provider, input) {
        (LoginProvider::Builtin(provider), CompletionInput::Callback { code, params }) => {
            perform_builtin_login(session, *provider, &code, &params).await
        }
        (LoginProvider::Plugin(id), CompletionInput::Callback { code, params }) => {
            let tokens = plugin_login::exchange(session, id, &code, &params).await?;
            plugin_login::finish(session, id, tokens).await
        }
        (LoginProvider::Plugin(id), CompletionInput::Tokens(tokens)) => {
            plugin_login::finish(session, id, tokens).await
        }
        (LoginProvider::Builtin(_), CompletionInput::Tokens(_)) => Err(Error::from_reason(
            "Built-in OAuth providers do not support token completion",
        )),
    }
}

async fn perform_builtin_login(
    session: &OAuthLoginSession,
    provider: OAuthProviderId,
    code: &str,
    params: &HashMap<String, String>,
) -> Result<OAuthLoginOutcome> {
    let issued_client_id = params
        .get("client_id")
        .map(String::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let tokens = provider::exchange_code(
        provider,
        code,
        &session.redirect_uri,
        &session.code_verifier,
        &session.state,
        &issued_client_id,
    )
    .await?;
    if provider == OAuthProviderId::ChatGpt {
        chatgpt::verify_identity(&tokens.id_token, &session.nonce)?;
    }
    let claims = match provider {
        OAuthProviderId::Codex | OAuthProviderId::ChatGpt => codex::parse_claims(&tokens.id_token),
        OAuthProviderId::Anthropic => anthropic::parse_claims(&tokens),
        OAuthProviderId::Antigravity => antigravity::parse_claims(&tokens),
        OAuthProviderId::Xai => xai::parse_claims(&tokens.id_token),
    };
    let metadata = OAuthProfileMetadata {
        provider,
        client_id: issued_client_id,
        refresh_token: tokens.refresh_token.clone(),
        account_id: claims.account_id.clone(),
        email: claims.email.clone(),
        plan_type: claims.plan_type.clone(),
        expires_at: tokens.expires_at,
    };

    let available_models =
        match provider::fetch_models(provider, &tokens.access_token, &claims.account_id).await {
            Ok(models) => models,
            Err(_) => Vec::new(),
        };

    let advanced_model = pick_model(provider, &session.advanced_model, &available_models);
    let basic_model = pick_model(provider, &session.basic_model, &available_models);

    let prepared = provider::prepare_profile(
        provider,
        &claims,
        &metadata,
        &tokens.access_token,
        &advanced_model,
        &basic_model,
    );
    let database_path = ensure_database_file()?;
    provider::persist_profile(database_path, provider, prepared.input).await?;

    Ok(OAuthLoginOutcome {
        provider: provider.as_str().to_string(),
        profile_name: prepared.profile_name,
        display_name: prepared.display_name,
        email: claims.email,
        plan_type: claims.plan_type,
        account_id: claims.account_id,
        available_models,
    })
}

fn pick_model(provider: OAuthProviderId, configured: &str, available: &[String]) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    if let Some(first) = available.first() {
        return first.clone();
    }
    provider.default_model().to_string()
}
