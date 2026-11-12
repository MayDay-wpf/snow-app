//! 非主对话流的模型请求（文件搜索 agent / 仓库 Wiki / 决策模型）同样写入用量记录，
//! 保证用量统计的真实性：每次请求一条，失败请求 token 为 0、状态 error。

use std::path::{Path, PathBuf};

use snow_storage::chat_conversations::ChatTokenUsage;
use snow_storage::usage_records::{record_usage, UsageRecordInput};

/// 一次自建请求的用量归属信息。
pub struct UsageContext {
    pub database_path: PathBuf,
    pub model: String,
    pub api_profile_name: String,
    pub api_config_id: String,
    pub request_method: String,
    /// 会话归属；空串表示该请求不属于任何会话（如文件搜索 agent）。
    pub conversation_id: String,
    pub directory_id: String,
}

impl UsageContext {
    pub async fn record(&self, usage: ChatTokenUsage, status: &'static str) {
        let database_path = self.database_path.clone();
        let model = self.model.clone();
        let api_profile_name = self.api_profile_name.clone();
        let api_config_id = self.api_config_id.clone();
        let request_method = self.request_method.clone();
        let conversation_id = self.conversation_id.clone();
        let directory_id = self.directory_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            record_usage(
                &database_path,
                &UsageRecordInput {
                    conversation_id: &conversation_id,
                    response_id: "",
                    model: &model,
                    api_profile_name: &api_profile_name,
                    api_config_id: &api_config_id,
                    request_method: &request_method,
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens,
                    cache_read_input_tokens: usage.cache_read_input_tokens,
                    status,
                    is_sub_agent: false,
                    directory_id: &directory_id,
                },
            )
        })
        .await;
        match result {
            Ok(Err(error)) => eprintln!("[usage] failed to record usage: {}", error.reason),
            Err(error) => eprintln!("[usage] failed to record usage: {error}"),
            Ok(Ok(())) => {}
        }
    }
}

/// 一次决策模型调用的用量归属与 token。
pub struct DecisionUsageInput<'a> {
    pub model: &'a str,
    /// 决策模型条目名，写入 api_profile_name（不是 API profile）。
    pub model_name: &'a str,
    /// 空串表示该调用不属于任何会话（如敏感命令判定）。
    pub conversation_id: &'a str,
    pub directory_id: &'a str,
    pub input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub status: &'static str,
}

/// 记录一次决策模型调用：请求方法固定 decisions，输出 token 固定 0
/// （Decisions API 不计输出费），api_config_id 留空。
pub async fn record_decision_usage(input: DecisionUsageInput<'_>) {
    if snow_runtime::ephemeral::is_active() {
        return;
    }

    let Ok(Ok(database_path)) =
        tokio::task::spawn_blocking(snow_storage_core::bootstrap::ensure_database_file).await
    else {
        return;
    };

    UsageContext {
        database_path,
        model: input.model.to_string(),
        api_profile_name: input.model_name.to_string(),
        api_config_id: String::new(),
        request_method: "decisions".to_string(),
        conversation_id: input.conversation_id.to_string(),
        directory_id: input.directory_id.to_string(),
    }
    .record(
        ChatTokenUsage {
            input_tokens: input.input_tokens,
            output_tokens: 0,
            cache_creation_input_tokens: input.cache_creation_input_tokens,
            cache_read_input_tokens: input.cache_read_input_tokens,
        },
        input.status,
    )
    .await;
}

/// 按项目路径查项目 id（项目已移除时为空串）。
pub fn resolve_directory_id(database_path: &Path, project_path: &str) -> String {
    let key = snow_support::paths::normalize_project_path(project_path);
    snow_storage::workspace_directories::list_workspace_directories(database_path)
        .ok()
        .and_then(|directories| {
            directories.into_iter().find(|directory| {
                snow_support::paths::normalize_project_path(&directory.path) == key
            })
        })
        .map(|directory| directory.directory_id)
        .unwrap_or_default()
}
