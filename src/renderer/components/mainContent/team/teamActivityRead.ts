import { useEffect, useState } from "react";

/** 团队动态已读游标按团队存放：纯本地 UI 状态，同源窗口共享。 */
const STORAGE_PREFIX = "snow.team.activity-read-at.";

/** 本窗口广播（localStorage 的 storage 事件不会回到写入窗口）。 */
const READ_CHANGED_EVENT = "snow:team-activity-read-changed";

const storageKey = (teamId: string): string => `${STORAGE_PREFIX}${teamId}`;

/**
 * 读取已读游标（毫秒时间戳）。首次访问以当前时间作为基线，
 * 避免把加入团队前的历史动态全部算成未读。
 */
export const getTeamActivityReadAt = (teamId: string): number => {
  if (!teamId) {
    return 0;
  }
  try {
    const raw = window.localStorage.getItem(storageKey(teamId));
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    const baseline = Date.now();
    window.localStorage.setItem(storageKey(teamId), String(baseline));
    return baseline;
  } catch {
    return Date.now();
  }
};

/** 推进已读游标（只前进不后退），并通知其它团队视图刷新未读数。 */
export const markTeamActivityRead = (teamId: string, at: number): void => {
  if (!teamId || !Number.isFinite(at) || at <= 0) {
    return;
  }
  const current = getTeamActivityReadAt(teamId);
  if (at <= current) {
    return;
  }
  try {
    window.localStorage.setItem(storageKey(teamId), String(at));
  } catch {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<{ teamId: string }>(READ_CHANGED_EVENT, {
      detail: { teamId },
    }),
  );
};

/** 订阅某团队的已读游标变化；返回取消订阅函数。 */
export const subscribeTeamActivityRead = (
  teamId: string,
  listener: () => void,
): (() => void) => {
  const onLocal = (event: Event): void => {
    const detail = (event as CustomEvent<{ teamId?: string }>).detail;
    if (!detail?.teamId || detail.teamId === teamId) {
      listener();
    }
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === storageKey(teamId)) {
      listener();
    }
  };
  window.addEventListener(READ_CHANGED_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(READ_CHANGED_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
};

/** 订阅并返回当前团队的已读游标。 */
export const useTeamActivityReadAt = (teamId: string): number => {
  const [readAt, setReadAt] = useState(() => getTeamActivityReadAt(teamId));
  useEffect(() => {
    setReadAt(getTeamActivityReadAt(teamId));
    return subscribeTeamActivityRead(teamId, () =>
      setReadAt(getTeamActivityReadAt(teamId)),
    );
  }, [teamId]);
  return readAt;
};

/** 未读判定：他人产生、且晚于已读游标的动态。 */
export const isTeamEventUnread = (
  event: { at: number; authorPeerId: string },
  readAt: number,
  selfPeerId: string,
): boolean => event.authorPeerId !== selfPeerId && event.at > readAt;
