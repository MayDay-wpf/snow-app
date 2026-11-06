/**
 * 桌面宠物窗口入口。
 *
 * 两种形态：
 * - 精灵形态：canvas 逐帧播放精灵图动画（原行为）。
 * - 聊天形态：双击宠物后变形出的小对话窗口 —— 背景是该宠物的 idle 动画
 *   （低透明度），前景是聊天面板，配色从精灵图采样。
 *
 * 窗口拖拽不再使用 CSS `-webkit-app-region: drag`：Windows 上 drag 区域被
 * 系统当作标题栏，渲染层收不到鼠标事件，双击无法识别。改为 pointer 捕获 +
 * 主进程按屏幕位移移动窗口（见 petWindow 中的说明），并在未发生拖动时
 * 用点击间隔识别双击。
 */
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import type { PetActivityState, PetWindowConfig } from "../preload/types/pets";
import type { PetSpriteState } from "./components/pet/petSprites";
import { PetStage } from "./components/pet/PetStage";
import { PetChatPanel } from "./components/pet/PetChatPanel";
import {
  FALLBACK_PET_PALETTE,
  extractPetPalette,
  paletteToCssVars,
  type PetPalette,
} from "./components/pet/petPalette";
import { usePetChat } from "./components/pet/usePetChat";
import { I18nProvider } from "./i18n";
import {
  GlobalEditContextMenu,
  resolveEditableTarget,
} from "./components/common/GlobalEditContextMenu";
// 宠物窗口不引 styles.css：统一右键菜单与它依赖的配色令牌单独引入。
import "./themes/tokens.css";
import "./themes/context-menu.css";
import "./pet.css";
import {
  applyCachedThemeFontToDocument,
  watchCachedThemeFont,
} from "./components/sidebar/themeSettings/themeFontCache";
import { installImeKeyboardGuard } from "../shared/imeKeyboard";

installImeKeyboardGuard();

// 宠物窗口同样跟随应用字体：启动即用主题缓存，主题变更由 storage 事件同步。
applyCachedThemeFontToDocument();
watchCachedThemeFont(applyCachedThemeFontToDocument);

/** 超过该位移视为拖拽而非点击（像素）。 */
const DRAG_THRESHOLD_PX = 4;
/** 双击判定窗口（毫秒）。 */
const DOUBLE_CLICK_WINDOW_MS = 320;

function PetWindowApp(): React.JSX.Element | null {
  const [config, setConfig] = useState<PetWindowConfig | null>(null);
  const [activity, setActivity] = useState<PetActivityState>("idle");
  const [dragState, setDragState] = useState<PetSpriteState | null>(null);
  const [palette, setPalette] = useState<PetPalette>(FALLBACK_PET_PALETTE);
  const pointerRef = useRef<{
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const lastClickAtRef = useRef(0);
  // 聊天状态挂在窗口根组件：收起宠物再展开时对话不丢。
  const chat = usePetChat(config?.labels ?? null);

  useEffect(() => {
    const bridge = window.petBridge;
    if (!bridge) {
      return;
    }

    // 先登记广播订阅，再拉取初始值：订阅之后的状态变化必然经广播送达，
    // 订阅之前的状态由拉取补齐。若顺序颠倒，先启动会话再唤醒宠物时，
    // 窗口创建时刻的活动状态广播会在页面加载前发出而永久丢失。
    const unsubscribeConfig = bridge.onConfigChanged(setConfig);
    const unsubscribeActivity = bridge.onActivityChanged(setActivity);
    const unsubscribeDrag = bridge.onDragStateChanged(setDragState);

    bridge.getConfig().then((initial) => {
      if (initial) {
        setConfig(initial);
      }
    });
    bridge.getActivity().then((initialActivity) => {
      setActivity(initialActivity);
    });

    return () => {
      unsubscribeConfig();
      unsubscribeActivity();
      unsubscribeDrag();
    };
  }, []);

  // 配色取自精灵图：宠物切换 / 重装后重新采样。
  const spritesheetPath = config?.manifest?.spritesheetPath ?? null;
  useEffect(() => {
    if (!spritesheetPath) {
      return;
    }
    let cancelled = false;
    void extractPetPalette(spritesheetPath).then((next) => {
      if (!cancelled) {
        setPalette(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [spritesheetPath]);

  // 形态切换后重置双击计时：收起聊天的那次点击不应把随后的单击算作双击。
  const mode = config?.mode ?? null;
  useEffect(() => {
    lastClickAtRef.current = 0;
  }, [mode]);

  // 右键：阻止页面默认右键行为，菜单本体由主进程构建并弹出
  // （Windows 上拖拽区域的右键由主进程 system-context-menu 兜底）。
  // 输入框 / 编辑区例外：交给全窗口统一的编辑右键菜单（GlobalEditContextMenu）。
  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (
      resolveEditableTarget(event.target, {
        x: event.clientX,
        y: event.clientY,
      })
    ) {
      return;
    }
    event.preventDefault();
    window.petBridge?.showContextMenu();
  };

  const handlePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    // 按钮 / 输入框等交互控件不参与窗口拖拽，避免误拖并保证点击照常送达。
    if (
      target.closest(
        "button, input, textarea, a, select, [contenteditable='true']",
      )
    ) {
      return;
    }
    if (!target.closest("[data-pet-drag]")) {
      return;
    }
    // 此处刻意不 setPointerCapture：捕获会让后续 click 重定向到本容器，
    // 拖动区域内的按钮（关闭聊天）就再也收不到点击。改为真正越过拖动
    // 阈值时再捕获，普通点击保持原生行为。
    pointerRef.current = {
      startX: event.screenX,
      startY: event.screenY,
      dragging: false,
    };
  };

  const handlePointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    const state = pointerRef.current;
    if (!state) {
      return;
    }
    const dx = event.screenX - state.startX;
    const dy = event.screenY - state.startY;
    if (!state.dragging) {
      if (
        Math.abs(dx) < DRAG_THRESHOLD_PX &&
        Math.abs(dy) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      state.dragging = true;
      // 拖动期间指针会离开窗口，必须捕获才能持续收到 pointermove。
      event.currentTarget.setPointerCapture(event.pointerId);
      window.petBridge?.dragStart();
    }
    window.petBridge?.dragMove(dx, dy);
  };

  const handlePointerEnd = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    const state = pointerRef.current;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // state 为空 = 这次按下并未参与窗口拖拽（按钮 / 输入框等），
    // 不参与双击计数，避免干扰交互控件的原生点击。
    if (!state) {
      return;
    }
    if (state.dragging) {
      window.petBridge?.dragEnd();
      return;
    }

    // 未发生拖动 → 视为点击：两次相邻点击落在窗口内即为双击。
    const now = Date.now();
    if (now - lastClickAtRef.current <= DOUBLE_CLICK_WINDOW_MS) {
      lastClickAtRef.current = 0;
      if (config?.mode === "sprite") {
        void window.petBridge?.setMode("chat");
      }
      return;
    }
    lastClickAtRef.current = now;
  };

  const handleCloseChat = (): void => {
    void window.petBridge?.setMode("sprite");
  };

  if (!config || !config.manifest) {
    return null;
  }

  const styleVars = paletteToCssVars(palette);

  if (config.mode === "chat") {
    return (
      <div
        className="pet-window pet-window-chat"
        style={styleVars}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <PetChatPanel
          manifest={config.manifest}
          speed={config.settings.speed}
          labels={config.labels}
          chatContext={config.chatContext}
          chat={chat}
          onClose={handleCloseChat}
        />
      </div>
    );
  }

  return (
    <div
      className="pet-window"
      data-pet-drag="true"
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <PetStage
        manifest={config.manifest}
        scale={config.settings.scale}
        speed={config.settings.speed}
        activity={activity}
        dragState={dragState}
      />
    </div>
  );
}

const container = document.getElementById("pet-root");
if (container) {
  createRoot(container).render(
    <I18nProvider>
      <PetWindowApp />
      <GlobalEditContextMenu />
    </I18nProvider>,
  );
}
