pub mod database;
mod migrations;
mod models;
mod paths;
pub mod services;

mod agents;
mod api_configs;
mod app_logs;
mod conversations;
mod image_library;
mod imports;
mod mcp_lsp;
mod memos;
mod plugins;
mod scheduled_tasks;
mod settings;
mod storage_locations;
mod system;
mod theme_assets;
mod usage;
mod workspace;

pub use models::*;

// 各领域 NAPI 入口重导出：crate 内部代码与既有 `crate::storage::xxx` 引用
// 依赖这里的扁平路径，拆分子模块后保持对外 API 不变。
pub use agents::*;
pub use api_configs::*;
pub use app_logs::*;
pub use conversations::*;
pub use image_library::*;
pub use imports::*;
pub use mcp_lsp::*;
pub use memos::*;
pub use plugins::*;
pub use scheduled_tasks::*;
pub use settings::*;
pub use storage_locations::*;
pub use system::*;
pub use theme_assets::*;
pub use usage::*;
pub use workspace::*;

use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, Once, OnceLock},
};

use napi::bindgen_prelude::*;

static INTERRUPT_MARK_INIT: Once = Once::new();
static MIGRATION_RECOVER_INIT: Once = Once::new();
static LSP_CONFIG_SEED_INIT: Once = Once::new();
static LSP_CONFIG_RECONCILE_INIT: Once = Once::new();
static LSP_CONFIG_NORMALIZE_INIT: Once = Once::new();

pub fn initialize_app_storage() -> Result<AppStorageInfo> {
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

    // Reconcile seed/legacy LSP configs against the real environment once
    // per process: records that are enabled but whose command is not found
    // on PATH are silently disabled (source=manual records are never
    // touched). Probe is side-effect free and idempotent, so this also
    // covers pre-existing databases seeded before §8.6 install probing.
    LSP_CONFIG_RECONCILE_INIT.call_once(|| {
        let db_path = database_path.clone();
        if let Err(error) = services::lsp_server_configs::reconcile_enabled_by_probe(&db_path) {
            eprintln!("Failed to reconcile LSP server install state: {error}");
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
    let archive_path = paths::archive_database_file_path(&storage_dir);
    services::archive::ensure_archive_database(&archive_path)?;

    // Store into the cache so all future calls hit the fast path.
    let _ = ARCHIVE_DATABASE_PATH_CACHE.set(archive_path.clone());
    Ok(archive_path)
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
