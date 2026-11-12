//! codebase 运行状态端口：由 exports 层注册，避免 api 反向依赖导出层。

use std::sync::OnceLock;

pub type IsEmbeddingActive = fn(&str) -> bool;
pub type IsSyncActive = fn(&str) -> bool;

static EMBEDDING_ACTIVE: OnceLock<IsEmbeddingActive> = OnceLock::new();
static SYNC_ACTIVE: OnceLock<IsSyncActive> = OnceLock::new();

pub fn register(embedding_active: IsEmbeddingActive, sync_active: IsSyncActive) {
    let _ = EMBEDDING_ACTIVE.set(embedding_active);
    let _ = SYNC_ACTIVE.set(sync_active);
}

pub fn is_embedding_active(project_id: &str) -> bool {
    EMBEDDING_ACTIVE
        .get()
        .map(|check| check(project_id))
        .unwrap_or(false)
}

pub fn is_sync_active(project_id: &str) -> bool {
    SYNC_ACTIVE
        .get()
        .map(|check| check(project_id))
        .unwrap_or(true)
}
