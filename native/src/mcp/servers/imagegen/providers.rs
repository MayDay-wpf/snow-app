use super::*;

impl ImageGenService {
    /// OpenAI Images API branch:
    /// - text-to-image:   POST {base}/images/generations (JSON, optional SSE stream)
    /// - image-to-image:  POST {base}/images/edits (multipart form, reference images)
    pub(super) async fn generate_openai(
        &self,
        args: &Value,
        prompts: &[&str],
        model: &str,
        size: &Option<String>,
        quality: &Option<String>,
        output_format: &Option<String>,
        frame_count: Option<u64>,
        frame_duration_ms: Option<u64>,
        base_url: &str,
        api_key: &str,
        n: usize,
        stream_enabled: bool,
        on_chunk: Option<&BashStreamCallback>,
        images: &[&[ReferenceImage]],
        seed: Option<u64>,
        input_fidelity: Option<&str>,
        background: Option<&str>,
        moderation: Option<&str>,
        complexity: Option<&str>,
        safety_identifier: Option<&str>,
        mask: Option<&ReferenceImage>,
        channel_label: &str,
        timeout_secs: Option<u64>,
    ) -> napi::Result<Value> {
        let mime_type = mime_for_format(output_format.as_deref().unwrap_or("png"));
        let format_lower = output_format
            .as_deref()
            .map(|value| value.to_ascii_lowercase());
        // svg / gif 输出：仅文生图（generations）；图生图已在分发前显式报错。
        // 这两类格式不支持流式预览与 output_compression。
        let is_svg_or_gif = matches!(format_lower.as_deref(), Some("svg" | "gif"));
        let is_gif = format_lower.as_deref() == Some("gif");
        let is_dall_e = model.to_ascii_lowercase().starts_with("dall-e");
        let is_gpt_image_2 = model.to_ascii_lowercase().contains("gpt-image-2");
        // xAI Grok Imagine：OpenAI 兼容端点，但尺寸用 aspect_ratio + resolution
        // （不走 size），图生图走 JSON body（非 multipart），不支持 SSE 流式。
        let is_grok = model.to_ascii_lowercase().contains("grok-imagine")
            || model.to_ascii_lowercase().contains("grok-image");

        // 单次调用内并发 n 个子请求（每个子请求 n=1）：中转/上游不支持
        // 单请求多图，拆成并发请求绕开限制。n>1 时禁用流式——多路
        // partial_image 事件无法区分归属，预览会互相覆盖。
        let requests = n.max(1);
        let allow_stream = stream_enabled
            && on_chunk.is_some()
            && requests == 1
            && !is_dall_e
            && !is_grok
            && !is_svg_or_gif
            && images.iter().all(|set| set.is_empty());
        let client = build_client(timeout_secs).await?;

        let tasks: Vec<_> = (0..requests)
            .map(|request_index| {
                let client = client.clone();
                let mime_type = mime_type.clone();
                let edits_endpoint = format!("{base_url}/images/edits");
                let generations_endpoint = format!("{base_url}/images/generations");
                async move {
                    // Hold through streaming, downloads and image-library persistence; legacy n uses one per image.
                    let _permit = limiter::acquire().await;
                    runtime::request_started(args, on_chunk).await?;
                    // 当前请求的提示词与参考图（prompts/requestImages 逐请求分发）
                    let prompt = prompts[request_index];
                    let request_images: &[ReferenceImage] = images[request_index];
                    // 用户显式指定 seed 且并发多张时逐张递增，避免生成完全相同的图
                    let request_seed = seed.map(|value| value.wrapping_add(request_index as u64));

                    // --- Image-to-image: POST /images/edits ---
                    if !request_images.is_empty() {
                        // xAI Grok Imagine：edits 走 application/json（非 multipart），
                        // 参考图以 data URI 形式放入 image.url；暂取第一张。
                        if is_grok {
                            let body = json!({
                                "model": model,
                                "prompt": prompt,
                                "image": {
                                    "url": format!(
                                        "data:{};base64,{}",
                                        request_images[0].mime_type, request_images[0].data
                                    )
                                }
                            });
                            let response = client
                                .post(&edits_endpoint)
                                .bearer_auth(api_key)
                                .json(&body)
                                .send()
                                .await
                                .map_err(|error| {
                                    generic_error(format!(
                                        "Grok image edit request failed: {error}"
                                    ))
                                })?;
                            let status = response.status();
                            let response_body: Value =
                                response.json().await.unwrap_or_else(|_| json!({}));
                            if !status.is_success() {
                                return Err(api_error(
                                    "Grok image edit failed",
                                    status.as_u16(),
                                    &response_body,
                                ));
                            }
                            let Some(data) = response_body.get("data").and_then(Value::as_array)
                            else {
                                return Err(generic_error(
                                    "Grok image edit response is missing the data array"
                                        .to_string(),
                                ));
                            };
                            return openai_stream::collect_openai_result(
                                prompt,
                                model,
                                channel_label,
                                data.iter().cloned().collect(),
                                mime_type,
                            )
                            .await;
                        }
                        let build_form =
                            |background: Option<&str>| -> napi::Result<reqwest::multipart::Form> {
                                let mut form = reqwest::multipart::Form::new()
                                    .text("model", model.to_string())
                                    .text("prompt", prompt.to_string())
                                    .text("n", "1");
                                for (index, image) in request_images.iter().enumerate() {
                                    let bytes = reference_image::decode_base64(&image.data)?;
                                    let file_name = format!(
                                        "image-{}.{}",
                                        index + 1,
                                        reference_image::ext_for_mime(&image.mime_type)
                                    );
                                    let part = reqwest::multipart::Part::bytes(bytes)
                                        .file_name(file_name)
                                        .mime_str(&image.mime_type)
                                        .map_err(|error| {
                                            generic_error(format!(
                                                "Failed to build multipart part: {error}"
                                            ))
                                        })?;
                                    form = form.part("image[]", part);
                                }
                                if let Some(value) = size {
                                    form = form.text("size", value.clone());
                                }
                                if let Some(value) = quality {
                                    form = form.text("quality", value.clone());
                                }
                                if let Some(value) = output_format {
                                    form = form.text("output_format", value.clone());
                                }
                                if let Some(value) =
                                    args.get("outputCompression").and_then(Value::as_u64)
                                {
                                    form = form.text(
                                        "output_compression",
                                        value.clamp(0, 100).to_string(),
                                    );
                                }
                                if let Some(value) = input_fidelity {
                                    // gpt-image-2 不允许设置 input_fidelity（自动高保真）
                                    if !is_gpt_image_2 && matches!(value, "low" | "high" | "auto") {
                                        form = form.text("input_fidelity", value.to_string());
                                    }
                                }
                                if let Some(value) = sanitize_background(model, background) {
                                    form = form.text("background", value.to_string());
                                }
                                if let Some(value) = moderation {
                                    if matches!(value, "auto" | "low") {
                                        form = form.text("moderation", value.to_string());
                                    }
                                }
                                if let Some(value) = complexity {
                                    form = form.text("complexity", value.to_string());
                                }
                                if let Some(value) = safety_identifier {
                                    form = form.text("safety_identifier", value.to_string());
                                }
                                if let Some(mask_image) = mask {
                                    let bytes = reference_image::decode_base64(&mask_image.data)?;
                                    let file_name = format!(
                                        "mask.{}",
                                        reference_image::ext_for_mime(&mask_image.mime_type)
                                    );
                                    let part = reqwest::multipart::Part::bytes(bytes)
                                        .file_name(file_name)
                                        .mime_str(&mask_image.mime_type)
                                        .map_err(|error| {
                                            generic_error(format!(
                                                "Failed to build mask multipart part: {error}"
                                            ))
                                        })?;
                                    form = form.part("mask", part);
                                }
                                Ok(form)
                            };

                        // 部分模型/代理不支持透明背景（400 "Transparent background is not
                        // supported"）：去掉 background 参数后重试一次
                        let mut attempt = 0;
                        let mut current_background = background;
                        let response = loop {
                            let form = build_form(current_background)?;
                            let response = client
                                .post(&edits_endpoint)
                                .bearer_auth(api_key)
                                .multipart(form)
                                .send()
                                .await
                                .map_err(|error| {
                                    generic_error(format!("Image edit request failed: {error}"))
                                })?;
                            let status = response.status();
                            if status.is_success() {
                                break response;
                            }
                            let response_body: Value =
                                response.json().await.unwrap_or_else(|_| json!({}));
                            if attempt == 0
                                && current_background.is_some()
                                && is_transparent_unsupported_error(&response_body)
                            {
                                current_background = None;
                                attempt += 1;
                                continue;
                            }
                            return Err(api_error(
                                "Image edit failed",
                                status.as_u16(),
                                &response_body,
                            ));
                        };

                        let response_body: Value = response.json().await.map_err(|error| {
                            generic_error(format!("Failed to parse image edit response: {error}"))
                        })?;
                        let Some(data) = response_body.get("data").and_then(Value::as_array) else {
                            return Err(generic_error(
                                "Image edit response is missing the data array".to_string(),
                            ));
                        };
                        return openai_stream::collect_openai_result(
                            prompt,
                            model,
                            channel_label,
                            data.iter().cloned().collect(),
                            mime_type,
                        )
                        .await;
                    }

                    // --- Text-to-image: POST /images/generations (JSON) ---
                    // size / quality / outputFormat are only sent when explicitly provided
                    // so that OpenAI-compatible third-party endpoints (which may reject
                    // unknown fields) keep working with a plain {model, prompt, n} body.
                    let mut body = json!({
                        "model": model,
                        "prompt": prompt,
                        "n": 1,
                    });
                    if is_grok {
                        // xAI Grok Imagine：尺寸 = aspect_ratio + resolution（1k/2k），
                        // 不走 OpenAI 的 size；quality 仅 low/medium（2.0 支持）；
                        // 不支持 output_format / output_compression / seed /
                        // background / moderation，一律不发送。
                        if let Some(value) = args.get("aspectRatio").and_then(Value::as_str) {
                            if !value.is_empty() {
                                body["aspect_ratio"] = json!(value);
                            }
                        }
                        if let Some(value) = args.get("resolution").and_then(Value::as_str) {
                            if !value.is_empty() {
                                body["resolution"] = json!(value);
                            }
                        }
                        if let Some(value) = quality {
                            if matches!(value.as_str(), "low" | "medium") {
                                body["quality"] = json!(value);
                            }
                        }
                        body["response_format"] = json!("b64_json");
                    } else {
                        if let Some(value) = size {
                            body["size"] = json!(value);
                        }
                        if let Some(value) = quality {
                            body["quality"] = json!(value);
                        }
                        if let Some(value) = output_format {
                            body["output_format"] = json!(value);
                        }
                        if is_gif {
                            if let Some(value) = frame_count {
                                body["frame_count"] = json!(value);
                            }
                            if let Some(value) = frame_duration_ms {
                                body["frame_duration_ms"] = json!(value);
                            }
                        }
                        if let Some(value) = complexity {
                            body["complexity"] = json!(value);
                        }
                        if !is_svg_or_gif {
                            if let Some(value) =
                                args.get("outputCompression").and_then(Value::as_u64)
                            {
                                // jpeg/webp 专属压缩率 0-100（gpt-image 系列）；
                                // svg/gif 输出禁止发送该字段。
                                body["output_compression"] = json!(value.clamp(0, 100));
                            }
                        }
                        if let Some(value) = request_seed {
                            body["seed"] = json!(value);
                        }
                        if let Some(value) = sanitize_background(model, background) {
                            body["background"] = json!(value);
                        }
                        if let Some(value) = moderation {
                            if matches!(value, "auto" | "low") {
                                body["moderation"] = json!(value);
                            }
                        }
                        if let Some(value) = safety_identifier {
                            body["safety_identifier"] = json!(value);
                        }
                        if allow_stream {
                            // gpt-image 系列流式：生成过程中推送 0-3 张中间预览
                            body["stream"] = json!(true);
                            body["partial_images"] = json!(2);
                        }
                        if is_dall_e {
                            // dall-e-3 uses `response_format` (b64_json) and does not accept
                            // `output_format` / `stream` / `background`; its `quality` values
                            // (standard/hd) differ from gpt-image (low/medium/high), so drop
                            // them to avoid a 400.
                            body["response_format"] = json!("b64_json");
                            if let Some(map) = body.as_object_mut() {
                                map.remove("output_format");
                                map.remove("output_compression");
                                map.remove("quality");
                                map.remove("complexity");
                                map.remove("stream");
                                map.remove("partial_images");
                                map.remove("background");
                                map.remove("moderation");
                                map.remove("safety_identifier");
                            }
                        }
                    }

                    // 部分模型/代理不支持透明背景（400 "Transparent background is not
                    // supported"）：去掉 background 参数后重试一次
                    let mut attempt = 0;
                    let response = loop {
                        let response = client
                            .post(&generations_endpoint)
                            .bearer_auth(api_key)
                            .json(&body)
                            .send()
                            .await
                            .map_err(|error| {
                                generic_error(format!("Image generation request failed: {error}"))
                            })?;
                        let status = response.status();
                        if status.is_success() {
                            break response;
                        }
                        let response_body: Value =
                            response.json().await.unwrap_or_else(|_| json!({}));
                        if attempt == 0
                            && body.get("background").is_some()
                            && is_transparent_unsupported_error(&response_body)
                        {
                            if let Some(map) = body.as_object_mut() {
                                map.remove("background");
                            }
                            attempt += 1;
                            continue;
                        }
                        return Err(api_error(
                            "Image generation failed",
                            status.as_u16(),
                            &response_body,
                        ));
                    };

                    // --- Streaming path: consume the SSE stream and forward partials ---
                    if allow_stream {
                        let mut partials: Vec<(usize, String)> = Vec::new();
                        let mut completed: Vec<Value> = Vec::new();
                        openai_stream::read_openai_sse(
                            response,
                            &mut partials,
                            &mut completed,
                            on_chunk.expect("allow_stream guarantees on_chunk is some"),
                            &mime_type,
                        )
                        .await?;

                        let final_images = if !completed.is_empty() {
                            completed
                        } else if !partials.is_empty() {
                            partials
                                .into_iter()
                                .max_by_key(|(index, _)| *index)
                                .into_iter()
                                .map(|(_, data)| json!({ "b64_json": data }))
                                .collect()
                        } else {
                            return Err(generic_error(
                                "Image generation stream ended without any image data".to_string(),
                            ));
                        };
                        return openai_stream::collect_openai_result(
                            prompt,
                            model,
                            channel_label,
                            final_images,
                            mime_type,
                        )
                        .await;
                    }

                    // --- Non-streaming path ---
                    let response_body: Value = response.json().await.map_err(|error| {
                        generic_error(format!(
                            "Failed to parse image generation response: {error}"
                        ))
                    })?;

                    let Some(data) = response_body.get("data").and_then(Value::as_array) else {
                        return Err(generic_error(
                            "Image generation response is missing the data array".to_string(),
                        ));
                    };

                    openai_stream::collect_openai_result(
                        prompt,
                        model,
                        channel_label,
                        data.iter().cloned().collect(),
                        mime_type,
                    )
                    .await
                }
            })
            .collect();

        let results = futures::future::join_all(tasks).await;
        merge_parallel_results(prompts[0], model, channel_label, requests, results)
    }

    /// NovelAI branch.
    /// - Native API: `POST {base}/ai/generate-image` (JSON body, Bearer persistent token).
    /// - text-to-image:  action = "generate"
    /// - image-to-image: action = "img2img" (single base image, `parameters.image`)
    /// - inpainting:     action = "infill"  (base image + `parameters.mask`)
    /// - Response: ZIP archive containing one PNG per sample (or a raw PNG).
    pub(super) async fn generate_novelai(
        &self,
        args: &Value,
        prompts: &[&str],
        model: &str,
        size: &Option<String>,
        base_url: &str,
        api_key: &str,
        n: usize,
        images: &[&[ReferenceImage]],
        seed: Option<u64>,
        negative_prompt: Option<&str>,
        mask: Option<&ReferenceImage>,
        channel_label: &str,
        timeout_secs: Option<u64>,
    ) -> napi::Result<Value> {
        // 单次调用内并发 n 个子请求（每个子请求 n_samples=1），与 OpenAI 分支同策略。
        let requests = n.max(1);
        let client = build_client(timeout_secs).await?;
        let endpoint = format!("{base_url}/ai/generate-image");

        let tasks: Vec<_> = (0..requests)
            .map(|request_index| {
                let client = client.clone();
                let endpoint = endpoint.clone();
                async move {
                    let _permit = limiter::acquire().await;
                    runtime::request_started(args, None).await?;
                    let prompt = prompts[request_index];
                    let request_images: &[ReferenceImage] = images[request_index];
                    let request_seed = seed.map(|value| value.wrapping_add(request_index as u64));

                    // action：mask → infill；参考图 → img2img；否则 generate
                    let has_mask = mask.is_some();
                    let action = if has_mask {
                        "infill"
                    } else if !request_images.is_empty() {
                        "img2img"
                    } else {
                        "generate"
                    };

                    // 尺寸：WIDTHxHEIGHT → width/height（未提供时交由上游默认）
                    let (width, height) = parse_novelai_size(size)?;
                    let mut parameters = json!({
                        "params_version": 3,
                        "n_samples": 1,
                    });
                    if width > 0 && height > 0 {
                        parameters["width"] = json!(width);
                        parameters["height"] = json!(height);
                    }
                    if let Some(value) = request_seed {
                        parameters["seed"] = json!(value);
                    }
                    if let Some(value) = negative_prompt {
                        let value = value.trim();
                        if !value.is_empty() {
                            // NovelAI 反向提示词字段（undesired content）
                            parameters["uc"] = json!(value);
                        }
                    }

                    if action != "generate" {
                        if request_images.is_empty() {
                            return Err(Error::new(
                                Status::InvalidArg,
                                "NovelAI img2img / infill requires a base reference image (`images`)"
                                    .to_string(),
                            ));
                        }
                        if request_images.len() > 1 {
                            return Err(Error::new(
                                Status::InvalidArg,
                                format!(
                                    "NovelAI img2img / infill accepts a single base reference image, got {}",
                                    request_images.len()
                                ),
                            ));
                        }
                        let image = &request_images[0];
                        let bytes = reference_image::decode_base64(&image.data)?;
                        parameters["image"] =
                            json!(base64::engine::general_purpose::STANDARD.encode(&bytes));
                        if has_mask {
                            let mask_image = mask.expect("has_mask implies mask is set");
                            let mask_bytes = reference_image::decode_base64(&mask_image.data)?;
                            parameters["mask"] = json!(base64::engine::general_purpose::STANDARD
                                .encode(&mask_bytes));
                        }
                    }

                    let body = json!({
                        "input": prompt,
                        "model": model,
                        "action": action,
                        "parameters": parameters,
                    });

                    let response = client
                        .post(&endpoint)
                        .bearer_auth(api_key)
                        .json(&body)
                        .send()
                        .await
                        .map_err(|error| {
                            generic_error(format!("NovelAI image request failed: {error}"))
                        })?;
                    let status = response.status();
                    if !status.is_success() {
                        let response_body: Value =
                            response.json().await.unwrap_or_else(|_| json!({}));
                        return Err(novelai_api_error(status.as_u16(), &response_body));
                    }
                    let bytes = response.bytes().await.map_err(|error| {
                        generic_error(format!("Failed to read NovelAI image response: {error}"))
                    })?;
                    let png = extract_novelai_png(&bytes)?;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                    openai_stream::collect_openai_result(
                        prompt,
                        model,
                        channel_label,
                        vec![json!({ "b64_json": b64 })],
                        "image/png".to_string(),
                    )
                    .await
                }
            })
            .collect();

        let results = futures::future::join_all(tasks).await;
        merge_parallel_results(prompts[0], model, channel_label, requests, results)
    }

    /// Google Gemini branch.
    /// - Nano Banana 2 / Pro / Lite (`gemini-3.1-flash-image`,
    ///   `gemini-3-pro-image`, `gemini-3.1-flash-lite-image`) use the
    ///   official **Interactions API** (`POST /v1beta/interactions`, model in
    ///   body, `response_format` for image config).
    /// - Older models (`gemini-2.5-flash-image`, Imagen) keep using
    ///   `POST /v1beta/models/{model}:generateContent`.
    pub(super) async fn generate_gemini(
        &self,
        args: &Value,
        channel: &ImageGenChannel,
        prompts: &[&str],
        model: &str,
        size: &Option<String>,
        quality: &Option<String>,
        base_url: &str,
        api_key: &str,
        n: usize,
        stream_enabled: bool,
        on_chunk: Option<&BashStreamCallback>,
        images: &[&[ReferenceImage]],
        seed: Option<u64>,
        thinking_level: Option<&str>,
        negative_prompt: Option<&str>,
        image_search: bool,
        channel_label: &str,
        timeout_secs: Option<u64>,
    ) -> napi::Result<Value> {
        let model_lower = model.to_ascii_lowercase();
        let is_nano_banana = model_lower.contains("banana")
            || model_lower.contains("flash-image")
            || model_lower.contains("pro-image")
            || model_lower.contains("lite-image")
            || model_lower.contains("gemini-3")
            || model_lower.contains("gemini-2.5");
        let is_nano_banana_2 = is_nano_banana && !model_lower.contains("gemini-2.5");

        // --- Shared: web search grounding (tools) ---
        let web_search = args
            .get("webSearch")
            .and_then(Value::as_bool)
            .unwrap_or(channel.web_search);
        let mut tools: Vec<Value> = Vec::new();
        if web_search || image_search {
            let mut search_tool = json!({ "type": "google_search" });
            if image_search {
                // 图片搜索（3.1 Flash Image 专属）：web + image 双通道
                search_tool["search_types"] = json!(["web_search", "image_search"]);
            }
            tools.push(search_tool);
        }

        // 单次调用内并发 n 个子请求（与 OpenAI 分支同策略）；n>1 禁用流式
        // （多路流式事件无法区分归属，预览会互相覆盖）。
        let requests = n.max(1);
        let allow_stream = stream_enabled && on_chunk.is_some() && requests == 1;
        let client = build_client(timeout_secs).await?;

        // --- Nano Banana 2+: Interactions API 共享配置 ---
        let interactions_endpoint = format!("{base_url}/interactions");
        let mut interactions_response_format = json!({
            "type": "image",
        });
        if let Some(size) = size {
            let trimmed = size.trim();
            // 组合格式 "16:9@2K"：同时设置 aspect_ratio + image_size
            if let Some((ratio_part, size_part)) = trimmed.split_once('@') {
                let ratio = ratio_part.trim();
                let image_size = size_part.trim();
                if matches!(image_size, "1K" | "2K" | "4K" | "0.5K" | "512") {
                    interactions_response_format["image_size"] = json!(image_size);
                }
                if ratio.contains(':')
                    && ratio.split(':').count() == 2
                    && ratio.split(':').all(|part| part.parse::<u32>().is_ok())
                {
                    interactions_response_format["aspect_ratio"] = json!(ratio);
                }
            } else if matches!(trimmed, "1K" | "2K" | "4K" | "0.5K" | "512") {
                interactions_response_format["image_size"] = json!(trimmed);
            } else if trimmed.contains(':')
                && trimmed.split(':').count() == 2
                && trimmed.split(':').all(|part| part.parse::<u32>().is_ok())
            {
                interactions_response_format["aspect_ratio"] = json!(trimmed);
            }
        }
        if let Some(quality) = quality {
            if matches!(quality.as_str(), "low" | "medium" | "high") {
                interactions_response_format["image_quality"] = json!(quality);
            }
        }
        // 输出格式（Gemini 3 系列 response_format mime_type：png / jpeg）
        if let Some(output_format) = args.get("outputFormat").and_then(Value::as_str) {
            match output_format.trim().to_ascii_lowercase().as_str() {
                "png" => {
                    interactions_response_format["mime_type"] = json!("image/png");
                }
                "jpeg" | "jpg" => {
                    interactions_response_format["mime_type"] = json!("image/jpeg");
                }
                _ => {}
            }
        }
        let mut interactions_generation_config = json!({});
        if let Some(level) = thinking_level {
            let lower = level.to_ascii_lowercase();
            let effective = match lower.as_str() {
                "minimal" | "low" => "minimal",
                "medium" => "medium",
                "high" => "high",
                _ => "",
            };
            if !effective.is_empty() {
                interactions_generation_config["thinking_level"] = json!(effective);
            }
        }
        if let Some(person_generation) = args
            .get("personGeneration")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if matches!(
                person_generation,
                "dont_allow" | "allow_all" | "allow_adult"
            ) {
                interactions_generation_config["personGeneration"] = json!(person_generation);
            }
        }

        // --- Legacy: generateContent API 共享配置 ---
        let legacy_endpoint = format!("{base_url}/models/{model}:generateContent");
        let legacy_stream_endpoint = format!("{base_url}/models/{model}:streamGenerateContent");
        let mut legacy_generation_config = json!({ "responseModalities": ["IMAGE"] });
        // size: "1K"/"2K"/"4K" -> imageSize; "N:N" (e.g. "16:9") -> aspectRatio;
        // "16:9@2K" -> 两者同时设置。
        if let Some(size) = size {
            let trimmed = size.trim();
            if let Some((ratio_part, size_part)) = trimmed.split_once('@') {
                let ratio = ratio_part.trim();
                let image_size = size_part.trim();
                if matches!(image_size, "1K" | "2K" | "4K") {
                    legacy_generation_config["imageSize"] = json!(image_size);
                }
                if ratio.contains(':')
                    && ratio.split(':').count() == 2
                    && ratio.split(':').all(|part| part.parse::<u32>().is_ok())
                {
                    legacy_generation_config["aspectRatio"] = json!(ratio);
                }
            } else if matches!(trimmed, "1K" | "2K" | "4K") {
                legacy_generation_config["imageSize"] = json!(trimmed);
            } else if trimmed.contains(':')
                && trimmed.split(':').count() == 2
                && trimmed.split(':').all(|part| part.parse::<u32>().is_ok())
            {
                legacy_generation_config["aspectRatio"] = json!(trimmed);
            }
        }
        if let Some(quality) = quality {
            if matches!(quality.as_str(), "low" | "medium" | "high") {
                legacy_generation_config["imageQuality"] = json!(quality);
            }
        }
        if let Some(level) = thinking_level {
            let lower = level.to_ascii_lowercase();
            if matches!(lower.as_str(), "minimal" | "low") {
                legacy_generation_config["thinkingConfig"] = json!({ "thinkingBudget": 1024 });
            } else if lower == "medium" {
                // 官方 medium 档（Nano Banana 2.1 默认）在 legacy 协议里没有
                // 字符串档位，只能近似为介于 minimal(1024) 与 high(4096) 之间的预算。
                legacy_generation_config["thinkingConfig"] = json!({ "thinkingBudget": 2048 });
            } else if lower == "high" {
                legacy_generation_config["thinkingConfig"] = json!({ "thinkingBudget": 4096 });
            }
        }
        if let Some(person_generation) = args
            .get("personGeneration")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if matches!(
                person_generation,
                "dont_allow" | "allow_all" | "allow_adult"
            ) {
                legacy_generation_config["personGeneration"] = json!(person_generation);
            }
        }
        // 反向提示词：仅 Imagen 系（generateContent 官方支持
        // generationConfig.negativePrompt）；Nano Banana 2.5 / 3 系列忽略
        // （官方建议用语义化正向描述，无独立 negative prompt 概念）。
        if let Some(value) = negative_prompt {
            if model.to_ascii_lowercase().starts_with("imagen") {
                legacy_generation_config["negativePrompt"] = json!(value);
            }
        }

        let tasks: Vec<_> = (0..requests)
            .map(|request_index| {
                let client = client.clone();
                let tools = tools.clone();
                let interactions_response_format = interactions_response_format.clone();
                let interactions_generation_config = interactions_generation_config.clone();
                let interactions_endpoint = interactions_endpoint.clone();
                let legacy_endpoint = legacy_endpoint.clone();
                let legacy_stream_endpoint = legacy_stream_endpoint.clone();
                let legacy_generation_config = legacy_generation_config.clone();
                async move {
                    // Share the same permit pool as OpenAI, including every legacy join_all member.
                    let _permit = limiter::acquire().await;
                    runtime::request_started(args, on_chunk).await?;
                    // 当前请求的提示词与参考图（prompts/requestImages 逐请求分发）
                    let prompt = prompts[request_index];
                    let request_images: &[ReferenceImage] = images[request_index];
                    // 用户显式指定 seed 且并发多张时逐张递增，避免生成完全相同的图
                    let request_seed = seed.map(|value| value.wrapping_add(request_index as u64));

                    // --- Nano Banana 2+: Interactions API ---
                    if is_nano_banana_2 {
                        // input parts：参考图（图生图）在前，文本指令在后
                        let mut input_parts: Vec<Value> = Vec::new();
                        for image in request_images {
                            input_parts.push(json!({
                                "type": "image",
                                "mime_type": image.mime_type,
                                "data": image.data,
                            }));
                        }
                        input_parts.push(json!({ "type": "text", "text": prompt }));

                        let mut generation_config = interactions_generation_config.clone();
                        if let Some(value) = request_seed {
                            generation_config["seed"] = json!(value);
                        }

                        let mut body = json!({
                            "model": model,
                            "input": input_parts,
                            "response_format": interactions_response_format,
                        });
                        if !tools.is_empty() {
                            body["tools"] = json!(tools);
                        }
                        if generation_config.as_object().is_some_and(|m| !m.is_empty()) {
                            body["generation_config"] = generation_config;
                        }
                        // 流式：官方 Interactions API 用 `stream: true` 走 SSE 事件流
                        // （interaction.created → step.start/step.delta/step.stop →
                        // interaction.completed → done），图片以 delta.type == "image"
                        // 的 base64 增量到达。仅单请求（requests == 1）时启用，
                        // 多路流式无法区分归属（与 OpenAI / legacy 分支同策略）。
                        if allow_stream {
                            body["stream"] = json!(true);
                        }

                        let response = client
                            .post(&interactions_endpoint)
                            .header("x-goog-api-key", api_key)
                            .json(&body)
                            .send()
                            .await
                            .map_err(|error| {
                                generic_error(format!("Image generation request failed: {error}"))
                            })?;
                        let status = response.status();
                        if !status.is_success() {
                            let response_body: Value =
                                response.json().await.unwrap_or_else(|_| json!({}));
                            return Err(api_error(
                                "Image generation failed",
                                status.as_u16(),
                                &response_body,
                            ));
                        }

                        // --- 流式路径：边到达边推送预览图 ---
                        if allow_stream {
                            let images = gemini_stream::read_interactions_stream(
                                response,
                                on_chunk.expect("allow_stream guarantees on_chunk is some"),
                            )
                            .await?;
                            return gemini_stream::collect_gemini_result(
                                prompt,
                                model,
                                channel_label,
                                images,
                            );
                        }

                        let response_body: Value = response.json().await.map_err(|error| {
                            generic_error(format!(
                                "Failed to parse image generation response: {error}"
                            ))
                        })?;

                        // 非流式：解析 steps[].content 中 type == "image" 的块
                        // （仅 model_output 步骤；thought 步骤是隐藏草稿）。
                        let images = gemini_stream::parse_interactions_images(&response_body);
                        return gemini_stream::collect_gemini_result(
                            prompt,
                            model,
                            channel_label,
                            images,
                        );
                    }

                    // --- Legacy: generateContent API ---
                    let mut generation_config = legacy_generation_config.clone();
                    if let Some(value) = request_seed {
                        generation_config["seed"] = json!(value);
                    }

                    // contents.parts: 参考图（图生图）在前，文本指令在后
                    let mut parts: Vec<Value> = Vec::new();
                    for image in request_images {
                        parts.push(json!({
                            "inlineData": {
                                "mimeType": image.mime_type,
                                "data": image.data,
                            }
                        }));
                    }
                    parts.push(json!({ "text": prompt }));

                    let mut body = json!({
                        "contents": [ { "parts": parts } ],
                        "generationConfig": generation_config,
                    });
                    if !tools.is_empty() {
                        body["tools"] = json!(tools);
                    }

                    let endpoint = if allow_stream {
                        &legacy_stream_endpoint
                    } else {
                        &legacy_endpoint
                    };
                    let response = client
                        .post(endpoint)
                        .header("x-goog-api-key", api_key)
                        .json(&body)
                        .send()
                        .await
                        .map_err(|error| {
                            generic_error(format!("Image generation request failed: {error}"))
                        })?;
                    let status = response.status();
                    if !status.is_success() {
                        let response_body: Value =
                            response.json().await.unwrap_or_else(|_| json!({}));
                        return Err(api_error(
                            "Image generation failed",
                            status.as_u16(),
                            &response_body,
                        ));
                    }

                    // --- Streaming path: parse the SSE/JSON stream, forward inlineData ---
                    if allow_stream {
                        let images = gemini_stream::read_gemini_stream(
                            response,
                            on_chunk.expect("allow_stream guarantees on_chunk is some"),
                        )
                        .await?;
                        return gemini_stream::collect_gemini_result(
                            prompt,
                            model,
                            channel_label,
                            images,
                        );
                    }

                    // --- Non-streaming path ---
                    let response_body: Value = response.json().await.map_err(|error| {
                        generic_error(format!(
                            "Failed to parse image generation response: {error}"
                        ))
                    })?;

                    let images = gemini_stream::parse_gemini_candidates(&response_body);
                    gemini_stream::collect_gemini_result(prompt, model, channel_label, images)
                }
            })
            .collect();

        let results = futures::future::join_all(tasks).await;
        merge_parallel_results(prompts[0], model, channel_label, requests, results)
    }
}

/// 解析 NovelAI 尺寸 `WIDTHxHEIGHT`；未提供 / `auto` 返回 (0,0)（交由上游默认）。
fn parse_novelai_size(size: &Option<String>) -> napi::Result<(u64, u64)> {
    let Some(raw) = size else {
        return Ok((0, 0));
    };
    let raw = raw.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("auto") {
        return Ok((0, 0));
    }
    let lower = raw.to_ascii_lowercase();
    let Some((width, height)) = lower.split_once('x') else {
        return Err(Error::new(
            Status::InvalidArg,
            format!("NovelAI size must be WIDTHxHEIGHT (e.g. 832x1216), got \"{raw}\""),
        ));
    };
    let (Ok(width), Ok(height)) = (
        width.trim().parse::<u64>(),
        height.trim().parse::<u64>(),
    ) else {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Invalid NovelAI size \"{raw}\": expected WIDTHxHEIGHT with integer pixels"),
        ));
    };
    if width == 0 || height == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Invalid NovelAI size \"{raw}\": dimensions must be positive"),
        ));
    }
    Ok((width, height))
}

/// 解包 NovelAI 返回：ZIP（内含每张样本一个 PNG）或直接 PNG 二进制。
fn extract_novelai_png(bytes: &[u8]) -> napi::Result<Vec<u8>> {
    // ZIP 魔数 PK\x03\x04；非 ZIP 视为直接返回的 PNG。
    if !bytes.starts_with(b"PK\x03\x04") {
        return Ok(bytes.to_vec());
    }
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| generic_error(format!("invalid ZIP archive: {error}")))?;
    let mut file = archive
        .by_index(0)
        .map_err(|error| generic_error(format!("ZIP entry unavailable: {error}")))?;
    let mut out = Vec::with_capacity(file.size() as usize);
    std::io::Read::read_to_end(&mut file, &mut out)
        .map_err(|error| generic_error(format!("ZIP entry read failed: {error}")))?;
    Ok(out)
}

/// NovelAI 错误响应解析（`{"message": ...}` 或 `{"error": {"message": ...}}`）。
fn novelai_api_error(status: u16, response_body: &Value) -> Error {
    let message = response_body
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| {
            response_body
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .unwrap_or("Unknown error");
    generic_error(format!("NovelAI image generation failed: {status} {message}"))
}
