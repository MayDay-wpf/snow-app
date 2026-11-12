//! SSH 工作区内的技能远程操作。
//!
//! Rust 侧不做 SSH IO：技能目录上传/删除、技能根目录扫描与 SKILL.md 回写都通过
//! `RemoteWorkspaceCallback` 转发给 Electron 主进程（SFTP / exec）执行。
//! `skills`（列表 / 执行 / 启停）与 `skills_installer`（安装 / 卸载）共用本模块，
//! 保证远程技能的目录发现与写入语义只有一套实现。

use std::collections::HashMap;
use std::path::Path;

use napi::{Error, Status};
use serde_json::{json, Value};

use snow_storage::remote_host::{execute_remote_workspace_command, global_remote_callback};

/// 远程技能根目录在项目工作区内的相对位置与来源标识（与本地扫描的 source 一致）。
const SKILL_ROOT_DIRECTORIES: [(&str, &str); 2] =
    [(".agents/skills", "agents"), (".snow/skills", "snow")];

/// 远程技能目录树中的一个条目（相对技能根目录的 POSIX 路径）。
pub struct RemoteSkillEntry {
    pub path: String,
    pub is_directory: bool,
}

/// 一个远程技能根目录的扫描结果。
pub struct RemoteSkillRoot {
    /// 根目录的 `ssh://` URI。
    pub uri: String,
    /// 技能来源标识：`agents` 或 `snow`。
    pub source: String,
    /// 根目录下的完整条目列表（目录不递归展开，条目自带路径）。
    pub entries: Vec<RemoteSkillEntry>,
    /// SKILL.md 相对路径 -> 文件原文。
    pub skill_files: HashMap<String, String>,
}

/// 转发一条远程技能命令。Electron 侧把连接级失败封装成 `{ success: false, error }`，
/// 必须上抛，否则失败会被当成成功（列表会静默变空、安装会误报成功）。
async fn run_remote_skill_command(operation: &str, args: Value) -> napi::Result<Value> {
    let callback = global_remote_callback().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "SSH remote channel is not available; remote Skill operations require an SSH workspace"
                .to_string(),
        )
    })?;
    let result = execute_remote_workspace_command(&callback, operation, &args, None)
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Remote Skill operation \"{operation}\" failed: {error}"),
            )
        })?;
    if result.get("success") == Some(&Value::Bool(false)) {
        let message = result
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("unknown SSH error");
        return Err(Error::new(
            Status::GenericFailure,
            format!("Remote Skill operation \"{operation}\" failed: {message}"),
        ));
    }
    Ok(result)
}

/// 把本地技能目录上传到远程工作区，并原子替换目标目录。
pub async fn install_remote_skill_dir(
    workspace: &str,
    destination: &str,
    source_dir: &Path,
) -> napi::Result<()> {
    run_remote_skill_command(
        "skills-install-dir",
        json!({
            "workspaceRoot": workspace,
            "path": destination,
            "sourceDir": source_dir.to_string_lossy(),
        }),
    )
    .await?;
    Ok(())
}

/// 删除远程工作区内的技能目录（卸载或安装回滚）。
pub async fn remove_remote_skill_dir(workspace: &str, destination: &str) -> napi::Result<()> {
    run_remote_skill_command(
        "skills-remove-dir",
        json!({ "workspaceRoot": workspace, "path": destination }),
    )
    .await?;
    Ok(())
}

/// 回写远程 SKILL.md（项目技能的 `enable` 开关）。
pub async fn write_remote_skill_file(
    workspace: &str,
    file_uri: &str,
    content: &str,
) -> napi::Result<()> {
    run_remote_skill_command(
        "skills-write-file",
        json!({ "workspaceRoot": workspace, "path": file_uri, "content": content }),
    )
    .await?;
    Ok(())
}

/// 扫描远程项目工作区内的技能根目录（`.agents/skills` 与 `.snow/skills`）。
pub async fn scan_remote_skill_roots(workspace: &str) -> napi::Result<Vec<RemoteSkillRoot>> {
    let base = workspace.trim_end_matches('/');
    let requests: Vec<(String, &str)> = SKILL_ROOT_DIRECTORIES
        .iter()
        .map(|(relative, source)| (format!("{base}/{relative}"), *source))
        .collect();
    let paths: Vec<&str> = requests.iter().map(|(uri, _)| uri.as_str()).collect();

    let result = run_remote_skill_command(
        "skills-scan",
        json!({ "workspaceRoot": workspace, "paths": paths }),
    )
    .await?;

    let response_roots = result.get("roots").and_then(Value::as_array);
    Ok(requests
        .into_iter()
        .map(|(uri, source)| {
            let root = response_roots
                .and_then(|roots| {
                    roots.iter().find(|root| {
                        root.get("path").and_then(Value::as_str) == Some(uri.as_str())
                    })
                });
            match root {
                Some(root) => parse_remote_skill_root(root, uri, source),
                // 根目录不存在时 Electron 返回空结果；缺失条目按空目录处理。
                None => RemoteSkillRoot {
                    uri,
                    source: source.to_string(),
                    entries: Vec::new(),
                    skill_files: HashMap::new(),
                },
            }
        })
        .collect())
}

fn parse_remote_skill_root(root: &Value, uri: String, source: &str) -> RemoteSkillRoot {
    let entries = root
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let path = entry.get("path").and_then(Value::as_str)?.to_string();
                    let is_directory = entry.get("type").and_then(Value::as_str) == Some("d");
                    Some(RemoteSkillEntry {
                        path,
                        is_directory,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let skill_files = root
        .get("files")
        .and_then(Value::as_object)
        .map(|files| {
            files
                .iter()
                .filter_map(|(path, content)| {
                    Some((path.clone(), content.as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    RemoteSkillRoot {
        uri,
        source: source.to_string(),
        entries,
        skill_files,
    }
}
