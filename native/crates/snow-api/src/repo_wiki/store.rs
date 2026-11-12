//! Wiki 存储：~/.snowapp/repo-wiki/<路径哈希>/{wiki.json, fingerprint.json, meta.json}。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use crate::mcp::servers::remote_workspace::is_ssh_path;

pub(crate) const WIKI_VERSION: u32 = 1;
/// 目录页数上限。
pub(crate) const MAX_PAGES: usize = 40;
/// 单页关键文件上限。
pub(crate) const MAX_FILES_PER_PAGE: usize = 16;
const WIKI_FILE: &str = "wiki.json";
const FINGERPRINT_FILE: &str = "fingerprint.json";
const META_FILE: &str = "meta.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct WikiSource {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct WikiPage {
    pub id: String,
    pub title: String,
    pub description: String,
    pub parent_id: Option<String>,
    pub files: Vec<String>,
    /// pending | generating | done | failed
    pub status: String,
    pub content: String,
    pub sources: Vec<WikiSource>,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RepoWiki {
    pub version: u32,
    pub project_path: String,
    pub project_name: String,
    pub title: String,
    pub summary: String,
    pub language: String,
    pub api_profile: String,
    pub model: String,
    pub diagrams: bool,
    pub retries: u32,
    pub auto_refresh: bool,
    /// running | completed | failed | stopped
    pub status: String,
    /// analyzing | catalog | pages | saving | done
    pub phase: String,
    pub error: Option<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub generated_at: Option<i64>,
    pub pages: Vec<WikiPage>,
}

impl RepoWiki {
    pub(crate) fn count(&self, status: &str) -> u32 {
        self.pages.iter().filter(|page| page.status == status).count() as u32
    }
}

/// 相对路径 -> "大小:修改时间"。
pub(crate) type Fingerprint = BTreeMap<String, String>;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct WikiMeta {
    done_pages: u32,
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn normalize_project_path(path: &str) -> String {
    crate::utils::paths::normalize_project_path(path)
}

/// 页面 id 规范化为 kebab-case（最长 64 字符）。
pub(crate) fn sanitize_page_id(raw: &str) -> String {
    let mut id = String::new();
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch);
        } else if !id.ends_with('-') && !id.is_empty() {
            id.push('-');
        }
    }
    id.trim_end_matches('-').chars().take(64).collect()
}

/// 导出为 zip（README.md + pages/*.md + wiki.json）。
pub(crate) fn export_archive(wiki: &RepoWiki, target_path: &Path) -> Result<u32> {
    use std::io::Write;

    let file = std::fs::File::create(target_path).map_err(|error| io_error("create", target_path, error))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let zip_error = |error: zip::result::ZipError| {
        Error::from_reason(format!("Failed to build the wiki archive: {error}"))
    };

    let mut readme = format!("# {}\n\n{}\n", wiki.title, wiki.summary);
    if let (Some(branch), Some(commit)) = (&wiki.branch, &wiki.commit) {
        readme.push_str(&format!(
            "\n- branch: `{branch}`\n- commit: `{}`\n",
            &commit[..commit.len().min(12)]
        ));
    }
    readme.push_str(&format!(
        "- language: {}\n- model: {}\n\n## Pages\n\n",
        wiki.language, wiki.model
    ));
    for page in wiki.pages.iter().filter(|page| !page.content.is_empty()) {
        readme.push_str(&format!("- [{}](pages/{}.md)\n", page.title, file_stem(page)));
    }
    writer.start_file("README.md", options).map_err(zip_error)?;
    writer
        .write_all(readme.as_bytes())
        .map_err(|error| io_error("write", target_path, error))?;

    let mut exported = 0u32;
    for page in wiki.pages.iter().filter(|page| !page.content.is_empty()) {
        let mut body = format!("# {}\n\n{}\n", page.title, page.content);
        if !page.sources.is_empty() {
            body.push_str("\n## Sources\n\n");
            for source in &page.sources {
                body.push_str(&format!(
                    "- `{}:{}-{}`\n",
                    source.path, source.start_line, source.end_line
                ));
            }
        }
        writer
            .start_file(format!("pages/{}.md", file_stem(page)), options)
            .map_err(zip_error)?;
        writer
            .write_all(body.as_bytes())
            .map_err(|error| io_error("write", target_path, error))?;
        exported += 1;
    }

    let json = serde_json::to_vec_pretty(wiki)
        .map_err(|error| Error::from_reason(format!("Failed to serialize wiki: {error}")))?;
    writer.start_file("wiki.json", options).map_err(zip_error)?;
    writer
        .write_all(&json)
        .map_err(|error| io_error("write", target_path, error))?;
    writer.finish().map_err(zip_error)?;
    Ok(exported)
}

fn file_stem(page: &WikiPage) -> String {
    let mut stem: String = page
        .id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' { ch } else { '-' })
        .collect();
    if stem.is_empty() {
        stem = "page".to_string();
    }
    stem
}

pub(crate) fn wiki_dir(project_path: &str) -> Result<PathBuf> {
    let key = normalize_project_path(project_path);
    let hash = blake3::hash(key.as_bytes()).to_hex();
    Ok(crate::storage::paths::app_storage_dir()?
        .join("repo-wiki")
        .join(&hash.as_str()[..16]))
}

pub(crate) fn wiki_file_path(project_path: &str) -> Result<PathBuf> {
    Ok(wiki_dir(project_path)?.join(WIKI_FILE))
}

fn io_error(action: &str, path: &Path, error: std::io::Error) -> Error {
    Error::from_reason(format!("Failed to {action} '{}': {error}", path.display()))
}

async fn write_atomic(path: &Path, bytes: Vec<u8>) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| io_error("create", parent, error))?;
    }
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, bytes)
        .await
        .map_err(|error| io_error("write", &tmp, error))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|error| io_error("rename", path, error))
}

async fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| Error::from_reason(format!("Invalid wiki file: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("read", path, error)),
    }
}

pub(crate) async fn load_wiki(project_path: &str) -> Result<Option<RepoWiki>> {
    read_json(&wiki_dir(project_path)?.join(WIKI_FILE)).await
}

pub(crate) async fn save_wiki(wiki: &RepoWiki) -> Result<()> {
    let dir = wiki_dir(&wiki.project_path)?;
    let bytes = serde_json::to_vec_pretty(wiki)
        .map_err(|error| Error::from_reason(format!("Failed to serialize wiki: {error}")))?;
    write_atomic(&dir.join(WIKI_FILE), bytes).await?;
    let meta = serde_json::to_vec(&WikiMeta {
        done_pages: wiki.count("done"),
    })
    .unwrap_or_default();
    write_atomic(&dir.join(META_FILE), meta).await
}

pub(crate) async fn delete_wiki(project_path: &str) -> Result<bool> {
    let dir = wiki_dir(project_path)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error("delete", &dir, error)),
    }
}

/// 有已完成页面时返回 wiki.json 路径（系统提示词注入用）。
pub(crate) async fn ready_wiki_path(project_path: &str) -> Option<PathBuf> {
    let dir = wiki_dir(project_path).ok()?;
    let meta: WikiMeta = read_json(&dir.join(META_FILE)).await.ok().flatten()?;
    (meta.done_pages > 0).then(|| dir.join(WIKI_FILE))
}

pub(crate) async fn load_fingerprint(project_path: &str) -> Fingerprint {
    let Ok(dir) = wiki_dir(project_path) else {
        return Fingerprint::new();
    };
    read_json(&dir.join(FINGERPRINT_FILE))
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

pub(crate) async fn save_fingerprint(project_path: &str, fingerprint: &Fingerprint) -> Result<()> {
    let dir = wiki_dir(project_path)?;
    let bytes = serde_json::to_vec(fingerprint).unwrap_or_default();
    write_atomic(&dir.join(FINGERPRINT_FILE), bytes).await
}

/// 扫描工作区文本文件（遵循 .gitignore 与跳过目录规则）生成指纹。
pub(crate) async fn scan_fingerprint(root: &str) -> Result<Fingerprint> {
    if is_ssh_path(root) {
        return super::remote::scan_fingerprint(root).await;
    }
    let root = root.to_string();
    tokio::task::spawn_blocking(move || {
        let root_path = Path::new(&root);
        let mut fingerprint = Fingerprint::new();
        for file in crate::storage::services::file_scanner::scan_project(root_path) {
            let Ok(metadata) = std::fs::metadata(&file.path) else {
                continue;
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            fingerprint.insert(file.relative_path, format!("{}:{modified}", metadata.len()));
        }
        fingerprint
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to scan workspace: {error}")))
}

/// 指纹差异（按新增 / 删除 / 修改分类）。
#[derive(Default)]
pub(crate) struct FingerprintDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<String>,
}

impl FingerprintDiff {
    pub(crate) fn changed(&self) -> Vec<String> {
        let mut all = self.modified.clone();
        all.extend(self.added.iter().cloned());
        all.extend(self.removed.iter().cloned());
        all
    }
}

pub(crate) fn diff_fingerprints(old: &Fingerprint, new: &Fingerprint) -> FingerprintDiff {
    let mut diff = FingerprintDiff::default();
    for (path, value) in new {
        match old.get(path) {
            None => diff.added.push(path.clone()),
            Some(previous) if previous != value => diff.modified.push(path.clone()),
            Some(_) => {}
        }
    }
    diff.removed = old
        .keys()
        .filter(|path| !new.contains_key(*path))
        .cloned()
        .collect();
    diff
}

/// 分支名与 HEAD 提交（非 git 仓库返回 None）。
pub(crate) async fn read_git_meta(root: &str) -> (Option<String>, Option<String>) {
    if is_ssh_path(root) {
        return super::remote::read_git_meta(root).await;
    }
    let root = root.to_string();
    tokio::task::spawn_blocking(move || {
        if !Path::new(&root).join(".git").exists() {
            return (None, None);
        }
        let run = |args: &[&str]| {
            crate::storage::services::git::run_git(&root, args)
                .ok()
                .map(|output| output.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        (
            run(&["rev-parse", "--abbrev-ref", "HEAD"]),
            run(&["rev-parse", "HEAD"]),
        )
    })
    .await
    .unwrap_or((None, None))
}
