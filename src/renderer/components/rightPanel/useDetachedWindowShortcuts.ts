import { useEffect, useRef } from "react";

import { useKeyboardShortcutsSettings } from "../KeyboardShortcutsProvider";
import { shortcutEvents } from "../shortcutEvents";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { adjustUiFontSize, resetUiFontSize } from "../../utils/uiZoom";

/**
 * 独立面板窗口的快捷键处理器。
 *
 * 主窗口的处理器注册在 App.tsx，其目标（侧边栏、顶栏、项目列表等）只存在于主窗口，
 * 独立窗口没有这些组件，因此只为能在本窗口生效的动作注册处理器：
 * - 会话运行时：取消 / 停止生成（handleAbort）；新会话（新增本窗口的草稿 tab）；
 * - 会话面板内的组件（聊天输入框、会话视图）通过 shortcutEvents 接收的动作；
 * - 应用级动作（宠物开关、界面字号）直接调用对应接口。
 */
export const useDetachedWindowShortcuts = (createTabRef: {
  current: (() => void) | null;
}): void => {
  const { registerHandler } = useKeyboardShortcutsSettings();
  const { handleAbort } = useChatConversationContext();

  const handleAbortRef = useRef(handleAbort);
  handleAbortRef.current = handleAbort;

  useEffect(() => {
    const unsubscribers = [
      registerHandler("cancelSession", () => {
        handleAbortRef.current();
      }),
      registerHandler("stopGeneration", () => {
        handleAbortRef.current();
      }),
      registerHandler("newChat", () => {
        createTabRef.current?.();
      }),
      registerHandler("focusInput", () => {
        shortcutEvents.emit("focus-chat-input");
      }),
      registerHandler("cycleApiProfile", () => {
        shortcutEvents.emit("open-api-profile-menu");
      }),
      registerHandler("sendMessage", () => {
        shortcutEvents.emit("send-message");
      }),
      registerHandler("sendMessageNow", () => {
        shortcutEvents.emit("send-message-now");
      }),
      registerHandler("scrollToTop", () => {
        shortcutEvents.emit("scroll-to-top");
      }),
      registerHandler("scrollToBottom", () => {
        shortcutEvents.emit("scroll-to-bottom");
      }),
      registerHandler("copyLastResponse", () => {
        shortcutEvents.emit("copy-last-response");
      }),
      registerHandler("togglePet", () => {
        void window.snow.getPetSettings().then((petSettings) => {
          void window.snow.setPetEnabled(!petSettings.enabled);
        });
      }),
      registerHandler("uiZoomIn", () => {
        adjustUiFontSize(1);
      }),
      registerHandler("uiZoomOut", () => {
        adjustUiFontSize(-1);
      }),
      registerHandler("uiZoomReset", () => {
        resetUiFontSize();
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [registerHandler, createTabRef]);
};
