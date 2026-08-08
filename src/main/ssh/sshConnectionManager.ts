import {
  connectSsh,
  disconnectSsh,
  getSshProfileKey,
  getSshSession,
  setSshSessionHandleResolver,
  type SshConnectParams,
} from "./sshManager";

export type SshConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "degraded"
  | "reconnecting"
  | "offline"
  | "auth_required"
  | "host_key_changed";

export type SshProfileConnection = {
  profileId: string;
  sessionId?: string;
  generation: number;
  status: SshConnectionStatus;
  lastError?: string;
};

type ProfileEntry = SshProfileConnection & {
  params: SshConnectParams;
  references: number;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  connectPromise?: Promise<SshProfileConnection>;
};

type SshConnectionManagerOptions = {
  random?: () => number;
  idleTimeoutMs?: number;
  reconnectDelaysMs?: number[];
};

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export const getSshProfileId = (params: Pick<
  SshConnectParams,
  "host" | "port" | "username"
>): string => `ssh-profile:${getSshProfileKey(params)}`;

const clonePublicState = (entry: ProfileEntry): SshProfileConnection => ({
  profileId: entry.profileId,
  sessionId: entry.sessionId,
  generation: entry.generation,
  status: entry.status,
  lastError: entry.lastError,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const classifyConnectionError = (error: unknown): SshConnectionStatus => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = errorMessage(error);
  if (code === "SSH_HOST_KEY_CHANGED") {
    return "host_key_changed";
  }
  if (
    code === "SSH_AGENT_UNAVAILABLE" ||
    /authentication|all configured authentication|permission denied/i.test(message)
  ) {
    return "auth_required";
  }
  return "offline";
};

/**
 * Owns the lifecycle of a profile-scoped SSH connection. Session IDs are
 * intentionally private implementation details; profile IDs are stable over
 * reconnects and the generation changes only after a successful connection.
 */
export class SshConnectionManager {
  private readonly entries = new Map<string, ProfileEntry>();
  private readonly listeners = new Set<(state: SshProfileConnection) => void>();
  private readonly random: () => number;
  private readonly idleTimeoutMs: number;
  private readonly reconnectDelaysMs: number[];

  constructor(options: SshConnectionManagerOptions = {}) {
    this.random = options.random ?? Math.random;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.reconnectDelaysMs =
      options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    setSshSessionHandleResolver((handle) => this.resolveSessionId(handle));
  }

  subscribe(
    listener: (state: SshProfileConnection) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(profileId: string): SshProfileConnection | null {
    const entry = this.entries.get(profileId);
    return entry ? clonePublicState(entry) : null;
  }

  resolveSessionId(profileIdOrSessionId: string): string | undefined {
    return this.entries.get(profileIdOrSessionId)?.sessionId;
  }

  async acquire(params: SshConnectParams): Promise<SshProfileConnection> {
    const profileId = getSshProfileId(params);
    let entry = this.entries.get(profileId);
    if (!entry) {
      entry = {
        profileId,
        params: { ...params },
        generation: 0,
        status: "idle",
        references: 0,
        reconnectAttempt: 0,
      };
      this.entries.set(profileId, entry);
    } else {
      entry.params = { ...params };
    }

    entry.references += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }

    if (entry.status === "connected" && entry.sessionId && getSshSession(entry.sessionId)) {
      return clonePublicState(entry);
    }
    if (entry.connectPromise) {
      return entry.connectPromise;
    }

    entry.connectPromise = this.connect(entry, false).finally(() => {
      if (entry) {
        entry.connectPromise = undefined;
      }
    });
    return entry.connectPromise;
  }

  release(profileId: string): void {
    const entry = this.entries.get(profileId);
    if (!entry) {
      return;
    }
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references > 0 || entry.idleTimer) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.references === 0) {
        this.stop(entry, "idle");
      }
    }, this.idleTimeoutMs);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.stop(entry, "idle");
    }
    this.entries.clear();
    this.listeners.clear();
  }

  private emit(entry: ProfileEntry): void {
    const snapshot = clonePublicState(entry);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private async connect(
    entry: ProfileEntry,
    isReconnect: boolean
  ): Promise<SshProfileConnection> {
    entry.status = isReconnect ? "reconnecting" : "connecting";
    entry.lastError = undefined;
    this.emit(entry);

    try {
      const sessionId = await connectSsh(entry.params);
      // A profile can be released while the network handshake is pending.
      if (entry.references === 0) {
        disconnectSsh(sessionId);
        entry.status = "idle";
        this.emit(entry);
        return clonePublicState(entry);
      }

      entry.sessionId = sessionId;
      entry.generation += 1;
      entry.status = "connected";
      entry.reconnectAttempt = 0;
      entry.lastError = undefined;
      this.watchTransport(entry, sessionId);
      this.emit(entry);
      return clonePublicState(entry);
    } catch (error) {
      entry.sessionId = undefined;
      entry.lastError = errorMessage(error);
      entry.status = classifyConnectionError(error);
      if (entry.status === "offline" && entry.references > 0) {
        // Keep the stable profile handle usable after an initial handshake
        // failure. The renderer can retain its cached tree and wait for the
        // next generation instead of losing the profile to a rejected call.
        entry.status = "reconnecting";
        this.emit(entry);
        this.scheduleReconnect(entry);
      } else {
        this.emit(entry);
      }
      return clonePublicState(entry);
    }
  }

  private watchTransport(entry: ProfileEntry, sessionId: string): void {
    const session = getSshSession(sessionId);
    if (!session) {
      return;
    }
    session.client.once("close", () => {
      if (entry.sessionId !== sessionId) {
        return;
      }
      entry.sessionId = undefined;
      if (entry.references === 0) {
        entry.status = "idle";
        this.emit(entry);
        return;
      }
      entry.status = "reconnecting";
      entry.lastError = "SSH connection closed";
      this.emit(entry);
      this.scheduleReconnect(entry);
    });
    session.client.once("error", (error: Error) => {
      if (entry.sessionId === sessionId && entry.status === "connected") {
        entry.status = "degraded";
        entry.lastError = error.message;
        this.emit(entry);
      }
    });
  }

  private scheduleReconnect(entry: ProfileEntry): void {
    if (entry.reconnectTimer || entry.references === 0) {
      return;
    }
    const maxDelay =
      this.reconnectDelaysMs[
        Math.min(entry.reconnectAttempt, this.reconnectDelaysMs.length - 1)
      ] ?? DEFAULT_RECONNECT_DELAYS_MS.at(-1)!;
    entry.reconnectAttempt += 1;
    // Full Jitter prevents many restored workspaces from reconnecting together.
    const delay = Math.floor(this.random() * (maxDelay + 1));
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      if (entry.references === 0 || entry.sessionId) {
        return;
      }
      void this.connect(entry, true).catch(() => {
        // State and the next retry are handled in connect().
      });
    }, delay);
  }

  private stop(entry: ProfileEntry, status: "idle"): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const sessionId = entry.sessionId;
    // Clear references before ending the transport: ssh2 emits close
    // asynchronously and must not turn an intentional idle close into a retry.
    entry.references = 0;
    if (sessionId) {
      disconnectSsh(sessionId);
    }
    entry.sessionId = undefined;
    entry.status = status;
    entry.lastError = undefined;
    this.emit(entry);
  }
}

export const sshConnectionManager = new SshConnectionManager();
