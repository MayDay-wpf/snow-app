//! 用户自定义脱敏规则：解析、校验、编译与匹配。

use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};

use crate::storage::services::privacy_settings::PrivacyCustomRule;

use super::{add_match, SensitiveMatch};

pub(crate) const CUSTOM_RULES_MAX: usize = 200;
const PATTERN_MAX_CHARS: usize = 2000;
const NAME_MAX_CHARS: usize = 120;
const REGEX_SIZE_LIMIT: usize = 1 << 20;
const CONFIDENCE: f64 = 0.99;

/// 星号遮罩的匹配类型；带替换文本时用前缀编码。
pub(super) const MATCH_TYPE: &str = "custom";
pub(super) const TEXT_PREFIX: &str = "custom_text:";

pub(super) struct CompiledCustomRule {
    regex: Regex,
    group: usize,
    match_type: String,
}

fn build_regex(pattern: &str) -> Result<Regex, String> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|error| error.to_string())
}

fn new_rule_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("custom_{}", &id[..10])
}

/// 校验整组规则：数量、名称、正则可编译、捕获组存在、id 唯一。
pub fn validate_rules(rules: &[PrivacyCustomRule]) -> Result<(), String> {
    if rules.len() > CUSTOM_RULES_MAX {
        return Err(format!("At most {CUSTOM_RULES_MAX} custom rules are allowed"));
    }
    let mut ids: Vec<&str> = Vec::new();
    for rule in rules {
        let label = if rule.name.is_empty() { &rule.id } else { &rule.name };
        if rule.id.trim().is_empty() {
            return Err(format!("Rule \"{label}\": id must not be empty"));
        }
        if ids.contains(&rule.id.as_str()) {
            return Err(format!("Duplicate custom rule id: {}", rule.id));
        }
        ids.push(rule.id.as_str());
        if rule.name.trim().is_empty() {
            return Err(format!("Rule \"{}\": name is required", rule.id));
        }
        if rule.name.chars().count() > NAME_MAX_CHARS {
            return Err(format!("Rule \"{label}\": name exceeds {NAME_MAX_CHARS} characters"));
        }
        if rule.pattern.is_empty() {
            return Err(format!("Rule \"{label}\": pattern is required"));
        }
        if rule.pattern.chars().count() > PATTERN_MAX_CHARS {
            return Err(format!("Rule \"{label}\": pattern exceeds {PATTERN_MAX_CHARS} characters"));
        }
        let regex = build_regex(&rule.pattern)
            .map_err(|error| format!("Rule \"{label}\": invalid regex: {error}"))?;
        if rule.group as usize >= regex.captures_len() {
            return Err(format!(
                "Rule \"{label}\": group {} does not exist (pattern has {} capture group(s))",
                rule.group,
                regex.captures_len() - 1
            ));
        }
    }
    Ok(())
}

fn field_str<'a>(map: &'a serde_json::Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

/// 解析单条规则；`base` 为已存在的规则，省略字段沿用其值。
fn parse_rule(value: &Value, base: Option<&PrivacyCustomRule>) -> Result<PrivacyCustomRule, String> {
    let map = value
        .as_object()
        .ok_or_else(|| "each custom rule must be an object".to_string())?;
    let mut rule = base.cloned().unwrap_or(PrivacyCustomRule {
        enabled: true,
        ..PrivacyCustomRule::default()
    });
    if let Some(id) = field_str(map, "id")? {
        rule.id = id.trim().to_string();
    }
    if let Some(name) = field_str(map, "name")? {
        rule.name = name.trim().to_string();
    }
    if let Some(pattern) = field_str(map, "pattern")? {
        rule.pattern = pattern.to_string();
    }
    if let Some(replacement) = field_str(map, "replacement")? {
        rule.replacement = replacement.to_string();
    }
    match map.get("group") {
        None | Some(Value::Null) => {}
        Some(group) => {
            rule.group = group
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "group must be a non-negative integer".to_string())?;
        }
    }
    match map.get("enabled") {
        None | Some(Value::Null) => {}
        Some(enabled) => {
            rule.enabled = enabled
                .as_bool()
                .ok_or_else(|| "enabled must be a boolean".to_string())?;
        }
    }
    if rule.id.is_empty() {
        rule.id = new_rule_id();
    }
    Ok(rule)
}

fn rule_items(value: &Value) -> Result<&Vec<Value>, String> {
    // 兼容 { rules: [...] } 包装
    let list = value.get("rules").unwrap_or(value);
    list.as_array()
        .ok_or_else(|| "custom rules must be a JSON array of rule objects".to_string())
}

/// 整体替换：按 id 合并已有规则的省略字段。
pub(crate) fn parse_rules(
    value: &Value,
    existing: &[PrivacyCustomRule],
) -> Result<Vec<PrivacyCustomRule>, String> {
    let mut rules = Vec::new();
    for item in rule_items(value)? {
        let base = item
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| existing.iter().find(|rule| rule.id == id.trim()));
        rules.push(parse_rule(item, base)?);
    }
    validate_rules(&rules)?;
    Ok(rules)
}

/// 编辑器 JSON 文本解析。
pub fn parse_rules_text(
    content: &str,
    existing: &[PrivacyCustomRule],
) -> Result<Vec<PrivacyCustomRule>, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value =
        serde_json::from_str(trimmed).map_err(|error| format!("Invalid JSON: {error}"))?;
    parse_rules(&value, existing)
}

fn find_index(rules: &[PrivacyCustomRule], key: &str) -> Option<usize> {
    rules
        .iter()
        .position(|rule| rule.id == key)
        .or_else(|| rules.iter().position(|rule| rule.name == key))
}

/// 增量写入：按 id（其次 name）命中则更新，否则新增。
pub(crate) fn upsert_rules(
    mut rules: Vec<PrivacyCustomRule>,
    value: &Value,
) -> Result<Vec<PrivacyCustomRule>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "upsertCustomRules must be an array of rule objects".to_string())?;
    for item in items {
        let key = item
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| item.get("name").and_then(Value::as_str))
            .map(str::trim)
            .unwrap_or_default();
        match find_index(&rules, key).filter(|_| !key.is_empty()) {
            Some(index) => {
                let updated = parse_rule(item, Some(&rules[index]))?;
                rules[index] = updated;
            }
            None => rules.push(parse_rule(item, None)?),
        }
    }
    validate_rules(&rules)?;
    Ok(rules)
}

/// 按 id 或 name 删除。
pub(crate) fn remove_rules(
    mut rules: Vec<PrivacyCustomRule>,
    value: &Value,
) -> Result<Vec<PrivacyCustomRule>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "removeCustomRules must be an array of rule ids or names".to_string())?;
    for item in items {
        let key = item.as_str().map(str::trim).unwrap_or_default();
        let index = find_index(&rules, key)
            .ok_or_else(|| format!("Unknown custom rule: {key}"))?;
        rules.remove(index);
    }
    Ok(rules)
}

pub(crate) fn rules_view(rules: &[PrivacyCustomRule]) -> Value {
    Value::Array(
        rules
            .iter()
            .map(|rule| {
                json!({
                    "id": rule.id,
                    "name": rule.name,
                    "pattern": rule.pattern,
                    "group": rule.group,
                    "replacement": rule.replacement,
                    "enabled": rule.enabled,
                })
            })
            .collect(),
    )
}

/// 只编译启用且合法的规则（非法规则静默跳过）。
pub(super) fn compile_rules(rules: &[PrivacyCustomRule]) -> Vec<CompiledCustomRule> {
    rules
        .iter()
        .filter(|rule| rule.enabled && !rule.pattern.is_empty())
        .filter_map(|rule| {
            let regex = build_regex(&rule.pattern).ok()?;
            let group = rule.group as usize;
            if group >= regex.captures_len() {
                return None;
            }
            let match_type = if rule.replacement.is_empty() {
                MATCH_TYPE.to_string()
            } else {
                format!("{TEXT_PREFIX}{}", rule.replacement)
            };
            Some(CompiledCustomRule {
                regex,
                group,
                match_type,
            })
        })
        .collect()
}

pub(super) fn collect_matches(
    text: &str,
    rules: &[CompiledCustomRule],
    matches: &mut Vec<SensitiveMatch>,
) {
    for rule in rules {
        if rule.group == 0 {
            for m in rule.regex.find_iter(text) {
                add_match(matches, m.start(), m.end(), &rule.match_type, CONFIDENCE);
            }
            continue;
        }
        for caps in rule.regex.captures_iter(text) {
            if let Some(m) = caps.get(rule.group) {
                add_match(matches, m.start(), m.end(), &rule.match_type, CONFIDENCE);
            }
        }
    }
}
