import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  KeyboardShortcutAction,
  KeyboardShortcutConfig,
  KeyboardShortcutsSettings,
} from "../../preload";
import { isMacOS } from "../utils/shortcutUtils";

/**
 * 所有快捷键的默认配置。当后端尚未 seed 或读取失败时使用。
 * 12 个快捷键默认 enabled=true；除 toggleWindow 外默认 foregroundOnly=true。
 * cycleApiProfile 的默认键平台相关：macOS 用 Ctrl+P（Alt 会输入特殊字符），
 * 其他平台用 Alt+P。
 * toggleWindow（mod+shift+h）默认 foregroundOnly=false：它由主进程
 * globalShortcut 注册，窗口隐藏到托盘时也要能呼出，不受"仅台前"限制。
 * togglePet（mod+shift+p）默认 foregroundOnly=true：宠物启停由渲染进程
 * 快捷键触发，仅应用聚焦时生效。
 * focusInput（mod+i）默认 foregroundOnly=true：聚焦输入框由渲染进程
 * 快捷键触发，仅应用聚焦时生效。
 * toggleSidebar / toggleRightPanel（mod+shift+l / mod+shift+r）默认
 * foregroundOnly=true：收起/展开左右侧边栏由渲染进程快捷键触发。
 */
const DEFAULT_SETTINGS: KeyboardShortcutsSettings = {
  cancelSession: { key: "escape", enabled: true, foregroundOnly: true },
  openSearch: { key: "mod+f", enabled: true, foregroundOnly: true },
  openMemo: { key: "mod+b", enabled: true, foregroundOnly: true },
  openTodo: { key: "mod+t", enabled: true, foregroundOnly: true },
  cycleProject: { key: "mod+backtick", enabled: true, foregroundOnly: true },
  openProjectExplorer: { key: "mod+d", enabled: true, foregroundOnly: true },
  cycleApiProfile: {
    key: isMacOS() ? "ctrl+p" : "alt+p",
    enabled: true,
    foregroundOnly: true,
  },
  toggleWindow: {
    key: "mod+shift+h",
    enabled: true,
    foregroundOnly: false,
  },
  togglePet: {
    key: "mod+shift+p",
    enabled: true,
    foregroundOnly: true,
  },
  focusInput: {
    key: "mod+i",
    enabled: true,
    foregroundOnly: true,
  },
  toggleSidebar: {
    key: "mod+shift+l",
    enabled: true,
    foregroundOnly: true,
  },
  toggleRightPanel: {
    key: "mod+shift+r",
    enabled: true,
    foregroundOnly: true,
  },
};

/**
 * 快捷键动作处理器类型。每个动作对应一个无参回调。
 * 当快捷键触发且 enabled=true 时调用。
 */
export type KeyboardShortcutHandler = () => void;

/**
 * 作用域拦截器：返回 true 表示当前上下文（如某个面板持有焦点）
 * 要接管该快捷键，引擎将调用局部 handler 而不再触发全局 handler。
 */
export type ScopedShortcutInterceptor = () => boolean;

/**
 * 作用域快捷键条目：局部 handler + 拦截判定。
 * 同一 action 可注册多个条目，引擎按注册的逆序查找第一个
 * shouldIntercept() 为 true 的条目。
 */
export type ScopedShortcutHandler = {
  handler: KeyboardShortcutHandler;
  shouldIntercept: ScopedShortcutInterceptor;
};

type KeyboardShortcutsContextValue = {
  /** 当前快捷键设置（内存缓存，启动时从 SQLite 加载） */
  settings: KeyboardShortcutsSettings;
  /** 是否已从后端加载完成 */
  isLoaded: boolean;
  /** 更新单个快捷键的配置，同时写入 SQLite 和内存缓存 */
  updateShortcutConfig: (
    action: KeyboardShortcutAction,
    config: Partial<KeyboardShortcutConfig>,
  ) => void;
  /** 注册某个动作的处理器。返回注销函数。 */
  registerHandler: (
    action: KeyboardShortcutAction,
    handler: KeyboardShortcutHandler,
  ) => () => void;
  /** 获取某个动作的当前处理器（通过 ref，避免闭包过期） */
  getHandler: (
    action: KeyboardShortcutAction,
  ) => KeyboardShortcutHandler | null;
  /**
   * 注册某个动作的作用域（局部）处理器。当快捷键命中且
   * shouldIntercept() 返回 true 时，引擎调用该局部 handler
   * 并跳过全局 handler；否则回落到全局 handler。返回注销函数。
   */
  registerScopedHandler: (
    action: KeyboardShortcutAction,
    handler: KeyboardShortcutHandler,
    shouldIntercept: ScopedShortcutInterceptor,
  ) => () => void;
  /** 获取某个动作的全部作用域条目（引擎用，逆序查找） */
  getScopedHandlers: (
    action: KeyboardShortcutAction,
  ) => ScopedShortcutHandler[];
};

const KeyboardShortcutsContext = createContext<
  KeyboardShortcutsContextValue | undefined
>(undefined);

export const KeyboardShortcutsProvider = ({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element => {
  const [settings, setSettings] =
    useState<KeyboardShortcutsSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  // 处理器注册表：action -> handler。使用 ref 持有最新值，
  // 这样 keydown 监听器读取时不会因闭包过期而调用旧 handler。
  const handlersRef = useRef<
    Map<KeyboardShortcutAction, KeyboardShortcutHandler>
  >(new Map());

  // 作用域处理器注册表：action -> 条目数组。用于焦点感知的局部接管，
  // 例如文件查看器持有焦点时把 openSearch 接管为文内搜索。
  const scopedHandlersRef = useRef<
    Map<KeyboardShortcutAction, ScopedShortcutHandler[]>
  >(new Map());

  // 设置的 ref 镜像，keydown 监听器通过它读取最新设置，
  // 避免每次设置变化都重新注册 keydown listener。
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // 启动时从 SQLite 加载快捷键设置到内存缓存
  useEffect(() => {
    let cancelled = false;
    void window.snow
      .getKeyboardShortcutsSettings()
      .then((loaded) => {
        if (!cancelled) {
          setSettings(loaded);
          setIsLoaded(true);
        }
      })
      .catch(() => {
        // 读取失败时使用默认值，不阻塞应用启动
        if (!cancelled) {
          setSettings(DEFAULT_SETTINGS);
          setIsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateShortcutConfig = useCallback(
    (
      action: KeyboardShortcutAction,
      config: Partial<KeyboardShortcutConfig>,
    ) => {
      setSettings((prev: KeyboardShortcutsSettings) => {
        const current = prev[action];
        const next: KeyboardShortcutsSettings = {
          ...prev,
          [action]: { ...current, ...config },
        };
        // 双写：异步写入 SQLite，不阻塞 UI；写入成功后通知主进程
        // 重注册全局快捷键（toggleWindow 由主进程 globalShortcut 处理，
        // 窗口隐藏时也能呼出，需在设置变更后同步）。
        void window.snow
          .setKeyboardShortcutsSettings(next)
          .then(() => {
            void window.snow.reloadGlobalShortcut().catch(() => {
              // 全局快捷键重注册失败时静默处理（如组合键被其他应用占用）
            });
          })
          .catch(() => {
            // 写入失败时静默处理，内存缓存仍已更新
          });
        return next;
      });
    },
    [],
  );

  const registerHandler = useCallback(
    (action: KeyboardShortcutAction, handler: KeyboardShortcutHandler) => {
      handlersRef.current.set(action, handler);
      return () => {
        // 仅在 handler 未被替换时才删除，避免新 handler 被误删
        if (handlersRef.current.get(action) === handler) {
          handlersRef.current.delete(action);
        }
      };
    },
    [],
  );

  const getHandler = useCallback(
    (action: KeyboardShortcutAction): KeyboardShortcutHandler | null => {
      return handlersRef.current.get(action) ?? null;
    },
    [],
  );

  const registerScopedHandler = useCallback(
    (
      action: KeyboardShortcutAction,
      handler: KeyboardShortcutHandler,
      shouldIntercept: ScopedShortcutInterceptor,
    ) => {
      const entry: ScopedShortcutHandler = { handler, shouldIntercept };
      const list = scopedHandlersRef.current.get(action) ?? [];
      list.push(entry);
      scopedHandlersRef.current.set(action, list);
      return () => {
        const current = scopedHandlersRef.current.get(action);
        if (!current) return;
        const index = current.indexOf(entry);
        if (index !== -1) {
          current.splice(index, 1);
        }
        if (current.length === 0) {
          scopedHandlersRef.current.delete(action);
        }
      };
    },
    [],
  );

  const getScopedHandlers = useCallback(
    (action: KeyboardShortcutAction): ScopedShortcutHandler[] => {
      return scopedHandlersRef.current.get(action) ?? [];
    },
    [],
  );

  const value: KeyboardShortcutsContextValue = {
    settings,
    isLoaded,
    updateShortcutConfig,
    registerHandler,
    getHandler,
    registerScopedHandler,
    getScopedHandlers,
  };

  return (
    <KeyboardShortcutsContext.Provider value={value}>
      {children}
    </KeyboardShortcutsContext.Provider>
  );
};

export const useKeyboardShortcutsSettings =
  (): KeyboardShortcutsContextValue => {
    const context = useContext(KeyboardShortcutsContext);
    if (!context) {
      throw new Error(
        "useKeyboardShortcutsSettings must be used within a KeyboardShortcutsProvider",
      );
    }
    return context;
  };

/**
 * 获取当前设置的 ref，供 keydown 监听器同步读取最新值。
 * 避免在 keydown callback 闭包中捕获过期的 settings。
 */
export const useKeyboardShortcutsSettingsRef =
  (): React.MutableRefObject<KeyboardShortcutsSettings> => {
    const { settings } = useKeyboardShortcutsSettings();
    const ref = useRef(settings);
    ref.current = settings;
    return ref;
  };
