//! 决策模型客户端（TypeSafe System One / OpenAI Decisions）。
//!
//! 决策模型不生成文本，只对给定 state 逐条回答问题：代码库审查用它判定每条结果
//! 是否相关，敏感命令辅助用它判定命令能否直接执行、给出理由分类与风险等级
//! （score 问题：OpenAI 用 `levels`，TypeSafe Jev 用有序 `criteria`）。
//!
//! 代码库审查有两种问题类型：未配置阈值时用 choice（relevant / irrelevant），
//! 配置了相关性阈值时改用 predicate。OpenAI Decisions 叫 predicate，TypeSafe
//! Jev 的同一能力叫 noul（yes/no 概率），请求体与响应字段在 provider 适配层互转。
//!
//! 两种 provider 共用同一条链路：构建 state 与问题 -> 按 provider 生成请求体 ->
//! 把两种响应折叠成 `answers: { <name>: { choice, confidence, probability } }`
//! -> 同一段解释代码。任何传输或协议失败都返回错误，由调用方决定回退。
//!
//! `evaluate_custom` 是 `decision-evaluate` 工具的通用入口，支持图片证据：
//! OpenAI 走 `input_image`（共享证据进 input，题级图片进 instructions 数组），
//! TypeSafe Jev 走顶层 `assets` + 引用串，并带 `TypeSafe-Danger-Zone-Images` 头。
//!
//! 敏感命令判定可选附带会话片段：OpenAI 用原生多轮 `input`（消息 + 工具调用/输出），
//! TypeSafe Jev 没有多轮协议，按官方 state 用法放进 state 的 `recentConversation`。
//!
//! 题数与 state 字符预算按 provider 区分（`DecisionProvider::limits`），超预算的结果
//! 不提问、按保留处理。
//!
//! 全部异步执行，不阻塞 Node.js 主线程。请求完成后把响应的 usage 写入
//! usage_records（request_method = decisions）；Jev 不返回 usage，不写 0 值记录。

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Map, Value};

use crate::api::config::normalize_base_url;
use crate::api::model_health::{
    observe_call, post_json, ModelCallReport, ModelKind, ModelRequestError, CONNECTION_TEST_FUNC,
};
use crate::storage::services::codebase_index::SearchResult;
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::SensitiveCommandMatchResult;

/// TypeSafe System One 官方端点（Base URL 留空时的回落值）。
const DEFAULT_TYPESAFE_BASE_URL: &str = "https://api.typesafe.ai/v1";

/// OpenAI Decisions 官方端点（Base URL 留空时的回落值）。
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

const CUSTOM_BASE_URL_MODE: &str = "custom";
const AUTO_BASE_URL_MODE: &str = "auto";

/// system_settings 里决策模型配置的 setting_code（与前端 decisionModels.ts 一致）。
pub const DECISION_MODELS_SETTING_CODE: &str = "decision_models";

/// 每条结果摘录的最大字符数。
const MAX_EXCERPT_CHARS: usize = 800;

/// TypeSafe Jev 预算。依据官方 Models 文档（2026-10-30 查阅，jev-1.13/1.14）：题数无单独上限，
/// state + 全部问题 <= 64k token，state + 最长单题 <= 32k token。按保守的 2 字符/token
/// 估算，48k 字符 state 约 24k token，可容纳 codebase-search 上限 50 条结果的完整摘录。
const TYPESAFE_LIMITS: DecisionLimits = DecisionLimits {
    max_questions: 50,
    max_state_chars: 48_000,
};

/// OpenAI Decisions 预算。依据官方 API 参考（2026-10-30 查阅，gpt-6-luna）：每请求 1-400 题，
/// 模型上下文 1.05M token，输入超 272k token 按 2 倍计价。题数取 50 对齐结果上限；
/// 200k 字符 state 按 2 字符/token 约 100k token，远低于计价拐点。
const OPENAI_LIMITS: DecisionLimits = DecisionLimits {
    max_questions: 50,
    max_state_chars: 200_000,
};

/// 请求超时：决策模型通常几十毫秒返回，短上限避免卡住搜索。
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// 带图片的请求体积大，上传与处理更慢，单独放宽超时。
const IMAGE_REQUEST_TIMEOUT_SECS: u64 = 90;

/// TypeSafe 图片能力开关头：请求含图片时必须携带。
const TYPESAFE_IMAGES_HEADER: &str = "TypeSafe-Danger-Zone-Images";

/// `decision-evaluate` 工具默认使用的决策模型 id（system_settings，值为模型 id 字符串）。
pub const DECISION_TOOL_MODEL_SETTING_CODE: &str = "decision_tool_model";

/// 模型判定相关的选项值。
const RELEVANT_OPTION: &str = "relevant";
const ALLOW_OPTION: &str = "allow";
const DENY_OPTION: &str = "deny";

/// 概率问题类型：OpenAI 叫 predicate，TypeSafe 叫 noul，内部统一用 predicate。
const PREDICATE_QUESTION_TYPE: &str = "predicate";
const NOUL_QUESTION_TYPE: &str = "noul";
const CHOICE_QUESTION_TYPE: &str = "choice";
const SCORE_QUESTION_TYPE: &str = "score";

/// 敏感命令请求的问题 id；答案按同名的 name 返回。
const VERDICT_QUESTION_ID: &str = "verdict";
const REASON_QUESTION_ID: &str = "reason";
const SEVERITY_QUESTION_ID: &str = "severity";

/// 风险等级（低 -> 高，顺序即档位序号）；label 是前端 i18n key
/// （`sensitiveCommand.severity.<label>`）。仅用于展示与日志，不参与放行判定。
const SEVERITY_LEVELS: &[(&str, &str)] = &[
    (
        "low",
        "Harmless or trivially undone: it only reads, touches generated or regenerable artifacts, or makes small edits inside the working directory",
    ),
    (
        "medium",
        "Bounded damage that takes effort to recover: project files, local data or environment state could be lost or changed, but it stays recoverable (version control, reinstall, rebuild)",
    ),
    (
        "high",
        "Severe or irreversible: unrecoverable data loss, paths outside the working directory, system-wide changes, or data published or sent off this machine",
    ),
];

/// 答案缺失或选项未知时回退的理由分类。
const REASON_UNKNOWN: &str = "unclear";

/// 理由分类的稳定 key，前端负责本地化（`sensitiveCommand.decision.reason.<key>`）。
const REASON_CATEGORIES: &[(&str, &str)] = &[
    (
        "readOnly",
        "Only reads information; files, system state and remote state stay untouched",
    ),
    (
        "regenerable",
        "Touches only generated or regenerable artifacts (build output, caches, temporary files, dependencies)",
    ),
    (
        "scopedChange",
        "Changes stay inside the working directory and can be undone (edit, rename, move)",
    ),
    (
        "dataLoss",
        "Deletes or overwrites data that cannot be recovered",
    ),
    (
        "systemState",
        "Changes system or environment state (permissions, packages, services, processes)",
    ),
    (
        "externalEffect",
        "Publishes or sends data outside this machine (git push, upload, network write)",
    ),
    (
        REASON_UNKNOWN,
        "The target or the blast radius of the command is unclear",
    ),
];

/// 决策模型协议类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionProvider {
    Typesafe,
    Openai,
}

impl DecisionProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionProvider::Typesafe => "typesafe",
            DecisionProvider::Openai => "openai",
        }
    }

    /// 未知值按 typesafe 处理：存量配置没有 provider 字段。
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Self {
        match value.trim() {
            "openai" => DecisionProvider::Openai,
            _ => DecisionProvider::Typesafe,
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            DecisionProvider::Typesafe => DEFAULT_TYPESAFE_BASE_URL,
            DecisionProvider::Openai => DEFAULT_OPENAI_BASE_URL,
        }
    }

    /// 单次请求的题数与 state 字符预算；超预算的结果不提问、按保留处理。
    pub fn limits(self) -> DecisionLimits {
        match self {
            DecisionProvider::Typesafe => TYPESAFE_LIMITS,
            DecisionProvider::Openai => OPENAI_LIMITS,
        }
    }
}

/// 按 provider 区分的请求预算（字符估算，不做实时 token 计数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecisionLimits {
    pub max_questions: usize,
    pub max_state_chars: usize,
}

/// 一次请求所需的配置；provider 决定端点、请求体与响应解析。
#[derive(Debug, Clone)]
pub struct DecisionModelConfig {
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub model: String,
    pub provider: DecisionProvider,
}

/// 一次决策模型调用的用量归属：条目名（档案名）+ 会话/项目。
#[derive(Debug, Clone, Default)]
pub struct DecisionUsageScope {
    /// 决策模型条目名，写入 usage_records.api_profile_name。
    pub model_name: String,
    /// 空串表示该调用不属于任何会话（如敏感命令判定）。
    pub conversation_id: String,
    pub directory_id: String,
}

/// 响应里的 token 用量；缓存字段都包含在 input_tokens 内，不重复累加。
#[derive(Debug, Clone, Copy, Default)]
struct DecisionTokenUsage {
    input_tokens: i64,
    cache_creation_input_tokens: i64,
    cache_read_input_tokens: i64,
}

/// 一个决策模型配置项（system_settings 的 `decision_models`，camelCase 与前端一致）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DecisionModel {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub model: String,
    pub enabled: bool,
    /// "typesafe" | "openai"；存量条目没有该字段，缺省为 typesafe。
    #[serde(default = "default_provider")]
    pub provider: String,
}

fn default_provider() -> String {
    DecisionProvider::Typesafe.as_str().to_string()
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct DecisionModelStore {
    models: Vec<DecisionModel>,
}

/// 读取全部决策模型配置。
///
/// 配置缺失、为空或解析失败时返回空列表：调用方随即退回 LLM 审查路径，
/// 不影响搜索本身。
pub fn load_decision_models(database_path: &Path) -> Vec<DecisionModel> {
    let raw = match get_system_setting_value(database_path, DECISION_MODELS_SETTING_CODE) {
        Ok(Some(value)) => value,
        _ => return Vec::new(),
    };

    if raw.trim().is_empty() {
        return Vec::new();
    }

    serde_json::from_str::<DecisionModelStore>(&raw)
        .map(|store| store.models)
        .unwrap_or_default()
}

/// 读取 `decision-evaluate` 工具的默认决策模型 id（未设置返回空串）。
pub fn load_decision_tool_model_id(database_path: &Path) -> String {
    match get_system_setting_value(database_path, DECISION_TOOL_MODEL_SETTING_CODE) {
        Ok(Some(value)) => value.trim().to_string(),
        _ => String::new(),
    }
}

impl DecisionModelConfig {
    /// 由原始配置字段构造请求配置。
    ///
    /// 配置不完整（API Key / 模型名为空，自定义模式下请求地址为空）时返回原因，
    /// 供调用方展示「决策模型不可用」而不再静默跳过。
    pub fn new(
        base_url: &str,
        base_url_mode: &str,
        api_key: &str,
        model: &str,
        provider: DecisionProvider,
    ) -> std::result::Result<Self, String> {
        let api_key = api_key.trim();
        let model = model.trim();

        if api_key.is_empty() {
            return Err("The decision model API key is empty".to_string());
        }
        if model.is_empty() {
            return Err("The decision model name is empty".to_string());
        }

        let base_url_mode = normalize_base_url_mode(base_url_mode);
        let base_url = resolve_base_url(base_url, &base_url_mode, provider);

        if base_url.is_empty() {
            return Err("The decision model request URL is empty".to_string());
        }

        Ok(Self {
            base_url,
            base_url_mode,
            api_key: api_key.to_string(),
            model: model.to_string(),
            provider,
        })
    }

    /// 当前 provider 的完整请求端点。
    pub fn endpoint(&self) -> String {
        resolve_provider_endpoint(&self.base_url, &self.base_url_mode, self.provider)
    }
}

/// 选中的决策模型能否使用。
pub enum DecisionModelResolution {
    /// 没有选择决策模型（使用方按「未启用」处理）。
    NotSelected,
    /// 选择了决策模型，但它已被删除、停用或请求信息不完整。
    Unavailable { name: String, reason: String },
    /// 可以发起请求。
    Ready {
        name: String,
        config: DecisionModelConfig,
    },
}

/// 按 id 解析选中的决策模型，并说明不可用的原因（供使用方展示回退原因）。
pub fn resolve_decision_model(models: &[DecisionModel], model_id: &str) -> DecisionModelResolution {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return DecisionModelResolution::NotSelected;
    }

    let Some(selected) = models.iter().find(|item| item.id == model_id) else {
        return DecisionModelResolution::Unavailable {
            name: model_id.to_string(),
            reason: "The selected decision model no longer exists".to_string(),
        };
    };

    let name = if selected.name.trim().is_empty() {
        selected.model.trim().to_string()
    } else {
        selected.name.trim().to_string()
    };

    if !selected.enabled {
        return DecisionModelResolution::Unavailable {
            name,
            reason: "The selected decision model is disabled".to_string(),
        };
    }

    match DecisionModelConfig::new(
        &selected.base_url,
        &selected.base_url_mode,
        &selected.api_key,
        &selected.model,
        DecisionProvider::from_str(&selected.provider),
    ) {
        Ok(config) => DecisionModelResolution::Ready { name, config },
        Err(reason) => DecisionModelResolution::Unavailable { name, reason },
    }
}

/// 按 id 或名称（不区分大小写）解析决策模型；工具参数允许填写两者之一。
pub fn resolve_decision_model_reference(
    models: &[DecisionModel],
    reference: &str,
) -> DecisionModelResolution {
    let reference = reference.trim();
    if reference.is_empty() {
        return DecisionModelResolution::NotSelected;
    }

    let matched = models
        .iter()
        .find(|item| item.id == reference)
        .or_else(|| {
            models
                .iter()
                .find(|item| item.name.trim().eq_ignore_ascii_case(reference))
        });

    match matched {
        Some(model) => resolve_decision_model(models, &model.id),
        None => DecisionModelResolution::Unavailable {
            name: reference.to_string(),
            reason: "No decision model matches this id or name".to_string(),
        },
    }
}

/// 按配置字段解析请求端点（连接自检在配置不完整时也要能展示端点）。
pub fn resolve_endpoint(
    base_url: &str,
    base_url_mode: &str,
    provider: DecisionProvider,
) -> String {
    let base_url_mode = normalize_base_url_mode(base_url_mode);
    let base_url = resolve_base_url(base_url, &base_url_mode, provider);
    resolve_provider_endpoint(&base_url, &base_url_mode, provider)
}

fn resolve_provider_endpoint(
    base_url: &str,
    base_url_mode: &str,
    provider: DecisionProvider,
) -> String {
    match provider {
        DecisionProvider::Typesafe => resolve_systemone_endpoint(base_url, base_url_mode),
        DecisionProvider::Openai => resolve_decisions_endpoint(base_url),
    }
}

fn normalize_base_url_mode(base_url_mode: &str) -> String {
    if base_url_mode.trim() == CUSTOM_BASE_URL_MODE {
        CUSTOM_BASE_URL_MODE.to_string()
    } else {
        AUTO_BASE_URL_MODE.to_string()
    }
}

/// 规范化后的 Base URL；自动模式下留空回落到该 provider 的官方地址。
fn resolve_base_url(
    base_url: &str,
    base_url_mode: &str,
    provider: DecisionProvider,
) -> String {
    let normalized = normalize_base_url(base_url);

    if base_url_mode == CUSTOM_BASE_URL_MODE {
        return normalized;
    }

    if normalized.is_empty() {
        provider.default_base_url().to_string()
    } else {
        normalized
    }
}

/// 相关性审查结果。
pub struct RelevanceEvaluation {
    /// 保留的结果下标（升序）。
    pub relevant_indices: Vec<usize>,
    /// 与输入结果一一对齐的概率；未询问、choice 模式或答案缺概率时为 None。
    pub probabilities: Vec<Option<f64>>,
    /// 本次实际生效的阈值；None 表示走的是 choice 二分类判定。
    pub relevance_threshold: Option<f64>,
    /// 本次请求使用的预算与判定数，供 pipeline 解释「为什么有些结果没被判定」。
    pub budget: RelevanceBudget,
}

/// 一次相关性审查的预算使用情况。
#[derive(Debug, Clone, Copy)]
pub struct RelevanceBudget {
    pub provider: DecisionProvider,
    pub limits: DecisionLimits,
    /// 参与审查的结果数。
    pub total: usize,
    /// 进入问题列表（实际请求判定）的结果数；其余超预算、按保留处理。
    pub asked: usize,
}

/// 询问决策模型：哪些搜索结果与 query 相关。
///
/// `relevance_threshold` 为 None 时每条结果变成一个 `relevant` / `irrelevant`
/// 的 choice 问题，判定完全由模型给出；为 Some(t) 时改用概率问题，按
/// `probability >= t` 保留。超出 provider 预算（`DecisionProvider::limits`）的结果、
/// 以及缺概率的结果都按相关保留，审查始终保守。
pub async fn evaluate_relevance(
    config: &DecisionModelConfig,
    usage_scope: &DecisionUsageScope,
    query: &str,
    results: &[SearchResult],
    relevance_threshold: Option<f64>,
) -> Result<RelevanceEvaluation> {
    let mut probabilities = vec![None; results.len()];
    let limits = config.provider.limits();
    let budget = |asked: usize| RelevanceBudget {
        provider: config.provider,
        limits,
        total: results.len(),
        asked,
    };

    if results.is_empty() {
        return Ok(RelevanceEvaluation {
            relevant_indices: Vec::new(),
            probabilities,
            relevance_threshold: None,
            budget: budget(0),
        });
    }

    // 越界阈值视为未配置：写入边界已校验，这里只防御存量/手改数据。
    let threshold = relevance_threshold
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value));

    let (state, asked) = build_state(query, results, limits);

    // 没有任何结果进入预算：全部按相关返回，避免只拿空列表去问模型。
    if asked.is_empty() {
        return Ok(RelevanceEvaluation {
            relevant_indices: (0..results.len()).collect(),
            probabilities,
            relevance_threshold: threshold,
            budget: budget(0),
        });
    }

    let questions = relevance_questions(&asked, threshold.is_some());

    let parsed = evaluate_state(
        config,
        Some(usage_scope),
        "evaluate_relevance",
        &state,
        &questions,
        |parsed| Ok(parsed),
    )
    .await
    .into_result()?;

    let answers = parsed.get("answers").and_then(Value::as_object);

    let mut asked_indices: Vec<usize> = Vec::with_capacity(asked.len());
    let mut relevant: Vec<usize> = Vec::with_capacity(results.len());
    let mut missing_probability = 0usize;

    for (index, id) in &asked {
        asked_indices.push(*index);
        let answer = answers.and_then(|map| map.get(id));

        match (threshold, answer) {
            (Some(limit), Some(answer)) => {
                match answer.get("probability").and_then(Value::as_f64) {
                    // 判定规则固定：probability >= threshold 保留，否则过滤。
                    Some(probability) if (0.0..=1.0).contains(&probability) => {
                        probabilities[*index] = Some(probability);
                        if probability >= limit {
                            relevant.push(*index);
                        }
                    }
                    // 缺概率或类型不符：该结果按保留处理，稍后记诊断日志。
                    _ => {
                        missing_probability += 1;
                        relevant.push(*index);
                    }
                }
            }
            (Some(_), None) => {
                missing_probability += 1;
                relevant.push(*index);
            }
            // choice 模式：模型判定决定去留；答案缺失时保留，不丢弃未判定的内容。
            (None, answer) => {
                let verdict = answer
                    .and_then(|answer| answer.get("choice"))
                    .and_then(Value::as_str);
                if verdict.is_none() || verdict == Some(RELEVANT_OPTION) {
                    relevant.push(*index);
                }
            }
        }
    }

    if threshold.is_some() {
        // 整批都缺概率说明响应对不上，按错误交回调用方回退 LLM 审查。
        if missing_probability == asked.len() {
            return Err(Error::from_reason(format!(
                "The {} decision model returned no usable relevance probability for any result",
                config.provider.as_str()
            )));
        }
        if missing_probability > 0 {
            log_missing_probabilities(query, missing_probability, asked.len()).await;
        }
    }

    // 未进入问题列表（问题上限 / state 预算）的结果同样保留。
    for index in 0..results.len() {
        if !asked_indices.contains(&index) {
            relevant.push(index);
        }
    }

    relevant.sort_unstable();
    Ok(RelevanceEvaluation {
        relevant_indices: relevant,
        probabilities,
        relevance_threshold: threshold,
        budget: budget(asked.len()),
    })
}

/// 组装相关性审查的问题：choice 二分类，或 predicate/noul 概率判定。
fn relevance_questions(asked: &[(usize, String)], predicate_mode: bool) -> Value {
    let mut questions = Map::new();
    for (_, id) in asked {
        let instructions =
            format!("Is result [{id}] relevant to the developer's code search query?");
        questions.insert(
            id.clone(),
            if predicate_mode {
                json!({
                    "type": PREDICATE_QUESTION_TYPE,
                    "instructions": instructions,
                    "criteria": {
                        "true": "The excerpt matches what the query is looking for",
                        "false": "An unrelated file, or generic boilerplate that only looks similar"
                    }
                })
            } else {
                json!({
                    "type": CHOICE_QUESTION_TYPE,
                    "instructions": instructions,
                    "criteria": {
                        "relevant": "The excerpt matches what the query is looking for",
                        "irrelevant": "An unrelated file, or generic boilerplate that only looks similar"
                    }
                })
            },
        );
    }
    Value::Object(questions)
}

/// 记录「部分答案缺概率」的诊断（best effort，不阻塞审查）。
async fn log_missing_probabilities(query: &str, missing: usize, asked: usize) {
    let Ok(Ok(database_path)) =
        tokio::task::spawn_blocking(crate::storage::ensure_database_file).await
    else {
        return;
    };

    crate::storage::services::app_logs::log_api_warning(
        &database_path,
        "evaluate_relevance",
        "Decision model relevance answers are missing a usable probability; those results were kept",
        &format!(
            "query: {}; missing: {missing}/{asked}",
            crate::api::common::truncate_chars(query, 200)
        ),
    )
    .await;
}

/// 决策模型对一条命中敏感规则命令的判定。
pub struct CommandDecision {
    /// 是否可以直接执行，无需用户确认。
    pub allow: bool,
    /// 理由分类 key（`REASON_CATEGORIES` 之一），前端本地化。
    pub reason: String,
    /// 模型对判定的置信度（0-1）。
    pub confidence: f64,
    /// 风险等级（`SEVERITY_LEVELS` 的 label），取各档概率的 argmax。
    pub severity: Option<String>,
    /// score 原值（档位概率加权平均，可落在两档之间），仅展示与日志。
    pub severity_score: Option<f64>,
    /// 等级解析失败的原因（只进日志）；此时等级留空，verdict 照常生效。
    pub severity_error: Option<String>,
    /// 会话上下文的使用情况；开关关闭时为 None。
    pub context: Option<ContextUsage>,
}

/// 一条命令的判定上下文：命令文本、模型写的说明与实际执行目录。
pub struct CommandContext<'a> {
    /// 完整命令文本。
    pub command: &'a str,
    /// 模型为命令写的一行说明（`bash-terminal-execute` 的 `description`）。
    pub description: &'a str,
    /// 命令的实际执行目录。
    pub working_directory: &'a str,
    /// 命中的敏感规则（模式 + 说明），只作为「被规则命中」的证据。
    pub matched_rules: &'a [SensitiveCommandMatchResult],
    /// 会话上下文（时间正序）；None = 开关关闭，Some(空) = 开关打开但无内容。
    pub conversation: Option<&'a [ConversationMessage]>,
}

/// 会话片段的结构上限：超出视为调用方传参异常；也是可配置条数的上限。
pub const MAX_CONTEXT_MESSAGES: usize = 50;
const MAX_CONTEXT_TOOL_CALLS: usize = 20;

/// 未配置时附带的最近消息条数（与前端默认值一致）。
pub const DEFAULT_CONTEXT_MESSAGES: usize = 8;

/// 配置的条数：缺省回落默认值，越界钳到 1..=MAX_CONTEXT_MESSAGES。
pub fn resolve_context_message_count(configured: Option<u32>) -> usize {
    configured
        .map(|count| (count as usize).clamp(1, MAX_CONTEXT_MESSAGES))
        .unwrap_or(DEFAULT_CONTEXT_MESSAGES)
}

/// OpenAI function name 只允许字母数字、`_`、`-`，最长 64。
const MAX_OPENAI_FUNCTION_NAME_CHARS: usize = 64;

/// 工具调用没有输出时的占位（OpenAI 要求调用与输出按 call_id 配对）。
const MISSING_TOOL_OUTPUT: &str = "[no output recorded]";

/// TypeSafe state 里会话片段的说明。
const TYPESAFE_CONTEXT_NOTE: &str = "Recent conversation before this command, oldest first. User messages show what the user actually asked for; the command under review was proposed by the assistant, not typed by the user.";

/// OpenAI 末尾 developer 消息的前缀：待判定命令放这里，避免被当成用户请求。
const OPENAI_PENDING_COMMAND_PREFIX: &str = "The conversation above is context only. The assistant now proposes the command below; the user did not type it. Judge this pending command (JSON):";

/// 渲染层裁剪后的一条会话消息（JSON 数组元素，camelCase）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationMessage {
    /// "user" | "assistant"。
    pub role: String,
    #[serde(default)]
    pub text: String,
    /// 仅 assistant 可带：该轮已结束的工具调用（名称 + 参数摘要 + 输出摘要）。
    #[serde(default)]
    pub tool_calls: Vec<ConversationToolCall>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationToolCall {
    pub call_id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: String,
    #[serde(default)]
    pub output: Option<String>,
}

/// 会话上下文实际使用情况（随判定记录返回并写日志）。
#[derive(Debug, Clone, Copy, Default)]
pub struct ContextUsage {
    /// 实际发送的消息条数。
    pub messages: usize,
    /// 超出 state 预算丢弃了较早的消息：判定依据不完整。
    pub truncated: bool,
    /// 开关打开但没有可发送的上下文：按无上下文判定。
    pub empty: bool,
}

/// 解析并校验渲染层传入的会话片段。结构非法直接报错（调用方回退人工确认），
/// 不静默降级成无上下文判定；空数组合法。
pub fn parse_conversation_context(
    raw: &str,
) -> std::result::Result<Vec<ConversationMessage>, String> {
    let messages: Vec<ConversationMessage> = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid conversation context: {error}"))?;
    if messages.len() > MAX_CONTEXT_MESSAGES {
        return Err(format!(
            "Invalid conversation context: {} messages exceed the limit of {MAX_CONTEXT_MESSAGES}",
            messages.len()
        ));
    }

    let mut call_ids = std::collections::HashSet::new();
    for (index, message) in messages.iter().enumerate() {
        match message.role.as_str() {
            "user" if !message.tool_calls.is_empty() => {
                return Err(format!(
                    "Invalid conversation context: user message #{index} cannot carry tool calls"
                ));
            }
            "user" | "assistant" => {}
            other => {
                return Err(format!(
                    "Invalid conversation context: message #{index} has unsupported role '{other}'"
                ));
            }
        }
        if message.text.trim().is_empty() && message.tool_calls.is_empty() {
            return Err(format!(
                "Invalid conversation context: message #{index} has neither text nor tool calls"
            ));
        }
        if message.tool_calls.len() > MAX_CONTEXT_TOOL_CALLS {
            return Err(format!(
                "Invalid conversation context: message #{index} has more than {MAX_CONTEXT_TOOL_CALLS} tool calls"
            ));
        }
        for call in &message.tool_calls {
            if call.name.trim().is_empty() || call.call_id.trim().is_empty() {
                return Err(format!(
                    "Invalid conversation context: a tool call in message #{index} has no name or call id"
                ));
            }
            if !call_ids.insert(call.call_id.trim().to_string()) {
                return Err(format!(
                    "Invalid conversation context: duplicate tool call id '{}'",
                    call.call_id.trim()
                ));
            }
        }
    }
    Ok(messages)
}

fn conversation_message_chars(message: &ConversationMessage) -> usize {
    message.text.chars().count()
        + message
            .tool_calls
            .iter()
            .map(|call| {
                call.name.chars().count()
                    + call.arguments.chars().count()
                    + call.output.as_deref().map_or(0, |output| output.chars().count())
            })
            .sum::<usize>()
}

/// 从最新一条往前保留，直到超出预算；返回保留片段（时间正序）与是否丢弃了消息。
fn fit_conversation(
    messages: &[ConversationMessage],
    budget: usize,
) -> (&[ConversationMessage], bool) {
    let mut used = 0usize;
    let mut start = messages.len();
    for (index, message) in messages.iter().enumerate().rev() {
        let cost = conversation_message_chars(message);
        if used + cost > budget {
            break;
        }
        used += cost;
        start = index;
    }
    (&messages[start..], start > 0)
}

/// 参数摘要：合法 JSON 原样保留结构，否则按字符串处理。
fn tool_arguments_value(arguments: &str) -> Value {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str::<Value>(trimmed).unwrap_or_else(|_| json!(trimmed))
}

/// TypeSafe：会话作为 state 的结构化字段（官方 state 支持对象 / 消息数组）。
fn typesafe_conversation(messages: &[ConversationMessage]) -> Value {
    let messages: Vec<Value> = messages
        .iter()
        .map(|message| {
            let mut entry = Map::new();
            entry.insert("role".to_string(), json!(message.role));
            if !message.text.trim().is_empty() {
                entry.insert("text".to_string(), json!(message.text));
            }
            if !message.tool_calls.is_empty() {
                entry.insert(
                    "toolCalls".to_string(),
                    Value::Array(
                        message
                            .tool_calls
                            .iter()
                            .map(|call| {
                                json!({
                                    "name": call.name,
                                    "arguments": tool_arguments_value(&call.arguments),
                                    "output": call.output.as_deref().unwrap_or(MISSING_TOOL_OUTPUT),
                                })
                            })
                            .collect(),
                    ),
                );
            }
            Value::Object(entry)
        })
        .collect();
    json!({ "note": TYPESAFE_CONTEXT_NOTE, "messages": messages })
}

fn openai_function_name(name: &str) -> String {
    let sanitized: String = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .take(MAX_OPENAI_FUNCTION_NAME_CHARS)
        .collect();
    if sanitized.is_empty() {
        "tool".to_string()
    } else {
        sanitized
    }
}

/// OpenAI：原生多轮 input（消息 + function_call / function_call_output 按 call_id 配对）。
fn openai_conversation_items(messages: &[ConversationMessage]) -> Vec<Value> {
    let mut items = Vec::new();
    for message in messages {
        if !message.text.trim().is_empty() {
            items.push(json!({ "role": message.role, "content": message.text }));
        }
        for call in &message.tool_calls {
            // arguments 必须是 JSON 字符串：非 JSON 摘要包一层。
            let arguments = match tool_arguments_value(&call.arguments) {
                Value::String(text) => json!({ "summary": text }).to_string(),
                other => other.to_string(),
            };
            let call_id = call.call_id.trim();
            items.push(json!({
                "type": "function_call",
                "call_id": call_id,
                "name": openai_function_name(&call.name),
                "arguments": arguments,
            }));
            items.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": call.output.as_deref().unwrap_or(MISSING_TOOL_OUTPUT),
            }));
        }
    }
    items
}

/// 带会话上下文的请求体（只在开关打开且有内容时使用；关闭时走原请求体）。
fn build_context_request_body(
    config: &DecisionModelConfig,
    state: &Value,
    questions: &Value,
    messages: &[ConversationMessage],
) -> Value {
    match config.provider {
        DecisionProvider::Typesafe => {
            let mut state = state.clone();
            if let Some(object) = state.as_object_mut() {
                object.insert(
                    "recentConversation".to_string(),
                    typesafe_conversation(messages),
                );
            }
            build_request_body(config, &state, questions)
        }
        DecisionProvider::Openai => {
            let mut input = openai_conversation_items(messages);
            input.push(json!({
                "role": "developer",
                "content": format!(
                    "{OPENAI_PENDING_COMMAND_PREFIX}\n{}",
                    serde_json::to_string_pretty(state).unwrap_or_else(|_| state.to_string())
                ),
            }));
            json!({
                "model": config.model,
                "input": input,
                "questions": openai_questions(questions),
            })
        }
    }
}

/// 询问决策模型：命中敏感规则的命令能否直接执行，以及理由分类。
///
/// verdict 是模型在真实执行上下文下给出的 `allow` / `deny`；规则命中只是提示。
/// 第二个问题从固定理由分类中选一个，调用方据此用用户语言解释判定。
/// 第三个 score 问题给出风险等级，只用于展示与日志，不影响 verdict。
/// 三个答案来自同一次请求；verdict 缺失按错误处理，调用方保持人工确认；
/// 等级缺失或越界只把等级留空（不猜），verdict 照常生效。
pub async fn evaluate_command(
    config: &DecisionModelConfig,
    usage_scope: &DecisionUsageScope,
    context: &CommandContext<'_>,
) -> Result<CommandDecision> {
    let mut state = Map::new();
    state.insert("command".to_string(), json!(context.command));
    if !context.description.trim().is_empty() {
        state.insert(
            "description".to_string(),
            json!(context.description.trim()),
        );
    }
    if !context.working_directory.trim().is_empty() {
        state.insert(
            "workingDirectory".to_string(),
            json!(context.working_directory.trim()),
        );
    }
    state.insert("platform".to_string(), json!(std::env::consts::OS));
    state.insert(
        "matchedRules".to_string(),
        json!(context
            .matched_rules
            .iter()
            .map(|rule| json!({
                "pattern": rule.pattern,
                "description": rule.description,
            }))
            .collect::<Vec<Value>>()),
    );

    let mut reason_criteria = Map::new();
    for (key, description) in REASON_CATEGORIES {
        reason_criteria.insert((*key).to_string(), json!(description));
    }

    // 内部统一为 { label, description } 档位，provider 适配层再转换。
    let severity_levels: Vec<Value> = SEVERITY_LEVELS
        .iter()
        .map(|(label, description)| json!({ "label": label, "description": description }))
        .collect();

    let questions = json!({
        (VERDICT_QUESTION_ID): {
            "type": "choice",
            "instructions": "Judging the real effect of this exact command in this working directory, does it have to wait for the user's confirmation before it runs?",
            "criteria": {
                (ALLOW_OPTION): "Low risk — it can run unattended. It only reads, or it touches generated or regenerable artifacts (build output, caches, temporary files, package or dependency directories), or its effect stays inside the working directory and is easy to undo. A matched rule is not a risk by itself: rules also fire on file names, arguments and commit messages. Typical cases: inspecting files, builds, tests, formatting, cleaning build output, installing dependencies, git status/diff/add/commit inside the project.",
                (DENY_OPTION): "Real risk of an effect the user did not ask for and could not easily undo: deleting or overwriting source code, documents, databases or paths outside the working directory; wiping data that cannot be regenerated; changing system or environment state (permissions, packages, services, processes); publishing or sending data off this machine; or the target is unknown so the effect cannot be bounded. Typical cases: recursive deletion of unresolved paths, disk formatting, force push, dropping a database, piping local files to a remote host.",
            }
        },
        (REASON_QUESTION_ID): {
            "type": "choice",
            "instructions": "Which of these best describes the command's effect?",
            "criteria": reason_criteria,
        },
        (SEVERITY_QUESTION_ID): {
            "type": SCORE_QUESTION_TYPE,
            "instructions": "If this exact command runs in this working directory, how severe is the worst realistic outcome?",
            "levels": severity_levels,
        },
    });
    let state = Value::Object(state);
    let provider = config.provider;

    // 会话上下文沿用 state 总预算：命令本身先占用，剩余按「最新优先」保留。
    let (conversation, context_usage) = match context.conversation {
        None => (None, None),
        Some(messages) => {
            let budget = config
                .provider
                .limits()
                .max_state_chars
                .saturating_sub(state.to_string().chars().count());
            let (kept, truncated) = fit_conversation(messages, budget);
            if truncated {
                log_context_truncated(config, messages.len(), kept.len(), budget).await;
            }
            let usage = ContextUsage {
                messages: kept.len(),
                truncated,
                empty: kept.is_empty(),
            };
            ((!kept.is_empty()).then_some(kept), Some(usage))
        }
    };
    let body = match conversation {
        Some(messages) => build_context_request_body(config, &state, &questions, messages),
        None => build_request_body(config, &state, &questions),
    };

    let decision = send_request(
        config,
        Some(usage_scope),
        "evaluate_command",
        body,
        RequestOptions {
            with_images: false,
            allow_refusal: false,
        },
        move |parsed| {
            let answers = parsed.get("answers").and_then(Value::as_object);
            let verdict_answer = answers.and_then(|map| map.get(VERDICT_QUESTION_ID));
            let verdict = verdict_answer
                .and_then(|answer| answer.get("choice"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    format!(
                        "The {} decision model did not answer the sensitive command verdict",
                        provider.as_str()
                    )
                })?;

            // 未知或缺失的理由分类降级为 unclear：判定仍有效，只是解释不够具体。
            let reason = answers
                .and_then(|map| map.get(REASON_QUESTION_ID))
                .and_then(|answer| answer.get("choice"))
                .and_then(Value::as_str)
                .filter(|choice| REASON_CATEGORIES.iter().any(|(key, _)| key == choice))
                .unwrap_or(REASON_UNKNOWN)
                .to_string();

            // 等级缺失或越界不猜：留空并记录原因，不拖累 verdict。
            let (severity, severity_score, severity_error) =
                match resolve_severity(answers.and_then(|map| map.get(SEVERITY_QUESTION_ID)), provider) {
                    Ok((severity, score)) => (Some(severity), Some(score), None),
                    Err(error) => (None, None, Some(error)),
                };

            Ok(CommandDecision {
                // 只有明确的 allow 才放行，其它情况都保留确认提示。
                allow: verdict == ALLOW_OPTION,
                reason,
                confidence: verdict_answer
                    .and_then(|answer| answer.get("confidence"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    .clamp(0.0, 1.0),
                severity,
                severity_score,
                severity_error,
                context: context_usage,
            })
        },
    )
    .await
    .into_result()?;

    log_command_decision(config, &decision).await;
    Ok(decision)
}

/// 会话上下文超出 state 预算被截断：判定依据不完整，写 WARN 日志（不含消息原文）。
async fn log_context_truncated(
    config: &DecisionModelConfig,
    provided: usize,
    kept: usize,
    budget: usize,
) {
    if crate::api::ephemeral::is_active() {
        return;
    }

    let input = crate::storage::services::app_logs::AppLogInput {
        level: "WARN".to_string(),
        module: "decision_model".to_string(),
        func: "evaluate_command".to_string(),
        line: None,
        message: "Sensitive command conversation context truncated to fit the state budget"
            .to_string(),
        input: None,
        output: None,
        duration: None,
        context: Some(
            json!({
                "provider": config.provider.as_str(),
                "model": config.model,
                "providedMessages": provided,
                "keptMessages": kept,
                "budgetChars": budget,
            })
            .to_string(),
        ),
        error: None,
        source: "main".to_string(),
    };

    tokio::task::spawn_blocking(move || {
        if let Ok(database_path) = crate::storage::ensure_database_file() {
            let _ = crate::storage::services::app_logs::insert_app_log(&database_path, &input);
        }
    })
    .await
    .ok();
}

/// 从 score 答案解析风险等级：取概率最大的档位（并列取更高档），score 仅作展示。
///
/// 档位概率缺失、概率非法、label 不在预设集合或序号越界都返回错误。
fn resolve_severity(
    answer: Option<&Value>,
    provider: DecisionProvider,
) -> std::result::Result<(String, f64), String> {
    let provider_name = provider.as_str();
    let answer = answer.ok_or_else(|| {
        format!("The {provider_name} decision model did not answer the severity question")
    })?;

    let levels = answer
        .get("levels")
        .and_then(Value::as_array)
        .filter(|levels| !levels.is_empty())
        .ok_or_else(|| {
            format!("The {provider_name} decision model returned no severity level probabilities")
        })?;

    let mut best: Option<(usize, f64)> = None;
    let mut probabilities = vec![0.0_f64; SEVERITY_LEVELS.len()];

    for level in levels {
        let probability = level
            .get("probability")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(|| {
                format!("The {provider_name} decision model returned an invalid severity probability")
            })?;

        // OpenAI 带 label，按 label 校验；TypeSafe 只有档位序号。
        let rank = match level.get("label").and_then(Value::as_str) {
            Some(label) => SEVERITY_LEVELS
                .iter()
                .position(|(key, _)| *key == label)
                .ok_or_else(|| {
                    format!(
                        "The {provider_name} decision model returned an unknown severity level '{label}'"
                    )
                })?,
            None => level
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
                .filter(|index| *index < SEVERITY_LEVELS.len())
                .ok_or_else(|| {
                    format!(
                        "The {provider_name} decision model returned a severity level outside the preset scale"
                    )
                })?,
        };

        probabilities[rank] = probability;
        let replace = match best {
            None => true,
            Some((best_rank, best_probability)) => {
                probability > best_probability
                    || (probability == best_probability && rank > best_rank)
            }
        };
        if replace {
            best = Some((rank, probability));
        }
    }

    let (rank, _) = best.ok_or_else(|| {
        format!("The {provider_name} decision model returned no severity level probabilities")
    })?;

    let top = (SEVERITY_LEVELS.len() - 1) as f64;
    // 优先用模型返回的 score；缺失时按档位概率加权补算，同样只作展示。
    let score = answer
        .get("score")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or_else(|| {
            let total: f64 = probabilities.iter().sum();
            if total > 0.0 {
                probabilities
                    .iter()
                    .enumerate()
                    .map(|(index, probability)| index as f64 * probability)
                    .sum::<f64>()
                    / total
            } else {
                rank as f64
            }
        })
        .clamp(0.0, top);

    Ok((SEVERITY_LEVELS[rank].0.to_string(), score))
}

/// 记录一次敏感命令判定（best effort）；不写命令原文，避免把敏感参数落进日志。
/// 等级解析失败时升为 WARN 并附原因，便于排查不支持 score 的端点。
async fn log_command_decision(config: &DecisionModelConfig, decision: &CommandDecision) {
    if crate::api::ephemeral::is_active() {
        return;
    }

    let input = crate::storage::services::app_logs::AppLogInput {
        level: if decision.severity_error.is_some() {
            "WARN"
        } else {
            "INFO"
        }
        .to_string(),
        module: "decision_model".to_string(),
        func: "evaluate_command".to_string(),
        line: None,
        message: if decision.severity_error.is_some() {
            "Sensitive command decision without a usable severity level"
        } else {
            "Sensitive command decision"
        }
        .to_string(),
        input: None,
        output: None,
        duration: None,
        context: Some(
            json!({
                "provider": config.provider.as_str(),
                "model": config.model,
                "allow": decision.allow,
                "reason": decision.reason,
                "confidence": decision.confidence,
                "severity": decision.severity,
                "severityScore": decision.severity_score,
                "contextMessages": decision.context.map(|usage| usage.messages),
                "contextTruncated": decision.context.map(|usage| usage.truncated),
                "contextEmpty": decision.context.map(|usage| usage.empty),
            })
            .to_string(),
        ),
        error: decision.severity_error.clone(),
        source: "main".to_string(),
    };

    tokio::task::spawn_blocking(move || {
        if let Ok(database_path) = crate::storage::ensure_database_file() {
            let _ = crate::storage::services::app_logs::insert_app_log(&database_path, &input);
        }
    })
    .await
    .ok();
}

/// 发送一次判定请求，并把两种 provider 的响应折叠后交给 `interpret`。
///
/// 传输失败、HTTP 状态、响应格式错误与 `interpret` 拒绝的答案都写入返回的报告
/// （同时进系统日志，module = `decision_model`），调用方据此决定回退。
async fn evaluate_state<T, I>(
    config: &DecisionModelConfig,
    usage_scope: Option<&DecisionUsageScope>,
    func: &str,
    state: &Value,
    questions: &Value,
    interpret: I,
) -> ModelCallReport<T>
where
    I: FnOnce(Value) -> std::result::Result<T, String>,
{
    let body = build_request_body(config, state, questions);
    send_request(
        config,
        usage_scope,
        func,
        body,
        RequestOptions {
            with_images: false,
            allow_refusal: false,
        },
        interpret,
    )
    .await
}

/// 单次请求的传输选项。
#[derive(Clone, Copy)]
struct RequestOptions {
    /// 请求体含图片：TypeSafe 需带图片能力头，超时放宽。
    with_images: bool,
    /// refusal 答案折叠为 `{ refusal: true }` 而不是让整次请求失败。
    allow_refusal: bool,
}

/// 一次请求的响应值 + 从响应解析出的 token 用量。
struct DecisionResponse<T> {
    value: T,
    usage: Option<DecisionTokenUsage>,
}

/// 解析 Decisions API 的 `usage`；Jev 不返回 usage，返回 None。
///
/// `cached_tokens` / `cache_write_tokens` 都包含在 `input_tokens` 内，
/// 只作为缓存维度记录，不重复累加。
fn parse_token_usage(parsed: &Value) -> Option<DecisionTokenUsage> {
    let usage = parsed.get("usage")?;
    // input_tokens 缺失视为没有 usage 数据，不写 0 值记录。
    let input_tokens = usage.get("input_tokens").and_then(Value::as_i64)?;
    let details = usage.get("input_tokens_details");
    let detail = |key: &str| {
        details
            .and_then(|details| details.get(key))
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0)
    };

    Some(DecisionTokenUsage {
        input_tokens: input_tokens.max(0),
        cache_creation_input_tokens: detail("cache_write_tokens"),
        cache_read_input_tokens: detail("cached_tokens"),
    })
}

/// 发送已构建好的请求体，响应折叠后交给 `interpret`。
async fn send_request<T, I>(
    config: &DecisionModelConfig,
    usage_scope: Option<&DecisionUsageScope>,
    func: &str,
    body: Value,
    options: RequestOptions,
    interpret: I,
) -> ModelCallReport<T>
where
    I: FnOnce(Value) -> std::result::Result<T, String>,
{
    let endpoint = config.endpoint();
    let endpoint_ref = endpoint.as_str();
    let provider = config.provider;
    let timeout = Duration::from_secs(if options.with_images {
        IMAGE_REQUEST_TIMEOUT_SECS
    } else {
        REQUEST_TIMEOUT_SECS
    });

    let report = observe_call(
        ModelKind::Decision,
        func,
        endpoint_ref,
        &config.model,
        async move {
            let (status, text) = post_json(
                ModelKind::Decision,
                endpoint_ref,
                build_headers(&config.api_key, provider, options.with_images),
                &body,
                timeout,
            )
            .await
            .map_err(|error| {
                ModelRequestError::new(
                    error.http_status,
                    format!("{} (provider: {})", error.message, provider.as_str()),
                )
            })?;

            let parsed: Value = serde_json::from_str(&text).map_err(|error| {
                ModelRequestError::new(
                    Some(status),
                    format!(
                        "Failed to parse the {} decision model response: {error}",
                        provider.as_str()
                    ),
                )
            })?;
            let usage = parse_token_usage(&parsed);

            let answers = normalize_answers(provider, &parsed, options.allow_refusal)
                .map_err(|message| ModelRequestError::new(Some(status), message))?;
            let normalized = json!({ "answers": answers });

            let value = interpret(normalized)
                .map_err(|message| ModelRequestError::new(Some(status), message))?;
            Ok((DecisionResponse { value, usage }, status))
        },
    )
    .await;

    let ModelCallReport {
        result,
        http_status,
        latency_ms,
    } = report;

    if let Some(scope) = usage_scope {
        // Ok(None)：成功但响应没有 usage（Jev），不写 0 值记录，避免污染统计。
        match result.as_ref().ok().map(|response| response.usage) {
            Some(Some(usage)) => {
                record_decision_usage(scope, config, usage, "completed").await;
            }
            Some(None) => {}
            // 失败也记一条，token 记 0。
            None => {
                record_decision_usage(scope, config, DecisionTokenUsage::default(), "error").await;
            }
        }
    }

    ModelCallReport {
        result: result.map(|response| response.value),
        http_status,
        latency_ms,
    }
}

/// 写一条决策模型用量记录（best effort，失败只打日志）。
async fn record_decision_usage(
    scope: &DecisionUsageScope,
    config: &DecisionModelConfig,
    usage: DecisionTokenUsage,
    status: &'static str,
) {
    crate::api::usage::record_decision_usage(crate::api::usage::DecisionUsageInput {
        model: &config.model,
        model_name: &scope.model_name,
        conversation_id: &scope.conversation_id,
        directory_id: &scope.directory_id,
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        status,
    })
    .await;
}

/// 连接自检：发一条最小请求，响应必须带答案。
///
/// typesafe 要求 `answers` 是对象；openai 要求 `answers` 是非空数组。
pub async fn test_connection(config: &DecisionModelConfig) -> ModelCallReport<()> {
    let state = json!({ "purpose": "Snow App connection test" });
    let questions = json!({
        "probe": {
            "type": "choice",
            "instructions": "Is this request a connection test?",
            "criteria": {
                "yes": "The state says it is a connection test",
                "no": "The state describes something else"
            }
        },
    });
    let provider = config.provider;

    evaluate_state(
        config,
        None,
        CONNECTION_TEST_FUNC,
        &state,
        &questions,
        move |parsed| {
            let answers = parsed.get("answers").and_then(Value::as_object);
            match provider {
                DecisionProvider::Typesafe => {
                    if answers.is_some() {
                        Ok(())
                    } else {
                        Err(format!(
                            "The {} decision model response is missing the 'answers' object",
                            provider.as_str()
                        ))
                    }
                }
                DecisionProvider::Openai => {
                    if answers.map(|map| !map.is_empty()).unwrap_or(false) {
                        Ok(())
                    } else {
                        Err(format!(
                            "The {} decision model returned no answers",
                            provider.as_str()
                        ))
                    }
                }
            }
        },
    )
    .await
}

/// 图片证据的编码格式：PNG / JPEG 是两个 provider 的公共子集。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceImageFormat {
    Png,
    Jpeg,
}

impl EvidenceImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            EvidenceImageFormat::Png => "image/png",
            EvidenceImageFormat::Jpeg => "image/jpeg",
        }
    }

    /// TypeSafe assets 的 `format` 字段取值。
    fn typesafe_name(self) -> &'static str {
        match self {
            EvidenceImageFormat::Png => "png",
            EvidenceImageFormat::Jpeg => "jpg",
        }
    }
}

/// 已读取并编码好的一张图片证据。
#[derive(Debug, Clone)]
pub struct EvidenceImage {
    /// 去重键（内容哈希）：同一张图在一次请求中只上传一次。
    pub key: String,
    /// 展示标签（文件名），写进证据说明供问题引用。
    pub label: String,
    pub format: EvidenceImageFormat,
    pub data_base64: String,
}

impl EvidenceImage {
    fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.format.mime(), self.data_base64)
    }
}

/// 共享证据：所有问题都基于它判定。
#[derive(Debug, Clone, Default)]
pub struct EvidenceInput {
    pub text: Option<String>,
    pub json: Option<Value>,
    pub images: Vec<EvidenceImage>,
}

impl EvidenceInput {
    pub fn is_empty(&self) -> bool {
        self.text.is_none() && self.json.is_none() && self.images.is_empty()
    }
}

/// 自定义问题类型；choice / score 的选项按「值 / 描述」成对保存。
#[derive(Debug, Clone)]
pub enum CustomQuestionKind {
    Predicate {
        when_true: Option<String>,
        when_false: Option<String>,
    },
    Choice {
        options: Vec<(String, Option<String>)>,
    },
    /// 档位低 -> 高。
    Score {
        levels: Vec<(String, Option<String>)>,
    },
}

#[derive(Debug, Clone)]
pub struct CustomQuestion {
    pub name: String,
    pub instructions: String,
    pub kind: CustomQuestionKind,
    /// 题级图片：只随该题发送（如每题一张候选图，与共享参考图对比）。
    pub images: Vec<EvidenceImage>,
}

/// 通用判定（`decision-evaluate` 工具入口），返回按问题 name 折叠的答案；
/// 单题 refusal 折叠为 `{ refusal: true }`，不影响其它题。
pub async fn evaluate_custom(
    config: &DecisionModelConfig,
    usage_scope: &DecisionUsageScope,
    evidence: &EvidenceInput,
    questions: &[CustomQuestion],
) -> Result<Map<String, Value>> {
    let with_images = !evidence.images.is_empty()
        || questions.iter().any(|question| !question.images.is_empty());
    let body = match config.provider {
        DecisionProvider::Typesafe => typesafe_custom_body(config, evidence, questions),
        DecisionProvider::Openai => openai_custom_body(config, evidence, questions),
    };
    let provider = config.provider;

    send_request(
        config,
        Some(usage_scope),
        "evaluate_custom",
        body,
        RequestOptions {
            with_images,
            allow_refusal: true,
        },
        move |parsed| {
            parsed
                .get("answers")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "The {} decision model returned no answers",
                        provider.as_str()
                    )
                })
        },
    )
    .await
    .into_result()
}

/// TypeSafe 资产登记：同一张图只登记一次，引用串每次请求随机生成（官方建议 UUID）。
#[derive(Default)]
struct TypesafeAssets {
    assets: Map<String, Value>,
    references: HashMap<String, String>,
}

impl TypesafeAssets {
    fn reference(&mut self, image: &EvidenceImage) -> String {
        if let Some(existing) = self.references.get(&image.key) {
            return existing.clone();
        }
        let reference = format!("image-{}", uuid::Uuid::new_v4().simple());
        self.assets.insert(
            reference.clone(),
            json!({
                "type": "image",
                "format": image.format.typesafe_name(),
                "data_base64": image.data_base64,
            }),
        );
        self.references
            .insert(image.key.clone(), reference.clone());
        reference
    }
}

/// score 档位在 Jev 只有有序描述（无 label），把 label 并入描述保留语义。
fn score_level_text(label: &str, description: Option<&str>) -> String {
    match description.map(str::trim).filter(|text| !text.is_empty()) {
        Some(description) => format!("{label}: {description}"),
        None => label.to_string(),
    }
}

/// TypeSafe 请求体：共享图片写进 state.images，题级图片引用串追加到 instructions。
fn typesafe_custom_body(
    config: &DecisionModelConfig,
    evidence: &EvidenceInput,
    questions: &[CustomQuestion],
) -> Value {
    let mut assets = TypesafeAssets::default();

    let mut state = Map::new();
    if let Some(text) = &evidence.text {
        state.insert("text".to_string(), json!(text));
    }
    if let Some(data) = &evidence.json {
        state.insert("data".to_string(), data.clone());
    }
    if !evidence.images.is_empty() {
        let images: Vec<Value> = evidence
            .images
            .iter()
            .map(|image| json!({ "label": image.label, "image": assets.reference(image) }))
            .collect();
        state.insert("images".to_string(), Value::Array(images));
    }

    let mut converted = Map::new();
    for question in questions {
        let mut instructions = question.instructions.clone();
        if !question.images.is_empty() {
            instructions.push_str("\n\nImages for this question:");
            for image in &question.images {
                let reference = assets.reference(image);
                instructions.push_str(&format!("\n- {}: {reference}", image.label));
            }
        }

        let value = match &question.kind {
            CustomQuestionKind::Predicate {
                when_true,
                when_false,
            } => {
                let mut object = json!({
                    "type": NOUL_QUESTION_TYPE,
                    "instructions": instructions,
                });
                if when_true.is_some() || when_false.is_some() {
                    object["criteria"] = json!({ "true": when_true, "false": when_false });
                }
                object
            }
            CustomQuestionKind::Choice { options } => json!({
                "type": CHOICE_QUESTION_TYPE,
                "instructions": instructions,
                "criteria": options
                    .iter()
                    .map(|(value, description)| {
                        (
                            value.clone(),
                            description.clone().map(Value::String).unwrap_or(Value::Null),
                        )
                    })
                    .collect::<Map<String, Value>>(),
            }),
            CustomQuestionKind::Score { levels } => json!({
                "type": SCORE_QUESTION_TYPE,
                "instructions": instructions,
                "criteria": levels
                    .iter()
                    .map(|(label, description)| {
                        Value::String(score_level_text(label, description.as_deref()))
                    })
                    .collect::<Vec<Value>>(),
            }),
        };
        converted.insert(question.name.clone(), value);
    }

    let state = if state.is_empty() {
        Value::String(String::new())
    } else {
        Value::Object(state)
    };
    let mut body = json!({
        "model": config.model,
        "state": state,
        "questions": converted,
    });
    if !assets.assets.is_empty() {
        body["assets"] = Value::Object(assets.assets);
    }
    body
}

/// OpenAI 的 `input` 只接受文本与 `input_text` / `input_image` 内容块：
/// 结构化数据（state、JSON 证据）一律按 pretty JSON 文本发送。
fn openai_input_text(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// OpenAI 请求体：共享证据进 input 的 user 消息，题级图片让 instructions 变成
/// `input_text` + `input_image` 数组（官方题级图片写法）。
fn openai_custom_body(
    config: &DecisionModelConfig,
    evidence: &EvidenceInput,
    questions: &[CustomQuestion],
) -> Value {
    let mut content: Vec<Value> = Vec::new();
    if let Some(text) = &evidence.text {
        content.push(json!({ "type": "input_text", "text": text }));
    }
    if let Some(data) = &evidence.json {
        content.push(json!({ "type": "input_text", "text": openai_input_text(data) }));
    }
    for (index, image) in evidence.images.iter().enumerate() {
        content.push(json!({
            "type": "input_text",
            "text": format!("Image {} ({})", index + 1, image.label),
        }));
        content.push(json!({ "type": "input_image", "image_url": image.data_url() }));
    }
    let input = if content.is_empty() {
        Value::String(String::new())
    } else {
        json!([{ "role": "user", "content": content }])
    };

    let questions: Vec<Value> = questions
        .iter()
        .map(|question| {
            let mut text = question.instructions.clone();
            // OpenAI predicate 没有 criteria 字段，判定标准并入说明。
            if let CustomQuestionKind::Predicate {
                when_true,
                when_false,
            } = &question.kind
            {
                if let Some(when_true) = when_true {
                    text.push_str(&format!("\nTrue when: {when_true}"));
                }
                if let Some(when_false) = when_false {
                    text.push_str(&format!("\nFalse when: {when_false}"));
                }
            }

            let instructions = if question.images.is_empty() {
                Value::String(text)
            } else {
                let mut parts = vec![json!({ "type": "input_text", "text": text })];
                for image in &question.images {
                    parts.push(json!({
                        "type": "input_text",
                        "text": format!("Image ({})", image.label),
                    }));
                    parts.push(json!({ "type": "input_image", "image_url": image.data_url() }));
                }
                Value::Array(parts)
            };

            match &question.kind {
                CustomQuestionKind::Predicate { .. } => json!({
                    "type": PREDICATE_QUESTION_TYPE,
                    "name": question.name,
                    "instructions": instructions,
                }),
                CustomQuestionKind::Choice { options } => json!({
                    "type": CHOICE_QUESTION_TYPE,
                    "name": question.name,
                    "instructions": instructions,
                    "choices": options
                        .iter()
                        .map(|(value, description)| labeled_entry("value", value, description))
                        .collect::<Vec<Value>>(),
                }),
                CustomQuestionKind::Score { levels } => json!({
                    "type": SCORE_QUESTION_TYPE,
                    "name": question.name,
                    "instructions": instructions,
                    "levels": levels
                        .iter()
                        .map(|(label, description)| labeled_entry("label", label, description))
                        .collect::<Vec<Value>>(),
                }),
            }
        })
        .collect();

    json!({
        "model": config.model,
        "input": input,
        "questions": questions,
    })
}

/// `{ <key>: value, description? }`：描述为空时省略字段。
fn labeled_entry(key: &str, value: &str, description: &Option<String>) -> Value {
    let mut entry = Map::new();
    entry.insert(key.to_string(), json!(value));
    if let Some(description) = description {
        entry.insert("description".to_string(), json!(description));
    }
    Value::Object(entry)
}

/// 按 provider 生成请求体。
///
/// 问题在内部统一保存为「id -> { type, instructions, criteria }」：TypeSafe 侧
/// 原样发送（predicate 改名为 noul），openai 侧把 criteria 映射成 `choices`
/// （predicate 只带 type/name/instructions），state 作为 JSON 文本放进 `input` 的
/// input_text 内容块（OpenAI 的 input 不接受结构化 JSON 内容块）。
fn build_request_body(
    config: &DecisionModelConfig,
    state: &Value,
    questions: &Value,
) -> Value {
    match config.provider {
        DecisionProvider::Typesafe => json!({
            "state": state,
            "model": config.model,
            "questions": typesafe_questions(questions),
        }),
        DecisionProvider::Openai => json!({
            "model": config.model,
            "input": [{
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": openai_input_text(state),
                }],
            }],
            "questions": openai_questions(questions),
        }),
    }
}

/// TypeSafe（Jev）没有 predicate 这个名字，yes/no 概率问题叫 noul，字段一致。
/// score 的档位在 Jev 是有序的 `criteria` 描述数组（序号即档位，无 label）。
fn typesafe_questions(questions: &Value) -> Value {
    let Some(map) = questions.as_object() else {
        return Value::Object(Map::new());
    };

    let mut converted = Map::new();
    for (name, question) in map {
        let question_type = question.get("type").and_then(Value::as_str);
        if question_type == Some(SCORE_QUESTION_TYPE) {
            converted.insert(
                name.clone(),
                json!({
                    "type": SCORE_QUESTION_TYPE,
                    "instructions": question.get("instructions").cloned().unwrap_or(Value::Null),
                    "criteria": score_levels(question)
                        .iter()
                        .map(|level| level.get("description").cloned().unwrap_or(Value::Null))
                        .collect::<Vec<Value>>(),
                }),
            );
            continue;
        }

        let mut question = question.clone();
        if question_type == Some(PREDICATE_QUESTION_TYPE) {
            if let Some(object) = question.as_object_mut() {
                object.insert("type".to_string(), json!(NOUL_QUESTION_TYPE));
            }
        }
        converted.insert(name.clone(), question);
    }
    Value::Object(converted)
}

/// 内部 score 问题的档位列表（`{ label, description }`，低 -> 高）。
fn score_levels(question: &Value) -> Vec<Value> {
    question
        .get("levels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// 把内部的问题对象转换为 OpenAI Decisions 的 questions 数组。
fn openai_questions(questions: &Value) -> Value {
    let Some(map) = questions.as_object() else {
        return Value::Array(Vec::new());
    };

    Value::Array(
        map.iter()
            .map(|(name, question)| {
                let instructions = question
                    .get("instructions")
                    .cloned()
                    .unwrap_or(Value::Null);

                if question.get("type").and_then(Value::as_str) == Some(PREDICATE_QUESTION_TYPE) {
                    return json!({
                        "type": PREDICATE_QUESTION_TYPE,
                        "name": name,
                        "instructions": instructions,
                    });
                }

                if question.get("type").and_then(Value::as_str) == Some(SCORE_QUESTION_TYPE) {
                    return json!({
                        "type": SCORE_QUESTION_TYPE,
                        "name": name,
                        "instructions": instructions,
                        "levels": score_levels(question),
                    });
                }

                let choices = question
                    .get("criteria")
                    .and_then(Value::as_object)
                    .map(|criteria| {
                        criteria
                            .iter()
                            .map(|(value, description)| {
                                json!({ "value": value, "description": description })
                            })
                            .collect::<Vec<Value>>()
                    })
                    .unwrap_or_default();

                json!({
                    "type": CHOICE_QUESTION_TYPE,
                    "name": name,
                    "instructions": instructions,
                    "choices": choices,
                })
            })
            .collect(),
    )
}

/// 把两种响应折叠成 `name -> { choice, confidence, probability }`。
///
/// typesafe 的 answers 是对象（noul 概率在 `noul` 字段）；openai 的 answers 是
/// 数组，按 name 折叠（predicate 概率在 `probability` 字段）。refusal 答案默认按
/// 错误返回，绝不当作 allow；`allow_refusal` 时折叠为 `{ refusal: true }`。
fn normalize_answers(
    provider: DecisionProvider,
    parsed: &Value,
    allow_refusal: bool,
) -> std::result::Result<Map<String, Value>, String> {
    let answers = parsed.get("answers").ok_or_else(|| {
        format!(
            "The {} decision model response is missing the 'answers' field",
            provider.as_str()
        )
    })?;

    match provider {
        DecisionProvider::Typesafe => {
            let map = answers.as_object().ok_or_else(|| {
                format!(
                    "The {} decision model response is missing the 'answers' object",
                    provider.as_str()
                )
            })?;

            Ok(map
                .iter()
                .map(|(name, answer)| (name.clone(), normalize_answer(answer, provider)))
                .collect())
        }
        DecisionProvider::Openai => {
            let items = answers.as_array().ok_or_else(|| {
                format!(
                    "The {} decision model response is missing the 'answers' array",
                    provider.as_str()
                )
            })?;

            let mut normalized = Map::new();
            for item in items {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if name.is_empty() {
                    return Err(format!(
                        "The {} decision model returned an answer without a name",
                        provider.as_str()
                    ));
                }
                if item.get("type").and_then(Value::as_str) == Some("refusal") {
                    if allow_refusal {
                        normalized.insert(name.to_string(), json!({ "refusal": true }));
                        continue;
                    }
                    return Err(format!("Decision refused for {name}"));
                }
                normalized.insert(name.to_string(), normalize_answer(item, provider));
            }
            Ok(normalized)
        }
    }
}

/// 单条答案归一化：choice / confidence 原样保留，概率字段统一叫 probability。
/// score 答案额外带 `score` 与 `levels: [{ index, label, probability }]`；
/// choice 答案额外带 `probabilities: { <value>: p }`。
fn normalize_answer(answer: &Value, provider: DecisionProvider) -> Value {
    let probability = match provider {
        DecisionProvider::Typesafe => answer.get("noul").or_else(|| answer.get("probability")),
        DecisionProvider::Openai => answer.get("probability"),
    };

    // 个别兼容端点不回 type，带数值 score 的答案也按 score 处理。
    let is_score = match answer.get("type").and_then(Value::as_str) {
        Some(kind) => kind == SCORE_QUESTION_TYPE,
        None => answer.get("score").and_then(Value::as_f64).is_some(),
    };
    let (score, levels) = if is_score {
        (
            answer.get("score").cloned().unwrap_or(Value::Null),
            normalize_score_levels(answer),
        )
    } else {
        (Value::Null, Value::Null)
    };

    let is_choice = match answer.get("type").and_then(Value::as_str) {
        Some(kind) => kind == CHOICE_QUESTION_TYPE,
        None => answer.get("choice").is_some(),
    };
    let probabilities = if is_choice {
        normalize_choice_probabilities(answer)
    } else {
        Value::Null
    };

    json!({
        "choice": answer.get("choice").cloned().unwrap_or(Value::Null),
        "confidence": answer.get("confidence").cloned().unwrap_or(Value::Null),
        "probability": probability.cloned().unwrap_or(Value::Null),
        "score": score,
        "levels": levels,
        "probabilities": probabilities,
    })
}

/// choice 各选项概率：TypeSafe 是 `{value: p}` 对象，OpenAI 是 `[{ value, probability }]`。
fn normalize_choice_probabilities(answer: &Value) -> Value {
    match answer.get("probabilities") {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::Array(items)) => Value::Object(
            items
                .iter()
                .filter_map(|item| {
                    let key = match item.get("value")? {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    Some((key, item.get("probability").cloned().unwrap_or(Value::Null)))
                })
                .collect(),
        ),
        _ => Value::Null,
    }
}

/// score 的档位概率：TypeSafe 是 `{"0": p}` 对象（无 label），OpenAI 是
/// `[{ value, label, probability }]` 数组。序号无法解析时 index 为 null，交给调用方报错。
fn normalize_score_levels(answer: &Value) -> Value {
    let level_index = |value: Option<&Value>| -> Value {
        value
            .and_then(|value| {
                value.as_u64().or_else(|| {
                    value
                        .as_f64()
                        .filter(|number| *number >= 0.0 && number.fract() == 0.0)
                        .map(|number| number as u64)
                })
            })
            .map(Value::from)
            .unwrap_or(Value::Null)
    };

    match answer.get("probabilities") {
        Some(Value::Object(map)) => Value::Array(
            map.iter()
                .map(|(key, probability)| {
                    json!({
                        "index": key.trim().parse::<u64>().map(Value::from).unwrap_or(Value::Null),
                        "label": Value::Null,
                        "probability": probability,
                    })
                })
                .collect(),
        ),
        Some(Value::Array(items)) => Value::Array(
            items
                .iter()
                .map(|item| {
                    json!({
                        "index": level_index(item.get("value")),
                        "label": item.get("label").cloned().unwrap_or(Value::Null),
                        "probability": item.get("probability").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect(),
        ),
        _ => Value::Null,
    }
}

/// 构建 state 与进入问题列表的 `(结果下标, 问题 id)`；题数与字符按 provider 预算截止。
fn build_state(
    query: &str,
    results: &[SearchResult],
    limits: DecisionLimits,
) -> (Value, Vec<(usize, String)>) {
    let mut items: Vec<Value> = Vec::new();
    let mut asked: Vec<(usize, String)> = Vec::new();
    let mut used_chars = query.chars().count();

    for (index, result) in results.iter().enumerate() {
        if asked.len() >= limits.max_questions {
            break;
        }

        let excerpt: String = result.content.chars().take(MAX_EXCERPT_CHARS).collect();
        // 路径、行号、id 与 JSON 键也占预算，用一个常量近似。
        let cost = excerpt.chars().count() + result.relative_path.chars().count() + 96;
        if used_chars + cost > limits.max_state_chars {
            break;
        }
        used_chars += cost;

        let id = format!("result_{}", index + 1);
        items.push(json!({
            "id": id,
            "file": result.relative_path,
            "lines": format!("{}-{}", result.start_line, result.end_line),
            "excerpt": excerpt,
        }));
        asked.push((index, id));
    }

    (json!({ "query": query, "results": items }), asked)
}

fn resolve_systemone_endpoint(base_url: &str, base_url_mode: &str) -> String {
    let normalized = normalize_base_url(base_url);

    if base_url_mode == CUSTOM_BASE_URL_MODE {
        return normalized;
    }

    if normalized.is_empty() {
        return format!("{DEFAULT_TYPESAFE_BASE_URL}/systemone");
    }

    if normalized.ends_with("/systemone") {
        return normalized;
    }

    if normalized.ends_with("/v1") {
        return format!("{normalized}/systemone");
    }

    format!("{normalized}/v1/systemone")
}

/// OpenAI Decisions 端点：尊重用户已填的完整地址，只补齐缺失的 /decisions。
fn resolve_decisions_endpoint(base_url: &str) -> String {
    let normalized = normalize_base_url(base_url);

    if normalized.is_empty() {
        return format!("{DEFAULT_OPENAI_BASE_URL}/decisions");
    }

    if normalized.ends_with("/decisions") {
        return normalized;
    }

    if normalized.ends_with("/v1") {
        return format!("{normalized}/decisions");
    }

    format!("{normalized}/v1/decisions")
}

fn build_headers(api_key: &str, provider: DecisionProvider, with_images: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert("Accept", HeaderValue::from_static("application/json"));

    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
        headers.insert("Authorization", value);
    }

    // Jev 的图片能力默认关闭，请求含图片时必须显式开启。
    if with_images && provider == DecisionProvider::Typesafe {
        headers.insert(TYPESAFE_IMAGES_HEADER, HeaderValue::from_static("true"));
    }

    headers
}
