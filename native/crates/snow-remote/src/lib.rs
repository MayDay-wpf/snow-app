//! 手机远控服务的生命周期编排（原生侧）。
//!
//! 由 Node 侧 remoteControlLifecycle.ts 触发：创建 / 停止局域网监听器、
//! 管理公网回环监听器与配对状态。所有网络、磁盘与鉴权工作都在 Rust 完成，
//! Node 只负责总开关持久化与把渲染进程桥注册进来。

pub mod assets;
pub mod attachments;
pub mod auth;
pub mod bridge;
pub mod json_patch;
pub mod live;
pub mod mention;
pub mod server;
pub mod theme_asset;
pub mod unauthorized;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;

use auth::{encode_query_component, normalize_fixed_token, random_token, WanAuth};
use server::{FailureGuard, ServerContext, ServerPolicy};

/// 监听器关闭的等待上限（超过后强制中止任务）。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
/// 公网回环监听地址：只接受本机 SSH2 反向隧道转发过来的请求。
const WAN_HOST: &str = "127.0.0.1";

/// 启动参数（由 Node 侧解析环境变量与路径后传入）。
pub struct StartOptions {
    pub host: String,
    pub port: u16,
    /// 显式配置的局域网令牌；缺省时生成随机令牌。
    pub token: Option<String>,
    /// 移动页产物目录（out/mobile 或打包后的 unpacked 路径）。
    pub mobile_dir: PathBuf,
    /// 应用品牌图标（引导页 / favicon 共用）。
    pub icon_path: PathBuf,
    /// 可选的公网入口地址（设置了才会启动 WAN 监听器）。
    pub wan_public_origin: Option<String>,
    pub wan_port: u16,
    /// 面板指定的公网令牌；缺省时生成随机令牌。
    pub wan_token: Option<String>,
}

/// 远控服务的对外状态快照（enabled 字段由 Node 侧补充）。
#[derive(Clone)]
pub struct RemoteControlState {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub token: String,
    pub generation: u64,
    pub wan: WanState,
}

#[derive(Clone)]
pub struct WanState {
    pub enabled: bool,
    pub local_port: u16,
    pub public_origin: String,
    pub pairing_url: String,
    /// 当前生效的公网令牌；公网入口未启动时为空串。
    pub token: String,
}

struct LanServer {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
    host: String,
    port: u16,
    token: Arc<RwLock<String>>,
    generation: Arc<AtomicU64>,
    mobile_dir: PathBuf,
    icon_bytes: Option<Arc<Vec<u8>>>,
}

struct WanServer {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
    port: u16,
    auth: Arc<WanAuth>,
}

static LAN_SLOT: OnceLock<Mutex<Option<LanServer>>> = OnceLock::new();
static WAN_SLOT: OnceLock<Mutex<Option<WanServer>>> = OnceLock::new();
/// 配对代数：令牌轮换 / 服务重启后自增，旧请求据此拒绝。
static GENERATION: OnceLock<Arc<AtomicU64>> = OnceLock::new();
/// 启停编排锁：start / stop / WAN 监听器操作串行执行。
static LIFECYCLE: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn lan_slot() -> &'static Mutex<Option<LanServer>> {
    LAN_SLOT.get_or_init(|| Mutex::new(None))
}

fn wan_slot() -> &'static Mutex<Option<WanServer>> {
    WAN_SLOT.get_or_init(|| Mutex::new(None))
}

fn lock_lan() -> MutexGuard<'static, Option<LanServer>> {
    lan_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_wan() -> MutexGuard<'static, Option<WanServer>> {
    wan_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn generation_counter() -> &'static Arc<AtomicU64> {
    GENERATION.get_or_init(|| Arc::new(AtomicU64::new(0)))
}

fn lifecycle() -> &'static AsyncMutex<()> {
    LIFECYCLE.get_or_init(|| AsyncMutex::new(()))
}

/// 按当前状态组装快照。
pub fn state() -> RemoteControlState {
    let (running, host, port, token) = {
        let lan = lock_lan();
        match lan.as_ref() {
            Some(server) => (
                true,
                server.host.clone(),
                server.port,
                server
                    .token
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
            ),
            None => (false, String::new(), 0, String::new()),
        }
    };
    let wan = {
        let wan = lock_wan();
        match wan.as_ref() {
            Some(server) => {
                let token = server.auth.token();
                WanState {
                    enabled: true,
                    local_port: server.port,
                    public_origin: server.auth.origin().to_string(),
                    pairing_url: format!(
                        "{}/?token={}",
                        server.auth.origin(),
                        encode_query_component(&token)
                    ),
                    token,
                }
            }
            None => WanState {
                enabled: false,
                local_port: 0,
                public_origin: String::new(),
                pairing_url: String::new(),
                token: String::new(),
            },
        }
    };
    RemoteControlState {
        running,
        host,
        port,
        token,
        generation: generation_counter().load(Ordering::SeqCst),
        wan,
    }
}

/// 归一化显式配置的令牌（环境变量或面板固定值）；空白视为未配置。
fn configured_token(value: Option<&str>) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|item| !item.is_empty()) {
        Some(configured) => normalize_fixed_token(configured).map(Some),
        None => Ok(None),
    }
}

/// 启动局域网远控服务；已运行时直接返回当前状态。
pub async fn start_server(options: StartOptions) -> Result<RemoteControlState, String> {
    let _guard = lifecycle().lock().await;
    if lock_lan().is_some() {
        return Ok(state());
    }
    let token = configured_token(options.token.as_deref())?.unwrap_or_else(random_token);
    let wan_token = configured_token(options.wan_token.as_deref())?;
    let generation = generation_counter().clone();
    generation.fetch_add(1, Ordering::SeqCst);
    let icon_bytes = tokio::fs::read(&options.icon_path)
        .await
        .ok()
        .map(Arc::new);
    // 令牌读写共享给服务上下文：轮换后立即对后续请求生效。
    let token_shared = Arc::new(RwLock::new(token));

    let listener = TcpListener::bind((options.host.as_str(), options.port))
        .await
        .map_err(|error| format!("监听 {host}:{port} 失败：{error}", host = options.host, port = options.port))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取监听端口失败：{error}"))?
        .port();

    let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);
    let context = Arc::new(ServerContext {
        policy: ServerPolicy::Lan,
        mobile_dir: options.mobile_dir.clone(),
        icon_bytes: icon_bytes.clone(),
        lan_token: Some(token_shared.clone()),
        wan_auth: None,
        generation: generation.clone(),
        unlock_tokens: FailureGuard::tokens(),
        unlock_codes: FailureGuard::codes(),
        closed: closed_rx,
    });
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = server::router(context);
    let join = tokio::spawn(async move {
        // 只有带上 connect info，服务端才能识别本机回环请求（免令牌）。
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
                let _ = closed_tx.send(true);
            })
            .await;
    });

    *lock_lan() = Some(LanServer {
        shutdown: Some(shutdown),
        join,
        host: options.host,
        port,
        token: token_shared,
        generation,
        mobile_dir: options.mobile_dir,
        icon_bytes,
    });

    if let Some(origin) = options.wan_public_origin {
        // 公网入口是可选项：配置错误或端口占用不能拖垮已就绪的局域网服务。
        let _ = start_wan_listener_locked(&origin, options.wan_port, wan_token).await;
    }
    Ok(state())
}

/// 停止局域网服务与公网监听器，并失效全部在途凭据。
pub async fn stop_server() -> Result<(), String> {
    let _guard = lifecycle().lock().await;
    let lan = lock_lan().take();
    generation_counter().fetch_add(1, Ordering::SeqCst);
    server::clear_completed_sends();
    stop_wan_listener_locked().await;
    attachments::invalidate_all().await;
    if let Some(server) = lan {
        shutdown_task(server.shutdown, server.join).await;
    }
    Ok(())
}

/// 应用设置面板提交的局域网令牌；None 表示回到随机令牌。
pub async fn set_lan_token(token: Option<String>) -> Result<RemoteControlState, String> {
    let _guard = lifecycle().lock().await;
    if lock_lan().is_none() {
        return Err("手机遥控服务尚未启动".to_string());
    }
    let next_token = configured_token(token.as_deref())?.unwrap_or_else(random_token);
    server::wait_send_idle().await;
    {
        let mut lan = lock_lan();
        let Some(server) = lan.as_mut() else {
            return Err("手机遥控服务尚未启动".to_string());
        };
        *server
            .token
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next_token;
        server.generation.fetch_add(1, Ordering::SeqCst);
    }
    server::clear_completed_sends();
    attachments::invalidate_all().await;
    Ok(state())
}

/// 应用设置面板提交的公网令牌；None 表示回到本次随机令牌。
pub async fn set_wan_token(token: Option<String>) -> Result<RemoteControlState, String> {
    let _guard = lifecycle().lock().await;
    let next_token = configured_token(token.as_deref())?.unwrap_or_else(random_token);
    {
        let wan = lock_wan();
        let Some(server) = wan.as_ref() else {
            return Err("公网远控尚未连接，配置将在下次连接时生效".to_string());
        };
        server.auth.set_token(next_token);
    }
    Ok(state())
}

/// 启动（或替换）公网回环监听器；公网入口或令牌变更时会重建监听器。
pub async fn start_wan_listener(
    public_origin: String,
    preferred_port: u16,
    token: Option<String>,
) -> Result<RemoteControlState, String> {
    let _guard = lifecycle().lock().await;
    start_wan_listener_locked(&public_origin, preferred_port, token).await?;
    Ok(state())
}

/// 停止公网回环监听器；局域网不受影响。
pub async fn stop_wan_listener() -> Result<(), String> {
    let _guard = lifecycle().lock().await;
    stop_wan_listener_locked().await;
    Ok(())
}

async fn start_wan_listener_locked(
    public_origin: &str,
    preferred_port: u16,
    token: Option<String>,
) -> Result<(), String> {
    let normalized = auth::normalize_public_origin(public_origin)?;
    let token = configured_token(token.as_deref())?.unwrap_or_else(random_token);
    let (mobile_dir, icon_bytes, generation) = {
        let lan = lock_lan();
        let Some(server) = lan.as_ref() else {
            return Err("手机遥控服务尚未启动".to_string());
        };
        (
            server.mobile_dir.clone(),
            server.icon_bytes.clone(),
            server.generation.clone(),
        )
    };
    {
        let wan = lock_wan();
        if let Some(existing) = wan.as_ref() {
            if existing.auth.origin() == normalized
                && existing.auth.token() == token
                && (preferred_port == 0 || preferred_port == existing.port)
            {
                return Ok(());
            }
        }
    }

    stop_wan_listener_locked().await;
    let wan_auth = Arc::new(WanAuth::new(&normalized, token)?);
    let listener = TcpListener::bind((WAN_HOST, preferred_port))
        .await
        .map_err(|error| format!("监听公网隧道入口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取公网隧道端口失败：{error}"))?
        .port();
    let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);
    let context = Arc::new(ServerContext {
        policy: ServerPolicy::Wan,
        mobile_dir,
        icon_bytes,
        lan_token: None,
        wan_auth: Some(wan_auth.clone()),
        generation,
        unlock_tokens: FailureGuard::tokens(),
        unlock_codes: FailureGuard::codes(),
        closed: closed_rx,
    });
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = server::router(context);
    let join = tokio::spawn(async move {
        // 公网监听器同样需要 connect info（判定只在局域网策略下生效）。
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
                let _ = closed_tx.send(true);
            })
            .await;
    });
    *lock_wan() = Some(WanServer {
        shutdown: Some(shutdown),
        join,
        port,
        auth: wan_auth,
    });
    Ok(())
}

async fn stop_wan_listener_locked() {
    let wan = lock_wan().take();
    if let Some(server) = wan {
        shutdown_task(server.shutdown, server.join).await;
    }
}

/// 发送优雅关闭信号并等待任务退出；超时后强制中止。
async fn shutdown_task(
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    mut join: tokio::task::JoinHandle<()>,
) {
    if let Some(sender) = shutdown {
        let _ = sender.send(());
    }
    if tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut join)
        .await
        .is_err()
    {
        join.abort();
    }
}

// 兼容外观：沿用搬迁前的 `crate::storage::*` / `crate::exports::*` / `crate::remote_control::*` 路径。
pub(crate) mod storage {
    pub fn read_upload_image(
        relative_path: String,
    ) -> napi::Result<Option<(String, Vec<u8>)>> {
        let database_path = snow_storage_services::ensure_database_file()?;
        Ok(
            snow_storage::media::read_upload_image(&relative_path, &database_path)
                .map(|(mime, bytes)| (mime.to_string(), bytes)),
        )
    }

    pub use snow_storage_services::*;

    pub mod paths {
        pub use snow_support::app_paths::*;
    }

    pub mod services {
        pub use snow_storage_services::services::*;
    }
}

pub(crate) mod exports {
    pub mod checkpoint {
        pub use snow_storage::checkpoint::{CheckpointDiffPage, CheckpointFileSummary};

        pub async fn list_checkpoint_summaries_batch(
            checkpoint_ids: Vec<String>,
            work_dir: String,
            include_all: Option<bool>,
        ) -> napi::Result<Vec<CheckpointFileSummary>> {
            tokio::task::spawn_blocking(move || {
                snow_storage::checkpoint::list_checkpoint_summaries_batch(
                    checkpoint_ids,
                    work_dir,
                    include_all.unwrap_or(false),
                )
            })
            .await
            .map_err(|error| {
                napi::Error::from_reason(format!("checkpoint task failed: {error}"))
            })?
        }

        pub async fn read_checkpoint_diff_page(
            checkpoint_ids: Vec<String>,
            work_dir: String,
            path: String,
            start_row: u32,
            max_rows: u32,
            max_bytes: u32,
        ) -> napi::Result<CheckpointDiffPage> {
            tokio::task::spawn_blocking(move || {
                snow_storage::checkpoint::read_checkpoint_diff_page(
                    checkpoint_ids,
                    work_dir,
                    path,
                    start_row,
                    max_rows,
                    max_bytes,
                )
            })
            .await
            .map_err(|error| {
                napi::Error::from_reason(format!("checkpoint task failed: {error}"))
            })?
        }
    }
}

pub(crate) mod remote_control {
    pub use crate::{
        assets, attachments, auth, bridge, live, mention, theme_asset, unauthorized,
    };
}
