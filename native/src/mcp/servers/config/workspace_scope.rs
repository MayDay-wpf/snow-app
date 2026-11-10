//! config 服务 `workspace` 作用域：工作区（项目）清单与关联项目组管理。
//!
//! - `key=directories`：工作区清单（directoryId、名称、路径、类型、激活状态、排序、
//!   路径健康状态）。`config-manage action=set value={action:"create", name, parentPath?}` 在
//!   tools/call.rs 路由到渲染端建项目；删除/重新定位仍由 UI 负责。
//! - `key=collections`（读写）：项目分组（合集 = 关联项目组）。`config-manage action=set` 用
//!   action 分发：`{action:"create", name}` / `{action:"rename", collectionId, name}`
//!   / `{action:"setColor", collectionId, color}` / `{action:"setMemberLinked",
//!   collectionId, directoryId, linked}` / `{action:"move", collectionId,
//!   directoryId, orderedMemberIds?}` / `{action:"reorder", collectionId,
//!   orderedMemberIds}` / `{action:"removeMember", collectionId, directoryId}`。
//!   成员带 `linked` 开关：断连的成员仍留在合集里，只是不参与关联。
//! - `key=collection:<collectionId>`（读 + delete）：读取单个分组；`config-manage action=delete`
//!   删除分组（需 confirmed）。
//!
//! 真源：应用数据库 `workspace_directories` / `project_collections` /
//! `collection_members`（与 UI 侧边栏同源）。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::services::project_collections::{
    create_project_collection, delete_project_collection, list_project_collections,
    move_project_to_collection, remove_project_from_collection, rename_project_collection,
    reorder_project_collection_members, set_project_collection_member_linked,
    update_project_collection_color,
};
use crate::storage::services::workspace_directories::list_workspace_directories;

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const DIRECTORIES_KEY: &str = "directories";
const COLLECTIONS_KEY: &str = "collections";
const COLLECTION_KEY_PREFIX: &str = "collection:";

fn directories_view(db_path: &Path) -> Result<Value> {
    let directories = list_workspace_directories(db_path)?;
    let items = directories
        .iter()
        .map(|directory| {
            json!({
                "directoryId": directory.directory_id,
                "name": directory.name,
                "path": directory.path,
                "kind": directory.kind,
                "isActive": directory.is_active,
                "sortOrder": directory.sort_order,
                "source": directory.source,
                "pathState": directory.path_state,
                "lastKnownPath": directory.last_known_path,
                "updatedAt": directory.updated_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!(items))
}

fn collections_view(db_path: &Path) -> Result<Value> {
    let collections = list_project_collections(db_path)?;
    let items = collections
        .iter()
        .map(|collection| {
            json!({
"collectionId": collection.collection_id,
                "name": collection.name,
                "color": collection.color,
                "sortOrder": collection.sort_order,
                "memberDirectoryIds": collection.member_directory_ids,
                "linkedDirectoryIds": collection.linked_directory_ids,
                "updatedAt": collection.updated_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!(items))
}

fn find_collection(db_path: &Path, collection_id: &str) -> Result<Value> {
    let collections = collections_view(db_path)?;
    collections
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("collectionId").and_then(Value::as_str) == Some(collection_id)
            })
        })
        .cloned()
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Project collection not found: {collection_id}"),
            )
        })
}

fn read_member_ids(value: &Value, field: &str) -> Result<Vec<String>> {
    let items = value.as_array().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("{field} must be an array of directoryId strings"),
        )
    })?;
    let mut ids = Vec::new();
    for item in items {
        let id = item
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("{field} must be an array of directoryId strings"),
                )
            })?;
        ids.push(id.to_string());
    }
    Ok(ids)
}

fn apply_collection_action(db_path: &Path, value: &Value) -> Result<Value> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "collections value must be an object like { action: \"create\", name: \"Work\" }"
                .to_string(),
        ));
    };
    let action = patch
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "collections value requires an `action` field".to_string(),
            )
        })?;
    let required_string = |field: &str| -> Result<String> {
        patch
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("{field} is required for action \"{action}\""),
                )
            })
    };

    let summary = match action {
        "create" => {
            let name = required_string("name")?;
            create_project_collection(db_path, &name, &[])?;
            json!({ "action": action, "name": name })
        }
        "rename" => {
            let collection_id = required_string("collectionId")?;
            let name = required_string("name")?;
            rename_project_collection(db_path, &collection_id, &name)?;
            json!({ "action": action, "collectionId": collection_id, "name": name })
        }
"setColor" => {
            let collection_id = required_string("collectionId")?;
            let color = required_string("color")?;
            update_project_collection_color(db_path, &collection_id, &color)?;
            json!({ "action": action, "collectionId": collection_id, "color": color })
        }
        "setMemberLinked" => {
            let collection_id = required_string("collectionId")?;
            let directory_id = required_string("directoryId")?;
            let linked = patch
                .get("linked")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "linked (boolean) is required for action \"setMemberLinked\"".to_string(),
                    )
                })?;
            set_project_collection_member_linked(
                db_path,
                &collection_id,
                &directory_id,
                linked,
            )?;
            json!({
                "action": action,
                "collectionId": collection_id,
                "directoryId": directory_id,
                "linked": linked,
            })
        }
        "move" => {
            let collection_id = required_string("collectionId")?;
            let directory_id = required_string("directoryId")?;
            let mut ordered = match patch.get("orderedMemberIds") {
                Some(items) => read_member_ids(items, "orderedMemberIds")?,
                None => {
                    // 缺省：现有成员 + 被移入的项目（若尚未在列表中）。
                    let collections = collections_view(db_path)?;
                    let mut members = collections
                        .as_array()
                        .and_then(|items| {
                            items.iter().find(|item| {
                                item.get("collectionId").and_then(Value::as_str)
                                    == Some(collection_id.as_str())
                            })
                        })
                        .and_then(|item| item.get("memberDirectoryIds"))
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    if !members.iter().any(|id| id == &directory_id) {
                        members.push(directory_id.clone());
                    }
                    members
                }
            };
            if !ordered.iter().any(|id| id == &directory_id) {
                ordered.push(directory_id.clone());
            }
            move_project_to_collection(db_path, &collection_id, &directory_id, &ordered)?;
            json!({
                "action": action,
                "collectionId": collection_id,
                "directoryId": directory_id,
                "orderedMemberIds": ordered,
            })
        }
        "reorder" => {
            let collection_id = required_string("collectionId")?;
            let ordered = read_member_ids(
                patch.get("orderedMemberIds").ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        "orderedMemberIds is required for action \"reorder\"".to_string(),
                    )
                })?,
                "orderedMemberIds",
            )?;
            reorder_project_collection_members(db_path, &collection_id, &ordered)?;
            json!({ "action": action, "collectionId": collection_id, "orderedMemberIds": ordered })
        }
        "removeMember" => {
            let collection_id = required_string("collectionId")?;
            let directory_id = required_string("directoryId")?;
            remove_project_from_collection(db_path, &collection_id, &directory_id)?;
            json!({ "action": action, "collectionId": collection_id, "directoryId": directory_id })
        }
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
"Unknown collections action: {other}. Available actions: create, rename, setColor, setMemberLinked, move, reorder, removeMember"
                ),
            ))
        }
    };

    Ok(json!({
        "scope": "workspace",
        "key": COLLECTIONS_KEY,
        "changed": summary,
        "value": collections_view(db_path)?,
    }))
}

/// Dispatches the `config-manage` list/get/set/delete actions for the `workspace` scope.
pub(crate) fn execute_workspace_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => Ok(json!({
            "scope": "workspace",
            "file": null,
            "keys": [
                {
                    "key": DIRECTORIES_KEY,
                    "type": "array",
                    "sensitive": false,
                    "readOnly": true,
                    "configured": true,
                    "value": directories_view(db_path)?,
                },
                {
                    "key": COLLECTIONS_KEY,
                    "type": "array",
                    "sensitive": false,
                    "readOnly": false,
                    "configured": true,
                    "value": collections_view(db_path)?,
                },
            ],
        })),
        TOOL_GET => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            match key {
                DIRECTORIES_KEY => Ok(json!({
                    "scope": "workspace",
                    "key": key,
                    "readOnly": true,
                    "value": directories_view(db_path)?,
                })),
                COLLECTIONS_KEY => Ok(json!({
                    "scope": "workspace",
                    "key": key,
                    "value": collections_view(db_path)?,
                })),
                "" => Err(Error::new(
                    Status::InvalidArg,
                    "workspace requires a key: directories | collections | collection:<collectionId>"
                        .to_string(),
                )),
                other => match other.strip_prefix(COLLECTION_KEY_PREFIX) {
                    Some(collection_id) if !collection_id.trim().is_empty() => Ok(json!({
                        "scope": "workspace",
                        "key": other,
                        "value": find_collection(db_path, collection_id.trim())?,
                    })),
                    _ => Err(Error::new(
                        Status::InvalidArg,
                        format!(
                            "Unknown workspace key \"{other}\"; available keys: directories, collections, collection:<collectionId>"
                        ),
                    )),
                },
            }
        }
        TOOL_SET => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if key != COLLECTIONS_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "workspace only supports writing key \"{COLLECTIONS_KEY}\", or key \"{DIRECTORIES_KEY}\" with value={{action:\"create\", name, parentPath?}} to create a project; project delete/relocate stays in the UI"
                    ),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for action=set".to_string(),
                )
            })?;
            apply_collection_action(db_path, &value)
        }
        TOOL_DELETE => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let Some(collection_id) = key.strip_prefix(COLLECTION_KEY_PREFIX) else {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "workspace delete requires key=\"collection:<collectionId>\"; \"{key}\" cannot be deleted here"
                    ),
                ));
            };
            let collection_id = collection_id.trim();
            if collection_id.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "collection:<collectionId> requires a non-empty collection id".to_string(),
                ));
            }
            // 先确认存在，避免"删了个不存在的东西却返回成功"。
            let existing = find_collection(db_path, collection_id)?;
            let removed_members = existing
                .get("memberDirectoryIds")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            delete_project_collection(db_path, collection_id)?;
            Ok(json!({
                "scope": "workspace",
                "key": key,
                "deleted": true,
                "removedMemberCount": removed_members,
                "value": collections_view(db_path)?,
            }))
        }
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope workspace: {other}"),
        )),
    }
}
