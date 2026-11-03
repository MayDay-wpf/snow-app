use napi::bindgen_prelude::{Error, Status};
use serde_json::Value;

use super::is_ssh_path;

pub(super) struct ConversationWorktreeBinding {
    pub path: String,
}

pub(super) async fn load_conversation_worktree_binding(
    conversation_id: String,
    directory_id: String,
) -> napi::Result<Option<ConversationWorktreeBinding>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        let Some(worktree) = crate::storage::services::git::get_conversation_worktree(
            &database_path,
            &conversation_id,
        )? else {
            return Ok(None);
        };

        if worktree.directory_id != directory_id {
            return Err(Error::new(
                Status::GenericFailure,
                "Conversation worktree binding belongs to a different project directory".to_string(),
            ));
        }
        if !worktree.is_valid {
            return Err(Error::new(
                Status::GenericFailure,
                "Conversation worktree binding is invalid or its Git worktree no longer exists".to_string(),
            ));
        }

        let reported_path = std::path::PathBuf::from(&worktree.worktree_path);
        let canonical_path = std::fs::canonicalize(&reported_path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Conversation worktree path is unavailable: {error}"),
            )
        })?;
        if !canonical_path.is_dir() {
            return Err(Error::new(
                Status::GenericFailure,
                "Conversation worktree path is not a directory".to_string(),
            ));
        }

        Ok(Some(ConversationWorktreeBinding {
            path: canonical_path.to_string_lossy().into_owned(),
        }))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to resolve conversation worktree binding: {error}"),
        )
    })?
}

pub(super) fn is_builtin_mcp_tool(tool_full_name: &str) -> bool {
    super::BUILTIN_SERVER_IDS
        .iter()
        .any(|server_id| tool_full_name.starts_with(&format!("{server_id}-")))
}

fn worktree_path_is_within(root: &std::path::Path, candidate: &std::path::Path) -> bool {
    candidate.starts_with(root)
}

/// Resolve model paths strictly beneath the canonical worktree root. Absolute
/// paths are accepted only when they name a location inside that root; `..`,
/// SSH URIs, drive/UNC paths outside the root, and symlink escapes are rejected.
fn resolve_path_inside_worktree(root: &str, requested: &str) -> napi::Result<String> {
    let root_path = std::path::Path::new(root);
    if requested.trim().is_empty() {
        return Ok(root.to_string());
    }
    if is_ssh_path(requested)
        || super::is_windows_absolute_path(requested) && !std::path::Path::new(requested).is_absolute()
    {
        return Err(Error::new(
            Status::GenericFailure,
            "WorkTree tools only accept local paths inside the bound worktree".to_string(),
        ));
    }

    let supplied = std::path::Path::new(requested);
    let relative = if supplied.is_absolute() {
        supplied.strip_prefix(root_path).map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "Requested path is outside the conversation's bound worktree".to_string(),
            )
        })?
    } else {
        supplied
    };
    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
        )
    }) {
        return Err(Error::new(
            Status::GenericFailure,
            "Parent traversal is not permitted for WorkTree tool paths".to_string(),
        ));
    }

    let candidate = root_path.join(relative);
    let canonical = if candidate.exists() {
        std::fs::canonicalize(&candidate).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to resolve WorkTree path: {error}"),
            )
        })?
    } else {
        let mut ancestor = candidate.as_path();
        let mut missing = Vec::new();
        while !ancestor.exists() {
            let name = ancestor.file_name().ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "WorkTree path has no existing parent directory".to_string(),
                )
            })?;
            missing.push(name.to_os_string());
            ancestor = ancestor.parent().ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "WorkTree path has no existing parent directory".to_string(),
                )
            })?;
        }
        let mut resolved = std::fs::canonicalize(ancestor).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to resolve WorkTree parent directory: {error}"),
            )
        })?;
        for component in missing.into_iter().rev() {
            resolved.push(component);
        }
        resolved
    };

    if !worktree_path_is_within(root_path, &canonical) {
        return Err(Error::new(
            Status::GenericFailure,
            "Resolved path escapes the conversation's bound worktree".to_string(),
        ));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

pub(super) fn force_worktree_execution_args(
    tool_full_name: &str,
    mut args: Value,
    binding: &ConversationWorktreeBinding,
) -> napi::Result<Value> {
    let root = &binding.path;
    if tool_full_name == "bash-terminal-execute" {
        if args.get("detach").and_then(Value::as_bool) == Some(true) {
            return Err(Error::new(
                Status::GenericFailure,
                "Detached bash commands are unavailable in WorkTree mode because their writes could outlive the shared execution lock".to_string(),
            ));
        }
        args["workingDirectory"] = Value::String(root.clone());
    } else if tool_full_name == "terminal-open" {
        args["cwd"] = Value::String(root.clone());
    } else if tool_full_name == "terminal-send" {
        // PTYs are persistent and are not owned by a conversation/worktree in
        // the terminal bridge. Refuse sending commands to an arbitrary tab.
        return Err(Error::new(
            Status::GenericFailure,
            "WorkTree terminal-send is unavailable because terminal tabs are not bound to a conversation/worktree; use bash-terminal-execute for serialized WorkTree commands".to_string(),
        ));
    } else if tool_full_name == "grep-search" || tool_full_name == "grep-find" {
        let requested = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(root);
        args["path"] = Value::String(resolve_path_inside_worktree(root, requested)?);
    } else if tool_full_name.starts_with("filesystem-") {
        for field in ["filePath", "sourceFilePath"] {
            if let Some(requested) = args.get(field).and_then(Value::as_str) {
                args[field] = Value::String(resolve_path_inside_worktree(root, requested)?);
            }
        }
        if args.get("filePath").and_then(Value::as_str).is_none() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("filePath is required for {tool_full_name}"),
            ));
        }
        if tool_full_name == "filesystem-copy"
            && args.get("sourceFilePath").and_then(Value::as_str).is_none()
        {
            return Err(Error::new(
                Status::InvalidArg,
                "sourceFilePath is required for filesystem-copy".to_string(),
            ));
        }
    } else if tool_full_name.starts_with("lsp-") {
        if matches!(
            tool_full_name,
            "lsp-workspace-diagnostics"
                | "lsp-workspace-symbols"
                | "lsp-vulncheck"
                | "lsp-execute-command"
        ) || (tool_full_name == "lsp-rename"
            && args.get("dryRun").and_then(Value::as_bool) == Some(false))
            || (tool_full_name == "lsp-code-action"
                && args.get("apply").and_then(Value::as_bool) == Some(true))
        {
            return Err(Error::new(
                Status::GenericFailure,
                "This LSP operation cannot be safely scoped to a conversation worktree".to_string(),
            ));
        }
        if let Some(requested) = args.get("filePath").and_then(Value::as_str) {
            args["filePath"] = Value::String(resolve_path_inside_worktree(root, requested)?);
        }
        if let Some(paths) = args.get("filePaths").and_then(Value::as_array) {
            let resolved = paths
                .iter()
                .map(|path| {
                    let requested = path.as_str().ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "Every filePaths entry must be a string".to_string(),
                        )
                    })?;
                    resolve_path_inside_worktree(root, requested).map(Value::String)
                })
                .collect::<napi::Result<Vec<_>>>()?;
            args["filePaths"] = Value::Array(resolved);
        }
    }

    // Prevent a PTY-open call from carrying an attacker/model-supplied cwd even
    // when the command name is normalized through an alias.
    if tool_full_name == "terminal-open" {
        args["cwd"] = Value::String(root.clone());
    }
    Ok(args)
}

