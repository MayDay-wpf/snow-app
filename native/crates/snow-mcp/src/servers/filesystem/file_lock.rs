//! 写文件类工具的文件级互斥与「在途写」登记。
//!
//! 同一文件的写入全程持锁（读取 -> 计算 -> 写盘），保证并行或连续的编辑
//! 不会互相覆盖；「在途写」计数供延迟格式化调度器（见 format.rs）判断
//! 此刻格式化会不会改写某个编辑工具的匹配基线。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::Mutex as AsyncMutex;

type FileWriteLockMap = HashMap<String, Arc<AsyncMutex<()>>>;

static FILE_WRITE_LOCKS: OnceLock<Mutex<FileWriteLockMap>> = OnceLock::new();
static IN_FLIGHT_WRITES: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

fn write_locks() -> &'static Mutex<FileWriteLockMap> {
    FILE_WRITE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn in_flight_writes() -> &'static Mutex<HashMap<String, usize>> {
    IN_FLIGHT_WRITES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取该路径的写锁：同一文件的写操作全程串行，锁表按完整路径持有。
pub(super) fn file_write_lock(file_path: &str) -> Arc<AsyncMutex<()>> {
    let mut locks = write_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(file_path.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// 在途写登记：在取写锁之前创建，工具调用结束时自动释放。
/// 用 RAII 保证取消、报错等任何退出路径都不会漏掉计数递减。
pub(super) struct InFlightWrite {
    file_path: String,
}

impl InFlightWrite {
    pub(super) fn acquire(file_path: &str) -> Self {
        let mut writes = in_flight_writes()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *writes.entry(file_path.to_string()).or_insert(0) += 1;
        InFlightWrite {
            file_path: file_path.to_string(),
        }
    }
}

impl Drop for InFlightWrite {
    fn drop(&mut self) {
        let mut writes = in_flight_writes()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let remaining = match writes.get_mut(&self.file_path) {
            Some(count) => {
                *count = count.saturating_sub(1);
                *count
            }
            None => return,
        };
        if remaining == 0 {
            writes.remove(&self.file_path);
        }
    }
}

/// 该文件此刻是否有写工具在途（含正在等待写锁的调用）。
pub(super) fn is_write_in_flight(file_path: &str) -> bool {
    in_flight_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(file_path)
        .is_some_and(|count| *count > 0)
}
