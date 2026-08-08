use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::exports::terminal::{load_terminal_shell_path, resolve_shell_and_args};
use crate::storage::services::app_logs;
use crate::storage::services::hooks_configs;

const DEFAULT_TIMEOUT_MS: u64 = 5_000;

#[napi(object)]
pub struct HookExecuteInput {
    pub hook_type: String,
    pub project_id: Option<String>,
    /// JSON string of the context object passed to hook actions
    pub context_json: String,
}

#[napi(object)]
pub struct HookActionResultRecord {
    pub action_type: String,
    pub success: bool,
    pub command: Option<String>,
    pub exit_code: Option<i32>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub additional_context: Option<String>,
}

#[napi(object)]
pub struct HookExecuteResult {
    pub success: bool,
    pub results: Vec<HookActionResultRecord>,
    pub executed_actions: i32,
    pub skipped_actions: i32,
    /// When a command exits with code 1, the hook signals a soft warning
    /// and the output/error should replace or warn the caller.
    pub soft_signal: Option<bool>,
    /// When a command exits with code >= 2, the hook blocks the action.
    pub blocked: Option<bool>,
    pub block_message: Option<String>,
    /// When true, the soft-warning hook returned a decision JSON on stdout
    /// and the caller must prompt the user to approve or reject the action.
    pub requires_decision: Option<bool>,
    /// The human-readable message extracted from the decision JSON's
    /// `decision.message` field. Present only when `requires_decision` is true.
    pub decision_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct HookActionDef {
    r#type: String,
    command: Option<String>,
    prompt: Option<String>,
    content: Option<String>,
    timeout: Option<u64>,
    enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct HookRuleDef {
    matcher: Option<String>,
    description: String,
    hooks: Vec<HookActionDef>,
}

impl Default for HookActionDef {
    fn default() -> Self {
        Self {
            r#type: String::new(),
            command: None,
            prompt: None,
            content: None,
            timeout: None,
            enabled: None,
        }
    }
}

impl Default for HookRuleDef {
    fn default() -> Self {
        Self {
            matcher: None,
            description: String::new(),
            hooks: Vec::new(),
        }
    }
}

pub async fn execute_hooks(
    database_path: &Path,
    input: &HookExecuteInput,
) -> Result<HookExecuteResult> {
    let hook_type = input.hook_type.trim();
    if hook_type.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Hook type is required".to_string(),
        ));
    }

    let context: Value = if input.context_json.trim().is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(&input.context_json).map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("Hook context JSON is invalid: {error}"),
            )
        })?
    };

    let project_id = input
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let rules = load_effective_rules(database_path, hook_type, project_id)?;

    let mut results: Vec<HookActionResultRecord> = Vec::new();
    let mut executed = 0i32;
    let mut skipped = 0i32;
    let mut soft_signal = false;
    let mut blocked = false;
    let mut block_message: Option<String> = None;
    let mut requires_decision = false;
    let mut decision_message: Option<String> = None;

    for rule in &rules {
        if !match_rule(rule, &context) {
            skipped += rule.hooks.len() as i32;
            continue;
        }

        for action in &rule.hooks {
            if action.enabled != Some(true) {
                skipped += 1;
                continue;
            }

            let result = execute_action(action, &context).await?;
            executed += 1;

            let is_soft = matches!(&result.action_type.as_str(), t if *t == "command")
                && !result.success
                && result.exit_code == Some(1);
            let is_hard = matches!(&result.action_type.as_str(), t if *t == "command")
                && !result.success
                && result
                    .exit_code
                    .map(|code| code >= 2 || code < 0)
                    .unwrap_or(false);

            if is_soft {
                soft_signal = true;
                // Check if the stdout contains a decision JSON.  When a hook
                // command exits with code 1 and its stdout parses as JSON with
                // a `decision` object containing a `message` field, the caller
                // must prompt the user to approve or reject the action.
                if let Some(ref output) = result.output {
                    if let Ok(parsed) = serde_json::from_str::<Value>(output) {
                        if let Some(decision) = parsed.get("decision") {
                            if let Some(msg) = decision.get("message").and_then(Value::as_str) {
                                requires_decision = true;
                                decision_message = Some(msg.to_string());
                            }
                        }
                    }
                }
                // Write a hook warning log for exit-code-1 commands.
                // The warning does not block the action but is recorded for diagnostics.
                // Uses spawn_blocking internally so the async path is not blocked.
                app_logs::log_hook_warning(
                    database_path.to_path_buf(),
                    hook_type.to_string(),
                    result.command.clone().unwrap_or_default(),
                    result.exit_code.unwrap_or(1),
                    result.output.clone(),
                    result.error.clone(),
                    Some(input.context_json.clone()),
                )
                .await;
            }

            if is_hard {
                blocked = true;
                block_message = result
                    .error
                    .clone()
                    .or_else(|| result.output.clone())
                    .or_else(|| Some("Hook blocked the action".to_string()));
                results.push(result);
                break;
            }

            results.push(result);
        }

        if blocked {
            break;
        }
    }

    Ok(HookExecuteResult {
        success: !blocked,
        results,
        executed_actions: executed,
        skipped_actions: skipped,
        soft_signal: if soft_signal { Some(true) } else { None },
        blocked: if blocked { Some(true) } else { None },
        block_message,
        requires_decision: if requires_decision { Some(true) } else { None },
        decision_message,
    })
}

fn load_effective_rules(
    database_path: &Path,
    hook_type: &str,
    project_id: Option<&str>,
) -> Result<Vec<HookRuleDef>> {
    let project_rules = if let Some(pid) = project_id {
        let configs = hooks_configs::list_hook_configs(database_path, "project", Some(pid))?;
        find_rules_for_hook(&configs, hook_type)
    } else {
        Vec::new()
    };

    if !project_rules.is_empty() {
        return Ok(project_rules);
    }

    let global_configs = hooks_configs::list_hook_configs(database_path, "global", None)?;
    Ok(find_rules_for_hook(&global_configs, hook_type))
}

fn find_rules_for_hook(
    configs: &[crate::storage::HookConfigRecord],
    hook_type: &str,
) -> Vec<HookRuleDef> {
    configs
        .iter()
        .find(|record| record.hook_type == hook_type)
        .and_then(|record| serde_json::from_str::<Vec<HookRuleDef>>(&record.rules_json).ok())
        .unwrap_or_default()
}

fn match_rule(rule: &HookRuleDef, context: &Value) -> bool {
    let matcher = match rule.matcher.as_deref() {
        Some(m) if !m.trim().is_empty() => m.trim(),
        _ => return true,
    };

    let matchers: Vec<&str> = matcher
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if matchers.is_empty() {
        return true;
    }

    for single in matchers {
        if check_single_matcher(single, context) {
            return true;
        }
    }

    false
}

fn check_single_matcher(matcher: &str, context: &Value) -> bool {
    if let Some((key, pattern)) = matcher.split_once(':') {
        let value = context.get(key);
        if let Some(val) = value {
            return match_pattern(pattern, &value_to_string(val));
        }
        return false;
    }

    if let Some(tool_name) = context.get("toolName") {
        return match_pattern(matcher, &value_to_string(tool_name));
    }

    let context_str = serde_json::to_string(context).unwrap_or_default();
    context_str.contains(matcher)
}

fn match_pattern(pattern: &str, value: &str) -> bool {
    let escaped: String = pattern
        .chars()
        .map(|c| {
            if ".+?^${}()|[]\\".contains(c) {
                format!("\\{c}")
            } else if c == '*' {
                ".*".to_string()
            } else {
                c.to_string()
            }
        })
        .collect();

    let full_pattern = format!("^{}$", escaped);
    Regex::new(&full_pattern)
        .map(|regex| regex.is_match(value))
        .unwrap_or(false)
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => value.to_string(),
    }
}

async fn execute_action(action: &HookActionDef, context: &Value) -> Result<HookActionResultRecord> {
    match action.r#type.as_str() {
        "command" => execute_command_action(action, context).await,
        "context" => execute_context_action(action),
        "prompt" => {
            // Prompt hooks require an AI model call which is not available in the
            // Rust backend.  Return a soft skip so the caller can handle it.
            Ok(HookActionResultRecord {
                action_type: "prompt".to_string(),
                success: false,
                command: None,
                exit_code: None,
                output: None,
                error: Some("Prompt hooks are not supported in the native executor".to_string()),
                additional_context: None,
            })
        }
        _ => Err(Error::new(
            Status::InvalidArg,
            format!("Unknown hook action type: {}", action.r#type),
        )),
    }
}

async fn execute_command_action(
    action: &HookActionDef,
    context: &Value,
) -> Result<HookActionResultRecord> {
    let command = action.command.as_deref().unwrap_or("").trim();
    if command.is_empty() {
        return Ok(HookActionResultRecord {
            action_type: "command".to_string(),
            success: false,
            command: Some(String::new()),
            exit_code: None,
            output: None,
            error: Some("Empty command".to_string()),
            additional_context: None,
        });
    }

    let timeout = action.timeout.unwrap_or(DEFAULT_TIMEOUT_MS);
    let cwd = context
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let stdin_data =
        if context.is_object() && !context.as_object().map(|m| m.is_empty()).unwrap_or(true) {
            Some(serde_json::to_string(context).unwrap_or_default())
        } else {
            None
        };

    // 复用终端设置：读取 system_settings.terminal_settings 的 shellPath，
    // 按 shell family 构造启动参数（PowerShell 注入 UTF-8 编码、cmd 带 chcp 65001，
    // WSL 用 --cd 传递工作目录 + bash -lc 加载 Linux PATH），
    // 避免硬编码 cmd /C 导致的中文路径乱码问题。
    let shell_path = load_terminal_shell_path().await?;
    let cwd_str = cwd.as_deref().and_then(Path::to_str);
    let (shell, shell_args) = resolve_shell_and_args(&shell_path, command, cwd_str).await?;

    let mut shell_command = Command::new(&shell);
    shell_command
        .args(&shell_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8");

    if let Some(ref dir) = cwd {
        shell_command.current_dir(dir);
    }

    // Windows 下避免 spawn 子进程时弹出控制台窗口闪烁
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        shell_command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = shell_command.spawn().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to spawn hook command: {error}"),
        )
    })?;

    if let Some(data) = &stdin_data {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(data.as_bytes()).await;
        }
    }

    drop(child.stdin.take());

    let wait_result = match tokio::time::timeout(Duration::from_millis(timeout), child.wait()).await
    {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(Error::new(
            Status::GenericFailure,
            format!("Hook command execution failed: {error}"),
        )),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(Error::new(
                Status::GenericFailure,
                format!("Hook command timed out after {timeout}ms"),
            ))
        }
    };

    let output = match wait_result {
        Ok(status) => {
            // 读取 stdout/stderr 需要先 take 出来
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let stdout_data = match stdout {
                Some(mut s) => {
                    use tokio::io::AsyncReadExt;
                    let mut buf = Vec::new();
                    let _ = s.read_to_end(&mut buf).await;
                    buf
                }
                None => Vec::new(),
            };
            let stderr_data = match stderr {
                Some(mut s) => {
                    use tokio::io::AsyncReadExt;
                    let mut buf = Vec::new();
                    let _ = s.read_to_end(&mut buf).await;
                    buf
                }
                None => Vec::new(),
            };
            (status, stdout_data, stderr_data)
        }
        Err(err) => return Err(err),
    };

    let (status, stdout_bytes, stderr_bytes) = output;
    let exit_code = status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();

    let success = exit_code == 0;
    let additional_context = if success && !stdout.is_empty() {
        extract_additional_context(&stdout)
    } else {
        None
    };

    Ok(HookActionResultRecord {
        action_type: "command".to_string(),
        success,
        command: Some(command.to_string()),
        exit_code: Some(exit_code),
        output: if stdout.is_empty() {
            None
        } else {
            Some(stdout)
        },
        error: if stderr.is_empty() {
            None
        } else {
            Some(stderr)
        },
        additional_context,
    })
}

fn execute_context_action(action: &HookActionDef) -> Result<HookActionResultRecord> {
    let content = action.content.as_deref().unwrap_or("").trim();
    if content.is_empty() {
        return Ok(HookActionResultRecord {
            action_type: "context".to_string(),
            success: false,
            command: None,
            exit_code: None,
            output: None,
            error: Some("Empty context content".to_string()),
            additional_context: None,
        });
    }

    let additional_context = if let Ok(parsed) = serde_json::from_str::<Value>(content) {
        if let Some(ctx) = parsed.get("additionalContext").and_then(Value::as_str) {
            Some(ctx.to_string())
        } else if let Some(ctx) = parsed.get("prompt").and_then(Value::as_str) {
            Some(ctx.to_string())
        } else {
            Some(content.to_string())
        }
    } else {
        Some(content.to_string())
    };

    Ok(HookActionResultRecord {
        action_type: "context".to_string(),
        success: true,
        command: None,
        exit_code: None,
        output: None,
        error: None,
        additional_context,
    })
}

fn extract_additional_context(output: &str) -> Option<String> {
    if let Ok(parsed) = serde_json::from_str::<Value>(output) {
        if let Some(ctx) = parsed.get("additionalContext").and_then(Value::as_str) {
            return Some(ctx.to_string());
        }
        if let Some(ctx) = parsed.get("prompt").and_then(Value::as_str) {
            return Some(ctx.to_string());
        }
    }
    Some(output.to_string())
}
