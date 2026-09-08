#![allow(non_snake_case)]

//! Local browser credential import: probe installed browsers (Chrome /
//! Edge / Chromium / Firefox) and decrypt their saved passwords and cookies,
//! plus plain-text bookmark (favorites) import.
//!
//! Decryption follows each browser's official algorithm:
//!
//! - Chrome family on macOS: key from the system Keychain item
//!   "Chrome Safe Storage" / "Microsoft Edge Safe Storage", then
//!   PBKDF2-HMAC-SHA1(salt = "saltysalt", 1003 rounds) -> AES-128-CBC
//!   (IV = 16 spaces) over the "v10"-prefixed payload.
//!   Cookie 库 schema v24+（Chrome 133+）的解密明文还附加了 32 字节
//!   SHA-256 哈希前缀，写入前需要剥离。
//! - Chrome family on Windows: DPAPI-unprotect the `encrypted_key` stored in
//!   `Local State`, then AES-256-GCM (nonce 12 + tag 16) over the payload.
//!   Chrome/Edge 127+ 的 App-Bound Encryption（v20 密文）：对
//!   `os_crypt.app_bound_encrypted_key` 依次做 SYSTEM DPAPI（SYSTEM 进程令牌模拟，
//!   需管理员权限）与用户 DPAPI 解密，再按 flag 分支恢复 32 字节
//!   `app_bound_key`（127-132：AES-256-GCM 硬编码密钥；133-136：
//!   ChaCha20-Poly1305 硬编码密钥；137+：CNG "Google Chromekey1" + 静态
//!   XOR 密钥），最后用其 AES-256-GCM 解密 v20 数据。
//! - Firefox: SHA1(global-salt + master-password) iterated 20 times yields
//!   the HP key (extended to 24 bytes), which 3DES-CBC-decrypts the `a11`
//!   key blob from key4.db; login blobs from logins.json are then
//!   3DES-CBC-decrypted with that 24-byte key.
//!
//! All heavy synchronous work (SQLite + crypto) runs inside
//! `tokio::task::spawn_blocking` so the Node.js event loop is never blocked.

pub(crate) use std::path::{Path, PathBuf};

pub(crate) use aes_gcm::aead::{Aead, KeyInit};
pub(crate) use base64::Engine;
pub(crate) use cipher::{BlockDecryptMut, KeyIvInit};
pub(crate) use napi::bindgen_prelude::*;
pub(crate) use napi_derive::napi;
#[cfg(target_os = "macos")]
pub(crate) use pbkdf2::pbkdf2_hmac;
pub(crate) use rusqlite::Connection;
pub(crate) use serde_json::Value;
pub(crate) use sha1::{Digest, Sha1};

mod decrypt;
mod discovery;

use decrypt::*;
use discovery::*;

// ---------------------------------------------------------------------------
// Public napi types
// ---------------------------------------------------------------------------

#[napi(object)]
#[allow(non_snake_case)]
pub struct ImportSourceInfo {
    /// Stable id: "chrome" | "edge" | "chromium" | "firefox"
    pub id: String,
    /// Display name, e.g. "Google Chrome"
    pub name: String,
    /// Profile name, e.g. "Default" / "Profile 1" / "abcd1234.default-release"
    pub profile: String,
    /// Browser account username (Chrome: Preferences account_info email,
    /// Firefox: services.sync.username), empty when signed out.
    pub accountName: String,
    /// Absolute path of the password database ("" when not applicable)
    pub passwordDb: String,
    /// Absolute path of the cookie database ("" when not applicable)
    pub cookieDb: String,
    /// Number of password records (counted without decrypting)
    pub passwordCount: i32,
    /// Number of cookie records
    pub cookieCount: i32,
    /// Number of bookmark records (Chrome/Edge: Bookmarks JSON; Firefox: places.sqlite)
    pub bookmarkCount: i32,
    /// Human-readable caveat, e.g. unsupported encryption on this platform
    pub note: String,
}

#[napi(object)]
#[allow(non_snake_case)]
pub struct ImportedPassword {
    /// Normalized origin, e.g. "https://accounts.google.com"
    pub origin: String,
    pub username: String,
    pub password: String,
}

#[napi(object)]
#[allow(non_snake_case)]
pub struct ImportedCookie {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    /// Unix seconds; None for session cookies
    pub expires: Option<i64>,
    pub httpOnly: bool,
    pub secure: bool,
    /// "None" | "Lax" | "Strict" | "unspecified"
    pub sameSite: String,
}

#[napi(object)]
#[allow(non_snake_case)]
pub struct ImportedBookmark {
    /// Page display title
    pub title: String,
    /// Full http(s) URL (path/query preserved, unlike passwords' origin)
    pub url: String,
    /// Folder path relative to the bookmark root, e.g. "News/Tech"
    pub folder: String,
}

// ---------------------------------------------------------------------------
// Chromium (Chrome / Edge / Chromium) readers
// ---------------------------------------------------------------------------

/// Chrome password table is only meaningful when the profile has one.
/// Returns (count, note) — note explains when data may be stale (browser
/// running, immutable fallback used).
fn chromium_password_count(profile_dir: &Path) -> (i32, String) {
    let db = profile_dir.join("Login Data");
    let (count, immutable) = query_with_retry(&db, |conn| {
        conn.query_row("SELECT COUNT(*) FROM logins", [], |row| row.get::<_, i64>(0))
    });
    (
        count.unwrap_or(0) as i32,
        if immutable {
            "浏览器正在运行，密码数据可能不是最新，建议关闭浏览器后重试".to_string()
        } else {
            String::new()
        },
    )
}

/// Chrome 115+（2023）将 Cookie 数据库从 `<profile>/Cookies` 迁移到
/// `<profile>/Network/Cookies`（旧路径仅保留给旧版本/未迁移安装）。
/// 返回实际存在的 Cookie 数据库路径。
fn chromium_cookie_db(profile_dir: &Path) -> Option<PathBuf> {
    let legacy = profile_dir.join("Cookies");
    let modern = profile_dir.join("Network").join("Cookies");
    if modern.exists() {
        Some(modern)
    } else if legacy.exists() {
        Some(legacy)
    } else {
        None
    }
}

fn chromium_cookie_count(profile_dir: &Path) -> (i32, String) {
    let Some(db) = chromium_cookie_db(profile_dir) else {
        return (0, String::new());
    };
    let (count, immutable) = query_with_retry(&db, |conn| {
        conn.query_row("SELECT COUNT(*) FROM cookies", [], |row| row.get::<_, i64>(0))
    });
    (
        count.unwrap_or(0) as i32,
        if immutable {
            "浏览器正在运行，Cookie 数据可能不是最新，建议关闭浏览器后重试".to_string()
        } else {
            String::new()
        },
    )
}

// ---------------------------------------------------------------------------
// Bookmarks (favorites) readers — plain text, no decryption involved
// ---------------------------------------------------------------------------

/// Bookmarks are only replayable by the embedded browser when http(s).
fn valid_bookmark_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return false;
    }
    reqwest::Url::parse(trimmed).is_ok()
}

fn chromium_bookmark_file(profile_dir: &Path) -> PathBuf {
    profile_dir.join("Bookmarks")
}

/// Count url-type nodes in the Chromium Bookmarks JSON without full parsing cost.
fn chromium_bookmark_count(profile_dir: &Path) -> i32 {
    let path = chromium_bookmark_file(profile_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return 0;
    };
    let Some(roots) = json.get("roots").and_then(Value::as_object) else {
        return 0;
    };
    fn count_node(node: &Value) -> i32 {
        let mut sum = 0;
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for child in children {
                if child.get("type").and_then(Value::as_str) == Some("url") {
                    sum += 1;
                } else {
                    sum += count_node(child);
                }
            }
        }
        sum
    }
    roots.values().map(count_node).sum()
}

/// Walk the Chromium Bookmarks JSON tree (bookmark_bar / other / synced roots)
/// and flatten url nodes into (title, url, folder path) records.
fn collect_chromium_bookmarks(node: &Value, folder: &str, out: &mut Vec<ImportedBookmark>) {
    let Some(children) = node.get("children").and_then(Value::as_array) else {
        return;
    };
    for child in children {
        let name = child
            .get("name")
            .or_else(|| child.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if child.get("type").and_then(Value::as_str) == Some("folder") {
            let next = if folder.is_empty() {
                name
            } else {
                format!("{folder}/{name}")
            };
            collect_chromium_bookmarks(child, &next, out);
            continue;
        }
        let Some(url) = child.get("url").and_then(Value::as_str) else {
            continue;
        };
        if !valid_bookmark_url(url) {
            continue;
        }
        out.push(ImportedBookmark {
            title: if name.is_empty() { url.to_string() } else { name },
            url: url.trim().to_string(),
            folder: folder.to_string(),
        });
    }
}

fn read_chromium_bookmarks(profile_dir: &Path) -> Result<Vec<ImportedBookmark>> {
    let path = chromium_bookmark_file(profile_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| Error::from_reason(format!("读取书签文件失败: {error}")))?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|error| Error::from_reason(format!("解析书签文件失败: {error}")))?;
    let Some(roots) = json.get("roots").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut bookmarks: Vec<ImportedBookmark> = Vec::new();
    // bookmark_bar 优先（收藏栏），随后 other / synced，顺序与浏览器一致。
    let order = ["bookmark_bar", "other", "synced"];
    let mut keys: Vec<&String> = roots.keys().collect();
    keys.sort_by_key(|key| {
        order
            .iter()
            .position(|candidate| candidate == key)
            .unwrap_or(order.len())
    });
    for key in keys {
        if let Some(root) = roots.get(key) {
            collect_chromium_bookmarks(root, "", &mut bookmarks);
        }
    }
    Ok(bookmarks)
}

fn normalize_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Only http(s) origins can be replayed by the embedded browser.
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return None;
    }
    reqwest::Url::parse(trimmed)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

fn read_chromium_passwords(source_id: &str, profile_dir: &Path) -> Result<Vec<ImportedPassword>> {
    let db = profile_dir.join("Login Data");
    if !db.exists() {
        return Ok(Vec::new());
    }
    // 常规 → immutable 双尝试：浏览器运行中锁定 WAL 时回退读主库文件。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&db) {
        match read_chromium_passwords_with(&conn, source_id, profile_dir) {
            Ok(items) => return Ok(items),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开密码数据库（浏览器可能正在运行，请关闭后重试）: {}",
            db.display()
        ))
    }))
}

fn read_chromium_passwords_with(
    conn: &Connection,
    source_id: &str,
    profile_dir: &Path,
) -> Result<Vec<ImportedPassword>> {
    let (keys, note) = chrome_keys(
        profile_dir.parent().unwrap_or(profile_dir),
        source_id,
    );
    if keys.is_empty() {
        return Err(Error::from_reason(note));
    }

    let mut stmt = conn
        .prepare(
            "SELECT origin_url, username_value, password_value FROM logins \
             WHERE username_value != '' OR password_value IS NOT NULL",
        )
        .map_err(|error| Error::from_reason(format!("读取登录记录失败: {error}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|error| Error::from_reason(format!("查询登录记录失败: {error}")))?;

    let mut passwords: Vec<ImportedPassword> = Vec::new();
    let mut decryption_failures = 0usize;
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for row in rows.flatten() {
        let (origin_url, username, encrypted) = row;
        let Some(origin) = normalize_origin(&origin_url) else {
            continue;
        };
        if encrypted.is_empty() {
            continue;
        }
        let Some(plain) = chrome_decrypt(&encrypted, &keys) else {
            decryption_failures += 1;
            continue;
        };
        let password = String::from_utf8_lossy(&plain).into_owned();
        if password.is_empty() {
            continue;
        }
        let username = username.trim().to_string();
        // A single origin may store duplicates; keep the last non-empty pair.
        if !seen.insert((origin.clone(), username.clone())) {
            continue;
        }
        passwords.push(ImportedPassword {
            origin,
            username,
            password,
        });
    }
    if passwords.is_empty() && decryption_failures > 0 {
        let detail = if note.is_empty() {
            "Windows 浏览器加密密钥恢复失败，请确认应用以管理员身份运行，并关闭源浏览器后重试"
                .to_string()
        } else {
            note
        };
        return Err(Error::from_reason(format!(
            "检测到 {decryption_failures} 条加密密码，但全部解密失败：{detail}"
        )));
    }
    Ok(passwords)
}

fn read_chromium_cookies(source_id: &str, profile_dir: &Path) -> Result<Vec<ImportedCookie>> {
    let Some(db) = chromium_cookie_db(profile_dir) else {
        return Ok(Vec::new());
    };
    // 常规 → immutable 双尝试：浏览器运行中锁定 WAL 时回退读主库文件。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&db) {
        match read_chromium_cookies_with(&conn, source_id, profile_dir) {
            Ok(items) => return Ok(items),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开 Cookie 数据库（浏览器可能正在运行，请关闭后重试）: {}",
            db.display()
        ))
    }))
}

fn read_chromium_cookies_with(
    conn: &Connection,
    source_id: &str,
    profile_dir: &Path,
) -> Result<Vec<ImportedCookie>> {
    // source_id 决定 macOS Keychain 服务名（Chrome 与 Edge 各自独立），
    // 传错会导致 Edge 的 Cookie 解密失败、值全部为空。
    let (keys, note) = chrome_keys(
        profile_dir.parent().unwrap_or(profile_dir),
        source_id,
    );

    // Chrome 133+ 的 Cookie 库 schema v24+ 会在解密明文前附加 32 字节
    // SHA-256 哈希前缀，必须剥离，否则值里全是控制字符，目标浏览器会以
    // EXCLUDE_DISALLOWED_CHARACTER 拒绝写入（表现为导入几乎全部失败）。
    // 浏览器运行中 meta 查询可能因 SQLITE_BUSY 失败，此时保留 None，
    // 由解码端启发式兜底判定，而不是错误地当作旧库不剥离。
    let schema_version: Option<i64> = conn
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| row.get(0))
        .ok();
    let strip_hash_prefix = schema_version.map(|version| version >= 24);

    // 新版 Chromium（2025+）：值存放在 encrypted_value BLOB，sameSite 列名为
    // 小写 samesite；旧版：value TEXT + same_site。
    let modern_query = "SELECT host_key, name, value, encrypted_value, path, expires_utc, \
                        is_secure, is_httponly, samesite, has_expires FROM cookies";
    let legacy_query = "SELECT host_key, name, value, path, expires_utc, is_secure, \
                        is_httponly, same_site, has_expires FROM cookies";

    struct CookieRow {
        domain: String,
        name: String,
        value: String,
        encrypted: Vec<u8>,
        path: String,
        expires_utc: i64,
        is_secure: i64,
        is_httponly: i64,
        same_site: i64,
        has_expires: Option<i64>,
    }

    let rows: Vec<CookieRow> = if conn.prepare(modern_query).is_ok() {
        let mut stmt = conn
            .prepare(modern_query)
            .map_err(|error| Error::from_reason(format!("读取 Cookie 表失败: {error}")))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(CookieRow {
                    domain: row.get::<_, String>(0)?,
                    name: row.get::<_, String>(1)?,
                    value: row.get::<_, String>(2)?,
                    encrypted: row
                        .get::<_, Option<Vec<u8>>>(3)?
                        .unwrap_or_default(),
                    path: row.get::<_, String>(4)?,
                    expires_utc: row.get::<_, i64>(5)?,
                    is_secure: row.get::<_, i64>(6)?,
                    is_httponly: row.get::<_, i64>(7)?,
                    same_site: row.get::<_, i64>(8)?,
                    has_expires: row.get::<_, Option<i64>>(9)?,
                })
            })
            .map_err(|error| Error::from_reason(format!("查询 Cookie 表失败: {error}")))?;
        mapped.flatten().collect()
    } else {
        let mut stmt = conn
            .prepare(legacy_query)
            .map_err(|error| Error::from_reason(format!("读取 Cookie 表失败: {error}")))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(CookieRow {
                    domain: row.get::<_, String>(0)?,
                    name: row.get::<_, String>(1)?,
                    value: row.get::<_, String>(2)?,
                    encrypted: Vec::new(),
                    path: row.get::<_, String>(3)?,
                    expires_utc: row.get::<_, i64>(4)?,
                    is_secure: row.get::<_, i64>(5)?,
                    is_httponly: row.get::<_, i64>(6)?,
                    same_site: row.get::<_, i64>(7)?,
                    has_expires: row.get::<_, Option<i64>>(8)?,
                })
            })
            .map_err(|error| Error::from_reason(format!("查询 Cookie 表失败: {error}")))?;
        mapped.flatten().collect()
    };

    // Chromium stores expires_utc as microseconds since 1601-01-01.
    const WINDOWS_EPOCH_DELTA_SECS: i64 = 11_644_473_600;

    let mut cookies: Vec<ImportedCookie> = Vec::new();
    let mut decryption_failures = 0usize;
    for row in rows {
        let CookieRow {
            domain,
            name,
            value,
            encrypted,
            path,
            expires_utc,
            is_secure,
            is_httponly,
            same_site,
            has_expires,
        } = row;
        // 新版 Chrome（schema v24+）值加密存入 encrypted_value、value 列为空；
        // 旧版（v10~v23）value 文本列直接存 v10 前缀密文。统一走解密入口，
        // 解密失败（如应用非管理员运行导致 ABE 密钥不可用）则跳过该条，
        // 避免把乱码/空值写入目标浏览器。
        let encrypted_value = !encrypted.is_empty()
            || value.starts_with("v10")
            || value.starts_with("v20");
        let Some(value) = (if !encrypted.is_empty() {
            decrypt_chromium_cookie_value(&encrypted, &keys, strip_hash_prefix)
        } else if value.starts_with("v10") || value.starts_with("v20") {
            decrypt_chromium_cookie_value(value.as_bytes(), &keys, strip_hash_prefix)
        } else {
            Some(value)
        }) else {
            if encrypted_value {
                decryption_failures += 1;
            }
            continue;
        };
        let expires = if has_expires == Some(0) {
            None
        } else if has_expires == Some(1) && expires_utc <= 0 {
            None
        } else {
            let unix = expires_utc / 1_000_000 - WINDOWS_EPOCH_DELTA_SECS;
            (unix > 0).then_some(unix)
        };
        let same_site = match same_site {
            0 => "None",
            1 => "Lax",
            2 => "Strict",
            _ => "unspecified",
        };
        cookies.push(ImportedCookie {
            domain,
            path: if path.is_empty() { "/".to_string() } else { path },
            name,
            value,
            expires,
            httpOnly: is_httponly != 0,
            secure: is_secure != 0,
            sameSite: same_site.to_string(),
        });
    }
    if cookies.is_empty() && decryption_failures > 0 {
        let detail = if note.is_empty() {
            "Windows 浏览器加密密钥恢复失败，请确认应用以管理员身份运行，并关闭源浏览器后重试"
                .to_string()
        } else {
            note
        };
        return Err(Error::from_reason(format!(
            "检测到 {decryption_failures} 个加密 Cookie，但全部解密失败：{detail}"
        )));
    }
    Ok(cookies)
}

// ---------------------------------------------------------------------------
// Firefox readers
// ---------------------------------------------------------------------------

fn firefox_has_master_password(profile_dir: &Path) -> bool {
    let db = profile_dir.join("key4.db");
    let (has_master, _) = query_with_retry(&db, |conn| {
        conn.query_row("SELECT item1 FROM metaData WHERE id = 3", [], |row| {
            row.get::<_, Vec<u8>>(0)
        })
    });
    has_master.map(|value| !value.is_empty()).unwrap_or(false)
}

/// Derive the 24-byte 3DES key from key4.db (no master password).
fn firefox_3des_key(profile_dir: &Path) -> Result<Vec<u8>> {
    let key_db = profile_dir.join("key4.db");
    if !key_db.exists() {
        return Err(Error::from_reason("未找到 key4.db，Firefox 可能未初始化".to_string()));
    }
    // 常规 → immutable 双尝试。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&key_db) {
        match firefox_3des_key_with(&conn, profile_dir) {
            Ok(key) => return Ok(key),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开 key4.db（Firefox 可能正在运行，请关闭后重试）: {}",
            key_db.display()
        ))
    }))
}

fn firefox_3des_key_with(conn: &Connection, profile_dir: &Path) -> Result<Vec<u8>> {
    if firefox_has_master_password(profile_dir) {
        return Err(Error::from_reason(
            "Firefox 已设置主密码，暂不支持导入；请临时取消主密码后重试".to_string(),
        ));
    }
    let global_salt: Vec<u8> = conn
        .query_row("SELECT item1 FROM metaData WHERE id = 1", [], |row| row.get(0))
        .map_err(|error| Error::from_reason(format!("读取 key4.db 失败: {error}")))?;
    let a11: Vec<u8> = conn
        .query_row(
            "SELECT a11 FROM nssPrivate WHERE a11 IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| Error::from_reason(format!("读取加密密钥失败: {error}")))?;

    // HP = SHA1(global_salt) iterated 20 times; NSS pads the 20-byte digest
    // to 24 bytes by repeating the first 4 bytes for the 3DES key.
    let mut hp = sha1_digest(&global_salt);
    for _ in 0..20 {
        hp = sha1_digest(&hp);
    }
    let mut key = [0u8; 24];
    key[..20].copy_from_slice(&hp);
    key[20..24].copy_from_slice(&hp[..4]);

    // a11 blob: IV(16) + ciphertext -> plaintext = key(24) + checksum(20).
    let (iv, payload) = a11.split_at(16);
    let plain = des3_cbc_decrypt(&key, iv, payload)
        .ok_or_else(|| Error::from_reason("解密 Firefox 密钥失败（数据损坏）".to_string()))?;
    if plain.len() < 44 {
        return Err(Error::from_reason("Firefox 密钥数据格式异常".to_string()));
    }
    let derived = &plain[..24];
    let checksum = sha1_digest(derived);
    if checksum != plain[24..44] {
        return Err(Error::from_reason(
            "Firefox 密钥校验失败（可能设置了主密码或数据损坏）".to_string(),
        ));
    }
    Ok(derived.to_vec())
}

fn firefox_decrypt_login_blob(blob: &[u8], key: &[u8]) -> Option<String> {
    let (iv, payload) = blob.split_at(16);
    let plain = des3_cbc_decrypt(key, iv, payload)?;
    // Firefox 97+ prefixes plaintext with '~' to mark the format version.
    let text = if plain.first() == Some(&b'~') {
        String::from_utf8_lossy(&plain[1..]).into_owned()
    } else {
        String::from_utf8_lossy(&plain).into_owned()
    };
    Some(text)
}

fn read_firefox_passwords(profile_dir: &Path) -> Result<Vec<ImportedPassword>> {
    let logins_path = profile_dir.join("logins.json");
    if !logins_path.exists() {
        return Ok(Vec::new());
    }
    let key = firefox_3des_key(profile_dir)?;
    let text = std::fs::read_to_string(&logins_path)
        .map_err(|error| Error::from_reason(format!("读取 logins.json 失败: {error}")))?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|error| Error::from_reason(format!("解析 logins.json 失败: {error}")))?;
    let logins = json
        .get("logins")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut passwords: Vec<ImportedPassword> = Vec::new();
    for login in logins {
        let Some(hostname) = login.get("hostname").and_then(Value::as_str) else {
            continue;
        };
        let Some(origin) = normalize_origin(hostname) else {
            continue;
        };
        let decrypt_field = |field: &str| -> Option<String> {
            let raw = login.get(field).and_then(Value::as_str)?;
            let blob = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
            firefox_decrypt_login_blob(&blob, &key)
        };
        let Some(password) = decrypt_field("encryptedPassword") else {
            continue;
        };
        let username = decrypt_field("encryptedUsername").unwrap_or_default();
        if password.is_empty() {
            continue;
        }
        passwords.push(ImportedPassword {
            origin,
            username,
            password,
        });
    }
    Ok(passwords)
}

fn read_firefox_cookies(profile_dir: &Path) -> Result<Vec<ImportedCookie>> {
    let db = profile_dir.join("cookies.sqlite");
    if !db.exists() {
        return Ok(Vec::new());
    }
    // 常规 → immutable 双尝试。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&db) {
        match read_firefox_cookies_with(&conn) {
            Ok(items) => return Ok(items),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开 cookies.sqlite（Firefox 可能正在运行，请关闭后重试）: {}",
            db.display()
        ))
    }))
}

fn read_firefox_cookies_with(conn: &Connection) -> Result<Vec<ImportedCookie>> {
    let mut stmt = conn
        .prepare(
            "SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite \
             FROM moz_cookies",
        )
        .map_err(|error| Error::from_reason(format!("读取 Cookie 表失败: {error}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|error| Error::from_reason(format!("查询 Cookie 表失败: {error}")))?;

    let mut cookies: Vec<ImportedCookie> = Vec::new();
    for row in rows.flatten() {
        let (name, value, host, path, expiry, is_secure, is_http_only, same_site) = row;
        // Firefox moz_cookies.sameSite: 0 = 无限制（None），1 = Lax，2 = Strict。
        let same_site = match same_site {
            0 => "None",
            1 => "Lax",
            2 => "Strict",
            _ => "unspecified",
        };
        cookies.push(ImportedCookie {
            domain: host,
            path: if path.is_empty() { "/".to_string() } else { path },
            name,
            value,
            expires: (expiry > 0).then_some(expiry),
            httpOnly: is_http_only != 0,
            secure: is_secure != 0,
            sameSite: same_site.to_string(),
        });
    }
    Ok(cookies)
}

/// Firefox bookmarks live in places.sqlite (moz_bookmarks + moz_places).
/// type: 1 = bookmark (fk -> moz_places.id), 2 = folder, 3 = separator.
fn read_firefox_bookmarks(profile_dir: &Path) -> Result<Vec<ImportedBookmark>> {
    let db = profile_dir.join("places.sqlite");
    if !db.exists() {
        return Ok(Vec::new());
    }
    // 常规 → immutable 双尝试（浏览器运行中锁定 WAL 时回退读主库文件）。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&db) {
        match read_firefox_bookmarks_with(&conn) {
            Ok(items) => return Ok(items),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开 places.sqlite（Firefox 可能正在运行，请关闭后重试）: {}",
            db.display()
        ))
    }))
}

fn read_firefox_bookmarks_with(conn: &Connection) -> Result<Vec<ImportedBookmark>> {
    // 单次全表读取（按 parent/position 排序），内存建树后从根(id=1) DFS 展开，
    // 避免递归 SQL；tags 根(id=4)整棵跳过（非用户收藏）。
    struct Row {
        r#type: i64,
        title: Option<String>,
        fk: Option<i64>,
    }
    let mut stmt = conn
        .prepare("SELECT id, parent, type, title, fk FROM moz_bookmarks ORDER BY parent, position, id")
        .map_err(|error| Error::from_reason(format!("读取书签表失败: {error}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(|error| Error::from_reason(format!("查询书签表失败: {error}")))?;

    let mut by_id: std::collections::HashMap<i64, Row> = std::collections::HashMap::new();
    let mut children: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for (id, parent, r#type, title, fk) in rows.flatten() {
        by_id.insert(id, Row { r#type, title, fk });
        if let Some(parent) = parent {
            children.entry(parent).or_default().push(id);
        }
    }

    // moz_places 的 id -> url 映射（书签 URL 查询）。
    let mut places: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    let mut place_stmt = conn
        .prepare("SELECT id, url FROM moz_places")
        .map_err(|error| Error::from_reason(format!("读取访问记录表失败: {error}")))?;
    let place_rows = place_stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| Error::from_reason(format!("查询访问记录表失败: {error}")))?;
    for (id, url) in place_rows.flatten() {
        places.insert(id, url);
    }

    let mut bookmarks: Vec<ImportedBookmark> = Vec::new();
    // DFS：folder 名入路径；根(id=1)与 tags(id=4) 的名称不进路径。
    fn walk(
        node_id: i64,
        folder: &str,
        by_id: &std::collections::HashMap<i64, Row>,
        children: &std::collections::HashMap<i64, Vec<i64>>,
        places: &std::collections::HashMap<i64, String>,
        out: &mut Vec<ImportedBookmark>,
    ) {
        let Some(child_ids) = children.get(&node_id) else {
            return;
        };
        for child_id in child_ids {
            let Some(row) = by_id.get(child_id) else {
                continue;
            };
            let name = row.title.clone().unwrap_or_default().trim().to_string();
            if row.r#type == 2 {
                let next = if node_id == 1 {
                    folder.to_string()
                } else if folder.is_empty() {
                    name.clone()
                } else {
                    format!("{folder}/{name}")
                };
                if *child_id != 4 {
                    walk(*child_id, &next, by_id, children, places, out);
                }
                continue;
            }
            if row.r#type != 1 {
                continue;
            }
            let Some(url) = row.fk.and_then(|fk| places.get(&fk)) else {
                continue;
            };
            if !valid_bookmark_url(url) {
                continue;
            }
            out.push(ImportedBookmark {
                title: if name.is_empty() {
                    url.trim().to_string()
                } else {
                    name
                },
                url: url.trim().to_string(),
                folder: folder.to_string(),
            });
        }
    }
    walk(1, "", &by_id, &children, &places, &mut bookmarks);
    Ok(bookmarks)
}

// ---------------------------------------------------------------------------
// napi entry points (async, spawn_blocking inside)
// ---------------------------------------------------------------------------

#[napi]
pub async fn browser_import_list_sources() -> Result<Vec<ImportSourceInfo>> {
    tokio::task::spawn_blocking(|| -> Result<Vec<ImportSourceInfo>> {
        let mut sources: Vec<ImportSourceInfo> = Vec::new();
        for (id, name, root) in chromium_roots() {
            if !root.exists() {
                continue;
            }
            // Chrome/Edge 127+ 启用 App-Bound Encryption（v20）：密码与 Cookie
            // 密文绑定系统级密钥，需管理员权限（SYSTEM 进程令牌模拟 + SYSTEM DPAPI）
            // 才能解密。同一根目录下所有 profile 共享同一把 key，只实际尝试
            // 解密一次：成功则静默，失败（典型为应用未以管理员运行）则提示，
            // 避免用户误以为导入功能损坏。
            let abe_note: Option<&str> = if has_app_bound_encryption(&root) {
                #[cfg(windows)]
                {
                    if app_bound_key_windows(&root).is_none() {
                        Some("该浏览器已启用应用绑定加密（Chrome/Edge 127+），请以管理员权限运行应用后重试导入")
                    } else {
                        None
                    }
                }
                #[cfg(not(windows))]
                {
                    Some("该浏览器已启用应用绑定加密（Chrome/Edge 127+），本平台暂不支持解密导入")
                }
            } else {
                None
            };
            for (profile, dir) in chromium_profiles(&root) {
                let password_db = dir.join("Login Data");
                let cookie_db = chromium_cookie_db(&dir);
                let bookmark_db = chromium_bookmark_file(&dir);
                let has_password_db = password_db.exists();
                let has_cookie_db = cookie_db.is_some();
                let has_bookmark_db = bookmark_db.exists();
                if !has_password_db && !has_cookie_db && !has_bookmark_db {
                    continue;
                }
                let (password_count, password_note) = if has_password_db {
                    chromium_password_count(&dir)
                } else {
                    (0, String::new())
                };
                let (cookie_count, cookie_note) = if has_cookie_db {
                    chromium_cookie_count(&dir)
                } else {
                    (0, String::new())
                };
                let bookmark_count = if has_bookmark_db {
                    chromium_bookmark_count(&dir)
                } else {
                    0
                };
                let mut notes: Vec<String> = vec![password_note, cookie_note]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect();
                if let Some(note) = abe_note {
                    notes.push(note.to_string());
                }
                let note = notes.join("；");
                sources.push(ImportSourceInfo {
                    id: id.clone(),
                    name: name.clone(),
                    profile,
                    accountName: chromium_account_name(&dir),
                    passwordDb: if has_password_db {
                        password_db.display().to_string()
                    } else {
                        String::new()
                    },
                    cookieDb: if let Some(db) = &cookie_db {
                        db.display().to_string()
                    } else {
                        String::new()
                    },
                    passwordCount: password_count,
                    cookieCount: cookie_count,
                    bookmarkCount: bookmark_count,
                    note,
                });
            }
        }
        for (profile, dir) in firefox_profiles() {
            let has_logins = dir.join("logins.json").exists();
            let has_cookies = dir.join("cookies.sqlite").exists();
            let has_places = dir.join("places.sqlite").exists();
            if !has_logins && !has_cookies && !has_places {
                continue;
            }
            let master = firefox_has_master_password(&dir);
            let password_count = if has_logins {
                std::fs::read_to_string(dir.join("logins.json"))
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|json| json.get("logins").and_then(Value::as_array).cloned())
                    .map(|logins| logins.len() as i32)
                    .unwrap_or(0)
            } else {
                0
            };
            sources.push(ImportSourceInfo {
                id: "firefox".to_string(),
                name: "Firefox".to_string(),
                profile,
                accountName: firefox_account_name(&dir),
                passwordDb: if has_logins {
                    dir.join("logins.json").display().to_string()
                } else {
                    String::new()
                },
                cookieDb: if has_cookies {
                    dir.join("cookies.sqlite").display().to_string()
                } else {
                    String::new()
                },
                passwordCount: password_count,
                cookieCount: if has_cookies {
                    let (count, _) = query_with_retry(&dir.join("cookies.sqlite"), |conn| {
                        conn.query_row("SELECT COUNT(*) FROM moz_cookies", [], |row| {
                            row.get::<_, i64>(0)
                        })
                    });
                    count.unwrap_or(0) as i32
                } else {
                    0
                },
                bookmarkCount: if has_places {
                    let (count, _) = query_with_retry(&dir.join("places.sqlite"), |conn| {
                        conn.query_row(
                            "SELECT COUNT(*) FROM moz_bookmarks WHERE type = 1 AND fk IS NOT NULL",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                    });
                    count.unwrap_or(0) as i32
                } else {
                    0
                },
                note: {
                    let mut notes: Vec<String> = Vec::new();
                    if master {
                        notes.push("Firefox 已设置主密码，导入密码前请临时取消主密码".to_string());
                    }
                    if has_cookies {
                        let (_, immutable) = query_with_retry(&dir.join("cookies.sqlite"), |conn| {
                            conn.query_row("SELECT COUNT(*) FROM moz_cookies", [], |row| {
                                row.get::<_, i64>(0)
                            })
                        });
                        if immutable {
                            notes.push(
                                "浏览器正在运行，Cookie 数据可能不是最新，建议关闭浏览器后重试"
                                    .to_string(),
                            );
                        }
                    }
                    notes.join("；")
                },
            });
        }
        Ok(sources)
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("浏览器源探测任务失败: {error}"),
        )
    })?
}

#[napi]
pub async fn browser_import_passwords(
    source_id: String,
    profile: String,
) -> Result<Vec<ImportedPassword>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ImportedPassword>> {
        if source_id == "firefox" {
            let dir = firefox_profile_dir(&profile)
                .ok_or_else(|| Error::from_reason("未找到指定 Firefox 配置文件".to_string()))?;
            read_firefox_passwords(&dir)
        } else {
            let (root, _name) = chromium_root_by_id(&source_id)
                .ok_or_else(|| Error::from_reason("不支持的浏览器类型".to_string()))?;
            let dir = root.join(&profile);
            if !dir.is_dir() {
                return Err(Error::from_reason(format!(
                    "未找到浏览器配置文件目录: {}",
                    dir.display()
                )));
            }
            read_chromium_passwords(&source_id, &dir)
        }
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("密码解析任务失败: {error}"),
        )
    })?
}

#[napi]
pub async fn browser_import_cookies(
    source_id: String,
    profile: String,
) -> Result<Vec<ImportedCookie>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ImportedCookie>> {
        if source_id == "firefox" {
            let dir = firefox_profile_dir(&profile)
                .ok_or_else(|| Error::from_reason("未找到指定 Firefox 配置文件".to_string()))?;
            read_firefox_cookies(&dir)
        } else {
            let (root, _name) = chromium_root_by_id(&source_id)
                .ok_or_else(|| Error::from_reason("不支持的浏览器类型".to_string()))?;
            let dir = root.join(&profile);
            if !dir.is_dir() {
                return Err(Error::from_reason(format!(
                    "未找到浏览器配置文件目录: {}",
                    dir.display()
                )));
            }
            read_chromium_cookies(&source_id, &dir)
        }
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Cookie 解析任务失败: {error}"),
        )
    })?
}

#[napi]
pub async fn browser_import_bookmarks(
    source_id: String,
    profile: String,
) -> Result<Vec<ImportedBookmark>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ImportedBookmark>> {
        if source_id == "firefox" {
            let dir = firefox_profile_dir(&profile)
                .ok_or_else(|| Error::from_reason("未找到指定 Firefox 配置文件".to_string()))?;
            read_firefox_bookmarks(&dir)
        } else {
            let (root, _name) = chromium_root_by_id(&source_id)
                .ok_or_else(|| Error::from_reason("不支持的浏览器类型".to_string()))?;
            let dir = root.join(&profile);
            if !dir.is_dir() {
                return Err(Error::from_reason(format!(
                    "未找到浏览器配置文件目录: {}",
                    dir.display()
                )));
            }
            read_chromium_bookmarks(&dir)
        }
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("书签解析任务失败: {error}"),
        )
    })?
}

fn chromium_root_by_id(source_id: &str) -> Option<(PathBuf, String)> {
    chromium_roots()
        .into_iter()
        .find(|(id, _, _)| id == source_id)
        .map(|(_, name, root)| (root, name))
}

fn firefox_profile_dir(profile: &str) -> Option<PathBuf> {
    firefox_profiles()
        .into_iter()
        .find(|(name, _)| name == profile)
        .map(|(_, dir)| dir)
}
