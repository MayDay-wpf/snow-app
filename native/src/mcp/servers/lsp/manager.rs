//! ServerManager：全局单例，管理 (语言 × 项目根) 会话的生命周期。
//!
//! - 会话粒度 = (语言, 项目根)：同项目同语言单进程，多项目各自进程（§7.2）
//! - 懒加载：首次工具调用才 spawn（§7.1）
//! - 空闲回收：周期巡检与新建路径共用安全回收判断
//! - 崩溃后重建；首次/后续启动失败按完整配置身份指数退避
//! - 并发上限：max_sessions（跨项目合计），超限 LRU 淘汰

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, Notify, RwLock};

use super::config;
use super::session::ServerSession;
use super::types::{LspError, ServerConfig, SessionKey};

/// 跨 (语言, 项目) 总进程数上限（§7.3）。
///
/// 3 → 5（2026-08-14 用户决策）：多项目工作流（4+ 项目）下 3 个上限会
/// 频繁 LRU 淘汰重服务器（rust-analyzer 重启需 10-30s 重建索引），体验
/// 损失大于多占内存；重服务器单进程 500MB-1GB，5 个上限内存风险仍可控。
const MAX_SESSIONS: usize = 5;
/// 空闲回收阈值（§7.3）。600s → 1800s（2026-08-14 用户决策）：rust-analyzer
/// 冷启动 + flycheck 首次 10-30s，频繁回收后重复支付冷启动成本；调大后会话
/// 更常驻。进程数上限仍由 MAX_SESSIONS + LRU 兜底，内存风险可控。
const IDLE_TIMEOUT: Duration = Duration::from_secs(1800);
/// 巡检粒度，不改变空闲阈值；使用 sleep 避免运行时暂停后的补偿突发。
const IDLE_REAP_INTERVAL: Duration = Duration::from_secs(60);
/// 崩溃连续重启上限（§7.3）。
const MAX_BACKOFF: Duration = Duration::from_secs(300);
/// 同 key 并发 spawn 占位等待的轮询间隔（M1/R3.1）：等待者以 Notify 唤醒为主、
/// 超时轮询为兜底——防「等待者尚未注册时占位者已 notify」的丢失竞态。
const START_WAIT_POLL: Duration = Duration::from_millis(200);
/// 占位等待轮次上限（200ms × 750 ≈ 150s，覆盖 JVM initialize 120s 上限 + 余量）。
/// 占位者异常（panic）未释放时的保险：超限返回超时，绝不额外spawn；正常路径下
/// 占位者完成（成功/失败）必然 notify，轮次远达不到上限。
const MAX_START_WAIT_ROUNDS: u32 = 750;

/// Global resource policy; absent fields preserve the historical defaults.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePolicy {
    pub max_sessions: usize,
    pub idle_timeout_secs: u64,
    pub max_concurrent_starts: usize,
}
impl Default for ResourcePolicy {
    fn default() -> Self {
        Self { max_sessions: MAX_SESSIONS, idle_timeout_secs: IDLE_TIMEOUT.as_secs(), max_concurrent_starts: 2 }
    }
}
impl ResourcePolicy {
    pub fn validate(&self) -> napi::Result<()> {
        if !(1..=32).contains(&self.max_sessions)
            || !(60..=86400).contains(&self.idle_timeout_secs)
            || !(1..=8).contains(&self.max_concurrent_starts) {
            return Err(napi::Error::from_reason("LSP resource policy: maxSessions 1..32, idleTimeoutSecs 60..86400, maxConcurrentStarts 1..8 (integers)"));
        }
        Ok(())
    }
    fn load() -> Self {
        crate::storage::get_system_setting_value("lsp_resource_policy".into())
            .ok().flatten().and_then(|raw| serde_json::from_str::<Self>(&raw).ok())
            .filter(|policy| policy.validate().is_ok()).unwrap_or_default()
    }
}

/// 会话状态快照（供前端状态徽章实时展示；查询时动态检测进程退出）。
#[derive(Debug, Clone)]
pub struct SessionStatus {
    pub resources: Option<super::session::LspResourceSnapshot>,
    pub lang: String,
    pub project_root: String,
    /// `running` | `dead` | `exited`（进程已退出但会话未标记）。
    pub status: String,
    pub restart_count: u32,
    pub last_used_ms: u64,
    pub error: Option<String>,
}

fn unused_handle<T>(handle: &Arc<Mutex<T>>) -> Option<tokio::sync::MutexGuard<'_, T>> {
    if Arc::strong_count(handle) != 1 {
        return None;
    }
    handle.try_lock().ok()
}

fn same_instance<T>(weak: &std::sync::Weak<T>, current: &Arc<T>) -> bool {
    weak.upgrade().is_some_and(|old| Arc::ptr_eq(&old, current))
}

type FailureKey = (String, PathBuf, String);

#[derive(Clone)]
struct StartupFailure {
    count: u32,
    retry_at: Instant,
    retry_at_ms: u64,
    failed_at_ms: u64,
    message: String,
    observed_crash: Option<std::sync::Weak<Mutex<ServerSession>>>,
}

fn failure_delay(count: u32) -> Duration {
    Duration::from_secs(5u64.saturating_mul(1u64 << count.saturating_sub(1).min(6)))
        .min(MAX_BACKOFF)
}

/// 启动future被取消时释放自己的占位；指针复核避免清掉新拥有者。
struct StartingLease {
    key: SessionKey,
    notify: Arc<Notify>,
    starting: Arc<Mutex<HashMap<SessionKey, Arc<Notify>>>>,
}
impl Drop for StartingLease {
    fn drop(&mut self) {
        let release =
            |map: &mut HashMap<SessionKey, Arc<Notify>>, key: &SessionKey, notify: &Arc<Notify>| {
                if map
                    .get(key)
                    .is_some_and(|current| Arc::ptr_eq(current, notify))
                {
                    map.remove(key);
                }
                notify.notify_waiters();
            };
        if let Ok(mut map) = self.starting.try_lock() {
            release(&mut map, &self.key, &self.notify);
        } else if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let starting = self.starting.clone();
            let key = self.key.clone();
            let notify = self.notify.clone();
            runtime.spawn(async move {
                release(&mut *starting.lock().await, &key, &notify);
            });
        }
    }
}

/// 关闭被取消时保留会话所有权和容量，下一轮巡检（包括新 runtime）继续关闭。
type DeferredRetirements = Arc<std::sync::Mutex<Vec<Arc<Mutex<ServerSession>>>>>;

struct RetiringSession {
    session: Arc<Mutex<ServerSession>>,
    count: Arc<AtomicUsize>,
    deferred: DeferredRetirements,
}
impl RetiringSession {
    fn new(
        session: Arc<Mutex<ServerSession>>,
        count: Arc<AtomicUsize>,
        deferred: DeferredRetirements,
    ) -> Self {
        count.fetch_add(1, Ordering::AcqRel);
        Self {
            session,
            count,
            deferred,
        }
    }
}
impl Drop for RetiringSession {
    fn drop(&mut self) {
        let exited = self
            .session
            .try_lock()
            .is_ok_and(|mut session| session.process_exited());
        if exited {
            self.count.fetch_sub(1, Ordering::AcqRel);
        } else {
            self.deferred
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(self.session.clone());
        }
    }
}

/// A fully started process awaiting publication still needs retirement if the
/// caller is cancelled while acquiring table locks. Partial initialize failure
/// continues to use ServerSession's existing process-tree Drop protection.
struct UnpublishedSession<'a> {
    session: &'a Arc<Mutex<ServerSession>>,
    manager: &'a ServerManager,
    published: bool,
}
impl Drop for UnpublishedSession<'_> {
    fn drop(&mut self) {
        if !self.published {
            drop(RetiringSession::new(
                self.session.clone(), self.manager.retiring.clone(),
                self.manager.deferred_retirements.clone(),
            ));
        }
    }
}

#[derive(Clone)]
struct RootAlias {
    owner: PathBuf,
    instance: std::sync::Weak<Mutex<ServerSession>>,
}

/// Confirmed identity of a registered physical session (never a logical root).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTarget {
    pub lang: String,
    pub project_root: String,
    pub expected_pid: u32,
    pub expected_restart_count: u32,
}

/// Keep the actual effective configuration and its originating scope bound to
/// the concrete instance. Exact restart must not choose global config or detect
/// a different language root merely because the UI does not carry projectId.
#[derive(Clone)]
struct SessionOrigin {
    instance: std::sync::Weak<Mutex<ServerSession>>,
    config: ServerConfig,
    project_id: String,
}

pub struct ServerManager {
    sessions: Mutex<HashMap<SessionKey, Arc<Mutex<ServerSession>>>>,
    session_origins: Mutex<HashMap<SessionKey, SessionOrigin>>,
    /// Successful acquisitions only; config and concrete instance are part of
    /// the binding. Historical paths never control a replacement process.
    root_aliases: Mutex<HashMap<FailureKey, RootAlias>>,
    /// 并发 spawn 占位（M1/R3.1）：key -> Notify。同一 key 同时只有一个 spawn
    /// 者；等待者克隆 Notify 后在锁外等待，占位者完成（成功/失败）后
    /// notify_waiters 唤醒，重试段 1 直接复用会话。
    starting: Arc<Mutex<HashMap<SessionKey, Arc<Notify>>>>,
    /// 有效配置快照（project_id → configs；空 key = 全局）。
    configs: RwLock<HashMap<String, Vec<ServerConfig>>>,
    policy: std::sync::RwLock<ResourcePolicy>,
    failures: Mutex<HashMap<FailureKey, StartupFailure>>,
    retiring: Arc<AtomicUsize>,
    deferred_retirements: DeferredRetirements,
    /// 只在不存在活跃任务时启动；已结束 runtime 的句柄可在下次访问时替换。
    idle_reaper: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ServerManager {
    pub fn resource_policy(&self) -> ResourcePolicy {
        *self.policy.read().unwrap_or_else(|error| error.into_inner())
    }

    pub async fn save_resource_policy(self: &Arc<Self>, policy: ResourcePolicy) -> napi::Result<()> {
        policy.validate()?;
        // Once persistence starts, cancellation must not leave disk/runtime divergent.
        // Serialize saves and admission; already admitted work is grandfathered.
        let admission = self.starting.clone().lock_owned().await;
        let manager = self.clone();
        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            crate::storage::set_system_setting("LSP resource policy".into(), "lsp_resource_policy".into(),
                serde_json::to_string(&policy).map_err(|error| napi::Error::from_reason(error.to_string()))?)?;
            *manager.policy.write().unwrap_or_else(|error| error.into_inner()) = policy;
            Ok(())
        }).await.map_err(|error| napi::Error::from_reason(error.to_string()))?
    }

    /// 全局单例；同步调用无 runtime 时只初始化，不创建异步任务。
    pub fn instance() -> &'static Arc<ServerManager> {
        static INSTANCE: OnceLock<Arc<ServerManager>> = OnceLock::new();
        let manager = INSTANCE.get_or_init(|| {
            Arc::new(ServerManager {
                sessions: Mutex::new(HashMap::new()),
                session_origins: Mutex::new(HashMap::new()),
                root_aliases: Mutex::new(HashMap::new()),
                starting: Arc::new(Mutex::new(HashMap::new())),
                configs: RwLock::new(HashMap::new()),
                policy: std::sync::RwLock::new(ResourcePolicy::load()),
                failures: Mutex::new(HashMap::new()),
                retiring: Arc::new(AtomicUsize::new(0)),
                deferred_retirements: Arc::new(std::sync::Mutex::new(Vec::new())),
                idle_reaper: std::sync::Mutex::new(None),
            })
        });
        manager.ensure_idle_reaper();
        manager
    }

    fn ensure_idle_reaper(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let mut task = self
            .idle_reaper
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if task.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let manager = Arc::downgrade(self);
        *task = Some(runtime.spawn(async move {
            loop {
                // 弱引用跨越等待；不固定任何会话，也不形成 manager/task 所有权环。
                let Some(manager) = manager.upgrade() else {
                    break;
                };
                manager.reap_idle_sessions().await;
                drop(manager);
                tokio::time::sleep(IDLE_REAP_INTERVAL).await;
            }
        }));
    }

    async fn reap_idle_sessions(&self) {
        let victims = {
            // 与启动路径保持同一锁序；只在锁内判断、移除和登记容量。
            let mut sessions = self.sessions.lock().await;
            let starting = self.starting.lock().await;
            self.reclaim_idle_keys(&sessions)
                .into_iter()
                .filter(|key| !starting.contains_key(key))
                .filter_map(|key| sessions.remove(&key))
                .map(|session| {
                    RetiringSession::new(
                        session,
                        self.retiring.clone(),
                        self.deferred_retirements.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        if !victims.is_empty() {
            eprintln!("[lsp] idle reaper retiring {} session(s)", victims.len());
        }
        // Snapshot the entire old queue before awaiting. A failed guard may
        // requeue itself, but cannot starve another entry in this same pass.
        let deferred = self
            .deferred_retirements
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain(..)
            .map(|session| RetiringSession {
                session,
                count: self.retiring.clone(),
                deferred: self.deferred_retirements.clone(),
            })
            .collect::<Vec<_>>();
        for victim in deferred {
            victim.session.lock().await.shutdown().await;
        }
        for victim in victims {
            victim.session.lock().await.shutdown().await;
        }
        let _ = self.live_root_aliases().await;
    }

    /// 从表重载配置（每次工具调用执行，支持热更新；按 project 区分有效配置）。
    pub async fn reload_configs(&self, project_id: Option<&str>) -> napi::Result<()> {
        let configs = config::load_configs(project_id).await?;
        let key = project_id.unwrap_or("").trim().to_string();
        let previous = self
            .configs
            .write()
            .await
            .insert(key, configs.clone())
            .unwrap_or_default();
        let obsolete: Vec<(String, String)> = previous
            .iter()
            .filter(|old| !configs.iter().any(|new| new == *old))
            .map(|old| (old.lang.clone(), old.fingerprint()))
            .collect();
        if !obsolete.is_empty() {
            self.failures
                .lock()
                .await
                .retain(|(lang, _, fingerprint), _| {
                    !obsolete
                        .iter()
                        .any(|(old_lang, old_fp)| old_lang == lang && old_fp == fingerprint)
                });
        }
        Ok(())
    }

    /// 当前配置快照（供工具匹配语言）。
    pub async fn configs(&self, project_id: Option<&str>) -> Vec<ServerConfig> {
        let key = project_id.unwrap_or("").trim().to_string();
        self.configs
            .read()
            .await
            .get(&key)
            .cloned()
            .unwrap_or_default()
    }

    async fn live_root_aliases(&self) -> HashMap<FailureKey, RootAlias> {
        let sessions = self.sessions.lock().await;
        let mut aliases = self.root_aliases.lock().await;
        aliases.retain(|(lang, _, _), alias| {
            sessions
                .get(&(lang.clone(), alias.owner.clone()))
                .is_some_and(|current| same_instance(&alias.instance, current))
        });
        aliases.clone()
    }

    async fn register_root_alias(
        &self,
        logical_root: &Path,
        physical_key: &FailureKey,
        session: &Arc<Mutex<ServerSession>>,
    ) {
        // Same lock order as pruning; registration cannot resurrect an alias
        // after stop/replacement has removed its instance from the table.
        let sessions = self.sessions.lock().await;
        if !sessions
            .get(&(physical_key.0.clone(), physical_key.1.clone()))
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            return;
        }
        let mut aliases = self.root_aliases.lock().await;
        aliases.retain(|(lang, _, _), alias| {
            sessions
                .get(&(lang.clone(), alias.owner.clone()))
                .is_some_and(|current| same_instance(&alias.instance, current))
        });
        let key = (
            physical_key.0.clone(),
            logical_root.to_path_buf(),
            physical_key.2.clone(),
        );
        aliases.insert(
            key,
            RootAlias {
                owner: physical_key.1.clone(),
                instance: Arc::downgrade(session),
            },
        );
    }

    /// Health reads never run Go or discover new ownership. Unknown/cold roots
    /// retain the static capability estimate; only established same-config
    /// aliases may select a negotiated session.
    pub async fn tool_availability(
        &self,
        config: &ServerConfig,
        root: &Path,
    ) -> Option<Vec<String>> {
        if !config.enabled {
            return Some(Vec::new());
        }
        let logical = tokio::fs::canonicalize(root).await.ok()?;
        let aliases = self.live_root_aliases().await;
        let fingerprint = config.fingerprint();
        let alias = aliases.get(&(config.lang.clone(), logical.clone(), fingerprint.clone()));
        let physical = alias.map(|alias| alias.owner.clone()).unwrap_or(logical);
        let failure_key = (config.lang.clone(), physical.clone(), fingerprint);
        if self
            .failures
            .lock()
            .await
            .get(&failure_key)
            .is_some_and(|failure| Instant::now() < failure.retry_at)
        {
            return Some(Vec::new());
        }
        let session = self
            .sessions
            .lock()
            .await
            .get(&(config.lang.clone(), physical.clone()))
            .cloned()?;
        if alias.is_some_and(|alias| !same_instance(&alias.instance, &session)) {
            return None;
        }
        let mut guard = session.try_lock().ok()?;
        if !guard.matches_config(config) {
            return None;
        }
        if guard.dead
            || guard.main_loop_done.load(Ordering::Acquire)
            || guard.exited_code().is_some()
        {
            drop(guard);
            return if self.observe_crash(&failure_key, &session).await {
                Some(Vec::new())
            } else {
                None
            };
        }
        Some(guard.negotiated_tools())
    }

    async fn record_start_failure(&self, key: &FailureKey, error: &LspError) {
        let mut failures = self.failures.lock().await;
        let count = failures
            .get(key)
            .map(|f| f.count)
            .unwrap_or(0)
            .saturating_add(1);
        let delay = failure_delay(count);
        let failed_at_ms = now_ms();
        let message = match error {
            LspError::ServerMissing(_, _) => "language server executable unavailable".to_string(),
            other => format!("{other:?}"),
        };
        failures.insert(
            key.clone(),
            StartupFailure {
                count,
                retry_at: Instant::now() + delay,
                retry_at_ms: failed_at_ms.saturating_add(delay.as_millis() as u64),
                failed_at_ms,
                message,
                observed_crash: None,
            },
        );
    }

    /// 同一死亡实例只记录一次，反复观察不延长恢复时间。
    async fn observe_crash(&self, key: &FailureKey, session: &Arc<Mutex<ServerSession>>) -> bool {
        let mut failures = self.failures.lock().await;
        if let Some(record) = failures.get(key) {
            if record
                .observed_crash
                .as_ref()
                .is_some_and(|weak| same_instance(weak, session))
            {
                return Instant::now() < record.retry_at;
            }
        }
        let count = failures
            .get(key)
            .map(|f| f.count)
            .unwrap_or(0)
            .saturating_add(1);
        let delay = failure_delay(count);
        let timestamp = now_ms();
        failures.insert(
            key.clone(),
            StartupFailure {
                count,
                retry_at: Instant::now() + delay,
                retry_at_ms: timestamp.saturating_add(delay.as_millis() as u64),
                failed_at_ms: timestamp,
                message: "language server crashed; retry permitted after backoff".into(),
                observed_crash: Some(Arc::downgrade(session)),
            },
        );
        true
    }

    async fn check_start_backoff(&self, key: &FailureKey) -> Result<(), LspError> {
        let failures = self.failures.lock().await;
        if let Some(failure) = failures.get(key).filter(|f| Instant::now() < f.retry_at) {
            return Err(LspError::ServerFailed(format!(
                "startup backoff after {} failure(s); retryAfterEpochMs={}; {}",
                failure.count, failure.retry_at_ms, failure.message
            )));
        }
        Ok(())
    }

    /// 获取（或懒加载）指定 (语言, 项目根) 的会话。
    ///
    /// M1/R3.1 锁结构：spawn（30-120s）与 victim shutdown（≤3s/个）全程在
    /// sessions 锁**外**执行——同 key 并发调用通过 `starting` 占位（Notify）
    /// 串行化，等待者在锁外等待只阻塞自身，其他 (语言, 项目) 的会话访问
    /// 不受影响。
    ///
    /// - 段 1（锁内快速路径）：已有会话复用 / 崩溃检测（dead / 进程退出 /
    ///   mainloop 结束，R2.1/R2.2）、并发防重占位、空闲回收 + LRU 只收集 victim。
    /// - 段 2（锁外慢路径）：victim shutdown、配置查找、probe、spawn、
    ///   锁内插入 + 释放占位 + 唤醒等待者。
    /// 获取会话并报告是复用现有进程还是新启动（仅工作区查询使用）。
    pub async fn get_or_start_with_trace(
        &self,
        lang: &str,
        project_root: &Path,
        project_id: Option<&str>,
    ) -> Result<(Arc<Mutex<ServerSession>>, bool), LspError> {
        self.get_or_start_inner(lang, project_root, project_id)
            .await
    }

    pub async fn get_or_start(
        &self,
        lang: &str,
        project_root: &Path,
        project_id: Option<&str>,
    ) -> Result<Arc<Mutex<ServerSession>>, LspError> {
        self.get_or_start_inner(lang, project_root, project_id)
            .await
            .map(|(session, _started)| session)
    }

    async fn get_or_start_inner(
        &self,
        lang: &str,
        project_root: &Path,
        project_id: Option<&str>,
    ) -> Result<(Arc<Mutex<ServerSession>>, bool), LspError> {
        // 先验证本请求有效配置，禁止已有会话绕过禁用/覆盖配置。
        let config_key = project_id.unwrap_or("").trim().to_string();
        let config = self
            .configs
            .read()
            .await
            .get(&config_key)
            .and_then(|list| list.iter().find(|c| c.lang == lang && c.enabled))
            .cloned()
            .ok_or_else(|| LspError::NotConfigured(lang.to_string()))?;
        let physical_root = tokio::fs::canonicalize(project_root)
            .await
            .map_err(|error| {
                LspError::Internal(format!("resolve workspace root failed: {error}"))
            })?;
        // Resolve before taking any lifecycle lock; member and workspace requests
        // therefore contend for the same startup placeholder and capacity slot.
        let logical_root = physical_root;
        let physical_root = super::detect::session_root(&config, &logical_root).await;
        // Alias publication is deferred until a concrete instance was acquired.
        let key: SessionKey = (lang.to_string(), physical_root.clone());
        let failure_key = (
            lang.to_string(),
            physical_root.clone(),
            config.fingerprint(),
        );
        // 不同有效配置不能继承旧配置的失败/退避状态。
        self.failures
            .lock()
            .await
            .retain(|(l, root, fingerprint), _| {
                l != lang || root != &physical_root || fingerprint == &failure_key.2
            });
        let mut restart_count = 0u32;
        let mut victims = Vec::new();
        let mut wait_rounds = 0u32;
        let own_notify: Option<Arc<Notify>>;
        loop {
            self.check_start_backoff(&failure_key).await?;
            // 表锁只克隆handle；慢会话锁只在表锁外等待。
            let existing = self.sessions.lock().await.get(&key).cloned();
            if let Some(session) = existing {
                let mut guard = session.lock().await;
                let changed = !guard.matches_config(&config);
                let crashed = guard.dead
                    || guard.main_loop_done.load(Ordering::Acquire)
                    || guard.exited_code().is_some();
                if !changed && !crashed {
                    guard.touch();
                    drop(guard);
                    let current = self
                        .sessions
                        .lock()
                        .await
                        .get(&key)
                        .is_some_and(|current| Arc::ptr_eq(current, &session));
                    if current {
                        self.register_root_alias(&logical_root, &failure_key, &session)
                            .await;
                        return Ok((session, false));
                    }
                    continue;
                }
                if !changed && crashed {
                    restart_count = guard.restart_count.saturating_add(1);
                    drop(guard);
                    if self.observe_crash(&failure_key, &session).await {
                        self.check_start_backoff(&failure_key).await?;
                    }
                } else {
                    if guard.active_diagnostics() > 0 {
                        return Err(LspError::ServerFailed("configuration changed while diagnostics are active; retry when they finish".into()));
                    }
                    drop(guard);
                }
                let mut table = self.sessions.lock().await;
                if !table
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    continue;
                }
                if !crashed && Arc::strong_count(&session) > 2 {
                    return Err(LspError::ServerFailed("configuration changed while requests hold the session; retry when they finish".into()));
                }
                if let Some(old) = table.remove(&key) {
                    victims.push(RetiringSession::new(
                        old,
                        self.retiring.clone(),
                        self.deferred_retirements.clone(),
                    ));
                }
            }
            let mut table = self.sessions.lock().await;
            if table.contains_key(&key) {
                continue;
            }
            let mut starting = self.starting.lock().await;
            if let Some(notify) = starting.get(&key).cloned() {
                drop(starting);
                drop(table);
                if wait_rounds >= MAX_START_WAIT_ROUNDS {
                    return Err(LspError::RequestTimeout(
                        "waiting for in-flight LSP startup".into(),
                    ));
                }
                wait_rounds += 1;
                tokio::select! { _ = notify.notified() => {}, _ = tokio::time::sleep(START_WAIT_POLL) => {} }
                continue;
            }
            let policy = self.resource_policy();
            // Same-key callers already wait above; different cold starts are bounded
            // before selecting any victims. This path cannot evict useful warm sessions.
            if starting.len() >= policy.max_concurrent_starts {
                drop(starting);
                drop(table);
                if wait_rounds >= MAX_START_WAIT_ROUNDS {
                    return Err(LspError::RequestTimeout("waiting for LSP cold-start budget".into()));
                }
                wait_rounds += 1;
                tokio::time::sleep(START_WAIT_POLL).await;
                continue;
            }
            for idle in self.reclaim_idle_keys(&table) {
                if starting.contains_key(&idle) {
                    continue;
                }
                if let Some(session) = table.remove(&idle) {
                    victims.push(RetiringSession::new(
                        session,
                        self.retiring.clone(),
                        self.deferred_retirements.clone(),
                    ));
                }
            }
            // 本次待关闭victim可让本次预留替代它，其他启动者仍必须计入这些进程。
            while table.len()
                + starting.len()
                + self
                    .retiring
                    .load(Ordering::Acquire)
                    .saturating_sub(victims.len())
                >= policy.max_sessions
            {
                let victim = table
                    .iter()
                    .filter_map(|(key, session)| {
                        if starting.contains_key(key) {
                            return None;
                        }
                        Self::reclaimable_last_used(session).map(|used| (key.clone(), used))
                    })
                    .min_by_key(|(_, used)| *used)
                    .map(|(key, _)| key);
                let Some(victim) = victim else {
                    return Err(LspError::ServerFailed(
                        "LSP capacity is occupied by active requests/startups; retry later".into(),
                    ));
                };
                if let Some(session) = table.remove(&victim) {
                    victims.push(RetiringSession::new(
                        session,
                        self.retiring.clone(),
                        self.deferred_retirements.clone(),
                    ));
                }
            }
            let notify = Arc::new(Notify::new());
            starting.insert(key.clone(), notify.clone());
            own_notify = Some(notify);
            break;
        }

        let _starting_lease = StartingLease {
            key: key.clone(),
            notify: own_notify
                .as_ref()
                .expect("startup placeholder owned")
                .clone(),
            starting: self.starting.clone(),
        };

        // —— 段 2：锁外慢路径（victim shutdown + 配置查找 + probe + spawn）——
        // 先 shutdown victim（优雅关闭 → 等待 → kill 兜底；锁外执行，避免
        // ≤3s/个的关闭时间阻塞其他会话访问，M1/R3.1）。
        for victim in victims {
            let mut session = victim.session.lock().await;
            session.shutdown().await;
            if !session.process_exited() {
                return Err(LspError::ServerFailed(
                    "LSP process has not exited after shutdown; capacity remains reserved, retry later".into(),
                ));
            }
            drop(session);
            // 先确认进程退出，再归还容量；失败/取消由 Drop 交给巡检继续关闭。
            drop(victim);
        }

        let origin = SessionOrigin {
            instance: std::sync::Weak::new(),
            config: config.clone(),
            project_id: config_key,
        };
        let session = match self
            .start_reserved_session(&key, config, restart_count, &failure_key)
            .await
        {
            Ok(session) => session,
            Err(error) => {
                self.release_starting(&key, own_notify.as_ref()).await;
                return Err(error);
            }
        };

        self.publish_reserved_session(
            &key,
            own_notify.as_ref().expect("startup placeholder owned"),
            &session,
            origin,
            Vec::new(),
        )
        .await?;
        self.failures
            .lock()
            .await
            .retain(|(l, root, _), _| l != lang || root != &physical_root);
        if let Some(notify) = own_notify {
            notify.notify_waiters();
        }
        self.register_root_alias(&logical_root, &failure_key, &session)
            .await;
        Ok((session, true))
    }

    /// Caller owns a StartingLease. Reuse probe/spawn/failure handling without
    /// root discovery, capacity eviction, or any project-prefix mutation.
    async fn start_reserved_session(
        &self,
        key: &SessionKey,
        config: ServerConfig,
        restart_count: u32,
        failure_key: &FailureKey,
    ) -> Result<Arc<Mutex<ServerSession>>, LspError> {
        let result = if !super::probe::is_command_installed(&config.command) {
            Err(LspError::ServerMissing(config.command.clone(), config.install_command.clone()))
        } else {
            ServerSession::start(&key.0, &key.1, config, restart_count)
                .await
                .map(|session| Arc::new(Mutex::new(session)))
        };
        if let Err(error) = &result {
            self.record_start_failure(failure_key, error).await;
        }
        result
    }

    async fn publish_reserved_session(
        &self,
        key: &SessionKey,
        notify: &Arc<Notify>,
        session: &Arc<Mutex<ServerSession>>,
        mut origin: SessionOrigin,
        aliases_to_rebind: Vec<FailureKey>,
    ) -> Result<(), LspError> {
        let mut unpublished = UnpublishedSession { session, manager: self, published: false };
        let inserted = {
            // The same order as admission/reaping: sessions -> starting. Metadata
            // is only acquired after these locks, never in the reverse order.
            let mut sessions = self.sessions.lock().await;
            let mut starting = self.starting.lock().await;
            let mut origins = self.session_origins.lock().await;
            let mut aliases = self.root_aliases.lock().await;
            let owns = starting.get(key).is_some_and(|current| Arc::ptr_eq(current, notify));
            if owns && !sessions.contains_key(key) {
                origins.retain(|key, origin| sessions.get(key)
                    .is_some_and(|current| same_instance(&origin.instance, current)));
                origin.instance = Arc::downgrade(session);
                origins.insert(key.clone(), origin);
                sessions.insert(key.clone(), session.clone());
                for alias_key in aliases_to_rebind {
                    aliases.insert(alias_key, RootAlias {
                        owner: key.1.clone(),
                        instance: Arc::downgrade(session),
                    });
                }
                starting.remove(key);
                unpublished.published = true;
                true
            } else {
                false
            }
        };
        if !inserted {
            session.lock().await.shutdown().await;
            // The unpublished guard keeps failed/cancelled shutdown in retirement.
            return Err(LspError::ServerFailed("LSP startup was superseded; replacement was not published".into()));
        }
        notify.notify_waiters();
        Ok(())
    }

    /// 释放 starting 占位并唤醒等待者（M1）。仅占位所有者执行；占位已被接管
    ///（Arc 指针不一致）时不动，由接管者负责清理——防旧占位者误删新占位者。
    async fn release_starting(&self, key: &SessionKey, own_notify: Option<&Arc<Notify>>) {
        let notify = {
            let mut starting = self.starting.lock().await;
            let is_owner = match (own_notify, starting.get(key)) {
                (Some(own), Some(current)) => Arc::ptr_eq(own, current),
                _ => false,
            };
            if is_owner {
                starting.remove(key)
            } else {
                None
            }
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    /// 只有表本身持有的空闲会话可回收；正在等待/运行请求的外部Arc会阻止淘汰。
    fn reclaimable_last_used(session: &Arc<Mutex<ServerSession>>) -> Option<u64> {
        let guard = unused_handle(session)?;
        if guard.active_diagnostics() > 0 {
            return None;
        }
        Some(guard.last_used_ms.load(Ordering::Relaxed))
    }

    fn reclaim_idle_keys(
        &self,
        sessions: &HashMap<SessionKey, Arc<Mutex<ServerSession>>>,
    ) -> Vec<SessionKey> {
        let idle_ms = self.resource_policy().idle_timeout_secs * 1000;
        sessions
            .iter()
            .filter_map(|(key, session)| {
                Self::reclaimable_last_used(session)
                    .filter(|used| *used > 0 && now_ms().saturating_sub(*used) > idle_ms)
                    .map(|_| key.clone())
            })
            .collect()
    }

    /// 会话状态快照（供前端状态徽章实时展示，§10）：遍历全部 (语言 × 项目根)
    /// 会话，动态检测进程退出状态；按 (lang, project_root) 排序保证输出稳定。
    ///
    /// `filter_project_root`：Some(root) 时只返回该项目根**及其子目录**下的
    /// 会话（会话根可能是项目根之下的技术栈根，如 native/；前端徽章按当前
    /// 项目过滤，§10）；None 返回全部会话。过滤在持有锁内做纯比较，
    /// 不触发任何会话创建/回收。
    ///
    /// 注意：这里只做**观察**，不修改任何会话状态（不触发回收/重启），
    /// 与 `get_or_start` 的懒加载语义完全解耦。
    /// 内部状态快照转换逻辑。
    fn build_session_status(
        lang: &str,
        project_root: &Path,
        guard: &mut ServerSession,
    ) -> SessionStatus {
        let (status, error) = if guard.dead || guard.main_loop_done.load(Ordering::Acquire) {
            let message = if guard.dead {
                "会话已停止（空闲回收或关闭）".to_string()
            } else {
                "服务器主循环已结束（进程退出或崩溃），下次工具调用将自动重启".to_string()
            };
            ("dead".to_string(), Some(message))
        } else if let Some(code) = guard.exited_code() {
            (
                "exited".to_string(),
                Some(format!(
                    "服务器进程已退出（exit code {code}），下次工具调用将自动重启"
                )),
            )
        } else {
            ("running".to_string(), None)
        };
        SessionStatus {
            resources: Some(guard.resource_snapshot()),
            lang: lang.to_string(),
            project_root: project_root.display().to_string(),
            status,
            restart_count: guard.restart_count,
            last_used_ms: guard.last_used_ms.load(Ordering::Relaxed),
            error,
        }
    }

    /// 会话状态快照（供前端状态徽章实时展示，§10）：遍历全部 (语言 × 项目根)
    /// 会话，动态检测进程退出状态；按 (lang, project_root) 排序保证输出稳定。
    ///
    /// `filter_project_root`：Some(root) 时只返回该项目根**及其子目录**下的
    /// 会话（会话根可能是项目根之下的技术栈根，如 native/；前端徽章按当前
    /// 项目过滤，§10）；None 返回全部会话。过滤在持有锁内做纯比较，
    /// 不触发任何会话创建/回收。
    ///
    /// 注意：这里只做**观察**，不修改任何会话状态（不触发回收/重启），
    /// 与 `get_or_start` 的懒加载语义完全解耦。
    pub async fn session_statuses(&self, filter_project_root: Option<&Path>) -> Vec<SessionStatus> {
        let normalized_filter = match filter_project_root {
            Some(root) => Some(
                tokio::fs::canonicalize(root)
                    .await
                    .unwrap_or_else(|_| root.to_path_buf()),
            ),
            None => None,
        };
        let aliases = self.live_root_aliases().await;
        let in_scope = |lang: &str, root: &Path, session: Option<&Arc<Mutex<ServerSession>>>| {
            normalized_filter.as_deref().is_none_or(|filter| {
                root.starts_with(filter)
                    || aliases.iter().any(|((l, logical, _), alias)| {
                        l == lang
                            && logical.starts_with(filter)
                            && alias.owner == root
                            && session
                                .is_some_and(|current| same_instance(&alias.instance, current))
                    })
            })
        };
        let handles: Vec<(SessionKey, Arc<Mutex<ServerSession>>)> = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(key, session)| (key.clone(), session.clone()))
            .collect();
        let mut statuses = Vec::with_capacity(handles.len());
        for ((lang, root), session) in handles {
            if !in_scope(&lang, &root, Some(&session)) {
                continue;
            }
            let sampled = match session.try_lock() {
                Ok(mut guard) => {
                    let status = Self::build_session_status(&lang, &root, &mut guard);
                    let failure_key = (lang.clone(), root.clone(), guard.config_fingerprint());
                    Some((status, failure_key))
                }
                Err(_) => None,
            };
            if let Some((status, failure_key)) = sampled {
                if status.status != "running" {
                    self.observe_crash(&failure_key, &session).await;
                }
                statuses.push(status);
            } else {
                statuses.push(SessionStatus { resources: None, lang, project_root:root.display().to_string(),status:"running".into(),
                    restart_count:0,last_used_ms:0,error:Some("session busy; process state was not sampled (not an index-readiness guarantee)".into()) });
            }
        }
        let failures = self.failures.lock().await.clone();
        for ((lang, root, _), failure) in failures {
            let observed = failure
                .observed_crash
                .as_ref()
                .and_then(std::sync::Weak::upgrade);
            if !in_scope(&lang, &root, observed.as_ref()) {
                continue;
            }
            if let Some(status) = statuses
                .iter_mut()
                .find(|status| status.lang == lang && Path::new(&status.project_root) == root)
            {
                if status.status != "running" {
                    // Keep the concrete generation used by exact confirmation;
                    // failure/backoff count belongs in the error text, not identity.
                    status.error = Some(format!(
                        "crashed {} time(s); retryAfterEpochMs={}; {}",
                        failure.count, failure.retry_at_ms, failure.message
                    ));
                }
                continue;
            }
            statuses.push(SessionStatus {
                resources: None,
                lang,
                project_root: root.display().to_string(),
                status: "dead".into(),
                restart_count: failure.count,
                last_used_ms: failure.failed_at_ms,
                error: Some(format!(
                    "startup failed {} time(s); retryAfterEpochMs={}; {}",
                    failure.count, failure.retry_at_ms, failure.message
                )),
            });
        }
        statuses.sort_by(|a, b| {
            a.lang
                .cmp(&b.lang)
                .then(a.project_root.cmp(&b.project_root))
        });
        statuses
    }

    /// Exact task-manager operation. The physical key must already exist; no
    /// alias/root detection and no unrelated idle/LRU victim is selected.
    pub async fn manage_session_exact(
        &self,
        target: &SessionTarget,
        action: &str,
    ) -> Result<Option<SessionStatus>, LspError> {
        let invalid = |message: &str| LspError::ServerFailed(message.into());
        if !matches!(action, "stop" | "restart") {
            return Err(invalid("LSP action must be 'stop' or 'restart'"));
        }
        let requested_root = Path::new(&target.project_root);
        if target.lang.trim().is_empty() || target.lang != target.lang.trim()
            || target.lang.contains('\0') || target.project_root.trim().is_empty()
            || target.project_root.contains('\0') || !requested_root.is_absolute()
            || target.expected_pid == 0
        {
            return Err(invalid("LSP target requires a language, local absolute root and positive PID"));
        }
        #[cfg(windows)]
        if !matches!(requested_root.components().next(), Some(std::path::Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
        {
            return Err(invalid("LSP target root must be a local absolute drive path"));
        }
        #[cfg(not(windows))]
        if target.project_root.starts_with("//") {
            return Err(invalid("LSP target root must be a local absolute path"));
        }
        let root = tokio::fs::canonicalize(requested_root).await
            .map_err(|_| invalid("LSP target root is unavailable; refresh the session list"))?;
        let key = (target.lang.clone(), root);
        // All awaits that acquire lifecycle metadata happen before identity
        // validation. After validation, lease + extraction are synchronous.
        let mut sessions = self.sessions.lock().await;
        let mut starting = self.starting.lock().await;
        if starting.contains_key(&key) {
            return Err(invalid("LSP session is starting or being managed; retry later"));
        }
        let session = sessions.get(&key).cloned()
            .ok_or_else(|| invalid("LSP session disappeared; refresh the session list"))?;
        let mut origins = self.session_origins.lock().await;
        let mut aliases = self.root_aliases.lock().await;
        let mut guard = session.try_lock()
            .map_err(|_| invalid("LSP session is busy; retry when requests finish"))?;
        if Arc::strong_count(&session) != 2 || guard.active_diagnostics() > 0 {
            return Err(invalid("LSP session has active or queued requests; retry when they finish"));
        }
        if guard.process_exited() || guard.resource_snapshot().pid != Some(target.expected_pid)
            || guard.restart_count != target.expected_restart_count
        {
            return Err(invalid("LSP session identity changed or PID is unavailable; refresh and confirm again"));
        }
        let origin = origins.get(&key).filter(|origin| same_instance(&origin.instance, &session))
            .cloned().ok_or_else(|| invalid("LSP session origin changed; refresh and confirm again"))?;
        if !guard.matches_config(&origin.config) {
            return Err(invalid("LSP session configuration identity changed; refresh and confirm again"));
        }
        let restart_count = if action == "restart" {
            let policy = self.resource_policy();
            if starting.len() >= policy.max_concurrent_starts
                || sessions.len() + starting.len() + self.retiring.load(Ordering::Acquire) > policy.max_sessions
            {
                return Err(invalid("LSP startup/capacity budget is busy; retry later (no other session was stopped)"));
            }
            let configs = self.configs.try_read()
                .map_err(|_| invalid("LSP configuration is being refreshed; retry later"))?;
            if !configs.get(&origin.project_id).is_some_and(|configs| configs.iter()
                .any(|config| config.enabled && *config == origin.config))
            {
                return Err(invalid("LSP effective configuration changed; use settings to start with the new configuration"));
            }
            guard.restart_count.checked_add(1)
                .ok_or_else(|| invalid("LSP restart count exhausted"))?
        } else {
            guard.restart_count
        };
        let failure_key = (key.0.clone(), key.1.clone(), origin.config.fingerprint());
        let aliases_to_rebind = aliases.iter()
            .filter(|((lang, _, _), alias)| lang == &key.0 && alias.owner == key.1
                && same_instance(&alias.instance, &session))
            .map(|(key, _)| key.clone()).collect::<Vec<_>>();
        let notify = Arc::new(Notify::new());
        starting.insert(key.clone(), notify.clone());
        let _lease = StartingLease { key: key.clone(), notify: notify.clone(), starting: self.starting.clone() };
        // Table lock and concrete instance guard protect the confirmation-to-
        // extraction transition. Later replacements can never become victims.
        let victim = RetiringSession::new(
            sessions.remove(&key).expect("confirmed physical session is registered"),
            self.retiring.clone(), self.deferred_retirements.clone(),
        );
        origins.remove(&key);
        for alias_key in &aliases_to_rebind { aliases.remove(alias_key); }
        drop(aliases);
        drop(origins);
        drop(starting);
        drop(sessions);
        guard.shutdown().await;
        let exited = guard.process_exited();
        drop(guard);
        drop(session);
        drop(victim); // Cancellation/failure keeps capacity in deferred retirement.
        if !exited {
            return Err(invalid("LSP process has not exited after shutdown; retirement remains reserved, retry later"));
        }
        self.failures.lock().await.remove(&failure_key);
        if action == "stop" {
            return Ok(None);
        }
        let replacement = self.start_reserved_session(&key, origin.config.clone(), restart_count, &failure_key).await?;
        let status = {
            let mut guard = replacement.lock().await;
            Self::build_session_status(&key.0, &key.1, &mut guard)
        };
        self.publish_reserved_session(&key, &notify, &replacement, origin, aliases_to_rebind).await?;
        // Status was sampled on our replacement before publication; no await
        // after publication can accidentally report a later replacement instance.
        Ok(Some(status))
    }

    /// 手动停止指定 (语言 × 项目根) 的所有运行中会话。
    ///
    /// 在锁内将匹配的会话从 sessions 中移除，在锁外优雅 shutdown（≤3s，超时 kill）。
    /// 返回实际关闭的会话数量。
    pub async fn stop_session(&self, lang: &str, project_root: &Path) -> usize {
        let normalized_root = tokio::fs::canonicalize(project_root)
            .await
            .unwrap_or_else(|_| project_root.to_path_buf());
        let project_root = normalized_root.as_path();
        // Stopping a member explicitly stops its shared physical session too.
        // This is recorded ownership, not an arbitrary ancestor-prefix match.
        let aliases = self.live_root_aliases().await;
        let victims: Vec<(SessionKey, RetiringSession)> = {
            let mut sessions = self.sessions.lock().await;
            let keys_to_remove: Vec<SessionKey> = sessions
                .iter()
                .filter(|((l, root), session)| {
                    l == lang
                        && (root.starts_with(project_root)
                            || aliases.iter().any(|((alias_lang, logical, _), alias)| {
                                alias_lang == lang
                                    && logical.starts_with(project_root)
                                    && alias.owner == *root
                                    && same_instance(&alias.instance, session)
                            }))
                })
                .map(|(key, _)| key.clone())
                .collect();
            let mut list = Vec::with_capacity(keys_to_remove.len());
            for key in keys_to_remove {
                if let Some(session) = sessions.remove(&key) {
                    list.push((
                        key,
                        RetiringSession::new(
                            session,
                            self.retiring.clone(),
                            self.deferred_retirements.clone(),
                        ),
                    ));
                }
            }
            list
        };

        let count = victims.len();
        for (_key, victim) in victims {
            victim.session.lock().await.shutdown().await;
        }
        count
    }

    /// 手动启动（预热）指定语言的 LSP 会话。
    pub async fn start_session(
        &self,
        lang: &str,
        project_root: &Path,
        project_id: Option<&str>,
    ) -> Result<SessionStatus, LspError> {
        // 先确保配置最新
        self.reload_configs(project_id)
            .await
            .map_err(|error| LspError::Internal(error.to_string()))?;

        let target_root =
            super::detect::find_lang_root(project_root, None, lang).ok_or_else(|| {
                LspError::NoLangStack(
                    lang.to_string(),
                    super::detect::markers_for_lang(lang).join(", "),
                )
            })?;

        let session = self.get_or_start(lang, &target_root, project_id).await?;
        let mut guard = session.lock().await;
        let actual_root = guard.project_root.clone();
        Ok(Self::build_session_status(lang, &actual_root, &mut guard))
    }

    /// 重启指定 (语言 × 项目根) 的 LSP 会话，可选清理该项目前缀的持久化诊断缓存。
    pub async fn restart_session(
        &self,
        lang: &str,
        project_root: &Path,
        project_id: Option<&str>,
        clear_cache: bool,
    ) -> Result<SessionStatus, LspError> {
        self.reload_configs(project_id)
            .await
            .map_err(|error| LspError::Internal(error.to_string()))?;
        let config = self
            .configs(project_id)
            .await
            .into_iter()
            .find(|config| config.lang == lang && config.enabled)
            .ok_or_else(|| LspError::NotConfigured(lang.into()))?;
        let physical = tokio::fs::canonicalize(project_root)
            .await
            .unwrap_or_else(|_| project_root.to_path_buf());
        let logical = super::detect::find_lang_root(&physical, None, lang)
            .unwrap_or_else(|| physical.clone());
        let owner = super::detect::session_root(&config, &logical).await;
        let fingerprint = config.fingerprint();
        self.stop_session(lang, project_root).await;
        self.failures.lock().await.retain(|(l, root, fp), _| {
            l != lang || fp != &fingerprint || !(root.starts_with(&physical) || root == &owner)
        });

        if clear_cache {
            if let Ok(storage_info) = crate::storage::initialize_app_storage() {
                let db_path = PathBuf::from(storage_info.database_path);
                let _ = crate::storage::services::lsp_diagnostic_cache::remove_by_prefix(
                    &db_path,
                    &project_root.to_string_lossy(),
                );
            }
        }

        self.start_session(lang, project_root, project_id).await
    }
}

/// 当前 unix 毫秒。
fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
