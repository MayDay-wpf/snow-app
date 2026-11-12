//! 远控服务的 NAPI 导出：Node 主进程通过原生绑定直接驱动 HTTP 服务。
//!
//! 这些导出替代了原先 Node 侧的 node:http 服务器、鉴权与附件存储；
//! Node 只保留渲染进程桥的回调实现与设置面板的 IPC 外壳。

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::remote_control::attachments::{AttachError, RemoteAttachmentContext};
use crate::remote_control::bridge::RemoteBridgeCallback;
use crate::remote_control::{self, StartOptions};

/// 公网入口状态：回环端口、公网地址与当前令牌。
#[napi(object)]
pub struct RemoteControlWanState {
    pub enabled: bool,
    pub local_port: u32,
    pub public_origin: String,
    pub pairing_url: String,
    /// 当前生效的公网令牌；公网入口未启动时为空串。
    pub token: String,
}

/// 远控服务状态快照（enabled 字段由 Node 侧按总开关补充）。
#[napi(object)]
pub struct RemoteControlServerState {
    pub running: bool,
    pub host: String,
    pub port: u32,
    pub token: String,
    pub generation: i64,
    pub wan: RemoteControlWanState,
}

/// 启动参数：监听地址、令牌与移动页产物路径。
#[napi(object)]
pub struct RemoteControlStartOptions {
    pub host: String,
    pub port: u32,
    pub token: Option<String>,
    pub mobile_dir: String,
    pub icon_path: String,
    pub wan_public_origin: Option<String>,
    pub wan_port: u32,
    pub wan_token: Option<String>,
}

/// 附件上下文：与消息发送时的会话 / 工作区绑定。
#[napi(object)]
pub struct RemoteAttachmentContextInput {
    pub directory_id: Option<String>,
    pub conversation_id: Option<String>,
}

/// 解析后的附件记录（图片带 dataUrl，文件带磁盘路径）。
#[napi(object)]
pub struct RemoteAttachmentRecord {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    pub data_url: Option<String>,
    pub path: Option<String>,
}

fn to_state(state: remote_control::RemoteControlState) -> RemoteControlServerState {
    RemoteControlServerState {
        running: state.running,
        host: state.host,
        port: state.port as u32,
        token: state.token,
        generation: state.generation as i64,
        wan: RemoteControlWanState {
            enabled: state.wan.enabled,
            local_port: state.wan.local_port as u32,
            public_origin: state.wan.public_origin,
            pairing_url: state.wan.pairing_url,
            token: state.wan.token,
        },
    }
}

fn attachment_error_message(error: AttachError) -> String {
    match error {
        AttachError::Code(code) => code.to_string(),
        AttachError::Internal(message) => message,
    }
}

/// 注册渲染进程桥：Rust 侧需要桌面 UI 状态时回调该函数。
/// 回调入参为 `{ action, argsJson }`，返回 JSON 字符串：
/// `{ ok: true, value }`、`{ ok: false, kind: "renderer", error }`（业务错误）
/// 或 `{ ok: false, kind: "infra", error }`（下层故障）。
#[napi]
pub fn set_remote_control_renderer_bridge(callback: RemoteBridgeCallback) {
    remote_control::bridge::register(callback);
}

/// 启动局域网远控服务（同时按需启动公网回环监听器）。
#[napi]
pub async fn start_remote_control_server(
    options: RemoteControlStartOptions,
) -> napi::Result<RemoteControlServerState> {
    let state = remote_control::start_server(StartOptions {
        host: options.host,
        port: options.port as u16,
        token: options.token,
        mobile_dir: PathBuf::from(options.mobile_dir),
        icon_path: PathBuf::from(options.icon_path),
        wan_public_origin: options.wan_public_origin,
        wan_port: options.wan_port as u16,
        wan_token: options.wan_token,
    })
    .await
    .map_err(Error::from_reason)?;
    Ok(to_state(state))
}

/// 停止局域网远控服务与公网监听器。
#[napi]
pub async fn stop_remote_control_server() -> napi::Result<()> {
    remote_control::stop_server()
        .await
        .map_err(Error::from_reason)
}

/// 查询当前远控服务状态（同步、无 I/O）。
#[napi]
pub fn get_remote_control_server_state() -> RemoteControlServerState {
    to_state(remote_control::state())
}

/// 应用面板固定的局域网令牌（None 表示回到随机令牌）。
#[napi]
pub async fn set_remote_control_lan_token(
    token: Option<String>,
) -> napi::Result<RemoteControlServerState> {
    let state = remote_control::set_lan_token(token)
        .await
        .map_err(Error::from_reason)?;
    Ok(to_state(state))
}

/// 应用面板固定的公网令牌（None 表示回到本次随机令牌）。
#[napi]
pub async fn set_remote_control_wan_token(
    token: Option<String>,
) -> napi::Result<RemoteControlServerState> {
    let state = remote_control::set_wan_token(token)
        .await
        .map_err(Error::from_reason)?;
    Ok(to_state(state))
}

/// 启动或替换公网回环监听器（SSH2 隧道入口）。
#[napi]
pub async fn start_remote_wan_listener(
    public_origin: String,
    preferred_port: u32,
    token: Option<String>,
) -> napi::Result<RemoteControlServerState> {
    let state = remote_control::start_wan_listener(public_origin, preferred_port as u16, token)
        .await
        .map_err(Error::from_reason)?;
    Ok(to_state(state))
}

/// 停止公网回环监听器。
#[napi]
pub async fn stop_remote_wan_listener() -> napi::Result<()> {
    remote_control::stop_wan_listener()
        .await
        .map_err(Error::from_reason)
}

/// 解析远控附件（渲染进程组装消息时使用）：图片转 dataUrl，文件给出路径。
#[napi]
pub async fn resolve_remote_attachments(
    ids: Vec<String>,
    context: RemoteAttachmentContextInput,
    generation: i64,
) -> napi::Result<Vec<RemoteAttachmentRecord>> {
    let context = RemoteAttachmentContext {
        directory_id: context.directory_id,
        conversation_id: context.conversation_id,
    };
    let resolved =
        remote_control::attachments::resolve_attachments(&ids, &context, generation as u64)
            .await
            .map_err(|error| Error::new(Status::GenericFailure, attachment_error_message(error)))?;
    Ok(resolved
        .into_iter()
        .map(|item| RemoteAttachmentRecord {
            id: item.summary.id,
            kind: item.summary.kind.as_str().to_string(),
            name: item.summary.name,
            mime_type: item.summary.mime_type,
            size: item.summary.size as i64,
            data_url: item.data_url,
            path: item.path,
        })
        .collect())
}
