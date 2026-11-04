/**
 * 桌面宠物系统 IPC 处理器。
 *
 * 主窗口设置界面：安装（zip 文件对话框）/ 列表 / 卸载 / 启用 / 选择 / 缩放 /
 * 动画速度 / 聊天用的 API 配置、模型与自定义人设 / 上报当前打开的会话。
 * 宠物窗口：拉取配置、上报活动状态、弹出右键菜单、精灵 ↔ 聊天形态切换、
 * 宠物聊天（btw 式旁路会话，复用主流程流式请求，携带只读工具白名单）。
 */
import { dialog, ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import type { PetChatHistoryMessage } from "../../../preload/types/pets";
import {
  PET_PERSONA_MAX_CHARS,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  PET_SPEED_MAX,
  PET_SPEED_MIN,
  loadPetSettings,
  savePetSettings,
  type PetTurnKind,
} from "../../pets/petSettings";
import {
  abortPetChat,
  getPetChatContext,
  hasPetChatSnapshot,
  normalizePetChatHistory,
  runPetChat,
  setPetChatContext,
} from "../../pets/petChat";
import {
  beginPetWindowDrag,
  broadcastPetChatContext,
  endPetWindowDrag,
  getCurrentPetActivity,
  getCurrentPetConfig,
  movePetWindowDrag,
  refreshPetWindow,
  reportPetTurnEnded,
  reportPetTurnStarted,
  setPetWindowMode,
  showPetContextMenu,
} from "../../pets/petWindow";
import { safeSend } from "../../utils/safeSend";

/** 宠物窗口聊天流式分片事件频道。 */
const PET_CHAT_CHUNK_CHANNEL = "pets:chat-chunk";
/** 宠物窗口工具活动事件频道（驱动「正在搜索…」状态行）。 */
const PET_CHAT_TOOL_CHANNEL = "pets:chat-tool";

/** 解析渲染层的回合事件载荷，非法载荷返回 null 直接丢弃。 */
const parsePetTurnPayload = (
  payload: unknown,
): { turnId: string; kind: PetTurnKind; failed: boolean } | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.turnId !== "string" || !record.turnId.trim()) {
    return null;
  }
  return {
    turnId: record.turnId.trim(),
    kind: record.kind === "review" ? "review" : "chat",
    failed: record.failed === true,
  };
};

/** 解析宠物聊天请求载荷，非法载荷返回 null。 */
const parsePetChatPayload = (
  payload: unknown,
): {
  requestId: string;
  text: string;
  history: PetChatHistoryMessage[];
} | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const requestId =
    typeof record.requestId === "string" ? record.requestId.trim() : "";
  const text = typeof record.text === "string" ? record.text : "";
  if (!requestId || !text.trim()) {
    return null;
  }
  return {
    requestId,
    text,
    history: normalizePetChatHistory(record.history),
  };
};

export const registerPetHandlers = (native: NativeBridge): void => {
  // ── 主窗口设置界面 ─────────────────────────────────────────────────

  ipcMain.handle("pets:install-zip", async () => {
    const selection = await dialog.showOpenDialog({
      title: "Install Codex Pet Package",
      buttonLabel: "Install",
      filters: [{ name: "Codex Pet Package", extensions: ["zip"] }],
      properties: ["openFile"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }

    const zipPath = selection.filePaths[0];
    const manifest = await native.installPetFromZip(zipPath);

    // 若尚未选择宠物，新安装的宠物自动设为激活。
    const settings = await loadPetSettings(native);
    if (!settings.activePetId) {
      await savePetSettings(native, { ...settings, activePetId: manifest.id });
    }

    await refreshPetWindow(native);
    return manifest;
  });

  ipcMain.handle("pets:list", () => native.listInstalledPets());

  ipcMain.handle("pets:uninstall", async (_event, petId: unknown) => {
    if (typeof petId !== "string" || !petId.trim()) {
      throw new Error("Pet id is required");
    }

    await native.uninstallPet(petId.trim());

    // 卸载的是当前激活宠物时清空激活项并收起窗口。
    const settings = await loadPetSettings(native);
    if (settings.activePetId === petId.trim()) {
      await savePetSettings(native, { ...settings, activePetId: null });
    }

    // 所有宠物都被删除时自动关闭启停开关（无宠物时不允许唤醒）。
    const remaining = await native.listInstalledPets();
    if (remaining.length === 0) {
      const latest = await loadPetSettings(native);
      await savePetSettings(native, { ...latest, enabled: false });
    }

    await refreshPetWindow(native);
  });

  ipcMain.handle("pets:get-settings", () => loadPetSettings(native));

  ipcMain.handle("pets:set-enabled", async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("Enabled flag must be a boolean");
    }
    const settings = await loadPetSettings(native);
    const saved = await savePetSettings(native, { ...settings, enabled });
    await refreshPetWindow(native);
    return saved;
  });

  ipcMain.handle("pets:set-active", async (_event, petId: unknown) => {
    if (typeof petId !== "string") {
      throw new Error("Pet id must be a string");
    }
    const settings = await loadPetSettings(native);
    const saved = await savePetSettings(native, {
      ...settings,
      activePetId: petId.trim(),
    });
    await refreshPetWindow(native);
    return saved;
  });

  ipcMain.handle("pets:set-scale", async (_event, scale: unknown) => {
    const value = typeof scale === "number" ? scale : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error("Scale must be a number");
    }
    const clamped = Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, value));
    const settings = await loadPetSettings(native);
    const saved = await savePetSettings(native, {
      ...settings,
      scale: clamped,
    });
    await refreshPetWindow(native);
    return saved;
  });

  ipcMain.handle("pets:set-speed", async (_event, speed: unknown) => {
    const value = typeof speed === "number" ? speed : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error("Speed must be a number");
    }
    const clamped = Math.min(PET_SPEED_MAX, Math.max(PET_SPEED_MIN, value));
    const settings = await loadPetSettings(native);
    const saved = await savePetSettings(native, {
      ...settings,
      speed: clamped,
    });
    await refreshPetWindow(native);
    return saved;
  });

  // ── 宠物聊天配置（主窗口设置界面）────────────────────────────────────

  ipcMain.handle("pets:set-api-profile", async (_event, profile: unknown) => {
    if (profile !== null && typeof profile !== "string") {
      throw new Error("Pet API profile must be a string or null");
    }
    const settings = await loadPetSettings(native);
    return savePetSettings(native, {
      ...settings,
      apiProfile: typeof profile === "string" ? profile : null,
    });
  });

  ipcMain.handle("pets:set-model", async (_event, model: unknown) => {
    if (model !== null && typeof model !== "string") {
      throw new Error("Pet chat model must be a string or null");
    }
    const settings = await loadPetSettings(native);
    return savePetSettings(native, {
      ...settings,
      model: typeof model === "string" ? model : null,
    });
  });

  // 自定义人设：按宠物 id 写入；空文本表示删除该条（恢复宠物包默认人设）。
  ipcMain.handle("pets:set-persona", async (_event, payload: unknown) => {
    if (typeof payload !== "object" || payload === null) {
      throw new Error("Pet persona payload must be an object");
    }
    const record = payload as Record<string, unknown>;
    const petId = typeof record.petId === "string" ? record.petId.trim() : "";
    if (!petId) {
      throw new Error("Pet id is required");
    }
    if (typeof record.persona !== "string") {
      throw new Error("Pet persona must be a string");
    }

    const settings = await loadPetSettings(native);
    const personas = { ...settings.personas };
    const persona = record.persona.trim();
    if (persona) {
      personas[petId] = persona.slice(0, PET_PERSONA_MAX_CHARS);
    } else {
      delete personas[petId];
    }
    return savePetSettings(native, { ...settings, personas });
  });

  // 主窗口渲染层上报当前会话的实时快照（在途正文 / 工具活动 / 待办进度），
  // 宠物聊天据此获得真实运行信息。推送较频繁，仅在会话标识变化时才广播
  // 配置（宠物窗口标题栏用得到会话名）。
  // 同一时刻只有主聊天面上报，因此按来源渲染层判定快照归属：它销毁
  // （窗口关闭）时清空快照，避免宠物读到已不存在的会话上下文。
  let snapshotReporterId: number | null = null;
  const watchedSenders = new WeakSet<Electron.WebContents>();
  ipcMain.on("pets:set-chat-context", (event, payload: unknown) => {
    if (!watchedSenders.has(event.sender)) {
      watchedSenders.add(event.sender);
      const reporterId = event.sender.id;
      event.sender.once("destroyed", () => {
        if (snapshotReporterId !== reporterId || !hasPetChatSnapshot()) {
          return;
        }
        snapshotReporterId = null;
        setPetChatContext(null);
        broadcastPetChatContext();
      });
    }
    const previous = getPetChatContext();
    const next = setPetChatContext(payload);
    snapshotReporterId = event.sender.id;
    if (
      previous.conversationId !== next.conversationId ||
      previous.title !== next.title
    ) {
      broadcastPetChatContext();
    }
  });

  // ── 宠物窗口 ───────────────────────────────────────────────────────

  ipcMain.handle("pets:get-config", () => getCurrentPetConfig());
  // 宠物页面挂载后主动拉取当前活动状态：先启动会话再唤醒宠物时，
  // 窗口创建时刻的状态广播尚未被页面接收，需由页面自行补齐。
  ipcMain.handle("pets:get-activity", () => getCurrentPetActivity());

  // 双击宠物 → 变形成小对话窗口；关闭聊天 → 变回精灵。
  ipcMain.handle("pets:set-mode", async (_event, mode: unknown) => {
    if (mode !== "chat" && mode !== "sprite") {
      throw new Error("Pet window mode must be 'sprite' or 'chat'");
    }
    const settings = await loadPetSettings(native);
    setPetWindowMode(mode, settings);
    return mode;
  });

  // 宠物聊天：复用主流程四类请求方案（skipContext 保证不落库），
  // 携带请求级工具白名单（联网搜索 / 文件搜索 / 文件阅读），工具循环
  // 在 petChat 内驱动，活动状态经 pets:chat-tool 推送给宠物窗口。
  ipcMain.handle("pets:chat-send", async (event, payload: unknown) => {
    const parsed = parsePetChatPayload(payload);
    if (!parsed) {
      throw new Error("Pet chat request requires a requestId and text");
    }
    const settings = await loadPetSettings(native);
    const manifest = getCurrentPetConfig()?.manifest ?? null;
    return runPetChat(
      native,
      {
        settings,
        manifest,
        requestId: parsed.requestId,
        text: parsed.text,
        history: parsed.history,
        activity: getCurrentPetActivity(),
      },
      {
        onChunk: (chunk) => {
          if (!chunk.contentDelta) {
            return;
          }
          safeSend(event.sender, PET_CHAT_CHUNK_CHANNEL, {
            requestId: parsed.requestId,
            contentDelta: chunk.contentDelta,
          });
        },
        onToolActivity: (activity) => {
          safeSend(event.sender, PET_CHAT_TOOL_CHANNEL, {
            requestId: parsed.requestId,
            ...activity,
          });
        },
      },
    );
  });

  ipcMain.handle("pets:chat-abort", (_event, requestId: unknown) => {
    if (typeof requestId !== "string" || !requestId.trim()) {
      return false;
    }
    return abortPetChat(native, requestId.trim());
  });

  // AI 回合级联动：整条 agent loop 开始/彻底结束时由渲染层通知，
  // 使宠物在回合期间保持 running、仅在真正完成时 waving。
  // 载荷携带渲染层生成的 turnId：多会话并行时按 id 精确核销，
  // 中止 / 顶替 / 渲染层销毁等异常路径都不会污染计数。
  ipcMain.on("pets:turn-start", (event, payload: unknown) => {
    const parsed = parsePetTurnPayload(payload);
    if (!parsed) {
      return;
    }
    reportPetTurnStarted(event.sender, parsed.turnId, parsed.kind);
  });
  ipcMain.on("pets:turn-end", (_event, payload: unknown) => {
    const parsed = parsePetTurnPayload(payload);
    if (!parsed) {
      return;
    }
    reportPetTurnEnded(parsed.turnId, parsed.failed);
  });

  // 宠物窗口右键 → 弹出宠物右键菜单（菜单项在主进程构建）。
  ipcMain.on("pets:show-context-menu", () => {
    showPetContextMenu(native);
  });

  // 渲染层自绘拖拽（替代 CSS app-region，见 petWindow 中的说明）。
  ipcMain.on("pets:drag-start", () => {
    beginPetWindowDrag();
  });
  ipcMain.on("pets:drag-move", (_event, payload: unknown) => {
    if (typeof payload !== "object" || payload === null) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const dx = typeof record.dx === "number" ? record.dx : Number.NaN;
    const dy = typeof record.dy === "number" ? record.dy : Number.NaN;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return;
    }
    movePetWindowDrag(dx, dy);
  });
  ipcMain.on("pets:drag-end", () => {
    endPetWindowDrag();
  });
};
