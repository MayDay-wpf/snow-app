import { ipcRenderer } from "electron";
import type {
  DataManagementCredentialStatus,
  DataManagementCredentialUpdate,
  DataManagementExportRequest,
  DataManagementImportRequest,
  DataManagementImportPreview,
  DataManagementConflictChoice,
  DataManagementProgress,
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementState,
} from "../types/dataManagement";

export const dataManagementApi = {
  getDataManagementState: (): Promise<DataManagementState> =>
    ipcRenderer.invoke("data-management:get-state"),

  getDataManagementSettings: (): Promise<DataManagementSettings> =>
    ipcRenderer.invoke("data-management:get-settings"),

  setDataManagementSettings: (
    patch: DataManagementSettingsPatch
  ): Promise<DataManagementSettings> =>
    ipcRenderer.invoke("data-management:set-settings", patch),

  /** Write-only secret update. The Renderer cannot read a saved secret. */
  setDataManagementCredential: (
    update: DataManagementCredentialUpdate
  ): Promise<DataManagementCredentialStatus> =>
    ipcRenderer.invoke("data-management:set-credential", update),

  clearDataManagementCredential: (
    kind: DataManagementCredentialUpdate["kind"]
  ): Promise<DataManagementCredentialStatus> =>
    ipcRenderer.invoke("data-management:clear-credential", kind),

  cancelDataManagementTask: (taskId?: string): Promise<boolean> =>
    ipcRenderer.invoke("data-management:cancel", taskId),

  exportDataManagementConfig: (
    request: DataManagementExportRequest
  ): Promise<DataManagementImportPreview | null> =>
    ipcRenderer.invoke("data:export-config", request),

  previewDataManagementImport: (
    password?: string
  ): Promise<DataManagementImportPreview | null> =>
    ipcRenderer.invoke("data:preview-import", password),

  importDataManagementConfig: (
    request: DataManagementImportRequest
  ): Promise<DataManagementImportPreview | null> =>
    ipcRenderer.invoke("data:apply-import", request),

  createDataManagementBackup: (
    reason?: string,
    includeArchive?: boolean
  ): Promise<unknown | null> =>
    ipcRenderer.invoke("backup:create", reason, includeArchive),

  deleteDataManagementBackup: (path: string): Promise<boolean> =>
    ipcRenderer.invoke("backup:delete", path),

  restoreDataManagementBackup: (path: string): Promise<boolean> =>
    ipcRenderer.invoke("backup:restore", path),

  testDataManagementSyncConnection: (): Promise<{ weakConflictProtection: boolean }> =>
    ipcRenderer.invoke("sync:test-connection"),

  runDataManagementSync: (): Promise<unknown | null> =>
    ipcRenderer.invoke("sync:run"),

  resolveDataManagementConflict: (
    choice: DataManagementConflictChoice
  ): Promise<unknown | null> => ipcRenderer.invoke("sync:resolve-conflict", choice),

  onDataManagementProgress: (
    listener: (progress: DataManagementProgress) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (!value || typeof value !== "object") {
        return;
      }
      listener(value as DataManagementProgress);
    };
    ipcRenderer.on("data-management:progress", handler);
    return () => ipcRenderer.removeListener("data-management:progress", handler);
  },
};
