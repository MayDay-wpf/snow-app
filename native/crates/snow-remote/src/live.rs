//! 手机远控实时通道（/api/live）。
//!
//! 状态中枢：有活跃订阅时按节拍从渲染进程拉取快照（流式中 500ms，空闲 1s），
//! 所有手机共享同一份快照；每个 WebSocket 会话按自己已下发的版本计算增量
//! 补丁（json_patch），只把变化部分推给手机。无人订阅（或全部转入后台暂停）
//! 时中枢自动停转。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{watch, Notify};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::bridge::{self, BridgeError};
use super::json_patch;

/// 运行中（流式 / 压缩）的拉取节拍。
const FAST_TICK: Duration = Duration::from_millis(500);
/// 空闲时的拉取节拍。
const IDLE_TICK: Duration = Duration::from_millis(1000);
/// 心跳间隔：保持反向代理 / 隧道连接不被空闲回收，并复查凭据。
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// 凭据失效（令牌轮换 / 服务重启）。
const CLOSE_UNAUTHORIZED: u16 = 4401;
/// 服务停止。
const CLOSE_SHUTDOWN: u16 = 4001;
/// 渲染进程桥的通用失败文案。
const BRIDGE_FALLBACK_MESSAGE: &str = "Snow 暂时无法处理该请求";

static NULL_VALUE: Value = Value::Null;

/// 中枢共享快照。
#[derive(Default)]
struct HubSnapshot {
    state: Option<Arc<Value>>,
    rollback: Option<Arc<Value>>,
    error: Option<(u16, String)>,
}

struct Hub {
    snapshot: watch::Sender<Arc<HubSnapshot>>,
    /// 已开始的拉取序号。
    started: AtomicU64,
    /// 已完成的拉取序号：sync 等到请求之后开始的那一拍完成再确认。
    ticks: watch::Sender<u64>,
    nudge: Notify,
    active: AtomicUsize,
    rollback_watchers: AtomicUsize,
    running: AtomicBool,
}

static HUB: OnceLock<Hub> = OnceLock::new();

fn hub() -> &'static Hub {
    HUB.get_or_init(|| Hub {
        snapshot: watch::channel(Arc::new(HubSnapshot::default())).0,
        started: AtomicU64::new(0),
        ticks: watch::channel(0).0,
        nudge: Notify::new(),
        active: AtomicUsize::new(0),
        rollback_watchers: AtomicUsize::new(0),
        running: AtomicBool::new(false),
    })
}

/// 立即触发一次拉取（远程变更操作之后调用）。
pub fn nudge() {
    if let Some(hub) = HUB.get() {
        if hub.running.load(Ordering::SeqCst) {
            hub.nudge.notify_one();
        }
    }
}

fn ensure_running(hub: &'static Hub) {
    if !hub.running.swap(true, Ordering::SeqCst) {
        tokio::spawn(run_hub());
    }
}

/// 活跃订阅计数（后台暂停的会话不计入）。
struct ActiveGuard;

impl ActiveGuard {
    fn acquire() -> Self {
        let hub = hub();
        hub.active.fetch_add(1, Ordering::SeqCst);
        ensure_running(hub);
        Self
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        hub().active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 回滚状态订阅计数：有人订阅时中枢才额外拉取 getRollbackState。
struct RollbackGuard;

impl RollbackGuard {
    fn acquire() -> Self {
        hub().rollback_watchers.fetch_add(1, Ordering::SeqCst);
        nudge();
        Self
    }
}

impl Drop for RollbackGuard {
    fn drop(&mut self) {
        hub().rollback_watchers.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn run_hub() {
    let hub = hub();
    loop {
        if hub.active.load(Ordering::SeqCst) == 0 {
            hub.snapshot.send_replace(Arc::new(HubSnapshot::default()));
            hub.running.store(false, Ordering::SeqCst);
            // 退出前复查，避免与新订阅竞态导致无人拉取。
            if hub.active.load(Ordering::SeqCst) == 0 || hub.running.swap(true, Ordering::SeqCst) {
                return;
            }
            continue;
        }
        let tick = hub.started.fetch_add(1, Ordering::SeqCst) + 1;
        let busy = refresh_snapshot(hub).await;
        hub.ticks.send_replace(tick);
        let delay = if busy { FAST_TICK } else { IDLE_TICK };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = hub.nudge.notified() => {}
        }
    }
}

fn bridge_error(error: BridgeError) -> (u16, String) {
    match error {
        BridgeError::NotReady => (409, "远程控制桥尚未就绪".to_string()),
        BridgeError::Renderer(message) => {
            let reason: String = message.trim().chars().take(200).collect();
            if reason.is_empty() {
                (409, BRIDGE_FALLBACK_MESSAGE.to_string())
            } else {
                (409, reason)
            }
        }
        BridgeError::Dispatch => (503, BRIDGE_FALLBACK_MESSAGE.to_string()),
    }
}

fn is_busy(state: &Value) -> bool {
    state.get("isStreaming").and_then(Value::as_bool) == Some(true)
        || state.get("isCompacting").and_then(Value::as_bool) == Some(true)
}

/// 拉取一次快照并在变化时发布；返回是否处于运行中（决定下一拍间隔）。
async fn refresh_snapshot(hub: &Hub) -> bool {
    let result = bridge::call("getState", json!([])).await;
    let watch_rollback = hub.rollback_watchers.load(Ordering::SeqCst) > 0;
    let rollback = if watch_rollback {
        bridge::call("getRollbackState", json!([])).await.ok()
    } else {
        None
    };
    match result {
        Ok(state) => {
            let busy = is_busy(&state);
            hub.snapshot.send_if_modified(move |slot| {
                let next_rollback = match rollback {
                    Some(value) => match &slot.rollback {
                        Some(previous) if **previous == value => Some(previous.clone()),
                        _ => Some(Arc::new(value)),
                    },
                    // 拉取失败时沿用上一份，避免弹层闪断。
                    None if watch_rollback => slot.rollback.clone(),
                    None => None,
                };
                let same_state = slot.state.as_deref() == Some(&state);
                let same_rollback = slot.rollback.as_deref() == next_rollback.as_deref();
                if slot.error.is_none() && same_state && same_rollback {
                    return false;
                }
                let next_state = if same_state {
                    slot.state.clone()
                } else {
                    Some(Arc::new(state))
                };
                *slot = Arc::new(HubSnapshot {
                    state: next_state,
                    rollback: next_rollback,
                    error: None,
                });
                true
            });
            busy
        }
        Err(error) => {
            let error = bridge_error(error);
            hub.snapshot.send_if_modified(move |slot| {
                if slot.error.as_ref() == Some(&error) {
                    return false;
                }
                *slot = Arc::new(HubSnapshot {
                    state: None,
                    rollback: None,
                    error: Some(error),
                });
                true
            });
            false
        }
    }
}

// ─── 会话 ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct FullFrame<'a> {
    t: &'static str,
    state: &'a Value,
    rollback: &'a Value,
}

#[derive(Serialize)]
struct PatchFrame {
    t: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rollback: Option<Value>,
}

/// 单个会话已下发的版本（补丁基线）。
#[derive(Default)]
struct ClientView {
    state: Option<Arc<Value>>,
    rollback: Option<Arc<Value>>,
    error: Option<(u16, String)>,
}

impl ClientView {
    fn reset(&mut self) {
        *self = Self::default();
    }

    /// 基于共享快照生成本会话需要下发的帧；无变化返回 None。
    fn frame(&mut self, snapshot: &HubSnapshot, watching_rollback: bool) -> Option<String> {
        if let Some(error) = &snapshot.error {
            if self.error.as_ref() == Some(error) {
                return None;
            }
            self.error = Some(error.clone());
            self.state = None;
            self.rollback = None;
            return serde_json::to_string(
                &json!({ "t": "error", "status": error.0, "message": error.1 }),
            )
            .ok();
        }
        let state = snapshot.state.clone()?;
        self.error = None;
        let rollback = if watching_rollback {
            snapshot.rollback.clone()
        } else {
            None
        };
        let frame = match &self.state {
            None => serde_json::to_string(&FullFrame {
                t: "full",
                state: &state,
                rollback: rollback.as_deref().unwrap_or(&NULL_VALUE),
            })
            .ok(),
            Some(previous) => {
                let state_patch = if Arc::ptr_eq(previous, &state) {
                    None
                } else {
                    json_patch::diff(previous, &state)
                };
                let rollback_patch = json_patch::diff(
                    self.rollback.as_deref().unwrap_or(&NULL_VALUE),
                    rollback.as_deref().unwrap_or(&NULL_VALUE),
                );
                if state_patch.is_none() && rollback_patch.is_none() {
                    None
                } else {
                    serde_json::to_string(&PatchFrame {
                        t: "patch",
                        state: state_patch,
                        rollback: rollback_patch,
                    })
                    .ok()
                }
            }
        };
        self.state = Some(state);
        self.rollback = rollback;
        frame
    }
}

enum Event {
    Closed,
    Snapshot,
    Tick,
    Incoming(Option<Result<Message, tokio_tungstenite::tungstenite::Error>>),
    Ping,
}

type Sink<S> = SplitSink<WebSocketStream<S>, Message>;

async fn push<S>(
    sink: &mut Sink<S>,
    view: &mut ClientView,
    snapshots: &mut watch::Receiver<Arc<HubSnapshot>>,
    watching_rollback: bool,
) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let snapshot = snapshots.borrow_and_update().clone();
    match view.frame(&snapshot, watching_rollback) {
        Some(frame) => sink.send(Message::Text(frame)).await.is_ok(),
        None => true,
    }
}

async fn close<S>(sink: &mut Sink<S>, code: u16, reason: &'static str)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code: CloseCode::Library(code),
            reason: reason.into(),
        })))
        .await;
}

async fn send_synced<S>(sink: &mut Sink<S>, ids: Vec<Value>) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    for id in ids {
        let frame = json!({ "t": "synced", "id": id }).to_string();
        if sink.send(Message::Text(frame)).await.is_err() {
            return false;
        }
    }
    true
}

/// 运行单个 WebSocket 会话直到断开、凭据失效或服务停止。
pub async fn run_session<S, F>(
    socket: WebSocketStream<S>,
    mut closed: watch::Receiver<bool>,
    still_authorized: F,
) where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn() -> bool,
{
    let hub = hub();
    let (mut sink, mut source) = socket.split();
    let mut snapshots = hub.snapshot.subscribe();
    let mut ticks = hub.ticks.subscribe();
    let mut active = Some(ActiveGuard::acquire());
    let mut rollback_guard: Option<RollbackGuard> = None;
    let mut view = ClientView::default();
    let mut pending_syncs: Vec<(u64, Value)> = Vec::new();
    let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);

    let stopped = *closed.borrow();
    if stopped {
        close(&mut sink, CLOSE_SHUTDOWN, "stopped").await;
        return;
    }
    if !push(&mut sink, &mut view, &mut snapshots, false).await {
        return;
    }

    loop {
        let event = tokio::select! {
            _ = closed.changed() => Event::Closed,
            result = snapshots.changed(), if active.is_some() => {
                if result.is_ok() { Event::Snapshot } else { Event::Closed }
            }
            result = ticks.changed(), if !pending_syncs.is_empty() => {
                if result.is_ok() { Event::Tick } else { Event::Closed }
            }
            message = source.next() => Event::Incoming(message),
            _ = ping.tick() => Event::Ping,
        };
        let watching = rollback_guard.is_some();
        match event {
            Event::Closed => {
                close(&mut sink, CLOSE_SHUTDOWN, "stopped").await;
                return;
            }
            Event::Snapshot => {
                if !still_authorized() {
                    close(&mut sink, CLOSE_UNAUTHORIZED, "unauthorized").await;
                    return;
                }
                if !push(&mut sink, &mut view, &mut snapshots, watching).await {
                    return;
                }
            }
            Event::Tick => {
                let completed = *ticks.borrow_and_update();
                let (ready, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut pending_syncs)
                    .into_iter()
                    .partition(|(target, _)| *target <= completed);
                pending_syncs = waiting;
                if ready.is_empty() {
                    continue;
                }
                let ids = ready.into_iter().map(|(_, id)| id).collect();
                if !push(&mut sink, &mut view, &mut snapshots, watching).await
                    || !send_synced(&mut sink, ids).await
                {
                    return;
                }
            }
            Event::Ping => {
                if !still_authorized() {
                    close(&mut sink, CLOSE_UNAUTHORIZED, "unauthorized").await;
                    return;
                }
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    return;
                }
            }
            Event::Incoming(None) | Event::Incoming(Some(Err(_))) => return,
            Event::Incoming(Some(Ok(Message::Close(_)))) => return,
            Event::Incoming(Some(Ok(Message::Text(text)))) => {
                let Ok(command) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match command.get("t").and_then(Value::as_str).unwrap_or_default() {
                    "sync" => {
                        let id = command.get("id").cloned().unwrap_or(Value::Null);
                        if active.is_none() {
                            // 暂停中中枢可能已停转：直接按现有快照确认。
                            if !push(&mut sink, &mut view, &mut snapshots, watching).await
                                || !send_synced(&mut sink, vec![id]).await
                            {
                                return;
                            }
                            continue;
                        }
                        ticks.borrow_and_update();
                        let target = hub.started.load(Ordering::SeqCst) + 1;
                        pending_syncs.push((target, id));
                        nudge();
                    }
                    "pause" => {
                        active = None;
                    }
                    "resume" => {
                        if active.is_none() {
                            active = Some(ActiveGuard::acquire());
                        }
                        if !push(&mut sink, &mut view, &mut snapshots, watching).await {
                            return;
                        }
                    }
                    "watch" => {
                        let enabled = command.get("rollback").and_then(Value::as_bool) == Some(true);
                        if enabled && rollback_guard.is_none() {
                            rollback_guard = Some(RollbackGuard::acquire());
                        } else if !enabled {
                            rollback_guard = None;
                        }
                        let watching = rollback_guard.is_some();
                        if !push(&mut sink, &mut view, &mut snapshots, watching).await {
                            return;
                        }
                    }
                    "resync" => {
                        view.reset();
                        if !push(&mut sink, &mut view, &mut snapshots, watching).await {
                            return;
                        }
                    }
                    _ => {}
                }
            }
            Event::Incoming(Some(Ok(_))) => {}
        }
    }
}
