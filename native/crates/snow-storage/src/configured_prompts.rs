//! API 档案配置的用户系统提示词解析。

use crate::chat_conversations::get_conversation_directory_id;
use crate::system_prompts::resolve_active_system_prompt_contents;

/// 按会话工作目录解析 `system_prompt_ids_json`，每条提示词单独返回。
pub async fn resolve_configured_system_prompts(
    system_prompt_ids_json: &str,
    conversation_id: Option<&str>,
) -> Vec<String> {
    let system_prompt_ids_json = system_prompt_ids_json.to_string();
    let conversation_id = conversation_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let Ok(database_path) = snow_storage_core::bootstrap::ensure_database_file() else {
            return Vec::new();
        };
        let directory_id = conversation_id.as_deref().and_then(|id| {
            get_conversation_directory_id(&database_path, id)
                .ok()
                .flatten()
        });
        resolve_active_system_prompt_contents(
            &database_path,
            &system_prompt_ids_json,
            directory_id.as_deref(),
        )
    })
    .await
    .unwrap_or_default()
}
