//! 团队协作的网络编排（原生侧）。
//!
//! 队长：在本机启动 WebSocket 服务承载团队数据，队员凭邀请码接入；队员：
//! 维持一条到队长的长连接并持续同步。所有数据都落在本机数据库
//! （见 `storage::services::team`），网络层只负责传输与在线状态。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::{Promise, Status};
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde::Serialize;

use crate::store as store;
use crate::protocol as protocol;
use crate::server as server;
use crate::client as client;

use crate::client::{ClientConfig, ClientHandle, MediaResponse};
use crate::protocol::ClientMessage;
use crate::server::HostHandle;

/// 推送给 Node 主进程的团队事件。
#[napi(object)]
pub struct TeamEventPayload {
    /// 事件类型：status / snapshot / members / record-upserted /
    /// record-deleted / media-uploaded / error / idle / joined / removed。
    pub event: String,
    pub team_id: String,
    /// 事件载荷（JSON 字符串，由渲染层按事件类型解析）。
    pub payload_json: String,
}

/// 事件回调：Node 侧返回 Promise，Rust 不等待其结果。
pub type TeamEventCallback =
    ThreadsafeFunction<TeamEventPayload, Promise<()>, TeamEventPayload, Status, false>;

/// 队长服务状态。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostState {
    pub running: bool,
    pub team_id: String,
    pub port: u16,
    pub endpoint: String,
}

impl HostState {
    fn stopped() -> Self {
        Self {
            running: false,
            team_id: String::new(),
            port: 0,
            endpoint: String::new(),
        }
    }
}

static EVENT_SINK: OnceLock<TeamEventCallback> = OnceLock::new();
static HOST: OnceLock<Mutex<Option<HostHandle>>> = OnceLock::new();
static CLIENTS: OnceLock<Mutex<HashMap<String, Arc<ClientHandle>>>> = OnceLock::new();
/// 待审核队员的客户端占位键：此时还不知道团队 id，收到 Welcome 后迁移到真实 id。
const PENDING_CLIENT_KEY: &str = "";
/// 待审核加入的项目上下文（仅内存）：队长放行前团队数据尚未落库，
/// 凭它告诉渲染层「该项目正在等待审核」，并在收到快照后把项目关联到团队。
static PENDING_JOIN: OnceLock<Mutex<Option<PendingJoinState>>> = OnceLock::new();

#[derive(Clone)]
pub struct PendingJoinState {
    pub directory_id: String,
}

fn host_slot() -> &'static Mutex<Option<HostHandle>> {
    HOST.get_or_init(|| Mutex::new(None))
}

fn client_slot() -> &'static Mutex<HashMap<String, Arc<ClientHandle>>> {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_join_slot() -> &'static Mutex<Option<PendingJoinState>> {
    PENDING_JOIN.get_or_init(|| Mutex::new(None))
}

/// 记录一条待审核加入申请所属的本地项目（换项目申请时覆盖）。
pub fn set_pending_join(directory_id: &str) {
    let directory_id = directory_id.trim().to_string();
    *pending_join_slot().lock().unwrap_or_else(|e| e.into_inner()) = if directory_id.is_empty() {
        None
    } else {
        Some(PendingJoinState { directory_id })
    };
}

/// 清除待审核状态（审核通过、被拒绝或放弃加入）。
pub fn clear_pending_join() {
    *pending_join_slot().lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 放弃待审核的加入申请：断开占位长连接并清除等待状态。
pub fn cancel_pending_join() {
    clear_pending_join();
    disconnect_client(PENDING_CLIENT_KEY);
}

/// 该项目是否有尚未审核通过的加入申请。
pub fn pending_join_matches(directory_id: &str) -> bool {
    let directory_id = directory_id.trim();
    pending_join_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|pending| pending.directory_id == directory_id)
        .unwrap_or(false)
}

/// 注册事件回调（重复注册时保留首次注册的回调）。
pub fn register_event_sink(callback: TeamEventCallback) {
    let _ = EVENT_SINK.set(callback);
}

/// 推送一条事件给 Node 主进程；未注册回调时静默丢弃。
pub async fn emit_event(event: &str, team_id: &str, payload_json: String) {
    let Some(sink) = EVENT_SINK.get() else {
        return;
    };
    let _ = sink
        .call_async_catch(TeamEventPayload {
            event: event.to_string(),
            team_id: team_id.to_string(),
            payload_json,
        })
        .await;
}

/// 在阻塞线程池中执行一次数据库操作（Rust 侧不做同步 I/O）。
pub async fn db<T: Send + 'static>(
    run: impl FnOnce() -> napi::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|error| format!("team task failed: {error}"))?
        .map_err(|error| error.reason.clone())
}

pub(crate) fn new_peer_id() -> String {
    format!(
        "peer-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..20]
    )
}

/// 设备在团队内的固定 peer id：同一设备退出或被移除后再加入，仍是同一身份。
pub(crate) fn peer_id_for_client(team_id: &str, client_id: &str) -> String {
    let hash = blake3::hash(format!("{}:{}", team_id.trim(), client_id.trim()).as_bytes());
    format!("peer-{}", &hash.to_hex()[..20])
}

/// 本机设备标识：加入申请去重与队长黑名单都以它为依据。
/// 首次使用时生成并持久化到系统设置，之后保持不变。
pub fn local_client_id(database_path: &std::path::Path) -> String {
    const SETTING_CODE: &str = "team_client_id";
    if let Ok(Some(value)) =
        snow_storage_core::system_settings::get_system_setting_value(
            database_path,
            SETTING_CODE,
        )
    {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let generated = format!(
        "client-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..20]
    );
    let _ = snow_storage_core::system_settings::set_system_setting(
        database_path,
        "团队设备标识",
        SETTING_CODE,
        &generated,
    );
    generated
}

/// 队长服务默认监听端口（固定端口，队员保存的连接地址在重启后依然有效）。
pub const DEFAULT_HOST_PORT: u16 = 17880;
const HOST_PORT_SETTING: &str = "team_host_port";

/// 读取队长服务监听端口：未配置或配置非法时使用默认端口。
pub fn configured_host_port(database_path: &std::path::Path) -> u16 {
    snow_storage_core::system_settings::get_system_setting_value(
        database_path,
        HOST_PORT_SETTING,
    )
    .ok()
    .flatten()
    .and_then(|value| value.trim().parse::<u16>().ok())
    .filter(|port| *port != 0)
    .unwrap_or(DEFAULT_HOST_PORT)
}

/// 保存队长服务监听端口。
pub fn save_host_port(database_path: &std::path::Path, port: u16) -> napi::Result<()> {
    snow_storage_core::system_settings::set_system_setting(
        database_path,
        "团队队长服务端口",
        HOST_PORT_SETTING,
        &port.to_string(),
    )
}

// ===== 队长服务 =====

/// 启动队长服务（`port` 为 0 时由系统分配）。
pub async fn start_host(
    database_path: PathBuf,
    team_id: String,
    port: u16,
) -> Result<HostState, String> {
    stop_host().await;
    let handle = server::start(database_path, team_id, port).await?;
    let state = HostState {
        running: true,
        team_id: handle.team_id.clone(),
        port: handle.port,
        endpoint: handle.endpoint.clone(),
    };
    *host_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    Ok(state)
}

/// 停止队长服务。
pub async fn stop_host() {
    let handle = host_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(handle) = handle {
        server::stop(handle).await;
    }
}

/// 解散团队时关闭队长服务：先通知在线成员与待审核申请者（对方随即清理本地副本），
/// 等连接把通知发出（上限 3 秒）后再停服务。仅处理本机正在承载的该团队。
pub async fn disband_host(team_id: &str) {
    let Some(hub) = host_hub().filter(|hub| hub.team_id == team_id) else {
        return;
    };
    hub.close_all("队长已解散团队");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while hub.active_connections() > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    stop_host().await;
}

/// 查询队长服务状态（同步、无 I/O）。
pub fn host_state() -> HostState {
    let slot = host_slot().lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_ref() {
        Some(handle) => HostState {
            running: true,
            team_id: handle.team_id.clone(),
            port: handle.port,
            endpoint: handle.endpoint.clone(),
        },
        None => HostState::stopped(),
    }
}

/// 队长侧把一条变更广播给所有在线队员（本地写入后调用）。
pub fn host_broadcast(message: protocol::ServerMessage) {
    let slot = host_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = slot.as_ref() {
        handle.hub.broadcast(None, message);
    }
}

/// 取出当前队长服务的连接表（未运行时返回 None）。
fn host_hub() -> Option<Arc<server::Hub>> {
    let slot = host_slot().lock().unwrap_or_else(|e| e.into_inner());
    slot.as_ref().map(|handle| handle.hub.clone())
}

/// 队长移除成员：删除其成员记录、断开连接并广播最新成员列表。
///
/// 只解除当前会话——被移除者仍可凭邀请链接重新加入，不做永久封禁。
pub async fn host_remove_member(
    database_path: PathBuf,
    team_id: String,
    peer_id: String,
) -> Result<(), String> {
    let hub = host_hub();
    if let Some(hub) = hub.as_ref() {
        if hub.team_id != team_id {
            return Err("该团队不由本机承载队长服务".to_string());
        }
    }
    let removed = db({
        let database_path = database_path.clone();
        let team_id = team_id.clone();
        let peer_id = peer_id.clone();
        move || store::delete_member(&database_path, &team_id, &peer_id)
    })
    .await?;
    if !removed {
        return Err("成员不存在".to_string());
    }
    if let Some(hub) = hub {
        hub.kick(
            &peer_id,
            protocol::ServerMessage::Removed {
                message: "你已被队长移出团队".to_string(),
            },
        );
        server::broadcast_members(&hub, None).await;
    }
    Ok(())
}

/// 当前待审核的加入申请（队长面板展示；未承载该团队时为空）。
pub fn pending_join_requests(team_id: &str) -> Vec<server::PendingJoinInfo> {
    match host_hub() {
        Some(hub) if hub.team_id == team_id => hub.pending_requests(),
        _ => Vec::new(),
    }
}

/// 队长裁决一条加入申请：通过时下发重连令牌，拒绝时通知队员。
pub fn respond_join_request(
    team_id: &str,
    request_id: &str,
    approve: bool,
) -> Result<(), String> {
    let hub = host_hub().ok_or_else(|| "队长服务未运行".to_string())?;
    if hub.team_id != team_id {
        return Err("该团队不由本机承载队长服务".to_string());
    }
    let decision = if approve {
        server::JoinDecision::Approved {
            token: store::generate_member_token(),
        }
    } else {
        server::JoinDecision::Rejected {
            message: "队长拒绝了你的加入申请".to_string(),
        }
    };
    hub.resolve_pending(request_id, decision)
}

// ===== 队员客户端 =====

/// 用邀请码申请加入团队：队长已放行时写入本地数据并返回团队信息，
/// 首次加入则返回待审核状态（队长同意后由长连接写入数据）。
///
/// `project_directory_id` / `project_name` 是本机发起加入的项目，
/// 审核通过后把该项目关联到团队，加入后即可直接进入团队面板。
#[allow(clippy::too_many_arguments)]
pub async fn join_via_invite(
    database_path: PathBuf,
    endpoint: String,
    invite_code: String,
    client_id: String,
    name: String,
    color: String,
    project_directory_id: String,
    project_name: String,
) -> Result<client::JoinOutcome, String> {
    client::join_via_host(
        database_path,
        endpoint,
        invite_code,
        client_id,
        name,
        color,
        project_directory_id,
        project_name,
    )
    .await
}

/// 启动（或替换）队员客户端的长连接。
pub fn connect_client(config: ClientConfig) {
    let team_id = config.team_id.clone();
    let handle = Arc::new(client::connect(config));
    let previous = client_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(team_id, handle);
    if let Some(previous) = previous {
        client::stop(&previous);
    }
}

/// 收到 Welcome 后把该客户端句柄登记到真实团队 id 下（按句柄 id 精确定位）。
///
/// 待审核时句柄挂在占位键下；若真实 id 下残留旧句柄（如被移出后重新加入），
/// 必须替换掉，否则 `client_send` 会命中已失效的旧连接。
pub fn bind_client(handle_id: u64, team_id: &str) {
    let team_id = team_id.trim();
    if team_id.is_empty() {
        return;
    }
    let mut clients = client_slot().lock().unwrap_or_else(|e| e.into_inner());
    let Some(key) = clients
        .iter()
        .find(|(_, handle)| handle.id == handle_id)
        .map(|(key, _)| key.clone())
    else {
        return;
    };
    if key == team_id {
        return;
    }
    if let Some(handle) = clients.remove(&key) {
        if let Some(previous) = clients.insert(team_id.to_string(), handle) {
            client::stop(&previous);
        }
    }
}

/// 客户端任务终止（被移出 / 被拒绝）时移除自己的句柄，不影响后来替换的新句柄。
pub fn release_client(handle_id: u64) {
    client_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, handle| handle.id != handle_id);
}

/// 断开队员客户端。
pub fn disconnect_client(team_id: &str) {
    let handle = client_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(team_id);
    if let Some(handle) = handle {
        client::stop(&handle);
    }
}

/// 断开全部队员客户端（应用退出时调用）。
pub fn disconnect_all_clients() {
    let handles: Vec<Arc<ClientHandle>> = client_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .map(|(_, handle)| handle)
        .collect();
    for handle in handles {
        client::stop(&handle);
    }
}

fn client_handle(team_id: &str) -> Option<Arc<ClientHandle>> {
    client_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(team_id)
        .filter(|handle| handle.is_alive())
        .cloned()
}

/// 把本地改动推给队长；未连接时返回 false。
pub fn client_send(team_id: &str, message: ClientMessage) -> bool {
    match client_handle(team_id) {
        Some(handle) => handle.send(message),
        None => false,
    }
}

/// 队员是否已连接队长。
pub fn is_client_connected(team_id: &str) -> bool {
    client_handle(team_id).is_some()
}

/// 向队长请求附件内容（本地没有时使用）。
pub async fn client_request_media(
    team_id: &str,
    media_id: &str,
) -> Result<MediaResponse, String> {
    let Some(handle) = client_handle(team_id) else {
        return Err("尚未连接队长".to_string());
    };
    handle.request_media(media_id).await
}

/// 生成邀请链接（仅队长侧使用）。
pub fn build_invite_link(invite_code: &str, endpoint: &str) -> String {
    format!(
        "snow-team://join?host={}&code={}",
        endpoint.trim(),
        invite_code.trim()
    )
}

/// 解析邀请链接，返回 `(endpoint, invite_code)`。
pub fn parse_invite_link(link: &str) -> std::result::Result<(String, String), String> {
    let trimmed = link.trim();
    let rest = trimmed
        .strip_prefix("snow-team://join?")
        .or_else(|| trimmed.strip_prefix("snowteam://join?"))
        .ok_or_else(|| "邀请链接格式不正确".to_string())?;
    let mut endpoint = String::new();
    let mut code = String::new();
    for pair in rest.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = percent_decode(value);
        match key.trim() {
            "host" => endpoint = value,
            "code" => code = value.to_uppercase(),
            _ => {}
        }
    }
    if endpoint.is_empty() || code.is_empty() {
        return Err("邀请链接缺少必要参数".to_string());
    }
    Ok((endpoint, code))
}

fn percent_decode(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8_lossy()
        .to_string()
}
