//! detach 后台任务登记表（内存 + 磁盘持久化）。
//!
//! 每个任务在登记时派一个后台等待任务 `wait()` 退出：进程结束的瞬间记录退出
//! 时刻并回收子进程（避免僵尸），运行时长据此定格。
//!
//! 登记表同时落盘到 `~/.snowapp/detached-tasks.json`，日志仍写在
//! `<workingDirectory>/.snow/logs/`。重启后从磁盘恢复，但只认「日志文件仍在」
//! 的条目——删日志就等于删记录。恢复的进程已不是本进程的子进程，存活靠
//! 「pid + 进程创建时刻」双重校验，校验通过才允许结束，避免 pid 复用误杀。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tokio::process::Child;
use uuid::Uuid;

/// 登记表上限：超出时先淘汰已退出的条目，长会话不会无限增长。
const MAX_ENTRIES: usize = 50;
const STORE_FILE_NAME: &str = "detached-tasks.json";
/// 恢复任务的 pid 身份校验容差：进程创建时刻与登记时刻的允许偏差。
const PROCESS_START_TOLERANCE_MS: i64 = 3_000;

/// 对外展示的后台任务状态。
pub struct DetachedTask {
    pub id: String,
    pub pid: u32,
    pub command: String,
    pub description: String,
    pub working_directory: String,
    /// 任务所属项目根；无法解析时为空串（任务管理器按此过滤）
    pub project_root: String,
    pub log_path: String,
    pub started_at: String,
    /// 退出时刻（RFC3339）；None 表示仍在运行
    pub ended_at: Option<String>,
    pub session_id: Option<String>,
    pub alive: bool,
}

struct Entry {
    id: String,
    pid: u32,
    command: String,
    description: String,
    working_directory: String,
    project_root: String,
    log_path: String,
    started_at: String,
    started_at_ms: i64,
    session_id: Option<String>,
    /// 本进程任务由退出等待任务写入；恢复任务由存活探测写入
    ended_at: Arc<Mutex<Option<String>>>,
    /// 从磁盘恢复：进程不是本进程的子进程，存活必须做身份校验
    foreign: bool,
}

/// 落盘格式（字段带默认值，便于后续演进）。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct PersistedTask {
    id: String,
    pid: u32,
    #[serde(default)]
    command: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    working_directory: String,
    #[serde(default)]
    project_root: String,
    log_path: String,
    #[serde(default)]
    started_at: String,
    #[serde(default)]
    started_at_ms: i64,
    #[serde(default)]
    ended_at: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedStore {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    tasks: Vec<PersistedTask>,
}

static REGISTRY: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
static PERSIST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn registry() -> MutexGuard<'static, Vec<Entry>> {
    REGISTRY
        .get_or_init(|| Mutex::new(load_records()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store_path() -> Option<PathBuf> {
    crate::storage::paths::app_storage_dir()
        .ok()
        .map(|dir| dir.join(STORE_FILE_NAME))
}

fn load_records() -> Vec<Entry> {
    let Some(path) = store_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(store) = serde_json::from_str::<PersistedStore>(&raw) else {
        return Vec::new();
    };
    store
        .tasks
        .into_iter()
        .filter(|task| {
            task.pid > 0
                && !task.id.trim().is_empty()
                && !task.log_path.trim().is_empty()
                // 日志被用户删除 → 记录随之消失（目录即真相）
                && Path::new(&task.log_path).exists()
        })
        .map(|task| Entry {
            id: task.id,
            pid: task.pid,
            command: task.command,
            description: task.description,
            working_directory: task.working_directory,
            project_root: task.project_root,
            log_path: task.log_path,
            started_at: task.started_at,
            started_at_ms: task.started_at_ms,
            session_id: task.session_id,
            ended_at: Arc::new(Mutex::new(task.ended_at)),
            foreign: true,
        })
        .collect()
}

fn ended_at_of(entry: &Entry) -> Option<String> {
    entry
        .ended_at
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn mark_ended(entry: &Entry, ended_at: String) {
    let mut slot = entry
        .ended_at
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        *slot = Some(ended_at);
    }
}

fn snapshot(entries: &[Entry]) -> Vec<PersistedTask> {
    entries
        .iter()
        .map(|entry| PersistedTask {
            id: entry.id.clone(),
            pid: entry.pid,
            command: entry.command.clone(),
            description: entry.description.clone(),
            working_directory: entry.working_directory.clone(),
            project_root: entry.project_root.clone(),
            log_path: entry.log_path.clone(),
            started_at: entry.started_at.clone(),
            started_at_ms: entry.started_at_ms,
            ended_at: ended_at_of(entry),
            session_id: entry.session_id.clone(),
        })
        .collect()
}

/// 异步落盘：串行化写入，避免并发快照互相覆盖；失败静默（记录丢了不影响命令）。
fn persist_async(tasks: Vec<PersistedTask>) {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let lock = PERSIST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
            let _guard = lock.lock().await;
            let _ = tokio::task::spawn_blocking(move || write_store(&tasks)).await;
        });
    } else {
        let _ = write_store(&tasks);
    }
}

fn write_store(tasks: &[PersistedTask]) -> std::io::Result<()> {
    let Some(path) = store_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let store = PersistedStore {
        version: 1,
        tasks: tasks.to_vec(),
    };
    let payload = serde_json::to_vec_pretty(&store)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
    // 临时文件 + rename：进程崩溃也不会留下半截 JSON。
    let temp = path.with_file_name(format!("{STORE_FILE_NAME}.tmp"));
    std::fs::write(&temp, payload)?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

/// 登记一个刚启动的后台任务，返回任务 id（写回工具结果供 UI 定位）。
pub(crate) fn register(
    mut child: Child,
    pid: u32,
    command: String,
    description: String,
    working_directory: String,
    project_root: String,
    log_path: String,
    started_at: String,
    started_at_ms: i64,
    session_id: Option<String>,
) -> String {
    let id = Uuid::new_v4().to_string();
    let ended_at = Arc::new(Mutex::new(None::<String>));
    // 后台等待退出：进程结束瞬间记录退出时刻（不依赖 UI 轮询），顺带回收僵尸进程。
    let watcher_slot = Arc::clone(&ended_at);
    tokio::spawn(async move {
        let _ = child.wait().await;
        let stamp = chrono::Local::now().to_rfc3339();
        *watcher_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stamp);
        let snapshot = {
            let entries = registry();
            snapshot(entries.as_slice())
        };
        persist_async(snapshot);
    });
    let mut entries = registry();
    prune(&mut entries);
    entries.push(Entry {
        id: id.clone(),
        pid,
        command,
        description,
        working_directory,
        project_root,
        log_path,
        started_at,
        started_at_ms,
        session_id,
        ended_at,
        foreign: false,
    });
    let snapshot = snapshot(entries.as_slice());
    drop(entries);
    persist_async(snapshot);
    id
}

/// 列出全部后台任务：存活优先、同状态按启动时间倒序。
pub fn list() -> Vec<DetachedTask> {
    let mut entries = registry();
    let mut dirty = false;
    // 日志被删掉的记录直接消失，目录始终是真相。
    entries.retain(|entry| {
        if Path::new(&entry.log_path).exists() {
            return true;
        }
        dirty = true;
        false
    });
    // 恢复的条目需要按 pid + 创建时刻校验，失效即定格退出时刻。
    for entry in entries.iter() {
        if !entry.foreign || ended_at_of(entry).is_some() {
            continue;
        }
        if !foreign_alive(entry) {
            mark_ended(entry, estimate_ended_at(entry));
            dirty = true;
        }
    }
    let mut tasks: Vec<DetachedTask> = entries
        .iter()
        .map(|entry| {
            let ended_at = ended_at_of(entry);
            DetachedTask {
                id: entry.id.clone(),
                pid: entry.pid,
                command: entry.command.clone(),
                description: entry.description.clone(),
                working_directory: entry.working_directory.clone(),
                project_root: entry.project_root.clone(),
                log_path: entry.log_path.clone(),
                started_at: entry.started_at.clone(),
                alive: ended_at.is_none(),
                ended_at,
                session_id: entry.session_id.clone(),
            }
        })
        .collect();
    let snapshot = if dirty {
        Some(snapshot(entries.as_slice()))
    } else {
        None
    };
    drop(entries);
    if let Some(tasks) = snapshot {
        persist_async(tasks);
    }
    tasks.sort_by(|left, right| {
        right
            .alive
            .cmp(&left.alive)
            .then_with(|| right.started_at.cmp(&left.started_at))
    });
    tasks
}

/// 终止后台任务的整棵进程树。返回 false 表示进程已自行退出。
pub fn kill(id: &str) -> Result<bool, String> {
    let pid = {
        let entries = registry();
        let entry = entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "Background task not found".to_string())?;
        if ended_at_of(entry).is_some() {
            return Ok(false);
        }
        if entry.foreign && !foreign_alive(entry) {
            // 恢复的 pid 已被复用或进程已退出：定格后拒绝，绝不误杀。
            mark_ended(entry, estimate_ended_at(entry));
            let snapshot = snapshot(entries.as_slice());
            drop(entries);
            persist_async(snapshot);
            return Ok(false);
        }
        entry.pid
    };
    if pid == 0 {
        return Err("Background task has no process id".to_string());
    }
    crate::storage::kill_process_tree(pid).map_err(|error| error.to_string())?;
    Ok(true)
}

/// 移除记录并删除对应日志文件；仍在运行的记录不允许移除。
pub fn forget(id: &str) -> bool {
    let mut entries = registry();
    let Some(index) = entries.iter().position(|entry| entry.id == id) else {
        return false;
    };
    {
        let entry = &entries[index];
        if ended_at_of(entry).is_none() {
            if !entry.foreign || foreign_alive(entry) {
                return false;
            }
            mark_ended(entry, estimate_ended_at(entry));
        }
    }
    let log_path = entries[index].log_path.clone();
    entries.remove(index);
    let snapshot = snapshot(entries.as_slice());
    drop(entries);
    let _ = std::fs::remove_file(&log_path);
    persist_async(snapshot);
    true
}

fn prune(entries: &mut Vec<Entry>) {
    if entries.len() < MAX_ENTRIES {
        return;
    }
    entries.retain(|entry| ended_at_of(entry).is_none());
    if entries.len() >= MAX_ENTRIES {
        entries.remove(0);
    }
}

/// 恢复条目的身份校验：pid 对应进程的创建时刻必须与登记时刻吻合。
fn foreign_alive(entry: &Entry) -> bool {
    if entry.started_at_ms <= 0 {
        return false;
    }
    match crate::storage::process_start_time_ms(entry.pid) {
        Some(started) => (started - entry.started_at_ms).abs() <= PROCESS_START_TOLERANCE_MS,
        None => false,
    }
}

/// 恢复条目退出时刻的估计：日志最后写入时间（进程停止输出即近于此），
/// 取不到则退回当前时间。
fn estimate_ended_at(entry: &Entry) -> String {
    std::fs::metadata(&entry.log_path)
        .and_then(|meta| meta.modified())
        .map(|time| chrono::DateTime::<chrono::Local>::from(time).to_rfc3339())
        .unwrap_or_else(|_| chrono::Local::now().to_rfc3339())
}
