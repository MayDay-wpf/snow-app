import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";

/** 团队诊断日志：控制台 + app 日志文件（~/.snow/log）。 */
const teamLog = (
  native: NativeBridge,
  message: string,
  context?: unknown,
): void => {
  void native
    .writeAppLog({
      level: "INFO",
      module: "team",
      func: "teamHandlers",
      message,
      context:
        context === undefined
          ? undefined
          : typeof context === "string"
            ? context
            : JSON.stringify(context),
      source: "main",
    })
    .catch(() => undefined);
};

/**
 * 团队协作 IPC 桥：把渲染层的团队调用转发给 Rust 原生模块。
 * 所有团队数据操作（身份读取、同步、记录 CRUD）都在 Rust 侧以
 * spawn_blocking 执行，不阻塞主进程事件循环。
 */
export const registerTeamHandlers = (native: NativeBridge): void => {
  ipcMain.handle("team:get-identity", async (_event, repoPath: unknown) => {
    const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
    teamLog(native, "IPC team:get-identity", { repoPath: trimmed });
    if (!trimmed) {
      throw new Error("Repository path is required");
    }
    try {
      const result = await native.teamGetIdentity(trimmed);
      teamLog(native, "IPC team:get-identity result", result);
      return result;
    } catch (e) {
      teamLog(native, "IPC team:get-identity ERROR", {
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  });

  ipcMain.handle("team:resolve-repo", async (_event, path: unknown) => {
    const trimmed = typeof path === "string" ? path.trim() : "";
    teamLog(native, "IPC team:resolve-repo", { path: trimmed });
    if (!trimmed) {
      throw new Error("Workspace path is required");
    }
    return native.teamResolveRepo(trimmed);
  });

  ipcMain.handle(
    "team:configure-identity",
    async (_event, repoPath: unknown, name: unknown, email: unknown) => {
      const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
      if (!trimmed) {
        throw new Error("Repository path is required");
      }
      if (typeof name !== "string" || typeof email !== "string") {
        throw new Error("Name and email are required");
      }
      return native.teamConfigureIdentity(trimmed, name.trim(), email.trim());
    },
  );

  ipcMain.handle("team:sync", async (_event, repoPath: unknown) => {
    const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
    if (!trimmed) {
      throw new Error("Repository path is required");
    }
    const result = await native.teamSync(trimmed);
    teamLog(native, "IPC team:sync result", result);
    return result;
  });

  ipcMain.handle(
    "team:list",
    async (_event, repoPath: unknown, kind: unknown) => {
      const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
      if (!trimmed) {
        throw new Error("Repository path is required");
      }
      if (typeof kind !== "string" || !kind.trim()) {
        throw new Error("Record kind is required");
      }
      return native.teamList(trimmed, kind.trim());
    },
  );

  ipcMain.handle(
    "team:upsert",
    async (
      _event,
      repoPath: unknown,
      kind: unknown,
      id: unknown,
      json: unknown,
    ) => {
      const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
      if (!trimmed) {
        throw new Error("Repository path is required");
      }
      if (typeof kind !== "string" || typeof id !== "string") {
        throw new Error("Record kind and id are required");
      }
      if (typeof json !== "string" || !json.trim()) {
        throw new Error("Record json is required");
      }
      return native.teamUpsert(trimmed, kind.trim(), id.trim(), json);
    },
  );

  ipcMain.handle(
    "team:delete",
    async (_event, repoPath: unknown, kind: unknown, id: unknown) => {
      const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
      if (!trimmed) {
        throw new Error("Repository path is required");
      }
      if (typeof kind !== "string" || typeof id !== "string") {
        throw new Error("Record kind and id are required");
      }
      return native.teamDelete(trimmed, kind.trim(), id.trim());
    },
  );

  ipcMain.handle(
    "team:media-save",
    async (
      _event,
      repoPath: unknown,
      noteId: unknown,
      fileName: unknown,
      base64Data: unknown,
    ) => {
      const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
      if (!trimmed) {
        throw new Error("Repository path is required");
      }
      if (
        typeof noteId !== "string" ||
        typeof fileName !== "string" ||
        typeof base64Data !== "string" ||
        !noteId.trim() ||
        !fileName.trim() ||
        !base64Data.trim()
      ) {
        throw new Error("Note id, file name and image data are required");
      }
      return native.teamMediaSave(
        trimmed,
        noteId.trim(),
        fileName.trim(),
        base64Data,
      );
    },
  );

  ipcMain.handle(
    "team:media-read",
    async (_event, repoPath: unknown, rel: unknown) => {
      const trimmed = typeof repoPath === "string" ? repoPath.trim() : "";
      if (!trimmed) {
        throw new Error("Repository path is required");
      }
      if (typeof rel !== "string" || !rel.trim()) {
        throw new Error("Media relative path is required");
      }
      return native.teamMediaRead(trimmed, rel.trim());
    },
  );
};
