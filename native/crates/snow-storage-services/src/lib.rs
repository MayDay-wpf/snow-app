pub mod database;

// 兼容外观：模块内部沿用 `crate::utils::*` / `crate::api::*` / `crate::mcp::*` / `crate::storage::*`。
pub(crate) mod utils {
    pub mod panic_hook {
        pub use snow_support::panic_hook::*;
    }
    pub mod paths {
        pub use snow_support::paths::*;
    }
    pub mod process {
        pub use snow_process::process::*;
    }
}

pub(crate) mod api {
    pub mod oauth {
        pub use snow_ai::oauth::*;
    }
    pub mod conversation {
        pub mod images {
            pub use snow_storage::media::*;
        }
    }
}

pub(crate) mod mcp {
    pub mod external {
        pub use snow_tools::external::*;
    }
}

pub(crate) mod storage {
    pub use snow_storage_core::models::*;
    pub mod services {
        pub use crate::services::*;
    }
    pub mod database {
        pub use crate::database::*;
    }
    pub mod paths {
        pub use snow_support::app_paths::*;
    }
}

pub use snow_storage::migrations;
pub use snow_storage_core::models;
pub(crate) use snow_support::app_paths as paths;
pub mod services;

pub use snow_storage_core::models::*;

mod agents;
mod api_configs;
mod app_logs;
mod conversations;
mod custom_commands;
mod diff_review_comments;
mod file_review_annotations;
mod image_library;
mod mcp_lsp;
mod memos;
mod process_start_time;
mod process_sampling_log;
mod processes;
pub use snow_storage::project_memories_api as project_memories;
mod scheduled_tasks;
mod settings;
mod storage_locations;
mod system;
mod theme_assets;
mod usage;
mod workspace;
pub use process_start_time::*;
pub use process_sampling_log::*;
pub use processes::*;
pub use project_memories::*;
pub use scheduled_tasks::*;
pub use settings::*;
pub use storage_locations::*;
pub use system::*;
pub use theme_assets::*;
pub use usage::*;
pub use workspace::*;

pub use agents::*;
pub use api_configs::*;
pub use app_logs::*;
pub use conversations::*;
pub use custom_commands::*;
pub use diff_review_comments::*;
pub use file_review_annotations::*;
pub use image_library::*;
pub use mcp_lsp::*;
pub use memos::*;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, Once, OnceLock},
};

use napi::bindgen_prelude::*;

static INTERRUPT_MARK_INIT: Once = Once::new();
static MIGRATION_RECOVER_INIT: Once = Once::new();
static LSP_CONFIG_SEED_INIT: Once = Once::new();
static LSP_CONFIG_RECONCILE_INIT: Once = Once::new();
static LSP_CONFIG_NORMALIZE_INIT: Once = Once::new();
static OAUTH_HEADER_SCHEME_BIND_INIT: Once = Once::new();

pub fn initialize_app_storage() -> Result<AppStorageInfo> {
    crate::utils::panic_hook::install_panic_hook();
    let database_path = ensure_database_file()?;
    let storage_dir = paths::app_storage_dir()?;

    // Mark any embedding sessions that were still "running" or "paused" when
    // the app was last closed as "interrupted". This should only run ONCE per
    // process lifetime — at startup. Without this guard, every subsequent
    // call to initialize_app_storage() (which happens on every API call)
    // would mark genuinely-active sessions as "interrupted", causing the
    // frontend to show a false "interrupted" prompt when the user switches
    // projects and switches back. Errors here are non-fatal.
    INTERRUPT_MARK_INIT.call_once(|| {
        if let Err(error) =
            services::codebase_embed_sessions::mark_interrupted_sessions(&database_path)
        {
            eprintln!("Failed to mark interrupted codebase sessions: {error}");
        }
    });

    // Recover an image library migration that was interrupted by a crash:
    // roll back uncommitted copies or finish cleanup of a committed one.
    // Also recover interrupted checkpoint / upload directory migrations.
    MIGRATION_RECOVER_INIT.call_once(|| {
        if let Err(error) = services::image_library::recover_interrupted_migration() {
            eprintln!("Failed to recover interrupted image library migration: {error}");
        }
        if let Err(error) = services::storage_locations::recover_interrupted_migrations() {
            eprintln!("Failed to recover interrupted storage migrations: {error}");
        }
    });

    // Seed LSP server configs once per process: migrate the legacy
    // ~/.snow/lsp-config.json (config domain lives under ~/.snow, NOT the
    // app storage dir) into the lsp_server_configs table, then insert
    // platform-aware defaults. Both steps only run when the table is empty
    // and are idempotent; errors are non-fatal.
    LSP_CONFIG_SEED_INIT.call_once(|| {
        let snow_dir = dirs_next::home_dir().map(|home| home.join(".snow"));
        let db_path = database_path.clone();
        let Ok(true) = services::lsp_server_configs::is_empty(&db_path) else {
            return;
        };
        if let Some(snow) = snow_dir {
            if let Err(error) = services::lsp_server_configs::migrate_legacy_file(&db_path, &snow) {
                eprintln!("Failed to migrate legacy LSP configs: {error}");
            }
        }
        if let Err(error) = services::lsp_server_configs::seed_defaults(&db_path) {
            eprintln!("Failed to seed LSP server configs: {error}");
        }
    });

    // Seed install commands are plain string updates (no command probing) and
    // stay on the startup path. The enabled/installed reconcile probe is NOT
    // run at startup (LSP tools are off by default and probing spawns real
    // processes): it is deferred to
    // storage::reconcile_lsp_server_install_state_once(), which fires on the
    // first LSP probe (settings page).
    LSP_CONFIG_RECONCILE_INIT.call_once(|| {
        let db_path = database_path.clone();
        if let Err(error) = services::lsp_server_configs::reconcile_seed_install_commands(&db_path) {
            eprintln!("Failed to reconcile LSP seed install commands: {error}");
        }
    });

    // Normalize legacy sort_order values once per process: earlier legacy
    // migrations assigned sort_order in legacy-file alphabetical order,
    // making tailwindcss (which declares .tsx/.jsx/.html/.css) match before
    // typescript for .tsx files. Known langs are re-mapped to their seed
    // order; unknown langs follow after the seeds in their current relative
    // order. Idempotent; source=manual records are never touched. Errors are
    // non-fatal.
    LSP_CONFIG_NORMALIZE_INIT.call_once(|| {
        let db_path = database_path.clone();
        if let Err(error) = services::lsp_server_configs::normalize_legacy_sort_orders(&db_path) {
            eprintln!("Failed to normalize LSP server sort orders: {error}");
        }
    });

    // Bind subscription (OAuth) profiles created before their identity headers
    // moved into custom header schemes. Runs once per database (guarded by a
    // system setting flag); errors are non-fatal.
    OAUTH_HEADER_SCHEME_BIND_INIT.call_once(|| {
        if let Err(error) =
            crate::api::oauth::header_schemes::bind_legacy_profiles_once(&database_path)
        {
            eprintln!("Failed to bind OAuth profiles to header schemes: {error}");
        }
    });

    Ok(AppStorageInfo {
        directory_path: storage_dir.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        archive_database_path: paths::archive_database_file_path(&storage_dir)
            .to_string_lossy()
            .into_owned(),
    })
}

/// Cached database path after the first successful initialization.
static DATABASE_PATH_CACHE: OnceLock<PathBuf> = OnceLock::new();

/// Serializes the first-time initialization so that even if multiple
/// `spawn_blocking` tasks call `ensure_database_file()` concurrently at
/// startup, only one thread actually performs schema creation and seeding.
/// All others block on this mutex, wake up, find the cache populated, and
/// return immediately.
static DATABASE_INIT_MUTEX: Mutex<()> = Mutex::new(());

/// Ensures the `.snowapp` storage directory and database schema exist.
///
/// Uses double-checked locking:
/// 1. **Fast path** (no lock): if the cache is already populated, return
///    immediately — this is the hot path for the 80+ API entry points.
/// 2. **Slow path** (mutex-guarded): acquire the mutex, then re-check the
///    cache. If still empty, perform the one-time initialization (create
///    directory, set WAL, create tables, seed defaults) and store the path.
///
/// This guarantees the heavy initialization runs **exactly once** per
/// process lifetime, regardless of how many threads race in.
pub fn ensure_database_file() -> Result<PathBuf> {
    // Fast path: cache hit — no lock, no I/O.
    if let Some(cached) = DATABASE_PATH_CACHE.get() {
        return Ok(cached.clone());
    }

    // Slow path: acquire the init mutex so only one thread initializes.
    let _guard = DATABASE_INIT_MUTEX
        .lock()
        .map_err(|_| Error::from_reason("Snow App database initialization mutex poisoned"))?;

    // Re-check after acquiring the lock — the thread that held the mutex
    // before us may have already populated the cache.
    if let Some(cached) = DATABASE_PATH_CACHE.get() {
        return Ok(cached.clone());
    }

    let storage_dir = ensure_storage_dir()?;
    // 上一次恢复可能已组装好数据库但还没替换：此刻进程尚未打开任何连接，
    // 是唯一能安全改名替换 `.snowapp/snowapp.db` 的时机。
    apply_pending_restore_once(&storage_dir);
    let database_path = paths::database_file_path(&storage_dir);
    database::ensure_database(&database_path)?;
    services::system_settings::seed_default_settings(&database_path)?;
    services::sub_agent_configs::seed_default_sub_agent_configs(&database_path)?;
    services::sensitive_command_configs::seed_default_sensitive_command_configs(&database_path)?;
    services::workspace_directories::seed_default_workspace_directory(&database_path)?;

    // Store into the cache so all future calls hit the fast path.
    let _ = DATABASE_PATH_CACHE.set(database_path.clone());
    Ok(database_path)
}

/// Cached archive database path after the first successful initialization.
static ARCHIVE_DATABASE_PATH_CACHE: OnceLock<PathBuf> = OnceLock::new();

/// Serializes the first-time initialization of the archive database
/// (double-checked locking, mirroring [ensure_database_file]).
static ARCHIVE_DATABASE_INIT_MUTEX: Mutex<()> = Mutex::new(());

/// Ensures the archive cold database (`.snowapp/archive.db`) exists with the
/// conversation archive schema. Used by archive/restore/list operations; the
/// archive database keeps archived conversations out of the runtime database
/// so the runtime database stays small without losing data.
pub fn ensure_archive_database_file() -> Result<PathBuf> {
    // Fast path: cache hit — no lock, no I/O.
    if let Some(cached) = ARCHIVE_DATABASE_PATH_CACHE.get() {
        return Ok(cached.clone());
    }

    // Slow path: acquire the init mutex so only one thread initializes.
    let _guard = ARCHIVE_DATABASE_INIT_MUTEX
        .lock()
        .map_err(|_| Error::from_reason("Snow App archive database init mutex poisoned"))?;

    // Re-check after acquiring the lock.
    if let Some(cached) = ARCHIVE_DATABASE_PATH_CACHE.get() {
        return Ok(cached.clone());
    }

    let storage_dir = ensure_storage_dir()?;
    // 归档库也可能在待恢复的数据库集合里；这里同样在打开连接前先完成替换。
    apply_pending_restore_once(&storage_dir);
    let archive_path = paths::archive_database_file_path(&storage_dir);
    services::archive::ensure_archive_database(&archive_path)?;

    // Store into the cache so all future calls hit the fast path.
    let _ = ARCHIVE_DATABASE_PATH_CACHE.set(archive_path.clone());
    Ok(archive_path)
}

/// 待应用的恢复只在本次进程第一次打开数据库前尝试一次：之后数据库连接
/// 已经建立，再改名替换既不安全也没有必要（失败时保留日志，下次启动重试）。
static PENDING_RESTORE_INIT: Once = Once::new();

fn apply_pending_restore_once(storage_dir: &Path) {
    PENDING_RESTORE_INIT.call_once(|| {
        if let Err(error) = services::backup::apply_pending_restore(storage_dir) {
            eprintln!("Failed to apply pending restore: {error}");
        }
    });
}

fn ensure_storage_dir() -> Result<PathBuf> {
    let storage_dir = paths::app_storage_dir()?;
    fs::create_dir_all(&storage_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create Snow App storage directory at '{}': {error}",
            storage_dir.display()
        ))
    })?;

    Ok(storage_dir)
}

pub fn get_storage_dir() -> Result<PathBuf> {
    let database_path = ensure_database_file()?;
    Ok(database_path)
}
