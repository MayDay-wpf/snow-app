//! 统一的代理 HTTP 客户端工厂。
//!
//! 所有 API 请求（Anthropic / Gemini / OpenAI Chat / Responses /
//! Embedding / Reranking / Vision / Summary / Codebase Review）都应
//! 通过此模块创建 `reqwest::Client`，确保代理设置一致：
//!
//! - 当用户启用了代理（`proxy_browser_settings.enabled == true`）时，
//!   所有请求通过 `http://127.0.0.1:{port}` 发出。
//! - 当代理未启用时，返回默认 builder（reqwest 默认会跟随系统代理
//!   环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 等）。
//!
//! 代理配置存储在数据库 `system_settings` 表中，setting_code 为
//! `proxy_browser_settings`，JSON 结构与前端
//! `ProxyBrowserSettings` 类型一致。

use std::sync::OnceLock;
use std::time::Duration;

use napi::bindgen_prelude::*;

const PROXY_BROWSER_SETTING_CODE: &str = "proxy_browser_settings";
const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
const DEFAULT_PROXY_PORT: u16 = 7890;
const DEFAULT_NO_PROXY: &str =
    "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10";

/// 从数据库加载的代理配置快照。
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub no_proxy: Vec<String>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: DEFAULT_PROXY_HOST.to_string(),
            port: DEFAULT_PROXY_PORT,
            no_proxy: Vec::new(),
        }
    }
}

/// 清理代理主机字符串：去除协议前缀和首尾空白，
/// 为空时回退到默认值。
fn sanitize_proxy_host(host: &str) -> String {
    let trimmed = host.trim();
    let stripped = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    let result = stripped.trim();
    if result.is_empty() {
        DEFAULT_PROXY_HOST.to_string()
    } else {
        result.to_string()
    }
}

impl ProxyConfig {
    /// 将代理设置应用到一个 `reqwest::ClientBuilder` 上。
    ///
    /// 当 `enabled` 为 false 时直接返回原 builder，由 reqwest 默认
    /// 跟随系统代理环境变量。当 `enabled` 为 true 时注入
    /// `http://{host}:{port}` 代理。
    pub fn apply(self, mut builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder> {
        if let Some(proxy) = self.build_proxy()? {
            builder = builder.proxy(proxy);
        }
        Ok(builder)
    }

    /// 与 [`ProxyConfig::apply`] 相同，但作用于同步的 `reqwest::blocking`
    /// 客户端构建器（模型列表拉取等同步链路）。
    pub fn apply_blocking(
        self,
        mut builder: reqwest::blocking::ClientBuilder,
    ) -> Result<reqwest::blocking::ClientBuilder> {
        if let Some(proxy) = self.build_proxy()? {
            builder = builder.proxy(proxy);
        }
        Ok(builder)
    }

    fn build_proxy(&self) -> Result<Option<reqwest::Proxy>> {
        let Some(url) = self.proxy_url() else {
            return Ok(None);
        };
        let proxy = reqwest::Proxy::all(url)
            .map_err(|error| Error::from_reason(format!("Invalid proxy settings: {error}")))?
            .no_proxy(reqwest::NoProxy::from_string(&self.no_proxy_list()));
        Ok(Some(proxy))
    }

    /// 启用代理时返回 `http://{host}:{port}`，否则返回 None
    /// （由 reqwest 默认跟随系统代理环境变量）。
    pub fn proxy_url(&self) -> Option<String> {
        self.enabled
            .then(|| format!("http://{}:{}", self.host, self.port))
    }

    pub fn no_proxy_list(&self) -> String {
        let mut entries: Vec<String> = DEFAULT_NO_PROXY
            .split(',')
            .map(str::to_string)
            .collect();
        entries.extend(self.no_proxy.iter().cloned());
        for key in ["NO_PROXY", "no_proxy"] {
            if let Ok(value) = std::env::var(key) {
                entries.extend(
                    value
                        .split(',')
                        .map(|item| item.trim().to_string())
                        .filter(|item| !item.is_empty()),
                );
            }
        }
        entries.join(",")
    }
}

/// 从数据库异步加载代理配置。
///
/// 内部使用 `spawn_blocking` 读取数据库，不会阻塞 Node.js 主线程。
pub async fn load_proxy_config() -> Result<ProxyConfig> {
    tokio::task::spawn_blocking(load_proxy_config_sync)
        .await
        .map_err(|join_error| {
            Error::from_reason(format!("Failed to load proxy config: {join_error}"))
        })?
}

/// 从数据库同步加载代理配置，仅供本身已是同步阻塞的链路使用
/// （如 `reqwest::blocking` 的模型列表拉取）。
pub fn load_proxy_config_sync() -> Result<ProxyConfig> {
    let database_path = snow_storage_core::bootstrap::ensure_database_file()?;

    let raw = snow_storage_core::system_settings::get_system_setting_value(
        &database_path,
        PROXY_BROWSER_SETTING_CODE,
    )?
    .unwrap_or_default();

    Ok(parse_proxy_config(&raw))
}

pub async fn resolve_transport_proxy_url(config: &ProxyConfig, secure: bool) -> Option<String> {
    if let Some(url) = config.proxy_url() {
        return Some(url);
    }
    tokio::task::spawn_blocking(move || system_proxy_url(secure))
        .await
        .ok()
        .flatten()
}

fn system_proxy_url(secure: bool) -> Option<String> {
    let keys = if secure {
        ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
    } else {
        ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
    };
    keys.iter()
        .filter_map(|key| std::env::var(key).ok())
        .find_map(|value| normalize_http_proxy_url(&value))
        .or_else(|| os_system_proxy_url(secure))
}

fn normalize_http_proxy_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let authority = candidate.strip_prefix("http://")?;
    if authority.trim().is_empty() {
        return None;
    }
    Some(candidate)
}

#[cfg(target_os = "macos")]
fn os_system_proxy_url(secure: bool) -> Option<String> {
    use system_configuration::core_foundation::number::CFNumber;
    use system_configuration::core_foundation::string::CFString;
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;
    use system_configuration::sys::schema_definitions::{
        kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPPort, kSCPropNetProxiesHTTPProxy,
        kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSPort, kSCPropNetProxiesHTTPSProxy,
    };

    let proxies = SCDynamicStoreBuilder::new("snow-app").build()?.get_proxies()?;
    let (enabled_key, host_key, port_key) = if secure {
        (
            unsafe { kSCPropNetProxiesHTTPSEnable },
            unsafe { kSCPropNetProxiesHTTPSProxy },
            unsafe { kSCPropNetProxiesHTTPSPort },
        )
    } else {
        (
            unsafe { kSCPropNetProxiesHTTPEnable },
            unsafe { kSCPropNetProxiesHTTPProxy },
            unsafe { kSCPropNetProxiesHTTPPort },
        )
    };

    let enabled = proxies
        .find(enabled_key)
        .and_then(|flag| flag.downcast::<CFNumber>())
        .and_then(|flag| flag.to_i32())
        .unwrap_or(0)
        == 1;
    if !enabled {
        return None;
    }

    let host = proxies
        .find(host_key)
        .and_then(|host| host.downcast::<CFString>())
        .map(|host| host.to_string())?;
    let authority = match proxies
        .find(port_key)
        .and_then(|port| port.downcast::<CFNumber>())
        .and_then(|port| port.to_i32())
    {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    normalize_http_proxy_url(&authority)
}

#[cfg(target_os = "windows")]
fn os_system_proxy_url(secure: bool) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            KEY_READ,
        )
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    parse_windows_proxy_server(&server, secure)
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(server: &str, secure: bool) -> Option<String> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('=') {
        return normalize_http_proxy_url(trimmed);
    }
    let wanted = if secure { "https" } else { "http" };
    trimmed
        .split(';')
        .filter_map(|entry| entry.split_once('='))
        .find(|(scheme, _)| scheme.trim().eq_ignore_ascii_case(wanted))
        .and_then(|(_, value)| normalize_http_proxy_url(value))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_system_proxy_url(_secure: bool) -> Option<String> {
    None
}

/// 解析代理配置 JSON。
fn parse_proxy_config(raw: &str) -> ProxyConfig {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return ProxyConfig::default();
    };

    let enabled = value
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let host = value
        .get("host")
        .and_then(serde_json::Value::as_str)
        .map(sanitize_proxy_host)
        .unwrap_or_else(|| DEFAULT_PROXY_HOST.to_string());

    let port = value
        .get("port")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i as u64)))
        .filter(|&p| (1..=65535).contains(&(p as u16)))
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PROXY_PORT);

    let no_proxy = parse_no_proxy_entries(
        value
            .get("noProxy")
            .or_else(|| value.get("no_proxy")),
    );

    ProxyConfig {
        enabled,
        host,
        port,
        no_proxy,
    }
}

/// 解析配置中的 `noProxy` 字段，支持逗号分隔字符串与字符串数组。
fn parse_no_proxy_entries(value: Option<&serde_json::Value>) -> Vec<String> {
    fn split(text: &str) -> Vec<String> {
        text.split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect()
    }

    match value {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(serde_json::Value::as_str)
            .flat_map(split)
            .collect(),
        Some(serde_json::Value::String(text)) => split(text),
        _ => Vec::new(),
    }
}

/// 统一的应用 User-Agent（Telegram Desktop 风格）。
///
/// 所有通过此模块创建的 HTTP 客户端默认携带该 UA，保证服务端
/// 能识别请求来源与应用版本。格式：
/// `Snow-App/<version> Snow App (<OS>; <arch>)`
///
/// 该 UA 设置在 client 的默认头上：当用户启用了自定义请求头
/// （custom-headers）并在 scheme 中显式配置了 `User-Agent` 时，
/// 请求级 header 会覆盖此默认值，尊重用户的覆盖。
pub fn app_user_agent() -> String {
    format!(
        "Snow-App/{} Snow App ({})",
        env!("CARGO_PKG_VERSION"),
        ua_platform()
    )
}

/// UA 中的平台描述（仿 Telegram Desktop），携带真实操作系统版本。
/// 例如：`Windows NT 10.0.26100; Win64; x64`、`Macintosh; ARM64 Mac OS X 15_3_1`。
/// 首次调用时检测一次并缓存（进程生命周期内不变），后续零开销。
fn ua_platform() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(detect_platform)
}

/// 检测真实操作系统信息。
fn detect_platform() -> String {
    #[cfg(target_os = "windows")]
    {
        let nt = windows_nt_version().unwrap_or_else(|| "10.0".to_string());
        match std::env::consts::ARCH {
            "aarch64" => format!("Windows NT {nt}; Win64; ARM64"),
            _ => format!("Windows NT {nt}; Win64; x64"),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let arch = if std::env::consts::ARCH == "aarch64" {
            "ARM64"
        } else {
            "Intel"
        };
        match macos_version() {
            Some(ver) => format!("Macintosh; {arch} Mac OS X {ver}"),
            None => format!("Macintosh; {arch} Mac OS X"),
        }
    }
    #[cfg(target_os = "linux")]
    {
        match linux_distro() {
            Some(distro) => format!("X11; Linux {} ({distro})", std::env::consts::ARCH),
            None => format!("X11; Linux {}", std::env::consts::ARCH),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        format!("{}; {}", std::env::consts::OS, std::env::consts::ARCH)
    }
}

/// Windows：读取注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`
/// 的 `CurrentBuildNumber`（如 26100）与 `UBR`（如 1150），拼成
/// `10.0.26100.1150`。失败时回退到 `10.0`。
#[cfg(target_os = "windows")]
fn windows_nt_version() -> Option<String> {
    const SUBKEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let build = reg_query_value(SUBKEY, "CurrentBuildNumber")?;
    let ubr = reg_query_value(SUBKEY, "UBR").unwrap_or_default();
    Some(if ubr.is_empty() {
        format!("10.0.{build}")
    } else {
        format!("10.0.{build}.{ubr}")
    })
}

#[cfg(target_os = "windows")]
fn reg_query_value(subkey: &str, name: &str) -> Option<String> {
    // 统一经 utils::process::cmd 创建：Windows 下自动携带
    // CREATE_NO_WINDOW，避免 spawn reg.exe 时控制台窗口一闪而过。
    let output = snow_process::process::cmd("reg")
        .args(["query", subkey, "/v", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // 输出行形如：`    CurrentBuildNumber    REG_SZ    26100`
    text.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with(name) {
            trimmed.split_whitespace().last().map(|v| v.to_string())
        } else {
            None
        }
    })
}

/// macOS：`sw_vers -productVersion` 获取真实版本（如 15.3.1），
/// 点号转下划线（浏览器 / Telegram 惯例：`15_3_1`）。
#[cfg(target_os = "macos")]
fn macos_version() -> Option<String> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version.replace('.', "_"))
    }
}

/// Linux：解析 `/etc/os-release` 的 `PRETTY_NAME`（如 `Ubuntu 24.04.1 LTS`），
/// 回退到 `VERSION_ID`（如 `24.04`）。
#[cfg(target_os = "linux")]
fn linux_distro() -> Option<String> {
    let content = std::fs::read_to_string("/etc/os-release").ok()?;
    let pretty = content.lines().find_map(|line| {
        line.strip_prefix("PRETTY_NAME=")
            .map(|v| v.trim_matches('"').trim().to_string())
    });
    let version_id = content.lines().find_map(|line| {
        line.strip_prefix("VERSION_ID=")
            .map(|v| v.trim_matches('"').trim().to_string())
    });
    pretty.or(version_id).filter(|v| !v.is_empty())
}

/// 创建带代理设置的默认 HTTP 客户端。
///
/// 适用于不需要额外自定义（timeout / default_headers 等）的场景。
/// 客户端默认携带统一的应用 User-Agent（见 [`app_user_agent`]）。
pub async fn build_proxied_client() -> Result<reqwest::Client> {
    let config = load_proxy_config().await?;
    let builder = config.apply(reqwest::Client::builder().user_agent(app_user_agent()))?;
    builder
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))
}

/// 创建带代理设置和自定义超时的 HTTP 客户端。
///
/// 客户端默认携带统一的应用 User-Agent（见 [`app_user_agent`]）。
pub async fn build_proxied_client_with_timeout(timeout: Duration) -> Result<reqwest::Client> {
    let config = load_proxy_config().await?;
    let builder = config.apply(
        reqwest::Client::builder()
            .user_agent(app_user_agent())
            .timeout(timeout),
    )?;
    builder
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))
}
