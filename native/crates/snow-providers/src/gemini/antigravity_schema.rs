use serde_json::{json, Map, Value};

const UNSUPPORTED_KEYS: &[&str] = &[
    "$schema",
    "$id",
    "id",
    "$ref",
    "$defs",
    "definitions",
    "$anchor",
    "$vocabulary",
    "$dynamicRef",
    "$dynamicAnchor",
    "$comment",
    "const",
    "examples",
    "patternProperties",
    "additionalProperties",
    "propertyNames",
    "additionalItems",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
    "uniqueItems",
    "minItems",
    "maxItems",
    "contains",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "pattern",
    "format",
    "default",
    "if",
    "then",
    "else",
    "not",
    "enumDescriptions",
    "enumTitles",
    "prefill",
    "deprecated",
    "encrypted",
];

const PLACEHOLDER_REASON_DESCRIPTION: &str = "Brief explanation of why you are calling this tool";

pub(crate) fn clean_tool_schema(schema: &Value, require_placeholder: bool) -> Value {
    let resolved = resolve_refs(schema, schema, &mut Vec::new());
    clean_node(&resolved, require_placeholder)
}

fn resolve_refs(value: &Value, root: &Value, active: &mut Vec<String>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve_refs(item, root, active))
                .collect(),
        ),
        Value::Object(map) => {
            let reference = map.get("$ref").and_then(Value::as_str);
            if let Some(reference) = reference.filter(|reference| reference.starts_with("#/")) {
                if let Some(target) = resolve_pointer(root, reference) {
                    if active.iter().any(|active_ref| active_ref == reference) {
                        return cyclic_ref_fallback(map, target, reference);
                    }
                    active.push(reference.to_string());
                    let resolved_target = resolve_refs(target, root, active);
                    active.pop();
                    let mut merged = match resolved_target {
                        Value::Object(target_map) => target_map,
                        _ => Map::new(),
                    };
                    for (key, item) in map {
                        if key == "$ref" {
                            continue;
                        }
                        merged.insert(key.clone(), resolve_refs(item, root, active));
                    }
                    return Value::Object(merged);
                }
            }
            let mut resolved = Map::new();
            for (key, item) in map {
                resolved.insert(key.clone(), resolve_refs(item, root, active));
            }
            Value::Object(resolved)
        }
        other => other.clone(),
    }
}

fn resolve_pointer<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let path = reference.strip_prefix("#/")?;
    let mut current = root;
    for segment in path.split('/') {
        let key = segment.replace("~1", "/").replace("~0", "~");
        current = match current {
            Value::Object(map) => map.get(&key)?,
            Value::Array(items) => items.get(key.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn cyclic_ref_fallback(node: &Map<String, Value>, target: &Value, reference: &str) -> Value {
    let mut fallback = Map::new();
    if let Value::Object(target_map) = target {
        for key in ["type", "nullable", "description"] {
            if let Some(value) = target_map.get(key) {
                fallback.insert(key.to_string(), value.clone());
            }
        }
    }
    for (key, value) in node {
        if key != "$ref" {
            fallback.insert(key.clone(), value.clone());
        }
    }
    let name = reference.rsplit('/').next().unwrap_or(reference);
    let hint = format!("See: {name}");
    let description = fallback
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let merged = if description.is_empty() {
        hint
    } else {
        format!("{description} ({hint})")
    };
    fallback.insert("description".to_string(), Value::String(merged));
    Value::Object(fallback)
}

fn clean_node(node: &Value, require_placeholder: bool) -> Value {
    let Value::Object(map) = node else {
        return match node {
            Value::Bool(_) => json!({}),
            other => other.clone(),
        };
    };

    let mut cleaned = map.clone();

    for key in ["anyOf", "oneOf"] {
        if let Some(branches) = cleaned.remove(key) {
            flatten_union(&mut cleaned, &branches, require_placeholder);
        }
    }
    if let Some(branches) = cleaned.remove("allOf") {
        merge_branch_list(&mut cleaned, &branches, require_placeholder);
    }
    for key in ["then", "else"] {
        if let Some(branch) = cleaned.remove(key) {
            merge_branch_properties(&mut cleaned, &branch, require_placeholder);
        }
    }

    if let Some(value) = cleaned.remove("const") {
        if !cleaned.contains_key("enum") {
            cleaned.insert("enum".to_string(), Value::Array(vec![value]));
        }
    }
    if let Some(Value::Array(values)) = cleaned.get("enum").cloned() {
        let stringified = values
            .iter()
            .map(|value| match value {
                Value::String(text) => Value::String(text.clone()),
                other => Value::String(scalar_to_string(other)),
            })
            .collect();
        cleaned.insert("enum".to_string(), Value::Array(stringified));
    }

    let mut nullable = cleaned
        .get("nullable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if let Some(Value::Array(types)) = cleaned.get("type").cloned() {
        let mut non_null_types: Vec<String> = Vec::new();
        for item in &types {
            let name = item.as_str().unwrap_or_default();
            if name == "null" {
                nullable = true;
            } else if !name.is_empty() {
                non_null_types.push(name.to_string());
            }
        }
        let chosen = if cleaned.contains_key("items") && non_null_types.iter().any(|t| t == "array")
        {
            "array".to_string()
        } else if cleaned.contains_key("properties")
            && non_null_types.iter().any(|t| t == "object")
        {
            "object".to_string()
        } else {
            non_null_types
                .first()
                .cloned()
                .unwrap_or_else(|| "string".to_string())
        };
        cleaned.insert("type".to_string(), Value::String(chosen));
    }
    if nullable {
        cleaned.insert("nullable".to_string(), Value::Bool(true));
    }

    for key in UNSUPPORTED_KEYS {
        cleaned.remove(*key);
    }
    cleaned.retain(|key, _| !key.starts_with("x-"));

    if cleaned.get("properties").and_then(Value::as_object).is_some() {
        if cleaned.get("type").and_then(Value::as_str) != Some("object") {
            cleaned.insert("type".to_string(), Value::String("object".to_string()));
        }
    }
    match cleaned.get("type").and_then(Value::as_str) {
        Some("array") => {
            if !cleaned.contains_key("items") {
                cleaned.insert("items".to_string(), json!({ "type": "string" }));
            }
        }
        Some(_) => {
            cleaned.remove("items");
        }
        None => {
            if cleaned.contains_key("items") {
                cleaned.insert("type".to_string(), Value::String("array".to_string()));
            }
        }
    }

    if let Some(Value::Object(properties)) = cleaned.get("properties").cloned() {
        let mut sanitized = Map::new();
        for (name, schema) in properties {
            sanitized.insert(name, clean_node(&schema, require_placeholder));
        }
        cleaned.insert("properties".to_string(), Value::Object(sanitized));
    }
    if let Some(items) = cleaned.get("items").cloned() {
        let sanitized = match items {
            Value::Array(entries) => Value::Array(
                entries
                    .iter()
                    .map(|item| clean_node(item, require_placeholder))
                    .collect(),
            ),
            other => clean_node(&other, require_placeholder),
        };
        cleaned.insert("items".to_string(), sanitized);
    }

    if let Some(Value::Array(required)) = cleaned.get("required").cloned() {
        let properties = cleaned.get("properties").and_then(Value::as_object);
        match properties {
            Some(properties) => {
                let filtered: Vec<Value> = required
                    .into_iter()
                    .filter(|name| {
                        name.as_str()
                            .is_some_and(|name| properties.contains_key(name))
                    })
                    .collect();
                if filtered.is_empty() {
                    cleaned.remove("required");
                } else {
                    cleaned.insert("required".to_string(), Value::Array(filtered));
                }
            }
            None => {
                cleaned.remove("required");
            }
        }
    }

    if !require_placeholder {
        cleaned.remove("title");
    }

    if require_placeholder && cleaned.get("type").and_then(Value::as_str) == Some("object") {
        add_placeholder(&mut cleaned);
    }

    Value::Object(cleaned)
}

fn add_placeholder(node: &mut Map<String, Value>) {
    let property_count = node
        .get("properties")
        .and_then(Value::as_object)
        .map_or(0, Map::len);
    let has_required = node
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|required| !required.is_empty());

    if property_count == 0 {
        node.insert(
            "properties".to_string(),
            json!({
                "reason": {
                    "type": "string",
                    "description": PLACEHOLDER_REASON_DESCRIPTION,
                }
            }),
        );
        node.insert("required".to_string(), json!(["reason"]));
        return;
    }

    if !has_required {
        if let Some(properties) = node.get_mut("properties").and_then(Value::as_object_mut) {
            properties.insert("_".to_string(), json!({ "type": "boolean" }));
        }
        node.insert("required".to_string(), json!(["_"]));
    }
}

fn flatten_union(parent: &mut Map<String, Value>, branches: &Value, require_placeholder: bool) {
    let Value::Array(items) = branches else {
        return;
    };
    if items.is_empty() {
        return;
    }

    let cleaned: Vec<Value> = items
        .iter()
        .map(|item| clean_node(item, require_placeholder))
        .collect();
    let has_null = cleaned
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("null"));

    let parent_has_properties = parent
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|properties| !properties.is_empty());
    if parent_has_properties {
        for branch in &cleaned {
            let Some(branch_properties) = branch.get("properties").and_then(Value::as_object)
            else {
                continue;
            };
            let target = parent
                .entry("properties".to_string())
                .or_insert_with(|| json!({}));
            let Some(target) = target.as_object_mut() else {
                continue;
            };
            for (name, schema) in branch_properties {
                target.entry(name.clone()).or_insert_with(|| schema.clone());
            }
        }
        if has_null {
            parent.insert("nullable".to_string(), Value::Bool(true));
        }
        if parent.get("type").is_none() {
            parent.insert("type".to_string(), Value::String("object".to_string()));
        }
        return;
    }

    let best = cleaned
        .iter()
        .enumerate()
        .max_by_key(|(_, item)| branch_score(item))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let selected = cleaned[best].clone();
    let selected_is_null = selected.get("type").and_then(Value::as_str) == Some("null");

    let mut merged = match selected {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for (key, value) in parent.iter() {
        if key == "anyOf" || key == "oneOf" {
            continue;
        }
        merged.entry(key.clone()).or_insert_with(|| value.clone());
    }
    if has_null && !selected_is_null {
        merged.insert("nullable".to_string(), Value::Bool(true));
    }
    *parent = merged;
}

fn branch_score(item: &Value) -> i32 {
    match item.get("type").and_then(Value::as_str) {
        Some("object") => 3,
        Some("array") => 2,
        Some("null") => 0,
        Some(_) => 1,
        None => {
            if item.get("properties").is_some() {
                3
            } else if item.get("items").is_some() {
                2
            } else {
                1
            }
        }
    }
}

fn merge_branch_list(parent: &mut Map<String, Value>, branches: &Value, require_placeholder: bool) {
    let Value::Array(items) = branches else {
        return;
    };
    for item in items {
        merge_branch(parent, item, require_placeholder);
    }
}

fn merge_branch_properties(
    parent: &mut Map<String, Value>,
    branch: &Value,
    require_placeholder: bool,
) {
    merge_branch(parent, branch, require_placeholder);
}

fn merge_branch(parent: &mut Map<String, Value>, branch: &Value, require_placeholder: bool) {
    let cleaned = clean_node(branch, require_placeholder);
    let Value::Object(branch_map) = cleaned else {
        return;
    };
    for (key, value) in branch_map {
        if key == "required" {
            let Some(branch_required) = value.as_array() else {
                continue;
            };
            let mut required = parent
                .get("required")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for name in branch_required {
                if !required.iter().any(|existing| existing == name) {
                    required.push(name.clone());
                }
            }
            if !required.is_empty() {
                parent.insert("required".to_string(), Value::Array(required));
            }
            continue;
        }
        if key == "properties" {
            let Some(branch_properties) = value.as_object() else {
                continue;
            };
            let target = parent
                .entry("properties".to_string())
                .or_insert_with(|| json!({}));
            let Some(target) = target.as_object_mut() else {
                continue;
            };
            for (name, schema) in branch_properties {
                target.entry(name.clone()).or_insert_with(|| schema.clone());
            }
            continue;
        }
        parent.entry(key).or_insert(value);
    }
}

fn scalar_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
