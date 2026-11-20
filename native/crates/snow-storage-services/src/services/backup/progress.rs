//! 备份 / 恢复 / 删除任务的进度快照。
//!
//! 任务本身跑在 Rust 的 blocking 线程池里，渲染进程按固定间隔读取这里的
//! 快照来绘制进度条，因此进度上报不会阻塞 Electron 主进程。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::{Error, Result, Status};
use napi_derive::napi;

/// 取消备份时的错误原因（TS 侧 BACKUP_CANCELLED_REASON 与之一致）。
const CANCELLED_REASON: &str = "Backup cancelled";

/// 取消请求标志：任务在检查点读取，开始新任务时复位。
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

/// 传输速度的统计窗口：取最近这段时间内实际传输的字节计算平均速度。
const SPEED_WINDOW: Duration = Duration::from_secs(5);

/// 备份 / 恢复 / 删除任务的当前进度。
#[napi(object)]
#[derive(Clone)]
pub struct BackupTaskProgress {
    /// 是否有任务正在执行（false 表示空闲）。
    pub active: bool,
    /// 任务类型：create（备份）| restore（恢复）| delete（删除备份）；空闲时为空字符串。
    pub kind: String,
    /// 当前阶段：snapshot | collect | write | apply | remove | scan | reclaim | finalize | idle。
    pub phase: String,
    /// 已处理字节数。
    pub processed_bytes: i64,
    /// 待处理总字节数（0 表示尚未统计，或任务只按文件数计量，如删除时回收块）。
    pub total_bytes: i64,
    /// 已处理文件数（删除任务为已回收的块数）。
    pub processed_files: u32,
    /// 待处理文件总数（0 表示尚未统计；删除任务为待回收的块数）。
    pub total_files: u32,
    /// 最近一段时间内实际写入 / 读取备份目标的平均速度（字节每秒）。
    /// 复用已有块不产生传输，不计入。
    pub bytes_per_second: i64,
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
        bytes_per_second: 0,
    }
}

struct ProgressState {
    progress: BackupTaskProgress,
    /// 实际传输的累计字节数。
    transferred_bytes: i64,
    /// 传输采样点（时间, 累计字节），用于计算窗口内的平均速度。
    samples: VecDeque<(Instant, i64)>,
}

impl ProgressState {
    fn reset(&mut self, progress: BackupTaskProgress) {
        self.progress = progress;
        self.transferred_bytes = 0;
        self.samples.clear();
        self.samples.push_back((Instant::now(), 0));
    }

    /// 丢弃窗口之外的采样，但保留一个窗口前的采样作为基准：
    /// 单块传输耗时超过窗口时速度仍能算出来，而不是跌到 0。
    fn prune(&mut self, now: Instant) {
        while self.samples.len() >= 2
            && self
                .samples
                .get(1)
                .is_some_and(|(time, _)| now.duration_since(*time) > SPEED_WINDOW)
        {
            self.samples.pop_front();
        }
    }

    fn speed(&self, now: Instant) -> i64 {
        let Some((start, start_bytes)) = self.samples.front() else {
            return 0;
        };
        let elapsed = now.duration_since(*start).as_secs_f64();
        if elapsed <= 0.0 {
            return 0;
        }
        ((self.transferred_bytes - start_bytes).max(0) as f64 / elapsed) as i64
    }
}

fn state() -> &'static Mutex<ProgressState> {
    static STATE: OnceLock<Mutex<ProgressState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(ProgressState {
            progress: idle_progress(),
            transferred_bytes: 0,
            samples: VecDeque::new(),
        })
    })
}

fn update(change: impl FnOnce(&mut ProgressState)) {
    let mut current = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    change(&mut current);
}

/// 读取当前进度快照（纯内存读取，不做 IO）。
pub fn task_progress() -> BackupTaskProgress {
    let mut current = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut snapshot = current.progress.clone();
    if snapshot.active {
        let now = Instant::now();
        current.prune(now);
        snapshot.bytes_per_second = current.speed(now);
    }
    snapshot
}

/// 请求取消正在执行的备份或删除（恢复不可取消），返回是否已受理。
pub fn request_cancel() -> bool {
    let current = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if current.progress.active && matches!(current.progress.kind.as_str(), "create" | "delete") {
        CANCEL_REQUESTED.store(true, Ordering::Release);
        return true;
    }
    false
}

/// 错误是否由取消请求产生。
pub(crate) fn is_cancelled(error: &Error) -> bool {
    error.status == Status::Cancelled
}

/// 任务进度写入句柄；离开作用域自动把快照复位为空闲。
pub(crate) struct TaskProgress;

impl TaskProgress {
    pub(crate) fn begin(kind: &str, phase: &str) -> Self {
        update(|current| {
            CANCEL_REQUESTED.store(false, Ordering::Release);
            current.reset(BackupTaskProgress {
                active: true,
                kind: kind.to_string(),
                phase: phase.to_string(),
                ..idle_progress()
            });
        });
        Self
    }

    pub(crate) fn phase(&self, phase: &str) {
        update(|current| current.progress.phase = phase.to_string());
    }

    /// 取消检查点：已请求取消时返回 Cancelled 错误。
    pub(crate) fn ensure_not_cancelled(&self) -> Result<()> {
        if CANCEL_REQUESTED.load(Ordering::Acquire) {
            return Err(Error::new(Status::Cancelled, CANCELLED_REASON));
        }
        Ok(())
    }

    pub(crate) fn set_totals(&self, total_bytes: i64, total_files: u32) {
        update(|current| {
            current.progress.total_bytes = total_bytes.max(0);
            current.progress.total_files = total_files;
        });
    }

    /// 累加已完成的处理量：阶段切换不清零，进度保持单调。
    ///
    /// 字节按块累加（每写入 / 读取一块调用一次），文件数在整个文件完成后累加。
    pub(crate) fn advance(&self, bytes: i64, files: u32) {
        update(|current| {
            current.progress.processed_bytes =
                current.progress.processed_bytes.saturating_add(bytes.max(0));
            current.progress.processed_files =
                current.progress.processed_files.saturating_add(files);
        });
    }

    /// 记录一次实际写入 / 读取备份目标的字节数，用于计算传输速度。
    pub(crate) fn transferred(&self, bytes: i64) {
        update(|current| {
            let now = Instant::now();
            current.transferred_bytes = current.transferred_bytes.saturating_add(bytes.max(0));
            let total = current.transferred_bytes;
            current.samples.push_back((now, total));
            current.prune(now);
        });
    }
}

impl Drop for TaskProgress {
    fn drop(&mut self) {
        update(|current| {
            CANCEL_REQUESTED.store(false, Ordering::Release);
            current.progress.active = false;
            current.progress.kind.clear();
            current.progress.phase = "idle".to_string();
            current.progress.bytes_per_second = 0;
        });
    }
}
