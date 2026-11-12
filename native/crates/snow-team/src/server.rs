//! 队长侧的团队 WebSocket 服务。
//!
//! 队长设备监听局域网端口，队员凭邀请码握手接入；所有团队数据都读写本机
//! 数据库，并即时广播给其他在线成员。服务生命周期由 `super` 编排。

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

use crate::store as store;
use crate::store::{TeamMemberRecord};

use super::protocol::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
use super::{db, emit_event};

/// 握手等待上限：连上却不发 hello 的连接会被直接断开。
const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
/// 加入申请的审核等待上限：超时视为未通过（连接断开，队员可重试）。
const JOIN_APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);
/// 单条附件上限（与数据层一致：5 MB 原始字节）。
const MAX_MEDIA_BYTES: usize = store::MEDIA_MAX_BYTES;

/// 连接序号：区分同一成员的新旧连接，旧连接收尾时不能误注销新连接。
static CONNECTION_SEQ: AtomicU64 = AtomicU64::new(1);

/// 一个在线连接的发送端。
struct PeerHandle {
    connection_id: u64,
    sender: mpsc::UnboundedSender<ServerMessage>,
}

/// 队长对一条加入申请的裁决。
pub enum JoinDecision {
    /// 通过：附带队长下发的重连令牌。
    Approved { token: String },
    /// 拒绝：附带给队员的说明。
    Rejected { message: String },
}

/// 待审核的加入申请（仅存内存：连接断开即失效）。
struct PendingJoin {
    client_id: String,
    name: String,
    color: String,
    created_at: String,
    /// 登记该申请的连接序号：被新连接接管后，旧连接收尾不得删除新申请。
    connection_id: u64,
    /// 裁决通道；已被审批或已被新连接接管时为 None。
    decision: Option<oneshot::Sender<JoinDecision>>,
}

/// 推送给渲染层的待审核申请（队长面板展示用）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingJoinInfo {
    pub request_id: String,
    pub client_id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
}

/// 在线连接表：单发与广播都经由这里。
pub struct Hub {
    pub database_path: PathBuf,
    pub team_id: String,
    peers: Mutex<HashMap<String, PeerHandle>>,
    /// 待审核的加入申请，按 request_id 索引。
    pending: Mutex<HashMap<String, PendingJoin>>,
    /// 存活连接数（含握手 / 待审核中的连接），解散时据此等待通知发出。
    connections: AtomicUsize,
}

/// 连接存活计数守卫：连接任务结束（含提前返回）时自动减一。
struct ConnectionGuard(std::sync::Arc<Hub>);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Hub {
    fn new(database_path: PathBuf, team_id: String) -> Self {
        Self {
            database_path,
            team_id,
            peers: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            connections: AtomicUsize::new(0),
        }
    }

    pub(crate) fn active_connections(&self) -> usize {
        self.connections.load(Ordering::Relaxed)
    }

    /// 团队解散：拒绝全部待审核申请，并通知全部在线成员已被移出（各连接随后自行断开）。
    pub(crate) fn close_all(&self, message: &str) {
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            for item in pending.values_mut() {
                if let Some(sender) = item.decision.take() {
                    let _ = sender.send(JoinDecision::Rejected {
                        message: message.to_string(),
                    });
                }
            }
        }
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        for (_, peer) in peers.drain() {
            let _ = peer.sender.send(ServerMessage::Removed {
                message: message.to_string(),
            });
        }
    }

    /// 登记一条加入申请；同一设备已有申请时沿用其 request_id 并接管裁决通道。
    fn register_pending(
        &self,
        connection_id: u64,
        client_id: &str,
        name: &str,
        color: &str,
    ) -> (String, oneshot::Receiver<JoinDecision>) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let request_id = pending
            .iter()
            .find(|(_, item)| item.client_id == client_id)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| format!("join-{}", &uuid::Uuid::new_v4().simple().to_string()[..20]));
        let (tx, rx) = oneshot::channel();
        pending.insert(
            request_id.clone(),
            PendingJoin {
                client_id: client_id.to_string(),
                name: name.to_string(),
                color: color.to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                connection_id,
                decision: Some(tx),
            },
        );
        (request_id, rx)
    }

    /// 提交裁决；申请已失效或已被处理时返回错误。
    pub(crate) fn resolve_pending(
        &self,
        request_id: &str,
        decision: JoinDecision,
    ) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = pending.get_mut(request_id) else {
            return Err("该加入申请已失效".to_string());
        };
        let Some(sender) = entry.decision.take() else {
            return Err("该加入申请已处理".to_string());
        };
        let _ = sender.send(decision);
        Ok(())
    }

    /// 只删除本连接登记的申请（已被同设备新连接接管的保留）。
    fn remove_pending(&self, request_id: &str, connection_id: u64) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending
            .get(request_id)
            .map(|item| item.connection_id == connection_id)
            .unwrap_or(false)
        {
            pending.remove(request_id);
        }
    }

    /// 当前待审核申请列表（按提交时间升序）。
    pub fn pending_requests(&self) -> Vec<PendingJoinInfo> {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut items: Vec<PendingJoinInfo> = pending
            .iter()
            .map(|(request_id, item)| PendingJoinInfo {
                request_id: request_id.clone(),
                client_id: item.client_id.clone(),
                name: item.name.clone(),
                color: item.color.clone(),
                created_at: item.created_at.clone(),
            })
            .collect();
        items.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        items
    }

    fn register(
        &self,
        peer_id: &str,
        connection_id: u64,
        sender: mpsc::UnboundedSender<ServerMessage>,
    ) {
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.insert(
            peer_id.to_string(),
            PeerHandle {
                connection_id,
                sender,
            },
        );
    }

    /// 只注销本连接；同一成员已有新连接接管时保留新连接。
    fn unregister(&self, peer_id: &str, connection_id: u64) {
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        if peers
            .get(peer_id)
            .map(|peer| peer.connection_id == connection_id)
            .unwrap_or(false)
        {
            peers.remove(peer_id);
        }
    }

    fn is_peer_online(&self, peer_id: &str) -> bool {
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.contains_key(peer_id)
    }

    /// 踢下线：先送出说明消息，再移除发送端（对应连接随后自行结束）。
    pub(crate) fn kick(&self, peer_id: &str, message: ServerMessage) {
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(peer) = peers.remove(peer_id) {
            let _ = peer.sender.send(message);
        }
    }

    fn send_to(&self, peer_id: &str, message: ServerMessage) {
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(peer) = peers.get(peer_id) {
            let _ = peer.sender.send(message);
        }
    }

    pub(crate) fn broadcast(&self, except: Option<&str>, message: ServerMessage) {
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        for (peer_id, peer) in peers.iter() {
            if Some(peer_id.as_str()) == except {
                continue;
            }
            let _ = peer.sender.send(message.clone());
        }
    }

    fn online_peer_ids(&self) -> HashSet<String> {
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.keys().cloned().collect()
    }

    fn is_empty(&self) -> bool {
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.is_empty()
    }
}

/// 已启动的队长服务句柄。
pub struct HostHandle {
    pub team_id: String,
    pub port: u16,
    /// 对外可连地址（`<局域网 IP>:<端口>`）。
    pub endpoint: String,
    pub hub: std::sync::Arc<Hub>,
    shutdown: Option<oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

/// 取本机在默认路由上使用的局域网 IPv4 地址。
pub fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // 只用于让内核选出出口网卡，不会真正发送数据。
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip())
}

/// 组装对外可连地址；无法探测局域网地址时退回回环地址。
pub fn endpoint_for(port: u16) -> String {
    match lan_ip() {
        Some(ip) => format!("{ip}:{port}"),
        None => format!("127.0.0.1:{port}"),
    }
}

/// 启动队长服务；`port` 为 0 时由系统分配端口。
pub async fn start(
    database_path: PathBuf,
    team_id: String,
    port: u16,
) -> Result<HostHandle, String> {
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|error| format!("监听团队服务端口失败：{error}"))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("读取团队服务端口失败：{error}"))?
        .port();

    let hub = std::sync::Arc::new(Hub::new(database_path.clone(), team_id.clone()));
    let app = Router::new()
        .route("/team/ws", get(ws_handler))
        .with_state(hub.clone());

    let (shutdown, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    Ok(HostHandle {
        team_id,
        port: bound_port,
        endpoint: endpoint_for(bound_port),
        hub,
        shutdown: Some(shutdown),
        join,
    })
}

/// 停止队长服务（优雅关闭，超时后强制中止）。
pub async fn stop(handle: HostHandle) {
    if let Some(shutdown) = handle.shutdown {
        let _ = shutdown.send(());
    }
    let mut join = handle.join;
    if tokio::time::timeout(Duration::from_secs(3), &mut join)
        .await
        .is_err()
    {
        join.abort();
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(hub): State<std::sync::Arc<Hub>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, hub))
}

/// 单条连接的生命周期：握手（令牌重连或邀请码申请审核）→ 快照 → 双向增量 → 断开清理。
async fn handle_socket(socket: WebSocket, hub: std::sync::Arc<Hub>) {
    let (mut tx, mut rx) = socket.split();
    let connection_id = CONNECTION_SEQ.fetch_add(1, Ordering::Relaxed);
    hub.connections.fetch_add(1, Ordering::Relaxed);
    let _guard = ConnectionGuard(hub.clone());

    let hello = match tokio::time::timeout(HELLO_TIMEOUT, wait_hello(&mut rx)).await {
        Ok(Some(hello)) => hello,
        _ => {
            let _ = tx
                .send(text_message(&ServerMessage::Error {
                    message: "握手超时".to_string(),
                }))
                .await;
            return;
        }
    };

    if hello.protocol != 0 && hello.protocol != PROTOCOL_VERSION {
        let _ = tx
            .send(text_message(&ServerMessage::Error {
                message: format!("协议版本不匹配（本机 {PROTOCOL_VERSION}）"),
            }))
            .await;
        return;
    }

    // 设备标识：黑名单判定与加入申请去重都以它为准。
    let client_id = if hello.client_id.trim().is_empty() {
        super::new_peer_id()
    } else {
        hello.client_id.trim().to_string()
    };

    // 黑名单优先：被拉黑的设备无论是否持有有效令牌都拒绝。
    match db({
        let database_path = hub.database_path.clone();
        let team_id = hub.team_id.clone();
        let client_id = client_id.clone();
        move || store::is_blocked(&database_path, &team_id, &client_id)
    })
    .await
    {
        Ok(true) => {
            let _ = tx
                .send(text_message(&ServerMessage::JoinRejected {
                    message: "你已被队长加入黑名单，无法加入该团队".to_string(),
                }))
                .await;
            return;
        }
        Ok(false) => {}
        Err(error) => {
            let _ = tx
                .send(text_message(&ServerMessage::Error { message: error }))
                .await;
            return;
        }
    }

    // 1) 已加入成员凭重连令牌免审核恢复身份。
    // stale_token：持有令牌但本机已查无此人（团队已解散或已被移出）。
    let mut stale_token = false;
    let reconnected = if hello.token.trim().is_empty() {
        None
    } else {
        let token = hello.token.trim().to_string();
        match db({
            let database_path = hub.database_path.clone();
            move || store::find_member_by_token(&database_path, &token)
        })
        .await
        {
            Ok(Some((team_id, member))) if team_id == hub.team_id => Some(member),
            Ok(None) => {
                stale_token = true;
                None
            }
            _ => None,
        }
    };

    // 2) 同一设备再次加入：沿用已有成员身份（一台设备只代表一个人），
    //    避免同一台设备在成员列表里出现多条记录。
    let known_member = if reconnected.is_none() && !client_id.is_empty() {
        match db({
            let database_path = hub.database_path.clone();
            let team_id = hub.team_id.clone();
            let client_id = client_id.clone();
            move || store::find_member_by_client_id(&database_path, &team_id, &client_id)
        })
        .await
        {
            Ok(member) => member,
            Err(_) => None,
        }
    } else {
        None
    };
    // 队长设备自己不能作为队员再加入：身份是唯一的（本机 = 队长）。
    if known_member
        .as_ref()
        .map(|member| member.role == store::ROLE_HOST)
        .unwrap_or(false)
    {
        let _ = tx
            .send(text_message(&ServerMessage::JoinRejected {
                message: "本机已是该团队的队长，无需再加入".to_string(),
            }))
            .await;
        return;
    }

    let (peer_id, member_token) = match reconnected {
        Some(member) => (member.peer_id, hello.token.trim().to_string()),
        None => {
            // 3) 首次加入：校验邀请码 → 登记申请 → 等待队长审核。
            let team = match db({
                let database_path = hub.database_path.clone();
                let invite_code = hello.invite_code.clone();
                move || store::get_team_by_invite_code(&database_path, &invite_code)
            })
            .await
            {
                Ok(Some(team)) if team.invite_code == hello.invite_code.trim().to_uppercase() => team,
                Ok(_) => {
                    // 旧成员的令牌与邀请码都已失效：团队已不存在，通知其清理本地副本。
                    let message = if stale_token {
                        ServerMessage::Removed {
                            message: "该团队已解散或你已不在团队中".to_string(),
                        }
                    } else {
                        ServerMessage::Error {
                            message: "邀请码无效或已失效".to_string(),
                        }
                    };
                    let _ = tx.send(text_message(&message)).await;
                    return;
                }
                Err(error) => {
                    let _ = tx
                        .send(text_message(&ServerMessage::Error { message: error }))
                        .await;
                    return;
                }
            };

            if team.team_id != hub.team_id {
                let _ = tx
                    .send(text_message(&ServerMessage::Error {
                        message: "该邀请码不属于本团队".to_string(),
                    }))
                    .await;
                return;
            }

            // 同一设备固定同一 peer id：退出或被移除后再加入，身份与历史记录保持不变。
            let peer_id = known_member
                .as_ref()
                .map(|member| member.peer_id.clone())
                .unwrap_or_else(|| super::peer_id_for_client(&hub.team_id, &client_id));
            let (request_id, decision_rx) = hub.register_pending(
                connection_id,
                &client_id,
                &display_name(&hello.name),
                hello.color.trim(),
            );
            let _ = tx
                .send(text_message(&ServerMessage::JoinPending {
                    request_id: request_id.clone(),
                }))
                .await;
            emit_pending(&hub).await;

            let decision = wait_decision(&mut rx, &mut tx, decision_rx).await;
            hub.remove_pending(&request_id, connection_id);
            emit_pending(&hub).await;

            match decision {
                Some(JoinDecision::Approved { token }) => (peer_id, token),
                Some(JoinDecision::Rejected { message }) => {
                    let _ = tx
                        .send(text_message(&ServerMessage::JoinRejected { message }))
                        .await;
                    return;
                }
                // 超时或已被同一设备的新连接接管：按普通错误处理，客户端退避重连。
                None => {
                    let _ = tx
                        .send(text_message(&ServerMessage::Error {
                            message: "加入申请未通过审核".to_string(),
                        }))
                        .await;
                    return;
                }
            }
        }
    };

    let name = display_name(&hello.name);
    let color = hello.color.trim().to_string();

    let snapshot = match db({
        let database_path = hub.database_path.clone();
        let team_id = hub.team_id.clone();
        move || store::team_snapshot(&database_path, &team_id)
    })
    .await
    {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return,
        Err(_) => return,
    };

    let _ = db({
        let database_path = hub.database_path.clone();
        let team_id = hub.team_id.clone();
        let peer_id = peer_id.clone();
        let name = name.clone();
        let color = color.clone();
        let client_id = client_id.clone();
        let member_token = member_token.clone();
        move || {
            store::upsert_member(
                &database_path,
                &team_id,
                &TeamMemberRecord {
                    peer_id,
                    name,
                    color,
                    role: store::ROLE_MEMBER.to_string(),
                    online: true,
                    joined_at: String::new(),
                    last_seen: String::new(),
                },
                &client_id,
                &member_token,
            )
        }
    })
    .await;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMessage>();
    hub.register(&peer_id, connection_id, out_tx);

    let welcome = ServerMessage::Welcome {
        team: snapshot.team.clone(),
        peer_id: peer_id.clone(),
        token: member_token.clone(),
        projects: snapshot.projects.clone(),
        members: snapshot.members.clone(),
        records: snapshot.records.clone(),
    };
    if tx.send(text_message(&welcome)).await.is_err() {
        hub.unregister(&peer_id, connection_id);
        return;
    }
    broadcast_members(&hub, None).await;
    emit_event(
        "members",
        &hub.team_id,
        serde_json::to_string(&snapshot.members).unwrap_or_else(|_| "[]".to_string()),
    )
    .await;

    loop {
        tokio::select! {
            incoming = rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !handle_client_message(&hub, &peer_id, text.as_str()).await {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Ping(payload))) => {
                        if tx.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Close(_))) => {}
                    Some(Err(_)) | None => break,
                }
            }
            outgoing = out_rx.recv() => {
                match outgoing {
                    Some(message) => {
                        if tx.send(text_message(&message)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    hub.unregister(&peer_id, connection_id);
    // 断开只标记离线：成员记录与重连令牌保留，队员重连时免审核。
    // 已被移除的成员不写回；同一成员已有新连接时保持在线。
    if !hub.is_peer_online(&peer_id) {
        let _ = db({
            let database_path = hub.database_path.clone();
            let team_id = hub.team_id.clone();
            let peer_id = peer_id.clone();
            move || store::set_member_offline(&database_path, &team_id, &peer_id)
        })
        .await;
    }
    broadcast_members(&hub, None).await;
    if hub.is_empty() {
        emit_event("idle", &hub.team_id, "{}".to_string()).await;
    }
}

/// 成员昵称兜底（空昵称统一显示为「队员」）。
fn display_name(name: &str) -> String {
    if name.trim().is_empty() {
        "队员".to_string()
    } else {
        name.trim().to_string()
    }
}

/// 把待审核申请列表推给渲染层（队长面板实时更新）。
async fn emit_pending(hub: &std::sync::Arc<Hub>) {
    let payload =
        serde_json::to_string(&hub.pending_requests()).unwrap_or_else(|_| "[]".to_string());
    emit_event("join-request", &hub.team_id, payload).await;
}

/// 等待队长裁决；期间保持连接（回心跳、忽略其它消息）。
async fn wait_decision(
    rx: &mut futures::stream::SplitStream<WebSocket>,
    tx: &mut futures::stream::SplitSink<WebSocket, Message>,
    decision_rx: oneshot::Receiver<JoinDecision>,
) -> Option<JoinDecision> {
    tokio::pin!(decision_rx);
    let deadline = tokio::time::sleep(JOIN_APPROVAL_TIMEOUT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            decision = &mut decision_rx => return decision.ok(),
            _ = &mut deadline => return None,
            incoming = rx.next() => {
                match incoming {
                    Some(Ok(Message::Ping(payload))) => {
                        if tx.send(Message::Pong(payload)).await.is_err() {
                            return None;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => return None,
                }
            }
        }
    }
}

/// 握手载荷（从 `ClientMessage::Hello` 解构而来）。
struct HelloPayload {
    protocol: u32,
    invite_code: String,
    client_id: String,
    token: String,
    name: String,
    color: String,
}

async fn wait_hello(
    rx: &mut futures::stream::SplitStream<WebSocket>,
) -> Option<HelloPayload> {
    while let Some(Ok(message)) = rx.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        if let Ok(ClientMessage::Hello {
            protocol,
            invite_code,
            client_id,
            token,
            name,
            color,
        }) = serde_json::from_str::<ClientMessage>(text.as_str())
        {
            return Some(HelloPayload {
                protocol,
                invite_code,
                client_id,
                token,
                name,
                color,
            });
        }
    }
    None
}

/// 处理一条客户端消息；返回 false 表示需要断开连接。
async fn handle_client_message(
    hub: &std::sync::Arc<Hub>,
    peer_id: &str,
    raw: &str,
) -> bool {
    let message = match serde_json::from_str::<ClientMessage>(raw) {
        Ok(message) => message,
        Err(error) => {
            hub.send_to(
                peer_id,
                ServerMessage::Error {
                    message: format!("无法解析的消息：{error}"),
                },
            );
            return true;
        }
    };

    match message {
        ClientMessage::Hello { .. } => true,
        ClientMessage::Ping => {
            hub.send_to(peer_id, ServerMessage::Pong);
            true
        }
        ClientMessage::SnapshotRequest => {
            match db({
                let database_path = hub.database_path.clone();
                let team_id = hub.team_id.clone();
                move || store::team_snapshot(&database_path, &team_id)
            })
            .await
            {
                Ok(Some(snapshot)) => hub.send_to(
                    peer_id,
                    ServerMessage::Snapshot {
                        team: snapshot.team,
                        projects: snapshot.projects,
                        members: snapshot.members,
                        records: snapshot.records,
                    },
                ),
                _ => hub.send_to(
                    peer_id,
                    ServerMessage::Error {
                        message: "读取团队数据失败".to_string(),
                    },
                ),
            }
            true
        }
        ClientMessage::RecordUpsert {
            kind,
            record_id,
            payload,
        } => {
            let result = db({
                let database_path = hub.database_path.clone();
                let team_id = hub.team_id.clone();
                let kind = kind.clone();
                let record_id = record_id.clone();
                let payload = payload.clone();
                move || store::upsert_record(&database_path, &team_id, &kind, &record_id, &payload)
            })
            .await;
            match result {
                Ok(payload) => {
                    hub.broadcast(
                        Some(peer_id),
                        ServerMessage::RecordUpserted {
                            kind: kind.clone(),
                            record_id: record_id.clone(),
                            payload: payload.clone(),
                        },
                    );
                    emit_event(
                        "record-upserted",
                        &hub.team_id,
                        serde_json::json!({
                            "kind": kind,
                            "recordId": record_id,
                            "payload": payload,
                        })
                        .to_string(),
                    )
                    .await;
                }
                Err(error) => hub.send_to(peer_id, ServerMessage::Error { message: error }),
            }
            true
        }
        ClientMessage::RecordDelete { kind, record_id } => {
            let result = db({
                let database_path = hub.database_path.clone();
                let team_id = hub.team_id.clone();
                let kind = kind.clone();
                let record_id = record_id.clone();
                move || store::delete_record(&database_path, &team_id, &kind, &record_id)
            })
            .await;
            match result {
                Ok(removed) => {
                    if removed {
                        hub.broadcast(
                            Some(peer_id),
                            ServerMessage::RecordDeleted {
                                kind: kind.clone(),
                                record_id: record_id.clone(),
                            },
                        );
                        emit_event(
                            "record-deleted",
                            &hub.team_id,
                            serde_json::json!({ "kind": kind, "recordId": record_id }).to_string(),
                        )
                        .await;
                    }
                }
                Err(error) => hub.send_to(peer_id, ServerMessage::Error { message: error }),
            }
            true
        }
        ClientMessage::MediaUpload {
            owner_id,
            media_id,
            file_name,
            is_image,
            data,
        } => {
            match decode_media(&data) {
                Ok(bytes) if bytes.len() <= MAX_MEDIA_BYTES => {
                    let result = db({
                        let database_path = hub.database_path.clone();
                        let team_id = hub.team_id.clone();
                        let media_id = media_id.clone();
                        let owner_id = owner_id.clone();
                        let file_name = file_name.clone();
                        move || {
                            store::save_media(
                                &database_path,
                                &team_id,
                                &media_id,
                                &owner_id,
                                &file_name,
                                is_image,
                                &bytes,
                            )
                        }
                    })
                    .await;
                    match result {
                        // 沿用发送方的 media_id 回执：记录里引用的就是它。
                        Ok(media_id) => hub.send_to(
                            peer_id,
                            ServerMessage::MediaUploaded { owner_id, media_id },
                        ),
                        Err(error) => {
                            hub.send_to(peer_id, ServerMessage::Error { message: error })
                        }
                    }
                }
                Ok(_) => hub.send_to(
                    peer_id,
                    ServerMessage::Error {
                        message: "附件超过大小上限".to_string(),
                    },
                ),
                Err(error) => hub.send_to(peer_id, ServerMessage::Error { message: error }),
            }
            true
        }
        ClientMessage::MediaRequest { media_id } => {
            let result = db({
                let database_path = hub.database_path.clone();
                let team_id = hub.team_id.clone();
                let media_id = media_id.clone();
                move || store::read_media(&database_path, &team_id, &media_id)
            })
            .await;
            match result {
                Ok(Some((meta, bytes))) => hub.send_to(
                    peer_id,
                    ServerMessage::Media {
                        owner_id: meta.owner_id,
                        media_id: meta.media_id,
                        file_name: meta.file_name,
                        is_image: meta.is_image,
                        data: encode_media(&bytes),
                    },
                ),
                Ok(None) => hub.send_to(
                    peer_id,
                    ServerMessage::MediaMissing {
                        media_id: media_id.clone(),
                    },
                ),
                Err(error) => hub.send_to(peer_id, ServerMessage::Error { message: error }),
            }
            true
        }
    }
}

/// 读取成员列表并叠加在线状态后广播。
pub(crate) async fn broadcast_members(hub: &std::sync::Arc<Hub>, except: Option<&str>) {
    let online = hub.online_peer_ids();
    let result = db({
        let database_path = hub.database_path.clone();
        let team_id = hub.team_id.clone();
        move || store::list_members(&database_path, &team_id)
    })
    .await;
    let Ok(mut members) = result else {
        return;
    };
    for member in members.iter_mut() {
        // 队长不在连接表里：广播本身就是队长服务在运行，按在线处理。
        member.online = member.role == store::ROLE_HOST || online.contains(&member.peer_id);
    }
    hub.broadcast(except, ServerMessage::Members {
        members: members.clone(),
    });
    emit_event(
        "members",
        &hub.team_id,
        serde_json::to_string(&members).unwrap_or_else(|_| "[]".to_string()),
    )
    .await;
}

fn text_message(message: &ServerMessage) -> Message {
    Message::Text(serde_json::to_string(message).unwrap_or_default().into())
}

/// 解码 base64（兼容 `data:*/*;base64,` 前缀）。
pub fn decode_media(data: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
    let trimmed = data.trim();
    let payload = match trimmed.strip_prefix("data:") {
        Some(rest) => rest
            .split_once(',')
            .map(|(_, value)| value)
            .ok_or_else(|| "附件数据格式非法".to_string())?,
        None => trimmed,
    };
    BASE64_STANDARD
        .decode(payload)
        .map_err(|error| format!("附件数据解码失败：{error}"))
}

/// 编码为裸 base64。
pub fn encode_media(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
    BASE64_STANDARD.encode(bytes)
}
