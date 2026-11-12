//! Codex 桌面宠物包管理。
//!
//! 完全兼容 Codex App / Petdex 社区的宠物包格式：
//! - zip 根目录或 `pets/{id}/` 子目录下的 `pet.json` + `spritesheet.webp`（或 `.png`）
//! - pet.json 字段：`{ id, displayName, description, spritesheetPath }`
//! - 精灵图为 8 列网格，单帧 192×208px，v1 共 9 行（1536×1872），
//!   Hatch Pet v2 为 11 行（1536×2288，后两行为 look 扩展态，渲染端忽略）
//!
//! 宠物安装目录为 `~/.snowapp/pets/{id}/`；同时扫描 Codex App
//! （`~/.codex/pets/`）与 Petdex（`~/.petdex/pets/`）已安装的宠物，
//! 使 Snow App 能直接使用 Codex 生态中的宠物。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;

use crate::storage::paths;

/// Codex 宠物精灵图单帧宽度（像素）。
pub const PET_FRAME_WIDTH: u32 = 192;
/// Codex 宠物精灵图单帧高度（像素）。
pub const PET_FRAME_HEIGHT: u32 = 208;
/// 精灵图清单文件名。
const PET_MANIFEST_FILE: &str = "pet.json";
/// Snow App 自身宠物安装目录名（位于 ~/.snowapp/ 下）。
const PETS_DIR_NAME: &str = "pets";
/// 内置宠物标记文件名（位于宠物目录下）：存在即表示该宠物为应用内置，不可卸载。
const BUILTIN_MARKER_FILE: &str = ".builtin";

/// 宠物清单元数据（pet.json 解析结果 + 安装位置信息）。
#[napi(object)]
#[derive(Clone)]
pub struct PetManifest {
    /// 宠物唯一标识（pet.json 的 id，已做安全清洗）。
    pub id: String,
    /// 展示名称。
    pub display_name: String,
    /// 宠物描述。
    pub description: String,
    /// 精灵图文件名（相对宠物目录）。
    pub spritesheet_file: String,
    /// 宠物目录绝对路径。
    pub dir_path: String,
    /// 精灵图绝对路径。
    pub spritesheet_path: String,
    /// 来源：`snow`（Snow App 安装）| `codex`（Codex App）| `petdex`（Petdex）。
    pub source: String,
    /// 精灵图版本：1 = 9 行标准网格，2 = 11 行（Hatch Pet v2）。
    pub version: i32,
    /// 精灵图列数（标准为 8）。
    pub columns: i32,
    /// 精灵图行数。
    pub rows: i32,
    /// 是否为应用内置宠物（内置宠物不可卸载，也不能被同 id 的手动安装包覆盖）。
    pub builtin: bool,
}

/// pet.json 原始结构（字段均容忍缺失）。
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawPetJson {
    id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    #[serde(rename = "spritesheetPath")]
    spritesheet_path: Option<String>,
}

fn err(reason: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, reason.into())
}

/// Snow App 宠物安装根目录 `~/.snowapp/pets`。
pub fn snow_pets_dir() -> Result<PathBuf> {
    let storage_dir = paths::app_storage_dir()?;
    Ok(storage_dir.join(PETS_DIR_NAME))
}

/// 目录是否为应用内置宠物（存在内置标记文件）。
pub fn is_builtin_pet_dir(dir: &Path) -> bool {
    dir.join(BUILTIN_MARKER_FILE).is_file()
}

/// 各来源的宠物根目录（按优先级排序，靠前者在同 id 冲突时胜出）。
fn pet_source_dirs() -> Vec<(PathBuf, &'static str)> {
    let home = match dirs_next::home_dir() {
        Some(home) => home,
        None => return Vec::new(),
    };
    vec![
        (home.join(".snowapp").join(PETS_DIR_NAME), "snow"),
        (home.join(".codex").join(PETS_DIR_NAME), "codex"),
        (home.join(".petdex").join(PETS_DIR_NAME), "petdex"),
    ]
}

/// 将宠物 id 清洗为安全的目录名：小写字母/数字/下划线/连字符，最长 64。
fn sanitize_pet_id(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else if ch.is_whitespace() {
                '-'
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '-' || c == '_');
    if trimmed.is_empty() {
        format!("pet-{}", uuid::Uuid::new_v4().simple())
    } else if trimmed.len() > 64 {
        trimmed[..64].to_string()
    } else {
        trimmed.to_string()
    }
}

/// 解析 PNG / WebP 图片尺寸（不引入图像解码库，仅读取文件头）。
/// 解析失败返回 None，由调用方决定是否放行。
fn read_image_dimensions(path: &Path) -> Option<(u32, u32)> {
    let mut file = fs::File::open(path).ok()?;
    let mut header = [0u8; 64];
    let read_len = file.read(&mut header).ok()?;
    let bytes = &header[..read_len.min(64)];

    // PNG：8 字节签名后第一个块为 IHDR，宽高为大端 u32。
    if bytes.len() >= 24 && bytes[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some((width, height));
    }

    // WebP：RIFF 容器 + WEBP 标识，逐个检查 VP8X / VP8L / VP8 块。
    if bytes.len() >= 32 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let chunk_tag = &bytes[12..16];
        let data = &bytes[20..];
        if chunk_tag == b"VP8X" && data.len() >= 10 {
            let width = 1 + u32::from_le_bytes([data[4], data[5], data[6], 0]);
            let height = 1 + u32::from_le_bytes([data[7], data[8], data[9], 0]);
            return Some((width, height));
        }
        if chunk_tag == b"VP8L" && data.len() >= 5 && data[0] == 0x2F {
            let bits = u32::from_le_bytes([data[1], data[2], data[3], data[4]]);
            let width = (bits & 0x3FFF) + 1;
            let height = ((bits >> 14) & 0x3FFF) + 1;
            return Some((width, height));
        }
        if chunk_tag == b"VP8 " && data.len() >= 10 {
            // 3 字节帧标签 + 3 字节起始码 0x9D012A，随后为 14 位宽高（小端）。
            if data[3] == 0x9D && data[4] == 0x01 && data[5] == 0x2A {
                let width = u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3FFF);
                let height = u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3FFF);
                return Some((width, height));
            }
        }
    }

    None
}

/// 校验精灵图几何是否符合 Codex 网格规范（单帧 192×208）。
/// 返回 (columns, rows, version)；无法解析尺寸时按 v1 标准网格兜底。
fn validate_spritesheet(path: &Path) -> Result<(i32, i32, i32)> {
    let (width, height) = match read_image_dimensions(path) {
        Some(dims) => dims,
        // 无法解析头部（非常规编码）时不阻断安装，渲染端会再次探测。
        None => return Ok((8, 9, 1)),
    };

    if width % PET_FRAME_WIDTH != 0 || height % PET_FRAME_HEIGHT != 0 {
        return Err(err(format!(
            "Spritesheet size {width}x{height} is not a multiple of the Codex frame size {}x{}",
            PET_FRAME_WIDTH, PET_FRAME_HEIGHT
        )));
    }

    let columns = (width / PET_FRAME_WIDTH) as i32;
    let rows = (height / PET_FRAME_HEIGHT) as i32;
    if columns < 1 || rows < 1 {
        return Err(err("Spritesheet has no frames".to_string()));
    }
    let version = if rows >= 11 { 2 } else { 1 };
    Ok((columns, rows, version))
}

/// 从 zip 条目路径中提取相对于宠物根目录的安全相对路径。
/// 防御 zip-slip：拒绝绝对路径与 `..` 组件。
fn safe_relative_path(zip_name: &str, prefix: &str) -> Option<PathBuf> {
    let normalized = zip_name.replace('\\', "/");
    let relative = if prefix.is_empty() {
        normalized.as_str()
    } else {
        normalized.strip_prefix(prefix)?
    };
    let relative = relative.trim_start_matches('/');
    if relative.is_empty() {
        return None;
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return None;
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => {}
            _ => return None,
        }
    }
    Some(path.to_path_buf())
}

/// 在 zip 中定位 pet.json：优先根目录，其次最浅层级的 `*/pet.json`、`pets/*/pet.json`。
fn locate_manifest(names: &[String]) -> Option<(String, String)> {
    let mut candidates: Vec<(usize, String)> = names
        .iter()
        .map(|name| name.replace('\\', "/"))
        .filter(|normalized| normalized.ends_with(PET_MANIFEST_FILE))
        .map(|normalized| (normalized.matches('/').count(), normalized))
        .filter(|(depth, _)| *depth <= 2)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by_key(|(depth, _)| *depth);
    let (_, manifest_name) = candidates.into_iter().next()?;
    let prefix = manifest_name
        .rsplit_once('/')
        .map(|(dir, _)| format!("{dir}/"))
        .unwrap_or_default();
    Some((manifest_name, prefix))
}

/// 读取某个宠物目录的 pet.json 并组装 PetManifest。
fn load_manifest_from_dir(dir: &Path, source: &str) -> Option<PetManifest> {
    let manifest_path = dir.join(PET_MANIFEST_FILE);
    let raw = fs::read_to_string(&manifest_path).ok()?;
    let parsed: RawPetJson = serde_json::from_str(&raw).ok()?;

    let dir_name = dir.file_name()?.to_string_lossy().to_string();
    let id = sanitize_pet_id(parsed.id.as_deref().unwrap_or(&dir_name));
    let spritesheet_file = parsed
        .spritesheet_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            Path::new(value)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "spritesheet.webp".to_string())
        })
        .unwrap_or_else(|| "spritesheet.webp".to_string());

    let spritesheet_path = dir.join(&spritesheet_file);
    if !spritesheet_path.exists() {
        return None;
    }

    let (columns, rows, version) = validate_spritesheet(&spritesheet_path).ok()?;

    Some(PetManifest {
        id,
        display_name: parsed
            .display_name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| dir_name.clone()),
        description: parsed.description.unwrap_or_default(),
        spritesheet_file,
        dir_path: dir.to_string_lossy().into_owned(),
        spritesheet_path: spritesheet_path.to_string_lossy().into_owned(),
        source: source.to_string(),
        version,
        columns,
        rows,
        builtin: is_builtin_pet_dir(dir),
    })
}

/// 安装宠物包 zip。解压校验后落盘到 `~/.snowapp/pets/{id}/`。
/// `builtin` 为 true 时标记为应用内置宠物；用户手动安装的包不能覆盖内置宠物。
pub fn install_pet_from_zip(zip_path: String, builtin: bool) -> Result<PetManifest> {
    let trimmed = zip_path.trim();
    if trimmed.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Pet package path is required".to_string(),
        ));
    }
    let source_path = Path::new(trimmed);
    if !source_path.exists() {
        return Err(err(format!("Pet package does not exist: {trimmed}")));
    }

    // ── 1. 扫描 zip，定位 pet.json 与其所在前缀 ─────────────────────────
    let file = fs::File::open(source_path)
        .map_err(|error| err(format!("Failed to open pet package: {error}")))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|error| err(format!("Invalid zip pet package: {error}")))?;

    let mut names: Vec<String> = Vec::new();
    for index in 0..archive.len() {
        if let Ok(entry) = archive.by_index(index) {
            if !entry.is_dir() {
                names.push(entry.name().to_string());
            }
        }
    }

    let (_, prefix) = locate_manifest(&names)
        .ok_or_else(|| err("pet.json not found in the pet package".to_string()))?;

    // ── 2. 解压到临时目录（防御 zip-slip，逐条目校验相对路径）──────────
    let staging_dir = std::env::temp_dir().join(format!(
        "snow-pet-install-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&staging_dir).map_err(|error| {
        err(format!(
            "Failed to create staging directory '{}': {error}",
            staging_dir.display()
        ))
    })?;

    let extract_result = (|| -> Result<()> {
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| err(format!("Failed to read zip entry: {error}")))?;
            if entry.is_dir() {
                continue;
            }
            let entry_name = entry.name().to_string();
            let relative = match safe_relative_path(&entry_name, &prefix) {
                Some(relative) => relative,
                None => continue, // 忽略宠物目录之外的无关文件
            };
            let dest = staging_dir.join(&relative);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    err(format!("Failed to create '{}': {error}", parent.display()))
                })?;
            }
            let mut output = fs::File::create(&dest)
                .map_err(|error| err(format!("Failed to create '{}': {error}", dest.display())))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| err(format!("Failed to extract '{}': {error}", dest.display())))?;
        }
        Ok(())
    })();

    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    // ── 3. 校验 pet.json 与精灵图 ───────────────────────────────────────
    let manifest_staging = staging_dir.join(PET_MANIFEST_FILE);
    if !manifest_staging.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err("pet.json not found after extraction".to_string()));
    }
    let manifest = match load_manifest_from_dir(&staging_dir, "snow") {
        Some(manifest) => manifest,
        None => {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(err(
                "Invalid pet package: pet.json is malformed or spritesheet is missing"
                    .to_string(),
            ));
        }
    };

    // ── 4. 落盘到 ~/.snowapp/pets/{id}/（覆盖同名宠物）─────────────────
    let pets_root = snow_pets_dir()?;
    fs::create_dir_all(&pets_root).map_err(|error| {
        err(format!(
            "Failed to create pets directory '{}': {error}",
            pets_root.display()
        ))
    })?;
    let target_dir = pets_root.join(&manifest.id);
    if target_dir.exists() {
        if !builtin && is_builtin_pet_dir(&target_dir) {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(err(format!(
                "Pet '{}' is a built-in pet and cannot be replaced by a user package",
                manifest.id
            )));
        }
        fs::remove_dir_all(&target_dir).map_err(|error| {
            err(format!(
                "Failed to replace existing pet '{}': {error}",
                target_dir.display()
            ))
        })?;
    }

    let move_result = copy_dir_recursive(&staging_dir, &target_dir);
    let _ = fs::remove_dir_all(&staging_dir);
    move_result.map_err(|error| {
        err(format!(
            "Failed to install pet to '{}': {error}",
            target_dir.display()
        ))
    })?;

    // 内置标记由安装方式决定，忽略包内自带的同名文件。
    let marker_path = target_dir.join(BUILTIN_MARKER_FILE);
    let _ = fs::remove_file(&marker_path);
    if builtin {
        fs::write(&marker_path, b"").map_err(|error| {
            err(format!(
                "Failed to mark built-in pet '{}': {error}",
                manifest.id
            ))
        })?;
    }

    load_manifest_from_dir(&target_dir, "snow").ok_or_else(|| {
        err("Pet package was installed but could not be re-read".to_string())
    })
}

/// 递归复制目录内容（不含源目录自身层级）。
fn copy_dir_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// 列出所有可用宠物：Snow App 安装的 + Codex App / Petdex 生态中的。
/// 同 id 冲突时按 snow > codex > petdex 优先级去重。
pub fn list_installed_pets() -> Vec<PetManifest> {
    let mut result: Vec<PetManifest> = Vec::new();
    for (root, source) in pet_source_dirs() {
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest = match load_manifest_from_dir(&path, source) {
                Some(manifest) => manifest,
                None => continue,
            };
            if result.iter().any(|existing| existing.id == manifest.id) {
                continue;
            }
            result.push(manifest);
        }
    }
    result.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    result
}

/// 卸载 Snow App 安装的宠物（仅允许删除 ~/.snowapp/pets/ 下的目录，内置宠物拒绝卸载）。
pub fn uninstall_pet(pet_id: String) -> Result<()> {
    let id = sanitize_pet_id(&pet_id);
    let pets_root = snow_pets_dir()?;
    let target_dir = pets_root.join(&id);

    if !target_dir.exists() {
        return Err(err(format!(
            "Pet '{id}' is not installed in Snow App (it may come from Codex App and cannot be removed here)"
        )));
    }

    // 安全检查：目标必须位于 ~/.snowapp/pets/ 内，防止误删其他目录。
    let canonical_root = pets_root.canonicalize()
        .map_err(|error| err(format!("Failed to resolve pets directory: {error}")))?;
    let canonical_target = target_dir.canonicalize()
        .map_err(|error| err(format!("Failed to resolve pet directory: {error}")))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(err("Refused to delete a directory outside the pets root"));
    }
    if is_builtin_pet_dir(&canonical_target) {
        return Err(err(format!("Built-in pet '{id}' cannot be uninstalled")));
    }

    fs::remove_dir_all(&canonical_target)
        .map_err(|error| err(format!("Failed to uninstall pet '{id}': {error}")))
}
