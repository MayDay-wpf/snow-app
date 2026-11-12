//! 发往模型的图片降采样。
//!
//! 附件原图按内容哈希原样落盘（界面显示、预览、imagegen 参考图都读原图），
//! 但发往模型的副本没有必要保留原始分辨率：主流视觉模型在服务端也会把图片
//! 缩到长边 1568~2048 像素量级再计算 token，超出部分只会放大请求体——一张
//! 8MB 的 PNG base64 后约 10.7MB，且历史图片每轮都会随上下文重发，直接把
//! 发送阶段推过流式空闲看门狗，会话被反复超时卡死（Issue #223）。
//!
//! 这里在组装请求时把超限图片缩到长边 [`MAX_EDGE`] 像素并重新编码，结果按
//! 原图内容哈希缓存（含「无需压缩 / 压缩无收益」的判定），同一张图在会话
//! 后续轮次中只解码一次。

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, ImageFormat, ImageReader, Rgb, RgbImage};

/// 发往模型的图片长边上限（像素）。
const MAX_EDGE: u32 = 1568;
/// 长边未超限时允许原样发送的体积上限（字节）。
const MAX_BYTES: usize = 1024 * 1024;
const JPEG_QUALITY: u8 = 85;
/// 压缩结果缓存的总体积上限（base64 字节数），超出时整体清空重建。
const CACHE_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// 降采样后的请求图片：真实 MIME 与 base64 数据。
#[derive(Clone)]
pub struct RequestImage {
    pub media_type: &'static str,
    pub data: String,
}

#[derive(Default)]
struct OptimizeCache {
    /// 原图内容哈希 -> 压缩结果；`None` 表示该图应原样发送。
    entries: HashMap<[u8; 32], Option<RequestImage>>,
    total_bytes: usize,
}

fn cache() -> &'static Mutex<OptimizeCache> {
    static CACHE: OnceLock<Mutex<OptimizeCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(OptimizeCache::default()))
}

/// 为请求生成降采样副本。返回 `None` 表示原图可直接发送：格式不支持
/// 重新编码（仅处理 PNG / JPEG，GIF 动图等保持原样）、尺寸与体积均未超限、
/// 解码失败，或重新编码后并不比原图更小。
pub fn optimize_for_request(bytes: &[u8], media_type: &str) -> Option<RequestImage> {
    let format = match media_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        _ => return None,
    };
    // 只读文件头取尺寸，未超限的图片无需解码与哈希。
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .ok()?;
    let needs_resize = width.max(height) > MAX_EDGE;
    if !needs_resize && bytes.len() <= MAX_BYTES {
        return None;
    }

    let key = *blake3::hash(bytes).as_bytes();
    if let Ok(guard) = cache().lock() {
        if let Some(cached) = guard.entries.get(&key) {
            return cached.clone();
        }
    }

    let result = downsample(bytes, format, needs_resize);
    if let Ok(mut guard) = cache().lock() {
        let size = result.as_ref().map_or(0, |image| image.data.len());
        if guard.total_bytes.saturating_add(size) > CACHE_BUDGET_BYTES {
            guard.entries.clear();
            guard.total_bytes = 0;
        }
        guard.total_bytes += size;
        guard.entries.insert(key, result.clone());
    }
    result
}

fn downsample(bytes: &[u8], format: ImageFormat, needs_resize: bool) -> Option<RequestImage> {
    let decoded = image::load_from_memory_with_format(bytes, format).ok()?;
    let resized = if needs_resize {
        // resize 等比缩放到 MAX_EDGE 见方的包围盒内，只缩不放。
        decoded.resize(MAX_EDGE, MAX_EDGE, FilterType::CatmullRom)
    } else {
        decoded
    };
    let (media_type, encoded) = encode(&resized)?;
    if encoded.len() >= bytes.len() {
        return None;
    }
    Some(RequestImage {
        media_type,
        data: base64::engine::general_purpose::STANDARD.encode(encoded),
    })
}

/// 不透明图片统一编码为 JPEG；含透明像素时优先保留 PNG，PNG 仍超出体积
/// 上限再铺白底转 JPEG（视觉模型对透明区域本就按底色合成理解）。
fn encode(image: &DynamicImage) -> Option<(&'static str, Vec<u8>)> {
    if has_transparency(image) {
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .ok()?;
        if png.len() <= MAX_BYTES {
            return Some(("image/png", png));
        }
        return encode_jpeg(&flatten_on_white(image)).map(|jpeg| ("image/jpeg", jpeg));
    }
    encode_jpeg(&image.to_rgb8()).map(|jpeg| ("image/jpeg", jpeg))
}

fn has_transparency(image: &DynamicImage) -> bool {
    image.color().has_alpha() && image.to_rgba8().pixels().any(|pixel| pixel.0[3] < u8::MAX)
}

fn flatten_on_white(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut flattened = RgbImage::new(rgba.width(), rgba.height());
    for (target, source) in flattened.pixels_mut().zip(rgba.pixels()) {
        let alpha = u16::from(source.0[3]);
        let blend =
            |channel: u8| ((u16::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8;
        *target = Rgb([blend(source.0[0]), blend(source.0[1]), blend(source.0[2])]);
    }
    flattened
}

fn encode_jpeg(rgb: &RgbImage) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    JpegEncoder::new_with_quality(&mut buffer, JPEG_QUALITY)
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .ok()?;
    Some(buffer)
}
