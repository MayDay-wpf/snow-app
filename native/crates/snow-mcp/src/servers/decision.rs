//! 决策模型内置 MCP 服务：`decision-evaluate`。
//!
//! 用已配置的决策模型（TypeSafe Jev / OpenAI Decisions）对文本、JSON 与本地图片
//! 证据回答 predicate / choice / score 问题，返回结构化答案。
//!
//! - 只在显式调用时读取并发送图片，不自动附带会话内容或截图
//! - 图片路径限定在工作区（项目根、关联项目、WorkTree）、应用数据目录、图片库与
//!   系统临时目录内；不可读、格式不支持或超限时整次报错（带路径），不发出请求
//! - 文件读取与图片处理放在阻塞线程池，网络请求异步执行，不阻塞 Node.js 线程
//!
//! 默认关闭（system_settings DEFAULT_DISABLED_BUILTIN_SERVERS + collect.rs
//! DEFAULT_DISABLED_SERVER_IDS），需在 MCP 面板按项目显式启用。

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

use base64::Engine;
use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::is_ssh_path;
use crate::api::decision_model::{
    evaluate_custom, load_decision_models, load_decision_tool_model_id,
    resolve_decision_model_reference, CustomQuestion, CustomQuestionKind, DecisionModelConfig,
    DecisionModelResolution, DecisionProvider, DecisionUsageScope, EvidenceImage,
    EvidenceImageFormat, EvidenceInput,
};

const SERVER_ID: &str = "decision";
const TOOL_EVALUATE: &str = "evaluate";

const MAX_QUESTIONS: usize = 50;
const MAX_NAME_CHARS: usize = 64;
const MAX_CHOICES: usize = 50;
const MIN_SCORE_LEVELS: usize = 2;
const MAX_SCORE_LEVELS: usize = 10;
const MAX_EVIDENCE_TEXT_CHARS: usize = 200_000;

/// 一次调用最多读取的不同图片数。
const MAX_IMAGES: usize = 16;
/// 单张图片文件上限（与 TypeSafe 单图上限一致）。
const MAX_IMAGE_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// 处理后全部图片的 base64 总量上限：为 TypeSafe 32 MiB 请求体留出余量。
const MAX_TOTAL_IMAGE_BASE64_BYTES: usize = 24 * 1024 * 1024;
/// 发送前长边上限（与 image_optimize 的降采样上限、TypeSafe 单边上限一致）。
const MAX_SENT_EDGE: u32 = 1568;
/// TypeSafe 单边下限：低于该值会被 API 拒绝，本地提前报错。
const TYPESAFE_MIN_EDGE: u32 = 280;

const TOOL_DESCRIPTION: &str = "Ask the configured decision model (TypeSafe Jev or OpenAI Decisions) typed questions about evidence and get structured answers back: predicate (probability that a statement is true), choice (one of fixed options with per-option probabilities) or score (rating on ordered levels). Evidence can be text, JSON and LOCAL image files (PNG or JPEG), e.g. verifying a browser-page screenshot against expectations or checking whether a generated image meets requirements. Put evidence shared by all questions in `evidence`; give a question its own candidate images with `questions[].images` (e.g. one question per candidate, each compared with a shared reference image in evidence). Image rules: PNG/JPEG only, at most 16 MiB per file and 16 distinct images per call; images are downscaled to a 1568 px long edge before sending; TypeSafe additionally needs both sides >= 280 px after scaling. Paths may be absolute or relative to the project root (`upload/...` resolves to the app upload directory) and must stay inside the project workspace, the Snow App data directory, the image library or the system temp directory. Unreadable, unsupported or oversized images fail the whole call with the path in the error and nothing is sent. Images are read and sent only when you call this tool. Uses `model` when given, otherwise the default decision tool model from Settings > API > Decision models.";

pub struct DecisionService;

impl DecisionService {
    pub fn new() -> Self {
        DecisionService
    }
}

impl McpService for DecisionService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_EVALUATE.to_string(),
            description: TOOL_DESCRIPTION.to_string(),
            input_schema: input_schema(),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        // 请求需要异步发送，只能经 call.rs 的异步分支执行。
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "Tool \"{SERVER_ID}-{tool_name}\" must run through the async MCP dispatcher"
            ),
        ))
    }
}

fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_QUESTIONS,
                "description": "Questions to answer about the evidence (1-50). Answers come back in the same order, keyed by name.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Unique id of the question: letters, digits, '_' or '-', at most 64 characters."
                        },
                        "type": {
                            "type": "string",
                            "enum": ["predicate", "choice", "score"],
                            "description": "predicate = probability that the instructions statement is true; choice = pick one of `choices`; score = rate on ordered `levels`."
                        },
                        "instructions": {
                            "type": "string",
                            "description": "The question or statement to judge, written around observable criteria."
                        },
                        "choices": {
                            "type": "array",
                            "description": "choice only: 2-50 distinct options.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "value": { "type": "string" },
                                    "description": { "type": "string", "description": "When this option applies." }
                                },
                                "required": ["value"]
                            }
                        },
                        "levels": {
                            "type": "array",
                            "description": "score only: 2-10 ordered levels, LOWEST first.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": { "type": "string" },
                                    "description": { "type": "string", "description": "Criteria for this level." }
                                },
                                "required": ["label"]
                            }
                        },
                        "whenTrue": {
                            "type": "string",
                            "description": "predicate only, optional: what counts as true."
                        },
                        "whenFalse": {
                            "type": "string",
                            "description": "predicate only, optional: what counts as false."
                        },
                        "images": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional question-level local image paths (PNG/JPEG) sent only with this question, e.g. one candidate image to compare with the shared evidence."
                        }
                    },
                    "required": ["name", "type", "instructions"]
                }
            },
            "evidence": {
                "type": "object",
                "description": "Evidence shared by every question. Provide at least one of text, json or images (or question-level images).",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Plain-text evidence."
                    },
                    "json": {
                        "description": "Structured evidence as a real JSON value (object or array), not a JSON-encoded string."
                    },
                    "images": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Local image paths (PNG/JPEG) shared by all questions, e.g. a screenshot or a reference image."
                    }
                }
            },
            "model": {
                "type": "string",
                "description": "Optional decision model id or name from Settings > API > Decision models. Omit to use the default decision tool model."
            }
        },
        "required": ["questions", "evidence"]
    })
}

/// 解析后的问题：图片仍是原始路径，读取在阻塞线程里完成。
struct QuestionSpec {
    name: String,
    instructions: String,
    kind: CustomQuestionKind,
    image_paths: Vec<String>,
}

struct EvidenceSpec {
    text: Option<String>,
    json: Option<Value>,
    image_paths: Vec<String>,
}

/// 一张已加载图片的展示摘要（随结果返回，便于核对实际发送的尺寸）。
struct LoadedImage {
    image: EvidenceImage,
    summary: Value,
}

impl DecisionService {
    /// `decision-evaluate`：`workspace_roots` 由分发层注入（WorkTree 根，或项目根 + 关联项目根）。
    pub async fn execute_evaluate(
        &self,
        args: &Value,
        workspace_roots: &[String],
        usage_scope: DecisionUsageScope,
    ) -> napi::Result<Value> {
        let questions = parse_questions(args)?;
        let evidence = parse_evidence(args)?;
        let has_question_images = questions.iter().any(|q| !q.image_paths.is_empty());
        if evidence.text.is_none()
            && evidence.json.is_none()
            && evidence.image_paths.is_empty()
            && !has_question_images
        {
            return Err(invalid_arg(
                "Nothing to judge: provide evidence.text, evidence.json, evidence.images or question-level images",
            ));
        }

        let model_reference = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let (model_name, config) = resolve_model(model_reference).await?;
        let usage_scope = DecisionUsageScope {
            model_name: model_name.clone(),
            ..usage_scope
        };

        // 先读完并校验全部图片，任何一张失败都不发请求。
        let mut all_paths: Vec<String> = Vec::new();
        for path in evidence
            .image_paths
            .iter()
            .chain(questions.iter().flat_map(|q| q.image_paths.iter()))
        {
            if !all_paths.contains(path) {
                all_paths.push(path.clone());
            }
        }
        if all_paths.len() > MAX_IMAGES {
            return Err(invalid_arg(format!(
                "Too many images: {} distinct paths (limit {MAX_IMAGES} per call)",
                all_paths.len()
            )));
        }

        let provider = config.provider;
        let roots = workspace_roots.to_vec();
        let loaded = tokio::task::spawn_blocking(move || load_images(&all_paths, &roots, provider))
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Image loading task failed: {error}"),
                )
            })??;

        let lookup = |path: &String| -> napi::Result<EvidenceImage> {
            loaded
                .get(path)
                .map(|item| item.image.clone())
                .ok_or_else(|| image_error(path, "was not loaded"))
        };

        let evidence_input = EvidenceInput {
            text: evidence.text,
            json: evidence.json,
            images: evidence
                .image_paths
                .iter()
                .map(lookup)
                .collect::<napi::Result<Vec<_>>>()?,
        };
        let mut custom_questions: Vec<CustomQuestion> = Vec::with_capacity(questions.len());
        for question in &questions {
            custom_questions.push(CustomQuestion {
                name: question.name.clone(),
                instructions: question.instructions.clone(),
                kind: question.kind.clone(),
                images: question
                    .image_paths
                    .iter()
                    .map(lookup)
                    .collect::<napi::Result<Vec<_>>>()?,
            });
        }

        let answers = evaluate_custom(&config, &usage_scope, &evidence_input, &custom_questions).await?;

        let formatted: Vec<Value> = questions
            .iter()
            .map(|question| format_answer(question, answers.get(&question.name)))
            .collect();

        let mut image_summaries: Vec<Value> = Vec::new();
        for path in evidence
            .image_paths
            .iter()
            .chain(questions.iter().flat_map(|q| q.image_paths.iter()))
        {
            if let Some(item) = loaded.get(path) {
                if !image_summaries
                    .iter()
                    .any(|summary| summary.get("path").and_then(Value::as_str) == Some(path.as_str()))
                {
                    image_summaries.push(item.summary.clone());
                }
            }
        }

        let mut result = json!({
            "success": true,
            "decisionModel": {
                "name": model_name,
                "provider": config.provider.as_str(),
                "model": config.model,
            },
            "answers": formatted,
        });
        if !image_summaries.is_empty() {
            result["images"] = Value::Array(image_summaries);
        }
        Ok(result)
    }
}

/// 解析决策模型：参数优先，否则用「决策工具默认模型」设置。
async fn resolve_model(reference: String) -> napi::Result<(String, DecisionModelConfig)> {
    let resolution = tokio::task::spawn_blocking(move || -> napi::Result<_> {
        let database_path = crate::storage::ensure_database_file()?;
        let models = load_decision_models(&database_path);
        let reference = if reference.is_empty() {
            load_decision_tool_model_id(&database_path)
        } else {
            reference
        };
        Ok(resolve_decision_model_reference(&models, &reference))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to resolve the decision model: {error}"),
        )
    })??;

    match resolution {
        DecisionModelResolution::Ready { name, config } => Ok((name, config)),
        DecisionModelResolution::NotSelected => Err(Error::new(
            Status::GenericFailure,
            "No decision model selected: pass `model` (a decision model id or name) or set the default decision tool model in Settings > API > Decision models".to_string(),
        )),
        DecisionModelResolution::Unavailable { name, reason } => Err(Error::new(
            Status::GenericFailure,
            format!("Decision model \"{name}\" is unavailable: {reason}"),
        )),
    }
}

fn parse_questions(args: &Value) -> napi::Result<Vec<QuestionSpec>> {
    let items = args
        .get("questions")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| invalid_arg("Missing required parameter: questions (a non-empty array)"))?;
    if items.len() > MAX_QUESTIONS {
        return Err(invalid_arg(format!(
            "Too many questions: {} (limit {MAX_QUESTIONS})",
            items.len()
        )));
    }

    let mut questions: Vec<QuestionSpec> = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let position = index + 1;
        let name = text_field(item, "name")
            .ok_or_else(|| invalid_arg(format!("questions[{position}].name is required")))?;
        let valid_name = name.chars().count() <= MAX_NAME_CHARS
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
        if !valid_name {
            return Err(invalid_arg(format!(
                "questions[{position}].name \"{name}\" must use letters, digits, '_' or '-' (at most {MAX_NAME_CHARS} characters)"
            )));
        }
        if questions.iter().any(|existing| existing.name == name) {
            return Err(invalid_arg(format!("Duplicate question name \"{name}\"")));
        }

        let instructions = text_field(item, "instructions").ok_or_else(|| {
            invalid_arg(format!("questions[{position}] (\"{name}\") needs instructions"))
        })?;
        let question_type = text_field(item, "type").unwrap_or_default();
        let kind = match question_type.as_str() {
            "predicate" => CustomQuestionKind::Predicate {
                when_true: text_field(item, "whenTrue"),
                when_false: text_field(item, "whenFalse"),
            },
            "choice" => {
                let options = labeled_list(item, "choices", "value", &name)?;
                if options.len() < 2 || options.len() > MAX_CHOICES {
                    return Err(invalid_arg(format!(
                        "Choice question \"{name}\" needs 2-{MAX_CHOICES} choices, got {}",
                        options.len()
                    )));
                }
                CustomQuestionKind::Choice { options }
            }
            "score" => {
                let levels = labeled_list(item, "levels", "label", &name)?;
                if levels.len() < MIN_SCORE_LEVELS || levels.len() > MAX_SCORE_LEVELS {
                    return Err(invalid_arg(format!(
                        "Score question \"{name}\" needs {MIN_SCORE_LEVELS}-{MAX_SCORE_LEVELS} levels, got {}",
                        levels.len()
                    )));
                }
                CustomQuestionKind::Score { levels }
            }
            other => {
                return Err(invalid_arg(format!(
                    "Question \"{name}\" has unsupported type \"{other}\" (use predicate, choice or score)"
                )))
            }
        };

        questions.push(QuestionSpec {
            image_paths: path_list(item, "images", &format!("questions[{position}].images"))?,
            name,
            instructions,
            kind,
        });
    }
    Ok(questions)
}

fn parse_evidence(args: &Value) -> napi::Result<EvidenceSpec> {
    let evidence = match args.get("evidence") {
        Some(Value::Object(_)) => args.get("evidence").cloned().unwrap_or(Value::Null),
        None | Some(Value::Null) => Value::Object(Map::new()),
        // 模型偶尔直接传字符串：按纯文本证据处理。
        Some(Value::String(text)) => json!({ "text": text }),
        Some(_) => {
            return Err(invalid_arg(
                "evidence must be an object with text, json and/or images",
            ))
        }
    };

    let text = text_field(&evidence, "text");
    if let Some(text) = &text {
        let length = text.chars().count();
        if length > MAX_EVIDENCE_TEXT_CHARS {
            return Err(invalid_arg(format!(
                "evidence.text is too long: {length} characters (limit {MAX_EVIDENCE_TEXT_CHARS})"
            )));
        }
    }

    let json = match evidence.get("json") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            if raw.trim().is_empty() {
                None
            } else {
                Some(serde_json::from_str::<Value>(raw).map_err(|_| {
                    invalid_arg("evidence.json must be a real JSON value (object or array); put plain text in evidence.text")
                })?)
            }
        }
        Some(value) => Some(value.clone()),
    };

    Ok(EvidenceSpec {
        text,
        json,
        image_paths: path_list(&evidence, "images", "evidence.images")?,
    })
}

/// 读取 `[{ <key>, description? }]` 列表：键非空且不重复。
fn labeled_list(
    item: &Value,
    field: &str,
    key: &str,
    question: &str,
) -> napi::Result<Vec<(String, Option<String>)>> {
    let entries = item.get(field).and_then(Value::as_array).ok_or_else(|| {
        invalid_arg(format!("Question \"{question}\" needs a `{field}` array"))
    })?;

    let mut list: Vec<(String, Option<String>)> = Vec::with_capacity(entries.len());
    for entry in entries {
        // 也接受纯字符串写法。
        let (value, description) = match entry {
            Value::String(text) => (Some(text.trim().to_string()), None),
            _ => (text_field(entry, key), text_field(entry, "description")),
        };
        let value = value.filter(|value| !value.is_empty()).ok_or_else(|| {
            invalid_arg(format!(
                "Every `{field}` entry of question \"{question}\" needs a non-empty {key}"
            ))
        })?;
        if list.iter().any(|(existing, _)| existing == &value) {
            return Err(invalid_arg(format!(
                "Question \"{question}\" repeats the {key} \"{value}\""
            )));
        }
        list.push((value, description));
    }
    Ok(list)
}

fn path_list(item: &Value, field: &str, label: &str) -> napi::Result<Vec<String>> {
    match item.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(path)) => Ok(non_empty_paths([path.as_str()])),
        Some(Value::Array(entries)) => {
            let mut paths = Vec::with_capacity(entries.len());
            for entry in entries {
                paths.push(entry.as_str().ok_or_else(|| {
                    invalid_arg(format!("{label} must be an array of path strings"))
                })?);
            }
            Ok(non_empty_paths(paths))
        }
        Some(_) => Err(invalid_arg(format!(
            "{label} must be an array of path strings"
        ))),
    }
}

fn non_empty_paths<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for path in paths.into_iter().map(str::trim).filter(|path| !path.is_empty()) {
        if !result.iter().any(|existing| existing == path) {
            result.push(path.to_string());
        }
    }
    result
}

fn text_field(item: &Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 图片允许读取的范围与相对路径基准。
struct ImageScope {
    base_dir: Option<PathBuf>,
    upload_dir: Option<PathBuf>,
    allowed_roots: Vec<PathBuf>,
}

fn build_image_scope(workspace_roots: &[String]) -> ImageScope {
    let app_storage_dir = crate::storage::paths::app_storage_dir().ok();
    let mut candidates: Vec<PathBuf> = workspace_roots
        .iter()
        .filter(|root| !is_ssh_path(root))
        .map(PathBuf::from)
        .collect();
    candidates.extend(app_storage_dir.clone());
    if let Ok(root) = crate::storage::services::image_library::image_library_root() {
        candidates.push(root);
    }
    candidates.push(std::env::temp_dir());

    // 统一取规范路径，符号链接与 macOS /var -> /private/var 才能正确比较。
    let mut allowed_roots: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if let Ok(canonical) = std::fs::canonicalize(&candidate) {
            if !allowed_roots.contains(&canonical) {
                allowed_roots.push(canonical);
            }
        }
    }

    ImageScope {
        base_dir: workspace_roots
            .iter()
            .find(|root| !is_ssh_path(root))
            .map(PathBuf::from),
        upload_dir: app_storage_dir,
        allowed_roots,
    }
}

fn resolve_image_path(raw: &str, scope: &ImageScope) -> napi::Result<PathBuf> {
    let lower = raw.to_ascii_lowercase();
    if is_ssh_path(raw)
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
    {
        return Err(image_error(
            raw,
            "only local image files are supported (no URLs, data URLs or remote SSH paths)",
        ));
    }

    let expanded = crate::utils::paths::expand_home_dir(raw);
    let candidate = PathBuf::from(&expanded);
    let path = if candidate.is_absolute() {
        candidate
    } else if expanded.starts_with("upload/") || expanded.starts_with("upload\\") {
        scope
            .upload_dir
            .as_ref()
            .map(|dir| dir.join(&expanded))
            .ok_or_else(|| image_error(raw, "the Snow App data directory is unavailable"))?
    } else {
        scope.base_dir.as_ref().map(|dir| dir.join(&expanded)).ok_or_else(|| {
            image_error(
                raw,
                "a relative path needs a local project workspace; pass an absolute path instead",
            )
        })?
    };

    let canonical = std::fs::canonicalize(&path)
        .map_err(|error| image_error(raw, &format!("cannot be read: {error}")))?;
    if !scope
        .allowed_roots
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Err(image_error(
            raw,
            "is outside the allowed directories (project workspace, Snow App data directory, image library, system temp directory)",
        ));
    }
    if !canonical.is_file() {
        return Err(image_error(raw, "is not a file"));
    }
    Ok(canonical)
}

/// 阻塞线程中读取、校验并编码全部图片；任何一张失败即整体失败。
fn load_images(
    paths: &[String],
    workspace_roots: &[String],
    provider: DecisionProvider,
) -> napi::Result<HashMap<String, LoadedImage>> {
    let mut loaded: HashMap<String, LoadedImage> = HashMap::new();
    if paths.is_empty() {
        return Ok(loaded);
    }

    let scope = build_image_scope(workspace_roots);
    let mut total_bytes = 0usize;
    for raw in paths {
        let item = load_image(raw, &scope, provider)?;
        total_bytes += item.image.data_base64.len();
        if total_bytes > MAX_TOTAL_IMAGE_BASE64_BYTES {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Images exceed the {} MiB total limit per call after processing (reached at \"{raw}\"); send fewer or smaller images",
                    MAX_TOTAL_IMAGE_BASE64_BYTES / 1024 / 1024
                ),
            ));
        }
        loaded.insert(raw.clone(), item);
    }
    Ok(loaded)
}

fn load_image(
    raw: &str,
    scope: &ImageScope,
    provider: DecisionProvider,
) -> napi::Result<LoadedImage> {
    let path = resolve_image_path(raw, scope)?;
    let size = std::fs::metadata(&path)
        .map_err(|error| image_error(raw, &format!("cannot be read: {error}")))?
        .len();
    if size > MAX_IMAGE_FILE_BYTES {
        return Err(image_error(
            raw,
            &format!(
                "is {size} bytes, over the {} MiB per-image limit",
                MAX_IMAGE_FILE_BYTES / 1024 / 1024
            ),
        ));
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| image_error(raw, &format!("cannot be read: {error}")))?;

    let format = detect_format(&bytes)
        .ok_or_else(|| image_error(raw, "is not a PNG or JPEG file (only PNG and JPEG are supported)"))?;
    let image_format = match format {
        EvidenceImageFormat::Png => image::ImageFormat::Png,
        EvidenceImageFormat::Jpeg => image::ImageFormat::Jpeg,
    };
    let (width, height) = image::ImageReader::with_format(Cursor::new(&bytes), image_format)
        .into_dimensions()
        .map_err(|error| image_error(raw, &format!("could not be decoded: {error}")))?;

    // 与会话图片同一套降采样：长边超过 1568 时等比缩小，体积过大时重编码。
    let optimized =
        crate::api::conversation::image_optimize::optimize_for_request(&bytes, format.mime());
    let resized = optimized.is_some() && width.max(height) > MAX_SENT_EDGE;
    let (sent_format, data_base64) = match optimized {
        Some(optimized) => (
            if optimized.media_type == "image/png" {
                EvidenceImageFormat::Png
            } else {
                EvidenceImageFormat::Jpeg
            },
            optimized.data,
        ),
        None => (
            format,
            base64::engine::general_purpose::STANDARD.encode(&bytes),
        ),
    };
    let (sent_width, sent_height) = if resized {
        scaled_dimensions(width, height)
    } else {
        (width, height)
    };

    if provider == DecisionProvider::Typesafe {
        if sent_width.max(sent_height) > MAX_SENT_EDGE {
            return Err(image_error(
                raw,
                &format!("is {width}x{height} and could not be downscaled to the 1568 px limit of TypeSafe Jev"),
            ));
        }
        if sent_width.min(sent_height) < TYPESAFE_MIN_EDGE {
            return Err(image_error(
                raw,
                &format!(
                    "is {sent_width}x{sent_height} after scaling; TypeSafe Jev requires both sides to be at least {TYPESAFE_MIN_EDGE} px"
                ),
            ));
        }
    }

    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw.to_string());
    let key = blake3::hash(&bytes).to_hex().as_str()[..32].to_string();

    Ok(LoadedImage {
        summary: json!({
            "path": raw,
            "width": width,
            "height": height,
            "sentWidth": sent_width,
            "sentHeight": sent_height,
            "format": sent_format.mime(),
        }),
        image: EvidenceImage {
            key,
            label,
            format: sent_format,
            data_base64,
        },
    })
}

/// 按文件头识别格式，不信任扩展名。
fn detect_format(bytes: &[u8]) -> Option<EvidenceImageFormat> {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.starts_with(PNG_SIGNATURE) {
        Some(EvidenceImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(EvidenceImageFormat::Jpeg)
    } else {
        None
    }
}

/// 与 image crate 等比缩放到 1568 包围盒的计算方式一致。
fn scaled_dimensions(width: u32, height: u32) -> (u32, u32) {
    let ratio = f64::from(MAX_SENT_EDGE) / f64::from(width.max(height));
    let scale = |value: u32| ((f64::from(value) * ratio).round() as u32).max(1);
    (scale(width), scale(height))
}

/// 把归一化答案整理成工具输出；score 的档位按问题定义的 label 还原。
fn format_answer(question: &QuestionSpec, answer: Option<&Value>) -> Value {
    let kind_name = match &question.kind {
        CustomQuestionKind::Predicate { .. } => "predicate",
        CustomQuestionKind::Choice { .. } => "choice",
        CustomQuestionKind::Score { .. } => "score",
    };
    let mut output = json!({ "name": question.name, "type": kind_name });

    let Some(answer) = answer else {
        output["error"] = json!("The decision model returned no answer for this question");
        return output;
    };
    if answer.get("refusal").and_then(Value::as_bool) == Some(true) {
        output["refused"] = json!(true);
        return output;
    }

    let confidence = answer.get("confidence").filter(|value| !value.is_null());
    match &question.kind {
        CustomQuestionKind::Predicate { .. } => {
            output["probability"] = answer.get("probability").cloned().unwrap_or(Value::Null);
        }
        CustomQuestionKind::Choice { .. } => {
            output["choice"] = answer.get("choice").cloned().unwrap_or(Value::Null);
            if let Some(confidence) = confidence {
                output["confidence"] = confidence.clone();
            }
            if let Some(probabilities) = answer.get("probabilities").filter(|v| v.is_object()) {
                output["probabilities"] = probabilities.clone();
            }
        }
        CustomQuestionKind::Score { levels } => {
            output["score"] = answer.get("score").cloned().unwrap_or(Value::Null);
            if let Some(confidence) = confidence {
                output["confidence"] = confidence.clone();
            }
            let probabilities = score_level_probabilities(levels, answer.get("levels"));
            if let Some((best, _)) = probabilities
                .iter()
                .enumerate()
                .filter_map(|(index, probability)| probability.map(|p| (index, p)))
                .fold(None::<(usize, f64)>, |best, (index, probability)| match best {
                    Some((_, best_probability)) if probability < best_probability => best,
                    _ => Some((index, probability)),
                })
            {
                output["level"] = json!(levels[best].0);
            }
            output["levels"] = Value::Array(
                levels
                    .iter()
                    .zip(probabilities.iter())
                    .map(|((label, _), probability)| {
                        json!({ "label": label, "probability": probability })
                    })
                    .collect(),
            );
        }
    }
    output
}

/// 按问题定义的档位顺序取各档概率：OpenAI 以 label 对齐，TypeSafe 以序号对齐。
fn score_level_probabilities(
    levels: &[(String, Option<String>)],
    answer_levels: Option<&Value>,
) -> Vec<Option<f64>> {
    let mut probabilities = vec![None; levels.len()];
    let Some(items) = answer_levels.and_then(Value::as_array) else {
        return probabilities;
    };
    for item in items {
        let Some(probability) = item
            .get("probability")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        else {
            continue;
        };
        let rank = item
            .get("label")
            .and_then(Value::as_str)
            .and_then(|label| levels.iter().position(|(key, _)| key == label))
            .or_else(|| {
                item.get("index")
                    .and_then(Value::as_u64)
                    .and_then(|index| usize::try_from(index).ok())
                    .filter(|index| *index < levels.len())
            });
        if let Some(rank) = rank {
            probabilities[rank] = Some(probability);
        }
    }
    probabilities
}

fn image_error(raw: &str, reason: &str) -> Error {
    Error::new(Status::GenericFailure, format!("Image \"{raw}\" {reason}"))
}

fn invalid_arg(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}
