#![allow(non_snake_case)]

//! 内置浏览器访问历史：地址栏补全与设置页管理的数据源。
//!
//! 明文 JSON 落盘 `~/.snowapp/browser-history.json`（临时文件 + rename 原子
//! 替换），进程内缓存全量条目。所有文件 I/O 与检索排序都在
//! `tokio::task::spawn_blocking` 中执行，不阻塞 Node.js 事件循环。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use url::Url;

const HISTORY_FILE_NAME: &str = "browser-history.json";
/// 文件版本：不匹配时按空历史重建，避免旧结构解析出错。
const HISTORY_VERSION: u32 = 1;
/// 条目上限：超出后按最后访问时间淘汰最旧条目。
const MAX_ENTRIES: usize = 3000;
/// 单次检索 / 列表返回上限。
const MAX_PAGE_SIZE: u32 = 500;

#[derive(Serialize, Deserialize, Clone)]
struct StoredEntry {
    id: String,
    url: String,
    title: String,
    visit_count: u32,
    created_at: i64,
    last_visit_at: i64,
}

#[derive(Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    entries: Vec<StoredEntry>,
}

#[napi(object)]
#[allow(non_snake_case)]
pub struct BrowserHistoryEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub visitCount: u32,
    pub createdAt: f64,
    pub lastVisitAt: f64,
}

#[napi(object)]
#[allow(non_snake_case)]
pub struct BrowserHistoryPage {
    pub items: Vec<BrowserHistoryEntry>,
    /// 命中查询的全部条目数（分页前），空查询时为总条目数。
    pub total: u32,
}

static CACHE: Mutex<Option<Vec<StoredEntry>>> = Mutex::new(None);

fn history_file_path() -> Result<PathBuf> {
    Ok(crate::storage::paths::app_storage_dir()?.join(HISTORY_FILE_NAME))
}

fn read_entries_from_disk() -> Vec<StoredEntry> {
    let Ok(path) = history_file_path() else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        // 文件缺失：空历史，首次记录时自动创建。
        return Vec::new();
    };
    let Ok(file) = serde_json::from_str::<HistoryFile>(&text) else {
        return Vec::new();
    };
    if file.version != HISTORY_VERSION {
        return Vec::new();
    }
    file.entries
}

/// 缓存读写入口：首次访问时从磁盘加载，闭包内直接操作缓存条目。
fn with_cache<T>(run: impl FnOnce(&mut Vec<StoredEntry>) -> T) -> T {
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if cache.is_none() {
        *cache = Some(read_entries_from_disk());
    }
    let entries = cache.as_mut().expect("browser history cache initialized");
    run(entries)
}

fn persist_entries(entries: &[StoredEntry]) -> Result<()> {
    let path = history_file_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create browser history directory: {error}"),
            )
        })?;
    }
    let payload = serde_json::to_vec_pretty(&HistoryFile {
        version: HISTORY_VERSION,
        entries: entries.to_vec(),
    })
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize browser history: {error}"),
        )
    })?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &payload).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write browser history: {error}"),
        )
    })?;
    fs::rename(&tmp, &path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to replace browser history file: {error}"),
        )
    })
}

/// 仅接受 http(s) URL，其余（about: / file: / devtools: 等）不入历史。
fn normalize_url(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.to_string())
}

fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_lowercase()))
        .unwrap_or_default()
}

/// 超出上限时按最后访问时间淘汰最旧条目。
fn prune(entries: &mut Vec<StoredEntry>) {
    if entries.len() <= MAX_ENTRIES {
        return;
    }
    entries.sort_by(|left, right| right.last_visit_at.cmp(&left.last_visit_at));
    entries.truncate(MAX_ENTRIES);
}

/// 查询分词后逐词匹配（URL 主机 / URL / 标题），全部命中才算匹配；
/// 分值按命中位置加权：主机前缀 > 主机包含 > URL 包含 > 标题前缀 > 标题包含。
fn match_score(entry: &StoredEntry, tokens: &[String]) -> Option<i64> {
    let url_lower = entry.url.to_lowercase();
    let title_lower = entry.title.to_lowercase();
    let host = host_of(&entry.url);
    let mut total = 0i64;
    for token in tokens {
        let mut score = 0i64;
        if host.starts_with(token.as_str()) {
            score = 100;
        } else if host.contains(token.as_str()) {
            score = 75;
        }
        if url_lower.contains(token.as_str()) {
            score = score.max(50);
        }
        if title_lower.starts_with(token.as_str()) {
            score = score.max(45);
        } else if title_lower.contains(token.as_str()) {
            score = score.max(30);
        }
        if score == 0 {
            return None;
        }
        total += score;
    }
    Some(total)
}

fn to_api_entry(entry: &StoredEntry) -> BrowserHistoryEntry {
    BrowserHistoryEntry {
        id: entry.id.clone(),
        url: entry.url.clone(),
        title: entry.title.clone(),
        visitCount: entry.visit_count,
        createdAt: entry.created_at as f64,
        lastVisitAt: entry.last_visit_at as f64,
    }
}

/// 记录一次访问：同 URL 累加次数并刷新时间；标题非空时覆盖旧标题。
#[napi]
pub async fn browser_history_record(url: String, title: String) -> Result<bool> {
    tokio::task::spawn_blocking(move || -> Result<bool> {
        let Some(normalized) = normalize_url(&url) else {
            return Ok(false);
        };
        let title = title.trim().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        with_cache(|entries| {
            match entries.iter_mut().find(|entry| entry.url == normalized) {
                Some(existing) => {
                    existing.visit_count = existing.visit_count.saturating_add(1);
                    existing.last_visit_at = now;
                    if !title.is_empty() {
                        existing.title = title;
                    }
                }
                None => entries.push(StoredEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    url: normalized,
                    title,
                    visit_count: 1,
                    created_at: now,
                    last_visit_at: now,
                }),
            }
            prune(entries);
            persist_entries(entries)?;
            Ok(true)
        })
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute browser_history_record: {error}"),
        )
    })?
}

/// 页面标题迟到更新：只改标题，不计入访问次数。
#[napi]
pub async fn browser_history_update_title(url: String, title: String) -> Result<bool> {
    tokio::task::spawn_blocking(move || -> Result<bool> {
        let Some(normalized) = normalize_url(&url) else {
            return Ok(false);
        };
        let title = title.trim().to_string();
        if title.is_empty() {
            return Ok(false);
        }
        with_cache(|entries| {
            let Some(existing) = entries.iter_mut().find(|entry| entry.url == normalized) else {
                return Ok(false);
            };
            if existing.title == title {
                return Ok(false);
            }
            existing.title = title;
            persist_entries(entries)?;
            Ok(true)
        })
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute browser_history_update_title: {error}"),
        )
    })?
}

/// 地址栏补全检索：按匹配度 + 访问次数 + 最近访问排序，返回前 limit 条。
#[napi]
pub async fn browser_history_search(query: String, limit: u32) -> Result<Vec<BrowserHistoryEntry>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<BrowserHistoryEntry>> {
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|token| token.to_lowercase())
            .collect();
        let limit = limit.clamp(1, MAX_PAGE_SIZE) as usize;
        with_cache(|entries| {
            let mut matched: Vec<(i64, &StoredEntry)> = entries
                .iter()
                .filter_map(|entry| {
                    if tokens.is_empty() {
                        Some((0i64, entry))
                    } else {
                        match_score(entry, &tokens).map(|score| (score, entry))
                    }
                })
                .collect();
            if tokens.is_empty() {
                matched.sort_by(|left, right| right.1.last_visit_at.cmp(&left.1.last_visit_at));
            } else {
                matched.sort_by(|left, right| {
                    right
                        .0
                        .cmp(&left.0)
                        .then(right.1.visit_count.cmp(&left.1.visit_count))
                        .then(right.1.last_visit_at.cmp(&left.1.last_visit_at))
                });
            }
            matched.truncate(limit);
            Ok(matched
                .into_iter()
                .map(|(_, entry)| to_api_entry(entry))
                .collect::<Vec<_>>())
        })
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute browser_history_search: {error}"),
        )
    })?
}

/// 设置页历史列表：支持查询过滤与分页，返回命中总数。
#[napi]
pub async fn browser_history_list(
    query: String,
    offset: u32,
    limit: u32,
) -> Result<BrowserHistoryPage> {
    tokio::task::spawn_blocking(move || -> Result<BrowserHistoryPage> {
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|token| token.to_lowercase())
            .collect();
        let limit = limit.clamp(1, MAX_PAGE_SIZE) as usize;
        let offset = offset as usize;
        with_cache(|entries| {
            let mut matched: Vec<(i64, &StoredEntry)> = entries
                .iter()
                .filter_map(|entry| {
                    if tokens.is_empty() {
                        Some((0i64, entry))
                    } else {
                        match_score(entry, &tokens).map(|score| (score, entry))
                    }
                })
                .collect();
            if tokens.is_empty() {
                matched.sort_by(|left, right| right.1.last_visit_at.cmp(&left.1.last_visit_at));
            } else {
                matched.sort_by(|left, right| {
                    right
                        .0
                        .cmp(&left.0)
                        .then(right.1.visit_count.cmp(&left.1.visit_count))
                        .then(right.1.last_visit_at.cmp(&left.1.last_visit_at))
                });
            }
            let total = matched.len() as u32;
            let items = matched
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|(_, entry)| to_api_entry(entry))
                .collect::<Vec<_>>();
            Ok(BrowserHistoryPage { items, total })
        })
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute browser_history_list: {error}"),
        )
    })?
}

/// 删除单条历史记录。
#[napi]
pub async fn browser_history_delete(id: String) -> Result<bool> {
    tokio::task::spawn_blocking(move || -> Result<bool> {
        with_cache(|entries| {
            let before = entries.len();
            entries.retain(|entry| entry.id != id);
            if entries.len() == before {
                return Ok(false);
            }
            persist_entries(entries)?;
            Ok(true)
        })
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute browser_history_delete: {error}"),
        )
    })?
}

/// 清空全部历史记录，返回删除数量。
#[napi]
pub async fn browser_history_clear() -> Result<u32> {
    tokio::task::spawn_blocking(move || -> Result<u32> {
        with_cache(|entries| {
            let removed = entries.len() as u32;
            entries.clear();
            persist_entries(entries)?;
            Ok(removed)
        })
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute browser_history_clear: {error}"),
        )
    })?
}
