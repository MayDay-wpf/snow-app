//! SSH 工作区的 checkpoint 远程访问层。
//!
//! 本地 checkpoint 用 `std::fs` 直接访问工作区；SSH 工作区（`ssh://` URI）
//! 的文件由 Electron 主进程通过 SSH 访问，Rust 侧无法直接 IO。本模块把
//! checkpoint 需要的远程操作封装为通过 `RemoteWorkspaceCallback` 转发给
//! Electron 的异步命令。
//!
//! 存储布局：manifest（只含路径与哈希）仍保存在本机，文件内容对象保存在
//! 远程主机的 `~/.snowapp/checkpoints/objects`（SHA-256 内容寻址）。哈希、
//! 入库、比对与恢复都由远程 shell 完成，网络上只传路径与哈希；只有查看
//! diff 时才按需读取单个文件内容。旧版 SSH 检查点的对象仍在本机对象库
//! （BLAKE3），比对时按内容换算 SHA-256，恢复时从本机上传。
//!
//! 远程主机需要 POSIX sh 与 sha256sum / shasum：不满足时不再为该主机创建
//! 检查点，并在 bash 输出中提醒用户安装。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::remote_host::{
    execute_remote_workspace_command, global_remote_callback, is_ssh_path,
    RemoteWorkspaceCallback,
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

/// checkpoint-read-file-with-stat 的读取结果（diff 查看当前文件内容）。
struct RemoteFileSnapshot {
    /// 文件内容；不存在或为目录时为 None。
    content: Option<Vec<u8>>,
    /// 文件超过调用方给定的读取上限，内容未传输。
    too_large: bool,
}

/// 远程批量哈希的单个结果（checkpoint-store-files）。
#[derive(Clone, Debug)]
enum RemoteHashResult {
    /// 常规文件及其 SHA-256（入库模式下对象已存在于远程对象库）。
    File(String),
    Missing,
    Directory,
    /// 未能取得哈希或入库失败（权限不足、文件名含哈希工具转义字符等）。
    Failed,
}

/// 远程对象库能力探测结果（checkpoint-store-probe）。
struct RemoteStoreProbe {
    supported: bool,
    missing: Vec<String>,
    reason: Option<String>,
}

/// 远程对象库中对象的读取结果（checkpoint-store-read）：content 为 None 且
/// 未超限表示对象不存在。
struct RemoteObjectContent {
    too_large: bool,
    content: Option<Vec<u8>>,
}

/// 远程批量恢复的单个操作（checkpoint-store-restore），按顺序执行。
enum RemoteRestoreOp {
    /// 从远程对象库复制对象到目标路径。
    Copy { path: String, object_id: String },
    /// 删除目标文件（不存在视为成功）。
    Remove { path: String },
    /// 尝试删除空目录（失败忽略，不回报结果）。
    RemoveDir { path: String },
}

/// 远程批量恢复的单个结果。
struct RemoteRestoreResult {
    path: String,
    status: String,
    reason: Option<String>,
}

/// 批量 stat 每次命令的路径上限。
const STAT_BATCH_MAX_PATHS: usize = 512;

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

    /// stat + 读内容合并为一次往返（diff 查看当前文件内容）。超过
    /// `max_bytes` 的文件只回元数据（too_large），内容不传输。
    async fn read_file_with_stat(&self, path: &str, max_bytes: u64) -> Result<RemoteFileSnapshot> {
        let result = self
            .run(
                "checkpoint-read-file-with-stat",
                json!({ "path": path, "maxBytes": max_bytes }),
            )
            .await?;
        let exists = result.get("exists").and_then(Value::as_bool).unwrap_or(false);
        let is_directory = result
            .get("isDirectory")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !exists || is_directory {
            return Ok(RemoteFileSnapshot {
                content: None,
                too_large: false,
            });
        }
        Ok(RemoteFileSnapshot {
            content: decode_base64_field(&result, "content")?,
            too_large: result
                .get("tooLarge")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// 远程对象库能力探测：POSIX sh、sha256sum/shasum 与基础命令是否齐全。
    async fn probe_store(&self, root: &str) -> Result<RemoteStoreProbe> {
        let result = self
            .run("checkpoint-store-probe", json!({ "path": root }))
            .await?;
        let missing = result
            .get("missing")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Ok(RemoteStoreProbe {
            supported: result
                .get("supported")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            missing,
            reason: result
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// 远程批量计算 SHA-256；`store` 为 true 时同时把内容写入远程对象库。
    /// 一次命令往返完成全部路径（路径经 stdin 传给远程脚本）。
    async fn hash_files(
        &self,
        paths: &[String],
        store: bool,
    ) -> Result<HashMap<String, RemoteHashResult>> {
        let mut hashes = HashMap::new();
        if paths.is_empty() {
            return Ok(hashes);
        }
        let response = self
            .run(
                "checkpoint-store-files",
                json!({ "paths": paths, "store": store }),
            )
            .await?;
        let Some(results) = response.get("results").and_then(Value::as_object) else {
            return Ok(hashes);
        };
        for (path, item) in results {
            let hash = item.get("hash").and_then(Value::as_str);
            let parsed = match (item.get("kind").and_then(Value::as_str), hash) {
                (Some("file"), Some(hash)) => RemoteHashResult::File(hash.to_string()),
                (Some("missing"), _) => RemoteHashResult::Missing,
                (Some("directory"), _) => RemoteHashResult::Directory,
                _ => RemoteHashResult::Failed,
            };
            hashes.insert(path.clone(), parsed);
        }
        Ok(hashes)
    }

    /// 读取远程对象库中的对象（diff 查看 original 内容）。`host_path` 为对象
    /// 所在主机上的任一 ssh:// 路径；超过 `max_bytes` 只回元数据。
    async fn read_object(
        &self,
        host_path: &str,
        object_id: &str,
        max_bytes: u64,
    ) -> Result<RemoteObjectContent> {
        let result = self
            .run(
                "checkpoint-store-read",
                json!({ "path": host_path, "objectId": object_id, "maxBytes": max_bytes }),
            )
            .await?;
        Ok(RemoteObjectContent {
            too_large: result
                .get("tooLarge")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            content: decode_base64_field(&result, "content")?,
        })
    }

    /// 远程批量恢复：同一主机的操作合并为一次远程脚本调用，按顺序执行。
    async fn restore_batch(&self, ops: &[RemoteRestoreOp]) -> Result<Vec<RemoteRestoreResult>> {
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        let payload: Vec<Value> = ops
            .iter()
            .map(|op| match op {
                RemoteRestoreOp::Copy { path, object_id } => {
                    json!({ "kind": "copy", "path": path, "objectId": object_id })
                }
                RemoteRestoreOp::Remove { path } => json!({ "kind": "remove", "path": path }),
                RemoteRestoreOp::RemoveDir { path } => json!({ "kind": "rmdir", "path": path }),
            })
            .collect();
        let response = self
            .run("checkpoint-store-restore", json!({ "ops": payload }))
            .await?;
        Ok(response
            .get("results")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(RemoteRestoreResult {
                            path: item.get("path")?.as_str()?.to_string(),
                            status: item.get("status")?.as_str()?.to_string(),
                            reason: item
                                .get("reason")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// 清理远程对象库：删除超过保留期且不在 `keep` 中的对象。
    async fn sweep_store(&self, host_path: &str, keep: &[String], retention_days: u64) -> Result<()> {
        self.run(
            "checkpoint-store-sweep",
            json!({ "path": host_path, "keep": keep, "retentionDays": retention_days }),
        )
        .await?;
        Ok(())
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

/// 解码响应中的 base64 内容字段；字段缺失或为 null 时返回 None。
fn decode_base64_field(result: &Value, field: &str) -> Result<Option<Vec<u8>>> {
    let Some(encoded) = result.get(field).and_then(Value::as_str) else {
        return Ok(None);
    };
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map(Some)
        .map_err(|error| {
            Error::from_reason(format!(
                "Failed to decode remote checkpoint content: {error}"
            ))
        })
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
// 远程（SSH）checkpoint 流程：与 mod.rs 的本地实现一一对应。manifest 读写、
// 链式合并与锁复用本地实现；文件内容的哈希、入库、比对与恢复交给远程
// 对象库（RemoteCheckpointClient 的 store 系列命令）。
// ============================================================================

use super::diff_view::{
    build_plan, cached_plan, compute_stats, diff_revision, render_page, store_plan,
    too_large_page, CheckpointDiffPage, CheckpointFileSummary, DiffStats, LineSource,
    REMOTE_DIFF_CONTENT_LIMIT,
};
use super::{
    bump_restore_epoch, cached_stats, change_owned_by_other_capture, checkpoint_manifest_exists,
    checkpoint_operation_lock, current_restore_epoch, filter_existing_checkpoints,
    fingerprint_lookup, fingerprint_store, manifest_lock, manifest_merge_key,
    merge_chained_manifests, object_path, original_digest, original_line_source,
    original_object_id, pending_state_to_original, read_manifest, register_file_capture_end,
    register_file_capture_start, register_recorded_change, should_skip_manifest_path,
    should_skip_relative, store_cached_stats, work_dir_lock, work_dir_read_guard_async,
    work_dir_write_guard_async, write_manifest, CachedCheckpointDiff, ChainedEntry,
    CheckpointEntry, CheckpointFileChange, CheckpointManifest, CheckpointWorktreeCapture,
    OriginalState, PendingFileState,
};

use crate::checkpoint_skip::{
    should_skip_pending_copy_size, PENDING_COPY_SIZE_LIMIT,
};

/// 不支持对象库的主机缓存多久后重新探测：用户安装工具后无需重启即可恢复。
const REMOTE_STORE_UNSUPPORTED_TTL: Duration = Duration::from_secs(60);

struct RemoteStoreSupport {
    checked_at: Instant,
    /// None 表示支持；Some 为缺失工具（或不支持原因）的展示文本。
    unavailable: Option<String>,
    /// 本进程是否已在 bash 输出中提醒过该主机。
    reminded: bool,
}

/// 远程对象库能力缓存：key 为 SSH authority（user@host:port）。
static REMOTE_STORE_SUPPORT: OnceLock<Mutex<HashMap<String, RemoteStoreSupport>>> =
    OnceLock::new();

fn remote_store_support() -> std::sync::MutexGuard<'static, HashMap<String, RemoteStoreSupport>> {
    REMOTE_STORE_SUPPORT
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn ssh_host_key(uri: &str) -> Option<String> {
    split_ssh_uri(uri).map(|(authority, _)| authority)
}

fn remote_store_unavailable_error(text: &str) -> Error {
    Error::from_reason(format!(
        "Remote host is missing tools required for SSH checkpoints: {text}"
    ))
}

/// 确认远程主机可以承载检查点对象库（POSIX sh + sha256sum/shasum + 基础
/// 命令）。支持的主机在进程内长期缓存；不支持时返回列出缺失工具的错误。
async fn ensure_remote_store(client: &RemoteCheckpointClient<'_>, root: &str) -> Result<()> {
    let host = ssh_host_key(root)
        .ok_or_else(|| Error::from_reason(format!("Invalid SSH working directory: {root}")))?;
    {
        let cache = remote_store_support();
        if let Some(support) = cache.get(&host) {
            match &support.unavailable {
                None => return Ok(()),
                Some(text) if support.checked_at.elapsed() < REMOTE_STORE_UNSUPPORTED_TTL => {
                    return Err(remote_store_unavailable_error(text));
                }
                Some(_) => {}
            }
        }
    }
    let probe = client.probe_store(root).await?;
    let unavailable = (!probe.supported).then(|| {
        if probe.missing.is_empty() {
            probe.reason.clone().unwrap_or_else(|| "sh".to_string())
        } else {
            probe.missing.join(", ")
        }
    });
    let mut cache = remote_store_support();
    let reminded = cache.get(&host).is_some_and(|support| support.reminded);
    cache.insert(
        host,
        RemoteStoreSupport {
            checked_at: Instant::now(),
            unavailable: unavailable.clone(),
            reminded,
        },
    );
    match unavailable {
        None => Ok(()),
        Some(text) => Err(remote_store_unavailable_error(&text)),
    }
}

/// bash 工具的安装提醒：该主机因缺少工具停用了检查点、且本进程尚未提醒
/// 过时，返回缺失工具文本并标记为已提醒。
pub fn take_remote_store_reminder(work_dir: &str) -> Option<String> {
    let host = ssh_host_key(work_dir.trim())?;
    let mut cache = remote_store_support();
    let support = cache.get_mut(&host)?;
    let text = support.unavailable.clone()?;
    if support.reminded {
        return None;
    }
    support.reminded = true;
    Some(text)
}

/// 本进程已清理过远程对象库的主机。
static REMOTE_SWEPT_HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// 每个主机每次运行最多清理一次远程对象库（首次为该主机创建检查点后在
/// 后台进行）。保留集合为本机全部 manifest 引用的对象与指纹缓存中尚未
/// 写入 manifest 的对象，且只删除超过保留期的对象。
fn schedule_remote_store_sweep(root: &str) {
    let Some(host) = ssh_host_key(root) else {
        return;
    };
    {
        let mut swept = REMOTE_SWEPT_HOSTS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !swept.insert(host) {
            return;
        }
    }
    let Some(callback) = global_remote_callback() else {
        return;
    };
    let host_path = root.to_string();
    tokio::spawn(async move {
        let (keep, retention_days) =
            match tokio::task::spawn_blocking(super::gc::remote_sweep_inputs).await {
                Ok(Ok(inputs)) => inputs,
                Ok(Err(error)) => {
                    eprintln!("[checkpoint] Remote object sweep skipped: {error}");
                    return;
                }
                Err(error) => {
                    eprintln!("[checkpoint] Remote object sweep skipped: {error}");
                    return;
                }
            };
        let client = RemoteCheckpointClient::new(&callback);
        if let Err(error) = client.sweep_store(&host_path, &keep, retention_days).await {
            eprintln!("[checkpoint] Remote object sweep failed for '{host_path}': {error}");
        }
    });
}

/// 对象所在位置：旧版 SSH 检查点的对象在本机对象库（BLAKE3），新版在远程
/// 主机对象库（SHA-256）。两者 id 都是 64 位十六进制，以本机对象文件是否
/// 存在区分（本机旧对象被回收后按远程处理，结果同样是「对象缺失」）。
enum ObjectLocation {
    Local(PathBuf),
    Remote,
}

fn locate_object(object_id: &str) -> Result<ObjectLocation> {
    let path = object_path(object_id)?;
    Ok(if path.is_file() {
        ObjectLocation::Local(path)
    } else {
        ObjectLocation::Remote
    })
}

/// 本机旧对象的 SHA-256 缓存：对象内容寻址，换算结果不会变化。
static LEGACY_OBJECT_DIGESTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
const LEGACY_OBJECT_DIGESTS_MAX_ENTRIES: usize = 10_000;

fn legacy_object_digests() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    LEGACY_OBJECT_DIGESTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};

    let mut file = std::fs::File::open(path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read checkpoint object '{}': {error}",
            path.display()
        ))
    })?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| {
        Error::from_reason(format!(
            "Failed to hash checkpoint object '{}': {error}",
            path.display()
        ))
    })?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// 对象的远程比对指纹（SHA-256）：远程对象的 id 即指纹；本机旧对象按内容
/// 换算 SHA-256（后台线程计算并缓存）。
async fn object_digest(object_id: &str) -> Result<String> {
    let ObjectLocation::Local(path) = locate_object(object_id)? else {
        return Ok(object_id.to_string());
    };
    if let Some(digest) = legacy_object_digests().get(object_id).cloned() {
        return Ok(digest);
    }
    let digest = tokio::task::spawn_blocking(move || sha256_file(&path))
        .await
        .map_err(join_error)??;
    let mut cache = legacy_object_digests();
    if cache.len() >= LEGACY_OBJECT_DIGESTS_MAX_ENTRIES {
        cache.clear();
    }
    cache.insert(object_id.to_string(), digest.clone());
    Ok(digest)
}

/// 批量求对象的比对指纹：key 为对象 id（参数为已收集好的 id，避免把借用
/// 迭代器带过 await 点）。
async fn object_digests(object_ids: Vec<String>) -> Result<HashMap<String, String>> {
    let mut digests = HashMap::new();
    for object_id in object_ids {
        if !digests.contains_key(&object_id) {
            let digest = object_digest(&object_id).await?;
            digests.insert(object_id, digest);
        }
    }
    Ok(digests)
}

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
) -> crate::gitignore::GitignoreMatcher {
    let mut sorted: Vec<&RemoteGitignore> = gitignores.iter().collect();
    sorted.sort_by_key(|gitignore| gitignore.dir.matches('/').count());
    let root_content = sorted
        .iter()
        .find(|gitignore| gitignore.dir.is_empty())
        .map(|gitignore| gitignore.content.as_str());
    let mut matcher =
        crate::gitignore::GitignoreMatcher::from_root_content(root_content);
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
    matcher: &crate::gitignore::GitignoreMatcher,
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
/// 使用本函数，保证 before/after 捕获与变更/回滚检测的过滤语义一致
/// （仓库 Wiki 的远程只读视图同样复用）。
pub async fn filter_remote_tree(
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

/// 远程文件当前状态（Missing / Object），内容同时写入远程对象库。与本地
/// current_state 对齐：内容无条件入库（不应用大小/扩展名跳过）。
async fn current_state_remote(
    client: &RemoteCheckpointClient<'_>,
    path: &str,
) -> Result<OriginalState> {
    let mut results = client.hash_files(&[path.to_string()], true).await?;
    match results.remove(path) {
        Some(RemoteHashResult::File(object_id)) => Ok(OriginalState::Object { object_id }),
        Some(RemoteHashResult::Missing) => Ok(OriginalState::Missing),
        Some(RemoteHashResult::Directory) => Err(Error::from_reason(format!(
            "Checkpoint path is not a regular file: {path}"
        ))),
        Some(RemoteHashResult::Failed) | None => Err(Error::from_reason(format!(
            "Failed to capture remote checkpoint content for '{path}'"
        ))),
    }
}

/// 对比当前远程状态与记录状态，返回变更类型（None 表示一致）。`digests`
/// 为记录状态对象的 SHA-256 比对指纹（见 object_digests）。
fn classify_remote_state(
    current: &RemoteHashResult,
    state: &OriginalState,
    digests: &HashMap<String, String>,
    relative: &str,
) -> Result<Option<String>> {
    match state {
        OriginalState::Missing => Ok((!matches!(current, RemoteHashResult::Missing))
            .then(|| "added".to_string())),
        OriginalState::Object { object_id } => Ok(match current {
            RemoteHashResult::Missing => Some("deleted".to_string()),
            RemoteHashResult::File(hash) => {
                (digests.get(object_id) != Some(hash)).then(|| "modified".to_string())
            }
            RemoteHashResult::Directory | RemoteHashResult::Failed => Some("modified".to_string()),
        }),
        OriginalState::Git => Err(Error::from_reason(format!(
            "Checkpoint Git baseline is missing for '{relative}'"
        ))),
    }
}

/// 追踪条目的远程探测结果：批量 stat（diff 缓存键使用）+ 远程哈希。
struct EntryProbe {
    entry: CheckpointEntry,
    stat: Option<RemoteFileStat>,
    current: RemoteHashResult,
}

struct ProbedEntries {
    items: Vec<EntryProbe>,
    /// 条目 original / expected 对象的比对指纹。
    digests: HashMap<String, String>,
}

/// 探测追踪条目的当前状态：批量 stat 与远程批量哈希并发进行，文件内容不经
/// 网络传输；对象比对指纹在本机求得（远程对象即 id，本机旧对象换算）。
async fn probe_tracked_entries(
    client: &RemoteCheckpointClient<'_>,
    root: &str,
    entries: Vec<CheckpointEntry>,
) -> Result<ProbedEntries> {
    let absolute_paths: Vec<String> = entries
        .iter()
        .map(|entry| resolve_remote_manifest_path(root, &entry.path))
        .collect();
    let (stats, mut hashes) = tokio::try_join!(
        client.stat_paths(&absolute_paths),
        client.hash_files(&absolute_paths, false),
    )?;
    let object_ids: Vec<String> = entries
        .iter()
        .flat_map(|entry| std::iter::once(&entry.original).chain(entry.expected.as_ref()))
        .filter_map(original_object_id)
        .collect();
    let digests = object_digests(object_ids).await?;
    let items = entries
        .into_iter()
        .zip(absolute_paths)
        .map(|(entry, absolute)| EntryProbe {
            stat: stats.get(&absolute).cloned(),
            current: hashes.remove(&absolute).unwrap_or(RemoteHashResult::Failed),
            entry,
        })
        .collect();
    Ok(ProbedEntries { items, digests })
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
/// 缓存（mtime+size）零内容 IO；未命中文件由远程一次性批量计算哈希并写入
/// 远程对象库（内容不经网络传输），回写指纹缓存。
pub async fn capture_checkpoint_worktree_before_remote(
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

    let object_guard = super::gc::object_writer_guard();
    let tree = filter_remote_tree(client, &root).await?;
    let mut before_paths = HashSet::new();
    let mut before_states = HashMap::new();
    // 未命中指纹缓存、需要远程入库的文件（relative, absolute, mtime, size）。
    let mut pending_stores: Vec<(String, String, u64, u64)> = Vec::new();
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
        pending_stores.push((
            relative.clone(),
            resolve_remote_manifest_path(&root, relative),
            entry.mtime_ms,
            entry.size,
        ));
    }

    let store_paths: Vec<String> = pending_stores
        .iter()
        .map(|(_, absolute, _, _)| absolute.clone())
        .collect();
    let mut hashes = client.hash_files(&store_paths, true).await?;
    for (relative, absolute, mtime_ms, size) in pending_stores {
        let state = match hashes.remove(&absolute) {
            Some(RemoteHashResult::File(object_id)) => {
                fingerprint_store(&work_dir, &relative, mtime_ms, size, object_id.clone());
                PendingFileState {
                    object_id: Some(object_id),
                    skipped: false,
                    mtime_ms,
                    size,
                }
            }
            // 扫描后被删除：不记录状态（与旧版一致，保留在 before_paths）。
            Some(RemoteHashResult::Missing) => continue,
            // 无法入库：命令前内容不可恢复，after 阶段跳过该文件。
            _ => PendingFileState {
                object_id: None,
                skipped: true,
                mtime_ms,
                size,
            },
        };
        before_states.insert(relative, state);
    }

    Ok(Some(CheckpointWorktreeCapture {
        // 先求值再移动 work_dir 字段。
        restore_epoch: current_restore_epoch(&work_dir)?,
        checkpoint_ids,
        work_dir,
        before_paths,
        before_states,
        _object_guard: object_guard,
    }))
}

/// 远程版 after 记录：一次 list-tree 得到命令后的树，与 before 指纹对比。
/// 变更判定与 expected 入库在锁外由远程**一次性批量**完成；各 checkpoint
/// 的 manifest 更新只做本地读写，不再逐 checkpoint 重复远程 IO。
pub async fn record_checkpoint_worktree_after_remote(
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

    // ---- 本地按元数据筛选：删除的文件直接得到变更；元数据变化（含新建）
    // 的文件交给远程一次性哈希并入库，同时得到命令后内容 id（expected），
    // 也弥补远程 mtime 精度不足导致的同秒改写漏检（以内容哈希为准）。----
    let mut observed: Vec<(String, OriginalState, OriginalState)> = Vec::new();
    let mut hash_targets: Vec<String> = Vec::new();
    for relative_path in &candidates {
        if should_skip_relative(Path::new(relative_path)) {
            continue;
        }
        let before_state = capture.before_states.get(relative_path);
        match (before_state, after_stats.get(relative_path)) {
            // 内容抓取被跳过：无法恢复命令前内容，不记录变更。
            (Some(state), _) if state.skipped => {}
            (Some(state), None) => observed.push((
                relative_path.clone(),
                pending_state_to_original(state)?,
                OriginalState::Missing,
            )),
            // 命令后超过内容抓取上限（由小变大或新建大文件）：与 before 侧
            // 一致不记录（不可回滚）。
            (_, Some(stat)) if stat.size > PENDING_COPY_SIZE_LIMIT => {}
            (Some(state), Some(stat))
                if stat.mtime_ms == state.mtime_ms && stat.size == state.size => {}
            (_, Some(_)) => hash_targets.push(relative_path.clone()),
            (None, None) => {}
        }
    }

    // ---- 远程阶段：一次命令完成全部候选文件的哈希与入库 ----
    let target_paths: Vec<String> = hash_targets
        .iter()
        .map(|relative| resolve_remote_manifest_path(&root, relative))
        .collect();
    let mut hashes = client.hash_files(&target_paths, true).await?;
    for (relative, absolute) in hash_targets.into_iter().zip(target_paths) {
        let before_state = capture.before_states.get(&relative);
        let original = match before_state {
            Some(state) => pending_state_to_original(state)?,
            None => OriginalState::Missing,
        };
        match hashes.remove(&absolute) {
            Some(RemoteHashResult::File(object_id)) => {
                let unchanged = before_state
                    .is_some_and(|state| state.object_id.as_deref() == Some(object_id.as_str()));
                if !unchanged {
                    observed.push((relative, original, OriginalState::Object { object_id }));
                }
            }
            // 列树与哈希之间被删除：仅命令前存在的文件构成变更。
            Some(RemoteHashResult::Missing) if before_state.is_some() => {
                observed.push((relative, original, OriginalState::Missing));
            }
            // 目录或无法入库：命令后内容无法记录，跳过（不可回滚）。
            _ => {}
        }
    }

    // 多会话并行防线（与本地一致）：路径已被并行文件工具认领（正在追捕或
    // 已按同一变更起点记录）时跳过，变化归它负责。
    let changes: Vec<(String, OriginalState, OriginalState)> = observed
        .into_iter()
        .filter(|(relative, _, _)| {
            !change_owned_by_other_capture(
                &capture.work_dir,
                relative,
                capture
                    .before_states
                    .get(relative)
                    .and_then(|state| state.object_id.as_deref()),
            )
        })
        .collect();

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
            for (relative, original, expected) in &changes {
                apply_entry_states(
                    &mut manifest,
                    &capture.work_dir,
                    relative,
                    original.clone(),
                    expected.clone(),
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
pub async fn record_checkpoint_file_remote(
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
pub async fn record_checkpoint_file_after_remote(
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

    // 编辑后内容只采样一次（写入远程对象库），各 checkpoint 共享。
    let expected = current_state_remote(client, &absolute).await?;
    for checkpoint_id in checkpoint_ids {
        with_manifest_lock_async(&checkpoint_id, || async {
            let mut manifest = read_manifest(&checkpoint_id)?;
            let Some(_root) = validate_capture_work_dir_remote(&manifest, &work_dir) else {
                return Ok(());
            };
            let Some(entry) = manifest
                .entries
                .iter_mut()
                .find(|entry| entry.path == path)
            else {
                return Ok(());
            };
            entry.expected = Some(expected.clone());
            write_manifest(&checkpoint_id, &manifest)
        })
        .await?;
    }
    // 无条件解除"正在追捕"登记，并保留变更归属供并行 bash 全树对比判定。
    register_file_capture_end(&work_dir, &path);
    Ok(())
}

/// 远程版变更列表（回滚确认对话框）：只探测追踪条目（批量 stat + 远程哈希
/// 比对），不全树扫描，也不传输文件内容。
pub async fn list_checkpoint_changes_remote(
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
    let probed = probe_tracked_entries(client, &root, tracked).await?;

    let mut changes = Vec::new();
    for probe in &probed.items {
        let expected = probe.entry.expected.as_ref().ok_or_else(|| {
            Error::from_reason("Checkpoint entry lost its expected state during probe")
        })?;
        let expected_differs =
            classify_remote_state(&probe.current, expected, &probed.digests, &probe.entry.path)?
                .is_some();
        if expected_differs {
            continue;
        }
        if let Some(change_type) = classify_remote_state(
            &probe.current,
            &probe.entry.original,
            &probed.digests,
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

/// 回滚链上一个已分类的远程条目。
struct ClassifiedRemoteEntry {
    path: String,
    original: OriginalState,
    source_checkpoint_id: String,
    stat: Option<RemoteFileStat>,
    change_type: String,
}

fn join_error(error: tokio::task::JoinError) -> Error {
    Error::from_reason(format!("Checkpoint diff task failed: {error}"))
}

/// 远程文件当前内容的行来源（diff 查看时按需读取）。返回 None 表示超过
/// 传输上限，调用方按 too_large 展示。
async fn remote_current_line_source(
    client: &RemoteCheckpointClient<'_>,
    absolute: &str,
    exists: bool,
) -> Result<Option<LineSource>> {
    if !exists {
        return Ok(Some(LineSource::Missing));
    }
    let snapshot = client
        .read_file_with_stat(absolute, REMOTE_DIFF_CONTENT_LIMIT)
        .await?;
    if snapshot.too_large {
        return Ok(None);
    }
    Ok(Some(
        snapshot
            .content
            .map(|content| LineSource::Bytes(Arc::new(content)))
            .unwrap_or(LineSource::Missing),
    ))
}

/// original 状态的行来源：本机旧对象流式读取；远程对象按需从对象所在主机
/// （`absolute` 为条目在该主机上的路径）的对象库读取。返回 None 表示超过
/// 传输上限。
async fn remote_original_line_source(
    client: &RemoteCheckpointClient<'_>,
    absolute: &str,
    original: &OriginalState,
) -> Result<Option<LineSource>> {
    let OriginalState::Object { object_id } = original else {
        return original_line_source(original).map(Some);
    };
    if let ObjectLocation::Local(path) = locate_object(object_id)? {
        return Ok(Some(LineSource::File(path)));
    }
    let object = client
        .read_object(absolute, object_id, REMOTE_DIFF_CONTENT_LIMIT)
        .await?;
    if object.too_large {
        return Ok(None);
    }
    Ok(Some(match object.content {
        Some(content) => LineSource::Bytes(Arc::new(content)),
        None => {
            eprintln!(
                "[checkpoint] Warning: remote checkpoint object '{object_id}' not found; falling back to None"
            );
            LineSource::Missing
        }
    }))
}

/// 远程版单文件变更统计：original 摘要 + 远程 mtime/size 均未变时复用进程内
/// 缓存。超过传输上限的文件不读取内容，只标记 too_large。
async fn remote_file_stats(
    client: &RemoteCheckpointClient<'_>,
    root: &str,
    entry: &ClassifiedRemoteEntry,
) -> Result<DiffStats> {
    let cache_key = format!("{}:{}", entry.source_checkpoint_id, entry.path);
    let digest = original_digest(&entry.original);
    if let Some(stat) = &entry.stat {
        if let Some(stats) = cached_stats(&cache_key, &digest, stat.mtime_ms, stat.size) {
            return Ok(stats);
        }
        if stat.size > REMOTE_DIFF_CONTENT_LIMIT {
            return Ok(DiffStats::too_large());
        }
    }
    let absolute = resolve_remote_manifest_path(root, &entry.path);
    let (original, current) = tokio::try_join!(
        remote_original_line_source(client, &absolute, &entry.original),
        remote_current_line_source(client, &absolute, entry.stat.is_some()),
    )?;
    let (Some(original), Some(current)) = (original, current) else {
        return Ok(DiffStats::too_large());
    };
    let stats = tokio::task::spawn_blocking(move || compute_stats(&original, &current))
        .await
        .map_err(join_error)??;
    if let Some(stat) = &entry.stat {
        store_cached_stats(
            cache_key,
            CachedCheckpointDiff {
                original_digest: digest,
                current_mtime_ms: stat.mtime_ms,
                current_size: stat.size,
                stats,
            },
        );
    }
    Ok(stats)
}

/// 远程读取回滚链上的 manifest 并合并：与本地 `collect_chained_entries` 共用
/// 同一份合并实现，只有加锁方式不同（异步锁）。调用方必须已持有工作区执行级锁。
async fn collect_chained_entries_remote(
    checkpoint_ids: &[String],
    validate: impl Fn(&CheckpointManifest) -> Result<()>,
) -> Result<Vec<ChainedEntry>> {
    let mut manifests = Vec::new();
    for checkpoint_id in checkpoint_ids {
        if !checkpoint_manifest_exists(checkpoint_id) {
            continue;
        }
        let lock = manifest_lock(checkpoint_id)?;
        let _guard = lock.lock().await;
        let manifest = read_manifest(checkpoint_id)?;
        validate(&manifest)?;
        manifests.push((checkpoint_id.clone(), manifest));
    }
    Ok(merge_chained_manifests(&manifests))
}

/// 链式条目 → 远端探测所需的 CheckpointEntry（expected 即门控状态）。
fn chained_probe_entries(chained: &[ChainedEntry]) -> Vec<CheckpointEntry> {
    chained
        .iter()
        .map(|entry| CheckpointEntry {
            path: entry.path.clone(),
            original: entry.original.clone(),
            expected: Some(entry.expected.clone()),
        })
        .collect()
}

/// 远程版回滚链变更摘要：与本地 `list_checkpoint_summaries_batch` 同语义
/// ——按路径合并整条链（original 取最早、expected 取最新），先新建再编辑的
/// 文件显示为「新增（回滚会删除它）」，与实际恢复结果一致。逐个文件读取
/// 内容统计增删行数，同一时刻只持有一个文件的内容。
pub async fn list_checkpoint_summaries_batch_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileSummary>> {
    let (root, classified) =
        collect_chain_changes_remote(client, checkpoint_ids, work_dir, include_all).await?;
    let mut summaries = Vec::with_capacity(classified.len());
    for entry in classified {
        let stats = remote_file_stats(client, &root, &entry)
            .await
            .unwrap_or_else(|error| {
                eprintln!(
                    "[checkpoint] Warning: failed to compute remote diff stats for '{}': {error}",
                    entry.path
                );
                DiffStats::default()
            });
        summaries.push(stats.into_summary(entry.path, entry.change_type));
    }
    Ok(summaries)
}

/// 远程版回滚链变更列表：只需路径与变更类型，不读取变更文件内容、不生成 diff。
pub async fn list_checkpoint_changes_batch_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileChange>> {
    let (_, classified) =
        collect_chain_changes_remote(client, checkpoint_ids, work_dir, include_all).await?;
    Ok(classified
        .into_iter()
        .map(|entry| CheckpointFileChange {
            path: entry.path,
            change_type: entry.change_type,
        })
        .collect())
}

/// 远程版单个文件 diff 的一页：与本地 `read_checkpoint_diff_page` 同语义。
/// 超过传输上限的文件不读取内容，返回 too_large 页。
pub async fn read_checkpoint_diff_page_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    path: String,
    start_row: u32,
    max_rows: u32,
    max_bytes: u32,
) -> Result<CheckpointDiffPage> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;
    let chained = collect_chained_entries_remote(&checkpoint_ids, |manifest| {
        validate_manifest_work_dir_remote(manifest, &work_dir).map(|_| ())
    })
    .await?;
    let requested_key = manifest_merge_key(&path);
    let entry = chained
        .into_iter()
        .find(|entry| entry.path == path || manifest_merge_key(&entry.path) == requested_key)
        .ok_or_else(|| Error::from_reason(format!("Checkpoint chain does not track '{path}'")))?;
    let absolute = resolve_remote_manifest_path(&root, &entry.path);
    let stat = client.stat(&absolute).await?;
    let revision = diff_revision(
        &original_digest(&entry.original),
        stat.as_ref().map(|stat| stat.mtime_ms).unwrap_or(0),
        stat.as_ref().map(|stat| stat.size).unwrap_or(0),
    );
    if stat
        .as_ref()
        .is_some_and(|stat| stat.size > REMOTE_DIFF_CONTENT_LIMIT)
    {
        return Ok(too_large_page(revision));
    }
    let cache_key = format!("{}:{}", entry.source_checkpoint_id, entry.path);
    let plan = match cached_plan(&cache_key, &revision) {
        Some(plan) => plan,
        None => {
            let (original, current) = tokio::try_join!(
                remote_original_line_source(client, &absolute, &entry.original),
                remote_current_line_source(client, &absolute, stat.is_some()),
            )?;
            let (Some(original), Some(current)) = (original, current) else {
                return Ok(too_large_page(revision));
            };
            let relative = entry.path.clone();
            let plan = tokio::task::spawn_blocking(move || {
                build_plan(&relative, original, current, revision)
            })
            .await
            .map_err(join_error)??;
            store_plan(cache_key, plan)
        }
    };
    tokio::task::spawn_blocking(move || render_page(&plan, start_row, max_rows, max_bytes))
        .await
        .map_err(join_error)?
}

/// 远程回滚链上需要报告的条目：按 `include_all` 语义门控并分类变更类型。
/// 分类只用远程哈希比对，不传输文件内容；返回规范化后的根路径。
async fn collect_chain_changes_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
    include_all: bool,
) -> Result<(String, Vec<ClassifiedRemoteEntry>)> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_read_guard_async(&work_dir_lock).await;
    let chained = collect_chained_entries_remote(&checkpoint_ids, |manifest| {
        validate_manifest_work_dir_remote(manifest, &work_dir).map(|_| ())
    })
    .await?;
    if chained.is_empty() {
        return Ok((root, Vec::new()));
    }

    // !include_all 时先用 expected 过滤（回滚预览语义）；original 对比恒定需要。
    let entries = chained_probe_entries(&chained);
    let ProbedEntries { items, digests } = probe_tracked_entries(client, &root, entries).await?;

    let mut results = Vec::new();
    for (probe, chained_entry) in items.into_iter().zip(chained) {
        if !include_all {
            let expected = probe.entry.expected.as_ref().ok_or_else(|| {
                Error::from_reason("Checkpoint entry lost its expected state during probe")
            })?;
            let expected_differs =
                classify_remote_state(&probe.current, expected, &digests, &probe.entry.path)?
                    .is_some();
            if expected_differs {
                continue;
            }
        }
        let Some(change_type) = classify_remote_state(
            &probe.current,
            &probe.entry.original,
            &digests,
            &probe.entry.path,
        )?
        else {
            continue;
        };
        results.push(ClassifiedRemoteEntry {
            path: probe.entry.path,
            original: probe.entry.original,
            source_checkpoint_id: chained_entry.source_checkpoint_id,
            stat: probe.stat,
            change_type,
        });
    }
    Ok((root, results))
}

/// 远程版回滚：把工作区恢复到 checkpoint 记录的 pre-change 状态。
/// 与批量恢复共用同一套链式语义，只是链上只有一个检查点。
pub async fn restore_checkpoint_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_id: String,
    work_dir: String,
) -> Result<()> {
    restore_checkpoints_remote(client, vec![checkpoint_id], work_dir).await
}

/// 远程版回滚链恢复：与本地 `restore_checkpoints` 同语义——按路径合并整条链
/// （original 取最早的目标状态、expected 取最新的门控状态），只探测追踪条目。
/// 复制回对象、删除新增文件与清理空目录合并为一次远程脚本调用；旧版检查点
/// 的本机对象从本机上传。
pub async fn restore_checkpoints_remote(
    client: &RemoteCheckpointClient<'_>,
    checkpoint_ids: Vec<String>,
    work_dir: String,
) -> Result<()> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    let root_path = PathBuf::from(&root);
    let work_dir_lock = work_dir_lock(&root_path)?;
    let _work_dir_guard = work_dir_write_guard_async(&work_dir_lock).await;
    // 递增回滚纪元：此刻起该远程目录上正在运行的 bash 命令的 after 捕获
    // 会检测到工作树被回滚改写并跳过变更记录，防止跨会话误记。
    bump_restore_epoch(&work_dir)?;

    let chained = collect_chained_entries_remote(&checkpoint_ids, |manifest| {
        validate_manifest_work_dir_remote(manifest, &work_dir).map(|_| ())
    })
    .await?;
    if chained.is_empty() {
        return Ok(());
    }

    // 只恢复仍处于链尾 expected 状态的文件（与本地一致）。
    let entries = chained_probe_entries(&chained);
    let probed = probe_tracked_entries(client, &root, entries).await?;

    let mut operations = Vec::new();
    let mut restored_paths = Vec::new();
    for probe in &probed.items {
        let expected = probe.entry.expected.as_ref().ok_or_else(|| {
            Error::from_reason("Checkpoint entry lost its expected state during probe")
        })?;
        let expected_differs =
            classify_remote_state(&probe.current, expected, &probed.digests, &probe.entry.path)?
                .is_some();
        if expected_differs {
            continue;
        }
        let destination = resolve_remote_manifest_path(&root, &probe.entry.path);
        match &probe.entry.original {
            OriginalState::Missing => operations.push(RemoteRestoreOp::Remove { path: destination }),
            OriginalState::Object { object_id } => match locate_object(object_id)? {
                ObjectLocation::Local(source) => {
                    upload_legacy_object(client, &source, &destination).await?
                }
                ObjectLocation::Remote => operations.push(RemoteRestoreOp::Copy {
                    path: destination,
                    object_id: object_id.clone(),
                }),
            },
            OriginalState::Git => {
                return Err(Error::from_reason("Checkpoint Git baseline is missing"));
            }
        }
        restored_paths.push(probe.entry.path.clone());
    }
    operations.extend(
        empty_parent_candidates(&root, &restored_paths)
            .into_iter()
            .map(|path| RemoteRestoreOp::RemoveDir { path }),
    );

    let mut first_failure: Option<String> = None;
    for result in client.restore_batch(&operations).await? {
        match result.status.as_str() {
            "ok" => {}
            "missing_object" => eprintln!(
                "[checkpoint] Warning: checkpoint object for '{}' is missing from the remote store; skipping restore",
                result.path
            ),
            _ => {
                if first_failure.is_none() {
                    first_failure = Some(match result.reason {
                        Some(reason) => {
                            format!("Failed to restore remote file '{}': {reason}", result.path)
                        }
                        None => format!("Failed to restore remote file '{}'", result.path),
                    });
                }
            }
        }
    }
    match first_failure {
        Some(message) => Err(Error::from_reason(message)),
        None => Ok(()),
    }
}

/// 旧版 SSH 检查点的本机对象：经 SSH 上传回远程。远程写入经 JSON(base64)
/// 整体传输，超过传输上限时跳过恢复，避免把整份内容读进主进程。
async fn upload_legacy_object(
    client: &RemoteCheckpointClient<'_>,
    source: &Path,
    destination: &str,
) -> Result<()> {
    if let Ok(meta) = tokio::fs::metadata(source).await {
        if meta.len() > REMOTE_DIFF_CONTENT_LIMIT {
            eprintln!(
                "[checkpoint] Warning: checkpoint object '{}' ({} bytes) exceeds the transfer limit; skipping restore of '{destination}'",
                source.display(),
                meta.len()
            );
            return Ok(());
        }
    }
    let content = match tokio::fs::read(source).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "[checkpoint] Warning: checkpoint object '{}' not found on disk: {error}; skipping restore",
                source.display()
            );
            return Ok(());
        }
        Err(error) => {
            return Err(Error::from_reason(format!(
                "Failed to read checkpoint object '{}': {error}",
                source.display()
            )));
        }
    };
    client.write_bytes(destination, &content).await
}

/// 回滚后尝试清理的空父目录（与本地 prune_empty_parent_directories 一致）：
/// 每个恢复路径在工作区内的全部祖先目录，最深优先。远程逐个 rmdir，非空目录
/// 自然失败，结果与逐级向上清理相同。工作区外的绝对路径条目不参与清理。
fn empty_parent_candidates(root: &str, restored_entries: &[String]) -> Vec<String> {
    let root_uri = root.trim_end_matches('/');
    let mut directories: Vec<String> = Vec::new();
    for path in restored_entries {
        if path.starts_with(ABSOLUTE_PATH_MARKER) {
            continue;
        }
        let mut current = path.as_str();
        while let Some(index) = current.rfind('/') {
            current = &current[..index];
            if current.is_empty() {
                break;
            }
            directories.push(current.to_string());
        }
    }
    directories.sort_by(|left, right| {
        right
            .matches('/')
            .count()
            .cmp(&left.matches('/').count())
            .then_with(|| left.cmp(right))
    });
    directories.dedup();
    directories
        .into_iter()
        .map(|directory| format!("{root_uri}/{directory}"))
        .collect()
}

/// 远程版创建 checkpoint：校验远程工作区存在且主机具备对象库所需工具后，
/// 仅发布本地 manifest（内容在工具执行前后按需捕获，与本地增量语义一致）。
/// 主机缺少工具时不创建检查点，由 bash 输出提醒用户安装。
pub async fn create_checkpoint_remote(
    client: &RemoteCheckpointClient<'_>,
    work_dir: String,
) -> Result<String> {
    let root = canonical_work_dir_remote(client, &work_dir).await?;
    ensure_remote_store(client, &root).await?;
    let checkpoint_id = super::generate_checkpoint_id();
    let manifest_root = root.clone();
    let created = with_manifest_lock_async(&checkpoint_id, || async {
        let manifest = CheckpointManifest {
            version: super::MANIFEST_VERSION,
            work_dir: manifest_root,
            git: None,
            entries: Vec::new(),
        };
        write_manifest(&checkpoint_id, &manifest)?;
        Ok(checkpoint_id.clone())
    })
    .await?;
    schedule_remote_store_sweep(&root);
    Ok(created)
}