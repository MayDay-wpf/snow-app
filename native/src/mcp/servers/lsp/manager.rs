//! ServerManager：全局单例，管理 (语言 × 项目根) 会话的生命周期。
//!
//! - 会话粒度 = (语言, 项目根)：同项目同语言单进程，多项目各自进程（§7.2）
//! - 懒加载：首次工具调用才 spawn（§7.1）
//! - 空闲回收：超过 idle_timeout 的会话在下次调用时回收
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
/// 崩溃连续重启上限（§7.3）。
const MAX_BACKOFF: Duration = Duration::from_secs(300);
/// 同 key 并发 spawn 占位等待的轮询间隔（M1/R3.1）：等待者以 Notify 唤醒为主、
/// 超时轮询为兜底——防「等待者尚未注册时占位者已 notify」的丢失竞态。
const START_WAIT_POLL: Duration = Duration::from_millis(200);
/// 占位等待轮次上限（200ms × 750 ≈ 150s，覆盖 JVM initialize 120s 上限 + 余量）。
/// 占位者异常（panic）未释放时的保险：超限返回超时，绝不额外spawn；正常路径下
/// 占位者完成（成功/失败）必然 notify，轮次远达不到上限。
const MAX_START_WAIT_ROUNDS: u32 = 750;

/// 会话状态快照（供前端状态徽章实时展示；查询时动态检测进程退出）。
#[derive(Debug, Clone)]
pub struct SessionStatus {
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

/// 尚在关闭的进程仍占容量；Drop覆盖启动任务取消路径。
struct RetiringSession {
    session: Arc<Mutex<ServerSession>>,
    count: Arc<AtomicUsize>,
}
impl RetiringSession {
    fn new(session: Arc<Mutex<ServerSession>>, count: Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::AcqRel);
        Self { session, count }
    }
}
impl Drop for RetiringSession {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct ServerManager {
    sessions: Mutex<HashMap<SessionKey, Arc<Mutex<ServerSession>>>>,
    /// 并发 spawn 占位（M1/R3.1）：key -> Notify。同一 key 同时只有一个 spawn
    /// 者；等待者克隆 Notify 后在锁外等待，占位者完成（成功/失败）后
    /// notify_waiters 唤醒，重试段 1 直接复用会话。
    starting: Arc<Mutex<HashMap<SessionKey, Arc<Notify>>>>,
    /// 有效配置快照（project_id → configs；空 key = 全局）。
    configs: RwLock<HashMap<String, Vec<ServerConfig>>>,
    max_sessions: usize,
    idle_timeout: Duration,
    failures: Mutex<HashMap<FailureKey, StartupFailure>>,
    retiring: Arc<AtomicUsize>,
}

impl ServerManager {
    /// 全局单例。
    pub fn instance() -> &'static Arc<ServerManager> {
        static INSTANCE: OnceLock<Arc<ServerManager>> = OnceLock::new();
        INSTANCE.get_or_init(|| {
            Arc::new(ServerManager {
                sessions: Mutex::new(HashMap::new()),
                starting: Arc::new(Mutex::new(HashMap::new())),
                configs: RwLock::new(HashMap::new()),
                max_sessions: MAX_SESSIONS,
                idle_timeout: IDLE_TIMEOUT,
                failures: Mutex::new(HashMap::new()),
                retiring: Arc::new(AtomicUsize::new(0)),
            })
        })
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

    /// 提示词/工具暴露只读健康快照，绝不启动服务器。各锁顺序获取、互不嵌套。
    pub async fn tool_availability(
        &self,
        config: &ServerConfig,
        root: &Path,
    ) -> Option<Vec<String>> {
        if !config.enabled {
            return Some(Vec::new());
        }
        let physical = match tokio::fs::canonicalize(root).await {
            Ok(root) => root,
            Err(_) => return Some(Vec::new()),
        };
        let failure_key = (config.lang.clone(), physical.clone(), config.fingerprint());
        let blocked = self
            .failures
            .lock()
            .await
            .get(&failure_key)
            .is_some_and(|f| Instant::now() < f.retry_at);
        if blocked {
            return Some(Vec::new());
        }
        let session = self
            .sessions
            .lock()
            .await
            .get(&(config.lang.clone(), physical))
            .cloned();
        let Some(session) = session else { return None };
        let mut guard = session.lock().await;
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
    pub async fn get_or_start(
        &self,
        lang: &str,
        project_root: &Path,
        project_id: Option<&str>,
    ) -> Result<Arc<Mutex<ServerSession>>, LspError> {
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
        let project_root = physical_root.as_path();
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
                        return Ok(session);
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
                    victims.push(RetiringSession::new(old, self.retiring.clone()));
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
            for idle in self.reclaim_idle_keys(&table) {
                if let Some(session) = table.remove(&idle) {
                    victims.push(RetiringSession::new(session, self.retiring.clone()));
                }
            }
            // 本次待关闭victim可让本次预留替代它，其他启动者仍必须计入这些进程。
            while table.len()
                + starting.len()
                + self
                    .retiring
                    .load(Ordering::Acquire)
                    .saturating_sub(victims.len())
                >= self.max_sessions
            {
                let victim = table
                    .iter()
                    .filter_map(|(key, session)| {
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
                    victims.push(RetiringSession::new(session, self.retiring.clone()));
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
            victim.session.lock().await.shutdown().await;
            // 先关闭，再归还retiring容量。
            drop(victim);
        }

        // config 已在快速路径前按当前作用域校验；启动使用同一快照。

        // 安装检查（§8.6）：enabled 但命令不在 PATH → 明确降级错误
        //    （附 installCommand 建议），避免 spawn ENOENT 的模糊失败。
        //    仅首次启动会话时探测一次；已有会话直接复用（段 1），无开销。
        if !super::probe::is_command_installed(&config.command) {
            let error =
                LspError::ServerMissing(config.command.clone(), config.install_command.clone());
            self.record_start_failure(&failure_key, &error).await;
            self.release_starting(&key, own_notify.as_ref()).await;
            return Err(error);
        }

        // 启动会话（懒加载；spawn + initialize 30-120s 全程不持 sessions 锁，
        // restart_count 为崩溃重建计数）。
        let session = match ServerSession::start(lang, project_root, config, restart_count).await {
            Ok(session) => Arc::new(Mutex::new(session)),
            Err(error) => {
                self.record_start_failure(&failure_key, &error).await;
                self.release_starting(&key, own_notify.as_ref()).await;
                return Err(error);
            }
        };

        // 锁内插入 + 释放占位 + 唤醒等待者（顺序：先 insert 后移除占位——等待者
        // 重试段 1 时直接复用会话）。own_notify 与 map 中占位不一致（占位已被
        // 接管）时不插入：防双会话竞争，本次会话随 Arc 释放被 Drop 回收（进程
        // 树由 kill_on_drop + ProcessTreeGuard 兜底清理）。
        let inserted = {
            // 同一锁序内确认占位所有权、插入会话并释放占位，消除检查后被接管的窗口。
            let mut sessions = self.sessions.lock().await;
            let mut starting = self.starting.lock().await;
            let owns = match (own_notify.as_ref(), starting.get(&key)) {
                (Some(own), Some(current)) => Arc::ptr_eq(own, current),
                _ => false,
            };
            if owns {
                sessions.insert(key.clone(), session.clone());
                starting.remove(&key);
            }
            owns
        };
        if !inserted {
            session.lock().await.shutdown().await;
            return Err(LspError::ServerFailed(
                "LSP startup was superseded; retry the request".into(),
            ));
        }
        self.failures
            .lock()
            .await
            .retain(|(l, root, _), _| l != lang || root != &physical_root);
        if let Some(notify) = own_notify {
            notify.notify_waiters();
        }
        Ok(session)
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
        let idle_ms = self.idle_timeout.as_millis() as u64;
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
        let handles: Vec<(SessionKey, Arc<Mutex<ServerSession>>)> = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(key, session)| (key.clone(), session.clone()))
            .collect();
        let mut statuses = Vec::with_capacity(handles.len());
        for ((lang, root), session) in handles {
            if normalized_filter
                .as_deref()
                .is_some_and(|filter| !root.starts_with(filter))
            {
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
                statuses.push(SessionStatus { lang, project_root:root.display().to_string(),status:"running".into(),
                    restart_count:0,last_used_ms:0,error:Some("session busy; process state was not sampled (not an index-readiness guarantee)".into()) });
            }
        }
        let failures = self.failures.lock().await.clone();
        for ((lang, root, _), failure) in failures {
            if normalized_filter
                .as_deref()
                .is_some_and(|filter| !root.starts_with(filter))
            {
                continue;
            }
            if let Some(status) = statuses
                .iter_mut()
                .find(|status| status.lang == lang && Path::new(&status.project_root) == root)
            {
                if status.status != "running" {
                    status.restart_count = failure.count;
                    status.error = Some(format!(
                        "crashed {} time(s); retryAfterEpochMs={}; {}",
                        failure.count, failure.retry_at_ms, failure.message
                    ));
                }
                continue;
            }
            statuses.push(SessionStatus {
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

    /// 手动停止指定 (语言 × 项目根) 的所有运行中会话。
    ///
    /// 在锁内将匹配的会话从 sessions 中移除，在锁外优雅 shutdown（≤3s，超时 kill）。
    /// 返回实际关闭的会话数量。
    pub async fn stop_session(&self, lang: &str, project_root: &Path) -> usize {
        let normalized_root = tokio::fs::canonicalize(project_root)
            .await
            .unwrap_or_else(|_| project_root.to_path_buf());
        let project_root = normalized_root.as_path();
        let victims: Vec<(SessionKey, RetiringSession)> = {
            let mut sessions = self.sessions.lock().await;
            let keys_to_remove: Vec<SessionKey> = sessions
                .keys()
                .filter(|(l, root)| l == lang && root.starts_with(project_root))
                .cloned()
                .collect();
            let mut list = Vec::with_capacity(keys_to_remove.len());
            for key in keys_to_remove {
                if let Some(session) = sessions.remove(&key) {
                    list.push((key, RetiringSession::new(session, self.retiring.clone())));
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
        Ok(Self::build_session_status(lang, &target_root, &mut guard))
    }

    /// 重启指定 (语言 × 项目根) 的 LSP 会话，可选清理该项目前缀的持久化诊断缓存。
    pub async fn restart_session(
        &self,
        lang: &str,
        project_root: &Path,
        project_id: Option<&str>,
        clear_cache: bool,
    ) -> Result<SessionStatus, LspError> {
        self.stop_session(lang, project_root).await;
        let physical = tokio::fs::canonicalize(project_root)
            .await
            .unwrap_or_else(|_| project_root.to_path_buf());
        self.failures
            .lock()
            .await
            .retain(|(l, root, _), _| l != lang || !root.starts_with(&physical));

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

#[cfg(test)]
mod health_tests {
    use super::*;
    #[test]
    fn cancelled_start_releases_only_its_own_placeholder() {
        let key = ("rust".into(), PathBuf::from("/fixture"));
        let notify = Arc::new(Notify::new());
        let starting = Arc::new(Mutex::new(HashMap::from([(key.clone(), notify.clone())])));
        drop(StartingLease {
            key: key.clone(),
            notify,
            starting: starting.clone(),
        });
        assert!(starting.try_lock().unwrap().is_empty());
        let old = Arc::new(Notify::new());
        let new = Arc::new(Notify::new());
        starting
            .try_lock()
            .unwrap()
            .insert(key.clone(), new.clone());
        drop(StartingLease {
            key: key.clone(),
            notify: old,
            starting: starting.clone(),
        });
        assert!(Arc::ptr_eq(
            starting.try_lock().unwrap().get(&key).unwrap(),
            &new
        ));
    }

    #[test]
    fn externally_pinned_and_locked_handles_are_not_reclaimable() {
        let handle = Arc::new(Mutex::new(0u8));
        assert!(unused_handle(&handle).is_some());
        let pin = handle.clone();
        assert!(unused_handle(&handle).is_none());
        drop(pin);
        let guard = handle.try_lock().unwrap();
        assert!(unused_handle(&handle).is_none());
        drop(guard);
        assert!(unused_handle(&handle).is_some());
    }
    #[test]
    fn repeated_crash_observation_keeps_instance_identity() {
        let first = Arc::new(());
        let weak = Arc::downgrade(&first);
        assert!(same_instance(&weak, &first));
        assert!(!same_instance(&weak, &Arc::new(())));
        let retry = Instant::now();
        assert!(!(retry + Duration::from_millis(1) < retry));
    }
    #[test]
    fn exponential_backoff_is_bounded() {
        assert_eq!(failure_delay(1), Duration::from_secs(5));
        assert_eq!(failure_delay(2), Duration::from_secs(10));
        assert_eq!(failure_delay(u32::MAX), MAX_BACKOFF);
    }
    #[test]
    fn failure_keys_include_physical_root_and_config() {
        let a: FailureKey = ("rust".into(), PathBuf::from("/work/a"), "config1".into());
        let b: FailureKey = ("rust".into(), PathBuf::from("/work/b"), "config1".into());
        let c: FailureKey = ("rust".into(), PathBuf::from("/work/a"), "config2".into());
        assert_ne!(a, b);
        assert_ne!(a, c);
    }
}
