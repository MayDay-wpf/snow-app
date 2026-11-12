//! 团队协作数据层（数据库版，不依赖 Git）。
//!
//! 团队、团队与项目的关联、成员、通用记录（消息 / 任务 / 议题 / 笔记）与
//! 附件全部存放在应用数据库中；队长设备承载 WebSocket 服务，队员凭邀请码
//! 加入。本模块只负责数据读写，网络编排见 `crate::team`。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use snow_storage_core::database;

mod knowledge_skill;
mod legacy_import;

pub use knowledge_skill::sync_knowledge_skill;
pub use legacy_import::{import_legacy_team_data, legacy_team_data_exists};

/// 团队协作总开关的系统设置 code（DB 持久化）。默认关闭，显式写入 "1" 才启用。
pub const TEAM_ENABLED_SETTING: &str = "team_collaboration_enabled";

/// 团队协作是否启用：未写入或非 "1" 一律视为关闭。
pub fn is_team_enabled() -> bool {
    let Ok(database_path) = snow_storage_core::bootstrap::ensure_database_file() else {
        return false;
    };
    snow_storage_core::system_settings::get_system_setting_value(
        &database_path,
        TEAM_ENABLED_SETTING,
    )
    .ok()
    .flatten()
    .map(|value| value == "1")
    .unwrap_or(false)
}

/// 记录类型：消息 / 任务 / 议题 / 笔记（review 仅为旧版评审数据兼容保留）。
pub const RECORD_KINDS: [&str; 5] = ["message", "task", "topic", "note", "review"];

/// 记录类型合法性校验（协议层与数据层共用）。
pub fn is_record_kind(kind: &str) -> bool {
    RECORD_KINDS.contains(&kind)
}

/// 成员角色：队长 / 队员。
pub const ROLE_HOST: &str = "host";
pub const ROLE_MEMBER: &str = "member";

// ===== 数据模型（serde，camelCase 与渲染层契约一致） =====

/// 本机所参与的团队。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInfo {
    pub team_id: String,
    pub name: String,
    /// 本机在该团队中的角色：host | member。
    pub role: String,
    /// 邀请码（仅队长持有有效值，队员保存队长下发的码以便重连）。
    pub invite_code: String,
    pub host_peer_id: String,
    pub host_name: String,
    /// 队长可连地址（局域网 `host:port` 或公网入口），由网络层写入。
    pub host_endpoint: String,
    pub self_peer_id: String,
    pub self_name: String,
    pub self_color: String,
    /// 队长模式：是否注册系统级常驻服务（关掉窗口后仍保持在线）。
    pub host_service: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 团队与本地项目的关联（一个团队可关联多个项目）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamProjectLink {
    pub team_id: String,
    pub directory_id: String,
    pub name: String,
}

/// 团队成员。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberRecord {
    pub peer_id: String,
    pub name: String,
    pub color: String,
    pub role: String,
    pub online: bool,
    pub joined_at: String,
    pub last_seen: String,
}

/// 通用记录：payload 为渲染层定义的 JSON 文本。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRecord {
    pub kind: String,
    pub record_id: String,
    pub payload: String,
    pub updated_at: String,
}

/// 团队全量快照：首次加入或队员重连时用于对齐数据。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSnapshot {
    pub team: TeamInfo,
    pub projects: Vec<TeamProjectLink>,
    pub members: Vec<TeamMemberRecord>,
    pub records: Vec<TeamRecord>,
}

/// 附件元数据（内容单独存放于 `team_media.content`）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMediaMeta {
    pub media_id: String,
    pub owner_id: String,
    pub file_name: String,
    pub is_image: bool,
    pub size: i64,
}

// ===== 通用工具 =====

fn with_connection<T>(
    database_path: &Path,
    action: &str,
    run: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T> {
    database::open_connection(database_path)
        .and_then(|connection| run(&connection))
        .map_err(|error| database::database_error(database_path, action, error))
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..20]
    )
}

fn generate_invite_code() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_uppercase()
}

/// 生成成员重连令牌（加入审核通过后由队长下发，队员凭它免审核重连）。
pub fn generate_member_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn row_to_team(row: &Row<'_>) -> rusqlite::Result<TeamInfo> {
    Ok(TeamInfo {
        team_id: row.get("team_id")?,
        name: row.get("name")?,
        role: row.get("role")?,
        invite_code: row.get("invite_code")?,
        host_peer_id: row.get("host_peer_id")?,
        host_name: row.get("host_name")?,
        host_endpoint: row.get("host_endpoint")?,
        self_peer_id: row.get("self_peer_id")?,
        self_name: row.get("self_name")?,
        self_color: row.get("self_color")?,
        host_service: row.get::<_, i64>("host_service")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const TEAM_COLUMNS: &str = "team_id, name, role, invite_code, host_peer_id, host_name, \
     host_endpoint, self_peer_id, self_name, self_color, host_service, created_at, updated_at";

// ===== 团队 =====

/// 列出本机参与的全部团队。
pub fn list_teams(database_path: &Path) -> Result<Vec<TeamInfo>> {
    with_connection(database_path, "list teams", |connection| {
        let mut statement = connection.prepare(&format!(
            "SELECT {TEAM_COLUMNS} FROM teams ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = statement.query_map([], row_to_team)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
}

/// 读取单个团队。
pub fn get_team(database_path: &Path, team_id: &str) -> Result<Option<TeamInfo>> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "get team", move |connection| {
        connection
            .query_row(
                &format!("SELECT {TEAM_COLUMNS} FROM teams WHERE team_id = ?1"),
                params![team_id],
                row_to_team,
            )
            .optional()
    })
}

/// 按邀请码定位团队（队员加入时校验）。
pub fn get_team_by_invite_code(
    database_path: &Path,
    invite_code: &str,
) -> Result<Option<TeamInfo>> {
    let invite_code = invite_code.trim().to_uppercase();
    with_connection(database_path, "find team by invite code", move |connection| {
        connection
            .query_row(
                &format!("SELECT {TEAM_COLUMNS} FROM teams WHERE invite_code = ?1"),
                params![invite_code],
                row_to_team,
            )
            .optional()
    })
}

/// 定位某个项目（工作区目录）所属的团队。
///
/// 一个项目在本地只应关联一个团队（见 `link_project`）；历史数据存在多条关联时
/// 以最后建立的关联为准（`rowid` 是插入顺序，避免混合时间格式影响比较）。
pub fn find_team_for_directory(
    database_path: &Path,
    directory_id: &str,
) -> Result<Option<TeamInfo>> {
    let directory_id = directory_id.trim().to_string();
    with_connection(database_path, "find team for directory", move |connection| {
        connection
            .query_row(
                &format!(
                    "SELECT {} FROM teams t
                       JOIN team_projects p ON p.team_id = t.team_id
                      WHERE p.directory_id = ?1
                      ORDER BY p.rowid DESC
                      LIMIT 1",
                    TEAM_COLUMNS
                        .split(',')
                        .map(|column| format!("t.{}", column.trim()))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                params![directory_id],
                row_to_team,
            )
            .optional()
    })
}

/// 创建团队：本机为队长，生成团队 id、本机 peer id 与邀请码。
///
/// 队长也是团队成员（一台设备只代表一个人），创建时即写入队长成员记录，
/// `host_client_id` 为本机设备标识，供后续按设备复用身份。
pub fn create_team(
    database_path: &Path,
    name: &str,
    self_name: &str,
    self_color: &str,
    host_client_id: &str,
) -> Result<TeamInfo> {
    let name = name.trim().to_string();
    let self_name = self_name.trim().to_string();
    let self_color = self_color.trim().to_string();
    let host_client_id = host_client_id.trim().to_string();
    with_connection(database_path, "create team", move |connection| {
        let team_id = new_id("team");
        let peer_id = new_id("peer");
        let invite_code = generate_invite_code();
        let now = now_rfc3339();
        connection.execute(
            "INSERT INTO teams (
                id, team_id, name, role, invite_code, host_peer_id, host_name,
                host_endpoint, self_peer_id, self_name, self_color, host_service,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, 0, ?11, ?11)",
            params![
                new_id("t"),
                team_id,
                name,
                ROLE_HOST,
                invite_code,
                peer_id,
                self_name,
                peer_id,
                self_name,
                self_color,
                now,
            ],
        )?;
        let host_member = TeamMemberRecord {
            peer_id: peer_id.clone(),
            name: self_name.clone(),
            color: self_color.clone(),
            role: ROLE_HOST.to_string(),
            online: true,
            joined_at: String::new(),
            last_seen: String::new(),
        };
        upsert_member_with_connection(
            connection,
            &team_id,
            &host_member,
            &host_client_id,
            "",
        )?;
        connection
            .query_row(
                &format!("SELECT {TEAM_COLUMNS} FROM teams WHERE team_id = ?1"),
                params![team_id],
                row_to_team,
            )
            .optional()?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    })
}

/// 队员加入团队：用队长下发的快照写入团队、成员与记录，并把本机项目关联到团队。
/// `peer_id` 由队长分配（重连时沿用本地已有值）；`member_token` 为队长下发
/// 的重连令牌（空字符串表示沿用本地已有值）。
///
/// 项目关联是本机概念（`directory_id` 只在本机有意义），因此只关联调用方传入
/// 的本地项目，不导入队长快照里的项目；同一项目由 `link_project` 保证只属于
/// 一个团队。
pub fn join_team(
    database_path: &Path,
    snapshot: &TeamSnapshot,
    peer_id: &str,
    self_name: &str,
    self_color: &str,
    member_token: &str,
    project_directory_id: &str,
    project_name: &str,
) -> Result<TeamInfo> {
    let snapshot = snapshot.clone();
    let peer_id = peer_id.trim().to_string();
    let self_name = self_name.trim().to_string();
    let self_color = self_color.trim().to_string();
    let member_token = member_token.trim().to_string();
    let project_directory_id = project_directory_id.trim().to_string();
    let project_name = project_name.trim().to_string();
    with_connection(database_path, "join team", move |connection| {
        let team_id = snapshot.team.team_id.clone();
        let peer_id = if peer_id.is_empty() {
            new_id("peer")
        } else {
            peer_id
        };
        let now = now_rfc3339();
        connection.execute(
            "INSERT INTO teams (
                id, team_id, name, role, invite_code, host_peer_id, host_name,
                host_endpoint, self_peer_id, self_name, self_color, host_service,
                member_token, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?13)
             ON CONFLICT(team_id) DO UPDATE SET
                name = excluded.name,
                role = excluded.role,
                invite_code = excluded.invite_code,
                host_peer_id = excluded.host_peer_id,
                host_name = excluded.host_name,
                host_endpoint = excluded.host_endpoint,
                self_name = excluded.self_name,
                self_color = excluded.self_color,
                member_token = CASE
                    WHEN excluded.member_token = '' THEN teams.member_token
                    ELSE excluded.member_token
                END,
                updated_at = excluded.updated_at",
            params![
                new_id("t"),
                team_id,
                snapshot.team.name,
                ROLE_MEMBER,
                snapshot.team.invite_code,
                snapshot.team.host_peer_id,
                snapshot.team.host_name,
                snapshot.team.host_endpoint,
                peer_id,
                self_name,
                self_color,
                member_token,
                now,
            ],
        )?;
        replace_members_with_connection(connection, &team_id, &snapshot.members)?;
        replace_records_with_connection(connection, &team_id, &snapshot.records)?;
        if !project_directory_id.is_empty() {
            link_project_with_connection(
                connection,
                &team_id,
                &project_directory_id,
                &project_name,
            )?;
        }
        connection
            .query_row(
                &format!("SELECT {TEAM_COLUMNS} FROM teams WHERE team_id = ?1"),
                params![team_id],
                row_to_team,
            )
            .optional()?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    })
}

/// 更新本机昵称与头像色（会同步刷新成员记录中的自己）。
pub fn update_team_profile(
    database_path: &Path,
    team_id: &str,
    self_name: &str,
    self_color: &str,
) -> Result<TeamInfo> {
    let team_id = team_id.trim().to_string();
    let self_name = self_name.trim().to_string();
    let self_color = self_color.trim().to_string();
    with_connection(database_path, "update team profile", move |connection| {
        let now = now_rfc3339();
        connection.execute(
            "UPDATE teams SET self_name = ?1, self_color = ?2, updated_at = ?3
              WHERE team_id = ?4",
            params![self_name, self_color, now, team_id],
        )?;
        connection.execute(
            "UPDATE team_members SET name = ?1, color = ?2
              WHERE team_id = ?3 AND peer_id = (SELECT self_peer_id FROM teams WHERE team_id = ?3)",
            params![self_name, self_color, team_id],
        )?;
        connection
            .query_row(
                &format!("SELECT {TEAM_COLUMNS} FROM teams WHERE team_id = ?1"),
                params![team_id],
                row_to_team,
            )
            .optional()?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    })
}

/// 重新生成邀请码（旧邀请链接立即失效；已加入成员凭重连令牌继续在线）。
pub fn reset_invite_code(database_path: &Path, team_id: &str) -> Result<TeamInfo> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "reset team invite code", move |connection| {
        let invite_code = generate_invite_code();
        connection.execute(
            "UPDATE teams SET invite_code = ?1, updated_at = ?2 WHERE team_id = ?3",
            params![invite_code, now_rfc3339(), team_id],
        )?;
        connection
            .query_row(
                &format!("SELECT {TEAM_COLUMNS} FROM teams WHERE team_id = ?1"),
                params![team_id],
                row_to_team,
            )
            .optional()?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    })
}

/// 读取本机（队员）在该团队中的重连令牌；未加入或未下发时返回空字符串。
pub fn get_member_token(database_path: &Path, team_id: &str) -> Result<String> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "get team member token", move |connection| {
        connection
            .query_row(
                "SELECT member_token FROM teams WHERE team_id = ?1",
                params![team_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.unwrap_or_default())
    })
}

/// 写入队长对外可连地址（网络层启动服务后调用）。
pub fn update_team_host_endpoint(
    database_path: &Path,
    team_id: &str,
    endpoint: &str,
) -> Result<()> {
    let team_id = team_id.trim().to_string();
    let endpoint = endpoint.trim().to_string();
    with_connection(database_path, "update host endpoint", move |connection| {
        connection.execute(
            "UPDATE teams SET host_endpoint = ?1, updated_at = ?2 WHERE team_id = ?3",
            params![endpoint, now_rfc3339(), team_id],
        )?;
        Ok(())
    })
}

/// 切换队长常驻服务开关。
pub fn set_host_service(database_path: &Path, team_id: &str, enabled: bool) -> Result<()> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "set host service", move |connection| {
        connection.execute(
            "UPDATE teams SET host_service = ?1, updated_at = ?2 WHERE team_id = ?3",
            params![if enabled { 1 } else { 0 }, now_rfc3339(), team_id],
        )?;
        Ok(())
    })
}

/// 退出并删除团队（连带项目关联、成员、记录与附件）。
pub fn delete_team(database_path: &Path, team_id: &str) -> Result<bool> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "delete team", move |connection| {
        let removed = connection.execute("DELETE FROM teams WHERE team_id = ?1", params![team_id])?;
        connection.execute("DELETE FROM team_projects WHERE team_id = ?1", params![team_id])?;
        connection.execute("DELETE FROM team_members WHERE team_id = ?1", params![team_id])?;
        connection.execute("DELETE FROM team_records WHERE team_id = ?1", params![team_id])?;
        connection.execute("DELETE FROM team_media WHERE team_id = ?1", params![team_id])?;
        Ok(removed > 0)
    })
}

// ===== 团队与项目关联 =====

/// 列出团队关联的全部项目。
pub fn list_team_projects(database_path: &Path, team_id: &str) -> Result<Vec<TeamProjectLink>> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "list team projects", move |connection| {
        let mut statement = connection.prepare(
            "SELECT team_id, directory_id, name FROM team_projects
              WHERE team_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![team_id], |row| {
            Ok(TeamProjectLink {
                team_id: row.get(0)?,
                directory_id: row.get(1)?,
                name: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
}

/// 关联一个本地项目到团队（同项目重复关联时更新名称）。
///
/// 一个项目同一时间只属于一个团队：先删除该项目与其它团队的关联，再写入本团队，
/// 避免同一项目解析出多个团队、进而显示错误的队长/成员身份。
pub fn link_project(
    database_path: &Path,
    team_id: &str,
    directory_id: &str,
    name: &str,
) -> Result<()> {
    let team_id = team_id.trim().to_string();
    let directory_id = directory_id.trim().to_string();
    let name = name.trim().to_string();
    with_connection(database_path, "link team project", move |connection| {
        link_project_with_connection(connection, &team_id, &directory_id, &name)
    })
}

fn link_project_with_connection(
    connection: &Connection,
    team_id: &str,
    directory_id: &str,
    name: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM team_projects WHERE directory_id = ?1 AND team_id <> ?2",
        params![directory_id, team_id],
    )?;
    connection.execute(
        "INSERT INTO team_projects (id, team_id, directory_id, name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(team_id, directory_id) DO UPDATE SET name = excluded.name",
        params![new_id("tp"), team_id, directory_id, name, now_rfc3339()],
    )?;
    Ok(())
}

/// 解除项目与团队的关联。
pub fn unlink_project(database_path: &Path, team_id: &str, directory_id: &str) -> Result<bool> {
    let team_id = team_id.trim().to_string();
    let directory_id = directory_id.trim().to_string();
    with_connection(database_path, "unlink team project", move |connection| {
        let removed = connection.execute(
            "DELETE FROM team_projects WHERE team_id = ?1 AND directory_id = ?2",
            params![team_id, directory_id],
        )?;
        Ok(removed > 0)
    })
}

// ===== 成员 =====

/// 列出团队成员。
pub fn list_members(database_path: &Path, team_id: &str) -> Result<Vec<TeamMemberRecord>> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "list team members", move |connection| {
        let mut statement = connection.prepare(
            "SELECT peer_id, name, color, role, online, joined_at, last_seen
               FROM team_members WHERE team_id = ?1 ORDER BY joined_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![team_id], |row| {
            Ok(TeamMemberRecord {
                peer_id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                role: row.get(3)?,
                online: row.get::<_, i64>(4)? != 0,
                joined_at: row.get(5)?,
                last_seen: row.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
}

/// 写入或更新一个成员（在线状态与心跳时间由调用方给出）。
/// `client_id` 为设备标识（黑名单依据），`token` 为重连令牌；空值不会覆盖已有值。
pub fn upsert_member(
    database_path: &Path,
    team_id: &str,
    member: &TeamMemberRecord,
    client_id: &str,
    token: &str,
) -> Result<TeamMemberRecord> {
    let team_id = team_id.trim().to_string();
    let member = member.clone();
    let client_id = client_id.trim().to_string();
    let token = token.trim().to_string();
    with_connection(database_path, "upsert team member", move |connection| {
        upsert_member_with_connection(connection, &team_id, &member, &client_id, &token)?;
        Ok(member)
    })
}

fn upsert_member_with_connection(
    connection: &Connection,
    team_id: &str,
    member: &TeamMemberRecord,
    client_id: &str,
    token: &str,
) -> rusqlite::Result<()> {
    let now = now_rfc3339();
    let joined_at = if member.joined_at.trim().is_empty() {
        now.clone()
    } else {
        member.joined_at.clone()
    };
    let last_seen = if member.last_seen.trim().is_empty() {
        now
    } else {
        member.last_seen.clone()
    };
    connection.execute(
        "INSERT INTO team_members (
            id, team_id, peer_id, name, color, role, online, joined_at, last_seen,
            client_id, token
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(team_id, peer_id) DO UPDATE SET
            name = excluded.name,
            color = excluded.color,
            role = excluded.role,
            online = excluded.online,
            last_seen = excluded.last_seen,
            client_id = CASE
                WHEN excluded.client_id = '' THEN team_members.client_id
                ELSE excluded.client_id
            END,
            token = CASE
                WHEN excluded.token = '' THEN team_members.token
                ELSE excluded.token
            END",
        params![
            new_id("tm"),
            team_id,
            member.peer_id,
            member.name,
            member.color,
            member.role,
            if member.online { 1 } else { 0 },
            joined_at,
            last_seen,
            client_id,
            token,
        ],
    )?;
    Ok(())
}

/// 用队长快照中的成员列表整体替换本地成员（队员首次加入时使用）。
pub fn replace_members(
    database_path: &Path,
    team_id: &str,
    members: &[TeamMemberRecord],
) -> Result<()> {
    let team_id = team_id.trim().to_string();
    let members = members.to_vec();
    with_connection(database_path, "replace team members", move |connection| {
        replace_members_with_connection(connection, &team_id, &members)
    })
}

fn replace_members_with_connection(
    connection: &Connection,
    team_id: &str,
    members: &[TeamMemberRecord],
) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM team_members WHERE team_id = ?1", params![team_id])?;
    for member in members {
        upsert_member_with_connection(connection, team_id, member, "", "")?;
    }
    Ok(())
}

/// 移除成员（队长踢人或队员主动离开）。
pub fn delete_member(database_path: &Path, team_id: &str, peer_id: &str) -> Result<bool> {
    let team_id = team_id.trim().to_string();
    let peer_id = peer_id.trim().to_string();
    with_connection(database_path, "delete team member", move |connection| {
        let removed = connection.execute(
            "DELETE FROM team_members WHERE team_id = ?1 AND peer_id = ?2",
            params![team_id, peer_id],
        )?;
        Ok(removed > 0)
    })
}

/// 连接断开时标记成员离线：只更新已有记录，已被移除的成员不会被重新写回。
pub fn set_member_offline(database_path: &Path, team_id: &str, peer_id: &str) -> Result<()> {
    let team_id = team_id.trim().to_string();
    let peer_id = peer_id.trim().to_string();
    with_connection(database_path, "mark team member offline", move |connection| {
        connection.execute(
            "UPDATE team_members SET online = 0, last_seen = ?1
              WHERE team_id = ?2 AND peer_id = ?3",
            params![now_rfc3339(), team_id, peer_id],
        )?;
        Ok(())
    })
}

/// 按重连令牌查找成员，返回 `(team_id, 成员记录)`（队员免审核重连时使用）。
pub fn find_member_by_token(
    database_path: &Path,
    token: &str,
) -> Result<Option<(String, TeamMemberRecord)>> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Ok(None);
    }
    with_connection(database_path, "find team member by token", move |connection| {
        connection
            .query_row(
                "SELECT team_id, peer_id, name, color, role, online, joined_at, last_seen
                   FROM team_members WHERE token = ?1",
                params![token],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        TeamMemberRecord {
                            peer_id: row.get(1)?,
                            name: row.get(2)?,
                            color: row.get(3)?,
                            role: row.get(4)?,
                            online: row.get::<_, i64>(5)? != 0,
                            joined_at: row.get(6)?,
                            last_seen: row.get(7)?,
                        },
                    ))
                },
            )
            .optional()
    })
}

/// 按设备标识查找已存在的成员（一台设备只代表一个人：再次加入沿用原身份，
/// 不再插入重复成员记录）。
pub fn find_member_by_client_id(
    database_path: &Path,
    team_id: &str,
    client_id: &str,
) -> Result<Option<TeamMemberRecord>> {
    let team_id = team_id.trim().to_string();
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Ok(None);
    }
    with_connection(database_path, "find team member by client id", move |connection| {
        connection
            .query_row(
                "SELECT peer_id, name, color, role, online, joined_at, last_seen
                   FROM team_members
                  WHERE team_id = ?1 AND client_id = ?2
                  ORDER BY rowid ASC
                  LIMIT 1",
                params![team_id, client_id],
                |row| {
                    Ok(TeamMemberRecord {
                        peer_id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                        role: row.get(3)?,
                        online: row.get::<_, i64>(4)? != 0,
                        joined_at: row.get(5)?,
                        last_seen: row.get(6)?,
                    })
                },
            )
            .optional()
    })
}

/// 读取成员的设备标识（队长拉黑成员时使用）。
pub fn member_client_id(
    database_path: &Path,
    team_id: &str,
    peer_id: &str,
) -> Result<Option<String>> {
    let team_id = team_id.trim().to_string();
    let peer_id = peer_id.trim().to_string();
    with_connection(database_path, "read team member client id", move |connection| {
        connection
            .query_row(
                "SELECT client_id FROM team_members WHERE team_id = ?1 AND peer_id = ?2",
                params![team_id, peer_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
    })
}

// ===== 黑名单 =====

/// 被队长拉黑的设备。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamBlockedMember {
    pub client_id: String,
    pub name: String,
    pub blocked_at: String,
}

/// 该设备是否已被队长拉黑。
pub fn is_blocked(database_path: &Path, team_id: &str, client_id: &str) -> Result<bool> {
    let team_id = team_id.trim().to_string();
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Ok(false);
    }
    with_connection(database_path, "check team blocklist", move |connection| {
        let found = connection
            .query_row(
                "SELECT 1 FROM team_blocklist WHERE team_id = ?1 AND client_id = ?2",
                params![team_id, client_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(found.is_some())
    })
}

/// 列出团队黑名单。
pub fn list_blocklist(database_path: &Path, team_id: &str) -> Result<Vec<TeamBlockedMember>> {
    let team_id = team_id.trim().to_string();
    with_connection(database_path, "list team blocklist", move |connection| {
        let mut statement = connection.prepare(
            "SELECT client_id, name, created_at FROM team_blocklist
              WHERE team_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![team_id], |row| {
            Ok(TeamBlockedMember {
                client_id: row.get(0)?,
                name: row.get(1)?,
                blocked_at: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
}

/// 把设备加入黑名单（重复拉黑时更新昵称）。
pub fn add_blocklist_entry(
    database_path: &Path,
    team_id: &str,
    client_id: &str,
    name: &str,
) -> Result<()> {
    let team_id = team_id.trim().to_string();
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(Error::from_reason("该成员缺少设备标识，无法拉黑"));
    }
    let name = name.trim().to_string();
    with_connection(database_path, "add team blocklist entry", move |connection| {
        connection.execute(
            "INSERT INTO team_blocklist (id, team_id, client_id, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(team_id, client_id) DO UPDATE SET name = excluded.name",
            params![new_id("tb"), team_id, client_id, name, now_rfc3339()],
        )?;
        Ok(())
    })
}

/// 解除对某个设备的拉黑。
pub fn remove_blocklist_entry(
    database_path: &Path,
    team_id: &str,
    client_id: &str,
) -> Result<bool> {
    let team_id = team_id.trim().to_string();
    let client_id = client_id.trim().to_string();
    with_connection(database_path, "remove team blocklist entry", move |connection| {
        let removed = connection.execute(
            "DELETE FROM team_blocklist WHERE team_id = ?1 AND client_id = ?2",
            params![team_id, client_id],
        )?;
        Ok(removed > 0)
    })
}

// ===== 通用记录 =====

/// 列出某类记录，返回原始 JSON 文本数组（按更新时间升序）。
pub fn list_records(database_path: &Path, team_id: &str, kind: &str) -> Result<Vec<String>> {
    if !is_record_kind(kind) {
        return Err(Error::from_reason(format!("invalid record kind: {kind}")));
    }
    let team_id = team_id.trim().to_string();
    let kind = kind.trim().to_string();
    with_connection(database_path, "list team records", move |connection| {
        let mut statement = connection.prepare(
            "SELECT payload FROM team_records
              WHERE team_id = ?1 AND kind = ?2 ORDER BY updated_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![team_id, kind], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
}

/// 写入或更新一条记录，返回落库后的原始 JSON。
pub fn upsert_record(
    database_path: &Path,
    team_id: &str,
    kind: &str,
    record_id: &str,
    payload: &str,
) -> Result<String> {
    if !is_record_kind(kind) {
        return Err(Error::from_reason(format!("invalid record kind: {kind}")));
    }
    let record_id = record_id.trim().to_string();
    if record_id.is_empty() {
        return Err(Error::from_reason("record id is required"));
    }
    if serde_json::from_str::<serde_json::Value>(payload).is_err() {
        return Err(Error::from_reason("record payload must be valid JSON"));
    }
    let team_id = team_id.trim().to_string();
    let kind = kind.trim().to_string();
    let payload = payload.to_string();
    with_connection(database_path, "upsert team record", move |connection| {
        upsert_record_with_connection(connection, &team_id, &kind, &record_id, &payload)?;
        Ok(payload)
    })
}

fn upsert_record_with_connection(
    connection: &Connection,
    team_id: &str,
    kind: &str,
    record_id: &str,
    payload: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO team_records (id, team_id, kind, record_id, payload, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(team_id, kind, record_id) DO UPDATE SET
            payload = excluded.payload,
            updated_at = excluded.updated_at",
        params![
            new_id("tr"),
            team_id,
            kind,
            record_id,
            payload,
            now_rfc3339()
        ],
    )?;
    Ok(())
}

/// 删除一条记录。
pub fn delete_record(
    database_path: &Path,
    team_id: &str,
    kind: &str,
    record_id: &str,
) -> Result<bool> {
    if !is_record_kind(kind) {
        return Err(Error::from_reason(format!("invalid record kind: {kind}")));
    }
    let team_id = team_id.trim().to_string();
    let kind = kind.trim().to_string();
    let record_id = record_id.trim().to_string();
    with_connection(database_path, "delete team record", move |connection| {
        let removed = connection.execute(
            "DELETE FROM team_records WHERE team_id = ?1 AND kind = ?2 AND record_id = ?3",
            params![team_id, kind, record_id],
        )?;
        Ok(removed > 0)
    })
}

/// 用快照中的记录整体替换本地记录（队员首次加入时使用）。
fn replace_records_with_connection(
    connection: &Connection,
    team_id: &str,
    records: &[TeamRecord],
) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM team_records WHERE team_id = ?1", params![team_id])?;
    for record in records {
        upsert_record_with_connection(
            connection,
            team_id,
            &record.kind,
            &record.record_id,
            &record.payload,
        )?;
    }
    Ok(())
}

// ===== 附件 =====

/// 附件大小上限（与旧实现一致：5 MB）。
pub const MEDIA_MAX_BYTES: usize = 5 * 1024 * 1024;

/// 保存附件内容，返回附件 id。
///
/// `media_id` 由发送方指定以保证全团队 id 一致（消息记录里引用的就是它）；
/// 为空时本地生成。
#[allow(clippy::too_many_arguments)]
pub fn save_media(
    database_path: &Path,
    team_id: &str,
    media_id: &str,
    owner_id: &str,
    file_name: &str,
    is_image: bool,
    bytes: &[u8],
) -> Result<String> {
    let team_id = team_id.trim().to_string();
    let owner_id = owner_id.trim().to_string();
    let file_name = file_name.trim().to_string();
    let bytes = bytes.to_vec();
    let requested_id = media_id.trim().to_string();
    with_connection(database_path, "save team media", move |connection| {
        let media_id = if requested_id.is_empty() {
            new_id("media")
        } else {
            requested_id
        };
        connection.execute(
            "INSERT INTO team_media (
                id, team_id, media_id, owner_id, file_name, is_image, size, content, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(team_id, media_id) DO UPDATE SET
                owner_id = excluded.owner_id,
                file_name = excluded.file_name,
                is_image = excluded.is_image,
                size = excluded.size,
                content = excluded.content",
            params![
                new_id("tmd"),
                team_id,
                media_id,
                owner_id,
                file_name,
                if is_image { 1 } else { 0 },
                bytes.len() as i64,
                bytes,
                now_rfc3339()
            ],
        )?;
        Ok(media_id)
    })
}

/// 读取附件元数据与内容。
pub fn read_media(
    database_path: &Path,
    team_id: &str,
    media_id: &str,
) -> Result<Option<(TeamMediaMeta, Vec<u8>)>> {
    let team_id = team_id.trim().to_string();
    let media_id = media_id.trim().to_string();
    with_connection(database_path, "read team media", move |connection| {
        connection
            .query_row(
                "SELECT media_id, owner_id, file_name, is_image, size, content
                   FROM team_media WHERE team_id = ?1 AND media_id = ?2",
                params![team_id, media_id],
                |row| {
                    Ok((
                        TeamMediaMeta {
                            media_id: row.get(0)?,
                            owner_id: row.get(1)?,
                            file_name: row.get(2)?,
                            is_image: row.get::<_, i64>(3)? != 0,
                            size: row.get(4)?,
                        },
                        row.get::<_, Option<Vec<u8>>>(5)?.unwrap_or_default(),
                    ))
                },
            )
            .optional()
    })
}

/// 删除某条记录（消息 / 笔记）名下的全部附件。
pub fn delete_media(database_path: &Path, team_id: &str, owner_id: &str) -> Result<bool> {
    let team_id = team_id.trim().to_string();
    let owner_id = owner_id.trim().to_string();
    with_connection(database_path, "delete team media", move |connection| {
        let removed = connection.execute(
            "DELETE FROM team_media WHERE team_id = ?1 AND owner_id = ?2",
            params![team_id, owner_id],
        )?;
        Ok(removed > 0)
    })
}

// ===== 快照 =====

/// 读取团队全量快照（队长在队员加入 / 重连时下发）。
pub fn team_snapshot(database_path: &Path, team_id: &str) -> Result<Option<TeamSnapshot>> {
    let team_id = team_id.trim().to_string();
    let team = match get_team(database_path, &team_id)? {
        Some(team) => team,
        None => return Ok(None),
    };
    let projects = list_team_projects(database_path, &team_id)?;
    let members = list_members(database_path, &team_id)?;
    let records = with_connection(database_path, "list all team records", {
        let team_id = team_id.clone();
        move |connection| {
            let mut statement = connection.prepare(
                "SELECT kind, record_id, payload, updated_at FROM team_records
                  WHERE team_id = ?1 ORDER BY updated_at ASC, id ASC",
            )?;
            let rows = statement.query_map(params![team_id], |row| {
                Ok(TeamRecord {
                    kind: row.get(0)?,
                    record_id: row.get(1)?,
                    payload: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        }
    })?;
    Ok(Some(TeamSnapshot {
        team,
        projects,
        members,
        records,
    }))
}
