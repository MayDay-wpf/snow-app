import { useCallback, useEffect, useSyncExternalStore } from "react";

import type {
  SshConnectionStatus,
  SshProfileConnection,
  WorkspaceDirectoryRecord,
} from "../../preload";

type SshConnectionStoreState = {
  /** 是否已完成首次状态快照装载。 */
  ready: boolean;
  revision: number;
  profiles: Record<string, SshProfileConnection>;
  /** 工作区路径 → profile ID（空字符串表示解析失败）。 */
  resolved: Record<string, string>;
  resolving: Record<string, true>;
};

let state: SshConnectionStoreState = {
  ready: false,
  revision: 0,
  profiles: {},
  resolved: {},
  resolving: {},
};

const listeners = new Set<() => void>();
const resolvePromises = new Map<string, Promise<string | null>>();

const commit = (patch: Partial<SshConnectionStoreState>): void => {
  state = { ...state, ...patch, revision: state.revision + 1 };
  for (const listener of listeners) {
    listener();
  }
};

const commitProfile = (profile: SshProfileConnection): void => {
  const current = state.profiles[profile.profileId];
  // 广播与快照可能乱序：只接受不更旧的 generation，同代际以最新状态为准。
  if (current && current.generation > profile.generation) {
    return;
  }
  commit({ profiles: { ...state.profiles, [profile.profileId]: profile } });
};

const commitResolved = (workspacePath: string, profileId: string): void => {
  if (state.resolved[workspacePath] === profileId) {
    return;
  }
  commit({ resolved: { ...state.resolved, [workspacePath]: profileId } });
};

let started = false;

/** 首次订阅时取一次快照，之后只消费主播（全窗口共享同一份事实）。 */
const ensureStarted = (): void => {
  if (started) {
    return;
  }
  started = true;
  window.snow.onSshProfileConnection((connection) => {
    commitProfile(connection);
  });
  const startRevision = state.revision;
  void window.snow
    .sshListProfiles()
    .then((profiles) => {
      const next: Record<string, SshProfileConnection> = {};
      for (const profile of profiles) {
        next[profile.profileId] = profile;
      }
      // 快照期间已收到广播时，以广播后的状态为准，仅补缺失项。
      const merged =
        state.revision === startRevision
          ? next
          : { ...next, ...state.profiles };
      commit({ profiles: merged, ready: true });
    })
    .catch(() => {
      commit({ ready: true });
    });
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  ensureStarted();
  return () => {
    listeners.delete(listener);
  };
};

// 非 SSH 目录无需订阅广播（状态恒为 null），避免每次状态变化重渲染所有行。
const subscribeNothing = (): (() => void) => () => undefined;

const ensureResolved = (workspacePath: string): Promise<string | null> => {
  if (!workspacePath) {
    return Promise.resolve(null);
  }
  const known = state.resolved[workspacePath];
  if (known) {
    return Promise.resolve(known);
  }
  const inflight = resolvePromises.get(workspacePath);
  if (inflight) {
    return inflight;
  }
  if (!state.resolving[workspacePath]) {
    commit({ resolving: { ...state.resolving, [workspacePath]: true } });
  }
  const task = window.snow
    .sshResolveProfile(workspacePath)
    .then((profileId) => {
      commitResolved(workspacePath, profileId);
      return profileId;
    })
    .catch(() => {
      commitResolved(workspacePath, "");
      return null;
    })
    .finally(() => {
      resolvePromises.delete(workspacePath);
      const nextResolving = { ...state.resolving };
      delete nextResolving[workspacePath];
      commit({ resolving: nextResolving });
    });
  resolvePromises.set(workspacePath, task);
  return task;
};

const getStatus = (workspacePath: string): SshConnectionStatus | null => {
  if (!workspacePath) {
    return null;
  }
  const profileId = state.resolved[workspacePath];
  if (profileId === undefined) {
    return state.resolving[workspacePath] ? "connecting" : null;
  }
  if (!profileId) {
    return "idle";
  }
  return state.profiles[profileId]?.status ?? "idle";
};

// ===== 工作区连接的完整快照（Git 面板等需要 profile 与连接代际） =====

export type SshWorkspaceConnectionInfo = {
  /** 解析出的 profile ID；未解析成功时为 null。 */
  profileId: string | null;
  status: SshConnectionStatus | null;
  /** 每次成功建连后自增：同路径重连也能被识别为新连接。 */
  generation: number;
  lastError: string | null;
  /** 工作区 → profile 的解析仍在进行。 */
  resolving: boolean;
};

// useSyncExternalStore 要求快照引用稳定：同一 revision 内复用同一对象，
// 连接状态或解析进度变化（commit 推进 revision）时才重新计算。
const connectionInfoCache = new Map<
  string,
  { revision: number; info: SshWorkspaceConnectionInfo }
>();

const getConnectionInfo = (
  workspacePath: string,
): SshWorkspaceConnectionInfo => {
  const cached = connectionInfoCache.get(workspacePath);
  if (cached && cached.revision === state.revision) {
    return cached.info;
  }
  const profileId = state.resolved[workspacePath] ?? null;
  const profile = profileId ? (state.profiles[profileId] ?? null) : null;
  const info: SshWorkspaceConnectionInfo = {
    profileId,
    status: getStatus(workspacePath),
    generation: profile?.generation ?? 0,
    lastError: profile?.lastError ?? null,
    resolving: state.resolving[workspacePath] === true,
  };
  connectionInfoCache.set(workspacePath, { revision: state.revision, info });
  return info;
};

/**
 * SSH 工作区的完整连接快照；非 `ssh://` 路径返回 null。
 *
 * 与 `useSshConnectionStatus` 的区别：这里额外提供 profileId、generation 与
 * lastError，供需要「连接身份」调用方（如 Git 面板按重连代际重新加载）使用。
 * 只读取共享状态，不在这里发起建连。
 */
export const useSshWorkspaceConnection = (
  workspacePath: string | null | undefined,
): SshWorkspaceConnectionInfo | null => {
  const path =
    workspacePath && workspacePath.startsWith("ssh://") ? workspacePath : "";
  const info = useSyncExternalStore(path ? subscribe : subscribeNothing, () =>
    path ? getConnectionInfo(path) : null,
  );
  useEffect(() => {
    if (path) {
      void ensureResolved(path);
    }
  }, [path]);
  return path ? info : null;
};

let activeSequence = 0;
let activeProfileId: string | null = null;

/**
 * 活动 SSH 工作区持有 1 个连接引用：切换项目或退出时释放。
 * 这样连接不再随右侧面板挂载/卸载在 connected 与 idle 之间抖动。
 */
export const setActiveSshWorkspace = (workspacePath: string | null): void => {
  activeSequence += 1;
  const sequence = activeSequence;
  const previousProfileId = activeProfileId;
  activeProfileId = null;
  if (previousProfileId) {
    void window.snow
      .sshReleaseProfile(previousProfileId)
      .catch(() => undefined);
  }
  if (!workspacePath) {
    return;
  }
  void ensureResolved(workspacePath);
  void (async (): Promise<void> => {
    try {
      const profile =
        await window.snow.sshConnectWorkspaceProfile(workspacePath);
      commitProfile(profile);
      commitResolved(workspacePath, profile.profileId);
      if (sequence !== activeSequence) {
        void window.snow
          .sshReleaseProfile(profile.profileId)
          .catch(() => undefined);
        return;
      }
      activeProfileId = profile.profileId;
    } catch {
      // 失败状态由 ssh:profile-state 广播体现（auth_required / offline 等）。
    }
  })();
};

/** 入口被拦下时点击 = 显式重连：只对已有 profile 发起一次握手。 */
export const requestSshWorkspaceConnection = (workspacePath: string): void => {
  if (!workspacePath) {
    return;
  }
  void (async (): Promise<void> => {
    const profileId = await ensureResolved(workspacePath);
    if (!profileId) {
      return;
    }
    const snapshot = await window.snow
      .sshReconnectProfile(profileId)
      .catch(() => null);
    if (snapshot) {
      commitProfile(snapshot);
    }
  })();
};

/**
 * 运行期工作区租约：AI 回合 / 定时任务等执行器在运行期间显式持有连接，
 * 结束后调用返回的释放函数；本地项目返回 null。重复释放是安全的。
 */
export const acquireSshWorkspaceLease = async (
  workspacePath: string | undefined,
): Promise<(() => void) | null> => {
  if (!workspacePath || !workspacePath.startsWith("ssh://")) {
    return null;
  }
  try {
    const profile = await window.snow.sshConnectWorkspaceProfile(workspacePath);
    commitProfile(profile);
    commitResolved(workspacePath, profile.profileId);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      void window.snow
        .sshReleaseProfile(profile.profileId)
        .catch(() => undefined);
    };
  } catch {
    return null;
  }
};

export const useSshConnectionStatus = (
  directory: WorkspaceDirectoryRecord | null | undefined,
): SshConnectionStatus | null => {
  const workspacePath = directory?.kind === "ssh" ? directory.path : "";
  const status = useSyncExternalStore(
    workspacePath ? subscribe : subscribeNothing,
    () => getStatus(workspacePath),
  );
  useEffect(() => {
    if (workspacePath) {
      void ensureResolved(workspacePath);
    }
  }, [workspacePath]);
  return workspacePath ? status : null;
};

export const useSshWorkspaceGate = (
  directory: WorkspaceDirectoryRecord | null | undefined,
): {
  blocked: boolean;
  status: SshConnectionStatus | null;
  requestConnection: () => void;
} => {
  const status = useSshConnectionStatus(directory);
  const workspacePath = directory?.kind === "ssh" ? directory.path : "";
  const requestConnection = useCallback(() => {
    requestSshWorkspaceConnection(workspacePath);
  }, [workspacePath]);
  const blocked = workspacePath !== "" && status !== "connected";
  return {
    blocked,
    status: workspacePath ? (status ?? "connecting") : null,
    requestConnection,
  };
};
