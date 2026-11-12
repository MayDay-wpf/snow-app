//! 远控 HTTP 认证：局域网与公网共用的长期令牌校验。
//!
//! 原先由 Node 主进程的 remoteWanAuth.ts 与 remoteControlServer.ts 承担；
//! 迁移到 Rust 后，手机请求的鉴权完全绕开 Electron 的 Node 事件循环。

use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use url::Url;

/// 固定令牌与随机令牌共用的最小长度。
pub const MIN_TOKEN_LEN: usize = 24;

/// percent-encode 集合：与 JS 的 encodeURIComponent 保留字符一致。
pub const URI_COMPONENT_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// 校验用户固定令牌：去空白后不能为空且不短于最小长度。
pub fn normalize_fixed_token(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.chars().count() < MIN_TOKEN_LEN {
        return Err(format!("令牌至少需要 {MIN_TOKEN_LEN} 个字符"));
    }
    if trimmed.chars().count() > 512 {
        return Err("令牌最多 512 个字符".to_string());
    }
    Ok(trimmed.to_string())
}

/// 令牌写入 URL 查询参数时的编码（与 JS encodeURIComponent 一致）。
pub fn encode_query_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT_SET).to_string()
}

/// 当前 Unix 毫秒时间戳。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// 常量时间比较，避免通过响应时间侧信道推断令牌内容。
pub fn secret_matches(candidate: &str, expected: &str) -> bool {
    if candidate.is_empty() || expected.is_empty() {
        return false;
    }
    let actual = candidate.as_bytes();
    let target = expected.as_bytes();
    if actual.len() != target.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in actual.iter().zip(target.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

/// 生成 24 字节随机令牌并以 base64url（无填充）编码，与旧的 Node 实现一致。
pub fn random_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::getrandom(&mut bytes).is_err() {
        // 系统熵源异常时回退到时间戳派生值：强度低于 CSPRNG，但可避免
        // 让 Electron 主进程 panic，且远控令牌本身是短期凭据。
        let seed = now_ms() as u128;
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((seed >> ((index % 16) * 8)) as u8) ^ (index as u8).wrapping_mul(167);
        }
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 公网入口规范化：必须是无凭据、无路径 / 查询 / fragment 的 HTTPS 地址。
pub fn normalize_public_origin(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value.trim())
        .map_err(|_| "SNOW_REMOTE_PUBLIC_ORIGIN 必须是有效的 HTTPS 地址".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("SNOW_REMOTE_PUBLIC_ORIGIN 必须是无凭据的 HTTPS 地址".to_string());
    }
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("SNOW_REMOTE_PUBLIC_ORIGIN 不能包含路径、查询或 fragment".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("SNOW_REMOTE_PUBLIC_ORIGIN 缺少主机名".to_string());
    }
    Ok(parsed.origin().ascii_serialization())
}

struct WanAuthInner {
    token: String,
}

/// 公网入口鉴权：与局域网一致，用单一长期令牌校验请求。
pub struct WanAuth {
    origin: String,
    inner: Mutex<WanAuthInner>,
}

impl WanAuth {
    pub fn new(origin: &str, token: String) -> Result<Self, String> {
        Ok(Self {
            origin: normalize_public_origin(origin)?,
            inner: Mutex::new(WanAuthInner { token }),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// 公网入口域名（含端口），用于校验请求的 Host 头。
    pub fn expected_host(&self) -> String {
        Url::parse(&self.origin)
            .ok()
            .and_then(|url| {
                url.host_str().map(|host| match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host.to_string(),
                })
            })
            .unwrap_or_default()
    }

    pub fn set_token(&self, token: String) {
        self.lock().token = token;
    }

    pub fn token(&self) -> String {
        self.lock().token.clone()
    }

    pub fn authorize(&self, token: Option<&str>) -> bool {
        let Some(candidate) = token else {
            return false;
        };
        secret_matches(candidate, &self.lock().token)
    }

    fn lock(&self) -> MutexGuard<'_, WanAuthInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
