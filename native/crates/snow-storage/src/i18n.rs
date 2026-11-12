use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const LANGUAGE_SETTING_CODE: &str = "language";
const LOCALE_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppLocale {
    En,
    ZhCn,
    ZhTw,
}

static LOCALE_CACHE: OnceLock<Mutex<Option<(AppLocale, Instant)>>> = OnceLock::new();

#[derive(Clone, Copy)]
pub enum CheckpointText {
    UnknownToolScope,
    SkipOutsideWorkspace,
    MissingWorkDir,
    ScanStarted,
    ScanCompleted,
    BeforeFailed,
    BeforeTimeout,
    AfterStarted,
    AfterCompleted,
    AfterFailed,
    AfterTimeout,
    RemoteStoreUnavailable,
}

#[derive(Clone, Debug)]
pub enum CheckpointSkipReason {
    NotSshWorkingDir { dir: String },
    WorkingDirOutside { dir: String },
    WritesOutside,
}

impl AppLocale {
    pub fn checkpoint_text(&self, key: CheckpointText) -> &'static str {
        use CheckpointText::*;
        match (self, key) {
            (AppLocale::En, UnknownToolScope) => "[checkpoint] The impact scope of {0} cannot be determined; this invocation has no rollback protection",
            (AppLocale::ZhCn, UnknownToolScope) => "[checkpoint] {0} 的影响范围无法确定，本次调用无回滚保护",
            (AppLocale::ZhTw, UnknownToolScope) => "[checkpoint] {0} 的影響範圍無法確定，本次調用無回滾保護",

            (AppLocale::En, SkipOutsideWorkspace) => "[checkpoint] Skipping the pre-execution snapshot: {0}, this invocation has no rollback protection",
            (AppLocale::ZhCn, SkipOutsideWorkspace) => "[checkpoint] 跳过执行前快照：{0}，本次调用无回滚保护",
            (AppLocale::ZhTw, SkipOutsideWorkspace) => "[checkpoint] 跳過執行前快照：{0}，本次調用無回滾保護",

            (AppLocale::En, MissingWorkDir) => "[checkpoint] No working directory is available; skipping the pre-execution snapshot, this invocation has no rollback protection",
            (AppLocale::ZhCn, MissingWorkDir) => "[checkpoint] 缺少工作目录，跳过执行前快照，本次调用无回滚保护",
            (AppLocale::ZhTw, MissingWorkDir) => "[checkpoint] 缺少工作目錄，跳過執行前快照，本次調用無回滾保護",

            (AppLocale::En, ScanStarted) => "[checkpoint] Creating the remote pre-execution snapshot...",
            (AppLocale::ZhCn, ScanStarted) => "[checkpoint] 正在创建远程执行前快照...",
            (AppLocale::ZhTw, ScanStarted) => "[checkpoint] 正在建立遠端執行前快照...",

            (AppLocale::En, ScanCompleted) => "[checkpoint] Pre-execution snapshot completed ({0}ms)",
            (AppLocale::ZhCn, ScanCompleted) => "[checkpoint] 执行前快照完成（{0}ms）",
            (AppLocale::ZhTw, ScanCompleted) => "[checkpoint] 執行前快照完成（{0}ms）",

            (AppLocale::En, BeforeFailed) => "[checkpoint] Pre-execution snapshot failed: {0}, this invocation has no rollback protection",
            (AppLocale::ZhCn, BeforeFailed) => "[checkpoint] 执行前快照失败：{0}，本次调用无回滚保护",
            (AppLocale::ZhTw, BeforeFailed) => "[checkpoint] 執行前快照失敗：{0}，本次調用無回滾保護",

            (AppLocale::En, BeforeTimeout) => "[checkpoint] Remote scan timed out ({0}ms); the scan was aborted and the pre-execution snapshot was skipped, this invocation has no rollback protection",
            (AppLocale::ZhCn, BeforeTimeout) => "[checkpoint] 远程扫描超时（{0}ms），已中止扫描并跳过执行前快照，本次调用无回滚保护",
            (AppLocale::ZhTw, BeforeTimeout) => "[checkpoint] 遠端掃描逾時（{0}ms），已中止掃描並跳過執行前快照，本次調用無回滾保護",

            (AppLocale::En, AfterStarted) => "[checkpoint] Comparing post-execution changes...",
            (AppLocale::ZhCn, AfterStarted) => "[checkpoint] 正在比较执行后变更...",
            (AppLocale::ZhTw, AfterStarted) => "[checkpoint] 正在比對執行後變更...",

            (AppLocale::En, AfterCompleted) => "[checkpoint] Post-execution changes recorded ({0}ms)",
            (AppLocale::ZhCn, AfterCompleted) => "[checkpoint] 执行后变更已记录（{0}ms）",
            (AppLocale::ZhTw, AfterCompleted) => "[checkpoint] 執行後變更已記錄（{0}ms）",

            (AppLocale::En, AfterFailed) => "[checkpoint] Failed to record post-execution changes: {0}, rollback protection may be incomplete",
            (AppLocale::ZhCn, AfterFailed) => "[checkpoint] 执行后变更记录失败：{0}，回滚保护可能不完整",
            (AppLocale::ZhTw, AfterFailed) => "[checkpoint] 執行後變更記錄失敗：{0}，回滾保護可能不完整",

            (AppLocale::En, AfterTimeout) => "[checkpoint] Remote scan timed out ({0}ms); the scan was aborted, the post-execution snapshot is incomplete, rollback protection may be incomplete",
            (AppLocale::ZhCn, AfterTimeout) => "[checkpoint] 远程扫描超时（{0}ms），已中止扫描，执行后快照未完成，回滚保护可能不完整",
            (AppLocale::ZhTw, AfterTimeout) => "[checkpoint] 遠端掃描逾時（{0}ms），已中止掃描，執行後快照未完成，回滾保護可能不完整",

            (AppLocale::En, RemoteStoreUnavailable) => "[checkpoint] The remote host is missing tools required for SSH checkpoints ({0}); checkpoints are disabled for this host and this invocation has no rollback protection. Install them on the remote host (e.g. coreutils) to restore rollback protection",
            (AppLocale::ZhCn, RemoteStoreUnavailable) => "[checkpoint] 远程主机缺少 SSH 检查点所需的工具（{0}），已停用该主机的检查点，本次调用无回滚保护。请在远程主机上安装（如 coreutils）后即可恢复回滚保护",
            (AppLocale::ZhTw, RemoteStoreUnavailable) => "[checkpoint] 遠端主機缺少 SSH 檢查點所需的工具（{0}），已停用該主機的檢查點，本次調用無回滾保護。請在遠端主機上安裝（如 coreutils）後即可恢復回滾保護",
        }
    }

    pub fn checkpoint_skip_reason(&self, reason: &CheckpointSkipReason) -> String {
        match (self, reason) {
            (AppLocale::En, CheckpointSkipReason::NotSshWorkingDir { dir }) => {
                format!("the command working directory ({dir}) is not a path in the current SSH workspace")
            }
            (AppLocale::ZhCn, CheckpointSkipReason::NotSshWorkingDir { dir }) => {
                format!("命令工作目录（{dir}）不是当前 SSH 工作区路径")
            }
            (AppLocale::ZhTw, CheckpointSkipReason::NotSshWorkingDir { dir }) => {
                format!("命令工作目錄（{dir}）不是目前 SSH 工作區路徑")
            }
            (AppLocale::En, CheckpointSkipReason::WorkingDirOutside { dir }) => {
                format!("the command working directory ({dir}) is outside the current project workspace")
            }
            (AppLocale::ZhCn, CheckpointSkipReason::WorkingDirOutside { dir }) => {
                format!("命令工作目录（{dir}）在当前项目工作区之外")
            }
            (AppLocale::ZhTw, CheckpointSkipReason::WorkingDirOutside { dir }) => {
                format!("命令工作目錄（{dir}）在目前專案工作區之外")
            }
            (AppLocale::En, CheckpointSkipReason::WritesOutside) => {
                "the command performs write operations outside the project workspace".to_string()
            }
            (AppLocale::ZhCn, CheckpointSkipReason::WritesOutside) => {
                "命令在项目工作区之外执行写操作".to_string()
            }
            (AppLocale::ZhTw, CheckpointSkipReason::WritesOutside) => {
                "命令在專案工作區之外執行寫操作".to_string()
            }
        }
    }
}

pub fn fill(template: &str, args: &[&dyn std::fmt::Display]) -> String {
    let mut result = template.to_string();
    for (index, arg) in args.iter().enumerate() {
        result = result.replace(&format!("{{{index}}}"), &format!("{arg}"));
    }
    result
}

pub async fn app_locale() -> AppLocale {
    if let Some(locale) = cached_locale() {
        return locale;
    }
    let locale = tokio::task::spawn_blocking(read_language_setting)
        .await
        .ok()
        .flatten()
        .unwrap_or(AppLocale::En);
    store_cached_locale(locale);
    locale
}

pub fn app_locale_blocking() -> AppLocale {
    if let Some(locale) = cached_locale() {
        return locale;
    }
    let locale = read_language_setting().unwrap_or(AppLocale::En);
    store_cached_locale(locale);
    locale
}

fn cached_locale() -> Option<AppLocale> {
    let cache = LOCALE_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (locale, cached_at) = cache.as_ref()?;
    if cached_at.elapsed() > LOCALE_CACHE_TTL {
        return None;
    }
    Some(*locale)
}

fn store_cached_locale(locale: AppLocale) {
    let mut cache = LOCALE_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = Some((locale, Instant::now()));
}

fn read_language_setting() -> Option<AppLocale> {
    let database_path = snow_storage_core::bootstrap::ensure_database_file().ok()?;
    let value = snow_storage_core::system_settings::get_system_setting_value(
        &database_path,
        LANGUAGE_SETTING_CODE,
    )
    .ok()??;
    Some(normalize_locale(&value))
}

fn normalize_locale(value: &str) -> AppLocale {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.starts_with("zh-tw") || normalized.starts_with("zh-hant") {
        AppLocale::ZhTw
    } else if normalized.starts_with("zh-cn")
        || normalized.starts_with("zh-hans")
        || normalized == "zh"
    {
        AppLocale::ZhCn
    } else {
        AppLocale::En
    }
}
