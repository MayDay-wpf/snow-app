use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use napi::{Error, Status};
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::tools::McpTool;

const SERVER_ID: &str = "skills";
const TOOL_NAME: &str = "skill-execute";
pub const SKILL_FILE_NAME: &str = "SKILL.md";

#[derive(Clone)]
struct Skill {
    id: String,
    name: String,
    description: String,
    location: String,
    source: String,
    path: PathBuf,
    content: String,
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
        run_blocking("list available skills", move || {
            let project_root = resolve_project_root(project_id.as_deref())?;
            let skills = load_available_skills(project_root.as_deref());
            Ok(skills
                .into_values()
                .map(|skill| SkillDefinition {
                    id: skill.id,
                    name: skill.name,
                    description: skill.description,
                    location: skill.location,
                    source: skill.source,
                    path: skill.path.to_string_lossy().into_owned(),
                    allowed_tools: skill.allowed_tools,
                    enabled: skill.enabled,
                })
                .collect())
        })
        .await
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

        run_blocking("update skill enabled state", move || {
            let project_root = resolve_project_root(project_id.as_deref())?;
            let skills = load_available_skills(project_root.as_deref());
            let skill = skills.get(&skill_id).ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("Skill \"{skill_id}\" not found"),
                )
            })?;
            if skill.enabled == enabled {
                return Ok(());
            }

            update_skill_file_enabled(&skill.path, enabled)
        })
        .await
    }

    pub async fn list_project(
        &self,
        project_id: &str,
    ) -> napi::Result<Vec<ProjectSkillDefinition>> {
        let project_id = normalize_required_value(project_id, "project id")?;
        run_blocking("list project skills", move || {
            let project_root = resolve_project_root(Some(&project_id))?;
            let Some(project_root) = project_root else {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Project \"{project_id}\" does not have a workspace directory"),
                ));
            };
            let storage_info = crate::storage::initialize_app_storage()?;
            let database_path = PathBuf::from(storage_info.database_path);
            let settings =
                crate::storage::services::system_settings::get_skills_project_scope_settings(
                    &database_path,
                    &project_id,
                )?;
            let skills = load_available_skills(Some(&project_root));
            Ok(skills
                .into_values()
                .map(|skill| {
                    let enabled = settings.effective_enabled(&skill.id, skill.enabled);
                    ProjectSkillDefinition {
                        id: skill.id,
                        name: skill.name,
                        description: skill.description,
                        location: skill.location,
                        source: skill.source,
                        path: skill.path.to_string_lossy().into_owned(),
                        allowed_tools: skill.allowed_tools,
                        default_enabled: skill.enabled,
                        enabled,
                    }
                })
                .collect())
        })
        .await
    }

    pub async fn set_project_enabled(
        &self,
        project_id: &str,
        skill_id: &str,
        enabled: bool,
    ) -> napi::Result<()> {
        let project_id = normalize_required_value(project_id, "project id")?;
        let skill_id = normalize_required_skill_id(skill_id)?;
        run_blocking("update project skill enabled state", move || {
            let project_root = resolve_project_root(Some(&project_id))?;
            let Some(project_root) = project_root else {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Project \"{project_id}\" does not have a workspace directory"),
                ));
            };
            let skills = load_available_skills(Some(&project_root));
            if !skills.contains_key(&skill_id) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Skill \"{skill_id}\" not found for project \"{project_id}\""),
                ));
            }

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
        run_blocking("load skill execution tool", move || {
            let project_root = resolve_project_root(project_id.as_deref())?;
            let mut skills = load_available_skills(project_root.as_deref());
            if let Some(project_id) = project_id.as_deref() {
                let storage_info = crate::storage::initialize_app_storage()?;
                let database_path = PathBuf::from(storage_info.database_path);
                let settings = crate::storage::services::system_settings::get_skills_project_scope_settings(
                    &database_path,
                    project_id,
                )?;
                skills.retain(|skill_id, skill| {
                    settings.effective_enabled(skill_id, skill.enabled)
                });
            } else {
                skills.retain(|_, skill| skill.enabled);
            }
            if skills.is_empty() {
                return Ok(None);
            }

            Ok(Some(McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_NAME.to_string(),
                description: generate_skill_tool_description(&skills),
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
        })
        .await
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

        run_blocking("execute skill", move || {
            let project_root = resolve_project_root(project_id.as_deref())?;
            let mut skills = load_available_skills(project_root.as_deref());
            if let Some(project_id) = project_id.as_deref() {
                let storage_info = crate::storage::initialize_app_storage()?;
                let database_path = PathBuf::from(storage_info.database_path);
                let settings =
                    crate::storage::services::system_settings::get_skills_project_scope_settings(
                        &database_path,
                        project_id,
                    )?;
                skills
                    .retain(|skill_id, skill| settings.effective_enabled(skill_id, skill.enabled));
            } else {
                skills.retain(|_, skill| skill.enabled);
            }
            let skill = skills.get(&requested_skill_id).ok_or_else(|| {
                let available = if skills.is_empty() {
                    "none".to_string()
                } else {
                    skills.keys().cloned().collect::<Vec<_>>().join(", ")
                };
                Error::new(
                    Status::InvalidArg,
                    format!(
                        "Skill \"{requested_skill_id}\" not found. Available skills: {available}"
                    ),
                )
            })?;

            Ok(Value::String(render_skill(skill)))
        })
        .await
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
                format!("Failed to {operation_name}: {error}"),
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

fn resolve_project_root(project_id: Option<&str>) -> napi::Result<Option<PathBuf>> {
    let Some(project_id) = project_id else {
        return Ok(None);
    };

    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(storage_info.database_path);
    let project_path =
        crate::storage::services::workspace_directories::get_workspace_directory_path(
            &database_path,
            project_id,
        )?;
    Ok(project_path.map(PathBuf::from))
}

fn load_available_skills(project_root: Option<&Path>) -> BTreeMap<String, Skill> {
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

fn load_skills_from_directory(
    skills: &mut BTreeMap<String, Skill>,
    base_skills_dir: &Path,
    location: &str,
    source: &str,
) {
    if !base_skills_dir.is_dir() {
        return;
    }

    let mut pending_dirs = vec![base_skills_dir.to_path_buf()];
    while let Some(current_dir) = pending_dirs.pop() {
        let Ok(entries) = fs::read_dir(&current_dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let entry_name = entry.file_name().to_string_lossy().into_owned();

            if file_type.is_dir() {
                if should_skip_skill_directory(&entry_name) {
                    continue;
                }
                pending_dirs.push(entry.path());
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
                    path: skill_dir,
                    content,
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
    let line_ending = if file_content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };

    let updated_content = match frontmatter_bounds(&file_content).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Cannot update {}: {error}", file_path.to_string_lossy()),
        )
    })? {
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
    };

    fs::write(&file_path, updated_content).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write {}: {error}", file_path.to_string_lossy()),
        )
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
    let directory_tree = generate_skill_tree(&skill.path);
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
        "<command-message>The \"{}\" skill is loading</command-message>\n\n{}{}\n\n<skill-info>\nSkill Name: {}\nAbsolute Path: {}\n\nDirectory Structure:\n```\n{}/\n{}\n```\n\nNote: You can use the filesystem read tool to read any file in this skill directory using the absolute path above.\n</skill-info>",
        skill.name,
        skill.content,
        tool_restriction,
        skill.name,
        skill.path.to_string_lossy(),
        skill.name,
        directory_tree
    )
}

fn generate_skill_tree(skill_path: &Path) -> String {
    let Ok(entries) = fs::read_dir(skill_path) else {
        return "(Unable to generate directory tree)".to_string();
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_is_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let right_is_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    let mut lines = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let is_last = index + 1 == entries.len();
        let prefix = if is_last { "└─" } else { "├─" };
        let connector = if is_last { "   " } else { "│  " };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);

        if is_directory {
            lines.push(format!("{prefix} {name}/"));
            if let Ok(sub_entries) = fs::read_dir(entry.path()) {
                let mut sub_entries = sub_entries.flatten().collect::<Vec<_>>();
                sub_entries.sort_by_key(|sub_entry| sub_entry.file_name());
                for (sub_index, sub_entry) in sub_entries.iter().enumerate() {
                    let sub_is_last = sub_index + 1 == sub_entries.len();
                    let sub_prefix = if sub_is_last { "└─" } else { "├─" };
                    let sub_is_directory = sub_entry
                        .file_type()
                        .map(|kind| kind.is_dir())
                        .unwrap_or(false);
                    let file_type = if sub_is_directory { "[DIR]" } else { "[FILE]" };
                    lines.push(format!(
                        "{connector}  {sub_prefix} {file_type} {}",
                        sub_entry.file_name().to_string_lossy()
                    ));
                }
            }
        } else {
            let file_type = if name == SKILL_FILE_NAME {
                "[MAIN]"
            } else {
                "[FILE]"
            };
            lines.push(format!("{prefix} {file_type} {name}"));
        }
    }

    lines.join("\n")
}
