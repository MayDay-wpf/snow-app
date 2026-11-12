//! 团队 WebSocket 协议（JSON 文本帧）。
//!
//! 队长设备的 Rust 服务与队员客户端使用同一套消息定义：队员凭邀请码握手，
//! 队长回传团队快照，此后双方以记录级增量（新增 / 更新 / 删除）保持同步。

use serde::{Deserialize, Serialize};

use crate::store::{
    TeamInfo, TeamMemberRecord, TeamProjectLink, TeamRecord,
};

/// 当前协议版本；双方不一致时队长拒绝握手并提示升级。
/// 2：加入审核（邀请码 → 队长审批）、成员重连令牌与黑名单。
pub const PROTOCOL_VERSION: u32 = 2;

/// 客户端 → 服务端。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    /// 握手：携带邀请码（首次加入）、重连令牌（已加入成员）与本机昵称 / 头像色。
    Hello {
        #[serde(default)]
        protocol: u32,
        #[serde(default)]
        invite_code: String,
        /// 本机设备标识：队长按它做黑名单判定。
        #[serde(default)]
        client_id: String,
        /// 重连令牌：非空时免审核直接恢复成员身份。
        #[serde(default)]
        token: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        color: String,
    },
    /// 主动请求全量快照（重连后对齐数据）。
    SnapshotRequest,
    /// 新增或更新一条记录。
    RecordUpsert {
        kind: String,
        record_id: String,
        payload: String,
    },
    /// 删除一条记录。
    RecordDelete { kind: String, record_id: String },
    /// 上传附件（`data` 为 base64）。
    ///
    /// `media_id` 由发送方生成：队长必须按同一个 id 落库，否则消息记录里
    /// 引用的附件 id 在队长侧查不到（图片会一直 loading）。
    MediaUpload {
        owner_id: String,
        #[serde(default)]
        media_id: String,
        file_name: String,
        #[serde(default)]
        is_image: bool,
        data: String,
    },
    /// 请求附件内容（base64 回传）。
    MediaRequest { media_id: String },
    /// 心跳。
    Ping,
}

/// 服务端 → 客户端。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    /// 握手成功：分配本机 peer id 并附带团队快照。
    /// `token` 为队长下发的重连令牌（队员保存后免审核重连）。
    Welcome {
        team: TeamInfo,
        peer_id: String,
        #[serde(default)]
        token: String,
        projects: Vec<TeamProjectLink>,
        members: Vec<TeamMemberRecord>,
        records: Vec<TeamRecord>,
    },
    /// 加入申请已提交，等待队长审核（连接保持，审核结果随后送达）。
    JoinPending { request_id: String },
    /// 加入申请被拒绝（被队长拒绝或已被拉黑）：客户端应停止重连。
    JoinRejected { message: String },
    /// 全量快照（响应 SnapshotRequest）。
    Snapshot {
        team: TeamInfo,
        projects: Vec<TeamProjectLink>,
        members: Vec<TeamMemberRecord>,
        records: Vec<TeamRecord>,
    },
    /// 某条记录被新增或更新（含来自其他队员的改动）。
    RecordUpserted {
        kind: String,
        record_id: String,
        payload: String,
    },
    /// 某条记录被删除。
    RecordDeleted { kind: String, record_id: String },
    /// 成员列表变化（在线状态或成员增减）。
    Members { members: Vec<TeamMemberRecord> },
    /// 附件上传成功回执。
    MediaUploaded { owner_id: String, media_id: String },
    /// 附件内容回执。
    Media {
        owner_id: String,
        media_id: String,
        file_name: String,
        is_image: bool,
        data: String,
    },
    /// 队长侧也没有该附件：队员应立即失败，不必等到超时。
    MediaMissing { media_id: String },
    /// 错误提示（不断开连接，除非错误致命）。
    Error { message: String },
    /// 已被队长移出团队：客户端应停止重连并清理本地团队数据。
    Removed { message: String },
    /// 心跳回执。
    Pong,
}
