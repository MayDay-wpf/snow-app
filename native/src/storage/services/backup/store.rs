use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;

use super::manifest::{BackupManifest, LatestPointer, MANIFEST_VERSION};
use super::BACKUP_DIR_NAME;

const MANIFEST_DIR: &str = "manifests";
const CHUNK_DIR: &str = "chunks";
const LATEST_FILE: &str = "latest.json";
const WORK_DIR: &str = ".work";

/// 本地目录后端：把备份写进 `<target>/snow-app-backup/`。
///
/// key 空间刻意与将来的网络后端保持一致（`manifests/<id>.json` 与
/// `chunks/<hash前两位>/<hash>`），这样切换后端时只替换读写实现，
/// 分块、清单与保留策略都不受影响。
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
        for directory in [MANIFEST_DIR, CHUNK_DIR, WORK_DIR] {
            fs::create_dir_all(root.join(directory)).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to create backup directory '{}': {error}",
                    root.join(directory).display()
                ))
            })?;
        }

        Ok(Self { root })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn chunk_root(&self) -> PathBuf {
        self.root.join(CHUNK_DIR)
    }

    /// 创建本次操作专用的临时目录，并清掉同名残留。
    pub(crate) fn create_work_dir(&self, name: &str) -> Result<PathBuf> {
        validate_work_dir_name(name)?;
        let directory = self.root.join(WORK_DIR).join(name);
        if directory.exists() {
            fs::remove_dir_all(&directory).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to clear backup workspace '{}': {error}",
                    directory.display()
                ))
            })?;
        }
        fs::create_dir_all(&directory).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create backup workspace '{}': {error}",
                directory.display()
            ))
        })?;
        Ok(directory)
    }

    pub(crate) fn has_chunk(&self, hash: &str) -> bool {
        is_valid_chunk_hash(hash) && self.chunk_path(hash).is_file()
    }

    /// 写入一个内容块。返回 true 表示本次真正落盘，false 表示已有相同内容。
    pub(crate) fn put_chunk(&self, hash: &str, bytes: &[u8]) -> Result<bool> {
        validate_chunk_hash(hash)?;
        let directory = self.chunk_root().join(&hash[..2]);
        let final_path = directory.join(hash);
        if final_path.is_file() {
            return Ok(false);
        }

        fs::create_dir_all(&directory).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create backup chunk directory '{}': {error}",
                directory.display()
            ))
        })?;

        let temporary = directory.join(format!("{hash}.tmp"));
        fs::write(&temporary, bytes).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!(
                "Failed to write backup chunk '{}': {error}",
                temporary.display()
            ))
        })?;

        match fs::rename(&temporary, &final_path) {
            Ok(()) => Ok(true),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                // 并发写入同一内容块时，目标可能已被另一个任务发布。
                if final_path.is_file() {
                    Ok(false)
                } else {
                    Err(Error::from_reason(format!(
                        "Failed to publish backup chunk '{}': {error}",
                        final_path.display()
                    )))
                }
            }
        }
    }

    pub(crate) fn get_chunk(&self, hash: &str) -> Result<Vec<u8>> {
        validate_chunk_hash(hash)?;
        let path = self.chunk_path(hash);
        fs::read(&path).map_err(|error| {
            Error::from_reason(format!(
                "Backup chunk '{}' is missing or unreadable: {error}",
                path.display()
            ))
        })
    }

    pub(crate) fn write_manifest(&self, manifest: &BackupManifest) -> Result<()> {
        validate_backup_id(&manifest.id)?;
        let directory = self.root.join(MANIFEST_DIR);
        let json = serde_json::to_vec(manifest).map_err(|error| {
            Error::from_reason(format!("Failed to serialize backup manifest: {error}"))
        })?;
        let temporary = directory.join(format!("{}.tmp", manifest.id));
        fs::write(&temporary, json).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!(
                "Failed to write backup manifest '{}': {error}",
                temporary.display()
            ))
        })?;
        let final_path = directory.join(format!("{}.json", manifest.id));
        fs::rename(&temporary, &final_path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!(
                "Failed to publish backup manifest '{}': {error}",
                final_path.display()
            ))
        })
    }

    pub(crate) fn read_manifest(&self, backup_id: &str) -> Result<BackupManifest> {
        validate_backup_id(backup_id)?;
        let path = self
            .root
            .join(MANIFEST_DIR)
            .join(format!("{backup_id}.json"));
        let json = fs::read_to_string(&path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to read backup manifest '{}': {error}",
                path.display()
            ))
        })?;
        let manifest: BackupManifest = serde_json::from_str(&json).map_err(|error| {
            Error::from_reason(format!(
                "Failed to parse backup manifest '{}': {error}",
                path.display()
            ))
        })?;
        if manifest.version != MANIFEST_VERSION {
            return Err(Error::from_reason(format!(
                "Unsupported backup format version {} in '{}'",
                manifest.version, backup_id
            )));
        }
        Ok(manifest)
    }

    /// 列出全部可读清单，按创建时间倒序。单个清单损坏不影响其它备份。
    pub(crate) fn list_manifests(&self) -> Result<Vec<BackupManifest>> {
        let directory = self.root.join(MANIFEST_DIR);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(Error::from_reason(format!(
                    "Failed to list backup manifests '{}': {error}",
                    directory.display()
                )))
            }
        };

        let mut manifests = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| {
                Error::from_reason(format!("Failed to read backup manifest entry: {error}"))
            })?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(backup_id) = name.strip_suffix(".json") else {
                continue;
            };
            if !is_valid_backup_id(backup_id) {
                continue;
            }
            if let Ok(manifest) = self.read_manifest(backup_id) {
                manifests.push(manifest);
            }
        }
        manifests.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
        Ok(manifests)
    }

    pub(crate) fn delete_manifest(&self, backup_id: &str) -> Result<()> {
        validate_backup_id(backup_id)?;
        let path = self
            .root
            .join(MANIFEST_DIR)
            .join(format!("{backup_id}.json"));
        if path.is_file() {
            fs::remove_file(&path).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to delete backup manifest '{}': {error}",
                    path.display()
                ))
            })?;
        }
        Ok(())
    }

    /// 读取最新一份备份。指针缺失或损坏时回退为扫描清单目录。
    pub(crate) fn latest_manifest(&self) -> Result<Option<BackupManifest>> {
        if let Some(pointer) = self.read_latest()? {
            if is_valid_backup_id(&pointer.backup_id) {
                if let Ok(manifest) = self.read_manifest(&pointer.backup_id) {
                    return Ok(Some(manifest));
                }
            }
        }
        Ok(self.list_manifests()?.into_iter().next())
    }

    pub(crate) fn write_latest(&self, backup_id: &str, created_at_ms: i64) -> Result<()> {
        validate_backup_id(backup_id)?;
        let pointer = LatestPointer {
            backup_id: backup_id.to_string(),
            created_at_ms,
        };
        let json = serde_json::to_vec(&pointer).map_err(|error| {
            Error::from_reason(format!("Failed to serialize latest pointer: {error}"))
        })?;
        let temporary = self.root.join(format!("{LATEST_FILE}.{backup_id}.tmp"));
        fs::write(&temporary, json).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!(
                "Failed to write latest pointer '{}': {error}",
                temporary.display()
            ))
        })?;
        let final_path = self.root.join(LATEST_FILE);
        fs::rename(&temporary, &final_path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!(
                "Failed to publish latest pointer '{}': {error}",
                final_path.display()
            ))
        })
    }

    /// 删除的正好是当前指针指向的备份时，同时清掉指针。
    pub(crate) fn clear_latest_if(&self, backup_id: &str) -> Result<()> {
        let Some(pointer) = self.read_latest()? else {
            return Ok(());
        };
        if pointer.backup_id == backup_id {
            let path = self.root.join(LATEST_FILE);
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }

    fn read_latest(&self) -> Result<Option<LatestPointer>> {
        let path = self.root.join(LATEST_FILE);
        if !path.is_file() {
            return Ok(None);
        }
        let json = fs::read_to_string(&path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to read latest pointer '{}': {error}",
                path.display()
            ))
        })?;
        // 指针只是加速缓存，损坏时静默回退到清单扫描。
        Ok(serde_json::from_str(&json).ok())
    }

    fn chunk_path(&self, hash: &str) -> PathBuf {
        self.chunk_root().join(&hash[..2]).join(hash)
    }
}

/// 备份 id 只允许字母、数字与连字符，避免通过清单名做路径穿越。
pub(crate) fn is_valid_backup_id(backup_id: &str) -> bool {
    !backup_id.is_empty()
        && backup_id.len() <= 64
        && backup_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(crate) fn validate_backup_id(backup_id: &str) -> Result<()> {
    if is_valid_backup_id(backup_id) {
        Ok(())
    } else {
        Err(Error::from_reason(format!(
            "Invalid backup id: {backup_id}"
        )))
    }
}

/// 临时工作目录名：字母、数字与连字符，禁止路径分隔符与 `..`。
fn validate_work_dir_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 128
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(Error::from_reason(format!(
            "Invalid backup workspace name: {name}"
        )))
    }
}

/// 内容地址是 64 位小写十六进制 BLAKE3。
pub(crate) fn is_valid_chunk_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn validate_chunk_hash(hash: &str) -> Result<()> {
    if is_valid_chunk_hash(hash) {
        Ok(())
    } else {
        Err(Error::from_reason(format!(
            "Invalid backup chunk hash: {hash}"
        )))
    }
}
