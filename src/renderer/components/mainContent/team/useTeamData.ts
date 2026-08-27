import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TeamIdentity,
  TeamMember,
  TeamMessage,
  TeamNote,
  TeamRecordKind,
  TeamReview,
  TeamSyncResult,
  TeamTask,
} from "../../../../preload";
import { parseRecords } from "./teamUtils";

const SYNC_INTERVAL_MS = 30_000;

/** 团队协作启停开关变化事件：设置面板切换后派发，侧边栏监听并刷新入口。 */
export const TEAM_ENABLED_CHANGED_EVENT = "snow:team-enabled-changed";

/** 团队协作开关的系统设置 code（与 Rust 侧 team::TEAM_ENABLED_SETTING 一致）。 */
export const TEAM_ENABLED_SETTING = "team_collaboration_enabled";

/** 团队功能诊断日志：内联 JSON 输出到控制台（不折叠），并尝试写入 app 日志。 */
export const teamLog = (message: string, context?: unknown): void => {
  const inline =
    context === undefined
      ? ""
      : typeof context === "string"
        ? context
        : JSON.stringify(context);
  void window.snow
    .writeLog("INFO", {
      module: "team",
      func: "renderer",
      message,
      context: inline || undefined,
      source: "renderer",
    })
    .catch(() => undefined);
};

/** publish 结果：本地写入始终成功后，附带远端推送是否成功。 */
export type TeamPublishResult = {
  ok: boolean;
  pushed: boolean;
  error: string | null;
};

export type TeamData = {
  repoPath: string;
  identity: TeamIdentity | null;
  identityResolving: boolean;
  syncResult: TeamSyncResult | null;
  syncing: boolean;
  lastSyncAt: number | null;
  error: string | null;
  members: TeamMember[];
  tasks: TeamTask[];
  reviews: TeamReview[];
  notes: TeamNote[];
  messages: TeamMessage[];
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  publish: <T extends object>(
    kind: TeamRecordKind,
    id: string,
    record: T,
  ) => Promise<TeamPublishResult>;
  remove: (kind: TeamRecordKind, id: string) => Promise<TeamPublishResult>;
  clearError: () => void;
};

const loadKind = async <T>(
  repoPath: string,
  kind: TeamRecordKind,
): Promise<T[]> => {
  try {
    const raw = await window.snow.teamList(repoPath, kind);
    return parseRecords<T>(raw);
  } catch {
    return [];
  }
};

/**
 * 团队数据层。仓库路径由 Rust 侧 `teamGetIdentity` 自动定位（无论工作区是
 * 仓库根、仓库子目录还是包含仓库的父目录，都能解析出真实仓库根），此处
 * 直接使用返回的 `repoPath`，不依赖渲染层自行判断。
 */
export const useTeamData = (workspacePath: string): TeamData => {
  const instanceId = useRef(`td-${Math.random().toString(36).slice(2, 7)}`);
  // 上一个工作区的身份缓存：切换工作区期间保留旧值，避免闪回设置视图
  const [identity, setIdentity] = useState<TeamIdentity | null>(null);
  const [identityWorkspace, setIdentityWorkspace] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [syncResult, setSyncResult] = useState<TeamSyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [reviews, setReviews] = useState<TeamReview[]>([]);
  const [notes, setNotes] = useState<TeamNote[]>([]);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const inFlightRef = useRef(false);

  // 解析身份与真实仓库路径（Rust 自动定位）
  useEffect(() => {
    if (!workspacePath) {
      setIdentity(null);
      setIdentityWorkspace("");
      setRepoPath("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const current = await window.snow.teamGetIdentity(workspacePath);
        if (cancelled) {
          return;
        }
        setIdentity(current);
        setIdentityWorkspace(workspacePath);
        setRepoPath(current.isRepo ? current.repoPath : "");
      } catch (e) {
        teamLog(`useTeamData.identityError#${instanceId.current}`, {
          error: e instanceof Error ? e.message : String(e),
        });
        if (cancelled) {
          return;
        }
        setIdentity(null);
        setIdentityWorkspace(workspacePath);
        setRepoPath("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const loadAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!repoPath) {
        return;
      }
      try {
        const current = await window.snow.teamGetIdentity(repoPath);
        setIdentity(current);
        if (!current.isRepo || !current.hasIdentity) {
          return;
        }
        const [memberList, taskList, reviewList, noteList, messageList] =
          await Promise.all([
            loadKind<TeamMember>(repoPath, "member"),
            loadKind<TeamTask>(repoPath, "task"),
            loadKind<TeamReview>(repoPath, "review"),
            loadKind<TeamNote>(repoPath, "note"),
            loadKind<TeamMessage>(repoPath, "message"),
          ]);
        setMembers(memberList);
        setTasks(taskList);
        setReviews(reviewList);
        setNotes(noteList);
        setMessages(messageList);
      } catch (e) {
        if (!opts?.silent) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [repoPath],
  );

  const sync = useCallback(async (): Promise<void> => {
    if (!repoPath || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setSyncing(true);
    try {
      const result = await window.snow.teamSync(repoPath);
      setSyncResult(result);
      setLastSyncAt(Date.now());
      if (result.error) {
        setError(result.error);
      }
      await loadAll({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
      setSyncing(false);
    }
  }, [repoPath, loadAll]);

  const refresh = useCallback(async (): Promise<void> => {
    await loadAll();
  }, [loadAll]);

  // 写入/删除后尽力推送远端，推送结果回传给调用方（用于消息发送态展示）
  const pushToRemote = useCallback(async (): Promise<TeamPublishResult> => {
    try {
      const result = await window.snow.teamSync(repoPath);
      const failure = result.ok
        ? result.error
        : (result.error ?? "sync failed");
      return { ok: !failure, pushed: result.pushed, error: failure ?? null };
    } catch (e) {
      return {
        ok: false,
        pushed: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, [repoPath]);

  const publish = useCallback(
    async <T extends object>(
      kind: TeamRecordKind,
      id: string,
      record: T,
    ): Promise<TeamPublishResult> => {
      if (!repoPath) {
        return { ok: false, pushed: false, error: "repository not ready" };
      }
      await window.snow.teamUpsert(repoPath, kind, id, JSON.stringify(record));
      const pushResult = await pushToRemote();
      await loadAll({ silent: true });
      return pushResult;
    },
    [repoPath, loadAll, pushToRemote],
  );

  const remove = useCallback(
    async (kind: TeamRecordKind, id: string): Promise<TeamPublishResult> => {
      if (!repoPath) {
        return { ok: false, pushed: false, error: "repository not ready" };
      }
      await window.snow.teamDelete(repoPath, kind, id);
      const pushResult = await pushToRemote();
      await loadAll({ silent: true });
      return pushResult;
    },
    [repoPath, loadAll, pushToRemote],
  );

  const clearError = useCallback(() => setError(null), []);

  // 当前工作区的身份尚未解析完成（首次进入或切换工作区期间）
  const identityResolving =
    workspacePath !== "" && identityWorkspace !== workspacePath;

  // 仓库就绪后：首次同步 → 加载数据；此后按固定间隔轮询同步
  useEffect(() => {
    if (!repoPath || !identity?.hasIdentity) {
      return;
    }
    let cancelled = false;
    void (async () => {
      if (cancelled) {
        return;
      }
      await sync();
    })();
    const timer = window.setInterval(() => {
      if (!cancelled) {
        void sync();
      }
    }, SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, identity?.hasIdentity]);

  return {
    repoPath,
    identity,
    identityResolving,
    syncResult,
    syncing,
    lastSyncAt,
    error,
    members,
    tasks,
    reviews,
    notes,
    messages,
    refresh,
    sync,
    publish,
    remove,
    clearError,
  };
};

/** 侧边栏入口用的轻量摘要：身份 + 待办数量。refreshKey 变化时强制重新解析身份
 * （团队协作开关切换后由侧边栏传入递增计数，实现入口即时显隐）。 */
export const useTeamSummary = (
  workspacePath: string,
  refreshKey = 0,
): {
  identity: TeamIdentity | null;
  pendingCount: number;
  loading: boolean;
} => {
  const [identity, setIdentity] = useState<TeamIdentity | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);
  // identity 通过 ref 提供给 load，避免 load 随 identity 重建 → effect
  // 重跑 → 立即再次 teamGetIdentity → setIdentity 新引用 → 无限循环
  // （此前每秒触发 7-28 次 IPC，Rust 侧每次 open_connection 读 schema，
  // 主进程 CPU 持续高位）。
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const load = useCallback(async () => {
    const repoPath = identityRef.current?.repoPath ?? "";
    if (!repoPath || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    try {
      const current = await window.snow.teamGetIdentity(repoPath);
      setIdentity(current);
      if (!current.isRepo || !current.hasIdentity) {
        setPendingCount(0);
        return;
      }
      await window.snow.teamSync(repoPath).catch(() => undefined);
      const [taskList, reviewList] = await Promise.all([
        loadKind<TeamTask>(repoPath, "task"),
        loadKind<TeamReview>(repoPath, "review"),
      ]);
      const mineTasks = taskList.filter(
        (task) =>
          task.assigneeEmail === current.email && task.status !== "done",
      ).length;
      const myReviews = reviewList.filter(
        (review) =>
          review.reviewerEmail === current.email && review.status === "pending",
      ).length;
      setPendingCount(mineTasks + myReviews);
    } catch {
      // 静默
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!workspacePath) {
      setIdentity(null);
      setPendingCount(0);
      return;
    }
    void (async () => {
      try {
        const current = await window.snow.teamGetIdentity(workspacePath);
        setIdentity(current);
      } catch {
        // 静默
      }
    })();
    const timer = window.setInterval(() => void load(), 45_000);
    return () => window.clearInterval(timer);
  }, [workspacePath, load, refreshKey]);

  return { identity, pendingCount, loading };
};
