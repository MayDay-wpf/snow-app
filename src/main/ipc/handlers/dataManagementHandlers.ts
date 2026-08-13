import { app, dialog, ipcMain } from "electron";
import { join, resolve } from "node:path";
import type {
  DataManagementExportRequest,
  DataManagementImportRequest,
  DataSection,
  DataManagementCredentialKind,
  DataManagementCredentialUpdate,
  DataManagementSettingsPatch,
} from "../../../preload/types/dataManagement";
import { dataManagementCoordinator } from "../../dataManagement/dataManagementCoordinator";
import type { NativeBridge } from "../../native/types";
import {
  createDatabaseBackup,
  deleteDatabaseBackup,
  listBackupRecords,
  stageDatabaseRestore,
} from "../../dataManagement/backupService";
import {
  applyConfigPackage,
  exportConfigPackage,
  inspectConfigPackage,
} from "../../dataManagement/configService";
import {
  recordWebDavSyncError,
  resolveWebDavConflict,
  runWebDavSync,
  testWebDavConnection,
} from "../../dataManagement/syncService";
import { getDataManagementSettings } from "../../dataManagement/settingsStore";

const pendingImportPaths = new Map<number, string>();
const pendingImportCleanupSenders = new Set<number>();

const CREDENTIAL_KINDS: readonly DataManagementCredentialKind[] = [
  "webdav-password",
  "sync-master-key",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const requireSettingsPatch = (value: unknown): DataManagementSettingsPatch => {
  if (!isRecord(value)) {
    throw new Error("Data management settings are required");
  }

  const patch: DataManagementSettingsPatch = {};
  if (value.deviceName !== undefined) {
    if (typeof value.deviceName !== "string") {
      throw new Error("Device name must be a string");
    }
    patch.deviceName = value.deviceName;
  }

  if (value.webdav !== undefined) {
    if (!isRecord(value.webdav)) {
      throw new Error("WebDAV settings must be an object");
    }
    const webdav = value.webdav;
    const next: NonNullable<DataManagementSettingsPatch["webdav"]> = {};
    if (webdav.endpoint !== undefined) {
      if (typeof webdav.endpoint !== "string" || webdav.endpoint.length > 2048) {
        throw new Error("WebDAV endpoint is invalid");
      }
      next.endpoint = webdav.endpoint.trim();
    }
    if (webdav.remoteRoot !== undefined) {
      if (
        typeof webdav.remoteRoot !== "string" ||
        webdav.remoteRoot.trim().length > 512
      ) {
        throw new Error("WebDAV remote root is invalid");
      }
      next.remoteRoot = webdav.remoteRoot.trim();
    }
    if (webdav.username !== undefined) {
      if (typeof webdav.username !== "string" || webdav.username.length > 512) {
        throw new Error("WebDAV username is invalid");
      }
      next.username = webdav.username.trim();
    }
    if (webdav.syncEnabled !== undefined) {
      if (typeof webdav.syncEnabled !== "boolean") {
        throw new Error("WebDAV syncEnabled must be a boolean");
      }
      next.syncEnabled = webdav.syncEnabled;
    }
    if (webdav.syncIntervalMinutes !== undefined) {
      if (![0, 15, 30, 60].includes(webdav.syncIntervalMinutes as number)) {
        throw new Error("WebDAV sync interval is invalid");
      }
      next.syncIntervalMinutes = webdav.syncIntervalMinutes as 0 | 15 | 30 | 60;
    }
    if (webdav.syncMode !== undefined) {
      if (webdav.syncMode !== "config" && webdav.syncMode !== "mirror") {
        throw new Error("WebDAV sync mode is invalid");
      }
      next.syncMode = webdav.syncMode;
    }
    if (webdav.allowInsecureHttp !== undefined) {
      if (typeof webdav.allowInsecureHttp !== "boolean") {
        throw new Error("WebDAV insecure HTTP option is invalid");
      }
      next.allowInsecureHttp = webdav.allowInsecureHttp;
    }
    patch.webdav = next;
  }

  if (value.backup !== undefined) {
    if (!isRecord(value.backup)) throw new Error("Backup settings must be an object");
    const backup = value.backup;
    const next: NonNullable<DataManagementSettingsPatch["backup"]> = {};
    if (backup.enabled !== undefined) {
      if (typeof backup.enabled !== "boolean") throw new Error("Backup enabled must be a boolean");
      next.enabled = backup.enabled;
    }
    if (backup.frequency !== undefined) {
      if (!["6h", "12h", "daily", "weekly"].includes(backup.frequency as string)) {
        throw new Error("Backup frequency is invalid");
      }
      next.frequency = backup.frequency as "6h" | "12h" | "daily" | "weekly";
    }
    if (backup.retentionCount !== undefined) {
      if (typeof backup.retentionCount !== "number" || !Number.isInteger(backup.retentionCount)) {
        throw new Error("Backup retention count is invalid");
      }
      next.retentionCount = backup.retentionCount;
    }
    if (backup.directory !== undefined) {
      if (typeof backup.directory !== "string" || backup.directory.length > 4096) {
        throw new Error("Backup directory is invalid");
      }
      next.directory = backup.directory.trim();
    }
    for (const key of ["includeArchive", "includeAttachments", "beforeImport", "beforeRestore"] as const) {
      if (backup[key] !== undefined) {
        if (typeof backup[key] !== "boolean") throw new Error(`Backup ${key} must be a boolean`);
        next[key] = backup[key];
      }
    }
    patch.backup = next;
  }

  return patch;
};

const requireCredentialUpdate = (
  value: unknown
): DataManagementCredentialUpdate => {
  if (!isRecord(value)) {
    throw new Error("Credential update is required");
  }
  if (
    typeof value.kind !== "string" ||
    !CREDENTIAL_KINDS.includes(value.kind as DataManagementCredentialKind)
  ) {
    throw new Error("Credential kind is invalid");
  }
  if (typeof value.value !== "string" || !value.value.trim()) {
    throw new Error("Credential value is required");
  }
  if (value.value.length > 1024 * 1024) {
    throw new Error("Credential value is too large");
  }
  return {
    kind: value.kind as DataManagementCredentialKind,
    value: value.value,
  };
};

const requireCredentialKind = (value: unknown): DataManagementCredentialKind => {
  if (
    typeof value !== "string" ||
    !CREDENTIAL_KINDS.includes(value as DataManagementCredentialKind)
  ) {
    throw new Error("Credential kind is invalid");
  }
  return value as DataManagementCredentialKind;
};

const requireSections = (value: unknown): DataSection[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some((section) => typeof section !== "string")) {
    throw new Error("At least one data-management section is required");
  }
  return value as DataSection[];
};

const requireExportRequest = (value: unknown): DataManagementExportRequest => {
  if (!isRecord(value)) throw new Error("Export request is required");
  const sections = requireSections(value.sections);
  const includeSecrets = value.includeSecrets === true;
  if (includeSecrets && (typeof value.password !== "string" || !value.password)) {
    throw new Error("An export password is required for sensitive configuration");
  }
  return {
    sections,
    includeSecrets,
    password: typeof value.password === "string" ? value.password : undefined,
  };
};

const requireImportRequest = (value: unknown): DataManagementImportRequest => {
  if (!isRecord(value)) throw new Error("Import request is required");
  return {
    sections: requireSections(value.sections),
    password: typeof value.password === "string" ? value.password : undefined,
    replaceSelected: value.replaceSelected === true,
  };
};

const optionalPassword = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("Import password is invalid");
  }
  return value || undefined;
};

const rememberPendingImport = (
  sender: Electron.WebContents,
  path: string
): void => {
  const senderId = sender.id;
  pendingImportPaths.set(senderId, path);
  if (pendingImportCleanupSenders.has(senderId)) return;
  pendingImportCleanupSenders.add(senderId);
  sender.once("destroyed", () => {
    pendingImportPaths.delete(senderId);
    pendingImportCleanupSenders.delete(senderId);
  });
};

const openConfigFile = async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Snow configuration", extensions: ["snow-config"] }],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
};

export const registerDataManagementHandlers = (native: NativeBridge): void => {
  ipcMain.handle("data-management:get-state", () =>
    dataManagementCoordinator.getState()
  );

  ipcMain.handle("data-management:get-settings", () =>
    dataManagementCoordinator.getSettings()
  );

  ipcMain.handle("data-management:set-settings", (_event, value: unknown) =>
    dataManagementCoordinator.setSettings(requireSettingsPatch(value))
  );

  // The value is accepted only for the duration of this IPC call. The return
  // value contains status booleans, never the plaintext or decrypted secret.
  ipcMain.handle(
    "data-management:set-credential",
    (_event, value: unknown) =>
      dataManagementCoordinator.setCredential(requireCredentialUpdate(value))
  );

  ipcMain.handle(
    "data-management:clear-credential",
    (_event, value: unknown) =>
      dataManagementCoordinator.clearCredential(requireCredentialKind(value))
  );

  ipcMain.handle("data-management:cancel", (_event, taskId: unknown) => {
    if (taskId !== undefined && typeof taskId !== "string") {
      throw new Error("Task ID must be a string");
    }
    return dataManagementCoordinator.cancel(taskId as string | undefined);
  });

  ipcMain.handle("data:export-config", async (_event, value: unknown) => {
    const request = requireExportRequest(value);
    const result = await dialog.showSaveDialog({
      defaultPath: join(app.getPath("documents"), "snow-app-config.snow-config"),
      filters: [{ name: "Snow configuration", extensions: ["snow-config"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return dataManagementCoordinator.run("config-export", async ({ report }) => {
      report({ phase: "exporting configuration", total: 3, completed: 1 });
      const preview = await exportConfigPackage(
        native,
        result.filePath as string,
        request.sections,
        request.includeSecrets,
        request.password
      );
      report({ phase: "configuration package written", total: 3, completed: 3 });
      return preview;
    });
  });

  ipcMain.handle("data:preview-import", async (event, value: unknown) => {
    const password = optionalPassword(value);
    const senderId = event.sender.id;
    let path = password ? pendingImportPaths.get(senderId) ?? null : null;
    if (!path) {
      pendingImportPaths.delete(senderId);
      path = await openConfigFile();
    }
    if (!path) return null;
    const preview = await inspectConfigPackage(path, password);
    rememberPendingImport(event.sender, path);
    return preview;
  });

  ipcMain.handle("data:apply-import", async (event, value: unknown) => {
    const request = requireImportRequest(value);
    const path = pendingImportPaths.get(event.sender.id) ?? (await openConfigFile());
    pendingImportPaths.delete(event.sender.id);
    if (!path) return null;
    return dataManagementCoordinator.run("config-import", async ({ report }) => {
      report({ phase: "validating configuration package", total: 3, completed: 1 });
      const preview = await applyConfigPackage(
        native,
        path,
        request.sections,
        request.password,
        request.replaceSelected,
        getDataManagementSettings().backup.beforeImport
      );
      report({ phase: "configuration imported", total: 3, completed: 3 });
      return preview;
    });
  });

  ipcMain.handle("backup:create", async (_event, reason: unknown, includeArchiveValue: unknown) => {
    if (includeArchiveValue !== undefined && typeof includeArchiveValue !== "boolean") {
      throw new Error("Backup archive option must be a boolean");
    }
    return dataManagementCoordinator.run("backup-create", async ({ report }) => {
      report({ phase: "creating SQLite online backup", total: 3, completed: 1 });
      const record = await createDatabaseBackup(
        native,
        typeof reason === "string" ? reason : "manual",
        includeArchiveValue ?? getDataManagementSettings().backup.includeArchive
      );
      report({ phase: "backup validated", total: 3, completed: 3, currentItem: record.path });
      return record;
    });
  });

  ipcMain.handle("backup:delete", (_event, value: unknown) => {
    if (typeof value !== "string" || !value) throw new Error("Backup path is required");
    deleteDatabaseBackup(value);
    return true;
  });

  ipcMain.handle("backup:restore", async (_event, value: unknown) => {
    if (typeof value !== "string" || !value) throw new Error("Backup path is required");
    const selected = listBackupRecords().find(
      (record) => record.integrity === "valid" && record.path === resolve(value)
    );
    if (!selected) {
      throw new Error("Only a validated backup from the configured backup directory can be restored");
    }
    await dataManagementCoordinator.run("backup-restore", async ({ report }) => {
      report({ phase: "validating restore snapshot", total: 3, completed: 1 });
      if (getDataManagementSettings().backup.beforeRestore) {
        await createDatabaseBackup(native, "pre-restore");
      }
      stageDatabaseRestore(value);
      report({ phase: "restore staged; restarting application", total: 3, completed: 3 });
    });
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle("sync:test-connection", () => testWebDavConnection());

  ipcMain.handle("sync:run", async () =>
    dataManagementCoordinator.run("sync", async ({ report }) => {
      report({ phase: "pulling remote sync state", total: 4, completed: 1 });
      let result;
      try {
        result = await runWebDavSync(native, true);
      } catch (error) {
        recordWebDavSyncError(error);
        throw error;
      }
      report({ phase: "sync completed", total: 4, completed: 4 });
      return result;
    })
  );

  ipcMain.handle("sync:resolve-conflict", async (_event, value: unknown) => {
    if (value !== "local" && value !== "remote" && value !== "keep-both") {
      throw new Error("Sync conflict choice is invalid");
    }
    return dataManagementCoordinator.run("sync", async ({ report }) => {
      report({ phase: "resolving sync conflict", total: 3, completed: 1 });
      let result;
      try {
        result = await resolveWebDavConflict(native, value, true);
      } catch (error) {
        recordWebDavSyncError(error);
        throw error;
      }
      report({ phase: "sync conflict resolved", total: 3, completed: 3 });
      return result;
    });
  });
};
