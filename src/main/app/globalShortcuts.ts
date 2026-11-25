import { app, globalShortcut } from "electron";
import type { NativeBridge } from "../native/types";
import { focusNextDetachedPanelWindow } from "./detachedPanelWindow";
import { getMainWindow } from "./mainWindow";
import { refreshTrayStats, showMainWindow } from "./tray";
import { snowLog } from "../../utils/snowLogger";

/**
 * 全局快捷键：所有支持全局注册的动作统一在此注册。
 *
 * 渲染进程 keydown 只在窗口聚焦时生效；「仅前台生效」关闭（foregroundOnly=false）
 * 的动作改由主进程 globalShortcut 注册，失焦也能触发。触发后经 IPC 把动作
 * 名转发给渲染进程执行（除 toggleWindow / togglePet 等主进程可直接处理的动作）。
 *
 * 键格式转换：渲染层规范化格式（mod+shift+h / alt+left / escape）
 * → Electron accelerator（CommandOrControl+Shift+H / Alt+Left / Esc）。
 */

const GLOBAL_ACTIONS = [
  "cancelSession",
  "openSearch",
  "openMemo",
  "openTodo",
  "openUserMessageRail",
  "cycleProject",
  "openProjectExplorer",
  "openProjectMemory",
  "openScheduledTasks",
  "openPlugins",
  "cycleApiProfile",
  "toggleWindow",
  "togglePet",
  "focusInput",
  "toggleSidebar",
  "toggleRightPanel",
  "newChat",
  "stopGeneration",
  "prevConversation",
  "nextConversation",
  "scrollToTop",
  "scrollToBottom",
  "openSettings",
  "copyLastResponse",
  "toggleRightPanelFullscreen",
  "showShortcutHelp",
  "toggleMessageTime",
  "uiZoomIn",
  "uiZoomOut",
  "uiZoomReset",
  "newChatInNewWindow",
  "cycleDetachedWindow",
] as const;

type GlobalAction = (typeof GLOBAL_ACTIONS)[number];

const registered = new Map<string, GlobalAction>();

/**
 * 规范化键 → Electron accelerator。
 * - mod → CommandOrControl（macOS=Cmd，其他=Ctrl）
 * - ctrl → Control，alt → Alt，shift → Shift
 * - backtick → `，escape → Esc，字母/数字大写
 * 无修饰键的单键组合（如 escape）返回 null：全局注册会抢占整个系统
 * 的该按键（包括其他应用的输入场景），风险过高，拒绝注册。
 */
export const keyToAccelerator = (key: string): string | null => {
  const parts = key.split("+").filter((part) => part.length > 0);
  if (parts.length < 2) {
    return null; // 必须带至少一个修饰键
  }
  const modifiers = parts.slice(0, -1);
  const main = parts[parts.length - 1];

  const acceleratorParts: string[] = [];
  for (const modifier of modifiers) {
    if (modifier === "mod") {
      acceleratorParts.push("CommandOrControl");
    } else if (modifier === "ctrl") {
      acceleratorParts.push("Control");
    } else if (modifier === "alt") {
      acceleratorParts.push("Alt");
    } else if (modifier === "shift") {
      acceleratorParts.push("Shift");
    } else {
      return null; // 未知修饰键，不注册
    }
  }

  let mainPart: string;
  if (main === "backtick") {
    mainPart = "`";
  } else if (main === "escape") {
    mainPart = "Esc";
  } else if (main === "enter") {
    mainPart = "Return";
  } else if (main === "left") {
    mainPart = "Left";
  } else if (main === "right") {
    mainPart = "Right";
  } else if (main === "up") {
    mainPart = "Up";
  } else if (main === "down") {
    mainPart = "Down";
  } else if (main === "home") {
    mainPart = "Home";
  } else if (main === "end") {
    mainPart = "End";
  } else if (main === "tab") {
    mainPart = "Tab";
  } else if (main === "space") {
    mainPart = "Space";
  } else if (main === ",") {
    mainPart = ",";
  } else if (main === ".") {
    mainPart = ".";
  } else if (main === "/") {
    mainPart = "/";
  } else if (main === "=") {
    // Electron 将主键盘区的 = 命名为 Plus
    mainPart = "Plus";
  } else if (main === "-") {
    mainPart = "-";
  } else if (main.length === 1 && /^[a-z0-9]$/i.test(main)) {
    mainPart = main.toUpperCase();
  } else {
    return null;
  }

  return [...acceleratorParts, mainPart].join("+");
};

/**
 * toggle 主窗口：
 * - 可见且聚焦 → 隐藏到托盘（macOS 同时隐藏 Dock 图标，与
 *   window:hide-to-tray 行为一致，并刷新托盘悬停信息）
 * - 其余状态（隐藏 / 最小化 / 失焦）→ 呼出并聚焦（复用托盘恢复逻辑）
 */
const toggleMainWindow = (): void => {
  const win = getMainWindow();
  if (win && win.isVisible() && win.isFocused()) {
    win.hide();
    if (process.platform === "darwin") {
      app.dock?.hide();
    }
    refreshTrayStats();
    return;
  }
  showMainWindow();
};

const dispatchToRenderer = (action: GlobalAction): void => {
  // 独立窗口循环聚焦由主进程直接处理：主窗口隐藏或不存在时同样可以切换独立窗口。
  if (action === "cycleDetachedWindow") {
    focusNextDetachedPanelWindow();
    return;
  }
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    return;
  }
  if (action === "toggleWindow") {
    // toggleWindow 直接在主进程处理：窗口隐藏时 webContents 收不到转发
    toggleMainWindow();
    return;
  }
  if (!win.isVisible()) {
    showMainWindow();
  }
  win.webContents.send("shortcuts:global-triggered", action);
};

/**
 * 根据数据库配置批量注册/注销全局快捷键。
 * 仅处理 enabled=true 且 foregroundOnly=false 的动作；
 * 注册失败（组合键被其他应用占用）：记录告警，不打扰用户。
 * native 代理已做 storageReady 门控，storage 未就绪时该调用会自动等待。
 */
export const registerGlobalShortcuts = async (
  native: NativeBridge,
): Promise<void> => {
  for (const accelerator of registered.keys()) {
    globalShortcut.unregister(accelerator);
  }
  registered.clear();

  const settings = await native.getKeyboardShortcutsSettings();
  for (const action of GLOBAL_ACTIONS) {
    const config = settings[action];
    if (!config?.enabled || config.foregroundOnly) {
      continue;
    }
    const accelerator = keyToAccelerator(config.key);
    if (!accelerator) {
      continue;
    }
    if (registered.has(accelerator)) {
      continue;
    }
    const handler = (): void => {
      dispatchToRenderer(action);
    };
    const ok = globalShortcut.register(accelerator, handler);
    if (ok) {
      registered.set(accelerator, action);
    } else {
      snowLog.warn({
        module: "app/globalShortcuts",
        func: "registerGlobalShortcuts",
        message:
          "Failed to register global shortcut, likely taken by another app",
        context: `action=${action} accelerator=${accelerator}`,
      });
    }
  }
};
