//! Per-request plugin and tool-search declarations captured before request hooks run.

use std::collections::{HashMap, HashSet};

use napi::{Error, Result};
use serde_json::Value;

#[derive(Clone, Copy)]
pub enum Protocol {
    Responses,
    Chat,
    Anthropic,
    Gemini,
    Interactions,
}

pub struct PluginToolConfiguration {
    generation: u64,
    servers: HashMap<String, (String, String)>,
}

pub struct PluginToolGuard {
    protocol: Protocol,
    servers: HashSet<String>,
    declarations: HashMap<String, (bool, Value)>,
}

impl PluginToolGuard {
    pub async fn configuration(project_id: Option<&str>) -> Result<PluginToolConfiguration> {
        let generation = crate::tool_search_port::generation();
        // Include every effective plugin server, not only those authorized for
        // this request. This lookup reads configuration and never connects.
        let servers = crate::external::available_plugin_servers(project_id, None).await?;
        if generation != crate::tool_search_port::generation() {
            return Err(Error::from_reason("Plugin configuration changed during request collection"));
        }
        Ok(PluginToolConfiguration { generation, servers })
    }

    pub async fn capture(
        protocol: Protocol,
        project_id: Option<&str>,
        configuration: PluginToolConfiguration,
        payload: &Value,
    ) -> Result<Self> {
        let current = crate::external::available_plugin_servers(project_id, None).await?;
        if configuration.generation != crate::tool_search_port::generation()
            || configuration.servers != current
        {
            return Err(Error::from_reason("Plugin configuration changed during request collection"));
        }
        let mut guard = Self {
            protocol,
            servers: configuration.servers.into_keys().collect(),
            declarations: HashMap::new(),
        };
        guard.declarations = guard.extract(payload)?;
        Ok(guard)
    }

    pub fn validate(&self, payload: &Value) -> Result<()> {
        if self.extract(payload)? != self.declarations {
            return Err(Error::from_reason(
                "Protected tool declarations changed after request transformation",
            ));
        }
        Ok(())
    }

    fn is_plugin_name(&self, name: &str) -> bool {
        crate::contract::split_tool_full_name(name)
            .is_some_and(|(server, _)| self.servers.contains(server))
    }

    fn is_guarded_tool(&self, name: &str) -> bool {
        use crate::contract::{TOOL_DISCOVER, TOOL_SEARCH_SERVER_ID};
        self.is_plugin_name(name)
            || crate::contract::split_tool_full_name(name)
                .is_some_and(|(server, tool)| server == TOOL_SEARCH_SERVER_ID && tool == TOOL_DISCOVER)
    }

    fn insert(
        &self,
        declarations: &mut HashMap<String, (bool, Value)>,
        name: &str,
        wrapped: bool,
        declaration: &Value,
    ) -> Result<()> {
        if declarations
            .insert(name.to_string(), (wrapped, declaration.clone()))
            .is_some()
        {
            return Err(Error::from_reason(format!(
                "Duplicate protected tool declaration: {name}"
            )));
        }
        Ok(())
    }

    fn extract(&self, payload: &Value) -> Result<HashMap<String, (bool, Value)>> {
        let mut declarations = HashMap::new();
        let object = payload.as_object().ok_or_else(|| {
            Error::from_reason("Cannot verify plugin tools in a non-object request")
        })?;
        self.extract_body(object, false, &mut declarations)?;
        // Antigravity wraps the Gemini body under request. Inspect both paths so
        // adding a second tools array or moving a declaration cannot bypass it.
        if matches!(self.protocol, Protocol::Gemini) {
            if let Some(request) = object.get("request") {
                let request = request.as_object().ok_or_else(|| {
                    Error::from_reason("Cannot verify plugin tools in request envelope")
                })?;
                self.extract_body(request, true, &mut declarations)?;
            }
        }
        Ok(declarations)
    }

    fn extract_body(
        &self,
        body: &serde_json::Map<String, Value>,
        wrapped: bool,
        declarations: &mut HashMap<String, (bool, Value)>,
    ) -> Result<()> {
        if let Some(tools) = body.get("tools").filter(|tools| !tools.is_null()) {
            self.extract_tools(tools, wrapped, declarations)?;
        }
        // Chat Completions also accepts legacy top-level function declarations.
        if matches!(self.protocol, Protocol::Chat) {
            if let Some(functions) = body.get("functions").filter(|functions| !functions.is_null()) {
                let functions = functions.as_array().ok_or_else(|| {
                    Error::from_reason("Cannot verify plugin functions: functions must be an array")
                })?;
                for function in functions {
                    self.extract_declaration(function, wrapped, declarations)?;
                }
            }
        }
        Ok(())
    }

    fn extract_tools(
        &self,
        tools: &Value,
        wrapped: bool,
        declarations: &mut HashMap<String, (bool, Value)>,
    ) -> Result<()> {
        let entries = tools.as_array().ok_or_else(|| {
            Error::from_reason("Cannot verify protected tools: tools must be an array")
        })?;
        for entry in entries {
            let object = entry.as_object().ok_or_else(|| {
                Error::from_reason("Cannot verify protected tools: invalid tool entry")
            })?;
            match self.protocol {
                Protocol::Gemini | Protocol::Interactions => {
                    for (key, value) in object {
                        if key == "functionDeclarations" || key == "function_declarations" {
                            let functions = value.as_array().ok_or_else(|| {
                                Error::from_reason("Cannot verify function declarations")
                            })?;
                            for function in functions {
                                self.extract_declaration(function, wrapped, declarations)?;
                            }
                        } else if key.to_ascii_lowercase().contains("function") {
                            return Err(Error::from_reason(
                                "Cannot verify function declarations in an unknown format",
                            ));
                        } else if key == "name"
                            && value.as_str().is_some_and(|name| self.is_guarded_tool(name))
                        {
                            return Err(Error::from_reason(
                                "Cannot verify protected tool in an unknown declaration format",
                            ));
                        }
                    }
                }
                Protocol::Chat => {
                    if let Some(function) = object.get("function") {
                        let name = function.get("name").and_then(Value::as_str).ok_or_else(|| {
                            Error::from_reason("Cannot verify chat function declaration")
                        })?;
                        if self.is_guarded_tool(name) {
                            self.insert(declarations, name, wrapped, entry)?;
                        }
                    } else {
                        let kind = object.get("type").and_then(Value::as_str).ok_or_else(|| {
                            Error::from_reason("Cannot verify chat tool declaration")
                        })?;
                        if kind == "function" {
                            return Err(Error::from_reason("Cannot verify chat function declaration"));
                        }
                        let direct_name = object.get("name").and_then(Value::as_str);
                        let custom_name = object.get("custom")
                            .and_then(|value| value.get("name"))
                            .and_then(Value::as_str);
                        if kind == "custom" && custom_name.is_none() {
                            return Err(Error::from_reason("Cannot verify chat custom tool declaration"));
                        }
                        if direct_name.is_some_and(|name| self.is_guarded_tool(name))
                            || custom_name.is_some_and(|name| self.is_guarded_tool(name))
                        {
                            return Err(Error::from_reason(
                                "Cannot verify protected tool in an unknown declaration format",
                            ));
                        }
                    }
                }
                Protocol::Responses | Protocol::Anthropic => {
                    if let Some(name) = object.get("name") {
                        let name = name.as_str().ok_or_else(|| {
                            Error::from_reason("Cannot verify tool declaration name")
                        })?;
                        if self.is_guarded_tool(name) {
                            self.insert(declarations, name, wrapped, entry)?;
                        }
                    } else {
                        let kind = object.get("type").and_then(Value::as_str).ok_or_else(|| {
                            Error::from_reason("Cannot verify tool declaration")
                        })?;
                        if kind == "function" || kind == "custom" {
                            return Err(Error::from_reason("Cannot verify function declaration"));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn extract_declaration(
        &self,
        declaration: &Value,
        wrapped: bool,
        declarations: &mut HashMap<String, (bool, Value)>,
    ) -> Result<()> {
        let name = declaration.get("name").and_then(Value::as_str).ok_or_else(|| {
            Error::from_reason("Cannot verify function declaration name")
        })?;
        if self.is_guarded_tool(name) {
            self.insert(declarations, name, wrapped, declaration)?;
        }
        Ok(())
    }
}
