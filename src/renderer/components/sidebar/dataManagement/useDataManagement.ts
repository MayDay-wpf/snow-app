import { useCallback, useEffect, useState } from "react";
import type {
  DataManagementProgress,
  DataManagementExportRequest,
  DataManagementImportRequest,
  DataManagementImportPreview,
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementState,
} from "../../../../preload";

export type UseDataManagementResult = {
  state: DataManagementState | null;
  settings: DataManagementSettings | null;
  progress: DataManagementProgress | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string;
  refresh: () => Promise<void>;
  updateSettings: (patch: DataManagementSettingsPatch) => Promise<void>;
  previewImport: (password?: string) => Promise<DataManagementImportPreview | null>;
  exportConfig: (request: DataManagementExportRequest) => Promise<DataManagementImportPreview | null>;
  importConfig: (request: DataManagementImportRequest) => Promise<DataManagementImportPreview | null>;
  createBackup: (reason?: string, includeArchive?: boolean) => Promise<unknown | null>;
  restoreBackup: (path: string) => Promise<boolean>;
  deleteBackup: (path: string) => Promise<boolean>;
  testSync: () => Promise<{ weakConflictProtection: boolean }>;
  runSync: () => Promise<unknown | null>;
  resolveConflict: (choice: "local" | "remote" | "keep-both") => Promise<unknown | null>;
};

export const useDataManagement = (): UseDataManagementResult => {
  const [state, setState] = useState<DataManagementState | null>(null);
  const [settings, setSettings] = useState<DataManagementSettings | null>(null);
  const [progress, setProgress] = useState<DataManagementProgress | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const [nextState, nextSettings] = await Promise.all([
        window.snow.getDataManagementState(),
        window.snow.getDataManagementSettings(),
      ]);
      setState(nextState);
      setSettings(nextSettings);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return window.snow.onDataManagementProgress((nextProgress) => {
      setProgress(nextProgress);
      if (nextProgress.status === "failed" && nextProgress.error) {
        setError(nextProgress.error);
      }
    });
  }, [refresh]);

  const updateSettings = useCallback(
    async (patch: DataManagementSettingsPatch): Promise<void> => {
      setIsSaving(true);
      try {
        const nextSettings = await window.snow.setDataManagementSettings(patch);
        setSettings(nextSettings);
        setState((current) =>
          current
            ? { ...current, deviceName: nextSettings.deviceName }
            : current
        );
        setError("");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        throw cause;
      } finally {
        setIsSaving(false);
      }
    },
    []
  );

  const action = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    try {
      const result = await work();
      await refresh();
      setError("");
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    }
  }, [refresh]);

  return {
    state,
    settings,
    progress,
    isLoading,
    isSaving,
    error,
    refresh,
    updateSettings,
    previewImport: (password) => action(() => window.snow.previewDataManagementImport(password)),
    exportConfig: (request) => action(() => window.snow.exportDataManagementConfig(request)),
    importConfig: (request) => action(() => window.snow.importDataManagementConfig(request)),
    createBackup: (reason, includeArchive) =>
      action(() => window.snow.createDataManagementBackup(reason, includeArchive)),
    restoreBackup: (path) => action(() => window.snow.restoreDataManagementBackup(path)),
    deleteBackup: (path) => action(() => window.snow.deleteDataManagementBackup(path)),
    testSync: () => action(() => window.snow.testDataManagementSyncConnection()),
    runSync: () => action(() => window.snow.runDataManagementSync()),
    resolveConflict: (choice) => action(() => window.snow.resolveDataManagementConflict(choice)),
  };
};
