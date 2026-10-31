import { useCallback, useEffect } from "react";

import type { WorkspaceDirectoryRecord } from "../../../preload";
import { ChatContent } from "../mainContent/ChatContent";
import { ChatSessionScope } from "../mainContent/chatMessages/components/ChatSessionScope";
import { useChatConversationContext } from "../mainContent/chatMessages";
import type { UseChatConversationResult } from "../mainContent/chatMessages/utils/conversationTypes";
import { loadTabTreeConversation } from "./useConversationTabTree";

type ConversationPanelProps = {
  /** 面板绑定的会话（拖入面板的根会话，也是 tab 身份）。 */
  conversationId: string;
  /**
   * tab 标题下拉切换后当前展示的会话（子代理 / Workflow 节点）；
   * 缺省或等于 conversationId 时展示根会话。
   */
  viewConversationId?: string;
  /** 承载本面板的 tab id（标题回写时定位 tab，避免每次渲染新建回调）。 */
  tabId: string;
  activeDirectory?: WorkspaceDirectoryRecord | null;
  /** tab 标题跟随会话摘要变化（由 RightPanel 写回 tab 标题）。 */
  onTitleChange?: (tabId: string, title: string) => void;
  /** 在同一个 tab 内切换展示的会话（RightPanel 改写 tab 的展示目标与标题）。 */
  onSelectConversationInTab?: (conversationId: string, title: string) => void;
};

/**
 * 面板内部：读的是 ChatSessionScope 注入的会话视图（summary 即该会话的摘要）。
 */
const ConversationPanelBody = ({
  tabId,
  conversationId,
  activeDirectory,
  onTitleChange,
}: ConversationPanelProps): React.JSX.Element => {
  const { summary, upsertedConversation } = useChatConversationContext();

  // 标题优先取刚落库的会话记录（AI 摘要生成后即时刷新），否则用内存中的摘要。
  const upsertedRecord = upsertedConversation?.record;
  const displayTitle =
    (upsertedRecord && upsertedRecord.conversationId === conversationId
      ? upsertedRecord.summary || upsertedRecord.title
      : "") || summary;

  useEffect(() => {
    if (displayTitle && onTitleChange) {
      onTitleChange(tabId, displayTitle);
    }
  }, [displayTitle, tabId, onTitleChange]);

  return (
    <div className="right-panel-conversation">
      <ChatContent activeDirectory={activeDirectory} surface="panel" />
    </div>
  );
};

/**
 * 右侧面板里的「会话面板」：绑定一个会话的完整聊天视图（含输入框与工具栏），
 * 与主内容区的聊天视图共用同一个会话运行时 —— 多个会话面板可同时运行、各自
 * 发送消息互不干扰。
 *
 * 展示的会话可以是根会话，也可以是其子代理 / Workflow 节点（由 tab 标题
 * 下拉切换，见 ConversationTabSwitcher）：切换只改本面板的展示目标，
 * 不影响主内容区，也不额外占用一个 tab。
 */
export const ConversationPanel = ({
  conversationId,
  viewConversationId,
  tabId,
  activeDirectory,
  onTitleChange,
  onSelectConversationInTab,
}: ConversationPanelProps): React.JSX.Element => {
  const activeConversationId = viewConversationId?.trim() || conversationId;
  const { handleSelectConversation } = useChatConversationContext();

  // 面板内的会话跳转（「返回主会话」等入口）：目标仍在本 tab 的会话树内时
  // 改为在同一个 tab 内切换展示目标，避免把主内容区一并切走；本 tab 之外的
  // 会话交回全局选择（与独立面板窗口的窗口级跳转语义一致）。
  const handlePanelSelectConversation = useCallback<
    UseChatConversationResult["handleSelectConversation"]
  >(
    async (targetConversationId, title, tokenUsage, directoryId) => {
      if (onSelectConversationInTab) {
        const record = await loadTabTreeConversation(
          targetConversationId,
          conversationId,
        );
        if (record) {
          onSelectConversationInTab(
            record.conversationId,
            record.summary || record.title,
          );
          return;
        }
      }
      await handleSelectConversation(
        targetConversationId,
        title,
        tokenUsage,
        directoryId,
      );
    },
    [conversationId, handleSelectConversation, onSelectConversationInTab],
  );

  return (
    <ChatSessionScope
      conversationId={activeConversationId}
      ownershipTabId={tabId}
      onSelectConversation={handlePanelSelectConversation}
    >
      <ConversationPanelBody
        conversationId={activeConversationId}
        tabId={tabId}
        activeDirectory={activeDirectory}
        onTitleChange={onTitleChange}
      />
    </ChatSessionScope>
  );
};
