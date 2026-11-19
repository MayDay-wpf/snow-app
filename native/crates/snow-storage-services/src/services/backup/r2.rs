//! Cloudflare R2 后端：通过 S3 兼容 API（AWS SigV4 签名）读写备份对象。
//!
//! 连接配置保存在应用数据库的 system_settings 中，与 API 配置一致由界面
//! 回显并可切换明文查看。所有请求都运行在调用方的 blocking 线程里。

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use hmac::{Hmac, Mac};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use reqwest::blocking::{Client, Response};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::store::ObjectStore;
use super::BACKUP_DIR_NAME;

const CONFIG_SETTING_CODE: &str = "backup_r2_config";
const CONFIG_SETTING_NAME: &str = "数据备份 R2 配置";
/// R2 只有一个逻辑区域，SigV4 固定使用 `auto`。
const REGION: &str = "auto";
const SERVICE: &str = "s3";
const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// 网络抖动或服务端繁忙时的最大尝试次数。
const MAX_ATTEMPTS: u32 = 3;
/// 数据库快照的本地临时工作区：R2 后端没有本地备份根目录，放到系统临时目录。
const WORK_DIR_NAME: &str = "snow-app-backup-work";

type HmacSha256 = Hmac<Sha256>;

/// 持久化的 R2 连接配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredR2Config {
    account_id: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    prefix: String,
}

/// 界面读写的 R2 配置。
#[napi(object)]
pub struct BackupR2Config {
    pub account_id: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// 存储桶内的路径前缀（可为空）。
    pub prefix: String,
}

fn load_stored_config() -> Result<StoredR2Config> {
    let database_path = crate::ensure_database_file()?;
    let raw = crate::services::system_settings::get_system_setting_value(
        &database_path,
        CONFIG_SETTING_CODE,
    )?
    .unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(StoredR2Config::default());
    }
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// 读取已保存的 R2 配置。
pub fn get_r2_config() -> Result<BackupR2Config> {
    let stored = load_stored_config()?;
    Ok(BackupR2Config {
        account_id: stored.account_id,
        bucket: stored.bucket,
        access_key_id: stored.access_key_id,
        secret_access_key: stored.secret_access_key,
        prefix: stored.prefix,
    })
}

/// 规整并校验界面提交的配置。
fn resolve_config(input: BackupR2Config) -> Result<StoredR2Config> {
    let config = StoredR2Config {
        account_id: input.account_id.trim().to_string(),
        bucket: input.bucket.trim().to_string(),
        access_key_id: input.access_key_id.trim().to_string(),
        secret_access_key: input.secret_access_key.trim().to_string(),
        prefix: normalize_prefix(&input.prefix)?,
    };
    validate_config(&config)?;
    Ok(config)
}

/// 保存 R2 配置。
pub fn set_r2_config(input: BackupR2Config) -> Result<()> {
    let config = resolve_config(input)?;
    let json = serde_json::to_string(&config).map_err(|error| {
        Error::from_reason(format!("Failed to serialize R2 settings: {error}"))
    })?;
    let database_path = crate::ensure_database_file()?;
    crate::services::system_settings::set_system_setting(
        &database_path,
        CONFIG_SETTING_NAME,
        CONFIG_SETTING_CODE,
        &json,
    )
}

/// 用给定配置（未保存的表单值也可）发起一次列举请求，验证凭据与存储桶可用。
pub fn test_r2_config(input: BackupR2Config) -> Result<()> {
    R2Store::new(resolve_config(input)?)?.check()
}

fn validate_config(config: &StoredR2Config) -> Result<()> {
    if config.account_id.is_empty()
        || !config
            .account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(Error::from_reason(
            "R2 Account ID is required and may only contain letters and digits",
        ));
    }
    let bucket_valid = (3..=63).contains(&config.bucket.len())
        && config
            .bucket
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !config.bucket.starts_with('-')
        && !config.bucket.ends_with('-');
    if !bucket_valid {
        return Err(Error::from_reason(
            "R2 bucket name must be 3-63 characters of lowercase letters, digits and hyphens",
        ));
    }
    if config.access_key_id.is_empty() {
        return Err(Error::from_reason("R2 Access Key ID is required"));
    }
    if config.secret_access_key.is_empty() {
        return Err(Error::from_reason("R2 Secret Access Key is required"));
    }
    Ok(())
}

/// 规整存储桶内的路径前缀：去掉首尾斜杠，只允许安全字符且禁止 `..`。
fn normalize_prefix(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_matches('/');
    let valid = trimmed.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/')
    }) && !trimmed.split('/').any(|part| part.is_empty() || part == "..");
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if !valid {
        return Err(Error::from_reason(
            "R2 path prefix may only contain letters, digits, '-', '_', '.' and '/'",
        ));
    }
    Ok(trimmed.to_string())
}

/// R2 后端：key 映射为 `<prefix>/snow-app-backup/<key>` 对象。
pub(crate) struct R2Store {
    client: Client,
    config: StoredR2Config,
    host: String,
    /// 对象 key 的统一前缀（以 `/` 结尾）。
    root: String,
}

impl R2Store {
    /// 读取已保存的配置并创建后端。
    pub(crate) fn open() -> Result<Self> {
        let config = load_stored_config()?;
        if config.account_id.is_empty() || config.bucket.is_empty() {
            return Err(Error::from_reason(
                "Cloudflare R2 is not configured yet; fill in the R2 settings first",
            ));
        }
        validate_config(&config)?;
        Self::new(config)
    }

    fn new(config: StoredR2Config) -> Result<Self> {
        let proxy = snow_net::http_client::load_proxy_config_sync().unwrap_or_default();
        let builder = Client::builder()
            .user_agent(snow_net::http_client::app_user_agent())
            .connect_timeout(Duration::from_secs(20))
            // 单个请求最多携带一个 8 MB 的块，慢速网络下也留足上传时间。
            .timeout(Duration::from_secs(300));
        let client = proxy
            .apply_blocking(builder)?
            .build()
            .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))?;
        let host = format!("{}.r2.cloudflarestorage.com", config.account_id);
        let root = if config.prefix.is_empty() {
            format!("{BACKUP_DIR_NAME}/")
        } else {
            format!("{}/{BACKUP_DIR_NAME}/", config.prefix)
        };
        Ok(Self {
            client,
            config,
            host,
            root,
        })
    }

    /// 发起一次最小的列举请求，确认凭据与存储桶可用。
    fn check(&self) -> Result<()> {
        let query = vec![
            ("list-type".to_string(), "2".to_string()),
            ("max-keys".to_string(), "1".to_string()),
            ("prefix".to_string(), self.root.clone()),
        ];
        let response = self.send(Method::GET, "", &query, Vec::new())?;
        ensure_success(response, "test the R2 connection").map(|_| ())
    }

    fn object_key(&self, key: &str) -> String {
        format!("{}{key}", self.root)
    }

    /// 签名并发送请求；网络错误、429 与 5xx 会退避后重试。
    fn send(
        &self,
        method: Method,
        object_key: &str,
        query: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<Response> {
        let path = if object_key.is_empty() {
            format!("/{}", self.config.bucket)
        } else {
            format!("/{}/{object_key}", self.config.bucket)
        };
        let canonical_uri = encode_path(&path);
        let canonical_query = canonical_query(query);
        let payload_hash = if body.is_empty() {
            EMPTY_PAYLOAD_SHA256.to_string()
        } else {
            hex(&Sha256::digest(&body))
        };
        let url = if canonical_query.is_empty() {
            format!("https://{}{canonical_uri}", self.host)
        } else {
            format!("https://{}{canonical_uri}?{canonical_query}", self.host)
        };

        let mut attempt = 0;
        loop {
            attempt += 1;
            let now = chrono::Utc::now();
            let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
            let authorization = self.authorization(
                method.as_str(),
                &canonical_uri,
                &canonical_query,
                &payload_hash,
                &amz_date,
            )?;

            let mut request = self
                .client
                .request(method.clone(), &url)
                .header("x-amz-date", &amz_date)
                .header("x-amz-content-sha256", &payload_hash)
                .header("authorization", authorization);
            if !body.is_empty() {
                request = request.body(body.clone());
            }

            let retryable = match request.send() {
                Ok(response) => {
                    let status = response.status();
                    if attempt < MAX_ATTEMPTS
                        && (status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS)
                    {
                        format!("HTTP {}", status.as_u16())
                    } else {
                        return Ok(response);
                    }
                }
                Err(error) => {
                    if attempt >= MAX_ATTEMPTS {
                        return Err(Error::from_reason(format!(
                            "Cloudflare R2 request failed: {error}"
                        )));
                    }
                    error.to_string()
                }
            };
            eprintln!("Cloudflare R2 request retry {attempt}/{MAX_ATTEMPTS}: {retryable}");
            thread::sleep(Duration::from_millis(500 * u64::from(attempt)));
        }
    }

    /// 计算 AWS SigV4 Authorization 头。
    fn authorization(
        &self,
        method: &str,
        canonical_uri: &str,
        canonical_query: &str,
        payload_hash: &str,
        amz_date: &str,
    ) -> Result<String> {
        let date = &amz_date[..8];
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_request = format!(
            "{method}\n{canonical_uri}\n{canonical_query}\nhost:{}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n\n{signed_headers}\n{payload_hash}",
            self.host
        );
        let scope = format!("{date}/{REGION}/{SERVICE}/aws4_request");
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex(&Sha256::digest(canonical_request.as_bytes()))
        );

        let secret = format!("AWS4{}", self.config.secret_access_key);
        let date_key = hmac_sha256(secret.as_bytes(), date)?;
        let region_key = hmac_sha256(&date_key, REGION)?;
        let service_key = hmac_sha256(&region_key, SERVICE)?;
        let signing_key = hmac_sha256(&service_key, "aws4_request")?;
        let signature = hex(&hmac_sha256(&signing_key, &string_to_sign)?);

        Ok(format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.config.access_key_id
        ))
    }
}

impl ObjectStore for R2Store {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let response = self.send(Method::GET, &self.object_key(key), &[], Vec::new())?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = ensure_success(response, "download a backup object")?;
        let bytes = response.bytes().map_err(|error| {
            Error::from_reason(format!("Failed to download backup object '{key}': {error}"))
        })?;
        Ok(Some(bytes.to_vec()))
    }

    fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let response = self.send(Method::PUT, &self.object_key(key), &[], bytes.to_vec())?;
        ensure_success(response, "upload a backup object").map(|_| ())
    }

    fn delete(&self, key: &str) -> Result<()> {
        let response = self.send(Method::DELETE, &self.object_key(key), &[], Vec::new())?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        ensure_success(response, "delete a backup object").map(|_| ())
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let full_prefix = self.object_key(prefix);
        let mut keys = Vec::new();
        let mut continuation: Option<String> = None;

        loop {
            let mut query = vec![
                ("list-type".to_string(), "2".to_string()),
                ("prefix".to_string(), full_prefix.clone()),
            ];
            if let Some(token) = &continuation {
                query.push(("continuation-token".to_string(), token.clone()));
            }
            let response = self.send(Method::GET, "", &query, Vec::new())?;
            let response = ensure_success(response, "list backup objects")?;
            let xml = response.text().map_err(|error| {
                Error::from_reason(format!("Failed to read R2 listing: {error}"))
            })?;

            for key in xml_values(&xml, "Key") {
                if let Some(relative) = key.strip_prefix(&self.root) {
                    keys.push(relative.to_string());
                }
            }

            let truncated = xml_values(&xml, "IsTruncated")
                .first()
                .is_some_and(|value| value == "true");
            continuation = xml_values(&xml, "NextContinuationToken").into_iter().next();
            if !truncated || continuation.is_none() {
                break;
            }
        }

        Ok(keys)
    }

    fn work_root(&self) -> PathBuf {
        std::env::temp_dir().join(WORK_DIR_NAME)
    }
}

/// 非 2xx 响应转成带 R2 错误码的错误信息。
fn ensure_success(response: Response, action: &str) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().unwrap_or_default();
    let code = xml_values(&body, "Code").into_iter().next();
    let message = xml_values(&body, "Message").into_iter().next();
    let detail = match (code, message) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (Some(code), None) => code,
        (None, Some(message)) => message,
        (None, None) => format!("HTTP {}", status.as_u16()),
    };
    Err(Error::from_reason(format!(
        "Failed to {action} on Cloudflare R2 ({detail})"
    )))
}

fn hmac_sha256(key: &[u8], data: &str) -> Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|error| Error::from_reason(format!("Failed to sign R2 request: {error}")))?;
    mac.update(data.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SigV4 的 URI 编码：只保留 RFC 3986 非保留字符。
fn uri_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn encode_path(path: &str) -> String {
    path.split('/').map(uri_encode).collect::<Vec<_>>().join("/")
}

/// 规范化查询串：键值分别编码后按键排序。
fn canonical_query(query: &[(String, String)]) -> String {
    let mut pairs: Vec<(String, String)> = query
        .iter()
        .map(|(key, value)| (uri_encode(key), uri_encode(value)))
        .collect();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// 从 S3 XML 响应中取出指定标签的全部文本值（已反转义）。
fn xml_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut values = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        values.push(xml_unescape(&after[..end]));
        rest = &after[end + close.len()..];
    }
    values
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
