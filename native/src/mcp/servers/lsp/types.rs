//! LSP 服务内部类型定义。

use std::path::PathBuf;

use serde_json::Value;

/// 解析后的语言服务器配置（来自 lsp_server_configs 表）。
#[derive(Debug, Clone, PartialEq)]
pub struct ServerConfig {
    pub lang: String,
    pub command: String,
    pub args: Vec<String>,
    pub file_extensions: Vec<String>,
    pub install_command: Option<String>,
    pub initialization_options: Option<Value>,
    pub enabled: bool,
}

impl ServerConfig {
    /// 包含全部配置字段的稳定指纹；仅用于内存身份，不把参数/配置秘密暴露到状态。
    pub(crate) fn fingerprint(&self) -> String {
        let value = serde_json::json!([
            self.lang,
            self.command,
            self.args,
            self.file_extensions,
            self.install_command,
            self.initialization_options,
            self.enabled
        ]);
        blake3::hash(value.to_string().as_bytes())
            .to_hex()
            .to_string()
    }
}

/// LSP 服务错误（携带可行动的降级建议，见设计文档 §9）。
#[derive(Debug)]
pub enum LspError {
    /// 未为文件类型配置语言服务器。
    NotConfigured(String),
    /// 服务器命令不存在（spawn ENOENT），附 installCommand 建议。
    ServerMissing(String, Option<String>),
    /// 服务器启动失败（initialize 超时/崩溃/协议错误）。
    ServerFailed(String),
    /// 请求超时。
    RequestTimeout(String),
    /// SSH/远程路径不支持。
    RemoteNotSupported,
    /// 文件过大。
    FileTooLarge(String),
    /// 当前语言的服务器不支持该请求（§8.7 运行时二次校验兜底）。
    CapabilityNotSupported(String, String),
    /// 项目中不存在该语言的技术栈标志（无 Cargo.toml / go.mod / tsconfig.json 等）：
    /// LSP 只在真实技术栈存在时启动（技术栈感知，2026-09-24）。
    NoLangStack(String, String),
    /// 服务器返回了暂不支持的操作（如 documentChanges.operations 的文件
    /// 创建/重命名/删除），不得静默丢弃——错误信息明确告知未应用（R1.2）。
    Unsupported(String),
    /// 内部错误。
    Internal(String),
}

impl From<LspError> for napi::Error {
    fn from(error: LspError) -> Self {
        match error {
            LspError::NotConfigured(lang) => napi::Error::new(
                napi::Status::GenericFailure,
                format!(
                    "未为语言 \"{lang}\" 配置 LSP 服务器。可用 lsp-config 域配置（config-set scope=lsp-config），符号导航可继续使用 codelens-* 工具"
                ),
            ),
            LspError::ServerMissing(command, install) => {
                let hint = install
                    .filter(|i| !i.is_empty())
                    .map(|i| format!(" 安装命令: {i}"))
                    .unwrap_or_default();
                napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("语言服务器 \"{command}\" 未找到或无法启动。请检查 command 是否匹配当前平台且已安装。{hint}"),
                )
            }
            LspError::ServerFailed(message) => {
                napi::Error::new(napi::Status::GenericFailure, format!("语言服务器启动失败: {message}"))
            }
            LspError::RequestTimeout(action) => {
                napi::Error::new(napi::Status::GenericFailure, format!("lsp 请求超时: {action}"))
            }
            LspError::RemoteNotSupported => napi::Error::new(
                napi::Status::GenericFailure,
                "远程项目暂不支持 LSP（语言服务器进程在本地运行），请在本地项目中使用",
            ),
            LspError::FileTooLarge(path) => napi::Error::new(
                napi::Status::GenericFailure,
                format!("文件过大，无法进行 LSP 分析（>512KB）: {path}"),
            ),
            LspError::CapabilityNotSupported(lang, tool) => napi::Error::new(
                napi::Status::GenericFailure,
                format!(
                    "当前语言的服务器（{lang}）不支持 lsp-{tool}。可检查 lsp-settings 是否启用了支持该能力的语言服务器（附录 F 能力矩阵）"
                ),
            ),
            LspError::NoLangStack(lang, markers) => napi::Error::new(
                napi::Status::GenericFailure,
                format!(
                    "项目中未检测到 {lang} 技术栈标志文件（{markers}）。LSP 服务器只在技术栈真实存在时启动：请确认该技术栈位于此项目内，或检查文件路径与项目根是否匹配"
                ),
            ),
            LspError::Unsupported(message) => {
                napi::Error::new(napi::Status::GenericFailure, format!("不支持的 LSP 操作: {message}"))
            }
            LspError::Internal(message) => {
                napi::Error::new(napi::Status::GenericFailure, format!("LSP 内部错误: {message}"))
            }
        }
    }
}

/// 会话 key：(语言, 项目根)。
pub type SessionKey = (String, PathBuf);

#[cfg(test)]
mod config_identity_tests {
    use super::*;
    #[test]
    fn arguments_and_initialization_options_affect_identity() {
        let config = ServerConfig {
            lang: "typescript".into(),
            command: "node".into(),
            args: vec!["server.js".into()],
            file_extensions: vec!["ts".into()],
            install_command: None,
            initialization_options: None,
            enabled: true,
        };
        let mut changed = config.clone();
        changed.args.push("--stdio".into());
        assert_ne!(config, changed);
        assert_ne!(config.fingerprint(), changed.fingerprint());
        changed = config.clone();
        changed.initialization_options = Some(serde_json::json!({"strict":true}));
        assert_ne!(config, changed);
    }
}
