use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use snow_support::app_paths as paths;
use snow_storage_core::system_settings;

const CHECKPOINT_DIR_SETTING_NAME: &str = "Checkpoint directory";
const CHECKPOINT_DIR_SETTING_CODE: &str = "checkpoint_dir";
const UPLOAD_DIR_SETTING_NAME: &str = "Upload directory";
const UPLOAD_DIR_SETTING_CODE: &str = "upload_dir";

const CHECKPOINT_DIR_NAME: &str = "checkpoints";
const UPLOAD_DIR_NAME: &str = "upload";
/// checkpoint 根目录下的纯临时目录（工具执行期间的快照），迁移时跳过。
pub const PENDING_DIR_NAME: &str = "pending";

const CHECKPOINT_MIGRATION_JOURNAL_FILE: &str = ".snow-checkpoint-migration.json";
const UPLOAD_MIGRATION_JOURNAL_FILE: &str = ".snow-upload-migration.json";

/// 可迁移的存储位置种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageLocationKind {
    Checkpoint,
    Upload,
}

impl StorageLocationKind {
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim() {
            "checkpoint" => Ok(Self::Checkpoint),
            "upload" => Ok(Self::Upload),
            _ => Err(Error::from_reason(format!(
                "Unknown storage location kind: {value}"
            ))),
        }
    }

    fn default_root(&self) -> Result<PathBuf> {
        Ok(paths::app_storage_dir()?.join(self.default_dir_name()))
    }

    fn default_dir_name(&self) -> &'static str {
        match self {
            Self::Checkpoint => CHECKPOINT_DIR_NAME,
            Self::Upload => UPLOAD_DIR_NAME,
        }
    }

    fn dir_setting_name(&self) -> &'static str {
        match self {
            Self::Checkpoint => CHECKPOINT_DIR_SETTING_NAME,
            Self::Upload => UPLOAD_DIR_SETTING_NAME,
        }
    }

    fn dir_setting_code(&self) -> &'static str {
        match self {
            Self::Checkpoint => CHECKPOINT_DIR_SETTING_CODE,
            Self::Upload => UPLOAD_DIR_SETTING_CODE,
        }
    }

    fn migration_journal_file(&self) -> &'static str {
        match self {
            Self::Checkpoint => CHECKPOINT_MIGRATION_JOURNAL_FILE,
            Self::Upload => UPLOAD_MIGRATION_JOURNAL_FILE,
        }
    }

    /// 目录树扫描时跳过的子目录名（checkpoint 的 pending 为纯临时目录）。
    fn skip_dir_name(&self, name: &str) -> bool {
        matches!(self, Self::Checkpoint if name == PENDING_DIR_NAME)
    }
}

/// 读取自定义保存目录。返回空字符串表示未设置（使用默认目录）。
pub fn get_custom_dir(database_path: &Path, kind: &StorageLocationKind) -> Result<String> {
    let Some(value) =
        system_settings::get_system_setting_value(database_path, kind.dir_setting_code())?
    else {
        return Ok(String::new());
    };
    Ok(value.trim().to_string())
}

/// 设置自定义保存目录。传入空字符串可重置为默认目录。
pub fn set_custom_dir(database_path: &Path, kind: &StorageLocationKind, dir: &str) -> Result<()> {
    system_settings::set_system_setting(
        database_path,
        kind.dir_setting_name(),
        kind.dir_setting_code(),
        dir.trim(),
    )?;
    if *kind == StorageLocationKind::Checkpoint {
        // 检查点模块按绝对路径缓存对象与目录解析结果，根目录切换后立即失效，
        // 否则迁移提交后仍会解析到旧根目录（已被清理）。
        super::checkpoint::clear_path_caches();
    }
    Ok(())
}

/// 存储位置根目录：优先读取用户自定义路径（system_settings 中保存），
/// 未设置或路径不可用时回退到默认目录。跨平台一致（macOS / Windows /
/// Linux 均解析到用户主目录下的 `.snowapp`）。
pub fn root(database_path: &Path, kind: &StorageLocationKind) -> Result<PathBuf> {
    let custom_dir = get_custom_dir(database_path, kind)?;
    if !custom_dir.is_empty() {
        let candidate = PathBuf::from(&custom_dir);
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
        // 自定义路径不可用，回退默认
    }
    let default_root = kind.default_root()?;
    fs::create_dir_all(&default_root).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create {} directory at '{}': {error}",
            kind.dir_setting_name(),
            default_root.display()
        ))
    })?;
    Ok(default_root)
}

/// 检查点根目录（便捷入口，与 `image_library_root` 同样的调用约定）。
pub fn checkpoint_root() -> Result<PathBuf> {
    let database_path = paths::database_file_path(&paths::app_storage_dir()?);
    root(&database_path, &StorageLocationKind::Checkpoint)
}

/// 上传图片目录根目录（便捷入口）。
pub fn upload_root() -> Result<PathBuf> {
    let database_path = paths::database_file_path(&paths::app_storage_dir()?);
    root(&database_path, &StorageLocationKind::Upload)
}

// ============================================================================
// 存储目录迁移（更换保存目录时把现有内容复制到新根目录，支持取消与崩溃恢复）
//
// 流程：prepare 写入迁移日志（存放于应用数据目录，独立于存储根目录，
// 保证任何情况下可发现）→ chunk 逐批复制并更新日志 → commit 写入新目录
// 设置（提交点）并清理旧目录文件。用户取消或复制出错时调用 rollback 删除
// 新目录中的副本；进程中途被杀时，下次启动由 recover_interrupted_migrations
// 自动回滚（未提交）或完成清理（已提交）。checkpoint 与 upload 使用各自
// 独立的日志文件，互不干扰。
// ============================================================================

/// 迁移日志：prepare 时写入，chunk 逐文件更新 copied，commit 成功后删除。
#[derive(Debug, Serialize, Deserialize)]
struct MigrationJournal {
    version: u32,
    old_root: String,
    new_root: String,
    /// commit 时写入 system_settings 的值（"" 表示重置为默认目录）
    setting_value: String,
    /// 计划迁移的相对路径（前斜杠分隔）
    files: Vec<String>,
    /// 已完成复制的相对路径
    copied: Vec<String>,
}

fn migration_journal_path(kind: &StorageLocationKind) -> Result<PathBuf> {
    Ok(paths::app_storage_dir()?.join(kind.migration_journal_file()))
}

fn load_migration_journal(kind: &StorageLocationKind) -> Result<Option<MigrationJournal>> {
    let path = migration_journal_path(kind)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read {} migration journal: {error}",
            kind.dir_setting_name()
        ))
    })?;
    match serde_json::from_str(&content) {
        Ok(journal) => Ok(Some(journal)),
        Err(error) => {
            // 日志损坏无法安全回滚：移除并记录，避免阻塞后续迁移
            let _ = fs::remove_file(&path);
            eprintln!(
                "[storage-locations] discarded corrupt {} migration journal: {error}",
                kind.dir_setting_name()
            );
            Ok(None)
        }
    }
}

fn save_migration_journal(kind: &StorageLocationKind, journal: &MigrationJournal) -> Result<()> {
    let path = migration_journal_path(kind)?;
    let content = serde_json::to_string_pretty(journal).map_err(|error| {
        Error::from_reason(format!("Failed to serialize migration journal: {error}"))
    })?;
    fs::write(&path, content)
        .map_err(|error| Error::from_reason(format!("Failed to write migration journal: {error}")))
}

/// 规范化路径用于比较（目录存在时优先 canonicalize，处理大小写与分隔符差异）。
fn normalized_for_compare(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// 递归收集根目录下的全部文件（相对路径，前斜杠分隔），跳过临时子目录。
fn collect_files(root: &Path, kind: &StorageLocationKind) -> Result<Vec<String>> {
    let mut files = Vec::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| {
            Error::from_reason(format!(
                "Failed to scan storage directory '{}': {error}",
                directory.display()
            ))
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                Error::from_reason(format!("Failed to read storage entry: {error}"))
            })?;
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to resolve storage-relative path '{}': {error}",
                    path.display()
                ))
            })?;
            let file_type = entry.file_type().map_err(|error| {
                Error::from_reason(format!(
                    "Failed to inspect storage path '{}': {error}",
                    path.display()
                ))
            })?;
            if file_type.is_dir() {
                if kind.skip_dir_name(&entry.file_name().to_string_lossy()) {
                    continue;
                }
                directories.push(path);
            } else if file_type.is_file() {
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    files.sort();
    Ok(files)
}

/// 从旧根复制一个文件到新根；源文件缺失视为已处理（跳过）。
fn copy_storage_file(old_root: &Path, new_root: &Path, relative_path: &str) -> std::io::Result<()> {
    let source = old_root.join(relative_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
    if !source.exists() {
        return Ok(());
    }
    let target = new_root.join(relative_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&source, &target)?;
    Ok(())
}

/// 删除根目录下的文件（相对路径来自迁移日志，二次校验防越界），失败不阻断。
fn remove_storage_file(root: &Path, relative_path: &str) {
    let file_path =
        root.join(relative_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
    if let Ok(canonical_root) = root.canonicalize() {
        if let Ok(canonical_file) = file_path.canonicalize() {
            if canonical_file.starts_with(&canonical_root) {
                let _ = fs::remove_file(&canonical_file);
            }
        }
    }
}

/// 删除根目录下的全部已迁移文件与空目录（commit 后清理旧根用）。
fn clear_root_files(root: &Path, kind: &StorageLocationKind) {
    for relative_path in collect_files(root, kind).unwrap_or_default() {
        remove_storage_file(root, &relative_path);
    }
    // 清理空目录（从最深开始）
    let mut directories: Vec<PathBuf> = collect_directories(root, kind);
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        let _ = fs::remove_dir(&directory);
    }
}

/// 收集根目录下的全部子目录（不含根自身），用于迁移后清理空目录。
fn collect_directories(root: &Path, kind: &StorageLocationKind) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if kind.skip_dir_name(&entry.file_name().to_string_lossy()) {
                continue;
            }
            directories.push(path.clone());
            stack.push(path);
        }
    }
    directories
}

/// 准备存储目录迁移：解析目标根目录、校验路径关系、列出旧根全部文件并写入
/// 迁移日志。返回待迁移文件数量；0 表示无需迁移（目标与当前相同或目录为空）。
pub fn prepare_migration(
    database_path: &Path,
    kind: &StorageLocationKind,
    target_dir: &str,
) -> Result<usize> {
    let old_root = root(database_path, kind)?;
    let setting_value = target_dir.trim().to_string();
    let new_root = if setting_value.is_empty() {
        kind.default_root()?
    } else {
        PathBuf::from(&setting_value)
    };

    fs::create_dir_all(&new_root).map_err(|error| {
        Error::from_reason(format!(
            "目标{}目录不可用 '{}': {error}",
            kind.dir_setting_name(),
            new_root.display()
        ))
    })?;

    let old_norm = normalized_for_compare(&old_root);
    let new_norm = normalized_for_compare(&new_root);
    if old_norm == new_norm {
        return Ok(0); // 目标与当前相同，无需迁移
    }
    if new_norm.starts_with(&old_norm) {
        return Err(Error::from_reason(format!(
            "目标目录不能位于当前{}目录内部",
            kind.dir_setting_name()
        )));
    }

    let files = collect_files(&old_root, kind)?;
    if files.is_empty() {
        return Ok(0);
    }

    save_migration_journal(
        kind,
        &MigrationJournal {
            version: 1,
            old_root: old_root.to_string_lossy().into_owned(),
            new_root: new_root.to_string_lossy().into_owned(),
            setting_value,
            copied: Vec::new(),
            files: files.clone(),
        },
    )?;
    eprintln!(
        "[storage-locations] {} migration prepared: {} -> {} ({} file(s))",
        kind.dir_setting_name(),
        old_root.display(),
        new_root.display(),
        files.len()
    );
    Ok(files.len())
}

/// 复制下一批文件（最多 chunk_size 个），逐文件更新迁移日志。
/// 返回 (已完成数, 总数, 是否完成)。
pub fn migrate_chunk(
    kind: &StorageLocationKind,
    chunk_size: usize,
) -> Result<(usize, usize, bool)> {
    let Some(mut journal) = load_migration_journal(kind)? else {
        return Err(Error::from_reason(format!(
            "没有进行中的{}迁移",
            kind.dir_setting_name()
        )));
    };
    let old_root = PathBuf::from(&journal.old_root);
    let new_root = PathBuf::from(&journal.new_root);

    let mut batch = 0usize;
    for relative_path in &journal.files {
        if batch >= chunk_size {
            break;
        }
        if journal.copied.contains(relative_path) {
            continue;
        }
        copy_storage_file(&old_root, &new_root, relative_path).map_err(|error| {
            Error::from_reason(format!("迁移文件失败 '{relative_path}': {error}"))
        })?;
        journal.copied.push(relative_path.clone());
        save_migration_journal(kind, &journal)?;
        batch += 1;
    }

    let total = journal.files.len();
    let copied = journal.copied.len();
    Ok((copied, total, copied >= total))
}

/// 提交迁移：写入新目录设置（提交点）→ 删除日志 → 清理旧根目录文件。
/// 迁移期间新生成的文件在此兜底补迁，避免索引指向新根却缺文件。
pub fn commit_migration(database_path: &Path, kind: &StorageLocationKind) -> Result<()> {
    let Some(mut journal) = load_migration_journal(kind)? else {
        return Err(Error::from_reason(format!(
            "没有进行中的{}迁移",
            kind.dir_setting_name()
        )));
    };
    let old_root = PathBuf::from(&journal.old_root);
    let new_root = PathBuf::from(&journal.new_root);

    // 兜底：迁移期间新增的文件一并复制（失败不阻断提交）
    let current_files = collect_files(&old_root, kind).unwrap_or_default();
    for relative_path in current_files {
        if !journal.files.contains(&relative_path) {
            if let Err(error) = copy_storage_file(&old_root, &new_root, &relative_path) {
                eprintln!("[storage-locations] catch-up copy failed '{relative_path}': {error}");
            }
            journal.files.push(relative_path);
        }
    }

    // 提交点：写入目录设置（此刻起存储根切换为新目录）
    set_custom_dir(database_path, kind, &journal.setting_value).map_err(|error| {
        Error::from_reason(format!(
            "Failed to save {} directory: {error}",
            kind.dir_setting_name()
        ))
    })?;

    let journal_path = migration_journal_path(kind)?;
    let _ = fs::remove_file(&journal_path);

    // 清理旧根目录文件（失败仅残留孤儿文件，不阻断提交）
    clear_root_files(&old_root, kind);

    eprintln!(
        "[storage-locations] {} migration committed: {} -> {} ({} file(s))",
        kind.dir_setting_name(),
        old_root.display(),
        new_root.display(),
        journal.files.len()
    );
    Ok(())
}

/// 回滚迁移：删除新根目录下已复制的文件并移除日志（幂等）。
/// 用户取消或迁移出错时调用；目录设置尚未写入，存储仍指向旧根目录。
pub fn rollback_migration(kind: &StorageLocationKind) -> Result<()> {
    let Some(journal) = load_migration_journal(kind)? else {
        return Ok(()); // 无进行中的迁移
    };
    let new_root = PathBuf::from(&journal.new_root);
    for relative_path in &journal.copied {
        remove_storage_file(&new_root, relative_path);
    }
    // 清理新根下的空目录
    clear_root_files(&new_root, kind);
    let journal_path = migration_journal_path(kind)?;
    let _ = fs::remove_file(&journal_path);
    eprintln!(
        "[storage-locations] {} migration rolled back, removed {} copied file(s) from {}",
        kind.dir_setting_name(),
        journal.copied.len(),
        new_root.display()
    );
    Ok(())
}

fn recover_one_migration(kind: &StorageLocationKind) -> Result<()> {
    let Some(journal) = load_migration_journal(kind)? else {
        return Ok(());
    };
    let database_path = paths::database_file_path(&paths::app_storage_dir()?);
    let journal_root = PathBuf::from(&journal.new_root);
    let current_root = root(&database_path, kind)?;
    let committed = normalized_for_compare(&current_root) == normalized_for_compare(&journal_root);

    if committed {
        let old_root = PathBuf::from(&journal.old_root);
        clear_root_files(&old_root, kind);
        eprintln!(
            "[storage-locations] recovered committed {} migration, cleaned up {}",
            kind.dir_setting_name(),
            old_root.display()
        );
    } else {
        for relative_path in &journal.copied {
            remove_storage_file(&journal_root, relative_path);
        }
        clear_root_files(&journal_root, kind);
        eprintln!(
            "[storage-locations] recovered interrupted {} migration, rolled back {} copied file(s) from {}",
            kind.dir_setting_name(),
            journal.copied.len(),
            journal_root.display()
        );
    }

    let journal_path = migration_journal_path(kind)?;
    let _ = fs::remove_file(&journal_path);
    Ok(())
}

/// 启动时恢复中断的迁移（在 initialize_app_storage 中调用一次）：
/// checkpoint 与 upload 各自独立判定：
/// - 日志的 new_root 已是当前根目录 → 设置已提交，仅清理日志与旧根文件；
/// - 否则 → 迁移未提交，回滚删除新根目录中的副本。
pub fn recover_interrupted_migrations() -> Result<()> {
    recover_one_migration(&StorageLocationKind::Checkpoint)?;
    recover_one_migration(&StorageLocationKind::Upload)?;
    Ok(())
}
