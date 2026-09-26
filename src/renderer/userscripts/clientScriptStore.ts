import { useSyncExternalStore } from "react";

import type {
  ClientScriptCommand,
  ClientScriptFailure,
  UserscriptRecord,
} from "../../preload/types/userscripts";

/**
 * 客户端 UI 脚本（“脚本插件”标签页）的状态源。
 *
 * 只管理 `target = client | all` 的脚本：`browser` 脚本仍由
 * 「浏览器设置 → 油猴脚本」维护，两者共用底层存储但互不干扰。
 */

export type ClientScriptStoreState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  scripts: UserscriptRecord[];
  failures: Record<string, ClientScriptFailure>;
  commands: ClientScriptCommand[];
  revision: number;
};

let state: ClientScriptStoreState = {
  status: "idle",
  error: null,
  scripts: [],
  failures: {},
  commands: [],
  revision: 0,
};

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

const commit = (partial: Partial<ClientScriptStoreState>): void => {
  state = { ...state, ...partial, revision: state.revision + 1 };
  for (const listener of listeners) {
    listener();
  }
};

const isClientScript = (record: UserscriptRecord): boolean =>
  record.target === "client" || record.target === "all";

const load = async (): Promise<void> => {
  commit({
    status: state.status === "ready" ? "ready" : "loading",
    error: null,
  });
  try {
    const [records, failures, commands] = await Promise.all([
      window.snow.listUserscripts(),
      window.snow.getClientScriptFailures().catch(() => []),
      window.snow.listClientScriptCommands().catch(() => []),
    ]);
    const failureMap: Record<string, ClientScriptFailure> = {};
    for (const failure of failures) {
      failureMap[failure.scriptId] = failure;
    }
    commit({
      status: "ready",
      scripts: records.filter(isClientScript),
      failures: failureMap,
      commands,
      error: null,
    });
  } catch (error) {
    commit({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const reload = (): Promise<void> => {
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  return inflight;
};

export const clientScriptStore = {
  getState(): ClientScriptStoreState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  ensureLoaded(): Promise<void> {
    if (state.status === "ready") {
      return Promise.resolve();
    }
    return reload();
  },
  refresh(): Promise<void> {
    return reload();
  },
  /** 创建脚本；返回新脚本记录。 */
  async create(raw: string): Promise<UserscriptRecord> {
    const record = await window.snow.createUserscript(raw);
    await window.snow.reapplyClientScripts().catch(() => {});
    await reload();
    return record;
  },
  async update(scriptId: string, raw: string): Promise<UserscriptRecord> {
    const record = await window.snow.updateUserscript(scriptId, raw);
    await window.snow.reapplyClientScripts().catch(() => {});
    await reload();
    return record;
  },
  async remove(scriptId: string): Promise<void> {
    await window.snow.deleteUserscript(scriptId);
    await window.snow.reapplyClientScripts().catch(() => {});
    await reload();
  },
  async setEnabled(scriptId: string, enabled: boolean): Promise<void> {
    await window.snow.setUserscriptEnabled(scriptId, enabled);
    await window.snow.reapplyClientScripts().catch(() => {});
    await reload();
  },
  /** 从 URL 安装（Greasy Fork 之外的直链 .user.js）。 */
  async installFromUrl(codeUrl: string): Promise<UserscriptRecord> {
    const record = await window.snow.installUserscript(codeUrl);
    await window.snow.reapplyClientScripts().catch(() => {});
    await reload();
    return record;
  },
  async pickFile(title?: string) {
    return window.snow.pickUserscriptFile(title);
  },
  async readSource(scriptId: string): Promise<string> {
    return window.snow.readUserscriptSource(scriptId);
  },
  async runCommand(commandId: number): Promise<void> {
    await window.snow.runClientScriptCommand(commandId);
  },
};

export const useClientScriptStore = (): ClientScriptStoreState =>
  useSyncExternalStore(
    clientScriptStore.subscribe,
    clientScriptStore.getState,
    () => state,
  );

// 脚本集合变化（含 AI 经 config-set 安装 / 启停 / 删除）统一刷新列表。
if (typeof window !== "undefined" && window.snow?.onUserscriptsChanged) {
  window.snow.onUserscriptsChanged(() => {
    void clientScriptStore.refresh();
  });
}
