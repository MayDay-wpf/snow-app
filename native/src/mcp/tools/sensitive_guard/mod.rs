//! 敏感操作统一守卫。
//!
//! 所有能执行命令、或改写「之后会被执行的配置」的工具入口都经过这里：
//! - bash 命令（`bash-terminal-execute`，在执行器内部自我保护检查之后调用）；
//! - 终端 PTY 输入（`terminal-send`）与 computer-use 键入文本；
//! - config-manage（action=set）写入 hooks 命令、定时任务前置脚本、MCP stdio 启动命令；
//! - config-manage（action=set / delete）修改敏感规则本身（不看规则命中，每次都要确认）。
//!
//! 命中时必须携带一次性授权令牌：令牌只在用户确认（或决策模型托管放行）后由
//! 主进程签发，绑定到本模块算出的「操作主体」文本，模型无法伪造或挪用。
//!
//! 检查过程出错一律按命中处理（fail-closed）：宁可多弹一次确认，也不静默放行。

mod scripts;

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use self::scripts::{collect_script_sources, ScriptSource};
use crate::mcp::builtin::sanitize_tool_full_name;
use crate::mcp::servers::app_control::decode_config_value;
use crate::storage::{SensitiveCommandMatchResult, SensitiveOperationCheckRecord};

/// 授权令牌有效期：用户确认到工具真正执行之间的窗口。
const AUTHORIZATION_TTL: Duration = Duration::from_secs(60);

/// 内置判定的规则 ID（`snow:` 前缀，渲染层据此本地化展示，不会与用户规则冲突）。
const CHECK_FAILED_RULE_ID: &str = "snow:check-failed";
const SCRIPT_UNREADABLE_RULE_ID: &str = "snow:script-unreadable";
const PROTECTED_RULES_RULE_ID: &str = "snow:protected-rules";

#[derive(Clone, Copy, PartialEq, Eq)]
enum SubjectKind {
    /// 会被执行的命令文本（bash / 终端输入 / 键入文本），可交给决策模型判定。
    Command,
    /// 写入之后会被执行的配置（hooks 命令、定时任务前置脚本、MCP 启动命令）。
    Config,
    /// 修改敏感规则本身：不看规则命中，每次都必须由用户确认。
    Protected,
}

impl SubjectKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Config => "config",
            Self::Protected => "protected",
        }
    }
}

struct SensitiveSubject {
    kind: SubjectKind,
    /// 令牌绑定与拦截提示展示的文本。
    text: String,
}

struct SensitiveCheck {
    subject: SensitiveSubject,
    matches: Vec<SensitiveCommandMatchResult>,
}

struct Authorization {
    subject: String,
    expires_at: Instant,
}

static AUTHORIZATIONS: OnceLock<tokio::sync::Mutex<HashMap<String, Authorization>>> =
    OnceLock::new();

fn authorizations() -> &'static tokio::sync::Mutex<HashMap<String, Authorization>> {
    AUTHORIZATIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// 用户确认（或决策模型托管放行）后由主进程登记授权令牌，绑定操作主体文本。
pub async fn authorize_sensitive_operation(subject: String, token: String) -> napi::Result<()> {
    if subject.trim().is_empty() || token.trim().is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Sensitive operation subject and authorization token are required".to_string(),
        ));
    }

    let now = Instant::now();
    let mut authorizations = authorizations().lock().await;
    authorizations.retain(|_, authorization| authorization.expires_at > now);
    authorizations.insert(
        token,
        Authorization {
            subject,
            expires_at: now + AUTHORIZATION_TTL,
        },
    );
    Ok(())
}

/// 消费令牌：一次有效，且必须与本次执行的操作主体完全一致。
async fn consume_authorization(subject: &str, token: Option<&str>) -> bool {
    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return false;
    };

    let now = Instant::now();
    let mut authorizations = authorizations().lock().await;
    authorizations.retain(|_, authorization| authorization.expires_at > now);
    authorizations
        .remove(token)
        .map(|authorization| authorization.subject == subject && authorization.expires_at > now)
        .unwrap_or(false)
}

/// 执行前的统一闸门：命中规则（含检查出错、脚本无法检查、修改敏感规则）且没有
/// 匹配的授权令牌时拒绝执行，错误负载为 `SENSITIVE_COMMAND_DETECTED` JSON。
pub(crate) async fn enforce(
    tool_full_name: &str,
    args: &Value,
    project_id: Option<&str>,
    token: Option<&str>,
) -> napi::Result<()> {
    let Some(check) = inspect(tool_full_name, args, project_id).await else {
        return Ok(());
    };
    if check.matches.is_empty() || consume_authorization(&check.subject.text, token).await {
        return Ok(());
    }

    let matches: Vec<Value> = check
        .matches
        .iter()
        .map(|item| {
            json!({
                "commandId": item.command_id,
                "pattern": item.pattern,
                "description": item.description,
            })
        })
        .collect();
    Err(Error::new(
        Status::GenericFailure,
        json!({
            "error": "SENSITIVE_COMMAND_DETECTED",
            "message": "Operation matched a sensitive command rule and requires user confirmation",
            "kind": check.subject.kind.as_str(),
            "subject": check.subject.text,
            "matches": matches,
        })
        .to_string(),
    ))
}

/// 渲染层授权前的预检查：与执行侧 `enforce` 使用同一套主体解析与匹配，拦截提示
/// 展示的就是执行时校验的内容。未命中返回 None。
pub async fn check_tool_call(
    tool_name: String,
    args_json: String,
    project_id: Option<String>,
) -> Option<SensitiveOperationCheckRecord> {
    let tool_full_name = sanitize_tool_full_name(&tool_name);
    // 参数不是合法 JSON 时工具本身会在执行时报错，这里无需拦截。
    let args = serde_json::from_str::<Value>(&args_json).ok()?;
    // bash 未填 workingDirectory 时执行侧会兜底为项目目录，脚本相对路径按同一目录解析。
    let args = match super::default_bash_working_directory(
        &tool_full_name,
        args.clone(),
        project_id.as_deref(),
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(_) => args,
    };
    let check = inspect(&tool_full_name, &args, project_id.as_deref()).await?;
    if check.matches.is_empty() {
        return None;
    }
    Some(SensitiveOperationCheckRecord {
        subject: check.subject.text,
        kind: check.subject.kind.as_str().to_string(),
        matches: check.matches,
    })
}

async fn inspect(
    tool_full_name: &str,
    args: &Value,
    project_id: Option<&str>,
) -> Option<SensitiveCheck> {
    let subject = resolve_subject(tool_full_name, args)?;
    let kind = subject.kind;
    let working_directory = match kind {
        SubjectKind::Protected => None,
        _ if tool_full_name == "bash-terminal-execute" => args
            .get("workingDirectory")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
            .map(str::to_string),
        // 终端输入、键入文本与配置里的相对脚本路径按项目根目录解析。
        _ => match super::resolve_local_project_root(project_id).await {
            Ok(root) => root,
            Err(error) => {
                return Some(SensitiveCheck {
                    subject,
                    matches: vec![check_failed(&error.reason)],
                })
            }
        },
    };
    let matches = match_rules(&subject, working_directory, project_id).await;
    Some(SensitiveCheck { subject, matches })
}

fn resolve_subject(tool_full_name: &str, args: &Value) -> Option<SensitiveSubject> {
    let text = match tool_full_name {
        "bash-terminal-execute" => args
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        // 终端两种输入模式：input 文本；keys 中未知的按键名会原样作为文本发送。
        "terminal-send" => match args.get("input").and_then(Value::as_str) {
            Some(input) => Some(input.to_string()),
            None => join_strings(args.get("keys")),
        },
        // computer-use：type 动作的 text，以及 steps 里所有 type 步骤的文本。
        "computer-use-act" => match args.get("action").and_then(Value::as_str) {
            Some("type") => args.get("text").and_then(Value::as_str).map(str::to_string),
            Some("steps") => typed_action_text(args),
            _ => None,
        },
        "config-manage" => return config_subject(tool_full_name, args),
        _ => None,
    }?;
    (!text.trim().is_empty()).then_some(SensitiveSubject {
        kind: SubjectKind::Command,
        text,
    })
}

fn join_strings(value: Option<&Value>) -> Option<String> {
    let parts: Vec<&str> = value?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// perform-actions 中所有 `type` 步骤键入的文本。
fn typed_action_text(args: &Value) -> Option<String> {
    let parts: Vec<&str> = args
        .get("actions")?
        .as_array()?
        .iter()
        .filter(|action| action.get("type").and_then(Value::as_str) == Some("type"))
        .filter_map(|action| action.get("text").and_then(Value::as_str))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn config_subject(tool_full_name: &str, args: &Value) -> Option<SensitiveSubject> {
    // 仅写动作可能有副作用：list/get/logs 直接跳过敏感检查。
    let action = args.get("action").and_then(Value::as_str).map(str::trim)?;
    if !matches!(action, "set" | "delete") {
        return None;
    }
    let scope = args.get("scope").and_then(Value::as_str)?.trim();
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let value = decode_config_value(args.get("value"));

    if scope == "settings" && key == "sensitiveCommands" {
        let mut text = format!("{tool_full_name} (action={action}) settings.sensitiveCommands");
        if let Some(project_id) = args
            .get("projectId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            text.push_str(&format!(" (projectId: {project_id})"));
        }
        if !value.is_null() {
            text.push('\n');
            text.push_str(
                &serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
            );
        }
        return Some(SensitiveSubject {
            kind: SubjectKind::Protected,
            text,
        });
    }

    let executable_scope = matches!(
        (scope, key),
        ("hooks", _) | ("scheduledTasks", _) | ("mcpServers", _) | ("settings", "mcpServers")
    );
    if action != "set" || !executable_scope {
        return None;
    }
    let mut lines = Vec::new();
    collect_executable_strings(&value, &mut lines);
    (!lines.is_empty()).then(|| SensitiveSubject {
        kind: SubjectKind::Config,
        text: lines.join("\n"),
    })
}

/// 收集配置值中之后会被执行的文本：`command`（连同同级 `args`）与 `preScript`。
fn collect_executable_strings(value: &Value, lines: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(command) = map
                .get("command")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
            {
                let mut line = command.to_string();
                for arg in map
                    .get("args")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    line.push(' ');
                    line.push_str(arg);
                }
                lines.push(line);
            }
            if let Some(script) = map
                .get("preScript")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
            {
                lines.push(script.to_string());
            }
            for child in map.values() {
                collect_executable_strings(child, lines);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_executable_strings(item, lines);
            }
        }
        _ => {}
    }
}

fn builtin_match(command_id: &str, description: String) -> SensitiveCommandMatchResult {
    SensitiveCommandMatchResult {
        command_id: command_id.to_string(),
        pattern: String::new(),
        description,
        ranges: Vec::new(),
        source_path: None,
        source_excerpt: None,
    }
}

fn check_failed(reason: impl std::fmt::Display) -> SensitiveCommandMatchResult {
    builtin_match(CHECK_FAILED_RULE_ID, reason.to_string())
}

/// 主体文本与其间接执行的脚本内容一并匹配规则；任何失败都转成内置命中。
async fn match_rules(
    subject: &SensitiveSubject,
    working_directory: Option<String>,
    project_id: Option<&str>,
) -> Vec<SensitiveCommandMatchResult> {
    if subject.kind == SubjectKind::Protected {
        return vec![builtin_match(PROTECTED_RULES_RULE_ID, String::new())];
    }

    let text = subject.text.clone();
    let project_id = project_id.map(str::to_string);
    // 规则读取与脚本扫描都是同步 IO，放入阻塞线程池，避免阻塞 Node.js 主线程。
    let outcome = tokio::task::spawn_blocking(move || {
        let mut candidates = vec![(text.clone(), None)];
        let mut unreadable = Vec::new();
        for source in collect_script_sources(&text, working_directory.as_deref()) {
            match source {
                ScriptSource::Content { path, content } => candidates.push((content, Some(path))),
                ScriptSource::Unreadable { path, reason } => unreadable.push(builtin_match(
                    SCRIPT_UNREADABLE_RULE_ID,
                    format!("{path}: {reason}"),
                )),
            }
        }
        crate::storage::check_sensitive_command_match(candidates, project_id).map(
            |mut matches| {
                matches.extend(unreadable);
                matches
            },
        )
    })
    .await;

    match outcome {
        Ok(Ok(matches)) => matches,
        Ok(Err(error)) => vec![check_failed(&error.reason)],
        Err(error) => vec![check_failed(error)],
    }
}
