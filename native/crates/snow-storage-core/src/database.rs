use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use napi::bindgen_prelude::*;
use rusqlite::Connection;

/// Bumped whenever the schema changes; written to `PRAGMA user_version` after
/// a successful `create_schema` so the app can detect stale databases.
/// 70: sensitive_command_feedback table (learned user decisions on sensitive commands).
/// 69: chat message origin, preserving unknown provenance for existing rows.
/// 68: system_prompt_snapshots table (per-conversation frozen ROLE.md rules and
/// API-configured system prompts; dropped on successful context compaction).
/// 67: embedding_models / reranking_models / decision_models tables (model registry
/// with per-model health columns; legacy system_settings JSON migrated in).
/// 66: backfill persisted sub-agent dispatch identity (tool-call interactionId /
/// legacyDispatch) so historical delegated turns can resolve rollback gates.
/// 65: team host is a member — backfill the host's own member record.
/// 64: team join approval — member tokens for silent reconnects, member
/// client ids for blocklisting and the per-team blocklist table.
/// 63: team collaboration tables (teams / team_projects / team_members /
/// team_records / team_media) — Git-independent team data plus WebSocket hub.
/// 62: refresh peer true-deletion guards when either exact endpoint is external.
/// 61: peer endpoint identities support independent hot/cold moves without local FKs.
/// 60: peer-message metadata/delivery state and rollback restoring phase.
/// 59: parent-event wake acknowledgement and retryable scoped rollback gates.
/// 58: durable sub-agent runs, idempotent requests, parent inbox and deletion guards.
/// 57: deleted_conversations tombstones (late run persistence must not recreate
/// deleted/archived conversations).
/// 56: durable image generation batches/tasks, scoped lifecycle and notification claims.
/// 55: existing application schema baseline.
/// 54: independent file_review_annotations table and scoped indexes.
/// 53: collection_members.linked column (per-member opt-out from the linked project group).
/// 52: project_collections.color column (linked project groups share a unified color dot).
/// 51: app_logs adds exact conversation_id correlation for AI-readable session diagnostics.
/// 50: combines userscripts.icon and persistent Git worktree bindings.
/// 49: userscripts.icon column (@icon / @iconURL metadata for the script list icon).
/// 48: diff_review_comments table (右侧面板 diff 行内评论).
/// 47: userscripts.target / view_json / surface_json / scope / sandbox columns
/// (client-side desktop UI userscripts via `@snow-target client`).
/// 46: chat_messages per-request token usage columns (rollback restores the
/// conversation token snapshot from the latest remaining assistant row).
/// 45: custom_commands table (global/project scoped user-defined slash commands).
/// 44: api_configs.sort_order column (user-ordered API profile list).
/// 42: workspace_directories path health columns + workspace_directory_relinks table.
/// 41: memory_prompt_snapshots table (per-conversation frozen Project Memory prompt section).
/// 40: project_memories.response_id column (rollback memory cleanup anchor).
/// 39: userscripts / userscript_values tables (userscript engine).
/// 37: workflow_node_sessions.flow_checkpoint_id column (flow-level file checkpoint).
/// 36: workflow_node_sessions.flow_id column (multi-flow isolation per parent).
/// 35: chat_conversations.workflow_mode column + workflow_node_sessions table.
/// 34: project_collections / collection_members tables (project collections).
/// 33: combines the upstream API config JSON migration with fork runtime/context migrations;
/// 32: api_configs canonical config_json migration plus conversation runtime config columns.
/// 31: main's scheduled-tasks pre-script migration (30) + PR #65's three
/// stream-interruption migrations (29 baseline + 4 total additions).
pub const CURRENT_SCHEMA_VERSION: i64 = 70;
const SNOWFLAKE_EPOCH_MS: u64 = 1_704_067_200_000;
const SNOWFLAKE_WORKER_ID_BITS: u64 = 10;
const SNOWFLAKE_SEQUENCE_BITS: u64 = 12;
const SNOWFLAKE_WORKER_ID_MASK: u64 = (1 << SNOWFLAKE_WORKER_ID_BITS) - 1;
const SNOWFLAKE_SEQUENCE_MASK: u64 = (1 << SNOWFLAKE_SEQUENCE_BITS) - 1;
const SNOWFLAKE_TIMESTAMP_SHIFT: u64 = SNOWFLAKE_WORKER_ID_BITS + SNOWFLAKE_SEQUENCE_BITS;

#[derive(Debug, Default)]
struct SnowflakeState {
    last_timestamp_ms: u64,
    sequence: u64,
}

static SNOWFLAKE_STATE: OnceLock<Mutex<SnowflakeState>> = OnceLock::new();

pub fn create_snowflake_id() -> String {
    let state_lock = SNOWFLAKE_STATE.get_or_init(|| Mutex::new(SnowflakeState::default()));
    let mut state = state_lock
        .lock()
        .expect("snowflake id generator mutex poisoned");
    let mut timestamp_ms = current_timestamp_ms().max(SNOWFLAKE_EPOCH_MS);

    if timestamp_ms < state.last_timestamp_ms {
        timestamp_ms = state.last_timestamp_ms;
    }

    if timestamp_ms == state.last_timestamp_ms {
        state.sequence = (state.sequence + 1) & SNOWFLAKE_SEQUENCE_MASK;
        if state.sequence == 0 {
            timestamp_ms = wait_next_millis(state.last_timestamp_ms);
        }
    } else {
        state.sequence = 0;
    }

    state.last_timestamp_ms = timestamp_ms;

    let worker_id = (std::process::id() as u64) & SNOWFLAKE_WORKER_ID_MASK;
    let snowflake_id = ((timestamp_ms - SNOWFLAKE_EPOCH_MS) << SNOWFLAKE_TIMESTAMP_SHIFT)
        | (worker_id << SNOWFLAKE_SEQUENCE_BITS)
        | state.sequence;

    format!("{snowflake_id:019}")
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(SNOWFLAKE_EPOCH_MS)
}

fn wait_next_millis(last_timestamp_ms: u64) -> u64 {
    loop {
        let timestamp_ms = current_timestamp_ms().max(SNOWFLAKE_EPOCH_MS);
        if timestamp_ms > last_timestamp_ms {
            return timestamp_ms;
        }
        std::hint::spin_loop();
    }
}

/// 连接池上限。SQLite 连接各自持有页缓存（数 MB），池过大会把空闲内存变成
/// 常驻占用；8 个连接足以覆盖 blocking 线程池上的并发热点路径。
const MAX_POOLED_CONNECTIONS: usize = 8;

struct PooledEntry {
    path: PathBuf,
    connection: Connection,
}

/// 进程内空闲连接池。`rusqlite::Connection` 不是 `Sync`，但实现了 `Send`，
/// 因此 `Mutex<Vec<PooledEntry>>` 可以安全地作为全局池：连接在任意 blocking
/// 线程被借出、归还，同一时刻只会被一个线程持有。
fn pool_entries() -> &'static Mutex<Vec<PooledEntry>> {
    static POOL: OnceLock<Mutex<Vec<PooledEntry>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(Vec::new()))
}

/// 关闭池中所有空闲连接。数据库文件即将被替换或删除时调用，避免连接持有
/// 文件句柄导致 Windows 上的 rename/remove 失败。
pub fn close_pooled_connections() {
    let mut entries = pool_entries()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.clear();
}

/// 从池中借出的 SQLite 连接。通过 `Deref`/`DerefMut` 暴露底层连接，现有
/// `let connection = open_connection(...)?; connection.execute(...)` 形式的
/// 调用点无需改动；Drop 时把连接还回池中（池满则直接关闭）。
pub struct PooledConnection {
    path: PathBuf,
    connection: Option<Connection>,
}

impl std::ops::Deref for PooledConnection {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.connection
            .as_ref()
            .expect("pooled database connection was already released")
    }
}

impl std::ops::DerefMut for PooledConnection {
    fn deref_mut(&mut self) -> &mut Connection {
        self.connection
            .as_mut()
            .expect("pooled database connection was already released")
    }
}

impl Drop for PooledConnection {
    fn drop(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        // 上一次使用若留下未结束的事务，先回滚再归还，避免污染下一次借用者。
        if !connection.is_autocommit() {
            let _ = connection.execute_batch("ROLLBACK;");
        }
        let mut entries = pool_entries()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if entries.len() < MAX_POOLED_CONNECTIONS {
            entries.push(PooledEntry {
                path: std::mem::take(&mut self.path),
                connection,
            });
        }
    }
}

/// Borrows a SQLite connection from the process-wide pool, opening a new one
/// (with foreign-key enforcement, WAL mode, and a busy timeout) only when no
/// idle connection for the same database file is available. The connection is
/// returned to the pool when the [`PooledConnection`] is dropped.
///
/// WAL (Write-Ahead Logging) allows readers and a writer to operate
/// simultaneously, eliminating most reader-writer contention. The busy
/// timeout (30 seconds) makes writers wait instead of failing immediately
/// when another writer holds the lock. Long waits happen entirely on the
/// Rust blocking thread pool, so the Electron main process is never blocked.
///
/// Every service function should call this instead of `Connection::open`
/// to ensure consistent concurrency behaviour across the codebase.
pub fn open_connection(database_path: impl AsRef<Path>) -> rusqlite::Result<PooledConnection> {
    let path = database_path.as_ref().to_path_buf();
    let reused = {
        let mut entries = pool_entries()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries
            .iter()
            .position(|entry| entry.path.as_path() == path.as_path())
            .map(|index| entries.swap_remove(index).connection)
    };
    if let Some(connection) = reused {
        return Ok(PooledConnection {
            path,
            connection: Some(connection),
        });
    }

    let connection = Connection::open(&path)?;
    // SQLite disables foreign keys for every new connection unless enabled
    // explicitly. Schema-level ON DELETE CASCADE clauses rely on this.
    connection.pragma_update(None, "foreign_keys", "ON")?;
    // busy_timeout MUST be set before any pragma that acquires a write lock
    // (e.g. journal_mode=WAL). Otherwise concurrent connections will get
    // "database is locked" immediately instead of waiting.
    connection.busy_timeout(Duration::from_secs(30))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(PooledConnection {
        path,
        connection: Some(connection),
    })
}

/// 全局写锁：串行化同进程内的所有 SQLite 写事务。
///
/// WAL 模式允许读与写并发，但同一时刻只允许**一个写者**。切换工作区时
/// 渲染进程会并发触发大量写操作（activate、会话保存、usage、日志等），
/// 多个 `spawn_blocking` 写任务同时争抢写锁时，等待方超过 busy_timeout
/// 就会报 "database is locked" 并冒泡到前端。写锁让同进程写操作严格
/// 排队，从根源上消除这类冲突；读操作不受影响（WAL 下读与写可并发）。
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// 在全局写锁内执行闭包，串行化同进程写操作。
pub fn with_write_lock<T>(operation: impl FnOnce() -> T) -> T {
    let guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let result = operation();
    drop(guard);
    result
}

/// 是否为 SQLite 写锁竞争错误（"database is locked" / "database table is locked"）。
fn is_lock_contention(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(ffi_error, _)
            if matches!(
                ffi_error.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

/// 对写操作执行忙等重试：当 busy_timeout 被耗尽（外部进程如杀毒/备份
/// 软件短暂持锁，或极端并发下锁等待超时）时，按递增间隔重试有限次数，
/// 避免 "database is locked" 直接冒泡到前端。操作全部运行在 Rust 的
/// blocking 线程池上，重试等待不会阻塞 Electron 主进程。
pub fn with_write_retry<T>(
    operation: impl Fn() -> rusqlite::Result<T>,
    context: &str,
) -> rusqlite::Result<T> {
    const MAX_ATTEMPTS: u32 = 4;
    const RETRY_DELAYS_MS: [u64; 3] = [250, 500, 1000];

    for attempt in 0..MAX_ATTEMPTS {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_lock_contention(&error) && attempt + 1 < MAX_ATTEMPTS => {
                eprintln!(
                    "Snow App database write contention ({context}), attempt {}/{}: {error}",
                    attempt + 1,
                    MAX_ATTEMPTS
                );
                std::thread::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt as usize]));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("with_write_retry: the loop always returns")
}
pub fn database_error(database_path: &Path, action: &str, error: rusqlite::Error) -> Error {
    Error::from_reason(format!(
        "PERSISTENCE_ERROR: Failed to {action} Snow App sqlite database at '{}': {error}",
        database_path.display()
    ))
}
