use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use pbkdf2::pbkdf2_hmac;
use sha1::{Digest, Sha1};
use sha2::Sha256;

use super::system_settings::{get_system_setting_value, set_system_setting};

const SETTING_NAME: &str = "App lock";
const ENABLED_CODE: &str = "app_lock_enabled";
const PIN_HASH_CODE: &str = "app_lock_pin_hash";
const TOTP_SECRET_CODE: &str = "app_lock_totp_secret";
const REMOTE_UNLOCK_CODE: &str = "app_lock_remote_unlock";
const DELAY_CODE: &str = "app_lock_delay_ms";
const LOCKED_CODE: &str = "app_lock_locked";
const FAILURES_CODE: &str = "app_lock_failures";
const COOLDOWN_CODE: &str = "app_lock_cooldown_until_ms";

const DEFAULT_DELAY_MS: u32 = 60_000;
const ALLOWED_DELAYS_MS: [u32; 4] = [0, 60_000, 300_000, 600_000];

const PIN_MIN_LEN: usize = 4;
const PIN_MAX_LEN: usize = 8;
const PIN_SALT_LEN: usize = 16;
const PIN_KEY_LEN: usize = 32;
const PIN_ITERATIONS: u32 = 120_000;

const TOTP_SECRET_BYTES: usize = 20;
const TOTP_STEP_SECONDS: u64 = 30;
const TOTP_DIGITS: u32 = 6;
const TOTP_DRIFT_STEPS: i64 = 1;
const TOTP_ISSUER: &str = "Snow App";

const MAX_ATTEMPTS: u64 = 5;
const BASE_COOLDOWN_MS: u64 = 30_000;
const MAX_COOLDOWN_MS: u64 = 300_000;

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

#[derive(Clone, Debug, Default)]
pub struct AppLockState {
    pub enabled: bool,
    pub has_pin: bool,
    pub totp_bound: bool,
    /// 手机远控是否接受身份验证器动态码代替配对令牌。
    pub remote_unlock: bool,
    pub delay_ms: u32,
    pub locked: bool,
}

#[derive(Clone, Debug, Default)]
pub struct AppLockVerifyResult {
    pub ok: bool,
    pub retry_after_ms: u32,
    pub remaining_attempts: u32,
}

#[derive(Clone, Debug, Default)]
pub struct AppLockTotpBinding {
    pub secret: String,
    pub otpauth_uri: String,
}

pub fn get_app_lock_state(database_path: &Path) -> Result<AppLockState> {
    let has_pin = !read_text(database_path, PIN_HASH_CODE)?.is_empty();
    let totp_bound = !read_text(database_path, TOTP_SECRET_CODE)?.is_empty();
    let remote_unlock = totp_bound && remote_unlock_setting(database_path)?;
    let delay_ms = normalize_delay_ms(u32::try_from(read_u64(database_path, DELAY_CODE)?).unwrap_or(DEFAULT_DELAY_MS));
    // PIN 不允许脱离身份验证器独立生效：缺少 PIN 或绑定即视为未启用，避免找不回应用。
    let enabled = read_bool(database_path, ENABLED_CODE)? && has_pin && totp_bound;
    let locked = read_bool(database_path, LOCKED_CODE)? && enabled;
    Ok(AppLockState {
        enabled,
        has_pin,
        totp_bound,
        remote_unlock,
        delay_ms,
        locked,
    })
}

pub fn normalize_delay_ms(delay_ms: u32) -> u32 {
    if ALLOWED_DELAYS_MS.contains(&delay_ms) {
        delay_ms
    } else {
        DEFAULT_DELAY_MS
    }
}

pub fn set_app_lock_delay(database_path: &Path, delay_ms: u32) -> Result<()> {
    write_setting(
        database_path,
        DELAY_CODE,
        &normalize_delay_ms(delay_ms).to_string(),
    )
}

/// 手机远控是否允许用身份验证器动态码代替配对令牌：未绑定即不允许，
/// 已绑定时未显式关闭即允许。
pub fn remote_unlock_enabled(database_path: &Path) -> Result<bool> {
    if read_text(database_path, TOTP_SECRET_CODE)?.is_empty() {
        return Ok(false);
    }
    remote_unlock_setting(database_path)
}

pub fn set_app_lock_remote_unlock(database_path: &Path, enabled: bool) -> Result<()> {
    write_setting(
        database_path,
        REMOTE_UNLOCK_CODE,
        if enabled { "true" } else { "false" },
    )
}

/// 校验远控解锁动态码：只比对动态码本身，不占用应用锁的尝试次数与冷却
/// （远控 HTTP 侧另有独立的频率限制）。
pub fn verify_remote_unlock_code(database_path: &Path, code: &str) -> Result<bool> {
    let secret = read_text(database_path, TOTP_SECRET_CODE)?;
    Ok(!secret.is_empty() && totp_matches(&secret, code))
}

fn remote_unlock_setting(database_path: &Path) -> Result<bool> {
    Ok(read_text(database_path, REMOTE_UNLOCK_CODE)?.trim() != "false")
}

pub fn begin_app_lock_totp_binding() -> Result<AppLockTotpBinding> {
    let mut bytes = [0u8; TOTP_SECRET_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| Error::from_reason(format!("Failed to generate TOTP secret: {error}")))?;
    let secret = base32_encode(&bytes);
    let label = TOTP_ISSUER.replace(' ', "%20");
    let otpauth_uri = format!(
        "otpauth://totp/{label}?secret={secret}&issuer={label}&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_STEP_SECONDS}"
    );
    Ok(AppLockTotpBinding {
        secret,
        otpauth_uri,
    })
}

pub fn confirm_app_lock_totp_binding(
    database_path: &Path,
    secret: &str,
    code: &str,
    verification: &str,
) -> Result<bool> {
    // 已设置 PIN 时必须在落库前复核 PIN；仅有旧绑定（锁定未启用）时，
    // 动态码校验放在生成新密钥之前完成，避免 30 秒过期导致误判。
    if !read_text(database_path, PIN_HASH_CODE)?.is_empty() {
        let identity = verify_app_lock_pin(database_path, verification)?;
        if !identity.ok {
            return Ok(false);
        }
    }
    let normalized = secret
        .trim()
        .to_ascii_uppercase()
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .collect::<String>();
    if base32_decode(&normalized).is_none() || !totp_matches(&normalized, code) {
        return Ok(false);
    }
    write_setting(database_path, TOTP_SECRET_CODE, &normalized)?;
    reset_failures(database_path)?;
    Ok(true)
}

/// 解绑身份验证器：只接受身份验证器动态码（PIN 可能已被遗忘），
/// 成功后一并清除动态码密钥与 PIN——PIN 不允许脱离身份验证器独立存在。
pub fn clear_app_lock_totp(database_path: &Path, code: &str) -> Result<AppLockVerifyResult> {
    if read_text(database_path, TOTP_SECRET_CODE)?.is_empty() {
        return Ok(success_result());
    }
    let result = verify_app_lock_totp(database_path, code)?;
    if !result.ok {
        return Ok(result);
    }
    write_setting(database_path, TOTP_SECRET_CODE, "")?;
    write_setting(database_path, PIN_HASH_CODE, "")?;
    write_setting(database_path, ENABLED_CODE, "false")?;
    write_setting(database_path, LOCKED_CODE, "false")?;
    reset_failures(database_path)?;
    Ok(success_result())
}

pub fn enable_app_lock(database_path: &Path, pin: &str) -> Result<()> {
    if !is_valid_pin(pin) {
        return Err(Error::from_reason(format!(
            "PIN must be {PIN_MIN_LEN}-{PIN_MAX_LEN} digits"
        )));
    }
    if read_text(database_path, TOTP_SECRET_CODE)?.is_empty() {
        return Err(Error::from_reason(
            "Bind Google Authenticator before enabling the app lock",
        ));
    }
    write_setting(database_path, PIN_HASH_CODE, &hash_pin(pin))?;
    write_setting(database_path, ENABLED_CODE, "true")?;
    write_setting(database_path, LOCKED_CODE, "false")?;
    reset_failures(database_path)
}

/// 停用应用锁：接受当前 PIN 或身份验证器动态码任一验证。
pub fn disable_app_lock(database_path: &Path, verification: &str) -> Result<AppLockVerifyResult> {
    let result = verify_app_lock_credential(database_path, verification)?;
    if !result.ok {
        return Ok(result);
    }
    write_setting(database_path, PIN_HASH_CODE, "")?;
    write_setting(database_path, ENABLED_CODE, "false")?;
    write_setting(database_path, LOCKED_CODE, "false")?;
    Ok(result)
}

/// 更换 PIN：接受当前 PIN 或身份验证器动态码任一验证（PIN 可能已被遗忘）。
pub fn change_app_lock_pin(
    database_path: &Path,
    verification: &str,
    new_pin: &str,
) -> Result<AppLockVerifyResult> {
    if !is_valid_pin(new_pin) {
        return Err(Error::from_reason(format!(
            "PIN must be {PIN_MIN_LEN}-{PIN_MAX_LEN} digits"
        )));
    }
    let result = verify_app_lock_credential(database_path, verification)?;
    if !result.ok {
        return Ok(result);
    }
    write_setting(database_path, PIN_HASH_CODE, &hash_pin(new_pin))?;
    Ok(result)
}

pub fn verify_app_lock_pin(database_path: &Path, pin: &str) -> Result<AppLockVerifyResult> {
    let retry_after_ms = cooldown_remaining_ms(database_path)?;
    if retry_after_ms > 0 {
        return Ok(AppLockVerifyResult {
            ok: false,
            retry_after_ms: u32::try_from(retry_after_ms).unwrap_or(u32::MAX),
            remaining_attempts: 0,
        });
    }
    let stored = read_text(database_path, PIN_HASH_CODE)?;
    if stored.is_empty() {
        return register_failure(database_path);
    }
    if verify_pin_hash(pin, &stored) {
        reset_failures(database_path)?;
        return Ok(success_result());
    }
    register_failure(database_path)
}

pub fn verify_app_lock_totp(database_path: &Path, code: &str) -> Result<AppLockVerifyResult> {
    let retry_after_ms = cooldown_remaining_ms(database_path)?;
    if retry_after_ms > 0 {
        return Ok(AppLockVerifyResult {
            ok: false,
            retry_after_ms: u32::try_from(retry_after_ms).unwrap_or(u32::MAX),
            remaining_attempts: 0,
        });
    }
    let secret = read_text(database_path, TOTP_SECRET_CODE)?;
    if !secret.is_empty() && totp_matches(&secret, code) {
        reset_failures(database_path)?;
        return Ok(success_result());
    }
    register_failure(database_path)
}

pub fn set_app_lock_locked(database_path: &Path, locked: bool) -> Result<()> {
    if !locked {
        reset_failures(database_path)?;
    }
    write_setting(database_path, LOCKED_CODE, if locked { "true" } else { "false" })
}

fn success_result() -> AppLockVerifyResult {
    AppLockVerifyResult {
        ok: true,
        retry_after_ms: 0,
        remaining_attempts: MAX_ATTEMPTS as u32,
    }
}

/// 校验「当前身份」：PIN 或身份验证器动态码任一匹配即通过，共用尝试次数与冷却。
fn verify_app_lock_credential(database_path: &Path, value: &str) -> Result<AppLockVerifyResult> {
    let retry_after_ms = cooldown_remaining_ms(database_path)?;
    if retry_after_ms > 0 {
        return Ok(AppLockVerifyResult {
            ok: false,
            retry_after_ms: u32::try_from(retry_after_ms).unwrap_or(u32::MAX),
            remaining_attempts: 0,
        });
    }
    let stored_pin = read_text(database_path, PIN_HASH_CODE)?;
    if !stored_pin.is_empty() && verify_pin_hash(value, &stored_pin) {
        reset_failures(database_path)?;
        return Ok(success_result());
    }
    let secret = read_text(database_path, TOTP_SECRET_CODE)?;
    if !secret.is_empty() && totp_matches(&secret, value) {
        reset_failures(database_path)?;
        return Ok(success_result());
    }
    register_failure(database_path)
}

fn read_text(database_path: &Path, code: &str) -> Result<String> {
    Ok(get_system_setting_value(database_path, code)?.unwrap_or_default())
}

fn read_bool(database_path: &Path, code: &str) -> Result<bool> {
    Ok(read_text(database_path, code)?.trim() == "true")
}

fn read_u64(database_path: &Path, code: &str) -> Result<u64> {
    Ok(read_text(database_path, code)?
        .trim()
        .parse::<u64>()
        .unwrap_or(0))
}

fn write_setting(database_path: &Path, code: &str, value: &str) -> Result<()> {
    set_system_setting(database_path, SETTING_NAME, code, value)
}

fn is_valid_pin(pin: &str) -> bool {
    let length = pin.len();
    (PIN_MIN_LEN..=PIN_MAX_LEN).contains(&length) && pin.chars().all(|c| c.is_ascii_digit())
}

fn hash_pin(pin: &str) -> String {
    let mut salt = [0u8; PIN_SALT_LEN];
    if getrandom::getrandom(&mut salt).is_err() {
        for (index, byte) in salt.iter_mut().enumerate() {
            *byte = ((now_ms() >> (index % 8 * 8)) & 0xff) as u8;
        }
    }
    let mut key = [0u8; PIN_KEY_LEN];
    pbkdf2_hmac::<Sha256>(pin.as_bytes(), &salt, PIN_ITERATIONS, &mut key);
    format!(
        "{}${}${}",
        PIN_ITERATIONS,
        to_hex(&salt),
        to_hex(&key)
    )
}

fn verify_pin_hash(pin: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let iterations = parts
        .next()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(PIN_ITERATIONS);
    let salt = parts.next().and_then(from_hex);
    let expected = parts.next().and_then(from_hex);
    let (Some(salt), Some(expected)) = (salt, expected) else {
        return false;
    };
    if expected.is_empty() {
        return false;
    }
    let mut key = vec![0u8; expected.len()];
    pbkdf2_hmac::<Sha256>(pin.as_bytes(), &salt, iterations, &mut key);
    constant_time_eq(&key, &expected)
}

fn register_failure(database_path: &Path) -> Result<AppLockVerifyResult> {
    let failures = read_u64(database_path, FAILURES_CODE)? + 1;
    write_setting(database_path, FAILURES_CODE, &failures.to_string())?;
    if failures < MAX_ATTEMPTS {
        return Ok(AppLockVerifyResult {
            ok: false,
            retry_after_ms: 0,
            remaining_attempts: (MAX_ATTEMPTS - failures) as u32,
        });
    }
    let steps = (failures - MAX_ATTEMPTS).min(4);
    let cooldown_ms = BASE_COOLDOWN_MS
        .saturating_mul(1u64 << steps)
        .min(MAX_COOLDOWN_MS);
    write_setting(
        database_path,
        COOLDOWN_CODE,
        &(now_ms() + cooldown_ms).to_string(),
    )?;
    Ok(AppLockVerifyResult {
        ok: false,
        retry_after_ms: u32::try_from(cooldown_ms).unwrap_or(u32::MAX),
        remaining_attempts: 0,
    })
}

fn reset_failures(database_path: &Path) -> Result<()> {
    write_setting(database_path, FAILURES_CODE, "0")?;
    write_setting(database_path, COOLDOWN_CODE, "0")
}

fn cooldown_remaining_ms(database_path: &Path) -> Result<u64> {
    let until_ms = read_u64(database_path, COOLDOWN_CODE)?;
    Ok(until_ms.saturating_sub(now_ms()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        let high = (bytes[index] as char).to_digit(16)?;
        let low = (bytes[index + 1] as char).to_digit(16)?;
        out.push((high * 16 + low) as u8);
        index += 2;
    }
    Some(out)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn totp_matches(secret: &str, code: &str) -> bool {
    let Some(key) = base32_decode(secret) else {
        return false;
    };
    let normalized = code.trim();
    if normalized.len() != TOTP_DIGITS as usize || !normalized.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let Ok(provided) = normalized.parse::<u32>() else {
        return false;
    };
    let Some(counter) = current_counter() else {
        return false;
    };
    (-TOTP_DRIFT_STEPS..=TOTP_DRIFT_STEPS).any(|drift| {
        let candidate = counter.wrapping_add_signed(drift);
        totp_code(&key, candidate) == provided
    })
}

fn current_counter() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_secs() / TOTP_STEP_SECONDS)
}

fn totp_code(key: &[u8], counter: u64) -> u32 {
    let digest = hmac_sha1(key, &counter.to_be_bytes());
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    binary % 10u32.pow(TOTP_DIGITS)
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> Vec<u8> {
    const BLOCK_LEN: usize = 64;
    let mut block = [0u8; BLOCK_LEN];
    if key.len() > BLOCK_LEN {
        let digest = Sha1::digest(key);
        block[..digest.len()].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; BLOCK_LEN];
    let mut outer_pad = [0x5cu8; BLOCK_LEN];
    for index in 0..BLOCK_LEN {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }
    let mut inner = Sha1::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha1::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().to_vec()
}

fn base32_encode(data: &[u8]) -> String {
    let mut text = String::with_capacity((data.len() * 8).div_ceil(5));
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in data {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1f) as usize;
            text.push(BASE32_ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1f) as usize;
        text.push(BASE32_ALPHABET[index] as char);
    }
    text
}

fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for character in text.chars() {
        if character == '=' {
            break;
        }
        let value = BASE32_ALPHABET
            .iter()
            .position(|candidate| *candidate as char == character)? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}
