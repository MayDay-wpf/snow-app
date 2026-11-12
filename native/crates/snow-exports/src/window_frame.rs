//! 窗口外边框颜色：让应用窗口的外框脱离 Windows 个性化（强调色）影响。
//!
//! Windows 11 会为每个顶层窗口绘制一圈 1px 边框，其颜色默认取自系统个性化
//! 设置里的强调色。应用使用无边框窗口（frame: false）时这一圈边框仍由 DWM
//! 绘制，窗口外观因此随用户的系统颜色设置变化。这里通过
//! DwmSetWindowAttribute(DWMWA_BORDER_COLOR) 把边框固定为应用自身的背景色
//! （或直接取消绘制），使其只跟随应用主题。
//!
//! Windows 10 及更早版本不支持该属性，调用会失败，此时静默返回 false。

use napi_derive::napi;

/// 与 Windows SDK 的 DWMWA_COLOR_NONE 一致：不绘制窗口边框。
#[cfg(target_os = "windows")]
pub const WINDOW_BORDER_COLOR_NONE: u32 = 0xFFFF_FFFE;

/// 设置窗口外边框颜色（仅 Windows 生效，其他平台直接返回 false）。
///
/// `handle` 为窗口原生句柄（HWND），`color` 为 COLORREF（0x00BBGGRR），
/// 传 `null` 表示不绘制边框。返回是否成功应用。
#[napi]
pub async fn set_window_border_color(handle: i64, color: Option<u32>) -> bool {
  apply_window_border_color(handle, color)
}

#[cfg(target_os = "windows")]
fn apply_window_border_color(handle: i64, color: Option<u32>) -> bool {
  use windows_sys::Win32::Foundation::HWND;
  use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};

  let hwnd = handle as usize as HWND;
  if hwnd.is_null() {
    return false;
  }

  let value = color.unwrap_or(WINDOW_BORDER_COLOR_NONE);
  let result = unsafe {
    DwmSetWindowAttribute(
      hwnd,
      DWMWA_BORDER_COLOR as u32,
      (&value as *const u32).cast(),
      std::mem::size_of::<u32>() as u32,
    )
  };
  result >= 0
}

#[cfg(not(target_os = "windows"))]
fn apply_window_border_color(_handle: i64, _color: Option<u32>) -> bool {
  false
}
