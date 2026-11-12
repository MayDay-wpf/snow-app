//! 手机远控的附件存储：上传落盘、图片合法性校验、生命周期管理。
//!
//! 原先由 Node 主进程的 remoteAttachmentStore.ts 承担；迁移到 Rust 后
//! 附件字节流直接写入磁盘，不再经过 Node 的 stream pipeline 与 Buffer 缓冲。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use axum::body::Body;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use super::auth::{now_ms, random_token};

pub const MAX_REMOTE_ATTACHMENTS: usize = 4;
pub const MAX_REMOTE_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_REMOTE_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_REMOTE_PENDING_BYTES: u64 = 40 * 1024 * 1024;

const MAX_IMAGE_PIXELS: u64 = 32_000_000;
const MAX_NAME_LENGTH: usize = 180;
const ABANDONED_UPLOAD_TTL_MS: i64 = 60 * 60 * 1000;

/// 图片扩展名白名单（与手机端上传通道一致）。
const IMAGE_MIME_EXTENSIONS: [(&str, &str); 4] = [
    ("image/png", ".png"),
    ("image/jpeg", ".jpg"),
    ("image/gif", ".gif"),
    ("image/webp", ".webp"),
];

pub const ERR_INVALID_KIND: &str = "INVALID_ATTACHMENT_KIND";
pub const ERR_INVALID_MIME: &str = "INVALID_ATTACHMENT_MIME";
pub const ERR_UNSUPPORTED_IMAGE_TYPE: &str = "UNSUPPORTED_IMAGE_TYPE";
pub const ERR_TOO_MANY_ATTACHMENTS: &str = "TOO_MANY_ATTACHMENTS";
pub const ERR_ATTACHMENT_TOO_LARGE: &str = "ATTACHMENT_TOO_LARGE";
pub const ERR_EMPTY_ATTACHMENT: &str = "EMPTY_ATTACHMENT";
pub const ERR_IMAGE_SIGNATURE_MISMATCH: &str = "IMAGE_SIGNATURE_MISMATCH";
pub const ERR_IMAGE_DIMENSIONS_INVALID: &str = "IMAGE_DIMENSIONS_INVALID";
pub const ERR_IMAGE_TOO_LARGE: &str = "IMAGE_TOO_LARGE";
pub const ERR_INVALID_ATTACHMENT_IDS: &str = "INVALID_ATTACHMENT_IDS";
pub const ERR_ATTACHMENT_NOT_AVAILABLE: &str = "ATTACHMENT_NOT_AVAILABLE";

/// 附件错误：错误码与旧 Node 实现一一对应，HTTP 状态与文案由服务层映射。
pub enum AttachError {
    Code(&'static str),
    Internal(String),
}

impl AttachError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

/// 附件所属的上下文；与消息发送时的会话 / 工作区绑定，防止跨会话串用。
#[derive(Clone, PartialEq, Eq)]
pub struct RemoteAttachmentContext {
    pub directory_id: Option<String>,
    pub conversation_id: Option<String>,
}

impl RemoteAttachmentContext {
    /// 从 Renderer 的 getState 快照构造上下文。
    pub fn from_state(state: &Value) -> Self {
        Self {
            directory_id: state
                .get("workspace")
                .and_then(|workspace| workspace.get("directoryId"))
                .and_then(Value::as_str)
                .map(str::to_string),
            conversation_id: state
                .get("activeConversationId")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "directoryId": self.directory_id,
            "conversationId": self.conversation_id,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    Image,
    File,
}

impl AttachmentKind {
    pub fn from_header(value: &str) -> Option<Self> {
        match value {
            "image" => Some(Self::Image),
            "file" => Some(Self::File),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::File => "file",
        }
    }
}

/// 已存储附件的对外摘要。
pub struct AttachmentSummary {
    pub id: String,
    pub kind: AttachmentKind,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
}

impl AttachmentSummary {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind.as_str(),
            "name": self.name,
            "mimeType": self.mime_type,
            "size": self.size,
        })
    }
}

/// 解析后的附件：图片附带 dataUrl，文件附带磁盘路径。
pub struct ResolvedAttachment {
    pub summary: AttachmentSummary,
    pub data_url: Option<String>,
    pub path: Option<String>,
}

struct StoredAttachment {
    summary: AttachmentSummary,
    absolute_path: PathBuf,
    context: RemoteAttachmentContext,
    generation: u64,
    created_at: i64,
}

static UPLOADS: OnceLock<Mutex<HashMap<String, StoredAttachment>>> = OnceLock::new();
static IN_FLIGHT_BYTES: AtomicU64 = AtomicU64::new(0);
static IN_FLIGHT_ATTACHMENTS: AtomicUsize = AtomicUsize::new(0);

fn uploads() -> &'static Mutex<HashMap<String, StoredAttachment>> {
    UPLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_uploads() -> MutexGuard<'static, HashMap<String, StoredAttachment>> {
    uploads()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn same_context(left: &RemoteAttachmentContext, right: &RemoteAttachmentContext) -> bool {
    left.directory_id == right.directory_id && left.conversation_id == right.conversation_id
}

/// 当前未被消费的附件占用的总字节数。
fn pending_bytes() -> u64 {
    lock_uploads().values().map(|item| item.summary.size).sum()
}

async fn remove_quietly(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

/// 清理超过 TTL 未被消费的遗留上传（远端放弃的附件）。
async fn cleanup_expired() {
    let cutoff = now_ms() - ABANDONED_UPLOAD_TTL_MS;
    let expired: Vec<StoredAttachment> = {
        let mut map = lock_uploads();
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, item)| item.created_at < cutoff)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter().filter_map(|id| map.remove(&id)).collect()
    };
    for item in expired {
        remove_quietly(&item.absolute_path).await;
    }
}

/// 读取正文流并落盘；全部校验通过后登记到内存表并返回摘要。
pub async fn save_attachment(
    kind: AttachmentKind,
    mime_type: &str,
    file_name: &str,
    declared_length: Option<u64>,
    body: Body,
    context: RemoteAttachmentContext,
    generation: u64,
) -> Result<AttachmentSummary, AttachError> {
    cleanup_expired().await;
    if mime_type.is_empty() || mime_type == "application/json" {
        return Err(AttachError::Code(ERR_INVALID_MIME));
    }
    let image_suffix = IMAGE_MIME_EXTENSIONS
        .iter()
        .find(|(mime, _)| *mime == mime_type)
        .map(|(_, suffix)| *suffix);
    if kind == AttachmentKind::Image && image_suffix.is_none() {
        return Err(AttachError::Code(ERR_UNSUPPORTED_IMAGE_TYPE));
    }
    {
        let map = lock_uploads();
        let matching = map
            .values()
            .filter(|item| item.generation == generation && same_context(&item.context, &context))
            .count();
        if matching + IN_FLIGHT_ATTACHMENTS.load(Ordering::Relaxed) >= MAX_REMOTE_ATTACHMENTS {
            return Err(AttachError::Code(ERR_TOO_MANY_ATTACHMENTS));
        }
    }

    IN_FLIGHT_ATTACHMENTS.fetch_add(1, Ordering::Relaxed);
    let result = save_attachment_inner(
        kind,
        mime_type,
        image_suffix,
        file_name,
        declared_length,
        body,
        context,
        generation,
    )
    .await;
    IN_FLIGHT_ATTACHMENTS.fetch_sub(1, Ordering::Relaxed);
    result
}

#[allow(clippy::too_many_arguments)]
async fn save_attachment_inner(
    kind: AttachmentKind,
    mime_type: &str,
    image_suffix: Option<&str>,
    file_name: &str,
    declared_length: Option<u64>,
    body: Body,
    context: RemoteAttachmentContext,
    generation: u64,
) -> Result<AttachmentSummary, AttachError> {
    let max_bytes = match kind {
        AttachmentKind::Image => MAX_REMOTE_IMAGE_BYTES,
        AttachmentKind::File => MAX_REMOTE_FILE_BYTES,
    };
    if let Some(declared) = declared_length {
        if declared > max_bytes || pending_bytes() + declared > MAX_REMOTE_PENDING_BYTES {
            return Err(AttachError::Code(ERR_ATTACHMENT_TOO_LARGE));
        }
    }

    let name = safe_name(file_name);
    let extension = match kind {
        AttachmentKind::Image => image_suffix.unwrap_or(".bin").to_string(),
        AttachmentKind::File => Path::new(&name)
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default(),
    };
    let id = random_token();
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let upload_root = upload_root().await?;
    let directory = upload_root.join("remote").join(day).join(&id);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| AttachError::internal(format!("创建附件目录失败：{error}")))?;
    let stored_name = match kind {
        AttachmentKind::Image => format!("image{extension}"),
        AttachmentKind::File => name.clone(),
    };
    let absolute_path = directory.join(stored_name);

    let mut file = tokio::fs::File::create_new(&absolute_path)
        .await
        .map_err(|error| AttachError::internal(format!("创建附件文件失败：{error}")))?;
    let mut size = 0u64;
    let mut reserved = 0u64;
    let mut stream = body.into_data_stream();
    let stream_result: Result<(), AttachError> = async {
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|error| AttachError::internal(format!("读取附件内容失败：{error}")))?;
            let chunk_len = chunk.len() as u64;
            size += chunk_len;
            if size > max_bytes
                || pending_bytes() + IN_FLIGHT_BYTES.load(Ordering::Relaxed) + chunk_len
                    > MAX_REMOTE_PENDING_BYTES
            {
                return Err(AttachError::Code(ERR_ATTACHMENT_TOO_LARGE));
            }
            IN_FLIGHT_BYTES.fetch_add(chunk_len, Ordering::Relaxed);
            reserved += chunk_len;
            file.write_all(&chunk)
                .await
                .map_err(|error| AttachError::internal(format!("写入附件失败：{error}")))?;
        }
        file.flush()
            .await
            .map_err(|error| AttachError::internal(format!("写入附件失败：{error}")))
    }
    .await;
    IN_FLIGHT_BYTES.fetch_sub(reserved, Ordering::Relaxed);
    drop(file);

    if let Err(error) = stream_result {
        remove_quietly(&absolute_path).await;
        return Err(error);
    }
    if size == 0 {
        remove_quietly(&absolute_path).await;
        return Err(AttachError::Code(ERR_EMPTY_ATTACHMENT));
    }
    if kind == AttachmentKind::Image {
        if let Err(error) = validate_image(&absolute_path, mime_type).await {
            remove_quietly(&absolute_path).await;
            return Err(error);
        }
    }

    let summary = AttachmentSummary {
        id: id.clone(),
        kind,
        name,
        mime_type: mime_type.to_string(),
        size,
    };
    lock_uploads().insert(
        id,
        StoredAttachment {
            summary: AttachmentSummary {
                id: summary.id.clone(),
                kind: summary.kind,
                name: summary.name.clone(),
                mime_type: summary.mime_type.clone(),
                size: summary.size,
            },
            absolute_path,
            context,
            generation,
            created_at: now_ms(),
        },
    );
    Ok(summary)
}

async fn upload_root() -> Result<PathBuf, AttachError> {
    let root = tokio::task::spawn_blocking(crate::storage::get_upload_root)
        .await
        .map_err(|error| AttachError::internal(format!("读取上传目录失败：{error}")))?
        .map_err(|error| AttachError::internal(format!("读取上传目录失败：{error}")))?;
    Ok(PathBuf::from(root))
}

/// 校验附件 ID 列表并克隆对应记录；不满足前置条件时按旧实现抛错。
fn require_attachments(
    ids: &[String],
    context: &RemoteAttachmentContext,
    generation: u64,
) -> Result<Vec<StoredAttachment>, AttachError> {
    let map = lock_uploads();
    validate_attachment_ids(ids, &map)?;
    ids.iter()
        .map(|id| {
            let item = map
                .get(id)
                .filter(|item| {
                    item.generation == generation && same_context(&item.context, context)
                })
                .ok_or(AttachError::Code(ERR_ATTACHMENT_NOT_AVAILABLE))?;
            Ok(StoredAttachment {
                summary: AttachmentSummary {
                    id: item.summary.id.clone(),
                    kind: item.summary.kind,
                    name: item.summary.name.clone(),
                    mime_type: item.summary.mime_type.clone(),
                    size: item.summary.size,
                },
                absolute_path: item.absolute_path.clone(),
                context: item.context.clone(),
                generation: item.generation,
                created_at: item.created_at,
            })
        })
        .collect()
}

fn validate_attachment_ids(
    ids: &[String],
    map: &HashMap<String, StoredAttachment>,
) -> Result<(), AttachError> {
    if ids.len() > MAX_REMOTE_ATTACHMENTS {
        return Err(AttachError::Code(ERR_INVALID_ATTACHMENT_IDS));
    }
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    if unique.len() != ids.len() {
        return Err(AttachError::Code(ERR_INVALID_ATTACHMENT_IDS));
    }
    let _ = map;
    Ok(())
}

/// 解析附件（图片转 dataUrl、文件给出磁盘路径），供 Renderer 组装消息。
pub async fn resolve_attachments(
    ids: &[String],
    context: &RemoteAttachmentContext,
    generation: u64,
) -> Result<Vec<ResolvedAttachment>, AttachError> {
    let items = require_attachments(ids, context, generation)?;
    let mut resolved = Vec::with_capacity(items.len());
    for item in items {
        if item.summary.kind == AttachmentKind::File {
            resolved.push(ResolvedAttachment {
                data_url: None,
                path: Some(item.absolute_path.to_string_lossy().into_owned()),
                summary: item.summary,
            });
            continue;
        }
        let bytes = tokio::fs::read(&item.absolute_path)
            .await
            .map_err(|error| AttachError::internal(format!("读取附件失败：{error}")))?;
        let data_url = format!(
            "data:{};base64,{}",
            item.summary.mime_type,
            BASE64_STANDARD.encode(bytes)
        );
        resolved.push(ResolvedAttachment {
            data_url: Some(data_url),
            path: None,
            summary: item.summary,
        });
    }
    Ok(resolved)
}

/// 标记附件已被消费：从内存表移除；图片临时文件随即清理，文件类型保留给会话使用。
pub async fn mark_consumed(
    ids: &[String],
    context: &RemoteAttachmentContext,
    generation: u64,
) -> Result<(), AttachError> {
    let items = take_attachments(ids, context, generation)?;
    for item in items {
        if item.summary.kind == AttachmentKind::Image {
            remove_quietly(&item.absolute_path).await;
        }
    }
    Ok(())
}

/// 主动丢弃某个附件（手机端取消选择）；不满足上下文时静默忽略。
pub async fn discard(id: &str, context: &RemoteAttachmentContext, generation: u64) {
    let removed = {
        let mut map = lock_uploads();
        let matches = map
            .get(id)
            .map(|item| item.generation == generation && same_context(&item.context, context))
            .unwrap_or(false);
        if matches {
            map.remove(id)
        } else {
            None
        }
    };
    if let Some(item) = removed {
        remove_quietly(&item.absolute_path).await;
    }
}

/// 停止服务 / 轮换凭据时失效全部待发附件。
pub async fn invalidate_all() {
    let items: Vec<StoredAttachment> = {
        let mut map = lock_uploads();
        map.drain().map(|(_, item)| item).collect()
    };
    for item in items {
        remove_quietly(&item.absolute_path).await;
    }
}

/// 取出并移除附件记录；校验失败时抛错。
fn take_attachments(
    ids: &[String],
    context: &RemoteAttachmentContext,
    generation: u64,
) -> Result<Vec<StoredAttachment>, AttachError> {
    let mut map = lock_uploads();
    validate_attachment_ids(ids, &map)?;
    for id in ids {
        let valid = map
            .get(id)
            .map(|item| item.generation == generation && same_context(&item.context, context))
            .unwrap_or(false);
        if !valid {
            return Err(AttachError::Code(ERR_ATTACHMENT_NOT_AVAILABLE));
        }
    }
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(item) = map.remove(id) {
            items.push(item);
        }
    }
    Ok(items)
}

/// 文件名清洗：去掉路径成分、控制字符与 Windows 非法字符，并处理保留设备名。
fn safe_name(raw: &str) -> String {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let base = Path::new(&decoded)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut name: String = base
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect();
    name = name.trim().to_string();
    while name.ends_with('.') || name.ends_with(' ') {
        name.pop();
    }
    if name.is_empty() || name == "." || name == ".." || is_reserved_windows_name(&name) {
        name = "attachment".to_string();
    }
    name.chars().take(MAX_NAME_LENGTH).collect()
}

fn is_reserved_windows_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or_default();
    if matches!(stem, "con" | "prn" | "aux" | "nul") {
        return true;
    }
    if stem.len() == 4 {
        let bytes = stem.as_bytes();
        let prefix = &stem[..3];
        if (prefix == "com" || prefix == "lpt") && bytes[3].is_ascii_digit() && bytes[3] != b'0' {
            return true;
        }
    }
    false
}

/// 图片合法性校验：签名匹配 + 尺寸可读 + 像素总量受限。
async fn validate_image(path: &Path, mime_type: &str) -> Result<(), AttachError> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| AttachError::internal(format!("读取图片失败：{error}")))?;
    let signature_ok = match mime_type {
        "image/png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !signature_ok {
        return Err(AttachError::Code(ERR_IMAGE_SIGNATURE_MISMATCH));
    }
    let dimensions =
        image_dimensions(&bytes, mime_type).ok_or(AttachError::Code(ERR_IMAGE_DIMENSIONS_INVALID))?;
    if dimensions.0 < 1 || dimensions.1 < 1 {
        return Err(AttachError::Code(ERR_IMAGE_DIMENSIONS_INVALID));
    }
    if dimensions.0 as u64 * dimensions.1 as u64 > MAX_IMAGE_PIXELS {
        return Err(AttachError::Code(ERR_IMAGE_TOO_LARGE));
    }
    Ok(())
}

/// 解析图片尺寸（PNG / GIF / WebP / JPEG），无法识别时返回 None。
fn image_dimensions(bytes: &[u8], mime_type: &str) -> Option<(u32, u32)> {
    match mime_type {
        "image/png" if bytes.len() >= 24 => Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        )),
        "image/gif" if bytes.len() >= 10 => Some((
            u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32,
            u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32,
        )),
        "image/webp" if bytes.len() >= 30 => {
            let kind = &bytes[12..16];
            if kind == b"VP8X" {
                let width = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
                let height = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
                return Some((width, height));
            }
            if kind == b"VP8 " && &bytes[23..26] == [0x9d, 0x01, 0x2a] {
                let width = (u16::from_le_bytes(bytes[26..28].try_into().ok()?) & 0x3fff) as u32;
                let height = (u16::from_le_bytes(bytes[28..30].try_into().ok()?) & 0x3fff) as u32;
                return Some((width, height));
            }
            if kind == b"VP8L" && bytes[20] == 0x2f {
                let width = 1 + bytes[21] as u32 + (((bytes[22] & 0x3f) as u32) << 8);
                let height = 1
                    + ((bytes[22] as u32 & 0xc0) >> 6)
                    + ((bytes[23] as u32) << 2)
                    + (((bytes[24] as u32) & 0x0f) << 10);
                return Some((width, height));
            }
            None
        }
        "image/jpeg" => {
            let mut offset = 2usize;
            while offset + 9 < bytes.len() {
                if bytes[offset] != 0xff {
                    break;
                }
                let marker = bytes[offset + 1];
                let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
                if length < 2 || offset + length + 2 > bytes.len() {
                    break;
                }
                if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                    let height = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
                    let width = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]) as u32;
                    return Some((width, height));
                }
                offset += length + 2;
            }
            None
        }
        _ => None,
    }
}
