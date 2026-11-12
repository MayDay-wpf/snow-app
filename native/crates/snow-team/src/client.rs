//! 队员侧的团队 WebSocket 客户端。
//!
//! 队员通过邀请链接加入后，本模块维持一条到队长的长连接：接收快照与增量、
//! 把本地改动推给队长、断线自动重连（指数退避）。所有数据读写都落到本机
//! 数据库，渲染层只消费事件。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::store as store;
use crate::store::{TeamInfo, TeamSnapshot};

use super::protocol::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
use super::{db, emit_event};

/// 握手 / 附件请求的等待上限。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// 队员客户端的运行参数。
#[derive(Clone)]
pub struct ClientConfig {
    pub database_path: PathBuf,
    pub team_id: String,
    pub endpoint: String,
    pub invite_code: String,
    /// 本机设备标识（队长黑名单依据）。
    pub client_id: String,
    /// 初始重连令牌（队员本地已保存的值，首次加入时为空）。
    pub token: String,
    pub name: String,
    pub color: String,
    /// 发起加入的本地项目：审核通过后写入团队关联，加入即进入团队面板。
    pub project_id: String,
    pub project_name: String,
}

/// 加入结果：直接加入成功，或已提交申请等待队长审核。
pub enum JoinOutcome {
    Joined(TeamInfo),
    Pending,
}

/// 附件响应：文件名、是否图片、原始字节。
pub type MediaResponse = (String, bool, Vec<u8>);

/// 附件请求的等待通道：成功得到内容，失败立即收到原因。
type MediaSender = oneshot::Sender<Result<MediaResponse, String>>;

/// 单次连接的结束方式。
enum ConnectionEnd {
    /// 连接断开（可退避重连）。
    Closed,
    /// 已被队长移出团队：停止重连并清理本地团队数据。
    Removed,
    /// 加入申请被拒绝或被拉黑：停止重连并清理本地团队数据。
    Rejected,
}

/// 客户端句柄序号：注册表按它精确绑定 / 释放，避免误伤替换后的新句柄。
static HANDLE_SEQ: AtomicU64 = AtomicU64::new(1);

/// 已连接的队员客户端句柄。
pub struct ClientHandle {
    pub id: u64,
    outgoing: mpsc::UnboundedSender<ClientMessage>,
    pending: Arc<Mutex<HashMap<String, MediaSender>>>,
    shutdown: watch::Sender<bool>,
}

impl ClientHandle {
    /// 后台任务仍在运行（被移出 / 被拒绝后任务结束，句柄随之失效）。
    pub fn is_alive(&self) -> bool {
        !self.outgoing.is_closed()
    }

    /// 把一条消息推给队长；连接尚未建立时返回 false（调用方据此提示离线）。
    pub fn send(&self, message: ClientMessage) -> bool {
        self.outgoing.send(message).is_ok()
    }

    /// 向队长请求附件内容，等待响应。
    pub async fn request_media(&self, media_id: &str) -> Result<MediaResponse, String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.insert(media_id.to_string(), tx);
        }
        if !self.send(ClientMessage::MediaRequest {
            media_id: media_id.to_string(),
        }) {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(media_id);
            return Err("尚未连接队长".to_string());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(response)) => response,
            _ => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(media_id);
                Err("等待附件超时".to_string())
            }
        }
    }
}

/// 启动持续同步的后台任务。
pub fn connect(config: ClientConfig) -> ClientHandle {
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let pending: Arc<Mutex<HashMap<String, MediaSender>>> = Arc::new(Mutex::new(HashMap::new()));
    let id = HANDLE_SEQ.fetch_add(1, Ordering::Relaxed);
    let join = tokio::spawn(run(
        config.clone(),
        id,
        out_rx,
        pending.clone(),
        shutdown_rx,
    ));
    drop(join);
    ClientHandle {
        id,
        outgoing: out_tx,
        pending,
        shutdown: shutdown_tx,
    }
}

/// 停止客户端：通知后台任务退出（任务自行结束，不阻塞调用方）。
pub fn stop(handle: &ClientHandle) {
    let _ = handle.shutdown.send(true);
}

/// 一次性握手：连接队长、提交加入申请（或凭令牌重连），返回加入结果。
#[allow(clippy::too_many_arguments)]
pub async fn join_via_host(
    database_path: PathBuf,
    endpoint: String,
    invite_code: String,
    client_id: String,
    name: String,
    color: String,
    project_id: String,
    project_name: String,
) -> Result<JoinOutcome, String> {
    let url = ws_url(&endpoint);
    let (stream, _) = connect_async(&url)
        .await
        .map_err(|error| format!("无法连接队长设备：{error}"))?;
    let (mut tx, mut rx) = stream.split();
    let hello = ClientMessage::Hello {
        protocol: PROTOCOL_VERSION,
        invite_code,
        client_id,
        token: String::new(),
        name: name.clone(),
        color: color.clone(),
    };
    tx.send(Message::Text(
        serde_json::to_string(&hello).map_err(|error| error.to_string())?,
    ))
    .await
    .map_err(|error| format!("发送握手失败：{error}"))?;

    let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                match serde_json::from_str::<ServerMessage>(text.as_str()) {
                    Ok(ServerMessage::Welcome {
                        team,
                        peer_id,
                        token,
                        projects,
                        members,
                        records,
                    }) => {
                        let snapshot = TeamSnapshot {
                            team,
                            projects,
                            members,
                            records,
                        };
                        let team_id = snapshot.team.team_id.clone();
                        let info = db({
                            let database_path = database_path.clone();
                            let name = name.clone();
                            let color = color.clone();
                            let project_id = project_id.clone();
                            let project_name = project_name.clone();
                            move || {
                                store::join_team(
                                    &database_path,
                                    &snapshot,
                                    &peer_id,
                                    &name,
                                    &color,
                                    &token,
                                    &project_id,
                                    &project_name,
                                )
                            }
                        })
                        .await?;
                        emit_event("snapshot", &team_id, "{}".to_string()).await;
                        return Ok(JoinOutcome::Joined(info));
                    }
                    // 首次加入需要队长审核：由常驻长连接继续等待审核结果。
                    Ok(ServerMessage::JoinPending { .. }) => return Ok(JoinOutcome::Pending),
                    Ok(ServerMessage::JoinRejected { message }) => return Err(message),
                    Ok(ServerMessage::Removed { message }) => return Err(message),
                    Ok(ServerMessage::Error { message }) => return Err(message),
                    Ok(_) => continue,
                    Err(_) => continue,
                }
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                let _ = tx.send(Message::Pong(payload)).await;
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(error))) => return Err(format!("连接中断：{error}")),
            Ok(None) => return Err("队长已断开连接".to_string()),
            Err(_) => return Err("等待队长响应超时".to_string()),
        }
    }
}

fn ws_url(endpoint: &str) -> String {
    format!("ws://{}/team/ws", endpoint.trim().trim_end_matches('/'))
}

/// 后台任务：连接 → 同步 → 断开退避重连。
async fn run(
    config: ClientConfig,
    handle_id: u64,
    mut outgoing: mpsc::UnboundedReceiver<ClientMessage>,
    pending: Arc<Mutex<HashMap<String, MediaSender>>>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut backoff = Duration::from_secs(1);
    // 重连令牌：审核通过后由队长下发，之后每次连接都用它免审核恢复身份。
    let mut token = config.token.clone();
    // 团队 id：首次加入（待审核）时未知，收到快照后补齐。
    let mut team_id = config.team_id.clone();
    loop {
        if *shutdown.borrow() {
            break;
        }
        match connect_once(
            &config,
            handle_id,
            &mut token,
            &mut team_id,
            &mut outgoing,
            &pending,
            &mut shutdown,
        )
        .await
        {
            Ok(ConnectionEnd::Closed) => backoff = Duration::from_secs(1),
            // 被队长移出团队 / 申请被拒绝：本地数据已清理，释放句柄并停止重连。
            Ok(ConnectionEnd::Removed) | Ok(ConnectionEnd::Rejected) => {
                outgoing.close();
                super::release_client(handle_id);
                break;
            }
            Err(error) => {
                emit_event(
                    "error",
                    &config.team_id,
                    serde_json::json!({ "message": error }).to_string(),
                )
                .await;
            }
        }
        if *shutdown.borrow() {
            break;
        }
        emit_event(
            "status",
            &config.team_id,
            serde_json::json!({ "connected": false }).to_string(),
        )
        .await;
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown.changed() => {}
        }
        backoff = (backoff * 2).min(Duration::from_secs(20));
    }
}

async fn connect_once(
    config: &ClientConfig,
    handle_id: u64,
    token: &mut String,
    team_id: &mut String,
    outgoing: &mut mpsc::UnboundedReceiver<ClientMessage>,
    pending: &Arc<Mutex<HashMap<String, MediaSender>>>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<ConnectionEnd, String> {
    let url = ws_url(&config.endpoint);
    let (stream, _) = connect_async(&url)
        .await
        .map_err(|error| format!("无法连接队长设备：{error}"))?;
    let (mut tx, mut rx) = stream.split();
    let hello = ClientMessage::Hello {
        protocol: PROTOCOL_VERSION,
        invite_code: config.invite_code.clone(),
        client_id: config.client_id.clone(),
        token: token.clone(),
        name: config.name.clone(),
        color: config.color.clone(),
    };
    tx.send(Message::Text(
        serde_json::to_string(&hello).map_err(|error| error.to_string())?,
    ))
    .await
    .map_err(|error| format!("发送握手失败：{error}"))?;
    emit_event(
        "status",
        &config.team_id,
        serde_json::json!({ "connected": true }).to_string(),
    )
    .await;

    loop {
        tokio::select! {
            incoming = rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(end) =
                            handle_message(config, handle_id, token, team_id, text.as_str(), pending).await
                        {
                            return Ok(end);
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = tx.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(format!("连接中断：{error}")),
                    None => return Ok(ConnectionEnd::Closed),
                }
            }
            outbound = outgoing.recv() => {
                match outbound {
                    Some(message) => {
                        let text = serde_json::to_string(&message)
                            .map_err(|error| error.to_string())?;
                        if tx.send(Message::Text(text)).await.is_err() {
                            return Err("推送数据失败".to_string());
                        }
                    }
                    None => return Ok(ConnectionEnd::Closed),
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return Ok(ConnectionEnd::Closed);
                }
            }
        }
    }
}

async fn handle_message(
    config: &ClientConfig,
    handle_id: u64,
    token: &mut String,
    team_id: &mut String,
    raw: &str,
    pending: &Arc<Mutex<HashMap<String, MediaSender>>>,
) -> Option<ConnectionEnd> {
    let Ok(message) = serde_json::from_str::<ServerMessage>(raw) else {
        return None;
    };
    match message {
        ServerMessage::Welcome {
            team,
            peer_id,
            token: issued_token,
            projects,
            members,
            records,
        } => {
            let snapshot = TeamSnapshot {
                team,
                projects,
                members,
                records,
            };
            let joined_team_id = snapshot.team.team_id.clone();
            let name = config.name.clone();
            let color = config.color.clone();
            let issued = issued_token.trim().to_string();
            let project_id = config.project_id.clone();
            let project_name = config.project_name.clone();
            let _ = db({
                let database_path = config.database_path.clone();
                let issued = issued.clone();
                move || {
                    store::join_team(
                        &database_path,
                        &snapshot,
                        &peer_id,
                        &name,
                        &color,
                        &issued,
                        &project_id,
                        &project_name,
                    )
                }
            })
            .await;
            if !issued.is_empty() {
                *token = issued;
            }
            *team_id = joined_team_id.clone();
            // 加入已生效：把本句柄登记到真实团队 id 下（替换残留旧句柄）并清除等待状态。
            super::bind_client(handle_id, &joined_team_id);
            super::clear_pending_join();
            emit_event("snapshot", &joined_team_id, "{}".to_string()).await;
        }
        ServerMessage::Snapshot {
            team,
            projects,
            members,
            records,
        } => {
            let snapshot = TeamSnapshot {
                team,
                projects,
                members,
                records,
            };
            let joined_team_id = snapshot.team.team_id.clone();
            let name = config.name.clone();
            let color = config.color.clone();
            let project_id = config.project_id.clone();
            let project_name = config.project_name.clone();
            let peer_id = local_peer_id(&config.database_path, team_id).await;
            let _ = db({
                let database_path = config.database_path.clone();
                move || {
                    store::join_team(
                        &database_path,
                        &snapshot,
                        &peer_id,
                        &name,
                        &color,
                        "",
                        &project_id,
                        &project_name,
                    )
                }
            })
            .await;
            *team_id = joined_team_id.clone();
            emit_event("snapshot", &joined_team_id, "{}".to_string()).await;
        }
        // 首次加入：已提交申请，等待队长审核（审核通过后下发快照与令牌）。
        ServerMessage::JoinPending { .. } => {
            emit_event("join-pending", team_id.as_str(), "{}".to_string()).await;
        }
        // 申请被拒绝或已被拉黑：清理本地团队数据并停止重连。
        ServerMessage::JoinRejected { message } => {
            super::clear_pending_join();
            let current_team_id = team_id.clone();
            let _ = db({
                let database_path = config.database_path.clone();
                let current_team_id = current_team_id.clone();
                move || store::delete_team(&database_path, &current_team_id)
            })
            .await;
            emit_event(
                "join-rejected",
                &current_team_id,
                serde_json::json!({ "message": message }).to_string(),
            )
            .await;
            return Some(ConnectionEnd::Rejected);
        }
        ServerMessage::RecordUpserted {
            kind,
            record_id,
            payload,
        } => {
            let current_team_id = team_id.to_string();
            let _ = db({
                let database_path = config.database_path.clone();
                let current_team_id = current_team_id.clone();
                let kind = kind.clone();
                let record_id = record_id.clone();
                let payload = payload.clone();
                move || {
                    store::upsert_record(
                        &database_path,
                        &current_team_id,
                        &kind,
                        &record_id,
                        &payload,
                    )
                }
            })
            .await;
            emit_event(
                "record-upserted",
                &current_team_id,
                serde_json::json!({
                    "kind": kind,
                    "recordId": record_id,
                    "payload": payload,
                })
                .to_string(),
            )
            .await;
        }
        ServerMessage::RecordDeleted { kind, record_id } => {
            let current_team_id = team_id.to_string();
            let _ = db({
                let database_path = config.database_path.clone();
                let current_team_id = current_team_id.clone();
                let kind = kind.clone();
                let record_id = record_id.clone();
                move || {
                    store::delete_record(&database_path, &current_team_id, &kind, &record_id)
                }
            })
            .await;
            emit_event(
                "record-deleted",
                &current_team_id,
                serde_json::json!({ "kind": kind, "recordId": record_id }).to_string(),
            )
            .await;
        }
        ServerMessage::Members { members } => {
            let current_team_id = team_id.to_string();
            let _ = db({
                let database_path = config.database_path.clone();
                let current_team_id = current_team_id.clone();
                let members = members.clone();
                move || store::replace_members(&database_path, &current_team_id, &members)
            })
            .await;
            emit_event(
                "members",
                &current_team_id,
                serde_json::to_string(&members).unwrap_or_else(|_| "[]".to_string()),
            )
            .await;
        }
        ServerMessage::MediaUploaded { owner_id, media_id } => {
            emit_event(
                "media-uploaded",
                team_id.as_str(),
                serde_json::json!({ "ownerId": owner_id, "mediaId": media_id }).to_string(),
            )
            .await;
        }
        ServerMessage::Media {
            owner_id,
            media_id,
            file_name,
            is_image,
            data,
        } => {
            let bytes = super::server::decode_media(&data).unwrap_or_default();
            let stored = bytes.clone();
            let current_team_id = team_id.to_string();
            let _ = db({
                let database_path = config.database_path.clone();
                let current_team_id = current_team_id.clone();
                let owner_id = owner_id.clone();
                let media_id = media_id.clone();
                let file_name = file_name.clone();
                move || {
                    store::save_media(
                        &database_path,
                        &current_team_id,
                        &media_id,
                        &owner_id,
                        &file_name,
                        is_image,
                        &stored,
                    )
                }
            })
            .await;
            let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sender) = pending.remove(&media_id) {
                let _ = sender.send(Ok((file_name, is_image, bytes)));
            }
        }
        ServerMessage::MediaMissing { media_id } => {
            let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sender) = pending.remove(&media_id) {
                let _ = sender.send(Err("队长侧没有该附件".to_string()));
            }
        }
        ServerMessage::Error { message } => {
            emit_event(
                "error",
                team_id.as_str(),
                serde_json::json!({ "message": message }).to_string(),
            )
            .await;
        }
        ServerMessage::Removed { message } => {
            // 已被队长移出团队：清理本地团队数据并停止重连（仍可凭邀请链接重新加入）。
            let current_team_id = team_id.to_string();
            let _ = db({
                let database_path = config.database_path.clone();
                let current_team_id = current_team_id.clone();
                move || store::delete_team(&database_path, &current_team_id)
            })
            .await;
            emit_event(
                "removed",
                &current_team_id,
                serde_json::json!({ "message": message }).to_string(),
            )
            .await;
            return Some(ConnectionEnd::Removed);
        }
        ServerMessage::Pong => {}
    }
    None
}

async fn local_peer_id(database_path: &PathBuf, team_id: &str) -> String {
    let database_path = database_path.clone();
    let team_id = team_id.to_string();
    db(move || store::get_team(&database_path, &team_id))
        .await
        .ok()
        .flatten()
        .map(|team| team.self_peer_id)
        .unwrap_or_default()
}
