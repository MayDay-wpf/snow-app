import { useSyncExternalStore } from "react";

import { clientScriptStore } from "./clientScriptStore";

/**
 * 脚本编辑器会话（浏览器油猴脚本 / 客户端脚本共用）：
 * 侧栏面板负责打开会话，MainContent 据此在主内容区渲染遮罩编辑页面，替代此前的模态弹窗。
 */

export type ScriptEditorKind = "browser" | "client";

type ScriptEditorSessionBase = {
  /** 会话自增 id：驱动编辑器重挂载，切换会话时重新读取初始内容。 */
  id: number;
  kind: ScriptEditorKind;
  /** 编辑器虚拟文件名。 */
  fileName: string;
  /** 遮罩页面标题。 */
  title: string;
  /** 初始内容。 */
  content: string;
};

export type ScriptEditorSession =
  | (ScriptEditorSessionBase & { mode: "new" })
  | (ScriptEditorSessionBase & { mode: "edit"; scriptId: string });

export type ScriptEditorSaveResult = {
  revision: number;
  kind: ScriptEditorKind;
  action: "created" | "updated";
};

export type ScriptEditorStoreState = {
  session: ScriptEditorSession | null;
  /** 最近一次保存结果：列表页据此刷新并提示。 */
  lastSave: ScriptEditorSaveResult | null;
};

type ScriptEditorContent = {
  fileName: string;
  title: string;
  content: string;
};

let state: ScriptEditorStoreState = { session: null, lastSave: null };
let nextSessionId = 1;

const listeners = new Set<() => void>();

const commit = (partial: Partial<ScriptEditorStoreState>): void => {
  state = { ...state, ...partial };
  for (const listener of listeners) {
    listener();
  }
};

export const scriptEditorStore = {
  getState(): ScriptEditorStoreState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  openNew(kind: ScriptEditorKind, options: ScriptEditorContent): void {
    commit({ session: { ...options, id: nextSessionId++, kind, mode: "new" } });
  },
  openEdit(
    kind: ScriptEditorKind,
    options: ScriptEditorContent & { scriptId: string },
  ): void {
    commit({
      session: { ...options, id: nextSessionId++, kind, mode: "edit" },
    });
  },
  /** 关闭编辑器：未保存的内容直接丢弃。 */
  close(): void {
    if (state.session) {
      commit({ session: null });
    }
  },
  /** 保存并关闭；失败时抛出异常，编辑器保持打开并显示错误。 */
  async save(content: string): Promise<void> {
    const session = state.session;
    if (!session) {
      return;
    }
    if (session.mode === "new") {
      if (session.kind === "browser") {
        await window.snow.createUserscript(content);
      } else {
        await clientScriptStore.create(content);
      }
    } else if (session.kind === "browser") {
      await window.snow.updateUserscript(session.scriptId, content);
    } else {
      await clientScriptStore.update(session.scriptId, content);
    }
    commit({
      session: null,
      lastSave: {
        revision: (state.lastSave?.revision ?? 0) + 1,
        kind: session.kind,
        action: session.mode === "new" ? "created" : "updated",
      },
    });
  },
};

export const useScriptEditorStore = (): ScriptEditorStoreState =>
  useSyncExternalStore(
    scriptEditorStore.subscribe,
    scriptEditorStore.getState,
    () => state,
  );
