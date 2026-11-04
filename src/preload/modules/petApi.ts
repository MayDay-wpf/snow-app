import { ipcRenderer } from "electron";
import type {
  PetChatSnapshot,
  PetManifest,
  PetSettings,
  PetTurnKind,
} from "../types/pets";

/**
 * 主窗口设置界面使用的宠物系统 API。
 * 设置变更后主进程会广播 "pets:changed"，界面据此刷新。
 */
export const petApi = {
  /** 打开文件对话框选择宠物包 zip 并安装；取消返回 null */
  installPetFromZip: (): Promise<PetManifest | null> =>
    ipcRenderer.invoke("pets:install-zip"),
  /** 列出所有可用宠物（Snow App + Codex App / Petdex 生态） */
  listInstalledPets: (): Promise<PetManifest[]> =>
    ipcRenderer.invoke("pets:list"),
  /** 卸载 Snow App 安装的宠物 */
  uninstallPet: (petId: string): Promise<void> =>
    ipcRenderer.invoke("pets:uninstall", petId),
  /** 读取宠物设置 */
  getPetSettings: (): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:get-settings"),
  /** 唤醒 / 收起宠物 */
  setPetEnabled: (enabled: boolean): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-enabled", enabled),
  /** 选择激活宠物（传空字符串取消选择） */
  setActivePet: (petId: string): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-active", petId),
  /** 设置显示缩放 */
  setPetScale: (scale: number): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-scale", scale),
  /** 设置动画播放速度倍率 */
  setPetSpeed: (speed: number): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-speed", speed),
  /** 设置宠物聊天使用的 API 配置（null = 跟随当前激活配置） */
  setPetApiProfile: (apiProfile: string | null): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-api-profile", apiProfile),
  /** 设置宠物聊天使用的模型（null = 跟随所选配置的高级模型） */
  setPetChatModel: (model: string | null): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-model", model),
  /**
   * 设置某个宠物的自定义人设（宠物聊天系统提示词里的 Persona 段）。
   * 传空字符串表示清除该宠物的自定义人设，恢复宠物包默认人设。
   */
  setPetPersona: (petId: string, persona: string): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-persona", { petId, persona }),
  /**
   * 上报当前打开会话的实时快照（在途正文、工具活动、待办进度）：
   * 宠物聊天据此注入真实运行信息（btw 式旁路会话）。渲染层节流调用，
   * 没有打开会话时上报空快照则退化为纯闲聊；渲染层卸载时传 null 清空。
   */
  setPetChatContext: (snapshot: PetChatSnapshot | null): void => {
    ipcRenderer.send("pets:set-chat-context", snapshot);
  },
  /** 订阅宠物列表 / 设置变化（安装、卸载、宠物窗口收起等） */
  onPetsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("pets:changed", handler);
    return () => {
      ipcRenderer.removeListener("pets:changed", handler);
    };
  },
  /** 通知宠物：一个 AI 回合（整条 agent loop）开始。
   *  turnId 由渲染层生成并持有，结束时原样回传以精确核销。 */
  notifyPetTurnStarted: (turnId: string, kind: PetTurnKind): void => {
    ipcRenderer.send("pets:turn-start", { turnId, kind });
  },
  /** 通知宠物：一个 AI 回合彻底结束（failed=true 播放失败动画） */
  notifyPetTurnEnded: (turnId: string, failed: boolean): void => {
    ipcRenderer.send("pets:turn-end", { turnId, failed });
  },
};
