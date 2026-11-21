//! 公共模型规格数据源（llm-specs）：整库分页拉取一次后在进程内缓存，按模型 id 本地匹配。
//!
//! 渠道的 `/models` 不返回上下文窗口时用它补齐：模型清单动辄上百个模型，逐个查询会
//! 打出大量请求，整库只有几千条且只取三个字段，一次加载后本地匹配更省也更稳定。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures::future::join_all;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::models::{positive_integer, Model, ModelLimits};

const MODELS_URL: &str = "https://api-llm-specs.axium-lab.com/v1/models";
const PAGE_SIZE: usize = 500;
/// 数据集条目数的安全上限，防止异常的 total 触发过量分页请求。
const MAX_ENTRIES: usize = 50_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CATALOG_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// 加载失败后的冷却期：期间不再重复请求，避免每次打开模型菜单都撞一次网络超时。
const FAILURE_COOLDOWN: Duration = Duration::from_secs(60);
/// 补齐模型清单时最多等待的时长；超时后加载在后台继续，下次直接命中缓存。
const ENRICH_WAIT: Duration = Duration::from_secs(4);

struct SpecEntry {
    id: String,
    limits: ModelLimits,
}

struct SpecCatalog {
    entries: Vec<SpecEntry>,
    /// 小写完整 id -> 条目下标。
    by_id: HashMap<String, usize>,
    /// 规范化后的模型主体名 -> 条目下标（保持数据集顺序）。
    by_base: HashMap<String, Vec<usize>>,
}

#[derive(Default)]
struct CatalogState {
    catalog: Option<(Instant, Arc<SpecCatalog>)>,
    last_failure: Option<Instant>,
}

fn state() -> &'static Mutex<CatalogState> {
    static STATE: OnceLock<Mutex<CatalogState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CatalogState::default()))
}

/// 去掉 `[1M]` 之类的名称标记，统一小写。
fn strip_model_marker(value: &str) -> String {
    let lowered = value.trim().to_ascii_lowercase();
    match lowered.find('[') {
        Some(index) => lowered[..index].trim().to_string(),
        None => lowered,
    }
}

/// 规范化模型 id：去掉渠道前缀、名称标记与大小写差异，只保留可比较的主体。
pub(crate) fn normalize_model_id(value: &str) -> String {
    let lowered = strip_model_marker(value);
    let base = lowered.rsplit('/').next().unwrap_or(lowered.as_str());
    base.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .collect()
}

/// 两个规范化 id 是否只差一个日期 / 快照后缀（如 `-20250929`、`-2024-08-06`）。
fn differs_by_date_suffix(target: &str, candidate: &str) -> bool {
    [(target, candidate), (candidate, target)]
        .into_iter()
        .any(|(short, long)| {
            let Some(rest) = long.strip_prefix(short) else {
                return false;
            };
            let Some(suffix) = rest.strip_prefix(['-', '_', '@']) else {
                return false;
            };
            suffix.chars().all(|ch| ch.is_ascii_digit() || ch == '-')
                && suffix.chars().filter(char::is_ascii_digit).count() >= 4
        })
}

impl SpecCatalog {
    fn new(entries: Vec<SpecEntry>) -> Self {
        let mut by_id = HashMap::with_capacity(entries.len());
        let mut by_base: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, entry) in entries.iter().enumerate() {
            by_id.entry(entry.id.to_ascii_lowercase()).or_insert(index);
            by_base
                .entry(normalize_model_id(&entry.id))
                .or_default()
                .push(index);
        }
        Self {
            entries,
            by_id,
            by_base,
        }
    }

    /// 同名候选里优先取不带渠道前缀的官方条目（如 `claude-haiku-5-5`），其次按数据集顺序。
    fn preferred(&self, indices: &[usize]) -> Option<ModelLimits> {
        let index = indices
            .iter()
            .copied()
            .find(|index| !self.entries[*index].id.contains('/'))
            .or_else(|| indices.first().copied())?;
        Some(self.entries[index].limits.clone())
    }

    fn find(&self, model_id: &str) -> Option<ModelLimits> {
        let lowered = strip_model_marker(model_id);
        if lowered.is_empty() {
            return None;
        }
        if let Some(index) = self.by_id.get(&lowered) {
            return Some(self.entries[*index].limits.clone());
        }
        let base = lowered.rsplit('/').next().unwrap_or(lowered.as_str());
        if let Some(index) = self.by_id.get(base) {
            return Some(self.entries[*index].limits.clone());
        }
        let normalized = normalize_model_id(&lowered);
        if let Some(indices) = self.by_base.get(&normalized) {
            return self.preferred(indices);
        }
        let mut related: Vec<usize> = self
            .by_base
            .iter()
            .filter(|(key, _)| differs_by_date_suffix(&normalized, key))
            .flat_map(|(_, indices)| indices.iter().copied())
            .collect();
        related.sort_unstable();
        self.preferred(&related)
    }
}

fn parse_page(data: &Value) -> Option<(usize, Vec<SpecEntry>)> {
    let total = usize::try_from(data.get("total").and_then(Value::as_u64)?).ok()?;
    let items = data.get("data").and_then(Value::as_array)?;
    let entries = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }
            let limits = ModelLimits {
                context_length: positive_integer(item.get("max_input_tokens")),
                max_output_tokens: positive_integer(item.get("max_output_tokens")),
            };
            (!limits.is_empty()).then(|| SpecEntry {
                id: id.to_string(),
                limits,
            })
        })
        .collect();
    Some((total, entries))
}

async fn fetch_page(client: &reqwest::Client, offset: usize) -> Option<(usize, Vec<SpecEntry>)> {
    let url = format!(
        "{MODELS_URL}?limit={PAGE_SIZE}&offset={offset}&fields=id,max_input_tokens,max_output_tokens"
    );
    let response = client.get(&url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().await.ok()?;
    let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    parse_page(&data)
}

async fn load_catalog() -> Option<SpecCatalog> {
    let client = snow_net::http_client::build_proxied_client_with_timeout(REQUEST_TIMEOUT)
        .await
        .ok()?;
    let (total, mut entries) = fetch_page(&client, 0).await?;
    let total = total.min(MAX_ENTRIES);
    let offsets: Vec<usize> = (PAGE_SIZE..total).step_by(PAGE_SIZE).collect();
    let pages = join_all(offsets.iter().map(|offset| fetch_page(&client, *offset))).await;
    // 任一分页失败都视为加载失败：残缺的数据集会被缓存数小时，宁可稍后重试。
    for page in pages {
        let (_, page_entries) = page?;
        entries.extend(page_entries);
    }
    Some(SpecCatalog::new(entries))
}

async fn catalog() -> Option<Arc<SpecCatalog>> {
    let mut state = state().lock().await;
    if let Some((loaded_at, catalog)) = &state.catalog {
        if loaded_at.elapsed() < CATALOG_TTL {
            return Some(catalog.clone());
        }
    }
    let stale = state.catalog.as_ref().map(|(_, catalog)| catalog.clone());
    if state
        .last_failure
        .is_some_and(|failed_at| failed_at.elapsed() < FAILURE_COOLDOWN)
    {
        return stale;
    }
    match load_catalog().await {
        Some(catalog) => {
            let catalog = Arc::new(catalog);
            state.catalog = Some((Instant::now(), catalog.clone()));
            state.last_failure = None;
            Some(catalog)
        }
        None => {
            state.last_failure = Some(Instant::now());
            stale
        }
    }
}

/// 查询单个模型的上下文 / 输出上限；数据集不可用或没有该模型时返回 None。
pub async fn lookup(model_id: &str) -> Option<ModelLimits> {
    if model_id.trim().is_empty() {
        return None;
    }
    catalog().await?.find(model_id)
}

/// 用公共规格数据补齐模型清单中缺失的上下文 / 输出上限（渠道返回的数值优先）。
pub async fn enrich_models_with_specs(models: &mut [Model]) {
    let needs_specs = |model: &Model| model.context_length.is_none() || model.max_output_tokens.is_none();
    if !models.iter().any(needs_specs) {
        return;
    }
    // 独立任务加载：等待超时只放弃本次补齐，加载本身继续并写入缓存。
    let loader = tokio::spawn(catalog());
    let Ok(Ok(Some(catalog))) = tokio::time::timeout(ENRICH_WAIT, loader).await else {
        return;
    };
    for model in models.iter_mut().filter(|model| needs_specs(model)) {
        if let Some(limits) = catalog.find(&model.id) {
            model.context_length = model.context_length.or(limits.context_length);
            model.max_output_tokens = model.max_output_tokens.or(limits.max_output_tokens);
        }
    }
}
