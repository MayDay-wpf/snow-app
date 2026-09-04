import { useEffect, useRef } from "react";

import { useKeyboardShortcutsSettings } from "../components/KeyboardShortcutsProvider";
import {
  SHORTCUT_ACTIONS,
  matchKey,
  shouldPreventDefault,
} from "../utils/shortcutUtils";

/**
 * 核心快捷键引擎 hook。
 *
 * 在 document 上注册单个 keydown 监听器，根据 KeyboardShortcutsProvider
 * 中的设置和已注册的 handler 分发快捷键动作。
 *
 * 工作流程：
 * 1. 事件源位于 [data-local-shortcuts] 区域时整体跳过（该区域的
 *    按键由组件自行处理，如文件搜索栏的 Enter/Esc）
 * 2. 读取 settingsRef（同步，避免闭包过期）
 * 3. 遍历 6 个快捷键动作，检查是否匹配当前按键
 * 4. 命中后先查作用域（局部）处理器：逆序找第一个 shouldIntercept()
 *    为 true 的条目并调用，用于焦点感知的局部接管（如文件查看器
 *    持有焦点时把 openSearch 接管为文内搜索）
 * 5. 无作用域接管时调用全局 handler
 * 6. 若需要，preventDefault 阻止浏览器默认行为
 *
 * foregroundOnly 语义说明：
 * - 渲染进程 keydown 监听天然仅在应用聚焦时触发（失焦时浏览器不接收键盘事件）
 * - 因此无论 foregroundOnly 开/关，行为一致（仅应用聚焦时生效）
 * 这是渲染进程方案的固有限制，未来可用 globalShortcut 增强
 */

/** 命令面板 / 文件提及面板是否处于打开状态（渲染在 DOM 中即视为打开）。 */
const isEscapePanelOpen = (): boolean =>
  document.querySelector("[data-esc-panel]") !== null;

export const useKeyboardShortcuts = (): void => {
  const { settings, getHandler, getScopedHandlers } =
    useKeyboardShortcutsSettings();

  // 使用 ref 持有最新的 settings 和 getHandler，使 keydown listener
  // 总是读取最新值而无需重新注册。
  const settingsRef = useRef(settings);
  const getHandlerRef = useRef(getHandler);
  const getScopedHandlersRef = useRef(getScopedHandlers);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    getHandlerRef.current = getHandler;
  }, [getHandler]);

  useEffect(() => {
    getScopedHandlersRef.current = getScopedHandlers;
  }, [getScopedHandlers]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // IME 组合输入期间（中文/日文等输入法候选过程，部分平台 keyCode 229）
      // 的按键属于输入法操作，不触发任何快捷键：如取消候选的 Esc 会误触发
      // cancelSession 中断正在运行的会话。
      if (event.isComposing || event.keyCode === 229) {
        return;
      }

      // 局部快捷键区域：事件源在标记元素内部时，引擎完全不介入，
      // 由该区域组件自己的 keydown 逻辑处理（避免 Esc 触发 cancelSession 等）。
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-local-shortcuts]")
      ) {
        return;
      }

      const currentSettings = settingsRef.current;
      const currentGetHandler = getHandlerRef.current;
      const currentGetScopedHandlers = getScopedHandlersRef.current;

      for (const action of SHORTCUT_ACTIONS) {
        const config = currentSettings[action];
        if (!config?.enabled) continue;

        if (!matchKey(event, config.key)) continue;

        // 命令面板 / 文件提及面板打开时，ESC 仅用于关闭面板，
        // 不触发 cancelSession（避免误中断正在运行的会话）。
        if (action === "cancelSession" && isEscapePanelOpen()) {
          continue;
        }

        // 作用域接管：逆序查找第一个声明要拦截的局部处理器
        const scopedHandlers = currentGetScopedHandlers(action);
        let scopedHandler: (() => void) | null = null;
        for (let i = scopedHandlers.length - 1; i >= 0; i -= 1) {
          const entry = scopedHandlers[i];
          if (entry.shouldIntercept()) {
            scopedHandler = entry.handler;
            break;
          }
        }

        const handler = scopedHandler ?? currentGetHandler(action);
        if (!handler) continue;

        // 匹配成功：阻止默认行为并调用 handler
        if (shouldPreventDefault(config.key)) {
          event.preventDefault();
        }
        handler();
        return; // 仅触发第一个匹配的动作
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);
};
