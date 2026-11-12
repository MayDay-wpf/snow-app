//! 由桥接层注入的端口，避免领域层反向依赖上层服务。

use std::path::Path;
use std::sync::OnceLock;

pub struct ConversationWorktreeBinding {
    pub directory_id: String,
    pub worktree_path: String,
    pub is_valid: bool,
}

pub type WorktreeResolver =
    fn(&Path, &str) -> napi::Result<Option<ConversationWorktreeBinding>>;

static WORKTREE_RESOLVER: OnceLock<WorktreeResolver> = OnceLock::new();

pub fn register_conversation_worktree_resolver(resolver: WorktreeResolver) {
    let _ = WORKTREE_RESOLVER.set(resolver);
}

pub fn resolve_conversation_worktree(
    database_path: &Path,
    conversation_id: &str,
) -> napi::Result<Option<ConversationWorktreeBinding>> {
    match WORKTREE_RESOLVER.get() {
        Some(resolver) => resolver(database_path, conversation_id),
        None => Ok(None),
    }
}
