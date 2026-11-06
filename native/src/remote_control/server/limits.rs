//! 远控接口的输入上限与固定常量。

use std::time::Duration;

/// 请求体上限（JSON 接口）。
pub(super) const MAX_BODY_BYTES: usize = 64 * 1024;
/// 局域网令牌 Cookie 与请求头名称。
pub(super) const COOKIE_NAME: &str = "snowRemoteToken";
/// 公网会话 Cookie 名称。
pub(super) const WAN_COOKIE_NAME: &str = "snowRemoteSession";
pub(super) const TOKEN_HEADER: &str = "x-snow-remote-token";
/// 会话图片允许的最大字节数（与手机端上传通道一致）。
pub(super) const MAX_MESSAGE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
/// 消息图片支持的 MIME 白名单。
pub(super) const MESSAGE_IMAGE_TYPES: [&str; 4] =
    ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// 标识符类字段（模型 id / Profile 名 / 指令 id / 思考强度）的长度上限。
pub(super) const MAX_IDENTIFIER_LENGTH: usize = 200;
/// 待办内容长度上限（与 Renderer 桥、移动端输入框 maxlength 保持一致）。
pub(super) const MAX_TODO_CONTENT_LENGTH: usize = 500;
/// WorkFlow 反馈内容长度上限（与 Renderer 桥、移动端输入框 maxlength 保持一致）。
pub(super) const MAX_WORKFLOW_REPLY_LENGTH: usize = 2_000;
/// 可远程切换的代理行为模式白名单（必须与 renderer/types/remoteControl.ts 一致）。
pub(super) const REMOTE_MODES: [&str; 5] = ["goal", "worktree", "workflow", "yolo", "lite"];
/// 目标模式 Token 预算上限（0 = 无上限；与 Renderer 桥的校验一致）。
pub(super) const MAX_GOAL_TOKEN_BUDGET: i64 = 1_000_000_000;
/// 已完成 send 请求的去重缓存容量。
pub(super) const COMPLETED_SEND_CAPACITY: usize = 200;
/// 等待 send 派发空窗的上限（轮换凭据 / 停止服务时使用）。
pub(super) const SEND_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
/// 单次 send 请求内最多携带的附件数（与附件存储一致）。
pub(super) const MAX_SEND_ATTACHMENTS: usize = 4;
/// `@` 引用搜索的查询词长度上限（防超长输入拖慢文件遍历）。
pub(super) const MAX_MENTION_QUERY_CHARS: usize = 200;
/// 回滚 diff：单次请求携带的检查点数量、返回的文件数上限。
pub(super) const MAX_ROLLBACK_CHECKPOINTS: usize = 300;
pub(super) const MAX_ROLLBACK_DIFF_FILES: usize = 50;
/// 单个文件 diff 下发给手机端的行数 / 字节上限（手机屏幕消费不了更长的内容）。
pub(super) const MAX_ROLLBACK_DIFF_ROWS: u32 = 400;
pub(super) const MAX_ROLLBACK_DIFF_BYTES: u32 = 64 * 1024;
/// 变更面板单条文件路径的长度上限（与桥的回滚清单一致）。
pub(super) const MAX_CHANGE_PATH_LENGTH: usize = 400;
/// 移动端 Git 面板：单次暂存 / 取消暂存的文件数、路径总长与提交信息上限。
pub(super) const MAX_GIT_PATHS: usize = 100;
pub(super) const MAX_GIT_PATH_LENGTH: usize = 1024;
pub(super) const MAX_GIT_PATHS_TOTAL_CHARS: usize = 30_000;
pub(super) const MAX_GIT_COMMIT_MESSAGE: usize = 4_000;
/// 令牌解锁尝试限流：窗口与窗口内允许的失败次数。
pub(super) const UNLOCK_FAILURE_WINDOW_MS: i64 = 5 * 60 * 1000;
pub(super) const MAX_UNLOCK_FAILURES: usize = 10;
/// 动态码解锁尝试限流：6 位码空间小，窗口内允许的失败次数必须比令牌更少。
pub(super) const CODE_FAILURE_WINDOW_MS: i64 = 5 * 60 * 1000;
pub(super) const MAX_CODE_FAILURES: usize = 5;
/// 令牌长度上限（面板固定令牌与移动端输入都不得超过）。
pub(super) const MAX_UNLOCK_TOKEN_LENGTH: usize = 512;
/// 动态码长度上限（手机端固定输入 6 位，留出容错余量）。
pub(super) const MAX_UNLOCK_CODE_LENGTH: usize = 12;
/// 令牌解锁成功后写入的公网会话 Cookie 有效期（令牌本身不设过期）。
pub(super) const WAN_COOKIE_MAX_AGE: i64 = 365 * 24 * 60 * 60;
/// 实时通道单条客户端消息上限（只有控制指令）。
pub(super) const LIVE_MAX_MESSAGE_BYTES: usize = 64 * 1024;
