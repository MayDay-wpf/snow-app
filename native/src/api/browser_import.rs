#![allow(non_snake_case)]

//! Local browser credential import: probe installed browsers (Chrome /
//! Edge / Chromium / Firefox) and decrypt their saved passwords and cookies.
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
//!   `os_crypt.app_bound_encrypted_key` 依次做 SYSTEM DPAPI（LSASS 令牌模拟，
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

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use base64::Engine;
use cipher::{BlockDecryptMut, KeyIvInit};
use napi::bindgen_prelude::*;
use napi_derive::napi;
#[cfg(target_os = "macos")]
use pbkdf2::pbkdf2_hmac;
use rusqlite::Connection;
use serde_json::Value;
use sha1::{Digest, Sha1};

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

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Candidate (id, display name, browser root dir).
fn chromium_roots() -> Vec<(String, String, PathBuf)> {
    let home = home_dir();
    let mut roots: Vec<(String, String, PathBuf)> = Vec::new();
    if cfg!(target_os = "macos") {
        let base = home.join("Library/Application Support");
        roots.push(("chrome".into(), "Google Chrome".into(), base.join("Google/Chrome")));
        roots.push(("edge".into(), "Microsoft Edge".into(), base.join("Microsoft Edge")));
        roots.push(("chromium".into(), "Chromium".into(), base.join("Chromium")));
    } else if cfg!(target_os = "windows") {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            roots.push(("chrome".into(), "Google Chrome".into(), base.join("Google/Chrome/User Data")));
            roots.push(("edge".into(), "Microsoft Edge".into(), base.join("Microsoft/Edge/User Data")));
            roots.push(("chromium".into(), "Chromium".into(), base.join("Chromium/User Data")));
        }
    } else {
        let base = home.join(".config");
        roots.push(("chrome".into(), "Google Chrome".into(), base.join("google-chrome")));
        roots.push(("edge".into(), "Microsoft Edge".into(), base.join("microsoft-edge")));
        roots.push(("chromium".into(), "Chromium".into(), base.join("chromium")));
    }
    roots
}

/// Chromium profile subdirectories ("Default" or "Profile N").
fn chromium_profiles(root: &Path) -> Vec<(String, PathBuf)> {
    let mut profiles: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "Default" || name.starts_with("Profile ") {
                profiles.push((name, path));
            }
        }
    }
    if profiles.is_empty() && root.join("Default").is_dir() {
        profiles.push(("Default".into(), root.join("Default")));
    }
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles
}

/// Firefox profile directories containing logins.json or cookies.sqlite.
fn firefox_profiles() -> Vec<(String, PathBuf)> {
    let home = home_dir();
    let roots: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![home.join("Library/Application Support/Firefox/Profiles")]
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(|dir| PathBuf::from(dir).join("Mozilla/Firefox/Profiles"))
            .into_iter()
            .collect()
    } else {
        vec![home.join(".mozilla/firefox")]
    };
    let mut profiles: Vec<(String, PathBuf)> = Vec::new();
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if path.join("logins.json").exists() || path.join("cookies.sqlite").exists() {
                    profiles.push((entry.file_name().to_string_lossy().to_string(), path));
                }
            }
        }
    }
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles
}

/// 打开 SQLite 数据库（只读），返回 `(连接, 是否使用了 immutable 回退)`。
///
/// 浏览器运行期间其数据库（尤其是 Chrome 的 Login Data）可能持有
/// WAL 锁，常规只读连接打开成功但真实表查询会得到 SQLITE_BUSY。
/// 因此调用方必须对真实查询做"常规 → immutable"双尝试：
/// `immutable=1` URI 让 SQLite 跳过锁检查与 WAL 文件、直接读主库文件
/// （可能缺少未 checkpoint 的最新变更，由调用方在 note 中提示用户）。
///
/// 生成只读连接尝试序列（常规 → immutable 回退），供读取函数双尝试。
fn readonly_attempts(path: &Path) -> Vec<(Connection, bool)> {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut attempts = Vec::new();
    if let Ok(conn) = Connection::open_with_flags(path, flags) {
        let _ = conn.busy_timeout(std::time::Duration::from_millis(1500));
        attempts.push((conn, false));
    }
    // immutable=1 让 SQLite 跳过锁检查与 WAL、直接读主库文件（浏览器运行中可用）。
    // Windows 路径含反斜杠，URI 中必须转义（\ → \\），否则 SQLite 打不开文件。
    let display = path.display().to_string();
    let escaped = display.replace('\\', "\\\\");
    let uri = format!("file:{escaped}?mode=ro&immutable=1");
    if let Ok(conn) =
        Connection::open_with_flags(uri, flags | rusqlite::OpenFlags::SQLITE_OPEN_URI)
    {
        attempts.push((conn, true));
    }
    attempts
}

/// 对真实查询执行"常规 → immutable"双尝试，返回 (结果, 是否 immutable)。
fn query_with_retry<T>(
    path: &Path,
    query: impl Fn(&Connection) -> rusqlite::Result<T>,
) -> (Option<T>, bool) {
    for (conn, immutable) in readonly_attempts(path) {
        if let Ok(value) = query(&conn) {
            return (Some(value), immutable);
        }
    }
    (None, false)
}

/// Browser account username for Chromium profiles: the `account_info` array
/// in `Preferences` (email of the first signed-in account).
fn chromium_account_name(profile_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(profile_dir.join("Preferences")) else {
        return String::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return String::new();
    };
    let Some(accounts) = json.pointer("/account_info").and_then(Value::as_array) else {
        return String::new();
    };
    for account in accounts {
        if let Some(email) = account.get("email").and_then(Value::as_str) {
            if !email.trim().is_empty() {
                return email.trim().to_string();
            }
        }
    }
    String::new()
}

/// Browser account username for Firefox profiles: `services.sync.username`
/// in prefs.js.
fn firefox_account_name(profile_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(profile_dir.join("prefs.js")) else {
        return String::new();
    };
    for line in text.lines() {
        if !line.contains("services.sync.username") {
            continue;
        }
        // Format: user_pref("services.sync.username", "user@example.com");
        // 4th double-quoted segment is the value.
        let mut segments = line.split('"');
        segments.next(); // user_pref(
        segments.next(); // services.sync.username
        segments.next(); // ",
        if let Some(value) = segments.next() {
            if !value.trim().is_empty() {
                return value.trim().to_string();
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

fn sha1_digest(data: &[u8]) -> Vec<u8> {
    Sha1::digest(data).to_vec()
}

/// AES-128-CBC with IV of 16 spaces (Chrome on macOS/Linux pre-v10-era scheme).
fn aes128_cbc_decrypt(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let iv = [0x20u8; 16];
    let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &iv).ok()?;
    let mut buf = payload.to_vec();
    let plain = cipher.decrypt_padded_mut::<cipher::block_padding::Pkcs7>(&mut buf).ok()?;
    Some(plain.to_vec())
}

/// AES-256-GCM with 12-byte nonce + 16-byte tag (Chrome on Windows).
fn aes256_gcm_decrypt(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 12 + 16 {
        return None;
    }
    let (nonce, rest) = payload.split_at(12);
    let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
    cipher.decrypt(aes_gcm::Nonce::from_slice(nonce), rest).ok()
}

/// 3DES-CBC (EDE3) with PKCS7 padding, used by Firefox (NSS).
fn des3_cbc_decrypt(key: &[u8], iv: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let cipher = cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv).ok()?;
    let mut buf = payload.to_vec();
    let plain = cipher.decrypt_padded_mut::<cipher::block_padding::Pkcs7>(&mut buf).ok()?;
    Some(plain.to_vec())
}

/// macOS Keychain lookup, e.g. `security find-generic-password -w -s "Chrome Safe Storage"`.
#[cfg(target_os = "macos")]
fn macos_keychain_password(service: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-w", "-s", service])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    Some(value.trim().to_string())
}

/// Chrome master key on macOS: PBKDF2-HMAC-SHA1 of the Keychain password.
#[cfg(target_os = "macos")]
fn chrome_master_key_macos(service: &str) -> Option<Vec<u8>> {
    let password = macos_keychain_password(service)?;
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    Some(key.to_vec())
}

/// DPAPI unprotect (Windows only).
#[cfg(windows)]
fn windows_dpapi_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use windows_sys::Win32::Foundation::LocalFree;

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: standard Win32 call; blobs point at valid memory.
    let ok = unsafe {
        CryptUnprotectData(
            &mut in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return None;
    }
    // SAFETY: out_blob is owned by DPAPI and must be released with LocalFree.
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(out_blob.pbData as *mut _);
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// App-Bound Encryption (Chrome/Edge 127+, Windows)
// ---------------------------------------------------------------------------
//
// Chrome 127+ 的密码/Cookie 密文前缀为 v20，其 32 字节 `app_bound_key` 存于
// `Local State` 的 `os_crypt.app_bound_encrypted_key`（base64，前缀 "APPB"），
// 由 elevation_service 以 SYSTEM DPAPI 加密（外层）+ 用户 DPAPI 加密（内层）。
// 还原 `app_bound_key` 需先以 SYSTEM 上下文做 DPAPI 解密（普通用户进程需借助
// LSASS 令牌模拟，即要求应用以管理员权限运行），再按 flag 分支：
//   flag 1（127-132）: AES-256-GCM，密钥硬编码在 elevation_service.exe；
//   flag 2（133-136）: ChaCha20-Poly1305，密钥同样硬编码；
//   flag 3（137+）   : CNG "Google Chromekey1"（SYSTEM 凭据）解密
//                      encrypted_aes_key，与静态 XOR 密钥异或后得到 AES 密钥；
// Edge 等非 Chrome 品牌无此附加层，两层 DPAPI 后末尾 32 字节即密钥。

/// Chrome elevation_service.exe 硬编码 AES-256-GCM 密钥（127-132）。
#[cfg(windows)]
const CHROME_ELEVATION_AES_KEY: [u8; 32] = [
    0xb3, 0x1c, 0x6e, 0x24, 0x1a, 0xc8, 0x46, 0x72, 0x8d, 0xa9, 0xc1, 0xfa, 0xc4, 0x93, 0x66, 0x51,
    0xcf, 0xfb, 0x94, 0x4d, 0x14, 0x3a, 0xb8, 0x16, 0x27, 0x6b, 0xcc, 0x6d, 0xa0, 0x28, 0x47, 0x87,
];

/// Chrome elevation_service.exe 硬编码 ChaCha20-Poly1305 密钥（133-136）。
#[cfg(windows)]
const CHROME_ELEVATION_CHACHA_KEY: [u8; 32] = [
    0xe9, 0x8f, 0x37, 0xd7, 0xf4, 0xe1, 0xfa, 0x43, 0x3d, 0x19, 0x30, 0x4d, 0xc2, 0x25, 0x80, 0x42,
    0x09, 0x0e, 0x2d, 0x1d, 0x7e, 0xea, 0x76, 0x70, 0xd4, 0x1f, 0x73, 0x8d, 0x08, 0x72, 0x96, 0x60,
];

/// Chrome 137+ 静态 XOR 密钥（与 CNG 解出的 AES 密钥逐字节异或）。
#[cfg(windows)]
const CHROME_CNG_XOR_KEY: [u8; 32] = [
    0xcc, 0xf8, 0xa1, 0xce, 0xc5, 0x66, 0x05, 0xb8, 0x51, 0x75, 0x52, 0xba, 0x1a, 0x2d, 0x06, 0x1c,
    0x03, 0xa2, 0x9e, 0x90, 0x27, 0x4f, 0xb2, 0xfc, 0xf5, 0x9b, 0xa4, 0xb7, 0x5c, 0x39, 0x23, 0x90,
];

/// AES-256-GCM 显式三段解密（iv / ciphertext / tag 分离布局）。
fn aes_gcm_decrypt_parts(key: &[u8], iv: &[u8], ciphertext: &[u8], tag: &[u8]) -> Option<Vec<u8>> {
    if key.len() != 32 || iv.len() != 12 || tag.len() != 16 {
        return None;
    }
    let mut payload = Vec::with_capacity(ciphertext.len() + tag.len());
    payload.extend_from_slice(ciphertext);
    payload.extend_from_slice(tag);
    let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
    cipher.decrypt(aes_gcm::Nonce::from_slice(iv), payload.as_slice()).ok()
}

/// ChaCha20-Poly1305 显式三段解密（Chrome 133-136 elevation_service 附加层）。
fn chacha20_poly1305_decrypt_parts(
    key: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
    tag: &[u8],
) -> Option<Vec<u8>> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    if key.len() != 32 || iv.len() != 12 || tag.len() != 16 {
        return None;
    }
    let mut payload = Vec::with_capacity(ciphertext.len() + tag.len());
    payload.extend_from_slice(ciphertext);
    payload.extend_from_slice(tag);
    let cipher = chacha20poly1305::ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(key));
    cipher
        .decrypt(chacha20poly1305::Nonce::from_slice(iv), payload.as_slice())
        .ok()
}

/// 在 SYSTEM 上下文执行 DPAPI 解密（App-Bound 外层密钥由 SYSTEM 主密钥保护）。
///
/// 流程：启用 SeDebugPrivilege（需管理员权限）→ 打开 lsass.exe（回退 PID 4）
/// 的进程令牌 → 复制为模拟令牌 → `ImpersonateLoggedOnUser` 后调用
/// `CryptUnprotectData`，随后恢复原令牌。应用未以管理员运行时返回 None。
#[cfg(windows)]
fn windows_dpapi_decrypt_system(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, LUID};
    use windows_sys::Win32::Security::{
        AdjustTokenPrivileges, DuplicateToken, ImpersonateLoggedOnUser, LookupPrivilegeValueW,
        RevertToSelf, SecurityImpersonation, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES,
        TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, LUID_AND_ATTRIBUTES,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_INFORMATION,
    };

    unsafe {
        // 1. 启用 SeDebugPrivilege（仅管理员进程可成功）。
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        ) == 0
        {
            return None;
        }
        let privilege: Vec<u16> = "SeDebugPrivilege\0".encode_utf16().collect();
        let mut luid = LUID {
            LowPart: 0,
            HighPart: 0,
        };
        if LookupPrivilegeValueW(std::ptr::null(), privilege.as_ptr(), &mut luid) == 0 {
            CloseHandle(token);
            return None;
        }
        let mut tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        AdjustTokenPrivileges(token, 0, &mut tp, 0, std::ptr::null_mut(), std::ptr::null_mut());
        CloseHandle(token);

        // 2. 定位 SYSTEM 进程：优先 lsass.exe，回退 PID 4（System）。
        let mut pid: u32 = 4;
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot != INVALID_HANDLE_VALUE {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..std::mem::zeroed()
            };
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let name = String::from_utf16_lossy(&entry.szExeFile);
                    if name.eq_ignore_ascii_case("lsass.exe") {
                        pid = entry.th32ProcessID;
                        break;
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }

        // 3. 复制 SYSTEM 令牌并模拟。
        let process = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut system_token: HANDLE = std::ptr::null_mut();
        let mut impersonation: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_DUPLICATE | TOKEN_QUERY, &mut system_token) == 0
            || DuplicateToken(system_token, SecurityImpersonation, &mut impersonation) == 0
        {
            CloseHandle(process);
            if !system_token.is_null() {
                CloseHandle(system_token);
            }
            return None;
        }
        CloseHandle(process);
        CloseHandle(system_token);
        if ImpersonateLoggedOnUser(impersonation) == 0 {
            CloseHandle(impersonation);
            return None;
        }

        // 4. 在 SYSTEM 上下文执行 DPAPI 解密（CryptUnprotectData 使用线程模拟令牌）。
        let result = windows_dpapi_decrypt(data);

        RevertToSelf();
        CloseHandle(impersonation);
        result
    }
}

/// 用 CNG（NCrypt）解密 Chrome 137+ 的 `encrypted_aes_key`。
///
/// 密钥 "Google Chromekey1" 存于 "Microsoft Software Key Storage Provider"
///（SYSTEM 凭据），必须处于 SYSTEM 上下文才能打开。
#[cfg(windows)]
fn windows_cng_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{
        NCryptDecrypt, NCryptFreeObject, NCryptOpenKey, NCryptOpenStorageProvider,
        NCRYPT_SILENT_FLAG,
    };

    unsafe {
        let mut provider = 0usize;
        let provider_name: Vec<u16> = "Microsoft Software Key Storage Provider\0"
            .encode_utf16()
            .collect();
        if NCryptOpenStorageProvider(&mut provider, provider_name.as_ptr(), 0) != 0 {
            return None;
        }
        let mut key_handle = 0usize;
        let key_name: Vec<u16> = "Google Chromekey1\0".encode_utf16().collect();
        if NCryptOpenKey(provider, &mut key_handle, key_name.as_ptr(), 0, 0) != 0 {
            NCryptFreeObject(provider);
            return None;
        }
        // 第一次调用获取输出大小，第二次实际解密。
        let mut result_len: u32 = 0;
        let status = NCryptDecrypt(
            key_handle,
            data.as_ptr(),
            data.len() as u32,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
            &mut result_len,
            NCRYPT_SILENT_FLAG,
        );
        if status != 0 {
            NCryptFreeObject(key_handle);
            NCryptFreeObject(provider);
            return None;
        }
        let mut output = vec![0u8; result_len as usize];
        let status = NCryptDecrypt(
            key_handle,
            data.as_ptr(),
            data.len() as u32,
            std::ptr::null(),
            output.as_mut_ptr(),
            result_len,
            &mut result_len,
            NCRYPT_SILENT_FLAG,
        );
        NCryptFreeObject(key_handle);
        NCryptFreeObject(provider);
        if status != 0 {
            return None;
        }
        output.truncate(result_len as usize);
        Some(output)
    }
}

/// 解密 content 段（flag 1/2/3，或 Edge 等品牌的裸 32 字节密钥），返回 `app_bound_key`。
#[cfg(windows)]
fn decode_app_bound_content(content: &[u8]) -> Option<Vec<u8>> {
    if content.is_empty() {
        return None;
    }
    match content[0] {
        1 | 2 => {
            // [flag(1)][iv(12)][ciphertext(32)][tag(16)]
            if content.len() != 61 {
                return None;
            }
            let (iv, rest) = content[1..].split_at(12);
            let (ciphertext, tag) = rest.split_at(32);
            if content[0] == 1 {
                aes_gcm_decrypt_parts(&CHROME_ELEVATION_AES_KEY, iv, ciphertext, tag)
            } else {
                chacha20_poly1305_decrypt_parts(&CHROME_ELEVATION_CHACHA_KEY, iv, ciphertext, tag)
            }
        }
        3 => {
            // [flag(1)][encrypted_aes_key(32)][iv(12)][ciphertext(32)][tag(16)]
            if content.len() != 93 {
                return None;
            }
            let encrypted_aes_key = &content[1..33];
            let (iv, rest) = content[33..].split_at(12);
            let (ciphertext, tag) = rest.split_at(32);
            // CNG 解出的 AES 密钥与静态 XOR 密钥逐字节异或，得到真正的 GCM 密钥。
            let decrypted = windows_cng_decrypt(encrypted_aes_key)?;
            let mut xored = [0u8; 32];
            for (i, byte) in xored.iter_mut().enumerate() {
                *byte = decrypted[i] ^ CHROME_CNG_XOR_KEY[i];
            }
            aes_gcm_decrypt_parts(&xored, iv, ciphertext, tag)
        }
        _ => {
            // 无 flag（Edge 等非 Chrome 品牌）：content 即 32 字节密钥。
            if content.len() >= 32 {
                Some(content[content.len() - 32..].to_vec())
            } else {
                None
            }
        }
    }
}

/// 从两层 DPAPI 解密后的明文 blob 中提取 `app_bound_key`。
///
/// 标准结构 `[header_len(4)][validation][content_len(4)][content]`；解析失败时
/// 按末尾特征兜底（部分浏览器/版本的 blob 不带长度前缀）。
#[cfg(windows)]
fn extract_app_bound_key(blob: &[u8]) -> Option<Vec<u8>> {
    // 标准结构：[header_len(4)][validation][content_len(4)][content]
    if blob.len() >= 8 {
        let header_len = u32::from_le_bytes(blob[..4].try_into().ok()?) as usize;
        let pos = 4 + header_len;
        if blob.len() >= pos + 4 {
            let content_len = u32::from_le_bytes(blob[pos..pos + 4].try_into().ok()?) as usize;
            if blob.len() == pos + 4 + content_len {
                if let Some(key) = decode_app_bound_content(&blob[pos + 4..]) {
                    return Some(key);
                }
            }
        }
    }
    // 兜底：按末尾特征识别（部分浏览器/版本不带长度前缀）；解密失败继续
    // 尝试后续方式，避免末尾 32 字节恰似 flag 特征时误判。
    for &(flag, len) in &[(1u8, 61usize), (2, 61), (3, 93)] {
        if blob.len() >= len && blob[blob.len() - len] == flag {
            if let Some(key) = decode_app_bound_content(&blob[blob.len() - len..]) {
                return Some(key);
            }
        }
    }
    if blob.len() >= 32 {
        Some(blob[blob.len() - 32..].to_vec())
    } else {
        None
    }
}

/// 从 `Local State` 还原 App-Bound 密钥（Chrome/Edge 127+ 的 v20 数据用）。
///
/// 解密链（与官方 elevation_service 等价）：APPB 前缀剥离 → SYSTEM DPAPI →
/// 用户 DPAPI → 按 flag 分支恢复 32 字节 `app_bound_key`。
#[cfg(windows)]
fn app_bound_key_windows(root: &Path) -> Option<Vec<u8>> {
    let text = std::fs::read_to_string(root.join("Local State")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let encrypted = json.pointer("/os_crypt/app_bound_encrypted_key")?.as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(encrypted).ok()?;
    let blob = raw.strip_prefix(b"APPB")?;
    // 外层 SYSTEM DPAPI → 内层用户 DPAPI。
    let system = windows_dpapi_decrypt_system(blob)?;
    let user = windows_dpapi_decrypt(&system)?;
    extract_app_bound_key(&user)
}

/// Chrome legacy key on Windows: DPAPI-decrypt `encrypted_key` from `Local State`
///（Chrome 127 之前的 v10 数据用）。
#[cfg(windows)]
fn chrome_legacy_key_windows(root: &Path) -> Option<Vec<u8>> {
    let text = std::fs::read_to_string(root.join("Local State")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let encrypted = json.pointer("/os_crypt/encrypted_key")?.as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(encrypted).ok()?;
    let payload = raw.strip_prefix(b"DPAPI")?;
    windows_dpapi_decrypt(payload)
}

/// Chromium 系浏览器的解密密钥集合。
///
/// - `legacy`: 旧版 `encrypted_key`（Windows DPAPI / macOS Keychain），解 v10 数据；
/// - `app_bound`: App-Bound 密钥（Chrome/Edge 127+，仅 Windows），解 v20 数据。
struct ChromeKeys {
    legacy: Option<Vec<u8>>,
    app_bound: Option<Vec<u8>>,
}

impl ChromeKeys {
    /// 至少持有一种密钥才可继续解密。
    fn is_empty(&self) -> bool {
        self.legacy.is_none() && self.app_bound.is_none()
    }
}

/// Resolve the Chrome-family decryption keys for the platform.
/// Returns (keys, note) where note explains why decryption is unavailable.
fn chrome_keys(root: &Path, source_id: &str) -> (ChromeKeys, String) {
    #[cfg(target_os = "macos")]
    {
        let _ = root;
        let service = match source_id {
            "edge" => "Microsoft Edge Safe Storage",
            _ => "Chrome Safe Storage",
        };
        match chrome_master_key_macos(service) {
            Some(key) => (
                ChromeKeys {
                    legacy: Some(key),
                    app_bound: None,
                },
                String::new(),
            ),
            None => (
                ChromeKeys {
                    legacy: None,
                    app_bound: None,
                },
                "Keychain 中未找到浏览器安全存储密钥（可能从未在该浏览器保存过密码，或 Keychain 访问被拒绝）".to_string(),
            ),
        }
    }
    #[cfg(windows)]
    {
        let _ = source_id;
        let mut notes: Vec<String> = Vec::new();
        // 旧版 encrypted_key（用户 DPAPI，解 v10 数据）。
        let legacy = chrome_legacy_key_windows(root);
        if legacy.is_none() {
            notes.push(
                "无法解密 Windows 凭据（DPAPI 调用失败或 Local State 缺失）".to_string(),
            );
        }
        // App-Bound 密钥（解 v20 数据，Chrome/Edge 127+）。
        let app_bound = if has_app_bound_encryption(root) {
            app_bound_key_windows(root)
        } else {
            None
        };
        if app_bound.is_none() && has_app_bound_encryption(root) {
            notes.push(
                "该浏览器已启用应用绑定加密（Chrome/Edge 127+），需以管理员权限运行应用后才能解密导入，请以管理员身份重启应用后重试"
                    .to_string(),
            );
        }
        (ChromeKeys { legacy, app_bound }, notes.join("；"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux Chrome keeps its key in gnome-keyring/kwallet; unsupported here.
        let _ = (root, source_id);
        (
            ChromeKeys {
                legacy: None,
                app_bound: None,
            },
            "Linux 上 Chrome 系浏览器使用系统密钥环加密，暂不支持解密；Firefox 可用".to_string(),
        )
    }
}

/// Decrypt a single Chrome-family credential blob.
///
/// v20（App-Bound，Chrome/Edge 127+，Windows）用 `app_bound` 密钥 AES-256-GCM
/// 解密；v10（旧版）用 `legacy` 密钥（macOS/Linux 为 AES-128-CBC 16 字节，
/// Windows 为 AES-256-GCM 32 字节）。
fn chrome_decrypt(payload: &[u8], keys: &ChromeKeys) -> Option<Vec<u8>> {
    if let Some(body) = payload.strip_prefix(b"v20") {
        // v20 布局：[iv(12)][ciphertext][tag(16)]。
        let key = keys.app_bound.as_deref()?;
        if key.len() == 32 {
            aes256_gcm_decrypt(key, body)
        } else {
            None
        }
    } else {
        let body = payload.strip_prefix(b"v10").unwrap_or(payload);
        if body.is_empty() {
            return None;
        }
        let key = keys.legacy.as_deref()?;
        if key.len() == 16 {
            aes128_cbc_decrypt(key, body)
        } else {
            aes256_gcm_decrypt(key, body)
        }
    }
}

/// 是否包含 ASCII 控制字符（Chromium 禁止 Cookie 值中出现此类字节）。
fn has_ascii_control(bytes: &[u8]) -> bool {
    bytes.iter().any(|&b| b < 0x20 || b == 0x7f)
}

/// 规范化解密后的 Cookie 明文：Chrome 133+（Cookie 库 schema v24+）会在
/// 解密明文前附加 32 字节 SHA-256 哈希前缀，剥离后才是真实值；同时剥离
/// 前导控制字符（合法 Cookie 值不可能以控制字符开头，但解密产物可能残留）。
///
/// `strip_hash_prefix` 为 `None`（meta 表不可读，如浏览器运行中锁竞争导致
/// SQLITE_BUSY）时回退到启发式判定：前 32 字节含控制字符、32 字节后不含，
/// 则判定前 32 字节为哈希前缀并剥离。随机哈希 32 字节全可打印的概率约 1.4%，
/// 该兜底仅在 meta 查询失败时启用，正常路径仍以 meta 版本精确判定。
fn decode_chromium_value_plaintext(plain: &[u8], strip_hash_prefix: Option<bool>) -> String {
    let strip = match strip_hash_prefix {
        Some(value) => value,
        None => {
            plain.len() >= 32
                && has_ascii_control(&plain[..32])
                && !has_ascii_control(&plain[32..])
        }
    };
    let bytes = if strip && plain.len() >= 32 {
        &plain[32..]
    } else {
        plain
    };
    let text = String::from_utf8_lossy(bytes);
    text.trim_start_matches(|c: char| (c as u32) < 0x20)
        .to_string()
}

/// 解密单条 Chromium Cookie 值：`v20` 前缀为 App-Bound 密文（Windows
/// Chrome/Edge 127+，用 `app_bound` 密钥），`v10` 前缀为旧版 AES 密文；
/// 无前缀时按明文处理（macOS 上部分 Cookie 值明文存储在 encrypted_value）。
/// 返回 None 表示无法解密（如应用未以管理员权限运行导致 ABE 密钥不可用），
/// 调用方应跳过该条。
fn decrypt_chromium_cookie_value(
    payload: &[u8],
    keys: &ChromeKeys,
    strip_hash_prefix: Option<bool>,
) -> Option<String> {
    if let Some(body) = payload.strip_prefix(b"v20") {
        // v20 布局：[iv(12)][ciphertext][tag(16)]，AES-256-GCM，密钥为 app_bound_key；
        // 解密明文同样带 32 字节 SHA-256 哈希前缀，按 meta 版本剥离。
        let key = keys.app_bound.as_deref()?;
        if key.len() != 32 {
            return None;
        }
        let plain = aes256_gcm_decrypt(key, body)?;
        Some(decode_chromium_value_plaintext(&plain, strip_hash_prefix))
    } else if let Some(body) = payload.strip_prefix(b"v10") {
        let key = keys.legacy.as_deref()?;
        let plain = if key.len() == 16 {
            aes128_cbc_decrypt(key, body)?
        } else {
            aes256_gcm_decrypt(key, body)?
        };
        Some(decode_chromium_value_plaintext(&plain, strip_hash_prefix))
    } else {
        // 明文存储路径：不剥离哈希前缀（明文本身不带前缀）。
        Some(decode_chromium_value_plaintext(payload, Some(false)))
    }
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

/// 检测浏览器是否启用了 App-Bound Encryption（Chrome/Edge 127+，Windows）。
/// 特征：`<root>/Local State` 的 `os_crypt.app_bound_encrypted_key` 字段存在，
/// 其 base64 解码后的前 4 字节为 "APPB"。启用后 v20 密文需要系统级密钥
/// 解密，普通用户权限下无法导入。
fn has_app_bound_encryption(root: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join("Local State")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(key) = json
        .pointer("/os_crypt/app_bound_encrypted_key")
        .and_then(Value::as_str)
    else {
        return false;
    };
    // key 是 base64 编码（QVBQ...），解码后才是 "APPB" 字节前缀。
    base64::engine::general_purpose::STANDARD
        .decode(key)
        .map(|raw| raw.starts_with(b"APPB"))
        .unwrap_or(false)
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
    let (keys, _note) = chrome_keys(
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
        let Some(value) = (if !encrypted.is_empty() {
            decrypt_chromium_cookie_value(&encrypted, &keys, strip_hash_prefix)
        } else if value.starts_with("v10") || value.starts_with("v20") {
            decrypt_chromium_cookie_value(value.as_bytes(), &keys, strip_hash_prefix)
        } else {
            Some(value)
        }) else {
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
            // 密文绑定系统级密钥，需管理员权限（LSASS 令牌模拟 + SYSTEM DPAPI）
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
                let has_password_db = password_db.exists();
                let has_cookie_db = cookie_db.is_some();
                if !has_password_db && !has_cookie_db {
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
                    note,
                });
            }
        }
        for (profile, dir) in firefox_profiles() {
            let has_logins = dir.join("logins.json").exists();
            let has_cookies = dir.join("cookies.sqlite").exists();
            if !has_logins && !has_cookies {
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
