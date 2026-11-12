use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::Status;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

/// 回调：文件变更（防抖后）触发，参数为被监听的文件路径。
pub type FileChangeCallback =
    ThreadsafeFunction<String, napi::Unknown<'static>, String, Status, false>;

/// 默认防抖窗口：编辑器一次保存常产生多个事件。
const DEBOUNCE_MS_DEFAULT: u64 = 250;
/// 防抖线程轮询间隔。
const POLL_INTERVAL_MS: u64 = 80;

struct DebounceState {
    last_event: Option<Instant>,
    fired: bool,
    stopped: bool,
}

struct WatchState {
    _watcher: Box<dyn notify::Watcher + Send>,
    _thread: std::thread::JoinHandle<()>,
    state: Arc<Mutex<DebounceState>>,
}

static WATCHERS: OnceLock<Mutex<HashMap<String, WatchState>>> = OnceLock::new();

fn watchers() -> &'static Mutex<HashMap<String, WatchState>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_error<E: std::fmt::Display>(e: E) -> napi::Error {
    napi::Error::from_reason(format!("Lock error: {e}"))
}

/// 监听单个本地文件（监听父目录、非递归，可捕获"写临时文件 + 改名"的原子保存）。
///
/// 事件在防抖窗口静默后才回调一次；notify 与防抖线程均不阻塞 Node.js 主线程。
pub fn start_file_watch(
    file_path: String,
    debounce_ms: f64,
    on_change: FileChangeCallback,
) -> napi::Result<()> {
    use notify::Watcher;

    let debounce_ms = if debounce_ms.is_finite() && debounce_ms > 0.0 {
        debounce_ms as u64
    } else {
        DEBOUNCE_MS_DEFAULT
    };

    {
        let map = watchers().lock().map_err(lock_error)?;
        if map.contains_key(&file_path) {
            return Ok(());
        }
    }

    let target = PathBuf::from(&file_path);
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| napi::Error::from_reason(format!("File has no parent: {file_path}")))?
        .to_path_buf();
    let target_name = target.file_name().map(|name| name.to_os_string());
    let canonical_target = target.canonicalize().ok();
    let target_for_cb = target.clone();
    let dir_for_cb = dir.clone();

    let state = Arc::new(Mutex::new(DebounceState {
        last_event: None,
        fired: false,
        stopped: false,
    }));
    let state_for_cb = state.clone();

    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else {
                return;
            };
            let hit = event.paths.iter().any(|path| {
                if path == &target_for_cb {
                    return true;
                }
                if path.parent() == Some(dir_for_cb.as_path())
                    && path.file_name() == target_name.as_deref()
                {
                    return true;
                }
                // 符号链接/规范化路径差异（如 macOS /var 与 /private/var）兜底。
                match (&canonical_target, path.canonicalize().ok()) {
                    (Some(expected), Some(actual)) => &actual == expected,
                    _ => false,
                }
            });
            if !hit {
                return;
            }
            if let Ok(mut guard) = state_for_cb.lock() {
                guard.last_event = Some(Instant::now());
                guard.fired = false;
            }
        },
    )
    .map_err(|e| napi::Error::from_reason(format!("Failed to create file watcher: {e}")))?;

    watcher
        .watch(&dir, notify::RecursiveMode::NonRecursive)
        .map_err(|e| napi::Error::from_reason(format!("Failed to watch {file_path}: {e}")))?;

    let state_for_thread = state.clone();
    let path_for_thread = file_path.clone();
    let thread = std::thread::spawn(move || {
        let debounce = Duration::from_millis(debounce_ms);
        let poll = Duration::from_millis(POLL_INTERVAL_MS);
        loop {
            std::thread::sleep(poll);
            let fire = {
                let guard = match state_for_thread.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                if guard.stopped {
                    return;
                }
                match guard.last_event {
                    Some(last) => !guard.fired && last.elapsed() >= debounce,
                    None => false,
                }
            };
            if !fire {
                continue;
            }
            if let Ok(mut guard) = state_for_thread.lock() {
                guard.fired = true;
            }
            on_change.call(
                path_for_thread.clone(),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    });

    let mut map = watchers().lock().map_err(lock_error)?;
    map.insert(
        file_path,
        WatchState {
            _watcher: Box::new(watcher),
            _thread: thread,
            state,
        },
    );
    Ok(())
}

/// 停止监听文件。丢弃 watcher 并通知防抖线程退出。
pub fn stop_file_watch(file_path: String) -> napi::Result<()> {
    let mut map = watchers().lock().map_err(lock_error)?;
    if let Some(state) = map.remove(&file_path) {
        if let Ok(mut guard) = state.state.lock() {
            guard.stopped = true;
        }
    }
    Ok(())
}
