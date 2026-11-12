//! 低优先级的「延迟 + 合并」Prettier 自动格式化调度器。
//!
//! 编辑工具写盘成功后只登记待格式化路径就立即返回，格式化改由后台任务执行：
//! 只有在「该文件已停止写入（静默窗口）且没有写工具在途」时才统一格式化一次。
//! 这样格式化永远不会插在同一批工具调用的两次编辑之间 —— 否则 Prettier 的全文
//! 重排会让后一次编辑的 searchContent 匹配不到，编辑被误判为“找不到内容”。
//!
//! 为保证模型看到的始终是磁盘最终态，观察点（filesystem-read）与应用退出前
//! 都会先把待格式化落盘（flush_path / flush_all）。
//!
//! 数据流：schedule / note_write_start 只登记（同步、极轻）→ worker_loop 等待
//! 静默窗口 → 取该文件写锁让位于编辑 → run_prettier 在 blocking pool 执行。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use super::file_lock;
use crate::storage::get_auto_format;

/// 同一文件自最后一次写入起的静默窗口。窗口之内不再动它：说明这一批工具
/// 调用还在写同一个文件，此时格式化会重排正文，让后一次编辑失配。
const EDIT_QUIET: Duration = Duration::from_millis(1200);

/// 定时器最小步长，避免密集轮询。
const MIN_TICK: Duration = Duration::from_millis(50);

/// Prettier 单次执行上限：超时即结束进程并放弃本次格式化，释放文件写锁。
const PRETTIER_TIMEOUT: Duration = Duration::from_secs(15);

/// 子进程退出状态轮询间隔。
const PRETTIER_POLL: Duration = Duration::from_millis(50);

/// 待格式化文件 -> 该文件最后一次写入时刻（在册即代表有待格式化的内容）。
static PENDING: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static NOTIFY: OnceLock<Notify> = OnceLock::new();
static WORKER_STARTED: OnceLock<()> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Instant>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_guard() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn notify() -> &'static Notify {
    NOTIFY.get_or_init(Notify::new)
}

/// worker 的等待决策。
enum Wait {
    /// 没有待格式化文件：挂起等待下一次登记。
    Idle,
    /// 有待格式化文件但都还没过静默窗口：睡这么久再看。
    Sleep(Duration),
    /// 已有文件可格式化。
    Ready,
}

/// 惰性启动后台 worker。首次写文件时调用一次（必须在 tokio 运行时上下文内），
/// 后续调用只做一次原子读。
pub(super) async fn ensure_worker() {
    if WORKER_STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(worker_loop());
}

/// 登记一个待格式化文件（编辑工具写盘成功后调用）。返回是否真的登记：
/// Prettier 不支持的文件类型不登记（调用方据此决定是否回报 formatPending）。
pub(super) fn schedule(file_path: &str) -> bool {
    if !is_prettier_supported_extension(Path::new(file_path)) {
        return false;
    }
    pending_guard().insert(file_path.to_string(), Instant::now());
    notify().notify_one();
    true
}

/// 写入开始时刷新静默窗口：让同一批编辑期间的格式化继续让位。
/// 只刷新已在册的文件，避免一次失败的写入把未改动过的文件也排进格式化。
pub(super) fn note_write_start(file_path: &str) {
    if !is_prettier_supported_extension(Path::new(file_path)) {
        return;
    }
    if let Some(last_write) = pending_guard().get_mut(file_path) {
        *last_write = Instant::now();
    }
}

/// 把该文件的待格式化立即落盘（观察点调用：读取前执行，保证读到最终态）。
pub(super) async fn flush_path(file_path: &str) {
    let should_format = pending_guard().remove(file_path).is_some();
    if should_format && auto_format_enabled().await {
        format_file(file_path).await;
    }
}

/// 把全部待格式化立即落盘（应用退出等收尾场景）。
pub(super) async fn flush_all() {
    let paths: Vec<String> = {
        let mut pending = pending_guard();
        let paths = pending.keys().cloned().collect();
        pending.clear();
        paths
    };
    if paths.is_empty() || !auto_format_enabled().await {
        return;
    }
    for file_path in paths {
        format_file(&file_path).await;
    }
}

/// 后台 worker：等待静默窗口 -> 取走可格式化的文件 -> 逐个格式化。
async fn worker_loop() {
    loop {
        match next_wait() {
            Wait::Idle => notify().notified().await,
            Wait::Sleep(duration) => tokio::time::sleep(duration).await,
            Wait::Ready => {
                let ready = take_ready();
                if ready.is_empty() {
                    continue;
                }
                if auto_format_enabled().await {
                    for file_path in ready {
                        format_file(&file_path).await;
                    }
                }
                // 用户已关闭自动格式化：直接丢弃这批登记，不再补做格式化。
            }
        }
    }
}

fn next_wait() -> Wait {
    let pending = pending_guard();
    if pending.is_empty() {
        return Wait::Idle;
    }
    let now = Instant::now();
    let mut earliest: Option<Duration> = None;
    for last_write in pending.values() {
        let ready_at = *last_write + EDIT_QUIET;
        if ready_at <= now {
            return Wait::Ready;
        }
        let delay = ready_at - now;
        earliest = Some(earliest.map_or(delay, |current| current.min(delay)));
    }
    Wait::Sleep(earliest.unwrap_or(MIN_TICK).max(MIN_TICK))
}

/// 取走所有已过静默窗口的文件；未过窗口的留在待格式化表里等下一轮。
fn take_ready() -> Vec<String> {
    let mut pending = pending_guard();
    let now = Instant::now();
    let ready: Vec<String> = pending
        .iter()
        .filter(|(_, last_write)| now.duration_since(**last_write) >= EDIT_QUIET)
        .map(|(file_path, _)| file_path.clone())
        .collect();
    for file_path in &ready {
        pending.remove(file_path);
    }
    ready
}

/// 对单个文件执行一次格式化。
async fn format_file(file_path: &str) {
    // 跟踪租约尽力而为：被长时间命令占用时不等（格式化本身由文件锁与写工具
    // 串行），避免读取观察点被自动格式化拖住。
    let tracking_lease = crate::mcp::tools::file_tracking::coordinate(
        &[file_path.to_string()],
        crate::mcp::tools::file_tracking::LeaseClass::Writer,
        crate::mcp::tools::file_tracking::WRITER_LEASE_WAIT,
    )
    .await;
    // 与编辑工具共用同一把文件锁：格式化永远排在正在进行的编辑之后，也不会
    // 和编辑的「读取 -> 计算 -> 写盘」交错。
    let write_lock = file_lock::file_write_lock(file_path);
    let _permit = write_lock.lock_owned().await;
    // 拿到锁后再复查在途写：有说明正有编辑在等这把锁，此时格式化会改掉它的
    // 匹配基线 —— 让位，重新登记后稍后再试。
    if file_lock::is_write_in_flight(file_path) {
        pending_guard().insert(file_path.to_string(), Instant::now());
        notify().notify_one();
        return;
    }
    let path = PathBuf::from(file_path);
    let recorded_path = file_path.to_string();
    // Prettier 子进程是同步阻塞调用，放进 blocking pool，避免占用承载
    // Electron N-API Promise 的异步线程；改写发生时补记检查点 expected。
    let _ = tokio::task::spawn_blocking(move || {
        let _tracking_lease = tracking_lease;
        let write_permit = _permit;
        let Some(previous_object_id) = run_prettier(&path) else {
            return;
        };
        // No disk write remains. Release before entering checkpoint locking:
        // a file-tool checkpoint reader may already be waiting for this lease.
        drop(write_permit);
        drop(_tracking_lease);
        if let Err(error) = crate::storage::services::checkpoint::record_formatted_file(
            &recorded_path,
            &previous_object_id,
        ) {
            eprintln!("[checkpoint] failed to record formatted file '{recorded_path}': {error}");
        }
    })
    .await;
}

/// 等待子进程退出：超时则强制结束并回收，返回 None；否则返回是否成功。
fn wait_child_with_timeout(child: &mut std::process::Child, timeout: Duration) -> Option<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(PRETTIER_POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// 自动格式化全局开关（默认开启）；读取失败按开启处理。
pub(super) async fn auto_format_enabled() -> bool {
    tokio::task::spawn_blocking(get_auto_format)
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(true)
}

/// Prettier 3 内置支持（无需额外插件）的文件扩展名。
fn is_prettier_supported_extension(file_path: &Path) -> bool {
    let Some(extension) = file_path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "js" | "jsx"
            | "mjs"
            | "cjs"
            | "ts"
            | "tsx"
            | "mts"
            | "cts"
            | "json"
            | "jsonc"
            | "css"
            | "scss"
            | "less"
            | "html"
            | "md"
            | "markdown"
            | "yaml"
            | "yml"
            | "graphql"
            | "gql"
    )
}

/// 从被编辑文件所在目录向上逐级查找 node_modules/prettier/bin/prettier.cjs。
/// 找到后用 `node <该入口> --write <file>` 调用，不依赖 shell 与 PATH 上的
/// npx。目标项目未安装 prettier 时返回 None（调用方静默跳过格式化）。
fn find_prettier_bin(file_path: &Path) -> Option<PathBuf> {
    let mut dir = file_path.parent()?.to_path_buf();
    loop {
        let candidate = dir
            .join("node_modules")
            .join("prettier")
            .join("bin")
            .join("prettier.cjs");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// 对文件执行一次 Prettier 格式化，返回被改写前内容的对象 id（BLAKE3）。
///
/// 返回 None 表示未执行、执行失败、超时或输出与原文一致（Prettier 不写盘），
/// 调用方据此决定是否补记检查点 expected。任何一步失败都静默跳过，不影响已经
/// 写盘的编辑结果；非 UTF-8（GBK / UTF-16 等）文件会被 Prettier 按 UTF-8
/// 重写而损坏，因此直接跳过。
fn run_prettier(file_path: &Path) -> Option<String> {
    let before = fs::read(file_path).ok()?;
    if std::str::from_utf8(&before).is_err() {
        return None;
    }
    let prettier_bin = find_prettier_bin(file_path)?;

    let mut command = std::process::Command::new("node");
    command
        .arg(&prettier_bin)
        .arg("--write")
        .arg(file_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：避免格式化时控制台窗口一闪而过。
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().ok()?;
    if !wait_child_with_timeout(&mut child, PRETTIER_TIMEOUT)? {
        return None;
    }
    let after = fs::read(file_path).ok()?;
    if before == after {
        return None;
    }
    Some(
        blake3::Hasher::new()
            .update(&before)
            .finalize()
            .to_hex()
            .to_string(),
    )
}
