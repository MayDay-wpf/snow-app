//! SSH 工作区的 checkpoint 远程文件访问层。
//!
//! 本地 checkpoint 用 `std::fs` 直接访问工作区；SSH 工作区（`ssh://` URI）
//! 的文件由 Electron 主进程通过 SFTP 访问，Rust 侧无法直接 IO。本模块把
//! checkpoint 需要的文件操作（stat / 递归列目录 / 读 / 写 / 删）封装为
//! 通过 `RemoteWorkspaceCallback` 转发给 Electron 的异步命令，供远程版
//! checkpoint 流程复用同一套 manifest / 对象存储逻辑。
//!
//! 性能设计：每次命令转发都是一次跨进程 + SSH 网络往返，因此所有流程都
//! 尽量合并请求——批量 stat / 批量读文件 / stat+read 合并操作，且 Electron
//! 侧对命令会话做连接池复用。捕获与查询流程在锁外一次性完成全部远程
//! IO，锁内只做本地 manifest 读写。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::mcp::servers::remote_workspace::{
    execute_remote_workspace_command, is_ssh_path, RemoteWorkspaceCallback,
};

use super::ABSOLUTE_PATH_MARKER;

/// 单个远程条目的 stat 信息（checkpoint-stat 返回）。
#[derive(Clone, Debug)]
pub struct RemoteFileStat {
    pub is_directory: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

/// 远程工作区文件树条目（相对根目录的 POSIX 路径，已跳过 SKIP_DIRS 与
/// 符号链接——与本地 collect_worktree_file_paths 的语义一致）。
#[derive(Clone, Debug)]
pub struct RemoteTreeEntry {
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

/// 远程目录的 .gitignore 内容（dir 为相对根目录的 POSIX 路径，根目录为
/// 空字符串）。Rust 侧用与本地相同的 GitignoreMatcher 语义做过滤。
#[derive(Clone, Debug)]
pub struct RemoteGitignore {
    pub dir: String,
    pub content: String,
}

/// checkpoint-list-tree 的完整返回：文件树 + 各目录的 .gitignore 内容。
#[derive(Clone, Debug)]
pub struct RemoteTreeListing {
    pub entries: Vec<RemoteTreeEntry>,
    pub gitignores: Vec<RemoteGitignore>,
}

/// 批量读取请求：路径 + 已知大小（用于分批时的带宽预算，未知填 0）。
#[derive(Clone, Debug)]
struct RemoteReadRequest {
    path: String,
    size_hint: u64,
}

/// stat+read 合并操作的返回（checkpoint-read-file-with-stat）。
struct RemoteFileSnapshot {
    stat: Option<RemoteFileStat>,
    content: Option<Vec<u8>>,
}

/// 批量 stat 每次命令的路径上限。
const STAT_BATCH_MAX_PATHS: usize = 512;
/// 批量读取每次命令的文件数与内容总量上限：控制单次 JSON 响应体积。
const READ_BATCH_MAX_FILES: usize = 32;
const READ_BATCH_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// SSH 工作区 checkpoint 的远程文件访问客户端。每个方法发起一次
/// checkpoint-* 远程命令并等待 Electron 侧 SFTP 完成。持有 callback
/// 的借用（napi ThreadsafeFunction 不支持 Clone）。
///
/// `scan_id` 标识一轮 checkpoint 扫描（before/after 各一个）：随命令传给
/// Electron 后，Rust 侧超时/失败时可通过 `abort_scan` 真正终止仍在进行
/// 的 SFTP 遍历，而不是仅在本端丢弃 future。
pub struct RemoteCheckpointClient<'a> {
    on_command: &'a RemoteWorkspaceCallback,
    scan_id: Option<String>,
}

impl<'a> RemoteCheckpointClient<'a> {
    pub fn new(on_command: &'a RemoteWorkspaceCallback) -> Self {
        Self {
            on_command,
            scan_id: None,
        }
    }

    pub fn with_scan_id(on_command: &'a RemoteWorkspaceCallback, scan_id: String) -> Self {
        Self {
            on_command,
            scan_id: Some(scan_id),
        }
    }

    /// 通知 Electron 中止本次扫描仍在进行的远程遍历（尽力而为，失败仅
    /// 意味着扫描已自行结束）。
    pub async fn abort_scan(&self) {
        let Some(scan_id) = self.scan_id.as_deref() else {
            return;
        };
        let _ = self
            .run("checkpoint-abort-scan", json!({ "scanId": scan_id }))
            .await;
    }

    /// 远程 stat：路径不存在时返回 Ok(None)。
    pub async fn stat(&self, path: &str) -> Result<Option<RemoteFileStat>> {
        let result = self
            .run("checkpoint-stat", json!({ "path": path }))
            .await?;
        if !result.get("exists").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(None);
        }
        Ok(Some(RemoteFileStat {
            is_directory: result
                .get("isDirectory")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            size: result.get("size").and_then(Value::as_u64).unwrap_or(0),
            mtime_ms: result.get("mtimeMs").and_then(Value::as_u64).unwrap_or(0),
        }))
    }

    /// 批量 stat：一次命令往返取回全部路径的元数据。返回 map 仅包含
    /// 存在的条目；不存在的路径直接缺省（等价 Ok(None) 语义）。
    async fn stat_paths(&self, paths: &[String]) -> Result<HashMap<String, RemoteFileStat>> {
        let mut result = HashMap::new();
        for chunk in paths.chunks(STAT_BATCH_MAX_PATHS) {
            let response = self
                .run("checkpoint-stat-paths", json!({ "paths": chunk }))
                .await?;
            let Some(stats) = response.get("stats").and_then(Value::as_object) else {
                continue;
            };
            for (path, stat) in stats {
                if !stat.get("exists").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                result.insert(
                    path.clone(),
                    RemoteFileStat {
                        is_directory: stat
                            .get("isDirectory")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        size: stat.get("size").and_then(Value::as_u64).unwrap_or(0),
                        mtime_ms: stat.get("mtimeMs").and_then(Value::as_u64).unwrap_or(0),
                    },
                );
            }
        }
        Ok(result)
    }

    /// 批量读取文件内容：按文件数与总大小分批，每批一次命令往返。
    /// 返回 map 中 `Some(None)` 表示文件在 stat 后消失。
    async fn read_files(
        &self,
        requests: &[RemoteReadRequest],
    ) -> Result<HashMap<String, Option<Vec<u8>>>> {
        let mut result: HashMap<String, Option<Vec<u8>>> = HashMap::new();
        let mut start = 0;
        while start < requests.len() {
            let mut end = start;
            let mut chunk_bytes: u64 = 0;
            while end < requests.len() {
                let next_bytes = chunk_bytes.saturating_add(requests[end].size_hint);
                let full = end > start
                    && (end - start >= READ_BATCH_MAX_FILES || next_bytes > READ_BATCH_MAX_BYTES);
                if full {
                    break;
                }
                chunk_bytes = next_bytes;
                end += 1;
            }
            let paths: Vec<String> = requests[start..end]
                .iter()
                .map(|request| request.path.clone())
                .collect();
            let response = self
                .run("checkpoint-read-files", json!({ "paths": paths }))
                .await?;
            if let Some(contents) = response.get("contents").and_then(Value::as_object) {
                for (path, content) in contents {
                    let decoded = match content.as_str() {
                        Some(encoded) => Some(
                            base64::engine::general_purpose::STANDARD
                                .decode(encoded)
                                .map_err(|error| {
                                    Error::from_reason(format!(
                                        "Failed to decode remote checkpoint file content: {error}"
                                    ))
                                })?,
                        ),
                        None => None,
                    };
                    result.insert(path.clone(), decoded);
                }
            }
            start = end;
        }
        Ok(result)
    }

    /// stat + 读内容合并为一次往返（单文件 checkpoint 记录的高频路径）。
    async fn read_file_with_stat(&self, path: &str) -> Result<RemoteFileSnapshot> {
        let result = self
            .run("checkpoint-read-file-with-stat", json!({ "path": path }))
            .await?;
        if !result.get("exists").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(RemoteFileSnapshot {
                stat: None,
                content: None,
            });
        }
        let stat = RemoteFileStat {
            is_directory: result
                .get("isDirectory")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            size: result.get("size").and_then(Value::as_u64).unwrap_or(0),
            mtime_ms: result.get("mtimeMs").and_then(Value::as_u64).unwrap_or(0),
        };
        let content = if stat.is_directory {
            None
        } else {
            match result.get("content").and_then(Value::as_str) {
                Some(encoded) => Some(
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|error| {
                            Error::from_reason(format!(
                                "Failed to decode remote checkpoint file content: {error}"
                            ))
                        })?,
                ),
                None => None,
            }
        };
        Ok(RemoteFileSnapshot {
            stat: Some(stat),
            content,
        })
    }

    /// 递归列出远程工作区文件树（含各目录 .gitignore 内容），
    /// 返回相对根目录的 POSIX 路径。
    pub async fn list_tree(&self, root: &str) -> Result<RemoteTreeListing> {
        let result = self
            .run("checkpoint-list-tree", json!({ "path": root }))
            .await?;
        let entries = result
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut tree = Vec::with_capacity(entries.len());
        for entry in entries {
            let Some(path) = entry.get("path").and_then(Value::as_str) else {
                continue;
            };
            tree.push(RemoteTreeEntry {
                path: path.to_string(),
                is_directory: entry
                    .get("isDirectory")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                size: entry.get("size").and_then(Value::as_u64).unwrap_or(0),
                mtime_ms: entry
                    .get("mtimeMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            });
        }
        let mut gitignores = Vec::new();
        if let Some(items) = result.get("gitignores").and_then(Value::as_array) {
            for item in items {
                let (Some(dir), Some(content)) = (
                    item.get("dir").and_then(Value::as_str),
                    item.get("content").and_then(Value::as_str),
                ) else {
                    continue;
                };
                gitignores.push(RemoteGitignore {
                    dir: dir.to_string(),
                    content: content.to_string(),
                });
            }
        }
        Ok(RemoteTreeListing {
            entries: tree,
            gitignores,
        })
    }

    /// 写入远程文件（自动创建父目录）。
    pub async fn write_bytes(&self, path: &str, content: &[u8]) -> Result<()> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(content);
        self.run(
            "checkpoint-write-file",
            json!({ "path": path, "contentBase64": encoded }),
        )
        .await?;
        Ok(())
    }

    /// 删除远程文件；文件不存在视为成功（恢复 Missing 语义）。
    pub async fn delete_file(&self, path: &str) -> Result<()> {
        let result = self
            .run("checkpoint-delete-file", json!({ "path": path }))
            .await?;
        if result
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err(Error::from_reason(format!(
                "Failed to delete remote file '{path}'"
            )))
        }
    }

    /// 尝试删除远程空目录；目录不存在或非空时返回 Ok(false)。
    pub async fn remove_dir(&self, path: &str) -> Result<bool> {
        let result = self
            .run("checkpoint-remove-dir", json!({ "path": path }))
            .await?;
        Ok(result
            .get("removed")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    async fn run(&self, operation: &str, mut args: Value) -> Result<Value> {
        // 携带 scanId 的命令会在 Electron 侧注册独立的 AbortController：
        // Rust 超时后通过 checkpoint-abort-scan 真正终止仍在进行的扫描。
        // checkpoint-abort-scan 自身不包裹（它的 scanId 是中止目标）。
        if let Some(scan_id) = self.scan_id.as_deref() {
            if operation != "checkpoint-abort-scan" {
                args["scanId"] = Value::String(scan_id.to_string());
            }
        }
        let result = execute_remote_workspace_command(self.on_command, operation, &args, None)
            .await
            .map_err(|error| {
                Error::from_reason(format!(
                    "Remote checkpoint operation '{operation}' failed: {error}"
                ))
            })?;
        // Electron 侧把连接级失败封装为 { success: false, error }：必须上抛，
        // 否则断连会被误读为"文件不存在"，产生错误的删除/缺省记录。
        if result.get("success") == Some(&Value::Bool(false)) {
            let message = result
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown SSH error");
            return Err(Error::from_reason(format!(
                "Remote checkpoint operation '{operation}' failed: {message}"
            )));
        }
        Ok(result)
    }
}

/// 解析 `ssh://user@host:port/path`，返回 (authority, remote_path)。
fn split_ssh_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("ssh://")?;
    let at = rest.find('@')?;
    let authority = &rest[..=at];
    let host_port_path = &rest[at + 1..];
    let slash = host_port_path.find('/')?;
    let host_port = &host_port_path[..slash];
    let remote_path = &host_port_path[slash..];
    Some((
        format!("{authority}{host_port}"),
        remote_path.to_string(),
    ))
}

/// 归一化 ssh:// URI：去除尾部斜杠。
pub fn normalize_ssh_uri(uri: &str) -> String {
    let trimmed = uri.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 把 ssh:// 文件 URI 解析为 (absolute_uri, 相对工作区根的 POSIX 路径)。
///
/// 与本地 `resolve_checkpoint_path` 对应：工作区内的文件返回相对路径，
/// 工作区之外的绝对路径（跨 authority 或不在根路径下）用
/// `ABSOLUTE_PATH_MARKER` 标记存完整 URI。
pub fn resolve_remote_checkpoint_path(root: &str, file_path: &str) -> (String, String) {
    let Some((root_authority, root_path)) = split_ssh_uri(root) else {
        // 根本身不是合法 ssh:// URI：把文件路径原样拼到根后，交由调用方报错。
        return (
            format!("{}/{}", root.trim_end_matches('/'), file_path),
            file_path.to_string(),
        );
    };
    let root_path = root_path.trim_end_matches('/');
    let Some((authority, path)) = split_ssh_uri(file_path) else {
        // 相对路径：拼到工作区根下。
        return (
            format!("{}/{file_path}", root.trim_end_matches('/')),
            file_path.to_string(),
        );
    };
    if authority == root_authority {
        let path = path.trim_end_matches('/');
        if path == root_path || path.is_empty() {
            return (file_path.to_string(), String::new());
        }
        if let Some(relative) = path.strip_prefix(&format!("{root_path}/")) {
            return (file_path.to_string(), relative.to_string());
        }
    }
    // 工作区之外的绝对路径：标记存储完整 URI。
    (
        file_path.to_string(),
        format!("{ABSOLUTE_PATH_MARKER}{file_path}"),
    )
}

/// 把 manifest 条目路径解析回完整的 ssh:// URI。
pub fn resolve_remote_manifest_path(root: &str, manifest_path: &str) -> String {
    if let Some(absolute) = manifest_path.strip_prefix(ABSOLUTE_PATH_MARKER) {
        absolute.to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), manifest_path)
    }
}

/// 已校验远程根目录的短 TTL 缓存：工具高频循环下（每次文件编辑、每条
/// 命令的 before/after 阶段）不再重复 stat 同一个根目录。
static REMOTE_WORK_DIR_VALIDATED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
const REMOTE_WORK_DIR_CACHE_TTL: Duration = Duration::from_secs(30);

/// 远程工作区根目录校验：URI 合法且远端存在且为目录。
pub async fn canonical_work_dir_remote(
    client: &RemoteCheckpointClient<'_>,
    work_dir: &str,
) -> Result<String> {
    let trimmed = work_dir.trim();
    if !is_ssh_path(trimmed) {
        return Err(Error::from_reason(format!(
            "Working directory is not an SSH path: {work_dir}"
        )));
    }
    let normalized = normalize_ssh_uri(trimmed);
    let recently_validated = {
        let cache = REMOTE_WORK_DIR_VALIDATED
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .get(&normalized)
            .map(|validated_at| validated_at.elapsed() < REMOTE_WORK_DIR_CACHE_TTL)
            .unwrap_or(false)
    };
    if recently_validated {
        return Ok(normalized);
    }
    let Some(stats) = client.stat(&normalized).await? else {
        return Err(Error::from_reason(format!(
            "Remote working directory does not exist: {work_dir}"
        )));
    };
    if !stats.is_directory {
        return Err(Error::from_reason(format!(
            "Path is not a directory: {work_dir}"
        )));
    }
    let mut cache = REMOTE_WORK_DIR_VALIDATED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() > 256 {
        cache.clear();
    }
    cache.insert(normalized.clone(), Instant::now());
    Ok(normalized)
}

// ============================================================================
// 远程（SSH）checkpoint 流程：与 mod.rs 的本地实现一一对应，文件 IO 全部
// 通过 RemoteCheckpointClient 转发给 Electron，manifest / 对象存储 / diff
// 逻辑完全复用本地实现。
// ============================================================================

use super::{
    bump_restore_epoch, change_owned_by_other_capture, checkpoint_manifest_exists,
    checkpoint_operation_lock, checkpoint_root, current_restore_epoch, filter_existing_checkpoints,
    fingerprint_lookup, fingerprint_store, manifest_lock, original_object_id,
    pending_state_to_original, read_manifest, register_file_capture_end,
    register_file_capture_start, register_recorded_change, should_skip_manifest_path,
    should_skip_relative, store_object_bytes, work_dir_lock, work_dir_read_guard_async,
    work_dir_write_guard_async, write_manifest, CachedCheckpointDiff, CheckpointEntry,
    CheckpointFileChange, CheckpointFileDiff, CheckpointManifest, CheckpointWorktreeCapture,
    OriginalState, PendingFileState, DIFF_CACHE_MAX_ENTRIES, OBJECT_DIR_NAME,
};

use crate::storage::services::checkpoint_skip::should_skip_pending_copy_size;

/// 远程工作目录校验：URI 规范化后与 manifest 记录值比较。
fn validate_manifest_work_dir_remote(
    manifest: &CheckpointManifest,
    work_dir: &str,
) -> Result<String> {
    let requested = normalize_ssh_uri(work_dir);
    let recorded = normalize_ssh_uri(&manifest.work_dir);
    if requested != recorded {
        return Err(Error::from_reason(format!(
            "Checkpoint belongs to '{}', not '{}'",
            recorded, requested
        )));
    }
    Ok(requested)
}

/// 捕获阶段的远程目录校验：不匹配时返回 None 并跳过（与本地行为一致）。
fn validate_capture_work_dir_remote(
    manifest: &CheckpointManifest,
    work_dir: &str,
) -> Option<String> {
    match validate_manifest_work_dir_remote(manifest, work_dir) {
        Ok(root) => Some(root),
        Err(error) => {
            eprintln!("[checkpoint] {error}; skipping checkpoint capture");
            None
        }
    }
}

/// 远程文件树 → 相对路径 → stat 映射（只含常规文件）。
fn remote_stat_map(tree: &[RemoteTreeEntry]) -> HashMap<String, RemoteFileStat> {
    tree.iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| {
            (
                entry.path.clone(),
                RemoteFileStat {
                    is_directory: false,
                    size: entry.size,
                    mtime_ms: entry.mtime_ms,
                },
            )
        })
        .collect()
}

/// 用各目录 .gitignore 内容构建 matcher（与本地 collect_worktree_file_paths
/// 的加载顺序一致：根目录规则先加载，子目录按深度升序后加载，深层规则
/// 覆盖浅层）。远程不读取工作区父目录与 .git/info/exclude（在 SSH
/// workspace 边界之外）。
fn build_remote_matcher(
    gitignores: &[RemoteGitignore],
) -> crate::storage::services::gitignore::GitignoreMatcher {
    let mut sorted: Vec<&RemoteGitignore> = gitignores.iter().collect();
    sorted.sort_by_key(|gitignore| gitignore.dir.matches('/').count());
    let root_content = sorted
        .iter()
        .find(|gitignore| gitignore.dir.is_empty())
        .map(|gitignore| gitignore.content.as_str());
    let mut matcher =
        crate::storage::services::gitignore::GitignoreMatcher::from_root_content(root_content);
    for gitignore in sorted {
        if gitignore.dir.is_empty() {
            continue;
        }
        matcher.append_directory_content(Path::new(&gitignore.dir), &gitignore.content);
    }
    matcher
}

/// 判断路径是否被 gitignore 忽略：检查路径本身及所有父目录。本地实现在
/// 遍历时对目录逐级过滤；远程树只含文件条目，必须补上父目录检查才能
/// 复现"忽略目录 = 忽略其下全部内容"的 git 语义。
fn is_ignored_with_ancestors(
    matcher: &crate::storage::services::gitignore::GitignoreMatcher,
    path: &str,
) -> bool {
    let mut prefix = String::new();
    for segment in path.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(segment);
        if matcher.is_ignored(&prefix, true) {
            return true;
        }
    }
    matcher.is_ignored(path, false)
}

/// 远程工作区文件树扫描 + .gitignore 过滤：所有远程 checkpoint 流程统一
/// 使用本函数，保证 before/after 捕获与变更/回滚检测的过滤语义一致。
async fn filter_remote_tree(
    client: &RemoteCheckpointClient<'_>,
    root: &str,
) -> Result<Vec<RemoteTreeEntry>> {
    let listing = client.list_tree(root).await?;
    let matcher = build_remote_matcher(&listing.gitignores);
    Ok(listing
        .entries
        .into_iter()
        .filter(|entry| !is_ignored_with_ancestors(&matcher, &entry.path))
        .collect())
}

/// 读取远程文件当前状态（Missing / Object）。与本地 current_state 对齐：
/// 内容无条件抓取（不应用大小/扩展名跳过）。stat+read 合并为一次往返。
async fn current_state_remote(
    client: &RemoteCheckpointClient<'_>,
    path: &str,
) -> Result<OriginalState> {
    let snapshot = client.read_file_with_stat(path).await?;
    let Some(stat) = snapshot.stat.as_ref() else {
        return Ok(OriginalState::Missing);
    };
    if stat.is_directory {
        return Err(Error::from_reason(format!(
            "Checkpoint path is not a regular file: {path}"
        )));
    }
    let Some(content) = snapshot.content else {
        return Ok(OriginalState::Missing);
    };
    Ok(OriginalState::Object {
        object_id: store_object_bytes(&content)?,
    })
}

/// 更新 expected 状态的远程版本。
async fn update_expected_state_remote(
    client: &RemoteCheckpointClient<'_>,
    manifest: &mut CheckpointManifest,
    absolute: &str,
    path: &str,
) -> Result<bool> {
    let Some(entry) = manifest
        .entries
        .iter_mut()
        .find(|entry| entry.path == path)
    else {
        return Ok(false);
    };
    entry.expected = Some(current_state_remote(client, absolute).await?);
    Ok(true)
}

/// 本地加载条目涉及的对象内容（object_id → 内容；缺失为 None），供
/// 纯本地分类对比使用。条目数少且对象库在本地，代价可忽略。
fn load_compare_objects(entries: &[&CheckpointEntry]) -> Result<HashMap<String, Option<Vec<u8>>>> {
    let object_dir = checkpoint_root()?.join(OBJECT_DIR_NAME);
    let mut objects: HashMap<String, Option<Vec<u8>>> = HashMap::new();
    for entry in entries {
        let mut states: Vec<&OriginalState> = vec![&entry.original];
        if let Some(expected) = entry.expected.as_ref() {
            states.push(expected);
        }
        for state in states {
            if let OriginalState::Object { object_id } = state {
                objects
                    .entry(object_id.clone())
                    .or_insert_with(|| fs::read(object_dir.join(object_id)).ok());
            }
        }
    }
    Ok(objects)
}

/// 判断某个状态的对比是否需要读取远程文件内容：仅当远端存在、对象可读
/// 且大小一致时才需要（大小不一致直接判"已修改"）。
fn content_compare_required(
    stat: Option<&RemoteFileStat>,
    state: &OriginalState,
    objects: &HashMap<String, Option<Vec<u8>>>,
) -> bool {
    let OriginalState::Object { object_id } = state else {
        return false;
    };
    let (Some(stat), Some(Some(bytes))) = (stat, objects.get(object_id)) else {
        return false;
    };
    stat.size == bytes.len() as u64
}

/// 纯本地分类：基于已取回的 stat 与内容对比 original 状态，返回变更类型。
/// `content`：Some(x) 表示内容已读取（x 为 None 代表文件已消失），None
/// 表示未读取；调用方必须先通过 content_compare_required 收集并批量读取
/// 所有需要的内容，未读取而需要内容的场景按"已修改"防御性处理。
fn classify_remote_state(
    stat: Option<&RemoteFileStat>,
    content: Option<Option<&[u8]>>,
    original: &OriginalState,
    objects: &HashMap<String, Option<Vec<u8>>>,
    relative: &str,
) -> Result<Option<String>> {
    match original {
        OriginalState::Missing => Ok(stat.map(|_| "added".to_string())),
        OriginalState::Object { object_id } => {
            let Some(stat) = stat else {
                return Ok(Some("deleted".to_string()));
            };
            let Some(bytes) = objects.get(object_id).and_then(|bytes| bytes.as_ref()) else {
                return Ok(Some("modified".to_string()));
            };
            if stat.size != bytes.len() as u64 {
                return Ok(Some("modified".to_string()));
            }
            let Some(content) = content else {
                return Ok(Some("modified".to_string()));
            };
            let Some(current) = content else {
                return Ok(Some("deleted".to_string()));
            };
            Ok((current != bytes.as_slice()).then(|| "modified".to_string()))
        }
        OriginalState::Git => Err(Error::from_reason(format!(
            "Checkpoint Git baseline is missing for '{relative}'"
        ))),
    }
}

/// 批量探测追踪条目的当前状态：一次批量 stat + 至多两次批量内容读取
/// （第一次为分类所需的大小一致对比；第二次仅当 read_changed_contents
/// 为 true 时按需补齐变更文件内容，供 diff 文本构建），替代旧版的全树
/// 扫描 + 逐文件串行读取。
struct ProbedEntries {
    /// 与输入条目一一对应：stat、已读内容（若有）。
    items: Vec<EntryProbe>,
    objects: HashMap<String, Option<Vec<u8>>>,
}

struct EntryProbe {
    entry: CheckpointEntry,
    stat: Option<RemoteFileStat>,
    content: Option<Option<Vec<u8>>>,
}

async fn probe_tracked_entries(
    client: &RemoteCheckpointClient<'_>,
    root: &str,
    entries: Vec<CheckpointEntry>,
    compare_states: &[(usize, OriginalState)],
    read_changed_contents: bool,
) -> Result<ProbedEntries> {
    let absolute_paths: Vec<String> = entries
        .iter()
        .map(|entry| resolve_remote_manifest_path(root, &entry.path))
        .collect();
    let stats = client.stat_paths(&absolute_paths).await?;
    let entry_refs: Vec<&CheckpointEntry> = entries.iter().collect();
    let objects = load_compare_objects(&entry_refs)?;

    // 第一轮读取：分类所需（存在且大小与对象一致的对比状态）。
    let mut read_requests: Vec<RemoteReadRequest> = Vec::new();
    let mut requested: HashSet<String> = HashSet::new();
    for (index, state) in compare_states {
        let absolute = &absolute_paths[*index];
        if requested.contains(absolute) {
            continue;
        }
        let stat = stats.get(absolute);
        if content_compare_required(stat, state, &objects) {
            requested.insert(absolute.clone());
            read_requests.push(RemoteReadRequest {
                path: absolute.clone(),
                size_hint: stat.map(|stat| stat.size).unwrap_or(0),
            });
        }
    }
    let mut contents = client.read_files(&read_requests).await?;

    // 第二轮读取：分类后仍缺内容但当前存在的文件（如大小变化的修改、
    // 新增文件）——仅 diff 流程需要其内容构建文本。
    let mut extra_requests: Vec<RemoteReadRequest> = Vec::new();
    if read_changed_contents {
        for (index, absolute) in absolute_paths.iter().enumerate() {
            if contents.contains_key(absolute) {
                continue;
            }
            let Some(stat) = stats.get(absolute) else {
                continue;
            };
            let entry = &entries[index];
            let entry_states: Vec<&OriginalState> = compare_states
                .iter()
                .filter(|(state_index, _)| *state_index == index)
                .map(|(_, state)| state)
                .collect();
            let classified = entry_states.iter().any(|state| {
                classify_remote_state(Some(stat), None, state, &objects, &entry.path)
                    .ok()
                    .flatten()
                    .is_some()
            });
            if classified {
                extra_requests.push(RemoteReadRequest {
                    path: absolute.clone(),
                    size_hint: stat.size,
                });
            }
        }
    }
    if !extra_requests.is_empty() {
        contents.extend(client.read_files(&extra_requests).await?);
    }

    let items = entries
        .into_iter()
        .zip(absolute_paths)
        .map(|(entry, absolute)| {
            let stat = stats.get(&absolute).cloned();
            let content = contents.remove(&absolute);
            EntryProbe {
                entry,
                stat,
                content,
            }
        })
        .collect();
    Ok(ProbedEntries { items, objects })
}

/// 带 manifest 锁的异步操作（远程流程内部需要 await SFTP 调用）。
async fn with_manifest_lock_async<T, Fut>(
    checkpoint_id: &str,
    operation: impl FnOnce() -> Fut,
) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    let lock = manifest_lock(checkpoint_id)?;
    let _guard = lock.lock().await;
    operation().await
}

/// 远程版 before 捕获：一次 list-tree 拿到全树 stat，未变化文件命中指纹
/// 缓存（mtime+size）零内容 IO；未命中文件按大小/数量分批**并发批量**
/// 读取（旧版逐文件串行往返），内容存入本地对象库并回写指纹缓存。
pub(crate) async fn capture_checkpoint_worktree_before_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
) -> Result<Option<CheckpointWorktreeCapture>> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(None);
    }
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    // 扫描期间短暂持有执行级共享读锁：与回滚（独占写锁）互斥，保证快照
    // 不与正在进行的回滚交错；bash 执行期间不持锁，跨会话命令并行。
    let operation_lock = checkpoint_operation_lock(&work_dir)?;
    let _operation_guard = operation_lock.read_owned().await;
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;

    // 至少一个 checkpoint 属于当前远程目录才扫描。
    let mut matched_any = false;
    for checkpoint_id in &checkpoint_ids {
        let lock = manifest_lock(checkpoint_id)?;
        let _guard = lock.lock().await;
        if !checkpoint_manifest_exists(checkpoint_id) {
            continue;
        }
        let manifest = read_manifest(checkpoint_id)?;
        if validate_capture_work_dir_remote(&manifest, &work_dir).is_some() {
            matched_any = true;
            break;
        }
    }
    if !matched_any {
        return Ok(None);
    }

    let tree = filter_remote_tree(client, &root).await?;
    let mut before_paths = HashSet::new();
    let mut before_states = HashMap::new();
    // 未命中指纹缓存、需要读取内容的文件（relative, absolute, mtime, size）。
    let mut pending_reads: Vec<(String, String, u64, u64)> = Vec::new();
    for entry in &tree {
        if entry.is_directory {
            continue;
        }
        let relative = &entry.path;
        if should_skip_relative(Path::new(relative)) {
            continue;
        }
        before_paths.insert(relative.clone());
        if let Some(object_id) =
            fingerprint_lookup(&work_dir, relative, entry.mtime_ms, entry.size)
        {
            before_states.insert(
                relative.clone(),
                PendingFileState {
                    object_id: Some(object_id),
                    skipped: false,
                    mtime_ms: entry.mtime_ms,
                    size: entry.size,
                },
            );
            continue;
        }
        if should_skip_pending_copy_size(entry.size, relative) {
            // 大文件/二进制：不抓取内容，变更不可回滚。
            before_states.insert(
                relative.clone(),
                PendingFileState {
                    object_id: None,
                    skipped: true,
                    mtime_ms: entry.mtime_ms,
                    size: entry.size,
                },
            );
            continue;
        }
        pending_reads.push((
            relative.clone(),
            resolve_remote_manifest_path(&root, relative),
            entry.mtime_ms,
            entry.size,
        ));
    }

    let read_requests: Vec<RemoteReadRequest> = pending_reads
        .iter()
        .map(|(_, absolute, _, size)| RemoteReadRequest {
            path: absolute.clone(),
            size_hint: *size,
        })
        .collect();
    let contents = client.read_files(&read_requests).await?;
    for (relative, absolute, mtime_ms, size) in pending_reads {
        let Some(Some(content)) = contents.get(&absolute) else {
            // 扫描后被删除：不记录状态（与旧版一致，保留在 before_paths）。
            continue;
        };
        let object_id = store_object_bytes(content)?;
        fingerprint_store(&work_dir, &relative, mtime_ms, size, object_id.clone());
        before_states.insert(
            relative,
            PendingFileState {
                object_id: Some(object_id),
                skipped: false,
                mtime_ms,
                size,
            },
        );
    }

    Ok(Some(CheckpointWorktreeCapture {
        // 先求值再移动 work_dir 字段。
        restore_epoch: current_restore_epoch(&work_dir)?,
        checkpoint_ids,
        work_dir,
        before_paths,
        before_states,
    }))
}

/// 远程版 after 记录：一次 list-tree 得到命令后的树，与 before 指纹对比。
/// 变更判定所需的全部内容对比与 expected 内容抓取都在锁外**一次性批量**
/// 完成；各 checkpoint 的 manifest 更新只做本地读写，不再逐 checkpoint
/// 重复远程 IO（旧版每个 checkpoint × 每个变更文件都会重新读一次远端）。
pub(crate) async fn record_checkpoint_worktree_after_remote(
    client: &RemoteCheckpointClient<'_>,
    capture: CheckpointWorktreeCapture,
) -> Result<()> {
    let root = canonical_work_dir_remote(client, &capture.work_dir).await?;
    let root_path = PathBuf::from(&root);
    // after 扫描同样短暂持有执行级共享读锁：与回滚（独占写锁）互斥。
    // 若在取得锁之前回滚已改写工作树，纪元已递增，这里跳过变更记录，
    // 避免把其他会话回滚恢复的文件误记到本会话 checkpoint。
    let operation_lock = checkpoint_operation_lock(&capture.work_dir)?;
    let _operation_guard = operation_lock.read_owned().await;
    if current_restore_epoch(&capture.work_dir)? != capture.restore_epoch {
        eprintln!(
            "[checkpoint] remote worktree was restored by a rollback while the command ran; \
             skipping change capture for checkpoint(s) {}",
            capture.checkpoint_ids.join(", ")
        );
        return Ok(());
    }
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;

    let mut effective_ids = Vec::new();
    for checkpoint_id in &capture.checkpoint_ids {
        let lock = manifest_lock(checkpoint_id)?;
        let _guard = lock.lock().await;
        if !checkpoint_manifest_exists(checkpoint_id) {
            continue;
        }
        let manifest = read_manifest(checkpoint_id)?;
        if validate_capture_work_dir_remote(&manifest, &capture.work_dir).is_some() {
            effective_ids.push(checkpoint_id.clone());
        }
    }
    if effective_ids.is_empty() {
        return Ok(());
    }

    let tree = filter_remote_tree(client, &root).await?;
    let after_stats = remote_stat_map(&tree);
    let mut candidates = capture.before_paths.clone();
    candidates.extend(after_stats.keys().cloned());

    // ---- 远程阶段 1：mtime 变化但大小一致的文件批量读内容做哈希对比 ----
    // （弥补远程 mtime 精度不足导致的同秒改写漏检；大小不同直接判变。）
    let mut compare_requests: Vec<RemoteReadRequest> = Vec::new();
    for relative_path in &candidates {
        let Some(state) = capture.before_states.get(relative_path) else {
            continue;
        };
        if state.skipped || state.object_id.is_none() {
            continue;
        }
        let Some(stat) = after_stats.get(relative_path) else {
            continue;
        };
        let metadata_changed = stat.mtime_ms != state.mtime_ms || stat.size != state.size;
        if metadata_changed && stat.size == state.size {
            compare_requests.push(RemoteReadRequest {
                path: resolve_remote_manifest_path(&root, relative_path),
                size_hint: stat.size,
            });
        }
    }
    let compared = client.read_files(&compare_requests).await?;

    // ---- 本地判定变更集 ----
    struct AfterChange {
        relative: String,
        original: OriginalState,
        /// 命令后仍存在、需要抓取当前内容作为 expected 的文件。
        needs_expected_content: bool,
    }
    let mut changes: Vec<AfterChange> = Vec::new();
    for relative_path in &candidates {
        if should_skip_relative(Path::new(relative_path)) {
            continue;
        }
        let before_state = capture.before_states.get(relative_path);
        let after_stat = after_stats.get(relative_path);
        let change = match before_state {
            // 内容抓取被跳过：无法恢复命令前内容，不记录变更。
            Some(state) if state.skipped => None,
            Some(state) => match after_stat {
                None => Some(pending_state_to_original(state)?),
                Some(stat) => {
                    if stat.mtime_ms == state.mtime_ms && stat.size == state.size {
                        None
                    } else if stat.size != state.size {
                        Some(pending_state_to_original(state)?)
                    } else {
                        // 大小一致：用阶段 1 批量读取的内容做哈希对比。
                        let absolute = resolve_remote_manifest_path(&root, relative_path);
                        let differs = match compared.get(&absolute) {
                            Some(Some(content)) => {
                                let current_id = blake3::hash(content).to_hex().to_string();
                                Some(current_id) != state.object_id
                            }
                            Some(None) => true, // 读取间隙被删除
                            None => true,
                        };
                        differs.then(|| pending_state_to_original(state)).transpose()?
                    }
                }
            },
            None => after_stat.map(|_| OriginalState::Missing),
        };
        let Some(original) = change else {
            continue;
        };
        // 多会话并行防线（与本地一致）：路径已被并行文件工具认领（正在
        // 追捕或已按同一变更起点记录）时跳过，变化归它负责。
        if change_owned_by_other_capture(
            &capture.work_dir,
            relative_path,
            before_state.and_then(|state| state.object_id.as_deref()),
        ) {
            continue;
        }
        changes.push(AfterChange {
            relative: relative_path.clone(),
            original,
            needs_expected_content: after_stat.is_some(),
        });
    }

    // ---- 远程阶段 2：为变更文件批量抓取命令后的内容（expected 状态）----
    let expected_requests: Vec<RemoteReadRequest> = changes
        .iter()
        .filter(|change| change.needs_expected_content)
        .map(|change| {
            let stat = after_stats.get(&change.relative);
            RemoteReadRequest {
                path: resolve_remote_manifest_path(&root, &change.relative),
                size_hint: stat.map(|stat| stat.size).unwrap_or(0),
            }
        })
        .collect();
    let expected_contents = client.read_files(&expected_requests).await?;
    let mut expected_states: HashMap<String, OriginalState> = HashMap::new();
    for change in &changes {
        if !change.needs_expected_content {
            expected_states.insert(change.relative.clone(), OriginalState::Missing);
            continue;
        }
        let absolute = resolve_remote_manifest_path(&root, &change.relative);
        let expected = match expected_contents.get(&absolute) {
            Some(Some(content)) => OriginalState::Object {
                object_id: store_object_bytes(content)?,
            },
            _ => OriginalState::Missing,
        };
        expected_states.insert(change.relative.clone(), expected);
    }

    // ---- manifest 阶段：纯本地读写，各 checkpoint 共享同一份变更集 ----
    for checkpoint_id in effective_ids {
        with_manifest_lock_async(&checkpoint_id, || async {
            if !checkpoint_manifest_exists(&checkpoint_id) {
                return Ok(());
            }
            let mut manifest = read_manifest(&checkpoint_id)?;
            if validate_capture_work_dir_remote(&manifest, &capture.work_dir).is_none() {
                return Ok(());
            }
            let mut changed = false;
            for change in &changes {
                let Some(expected) = expected_states.get(&change.relative).cloned() else {
                    continue;
                };
                apply_entry_states(
                    &mut manifest,
                    &capture.work_dir,
                    &change.relative,
                    change.original.clone(),
                    expected,
                );
                changed = true;
            }
            if changed {
                write_manifest(&checkpoint_id, &manifest)?;
            }
            Ok(())
        })
        .await?;
    }

    if let Some(mut cache) = super::DIFF_CACHE.get().and_then(|cache| cache.lock().ok()) {
        cache.retain(|key, _| {
            !capture
                .checkpoint_ids
                .iter()
                .any(|checkpoint_id| key.starts_with(&format!("{checkpoint_id}:")))
        });
    }
    Ok(())
}

/// 把 (original, expected) 状态对写入 manifest 条目：已有条目仅更新
/// expected（保留首次记录的 original），新条目追加。纯本地操作。
/// `work_dir` 用于变更归属注册（并行会话的 bash 全树对比据此跳过该路径）。
fn apply_entry_states(
    manifest: &mut CheckpointManifest,
    work_dir: &str,
    relative: &str,
    original: OriginalState,
    expected: OriginalState,
) {
    let relative_path = Path::new(relative);
    if relative_path.as_os_str().is_empty() || should_skip_relative(relative_path) {
        return;
    }
    if let Some(entry) = manifest
        .entries
        .iter_mut()
        .find(|entry| entry.path == relative)
    {
        entry.expected = Some(expected);
        return;
    }
    register_recorded_change(work_dir, relative, original_object_id(&original));
    manifest.entries.push(CheckpointEntry {
        path: relative.to_string(),
        original,
        expected: Some(expected),
    });
}

/// 远程版单文件 before 记录（filesystem-replace_edit/create 前）。
pub(crate) async fn record_checkpoint_file_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    file_path: String,
) -> Result<()> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(());
    }
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;
    let (absolute, path) = resolve_remote_checkpoint_path(&root, &file_path);
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    // before 内容只采样一次；无论该文件是否已有条目都必须登记"正在追捕"
    // （与本地一致），否则本轮编辑期间并行 bash 的全树对比会误记变化。
    let original = current_state_remote(client, &absolute).await?;
    register_file_capture_start(&work_dir, &path, original_object_id(&original));

    for checkpoint_id in checkpoint_ids {
        with_manifest_lock_async(&checkpoint_id, || async {
            let mut manifest = read_manifest(&checkpoint_id)?;
            let Some(_root) = validate_capture_work_dir_remote(&manifest, &work_dir) else {
                return Ok(());
            };
            if manifest.entries.iter().any(|entry| entry.path == path) {
                return Ok(());
            }
            manifest.entries.push(CheckpointEntry {
                path: path.clone(),
                original: original.clone(),
                expected: None,
            });
            write_manifest(&checkpoint_id, &manifest)
        })
        .await?;
    }
    Ok(())
}

/// 远程版单文件 after 记录（filesystem-replace_edit/create 成功后）。
pub(crate) async fn record_checkpoint_file_after_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    file_path: String,
) -> Result<()> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(());
    }
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;
    let (absolute, path) = resolve_remote_checkpoint_path(&root, &file_path);
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    for checkpoint_id in checkpoint_ids {
        with_manifest_lock_async(&checkpoint_id, || async {
            let mut manifest = read_manifest(&checkpoint_id)?;
            let Some(_root) = validate_capture_work_dir_remote(&manifest, &work_dir) else {
                return Ok(());
            };
            if update_expected_state_remote(client, &mut manifest, &absolute, &path).await? {
                write_manifest(&checkpoint_id, &manifest)?;
            }
            Ok(())
        })
        .await?;
    }
    // 无条件解除"正在追捕"登记，并保留变更归属供并行 bash 全树对比判定。
    register_file_capture_end(&work_dir, &path);
    Ok(())
}

/// 远程版变更列表（回滚确认对话框）：只对追踪条目做批量 stat + 共享内容
/// 读取，不再全树扫描。
pub(crate) async fn list_checkpoint_changes_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_id: String,
    work_dir: String,
) -> Result<Vec<CheckpointFileChange>> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;
    let manifest_lock = manifest_lock(&checkpoint_id)?;
    let _manifest_guard = manifest_lock.lock().await;
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    validate_manifest_work_dir_remote(&manifest, &work_dir)?;

    let tracked: Vec<CheckpointEntry> = manifest
        .entries
        .iter()
        .filter(|entry| !should_skip_manifest_path(&entry.path) && entry.expected.is_some())
        .cloned()
        .collect();
    if tracked.is_empty() {
        return Ok(Vec::new());
    }
    // states_match（expected）与 classify（original）都可能需要内容对比。
    let mut compare_states: Vec<(usize, OriginalState)> = Vec::new();
    for (index, entry) in tracked.iter().enumerate() {
        if let Some(expected) = entry.expected.as_ref() {
            compare_states.push((index, expected.clone()));
        }
        compare_states.push((index, entry.original.clone()));
    }
    let probed = probe_tracked_entries(client, &root, tracked, &compare_states, false).await?;

    let mut changes = Vec::new();
    for probe in &probed.items {
        let expected = probe.entry.expected.as_ref().ok_or_else(|| {
            Error::from_reason("Checkpoint entry lost its expected state during probe")
        })?;
        let expected_differs = classify_remote_state(
            probe.stat.as_ref(),
            probe.content.as_ref().map(|content| content.as_deref()),
            expected,
            &probed.objects,
            &probe.entry.path,
        )?
        .is_some();
        if expected_differs {
            continue;
        }
        if let Some(change_type) = classify_remote_state(
            probe.stat.as_ref(),
            probe.content.as_ref().map(|content| content.as_deref()),
            &probe.entry.original,
            &probed.objects,
            &probe.entry.path,
        )? {
            changes.push(CheckpointFileChange {
                path: probe.entry.path.clone(),
                change_type,
            });
        }
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

/// 远程版 diff 列表（回滚预览 / 文件变更面板）：只对追踪条目做批量
/// stat + 批量内容读取，不再全树扫描。
pub(crate) async fn list_checkpoint_diffs_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_id: String,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileDiff>> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;
    let manifest_lock = manifest_lock(&checkpoint_id)?;
    let _manifest_guard = manifest_lock.lock().await;
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    validate_manifest_work_dir_remote(&manifest, &work_dir)?;

    let tracked: Vec<CheckpointEntry> = manifest
        .entries
        .iter()
        .filter(|entry| !should_skip_manifest_path(&entry.path) && entry.expected.is_some())
        .cloned()
        .collect();
    if tracked.is_empty() {
        return Ok(Vec::new());
    }
    // !include_all 时先用 expected 过滤（回滚预览语义）；original 对比恒定需要。
    let mut compare_states: Vec<(usize, OriginalState)> = Vec::new();
    for (index, entry) in tracked.iter().enumerate() {
        if !include_all {
            if let Some(expected) = entry.expected.as_ref() {
                compare_states.push((index, expected.clone()));
            }
        }
        compare_states.push((index, entry.original.clone()));
    }
    let probed = probe_tracked_entries(client, &root, tracked, &compare_states, true).await?;

    let mut diffs = Vec::new();
    for probe in &probed.items {
        if !include_all {
            let expected = probe.entry.expected.as_ref().ok_or_else(|| {
                Error::from_reason("Checkpoint entry lost its expected state during probe")
            })?;
            let expected_differs = classify_remote_state(
                probe.stat.as_ref(),
                probe.content.as_ref().map(|content| content.as_deref()),
                expected,
                &probed.objects,
                &probe.entry.path,
            )?
            .is_some();
            if expected_differs {
                continue;
            }
        }
        let Some(change_type) = classify_remote_state(
            probe.stat.as_ref(),
            probe.content.as_ref().map(|content| content.as_deref()),
            &probe.entry.original,
            &probed.objects,
            &probe.entry.path,
        )?
        else {
            continue;
        };

        // 进程内 diff 缓存：original 摘要 + 远程 mtime/size 未变时复用。
        let cache_key = format!("{}:{}", checkpoint_id, probe.entry.path);
        let digest = super::original_digest(
            &probe.entry.original,
            manifest.git.as_ref(),
            &probe.entry.path,
        );
        let cached = {
            let cache = super::diff_cache();
            cache.get(&cache_key).and_then(|cached_entry| {
                let stat = probe.stat.as_ref()?;
                (cached_entry.original_digest == digest
                    && cached_entry.current_mtime_ms == stat.mtime_ms
                    && cached_entry.current_size == stat.size)
                    .then_some((cached_entry.content.clone(), cached_entry.is_binary))
            })
        };
        let (content, is_binary) = match cached {
            Some((content, is_binary)) => (content, is_binary),
            None => {
                let original_content = super::read_original_content(
                    &probe.entry.original,
                    manifest.git.as_ref(),
                    &probe.entry.path,
                )?;
                let current_content = probe
                    .stat
                    .as_ref()
                    .and_then(|_| probe.content.as_ref())
                    .and_then(|content| content.clone());
                let (content, is_binary) = super::build_unified_diff(
                    &probe.entry.path,
                    original_content.as_deref(),
                    current_content.as_deref(),
                );
                let mut cache = super::diff_cache();
                if cache.len() >= DIFF_CACHE_MAX_ENTRIES {
                    cache.clear();
                }
                cache.insert(
                    cache_key,
                    CachedCheckpointDiff {
                        original_digest: digest,
                        current_mtime_ms: probe.stat.as_ref().map(|stat| stat.mtime_ms).unwrap_or(0),
                        current_size: probe.stat.as_ref().map(|stat| stat.size).unwrap_or(0),
                        content: content.clone(),
                        is_binary,
                    },
                );
                (content, is_binary)
            }
        };
        diffs.push(CheckpointFileDiff {
            path: probe.entry.path.clone(),
            change_type,
            content,
            is_binary,
        });
    }
    diffs.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(diffs)
}

pub(crate) async fn list_checkpoint_diffs_batch_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileDiff>> {
    let mut seen_paths = HashSet::new();
    let mut diffs = Vec::new();
    for checkpoint_id in checkpoint_ids {
        if !checkpoint_manifest_exists(&checkpoint_id) {
            continue;
        }
        for diff in
            list_checkpoint_diffs_remote(client, checkpoint_id, work_dir.clone(), include_all).await?
        {
            if seen_paths.insert(diff.path.clone()) {
                diffs.push(diff);
            }
        }
    }
    Ok(diffs)
}

pub(crate) async fn list_checkpoint_changes_batch_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileChange>> {
    Ok(
        list_checkpoint_diffs_batch_remote(client, checkpoint_ids, work_dir, include_all)
            .await?
            .into_iter()
            .map(|diff| CheckpointFileChange {
                path: diff.path,
                change_type: diff.change_type,
            })
            .collect(),
    )
}

/// 远程版回滚：把工作区恢复到 checkpoint 记录的 pre-change 状态.
/// 只探测追踪条目（批量 stat + 共享内容读取），不再全树扫描。
pub(crate) async fn restore_checkpoint_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_id: String,
    work_dir: String,
) -> Result<()> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_write_guard_async(&work_dir_lock).await;
    let manifest_lock = manifest_lock(&checkpoint_id)?;
    let _manifest_guard = manifest_lock.lock().await;
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    validate_manifest_work_dir_remote(&manifest, &work_dir)?;
    // 递增回滚纪元：此刻起该远程目录上正在运行的 bash 命令的 after 捕获
    // 会检测到工作树被回滚改写并跳过变更记录，防止跨会话误记。
    bump_restore_epoch(&work_dir)?;

    // 当前树 stat：只恢复仍处于 expected 状态的文件（与本地一致）。
    let tracked: Vec<CheckpointEntry> = manifest
        .entries
        .iter()
        .filter(|entry| !should_skip_manifest_path(&entry.path) && entry.expected.is_some())
        .cloned()
        .collect();
    let mut restored_entries = Vec::new();
    if !tracked.is_empty() {
        let compare_states: Vec<(usize, OriginalState)> = tracked
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                entry.expected.as_ref().map(|expected| (index, expected.clone()))
            })
            .collect();
        let probed = probe_tracked_entries(client, &root, tracked, &compare_states, false).await?;
        for probe in &probed.items {
            let expected = probe.entry.expected.as_ref().ok_or_else(|| {
                Error::from_reason("Checkpoint entry lost its expected state during probe")
            })?;
            let expected_differs = classify_remote_state(
                probe.stat.as_ref(),
                probe.content.as_ref().map(|content| content.as_deref()),
                expected,
                &probed.objects,
                &probe.entry.path,
            )?
            .is_some();
            if expected_differs {
                continue;
            }
            let destination = resolve_remote_manifest_path(&root, &probe.entry.path);
            restore_entry_remote(client, &probe.entry, &destination).await?;
            restored_entries.push(probe.entry.path.clone());
        }
    }
    prune_empty_parent_directories_remote(client, &root, &restored_entries).await?;
    Ok(())
}

pub(crate) async fn restore_checkpoints_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
) -> Result<()> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_write_guard_async(&work_dir_lock).await;
    bump_restore_epoch(&work_dir)?;

    let mut restored_entries = Vec::new();
    for checkpoint_id in checkpoint_ids.into_iter().rev() {
        let manifest_lock = manifest_lock(&checkpoint_id)?;
        let _manifest_guard = manifest_lock.lock().await;
        if !checkpoint_manifest_exists(&checkpoint_id) {
            continue;
        }
        let manifest = read_manifest(&checkpoint_id)?;
        validate_manifest_work_dir_remote(&manifest, &work_dir)?;
        let tracked: Vec<CheckpointEntry> = manifest
            .entries
            .iter()
            .filter(|entry| !should_skip_manifest_path(&entry.path) && entry.expected.is_some())
            .cloned()
            .collect();
        if tracked.is_empty() {
            continue;
        }
        let compare_states: Vec<(usize, OriginalState)> = tracked
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                entry.expected.as_ref().map(|expected| (index, expected.clone()))
            })
            .collect();
        let probed = probe_tracked_entries(client, &root, tracked, &compare_states, false).await?;
        for probe in &probed.items {
            let expected = probe.entry.expected.as_ref().ok_or_else(|| {
                Error::from_reason("Checkpoint entry lost its expected state during probe")
            })?;
            let expected_differs = classify_remote_state(
                probe.stat.as_ref(),
                probe.content.as_ref().map(|content| content.as_deref()),
                expected,
                &probed.objects,
                &probe.entry.path,
            )?
            .is_some();
            if expected_differs {
                continue;
            }
            let destination = resolve_remote_manifest_path(&root, &probe.entry.path);
            restore_entry_remote(client, &probe.entry, &destination).await?;
            restored_entries.push(probe.entry.path.clone());
        }
    }
    prune_empty_parent_directories_remote(client, &root, &restored_entries).await
}

async fn restore_entry_remote(
    client: &RemoteCheckpointClient<'_>,
    entry: &CheckpointEntry,
    destination: &str,
) -> Result<()> {
    match &entry.original {
        OriginalState::Missing => client.delete_file(destination).await,
        OriginalState::Object { object_id } => {
            let source = checkpoint_root()?.join(OBJECT_DIR_NAME).join(object_id);
            let content = fs::read(&source).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to read checkpoint object '{}': {error}",
                    source.display()
                ))
            })?;
            client.write_bytes(destination, &content).await
        }
        OriginalState::Git => Err(Error::from_reason(
            "Checkpoint Git baseline is missing",
        )),
    }
}

/// 回滚后清理空父目录（最深优先，与本地 prune_empty_parent_directories 一致）。
async fn prune_empty_parent_directories_remote(
    client: &RemoteCheckpointClient<'_>,
    root: &str,
    restored_entries: &[String],
) -> Result<()> {
    let mut directories: Vec<String> = restored_entries
        .iter()
        .filter_map(|path| {
            path.rfind('/')
                .map(|index| path[..index].to_string())
                .filter(|parent| !parent.is_empty())
        })
        .collect();
    directories.sort_by_key(|directory| std::cmp::Reverse(directory.matches('/').count()));
    directories.dedup();
    let root_uri = root.trim_end_matches('/');
    for directory in directories {
        let mut current = format!("{root_uri}/{directory}");
        loop {
            if current == root_uri || !current.starts_with(&format!("{root_uri}/")) {
                break;
            }
            if !client.remove_dir(&current).await? {
                break;
            }
            let Some(parent) = current.rfind('/') else {
                break;
            };
            current = current[..parent].to_string();
            if current.len() <= root_uri.len() {
                break;
            }
        }
    }
    Ok(())
}

/// 远程版创建 checkpoint：校验远程工作区存在后仅发布本地 manifest
/// （内容在工具执行前后按需捕获，与本地增量语义一致）。
pub(crate) async fn create_checkpoint_remote(
    client: &RemoteCheckpointClient<'_>,
    work_dir: String,
) -> Result<String> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let checkpoint_id = super::generate_checkpoint_id();
    with_manifest_lock_async(&checkpoint_id, || async {
        let manifest = CheckpointManifest {
            version: super::MANIFEST_VERSION,
            work_dir: root,
            git: None,
            entries: Vec::new(),
        };
        write_manifest(&checkpoint_id, &manifest)?;
        Ok(checkpoint_id.clone())
    })
    .await
}
