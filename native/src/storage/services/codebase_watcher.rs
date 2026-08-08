use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::Status;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use super::file_scanner::{
    get_extension, is_extensionless_text_file, is_likely_binary, BINARY_EXTENSIONS,
    IMAGE_EXTENSIONS, MAX_FILE_SIZE, SKIP_DIRS, TEXT_EXTENSIONS,
};
use super::gitignore::GitignoreMatcher;

/// Callback type: JS receives the project_id string when a debounced change
/// fires. The frontend uses this to refresh index stats / show a sync
/// indicator.
pub type CodebaseChangeCallback =
    ThreadsafeFunction<String, napi::Unknown<'static>, String, Status, false>;

/// Debounce window. File system events arrive in bursts (a single save can
/// produce Created + Modified + Renamed events). We wait this long after the
/// last event before notifying the frontend, so we only fire once per burst.
const DEBOUNCE_MS: u64 = 3000;

/// Poll interval for the debounce thread. The debounce thread wakes up every
/// `POLL_INTERVAL_MS` to check whether the debounce window has elapsed since
/// the last event. A shorter interval means faster notification but more
/// thread wakeups; 500ms is a good balance.
const POLL_INTERVAL_MS: u64 = 500;

/// Noise filter for paths that should never trigger a codebase refresh.
/// Mirrors the logic in `file_scanner.rs` so the watcher only fires for files
/// that would actually be embedded.
fn is_noise_path(path: &Path, root: &Path) -> bool {
    let relative = match path.strip_prefix(root) {
        Ok(rel) => rel,
        Err(_) => return true, // Outside the project root — ignore.
    };

    // Skip known binary/build directories at any depth.
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if SKIP_DIRS.contains(&name.as_ref()) {
            return true;
        }
    }

    // Skip hidden files/dirs starting with '.' (except .gitignore).
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if name.starts_with('.') && name != ".gitignore" {
            return true;
        }
    }

    // For files, apply the same extension / binary checks as the scanner.
    if path.is_file() {
        let ext = get_extension(path);
        if !TEXT_EXTENSIONS.contains(&ext.as_str())
            && !is_extensionless_text_file(&path.to_string_lossy())
        {
            return true;
        }
        if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            return true;
        }
        if BINARY_EXTENSIONS.contains(&ext.as_str()) {
            return true;
        }
    }

    false
}

/// Check whether a path is eligible for embedding using the same rules as
/// `file_scanner::scan_project`. This is used to filter watch events so we
/// only notify the frontend when a *relevant* file changes.
fn is_relevant_file(path: &Path, root: &Path, matcher: &GitignoreMatcher) -> bool {
    if is_noise_path(path, root) {
        return false;
    }

    let relative = match path.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => return false,
    };

    // Check gitignore for the file.
    if matcher.is_ignored(&relative, false) {
        return false;
    }

    // Final size + binary content check.
    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.is_file() {
            if metadata.len() > MAX_FILE_SIZE {
                return false;
            }
            if is_likely_binary(path) {
                return false;
            }
        }
    }

    true
}

/// Shared debounce state for a single watcher.
struct DebounceState {
    /// Timestamp of the most recent file-system event, or `None` if no event
    /// has been seen since the last callback fire.
    last_event: Option<Instant>,
    /// Timestamp of the last callback fire. Used to avoid duplicate fires.
    last_fire: Option<Instant>,
    /// Set to true when the debounce thread should exit.
    stopped: bool,
}

struct WatcherHandle {
    /// The notify watcher. Dropping this stops watching.
    _watcher: Box<dyn notify::Watcher + Send>,
    /// Handle to the debounce polling thread.
    _debounce_thread: std::thread::JoinHandle<()>,
    /// Shared debounce state. The debounce thread reads from this; the notify
    /// callback writes to it.
    debounce_state: Arc<Mutex<DebounceState>>,
}

static WATCHERS: OnceLock<Mutex<HashMap<String, WatcherHandle>>> = OnceLock::new();

fn watchers() -> &'static Mutex<HashMap<String, WatcherHandle>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start watching a project directory for codebase-relevant file changes.
///
/// Events are filtered using the same rules as `file_scanner::scan_project`
/// (gitignore, extension whitelist, binary detection, size limit) and
/// debounced for 3 seconds. When a valid change is detected, the JS callback
/// is invoked with the project_id string.
///
/// This function is synchronous and returns immediately. The watcher runs on
/// its own background thread managed by the `notify` crate, and a separate
/// debounce thread polls for the debounce window. Neither blocks the Node.js
/// main thread.
#[napi(
    ts_args_type = "projectId: string, projectPath: string, onChange: (projectId: string) => void",
    ts_return_type = "void"
)]
pub fn start_codebase_watch(
    project_id: String,
    project_path: String,
    on_change: CodebaseChangeCallback,
) -> napi::Result<()> {
    use notify::Watcher;

    // Already watching this project — no-op.
    {
        let map = watchers()
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock error: {e}")))?;
        if map.contains_key(&project_id) {
            return Ok(());
        }
    }

    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(napi::Error::from_reason(format!(
            "Project path is not a directory: {project_path}"
        )));
    }

    // Build the gitignore matcher once at watch start. We don't re-read
    // .gitignore on every event (that would be too expensive); gitignore
    // changes take effect on the next watch restart.
    let matcher = Arc::new(GitignoreMatcher::from_project_root(&root));
    let root_for_closure = root.clone();

    // Shared debounce state.
    let debounce_state = Arc::new(Mutex::new(DebounceState {
        last_event: None,
        last_fire: None,
        stopped: false,
    }));

    let debounce_state_for_callback = debounce_state.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Check if any affected path is a relevant file (or a
                // non-noise directory).
                let should_fire = event.paths.iter().any(|p| {
                    if p.is_dir() {
                        !is_noise_path(p, &root_for_closure)
                    } else {
                        is_relevant_file(p, &root_for_closure, &matcher)
                    }
                });

                if !should_fire {
                    return;
                }

                // Record the event time. The debounce thread will fire the
                // callback after DEBOUNCE_MS elapses with no new events.
                if let Ok(mut guard) = debounce_state_for_callback.lock() {
                    guard.last_event = Some(Instant::now());
                }
            }
        })
        .map_err(|e| napi::Error::from_reason(format!("Failed to create codebase watcher: {e}")))?;

    // Watch the entire project recursively.
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| napi::Error::from_reason(format!("Failed to watch {project_path}: {e}")))?;

    // Spawn the debounce polling thread. This thread wakes up every
    // POLL_INTERVAL_MS, checks whether the debounce window has elapsed since
    // the last event, and if so fires the callback. It exits when
    // `stopped` is set to true (by `stop_codebase_watch`).
    let debounce_state_for_thread = debounce_state.clone();
    let callback_for_thread = on_change;
    let project_id_for_thread = project_id.clone();
    let debounce_thread = std::thread::spawn(move || {
        let debounce_duration = Duration::from_millis(DEBOUNCE_MS);
        let poll_duration = Duration::from_millis(POLL_INTERVAL_MS);

        loop {
            std::thread::sleep(poll_duration);

            let should_fire = {
                let guard = debounce_state_for_thread.lock();
                match guard {
                    Ok(g) => {
                        if g.stopped {
                            return;
                        }
                        match g.last_event {
                            Some(last_event_time) => {
                                // Only fire if the debounce window has
                                // elapsed AND we haven't already fired for
                                // this event burst.
                                let elapsed = Instant::now().duration_since(last_event_time);
                                if elapsed >= debounce_duration {
                                    match g.last_fire {
                                        Some(last_fire_time) => last_fire_time < last_event_time,
                                        None => true,
                                    }
                                } else {
                                    false
                                }
                            }
                            None => false,
                        }
                    }
                    Err(_) => return, // Mutex poisoned — exit.
                }
            };

            if should_fire {
                // Update last_fire and release the lock before calling the
                // callback (which may be slow / cross-thread).
                {
                    if let Ok(mut guard) = debounce_state_for_thread.lock() {
                        if guard.stopped {
                            return;
                        }
                        guard.last_fire = Some(Instant::now());
                        guard.last_event = None;
                    } else {
                        return;
                    }
                }

                callback_for_thread.call(
                    project_id_for_thread.clone(),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        }
    });

    let handle = WatcherHandle {
        _watcher: Box::new(watcher),
        _debounce_thread: debounce_thread,
        debounce_state,
    };

    {
        let mut map = watchers()
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock error: {e}")))?;
        map.insert(project_id, handle);
    }

    Ok(())
}

/// Stop watching a project directory.
#[napi]
pub fn stop_codebase_watch(project_id: String) -> napi::Result<()> {
    let removed = {
        let mut map = watchers()
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock error: {e}")))?;
        map.remove(&project_id)
    };

    if let Some(handle) = removed {
        // Signal the debounce thread to stop.
        if let Ok(mut guard) = handle.debounce_state.lock() {
            guard.stopped = true;
        }
        // Dropping `handle` drops the watcher (stops watching) and the
        // JoinHandle (detaches the thread — it will exit on its next poll).
    }

    Ok(())
}

/// Stop all active codebase watchers. Called during app shutdown to ensure
/// no dangling watch threads remain.
#[allow(dead_code)]
pub fn stop_all_codebase_watches() {
    if let Some(map) = WATCHERS.get() {
        if let Ok(mut guard) = map.lock() {
            for (_, handle) in guard.drain() {
                if let Ok(mut state) = handle.debounce_state.lock() {
                    state.stopped = true;
                }
                // Dropping handle stops the watcher and detaches the thread.
                drop(handle);
            }
        }
    }
}
