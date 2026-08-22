use super::*;

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
                }
            })
        })
        .collect();

    Value::Array(functions)
}

/// Tool APIs require input schemas to describe an object. Some gateways (e.g.
/// Google Gemini API, OpenAI, Claude) strictly enforce that any schema node with
/// `properties` or `required` MUST declare `"type": "object"`, any node with
/// `items` MUST declare `"type": "array"`, and `type` cannot be a union array.
/// Remove root combinators (`oneOf`/`anyOf`/`allOf`) and recursively ensure all
/// nested schema nodes are compliant.
fn sanitize_tool_input_schema(schema: &Value) -> Value {
    let mut root = schema.clone();
    sanitize_schema_node(&mut root, true);
    root
}

fn sanitize_schema_node(node: &mut Value, is_root: bool) {
    if let Value::Object(map) = node {
        if is_root {
            map.remove("oneOf");
            map.remove("anyOf");
            map.remove("allOf");
            map.insert("type".to_string(), Value::String("object".to_string()));
        } else if let Some(type_val) = map.get("type") {
            if let Some(arr) = type_val.as_array() {
                let first_scalar = arr
                    .iter()
                    .find_map(|item| item.as_str())
                    .unwrap_or("string");
                map.insert("type".to_string(), Value::String(first_scalar.to_string()));
            }
        } else if map.contains_key("properties") || map.contains_key("required") {
            map.insert("type".to_string(), Value::String("object".to_string()));
        } else if map.contains_key("items") {
            map.insert("type".to_string(), Value::String("array".to_string()));
        }

        if let Some(properties) = map.get_mut("properties") {
            if let Value::Object(props_map) = properties {
                for (_, prop_val) in props_map.iter_mut() {
                    sanitize_schema_node(prop_val, false);
                }
            }
        }

        if let Some(items) = map.get_mut("items") {
            sanitize_schema_node(items, false);
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
            json!({
                "name": tool.full_name(),
                "description": tool.description,
                "parameters": sanitized_schema,
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_tool(server_id: &str, name: &str, required_field: &str) -> McpTool {
        McpTool {
            server_id: server_id.to_string(),
            name: name.to_string(),
            description: format!("Tool requiring {required_field}"),
            input_schema: json!({
                "properties": {
                    required_field: { "type": "string" }
                },
                "required": [required_field]
            }),
        }
    }

    #[test]
    fn sanitizes_nested_schemas_and_fixes_missing_types_for_gemini() {
        let raw_schema = json!({
            "oneOf": [{"type": "object"}],
            "properties": {
                "dialogResponse": {
                    "description": "A dialog response object without explicit type",
                    "properties": {
                        "accept": { "type": "boolean" },
                        "promptText": { "type": "string" }
                    },
                    "required": ["accept"]
                },
                "requestId": {
                    "type": ["string", "number"],
                    "description": "Union type"
                },
                "itemsList": {
                    "items": {
                        "properties": {
                            "name": { "type": "string" }
                        }
                    }
                }
            }
        });

        let sanitized = sanitize_tool_input_schema(&raw_schema);

        assert_eq!(sanitized["type"], "object");
        assert!(sanitized.get("oneOf").is_none());

        // dialogResponse has properties, so type: "object" must be injected
        assert_eq!(sanitized["properties"]["dialogResponse"]["type"], "object");
        assert_eq!(
            sanitized["properties"]["dialogResponse"]["properties"]["accept"]["type"],
            "boolean"
        );

        // requestId array type collapsed to single scalar string
        assert_eq!(sanitized["properties"]["requestId"]["type"], "string");

        // itemsList items object has properties, so type: "object" injected into item, and itemsList has type: "array"
        assert_eq!(sanitized["properties"]["itemsList"]["type"], "array");
        assert_eq!(
            sanitized["properties"]["itemsList"]["items"]["type"],
            "object"
        );
    }

    #[test]
    fn serializes_interactions_tools_as_one_grouped_compatibility_object() {
        let tools = vec![
            test_tool("todo", "todo-manage", "action"),
            test_tool("filesystem", "read", "filePath"),
        ];

        let serialized = tools_as_interactions_json(&tools);
        let entries = serialized.as_array().expect("Interactions tools array");
        let declarations = entries[0]["function_declarations"]
            .as_array()
            .expect("Interactions function declarations");

        assert_eq!(entries.len(), 1);
        assert!(entries[0].get("type").is_none());
        assert_eq!(declarations.len(), 2);
        assert_eq!(declarations[0]["name"], "todo-todo-manage");
        assert_eq!(declarations[0]["parameters"]["type"], "object");
        assert_eq!(declarations[0]["parameters"]["required"], json!(["action"]));
        assert_eq!(
            declarations[0]["parameters"]["properties"]["action"]["type"],
            "string"
        );
        assert_eq!(declarations[1]["name"], "filesystem-read");
        assert_eq!(
            declarations[1]["parameters"]["required"],
            json!(["filePath"])
        );
        assert!(declarations
            .iter()
            .all(|declaration| declaration.get("type").is_none()));
        assert!(entries[0].get("functionDeclarations").is_none());
    }

    #[test]
    fn keeps_native_gemini_tools_grouped() {
        let serialized = tools_as_gemini_json(&[test_tool("filesystem", "read", "filePath")]);
        let entries = serialized.as_array().expect("Gemini tools array");
        let declarations = entries[0]["functionDeclarations"]
            .as_array()
            .expect("Gemini function declarations");

        assert_eq!(entries.len(), 1);
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0]["name"], "filesystem-read");
        assert_eq!(
            declarations[0]["parameters"]["required"],
            json!(["filePath"])
        );
        assert!(entries[0].get("type").is_none());
    }
}
