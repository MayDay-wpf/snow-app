import { app, utilityProcess, type UtilityProcess } from "electron";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import type {
  PluginRecord,
  PluginRuntimeDeclaration,
  PluginRuntimePermission,
  PluginRuntimeStatus,
} from "../../shared/plugins";
import { hashImportPath } from "../importConfig/discovery";

type RuntimeMessage = {
  type?: unknown;
  message?: unknown;
};

type RunningPluginRuntime = {
  child: UtilityProcess;
  timeout: NodeJS.Timeout;
  stopping: boolean;
  stopResolver?: (status: PluginRuntimeStatus) => void;
};

const STOP_TIMEOUT_MS = 5_000;

const exactPermissions = (
  declared: PluginRuntimePermission[],
  granted: unknown
): granted is PluginRuntimePermission[] => {
  if (
    !Array.isArray(granted) ||
    !granted.every((item) => typeof item === "string")
  )
    return false;
  const received = new Set(granted);
  return (
    received.size === granted.length &&
    declared.every((permission) => received.has(permission))
  );
};

const messageFrom = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : fallback;

const isWithin = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

export class PluginRuntimeManager {
  private readonly running = new Map<string, RunningPluginRuntime>();
  private readonly statuses = new Map<string, PluginRuntimeStatus>();

  getStatus(plugin: PluginRecord): PluginRuntimeStatus {
    if (!plugin.runtime) {
      return {
        state: "unavailable",
        message: "This Plugin does not declare a Snow runtime",
      };
    }
    return this.statuses.get(plugin.pluginId) ?? { state: "stopped" };
  }

  async start(
    plugin: PluginRecord,
    grantedPermissions: unknown
  ): Promise<PluginRuntimeStatus> {
    const runtime = plugin.runtime;
    if (!runtime) {
      return this.setStatus(plugin.pluginId, {
        state: "unavailable",
        message: "This Plugin does not declare a Snow runtime",
      });
    }
    if (plugin.state !== "enabled") {
      return this.setStatus(plugin.pluginId, {
        state: "stopped",
        message: "Enable the Plugin before starting its runtime",
      });
    }
    if (!exactPermissions(runtime.permissions, grantedPermissions)) {
      return this.setStatus(plugin.pluginId, {
        state: "permission-denied",
        message: "The declared runtime permissions were not approved",
      });
    }
    const existing = this.running.get(plugin.pluginId);
    if (existing) return this.getStatus(plugin);

    try {
      if ((await hashImportPath(plugin.sourcePath)) !== plugin.contentHash) {
        return this.setStatus(plugin.pluginId, {
          state: "stopped",
          message:
            "Plugin source changed; rescan and update it before running external code",
        });
      }
    } catch (error) {
      return this.setStatus(plugin.pluginId, {
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let entryPath: string;
    let storagePath: string;
    try {
      entryPath = this.resolveEntry(plugin, runtime);
      storagePath = this.pluginStoragePath(plugin.pluginId);
      mkdirSync(storagePath, { recursive: true });
    } catch (error) {
      return this.setStatus(plugin.pluginId, {
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.setStatus(plugin.pluginId, { state: "starting" });
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(
        join(import.meta.dirname, "plugin-runtime-worker.js"),
        [],
        {
          cwd: storagePath,
          env: {
            SNOW_PLUGIN_ID: plugin.pluginId,
            SNOW_PLUGIN_STORAGE_PATH: storagePath,
          },
          execArgv: this.permissionArguments(plugin, entryPath, storagePath),
          serviceName: `Snow Plugin: ${plugin.name}`,
          stdio: "ignore",
        }
      );
    } catch (error) {
      return this.setStatus(plugin.pluginId, {
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const timeout = setTimeout(() => {
      const active = this.running.get(plugin.pluginId);
      if (!active || active.child !== child) return;
      active.stopping = true;
      this.setStatus(plugin.pluginId, {
        state: "timed-out",
        message: `Plugin runtime did not become ready within ${runtime.timeoutMs}ms`,
      });
      child.kill();
    }, runtime.timeoutMs);
    const active: RunningPluginRuntime = { child, timeout, stopping: false };
    this.running.set(plugin.pluginId, active);

    child.on("spawn", () => {
      child.postMessage({
        type: "start",
        pluginId: plugin.pluginId,
        entryPath,
        storagePath,
        permissions: runtime.permissions,
      });
    });
    child.on("message", (message: RuntimeMessage) => {
      this.handleMessage(plugin.pluginId, child, message);
    });
    child.on("error", (_type: unknown, _location: unknown, report: unknown) => {
      const current = this.running.get(plugin.pluginId);
      if (!current || current.child !== child) return;
      this.setStatus(plugin.pluginId, {
        state: "failed",
        message: messageFrom(
          report,
          "Plugin runtime encountered a fatal error"
        ),
      });
    });
    child.on("exit", (code) => {
      this.handleExit(plugin.pluginId, child, code);
    });
    return this.getStatus(plugin);
  }

  async stop(plugin: PluginRecord): Promise<PluginRuntimeStatus> {
    const active = this.running.get(plugin.pluginId);
    if (!active) {
      return this.setStatus(
        plugin.pluginId,
        plugin.runtime
          ? { state: "stopped" }
          : {
              state: "unavailable",
              message: "This Plugin does not declare a Snow runtime",
            }
      );
    }
    if (active.stopping) return this.getStatus(plugin);
    active.stopping = true;
    clearTimeout(active.timeout);
    this.setStatus(plugin.pluginId, { state: "stopping" });
    const stopped = new Promise<PluginRuntimeStatus>((resolve) => {
      active.stopResolver = resolve;
    });
    active.child.postMessage({ type: "stop" });
    setTimeout(() => {
      const current = this.running.get(plugin.pluginId);
      if (current?.child === active.child) current.child.kill();
    }, STOP_TIMEOUT_MS);
    return stopped;
  }

  stopForLifecycleChange(pluginId: string): void {
    const active = this.running.get(pluginId);
    if (!active) return;
    active.stopping = true;
    clearTimeout(active.timeout);
    active.child.kill();
  }

  stopAll(): void {
    for (const [pluginId, active] of this.running) {
      active.stopping = true;
      clearTimeout(active.timeout);
      active.child.kill();
      this.statuses.set(pluginId, { state: "stopped" });
    }
    this.running.clear();
  }

  private handleMessage(
    pluginId: string,
    child: UtilityProcess,
    message: RuntimeMessage
  ): void {
    const active = this.running.get(pluginId);
    if (!active || active.child !== child || typeof message?.type !== "string")
      return;
    if (message.type === "ready") {
      clearTimeout(active.timeout);
      this.setStatus(pluginId, {
        state: "running",
        pid: child.pid,
        startedAt: new Date().toISOString(),
      });
      return;
    }
    if (message.type === "log") {
      const current = this.statuses.get(pluginId);
      if (current)
        this.setStatus(pluginId, {
          ...current,
          message: messageFrom(message.message, ""),
        });
      return;
    }
    if (message.type === "failed") {
      clearTimeout(active.timeout);
      active.stopping = true;
      this.setStatus(pluginId, {
        state: "failed",
        message: messageFrom(message.message, "Plugin runtime failed"),
      });
      child.kill();
    }
  }

  private handleExit(
    pluginId: string,
    child: UtilityProcess,
    code: number
  ): void {
    const active = this.running.get(pluginId);
    if (!active || active.child !== child) return;
    clearTimeout(active.timeout);
    this.running.delete(pluginId);
    const current = this.statuses.get(pluginId);
    const status = active.stopping
      ? current?.state === "timed-out" || current?.state === "failed"
        ? current
        : this.setStatus(pluginId, { state: "stopped" })
      : this.setStatus(pluginId, {
          state: "crashed",
          message: `Plugin runtime exited unexpectedly with code ${code}`,
        });
    active.stopResolver?.(status ?? { state: "stopped" });
  }

  private permissionArguments(
    plugin: PluginRecord,
    entryPath: string,
    storagePath: string
  ): string[] {
    const readPaths = [
      plugin.sourcePath,
      entryPath,
      import.meta.dirname,
      app.getAppPath(),
    ];
    if (plugin.runtime?.permissions.includes("storage")) {
      readPaths.push(storagePath);
    }
    const args = ["--permission", `--allow-fs-read=${readPaths.join(",")}`];
    if (plugin.runtime?.permissions.includes("storage"))
      args.push(`--allow-fs-write=${storagePath}`);
    if (plugin.runtime?.permissions.includes("network"))
      args.push("--allow-net");
    if (plugin.runtime?.permissions.includes("child-process"))
      args.push("--allow-child-process");
    return args;
  }

  private pluginStoragePath(pluginId: string): string {
    const segment = createHash("sha256")
      .update(pluginId)
      .digest("hex")
      .slice(0, 24);
    return join(app.getPath("userData"), "plugins", segment);
  }

  private resolveEntry(
    plugin: PluginRecord,
    runtime: PluginRuntimeDeclaration
  ): string {
    if (!existsSync(plugin.sourcePath)) {
      throw new Error("Plugin source directory is no longer available");
    }
    const root = realpathSync(plugin.sourcePath);
    const entry = resolve(root, runtime.entry);
    if (!existsSync(entry))
      throw new Error(`Plugin runtime entry is missing: ${runtime.entry}`);
    const canonicalEntry = realpathSync(entry);
    if (!isWithin(canonicalEntry, root)) {
      throw new Error(
        "Plugin runtime entry resolves outside the Plugin directory"
      );
    }
    if (!/\.(?:cjs|mjs|js)$/i.test(canonicalEntry)) {
      throw new Error("Plugin runtime entry must be a .js, .mjs, or .cjs file");
    }
    return canonicalEntry;
  }

  private setStatus(
    pluginId: string,
    status: PluginRuntimeStatus
  ): PluginRuntimeStatus {
    this.statuses.set(pluginId, status);
    return status;
  }
}
