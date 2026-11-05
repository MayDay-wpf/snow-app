import type { SnowRemoteState } from "../renderer/types/remoteControl";
import { fetchState, isUnauthorizedError } from "./api";
import { initComposer, renderComposer, syncSessionContext } from "./composer";
import { initControls, renderControls } from "./controls";
import { $, escapeHtml } from "./dom";
import { sessionContextKey } from "./format";
import { initGit, renderGit } from "./git";
import { initI18n, t } from "./i18n";
import { hydrateIcons, iconMarkup } from "./icons";
import { initInteractions, renderInteractions } from "./interactions";
import {
  initLive,
  isLiveReady,
  setLivePaused,
  startLive,
  stopLive,
  syncLive,
  wakeLive,
} from "./live";
import { showNotice } from "./notice";
import { initOverlays } from "./overlays";
import { closeRemotePanels, initPanels, renderPanels } from "./panels";
import { initPending, renderPending } from "./pending";
import { initRollback } from "./rollback";
import { applyAccentColor, applyUiFontFamily, initTheme } from "./theme";
import { initThreads, renderThreads } from "./threads";
import {
  beginConversationSwitch,
  cancelConversationSwitch,
  initTimeline,
  renderTimeline,
  stickToBottomIfNear,
} from "./timeline";
import { initTodos, renderTodos } from "./todos";
import { correctionDigest } from "./tools/correction";
import { initTopbar, renderTopbar } from "./topbar";
import type { AppContext } from "./types";
import { hideUnlock, initUnlock, showUnlock } from "./unlock";
import { initWorkflow, workflowDigest } from "./workflow";

/**
 * Mobile 远控页入口：装配各功能模块，维护状态同步与整体渲染。
 *
 * 状态同步：优先走 /api/live 实时通道（服务端推送增量补丁），
 * 通道不可用时回落到 /api/state 轮询。
 *
 * 渲染策略：
 * - 每轮快照都刷新廉价区域（顶栏、chips、面板列表、会话列表、交互卡片）；
 * - 消息区通过签名比较跳过无变化的整段重建，并维护自动跟随与「回到底部」按钮；
 * - 失败时展示离线占位，401 提示重新配对。
 */
let currentState: SnowRemoteState | null = null;
let lastSignature = "";
let requestGeneration = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const buildSignature = (next: SnowRemoteState): string =>
  next.activeConversationId +
  "|" +
  next.isStreaming +
  "|" +
  next.isCompacting +
  "|" +
  (next.compactionError ?? "") +
  "|" +
  (next.compactionPreview ?? "").length +
  "|" +
  // 回滚入口可见性参与签名（与 timeline.ts 的判定同源）：桌面切到子代理会话、
  // 或会话身份判定完成后「能否回滚」发生变化时，用户消息上的回滚按钮必须立即
  // 跟随消失，不能等下一次消息变化才重绘。
  String(next.rollbackAvailable !== false) +
  "|" +
  // 「是否还有更早记录」参与签名：它只影响时间线的「加载更早」入口，桌面
  // 分页状态变化（历史加载完成 / 已翻到最早）不一定伴随消息窗口变化，漏掉
  // 它会让入口停留在旧结论上（隐藏着打不开，或显示着却已无内容）。
  (next.hasOlderMessages ?? "") +
  "|" +
  next.messages
    .map(
      (message) =>
        message.id +
        ":" +
        message.status +
        ":" +
        message.content.length +
        ":" +
        (message.thinking || "").length +
        ":" +
        (message.toolCalls || [])
          .map(
            (tool) =>
              tool.interactionId +
              ":" +
              tool.status +
              ":" +
              // 参数是流式增长的（arguments 边收边拼），长度必须参与签名，
              // 否则参数变化不会触发消息区重绘。
              (tool.arguments || "").length +
              ":" +
              (tool.result || "").length +
              ":" +
              (tool.streamingStdout || "").length +
              ":" +
              // 纠错 Agent 的尝试追加 / 状态与结果变化必须触发消息区重绘。
              correctionDigest(tool.correction) +
              ":" +
              // workflow 卡片快照（节点进度）变化必须触发消息区重绘。
              workflowDigest(tool.workflow),
          )
          .join(","),
    )
    .join("|");

const render = (next: SnowRemoteState): void => {
  applyAccentColor(next.theme?.accentColor);
  applyUiFontFamily(next.theme?.fontFamily);
  renderTopbar(next);
  renderControls(next);
  renderGit(next);
  renderComposer(next);
  renderPending(next);
  renderTodos(next);
  renderPanels(next);
  renderThreads(next);
  renderInteractions(next);
  const signature = buildSignature(next);
  if (signature !== lastSignature) {
    const isFirstRender = lastSignature === "";
    lastSignature = signature;
    renderTimeline(next, isFirstRender);
  }
};

const offlineHtml = (message: string): string =>
  `<div class="empty"><div><div class="empty-mark">${iconMarkup("wifi-off")}</div><strong>${escapeHtml(message)}</strong><span>${t("remote.empty.offline.hint")}</span><button class="empty-action" type="button" data-unlock-open>${t("remote.unlock.open")}</button></div></div>`;

const showState = (next: SnowRemoteState): void => {
  syncSessionContext(sessionContextKey(next));
  currentState = next;
  hideUnlock();
  render(next);
};

const showOffline = (
  message: string,
  unauthorized: boolean,
  silent?: boolean,
): void => {
  closeRemotePanels();
  // 消息区被占位替换，恢复后必须整段重建。
  lastSignature = "";
  $("statusDot").className = "status-dot offline";
  $("threadTitle").textContent = unauthorized
    ? t("remote.empty.unauthorized.title")
    : t("remote.empty.failed.title");
  $("messages").innerHTML = offlineHtml(message);
  if (unauthorized) showUnlock("");
  if (!silent) showNotice(message, true);
};

const refresh = async (silent?: boolean): Promise<void> => {
  // 实时通道在线：请求服务端立即采集并推送增量，无需整份拉取。
  if (isLiveReady() && (await syncLive())) return;
  const generation = ++requestGeneration;
  try {
    const next = await fetchState();
    if (generation !== requestGeneration) return;
    showState(next);
    startLive();
  } catch (error) {
    if (generation !== requestGeneration) return;
    const unauthorized = isUnauthorizedError(error);
    if (unauthorized) stopLive();
    const message = unauthorized
      ? t("remote.error.unauthorized")
      : (error as Error).message || t("remote.error.offline");
    showOffline(message, unauthorized, silent);
  }
};

/** HTTP 轮询仅在实时通道不可用时兜底。 */
const schedule = (): void => {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  if (isLiveReady()) return;
  pollTimer = setTimeout(
    async () => {
      pollTimer = null;
      if (!isLiveReady()) await refresh(true);
      schedule();
    },
    document.hidden ? 5000 : 1000,
  );
};

const ctx: AppContext = {
  refresh,
  getState: () => currentState,
  invalidateTimeline: () => {
    lastSignature = "";
  },
  beginConversationSwitch,
  cancelConversationSwitch,
};

// ── 启动装配 ──────────────────────────────────────────────────────────────
// 注意：initI18n 会移除 <html data-i18n-pending>，在此之前样式表一直隐藏
// body，避免默认语言文案的闪烁；整个装配是同步的，不会出现半初始化截图。

hydrateIcons();
initI18n();
initTheme();
initOverlays();
initPanels(ctx);
initGit();
initTopbar(ctx);
initThreads(ctx);
initInteractions(ctx);
initTimeline();
initRollback(ctx);
initWorkflow(ctx);
initComposer(ctx);
initPending(ctx);
initTodos(ctx);
initControls(ctx);
initUnlock(() => refresh(false));
initLive({
  onState: (next) => {
    // 作废在途的 HTTP 拉取，避免旧快照覆盖推送结果。
    requestGeneration += 1;
    showState(next);
  },
  onError: (_status, message) => {
    requestGeneration += 1;
    showOffline(message || t("remote.error.offline"), false, true);
  },
  onOpen: () => {
    schedule();
  },
  onClose: (unauthorized) => {
    if (unauthorized) {
      showOffline(t("remote.error.unauthorized"), true, true);
    } else {
      void refresh(true);
    }
    schedule();
  },
});
renderControls(null);
renderComposer(null);

document.addEventListener("visibilitychange", () => {
  setLivePaused(document.hidden);
  if (!document.hidden) {
    wakeLive();
    void refresh(true);
  }
  schedule();
});
window.addEventListener("pageshow", () => {
  void refresh(true);
});
window.addEventListener("focus", () => {
  void refresh(true);
});
const viewport = window.visualViewport;
if (viewport) {
  /**
   * 软键盘遮挡高度 → CSS 变量（样式层据此压缩整页高度，卡片按钮不被键盘盖住）。
   * 小于阈值的高度差来自地址栏收缩 / 渲染误差，不参与补偿，避免整页抖动。
   * 视口变矮后若用户原本贴底，继续保持贴底，正在读的正文不会被顶走。
   */
  const syncKeyboardOffset = (): void => {
    const covered = Math.max(0, window.innerHeight - viewport.height);
    document.documentElement.style.setProperty(
      "--keyboard-offset",
      (covered > 80 ? covered : 0) + "px",
    );
    // 等样式与布局真正生效后再补偿（单次 rAF 可能仍读到旧的可视高度）。
    requestAnimationFrame(() =>
      requestAnimationFrame(() => stickToBottomIfNear()),
    );
  };
  viewport.addEventListener("resize", syncKeyboardOffset);
  syncKeyboardOffset();
}

if (location.search) {
  history.replaceState(null, "", location.pathname + location.hash);
}
setLivePaused(document.hidden);
startLive();
schedule();
