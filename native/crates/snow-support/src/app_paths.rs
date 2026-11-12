use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;

const APP_STORAGE_DIR_NAME: &str = ".snowapp";
const APP_DATABASE_FILE_NAME: &str = "snowapp.db";
/// 会话归档专用冷数据库：与运行库分离，保持运行库小体积的同时数据不丢失。
const ARCHIVE_DATABASE_FILE_NAME: &str = "archive.db";

pub fn app_storage_dir() -> Result<PathBuf> {
    let home_dir = dirs_next::home_dir().ok_or_else(|| {
        Error::from_reason("Failed to resolve the current user's home directory".to_string())
    })?;

    Ok(home_dir.join(APP_STORAGE_DIR_NAME))
}

pub fn database_file_path(storage_dir: &Path) -> PathBuf {
    storage_dir.join(APP_DATABASE_FILE_NAME)
}

pub fn archive_database_file_path(storage_dir: &Path) -> PathBuf {
    storage_dir.join(ARCHIVE_DATABASE_FILE_NAME)
}
