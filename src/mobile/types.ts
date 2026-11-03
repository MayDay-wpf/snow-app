import type { SnowRemoteState } from "../renderer/types/remoteControl";

/**
 * 各功能模块初始化时注入的最小运行时上下文。
 * refresh / getState 由 main.ts 的状态同步（实时通道优先，轮询兜底）提供，
 * invalidateTimeline 用于切换会话后强制重建消息区，
 * beginConversationSwitch / cancelConversationSwitch 控制会话切换过渡态的
 * 消息区骨架屏（见 timeline.ts）。
 */
export type AppContext = {
  refresh: (silent?: boolean) => Promise<void>;
  getState: () => SnowRemoteState | null;
  invalidateTimeline: () => void;
  beginConversationSwitch: (conversationId: string) => void;
  cancelConversationSwitch: () => void;
};
