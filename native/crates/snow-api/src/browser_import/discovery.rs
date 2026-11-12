//! 浏览器安装路径与配置文件发现。

use super::*;

pub(crate) fn home_dir() -> PathBuf {
    dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Candidate (id, display name, browser root dir).
pub(crate) fn chromium_roots() -> Vec<(String, String, PathBuf)> {
    let home = home_dir();
    let mut roots: Vec<(String, String, PathBuf)> = Vec::new();
    if cfg!(target_os = "macos") {
        let base = home.join("Library/Application Support");
        roots.push(("chrome".into(), "Google Chrome".into(), base.join("Google/Chrome")));
        roots.push(("edge".into(), "Microsoft Edge".into(), base.join("Microsoft Edge")));
        roots.push(("chromium".into(), "Chromium".into(), base.join("Chromium")));
    } else if cfg!(target_os = "windows") {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            roots.push(("chrome".into(), "Google Chrome".into(), base.join("Google/Chrome/User Data")));
            roots.push(("edge".into(), "Microsoft Edge".into(), base.join("Microsoft/Edge/User Data")));
            roots.push(("chromium".into(), "Chromium".into(), base.join("Chromium/User Data")));
        }
    } else {
        let base = home.join(".config");
        roots.push(("chrome".into(), "Google Chrome".into(), base.join("google-chrome")));
        roots.push(("edge".into(), "Microsoft Edge".into(), base.join("microsoft-edge")));
        roots.push(("chromium".into(), "Chromium".into(), base.join("chromium")));
    }
    roots
}

/// Chromium profile subdirectories ("Default" or "Profile N").
pub(crate) fn chromium_profiles(root: &Path) -> Vec<(String, PathBuf)> {
    let mut profiles: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "Default" || name.starts_with("Profile ") {
                profiles.push((name, path));
            }
        }
    }
    if profiles.is_empty() && root.join("Default").is_dir() {
        profiles.push(("Default".into(), root.join("Default")));
    }
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles
}

/// Firefox profile directories containing logins.json / cookies.sqlite /
/// places.sqlite.
pub(crate) fn firefox_profiles() -> Vec<(String, PathBuf)> {
    let home = home_dir();
    let roots: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![home.join("Library/Application Support/Firefox/Profiles")]
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(|dir| PathBuf::from(dir).join("Mozilla/Firefox/Profiles"))
            .into_iter()
            .collect()
    } else {
        vec![home.join(".mozilla/firefox")]
    };
    let mut profiles: Vec<(String, PathBuf)> = Vec::new();
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if path.join("logins.json").exists()
                    || path.join("cookies.sqlite").exists()
                    || path.join("places.sqlite").exists()
                {
                    profiles.push((entry.file_name().to_string_lossy().to_string(), path));
                }
            }
        }
    }
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles
}

/// 打开 SQLite 数据库（只读），返回 `(连接, 是否使用了 immutable 回退)`。
///
/// 浏览器运行期间其数据库（尤其是 Chrome 的 Login Data）可能持有
/// WAL 锁，常规只读连接打开成功但真实表查询会得到 SQLITE_BUSY。
/// 因此调用方必须对真实查询做"常规 → immutable"双尝试：
/// `immutable=1` URI 让 SQLite 跳过锁检查与 WAL 文件、直接读主库文件
/// （可能缺少未 checkpoint 的最新变更，由调用方在 note 中提示用户）。
///
/// 生成只读连接尝试序列（常规 → immutable 回退），供读取函数双尝试。
pub(crate) fn readonly_attempts(path: &Path) -> Vec<(Connection, bool)> {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut attempts = Vec::new();
    if let Ok(conn) = Connection::open_with_flags(path, flags) {
        let _ = conn.busy_timeout(std::time::Duration::from_millis(1500));
        attempts.push((conn, false));
    }
    // immutable=1 让 SQLite 跳过锁检查与 WAL、直接读主库文件（浏览器运行中可用）。
    // Windows 路径含反斜杠，URI 中必须转义（\ → \\），否则 SQLite 打不开文件。
    let display = path.display().to_string();
    let escaped = display.replace('\\', "\\\\");
    let uri = format!("file:{escaped}?mode=ro&immutable=1");
    if let Ok(conn) =
        Connection::open_with_flags(uri, flags | rusqlite::OpenFlags::SQLITE_OPEN_URI)
    {
        attempts.push((conn, true));
    }
    attempts
}

/// 对真实查询执行"常规 → immutable"双尝试，返回 (结果, 是否 immutable)。
pub(crate) fn query_with_retry<T>(
    path: &Path,
    query: impl Fn(&Connection) -> rusqlite::Result<T>,
) -> (Option<T>, bool) {
    for (conn, immutable) in readonly_attempts(path) {
        if let Ok(value) = query(&conn) {
            return (Some(value), immutable);
        }
    }
    (None, false)
}

/// Browser account username for Chromium profiles: the `account_info` array
/// in `Preferences` (email of the first signed-in account).
pub(crate) fn chromium_account_name(profile_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(profile_dir.join("Preferences")) else {
        return String::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return String::new();
    };
    let Some(accounts) = json.pointer("/account_info").and_then(Value::as_array) else {
        return String::new();
    };
    for account in accounts {
        if let Some(email) = account.get("email").and_then(Value::as_str) {
            if !email.trim().is_empty() {
                return email.trim().to_string();
            }
        }
    }
    String::new()
}

/// Browser account username for Firefox profiles: `services.sync.username`
/// in prefs.js.
pub(crate) fn firefox_account_name(profile_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(profile_dir.join("prefs.js")) else {
        return String::new();
    };
    for line in text.lines() {
        if !line.contains("services.sync.username") {
            continue;
        }
        // Format: user_pref("services.sync.username", "user@example.com");
        // 4th double-quoted segment is the value.
        let mut segments = line.split('"');
        segments.next(); // user_pref(
        segments.next(); // services.sync.username
        segments.next(); // ",
        if let Some(value) = segments.next() {
            if !value.trim().is_empty() {
                return value.trim().to_string();
            }
        }
    }
    String::new()
}
