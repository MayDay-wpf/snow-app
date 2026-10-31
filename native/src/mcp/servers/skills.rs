use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use napi::{Error, Status};
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::tools::McpTool;
use super::remote_workspace::is_ssh_path;
use super::skills_remote::{
    scan_remote_skill_roots, write_remote_skill_file, RemoteSkillEntry, RemoteSkillRoot,
};

const SERVER_ID: &str = "skills";
const TOOL_NAME: &str = "skill-execute";
pub const SKILL_FILE_NAME: &str = "SKILL.md";

/// 单次本地扫描的目录数量上限：符号链接（junction）可能把扫描带到大树上，
/// 用预算兜住每轮扫描的成本。
const MAX_SKILL_SCAN_DIRECTORIES: usize = 2000;

/// 技能目录位置：本地文件系统目录，或 SSH 工作区内的 `ssh://` URI。
#[derive(Clone)]
enum SkillDirectory {
    Local(PathBuf),
    Remote(String),
}

impl SkillDirectory {
    /// 展示路径（远程为 `ssh://` URI）。
    fn display(&self) -> String {
        match self {
            SkillDirectory::Local(path) => path.to_string_lossy().into_owned(),
            SkillDirectory::Remote(uri) => uri.clone(),
        }
    }

    /// SKILL.md 的路径。
    fn skill_file(&self) -> String {
        match self {
            SkillDirectory::Local(path) => {
                path.join(SKILL_FILE_NAME).to_string_lossy().into_owned()
            }
            SkillDirectory::Remote(uri) => {
                format!("{}/{}", uri.trim_end_matches('/'), SKILL_FILE_NAME)
            }
        }
    }
}

#[derive(Clone)]
struct Skill {
    id: String,
    name: String,
    description: String,
    location: String,
    source: String,
    directory: SkillDirectory,
    /// SKILL.md 正文（已剥离 frontmatter）。
    content: String,
    /// 远程技能的 SKILL.md 原文（启停时改 frontmatter 用）；本地技能为 None（现读现写）。
    raw_content: Option<String>,
    /// 远程技能预渲染好的目录树；本地技能为 None（渲染时现读）。
    tree: Option<String>,
    allowed_tools: Option<Vec<String>>,
    enabled: bool,
}

struct SkillMetadata {
    name: String,
    description: String,
    allowed_tools: Option<Vec<String>>,
    enabled: bool,
}

impl Default for SkillMetadata {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            allowed_tools: None,
            enabled: true,
        }
    }
}

#[napi(object)]
pub struct SkillDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub location: String,
    pub source: String,
    pub path: String,
    pub allowed_tools: Option<Vec<String>>,
    pub enabled: bool,
}

#[napi(object)]
pub struct ProjectSkillDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub location: String,
    pub source: String,
    pub path: String,
    pub allowed_tools: Option<Vec<String>>,
    pub default_enabled: bool,
    pub enabled: bool,
}

pub struct SkillsService;

impl SkillsService {
    pub fn new() -> Self {
        Self
    }

    pub async fn list_available(
        &self,
        project_id: Option<&str>,
    ) -> napi::Result<Vec<SkillDefinition>> {
        let project_id = normalize_optional_value(project_id);
        let loaded = load_skills(project_id.as_deref()).await?;
        loaded.require_remote_scan()?;
        Ok(loaded
            .skills
            .into_values()
            .map(|skill| SkillDefinition {
                id: skill.id,
                name: skill.name,
                description: skill.description,
                location: skill.location,
                source: skill.source,
                path: skill.directory.display(),
                allowed_tools: skill.allowed_tools,
                enabled: skill.enabled,
            })
            .collect())
    }

    pub async fn set_enabled(
        &self,
        project_id: Option<&str>,
        skill_id: &str,
        enabled: bool,
    ) -> napi::Result<()> {
        let project_id = normalize_optional_value(project_id);
        let skill_id = normalize_skill_id(skill_id);
        if skill_id.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "skill id must be a non-empty string".to_string(),
            ));
        }

        let loaded = load_skills(project_id.as_deref()).await?;
        loaded.require_remote_scan()?;
        let skill = loaded.skills.get(&skill_id).ok_or_else(|| {
            Error::new(Status::InvalidArg, format!("Skill \"{skill_id}\" not found"))
        })?;
        if skill.enabled == enabled {
            return Ok(());
        }

        match &skill.directory {
            SkillDirectory::Local(directory) => {
                let directory = directory.clone();
                run_blocking("update skill enabled state", move || {
                    update_skill_file_enabled(&directory, enabled)
                })
                .await
            }
            SkillDirectory::Remote(_) => {
                // 远程技能：用扫描时读到的 SKILL.md 原文改 frontmatter，再写回远程。
                let workspace = loaded.workspace.clone().ok_or_else(|| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Remote Skill \"{skill_id}\" requires an SSH workspace"),
                    )
                })?;
                let raw_content = skill.raw_content.clone().ok_or_else(|| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Remote Skill \"{skill_id}\" is missing its SKILL.md content"),
                    )
                })?;
                let updated = build_skill_content_with_enabled(&raw_content, enabled).map_err(
                    |error| {
                        Error::new(
                            Status::InvalidArg,
                            format!("Cannot update {}: {error}", skill.directory.skill_file()),
                        )
                    },
                )?;
                write_remote_skill_file(&workspace, &skill.directory.skill_file(), &updated).await
            }
        }
    }

    pub async fn list_project(
        &self,
        project_id: &str,
    ) -> napi::Result<Vec<ProjectSkillDefinition>> {
        let project_id = normalize_required_value(project_id, "project id")?;
        let loaded = load_skills(Some(&project_id)).await?;
        loaded.require_remote_scan()?;
        if loaded.workspace.is_none() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Project \"{project_id}\" does not have a workspace directory"),
            ));
        }

        let settings = {
            let project_id = project_id.clone();
            run_blocking("load project skill settings", move || {
                let storage_info = crate::storage::initialize_app_storage()?;
                let database_path = PathBuf::from(storage_info.database_path);
                crate::storage::services::system_settings::get_skills_project_scope_settings(
                    &database_path,
                    &project_id,
                )
            })
            .await?
        };

        Ok(loaded
            .skills
            .into_values()
            .map(|skill| {
                let enabled = settings.effective_enabled(&skill.id, skill.enabled);
                ProjectSkillDefinition {
                    id: skill.id,
                    name: skill.name,
                    description: skill.description,
                    location: skill.location,
                    source: skill.source,
                    path: skill.directory.display(),
                    allowed_tools: skill.allowed_tools,
                    default_enabled: skill.enabled,
                    enabled,
                }
            })
            .collect())
    }

    pub async fn set_project_enabled(
        &self,
        project_id: &str,
        skill_id: &str,
        enabled: bool,
    ) -> napi::Result<()> {
        let project_id = normalize_required_value(project_id, "project id")?;
        let skill_id = normalize_required_skill_id(skill_id)?;
        let loaded = load_skills(Some(&project_id)).await?;
        loaded.require_remote_scan()?;
        if loaded.workspace.is_none() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Project \"{project_id}\" does not have a workspace directory"),
            ));
        }
        if !loaded.skills.contains_key(&skill_id) {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Skill \"{skill_id}\" not found for project \"{project_id}\""),
            ));
        }

        run_blocking("update project skill enabled state", move || {
            let storage_info = crate::storage::initialize_app_storage()?;
            let database_path = PathBuf::from(storage_info.database_path);
            crate::storage::services::system_settings::set_skills_project_skill_enabled(
                &database_path,
                &project_id,
                &skill_id,
                enabled,
            )
        })
        .await
    }

    pub async fn tool(&self, project_id: Option<&str>) -> napi::Result<Option<McpTool>> {
        let project_id = normalize_optional_value(project_id);
        // 工具链不能因远程扫描失败而整体失败：SSH 不可用时降级为全局技能。
        let mut loaded = load_skills(project_id.as_deref()).await?;
        if let Some(project_id) = project_id.as_deref() {
            let project_id = project_id.to_string();
            let settings = run_blocking("load project skill settings", move || {
                let storage_info = crate::storage::initialize_app_storage()?;
                let database_path = PathBuf::from(storage_info.database_path);
                crate::storage::services::system_settings::get_skills_project_scope_settings(
                    &database_path,
                    &project_id,
                )
            })
            .await?;
            loaded
                .skills
                .retain(|skill_id, skill| settings.effective_enabled(skill_id, skill.enabled));
        } else {
            loaded.skills.retain(|_, skill| skill.enabled);
        }
        if loaded.skills.is_empty() {
            return Ok(None);
        }

        Ok(Some(McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_NAME.to_string(),
            description: generate_skill_tool_description(&loaded.skills),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "skill": {
                        "type": "string",
                        "description": "The skill id with no arguments, for example pdf, data-analysis, or helloagents/analyze."
                    }
                },
                "required": ["skill"],
                "additionalProperties": false
            }),
        }))
    }

    pub async fn execute(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let requested_skill_id = args
            .get("skill")
            .and_then(Value::as_str)
            .map(normalize_skill_id)
            .filter(|skill_id| !skill_id.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "skill parameter is required and must be a non-empty string".to_string(),
                )
            })?;
        let project_id = normalize_optional_value(project_id);

        // 与 tool() 一致：远程扫描失败时降级为全局技能，不让技能调用整体失败。
        let mut loaded = load_skills(project_id.as_deref()).await?;
        if let Some(project_id) = project_id.as_deref() {
            let project_id = project_id.to_string();
            let settings = run_blocking("load project skill settings", move || {
                let storage_info = crate::storage::initialize_app_storage()?;
                let database_path = PathBuf::from(storage_info.database_path);
                crate::storage::services::system_settings::get_skills_project_scope_settings(
                    &database_path,
                    &project_id,
                )
            })
            .await?;
            loaded
                .skills
                .retain(|skill_id, skill| settings.effective_enabled(skill_id, skill.enabled));
        } else {
            loaded.skills.retain(|_, skill| skill.enabled);
        }
        let skill = loaded.skills.get(&requested_skill_id).ok_or_else(|| {
            let available = if loaded.skills.is_empty() {
                "none".to_string()
            } else {
                loaded.skills.keys().cloned().collect::<Vec<_>>().join(", ")
            };
            Error::new(
                Status::InvalidArg,
                format!(
                    "Skill \"{requested_skill_id}\" not found. Available skills: {available}"
                ),
            )
        })?;

        Ok(Value::String(render_skill(skill)))
    }
}

async fn run_blocking<T, F>(operation_name: &'static str, operation: F) -> napi::Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> napi::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("HOST_OPERATION_FAILED: Failed to {operation_name}: {error}"),
            )
        })?
}

fn normalize_optional_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_required_value(value: &str, label: &str) -> napi::Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} must be a non-empty string"),
        ));
    }
    Ok(normalized.to_string())
}

fn normalize_required_skill_id(skill_id: &str) -> napi::Result<String> {
    let normalized = normalize_skill_id(skill_id);
    if normalized.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "skill id must be a non-empty string".to_string(),
        ));
    }
    Ok(normalized)
}

/// 技能加载结果：技能集合 + 项目工作区 + 远程扫描失败原因。
struct LoadedSkills {
    skills: BTreeMap<String, Skill>,
    /// 项目工作区（本地绝对路径或 `ssh://` URI）；无项目上下文时为 None。
    workspace: Option<String>,
    /// SSH 远程技能扫描失败的原因（本地项目恒为 None）。
    remote_error: Option<String>,
}

impl LoadedSkills {
    /// UI / 配置路径：远程扫描失败必须上抛，否则远程项目会静默显示成"没有项目技能"。
    fn require_remote_scan(&self) -> napi::Result<()> {
        match &self.remote_error {
            Some(error) => Err(Error::new(Status::GenericFailure, error.clone())),
            None => Ok(()),
        }
    }
}

/// 加载技能集合：全局技能始终来自本机；项目技能按工作区类型走本地扫描或 SSH 远程扫描。
///
/// 远程扫描失败时不直接报错，而是把原因带回 `LoadedSkills::remote_error`：
/// UI / 配置路径据此上抛，工具链（`tool` / `execute`）则降级为全局技能。
async fn load_skills(project_id: Option<&str>) -> napi::Result<LoadedSkills> {
    let workspace = resolve_project_workspace(project_id).await?;

    if let Some(workspace_path) = workspace.as_deref().filter(|path| is_ssh_path(path)) {
        return match scan_remote_skill_roots(workspace_path).await {
            Ok(roots) => Ok(LoadedSkills {
                skills: load_remote_project_skills(&roots),
                workspace,
                remote_error: None,
            }),
            Err(error) => {
                let skills =
                    run_blocking("load global skills", || Ok(load_global_skills())).await?;
                Ok(LoadedSkills {
                    skills,
                    workspace,
                    remote_error: Some(format!("Failed to scan remote project Skills: {error}")),
                })
            }
        };
    }

    let project_root = workspace.clone().map(PathBuf::from);
    let skills = run_blocking("load skills", move || {
        Ok(load_local_skills(project_root.as_deref()))
    })
    .await?;
    Ok(LoadedSkills {
        skills,
        workspace,
        remote_error: None,
    })
}

/// 项目工作区路径：本地绝对路径或 `ssh://` 远程工作区 URI。
async fn resolve_project_workspace(project_id: Option<&str>) -> napi::Result<Option<String>> {
    let Some(project_id) = project_id.map(str::to_string) else {
        return Ok(None);
    };

    run_blocking("resolve project workspace", move || {
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = PathBuf::from(storage_info.database_path);
        crate::storage::services::workspace_directories::get_workspace_directory_path(
            &database_path,
            &project_id,
        )
    })
    .await
}

/// 本机全局技能（`~/.agents/skills` 与 `~/.snow/skills`）。
fn load_global_skills() -> BTreeMap<String, Skill> {
    let mut skills = BTreeMap::new();
    if let Some(home) = dirs_next::home_dir() {
        load_skills_from_directory(
            &mut skills,
            &home.join(".agents").join("skills"),
            "global",
            "agents",
        );
        load_skills_from_directory(
            &mut skills,
            &home.join(".snow").join("skills"),
            "global",
            "snow",
        );
    }
    skills
}

/// 本机技能：全局目录 + 可选的本地项目目录。
fn load_local_skills(project_root: Option<&Path>) -> BTreeMap<String, Skill> {
    let mut skills = load_global_skills();

    if let Some(project_root) = project_root {
        load_skills_from_directory(
            &mut skills,
            &project_root.join(".agents").join("skills"),
            "project",
            "agents",
        );
        load_skills_from_directory(
            &mut skills,
            &project_root.join(".snow").join("skills"),
            "project",
            "snow",
        );
    }

    skills
}

/// 远程项目技能：全局技能来自本机，项目技能来自 SSH 工作区扫描结果。
fn load_remote_project_skills(roots: &[RemoteSkillRoot]) -> BTreeMap<String, Skill> {
    let mut skills = load_global_skills();
    for root in roots {
        load_skills_from_remote_root(&mut skills, root);
    }
    skills
}

/// 从远程扫描结果中发现技能：规则与本地扫描一致（SKILL.md 所在目录即一个技能，
/// 技能 ID 是它相对技能根目录的路径，同 ID 后扫描的覆盖先扫描的）。
fn load_skills_from_remote_root(skills: &mut BTreeMap<String, Skill>, root: &RemoteSkillRoot) {
    let root_uri = root.uri.trim_end_matches('/');

    for entry in &root.entries {
        if entry.is_directory {
            continue;
        }
        if entry.path.rsplit('/').next() != Some(SKILL_FILE_NAME) {
            continue;
        }

        let directory_relative =
            entry.path[..entry.path.len() - SKILL_FILE_NAME.len()].trim_end_matches('/');
        if directory_relative
            .split('/')
            .any(should_skip_skill_directory)
        {
            continue;
        }
        let skill_id = normalize_skill_id(directory_relative);
        if skill_id.is_empty() || skill_id == "." {
            continue;
        }

        let Some(raw_content) = root.skill_files.get(&entry.path) else {
            continue;
        };
        let Ok((metadata, content)) = parse_skill_document(raw_content) else {
            continue;
        };

        let fallback_name = skill_id
            .split('/')
            .filter(|part| !part.is_empty())
            .next_back()
            .unwrap_or(&skill_id)
            .to_string();
        let directory_uri = if directory_relative.is_empty() {
            root_uri.to_string()
        } else {
            format!("{root_uri}/{directory_relative}")
        };
        let tree = build_remote_skill_tree(&root.entries, directory_relative);

        skills.insert(
            skill_id.clone(),
            Skill {
                id: skill_id,
                name: if metadata.name.is_empty() {
                    fallback_name
                } else {
                    metadata.name
                },
                description: metadata.description,
                location: "project".to_string(),
                source: root.source.clone(),
                directory: SkillDirectory::Remote(directory_uri),
                content,
                raw_content: Some(raw_content.clone()),
                tree: Some(tree),
                allowed_tools: metadata.allowed_tools,
                enabled: metadata.enabled,
            },
        );
    }
}

fn load_skills_from_directory(
    skills: &mut BTreeMap<String, Skill>,
    base_skills_dir: &Path,
    location: &str,
    source: &str,
) {
    if !base_skills_dir.is_dir() {
        return;
    }

    // 链接形式的目录可能成环（a -> b -> a），入栈时用祖先链的真实路径
    // （canonicalize 会解析链接）判断该目录是否已经在自己的祖先中出现过；
    // 同时限制扫描的目录数量，避免某个链接指向大树时本轮扫描成本爆炸。
    let base_key =
        fs::canonicalize(base_skills_dir).unwrap_or_else(|_| base_skills_dir.to_path_buf());
    let mut pending_dirs = vec![(base_skills_dir.to_path_buf(), vec![base_key])];
    let mut remaining_dirs = MAX_SKILL_SCAN_DIRECTORIES;
    while let Some((current_dir, ancestor_keys)) = pending_dirs.pop() {
        if remaining_dirs == 0 {
            eprintln!(
                "[skills] reached the {MAX_SKILL_SCAN_DIRECTORIES}-directory scan budget at {}; the rest of the tree is skipped",
                base_skills_dir.display()
            );
            break;
        }
        remaining_dirs -= 1;

        let Ok(entries) = fs::read_dir(&current_dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let Some(file_type) = resolve_entry_file_type(&entry) else {
                continue;
            };
            let entry_name = entry.file_name().to_string_lossy().into_owned();

            if file_type.is_dir() {
                if should_skip_skill_directory(&entry_name) {
                    continue;
                }
                let dir_path = entry.path();
                let dir_key = fs::canonicalize(&dir_path).unwrap_or_else(|_| dir_path.clone());
                if ancestor_keys.contains(&dir_key) {
                    continue;
                }
                let mut child_ancestor_keys = ancestor_keys.clone();
                child_ancestor_keys.push(dir_key);
                pending_dirs.push((dir_path, child_ancestor_keys));
                continue;
            }

            if !file_type.is_file() || entry_name != SKILL_FILE_NAME {
                continue;
            }

            let skill_dir = current_dir.clone();
            let Ok(relative_path) = skill_dir.strip_prefix(base_skills_dir) else {
                continue;
            };
            let skill_id = normalize_skill_id(&relative_path.to_string_lossy());
            if skill_id.is_empty() || skill_id == "." {
                continue;
            }

            let Some((metadata, content)) = read_skill_file(&skill_dir) else {
                continue;
            };
            let fallback_name = skill_id
                .split('/')
                .filter(|part| !part.is_empty())
                .next_back()
                .unwrap_or(&skill_id)
                .to_string();

            skills.insert(
                skill_id.clone(),
                Skill {
                    id: skill_id,
                    name: if metadata.name.is_empty() {
                        fallback_name
                    } else {
                        metadata.name
                    },
                    description: metadata.description,
                    location: location.to_string(),
                    source: source.to_string(),
                    directory: SkillDirectory::Local(skill_dir),
                    content,
                    raw_content: None,
                    tree: None,
                    allowed_tools: metadata.allowed_tools,
                    enabled: metadata.enabled,
                },
            );
        }
    }
}

fn should_skip_skill_directory(name: &str) -> bool {
    name == "templates" || name == "examples" || name == "node_modules" || name.starts_with('.')
}

/// 解析目录项的真实类型：符号链接 / junction 会跟随链接解析到目标类型，
/// 悬空链接返回 `None`（跳过）。`DirEntry::file_type()` 不跟随链接，链接目录在其上
/// 既不是文件也不是目录，链接形式的技能目录会因此被静默忽略，所以这里补一次
/// `metadata()`（它会跟随链接）。
fn resolve_entry_file_type(entry: &fs::DirEntry) -> Option<fs::FileType> {
    let file_type = entry.file_type().ok()?;
    if file_type.is_dir() || file_type.is_file() {
        return Some(file_type);
    }
    fs::metadata(entry.path())
        .ok()
        .map(|metadata| metadata.file_type())
}

/// 目录项是否为目录（跟随符号链接 / junction）。
fn entry_is_directory(entry: &fs::DirEntry) -> bool {
    resolve_entry_file_type(entry)
        .map(|file_type| file_type.is_dir())
        .unwrap_or(false)
}

fn read_skill_file(skill_path: &Path) -> Option<(SkillMetadata, String)> {
    let file_content = fs::read_to_string(skill_path.join(SKILL_FILE_NAME)).ok()?;
    parse_skill_document(&file_content).ok()
}

fn update_skill_file_enabled(skill_path: &Path, enabled: bool) -> napi::Result<()> {
    let file_path = skill_path.join(SKILL_FILE_NAME);
    let file_content = fs::read_to_string(&file_path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read {}: {error}", file_path.to_string_lossy()),
        )
    })?;
    let updated_content = build_skill_content_with_enabled(&file_content, enabled).map_err(
        |error| {
            Error::new(
                Status::InvalidArg,
                format!("Cannot update {}: {error}", file_path.to_string_lossy()),
            )
        },
    )?;

    fs::write(&file_path, updated_content).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write {}: {error}", file_path.to_string_lossy()),
        )
    })
}

/// 按 `enable` 字段重写 SKILL.md 内容（frontmatter 缺失时补一段）；本地与远程技能共用。
fn build_skill_content_with_enabled(
    file_content: &str,
    enabled: bool,
) -> std::result::Result<String, String> {
    let line_ending = if file_content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };

    Ok(match frontmatter_bounds(file_content)? {
        Some((frontmatter_start, frontmatter_end, _)) => {
            let frontmatter = &file_content[frontmatter_start..frontmatter_end];
            let updated_frontmatter = update_frontmatter_enabled(frontmatter, enabled, line_ending);
            format!(
                "{}{}{}",
                &file_content[..frontmatter_start],
                updated_frontmatter,
                &file_content[frontmatter_end..]
            )
        }
        None => {
            format!("---{line_ending}enable: {enabled}{line_ending}---{line_ending}{file_content}")
        }
    })
}

fn update_frontmatter_enabled(frontmatter: &str, enabled: bool, line_ending: &str) -> String {
    let mut updated = String::with_capacity(frontmatter.len() + 16);
    let mut replaced = false;

    for line in frontmatter.split_inclusive('\n') {
        let line_without_ending = line.trim_end_matches(['\r', '\n']);
        let is_indented =
            line_without_ending.starts_with(' ') || line_without_ending.starts_with('\t');
        let is_root_enable = !is_indented
            && line_without_ending
                .split_once(':')
                .is_some_and(|(key, _)| key.trim() == "enable");
        if is_root_enable {
            let existing_line_ending = if line.ends_with("\r\n") {
                "\r\n"
            } else if line.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            updated.push_str(&format!("enable: {enabled}{existing_line_ending}"));
            replaced = true;
        } else {
            updated.push_str(line);
        }
    }

    if !replaced {
        if !updated.is_empty() && !updated.ends_with('\n') {
            updated.push_str(line_ending);
        }
        updated.push_str(&format!("enable: {enabled}{line_ending}"));
    }

    updated
}

fn parse_skill_document(
    file_content: &str,
) -> std::result::Result<(SkillMetadata, String), String> {
    let Some((frontmatter, body)) = split_frontmatter(file_content)? else {
        return Ok((SkillMetadata::default(), file_content.trim().to_string()));
    };
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(frontmatter)
        .map_err(|error| format!("Invalid skill frontmatter: {error}"))?;
    let metadata = parse_skill_metadata(&yaml);
    let content = strip_nested_frontmatter(body.trim()).trim().to_string();
    Ok((metadata, content))
}

fn frontmatter_bounds(content: &str) -> std::result::Result<Option<(usize, usize, usize)>, String> {
    let mut lines = content.split_inclusive('\n');
    let Some(first_line) = lines.next() else {
        return Ok(None);
    };
    if first_line.trim_end_matches(['\r', '\n']) != "---" {
        return Ok(None);
    }

    let frontmatter_start = first_line.len();
    let mut offset = frontmatter_start;
    for line in lines {
        let next_offset = offset + line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Ok(Some((frontmatter_start, offset, next_offset)));
        }
        offset = next_offset;
    }

    Err("Skill frontmatter is missing a closing --- marker".to_string())
}

fn split_frontmatter(content: &str) -> std::result::Result<Option<(&str, &str)>, String> {
    Ok(
        frontmatter_bounds(content)?.map(|(frontmatter_start, frontmatter_end, body_start)| {
            (
                &content[frontmatter_start..frontmatter_end],
                &content[body_start..],
            )
        }),
    )
}

fn strip_nested_frontmatter(content: &str) -> &str {
    match split_frontmatter(content) {
        Ok(Some((_, body))) => body,
        _ => content,
    }
}

/// Parse a SKILL.md document and return `(name, description)` for install
/// bookkeeping. Exposed as a public helper for the skills installer.
pub fn parse_skill_metadata_for_install(file_content: &str) -> Option<(String, String)> {
    match parse_skill_document(file_content) {
        Ok((metadata, _)) => Some((metadata.name, metadata.description)),
        Err(_) => None,
    }
}

fn parse_skill_metadata(value: &serde_yaml::Value) -> SkillMetadata {
    let Some(mapping) = value.as_mapping() else {
        return SkillMetadata::default();
    };

    let name = yaml_mapping_value(mapping, "name")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let description = yaml_mapping_value(mapping, "description")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let allowed_tools = yaml_mapping_value(mapping, "allowed-tools")
        .and_then(parse_allowed_tools)
        .filter(|tools| !tools.is_empty());
    let enabled = yaml_mapping_value(mapping, "enable")
        .and_then(serde_yaml::Value::as_bool)
        .unwrap_or(true);

    SkillMetadata {
        name,
        description,
        allowed_tools,
        enabled,
    }
}

fn yaml_mapping_value<'a>(
    mapping: &'a serde_yaml::Mapping,
    key: &str,
) -> Option<&'a serde_yaml::Value> {
    mapping.get(serde_yaml::Value::String(key.to_string()))
}

fn parse_allowed_tools(value: &serde_yaml::Value) -> Option<Vec<String>> {
    if let Some(items) = value.as_sequence() {
        return Some(
            items
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|tool| !tool.is_empty())
                .map(str::to_string)
                .collect(),
        );
    }

    value.as_str().map(|tools| {
        tools
            .split(',')
            .map(str::trim)
            .filter(|tool| !tool.is_empty())
            .map(str::to_string)
            .collect()
    })
}

pub fn normalize_skill_id(skill_id: &str) -> String {
    let mut normalized = skill_id.trim().replace('\\', "/");
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }
    normalized
}

fn generate_skill_tool_description(skills: &BTreeMap<String, Skill>) -> String {
    let skills_list = skills
        .values()
        .map(|skill| {
            format!(
                "<skill>\n<name>\n{}\n</name>\n<description>\n{}\n</description>\n<location>\n{}\n</location>\n</skill>",
                skill.id, skill.description, skill.location
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "Execute a skill within the main conversation\n\n<skills_instructions>\nWhen users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.\n\nHow to use skills:\n- Invoke skills using this tool with the skill id only (no arguments)\n- When you invoke a skill, you will see <command-message>The \"{{name}}\" skill is loading</command-message>\n- The skill's prompt will expand and provide detailed instructions on how to complete the task\n\nImportant:\n- Only use skills listed in <available_skills> below\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands\n</skills_instructions>\n\n<available_skills>\n{skills_list}\n</available_skills>"
    )
}

fn render_skill(skill: &Skill) -> String {
    let directory_tree = match &skill.tree {
        Some(tree) => tree.clone(),
        None => match &skill.directory {
            SkillDirectory::Local(path) => build_local_skill_tree(path),
            SkillDirectory::Remote(_) => "(Unable to generate directory tree)".to_string(),
        },
    };
    let tool_restriction = skill
        .allowed_tools
        .as_ref()
        .filter(|tools| !tools.is_empty())
        .map(|tools| {
            format!(
                "\n\n<tool-restrictions>\nCRITICAL: This skill ONLY allows the following tools:\n{}\n\nYou MUST NOT use any other tools. Any tool not listed above is forbidden for this skill.\n</tool-restrictions>",
                tools
                    .iter()
                    .map(|tool| format!("- {tool}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })
        .unwrap_or_default();

    format!(
        "<command-message>The \"{}\" skill is loading</command-message>\n\n{}{}\n\n<skill-info>\nSkill Name: {}\nAbsolute Path: {}\n\nDirectory Structure:\n```\n{}/\\n{}\n```\n\nNote: You can use the filesystem read tool to read any file in this skill directory using the absolute path above.\n</skill-info>",
        skill.name,
        skill.content,
        tool_restriction,
        skill.name,
        skill.directory.display(),
        skill.name,
        directory_tree
    )
}

/// 目录树条目：本地与远程技能共用同一套格式化规则。
struct SkillTreeEntry {
    name: String,
    is_directory: bool,
    children: Vec<(String, bool)>,
}

/// 读取本地技能目录的两级目录树（顶层条目 + 各顶层目录的直接子项）。
fn build_local_skill_tree(skill_path: &Path) -> String {
    let Ok(entries) = fs::read_dir(skill_path) else {
        return "(Unable to generate directory tree)".to_string();
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_is_dir = entry_is_directory(left);
        let right_is_dir = entry_is_directory(right);
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    let tree_entries = entries
        .iter()
        .map(|entry| {
            let is_directory = entry_is_directory(entry);
            let children = if is_directory {
                let mut children = fs::read_dir(entry.path())
                    .map(|sub_entries| sub_entries.flatten().collect::<Vec<_>>())
                    .unwrap_or_default();
                children.sort_by_key(|child| child.file_name());
                children
                    .iter()
                    .map(|child| {
                        (
                            child.file_name().to_string_lossy().into_owned(),
                            entry_is_directory(child),
                        )
                    })
                    .collect()
            } else {
                Vec::new()
            };
            SkillTreeEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_directory,
                children,
            }
        })
        .collect::<Vec<_>>();

    format_skill_tree(&tree_entries)
}

/// 从远程扫描结果里取某个技能目录的两级目录树（与本地输出格式一致）。
fn build_remote_skill_tree(entries: &[RemoteSkillEntry], skill_prefix: &str) -> String {
    let prefix = if skill_prefix.is_empty() {
        String::new()
    } else {
        format!("{skill_prefix}/")
    };

    let mut tree_entries: Vec<SkillTreeEntry> = Vec::new();
    for entry in entries {
        let Some(relative) = entry.path.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if relative.is_empty() || relative.contains('/') {
            continue;
        }
        tree_entries.push(SkillTreeEntry {
            name: relative.to_string(),
            is_directory: entry.is_directory,
            children: Vec::new(),
        });
    }
    for entry in entries {
        let Some(relative) = entry.path.strip_prefix(prefix.as_str()) else {
            continue;
        };
        let Some((parent, child)) = relative.split_once('/') else {
            continue;
        };
        // 只列直接子项：更深层级与本地扫描的展示口径一致。
        if child.contains('/') {
            continue;
        }
        if let Some(tree_entry) = tree_entries
            .iter_mut()
            .find(|tree_entry| tree_entry.is_directory && tree_entry.name == parent)
        {
            tree_entry.children.push((child.to_string(), entry.is_directory));
        }
    }

    tree_entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.cmp(&right.name))
    });
    for tree_entry in tree_entries.iter_mut() {
        tree_entry.children.sort_by(|left, right| left.0.cmp(&right.0));
    }

    format_skill_tree(&tree_entries)
}

/// 渲染目录树文本（本地与远程技能输出格式一致）。
fn format_skill_tree(entries: &[SkillTreeEntry]) -> String {
    let mut lines = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let is_last = index + 1 == entries.len();
        let prefix = if is_last { "└─" } else { "├─" };
        let connector = if is_last { "   " } else { "│  " };

        if entry.is_directory {
            lines.push(format!("{prefix} {}/", entry.name));
            for (sub_index, (name, is_directory)) in entry.children.iter().enumerate() {
                let sub_is_last = sub_index + 1 == entry.children.len();
                let sub_prefix = if sub_is_last { "└─" } else { "├─" };
                let file_type = if *is_directory { "[DIR]" } else { "[FILE]" };
                lines.push(format!("{connector}  {sub_prefix} {file_type} {name}"));
            }
        } else {
            let file_type = if entry.name == SKILL_FILE_NAME {
                "[MAIN]"
            } else {
                "[FILE]"
            };
            lines.push(format!("{prefix} {file_type} {}", entry.name));
        }
    }

    lines.join("\n")
}
