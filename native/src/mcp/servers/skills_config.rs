//! Internal skill-management service backing the `config` server's `skills`
//! scope. Not registered as a standalone built-in MCP server; `config`
//! delegates its `skills` scope here so the storage semantics stay identical
//! to the UI (global toggle = SKILL.md frontmatter, project toggle = app DB
//! override, install/uninstall = ~/.snow/skills directories +
//! skills-registry.json).
//!
//! Internal tools:
//! - `list`            — list available skills + GitHub-installed records
//! - `setEnabled`      — toggle a skill (global frontmatter or project DB override)
//! - `installGithub`   — install skill(s) from a GitHub repository
//! - `uninstall`       — uninstall a GitHub-installed skill
//!
//! The implementation reuses the exact same native entry points as the UI
//! (SkillsService + skills_installer), so the agent and the UI always agree
//! on the effective state.

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::skills::SkillsService;
use super::skills_installer::{
    install_skill_from_github, list_github_skills, uninstall_github_skill,
};

const TOOL_LIST: &str = "list";
const TOOL_SET_ENABLED: &str = "setEnabled";
const TOOL_INSTALL_GITHUB: &str = "installGithub";
const TOOL_UNINSTALL: &str = "uninstall";

pub struct SkillsConfigService;

impl SkillsConfigService {
    pub fn new() -> Self {
        Self
    }

    /// Async entry point used by `call_mcp_tool` in tools.rs.
    ///
    /// Every underlying operation (`SkillsService::*`, `skills_installer::*`)
    /// is itself async and already moves blocking work onto the blocking pool,
    /// so no extra `spawn_blocking` wrapper is needed here.
    pub async fn execute_async(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_LIST => self.execute_list(args).await,
            TOOL_SET_ENABLED => self.execute_set_enabled(args).await,
            TOOL_INSTALL_GITHUB => self.execute_install_github(args).await,
            TOOL_UNINSTALL => self.execute_uninstall(args).await,
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{tool_name}\" for skills management. Available tools: [list, setEnabled, installGithub, uninstall]"
                ),
            )),
        }
    }

    /// List available skills plus GitHub-installed records.
    ///
    /// - Without `projectId`: global view. `enabled` is the SKILL.md
    ///   frontmatter `enable` field (the file is the source of truth).
    /// - With `projectId`: project-scoped view. Skills are merged from the
    ///   four scan directories (~/.agents/skills → ~/.snow/skills →
    ///   <project>/.agents/skills → <project>/.snow/skills, higher priority
    ///   wins); `enabled` is the effective state (project DB override >
    ///   frontmatter) and `defaultEnabled` is the frontmatter value.
    async fn execute_list(&self, args: &Value) -> napi::Result<Value> {
        let project_id = optional_string(args, "projectId")?;

        let skills: Vec<Value> = if let Some(project_id) = &project_id {
            SkillsService::new()
                .list_project(project_id)
                .await?
                .into_iter()
                .map(|skill| {
                    json!({
                        "id": skill.id,
                        "name": skill.name,
                        "description": skill.description,
                        "location": skill.location,
                        "source": skill.source,
                        "path": skill.path,
                        "allowedTools": skill.allowed_tools,
                        "defaultEnabled": skill.default_enabled,
                        "enabled": skill.enabled,
                    })
                })
                .collect()
        } else {
            SkillsService::new()
                .list_available(None)
                .await?
                .into_iter()
                .map(|skill| {
                    json!({
                        "id": skill.id,
                        "name": skill.name,
                        "description": skill.description,
                        "location": skill.location,
                        "source": skill.source,
                        "path": skill.path,
                        "allowedTools": skill.allowed_tools,
                        "enabled": skill.enabled,
                    })
                })
                .collect()
        };

        let github_installed: Vec<Value> = list_github_skills()
            .await?
            .into_iter()
            .map(|record| {
                json!({
                    "id": record.id,
                    "name": record.name,
                    "description": record.description,
                    "location": record.location,
                    "sourceUrl": record.source_url,
                    "installedAt": record.installed_at,
                    "commitSha": record.commit_sha,
                })
            })
            .collect();

        Ok(json!({
            "projectId": project_id,
            "skills": skills,
            "githubInstalled": github_installed,
        }))
    }

    /// Enable or disable a skill.
    ///
    /// - Without `projectId`: global toggle. Writes the `enable` field in the
    ///   SKILL.md frontmatter (same file rewrite as the UI toggle). Note the
    ///   frontmatter field name is `enable`, not `enabled`.
    /// - With `projectId`: project-scope toggle. Writes a DB override in the
    ///   app database (`skill_overrides`), which takes effect immediately and
    ///   takes precedence over the frontmatter value.
    async fn execute_set_enabled(&self, args: &Value) -> napi::Result<Value> {
        let project_id = optional_string(args, "projectId")?;
        let skill_id = required_string(args, "skillId")?;
        let enabled = required_bool(args, "enabled")?;

        match &project_id {
            Some(project_id) => {
                SkillsService::new()
                    .set_project_enabled(project_id, &skill_id, enabled)
                    .await?;
                Ok(json!({
                    "skillId": skill_id,
                    "projectId": project_id,
                    "scope": "project",
                    "enabled": enabled,
                    "method": "db-override",
                }))
            }
            None => {
                SkillsService::new()
                    .set_enabled(None, &skill_id, enabled)
                    .await?;
                Ok(json!({
                    "skillId": skill_id,
                    "projectId": null,
                    "scope": "global",
                    "enabled": enabled,
                    "method": "frontmatter",
                }))
            }
        }
    }

    /// Install skill(s) from a GitHub repository.
    ///
    /// `url` accepts `https://github.com/owner/repo`, the `owner/repo`
    /// shorthand, optional `@branch` and `:sub/dir` suffixes. `location` must
    /// be `global` (~/.snow/skills) or `project` (<project>/.snow/skills,
    /// requires `projectId`). Metadata is recorded in
    /// `~/.snow/skills-registry.json` so the config skills scope can remove
    /// the skill later.
    async fn execute_install_github(&self, args: &Value) -> napi::Result<Value> {
        let url = required_string(args, "url")?;
        let location = required_string(args, "location")?;
        if location != "global" && location != "project" {
            return Err(Error::new(
                Status::InvalidArg,
                format!("location must be \"global\" or \"project\", got \"{location}\""),
            ));
        }
        let project_id = optional_string(args, "projectId")?;

        let result = install_skill_from_github(url, location, project_id.clone()).await?;
        let results: Vec<Value> = result
            .results
            .into_iter()
            .map(|entry| {
                json!({
                    "success": entry.success,
                    "skillId": entry.skill_id,
                    "path": entry.path,
                    "installedAt": entry.installed_at,
                    "commitSha": entry.commit_sha,
                    "error": entry.error,
                })
            })
            .collect();

        Ok(json!({
            "success": result.success,
            "results": results,
            "installedCount": result.installed_count,
            "totalCount": result.total_count,
            "commitSha": result.commit_sha,
            "error": result.error,
        }))
    }

    /// Uninstall a skill that was installed from GitHub.
    ///
    /// Only skills recorded in `~/.snow/skills-registry.json` can be removed
    /// this way; manually placed or app-bundled skills are rejected (delete
    /// their directory instead).
    async fn execute_uninstall(&self, args: &Value) -> napi::Result<Value> {
        let skill_id = required_string(args, "skillId")?;
        let project_id = optional_string(args, "projectId")?;

        let result = uninstall_github_skill(skill_id, project_id.clone()).await?;
        Ok(json!({
            "success": result.success,
            "skillId": result.skill_id,
            "message": result.message,
            "error": result.error,
        }))
    }
}

fn optional_string(args: &Value, key: &str) -> napi::Result<Option<String>> {
    Ok(args
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

fn required_string(args: &Value, key: &str) -> napi::Result<String> {
    optional_string(args, key)?
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("{key} is required")))
}

fn required_bool(args: &Value, key: &str) -> napi::Result<bool> {
    args.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("{key} is required")))
}
