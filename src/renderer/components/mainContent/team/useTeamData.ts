import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TeamBlockedMember,
  TeamEventPayload,
  TeamInfo,
  TeamJoinRequest,
  TeamMemberRecord,
  TeamMessage,
  TeamNote,
  TeamProjectLink,
  TeamRecordKind,
  TeamState,
  TeamTask,
  TeamTopic,
} from "../../../../preload";
import { buildTeamEvents, parseRecords } from "./teamUtils";
import { isTeamEventUnread, useTeamActivityReadAt } from "./teamActivityRead";

/** 团队数据层重新加载的节流窗口：同一批变更合并为一次刷新。 */
const RELOAD_DEBOUNCE_MS = 120;

/**
 * 团队状态在渲染层发生变化的事件：本机创建 / 加入 / 退出团队或修改身份后派发，
 * 供侧边栏入口等其它团队视图立即重新解析（无需等待下一次轮询）。
 */
const TEAM_STATE_CHANGED_EVENT = "snow:team-state-changed";

/** 广播团队状态变化（渲染层内跨组件，不经过主进程）。 */
const notifyTeamStateChanged = (): void => {
  window.dispatchEvent(new CustomEvent(TEAM_STATE_CHANGED_EVENT));
};

/** 团队面板的数据入口参数。 */
export type TeamDirectory = {
  directoryId: string;
  path: string;
};

export type TeamData = {
  loading: boolean;
  /** 团队协作总开关（设置页）。 */
  enabled: boolean;
  team: TeamInfo | null;
  role: "host" | "member" | "";
  /** 队长：服务运行中；队员：已连上队长。 */
  connected: boolean;
  /** 队长：本机可连地址；队员：队长地址。 */
  endpoint: string;
  /** 队长专属：可直接分享的邀请链接。 */
  inviteLink: string;
  /** 队长专属：队长服务监听端口。 */
  hostPort: number;
  /** 当前项目下是否残留旧版基于 Git 的团队数据。 */
  legacyAvailable: boolean;
  members: TeamMemberRecord[];
  projects: TeamProjectLink[];
  tasks: TeamTask[];
  topics: TeamTopic[];
  notes: TeamNote[];
  messages: TeamMessage[];
  /** 团队动态中未读的条数（不含自己产生的动态）。 */
  activityUnreadCount: number;
  /** 队长专属：待审核的加入申请。 */
  joinRequests: TeamJoinRequest[];
  /** 队长专属：已拉黑的设备。 */
  blocklist: TeamBlockedMember[];
  /** 队员：已提交加入申请，等待队长审核。 */
  pendingJoin: boolean;
  /** 队员：加入申请被拒绝 / 被拉黑时的说明。 */
  joinRejected: string | null;
  /** 本机在团队中的身份。 */
  me: { peerId: string; name: string; color: string };
  error: string | null;
  refresh: () => Promise<void>;
  createTeam: (
    name: string,
    selfName: string,
    selfColor: string,
  ) => Promise<void>;
  joinTeam: (
    inviteLink: string,
    selfName: string,
    selfColor: string,
  ) => Promise<"joined" | "pending">;
  leaveTeam: () => Promise<void>;
  disbandTeam: () => Promise<void>;
  cancelJoin: () => Promise<void>;
  setProfile: (name: string, color: string) => Promise<void>;
  respondJoinRequest: (requestId: string, approve: boolean) => Promise<void>;
  resetInvite: () => Promise<void>;
  setHostPort: (port: number) => Promise<void>;
  blockMember: (peerId: string) => Promise<void>;
  unblockMember: (clientId: string) => Promise<void>;
  removeMember: (peerId: string) => Promise<void>;
  publish: <T extends object>(
    kind: TeamRecordKind,
    id: string,
    record: T,
  ) => Promise<void>;
  remove: (kind: TeamRecordKind, id: string) => Promise<void>;
  saveMedia: (
    ownerId: string,
    fileName: string,
    base64: string,
    imageOnly: boolean,
  ) => Promise<string>;
  readMedia: (mediaId: string) => Promise<string>;
  deleteMedia: (ownerId: string) => Promise<boolean>;
  clearError: () => void;
  clearJoinRejected: () => void;
};

const loadKind = async <T>(
  teamId: string,
  kind: TeamRecordKind,
): Promise<T[]> => {
  try {
    return parseRecords<T>(await window.snow.teamListRecords(teamId, kind));
  } catch {
    return [];
  }
};

/** 读取团队黑名单（队长专属；失败时静默返回空列表）。 */
const loadBlocklist = async (teamId: string): Promise<TeamBlockedMember[]> => {
  try {
    return await window.snow.teamListBlocklist(teamId);
  } catch {
    return [];
  }
};

/**
 * 团队数据层：所有团队数据来自本机数据库，队长设备通过 WebSocket 服务把
 * 变更广播给在线队员（队员侧由 Rust 客户端写库后推送事件）。
 */
export const useTeamData = (directory: TeamDirectory | null): TeamData => {
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<TeamState | null>(null);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [topics, setTopics] = useState<TeamTopic[]>([]);
  const [notes, setNotes] = useState<TeamNote[]>([]);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [blocklist, setBlocklist] = useState<TeamBlockedMember[]>([]);
  /** 队员：加入申请被拒绝 / 被拉黑时的说明（等待状态以 Rust 侧为准）。 */
  const [joinRejected, setJoinRejected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const teamId = state?.team?.teamId ?? "";
  const teamIdRef = useRef(teamId);
  teamIdRef.current = teamId;
  const reloadTimerRef = useRef<number | null>(null);

  // 动态未读数：事件流与已读游标都在渲染层推导，游标按团队本地持久化。
  const selfPeerId = state?.team?.selfPeerId ?? "";
  const activityReadAt = useTeamActivityReadAt(teamId);
  const activityEvents = useMemo(
    () =>
      buildTeamEvents({
        messages,
        tasks,
        topics,
        notes,
        members: state?.members ?? [],
      }),
    [messages, tasks, topics, notes, state?.members],
  );
  const activityUnreadCount = useMemo(
    () =>
      activityEvents.reduce(
        (count, event) =>
          count +
          (isTeamEventUnread(event, activityReadAt, selfPeerId) ? 1 : 0),
        0,
      ),
    [activityEvents, activityReadAt, selfPeerId],
  );

  const loadRecords = useCallback(async (id: string) => {
    if (!id) {
      setTasks([]);
      setTopics([]);
      setNotes([]);
      setMessages([]);
      return;
    }
    const [taskList, topicList, noteList, messageList] = await Promise.all([
      loadKind<TeamTask>(id, "task"),
      loadKind<TeamTopic>(id, "topic"),
      loadKind<TeamNote>(id, "note"),
      loadKind<TeamMessage>(id, "message"),
    ]);
    setTasks(taskList);
    setTopics(topicList);
    setNotes(noteList);
    setMessages(messageList);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!directory) {
      setState(null);
      setBlocklist([]);
      await loadRecords("");
      return;
    }
    setLoading(true);
    try {
      const next = await window.snow.teamGetState(
        directory.directoryId,
        directory.path,
      );
      setState(next);
      setError(null);
      if (next.team) {
        setJoinRejected(null);
      }
      setBlocklist(
        next.role === "host" && next.team
          ? await loadBlocklist(next.team.teamId)
          : [],
      );
      await loadRecords(next.team?.teamId ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [directory, loadRecords]);

  /** 事件驱动的数据刷新（合并同一批变更）。 */
  const scheduleReload = useCallback(
    (payload?: TeamEventPayload): void => {
      if (payload) {
        if (payload.event === "error") {
          try {
            const parsed = JSON.parse(payload.payloadJson) as {
              message?: string;
            };
            setError(parsed.message ?? "团队操作失败");
          } catch {
            setError("团队操作失败");
          }
          return;
        }
        if (payload.event === "join-pending") {
          // 队员：已提交加入申请，等待队长审核（等待状态由 teamGetState 返回）
          setJoinRejected(null);
        }
        if (payload.event === "join-rejected") {
          // 队员：申请被拒绝或已被拉黑
          try {
            const parsed = JSON.parse(payload.payloadJson) as {
              message?: string;
            };
            setJoinRejected(parsed.message ?? "加入申请未通过");
          } catch {
            setJoinRejected("加入申请未通过");
          }
        }
        if (
          payload.event === "record-upserted" ||
          payload.event === "record-deleted"
        ) {
          let kind: TeamRecordKind | null = null;
          try {
            kind =
              (JSON.parse(payload.payloadJson) as { kind?: TeamRecordKind })
                .kind ?? null;
          } catch {
            kind = null;
          }
          const id = teamIdRef.current;
          if (id && kind) {
            if (kind === "note") {
              // 其他成员改动笔记：同步重建本机关联项目的团队知识 Skill
              void window.snow.teamSyncKnowledge(id).catch(() => undefined);
            }
            void refreshRecordsForKind(id, kind, {
              setTasks,
              setTopics,
              setNotes,
              setMessages,
            });
            return;
          }
        }
      }
      if (reloadTimerRef.current !== null) {
        return;
      }
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        void refresh();
      }, RELOAD_DEBOUNCE_MS);
    },
    [refresh],
  );

  // 首次加载 + 目录切换
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 订阅 Rust 团队事件
  useEffect(() => {
    const unsubscribe = window.snow.onTeamEvent((payload) => {
      const current = teamIdRef.current;
      // 队员待审核期间本机还没有团队 id：此时不做过滤，交给数据层刷新。
      if (payload.teamId && current && payload.teamId !== current) {
        return;
      }
      scheduleReload(payload);
    });
    return unsubscribe;
  }, [scheduleReload]);

  useEffect(
    () => () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    },
    [],
  );

  const createTeam = useCallback(
    async (
      name: string,
      selfName: string,
      selfColor: string,
    ): Promise<void> => {
      if (!directory) {
        throw new Error("请先打开一个项目");
      }
      await window.snow.teamCreateTeam(
        directory.directoryId,
        directory.path,
        name,
        selfName,
        selfColor,
      );
      notifyTeamStateChanged();
      await refresh();
    },
    [directory, refresh],
  );

  const joinTeam = useCallback(
    async (
      inviteLink: string,
      selfName: string,
      selfColor: string,
    ): Promise<"joined" | "pending"> => {
      if (!directory) {
        throw new Error("请先打开一个项目");
      }
      const result = await window.snow.teamJoinTeam(
        inviteLink,
        selfName,
        selfColor,
        directory.directoryId,
        directory.path,
      );
      // 首次加入需要队长审核：长连接在后台等待审核结果。
      // 无论直接加入还是待审核，都重新读取状态（待审核标记由 Rust 侧维护）。
      notifyTeamStateChanged();
      setJoinRejected(null);
      await refresh();
      return result.status;
    },
    [directory, refresh],
  );

  const leaveTeam = useCallback(async (): Promise<void> => {
    const id = teamIdRef.current;
    if (!id) {
      return;
    }
    await window.snow.teamLeaveTeam(id);
    notifyTeamStateChanged();
    await refresh();
  }, [refresh]);

  const disbandTeam = useCallback(async (): Promise<void> => {
    const id = teamIdRef.current;
    if (!id) {
      return;
    }
    await window.snow.teamDisbandTeam(id);
    notifyTeamStateChanged();
    await refresh();
  }, [refresh]);

  /** 放弃等待审核的加入申请，回到「创建 / 加入」界面。 */
  const cancelJoin = useCallback(async (): Promise<void> => {
    await window.snow.teamCancelJoin();
    setJoinRejected(null);
    await refresh();
  }, [refresh]);

  const setProfile = useCallback(
    async (name: string, color: string): Promise<void> => {
      const id = teamIdRef.current;
      if (!id) {
        return;
      }
      await window.snow.teamSetProfile(id, name, color);
      notifyTeamStateChanged();
      await refresh();
    },
    [refresh],
  );

  const respondJoinRequest = useCallback(
    async (requestId: string, approve: boolean): Promise<void> => {
      const id = teamIdRef.current;
      if (!id) {
        return;
      }
      await window.snow.teamRespondJoinRequest(id, requestId, approve);
      await refresh();
    },
    [refresh],
  );

  const resetInvite = useCallback(async (): Promise<void> => {
    const id = teamIdRef.current;
    if (!id) {
      return;
    }
    await window.snow.teamResetInvite(id);
    await refresh();
  }, [refresh]);

  const blockMember = useCallback(
    async (peerId: string): Promise<void> => {
      const id = teamIdRef.current;
      if (!id) {
        return;
      }
      await window.snow.teamBlockMember(id, peerId);
      await refresh();
    },
    [refresh],
  );

  const removeMember = useCallback(
    async (peerId: string): Promise<void> => {
      const id = teamIdRef.current;
      if (!id) {
        return;
      }
      await window.snow.teamRemoveMember(id, peerId);
      await refresh();
    },
    [refresh],
  );

  const unblockMember = useCallback(
    async (clientId: string): Promise<void> => {
      const id = teamIdRef.current;
      if (!id) {
        return;
      }
      await window.snow.teamUnblockMember(id, clientId);
      await refresh();
    },
    [refresh],
  );

  const setHostPort = useCallback(
    async (port: number): Promise<void> => {
      const id = teamIdRef.current;
      if (!id) {
        return;
      }
      try {
        await window.snow.teamSetHostPort(id, port);
      } finally {
        // 失败时服务可能已回退到原端口，同样需要刷新状态
        await refresh();
      }
    },
    [refresh],
  );

  const publish = useCallback(
    async <T extends object>(
      kind: TeamRecordKind,
      id: string,
      record: T,
    ): Promise<void> => {
      const current = teamIdRef.current;
      if (!current) {
        throw new Error("团队尚未就绪");
      }
      await window.snow.teamUpsertRecord(
        current,
        kind,
        id,
        JSON.stringify(record),
      );
      if (kind === "note") {
        // 笔记变更后重建关联项目的「团队项目知识」Skill
        void window.snow.teamSyncKnowledge(current).catch(() => undefined);
      }
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (kind: TeamRecordKind, id: string): Promise<void> => {
      const current = teamIdRef.current;
      if (!current) {
        throw new Error("团队尚未就绪");
      }
      await window.snow.teamDeleteRecord(current, kind, id);
      if (kind === "note") {
        void window.snow.teamSyncKnowledge(current).catch(() => undefined);
      }
      await refresh();
    },
    [refresh],
  );

  const saveMedia = useCallback(
    async (
      ownerId: string,
      fileName: string,
      base64: string,
      imageOnly: boolean,
    ): Promise<string> => {
      const current = teamIdRef.current;
      if (!current) {
        throw new Error("团队尚未就绪");
      }
      return window.snow.teamSaveMedia(
        current,
        ownerId,
        fileName,
        base64,
        imageOnly,
      );
    },
    [],
  );

  const readMedia = useCallback(async (mediaId: string): Promise<string> => {
    const current = teamIdRef.current;
    if (!current) {
      throw new Error("团队尚未就绪");
    }
    return window.snow.teamReadMedia(current, mediaId);
  }, []);

  const deleteMedia = useCallback(async (ownerId: string): Promise<boolean> => {
    const current = teamIdRef.current;
    if (!current) {
      return false;
    }
    return window.snow.teamDeleteMedia(current, ownerId);
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const clearJoinRejected = useCallback(() => setJoinRejected(null), []);

  const me = {
    peerId: state?.team?.selfPeerId ?? "",
    name: state?.team?.selfName ?? "",
    color: state?.team?.selfColor ?? "",
  };

  return {
    loading,
    enabled: state?.enabled ?? false,
    team: state?.team ?? null,
    role: (state?.role as "host" | "member" | "") ?? "",
    connected: state?.connected ?? false,
    endpoint: state?.endpoint ?? "",
    inviteLink: state?.inviteLink ?? "",
    hostPort: state?.hostPort ?? 0,
    legacyAvailable: state?.legacyAvailable ?? false,
    members: state?.members ?? [],
    projects: state?.projects ?? [],
    tasks,
    topics,
    notes,
    messages,
    activityUnreadCount,
    joinRequests: state?.joinRequests ?? [],
    blocklist,
    pendingJoin: state?.pendingJoin ?? false,
    joinRejected,
    me,
    error,
    refresh,
    createTeam,
    joinTeam,
    leaveTeam,
    disbandTeam,
    cancelJoin,
    setProfile,
    respondJoinRequest,
    resetInvite,
    setHostPort,
    blockMember,
    unblockMember,
    removeMember,
    publish,
    remove,
    saveMedia,
    readMedia,
    deleteMedia,
    clearError,
    clearJoinRejected,
  };
};

/** 团队协作总开关的系统设置 code（与 Rust 侧 `team::TEAM_ENABLED_SETTING` 一致）。 */
export const TEAM_ENABLED_SETTING = "team_collaboration_enabled";

/** 团队入口需要重新解析状态的事件：开关切换后派发。 */
export const TEAM_ENABLED_CHANGED_EVENT = "snow:team-enabled-changed";

/**
 * 侧边栏入口用的轻量摘要：当前项目所属团队 + 任务 / 议题 / 动态未读数量。
 * 本机创建 / 加入 / 退出团队或修改身份（`TEAM_STATE_CHANGED_EVENT`）、远端团队事件
 * 到达时立即重新解析，因此头像与徽标无需等待轮询；`refreshKey` 变化同样强制刷新
 * （团队协作开关切换后由侧边栏传入递增计数）。
 */
export const useTeamSummary = (
  directoryId: string,
  directoryPath: string,
  refreshKey = 0,
): {
  team: TeamInfo | null;
  enabled: boolean;
  /** 指派给我且未完成的任务 + 待我表态的议题。 */
  pendingCount: number;
  /** 团队动态中他人的未读条目数。 */
  unreadCount: number;
  /** 侧边栏入口使用的累计红点数量（动态 + 任务 + 议题 + 加入申请）。 */
  totalCount: number;
  loading: boolean;
} => {
  const [state, setState] = useState<TeamState | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  /** 动态事件的最小快照：未读数只依赖时间与作者，不保留完整记录。 */
  const [activityEvents, setActivityEvents] = useState<
    { at: number; authorPeerId: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  /** 请求序号：并发刷新时只采纳最后一次结果，避免旧快照覆盖新状态。 */
  const requestSeqRef = useRef(0);
  const reloadTimerRef = useRef<number | null>(null);

  const teamId = state?.team?.teamId ?? "";
  const selfPeerId = state?.team?.selfPeerId ?? "";
  const activityReadAt = useTeamActivityReadAt(teamId);

  const load = useCallback(async (): Promise<void> => {
    if (!directoryId) {
      return;
    }
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setLoading(true);
    try {
      const next = await window.snow.teamGetState(directoryId, directoryPath);
      if (seq !== requestSeqRef.current) {
        return;
      }
      setState(next);
      const id = next.team?.teamId ?? "";
      if (!id) {
        setPendingCount(0);
        setActivityEvents([]);
        return;
      }
      const [tasks, topics, notes, messages] = await Promise.all([
        window.snow.teamListRecords(id, "task").catch(() => []),
        window.snow.teamListRecords(id, "topic").catch(() => []),
        window.snow.teamListRecords(id, "note").catch(() => []),
        window.snow.teamListRecords(id, "message").catch(() => []),
      ]);
      if (seq !== requestSeqRef.current) {
        return;
      }
      const me = next.team?.selfPeerId ?? "";
      const taskList = parseRecords<TeamTask>(tasks);
      const topicList = parseRecords<TeamTopic>(topics);
      const mineTasks = taskList.filter(
        (task) => task.assigneePeerId === me && task.status !== "done",
      ).length;
      // 待我表态：尚未定案且我还没投票的议题
      const myTopics = topicList.filter(
        (topic) =>
          !topic.veto && !topic.votes.some((vote) => vote.peerId === me),
      ).length;
      setPendingCount(mineTasks + myTopics);
      setActivityEvents(
        buildTeamEvents({
          messages: parseRecords<TeamMessage>(messages),
          tasks: taskList,
          topics: topicList,
          notes: parseRecords<TeamNote>(notes),
          members: next.members ?? [],
        }).map((event) => ({ at: event.at, authorPeerId: event.authorPeerId })),
      );
    } catch {
      // 静默：入口不因单次读取失败而闪烁
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [directoryId, directoryPath]);

  /** 事件驱动的刷新（合并同一批变更，避免重复查询）。 */
  const scheduleLoad = useCallback((): void => {
    if (reloadTimerRef.current !== null) {
      return;
    }
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null;
      void load();
    }, RELOAD_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    if (!directoryId) {
      setState(null);
      setPendingCount(0);
      setActivityEvents([]);
      return;
    }
    void load();
    const timer = window.setInterval(() => void load(), 45_000);
    return () => window.clearInterval(timer);
  }, [directoryId, load, refreshKey]);

  // 团队状态变化即时刷新入口：本机创建 / 加入 / 退出 / 修改身份由渲染层事件通知，
  // 远端成员与快照变更由 Rust 事件推送。
  useEffect(() => {
    if (!directoryId) {
      return undefined;
    }
    window.addEventListener(TEAM_STATE_CHANGED_EVENT, scheduleLoad);
    const unsubscribe = window.snow.onTeamEvent(scheduleLoad);
    return () => {
      window.removeEventListener(TEAM_STATE_CHANGED_EVENT, scheduleLoad);
      unsubscribe();
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [directoryId, scheduleLoad]);

  const unreadCount = useMemo(
    () =>
      activityEvents.reduce(
        (count, event) =>
          count +
          (isTeamEventUnread(event, activityReadAt, selfPeerId) ? 1 : 0),
        0,
      ),
    [activityEvents, activityReadAt, selfPeerId],
  );

  return {
    team: state?.team ?? null,
    enabled: state?.enabled ?? false,
    pendingCount,
    unreadCount,
    totalCount:
      pendingCount +
      unreadCount +
      (state?.role === "host" ? (state.joinRequests?.length ?? 0) : 0),
    loading,
  };
};

/** 按记录类型刷新对应列表（避免整块数据重取）。 */
const refreshRecordsForKind = async (
  teamId: string,
  kind: TeamRecordKind,
  setters: {
    setTasks: (value: TeamTask[]) => void;
    setTopics: (value: TeamTopic[]) => void;
    setNotes: (value: TeamNote[]) => void;
    setMessages: (value: TeamMessage[]) => void;
  },
): Promise<void> => {
  if (kind === "task") {
    setters.setTasks(await loadKind<TeamTask>(teamId, "task"));
  } else if (kind === "topic") {
    setters.setTopics(await loadKind<TeamTopic>(teamId, "topic"));
  } else if (kind === "note") {
    setters.setNotes(await loadKind<TeamNote>(teamId, "note"));
  } else if (kind === "message") {
    setters.setMessages(await loadKind<TeamMessage>(teamId, "message"));
  }
};
