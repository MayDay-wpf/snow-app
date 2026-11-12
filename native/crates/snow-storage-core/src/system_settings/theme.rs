use std::path::Path;

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use super::{
    get_system_setting_value, set_system_setting, DEFAULT_THEME_SETTING_CODE,
    DEFAULT_THEME_SETTING_NAME,
};

// 排版数值范围与默认值，与渲染层 themeSettingsUtils 的 typography 常量保持一致。
const UI_FONT_SIZE_MIN: f64 = 10.0;
const UI_FONT_SIZE_MAX: f64 = 18.0;
const DEFAULT_UI_FONT_SIZE: f64 = 13.0;
const FONT_WEIGHT_MIN: f64 = 100.0;
const FONT_WEIGHT_MAX: f64 = 900.0;
const DEFAULT_FONT_WEIGHT: f64 = 400.0;
const CHAT_FONT_SIZE_MIN: f64 = 12.0;
const CHAT_FONT_SIZE_MAX: f64 = 20.0;
const DEFAULT_CHAT_FONT_SIZE: f64 = 15.0;
const CHAT_LINE_HEIGHT_MIN: f64 = 1.2;
const CHAT_LINE_HEIGHT_MAX: f64 = 2.4;
const DEFAULT_CHAT_LINE_HEIGHT: f64 = 1.75;
const CODE_FONT_SIZE_MIN: f64 = 10.0;
const CODE_FONT_SIZE_MAX: f64 = 18.0;
const DEFAULT_CODE_FONT_SIZE: f64 = 12.5;

// 宠物背景大小（相对视口高度的比例）范围与默认值，与渲染层 themeSettingsUtils 保持一致。
const PET_BACKGROUND_SCALE_MIN: f64 = 0.2;
const PET_BACKGROUND_SCALE_MAX: f64 = 1.5;
const DEFAULT_PET_BACKGROUND_SCALE: f64 = 0.6;

// 背景图列表上限与轮播参数范围 / 默认值，与渲染层 themeSettingsUtils 保持一致。
const BACKGROUND_IMAGE_LIMIT: usize = 30;
const CAROUSEL_INTERVAL_MIN_SECS: f64 = 10.0;
const CAROUSEL_INTERVAL_MAX_SECS: f64 = 7200.0;
const DEFAULT_CAROUSEL_INTERVAL_SECS: f64 = 300.0;

// ===== Theme settings =====

/// 主题调色板，对应渲染层 CSS 变量。每个字段为合法 CSS 颜色字符串
/// （hex 或 rgba()），serde default 使旧数据缺字段时仍可反序列化。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemePalette {
    pub bg_primary: String,
    pub bg_secondary: String,
    pub bg_tertiary: String,
    pub bg_hover: String,
    pub bg_active: String,
    pub chrome_bg: String,
    pub app_bg: String,
    pub border_color: String,
    pub border_light: String,
    pub border_subtle: String,
    pub text_primary: String,
    pub text_secondary: String,
    pub text_tertiary: String,
    pub text_muted: String,
    pub accent_green: String,
    pub accent_green_bg: String,
    pub accent_green_text: String,
    pub accent_red: String,
    pub accent_red_bg: String,
    pub accent_red_text: String,
    pub accent_blue: String,
    pub accent_blue_bg: String,
    pub accent_blue_text: String,
    pub accent_color: String,
    pub on_solid: String,
    pub selection_bg: String,
    pub focus_ring: String,
}

impl ThemePalette {
    /// 将空字符串字段填充为占位透明色，避免渲染层 var() 回退为 initial。
    fn normalize(&mut self) {
        let placeholder = "transparent";
        macro_rules! fill {
            ($field:ident) => {
                if self.$field.trim().is_empty() {
                    self.$field = placeholder.to_string();
                } else {
                    self.$field = self.$field.trim().to_string();
                }
            };
        }
        fill!(bg_primary);
        fill!(bg_secondary);
        fill!(bg_tertiary);
        fill!(bg_hover);
        fill!(bg_active);
        fill!(chrome_bg);
        fill!(app_bg);
        fill!(border_color);
        fill!(border_light);
        fill!(border_subtle);
        fill!(text_primary);
        fill!(text_secondary);
        fill!(text_tertiary);
        fill!(text_muted);
        fill!(accent_green);
        fill!(accent_green_bg);
        fill!(accent_green_text);
        fill!(accent_red);
        fill!(accent_red_bg);
        fill!(accent_red_text);
        fill!(accent_blue);
        fill!(accent_blue_bg);
        fill!(accent_blue_text);
        fill!(accent_color);
        fill!(on_solid);
        fill!(selection_bg);
        fill!(focus_ring);
    }
}

/// 自定义主题：亮色 + 暗色两套调色板。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomTheme {
    pub light: ThemePalette,
    pub dark: ThemePalette,
}

impl CustomTheme {
    fn normalize(&mut self) {
        self.light.normalize();
        self.dark.normalize();
    }
}

/// 背景配置。source 决定来源："image" 使用 image_paths 指向的多张自定义图片，
/// "pet" 使用 pet_id 指向的已安装宠物的 idle 动画（pet_scale 为相对视口高度
/// 的比例）；opacity 范围 0.0~1.0；blur 为高斯模糊像素值（0 表示不模糊）。
/// carousel_enabled / carousel_interval_secs / carousel_order 为图片自动轮播参数。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeBackground {
    pub enabled: bool,
    pub source: String,
    /// 旧版单图字段：仅用于兼容读取旧数据，normalize 后并入 image_paths 并清空。
    pub image_path: String,
    /// 背景图片列表（source 为 image 时生效，首张为初始显示图）。
    pub image_paths: Vec<String>,
    pub pet_id: String,
    pub pet_scale: f64,
    pub opacity: f64,
    pub blur: f64,
    /// 是否开启自动轮播（图片数量 >= 2 时生效）。
    pub carousel_enabled: bool,
    /// 轮播切换间隔（秒），范围 CAROUSEL_INTERVAL_MIN_SECS ~ CAROUSEL_INTERVAL_MAX_SECS。
    pub carousel_interval_secs: f64,
    /// 轮播播放顺序："sequential"（顺序）| "random"（随机）。
    pub carousel_order: String,
    /// 当前显示 / 固定的背景图路径（空表示取列表首张）；轮播切换后由渲染层更新。
    pub current_image_path: String,
}

impl ThemeBackground {
    fn normalize(&mut self) {
        self.source = self.source.trim().to_string();
        if !matches!(self.source.as_str(), "image" | "pet") {
            self.source = "image".to_string();
        }
        // 图片列表：trim、去空、去重（保留首次出现）、截断到上限。
        let mut paths: Vec<String> = Vec::new();
        for item in self.image_paths.drain(..) {
            let trimmed = item.trim().to_string();
            if trimmed.is_empty() || paths.iter().any(|existing| existing == &trimmed) {
                continue;
            }
            paths.push(trimmed);
            if paths.len() >= BACKGROUND_IMAGE_LIMIT {
                break;
            }
        }
        // 旧数据迁移：旧版单图字段非空且列表为空时并入列表。
        self.image_path = self.image_path.trim().to_string();
        if paths.is_empty() && !self.image_path.is_empty() {
            paths.push(self.image_path.clone());
        }
        self.image_path.clear();
        self.image_paths = paths;

        self.pet_id = self.pet_id.trim().to_string();
        if !self.pet_scale.is_finite() || self.pet_scale < PET_BACKGROUND_SCALE_MIN {
            self.pet_scale = DEFAULT_PET_BACKGROUND_SCALE;
        } else if self.pet_scale > PET_BACKGROUND_SCALE_MAX {
            self.pet_scale = PET_BACKGROUND_SCALE_MAX;
        }
        if !self.opacity.is_finite() || self.opacity < 0.0 {
            self.opacity = 1.0;
        } else if self.opacity > 1.0 {
            self.opacity = 1.0;
        }
        if !self.blur.is_finite() || self.blur < 0.0 {
            self.blur = 0.0;
        } else if self.blur > 100.0 {
            self.blur = 100.0;
        }
        // 轮播参数：顺序校验 + 间隔钳制（缺省 / 小于下限时回退默认值）。
        self.carousel_order = self.carousel_order.trim().to_string();
        if self.carousel_order != "random" {
            self.carousel_order = "sequential".to_string();
        }
        if !self.carousel_interval_secs.is_finite()
            || self.carousel_interval_secs < CAROUSEL_INTERVAL_MIN_SECS
        {
            self.carousel_interval_secs = DEFAULT_CAROUSEL_INTERVAL_SECS;
        } else if self.carousel_interval_secs > CAROUSEL_INTERVAL_MAX_SECS {
            self.carousel_interval_secs = CAROUSEL_INTERVAL_MAX_SECS;
        }
        // 当前显示图必须属于图片列表，否则清空（渲染层会回退到列表首张）。
        self.current_image_path = self.current_image_path.trim().to_string();
        if !self.current_image_path.is_empty()
            && !self
                .image_paths
                .iter()
                .any(|existing| existing == &self.current_image_path)
        {
            self.current_image_path.clear();
        }
        // 当前来源缺少素材（图片列表 / 宠物 id）时视为未启用。
        let has_content = if self.source == "pet" {
            !self.pet_id.is_empty()
        } else {
            !self.image_paths.is_empty()
        };
        if !has_content {
            self.enabled = false;
        }
    }
}

/// 流式光标配置。icon_type 决定渲染形态：
/// - "dot"：默认脉冲圆点
/// - "lucide"：使用内置 lucide 图标，由 lucide_name 指定
/// - "custom"：使用用户上传的 SVG，由 svg_path 指定文件路径
/// - "snowbot"：内置 Snow Bot 动态机器人图标
/// - "image"：用户上传的任意图片（含 GIF），原样显示无动画，路径复用 svg_path
/// - "canvas"：用户上传的 JS 绘制脚本（Worker 中运行），路径复用 svg_path
/// icon_type 为 "lucide" 时 svg_path 应为空；为 "custom"/"image"/"canvas" 时 lucide_name 应为空。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeStreamCursor {
    pub icon_type: String,
    pub lucide_name: String,
    pub svg_path: String,
    pub icon_size: f64,
}

impl ThemeStreamCursor {
    fn normalize(&mut self) {
        self.icon_type = self.icon_type.trim().to_string();
        if !matches!(
            self.icon_type.as_str(),
            "dot" | "lucide" | "custom" | "snowbot" | "image" | "canvas"
        ) {
            self.icon_type = "dot".to_string();
        }
        self.lucide_name = self.lucide_name.trim().to_string();
        self.svg_path = self.svg_path.trim().to_string();
        // 图标尺寸范围 8~48，默认 14。
        if !self.icon_size.is_finite() || self.icon_size < 8.0 {
            self.icon_size = 14.0;
        } else if self.icon_size > 48.0 {
            self.icon_size = 48.0;
        }
        // 根据类型清理无关字段，避免持久化数据与实际渲染形态不一致。
        match self.icon_type.as_str() {
            "dot" | "snowbot" => {
                self.lucide_name.clear();
                self.svg_path.clear();
            }
            "lucide" => {
                self.svg_path.clear();
                if self.lucide_name.is_empty() {
                    // 退化到默认脉冲圆点。
                    self.icon_type = "dot".to_string();
                }
            }
            "custom" | "image" | "canvas" => {
                self.lucide_name.clear();
                if self.svg_path.is_empty() {
                    self.icon_type = "dot".to_string();
                }
            }
            _ => {}
        }
    }
}

/// 排版设置：界面字号（驱动整页缩放）+ 正文字重 + 聊天正文字号 /
/// 行高 + 代码字号。数值范围与前端 typography 常量保持一致。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeTypography {
    pub font_size: f64,
    pub font_weight: f64,
    pub chat_font_size: f64,
    pub chat_line_height: f64,
    pub code_font_size: f64,
}

impl Default for ThemeTypography {
    fn default() -> Self {
        Self {
            font_size: DEFAULT_UI_FONT_SIZE,
            font_weight: DEFAULT_FONT_WEIGHT,
            chat_font_size: DEFAULT_CHAT_FONT_SIZE,
            chat_line_height: DEFAULT_CHAT_LINE_HEIGHT,
            code_font_size: DEFAULT_CODE_FONT_SIZE,
        }
    }
}

impl ThemeTypography {
    fn normalize(&mut self) {
        if !self.font_size.is_finite()
            || self.font_size < UI_FONT_SIZE_MIN
            || self.font_size > UI_FONT_SIZE_MAX
        {
            self.font_size = DEFAULT_UI_FONT_SIZE;
        }
        if !self.font_weight.is_finite()
            || self.font_weight < FONT_WEIGHT_MIN
            || self.font_weight > FONT_WEIGHT_MAX
        {
            self.font_weight = DEFAULT_FONT_WEIGHT;
        }
        if !self.chat_font_size.is_finite()
            || self.chat_font_size < CHAT_FONT_SIZE_MIN
            || self.chat_font_size > CHAT_FONT_SIZE_MAX
        {
            self.chat_font_size = DEFAULT_CHAT_FONT_SIZE;
        }
        if !self.chat_line_height.is_finite()
            || self.chat_line_height < CHAT_LINE_HEIGHT_MIN
            || self.chat_line_height > CHAT_LINE_HEIGHT_MAX
        {
            self.chat_line_height = DEFAULT_CHAT_LINE_HEIGHT;
        }
        if !self.code_font_size.is_finite()
            || self.code_font_size < CODE_FONT_SIZE_MIN
            || self.code_font_size > CODE_FONT_SIZE_MAX
        {
            self.code_font_size = DEFAULT_CODE_FONT_SIZE;
        }
    }
}

/// 聊天窗口风格：IM 模式开关 + AI / 用户头像（空路径表示使用默认头像）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeChatStyle {
    pub im_mode: bool,
    pub ai_avatar_path: String,
    pub user_avatar_path: String,
}

impl ThemeChatStyle {
    fn normalize(&mut self) {
        self.ai_avatar_path = self.ai_avatar_path.trim().to_string();
        self.user_avatar_path = self.user_avatar_path.trim().to_string();
    }
}

/// 完整主题设置：模式 + 预设 ID + 自定义调色板 + 背景图 + 字体 + 流式光标 + 排版 + 聊天风格。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeSettings {
    pub mode: String,
    pub preset_id: String,
    pub layout_style: String,
    pub custom: CustomTheme,
    pub background: ThemeBackground,
    pub font_family: String,
    pub stream_cursor: ThemeStreamCursor,
    pub typography: ThemeTypography,
    pub chat_style: ThemeChatStyle,
}

impl ThemeSettings {
    fn normalize(&mut self) {
        self.mode = self.mode.trim().to_string();
        if !matches!(self.mode.as_str(), "system" | "light" | "dark") {
            self.mode = "system".to_string();
        }
        self.preset_id = self.preset_id.trim().to_string();
        if self.preset_id.is_empty() {
            self.preset_id = "snow".to_string();
        }
        self.layout_style = self.layout_style.trim().to_string();
        if self.layout_style.is_empty() {
            // 临时单主题时期的旧数据默认迁移到层叠风格。
            self.layout_style = if matches!(self.preset_id.as_str(), "minimal" | "layered") {
                "layered".to_string()
            } else {
                "island".to_string()
            };
        } else if !matches!(self.layout_style.as_str(), "island" | "layered" | "flush") {
            self.layout_style = "island".to_string();
        }
        self.custom.normalize();
        self.background.normalize();
        self.font_family = self.font_family.trim().to_string();
        self.stream_cursor.normalize();
        self.typography.normalize();
        self.chat_style.normalize();
    }
}

pub fn get_theme_settings(database_path: &Path) -> Result<ThemeSettings> {
    let Some(raw_value) = get_system_setting_value(database_path, DEFAULT_THEME_SETTING_CODE)?
    else {
        return Ok(ThemeSettings::default());
    };

    let mut settings = serde_json::from_str::<ThemeSettings>(&raw_value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse theme settings: {error}"),
        )
    })?;
    settings.normalize();
    Ok(settings)
}

/// 未自定义界面字体时的系统栈（与渲染层 tokens.css 的 --font-sans 一致）。
pub const DEFAULT_UI_FONT_STACK: &str =
    "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif";

/// 过滤会破坏 <style> 上下文的字符，避免用户字体串注入标记或控制字符。
fn sanitize_font_family(value: &str) -> String {
    value
        .chars()
        .filter(|&ch| {
            !matches!(
                ch,
                '<' | '>' | '{' | '}' | ';' | '\\' | '\u{0}'..='\u{1f}'
            )
        })
        .collect()
}

/// 当前界面字体栈：自定义字体优先，否则系统栈；数据库不可用时回退系统栈。
pub fn resolve_ui_font_family(database_path: &Path) -> String {
    let custom = get_theme_settings(database_path)
        .map(|settings| sanitize_font_family(&settings.font_family))
        .unwrap_or_default();
    let trimmed = custom.trim();
    if trimmed.is_empty() {
        DEFAULT_UI_FONT_STACK.to_string()
    } else {
        format!("{trimmed}, {DEFAULT_UI_FONT_STACK}")
    }
}

pub fn set_theme_settings(database_path: &Path, settings: &ThemeSettings) -> Result<()> {
    let mut normalized = settings.clone();
    normalized.normalize();
    let setting_value = serde_json::to_string(&normalized).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize theme settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        DEFAULT_THEME_SETTING_NAME,
        DEFAULT_THEME_SETTING_CODE,
        &setting_value,
    )
}
