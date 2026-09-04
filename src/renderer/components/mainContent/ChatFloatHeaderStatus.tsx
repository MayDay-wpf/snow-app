import { useEffect, useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useChatConversationContext } from "./chatMessages";
import { OPEN_PROJECT_CODEBASE_PANEL_EVENT } from "./chatInput/ProjectCodebasePanel";
import { CodebaseSyncIndicator } from "../TopBar/CodebaseSyncIndicator";
import { TodoPanelButton } from "../TopBar/TodoPanelButton";
import { codebaseSyncStore } from "../TopBar/codebaseSyncStore";

type ChatFloatHeaderStatusProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

/**
 * 悬浮聊天头部状态条：复用 TopBar 的 TODO 面板按钮与代码库同步指示器。
 * 右面板全屏时 TopBar 中部被隐藏，这里补齐同等信息。
 */
export const ChatFloatHeaderStatus = ({
  activeDirectory,
}: ChatFloatHeaderStatusProps): React.JSX.Element => {
  const {
    messages,
    activeConversationId,
    conversationDirectoryId,
    isStreaming,
  } = useChatConversationContext();
  // 订阅 TopBar 发布的同步快照（TopBar 为唯一 watcher 持有者）。
  const [snapshot, setSnapshot] = useState(() => codebaseSyncStore.get());
  useEffect(() => codebaseSyncStore.subscribe(setSnapshot), []);

  return (
    <>
      <TodoPanelButton
        messages={messages}
        conversationId={activeConversationId}
        projectId={conversationDirectoryId ?? activeDirectory?.directoryId}
        isRunning={isStreaming}
      />
      {snapshot ? (
        <CodebaseSyncIndicator
          syncStatus={snapshot.syncStatus}
          watchedProjectId={snapshot.watchedProjectId}
          activeProjectId={snapshot.activeProjectId}
          isIndexed={snapshot.isIndexed}
          embedError={snapshot.embedError}
          onClick={() => {
            // 与 TopBar 行为一致：点击打开代码库管理弹窗（ChatInputView 监听）。
            window.dispatchEvent(
              new CustomEvent(OPEN_PROJECT_CODEBASE_PANEL_EVENT),
            );
          }}
        />
      ) : null}
    </>
  );
};
