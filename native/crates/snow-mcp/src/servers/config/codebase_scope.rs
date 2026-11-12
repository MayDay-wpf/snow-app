//! config 服务 `codebase` 作用域：代码库索引配置（全局）+ 项目级索引作用域。
//!
//! 全局（不带 projectId，或显式 `projectId: ""`）：
//! - key = `settings`：真源是 system_settings 的 `codebase_settings`，包含选中的
//!   嵌入 / 重排模型 id（`embeddingModelId` / `rerankingModelId`，空 = 未选择）、
//!   重排 topN、批量与分块参数，以及 agent review 选用的决策模型 id 与相关性阈值。
//!   按**白名单字段 merge** 写入，未列出的字段原样保留。
//! - key = `embeddingModels` / `rerankingModels`：全局模型列表（`embedding_models` /
//!   `reranking_models` 表，与「API 配置 → 嵌入模型 / 重排模型」同源）。读取时
//!   apiKey 掩码；写入 `{upsert?: [...], remove?: [...]}`，按 id（其次 name）匹配，
//!   省略或空 apiKey 保留旧值；删除被选中的模型时一并清空选择。
//!
//! 项目级（projectId 非空）：key = `scope`，三态开关
//! `{enabled?, enableAgentReview?, enableReranking?}`——`null` 表示继承全局，
//! 保存在 system_settings 的 `project_codebase_scope_<blake3(projectId)>`。
//!
//! ⚠️ 修改嵌入模型（选择或其配置）后，已索引的文件不会自动更新，
//! 需要在「代码库」设置页重建索引才会用新配置生效（响应内附同样提示）。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::storage::services::model_registry::{
    delete_model, list_embedding_models, list_reranking_models, load_embedding_models,
    load_reranking_models, upsert_embedding_model, upsert_reranking_model, EmbeddingModelEntry,
    RegisteredModelKind, RerankingModelEntry,
};
use crate::storage::services::system_settings::{
    get_codebase_project_scope_settings, get_system_setting_value,
    set_codebase_project_agent_review, set_codebase_project_enabled,
    set_codebase_project_reranking, set_system_setting, CodebaseProjectScopeSettings,
    EMBEDDING_MODEL_ID_KEY, RERANKING_MODEL_ID_KEY,
};

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const SETTINGS_KEY: &str = "settings";
const SCOPE_KEY: &str = "scope";
const EMBEDDING_MODELS_KEY: &str = "embeddingModels";
const RERANKING_MODELS_KEY: &str = "rerankingModels";

const CODEBASE_SETTING_NAME: &str = "Codebase settings";
const CODEBASE_SETTING_CODE: &str = "codebase_settings";

/// 允许通过本域写入的全局字段（其余字段原样保留）。
const WRITABLE_FIELDS: &[&str] = &[
    "profileName",
    "embeddingModelId",
    "batchMaxLines",
    "batchConcurrency",
    "chunkingMaxLinesPerChunk",
    "chunkingMinLinesPerChunk",
    "chunkingMinCharsPerChunk",
    "chunkingOverlapLines",
    "rerankingModelId",
    "rerankingTopN",
    "agentReviewModelId",
    "agentReviewRelevanceThreshold",
    "configJson",
    "source",
];

/// 读取时需要掩码的密钥字段（未迁移的旧数据可能仍带内联密钥）。
const SECRET_FIELDS: &[&str] = &["embeddingApiKey", "rerankingApiKey"];

const REINDEX_NOTE: &str = "Changing the selected embedding model (or its model / baseUrl / dimension / key) only affects files indexed AFTER the change; rebuild the codebase index in the UI (Codebase settings) for existing files.";

const MODELS_GUIDANCE: &str = "embeddingModels / rerankingModels are the global model lists (same as API settings > Embedding models / Reranking models). config-manage action=set value={upsert?: [{id?, name?, modelName, baseUrl, apiKey, ...}], remove?: [idOrName]}: upsert matches by id (then name), omitted fields keep their values and an empty apiKey keeps the stored key; new entries need modelName and get a generated id. Embedding fields: name, embeddingType (jina|ollama|gemini|mistral), modelName, baseUrl, apiKey, dimensions (0 = omit), contextLength, enabled. Reranking fields: name, modelName, baseUrl, apiKey, contextLength, enabled. Select one for the codebase with key=settings value={embeddingModelId|rerankingModelId: \"<id>\"} (\"\" = none); removing a selected model clears the selection.";

/// 模型列表键的描述：对应的模型表、允许字段与新建默认值。
struct ModelListSpec {
    key: &'static str,
    kind: RegisteredModelKind,
    id_prefix: &'static str,
    fields: &'static [&'static str],
    default_context_length: i64,
    is_embedding: bool,
}

const EMBEDDING_SPEC: ModelListSpec = ModelListSpec {
    key: EMBEDDING_MODELS_KEY,
    kind: RegisteredModelKind::Embedding,
    id_prefix: "em",
    fields: &[
        "name",
        "embeddingType",
        "modelName",
        "baseUrl",
        "apiKey",
        "dimensions",
        "contextLength",
        "enabled",
    ],
    default_context_length: 8192,
    is_embedding: true,
};

const RERANKING_SPEC: ModelListSpec = ModelListSpec {
    key: RERANKING_MODELS_KEY,
    kind: RegisteredModelKind::Reranking,
    id_prefix: "rm",
    fields: &[
        "name",
        "modelName",
        "baseUrl",
        "apiKey",
        "contextLength",
        "enabled",
    ],
    default_context_length: 4096,
    is_embedding: false,
};

fn model_spec(key: &str) -> Option<&'static ModelListSpec> {
    match key {
        EMBEDDING_MODELS_KEY => Some(&EMBEDDING_SPEC),
        RERANKING_MODELS_KEY => Some(&RERANKING_SPEC),
        _ => None,
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn str_of<'a>(object: &'a Map<String, Value>, key: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

fn to_maps<T: Serialize>(items: Vec<T>) -> Vec<Map<String, Value>> {
    items
        .into_iter()
        .filter_map(|item| serde_json::to_value(item).ok())
        .filter_map(|value| value.as_object().cloned())
        .collect()
}

fn read_models(db_path: &Path, spec: &ModelListSpec) -> Result<Vec<Map<String, Value>>> {
    Ok(if spec.is_embedding {
        to_maps(list_embedding_models(db_path)?)
    } else {
        to_maps(list_reranking_models(db_path)?)
    })
}

fn masked_models(db_path: &Path, spec: &ModelListSpec) -> Result<Value> {
    let models = read_models(db_path, spec)?
        .into_iter()
        .map(|mut model| {
            let masked = model
                .get("apiKey")
                .and_then(Value::as_str)
                .map(mask_secret);
            if let Some(masked) = masked {
                model.insert("apiKey".to_string(), masked);
            }
            Value::Object(model)
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(models))
}

/// 新建条目的默认值（随后由调用方字段覆盖）。
fn new_model_entry(spec: &ModelListSpec, name: &str, model_name: &str) -> Map<String, Value> {
    let mut entry = Map::new();
    entry.insert(
        "id".to_string(),
        json!(format!(
            "{}-{}",
            spec.id_prefix,
            crate::storage::database::create_snowflake_id()
        )),
    );
    entry.insert(
        "name".to_string(),
        json!(if name.is_empty() { model_name } else { name }),
    );
    if spec.is_embedding {
        entry.insert("embeddingType".to_string(), json!("jina"));
        entry.insert("dimensions".to_string(), json!(0));
    }
    entry.insert("modelName".to_string(), json!(model_name));
    entry.insert("baseUrl".to_string(), json!(""));
    entry.insert("apiKey".to_string(), json!(""));
    entry.insert("contextLength".to_string(), json!(spec.default_context_length));
    entry.insert("enabled".to_string(), json!(true));
    entry
}

/// 合并后的条目解析结果（先全部校验，再统一写库）。
enum ParsedModel {
    Embedding(EmbeddingModelEntry),
    Reranking(RerankingModelEntry),
}

fn parse_model_entry(spec: &ModelListSpec, entry: &Map<String, Value>) -> Result<ParsedModel> {
    let value = Value::Object(entry.clone());
    let parsed = if spec.is_embedding {
        serde_json::from_value::<EmbeddingModelEntry>(value).map(ParsedModel::Embedding)
    } else {
        serde_json::from_value::<RerankingModelEntry>(value).map(ParsedModel::Reranking)
    };
    parsed.map_err(|error| {
        invalid(format!(
            "invalid {} entry \"{}\": {error}",
            spec.key,
            str_of(entry, "name")
        ))
    })
}

/// `{upsert?: [...], remove?: [...]}`：按 id（其次 name）匹配，空 apiKey 保留旧值。
fn write_models(db_path: &Path, spec: &ModelListSpec, value: &Value) -> Result<()> {
    let Some(patch) = value.as_object() else {
        return Err(invalid(format!(
            "{} value must be an object like {{upsert: [...], remove: [...]}}",
            spec.key
        )));
    };
    if let Some(unknown) = patch.keys().find(|key| *key != "upsert" && *key != "remove") {
        return Err(invalid(format!(
            "unknown field \"{unknown}\" for {}; use upsert and/or remove",
            spec.key
        )));
    }

    let mut models = read_models(db_path, spec)?;
    let mut removed_ids: Vec<String> = Vec::new();
    let mut pending: Vec<(String, ParsedModel)> = Vec::new();

    if let Some(remove) = patch.get("remove") {
        let targets = remove
            .as_array()
            .ok_or_else(|| invalid("remove must be an array of model ids or names"))?;
        for target in targets {
            let target = target.as_str().map(str::trim).unwrap_or("");
            if target.is_empty() {
                continue;
            }
            let before = models.len();
            models.retain(|model| {
                let hit = str_of(model, "id") == target || str_of(model, "name") == target;
                if hit {
                    removed_ids.push(str_of(model, "id").to_string());
                }
                !hit
            });
            if models.len() == before {
                return Err(invalid(format!("no {} entry matches \"{target}\"", spec.key)));
            }
        }
    }

    if let Some(upsert) = patch.get("upsert") {
        let items = upsert
            .as_array()
            .ok_or_else(|| invalid("upsert must be an array of model objects"))?;
        for item in items {
            let fields = item
                .as_object()
                .ok_or_else(|| invalid("each upsert item must be an object"))?;
            if let Some(unknown) = fields
                .keys()
                .find(|key| *key != "id" && !spec.fields.contains(&key.as_str()))
            {
                return Err(invalid(format!(
                    "\"{unknown}\" is not a {} field; allowed: id, {}",
                    spec.key,
                    spec.fields.join(", ")
                )));
            }

            let id = str_of(fields, "id").to_string();
            let name = str_of(fields, "name").to_string();
            let position = models.iter().position(|model| {
                if id.is_empty() {
                    !name.is_empty() && str_of(model, "name") == name
                } else {
                    str_of(model, "id") == id
                }
            });

            let index = match position {
                Some(index) => index,
                None => {
                    if !id.is_empty() {
                        return Err(invalid(format!("no {} entry has id \"{id}\"", spec.key)));
                    }
                    let model_name = str_of(fields, "modelName").to_string();
                    if model_name.is_empty() {
                        return Err(invalid(format!(
                            "modelName is required when creating a new {} entry",
                            spec.key
                        )));
                    }
                    models.push(new_model_entry(spec, &name, &model_name));
                    models.len() - 1
                }
            };

            let target = &mut models[index];
            for (key, field_value) in fields {
                if key == "id" {
                    continue;
                }
                // 省略/空字符串 = 保留旧密钥，避免用掩码占位符覆盖真实值。
                if key == "apiKey" {
                    match field_value.as_str().map(str::trim) {
                        None | Some("") => continue,
                        Some(secret) => {
                            target.insert(key.clone(), json!(secret));
                            continue;
                        }
                    }
                }
                target.insert(key.clone(), field_value.clone());
            }
            let target_id = str_of(target, "id").to_string();
            let parsed = parse_model_entry(spec, target)?;
            pending.retain(|(id, _)| *id != target_id);
            pending.push((target_id, parsed));
        }
    }

    // 删除会同时清空引用该模型的代码库选择。
    for id in &removed_ids {
        delete_model(db_path, spec.kind, id)?;
    }
    for (_, parsed) in pending {
        match parsed {
            ParsedModel::Embedding(model) => {
                upsert_embedding_model(db_path, model)?;
            }
            ParsedModel::Reranking(model) => {
                upsert_reranking_model(db_path, model)?;
            }
        }
    }
    Ok(())
}

fn mask_secret(value: &str) -> Value {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return json!("");
    }
    if chars.len() <= 8 {
        return json!("****");
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    json!(format!("{head}****{tail}"))
}

fn read_global(db_path: &Path) -> Result<Value> {
    let raw = get_system_setting_value(db_path, CODEBASE_SETTING_CODE)?.unwrap_or_default();
    let parsed = if raw.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&raw).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse codebase settings: {error}"),
            )
        })?
    };
    let Some(object) = parsed.as_object() else {
        return Ok(json!({}));
    };

    let mut masked = Map::new();
    for (key, value) in object {
        let masked_value = match (SECRET_FIELDS.contains(&key.as_str()), value.as_str()) {
            (true, Some(text)) => mask_secret(text),
            _ => value.clone(),
        };
        masked.insert(key.clone(), masked_value);
    }
    Ok(Value::Object(masked))
}

fn write_global(db_path: &Path, value: &Value) -> Result<()> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "codebase settings value must be an object".to_string(),
        ));
    };

    let raw = get_system_setting_value(db_path, CODEBASE_SETTING_CODE)?.unwrap_or_default();
    let mut merged = if raw.trim().is_empty() {
        Map::new()
    } else {
        serde_json::from_str::<Value>(&raw)
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse codebase settings: {error}"),
                )
            })?
            .as_object()
            .cloned()
            .unwrap_or_default()
    };

    for (key, field_value) in patch {
        if !WRITABLE_FIELDS.contains(&key.as_str()) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "{key} is not writable in the codebase scope; allowed fields: {}. Model configs (model / baseUrl / apiKey ...) live in the {EMBEDDING_MODELS_KEY} / {RERANKING_MODELS_KEY} keys",
                    WRITABLE_FIELDS.join(", ")
                ),
            ));
        }
        merged.insert(key.clone(), field_value.clone());
    }

    // 选择的模型必须存在（空串 = 不选择）。
    let selected_id = |key: &str| {
        patch
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    };
    if let Some(id) = selected_id(EMBEDDING_MODEL_ID_KEY) {
        if !load_embedding_models(db_path).iter().any(|model| model.id == id) {
            return Err(invalid(format!(
                "embeddingModelId \"{id}\" does not exist; list the {EMBEDDING_MODELS_KEY} key for valid ids"
            )));
        }
    }
    if let Some(id) = selected_id(RERANKING_MODEL_ID_KEY) {
        if !load_reranking_models(db_path).iter().any(|model| model.id == id) {
            return Err(invalid(format!(
                "rerankingModelId \"{id}\" does not exist; list the {RERANKING_MODELS_KEY} key for valid ids"
            )));
        }
    }

    let serialized = serde_json::to_string(&Value::Object(merged)).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize codebase settings: {error}"),
        )
    })?;
    set_system_setting(
        db_path,
        CODEBASE_SETTING_NAME,
        CODEBASE_SETTING_CODE,
        &serialized,
    )
}

fn scope_view(settings: &CodebaseProjectScopeSettings) -> Value {
    json!({
        "projectId": settings.project_id,
        "enabled": settings.enabled,
        "enableAgentReview": settings.enable_agent_review,
        "enableReranking": settings.enable_reranking,
    })
}

fn write_project_scope(db_path: &Path, project_id: &str, value: &Value) -> Result<()> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "project codebase scope value must be an object like { enabled: true }".to_string(),
        ));
    };
    if patch.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "project codebase scope value must contain at least one of: enabled, enableAgentReview, enableReranking"
                .to_string(),
        ));
    }

    for (field, field_value) in patch {
        let flag = field_value.as_bool().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} must be a boolean (or null to inherit the global default)"),
            )
        })?;
        match field.as_str() {
            "enabled" => set_codebase_project_enabled(db_path, project_id, flag)?,
            "enableAgentReview" => set_codebase_project_agent_review(db_path, project_id, flag)?,
            "enableReranking" => set_codebase_project_reranking(db_path, project_id, flag)?,
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Unknown project codebase scope field \"{other}\"; available fields: enabled, enableAgentReview, enableReranking"
                    ),
                ))
            }
        }
    }
    Ok(())
}

/// Dispatches the `config-manage` list/get/set/delete actions for the `codebase` scope.
pub(crate) fn execute_codebase_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
    project_id: Option<&str>,
) -> Result<Value> {
    match (tool_name, project_id) {
        ("list", Some(project_id)) => Ok(json!({
            "scope": "codebase",
            "file": null,
            "scoped": "project",
            "projectId": project_id,
            "keys": [{
                "key": SCOPE_KEY,
                "type": "object",
                "sensitive": false,
                "configured": true,
                "value": scope_view(&get_codebase_project_scope_settings(db_path, project_id)?),
            }],
        })),
        ("list", None) => Ok(json!({
            "scope": "codebase",
            "file": null,
            "scoped": "global",
            "projectId": Value::Null,
            "note": REINDEX_NOTE,
            "keys": [
                {
                    "key": SETTINGS_KEY,
                    "type": "object",
                    "sensitive": false,
                    "configured": true,
                    "value": read_global(db_path)?,
                },
                {
                    "key": EMBEDDING_MODELS_KEY,
                    "type": "array",
                    "sensitive": true,
                    "configured": true,
                    "value": masked_models(db_path, &EMBEDDING_SPEC)?,
                },
                {
                    "key": RERANKING_MODELS_KEY,
                    "type": "array",
                    "sensitive": true,
                    "configured": true,
                    "value": masked_models(db_path, &RERANKING_SPEC)?,
                },
            ],
            "modelsGuidance": MODELS_GUIDANCE,
        })),
        (TOOL_GET, Some(project_id)) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SCOPE_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("project codebase scope only defines the key \"{SCOPE_KEY}\""),
                ));
            }
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "project",
                "projectId": project_id,
                "value": scope_view(&get_codebase_project_scope_settings(db_path, project_id)?),
            }))
        }
        (TOOL_GET, None) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if let Some(spec) = model_spec(key) {
                return Ok(json!({
                    "scope": "codebase",
                    "key": key,
                    "scoped": "global",
                    "note": MODELS_GUIDANCE,
                    "value": masked_models(db_path, spec)?,
                }));
            }
            if key != SETTINGS_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("codebase (global) defines the keys \"{SETTINGS_KEY}\", \"{EMBEDDING_MODELS_KEY}\" and \"{RERANKING_MODELS_KEY}\"; project sessions inject projectId - pass projectId: \"\" for the global view"),
                ));
            }
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "global",
                "note": REINDEX_NOTE,
                "value": read_global(db_path)?,
            }))
        }
        (TOOL_SET, Some(project_id)) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SCOPE_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("project codebase scope only defines the key \"{SCOPE_KEY}\""),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for action=set".to_string(),
                )
            })?;
            write_project_scope(db_path, project_id, &value)?;
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "project",
                "projectId": project_id,
                "value": scope_view(&get_codebase_project_scope_settings(db_path, project_id)?),
            }))
        }
        (TOOL_SET, None) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for action=set".to_string(),
                )
            })?;
            if let Some(spec) = model_spec(key) {
                write_models(db_path, spec, &value)?;
                return Ok(json!({
                    "scope": "codebase",
                    "key": key,
                    "scoped": "global",
                    "note": REINDEX_NOTE,
                    "value": masked_models(db_path, spec)?,
                    "settings": read_global(db_path)?,
                }));
            }
            if key != SETTINGS_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("codebase (global) defines the keys \"{SETTINGS_KEY}\", \"{EMBEDDING_MODELS_KEY}\" and \"{RERANKING_MODELS_KEY}\""),
                ));
            }
            write_global(db_path, &value)?;
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "global",
                "note": REINDEX_NOTE,
                "value": read_global(db_path)?,
            }))
        }
        (TOOL_DELETE, _) => Err(Error::new(
            Status::InvalidArg,
            "codebase does not support delete; write explicit values with action=set instead (project-level fields accept true/false to override and re-writing the previous value to change them back)"
                .to_string(),
        )),
        (other, _) => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope codebase: {other}"),
        )),
    }
}
