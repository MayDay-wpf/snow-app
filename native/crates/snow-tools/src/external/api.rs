//! 自定义 API 传输：把 Web API 接口映射为 MCP 工具。
//! 配置约定：url = Base URL，headers_json = 公共请求头，args_json = `{cookies, endpoints}`。

use std::time::{Duration, Instant};

use napi::{Error, Result};
use napi_derive::napi;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use snow_storage_core::models::McpServerConfigRecord;

use crate::protocol::RemoteMcpTool;

const DEFAULT_TEST_TIMEOUT_MS: u64 = 30_000;

/// RFC 3986 unreserved 之外的字符全部编码。
const COMPONENT_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ApiSpec {
    cookies: Map<String, Value>,
    endpoints: Vec<ApiEndpoint>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ApiEndpoint {
    name: String,
    description: String,
    method: String,
    path: String,
    headers: Map<String, Value>,
    params: Vec<ApiParam>,
    /// none | json | form | multipart | raw
    body_type: String,
    body_template: String,
    raw_content_type: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ApiParam {
    name: String,
    #[serde(rename = "type")]
    param_type: String,
    required: bool,
    description: String,
    /// query | path | header | body
    location: String,
    default_value: String,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct McpApiHeader {
    pub name: String,
    pub value: String,
}

#[napi(object)]
pub struct McpApiTestInput {
    pub base_url: String,
    pub headers_json: String,
    pub spec_json: String,
    pub endpoint_index: u32,
    pub arguments_json: String,
    pub timeout_ms: Option<u32>,
}

#[napi(object)]
#[derive(Default)]
pub struct McpApiTestResult {
    pub ok: bool,
    pub error: Option<String>,
    pub method: String,
    pub url: String,
    pub request_headers: Vec<McpApiHeader>,
    pub request_body: String,
    pub status: Option<u32>,
    pub status_text: String,
    pub elapsed_ms: u32,
    pub response_headers: Vec<McpApiHeader>,
    pub content_type: String,
    pub body: String,
}

fn parse_spec(args_json: &str) -> Result<ApiSpec> {
    let trimmed = args_json.trim();
    if trimmed.is_empty() {
        return Ok(ApiSpec::default());
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|error| Error::from_reason(format!("Invalid custom API definition: {error}")))?;
    // 由其他传输切换过来时 args 可能是数组，按空定义处理
    if !value.is_object() {
        return Ok(ApiSpec::default());
    }
    serde_json::from_value(value)
        .map_err(|error| Error::from_reason(format!("Invalid custom API definition: {error}")))
}

fn parse_header_pairs(headers_json: &str) -> Result<Vec<(String, String)>> {
    let trimmed = headers_json.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let map: Map<String, Value> = serde_json::from_str(trimmed)
        .map_err(|error| Error::from_reason(format!("Invalid custom API headers JSON: {error}")))?;
    Ok(string_pairs(&map))
}

fn string_pairs(map: &Map<String, Value>) -> Vec<(String, String)> {
    map.iter()
        .filter_map(|(key, value)| {
            let key = key.trim();
            (!key.is_empty()).then(|| (key.to_string(), value_to_text(value)))
        })
        .collect()
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn normalized_method_name(method: &str) -> String {
    let upper = method.trim().to_ascii_uppercase();
    if upper.is_empty() {
        "GET".to_string()
    } else {
        upper
    }
}

fn json_schema_type(param_type: &str) -> &'static str {
    match param_type.trim().to_ascii_lowercase().as_str() {
        "number" => "number",
        "integer" => "integer",
        "boolean" => "boolean",
        "object" => "object",
        "array" => "array",
        _ => "string",
    }
}

fn endpoint_tool_name(index: usize, endpoint: &ApiEndpoint) -> String {
    let name = endpoint.name.trim();
    if name.is_empty() {
        format!("endpoint_{}", index + 1)
    } else {
        name.to_string()
    }
}

fn endpoint_tool(index: usize, endpoint: &ApiEndpoint) -> RemoteMcpTool {
    let signature = format!(
        "{} {}",
        normalized_method_name(&endpoint.method),
        endpoint.path.trim()
    );
    let description = endpoint.description.trim();
    RemoteMcpTool {
        name: endpoint_tool_name(index, endpoint),
        description: if description.is_empty() {
            signature
        } else {
            format!("{description}\n({signature})")
        },
        input_schema: build_input_schema(&endpoint.params),
    }
}

fn build_input_schema(params: &[ApiParam]) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for param in params {
        let name = param.name.trim();
        if name.is_empty() {
            continue;
        }
        let schema_type = json_schema_type(&param.param_type);
        let mut property = Map::new();
        property.insert("type".to_string(), json!(schema_type));
        if schema_type == "array" {
            property.insert("items".to_string(), json!({}));
        }
        let default_value = param.default_value.trim();
        let mut description = param.description.trim().to_string();
        if !default_value.is_empty() {
            let note = format!("Default: {default_value}");
            description = if description.is_empty() {
                note
            } else {
                format!("{description} ({note})")
            };
        }
        if !description.is_empty() {
            property.insert("description".to_string(), json!(description));
        }
        properties.insert(name.to_string(), Value::Object(property));
        // 有默认值的参数模型可省略
        if param.required && default_value.is_empty() {
            required.push(json!(name));
        }
    }

    let mut schema = Map::new();
    schema.insert("type".to_string(), json!("object"));
    schema.insert("properties".to_string(), Value::Object(properties));
    if !required.is_empty() {
        schema.insert("required".to_string(), Value::Array(required));
    }
    Value::Object(schema)
}

/// 合并调用参数与默认值，缺少必填参数时报错。
fn resolve_values(params: &[ApiParam], arguments: &Value) -> Result<Map<String, Value>> {
    let mut values = arguments.as_object().cloned().unwrap_or_default();
    values.retain(|_, value| !value.is_null());
    for param in params {
        let name = param.name.trim();
        if name.is_empty() || values.contains_key(name) {
            continue;
        }
        let default_value = param.default_value.trim();
        if !default_value.is_empty() {
            values.insert(
                name.to_string(),
                coerce_text(default_value, &param.param_type),
            );
        } else if param.required {
            return Err(Error::from_reason(format!(
                "Missing required parameter: {name}"
            )));
        }
    }
    Ok(values)
}

fn coerce_text(raw: &str, param_type: &str) -> Value {
    match json_schema_type(param_type) {
        "string" => Value::String(raw.to_string()),
        _ => serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string())),
    }
}

fn is_placeholder_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.' | '$'))
}

fn identity_encode(text: &str) -> String {
    text.to_string()
}

fn component_encode(text: &str) -> String {
    utf8_percent_encode(text, COMPONENT_ENCODE_SET).to_string()
}

/// 替换文本中的 `{{name}}`，缺失参数替换为空串。
fn render_text(template: &str, values: &Map<String, Value>, encode: fn(&str) -> String) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(offset) = rest[start + 2..].find("}}") else {
            break;
        };
        let key = rest[start + 2..start + 2 + offset].trim();
        output.push_str(&rest[..start]);
        if is_placeholder_key(key) {
            let text = values.get(key).map(value_to_text).unwrap_or_default();
            output.push_str(&encode(&text));
        } else {
            output.push_str(&rest[start..start + 4 + offset]);
        }
        rest = &rest[start + 4 + offset..];
    }
    output.push_str(rest);
    output
}

fn find_placeholder_end(chars: &[char], from: usize) -> Option<usize> {
    let mut index = from;
    while index + 1 < chars.len() {
        if chars[index] == '}' && chars[index + 1] == '}' {
            return Some(index);
        }
        if chars[index] == '\n' || chars[index] == '"' {
            return None;
        }
        index += 1;
    }
    None
}

/// 缺失参数的占位标记，渲染后从 JSON 结构中剔除。
const MISSING_MARKER: &str = "\u{0}snow-api-missing\u{0}";

fn is_missing_marker(value: &Value) -> bool {
    matches!(value, Value::String(text) if text == MISSING_MARKER)
}

fn standalone_json(found: Option<&Value>) -> String {
    match found {
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
        None => serde_json::to_string(MISSING_MARKER).unwrap_or_default(),
    }
}

/// 递归删除值为缺失标记的对象成员与数组元素。
fn prune_missing(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, item| key != MISSING_MARKER && !is_missing_marker(item));
            map.values_mut().for_each(prune_missing);
        }
        Value::Array(items) => {
            items.retain(|item| !is_missing_marker(item));
            items.iter_mut().for_each(prune_missing);
        }
        _ => {}
    }
}

/// 渲染 JSON 请求体并校验；独立占位符对应参数缺失时省略该字段。
fn render_json_body(template: &str, values: &Map<String, Value>) -> Result<String> {
    let rendered = render_json(template, values);
    let mut parsed = serde_json::from_str::<Value>(&rendered).map_err(|error| {
        Error::from_reason(format!("Rendered JSON body is invalid: {error}"))
    })?;
    if !rendered.contains("snow-api-missing") {
        return Ok(rendered);
    }
    prune_missing(&mut parsed);
    if is_missing_marker(&parsed) {
        parsed = Value::Null;
    }
    Ok(parsed.to_string())
}

/// 表单模板：`key={{x}}` 段在参数缺失时整段省略。
fn render_form(template: &str, values: &Map<String, Value>) -> String {
    template
        .split('&')
        .filter(|segment| !is_missing_form_segment(segment, values))
        .map(|segment| render_text(segment, values, component_encode))
        .collect::<Vec<_>>()
        .join("&")
}

fn is_missing_form_segment(segment: &str, values: &Map<String, Value>) -> bool {
    let Some((_, raw)) = segment.split_once('=') else {
        return false;
    };
    let Some(inner) = raw
        .trim()
        .strip_prefix("{{")
        .and_then(|rest| rest.strip_suffix("}}"))
    else {
        return false;
    };
    let key = inner.trim();
    is_placeholder_key(key) && !values.contains_key(key)
}

/// JSON 模板渲染：`"{{x}}"` 整串或裸 `{{x}}` 按 JSON 值替换（保留类型，
/// 缺失时写入缺失标记），字符串内部的占位符按转义后的文本替换。
fn render_json(template: &str, values: &Map<String, Value>) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut output = String::with_capacity(template.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut string_start_len = 0usize;
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        if ch == '{' && chars.get(index + 1) == Some(&'{') && !escaped {
            if let Some(close) = find_placeholder_end(&chars, index + 2) {
                let raw_key: String = chars[index + 2..close].iter().collect();
                let key = raw_key.trim();
                if is_placeholder_key(key) {
                    let found = values.get(key);
                    let after = close + 2;
                    if in_string
                        && output.len() == string_start_len
                        && chars.get(after) == Some(&'"')
                    {
                        output.pop();
                        output.push_str(&standalone_json(found));
                        in_string = false;
                        index = after + 1;
                    } else if in_string {
                        let text = found.map(value_to_text).unwrap_or_default();
                        let quoted = serde_json::to_string(&text).unwrap_or_default();
                        if quoted.len() >= 2 {
                            output.push_str(&quoted[1..quoted.len() - 1]);
                        }
                        index = after;
                    } else {
                        output.push_str(&standalone_json(found));
                        index = after;
                    }
                    continue;
                }
            }
        }

        output.push(ch);
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            string_start_len = output.len();
        }
        index += 1;
    }
    output
}

fn join_url(base_url: &str, path: &str) -> String {
    let path = path.trim();
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    let base = base_url.trim().trim_end_matches('/');
    if path.is_empty() {
        return base.to_string();
    }
    if path.starts_with('?') {
        return format!("{base}{path}");
    }
    format!("{base}/{}", path.trim_start_matches('/'))
}

fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: String) {
    if let Some(entry) = headers
        .iter_mut()
        .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
    {
        entry.1 = value;
    } else {
        headers.push((name.to_string(), value));
    }
}

fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers
        .iter()
        .any(|(existing, _)| existing.eq_ignore_ascii_case(name))
}

fn located_values<'a>(
    endpoint: &'a ApiEndpoint,
    values: &'a Map<String, Value>,
    location: &str,
) -> Vec<(&'a str, &'a Value)> {
    endpoint
        .params
        .iter()
        .filter(|param| param.location.trim().eq_ignore_ascii_case(location))
        .filter_map(|param| {
            let name = param.name.trim();
            values.get(name).map(|value| (name, value))
        })
        .collect()
}

enum PreparedBody {
    None,
    Text(String),
    Multipart(Vec<(String, String)>),
}

struct PreparedRequest {
    method: reqwest::Method,
    url: reqwest::Url,
    headers: Vec<(String, String)>,
    body: PreparedBody,
}

impl PreparedRequest {
    fn body_preview(&self) -> String {
        match &self.body {
            PreparedBody::None => String::new(),
            PreparedBody::Text(text) => text.clone(),
            PreparedBody::Multipart(fields) => fields
                .iter()
                .map(|(name, value)| format!("{name}: {value}"))
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

fn prepare_request(
    base_url: &str,
    shared_headers: &[(String, String)],
    cookies: &[(String, String)],
    endpoint: &ApiEndpoint,
    arguments: &Value,
) -> Result<PreparedRequest> {
    let values = resolve_values(&endpoint.params, arguments)?;
    let method_name = normalized_method_name(&endpoint.method);
    let method = reqwest::Method::from_bytes(method_name.as_bytes())
        .map_err(|_| Error::from_reason(format!("Invalid HTTP method: {method_name}")))?;

    let raw_url = join_url(
        base_url,
        &render_text(&endpoint.path, &values, component_encode),
    );
    let mut url = reqwest::Url::parse(&raw_url)
        .map_err(|error| Error::from_reason(format!("Invalid request URL {raw_url}: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::from_reason(format!(
            "Unsupported URL scheme: {}",
            url.scheme()
        )));
    }

    let query_values = located_values(endpoint, &values, "query");
    if !query_values.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query_values {
            match value {
                Value::Array(items) => {
                    for item in items {
                        pairs.append_pair(name, &value_to_text(item));
                    }
                }
                other => {
                    pairs.append_pair(name, &value_to_text(other));
                }
            }
        }
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in shared_headers {
        set_header(&mut headers, name, render_text(value, &values, identity_encode));
    }
    for (name, value) in string_pairs(&endpoint.headers) {
        set_header(
            &mut headers,
            &name,
            render_text(&value, &values, identity_encode),
        );
    }
    for (name, value) in located_values(endpoint, &values, "header") {
        set_header(&mut headers, name, value_to_text(value));
    }

    let cookie_text = cookies
        .iter()
        .map(|(name, value)| {
            format!(
                "{name}={}",
                render_text(value, &values, identity_encode)
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    if !cookie_text.is_empty() {
        let existing = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("cookie"))
            .map(|(_, value)| value.trim().trim_end_matches(';').to_string())
            .filter(|value| !value.is_empty());
        let merged = match existing {
            Some(existing) => format!("{existing}; {cookie_text}"),
            None => cookie_text,
        };
        set_header(&mut headers, "Cookie", merged);
    }

    let body_values = located_values(endpoint, &values, "body");
    let template = endpoint.body_template.trim();
    let body = match endpoint.body_type.trim().to_ascii_lowercase().as_str() {
        "json" => {
            let text = if template.is_empty() {
                let object = body_values
                    .iter()
                    .map(|(name, value)| ((*name).to_string(), (*value).clone()))
                    .collect::<Map<String, Value>>();
                Value::Object(object).to_string()
            } else {
                render_json_body(template, &values)?
            };
            if !has_header(&headers, "content-type") {
                headers.push(("Content-Type".to_string(), "application/json".to_string()));
            }
            PreparedBody::Text(text)
        }
        "form" => {
            let text = if template.is_empty() {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                for (name, value) in &body_values {
                    serializer.append_pair(name, &value_to_text(value));
                }
                serializer.finish()
            } else {
                render_form(template, &values)
            };
            if !has_header(&headers, "content-type") {
                headers.push((
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ));
            }
            PreparedBody::Text(text)
        }
        "multipart" => PreparedBody::Multipart(
            body_values
                .iter()
                .map(|(name, value)| ((*name).to_string(), value_to_text(value)))
                .collect(),
        ),
        "raw" => {
            if !has_header(&headers, "content-type") {
                let content_type = endpoint.raw_content_type.trim();
                headers.push((
                    "Content-Type".to_string(),
                    if content_type.is_empty() {
                        "text/plain".to_string()
                    } else {
                        content_type.to_string()
                    },
                ));
            }
            PreparedBody::Text(render_text(
                &endpoint.body_template,
                &values,
                identity_encode,
            ))
        }
        _ => PreparedBody::None,
    };

    Ok(PreparedRequest {
        method,
        url,
        headers,
        body,
    })
}

struct ApiHttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    content_type: String,
    body: String,
}

fn describe_error(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        let text = inner.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = inner.source();
    }
    message
}

async fn send_request(
    client: &reqwest::Client,
    prepared: &PreparedRequest,
    pretty_json: bool,
) -> Result<ApiHttpResponse> {
    let is_multipart = matches!(prepared.body, PreparedBody::Multipart(_));
    let mut header_map = HeaderMap::new();
    for (name, value) in &prepared.headers {
        // multipart 的 Content-Type 需由 reqwest 生成 boundary
        if is_multipart && name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| Error::from_reason(format!("Invalid header name {name}: {error}")))?;
        let header_value = HeaderValue::from_str(value).map_err(|error| {
            Error::from_reason(format!("Invalid value for header {name}: {error}"))
        })?;
        header_map.append(header_name, header_value);
    }

    let mut builder = client
        .request(prepared.method.clone(), prepared.url.clone())
        .headers(header_map);
    builder = match &prepared.body {
        PreparedBody::None => builder,
        PreparedBody::Text(text) => builder.body(text.clone()),
        PreparedBody::Multipart(fields) => {
            let mut form = reqwest::multipart::Form::new();
            for (name, value) in fields {
                form = form.text(name.clone(), value.clone());
            }
            builder.multipart(form)
        }
    };

    let response = builder.send().await.map_err(|error| {
        Error::from_reason(format!("Request failed: {}", describe_error(&error)))
    })?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect::<Vec<_>>();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let bytes = response.bytes().await.map_err(|error| {
        Error::from_reason(format!(
            "Failed to read response body: {}",
            describe_error(&error)
        ))
    })?;

    let mut body = String::from_utf8_lossy(&bytes).into_owned();
    if pretty_json && content_type.to_ascii_lowercase().contains("json") {
        if let Ok(pretty) = serde_json::from_str::<Value>(&body)
            .and_then(|parsed| serde_json::to_string_pretty(&parsed))
        {
            body = pretty;
        }
    }

    Ok(ApiHttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        headers,
        content_type,
        body,
    })
}

fn tool_text_result(text: String, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

fn format_tool_response(response: &ApiHttpResponse) -> Value {
    let mut text = format!("HTTP {} {}", response.status, response.status_text)
        .trim_end()
        .to_string();
    if !response.content_type.is_empty() {
        text.push_str(&format!("\nContent-Type: {}", response.content_type));
    }
    text.push_str("\n\n");
    text.push_str(&response.body);
    tool_text_result(text, response.status >= 400)
}

fn to_napi_headers(headers: &[(String, String)]) -> Vec<McpApiHeader> {
    headers
        .iter()
        .map(|(name, value)| McpApiHeader {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

pub(super) struct ApiMcpClient {
    base_url: String,
    headers: Vec<(String, String)>,
    cookies: Vec<(String, String)>,
    endpoints: Vec<ApiEndpoint>,
    client: reqwest::Client,
}

impl ApiMcpClient {
    pub(super) async fn connect(config: &McpServerConfigRecord) -> Result<Self> {
        let spec = parse_spec(&config.args_json)?;
        let headers = parse_header_pairs(&config.headers_json)?;
        let client = snow_net::http_client::build_proxied_client().await?;
        Ok(Self {
            base_url: config.url.trim().to_string(),
            headers,
            cookies: string_pairs(&spec.cookies),
            endpoints: spec.endpoints,
            client,
        })
    }

    pub(super) async fn list_all_tools(&self) -> Result<Vec<RemoteMcpTool>> {
        Ok(self
            .endpoints
            .iter()
            .enumerate()
            .map(|(index, endpoint)| endpoint_tool(index, endpoint))
            .collect())
    }

    pub(super) async fn call_tool(&self, name: &str, arguments: &Value) -> Result<Value> {
        let endpoint = self
            .endpoints
            .iter()
            .enumerate()
            .find(|(index, endpoint)| endpoint_tool_name(*index, endpoint) == name)
            .map(|(_, endpoint)| endpoint)
            .ok_or_else(|| Error::from_reason(format!("Custom API endpoint {name} not found")))?;

        // 参数/网络错误以 isError 结果返回，便于模型据此修正调用
        let prepared = match prepare_request(
            &self.base_url,
            &self.headers,
            &self.cookies,
            endpoint,
            arguments,
        ) {
            Ok(prepared) => prepared,
            Err(error) => return Ok(tool_text_result(error.reason.clone(), true)),
        };
        match send_request(&self.client, &prepared, false).await {
            Ok(response) => Ok(format_tool_response(&response)),
            Err(error) => Ok(tool_text_result(error.reason.clone(), true)),
        }
    }

    pub(super) async fn close(self) {}
}

/// 按编辑中的草稿直接发送一次测试请求（无需保存）。
pub async fn test_api_endpoint(input: McpApiTestInput) -> Result<McpApiTestResult> {
    let mut result = McpApiTestResult::default();
    if let Err(error) = run_test(input, &mut result).await {
        result.ok = false;
        result.error = Some(error.reason.clone());
    }
    Ok(result)
}

async fn run_test(input: McpApiTestInput, result: &mut McpApiTestResult) -> Result<()> {
    let spec = parse_spec(&input.spec_json)?;
    let endpoint = spec
        .endpoints
        .get(input.endpoint_index as usize)
        .ok_or_else(|| Error::from_reason("Custom API endpoint not found"))?;
    let headers = parse_header_pairs(&input.headers_json)?;
    let arguments: Value = if input.arguments_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&input.arguments_json)
            .map_err(|error| Error::from_reason(format!("Invalid test arguments: {error}")))?
    };

    let prepared = prepare_request(
        &input.base_url,
        &headers,
        &string_pairs(&spec.cookies),
        endpoint,
        &arguments,
    )?;
    result.method = prepared.method.to_string();
    result.url = prepared.url.to_string();
    result.request_headers = to_napi_headers(&prepared.headers);
    result.request_body = prepared.body_preview();

    let timeout_ms = input
        .timeout_ms
        .filter(|value| *value > 0)
        .map(u64::from)
        .unwrap_or(DEFAULT_TEST_TIMEOUT_MS);
    let client = snow_net::http_client::build_proxied_client_with_timeout(
        Duration::from_millis(timeout_ms),
    )
    .await?;

    let started = Instant::now();
    let response = send_request(&client, &prepared, true).await;
    result.elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    let response = response?;

    result.ok = response.status < 400;
    result.status = Some(u32::from(response.status));
    result.status_text = response.status_text;
    result.response_headers = to_napi_headers(&response.headers);
    result.content_type = response.content_type;
    result.body = response.body;
    Ok(())
}
