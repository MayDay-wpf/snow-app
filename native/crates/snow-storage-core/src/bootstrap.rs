//! 数据库初始化钩子。
//!
//! core 只负责路径解析；完整初始化（建表、迁移、seed）由桥接层注册，
//! 避免 core 反向依赖业务服务。

use std::path::PathBuf;
use std::sync::OnceLock;

pub type Initializer = fn() -> napi::Result<PathBuf>;

static INITIALIZER: OnceLock<Initializer> = OnceLock::new();

pub fn register_database_initializer(initializer: Initializer) {
    let _ = INITIALIZER.set(initializer);
}

pub fn ensure_database_file() -> napi::Result<PathBuf> {
    if let Some(initializer) = INITIALIZER.get() {
        return initializer();
    }
    let storage_dir = snow_support::app_paths::app_storage_dir()?;
    let _ = std::fs::create_dir_all(&storage_dir);
    Ok(snow_support::app_paths::database_file_path(&storage_dir))
}
