//! Wiki agent 工具：只读浏览（filesystem-read / grep-search / grep-find）与页面就地编辑
//! （wiki-page-edit）。只读视图统一过滤依赖与构建目录、.gitignore 命中项、疑似密钥文件与符号链接。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::file_search_agent::AgentToolExecutor;
use crate::mcp::servers::filesystem::FilesystemService;
use crate::mcp::servers::grep::GrepService;
use crate::mcp::servers::remote_workspace::{is_ssh_path, is_windows_absolute_path};
use crate::mcp::service::McpService;
use crate::mcp::tools::McpTool;
use crate::storage::services::file_scanner::{BINARY_EXTENSIONS, IMAGE_EXTENSIONS, SKIP_DIRS};
use crate::storage::services::gitignore::GitignoreMatcher;

use super::remote::{remote_base_path, RemoteSnapshot};
use super::store::{sanitize_page_id, Fingerprint, WikiPage, MAX_FILES_PER_PAGE, MAX_PAGES};


const MAX_TOOL_OUTPUT_CHARS: usize = 16_000;
const MAX_DIR_ENTRIES: usize = 400;
const SENSITIVE_WORDS: &[&str] = &[
    "token",
    "secret",
    "credential",
    "password",
    "passwd",
    "private_key",
    "privatekey",
    "apikey",
    "api_key",
];
/// 名称含敏感词时仍可读的源码扩展名（如 tokenService.ts）。
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "go", "java", "kt", "kts",
    "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "vue", "svelte", "dart", "scala",
    "lua", "ex", "exs", "md", "mdx",
];
const ALWAYS_SENSITIVE_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "keystore", "jks"];

pub(crate) struct WikiReadView {
    root: String,
    source: ViewSource,
}

enum ViewSource {
    Local(GitignoreMatcher),
    /// SSH 工作区：快照已按 .gitignore 与跳过目录过滤；`base_path` 为远端根路径。
    Remote {
        snapshot: RemoteSnapshot,
        base_path: String,
    },
}

impl WikiReadView {
    pub(crate) async fn new(root: &str) -> Result<Self> {
        let root = super::store::normalize_project_path(root);
        if is_ssh_path(&root) {
            let snapshot = RemoteSnapshot::load(&root).await?;
            let base_path = remote_base_path(&root);
            return Ok(Self {
                root,
                source: ViewSource::Remote {
                    snapshot,
                    base_path,
                },
            });
        }
        let matcher_root = root.clone();
        let matcher = tokio::task::spawn_blocking(move || {
            GitignoreMatcher::from_project_root(Path::new(&matcher_root))
        })
        .await
        .unwrap_or_else(|_| GitignoreMatcher::from_root_content(None));
        Ok(Self {
            root,
            source: ViewSource::Local(matcher),
        })
    }

    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    /// 代码指纹：远程直接复用快照，避免再拉一次文件树。
    pub(crate) async fn fingerprint(&self) -> Result<Fingerprint> {
        match &self.source {
            ViewSource::Local(_) => super::store::scan_fingerprint(&self.root).await,
            ViewSource::Remote { snapshot, .. } => Ok(snapshot.fingerprint()),
        }
    }

    /// 绝对路径转为根内相对路径（不在根内返回 None）。
    pub(crate) fn relative(&self, path: &str) -> Option<String> {
        let normalized = path.trim().replace('\\', "/");
        let normalized = normalized.trim_start_matches("./");
        if normalized.is_empty() || normalized == "." {
            return Some(String::new());
        }
        if let ViewSource::Remote { base_path, .. } = &self.source {
            return remote_relative(&self.root, base_path, normalized);
        }
        let is_absolute = normalized.starts_with('/')
            || (normalized.len() >= 3 && normalized.as_bytes()[1] == b':');
        if !is_absolute {
            return Some(normalized.trim_end_matches('/').to_string());
        }
        let lower = normalized.to_lowercase();
        let root_lower = self.root.to_lowercase();
        if lower == root_lower {
            return Some(String::new());
        }
        if !lower.starts_with(&format!("{root_lower}/")) {
            return None;
        }
        normalized
            .get(self.root.len() + 1..)
            .map(|rest| rest.trim_end_matches('/').to_string())
    }

    /// 工具输出里的路径：绝对路径（含 ssh:// URI）直接转换，相对路径按搜索目录拼接。
    fn relative_from(&self, base_relative: &str, file: &str) -> Option<String> {
        let normalized = file.replace('\\', "/");
        if normalized.starts_with('/') || is_ssh_path(&normalized) || Path::new(file).is_absolute()
        {
            return self.relative(&normalized);
        }
        let joined = if base_relative.is_empty() {
            normalized
        } else {
            format!("{base_relative}/{}", normalized.trim_start_matches("./"))
        };
        self.relative(&joined)
    }

    fn absolute(&self, relative: &str) -> String {
        if relative.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{relative}", self.root)
        }
    }

    pub(crate) fn is_blocked(&self, relative: &str, is_dir: bool) -> bool {
        if relative.is_empty() {
            return false;
        }
        if relative.split('/').any(|part| part == ".." || SKIP_DIRS.contains(&part)) {
            return true;
        }
        let excluded = match &self.source {
            ViewSource::Local(matcher) => matcher.is_ignored(relative, is_dir),
            // 远程快照已过滤：不在快照里即不存在或被排除（目录判定兼容把单个文件
            // 当作检索范围的 grep-search / grep-find）
            ViewSource::Remote { snapshot, .. } => {
                if is_dir {
                    !snapshot.is_dir(relative) && !snapshot.is_file(relative)
                } else {
                    !snapshot.is_file(relative)
                }
            }
        };
        if excluded {
            return true;
        }
        !is_dir && is_sensitive_file(relative.rsplit('/').next().unwrap_or(relative))
    }
}

/// 远程路径（ssh:// URI、远端绝对路径或相对路径）转为根内相对路径；远端路径区分大小写。
fn remote_relative(root: &str, base_path: &str, path: &str) -> Option<String> {
    if is_ssh_path(path) {
        return strip_root(path, root);
    }
    if path.starts_with('/') {
        return strip_root(path, base_path);
    }
    if is_windows_absolute_path(path) {
        return None;
    }
    Some(path.trim_end_matches('/').to_string())
}

fn strip_root(path: &str, root: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    if path == root {
        return Some(String::new());
    }
    path.strip_prefix(root)?
        .strip_prefix('/')
        .map(str::to_string)
}

fn is_sensitive_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.starts_with(".env") || lower.starts_with("id_rsa") || lower.starts_with("id_ed25519")
    {
        return true;
    }
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    if ALWAYS_SENSITIVE_EXTENSIONS.contains(&extension) {
        return true;
    }
    SENSITIVE_WORDS.iter().any(|word| lower.contains(word))
        && !SOURCE_EXTENSIONS.contains(&extension)
}

fn is_binary_file(relative: &str) -> bool {
    let extension = relative
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default();
    IMAGE_EXTENSIONS.contains(&extension.as_str()) || BINARY_EXTENSIONS.contains(&extension.as_str())
}

fn truncate_output(output: &Value) -> String {
    let serialized = serde_json::to_string(output).unwrap_or_default();
    if serialized.chars().count() <= MAX_TOOL_OUTPUT_CHARS {
        return serialized;
    }
    let mut text: String = serialized.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
    text.push_str("...[truncated: narrow the range with startLine/endLine or a more specific query]");
    text
}

/// 目录列举结果（本地与远程同一结构）。
fn dir_listing(relative: &str, mut entries: Vec<String>, hidden: usize) -> Value {
    entries.sort();
    let truncated = entries.len() > MAX_DIR_ENTRIES;
    entries.truncate(MAX_DIR_ENTRIES);
    json!({
        "path": if relative.is_empty() { "." } else { relative },
        "entries": entries.join("\n"),
        "excludedEntries": hidden,
        "truncated": truncated,
    })
}

/// 页面局部编辑草稿：模型用 wiki-page-edit 就地打补丁，避免整章重写。
pub(crate) struct PageDraft {
    content: tokio::sync::Mutex<String>,
    edited: AtomicBool,
}

impl PageDraft {
    pub(crate) fn new(content: String) -> Self {
        Self {
            content: tokio::sync::Mutex::new(content),
            edited: AtomicBool::new(false),
        }
    }

    pub(crate) fn was_edited(&self) -> bool {
        self.edited.load(Ordering::SeqCst)
    }

    pub(crate) async fn content(&self) -> String {
        self.content.lock().await.clone()
    }

    /// 精确字符串替换：old 必须唯一命中（replaceAll 时替换全部）。
    async fn apply(
        &self,
        old: &str,
        new: &str,
        replace_all: bool,
    ) -> std::result::Result<(usize, usize), String> {
        if old.is_empty() {
            return Err("oldString is empty: pass the exact text to replace".to_string());
        }
        if old == new {
            return Err("oldString and newString are identical, nothing to change".to_string());
        }
        let mut content = self.content.lock().await;
        let count = content.matches(old).count();
        if count == 0 {
            return Err(
                "oldString not found: copy it verbatim from the current page (include enough surrounding context)"
                    .to_string(),
            );
        }
        if count > 1 && !replace_all {
            return Err(format!(
                "oldString matches {count} places: add surrounding context to make it unique, or set replaceAll=true"
            ));
        }
        let updated = if replace_all {
            content.replace(old, new)
        } else {
            content.replacen(old, new, 1)
        };
        *content = updated;
        self.edited.store(true, Ordering::SeqCst);
        let applied = if replace_all { count } else { 1 };
        Ok((applied, content.chars().count()))
    }
}

/// 局部编辑工具定义（仅在已有页面内容时提供给模型）。
pub(crate) fn page_edit_tool() -> McpTool {
    McpTool {
        server_id: "wiki".to_string(),
        name: "page-edit".to_string(),
        description: "Patch the CURRENT wiki page markdown in place. oldString must be copied verbatim from the current page and must match exactly; keep edits minimal and leave correct sections untouched.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "oldString": {
                    "type": "string",
                    "description": "Exact text from the current page markdown to replace (include enough surrounding context to be unique)."
                },
                "newString": {
                    "type": "string",
                    "description": "Replacement text for oldString."
                },
                "replaceAll": {
                    "type": "boolean",
                    "description": "Replace every occurrence. Default false: oldString must match exactly once."
                }
            },
            "required": ["oldString", "newString"]
        }),
    }
}

/// 目录调整工具定义（自动更新时用于增删改章节）。
pub(crate) fn catalog_edit_tool() -> McpTool {
    McpTool {
        server_id: "wiki".to_string(),
        name: "catalog-edit".to_string(),
        description: "Change the wiki CATALOG (table of contents): add a page for a new feature, remove a page whose feature no longer exists, or update a page's title/scope/key files. Page bodies are written automatically afterwards, so never provide content here.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["add", "remove", "update"],
                    "description": "Which catalog operation to apply."
                },
                "pageId": {
                    "type": "string",
                    "description": "Existing page id (required for remove/update; add generates the id from title)."
                },
                "title": {
                    "type": "string",
                    "description": "Page title (required for add)."
                },
                "description": {
                    "type": "string",
                    "description": "What the page must explain, 1-3 sentences (add/update)."
                },
                "parentId": {
                    "type": "string",
                    "description": "Id of an existing top-level page to nest under (max 2 levels). Empty string or null puts the page at the top level; omit to keep the current parent."
                },
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Key file paths, workspace-relative, that really exist (add/update replaces the list)."
                }
            },
            "required": ["action"]
        }),
    }
}

/// 目录草稿：模型用 wiki-catalog-edit 增删改章节，结束后整体替换 wiki.pages。
pub(crate) struct CatalogDraft {
    state: tokio::sync::Mutex<CatalogState>,
    edited: AtomicBool,
}

struct CatalogState {
    pages: Vec<WikiPage>,
    /// 结构被改动的页面 id（新增或元数据更新）。
    touched: Vec<String>,
}

impl CatalogDraft {
    pub(crate) fn new(pages: Vec<WikiPage>) -> Self {
        Self {
            state: tokio::sync::Mutex::new(CatalogState {
                pages,
                touched: Vec::new(),
            }),
            edited: AtomicBool::new(false),
        }
    }

    pub(crate) fn was_edited(&self) -> bool {
        self.edited.load(Ordering::SeqCst)
    }

    pub(crate) async fn take(&self) -> (Vec<WikiPage>, Vec<String>) {
        let mut state = self.state.lock().await;
        (
            std::mem::take(&mut state.pages),
            std::mem::take(&mut state.touched),
        )
    }

    async fn add(
        &self,
        title: Option<String>,
        description: Option<String>,
        parent: Option<Option<String>>,
        files: Option<Vec<String>>,
    ) -> std::result::Result<Value, String> {
        let mut state = self.state.lock().await;
        if state.pages.len() >= MAX_PAGES {
            return Err(format!(
                "the catalog already has {MAX_PAGES} pages: update or remove an existing page instead of adding"
            ));
        }
        let title = title.unwrap_or_default();
        if title.trim().is_empty() {
            return Err("title is required when action=add".to_string());
        }
        let mut id = sanitize_page_id(&title);
        if id.is_empty() {
            id = format!("page-{}", state.pages.len() + 1);
        }
        let base = id.clone();
        let mut suffix = 2;
        while state.pages.iter().any(|page| page.id == id) {
            id = format!("{base}-{suffix}");
            suffix += 1;
        }
        let requested_parent = parent.flatten();
        let parent_id = resolve_parent(&state.pages, requested_parent.as_deref(), None)?;
        state.pages.push(WikiPage {
            id: id.clone(),
            title: title.trim().to_string(),
            description: description.unwrap_or_default(),
            parent_id,
            files: files.unwrap_or_default(),
            status: "pending".to_string(),
            ..Default::default()
        });
        state.touched.push(id.clone());
        self.edited.store(true, Ordering::SeqCst);
        Ok(json!({ "action": "add", "pageId": id, "pages": state.pages.len() }))
    }

    async fn remove(&self, page_id: &str) -> std::result::Result<Value, String> {
        if page_id.is_empty() {
            return Err("pageId is required when action=remove".to_string());
        }
        let mut state = self.state.lock().await;
        let Some(index) = state.pages.iter().position(|page| page.id == page_id) else {
            return Err(format!("page \"{page_id}\" does not exist"));
        };
        if state.pages.len() <= 1 {
            return Err("the catalog must keep at least one page".to_string());
        }
        state.pages.remove(index);
        for page in state.pages.iter_mut() {
            if page.parent_id.as_deref() == Some(page_id) {
                page.parent_id = None;
            }
        }
        state.touched.retain(|id| id.as_str() != page_id);
        self.edited.store(true, Ordering::SeqCst);
        Ok(json!({ "action": "remove", "pageId": page_id, "pages": state.pages.len() }))
    }

    async fn update(
        &self,
        page_id: &str,
        title: Option<String>,
        description: Option<String>,
        parent: Option<Option<String>>,
        files: Option<Vec<String>>,
    ) -> std::result::Result<Value, String> {
        if page_id.is_empty() {
            return Err("pageId is required when action=update".to_string());
        }
        let mut state = self.state.lock().await;
        let Some(index) = state.pages.iter().position(|page| page.id == page_id) else {
            return Err(format!("page \"{page_id}\" does not exist"));
        };
        if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
            state.pages[index].title = title;
        }
        if let Some(description) = description {
            state.pages[index].description = description;
        }
        if let Some(requested_parent) = parent {
            let resolved = resolve_parent(&state.pages, requested_parent.as_deref(), Some(page_id))?;
            state.pages[index].parent_id = resolved;
        }
        if let Some(files) = files {
            state.pages[index].files = files;
        }
        if !state.touched.iter().any(|id| id.as_str() == page_id) {
            state.touched.push(page_id.to_string());
        }
        self.edited.store(true, Ordering::SeqCst);
        Ok(json!({ "action": "update", "pageId": page_id, "pages": state.pages.len() }))
    }
}

/// 父级只能是顶层页，保证最多两级。
fn resolve_parent(
    pages: &[WikiPage],
    requested: Option<&str>,
    self_id: Option<&str>,
) -> std::result::Result<Option<String>, String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if Some(requested) == self_id {
        return Err("a page cannot be its own parent".to_string());
    }
    let Some(parent) = pages.iter().find(|page| page.id == requested) else {
        return Err(format!("parentId \"{requested}\" does not exist"));
    };
    Ok(Some(
        parent.parent_id.clone().unwrap_or_else(|| parent.id.clone()),
    ))
}

/// 工具活动回调：(工具名, 目标)。
pub(crate) type ActivityFn<'a> = &'a (dyn Fn(&str, &str) + Send + Sync);

pub(crate) struct WikiToolExecutor<'a> {
    pub view: &'a WikiReadView,
    pub on_activity: ActivityFn<'a>,
    /// 局部编辑草稿；None 时 wiki-page-edit 不可用。
    pub draft: Option<&'a PageDraft>,
    /// 目录草稿；None 时 wiki-catalog-edit 不可用。
    pub catalog: Option<&'a CatalogDraft>,
}


impl AgentToolExecutor for WikiToolExecutor<'_> {
    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments_json: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let args: Value = match serde_json::from_str(arguments_json) {
                Ok(args) => args,
                Err(error) => return Ok(format!("Error: failed to parse tool arguments: {error}")),
            };
            let result = match name {
                "filesystem-read" => self.read(args).await,
                "grep-search" => self.search(args).await,
                "grep-find" => self.find(args).await,
                "wiki-page-edit" => self.edit(&args).await,
                "wiki-catalog-edit" => self.catalog_edit(&args).await,
                other => Err(format!(
                    "unsupported tool \"{other}\". Available tools: filesystem-read, grep-search, grep-find, wiki-page-edit, wiki-catalog-edit"
                )),
            };
            Ok(match result {
                Ok(output) => truncate_output(&output),
                Err(message) => format!("Error: {message}"),
            })
        })
    }

    fn label(&self) -> &'static str {
        "repo_wiki_agent"
    }
}

impl WikiToolExecutor<'_> {
    fn resolve(&self, requested: Option<&str>) -> std::result::Result<String, String> {
        let requested = requested.unwrap_or("").trim();
        self.view.relative(requested).ok_or_else(|| {
            format!(
                "path \"{requested}\" is outside the workspace \"{}\"",
                self.view.root()
            )
        })
    }

    /// 就地编辑当前页面草稿：精确字符串替换。
    async fn edit(&self, args: &Value) -> std::result::Result<Value, String> {
        let Some(draft) = self.draft else {
            return Err("wiki-page-edit is not available for this task".to_string());
        };
        let old = args
            .get("oldString")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let new = args
            .get("newString")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let replace_all = args
            .get("replaceAll")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let target: String = old
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .chars()
            .take(80)
            .collect();
        (self.on_activity)(
            "edit",
            if target.is_empty() {
                "page"
            } else {
                target.as_str()
            },
        );
        let (applied, page_chars) = draft.apply(old, new, replace_all).await?;
        Ok(json!({ "applied": applied, "pageChars": page_chars }))
    }

    /// 目录增删改：落到 CatalogDraft，新页留给后续生成阶段。
    async fn catalog_edit(&self, args: &Value) -> std::result::Result<Value, String> {
        let Some(catalog) = self.catalog else {
            return Err("wiki-catalog-edit is not available for this task".to_string());
        };
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let page_id = args
            .get("pageId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let description = args
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string);
        // 字段缺失=不改；空串或 null=提升为顶层
        let parent = match args.get("parentId") {
            Some(Value::Null) => Some(None),
            Some(Value::String(text)) => {
                let text = text.trim();
                Some((!text.is_empty()).then(|| text.to_string()))
            }
            _ => None,
        };
        let files = args.get("files").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|file| self.view.relative(file))
                .filter(|file| !file.is_empty())
                .take(MAX_FILES_PER_PAGE)
                .collect::<Vec<String>>()
        });
        let label = if page_id.is_empty() {
            format!("{action} {}", title.clone().unwrap_or_default())
        } else {
            format!("{action} {page_id}")
        };
        (self.on_activity)("catalog", label.trim());
        match action.as_str() {
            "add" => catalog.add(title, description, parent, files).await,
            "remove" => catalog.remove(&page_id).await,
            "update" => catalog.update(&page_id, title, description, parent, files).await,
            other => Err(format!(
                "unknown action \"{other}\": use add, remove or update"
            )),
        }
    }

    async fn read(&self, mut args: Value) -> std::result::Result<Value, String> {
        let requested = args.get("filePath").and_then(Value::as_str).map(str::to_string);
        if requested.as_deref().map(str::trim).unwrap_or("").is_empty() {
            return Err("filePath is required".to_string());
        }
        let relative = self.resolve(requested.as_deref())?;
        let absolute = self.view.absolute(&relative);
        (self.on_activity)("read", if relative.is_empty() { "." } else { relative.as_str() });

        if let ViewSource::Remote { snapshot, .. } = &self.view.source {
            return self.read_remote(snapshot, args, relative, absolute).await;
        }

        let metadata = tokio::fs::symlink_metadata(&absolute)
            .await
            .map_err(|error| format!("cannot access \"{relative}\": {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("symbolic links are excluded from the wiki read view".to_string());
        }
        if metadata.is_dir() {
            if self.view.is_blocked(&relative, true) {
                return Err(format!("\"{relative}\" is excluded from the wiki read view"));
            }
            return self.list_dir(&relative, &absolute).await;
        }
        if self.view.is_blocked(&relative, false) {
            return Err(format!("\"{relative}\" is excluded from the wiki read view"));
        }
        if is_binary_file(&relative) {
            return Err(format!("\"{relative}\" is a binary file"));
        }
        args["filePath"] = Value::String(absolute);
        let output = tokio::task::spawn_blocking(move || FilesystemService::new().execute("read", &args))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.reason.clone())?;
        let mut output = output;
        if let Some(object) = output.as_object_mut() {
            object.insert("path".to_string(), json!(relative));
        }
        Ok(output)
    }

    /// 远程读取：目录直接由快照列出，文件经 SSH 读取。
    async fn read_remote(
        &self,
        snapshot: &RemoteSnapshot,
        mut args: Value,
        relative: String,
        absolute: String,
    ) -> std::result::Result<Value, String> {
        if snapshot.is_dir(&relative) {
            if self.view.is_blocked(&relative, true) {
                return Err(format!("\"{relative}\" is excluded from the wiki read view"));
            }
            let mut entries: Vec<String> = Vec::new();
            let mut hidden = 0usize;
            for label in snapshot.children(&relative) {
                let is_dir = label.ends_with('/');
                let name = label.trim_end_matches('/');
                let child = if relative.is_empty() {
                    name.to_string()
                } else {
                    format!("{relative}/{name}")
                };
                if self.view.is_blocked(&child, is_dir) {
                    hidden += 1;
                    continue;
                }
                entries.push(label.clone());
            }
            return Ok(dir_listing(&relative, entries, hidden));
        }
        if self.view.is_blocked(&relative, false) {
            return Err(format!(
                "\"{relative}\" does not exist or is excluded from the wiki read view"
            ));
        }
        if is_binary_file(&relative) {
            return Err(format!("\"{relative}\" is a binary file"));
        }
        args["filePath"] = Value::String(absolute);
        let mut output = snapshot
            .run("filesystem-read", &args)
            .await
            .map_err(|error| error.reason.clone())?;
        if let Some(object) = output.as_object_mut() {
            object.insert("path".to_string(), json!(relative));
        }
        Ok(output)
    }

    async fn list_dir(&self, relative: &str, absolute: &str) -> std::result::Result<Value, String> {
        let mut reader = tokio::fs::read_dir(absolute)
            .await
            .map_err(|error| format!("failed to read directory: {error}"))?;
        let mut entries: Vec<String> = Vec::new();
        let mut hidden = 0usize;
        while let Ok(Some(entry)) = reader.next_entry().await {
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if file_type.is_symlink() {
                hidden += 1;
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let child = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let is_dir = file_type.is_dir();
            if name == ".git" || self.view.is_blocked(&child, is_dir) {
                hidden += 1;
                continue;
            }
            entries.push(if is_dir { format!("{name}/") } else { name });
        }
        Ok(dir_listing(relative, entries, hidden))
    }

    async fn search(&self, mut args: Value) -> std::result::Result<Value, String> {
        let relative = self.resolve(args.get("path").and_then(Value::as_str))?;
        if self.view.is_blocked(&relative, true) {
            return Err(format!("\"{relative}\" is excluded from the wiki read view"));
        }
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (self.on_activity)("search", &pattern);
        args["path"] = json!(self.view.absolute(&relative));
        if let Some(object) = args.as_object_mut() {
            object.remove("linkedRoots");
        }
        let mut output = match &self.view.source {
            ViewSource::Local(_) => GrepService::new().execute_search_local(&args).await,
            ViewSource::Remote { snapshot, .. } => snapshot.run("grep-search", &args).await,
        }
        .map_err(|error| error.reason.clone())?;
        if let Some(object) = output.as_object_mut() {
            object.remove("rawOutput");
            object.remove("backend");
            object.insert("path".to_string(), json!(relative));
        }
        if let Some(matches) = output.get_mut("matches").and_then(Value::as_array_mut) {
            matches.retain_mut(|item| {
                let Some(file) = item.get("file").and_then(Value::as_str) else {
                    return false;
                };
                match self.view.relative_from(&relative, file) {
                    Some(rel) if !self.view.is_blocked(&rel, false) => {
                        item["file"] = json!(rel);
                        true
                    }
                    _ => false,
                }
            });
        }
        Ok(output)
    }

    async fn find(&self, mut args: Value) -> std::result::Result<Value, String> {
        let relative = self.resolve(args.get("path").and_then(Value::as_str))?;
        if self.view.is_blocked(&relative, true) {
            return Err(format!("\"{relative}\" is excluded from the wiki read view"));
        }
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (self.on_activity)("find", &pattern);
        args["path"] = json!(self.view.absolute(&relative));
        args["searchAll"] = json!(false);
        if let Some(object) = args.as_object_mut() {
            object.remove("linkedRoots");
        }
        let mut output = match &self.view.source {
            ViewSource::Local(_) => GrepService::new().execute_find_local(&args).await,
            ViewSource::Remote { snapshot, .. } => snapshot.run("grep-find", &args).await,
        }
        .map_err(|error| error.reason.clone())?;
        if let Some(object) = output.as_object_mut() {
            object.remove("backend");
            object.insert("path".to_string(), json!(relative));
        }
        if let Some(files) = output.get_mut("files").and_then(Value::as_array_mut) {
            let filtered: Vec<Value> = files
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|file| self.view.relative_from(&relative, file))
                .filter(|rel| !self.view.is_blocked(rel, false))
                .map(Value::String)
                .collect();
            *files = filtered;
        }
        Ok(output)
    }
}
