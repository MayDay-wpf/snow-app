//! 备份 / 恢复任务的进度快照。
//!
//! 任务本身跑在 Rust 的 blocking 线程池里，渲染进程按固定间隔读取这里的
//! 快照来绘制进度条，因此进度上报不会阻塞 Electron 主进程。

use std::sync::{Mutex, OnceLock};

use napi_derive::napi;

/// 备份 / 恢复任务的当前进度。
#[napi(object)]
#[derive(Clone)]
pub struct BackupTaskProgress {
    /// 是否有任务正在执行（false 表示空闲）。
    pub active: bool,
    /// 任务类型：create（备份）| restore（恢复）；空闲时为空字符串。
    pub kind: String,
    /// 当前阶段：snapshot | collect | write | apply | finalize | idle。
    pub phase: String,
    /// 已处理字节数。
    pub processed_bytes: i64,
    /// 待处理总字节数（0 表示尚未统计，界面按不确定进度显示）。
    pub total_bytes: i64,
    /// 已处理文件数。
    pub processed_files: u32,
    /// 待处理文件总数（0 表示尚未统计）。
    pub total_files: u32,
}

fn idle_progress() -> BackupTaskProgress {
    BackupTaskProgress {
        active: false,
        kind: String::new(),
        phase: "idle".to_string(),
        processed_bytes: 0,
        total_bytes: 0,
        processed_files: 0,
        total_files: 0,
    }
}

fn state() -> &'static Mutex<BackupTaskProgress> {
    static STATE: OnceLock<Mutex<BackupTaskProgress>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(idle_progress()))
}

fn update(change: impl FnOnce(&mut BackupTaskProgress)) {
    let mut current = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    change(&mut current);
}

/// 读取当前进度快照（纯内存读取，不做 IO）。
pub fn task_progress() -> BackupTaskProgress {
    state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// 任务进度写入句柄；离开作用域自动把快照复位为空闲。
pub(crate) struct TaskProgress;

impl TaskProgress {
    pub(crate) fn begin(kind: &str, phase: &str) -> Self {
        update(|current| {
            *current = BackupTaskProgress {
                active: true,
                kind: kind.to_string(),
                phase: phase.to_string(),
                processed_bytes: 0,
                total_bytes: 0,
                processed_files: 0,
                total_files: 0,
            };
        });
        Self
    }

    pub(crate) fn phase(&self, phase: &str) {
        update(|current| current.phase = phase.to_string());
    }

    pub(crate) fn set_totals(&self, total_bytes: i64, total_files: u32) {
        update(|current| {
            current.total_bytes = total_bytes.max(0);
            current.total_files = total_files;
        });
    }

    /// 累加已完成的处理量：阶段切换不清零，进度保持单调。
    pub(crate) fn advance(&self, bytes: i64, files: u32) {
        update(|current| {
            current.processed_bytes = current.processed_bytes.saturating_add(bytes.max(0));
            current.processed_files = current.processed_files.saturating_add(files);
        });
    }
}

impl Drop for TaskProgress {
    fn drop(&mut self) {
        update(|current| {
            current.active = false;
            current.kind.clear();
            current.phase = "idle".to_string();
        });
    }
}
