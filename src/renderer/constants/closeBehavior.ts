/**
 * 「关闭 Snow App 时」行为设置的渲染端共享常量。
 *
 * 设置持久化在 Rust 后端 system_settings 表（close_behavior），
 * 由主进程在 close 拦截时读取并自动执行（见 windowHandlers.ts）；
 * 渲染端仅在通用设置面板展示与写入。
 */

/** system_settings 中的设置代码（主进程 windowHandlers.ts 保持一致）。 */
export const CLOSE_BEHAVIOR_SETTING_CODE = "close_behavior";

/** setSystemSetting 的展示名（与「团队协作」等既有设置命名风格一致）。 */
export const CLOSE_BEHAVIOR_SETTING_NAME = "关闭 Snow App 时";

/** 关闭行为：ask 每次询问（默认）/ exit 直接退出 / minimize 最小化到托盘。 */
export type CloseBehavior = "ask" | "exit" | "minimize";

/** 默认行为（未写入设置时）。 */
export const CLOSE_BEHAVIOR_DEFAULT: CloseBehavior = "ask";

/** 校验从后端读到的原始值，非法时回退默认行为。 */
export const normalizeCloseBehavior = (raw: string | null): CloseBehavior =>
  raw === "exit" || raw === "minimize" ? raw : CLOSE_BEHAVIOR_DEFAULT;
