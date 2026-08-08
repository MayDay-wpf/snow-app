import { useEffect, useRef } from "react";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../preload";
import type { NotificationConversationTarget } from "../../shared/notification";
import { useChatConversationContext } from "./mainContent/chatMessages";
import type { MainContentView } from "./mainContent/types";

type NotificationNavigationBridgeProps = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange: (
    directory: WorkspaceDirectoryRecord | null
  ) => void;
  onSelectMainView: (view: MainContentView) => void;
};

const WARNING_PREFIX = "[NotificationNavigationBridge]";

export const NotificationNavigationBridge = ({
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
}: NotificationNavigationBridgeProps): null => {
  const { handleSelectConversation } = useChatConversationContext();
  const activeDirectoryRef = useRef(activeDirectory);
  const onActiveDirectoryChangeRef = useRef(onActiveDirectoryChange);
  const onSelectMainViewRef = useRef(onSelectMainView);
  const handleSelectConversationRef = useRef(handleSelectConversation);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);

  activeDirectoryRef.current = activeDirectory;
  onActiveDirectoryChangeRef.current = onActiveDirectoryChange;
  onSelectMainViewRef.current = onSelectMainView;
  handleSelectConversationRef.current = handleSelectConversation;

  useEffect(() => {
    mountedRef.current = true;

    const navigateToConversation = async (
      target: NotificationConversationTarget
    ): Promise<void> => {
      const requestId = ++requestIdRef.current;
      const conversationId = target.conversationId.trim();
      const directoryId = target.directoryId.trim();
      const isCurrentRequest = (): boolean =>
        mountedRef.current && requestId === requestIdRef.current;

      if (!conversationId || !directoryId) {
        console.warn(
          `${WARNING_PREFIX} Ignored notification activation because its conversationId or directoryId is empty.`
        );
        return;
      }

      let conversation: ChatConversationRecord | null;
      try {
        conversation = await window.snow.getChatConversation(conversationId);
      } catch (error) {
        if (!isCurrentRequest()) {
          return;
        }
        console.warn(
          `${WARNING_PREFIX} Failed to validate the notification target conversation.`,
          { conversationId, directoryId, error }
        );
        return;
      }
      if (!isCurrentRequest()) {
        return;
      }

      if (!conversation) {
        console.warn(
          `${WARNING_PREFIX} Ignored notification activation because the target conversation no longer exists.`,
          { conversationId, directoryId }
        );
        return;
      }
      if (conversation.directoryId.trim() !== directoryId) {
        console.warn(
          `${WARNING_PREFIX} Ignored notification activation because the conversation directory does not match the notification target.`,
          {
            conversationId,
            expectedDirectoryId: directoryId,
            actualDirectoryId: conversation.directoryId,
          }
        );
        return;
      }

      if (activeDirectoryRef.current?.directoryId.trim() !== directoryId) {
        let directories: WorkspaceDirectoryRecord[];
        try {
          directories = await window.snow.activateWorkspaceDirectory(directoryId);
        } catch (error) {
          if (!isCurrentRequest()) {
            return;
          }
          console.warn(
            `${WARNING_PREFIX} Failed to activate the notification target workspace directory.`,
            { conversationId, directoryId, error }
          );
          return;
        }
        if (!isCurrentRequest()) {
          return;
        }

        const nextDirectory =
          directories.find(
            (directory) =>
              directory.directoryId.trim() === directoryId && directory.isActive
          ) ??
          directories.find(
            (directory) => directory.directoryId.trim() === directoryId
          );
        if (!nextDirectory) {
          console.warn(
            `${WARNING_PREFIX} Ignored notification activation because the target workspace directory is unavailable after activation.`,
            { conversationId, directoryId }
          );
          return;
        }

        activeDirectoryRef.current = nextDirectory;
        onActiveDirectoryChangeRef.current(nextDirectory);
      }

      if (!isCurrentRequest()) {
        return;
      }
      onSelectMainViewRef.current("chat");

      try {
        await handleSelectConversationRef.current(
          conversationId,
          conversation.summary || conversation.title,
          {
            inputTokens: conversation.inputTokens,
            outputTokens: conversation.outputTokens,
            cacheCreationInputTokens: conversation.cacheCreationInputTokens,
            cacheReadInputTokens: conversation.cacheReadInputTokens,
          },
          directoryId
        );
      } catch (error) {
        if (!isCurrentRequest()) {
          return;
        }
        console.warn(
          `${WARNING_PREFIX} Failed to select the notification target conversation.`,
          { conversationId, directoryId, error }
        );
        return;
      }

      if (!isCurrentRequest()) {
        return;
      }
    };

    const dispose = window.snow.onNotificationActivated((target) => {
      void navigateToConversation(target);
    });

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      dispose();
    };
  }, []);

  return null;
};
