//! 应用锁（PIN + 谷歌身份验证器 TOTP）的 NAPI 类型与转发。

use super::*;

use crate::storage::services::app_lock;

#[napi(object)]
pub struct AppLockStateNapi {
    pub enabled: bool,
    pub has_pin: bool,
    pub totp_bound: bool,
    pub remote_unlock: bool,
    pub delay_ms: u32,
    pub locked: bool,
}

impl From<AppLockState> for AppLockStateNapi {
    fn from(state: AppLockState) -> Self {
        AppLockStateNapi {
            enabled: state.enabled,
            has_pin: state.has_pin,
            totp_bound: state.totp_bound,
            remote_unlock: state.remote_unlock,
            delay_ms: state.delay_ms,
            locked: state.locked,
        }
    }
}

#[napi(object)]
pub struct AppLockVerifyResultNapi {
    pub ok: bool,
    pub retry_after_ms: u32,
    pub remaining_attempts: u32,
}

impl From<AppLockVerifyResult> for AppLockVerifyResultNapi {
    fn from(result: AppLockVerifyResult) -> Self {
        AppLockVerifyResultNapi {
            ok: result.ok,
            retry_after_ms: result.retry_after_ms,
            remaining_attempts: result.remaining_attempts,
        }
    }
}

#[napi(object)]
pub struct AppLockTotpBindingNapi {
    pub secret: String,
    pub otpauth_uri: String,
}

impl From<AppLockTotpBinding> for AppLockTotpBindingNapi {
    fn from(binding: AppLockTotpBinding) -> Self {
        AppLockTotpBindingNapi {
            secret: binding.secret,
            otpauth_uri: binding.otpauth_uri,
        }
    }
}

#[napi]
pub async fn get_app_lock_state() -> napi::Result<AppLockStateNapi> {
    tokio::task::spawn_blocking(|| -> napi::Result<AppLockStateNapi> {
        let database_path = crate::storage::ensure_database_file()?;
        Ok(app_lock::get_app_lock_state(&database_path)?.into())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_app_lock_delay(delay_ms: u32) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || -> napi::Result<()> {
        let database_path = crate::storage::ensure_database_file()?;
        app_lock::set_app_lock_delay(&database_path, delay_ms)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_app_lock_remote_unlock(enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || -> napi::Result<()> {
        let database_path = crate::storage::ensure_database_file()?;
        app_lock::set_app_lock_remote_unlock(&database_path, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn begin_app_lock_totp_binding() -> napi::Result<AppLockTotpBindingNapi> {
    tokio::task::spawn_blocking(|| -> napi::Result<AppLockTotpBindingNapi> {
        Ok(app_lock::begin_app_lock_totp_binding()?.into())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn confirm_app_lock_totp_binding(
    secret: String,
    code: String,
    verification: String,
) -> napi::Result<bool> {
    tokio::task::spawn_blocking(move || -> napi::Result<bool> {
        let database_path = crate::storage::ensure_database_file()?;
        app_lock::confirm_app_lock_totp_binding(&database_path, &secret, &code, &verification)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn clear_app_lock_totp(code: String) -> napi::Result<AppLockVerifyResultNapi> {
    tokio::task::spawn_blocking(move || -> napi::Result<AppLockVerifyResultNapi> {
        let database_path = crate::storage::ensure_database_file()?;
        Ok(app_lock::clear_app_lock_totp(&database_path, &code)?.into())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn enable_app_lock(pin: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || -> napi::Result<()> {
        let database_path = crate::storage::ensure_database_file()?;
        app_lock::enable_app_lock(&database_path, &pin)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn change_app_lock_pin(
    verification: String,
    new_pin: String,
) -> napi::Result<AppLockVerifyResultNapi> {
    tokio::task::spawn_blocking(move || -> napi::Result<AppLockVerifyResultNapi> {
        let database_path = crate::storage::ensure_database_file()?;
        Ok(app_lock::change_app_lock_pin(&database_path, &verification, &new_pin)?.into())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn disable_app_lock(verification: String) -> napi::Result<AppLockVerifyResultNapi> {
    tokio::task::spawn_blocking(move || -> napi::Result<AppLockVerifyResultNapi> {
        let database_path = crate::storage::ensure_database_file()?;
        Ok(app_lock::disable_app_lock(&database_path, &verification)?.into())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn verify_app_lock_pin(pin: String) -> napi::Result<AppLockVerifyResultNapi> {
    tokio::task::spawn_blocking(move || -> napi::Result<AppLockVerifyResultNapi> {
        let database_path = crate::storage::ensure_database_file()?;
        Ok(app_lock::verify_app_lock_pin(&database_path, &pin)?.into())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn verify_app_lock_totp(code: String) -> napi::Result<AppLockVerifyResultNapi> {
    tokio::task::spawn_blocking(move || -> napi::Result<AppLockVerifyResultNapi> {
        let database_path = crate::storage::ensure_database_file()?;
        Ok(app_lock::verify_app_lock_totp(&database_path, &code)?.into())
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_app_lock_locked(locked: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || -> napi::Result<()> {
        let database_path = crate::storage::ensure_database_file()?;
        app_lock::set_app_lock_locked(&database_path, locked)
    })
    .await
    .map_err(map_spawn_error)?
}
