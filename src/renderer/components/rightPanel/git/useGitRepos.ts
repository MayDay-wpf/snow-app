import { useCallback, useEffect, useRef, useState } from "react";
import type { GitRepoInfo, SshConnectionStatus } from "../../../../preload";
import { useSshWorkspaceConnection } from "../../../ssh/sshConnectionStore";

/**
 * 仓库列表所处阶段：
 * - idle：没有工作目录；
 * - waiting：SSH 正在连接／重连；
 * - disconnected：SSH 当前不可用（离线、认证失败等）；
 * - scanning：正在扫描；
 * - ready：扫描成功（可能为空列表）；
 * - error：扫描失败（可能仍展示上次成功的结果）。
 */
export type GitRepoPhase =
  "idle" | "waiting" | "disconnected" | "scanning" | "ready" | "error";

type UseGitReposResult = {
  repos: GitRepoInfo[];
  isLoading: boolean;
  phase: GitRepoPhase;
  error: string | null;
  selectedRepoPath: string | null;
  setSelectedRepoPath: (path: string | null) => void;
  /** 当前连接是否允许执行 Git 操作：本地工作区恒为 true。 */
  canOperate: boolean;
  /** 工作区 + profile + 连接代际：变化时数据子树应重新挂载。 */
  identity: string;
  sshStatus: SshConnectionStatus | null;
  /** 重新扫描仓库；返回是否扫描成功（连接不可用或失败时为 false）。 */
  refresh: () => Promise<boolean>;
};

const SSH_PREFIX = "ssh://";

const isRemotePath = (path: string): boolean => path.startsWith(SSH_PREFIX);

/**
 * Discovers all git repositories within the active workspace directory.
 *
 * 本地路径由 Rust 后端扫描；`ssh://` 路径走 SSH 扫描，并且必须等共享连接
 * store 报告 `connected` 后才发起——远程命令只在已连接时可用，扫描早于
 * 建连会被主进程拒绝（SSH_WORKSPACE_NOT_CONNECTED）。
 *
 * 每次连接成功或重连（代际变化）都会重新扫描；扫描失败保留同一工作区
 * 上次成功的结果，只有成功返回空数组才表示「确实没有仓库」。
 *
 * If multiple repos are found, the user can switch between them via the
 * RepoSelector dropdown, and the choice is remembered per workspace directory.
 */
export const useGitRepos = (
  workspacePath: string | undefined | null,
): UseGitReposResult => {
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedRepoPath, setSelectedRepoPathState] = useState<string | null>(
    null,
  );
  // 扫描结果阶段只表达「扫描本身」；等待/断连由连接状态派生，避免切换
  // 工作目录时先渲染一帧过期的扫描阶段。
  const [scanPhase, setScanPhase] = useState<
    "idle" | "scanning" | "ready" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const workspacePathRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  // 每个工作目录各自记住用户选中的仓库：面板在项目切换时保持挂载，但选中项
  // 只有一个 state，切回来时 prev 属于另一个项目，必然落到「回退第一个」的
  // 分支上。扫描完成后优先按目录恢复记忆值。
  const selectedRepoByWorkspaceRef = useRef<Map<string, string>>(new Map());
  // 每个工作目录最后一次成功扫描的结果：同一目录刷新失败时继续展示，
  // 避免把「扫描失败」误显示成「没有仓库」。
  const lastSuccessByWorkspaceRef = useRef<Map<string, GitRepoInfo[]>>(
    new Map(),
  );

  const connection = useSshWorkspaceConnection(workspacePath);
  const remote = !!workspacePath && isRemotePath(workspacePath);
  const sshStatus = remote ? (connection?.status ?? null) : null;
  const profileId = remote ? (connection?.profileId ?? "") : "";
  const generation = remote ? (connection?.generation ?? 0) : 0;
  const canOperate = !remote || sshStatus === "connected";
  // 连接身份：同一路径重连后 generation 变化，数据子树据此重新加载。
  const identity = remote
    ? `ssh:${workspacePath}:${profileId}:${generation}`
    : `local:${workspacePath ?? ""}`;
  const connecting =
    remote &&
    (sshStatus === null ||
      sshStatus === "connecting" ||
      sshStatus === "reconnecting");

  // 供异步回调读取最新的可用性判断（避免闭包拿到旧连接状态）。
  const canOperateRef = useRef(canOperate);
  canOperateRef.current = canOperate;

  const applySelection = useCallback((path: string, result: GitRepoInfo[]) => {
    const remembered = selectedRepoByWorkspaceRef.current.get(path);
    setSelectedRepoPathState((prev) => {
      if (result.length === 0) {
        return null;
      }
      if (remembered && result.some((r) => r.path === remembered)) {
        return remembered;
      }
      if (prev && result.some((r) => r.path === prev)) {
        return prev;
      }
      return result[0].path;
    });
  }, []);

  const fetchRepos = useCallback(async (): Promise<boolean> => {
    const path = workspacePathRef.current;
    if (!path) {
      setRepos([]);
      setSelectedRepoPathState(null);
      setScanPhase("idle");
      setError(null);
      setIsLoading(false);
      return false;
    }
    // 远程连接不可用时不发请求：等待连接状态变化后由 effect 触发重扫。
    if (!canOperateRef.current) {
      return false;
    }

    const myId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    setScanPhase("scanning");

    try {
      const result = await window.snow.discoverGitRepos(path);
      // 过期结果（已切目录／已重连／已卸载）直接丢弃。
      if (myId !== requestIdRef.current) {
        return false;
      }
      lastSuccessByWorkspaceRef.current.set(path, result);
      setRepos(result);
      applySelection(path, result);
      setScanPhase("ready");
      return true;
    } catch (err) {
      if (myId !== requestIdRef.current) {
        return false;
      }
      // 失败不等于空仓库：保留同一目录上次成功的结果与选中项。
      const last = lastSuccessByWorkspaceRef.current.get(path);
      if (last) {
        setRepos(last);
        applySelection(path, last);
      }
      setError(err instanceof Error ? err.message : String(err));
      setScanPhase("error");
      return false;
    } finally {
      if (myId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [applySelection]);

  // 切换工作目录：立即清空上一个目录的可见数据，并让在途扫描结果失效。
  useEffect(() => {
    workspacePathRef.current = workspacePath ?? null;
    requestIdRef.current += 1;
    setRepos([]);
    setSelectedRepoPathState(null);
    setError(null);
    setScanPhase("idle");
    setIsLoading(false);
  }, [workspacePath]);

  // 连接就绪后扫描；连接身份（profile / 代际）变化时重扫，覆盖首次建连与重连。
  // 连接不可用时只需让在途结果失效，缓存的列表仍然可见但操作入口已禁用。
  useEffect(() => {
    if (!workspacePath) {
      return;
    }
    if (!canOperate) {
      requestIdRef.current += 1;
      setIsLoading(false);
      return;
    }
    void fetchRepos();
  }, [workspacePath, canOperate, identity, fetchRepos]);

  const phase: GitRepoPhase = !workspacePath
    ? "idle"
    : !canOperate
      ? connecting
        ? "waiting"
        : "disconnected"
      : scanPhase;

  const setSelectedRepoPath = useCallback((path: string | null) => {
    const workspace = workspacePathRef.current;
    if (workspace) {
      if (path) {
        selectedRepoByWorkspaceRef.current.set(workspace, path);
      } else {
        selectedRepoByWorkspaceRef.current.delete(workspace);
      }
    }
    setSelectedRepoPathState(path);
  }, []);

  const refresh = useCallback((): Promise<boolean> => {
    return fetchRepos();
  }, [fetchRepos]);

  return {
    repos,
    isLoading,
    phase,
    error,
    selectedRepoPath,
    setSelectedRepoPath,
    canOperate,
    identity,
    sshStatus,
    refresh,
  };
};
