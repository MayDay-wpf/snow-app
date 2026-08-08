use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::Status;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// Callback type: JS receives the repo_path string when a debounced change fires.
pub type GitChangeCallback =
    ThreadsafeFunction<String, napi::Unknown<'static>, String, Status, false>;

/// Noise patterns that should NOT trigger a git status refresh.
/// Matches VSCode's DotGitWatcher filtering logic.
fn is_noise(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.ends_with(".lock") {
        return true;
    }
    if normalized.contains("/node_modules/") {
        return true;
    }
    if normalized.contains("/dist/")
        || normalized.contains("/build/")
        || normalized.contains("/out/")
        || normalized.contains("/target/")
    {
        return true;
    }
    if normalized.contains("/.git/")
        && (normalized.contains("/logs/") || normalized.contains("/hooks/"))
    {
        return true;
    }
    false
}

struct WatchState {
    _watcher: Box<dyn notify::Watcher + Send>,
}

static WATCHERS: OnceLock<Mutex<HashMap<String, WatchState>>> = OnceLock::new();

fn watchers() -> &'static Mutex<HashMap<String, WatchState>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

const DEBOUNCE_MS: u64 = 300;

/// Start watching a git repository for file changes.
///
/// Uses the `notify` crate (ReadDirectoryChangesW on Windows, inotify on Linux, FSEvents on macOS).
/// Events are debounced (300ms) and filtered (excludes *.lock, node_modules, build output, .git/logs, .git/hooks).
/// When a valid change is detected, the JS callback is invoked with the repo_path string.
#[napi(
    ts_args_type = "repoPath: string, onChange: (repoPath: string) => void",
    ts_return_type = "void"
)]
pub fn start_git_watch(repo_path: String, on_change: GitChangeCallback) -> napi::Result<()> {
    use notify::Watcher;

    // Already watching this repo
    {
        let map = watchers()
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock error: {e}")))?;
        if map.contains_key(&repo_path) {
            return Ok(());
        }
    }

    let debounce_state = std::sync::Arc::new(Mutex::new(None::<Instant>));
    let repo_path_for_cb = repo_path.clone();

    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Check if any affected path is non-noise
                let should_fire = event.paths.iter().any(|p| !is_noise(&p.to_string_lossy()));

                if !should_fire {
                    return;
                }

                // Debounce: check if enough time has passed since last fire
                let now = Instant::now();
                if let Ok(mut last) = debounce_state.lock() {
                    let fire = match *last {
                        Some(t) => now.duration_since(t) > Duration::from_millis(DEBOUNCE_MS),
                        None => true,
                    };
                    if fire {
                        *last = Some(now);
                        on_change.call(
                            repo_path_for_cb.clone(),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                }
            }
        })
        .map_err(|e| napi::Error::from_reason(format!("Failed to create watcher: {e}")))?;

    // Watch the entire repo recursively
    watcher
        .watch(Path::new(&repo_path), notify::RecursiveMode::Recursive)
        .map_err(|e| napi::Error::from_reason(format!("Failed to watch {repo_path}: {e}")))?;

    let state = WatchState {
        _watcher: Box::new(watcher),
    };

    {
        let mut map = watchers()
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock error: {e}")))?;
        map.insert(repo_path, state);
    }

    Ok(())
}

/// Stop watching a git repository.
#[napi]
pub fn stop_git_watch(repo_path: String) -> napi::Result<()> {
    let mut map = watchers()
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {e}")))?;

    // Removing the WatchState drops the watcher, which stops watching
    map.remove(&repo_path);

    Ok(())
}
