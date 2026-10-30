import type { TaskManagerProcess } from "../../../preload";
import type { LspSessionStatus } from "../../../preload/types/lsp";
import { formatDisplayPath } from "../../utils/formatDisplayPath";

export const LSP_REFRESH_INTERVAL_MS = 5000;
// A short bounded window, not lastUsedMs: an idle, healthy server is still running.
export const SNAPSHOT_FRESHNESS_MS = 15000;

export type SessionSnapshot = {
  sessions: LspSessionStatus[];
  receivedAtMs: number;
  rootIdentities: Map<number, string>;
};

export type TaskManagerRow = TaskManagerProcess & {
  lspSession?: LspSessionStatus;
  lspRootPid?: number;
};

/** Identity check only; executable names are never used to infer project ownership. */
export const processIdentity = (process: TaskManagerProcess): string =>
  JSON.stringify([
    process.pid,
    process.parentPid,
    process.name,
    process.exePath,
    process.kind,
  ]);

export const uniqueProcesses = (
  processes: TaskManagerProcess[],
): TaskManagerProcess[] => [
  ...new Map(processes.map((process) => [process.pid, process])).values(),
];

export const captureSessions = (
  sessions: LspSessionStatus[],
  processes: TaskManagerProcess[],
  receivedAtMs: number,
): SessionSnapshot => {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const rootIdentities = new Map<number, string>();
  for (const session of sessions) {
    const pid = session.resources?.pid;
    const process = pid == null ? undefined : byPid.get(pid);
    if (session.status === "running" && process?.kind === "child") {
      rootIdentities.set(process.pid, processIdentity(process));
    }
  }
  return { sessions, receivedAtMs, rootIdentities };
};

/** A disappeared/changed root stays invalid until a new LSP snapshot verifies it again. */
export const reconcileSessionRoots = (
  snapshot: SessionSnapshot,
  processes: TaskManagerProcess[],
): SessionSnapshot => {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const rootIdentities = new Map(snapshot.rootIdentities);
  for (const [pid, identity] of rootIdentities) {
    const process = byPid.get(pid);
    if (!process || processIdentity(process) !== identity)
      rootIdentities.delete(pid);
  }
  return { ...snapshot, rootIdentities };
};

export const sessionSampleIsFresh = (
  session: LspSessionStatus,
  now: number,
): boolean => {
  const sampledAt = session.resources?.sampledAtMs;
  return (
    sampledAt != null &&
    Number.isFinite(sampledAt) &&
    sampledAt > 0 &&
    sampledAt <= now + 1000 &&
    now - sampledAt <= SNAPSHOT_FRESHNESS_MS
  );
};

/** Nearest verified LSP ancestor wins. Missing parents and cycles end the walk safely. */
export const associateLspProcesses = (
  processes: TaskManagerProcess[],
  snapshot: SessionSnapshot | null,
  now: number,
  stale: boolean,
): TaskManagerRow[] => {
  const unique = uniqueProcesses(processes);
  const byPid = new Map(unique.map((process) => [process.pid, process]));
  const roots = new Map<number, LspSessionStatus>();
  const ambiguous = new Set<number>();
  const boundaries = new Set<number>();
  for (const session of snapshot?.sessions ?? []) {
    const pid = session.resources?.pid;
    if (pid == null) continue;
    if (boundaries.has(pid)) ambiguous.add(pid);
    boundaries.add(pid);
  }
  if (
    snapshot &&
    !stale &&
    now - snapshot.receivedAtMs <= SNAPSHOT_FRESHNESS_MS
  ) {
    for (const session of snapshot.sessions) {
      const pid = session.resources?.pid;
      if (
        session.status !== "running" ||
        pid == null ||
        !sessionSampleIsFresh(session, now)
      )
        continue;
      const process = byPid.get(pid);
      if (
        !process ||
        snapshot.rootIdentities.get(pid) !== processIdentity(process)
      )
        continue;
      // Duplicate roots are ambiguous, even if metadata happens to look similar.
      if (roots.has(pid)) ambiguous.add(pid);
      else roots.set(pid, session);
    }
    for (const pid of ambiguous) roots.delete(pid);
  }
  return unique.map((process) => {
    const seen = new Set<number>();
    let cursor: TaskManagerProcess | undefined = process;
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      if (ambiguous.has(cursor.pid)) break;
      const session = roots.get(cursor.pid);
      if (session)
        return { ...process, lspSession: session, lspRootPid: cursor.pid };
      // A known but unverified session root must not fall through into an outer session.
      if (boundaries.has(cursor.pid)) break;
      cursor = byPid.get(cursor.parentPid);
    }
    return process;
  });
};

/** Own-process samples only. Never add native Job totals (which include exited children). */
export const summarizeProcesses = (processes: TaskManagerProcess[]) => {
  let memory = 0;
  let cpu = 0;
  let cpuSamples = 0;
  for (const process of processes) {
    memory += process.memoryBytes;
    if (process.cpuPercent >= 0) {
      cpu += process.cpuPercent;
      cpuSamples += 1;
    }
  }
  return { memory, cpu, cpuSamples, count: processes.length };
};

/** UI comparison only: retain the original physical root when calling lifecycle APIs. */
export const normalizeTaskProject = (root: string): string => {
  let normalized = root.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(normalized))
    normalized = `//${normalized.slice(8)}`;
  else if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  normalized = normalized.replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
};

export type ProcessFilter = {
  query: string;
  kind: "all" | "lsp";
  project: string;
};
export const filterTaskProcesses = (
  rows: TaskManagerRow[],
  filter: ProcessFilter,
): TaskManagerRow[] => {
  const search = filter.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filter.kind === "lsp" && !row.lspSession) return false;
    if (
      filter.project &&
      (!row.lspSession ||
        normalizeTaskProject(row.lspSession.projectRoot) !== filter.project)
    )
      return false;
    return (
      !search ||
      [
        row.title,
        row.serviceName,
        row.name,
        row.pid,
        row.parentPid,
        row.lspSession?.lang,
        row.lspSession?.projectRoot,
        row.lspSession && formatDisplayPath(row.lspSession.projectRoot),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search)
    );
  });
};

export type ProcessForest = {
  roots: TaskManagerRow[];
  children: Map<number, TaskManagerRow[]>;
};

/** Build only from matched rows. Break one deterministic edge per cycle; every PID stays once. */
export const buildProcessForest = (
  sortedRows: TaskManagerRow[],
): ProcessForest => {
  const rows = [...new Map(sortedRows.map((row) => [row.pid, row])).values()];
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const parents = new Map<number, number>();
  for (const row of rows) {
    if (row.parentPid !== row.pid && byPid.has(row.parentPid))
      parents.set(row.pid, row.parentPid);
  }
  const done = new Set<number>();
  for (const row of rows) {
    if (done.has(row.pid)) continue;
    const chain: number[] = [];
    const positions = new Map<number, number>();
    let cursor: number | undefined = row.pid;
    while (cursor != null && !done.has(cursor) && !positions.has(cursor)) {
      positions.set(cursor, chain.length);
      chain.push(cursor);
      cursor = parents.get(cursor);
    }
    if (cursor != null && positions.has(cursor)) {
      const cycle = chain.slice(positions.get(cursor)!);
      parents.delete(
        cycle.reduce((minimum, pid) => Math.min(minimum, pid), cycle[0]),
      );
    }
    for (const pid of chain) done.add(pid);
  }
  const roots: TaskManagerRow[] = [];
  const children = new Map<number, TaskManagerRow[]>();
  for (const row of rows) {
    const parent = parents.get(row.pid);
    if (parent == null) roots.push(row);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(row);
      children.set(parent, siblings);
    }
  }
  return { roots, children };
};

export const flattenProcessForest = (
  forest: ProcessForest,
  collapsed: ReadonlySet<number>,
) => {
  const result: {
    process: TaskManagerRow;
    depth: number;
    hasChildren: boolean;
  }[] = [];
  const stack = forest.roots
    .map((process) => ({ process, depth: 0 }))
    .reverse();
  const seen = new Set<number>();
  while (stack.length) {
    const item = stack.pop()!;
    if (seen.has(item.process.pid)) continue;
    seen.add(item.process.pid);
    const children = forest.children.get(item.process.pid) ?? [];
    result.push({ ...item, hasChildren: children.length > 0 });
    if (!collapsed.has(item.process.pid)) {
      for (let index = children.length - 1; index >= 0; index -= 1)
        stack.push({ process: children[index], depth: item.depth + 1 });
    }
  }
  return result;
};
