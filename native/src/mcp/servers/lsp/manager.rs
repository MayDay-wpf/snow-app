//! ServerManager：全局单例，管理 (语言 × 项目根) 会话的生命周期。
//!
//! - 会话粒度 = (语言, 项目根)：同项目同语言单进程，多项目各自进程（§7.2）
//! - 懒加载：首次工具调用才 spawn（§7.1）
//! - 空闲回收：超过 idle_timeout 的会话在下次调用时回收
//! - 崩溃重启：dead 会话在下次使用时重建（≤2 次，§7.1）
//! - 并发上限：max_sessions（跨项目合计），超限 LRU 淘汰

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

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
const RESTART_LIMIT: u32 = 2;
/// 同 key 并发 spawn 占位等待的轮询间隔（M1/R3.1）：等待者以 Notify 唤醒为主、
/// 超时轮询为兜底——防「等待者尚未注册时占位者已 notify」的丢失竞态。
const START_WAIT_POLL: Duration = Duration::from_millis(200);
/// 占位等待轮次上限（200ms × 750 ≈ 150s，覆盖 JVM initialize 120s 上限 + 余量）。
/// 占位者异常（panic）未释放时的保险：超限后接管占位直接 spawn；正常路径下
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

pub struct ServerManager {
    sessions: Mutex<HashMap<SessionKey, Arc<Mutex<ServerSession>>>>,
    /// 并发 spawn 占位（M1/R3.1）：key -> Notify。同一 key 同时只有一个 spawn
    /// 者；等待者克隆 Notify 后在锁外等待，占位者完成（成功/失败）后
    /// notify_waiters 唤醒，重试段 1 直接复用会话。
    starting: Mutex<HashMap<SessionKey, Arc<Notify>>>,
    /// 有效配置快照（project_id → configs；空 key = 全局）。
    configs: RwLock<HashMap<String, Vec<ServerConfig>>>,
    max_sessions: usize,
    idle_timeout: Duration,
}

impl ServerManager {
    /// 全局单例。
    pub fn instance() -> &'static Arc<ServerManager> {
        static INSTANCE: OnceLock<Arc<ServerManager>> = OnceLock::new();
        INSTANCE.get_or_init(|| {
            Arc::new(ServerManager {
                sessions: Mutex::new(HashMap::new()),
                starting: Mutex::new(HashMap::new()),
                configs: RwLock::new(HashMap::new()),
                max_sessions: MAX_SESSIONS,
                idle_timeout: IDLE_TIMEOUT,
            })
        })
    }

    /// 从表重载配置（每次工具调用执行，支持热更新；按 project 区分有效配置）。
    pub async fn reload_configs(&self, project_id: Option<&str>) -> napi::Result<()> {
        let configs = config::load_configs(project_id).await?;
        let key = project_id.unwrap_or("").trim().to_string();
        self.configs.write().await.insert(key, configs);
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
        let key: SessionKey = (lang.to_string(), project_root.to_path_buf());
        // 崩溃重建计数：dead 会话重建时 +1 传入新会话（R2.1，全仓唯一递增点）。
        let mut restart_count: u32 = 0;
        // 空闲回收 + LRU 淘汰收集的 victim（段 2 锁外统一 shutdown）。
        let mut victims: Vec<Arc<Mutex<ServerSession>>> = Vec::new();
        // 自己是 spawn 者时持有的占位（释放时校验所有权，防被接管竞态）。
        let mut own_notify: Option<Arc<Notify>> = None;
        // 等待轮次：占位者未释放时递增（保险计数防占位者异常泄漏）。
        let mut wait_rounds: u32 = 0;

        // —— 段 1：锁内快速路径（不 spawn、不 shutdown）——
        loop {
            // 段 1 作用域：sessions / starting 锁在离开块时释放。
            let should_wait: Option<Arc<Notify>> = {
                let mut sessions = self.sessions.lock().await;

                // 1. 已有会话：崩溃检测 → 复用或重建。
                if let Some(session) = sessions.get(&key) {
                    let mut guard = session.lock().await;
                    // 进程已退出但会话未标记 dead（如外部 kill / 服务器自行崩溃），
                    // 或 mainloop 已结束（管道断开）：均视为崩溃并走重启路径
                    //（R2.1/R2.2）。tokio Child::try_wait 重复调用幂等安全。
                    let crashed = guard.dead
                        || guard.main_loop_done.load(Ordering::Acquire)
                        || guard.exited_code().is_some();
                    if crashed && guard.restart_count >= RESTART_LIMIT {
                        return Err(LspError::ServerFailed(format!(
                            "语言服务器 \"{lang}\" 启动失败（已连续重启 {RESTART_LIMIT} 次），请检查安装与配置"
                        )));
                    }
                    if crashed {
                        restart_count = guard.restart_count + 1;
                        drop(guard);
                        sessions.remove(&key);
                    } else {
                        guard.touch();
                        return Ok(session.clone());
                    }
                }

                // 2. 并发防重：同 key 已有 spawn 占位 → 锁外等待（占位者完成
                //    成功/失败均 notify）；等待超限（占位者异常未完成）→ 接管
                //    占位直接 spawn（保险计数，正常路径远达不到）。
                let mut starting = self.starting.lock().await;
                let waiter = match starting.get(&key) {
                    Some(notify) if wait_rounds < MAX_START_WAIT_ROUNDS => Some(notify.clone()),
                    _ => {
                        let notify = Arc::new(Notify::new());
                        starting.insert(key.clone(), notify.clone());
                        own_notify = Some(notify);
                        None
                    }
                };

                if waiter.is_some() {
                    // 自己是等待者：不收集 victim（收集了也无人 shutdown）。
                    waiter
                } else {
                    drop(starting);
                    // 3. 自己是 spawn 者：回收空闲 + LRU 淘汰，只收集 victim
                    //    （shutdown 在段 2 锁外执行，M1/R3.1）。
                    for idle_key in self.reclaim_idle_keys(&sessions).await {
                        if let Some(session) = sessions.remove(&idle_key) {
                            victims.push(session);
                        }
                    }
                    while sessions.len() >= self.max_sessions {
                        // 先收集 (key, last_used_ms)，再求最小（闭包内不能 await）。
                        let mut candidates: Vec<(SessionKey, u64)> =
                            Vec::with_capacity(sessions.len());
                        for (key, session) in sessions.iter() {
                            let last_used =
                                session.lock().await.last_used_ms.load(Ordering::Relaxed);
                            candidates.push((key.clone(), last_used));
                        }
                        let victim_key = candidates
                            .into_iter()
                            .min_by_key(|(_, last_used)| *last_used)
                            .map(|(key, _)| key);
                        match victim_key {
                            Some(victim_key) => {
                                if let Some(victim) = sessions.remove(&victim_key) {
                                    victims.push(victim);
                                }
                            }
                            None => break,
                        }
                    }
                    None
                }
            };

            // 锁外等待占位释放：notify 为主、超时轮询兜底（防 notify 在等待者
            // 注册前已发出的丢失竞态）；唤醒/超时后重查占位状态。
            if let Some(notify) = should_wait {
                tokio::select! {
                    _ = notify.notified() => {}
                    _ = tokio::time::sleep(START_WAIT_POLL) => {}
                }
                let released = !self.starting.lock().await.contains_key(&key);
                // 占位已释放 → 重试段 1（会话已插入或占位已移除）；仍在 → 计一轮。
                wait_rounds = if released { 0 } else { wait_rounds + 1 };
                continue;
            }
            // 自己是 spawn 者：进入段 2。
            break;
        }

        // —— 段 2：锁外慢路径（victim shutdown + 配置查找 + probe + spawn）——
        // 先 shutdown victim（优雅关闭 → 等待 → kill 兜底；锁外执行，避免
        // ≤3s/个的关闭时间阻塞其他会话访问，M1/R3.1）。
        for victim in victims {
            victim.lock().await.shutdown().await;
        }

        // 配置查找（enabled 才启动；按 project 的有效配置）。
        let config_key = project_id.unwrap_or("").trim().to_string();
        let configs = self.configs.read().await;
        let Some(config) = configs
            .get(&config_key)
            .and_then(|list| list.iter().find(|c| c.lang == lang && c.enabled))
            .cloned()
        else {
            drop(configs);
            self.release_starting(&key, own_notify.as_ref()).await;
            return Err(LspError::NotConfigured(lang.to_string()));
        };
        drop(configs);

        // 安装检查（§8.6）：enabled 但命令不在 PATH → 明确降级错误
        //    （附 installCommand 建议），避免 spawn ENOENT 的模糊失败。
        //    仅首次启动会话时探测一次；已有会话直接复用（段 1），无开销。
        if !super::probe::is_command_installed(&config.command) {
            self.release_starting(&key, own_notify.as_ref()).await;
            return Err(LspError::ServerMissing(
                config.command.clone(),
                config.install_command.clone(),
            ));
        }

        // 启动会话（懒加载；spawn + initialize 30-120s 全程不持 sessions 锁，
        // restart_count 为崩溃重建计数）。
        let session = match ServerSession::start(lang, project_root, config, restart_count).await {
            Ok(session) => Arc::new(Mutex::new(session)),
            Err(error) => {
                self.release_starting(&key, own_notify.as_ref()).await;
                return Err(error);
            }
        };

        // 锁内插入 + 释放占位 + 唤醒等待者（顺序：先 insert 后移除占位——等待者
        // 重试段 1 时直接复用会话）。own_notify 与 map 中占位不一致（占位已被
        // 接管）时不插入：防双会话竞争，本次会话随 Arc 释放被 Drop 回收（进程
        // 树由 kill_on_drop + ProcessTreeGuard 兜底清理）。
        let owns_placeholder = {
            let starting = self.starting.lock().await;
            match (own_notify.as_ref(), starting.get(&key)) {
                (Some(own), Some(current)) => Arc::ptr_eq(own, current),
                _ => false,
            }
        };
        if owns_placeholder {
            self.sessions.lock().await.insert(key.clone(), session.clone());
        } else {
            eprintln!(
                "[lsp] get_or_start: 占位已被接管，丢弃本次 spawn 的会话（进程树随 Drop 回收）"
            );
        }
        self.release_starting(&key, own_notify.as_ref()).await;
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

    /// 收集超过空闲阈值的会话 key（不 shutdown——shutdown 由调用方在锁外
    /// 执行，M1/R3.1：锁内只做纯收集，不持锁跨 await）。
    async fn reclaim_idle_keys(
        &self,
        sessions: &HashMap<SessionKey, Arc<Mutex<ServerSession>>>,
    ) -> Vec<SessionKey> {
        let idle_ms = self.idle_timeout.as_millis() as u64;
        let mut to_reclaim = Vec::new();
        for (key, session) in sessions.iter() {
            let last_used = session.lock().await.last_used_ms.load(Ordering::Relaxed);
            if last_used > 0 && now_ms().saturating_sub(last_used) > idle_ms {
                to_reclaim.push(key.clone());
            }
        }
        to_reclaim
    }

    /// 会话状态快照（供前端状态徽章实时展示，§10）：遍历全部 (语言 × 项目根)
    /// 会话，动态检测进程退出状态；按 (lang, project_root) 排序保证输出稳定。
    ///
    /// `filter_project_root`：Some(root) 时只返回该项目根下的会话（前端徽章
    /// 按当前项目过滤，§10）；None 返回全部会话。过滤在持有锁内做纯比较，
    /// 不触发任何会话创建/回收。
    ///
    /// 注意：这里只做**观察**，不修改任何会话状态（不触发回收/重启），
    /// 与 `get_or_start` 的懒加载语义完全解耦。
    pub async fn session_statuses(&self, filter_project_root: Option<&Path>) -> Vec<SessionStatus> {
        let sessions = self.sessions.lock().await;
        let mut statuses: Vec<SessionStatus> = Vec::with_capacity(sessions.len());
        for ((lang, project_root), session) in sessions.iter() {
            if let Some(root) = filter_project_root {
                if project_root.as_path() != root {
                    continue;
                }
            }
            let mut guard = session.lock().await;
            // mainloop 完成（进程退出/管道断开）→ dead（R2.2）：状态徽章显示异常，
            // 下次工具调用触发自动重启，不再出现「running 但请求全部失败」的僵尸态。
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
            statuses.push(SessionStatus {
                lang: lang.clone(),
                project_root: project_root.display().to_string(),
                status,
                restart_count: guard.restart_count,
                last_used_ms: guard.last_used_ms.load(Ordering::Relaxed),
                error,
            });
        }
        statuses.sort_by(|a, b| a.lang.cmp(&b.lang).then(a.project_root.cmp(&b.project_root)));
        statuses
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
