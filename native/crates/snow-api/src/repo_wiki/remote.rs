//! 仓库 Wiki 的 SSH 工作区访问层：文件树、文件读取、检索与 git 元信息都经全局远程
//! 命令回调转发给 Electron（SFTP / exec），Rust 侧不直接做 SSH IO。

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::mcp::servers::remote_workspace::{
    execute_remote_workspace_command, global_remote_callback, RemoteWorkspaceCallback,
};
use crate::storage::services::checkpoint::remote::{
    filter_remote_tree, RemoteCheckpointClient, RemoteTreeEntry,
};
use crate::storage::services::file_scanner::{
    get_extension, is_extensionless_text_file, BINARY_EXTENSIONS, IMAGE_EXTENSIONS, MAX_FILE_SIZE,
    SKIP_DIRS, TEXT_EXTENSIONS,
};

use super::store::Fingerprint;

const GIT_META_TIMEOUT_MS: u64 = 15_000;

/// 单个 SSH 工作区的远程命令客户端。
struct RemoteWorkspace {
    root: String,
    callback: Arc<RemoteWorkspaceCallback>,
}

impl RemoteWorkspace {
    fn connect(root: &str) -> Result<Self> {
        let callback = global_remote_callback().ok_or_else(|| {
            Error::from_reason(
                "SSH remote channel is not registered; Repo Wiki cannot access the remote workspace",
            )
        })?;
        Ok(Self {
            root: root.to_string(),
            callback,
        })
    }

    /// 过滤后的远程文件树（跳过依赖/构建目录、.gitignore 命中项与符号链接）。
    async fn list_files(&self) -> Result<Vec<RemoteTreeEntry>> {
        let client = RemoteCheckpointClient::new(&self.callback);
        filter_remote_tree(&client, &self.root).await
    }

    async fn run(&self, operation: &str, args: &Value) -> Result<Value> {
        let result = execute_remote_workspace_command(&self.callback, operation, args, None).await?;
        // Electron 把连接级失败封装为 { success: false, error }，需要转成错误上抛
        if result.get("success") == Some(&Value::Bool(false)) {
            let message = result
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown SSH error");
            return Err(Error::from_reason(format!(
                "Remote operation '{operation}' failed: {message}"
            )));
        }
        Ok(result)
    }

    async fn git_meta(&self) -> Result<(Option<String>, Option<String>)> {
        let output = self
            .run(
                "bash-terminal-execute",
                &json!({
                    "command": "git rev-parse --abbrev-ref HEAD 2>/dev/null; git rev-parse HEAD 2>/dev/null; true",
                    "workingDirectory": self.root,
                    "timeout": GIT_META_TIMEOUT_MS,
                }),
            )
            .await?;
        let stdout = output.get("stdout").and_then(Value::as_str).unwrap_or("");
        let lines: Vec<&str> = stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let [branch, commit] = lines.as_slice() else {
            return Ok((None, None));
        };
        if commit.len() != 40 || !commit.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Ok((None, None));
        }
        Ok((Some(branch.to_string()), Some(commit.to_string())))
    }
}

/// 远程只读视图的文件树快照：任务开始时一次拉取，之后的目录列举与可见性判断在本地完成。
pub(crate) struct RemoteSnapshot {
    workspace: RemoteWorkspace,
    entries: Vec<RemoteTreeEntry>,
    files: HashSet<String>,
    dirs: HashSet<String>,
    /// 目录相对路径 -> 直接子项（目录名带 `/` 后缀，已排序）。
    children: HashMap<String, BTreeSet<String>>,
}

struct SnapshotIndex {
    files: HashSet<String>,
    dirs: HashSet<String>,
    children: HashMap<String, BTreeSet<String>>,
}

fn build_index(entries: &[RemoteTreeEntry]) -> SnapshotIndex {
    let mut files = HashSet::new();
    let mut dirs = HashSet::from([String::new()]);
    let mut children: HashMap<String, BTreeSet<String>> = HashMap::new();
    for entry in entries.iter().filter(|entry| !entry.is_directory) {
        files.insert(entry.path.clone());
        let mut parent = String::new();
        let mut segments = entry.path.split('/').filter(|part| !part.is_empty()).peekable();
        while let Some(name) = segments.next() {
            let is_dir = segments.peek().is_some();
            let path = if parent.is_empty() {
                name.to_string()
            } else {
                format!("{parent}/{name}")
            };
            let label = if is_dir {
                format!("{name}/")
            } else {
                name.to_string()
            };
            children.entry(parent).or_default().insert(label);
            if is_dir {
                dirs.insert(path.clone());
            }
            parent = path;
        }
    }
    SnapshotIndex {
        files,
        dirs,
        children,
    }
}

impl RemoteSnapshot {
    pub(crate) async fn load(root: &str) -> Result<Self> {
        let workspace = RemoteWorkspace::connect(root)?;
        let entries = workspace.list_files().await?;
        let (entries, index) = tokio::task::spawn_blocking(move || {
            let index = build_index(&entries);
            (entries, index)
        })
        .await
        .map_err(|error| Error::from_reason(format!("Failed to index remote workspace: {error}")))?;
        Ok(Self {
            workspace,
            entries,
            files: index.files,
            dirs: index.dirs,
            children: index.children,
        })
    }

    pub(crate) fn is_file(&self, relative: &str) -> bool {
        self.files.contains(relative)
    }

    pub(crate) fn is_dir(&self, relative: &str) -> bool {
        self.dirs.contains(relative)
    }

    pub(crate) fn children(&self, relative: &str) -> impl Iterator<Item = &String> {
        self.children.get(relative).into_iter().flatten()
    }

    pub(crate) fn fingerprint(&self) -> Fingerprint {
        fingerprint_from_entries(&self.entries)
    }

    /// 转发 filesystem-read / grep-search / grep-find 等远程操作。
    pub(crate) async fn run(&self, operation: &str, args: &Value) -> Result<Value> {
        self.workspace.run(operation, args).await
    }
}

/// `ssh://user@host:port/path` 中 authority 之后的远端根路径（根为 `/` 时为空串）。
pub(crate) fn remote_base_path(root: &str) -> String {
    let rest = root.strip_prefix("ssh://").unwrap_or(root);
    rest.find('/')
        .map(|index| rest[index..].trim_end_matches('/').to_string())
        .unwrap_or_default()
}

/// 与本地 file_scanner::scan_project 同一套筛选（远程不做内容级二进制探测）。
fn is_scannable(path: &str, size: u64) -> bool {
    if size > MAX_FILE_SIZE {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|part| (part.starts_with('.') && *part != ".gitignore") || SKIP_DIRS.contains(part))
    {
        return false;
    }
    let name = segments.last().copied().unwrap_or(path);
    let extension = get_extension(Path::new(name));
    if IMAGE_EXTENSIONS.contains(&extension.as_str())
        || BINARY_EXTENSIONS.contains(&extension.as_str())
    {
        return false;
    }
    TEXT_EXTENSIONS.contains(&extension.as_str()) || is_extensionless_text_file(name)
}

fn fingerprint_from_entries(entries: &[RemoteTreeEntry]) -> Fingerprint {
    entries
        .iter()
        .filter(|entry| !entry.is_directory && is_scannable(&entry.path, entry.size))
        .map(|entry| {
            (
                entry.path.clone(),
                format!("{}:{}", entry.size, entry.mtime_ms),
            )
        })
        .collect()
}

/// 远程工作区代码指纹（一次 list-tree 往返）。
pub(crate) async fn scan_fingerprint(root: &str) -> Result<Fingerprint> {
    let workspace = RemoteWorkspace::connect(root)?;
    let entries = workspace.list_files().await?;
    Ok(fingerprint_from_entries(&entries))
}

/// 远程分支名与 HEAD 提交（非 git 仓库或读取失败返回 None）。
pub(crate) async fn read_git_meta(root: &str) -> (Option<String>, Option<String>) {
    match RemoteWorkspace::connect(root) {
        Ok(workspace) => workspace.git_meta().await.unwrap_or((None, None)),
        Err(_) => (None, None),
    }
}
