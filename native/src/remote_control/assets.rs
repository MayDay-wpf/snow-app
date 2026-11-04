//! 移动端远控页面产物读取、桌面语言注入与静态资源类型判定。
//!
//! 原先由 Node 主进程的 mobileAssets.ts 承担；迁移到 Rust 后静态资源
//! 直接由原生 HTTP 服务读取磁盘返回，不再经过 Node 的文件系统调用。
//!
//! 这里刻意不做内存缓存：请求频率低、文件小，而 dev 下 rebuild 后必须
//! 立即读到新产物（旧哈希文件已随 emptyOutDir 删除，缓存反而会引入脏数据）。

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use percent_encoding::percent_decode_str;

/// assets 路由前缀；远控服务的 GET 路由与 WAN 预配对放行共用同一常量。
pub const MOBILE_ASSET_PATH_PREFIX: &str = "/assets/";

/// index.html 中的语言注入占位符（见 src/mobile/index.html）。
const LOCALE_PLACEHOLDER: &str = "__SNOW_LOCALE__";
/// 桌面端「系统设置」中保存应用语言的设置编码。
const LANGUAGE_SETTING_CODE: &str = "language";
/// 未读取到桌面语言时写入的标记，页面会回落到浏览器语言。
const LOCALE_AUTO: &str = "auto";

const ASSET_CONTENT_TYPES: [(&str, &str); 8] = [
    (".js", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".map", "application/json; charset=utf-8"),
    (".svg", "image/svg+xml"),
    (".png", "image/png"),
    (".webp", "image/webp"),
    (".woff2", "font/woff2"),
];

/// 远控页面支持的语言，与桌面端 shared/locale.ts 的规则保持一致。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    ZhCn,
    ZhTw,
}

pub const DEFAULT_LOCALE: Locale = Locale::En;

impl Locale {
    pub fn code(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::ZhCn => "zh-CN",
            Locale::ZhTw => "zh-TW",
        }
    }

    /// 把任意语言标记归一化：zh-Hant / zh-TW → zh-TW，zh / zh-Hans → zh-CN，
    /// en-* → en，其余返回 None。
    pub fn from_tag(value: &str) -> Option<Self> {
        if value == "en" {
            return Some(Locale::En);
        }
        if value == "zh-CN" {
            return Some(Locale::ZhCn);
        }
        if value == "zh-TW" {
            return Some(Locale::ZhTw);
        }
        let normalized = value.to_ascii_lowercase();
        if normalized.starts_with("zh-tw") || normalized.starts_with("zh-hant") {
            return Some(Locale::ZhTw);
        }
        if normalized.starts_with("zh-cn")
            || normalized.starts_with("zh-hans")
            || normalized == "zh"
        {
            return Some(Locale::ZhCn);
        }
        if normalized.starts_with("en") {
            return Some(Locale::En);
        }
        None
    }

    /// 浏览器协商语言：Accept-Language 首个语言标签（zh-CN,en;q=0.9 → zh-CN）。
    pub fn from_accept_language(header: Option<&str>) -> Option<Self> {
        let first_tag = header?.split(',').next()?.split(';').next()?.trim();
        Self::from_tag(first_tag)
    }
}

/// 桌面端应用语言（系统设置 "language"）；未设置或数据库不可用时返回 None。
pub async fn read_desktop_locale() -> Option<Locale> {
    tokio::task::spawn_blocking(|| {
        let database_path = crate::storage::ensure_database_file().ok()?;
        let value = crate::storage::services::system_settings::get_system_setting_value(
            &database_path,
            LANGUAGE_SETTING_CODE,
        )
        .ok()??;
        Locale::from_tag(&value)
    })
    .await
    .ok()
    .flatten()
}

/// 桌面界面字体栈（自定义字体优先）；读取失败回退系统栈。
pub async fn read_desktop_ui_font() -> String {
    tokio::task::spawn_blocking(|| {
        let Ok(database_path) = crate::storage::ensure_database_file() else {
            return crate::storage::services::system_settings::DEFAULT_UI_FONT_STACK.to_string();
        };
        crate::storage::services::system_settings::resolve_ui_font_family(&database_path)
    })
    .await
    .unwrap_or_else(|_| {
        crate::storage::services::system_settings::DEFAULT_UI_FONT_STACK.to_string()
    })
}

/// 页面 HTML；资源尚未构建时返回 None（远控服务据此回 503）。
pub async fn read_mobile_index_html(mobile_dir: &Path) -> Option<String> {
    let html = tokio::fs::read(mobile_dir.join("index.html")).await.ok()?;
    let text = String::from_utf8(html).ok()?;
    let locale = read_desktop_locale()
        .await
        .map(Locale::code)
        .unwrap_or(LOCALE_AUTO);
    Some(text.replace(LOCALE_PLACEHOLDER, locale))
}

/// assets 目录内的静态资源；路径越界、类型未知或文件缺失时返回 None。
pub async fn read_mobile_asset(mobile_dir: &Path, pathname: &str) -> Option<(Vec<u8>, &'static str)> {
    let raw = pathname.strip_prefix(MOBILE_ASSET_PATH_PREFIX)?;
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    let mut relative = PathBuf::new();
    for component in Path::new(decoded.as_ref()).components() {
        match component {
            // 只接受普通路径段：绝对路径、`..`、Windows 前缀一律拒绝。
            Component::Normal(part) => relative.push(part),
            _ => return None,
        }
    }
    let content_type = content_type_for(relative.extension()?)?;
    let absolute = mobile_dir.join("assets").join(&relative);
    let bytes = tokio::fs::read(absolute).await.ok()?;
    Some((bytes, content_type))
}

fn content_type_for(extension: &OsStr) -> Option<&'static str> {
    let normalized = format!(".{}", extension.to_string_lossy().to_ascii_lowercase());
    ASSET_CONTENT_TYPES
        .iter()
        .find(|(suffix, _)| *suffix == normalized)
        .map(|(_, value)| *value)
}
