use crate::contract::*;

use serde_json::{json, Value};

pub fn tools_as_openai_chat_json(tools: &[McpTool]) -> Value {
    let functions: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "type": "function",
                "function": {
                    "name": tool.full_name(),
                    "description": tool.description,
                    "parameters": sanitized_schema,
                    // Preserve genuine optional properties; do not opt into a
                    // strict dialect that requires every property to be present.
                    "strict": false,
                }
            })
        })
        .collect();

    Value::Array(functions)
}

/// Normalize schema structure, never weaken the accepted argument language.
/// OpenAI chat/responses (non-strict) and Anthropic receive JSON Schema, as do
/// Interactions declarations. Gateways implementing only a subset must reject
/// unsupported keywords explicitly rather than silently dropping constraints.
/// Gemini uses parametersJsonSchema below: its legacy parameters/Schema dialect
/// cannot faithfully represent arbitrary root combinators and nullable unions.
/// Keep public serializer signatures and optional-property required lists intact.
fn sanitize_tool_input_schema(schema: &Value) -> Value {
    let mut root = schema.clone();
    // Some gateways (xAI) validate combinator branches on their own `type` and
    // reject `{"$ref": "#/$defs/X"}` branches, so pure `$ref` nodes at the root
    // or in combinator branches are inlined first. Inlining is lossless.
    let definitions = schema.clone();
    let mut budget = MAX_REF_EXPANSIONS;
    expand_ref_nodes(&mut root, &definitions, true, 0, &mut budget);
    sanitize_schema_node(&mut root, true);
    root
}

const MAX_REF_EXPANSION_DEPTH: usize = 6;
const MAX_REF_EXPANSIONS: usize = 512;

/// Inline `$ref` nodes that carry nothing but `$ref` (annotations would be lost).
fn expand_ref_nodes(
    node: &mut Value,
    root: &Value,
    allow_inline: bool,
    depth: usize,
    budget: &mut usize,
) {
    if depth > MAX_REF_EXPANSION_DEPTH {
        return;
    }
    if allow_inline {
        // Follow chained pure `$ref` nodes.
        for _ in 0..MAX_REF_EXPANSION_DEPTH {
            if *budget == 0 {
                break;
            }
            let Some(target) = pure_ref_target(node, root) else {
                break;
            };
            *node = target.clone();
            *budget -= 1;
        }
    }
    let Some(map) = node.as_object_mut() else {
        return;
    };
    for keyword in [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
    ] {
        if let Some(Value::Object(children)) = map.get_mut(keyword) {
            for child in children.values_mut() {
                expand_ref_nodes(child, root, false, depth + 1, budget);
            }
        }
    }
    for keyword in [
        "items",
        "additionalProperties",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
    ] {
        if let Some(child) = map.get_mut(keyword) {
            if let Value::Array(children) = child {
                for child in children {
                    expand_ref_nodes(child, root, false, depth + 1, budget);
                }
            } else {
                expand_ref_nodes(child, root, false, depth + 1, budget);
            }
        }
    }
    for keyword in ["anyOf", "oneOf", "allOf", "prefixItems"] {
        if let Some(Value::Array(children)) = map.get_mut(keyword) {
            for child in children {
                expand_ref_nodes(child, root, true, depth + 1, budget);
            }
        }
    }
}

fn pure_ref_target<'a>(node: &Value, root: &'a Value) -> Option<&'a Value> {
    let map = node.as_object()?;
    if map.len() != 1 {
        return None;
    }
    resolve_json_pointer(root, map.get("$ref")?.as_str()?)
}

/// Local JSON pointer only (`#` / `#/a/b`); remote refs are left untouched.
fn resolve_json_pointer<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    if pointer.is_empty() {
        return Some(root);
    }
    let mut current = root;
    for raw in pointer.strip_prefix('/')?.split('/') {
        let token = raw.replace("~1", "/").replace("~0", "~");
        current = match current {
            Value::Object(map) => map.get(&token)?,
            Value::Array(items) => items.get(token.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn sanitize_schema_node(node: &mut Value, is_root: bool) {
    if let Value::Object(map) = node {
        if !map.contains_key("type") {
            if is_root || map.contains_key("properties") || map.contains_key("required") {
                map.insert("type".to_string(), json!("object"));
            } else if map.contains_key("items") {
                map.insert("type".to_string(), json!("array"));
            }
        }
        let is_object = map.get("type").is_some_and(|value| {
            value.as_str() == Some("object")
                || value
                    .as_array()
                    .is_some_and(|types| types.iter().any(|ty| ty == "object"))
        });
        if is_object && map.get("required").is_none_or(Value::is_null) {
            map.insert("required".to_string(), json!([]));
        }
        // Visit schema-valued keywords only; never reinterpret defaults, const,
        // enum or examples (which may contain arbitrary user JSON) as schemas.
        for keyword in [
            "properties",
            "patternProperties",
            "$defs",
            "definitions",
            "dependentSchemas",
        ] {
            if let Some(Value::Object(children)) = map.get_mut(keyword) {
                for child in children.values_mut() {
                    sanitize_schema_node(child, false);
                }
            }
        }
        for keyword in [
            "items",
            "additionalProperties",
            "contains",
            "not",
            "if",
            "then",
            "else",
            "propertyNames",
        ] {
            if let Some(child) = map.get_mut(keyword) {
                if let Value::Array(children) = child {
                    for child in children {
                        sanitize_schema_node(child, false);
                    }
                } else {
                    sanitize_schema_node(child, false);
                }
            }
        }
        for keyword in ["anyOf", "oneOf", "allOf", "prefixItems"] {
            if let Some(Value::Array(children)) = map.get_mut(keyword) {
                for child in children {
                    sanitize_schema_node(child, false);
                }
            }
        }
    }
}

pub fn tools_as_anthropic_json(tools: &[McpTool]) -> Value {
    let tools_json: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "name": tool.full_name(),
                "description": tool.description,
                "input_schema": sanitized_schema,
            })
        })
        .collect();

    Value::Array(tools_json)
}

pub fn tools_as_openai_responses_json(tools: &[McpTool]) -> Value {
    let tools_json: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "type": "function",
                "name": tool.full_name(),
                "description": tool.description,
                "parameters": sanitized_schema,
                "strict": false,
            })
        })
        .collect();

    Value::Array(tools_json)
}

pub fn tools_as_gemini_json(tools: &[McpTool]) -> Value {
    let function_declarations: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            // Preserve the legacy parameters envelope for simple tools. Advanced
            // JSON Schema requires Gemini's lossless JSON Schema transport.
            let mut declaration = json!({
                "name": tool.full_name(),
                "description": tool.description,
            });
            let field = if requires_json_schema_transport(&sanitized_schema) {
                "parametersJsonSchema"
            } else {
                "parameters"
            };
            declaration[field] = sanitized_schema;
            declaration
        })
        .collect();

    // Gemini API 的 tools 字段是数组，每个元素是一个 Tool 对象：
    // `"tools": [{"functionDeclarations": [...]}]`（与 Snow CLI 的
    // convertToolsToGemini 一致）。调用方（build_gemini_payload 等）用
    // as_array() 判断是否注入，必须保持数组形态。
    json!([{
        "functionDeclarations": function_declarations
    }])
}

// This is a transport capability choice, not a lossy schema conversion. Inspect
// only schema locations: a user default containing a key named type is data.
fn requires_json_schema_transport(schema: &Value) -> bool {
    let Some(map) = schema.as_object() else {
        return false;
    };
    // Antigravity's legacy `parameters` adapter strips these constraints,
    // stringifies non-string enum values, and adds required placeholders to
    // optional-only objects. Keep those schemas on the untouched JSON Schema
    // transport rather than silently changing bounds, nulls or optionality.
    let optional_only_object = map.get("type").and_then(Value::as_str) == Some("object")
        && map
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
    let non_string_enum = map
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| !value.is_string()));
    if optional_only_object
        || non_string_enum
        || map.get("type").is_some_and(Value::is_array)
        || map.get("items").is_some_and(Value::is_array)
        || [
            "anyOf",
            "oneOf",
            "allOf",
            "not",
            "if",
            "then",
            "else",
            "const",
            "default",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "multipleOf",
            "minLength",
            "maxLength",
            "pattern",
            "format",
            "minItems",
            "maxItems",
            "uniqueItems",
            "contains",
            "minProperties",
            "maxProperties",
            "propertyNames",
            "dependentRequired",
            "additionalItems",
            "unevaluatedProperties",
            "unevaluatedItems",
            "$ref",
            "$defs",
            "definitions",
            "additionalProperties",
            "patternProperties",
            "dependentSchemas",
            "prefixItems",
        ]
        .iter()
        .any(|key| map.contains_key(*key))
    {
        return true;
    }
    map.get("properties")
        .and_then(Value::as_object)
        .is_some_and(|properties| properties.values().any(requires_json_schema_transport))
        || map.get("items").is_some_and(requires_json_schema_transport)
}

pub fn tools_as_interactions_json(tools: &[McpTool]) -> Value {
    let function_declarations: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let sanitized_schema = sanitize_tool_input_schema(&tool.input_schema);
            json!({
                "name": tool.full_name(),
                "description": tool.description,
                "parameters": sanitized_schema,
            })
        })
        .collect();

    json!([{
        "function_declarations": function_declarations
    }])
}
