//! 资源管理器文件夹右键菜单「在 Snow App 中打开」。
//!
//! 菜单写在 `HKCU\Software\Classes` 下（当前用户可写，无需管理员权限），同时覆盖
//! 「右键文件夹」(`Directory\shell`) 与「在文件夹空白处右键」
//! (`Directory\Background\shell`)，两处都用 `%V` 取得目录路径。
//!
//! Windows 10 / 11 兼容：两代系统读取的是同一套经典注册表菜单。Windows 10 直接显示
//! 在右键菜单中；Windows 11 的新版精简菜单只接受带包标识（签名的 MSIX / 稀疏包）的
//! IExplorerCommand 扩展，经典菜单项统一收纳在「显示更多选项」（Shift+F10）里，
//! 用户恢复经典右键菜单后同样直接显示。菜单文本同时写入默认值与 `MUIVerb`
//! （Windows 11 的经典菜单优先读取 `MUIVerb`），图标由调用方指定（打包版取应用
//! 可执行文件，预览模式取项目内的 icon.ico）。
//!
//! 预览模式（`npm run preview`，未打包的 electron.exe + 应用目录）写入独立的菜单键，
//! 与已安装版本的菜单并存，互不覆盖。
//!
//! 注册表读写与路径校验都放到阻塞线程池 / 异步文件系统执行，不阻塞 Node 事件循环。

use napi_derive::napi;

#[napi(object)]
pub struct ExplorerContextMenuOptions {
    /// 菜单显示文本（随桌面语言变化）。
    pub title: String,
    /// 启动程序的绝对路径（打包版为应用 exe，便携版为外层启动 exe，预览为 electron.exe）。
    pub executable: String,
    /// 未打包运行时交给 electron.exe 的应用目录；打包版不传。
    pub app_path: Option<String>,
    /// 菜单图标（exe 或 ico 的绝对路径）。
    pub icon: String,
    /// 传给应用的命令行开关，菜单命令为 `"<exe>" ["<appPath>"] <switch>="%V"`。
    pub switch_name: String,
    /// 是否为预览模式（写入独立的菜单键）。
    pub preview: bool,
}

/// 注册（或覆盖）文件夹右键菜单；返回是否已注册（非 Windows 平台恒为 false）。
#[napi]
pub async fn register_explorer_context_menu(
    options: ExplorerContextMenuOptions,
) -> napi::Result<bool> {
    let title = options.title.trim().to_string();
    let executable = options.executable.trim().to_string();
    let icon = options.icon.trim().to_string();
    let app_path = options
        .app_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let switch_name = options.switch_name.trim().to_string();
    if title.is_empty() || executable.is_empty() || icon.is_empty() {
        return Err(napi::Error::from_reason(
            "Explorer context menu title, executable and icon are required",
        ));
    }
    // 路径会被包进双引号写入命令行，不允许自带引号。
    let has_quote = [Some(&executable), Some(&icon), app_path.as_ref()]
        .into_iter()
        .flatten()
        .any(|value| value.contains('"'));
    if has_quote {
        return Err(napi::Error::from_reason(
            "Explorer context menu paths must not contain quotes",
        ));
    }
    if !is_valid_switch(&switch_name) {
        return Err(napi::Error::from_reason(format!(
            "Invalid explorer context menu switch \"{switch_name}\""
        )));
    }
    let app_arg = app_path
        .map(|value| format!(" \"{value}\""))
        .unwrap_or_default();
    let command = format!("\"{executable}\"{app_arg} {switch_name}=\"%V\"");
    platform::register(options.preview, title, format!("\"{icon}\""), command).await
}

/// 规整右键菜单传入的目录路径并确认它是已存在的目录；无效时返回 None。
///
/// `"%V"` 遇到磁盘根目录（`C:\`）时，结尾的 `\"` 会被命令行解析成字面引号，
/// 应用拿到的是 `C:"`，这里先剥掉残留引号再补回根目录分隔符。
#[napi]
pub async fn resolve_shell_directory_path(raw: String) -> napi::Result<Option<String>> {
    let Some(candidate) = normalize_directory_path(&raw) else {
        return Ok(None);
    };
    if !std::path::Path::new(&candidate).is_absolute() {
        return Ok(None);
    }
    match tokio::fs::metadata(&candidate).await {
        Ok(metadata) if metadata.is_dir() => Ok(Some(candidate)),
        _ => Ok(None),
    }
}

/// 开关只允许 `--` 开头的小写字母、数字与连字符，防止命令行注入。
fn is_valid_switch(switch_name: &str) -> bool {
    switch_name.len() > 2
        && switch_name.len() <= 64
        && switch_name.starts_with("--")
        && switch_name[2..]
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn normalize_directory_path(raw: &str) -> Option<String> {
    let mut value = raw.trim().trim_matches('"').trim().to_string();
    if value.is_empty() {
        return None;
    }
    // 裸盘符（C:）补成根目录（C:\），否则会被当作该盘的当前目录。
    if value.len() == 2 && value.ends_with(':') && value.as_bytes()[0].is_ascii_alphabetic() {
        value.push(std::path::MAIN_SEPARATOR);
    }
    // 去掉结尾多余的分隔符，但保留根目录（C:\ 与 /）。
    while value.len() > 1 && value.ends_with(['\\', '/']) {
        if value[..value.len() - 1].ends_with(':') {
            break;
        }
        value.pop();
    }
    Some(value)
}

#[cfg(target_os = "windows")]
mod platform {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    /// 菜单项的注册表键名；NSIS 卸载脚本（build/installer.nsh）按同名键清理。
    const VERB_KEY: &str = "SnowApp";
    /// 预览模式（`npm run preview`）的菜单键，与已安装版本并存。
    const PREVIEW_VERB_KEY: &str = "SnowAppPreview";

    /// 右键文件夹 / 文件夹空白处右键 两个入口。
    const SHELL_ROOTS: [&str; 2] = [
        r"Software\Classes\Directory\shell",
        r"Software\Classes\Directory\Background\shell",
    ];

    pub(super) async fn register(
        preview: bool,
        title: String,
        icon: String,
        command: String,
    ) -> napi::Result<bool> {
        let verb_key = if preview { PREVIEW_VERB_KEY } else { VERB_KEY };
        tokio::task::spawn_blocking(move || write_entries(verb_key, &title, &icon, &command))
            .await
            .map_err(|error| {
                napi::Error::from_reason(format!("Explorer context menu task failed: {error}"))
            })?
            .map_err(napi::Error::from_reason)?;
        Ok(true)
    }

    fn write_entries(verb_key: &str, title: &str, icon: &str, command: &str) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for root in SHELL_ROOTS {
            let verb_path = format!(r"{root}\{verb_key}");
            let (verb, _) = hkcu
                .create_subkey(&verb_path)
                .map_err(|error| format!("Failed to open {verb_path}: {error}"))?;
            for (name, value) in [("", title), ("MUIVerb", title), ("Icon", icon)] {
                verb.set_value(name, &value)
                    .map_err(|error| format!("Failed to write {verb_path}\\{name}: {error}"))?;
            }
            let (command_key, _) = verb
                .create_subkey("command")
                .map_err(|error| format!("Failed to open {verb_path}\\command: {error}"))?;
            command_key
                .set_value("", &command)
                .map_err(|error| format!("Failed to write {verb_path}\\command: {error}"))?;
        }
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    /// 资源管理器右键菜单是 Windows 专属能力，其他平台不做任何注册。
    pub(super) async fn register(
        _preview: bool,
        _title: String,
        _icon: String,
        _command: String,
    ) -> napi::Result<bool> {
        Ok(false)
    }
}
