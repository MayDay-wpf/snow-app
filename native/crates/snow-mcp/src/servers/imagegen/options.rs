//! Shared effective options for both real generation and auto execution-mode decisions.

use super::*;

pub(super) struct ResolvedImageOptions {
    pub model: String,
    pub size: Option<String>,
    pub quality: Option<String>,
}

pub(super) fn resolve_options(
    args: &Value,
    channel: &ImageGenChannel,
) -> napi::Result<ResolvedImageOptions> {
    let model = args.get("model").and_then(Value::as_str).and_then(non_empty)
        .or_else(|| non_empty(&channel.primary_model()))
        .ok_or_else(|| Error::from_reason("No image model configured for the selected channel. Configure the model in Settings -> Image generation, or pass the `model` argument explicitly."))?;
    let model_item = channel.find_model_config(&model);
    let size = args
        .get("size")
        .and_then(Value::as_str)
        .and_then(non_empty)
        .or_else(|| {
            model_item
                .as_ref()
                .and_then(|item| non_empty(&item.default_size))
        })
        .or_else(|| non_empty(&channel.default_size))
        .and_then(|value| {
            sanitize_size(
                Some(&value),
                model_item
                    .as_ref()
                    .map(|item| item.supported_ratios.as_str())
                    .unwrap_or(""),
                model_item
                    .as_ref()
                    .map(|item| item.supported_resolutions.as_str())
                    .unwrap_or(""),
            )
        });
    let quality = args
        .get("quality")
        .and_then(Value::as_str)
        .and_then(non_empty)
        .or_else(|| {
            model_item
                .as_ref()
                .and_then(|item| non_empty(&item.default_quality))
        })
        .or_else(|| non_empty(&channel.default_quality));
    Ok(ResolvedImageOptions {
        model,
        size,
        quality,
    })
}

fn execution_mode(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|mode| matches!(*mode, "auto" | "sync" | "async"))
}

pub(super) fn asynchronous(args: &Value, settings: &ImageGenSettings) -> bool {
    let channel = resolve_channel(args, settings)
        .ok()
        .map(|(_, channel)| channel);
    // An explicit auto is a decision, not an absent setting: each higher layer overrides the lower.
    let mode = execution_mode(args.get("mode").and_then(Value::as_str))
        .or_else(|| execution_mode(channel.and_then(|channel| channel.execution_mode.as_deref())))
        .or_else(|| execution_mode(settings.execution_mode.as_deref()))
        .unwrap_or("auto");
    match mode {
        "sync" => false,
        "async" => true,
        _ => channel
            .and_then(|channel| resolve_options(args, channel).ok())
            .is_some_and(|options| heavy_auto_request(args, &options)),
    }
}

fn heavy_auto_request(args: &Value, options: &ResolvedImageOptions) -> bool {
    let count = args
        .get("prompts")
        .and_then(Value::as_array)
        .map(|prompts| {
            prompts
                .iter()
                .filter_map(Value::as_str)
                .filter(|prompt| !prompt.trim().is_empty())
                .count()
        })
        .unwrap_or_else(|| {
            let n = args
                .get("n")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_N as u64)
                .clamp(1, MAX_PARALLEL_IMAGES as u64) as usize;
            if options.model.to_ascii_lowercase().starts_with("dall-e-3") {
                1
            } else {
                n
            }
        });
    let heavy_quality = options.quality.as_deref().is_some_and(|quality| {
        matches!(
            quality.trim().to_ascii_lowercase().as_str(),
            "high" | "xhigh" | "max" | "hd"
        )
    });
    let model = options.model.to_ascii_lowercase();
    let grok_resolution = (model.contains("grok-imagine") || model.contains("grok-image"))
        && args
            .get("resolution")
            .and_then(Value::as_str)
            .is_some_and(high_resolution);
    count > 1
        || heavy_quality
        || options.size.as_deref().is_some_and(high_resolution)
        || grok_resolution
}

fn high_resolution(size: &str) -> bool {
    let size = size.trim().to_ascii_lowercase();
    let tier = size.rsplit('@').next().unwrap_or(&size).trim();
    if matches!(tier, "2k" | "4k") {
        return true;
    }
    tier.split_once('x')
        .and_then(|(width, height)| {
            Some((
                width.trim().parse::<u32>().ok()?,
                height.trim().parse::<u32>().ok()?,
            ))
        })
        .is_some_and(|(width, height)| width.max(height) >= 2048)
}
