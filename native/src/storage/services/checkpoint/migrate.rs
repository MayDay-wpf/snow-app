//! 旧版检查点布局一次性整理：扁平检查点目录 → 按创建日期分片，
//! 扁平对象库 → 按内容 id 前两位分桶。
//!
//! 只做同盘 rename（不复制内容），可重复执行：只处理仍处于旧布局的条目，
//! 中断后下次启动继续；单条失败仅记录日志并保持原布局（读取逻辑同时
//! 兼容两种布局），不阻塞启动。

use std::fs;
use std::path::Path;

use napi::bindgen_prelude::*;

use super::paths::{checkpoint_date_dir, clear_checkpoint_dir_cache};
use super::{checkpoint_root, clear_object_path_cache, object_shard, OBJECT_DIR_NAME};

/// 整理旧布局，返回搬移的条目数（检查点目录 + 对象文件）。
pub fn migrate_checkpoint_layout() -> Result<u64> {
    let root = checkpoint_root()?;
    let mut moved = migrate_checkpoint_directories(&root);
    moved += migrate_objects(&root);
    if moved > 0 {
        // 迁移后缓存的旧路径已失效，必须清空。
        clear_checkpoint_dir_cache();
        clear_object_path_cache();
    }
    Ok(moved)
}

/// 日期分片目录名形如 `2026-09-09`（与 paths.rs 的识别规则一致）。
fn is_date_dir(name: &str) -> bool {
    name.len() == 10 && name.starts_with(|c: char| c.is_ascii_digit())
}

/// BLAKE3 内容 id：64 个十六进制字符。
fn is_object_id(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 把根目录下仍是扁平布局的检查点目录移动到日期分片目录。
fn migrate_checkpoint_directories(root: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == OBJECT_DIR_NAME || is_date_dir(&name) {
            continue;
        }
        // 无法从 id 解析时间的目录保持原样（解析逻辑同样按旧布局处理）。
        let Some(date) = checkpoint_date_dir(&name) else {
            continue;
        };
        let date_dir = root.join(&date);
        let target = date_dir.join(&name);
        if target.is_dir() {
            continue;
        }
        if fs::create_dir_all(&date_dir).is_err() {
            continue;
        }
        match fs::rename(entry.path(), &target) {
            Ok(()) => moved += 1,
            Err(error) => {
                // 另一实例已完成迁移时目标已存在，视为成功。
                if !target.is_dir() {
                    eprintln!(
                        "[checkpoint] failed to migrate checkpoint directory '{}': {error}",
                        name
                    );
                }
            }
        }
    }
    moved
}

/// 把对象库根下仍是扁平布局的对象文件移动到分片目录。
fn migrate_objects(root: &Path) -> u64 {
    let objects = root.join(OBJECT_DIR_NAME);
    let Ok(entries) = fs::read_dir(&objects) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 分片目录跳过；`*.tmp` 等崩溃残留文件保持原样不动。
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_object_id(&name) {
            continue;
        }
        let target_directory = objects.join(object_shard(&name));
        if fs::create_dir_all(&target_directory).is_err() {
            continue;
        }
        let target = target_directory.join(&name);
        if target.is_file() {
            // 内容寻址：同名即同内容，旧副本可直接清理。
            let _ = fs::remove_file(entry.path());
            continue;
        }
        match fs::rename(entry.path(), &target) {
            Ok(()) => moved += 1,
            Err(error) => {
                if !target.is_file() {
                    eprintln!(
                        "[checkpoint] failed to migrate checkpoint object '{}': {error}",
                        name
                    );
                }
            }
        }
    }
    moved
}
