//! Theme 设置 NAPI 类型、From 转换与转发函数。

use super::*;

// ===== Theme settings NAPI 导出 =====

#[napi(object)]
pub struct ThemePaletteNapi {
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

impl From<ThemePalette> for ThemePaletteNapi {
    fn from(p: ThemePalette) -> Self {
        ThemePaletteNapi {
            bg_primary: p.bg_primary,
            bg_secondary: p.bg_secondary,
            bg_tertiary: p.bg_tertiary,
            bg_hover: p.bg_hover,
            bg_active: p.bg_active,
            chrome_bg: p.chrome_bg,
            app_bg: p.app_bg,
            border_color: p.border_color,
            border_light: p.border_light,
            border_subtle: p.border_subtle,
            text_primary: p.text_primary,
            text_secondary: p.text_secondary,
            text_tertiary: p.text_tertiary,
            text_muted: p.text_muted,
            accent_green: p.accent_green,
            accent_green_bg: p.accent_green_bg,
            accent_green_text: p.accent_green_text,
            accent_red: p.accent_red,
            accent_red_bg: p.accent_red_bg,
            accent_red_text: p.accent_red_text,
            accent_blue: p.accent_blue,
            accent_blue_bg: p.accent_blue_bg,
            accent_blue_text: p.accent_blue_text,
            accent_color: p.accent_color,
            on_solid: p.on_solid,
            selection_bg: p.selection_bg,
            focus_ring: p.focus_ring,
        }
    }
}

impl From<ThemePaletteNapi> for ThemePalette {
    fn from(p: ThemePaletteNapi) -> Self {
        ThemePalette {
            bg_primary: p.bg_primary,
            bg_secondary: p.bg_secondary,
            bg_tertiary: p.bg_tertiary,
            bg_hover: p.bg_hover,
            bg_active: p.bg_active,
            chrome_bg: p.chrome_bg,
            app_bg: p.app_bg,
            border_color: p.border_color,
            border_light: p.border_light,
            border_subtle: p.border_subtle,
            text_primary: p.text_primary,
            text_secondary: p.text_secondary,
            text_tertiary: p.text_tertiary,
            text_muted: p.text_muted,
            accent_green: p.accent_green,
            accent_green_bg: p.accent_green_bg,
            accent_green_text: p.accent_green_text,
            accent_red: p.accent_red,
            accent_red_bg: p.accent_red_bg,
            accent_red_text: p.accent_red_text,
            accent_blue: p.accent_blue,
            accent_blue_bg: p.accent_blue_bg,
            accent_blue_text: p.accent_blue_text,
            accent_color: p.accent_color,
            on_solid: p.on_solid,
            selection_bg: p.selection_bg,
            focus_ring: p.focus_ring,
        }
    }
}

#[napi(object)]
pub struct CustomThemeNapi {
    pub light: ThemePaletteNapi,
    pub dark: ThemePaletteNapi,
}

impl From<CustomTheme> for CustomThemeNapi {
    fn from(c: CustomTheme) -> Self {
        CustomThemeNapi {
            light: c.light.into(),
            dark: c.dark.into(),
        }
    }
}

impl From<CustomThemeNapi> for CustomTheme {
    fn from(c: CustomThemeNapi) -> Self {
        CustomTheme {
            light: c.light.into(),
            dark: c.dark.into(),
        }
    }
}

#[napi(object)]
pub struct ThemeBackgroundNapi {
    pub enabled: bool,
    /// 背景来源："image"（自定义图片）| "pet"（桌面宠物 idle 动画）
    pub source: String,
    /// 背景图片列表（source 为 "image" 时生效，首张为初始显示图）
    pub image_paths: Vec<String>,
    /// 宠物背景使用的已安装宠物 id
    pub pet_id: String,
    /// 宠物背景大小：相对视口高度的比例
    pub pet_scale: f64,
    pub opacity: f64,
    pub blur: f64,
    /// 是否开启自动轮播（图片数量 >= 2 时生效）
    pub carousel_enabled: bool,
    /// 轮播切换间隔（秒）
    pub carousel_interval_secs: f64,
    /// 轮播播放顺序："sequential" | "random"
    pub carousel_order: String,
    /// 当前显示 / 固定的背景图路径（空表示取列表首张）
    pub current_image_path: String,
}

impl From<ThemeBackground> for ThemeBackgroundNapi {
    fn from(b: ThemeBackground) -> Self {
        ThemeBackgroundNapi {
            enabled: b.enabled,
            source: b.source,
            image_paths: b.image_paths,
            pet_id: b.pet_id,
            pet_scale: b.pet_scale,
            opacity: b.opacity,
            blur: b.blur,
            carousel_enabled: b.carousel_enabled,
            carousel_interval_secs: b.carousel_interval_secs,
            carousel_order: b.carousel_order,
            current_image_path: b.current_image_path,
        }
    }
}

impl From<ThemeBackgroundNapi> for ThemeBackground {
    fn from(b: ThemeBackgroundNapi) -> Self {
        ThemeBackground {
            enabled: b.enabled,
            source: b.source,
            // napi 层不再暴露旧版单图字段，storage 层保留空值以兼容序列化结构。
            image_path: String::new(),
            image_paths: b.image_paths,
            pet_id: b.pet_id,
            pet_scale: b.pet_scale,
            opacity: b.opacity,
            blur: b.blur,
            carousel_enabled: b.carousel_enabled,
            carousel_interval_secs: b.carousel_interval_secs,
            carousel_order: b.carousel_order,
            current_image_path: b.current_image_path,
        }
    }
}

#[napi(object)]
pub struct ThemeStreamCursorNapi {
    pub icon_type: String,
    pub lucide_name: String,
    pub svg_path: String,
    pub icon_size: f64,
}

impl From<ThemeStreamCursor> for ThemeStreamCursorNapi {
    fn from(c: ThemeStreamCursor) -> Self {
        ThemeStreamCursorNapi {
            icon_type: c.icon_type,
            lucide_name: c.lucide_name,
            svg_path: c.svg_path,
            icon_size: c.icon_size,
        }
    }
}

impl From<ThemeStreamCursorNapi> for ThemeStreamCursor {
    fn from(c: ThemeStreamCursorNapi) -> Self {
        ThemeStreamCursor {
            icon_type: c.icon_type,
            lucide_name: c.lucide_name,
            svg_path: c.svg_path,
            icon_size: c.icon_size,
        }
    }
}

#[napi(object)]
pub struct ThemeTypographyNapi {
    pub font_size: f64,
    pub font_weight: f64,
    pub chat_font_size: f64,
    pub chat_line_height: f64,
    pub code_font_size: f64,
}

impl From<ThemeTypography> for ThemeTypographyNapi {
    fn from(t: ThemeTypography) -> Self {
        ThemeTypographyNapi {
            font_size: t.font_size,
            font_weight: t.font_weight,
            chat_font_size: t.chat_font_size,
            chat_line_height: t.chat_line_height,
            code_font_size: t.code_font_size,
        }
    }
}

impl From<ThemeTypographyNapi> for ThemeTypography {
    fn from(t: ThemeTypographyNapi) -> Self {
        ThemeTypography {
            font_size: t.font_size,
            font_weight: t.font_weight,
            chat_font_size: t.chat_font_size,
            chat_line_height: t.chat_line_height,
            code_font_size: t.code_font_size,
        }
    }
}

#[napi(object)]
pub struct ThemeChatStyleNapi {
    pub im_mode: bool,
    pub ai_avatar_path: String,
    pub user_avatar_path: String,
}

impl From<ThemeChatStyle> for ThemeChatStyleNapi {
    fn from(c: ThemeChatStyle) -> Self {
        ThemeChatStyleNapi {
            im_mode: c.im_mode,
            ai_avatar_path: c.ai_avatar_path,
            user_avatar_path: c.user_avatar_path,
        }
    }
}

impl From<ThemeChatStyleNapi> for ThemeChatStyle {
    fn from(c: ThemeChatStyleNapi) -> Self {
        ThemeChatStyle {
            im_mode: c.im_mode,
            ai_avatar_path: c.ai_avatar_path,
            user_avatar_path: c.user_avatar_path,
        }
    }
}

#[napi(object)]
pub struct ThemeSettingsNapi {
    pub mode: String,
    pub preset_id: String,
    pub layout_style: String,
    pub custom: CustomThemeNapi,
    pub background: ThemeBackgroundNapi,
    pub font_family: String,
    pub stream_cursor: ThemeStreamCursorNapi,
    pub typography: ThemeTypographyNapi,
    // 可选：旧调用方未携带时保持默认值
    pub chat_style: Option<ThemeChatStyleNapi>,
}

impl From<ThemeSettings> for ThemeSettingsNapi {
    fn from(s: ThemeSettings) -> Self {
        ThemeSettingsNapi {
            mode: s.mode,
            preset_id: s.preset_id,
            layout_style: s.layout_style,
            custom: s.custom.into(),
            background: s.background.into(),
            font_family: s.font_family,
            stream_cursor: s.stream_cursor.into(),
            typography: s.typography.into(),
            chat_style: Some(s.chat_style.into()),
        }
    }
}

impl From<ThemeSettingsNapi> for ThemeSettings {
    fn from(s: ThemeSettingsNapi) -> Self {
        ThemeSettings {
            mode: s.mode,
            preset_id: s.preset_id,
            layout_style: s.layout_style,
            custom: s.custom.into(),
            background: s.background.into(),
            font_family: s.font_family,
            stream_cursor: s.stream_cursor.into(),
            typography: s.typography.into(),
            chat_style: s.chat_style.map(Into::into).unwrap_or_default(),
        }
    }
}

#[napi]
pub async fn get_theme_settings() -> napi::Result<ThemeSettingsNapi> {
    let settings = tokio::task::spawn_blocking(crate::storage::get_theme_settings)
        .await
        .map_err(map_spawn_error)??;
    Ok(settings.into())
}

#[napi]
pub async fn set_theme_settings(settings: ThemeSettingsNapi) -> napi::Result<()> {
    let settings = settings.into();
    tokio::task::spawn_blocking(move || crate::storage::set_theme_settings(settings))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_theme_background_image(source_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::save_theme_background_image(source_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_theme_background_image(image_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_theme_background_image(image_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_theme_stream_cursor_svg(source_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::save_theme_stream_cursor_svg(source_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_theme_stream_cursor_image(source_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::save_theme_stream_cursor_image(source_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_theme_stream_cursor_script(source_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::save_theme_stream_cursor_script(source_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_theme_stream_cursor_script(script_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::read_theme_stream_cursor_script(script_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_theme_stream_cursor_svg(svg_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_theme_stream_cursor_svg(svg_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn save_theme_chat_avatar(source_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || crate::storage::save_theme_chat_avatar(source_path))
        .await
        .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_theme_chat_avatar(avatar_path: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_theme_chat_avatar(avatar_path))
        .await
        .map_err(map_spawn_error)?
}
