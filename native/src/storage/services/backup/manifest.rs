use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// manifest 结构版本。恢复端据此拒绝不认识的备份格式。
pub(crate) const MANIFEST_VERSION: u32 = 1;

/// 一份完整备份的清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BackupManifest {
    pub(crate) version: u32,
    pub(crate) id: String,
    /// 生成备份时的应用版本，用于恢复前提示版本差异。
    pub(crate) app_version: String,
    pub(crate) created_at_ms: i64,
    /// 生成该备份时使用的块大小，恢复时用于校验兼容性。
    pub(crate) chunk_size: u32,
    pub(crate) total_bytes: i64,
    pub(crate) files: Vec<ManifestFile>,
}

/// 清单中的单个文件条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ManifestFile {
    /// 相对 `.snowapp` 的正斜杠路径。
    pub(crate) path: String,
    pub(crate) size: i64,
    /// 备份时源文件的修改时间（Unix 毫秒），用于下次备份判断能否跳过读取。
    pub(crate) modified_ms: i64,
    /// 按顺序拼接即为完整文件内容的内容寻址块哈希。
    pub(crate) chunks: Vec<String>,
}

/// `latest.json` 指针，避免网络后端每次备份都全量列举清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LatestPointer {
    pub(crate) backup_id: String,
    pub(crate) created_at_ms: i64,
}

/// 上一份备份留下的 (大小, 修改时间) 索引。
///
/// 只有一个用途：源文件自上次备份以来没有变化时直接复用它的块列表，
/// 从而跳过读取。归档库这类数百 MB 的冷数据因此不会在每次备份时被重扫。
pub(crate) struct ReuseIndex {
    entries: HashMap<String, (i64, i64, Vec<String>)>,
}

impl ReuseIndex {
    pub(crate) fn from_manifest(manifest: Option<&BackupManifest>) -> Self {
        let mut entries = HashMap::new();
        if let Some(manifest) = manifest {
            for file in &manifest.files {
                entries.insert(
                    file.path.clone(),
                    (file.size, file.modified_ms, file.chunks.clone()),
                );
            }
        }
        Self { entries }
    }

    /// 命中时返回上次记录的块列表。
    pub(crate) fn lookup(
        &self,
        relative_path: &str,
        size: i64,
        modified_ms: i64,
    ) -> Option<Vec<String>> {
        let (previous_size, previous_modified, chunks) = self.entries.get(relative_path)?;
        if *previous_size == size && *previous_modified == modified_ms {
            Some(chunks.clone())
        } else {
            None
        }
    }
}

/// 备份 id：`20261105T201530-3f2a9c1b`，时间前缀可读，随机后缀避免同秒冲突。
pub(crate) fn generate_backup_id() -> String {
    let timestamp = chrono::Local::now().format("%Y%m%dT%H%M%S");
    let mut seed = [0_u8; 8];
    let suffix = if getrandom::getrandom(&mut seed).is_ok() {
        blake3::hash(&seed).to_hex().to_string()
    } else {
        format!("{:016x}", chrono::Local::now().timestamp_millis())
    };
    format!("{timestamp}-{}", &suffix[..8])
}
