import type { Event, WebContents } from "electron";

export type FrameTargetSession = {
  sessionId: string;
  targetId: string;
  parentSessionId?: string;
};

export type FrameTargetChange =
  | { type: "attached"; session: FrameTargetSession }
  | { type: "detached"; sessionId: string };

export type FrameTargetListener = (
  change: FrameTargetChange,
) => void | Promise<void>;

type AttachedTargetPayload = {
  sessionId?: unknown;
  targetInfo?: { type?: unknown; targetId?: unknown };
};

const COMMAND_TIMEOUT_MS = 10_000;
const SETTLE_QUIET_MS = 60;
const SETTLE_TIMEOUT_MS = 2_000;
const MAX_ERRORS = 8;
const autoAttachParams: Record<string, unknown> = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "iframe" }, { exclude: true }],
};

/** Shared CDP deadline for frame-target and frame-action commands. */
export const frameCdpDeadline = async <T>(
  method: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `FRAME_CDP_TIMEOUT: ${method} did not finish within 10 seconds`,
              ),
            ),
          COMMAND_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Owns the iframe target sessions of one guest. The root session keeps
 * `Target.setAutoAttach` enabled (recursively for nested OOPIFs), so frame
 * operations and event consumers share the same child sessions instead of
 * attaching and detaching them per call. New targets wait until subscribers
 * configure their domains, then are resumed. Sessions are dropped when Chrome
 * detaches a target, DevTools takes the debugger, or the guest is destroyed.
 */
class FrameTargetManager {
  private readonly contentsId: number;
  private readonly sessions = new Map<string, FrameTargetSession>();
  private readonly listeners = new Set<FrameTargetListener>();
  private readonly errors: string[] = [];
  private listener:
    | ((event: Event, method: string, params: any, sessionId: string) => void)
    | undefined;
  private starting: Promise<void> | undefined;
  private active = false;
  private pending = 0;
  private lastActivity = Date.now();
  private disposed = false;
  private readonly onDetach = (): void => this.dispose();
  private readonly onDestroyed = (): void => this.dispose();

  constructor(private readonly contents: WebContents) {
    this.contentsId = contents.id;
    contents.debugger.on("detach", this.onDetach);
    contents.once("destroyed", this.onDestroyed);
  }

  /** Start auto-attach once and wait until the existing iframe targets settle. */
  async ensure(): Promise<void> {
    if (this.disposed)
      throw new Error(
        "FRAME_CDP_UNAVAILABLE: frame target manager was released",
      );
    if (!this.active) {
      if (!this.starting) this.starting = this.start();
      const starting = this.starting;
      try {
        await starting;
      } catch (error) {
        if (this.starting === starting) this.starting = undefined;
        throw error;
      }
    }
    await this.waitForIdle();
  }

  /** Snapshot of currently attached iframe sessions. */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Replays current sessions, then reports attach/detach until unsubscribed. */
  subscribe(listener: FrameTargetListener): () => void {
    if (this.disposed)
      throw new Error(
        "FRAME_CDP_UNAVAILABLE: frame target manager was released",
      );
    for (const session of this.sessions.values()) {
      try {
        const result = listener({ type: "attached", session });
        if (result)
          void Promise.resolve(result).catch((error) =>
            this.recordError("frame target listener", error),
          );
      } catch (error) {
        this.recordError("frame target listener", error);
      }
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  diagnostics(): { sessions: number; errors: readonly string[] } {
    return { sessions: this.sessions.size, errors: this.errors };
  }

  private async start(): Promise<void> {
    if (this.contents.isDestroyed() || !this.contents.debugger.isAttached())
      throw new Error("FRAME_CDP_UNAVAILABLE: debugger is not attached");
    const listener = (
      _event: Event,
      method: string,
      params: any,
      sessionId: string,
    ): void => {
      this.onMessage(method, params, sessionId);
    };
    this.listener = listener;
    this.contents.debugger.on("message", listener);
    try {
      await this.command("Target.setAutoAttach", autoAttachParams);
    } catch (error) {
      this.removeListener();
      throw error;
    }
    if (this.disposed) {
      this.removeListener();
      throw new Error(
        "FRAME_CDP_UNAVAILABLE: frame target manager was released",
      );
    }
    this.active = true;
    this.lastActivity = Date.now();
  }

  private onMessage(
    method: string,
    params: unknown,
    parentSessionId: string,
  ): void {
    if (this.disposed) return;
    if (method === "Target.attachedToTarget") {
      const payload = params as AttachedTargetPayload | null;
      if (payload?.targetInfo?.type !== "iframe") return;
      const sessionId = payload.sessionId;
      const targetId = payload.targetInfo.targetId;
      if (
        typeof sessionId !== "string" ||
        typeof targetId !== "string" ||
        this.sessions.has(sessionId)
      )
        return;
      const session: FrameTargetSession = {
        sessionId,
        targetId,
        ...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
      };
      this.sessions.set(sessionId, session);
      this.lastActivity = Date.now();
      this.pending += 1;
      void this.configureSession(session).finally(() => {
        this.pending -= 1;
        this.lastActivity = Date.now();
      });
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId === "string") this.removeSession(sessionId);
    }
  }

  /** Configure listeners while the target is paused, then resume it. */
  private async configureSession(session: FrameTargetSession): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener({ type: "attached", session });
      } catch (error) {
        this.recordError("frame target listener", error);
      }
    }
    try {
      await this.command(
        "Target.setAutoAttach",
        autoAttachParams,
        session.sessionId,
      );
    } catch (error) {
      this.recordError("child auto-attach", error);
    }
    try {
      await this.command(
        "Runtime.runIfWaitingForDebugger",
        {},
        session.sessionId,
      );
    } catch (error) {
      this.recordError("resume target", error);
    }
  }

  private removeSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    const removed = new Set<string>([sessionId]);
    const queue = [sessionId];
    while (queue.length > 0) {
      const parent = queue.shift() as string;
      for (const [id, session] of this.sessions) {
        if (session.parentSessionId !== parent || removed.has(id)) continue;
        removed.add(id);
        queue.push(id);
      }
    }
    for (const id of removed) {
      this.sessions.delete(id);
      this.notify({ type: "detached", sessionId: id });
    }
  }

  private notify(change: FrameTargetChange): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(change);
        if (result)
          void Promise.resolve(result).catch((error) =>
            this.recordError("frame target listener", error),
          );
      } catch (error) {
        this.recordError("frame target listener", error);
      }
    }
  }

  private async waitForIdle(): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (
        this.pending === 0 &&
        Date.now() - this.lastActivity >= SETTLE_QUIET_MS
      )
        return;
      await delay(20);
    }
  }

  private command(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any> {
    if (this.contents.isDestroyed() || !this.contents.debugger.isAttached())
      return Promise.reject(
        new Error("FRAME_CDP_UNAVAILABLE: debugger is not attached"),
      );
    return frameCdpDeadline(method, () =>
      this.contents.debugger.sendCommand(method, params, sessionId),
    );
  }

  private removeListener(): void {
    if (!this.listener) return;
    this.contents.debugger.removeListener("message", this.listener);
    this.listener = undefined;
  }

  private recordError(stage: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.push(`${stage}: ${message}`);
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.starting = undefined;
    if (this.contents.isDestroyed()) {
      this.listener = undefined;
    } else {
      this.removeListener();
      this.contents.debugger.removeListener("detach", this.onDetach);
      this.contents.removeListener("destroyed", this.onDestroyed);
    }
    this.sessions.clear();
    this.listeners.clear();
    this.pending = 0;
    if (managers.get(this.contentsId) === this)
      managers.delete(this.contentsId);
  }
}

const managers = new Map<number, FrameTargetManager>();

/** Shared per-guest frame target manager; callers must ensure the debugger first. */
export const getFrameTargetManager = (
  contents: WebContents,
): FrameTargetManager => {
  let manager = managers.get(contents.id);
  if (!manager) {
    manager = new FrameTargetManager(contents);
    managers.set(contents.id, manager);
  }
  return manager;
};
