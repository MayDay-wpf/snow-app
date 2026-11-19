use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;

use super::store::ObjectStore;
use super::BACKUP_DIR_NAME;

/// 快照与恢复的临时工作区，位于备份根目录下。
const WORK_DIR: &str = ".work";

/// 本地目录后端：把备份写进 `<target>/snow-app-backup/`。
///
/// key 直接映射为备份根目录下的相对路径，与网络后端共用同一套 key 空间。
pub(crate) struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    /// 打开（必要时创建）备份根目录，并拒绝把备份写进应用数据目录内部。
    pub(crate) fn open(target_dir: &str) -> Result<Self> {
        let target = Path::new(target_dir);
        if target.exists() {
            if !target.is_dir() {
                return Err(Error::from_reason(format!(
                    "Backup target is not a directory: {target_dir}"
                )));
            }
        } else {
            fs::create_dir_all(target).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to create backup target '{}': {error}",
                    target.display()
                ))
            })?;
        }

        let target = fs::canonicalize(target).map_err(|error| {
            Error::from_reason(format!(
                "Failed to resolve backup target '{}': {error}",
                target.display()
            ))
        })?;
        let app_dir = crate::storage::paths::app_storage_dir()?;
        let app_dir = fs::canonicalize(&app_dir).unwrap_or(app_dir);

        // 备份目录若落在 .snowapp 内部，下一次备份会把上一次的备份一起打包，
        // 体积立刻翻倍且不断自我嵌套，必须在入口处拒绝。
        if target.starts_with(&app_dir) {
            return Err(Error::from_reason(format!(
                "Backup target '{}' is inside Snow App's data directory; choose a directory outside '{}'",
                target.display(),
                app_dir.display()
            )));
        }

        let root = target.join(BACKUP_DIR_NAME);
        fs::create_dir_all(&root).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create backup directory '{}': {error}",
                root.display()
            ))
        })?;

        Ok(Self { root })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn path_of(&self, key: &str) -> PathBuf {
        key.split('/')
            .filter(|part| !part.is_empty())
            .fold(self.root.clone(), |path, part| path.join(part))
    }
}

impl ObjectStore for LocalStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let path = self.path_of(key);
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(Error::from_reason(format!(
                "Failed to read backup file '{}': {error}",
                path.display()
            ))),
        }
    }

    /// 先写同目录临时文件再改名，读者永远看不到写了一半的内容。
    fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let path = self.path_of(key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to create backup directory '{}': {error}",
                    parent.display()
                ))
            })?;
        }

        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("object");
        let temporary = path.with_file_name(format!("{name}.tmp"));
        fs::write(&temporary, bytes).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!(
                "Failed to write backup file '{}': {error}",
                temporary.display()
            ))
        })?;
        fs::rename(&temporary, &path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!(
                "Failed to publish backup file '{}': {error}",
                path.display()
            ))
        })
    }

    fn delete(&self, key: &str) -> Result<()> {
        let path = self.path_of(key);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(Error::from_reason(format!(
                    "Failed to delete backup file '{}': {error}",
                    path.display()
                )))
            }
        }

        // 分片目录（chunks/<两位前缀>/）清空后一并移除；顶层目录保留。
        if let Some(parent) = path.parent() {
            if parent != self.root && parent.parent() != Some(self.root.as_path()) {
                let _ = fs::remove_dir(parent);
            }
        }
        Ok(())
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let mut keys = Vec::new();
        let mut pending = vec![self.path_of(prefix)];

        while let Some(directory) = pending.pop() {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(Error::from_reason(format!(
                        "Failed to list backup directory '{}': {error}",
                        directory.display()
                    )))
                }
            };

            for entry in entries {
                let entry = entry.map_err(|error| {
                    Error::from_reason(format!("Failed to read backup directory entry: {error}"))
                })?;
                let file_type = entry.file_type().map_err(|error| {
                    Error::from_reason(format!("Failed to inspect backup file: {error}"))
                })?;
                let path = entry.path();
                if file_type.is_dir() {
                    pending.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                let Some(relative) = path.strip_prefix(&self.root).ok().and_then(Path::to_str)
                else {
                    continue;
                };
                // `.tmp` 是写入中的临时文件，不是已发布的对象。
                if relative.ends_with(".tmp") {
                    continue;
                }
                keys.push(relative.replace('\\', "/"));
            }
        }

        Ok(keys)
    }

    fn work_root(&self) -> PathBuf {
        self.root.join(WORK_DIR)
    }
}
