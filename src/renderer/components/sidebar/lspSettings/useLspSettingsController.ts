import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LspServerConfigRecord,
  LspSessionStatus,
  ProjectStackDetection,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  createLspStringItem,
  toDraft,
  toInput,
  validateInitializationOptions,
} from "./lspSettingsUtils";
import type { LspServerConfig, LspServerDraft } from "./types";
import type { LspSettingsListItem } from "./LspSettingsList";

export type LspScope = "global" | "project";
type Task = { current: () => boolean; commit: (update: () => void) => void };

/** The parent keys this controller by scope + project id. Epochs also invalidate unmounted work. */
export function useLspSettingsController(
  activeScope: LspScope,
  activeDirectory?: WorkspaceDirectoryRecord | null,
) {
  const { t } = useI18n();
  const isGlobalScope = activeScope === "global";
  const projectId = activeDirectory?.directoryId;
  const scopeProjectId = isGlobalScope ? undefined : projectId;
  const [servers, setServers] = useState<LspServerConfig[]>([]);
  const [installedByCommand, setInstalledByCommand] = useState<
    Record<string, boolean>
  >({});
  const [sessionStatuses, setSessionStatuses] = useState<LspSessionStatus[]>(
    [],
  );
  const [runtimeStale, setRuntimeStale] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState("");
  const [operatingLang, setOperatingLang] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] =
    useState<LspSettingsListItem | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<LspSettingsListItem | null>(null);
  const [draft, setDraft] = useState<LspServerDraft | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [stackDetections, setStackDetections] = useState<
    ProjectStackDetection[] | null
  >(null);
  const mounted = useRef(false);
  const scopeEpoch = useRef(0);
  const loadGeneration = useRef(0);
  const statusGeneration = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scopeEpoch.current += 1;
      loadGeneration.current += 1;
      statusGeneration.current += 1;
    };
  }, []);

  const load = useCallback(
    async (clearNotice = true): Promise<void> => {
      const epoch = scopeEpoch.current;
      const generation = ++loadGeneration.current;
      const statusRevision = ++statusGeneration.current;
      setIsLoading(true);
      if (clearNotice) {
        setError("");
        setStatus("");
      }
      const results = await Promise.allSettled([
        isGlobalScope
          ? window.snow.listLspServerConfigs()
          : projectId
            ? window.snow.listEffectiveLspServerConfigs(projectId)
            : Promise.resolve([]),
        window.snow.probeLspServerCommands(scopeProjectId),
        !isGlobalScope && projectId
          ? window.snow.listLspSessionStatuses(projectId)
          : Promise.resolve([]),
      ]);
      if (
        !mounted.current ||
        scopeEpoch.current !== epoch ||
        loadGeneration.current !== generation
      )
        return;
      const [configs, probes, sessions] = results;
      setServers(configs.status === "fulfilled" ? configs.value : []);
      setInstalledByCommand(
        probes.status === "fulfilled"
          ? Object.fromEntries(
              probes.value.map((probe) => [probe.command, probe.installed]),
            )
          : {},
      );
      if (statusGeneration.current === statusRevision) {
        setSessionStatuses(
          sessions.status === "fulfilled" ? sessions.value : [],
        );
        setRuntimeStale(sessions.status !== "fulfilled");
      }
      const failures = results.flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : t("settings.lspLoadError"),
            ]
          : [],
      );
      if (failures.length > 0)
        setError((previous) =>
          [previous, ...failures].filter(Boolean).join("\n"),
        );
      setIsLoading(false);
    },
    [isGlobalScope, projectId, scopeProjectId, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (isGlobalScope || !projectId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (!busy.current) {
        const revision = ++statusGeneration.current;
        try {
          const items = await window.snow.listLspSessionStatuses(projectId);
          if (!disposed && revision === statusGeneration.current) {
            setSessionStatuses(items);
            setRuntimeStale(false);
          }
        } catch {
          if (!disposed && revision === statusGeneration.current)
            setRuntimeStale(true);
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [isGlobalScope, projectId]);

  const runTask = async (
    name: string,
    work: (task: Task) => Promise<void>,
    refresh = false,
    lang?: string,
  ): Promise<void> => {
    // Synchronous lock also rejects a second click before React can render disabled controls.
    if (busy.current || isLoading || !mounted.current) return;
    busy.current = true;
    const epoch = scopeEpoch.current;
    ++statusGeneration.current;
    ++loadGeneration.current;
    const current = (): boolean =>
      mounted.current && scopeEpoch.current === epoch;
    const task: Task = {
      current,
      commit: (update) => {
        if (current()) update();
      },
    };
    setAction(name);
    setOperatingLang(lang ?? null);
    setError("");
    setStatus("");
    try {
      await work(task);
    } catch (failure) {
      task.commit(() =>
        setError(
          failure instanceof Error
            ? failure.message
            : t("settings.lspOperationError"),
        ),
      );
    } finally {
      // Reconcile even after a batch partially succeeded; never keep an optimistic stale list.
      try {
        if (refresh && current()) await load(false);
      } catch (failure) {
        task.commit(() => {
          setIsLoading(false);
          setError(
            failure instanceof Error
              ? failure.message
              : t("settings.lspLoadError"),
          );
        });
      } finally {
        if (current()) {
          busy.current = false;
          setAction("");
          setOperatingLang(null);
        }
      }
    }
  };

  const reprobe = (): Promise<void> =>
    runTask("probe", async (task) => {
      const probes = await window.snow.probeLspServerCommands(scopeProjectId);
      task.commit(() => {
        setInstalledByCommand(
          Object.fromEntries(
            probes.map((probe) => [probe.command, probe.installed]),
          ),
        );
        setStatus(t("settings.lspRecheckDone"));
      });
    });
  const detectStack = (): Promise<void> =>
    runTask("detect", async (task) => {
      if (!activeDirectory) return;
      const detections = await window.snow.detectProjectStack(
        activeDirectory.path,
      );
      task.commit(() => {
        setStackDetections(detections);
        if (detections.length === 0) setStatus(t("settings.lspStackEmpty"));
      });
    });
  const confirmInstall = (): Promise<void> => {
    const pending = pendingInstall;
    if (!pending?.installCommand) return Promise.resolve();
    return runTask(
      "install",
      async (task) => {
        setPendingInstall(null);
        const result = await window.snow.installLspServer(
          pending.lang,
          scopeProjectId,
        );
        if (!task.current()) return;
        if (result.exitCode !== 0)
          throw new Error(
            t("settings.lspInstallFailed", {
              values: {
                lang: pending.lang,
                code: String(result.exitCode ?? "?"),
                output: result.output.trim().slice(-1500),
              },
            }),
          );
        setStatus(
          t("settings.lspInstallSuccess", { values: { lang: pending.lang } }),
        );
      },
      true,
      pending.lang,
    );
  };

  const startAdd = (): void => {
    setDraft({
      id: "",
      lang: "",
      command: "",
      args: [],
      fileExtensions: [],
      installCommand: "",
      initializationOptions: "",
      enabled: true,
      sortOrder:
        servers.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1,
      source: isGlobalScope ? "manual" : "project",
    });
    setError("");
    setStatus("");
  };
  const startEdit = (server: LspServerConfigRecord): void => {
    setDraft(toDraft(server));
    setError("");
    setStatus("");
  };
  const cancelDraft = (): void => {
    setDraft(null);
    setError("");
  };
  const patchDraft = (patch: Partial<LspServerDraft>): void =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
  const updateItem = (
    group: "args" | "fileExtensions",
    id: string,
    value: string,
  ): void =>
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].map((item) =>
              item.id === id ? { ...item, value } : item,
            ),
          }
        : null,
    );
  const addItem = (group: "args" | "fileExtensions"): void =>
    setDraft((previous) =>
      previous
        ? { ...previous, [group]: [...previous[group], createLspStringItem()] }
        : null,
    );
  const removeItem = (group: "args" | "fileExtensions", id: string): void =>
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].filter((item) => item.id !== id),
          }
        : null,
    );
  const saveDraft = (): Promise<void> => {
    if (!draft) return Promise.resolve();
    const input = toInput(draft);
    const initError = validateInitializationOptions(
      draft.initializationOptions,
    );
    const duplicate = servers.some(
      (item) =>
        item.lang === input.lang &&
        item.id !== draft.id &&
        (isGlobalScope || item.id.startsWith("project:")),
    );
    const validation = !input.lang
      ? t("settings.lspLangRequired")
      : !input.command
        ? t("settings.lspCommandRequired")
        : initError
          ? t(
              initError.includes("valid JSON")
                ? "settings.lspInitializationInvalidJson"
                : "settings.lspInitializationObjectRequired",
            )
          : duplicate
            ? t("settings.lspDuplicateLang", { values: { lang: input.lang } })
            : !isGlobalScope && !projectId
              ? t("settings.lspProjectRequired")
              : "";
    if (validation) {
      setError(validation);
      setStatus("");
      return Promise.resolve();
    }
    return runTask(
      "save",
      async (task) => {
        if (isGlobalScope) await window.snow.upsertLspServerConfig(input);
        else if (projectId)
          await window.snow.upsertProjectLspServerConfig(projectId, input);
        task.commit(() => {
          setDraft(null);
          setStatus(
            t(draft.id ? "settings.lspSaveSuccess" : "settings.lspAddSuccess"),
          );
        });
      },
      true,
      input.lang,
    );
  };
  const handleListToggle = (server: LspSettingsListItem): void => {
    const config = servers.find((item) => item.lang === server.lang);
    if (!config) return;
    void runTask(
      "toggle",
      async (task) => {
        const input = { ...toInput(toDraft(config)), enabled: !config.enabled };
        if (isGlobalScope) await window.snow.upsertLspServerConfig(input);
        else if (projectId)
          await window.snow.upsertProjectLspServerConfig(projectId, input);
        task.commit(() => setStatus(t("settings.lspSaveSuccess")));
      },
      true,
      config.lang,
    );
  };
  const handleListEdit = (server: LspSettingsListItem): void => {
    const config = servers.find((item) => item.lang === server.lang);
    if (config) startEdit(config);
  };
  const handleListDelete = (server: LspSettingsListItem): void =>
    setPendingDelete(server);
  const confirmDelete = (): Promise<void> => {
    const pending = pendingDelete;
    if (!pending) return Promise.resolve();
    return runTask(
      "delete",
      async (task) => {
        setPendingDelete(null);
        if (isGlobalScope)
          await window.snow.deleteLspServerConfig(pending.lang);
        else if (projectId)
          await window.snow.deleteProjectLspServerConfig(
            projectId,
            pending.lang,
          );
        task.commit(() => setStatus(t("settings.lspDeleteSuccess")));
      },
      true,
      pending.lang,
    );
  };
  const enableDetected = (): Promise<void> =>
    runTask(
      "enableDetected",
      async (task) => {
        if (!projectId || !stackDetections) return;
        for (const lang of new Set(stackDetections.map((item) => item.lang))) {
          if (!task.current()) return;
          const existing = servers.find((item) => item.lang === lang);
          if (!existing || existing.enabled) continue;
          await window.snow.upsertProjectLspServerConfig(projectId, {
            ...toInput(toDraft(existing)),
            enabled: true,
            source: "project",
          });
        }
      },
      true,
    );
  const removeDetectedOverrides = (): Promise<void> =>
    runTask(
      "removeDetected",
      async (task) => {
        if (!projectId || !stackDetections) return;
        const detected = new Set(stackDetections.map((item) => item.lang));
        for (const server of servers.filter(
          (item) => item.id.startsWith("project:") && detected.has(item.lang),
        )) {
          if (!task.current()) return;
          await window.snow.deleteProjectLspServerConfig(
            projectId,
            server.lang,
          );
        }
      },
      true,
    );
  const lifecycle = (
    kind: "start" | "stop" | "restart",
    server: LspSettingsListItem,
  ): Promise<void> =>
    runTask(
      kind,
      async (task) => {
        if (!projectId) return;
        if (kind === "start")
          await window.snow.startLspSession(projectId, server.lang);
        else if (kind === "stop")
          await window.snow.stopLspSession(projectId, server.lang);
        else await window.snow.restartLspSession(projectId, server.lang, true);
        task.commit(() =>
          setStatus(
            t(
              kind === "start"
                ? "settings.lspStartSuccess"
                : kind === "stop"
                  ? "settings.lspStopSuccess"
                  : "settings.lspRestartSuccess",
              { values: { lang: server.lang } },
            ),
          ),
        );
      },
      true,
      server.lang,
    );

  const listItems: LspSettingsListItem[] = servers.map((server) => {
    const sessions = sessionStatuses.filter(
      (item) => item.lang === server.lang,
    );
    const problem = sessions.find((item) => item.status !== "running");
    const session = problem ?? sessions[0];
    return {
      lang: server.lang,
      command: server.command,
      enabled: server.enabled,
      detail: `${server.command}${server.argsJson && server.argsJson !== "[]" ? " " + server.argsJson : ""}`,
      source: server.source,
      installCommand: server.installCommand ?? undefined,
      inherited: !isGlobalScope && !server.id.startsWith("project:"),
      runtimeStatus: runtimeStale ? "unknown" : (session?.status ?? "idle"),
      runtimeError: runtimeStale
        ? t("settings.lspStatusUnknown")
        : sessions
            .map((item) => `${item.projectRoot}: ${item.error ?? item.status}`)
            .join("\n") || undefined,
      lastUsedMs: session?.lastUsedMs,
    };
  });
  const detectedLangs = new Set(
    (stackDetections ?? []).map((item) => item.lang),
  );
  const isBusy = isLoading || action.length > 0;
  return {
    isGlobalScope,
    servers,
    listItems,
    installedByCommand,
    operatingLang,
    isLoading,
    isBusy,
    isSaving: [
      "save",
      "toggle",
      "delete",
      "enableDetected",
      "removeDetected",
    ].includes(action),
    isProbing: action === "probe",
    isInstalling: action === "install",
    isDetecting: action === "detect",
    pendingInstall,
    setPendingInstall,
    pendingDelete,
    setPendingDelete,
    draft,
    status,
    setStatus,
    error,
    setError,
    stackDetections,
    enabledCount: servers.filter((item) => item.enabled).length,
    listTitle: t("settings.lspServerListTitle"),
    emptyMessage: t("settings.lspNoServers"),
    canEnableDetected: servers.some(
      (item) => detectedLangs.has(item.lang) && !item.enabled,
    ),
    canRemoveDetected: servers.some(
      (item) => detectedLangs.has(item.lang) && item.id.startsWith("project:"),
    ),
    reprobe,
    detectStack,
    confirmInstall,
    startAdd,
    cancelDraft,
    patchDraft,
    updateItem,
    addItem,
    removeItem,
    saveDraft,
    handleListToggle,
    handleListEdit,
    handleListDelete,
    confirmDelete,
    enableDetected,
    removeDetectedOverrides,
    handleStart: (server: LspSettingsListItem) => lifecycle("start", server),
    handleStop: (server: LspSettingsListItem) => lifecycle("stop", server),
    handleRestart: (server: LspSettingsListItem) =>
      lifecycle("restart", server),
  };
}
