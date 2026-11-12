//! API 配置的批量导出 / 导入（跨设备、跨安装迁移）。
//!
//! - 导出：按 profileName 挑选配置，生成带版本号的 JSON 迁移文档（含明文密钥）。
//! - 导入：解析迁移文档（也兼容裸数组 / 单条对象），按冲突策略写库。
//!
//! Electron 侧只负责弹出文件对话框与读写文件字节，文档结构与字段映射全部留在
//! Rust，避免同一套字段映射在 Node 侧再实现一遍。

use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{json, Map, Value};

use super::super::{ApiConfigInput, ApiConfigRecord};
use super::api_configs::{list_api_configs, upsert_api_config};

/// 迁移文档标识与版本；导入时据此识别文件类型。
const DOCUMENT_KIND: &str = "snow-app-api-configs";
const DOCUMENT_VERSION: i64 = 1;

/// 同名冲突策略（由渲染层传入）。
const STRATEGY_OVERWRITE: &str = "overwrite";
const STRATEGY_DUPLICATE: &str = "duplicate";

/// 导出文件中的单个配置（用于导入预览展示）。
#[napi(object)]
pub struct ApiConfigTransferItem {
    pub profile_name: String,
    pub display_name: String,
    pub base_url: String,
    pub request_method: String,
    pub advanced_model: String,
}

/// 导入前的文件预览结果（不写库），供用户确认同名冲突处理方式。
#[napi(object)]
pub struct ApiConfigImportPreview {
    pub profiles: Vec<ApiConfigTransferItem>,
    /// 文件中无法识别（缺少配置名等）而被忽略的条目数。
    pub skipped_count: i32,
}

/// 导入执行结果。
#[napi(object)]
pub struct ApiConfigImportOutcome {
    pub imported_count: i32,
    /// 覆盖了同名的既有配置数量（仅 overwrite 策略可能非 0）。
    pub overwritten_count: i32,
    /// 因同名而重命名为新副本的数量（仅 duplicate 策略可能非 0）。
    pub renamed_count: i32,
    pub skipped_count: i32,
    /// 导入后按文件中的激活标记切换了当前启用配置时，返回该配置名。
    pub activated_profile_name: Option<String>,
}

/// 导出结果：迁移文档文本 + 实际导出条数。
#[napi(object)]
pub struct ApiConfigExportResult {
    pub content: String,
    pub exported_count: i32,
}

/// 导出选中配置为迁移文档 JSON 文本。
pub fn export_api_configs(
    database_path: &Path,
    profile_names: &[String],
) -> Result<ApiConfigExportResult> {
    let requested: Vec<String> = profile_names
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    if requested.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "At least one API profile must be selected to export".to_string(),
        ));
    }

    let configs = list_api_configs(database_path)?;
    let mut selected: Vec<&ApiConfigRecord> = Vec::new();
    for name in &requested {
        if selected.iter().any(|config| &config.profile_name == name) {
            continue;
        }
        if let Some(config) = configs.iter().find(|config| &config.profile_name == name) {
            selected.push(config);
        }
    }
    if selected.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "None of the selected API profiles exist any more".to_string(),
        ));
    }

    let document = json!({
        "kind": DOCUMENT_KIND,
        "version": DOCUMENT_VERSION,
        "exportedAt": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        "profiles": selected
            .iter()
            .map(|config| config_to_document(config))
            .collect::<Vec<Value>>(),
    });

    let content = serde_json::to_string_pretty(&document).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize API config export: {error}"),
        )
    })?;

    Ok(ApiConfigExportResult {
        content,
        exported_count: selected.len() as i32,
    })
}

/// 解析迁移文档并返回预览信息（不写库）。
pub fn inspect_api_config_import(payload_json: &str) -> Result<ApiConfigImportPreview> {
    let (profiles, skipped_count) = parse_document(payload_json)?;
    if profiles.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "The selected file contains no valid API profile".to_string(),
        ));
    }

    Ok(ApiConfigImportPreview {
        profiles: profiles
            .iter()
            .map(|profile| ApiConfigTransferItem {
                profile_name: profile.profile_name.clone(),
                display_name: profile.display_name.clone(),
                base_url: profile.base_url.clone(),
                request_method: profile.request_method.clone(),
                advanced_model: profile.advanced_model.clone(),
            })
            .collect(),
        skipped_count,
    })
}

/// 执行导入：同名冲突按 `conflict_strategy` 覆盖或另存副本。
pub fn import_api_configs(
    database_path: &Path,
    payload_json: &str,
    conflict_strategy: &str,
) -> Result<ApiConfigImportOutcome> {
    let strategy = conflict_strategy.trim();
    if strategy != STRATEGY_OVERWRITE && strategy != STRATEGY_DUPLICATE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported API config import strategy: {conflict_strategy}"),
        ));
    }

    let (profiles, skipped_count) = parse_document(payload_json)?;
    if profiles.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "The selected file contains no valid API profile".to_string(),
        ));
    }

    let existing = list_api_configs(database_path)?;
    let mut taken: HashSet<String> = existing
        .iter()
        .map(|config| config.profile_name.clone())
        .collect();

    let mut overwritten_count = 0i32;
    let mut renamed_count = 0i32;
    let mut prepared: Vec<(String, String, TransferProfile)> = Vec::new();
    for profile in profiles {
        let (name, display_name) = if !taken.contains(&profile.profile_name) {
            (profile.profile_name.clone(), profile.display_name.clone())
        } else if strategy == STRATEGY_DUPLICATE {
            renamed_count += 1;
            let (name, suffix) =
                build_copy_name(&profile.profile_name, &profile.display_name, &taken);
            (name, format!("{}{suffix}", profile.display_name))
        } else {
            overwritten_count += 1;
            (profile.profile_name.clone(), profile.display_name.clone())
        };

        taken.insert(name.clone());
        prepared.push((name, display_name, profile));
    }

    // 激活策略：先全部按“未启用”写库（不会影响当前启用配置），最后再把文件中标记为
    // 启用的第一条（且模型完整）切为启用，避免导入过程反复切换 active profile。
    let activation_candidate = prepared
        .iter()
        .find(|(_, _, profile)| {
            profile.is_active
                && !profile.advanced_model.trim().is_empty()
                && !profile.basic_model.trim().is_empty()
        })
        .map(|(name, _, _)| name.clone());

    for (name, display_name, profile) in &prepared {
        let input = profile.to_input(name, display_name, false);
        upsert_api_config(database_path, &input)?;
    }

    let mut activated_profile_name = None;
    if let Some(candidate) = activation_candidate {
        if let Some((name, display_name, profile)) =
            prepared.iter().find(|(name, _, _)| name == &candidate)
        {
            let input = profile.to_input(name, display_name, true);
            upsert_api_config(database_path, &input)?;
            activated_profile_name = Some(name.clone());
        }
    }

    Ok(ApiConfigImportOutcome {
        imported_count: prepared.len() as i32,
        overwritten_count,
        renamed_count,
        skipped_count,
        activated_profile_name,
    })
}

/// 导出文档中的单条配置：字段名与 TS `ApiConfigInput` 保持一致。
fn config_to_document(config: &ApiConfigRecord) -> Value {
    json!({
        "profileName": config.profile_name,
        "displayName": config.display_name,
        "isActive": config.is_active,
        "baseUrl": config.base_url,
        "baseUrlMode": config.base_url_mode,
        "apiKey": config.api_key,
        "requestMethod": config.request_method,
        "advancedModel": config.advanced_model,
        "basicModel": config.basic_model,
        "supportsVision": config.supports_vision,
        "visionBaseUrl": config.vision_base_url,
        "visionBaseUrlMode": config.vision_base_url_mode,
        "visionApiKey": config.vision_api_key,
        "visionRequestMethod": config.vision_request_method,
        "visionModel": config.vision_model,
        "maxContextTokens": config.max_context_tokens,
        "maxTokens": config.max_tokens,
        "streamIdleTimeoutSec": config.stream_idle_timeout_sec,
        "enableAutoCompress": config.enable_auto_compress,
        "autoCompressThreshold": config.auto_compress_threshold,
        "maxRetries": config.max_retries,
        "retryBaseDelayMs": config.retry_base_delay_ms,
        "partialRetryMaxChars": config.partial_retry_max_chars,
        "systemPromptIdsJson": config.system_prompt_ids_json,
        "customHeaderSchemeId": config.custom_header_scheme_id,
        "configJson": config.config_json,
        "source": config.source,
    })
}

/// 从迁移文档中读出的配置（尚未落库）。
struct TransferProfile {
    profile_name: String,
    display_name: String,
    is_active: bool,
    base_url: String,
    base_url_mode: String,
    api_key: String,
    request_method: String,
    advanced_model: String,
    basic_model: String,
    supports_vision: bool,
    vision_base_url: String,
    vision_base_url_mode: String,
    vision_api_key: String,
    vision_request_method: String,
    vision_model: String,
    max_context_tokens: Option<i32>,
    max_tokens: Option<i32>,
    stream_idle_timeout_sec: Option<i32>,
    enable_auto_compress: bool,
    auto_compress_threshold: Option<i32>,
    max_retries: Option<i32>,
    retry_base_delay_ms: Option<i32>,
    partial_retry_max_chars: Option<i32>,
    system_prompt_ids_json: String,
    custom_header_scheme_id: String,
    config_json: String,
    source: String,
}

impl TransferProfile {
    fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let profile_name = read_text(object, "profileName")?;
        let display_name = read_text(object, "displayName").unwrap_or_else(|| profile_name.clone());

        Some(Self {
            profile_name,
            display_name,
            is_active: read_bool(object, "isActive", false),
            base_url: read_text(object, "baseUrl")
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
            base_url_mode: read_text(object, "baseUrlMode").unwrap_or_else(|| "auto".to_string()),
            api_key: read_text(object, "apiKey").unwrap_or_default(),
            request_method: read_text(object, "requestMethod").unwrap_or_else(|| "chat".to_string()),
            advanced_model: read_text(object, "advancedModel").unwrap_or_default(),
            basic_model: read_text(object, "basicModel").unwrap_or_default(),
            supports_vision: read_bool(object, "supportsVision", true),
            vision_base_url: read_text(object, "visionBaseUrl").unwrap_or_default(),
            vision_base_url_mode: read_text(object, "visionBaseUrlMode")
                .unwrap_or_else(|| "auto".to_string()),
            vision_api_key: read_text(object, "visionApiKey").unwrap_or_default(),
            vision_request_method: read_text(object, "visionRequestMethod")
                .unwrap_or_else(|| "chat".to_string()),
            vision_model: read_text(object, "visionModel").unwrap_or_default(),
            max_context_tokens: read_i32(object, "maxContextTokens"),
            max_tokens: read_i32(object, "maxTokens"),
            stream_idle_timeout_sec: read_i32(object, "streamIdleTimeoutSec"),
            enable_auto_compress: read_bool(object, "enableAutoCompress", true),
            auto_compress_threshold: read_i32(object, "autoCompressThreshold"),
            max_retries: read_i32(object, "maxRetries"),
            retry_base_delay_ms: read_i32(object, "retryBaseDelayMs"),
            partial_retry_max_chars: read_i32(object, "partialRetryMaxChars"),
            system_prompt_ids_json: read_text(object, "systemPromptIdsJson").unwrap_or_default(),
            custom_header_scheme_id: read_text(object, "customHeaderSchemeId").unwrap_or_default(),
            config_json: read_text(object, "configJson").unwrap_or_else(|| "{}".to_string()),
            source: read_text(object, "source").unwrap_or_else(|| "manual".to_string()),
        })
    }

    fn to_input(&self, profile_name: &str, display_name: &str, is_active: bool) -> ApiConfigInput {
        ApiConfigInput {
            profile_name: profile_name.to_string(),
            previous_profile_name: None,
            display_name: display_name.to_string(),
            is_active,
            base_url: self.base_url.clone(),
            base_url_mode: self.base_url_mode.clone(),
            api_key: self.api_key.clone(),
            request_method: self.request_method.clone(),
            advanced_model: self.advanced_model.clone(),
            basic_model: self.basic_model.clone(),
            supports_vision: self.supports_vision,
            vision_base_url: self.vision_base_url.clone(),
            vision_base_url_mode: self.vision_base_url_mode.clone(),
            vision_api_key: self.vision_api_key.clone(),
            vision_request_method: self.vision_request_method.clone(),
            vision_model: self.vision_model.clone(),
            max_context_tokens: self.max_context_tokens,
            max_tokens: self.max_tokens,
            stream_idle_timeout_sec: self.stream_idle_timeout_sec,
            enable_auto_compress: self.enable_auto_compress,
            auto_compress_threshold: self.auto_compress_threshold,
            max_retries: self.max_retries,
            retry_base_delay_ms: self.retry_base_delay_ms,
            partial_retry_max_chars: self.partial_retry_max_chars,
            system_prompt_ids_json: self.system_prompt_ids_json.clone(),
            custom_header_scheme_id: self.custom_header_scheme_id.clone(),
            config_json: self.config_json.clone(),
            source: self.source.clone(),
        }
    }
}

/// 解析迁移文档：接受 `{ profiles: [...] }`、裸数组，或单条配置对象。
/// 返回（有效配置, 被忽略条目数）。
fn parse_document(payload_json: &str) -> Result<(Vec<TransferProfile>, i32)> {
    let root: Value = serde_json::from_str(payload_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Import file is not valid JSON: {error}"),
        )
    })?;

    let entries: Vec<Value> = match root {
        Value::Array(items) => items,
        Value::Object(mut object) => match object.remove("profiles") {
            Some(Value::Array(items)) => items,
            Some(_) => {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Import file field \"profiles\" must be an array".to_string(),
                ))
            }
            None => vec![Value::Object(object)],
        },
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                "Import file must contain an object or an array of API profiles".to_string(),
            ))
        }
    };

    let mut profiles = Vec::new();
    let mut skipped_count = 0i32;
    for entry in entries {
        match TransferProfile::from_value(&entry) {
            Some(profile) => profiles.push(profile),
            None => skipped_count += 1,
        }
    }

    Ok((profiles, skipped_count))
}

/// 生成不冲突的副本名（与渲染层 duplicateName.ts 的 `-Copy-n` 规则一致）。
/// 返回（配置名, 追加到展示名后的后缀）。
fn build_copy_name(
    profile_name: &str,
    display_name: &str,
    taken: &HashSet<String>,
) -> (String, String) {
    let base = strip_copy_suffix(profile_name);
    let display_base = strip_copy_suffix(display_name);

    let mut index = 1;
    loop {
        let suffix = format!("-Copy-{index}");
        let candidate = format!("{base}{suffix}");
        if !taken.contains(&candidate) {
            return (candidate, format!("{display_base}{suffix}"));
        }
        index += 1;
    }
}

/// 去除名称末尾的 `-Copy-n` 后缀，得到副本基数名。
fn strip_copy_suffix(name: &str) -> String {
    let Some(position) = name.rfind("-Copy-") else {
        return name.to_string();
    };
    let suffix = &name[position + "-Copy-".len()..];
    if !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit()) {
        return name[..position].to_string();
    }
    name.to_string()
}

fn read_text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_bool(object: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    object
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn read_i32(object: &Map<String, Value>, key: &str) -> Option<i32> {
    match object.get(key)? {
        Value::Number(number) => number.as_i64().and_then(|value| i32::try_from(value).ok()),
        Value::String(text) => text.trim().parse::<i32>().ok(),
        _ => None,
    }
}
