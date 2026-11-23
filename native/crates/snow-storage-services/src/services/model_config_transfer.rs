//! 图像生成渠道 / 决策 / 嵌入 / 重排模型的批量导出与导入。
//!
//! 每类配置使用独立的文档类型（`kind` 字段），只能导回同类标签页。
//! 同名（或同 id）冲突按 overwrite / duplicate 策略处理，与 API 档案迁移一致。

use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{json, Map, Value};

use super::model_registry::{
    self, DecisionModelEntry, EmbeddingModelEntry, RegisteredModelKind, RerankingModelEntry,
};
use super::export_file_name::build_export_file_name;
use super::system_settings::{get_system_setting_value, set_system_setting};
use crate::database::create_snowflake_id;

const DOCUMENT_VERSION: i64 = 1;
const IMAGE_GEN_SETTING_CODE: &str = "imagegen_settings";
const IMAGE_GEN_SETTING_NAME: &str = "Image Generation Settings";
const IMAGE_GEN_PROVIDERS: [&str; 3] = ["openai", "gemini", "novelai"];
const STRATEGY_OVERWRITE: &str = "overwrite";
const STRATEGY_DUPLICATE: &str = "duplicate";
const COPY_SUFFIX: &str = "-Copy-";

/// 导入预览中的单条配置（不含密钥）。
#[napi(object)]
pub struct ModelConfigTransferItem {
    pub id: String,
    pub name: String,
    pub model: String,
    /// 与现有配置同 id 或同名。
    pub conflict: bool,
}

#[napi(object)]
pub struct ModelConfigImportPreview {
    pub items: Vec<ModelConfigTransferItem>,
    pub conflict_names: Vec<String>,
    pub skipped_count: i32,
}

#[napi(object)]
pub struct ModelConfigImportOutcome {
    pub imported_count: i32,
    pub overwritten_count: i32,
    pub renamed_count: i32,
    pub skipped_count: i32,
}

#[napi(object)]
pub struct ModelConfigExportResult {
    pub content: String,
    pub exported_count: i32,
    pub file_name: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TransferKind {
    ImageGen,
    Model(RegisteredModelKind),
}

impl TransferKind {
    fn parse(value: &str) -> Result<Self> {
        if value.trim() == "imagegen" {
            return Ok(Self::ImageGen);
        }
        RegisteredModelKind::parse(value).map(Self::Model).ok_or_else(|| {
            invalid(format!(
                "Unknown config kind \"{value}\"; expected imagegen, decision, embedding or reranking"
            ))
        })
    }

    fn document_kind(self) -> &'static str {
        match self {
            Self::ImageGen => "snow-app-imagegen-channels",
            Self::Model(RegisteredModelKind::Decision) => "snow-app-decision-models",
            Self::Model(RegisteredModelKind::Embedding) => "snow-app-embedding-models",
            Self::Model(RegisteredModelKind::Reranking) => "snow-app-reranking-models",
        }
    }

    fn model_field(self) -> &'static str {
        match self {
            Self::ImageGen | Self::Model(RegisteredModelKind::Decision) => "model",
            Self::Model(_) => "modelName",
        }
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|item| item.trim().to_string())
        .unwrap_or_default()
}

/// 展示名：name 为空时依次回退模型名、provider、id。
fn label(kind: TransferKind, value: &Value) -> String {
    [
        text(value, "name"),
        text(value, kind.model_field()),
        text(value, "provider"),
        text(value, "id"),
    ]
    .into_iter()
    .find(|item| !item.is_empty())
    .unwrap_or_default()
}

fn to_value<T: serde::Serialize>(entry: &T) -> Result<Value> {
    serde_json::to_value(entry).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize model config: {error}"),
        )
    })
}

/// 读取生图设置根对象；旧版（无 channels）格式需先在设置页保存一次完成迁移。
fn read_image_gen_root(database_path: &Path) -> Result<Map<String, Value>> {
    let raw = get_system_setting_value(database_path, IMAGE_GEN_SETTING_CODE)?.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    let root = match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(root)) => root,
        _ => return Ok(Map::new()),
    };
    let is_legacy = !root.contains_key("channels")
        && ["openai", "gemini", "provider", "baseUrl"]
            .iter()
            .any(|key| root.contains_key(*key));
    if is_legacy {
        return Err(invalid(
            "Image generation settings use a legacy format; save them once in the settings page first",
        ));
    }
    Ok(root)
}

fn image_gen_channels(root: &Map<String, Value>) -> Vec<Value> {
    root.get("channels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn load_items(database_path: &Path, kind: TransferKind) -> Result<Vec<Value>> {
    match kind {
        TransferKind::ImageGen => Ok(image_gen_channels(&read_image_gen_root(database_path)?)),
        TransferKind::Model(RegisteredModelKind::Embedding) => {
            model_registry::list_embedding_models(database_path)?
                .iter()
                .map(to_value)
                .collect()
        }
        TransferKind::Model(RegisteredModelKind::Reranking) => {
            model_registry::list_reranking_models(database_path)?
                .iter()
                .map(to_value)
                .collect()
        }
        TransferKind::Model(RegisteredModelKind::Decision) => {
            model_registry::list_decision_models(database_path)?
                .iter()
                .map(to_value)
                .collect()
        }
    }
}

/// 校验并规范化单条导入项；无法识别时返回 None（计入忽略数）。
fn normalize_item(kind: TransferKind, value: Value) -> Option<Value> {
    match kind {
        TransferKind::ImageGen => {
            let provider = text(&value, "provider");
            (value.is_object() && IMAGE_GEN_PROVIDERS.contains(&provider.as_str())).then_some(value)
        }
        TransferKind::Model(RegisteredModelKind::Embedding) => {
            serde_json::from_value::<EmbeddingModelEntry>(value)
                .ok()
                .filter(|entry| !entry.model_name.trim().is_empty())
                .and_then(|entry| serde_json::to_value(entry).ok())
        }
        TransferKind::Model(RegisteredModelKind::Reranking) => {
            serde_json::from_value::<RerankingModelEntry>(value)
                .ok()
                .filter(|entry| !entry.model_name.trim().is_empty())
                .and_then(|entry| serde_json::to_value(entry).ok())
        }
        TransferKind::Model(RegisteredModelKind::Decision) => {
            serde_json::from_value::<DecisionModelEntry>(value)
                .ok()
                .filter(|entry| {
                    !entry.model.trim().is_empty()
                        && !(entry.base_url_mode.trim() == "custom" && entry.base_url.trim().is_empty())
                })
                .and_then(|entry| serde_json::to_value(entry).ok())
        }
    }
}

/// 解析迁移文档：接受 `{ kind, items }`、裸数组或单条对象；kind 不符时报错。
fn parse_document(kind: TransferKind, payload_json: &str) -> Result<(Vec<Value>, i32)> {
    let root: Value = serde_json::from_str(payload_json)
        .map_err(|error| invalid(format!("Import file is not valid JSON: {error}")))?;

    let entries = match root {
        Value::Array(items) => items,
        Value::Object(mut object) => {
            if let Some(found) = object.get("kind").and_then(Value::as_str) {
                if found != kind.document_kind() {
                    return Err(invalid(format!(
                        "This file is a \"{found}\" export and cannot be imported here (expected \"{}\")",
                        kind.document_kind()
                    )));
                }
            }
            match object.remove("items") {
                Some(Value::Array(items)) => items,
                Some(_) => return Err(invalid("Import file field \"items\" must be an array")),
                None => vec![Value::Object(object)],
            }
        }
        _ => return Err(invalid("Import file must contain an object or an array")),
    };

    let mut items = Vec::new();
    let mut skipped_count = 0i32;
    for entry in entries {
        match normalize_item(kind, entry) {
            Some(item) => items.push(item),
            None => skipped_count += 1,
        }
    }
    if items.is_empty() {
        return Err(invalid("The selected file contains no valid configuration"));
    }
    Ok((items, skipped_count))
}

/// 与现有项同 id 或同名时返回其下标。
fn find_conflict(existing: &[Value], item: &Value) -> Option<usize> {
    let id = text(item, "id");
    let name = text(item, "name");
    existing.iter().position(|current| {
        (!id.is_empty() && text(current, "id") == id)
            || (!name.is_empty() && text(current, "name") == name)
    })
}

fn strip_copy_suffix(name: &str) -> &str {
    if let Some(position) = name.rfind(COPY_SUFFIX) {
        let suffix = &name[position + COPY_SUFFIX.len()..];
        if !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit()) {
            return &name[..position];
        }
    }
    name
}

fn build_copy_name(base: &str, taken: &HashSet<String>) -> String {
    let base = strip_copy_suffix(base);
    (1..)
        .map(|index| format!("{base}{COPY_SUFFIX}{index}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or_else(|| base.to_string())
}

fn set_field(item: &mut Value, key: &str, value: String) {
    if let Value::Object(object) = item {
        object.insert(key.to_string(), Value::String(value));
    }
}

/// 生图渠道 id 由前端约定生成（provider-随机串）；模型 id 交给 Rust upsert 生成。
fn fresh_id(kind: TransferKind, item: &Value) -> String {
    match kind {
        TransferKind::ImageGen => format!("{}-{}", text(item, "provider"), create_snowflake_id()),
        TransferKind::Model(_) => String::new(),
    }
}

/// 导出选中项为迁移文档 JSON 文本（含明文密钥）。
pub fn export_model_configs(
    database_path: &Path,
    kind: &str,
    ids: &[String],
) -> Result<ModelConfigExportResult> {
    let kind = TransferKind::parse(kind)?;
    let mut requested: Vec<String> = Vec::new();
    for id in ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
        if !requested.iter().any(|item| item == id) {
            requested.push(id.to_string());
        }
    }
    if requested.is_empty() {
        return Err(invalid("At least one item must be selected to export"));
    }

    let items = load_items(database_path, kind)?;
    // 按列表展示顺序收集，导出文档与文件名都以首项为准。
    let selected: Vec<Value> = items
        .iter()
        .filter(|item| requested.iter().any(|id| id == &text(item, "id")))
        .cloned()
        .collect();
    if selected.is_empty() {
        return Err(invalid("None of the selected items exist any more"));
    }

    let document = json!({
        "kind": kind.document_kind(),
        "version": DOCUMENT_VERSION,
        "exportedAt": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        "items": selected,
    });
    let content = serde_json::to_string_pretty(&document).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize config export: {error}"),
        )
    })?;

    let first_label = selected.first().map(|item| label(kind, item)).unwrap_or_default();
    let file_name = build_export_file_name(&first_label, selected.len(), kind.document_kind());

    Ok(ModelConfigExportResult {
        content,
        exported_count: selected.len() as i32,
        file_name,
    })
}

/// 解析迁移文档并标出冲突项（不写库）。
pub fn inspect_model_config_import(
    database_path: &Path,
    kind: &str,
    payload_json: &str,
) -> Result<ModelConfigImportPreview> {
    let kind = TransferKind::parse(kind)?;
    let (items, skipped_count) = parse_document(kind, payload_json)?;
    let existing = load_items(database_path, kind)?;

    let mut conflict_names = Vec::new();
    let preview = items
        .iter()
        .map(|item| {
            let conflict = find_conflict(&existing, item).is_some();
            let name = label(kind, item);
            if conflict {
                conflict_names.push(name.clone());
            }
            ModelConfigTransferItem {
                id: text(item, "id"),
                name,
                model: text(item, kind.model_field()),
                conflict,
            }
        })
        .collect();

    Ok(ModelConfigImportPreview {
        items: preview,
        conflict_names,
        skipped_count,
    })
}

/// 执行导入：冲突项按策略覆盖（沿用现有 id）或另存副本（新 id + `-Copy-n` 名称）。
pub fn import_model_configs(
    database_path: &Path,
    kind: &str,
    payload_json: &str,
    conflict_strategy: &str,
) -> Result<ModelConfigImportOutcome> {
    let kind = TransferKind::parse(kind)?;
    let strategy = conflict_strategy.trim();
    if strategy != STRATEGY_OVERWRITE && strategy != STRATEGY_DUPLICATE {
        return Err(invalid(format!(
            "Unsupported import strategy: {conflict_strategy}"
        )));
    }

    let (items, skipped_count) = parse_document(kind, payload_json)?;
    let mut image_gen_root = match kind {
        TransferKind::ImageGen => Some(read_image_gen_root(database_path)?),
        TransferKind::Model(_) => None,
    };
    let mut merged = match &image_gen_root {
        Some(root) => image_gen_channels(root),
        None => load_items(database_path, kind)?,
    };
    let mut taken_names: HashSet<String> =
        merged.iter().map(|item| label(kind, item)).collect();

    let mut changed: Vec<Value> = Vec::new();
    let mut overwritten_count = 0i32;
    let mut renamed_count = 0i32;
    for mut item in items {
        match find_conflict(&merged, &item) {
            Some(index) if strategy == STRATEGY_OVERWRITE => {
                let id = text(&merged[index], "id");
                set_field(&mut item, "id", id);
                merged[index] = item.clone();
                overwritten_count += 1;
            }
            Some(_) => {
                let name = build_copy_name(&label(kind, &item), &taken_names);
                let id = fresh_id(kind, &item);
                set_field(&mut item, "id", id);
                set_field(&mut item, "name", name);
                merged.push(item.clone());
                renamed_count += 1;
            }
            None => {
                if text(&item, "id").is_empty() {
                    let id = fresh_id(kind, &item);
                    set_field(&mut item, "id", id);
                }
                merged.push(item.clone());
            }
        }
        taken_names.insert(label(kind, &item));
        changed.push(item);
    }

    match kind {
        TransferKind::ImageGen => {
            let mut root = image_gen_root.take().unwrap_or_default();
            root.insert(
                "channels".to_string(),
                Value::Array(hoist_imported_items(&merged, &changed)),
            );
            set_system_setting(
                database_path,
                IMAGE_GEN_SETTING_NAME,
                IMAGE_GEN_SETTING_CODE,
                &Value::Object(root).to_string(),
            )?;
        }
        TransferKind::Model(model_kind) => {
            let mut imported_ids: Vec<String> = Vec::with_capacity(changed.len());
            for item in changed.iter().cloned() {
                let model_id = upsert_model(database_path, model_kind, item)?;
                if !model_id.trim().is_empty() && !imported_ids.iter().any(|id| id == &model_id) {
                    imported_ids.push(model_id);
                }
            }
            // 导入项按文件顺序置顶，其余模型保持原有相对顺序。
            model_registry::reorder_models(database_path, model_kind, &imported_ids)?;
        }
    }

    Ok(ModelConfigImportOutcome {
        imported_count: changed.len() as i32,
        overwritten_count,
        renamed_count,
        skipped_count,
    })
}

/// 把导入项（按文件顺序）提到列表最前，其余项保持原顺序。
fn hoist_imported_items(merged: &[Value], changed: &[Value]) -> Vec<Value> {
    let mut ordered: Vec<Value> = Vec::with_capacity(merged.len());
    for item in changed {
        let id = text(item, "id");
        if id.is_empty() || ordered.iter().any(|existing| text(existing, "id") == id) {
            continue;
        }
        if let Some(found) = merged.iter().find(|candidate| text(candidate, "id") == id) {
            ordered.push(found.clone());
        }
    }
    for item in merged {
        let id = text(item, "id");
        if !ordered.iter().any(|existing| text(existing, "id") == id) {
            ordered.push(item.clone());
        }
    }
    ordered
}

fn upsert_model(database_path: &Path, kind: RegisteredModelKind, item: Value) -> Result<String> {
    let parse_error =
        |error: serde_json::Error| invalid(format!("Invalid model config in import file: {error}"));
    match kind {
        RegisteredModelKind::Embedding => {
            let entry = serde_json::from_value::<EmbeddingModelEntry>(item).map_err(parse_error)?;
            model_registry::upsert_embedding_model(database_path, entry).map(|saved| saved.id)
        }
        RegisteredModelKind::Reranking => {
            let entry = serde_json::from_value::<RerankingModelEntry>(item).map_err(parse_error)?;
            model_registry::upsert_reranking_model(database_path, entry).map(|saved| saved.id)
        }
        RegisteredModelKind::Decision => {
            let entry = serde_json::from_value::<DecisionModelEntry>(item).map_err(parse_error)?;
            model_registry::upsert_decision_model(database_path, entry).map(|saved| saved.id)
        }
    }
}
