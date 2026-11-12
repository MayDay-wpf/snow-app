//! 浏览器加密数据的解密函数群（Chrome 系 + Firefox 共用）。

use super::*;

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

pub(crate) fn sha1_digest(data: &[u8]) -> Vec<u8> {
    Sha1::digest(data).to_vec()
}

/// AES-128-CBC with IV of 16 spaces (Chrome on macOS/Linux pre-v10-era scheme).
pub(crate) fn aes128_cbc_decrypt(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let iv = [0x20u8; 16];
    let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &iv).ok()?;
    let mut buf = payload.to_vec();
    let plain = cipher.decrypt_padded_mut::<cipher::block_padding::Pkcs7>(&mut buf).ok()?;
    Some(plain.to_vec())
}

/// AES-256-GCM with 12-byte nonce + 16-byte tag (Chrome on Windows).
pub(crate) fn aes256_gcm_decrypt(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 12 + 16 {
        return None;
    }
    let (nonce, rest) = payload.split_at(12);
    let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
    cipher.decrypt(aes_gcm::Nonce::from_slice(nonce), rest).ok()
}

/// 3DES-CBC (EDE3) with PKCS7 padding, used by Firefox (NSS).
pub(crate) fn des3_cbc_decrypt(key: &[u8], iv: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let cipher = cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv).ok()?;
    let mut buf = payload.to_vec();
    let plain = cipher.decrypt_padded_mut::<cipher::block_padding::Pkcs7>(&mut buf).ok()?;
    Some(plain.to_vec())
}

/// macOS Keychain lookup, e.g. `security find-generic-password -w -s "Chrome Safe Storage"`.
#[cfg(target_os = "macos")]
pub(crate) fn macos_keychain_password(service: &str) -> Option<String> {
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
pub(crate) fn chrome_master_key_macos(service: &str) -> Option<Vec<u8>> {
    let password = macos_keychain_password(service)?;
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    Some(key.to_vec())
}

/// DPAPI unprotect (Windows only).
#[cfg(windows)]
pub(crate) fn windows_dpapi_decrypt(data: &[u8]) -> Option<Vec<u8>> {
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
// 可读取令牌的 SYSTEM 进程模拟，即要求应用以管理员权限运行），再按 flag 分支：
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
#[cfg(windows)]
pub(crate) fn aes_gcm_decrypt_parts(key: &[u8], iv: &[u8], ciphertext: &[u8], tag: &[u8]) -> Option<Vec<u8>> {
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
#[cfg(windows)]
pub(crate) fn chacha20_poly1305_decrypt_parts(
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

/// 在 SYSTEM 上下文执行闭包。
///
/// 管理员进程并不等于 SYSTEM；同时现代 Windows 上 lsass.exe / PID 4 通常受
/// PPL 保护，即使启用了 SeDebugPrivilege 也无法读取其令牌。因此优先从
/// winlogon.exe / services.exe / wininit.exe 等非 PPL 的 SYSTEM 进程复制模拟令牌。
/// 枚举进程名时必须在首个 NUL 处截断，不能直接转换整个固定长度数组。
#[cfg(windows)]
pub(crate) fn with_windows_system_impersonation<T>(operation: impl Fn() -> Option<T>) -> Option<T> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, LUID};
    use windows_sys::Win32::Security::{
        AdjustTokenPrivileges, DuplicateToken, ImpersonateLoggedOnUser, LookupPrivilegeValueW,
        RevertToSelf, SecurityImpersonation, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_INFORMATION,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        // 1. 启用 SeDebugPrivilege（管理员令牌才可获得该权限）。
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

        // 2. 枚举可读取令牌的 SYSTEM 进程。不要只使用 lsass.exe / PID 4：
        // 它们在现代 Windows 上通常受 PPL 保护。priority 越小越优先。
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut candidates: Vec<(usize, u32)> = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..std::mem::zeroed()
        };
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&character| character == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                let priority = if name.eq_ignore_ascii_case("winlogon.exe") {
                    Some(0)
                } else if name.eq_ignore_ascii_case("services.exe") {
                    Some(1)
                } else if name.eq_ignore_ascii_case("wininit.exe") {
                    Some(2)
                } else if name.eq_ignore_ascii_case("lsass.exe") {
                    Some(3)
                } else {
                    None
                };
                if let Some(priority) = priority {
                    candidates.push((priority, entry.th32ProcessID));
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        candidates.sort_unstable_by_key(|&(priority, _)| priority);

        // 3. 依次尝试复制 SYSTEM 模拟令牌，并在该上下文执行闭包。
        for (_, pid) in candidates {
            let mut process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                process = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
            }
            if process.is_null() {
                continue;
            }
            let mut system_token: HANDLE = std::ptr::null_mut();
            let opened = OpenProcessToken(process, TOKEN_DUPLICATE | TOKEN_QUERY, &mut system_token);
            CloseHandle(process);
            if opened == 0 {
                continue;
            }
            let mut impersonation: HANDLE = std::ptr::null_mut();
            let duplicated = DuplicateToken(system_token, SecurityImpersonation, &mut impersonation);
            CloseHandle(system_token);
            if duplicated == 0 || impersonation.is_null() {
                continue;
            }
            if ImpersonateLoggedOnUser(impersonation) == 0 {
                CloseHandle(impersonation);
                continue;
            }

            let result = operation();
            RevertToSelf();
            CloseHandle(impersonation);
            if result.is_some() {
                return result;
            }
        }
        None
    }
}

/// 在 SYSTEM 上下文执行 DPAPI 解密（App-Bound 外层密钥由 SYSTEM 主密钥保护）。
#[cfg(windows)]
pub(crate) fn windows_dpapi_decrypt_system(data: &[u8]) -> Option<Vec<u8>> {
    with_windows_system_impersonation(|| windows_dpapi_decrypt(data))
}

/// 用 CNG（NCrypt）解密 Chrome 137+ 的 `encrypted_aes_key`。
///
/// 密钥 "Google Chromekey1" 存于 "Microsoft Software Key Storage Provider"
///（SYSTEM 凭据），因此 CNG 打开和解密也必须在 SYSTEM 模拟上下文内完成，
/// 不能在外层 DPAPI 解密结束并恢复当前用户后直接调用。
#[cfg(windows)]
pub(crate) fn windows_cng_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    with_windows_system_impersonation(|| windows_cng_decrypt_as_system(data))
}

#[cfg(windows)]
fn windows_cng_decrypt_as_system(data: &[u8]) -> Option<Vec<u8>> {
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
        if NCryptOpenKey(provider, &mut key_handle, key_name.as_ptr(), 0, NCRYPT_SILENT_FLAG) != 0 {
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
        if status != 0 || result_len == 0 {
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
            if decrypted.len() != 32 {
                return None;
            }
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
pub(crate) fn app_bound_key_windows(root: &Path) -> Option<Vec<u8>> {
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
pub(crate) struct ChromeKeys {
    legacy: Option<Vec<u8>>,
    app_bound: Option<Vec<u8>>,
}

impl ChromeKeys {
    /// 至少持有一种密钥才可继续解密。
    pub(crate) fn is_empty(&self) -> bool {
        self.legacy.is_none() && self.app_bound.is_none()
    }
}

/// Resolve the Chrome-family decryption keys for the platform.
/// Returns (keys, note) where note explains why decryption is unavailable.
pub(crate) fn chrome_keys(root: &Path, source_id: &str) -> (ChromeKeys, String) {
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
pub(crate) fn chrome_decrypt(payload: &[u8], keys: &ChromeKeys) -> Option<Vec<u8>> {
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
pub(crate) fn decrypt_chromium_cookie_value(
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

/// 检测浏览器是否启用了 App-Bound Encryption（Chrome/Edge 127+，Windows）。
/// 特征：`<root>/Local State` 的 `os_crypt.app_bound_encrypted_key` 字段存在，
/// 其 base64 解码后的前 4 字节为 "APPB"。启用后 v20 密文需要系统级密钥
/// 解密，普通用户权限下无法导入。
pub(crate) fn has_app_bound_encryption(root: &Path) -> bool {
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
