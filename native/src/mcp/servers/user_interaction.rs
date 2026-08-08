use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "user-interaction";
const TOOL_NAME: &str = "askUserQuestion";

#[napi(object)]
pub struct UserQuestionCommand {
    pub question: String,
    pub options: Vec<String>,
}

pub type UserQuestionCallback =
    ThreadsafeFunction<UserQuestionCommand, Promise<String>, UserQuestionCommand, Status, false>;

#[derive(Debug, Clone, PartialEq)]
struct NormalizedQuestion {
    question: String,
    options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct NormalizedAnswer {
    cancelled: bool,
    answers: Vec<String>,
    selected_options: Vec<String>,
    custom_answers: Vec<String>,
}

pub struct UserInteractionService;

impl UserInteractionService {
    pub fn new() -> Self {
        UserInteractionService
    }

    pub async fn execute_async(
        &self,
        args: &Value,
        on_question: &UserQuestionCallback,
    ) -> napi::Result<Value> {
        let normalized = validate_question_args(args)?;
        let command = UserQuestionCommand {
            question: normalized.question.clone(),
            options: normalized.options.clone(),
        };

        let promise = on_question
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch user question to Electron: {error}"),
                )
            })?;
        let answer_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("User question failed: {error}"),
            )
        })?;
        let answer = validate_answer_json(&answer_json, &normalized.options)?;

        Ok(json!({
            "answered": !answer.cancelled,
            "cancelled": answer.cancelled,
            "question": normalized.question,
            "answers": answer.answers,
            "selectedOptions": answer.selected_options,
            "customAnswers": answer.custom_answers,
        }))
    }
}

impl McpService for UserInteractionService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_NAME.to_string(),
            description: "Pause and engage the user for input before continuing. Use this tool for two purposes: (1) ask a concise question when a decision or missing detail must be clarified before proceeding; (2) wait for the user to complete a manual action you need assistance with — for example when you need the user to perform an operation you cannot do yourself, confirm something in the real world, or verify a result you cannot check. In this case phrase the message as a wait request and let the user reply once they are done. The interaction is always multi-select: the user may choose any combination of the provided options and may add one or more arbitrary free-text answers. Call this tool by itself, never in parallel with other tools, because subsequent work must use the user's answer."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "A concise, focused message describing either the decision that needs clarification or the manual action the user should complete before you can continue."
                    },
                    "options": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "minLength": 1
                        },
                        "minItems": 2,
                        "uniqueItems": true,
                        "description": "Two or more concise choices. The user can select multiple choices and add custom free-text answers."
                    }
                },
                "required": ["question", "options"]
            }),
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_NAME => Err(Error::new(
                Status::GenericFailure,
                "askUserQuestion must be executed through the asynchronous Electron interaction bridge"
                    .to_string(),
            )),
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

fn validate_question_args(args: &Value) -> napi::Result<NormalizedQuestion> {
    let object = args.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Arguments for askUserQuestion must be a JSON object".to_string(),
        )
    })?;

    let question = match object.get("question") {
        None | Some(Value::Null) => {
            return Err(Error::new(
                Status::InvalidArg,
                "question is required for askUserQuestion".to_string(),
            ));
        }
        Some(Value::String(s)) => s.clone(),
        Some(value) => coerce_scalar_to_string(value).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "question must be a string (received {})",
                    value_type_name(value)
                ),
            )
        })?,
    };
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "question must not be empty for askUserQuestion".to_string(),
        ));
    }

    let raw_options = match object.get("options") {
        None | Some(Value::Null) => {
            return Err(Error::new(
                Status::InvalidArg,
                "options is required for askUserQuestion".to_string(),
            ));
        }
        Some(Value::Array(arr)) => arr.clone(),
        Some(value) => {
            if is_scalar_value(value) {
                vec![value.clone()]
            } else {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "options must be an array of strings (received {})",
                        value_type_name(value)
                    ),
                ));
            }
        }
    };
    let options = normalize_string_array(&raw_options, "options")?;

    if options.len() < 2 {
        return Err(Error::new(
            Status::InvalidArg,
            "options must contain at least two unique non-empty choices".to_string(),
        ));
    }

    Ok(NormalizedQuestion { question, options })
}

fn validate_answer_json(answer_json: &str, options: &[String]) -> napi::Result<NormalizedAnswer> {
    let parsed: Value = serde_json::from_str(answer_json).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("User answer must be valid JSON: {error}"),
        )
    })?;
    let object = parsed.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "User answer must be a JSON object".to_string(),
        )
    })?;
    let cancelled = match object.get("cancelled") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            return Err(Error::new(
                Status::InvalidArg,
                "cancelled must be a boolean".to_string(),
            ));
        }
    };

    if cancelled {
        let read_cancelled_array = |field: &str| -> napi::Result<Vec<String>> {
            let values = object.get(field).and_then(Value::as_array).ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("Cancelled user answer must contain an empty {field} array"),
                )
            })?;
            normalize_string_array(values, field)
        };
        let answers = read_cancelled_array("answers")?;
        let selected_options = read_cancelled_array("selectedOptions")?;
        let custom_answers = read_cancelled_array("customAnswers")?;
        if !answers.is_empty() || !selected_options.is_empty() || !custom_answers.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "Cancelled user answer arrays must all be empty".to_string(),
            ));
        }

        return Ok(NormalizedAnswer {
            cancelled: true,
            answers,
            selected_options,
            custom_answers,
        });
    }

    let raw_answers = object
        .get("answers")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "User answer must contain a non-empty answers array".to_string(),
            )
        })?;
    let answers = normalize_string_array(raw_answers, "answers")?;
    if answers.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "The user must provide at least one answer".to_string(),
        ));
    }

    let selected_options = optional_string_array(object.get("selectedOptions"), "selectedOptions")?;
    if selected_options
        .iter()
        .any(|selected| !options.contains(selected))
    {
        return Err(Error::new(
            Status::InvalidArg,
            "selectedOptions contains a value that was not offered".to_string(),
        ));
    }

    let custom_answers = optional_string_array(object.get("customAnswers"), "customAnswers")?;
    if selected_options
        .iter()
        .chain(custom_answers.iter())
        .any(|answer| !answers.contains(answer))
    {
        return Err(Error::new(
            Status::InvalidArg,
            "Every selected or custom answer must also appear in answers".to_string(),
        ));
    }

    Ok(NormalizedAnswer {
        cancelled: false,
        answers,
        selected_options,
        custom_answers,
    })
}

fn optional_string_array(value: Option<&Value>, field: &str) -> napi::Result<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(values)) => normalize_string_array(values, field),
        Some(_) => Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be an array of strings"),
        )),
    }
}

fn is_scalar_value(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

fn coerce_scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn normalize_string_array(values: &[Value], field: &str) -> napi::Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        let coerced = coerce_scalar_to_string(value).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!(
                    "{field} must contain only strings, numbers, or booleans (received {})",
                    value_type_name(value)
                ),
            )
        })?;
        let trimmed = coerced.trim();
        if trimmed.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("{field} must not contain empty values"),
            ));
        }
        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    Ok(normalized)
}

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [{SERVER_ID}-{TOOL_NAME}]"
        ),
    )
}
