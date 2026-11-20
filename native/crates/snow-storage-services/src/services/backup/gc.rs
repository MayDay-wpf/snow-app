use std::collections::HashSet;

use napi::bindgen_prelude::*;

use super::progress::TaskProgress;
use super::store::BackupRepo;

/// 删除超出保留份数的旧备份，返回实际删除的份数。
pub(crate) fn prune_manifests(repo: &BackupRepo, keep: u32) -> Result<u32> {
    let mut manifests = repo.list_manifests()?;
    if manifests.len() <= keep as usize {
        return Ok(0);
    }

    let mut removed = 0;
    for manifest in manifests.split_off(keep as usize) {
        repo.delete_manifest(&manifest.id)?;
        repo.clear_latest_if(&manifest.id)?;
        removed += 1;
    }
    Ok(removed)
}

/// 删除不再被任何清单引用的块，返回删除的块数量。
///
/// 传入 `task` 时上报回收进度：先进入 scan 阶段列举清单与块，再在 reclaim
/// 阶段按块推进（总数为待回收的块数）。R2 上逐个删除对象很慢，没有进度时
/// 用户只能看到一个长时间不动的界面。
///
/// 单个块删除失败（被占用、网络抖动等）不中断回收，留待下次再试。
/// 传入 `task` 时每块前检查取消请求；未回收的孤儿块由下一次回收清理。
pub(crate) fn sweep_orphan_chunks(repo: &BackupRepo, task: Option<&TaskProgress>) -> Result<u32> {
    if let Some(task) = task {
        task.phase("scan");
    }

    let mut referenced: HashSet<String> = HashSet::new();
    for manifest in repo.list_manifests()? {
        for file in manifest.files {
            referenced.extend(file.chunks);
        }
    }

    let orphans: Vec<String> = repo
        .list_chunks()?
        .into_iter()
        .filter(|hash| !referenced.contains(hash))
        .collect();

    if let Some(task) = task {
        task.ensure_not_cancelled()?;
        task.set_totals(0, orphans.len() as u32);
        task.phase("reclaim");
    }

    let mut removed = 0_u32;
    for hash in orphans {
        if let Some(task) = task {
            task.ensure_not_cancelled()?;
        }
        if repo.delete_chunk(&hash).is_ok() {
            removed += 1;
        }
        if let Some(task) = task {
            task.advance(0, 1);
        }
    }
    Ok(removed)
}
