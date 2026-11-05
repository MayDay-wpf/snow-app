use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;

use napi::bindgen_prelude::*;

use super::store::{is_valid_chunk_hash, LocalStore};

/// 删除超出保留份数的旧备份，返回实际删除的份数。
pub(crate) fn prune_manifests(store: &LocalStore, keep: u32) -> Result<u32> {
    let mut manifests = store.list_manifests()?;
    if manifests.len() <= keep as usize {
        return Ok(0);
    }

    let mut removed = 0;
    for manifest in manifests.split_off(keep as usize) {
        store.delete_manifest(&manifest.id)?;
        store.clear_latest_if(&manifest.id)?;
        removed += 1;
    }
    Ok(removed)
}

/// 删除不再被任何清单引用的块，返回释放的字节数。
///
/// 只清理 `chunks/<两位前缀>/` 下的合法块文件；`.tmp` 是写入中的临时文件，
/// 前缀目录清空后一并移除。
pub(crate) fn sweep_orphan_chunks(store: &LocalStore) -> Result<u64> {
    let mut referenced: HashSet<String> = HashSet::new();
    for manifest in store.list_manifests()? {
        for file in manifest.files {
            referenced.extend(file.chunks);
        }
    }

    let chunk_root = store.chunk_root();
    let shards = match fs::read_dir(&chunk_root) {
        Ok(shards) => shards,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(Error::from_reason(format!(
                "Failed to list backup chunks '{}': {error}",
                chunk_root.display()
            )))
        }
    };

    let mut freed = 0_u64;
    for shard in shards {
        let shard = shard.map_err(|error| {
            Error::from_reason(format!("Failed to read backup chunk shard: {error}"))
        })?;
        if !shard
            .file_type()
            .map_err(|error| Error::from_reason(format!("Failed to inspect chunk shard: {error}")))?
            .is_dir()
        {
            continue;
        }

        let shard_path = shard.path();
        let mut remaining = 0_usize;
        let entries = fs::read_dir(&shard_path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to read backup chunk shard '{}': {error}",
                shard_path.display()
            ))
        })?;

        for entry in entries {
            let entry = entry.map_err(|error| {
                Error::from_reason(format!("Failed to read backup chunk entry: {error}"))
            })?;
            if !entry
                .file_type()
                .map_err(|error| {
                    Error::from_reason(format!("Failed to inspect backup chunk: {error}"))
                })?
                .is_file()
            {
                continue;
            }

            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.ends_with(".tmp") || !is_valid_chunk_hash(name) {
                continue;
            }
            if referenced.contains(name) {
                remaining += 1;
                continue;
            }

            let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            match fs::remove_file(entry.path()) {
                Ok(()) => freed += size,
                // 删除失败（被占用等）时保留目录，下次再试。
                Err(_) => remaining += 1,
            }
        }

        if remaining == 0 {
            let _ = fs::remove_dir(&shard_path);
        }
    }

    Ok(freed)
}
