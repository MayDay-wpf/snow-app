use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use napi::bindgen_prelude::*;

use super::manifest::{BackupManifest, LatestPointer, MANIFEST_VERSION};

const MANIFEST_PREFIX: &str = "manifests/";
const CHUNK_PREFIX: &str = "chunks/";
const LATEST_KEY: &str = "latest.json";

/// 备份后端的最小对象存储接口。
///
/// key 是相对备份根的正斜杠路径（`manifests/<id>.json`、`chunks/<hh>/<hash>`、
/// `latest.json`）。本地目录与 Cloudflare R2 只需实现这几个读写原语，分块、
/// 清单、保留策略与恢复流程全部共用。
pub(crate) trait ObjectStore {
    /// 读取对象；不存在时返回 None。
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    /// 写入对象（整体覆盖，读者不会看到写了一半的内容）。
    fn put(&self, key: &str, bytes: &[u8]) -> Result<()>;
    /// 删除对象；不存在时视为成功。
    fn delete(&self, key: &str) -> Result<()>;
    /// 列出 key 以 prefix 开头的全部对象。
    fn list(&self, prefix: &str) -> Result<Vec<String>>;
    /// 本地临时工作区根目录（数据库快照落在这里），必须位于 `.snowapp` 之外。
    fn work_root(&self) -> PathBuf;
}

/// 建立在对象存储之上的备份仓库：清单、内容块与最新指针的读写。
pub(crate) struct BackupRepo {
    store: Box<dyn ObjectStore>,
    /// 已存在的块哈希。首次用到时一次性列举，避免网络后端逐块探测。
    chunks: Mutex<Option<HashSet<String>>>,
}

impl BackupRepo {
    pub(crate) fn new(store: Box<dyn ObjectStore>) -> Self {
        Self {
            store,
            chunks: Mutex::new(None),
        }
    }

    /// 创建本次操作专用的临时目录，并清掉同名残留。
    pub(crate) fn create_work_dir(&self, name: &str) -> Result<PathBuf> {
        validate_work_dir_name(name)?;
        let directory = self.store.work_root().join(name);
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

    /// 删除本次操作的临时目录（尽力而为：残留会在同名续跑时被清掉）。
    pub(crate) fn remove_work_dir(&self, name: &str) {
        if validate_work_dir_name(name).is_ok() {
            let _ = fs::remove_dir_all(self.store.work_root().join(name));
        }
    }

    fn known_chunks(&self) -> Result<MutexGuard<'_, Option<HashSet<String>>>> {
        let mut guard = self
            .chunks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = Some(self.list_chunks()?.into_iter().collect());
        }
        Ok(guard)
    }

    pub(crate) fn has_chunk(&self, hash: &str) -> Result<bool> {
        if !is_valid_chunk_hash(hash) {
            return Ok(false);
        }
        Ok(self
            .known_chunks()?
            .as_ref()
            .is_some_and(|chunks| chunks.contains(hash)))
    }

    /// 写入一个内容块。返回 true 表示本次真正写入，false 表示已有相同内容。
    pub(crate) fn put_chunk(&self, hash: &str, bytes: &[u8]) -> Result<bool> {
        validate_chunk_hash(hash)?;
        if self.has_chunk(hash)? {
            return Ok(false);
        }
        self.store.put(&chunk_key(hash), bytes)?;
        if let Some(chunks) = self.known_chunks()?.as_mut() {
            chunks.insert(hash.to_string());
        }
        Ok(true)
    }

    pub(crate) fn get_chunk(&self, hash: &str) -> Result<Vec<u8>> {
        validate_chunk_hash(hash)?;
        self.store.get(&chunk_key(hash))?.ok_or_else(|| {
            Error::from_reason(format!("Backup chunk '{hash}' is missing"))
        })
    }

    /// 列出后端中全部合法的块哈希。
    pub(crate) fn list_chunks(&self) -> Result<Vec<String>> {
        Ok(self
            .store
            .list(CHUNK_PREFIX)?
            .into_iter()
            .filter_map(|key| {
                let name = key.rsplit('/').next()?;
                is_valid_chunk_hash(name).then(|| name.to_string())
            })
            .collect())
    }

    pub(crate) fn delete_chunk(&self, hash: &str) -> Result<()> {
        validate_chunk_hash(hash)?;
        self.store.delete(&chunk_key(hash))?;
        if let Some(chunks) = self.known_chunks()?.as_mut() {
            chunks.remove(hash);
        }
        Ok(())
    }

    pub(crate) fn write_manifest(&self, manifest: &BackupManifest) -> Result<()> {
        validate_backup_id(&manifest.id)?;
        let json = serde_json::to_vec(manifest).map_err(|error| {
            Error::from_reason(format!("Failed to serialize backup manifest: {error}"))
        })?;
        self.store.put(&manifest_key(&manifest.id), &json)
    }

    pub(crate) fn read_manifest(&self, backup_id: &str) -> Result<BackupManifest> {
        validate_backup_id(backup_id)?;
        let bytes = self
            .store
            .get(&manifest_key(backup_id))?
            .ok_or_else(|| Error::from_reason(format!("Backup '{backup_id}' does not exist")))?;
        let manifest: BackupManifest = serde_json::from_slice(&bytes).map_err(|error| {
            Error::from_reason(format!(
                "Failed to parse backup manifest '{backup_id}': {error}"
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
        let mut manifests = Vec::new();
        for key in self.store.list(MANIFEST_PREFIX)? {
            let Some(backup_id) = key
                .strip_prefix(MANIFEST_PREFIX)
                .and_then(|name| name.strip_suffix(".json"))
            else {
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
        self.store.delete(&manifest_key(backup_id))
    }

    /// 读取最新一份备份。指针缺失或损坏时回退为扫描清单。
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
        self.store.put(LATEST_KEY, &json)
    }

    /// 删除的正好是当前指针指向的备份时，同时清掉指针。
    pub(crate) fn clear_latest_if(&self, backup_id: &str) -> Result<()> {
        let Some(pointer) = self.read_latest()? else {
            return Ok(());
        };
        if pointer.backup_id == backup_id {
            self.store.delete(LATEST_KEY)?;
        }
        Ok(())
    }

    fn read_latest(&self) -> Result<Option<LatestPointer>> {
        let Some(bytes) = self.store.get(LATEST_KEY)? else {
            return Ok(None);
        };
        // 指针只是加速缓存，损坏时静默回退到清单扫描。
        Ok(serde_json::from_slice(&bytes).ok())
    }
}

fn manifest_key(backup_id: &str) -> String {
    format!("{MANIFEST_PREFIX}{backup_id}.json")
}

fn chunk_key(hash: &str) -> String {
    format!("{CHUNK_PREFIX}{}/{hash}", &hash[..2])
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
