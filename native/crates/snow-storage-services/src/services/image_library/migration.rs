use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use super::super::super::database;
use super::super::super::paths;
use super::super::system_settings;
use super::{image_library_root, library_file_path};

// ============================================================================
// 图库目录迁移（更换保存目录时把现有图片复制到新根目录，支持取消与崩溃恢复）
//
// 流程：prepare 写入迁移日志（存放于应用数据目录，独立于图库根目录，
// 保证任何情况下可发现）→ chunk 逐批复制并更新日志 → commit 写入新目录
// 设置（提交点）并清理旧文件。用户取消或复制出错时调用 rollback 删除新
// 目录中的副本；进程中途被杀时，下次启动由 recover_interrupted_migration
// 自动回滚（未提交）或完成清理（已提交）。
// ============================================================================

/// 迁移日志文件名
const MIGRATION_JOURNAL_FILE: &str = ".snow-image-migration.json";

/// 迁移日志：prepare 时写入，chunk 逐文件更新 copied，commit 成功后删除。
#[derive(Debug, Serialize, Deserialize)]
struct MigrationJournal {
    version: u32,
    old_root: String,
    new_root: String,
    /// commit 时写入 system_settings 的值（"" 表示重置为默认目录）
    setting_value: String,
    /// 计划迁移的图库相对路径（image/...）
    files: Vec<String>,
    /// 已完成复制的相对路径
    copied: Vec<String>,
}

fn migration_journal_path() -> Result<PathBuf> {
    Ok(paths::app_storage_dir()?.join(MIGRATION_JOURNAL_FILE))
}

fn load_migration_journal() -> Result<Option<MigrationJournal>> {
    let path = migration_journal_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        Error::from_reason(format!("Failed to read migration journal: {error}"))
    })?;
    match serde_json::from_str(&content) {
        Ok(journal) => Ok(Some(journal)),
        Err(error) => {
            // 日志损坏无法安全回滚：移除并记录，避免阻塞后续迁移
            let _ = fs::remove_file(&path);
            eprintln!("[image-library] discarded corrupt migration journal: {error}");
            Ok(None)
        }
    }
}

fn save_migration_journal(journal: &MigrationJournal) -> Result<()> {
    let path = migration_journal_path()?;
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

/// 校验并规范化图库相对路径（白名单：image/ 前缀 + 防穿越）。
fn validated_rel_path(relative_path: &str) -> Option<String> {
    let normalized = relative_path.trim().replace('\\', "/");
    if !normalized.starts_with("image/") || normalized.contains("..") {
        return None;
    }
    Some(normalized)
}

/// 从旧根复制一个图库文件到新根；源文件缺失视为已处理（跳过）。
fn copy_library_file(old_root: &Path, new_root: &Path, relative_path: &str) -> std::io::Result<()> {
    let source = library_file_path(old_root, relative_path);
    if !source.exists() {
        return Ok(());
    }
    let target = library_file_path(new_root, relative_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&source, &target)?;
    Ok(())
}

/// 删除指定根目录下的图库文件（白名单校验防越界），失败不阻断。
fn remove_library_file(root: &Path, relative_path: &str) {
    let file_path = library_file_path(root, relative_path);
    if let Ok(canonical_root) = root.canonicalize() {
        if let Ok(canonical_file) = file_path.canonicalize() {
            if canonical_file.starts_with(&canonical_root) {
                let _ = fs::remove_file(&canonical_file);
            }
        }
    }
}

/// 列出图库索引中的全部相对路径。
fn list_relative_paths(database_path: &Path) -> Result<Vec<String>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare("SELECT relative_path FROM image_library")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list image library paths", error))
}

/// 准备图库迁移：解析目标根目录、校验路径关系、按索引列出现有图片并写入迁移日志。
/// 返回待迁移图片数量；0 表示无需迁移（目标与当前相同或图库为空）。
pub fn prepare_migration(database_path: &Path, target_dir: &str) -> Result<usize> {
    let old_root = image_library_root()?;
    let setting_value = target_dir.trim().to_string();
    let new_root = if setting_value.is_empty() {
        paths::app_storage_dir()?.join("image")
    } else {
        PathBuf::from(&setting_value)
    };

    fs::create_dir_all(&new_root).map_err(|error| {
        Error::from_reason(format!(
            "目标图片目录不可用 '{}': {error}",
            new_root.display()
        ))
    })?;

    let old_norm = normalized_for_compare(&old_root);
    let new_norm = normalized_for_compare(&new_root);
    if old_norm == new_norm {
        return Ok(0); // 目标与当前相同，无需迁移
    }
    if new_norm.starts_with(&old_norm) {
        return Err(Error::from_reason(
            "目标目录不能位于当前图库目录内部".to_string(),
        ));
    }

    let files: Vec<String> = list_relative_paths(database_path)?
        .into_iter()
        .filter_map(|path| validated_rel_path(&path))
        .collect();
    if files.is_empty() {
        return Ok(0);
    }

    save_migration_journal(&MigrationJournal {
        version: 1,
        old_root: old_root.to_string_lossy().into_owned(),
        new_root: new_root.to_string_lossy().into_owned(),
        setting_value,
        copied: Vec::new(),
        files: files.clone(),
    })?;
    eprintln!(
        "[image-library] migration prepared: {} -> {} ({} file(s))",
        old_root.display(),
        new_root.display(),
        files.len()
    );
    Ok(files.len())
}

/// 复制下一批图库文件（最多 chunk_size 个），逐文件更新迁移日志。
/// 返回 (已完成数, 总数, 是否完成)。
pub fn migrate_chunk(chunk_size: usize) -> Result<(usize, usize, bool)> {
    let Some(mut journal) = load_migration_journal()? else {
        return Err(Error::from_reason("没有进行中的图片迁移".to_string()));
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
        copy_library_file(&old_root, &new_root, relative_path).map_err(|error| {
            Error::from_reason(format!("迁移图片失败 '{relative_path}': {error}"))
        })?;
        journal.copied.push(relative_path.clone());
        save_migration_journal(&journal)?;
        batch += 1;
    }

    let total = journal.files.len();
    let copied = journal.copied.len();
    Ok((copied, total, copied >= total))
}

/// 提交迁移：写入新目录设置（提交点）→ 删除日志 → 清理旧根目录文件。
/// 迁移期间新生成的图片在此兜底补迁，避免索引指向新根却缺文件。
pub fn commit_migration(database_path: &Path) -> Result<()> {
    let Some(mut journal) = load_migration_journal()? else {
        return Err(Error::from_reason("没有进行中的图片迁移".to_string()));
    };
    let old_root = PathBuf::from(&journal.old_root);
    let new_root = PathBuf::from(&journal.new_root);

    // 兜底：迁移期间新增的图片一并复制（失败不阻断提交）
    let current_paths = list_relative_paths(database_path).unwrap_or_default();
    for relative_path in current_paths {
        if let Some(rel) = validated_rel_path(&relative_path) {
            if !journal.files.contains(&rel) {
                if let Err(error) = copy_library_file(&old_root, &new_root, &rel) {
                    eprintln!("[image-library] catch-up copy failed '{rel}': {error}");
                }
                journal.files.push(rel);
            }
        }
    }

    // 提交点：写入目录设置（此刻起图库根切换为新目录）
    system_settings::set_image_library_dir(database_path, &journal.setting_value).map_err(
        |error| Error::from_reason(format!("Failed to save image library directory: {error}")),
    )?;

    let journal_path = migration_journal_path()?;
    let _ = fs::remove_file(&journal_path);

    // 清理旧根目录文件（失败仅残留孤儿文件，不阻断提交）
    for relative_path in &journal.files {
        remove_library_file(&old_root, relative_path);
    }

    eprintln!(
        "[image-library] migration committed: {} -> {} ({} file(s))",
        old_root.display(),
        new_root.display(),
        journal.files.len()
    );
    Ok(())
}

/// 回滚迁移：删除新根目录下已复制的文件并移除日志（幂等）。
/// 用户取消或迁移出错时调用；目录设置尚未写入，图库仍指向旧根目录。
pub fn rollback_migration() -> Result<()> {
    let Some(journal) = load_migration_journal()? else {
        return Ok(()); // 无进行中的迁移
    };
    let new_root = PathBuf::from(&journal.new_root);
    for relative_path in &journal.copied {
        remove_library_file(&new_root, relative_path);
    }
    let journal_path = migration_journal_path()?;
    let _ = fs::remove_file(&journal_path);
    eprintln!(
        "[image-library] migration rolled back, removed {} copied file(s) from {}",
        journal.copied.len(),
        new_root.display()
    );
    Ok(())
}

/// 启动时恢复中断的迁移（在 initialize_app_storage 中调用一次）：
/// - 日志的 new_root 已是当前根目录 → 设置已提交，仅清理日志与旧根文件；
/// - 否则 → 迁移未提交，回滚删除新根目录中的副本。
pub fn recover_interrupted_migration() -> Result<()> {
    let Some(journal) = load_migration_journal()? else {
        return Ok(());
    };
    let journal_root = PathBuf::from(&journal.new_root);
    let current_root = image_library_root()?;
    let committed = normalized_for_compare(&current_root) == normalized_for_compare(&journal_root);

    if committed {
        let old_root = PathBuf::from(&journal.old_root);
        for relative_path in &journal.files {
            remove_library_file(&old_root, relative_path);
        }
        eprintln!(
            "[image-library] recovered committed migration, cleaned up {}",
            old_root.display()
        );
    } else {
        for relative_path in &journal.copied {
            remove_library_file(&journal_root, relative_path);
        }
        eprintln!(
            "[image-library] recovered interrupted migration, rolled back {} copied file(s) from {}",
            journal.copied.len(),
            journal_root.display()
        );
    }

    let journal_path = migration_journal_path()?;
    let _ = fs::remove_file(&journal_path);
    Ok(())
}
