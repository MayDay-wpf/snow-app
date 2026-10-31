import { useCallback, useEffect, useRef, useState } from "react";
import type { GitRepoInfo } from "../../../../preload";

type UseGitReposResult = {
  repos: GitRepoInfo[];
  isLoading: boolean;
  selectedRepoPath: string | null;
  setSelectedRepoPath: (path: string | null) => void;
  refresh: () => void;
};

/**
 * Discovers all git repositories within the active workspace directory.
 *
 * When the workspace directory changes, this hook calls the backend to
 * recursively scan for `.git` folders — the Rust backend for local paths,
 * an SSH-backed scan for remote (`ssh://`) paths. The repo the user last
 * selected in that directory (or the first discovered one when there is no
 * memory) is auto-selected.
 *
 * If exactly one repo is found, it is selected automatically. If multiple
 * repos are found, the user can switch between them via the RepoSelector
 * dropdown, and the choice is remembered per workspace directory so that
 * switching projects back and forth keeps it. If no repos are found,
 * selectedRepoPath remains null and the UI shows an appropriate empty state.
 */
export const useGitRepos = (
  workspacePath: string | undefined | null,
): UseGitReposResult => {
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedRepoPath, setSelectedRepoPathState] = useState<string | null>(
    null,
  );
  const workspacePathRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  // 每个工作目录各自记住用户选中的仓库：面板在项目切换时保持挂载，但选中项
  // 只有一个 state，切回来时 prev 属于另一个项目，必然落到「回退第一个」的
  // 分支上。扫描完成后优先按目录恢复记忆值。
  const selectedRepoByWorkspaceRef = useRef<Map<string, string>>(new Map());

  const fetchRepos = useCallback(async () => {
    const path = workspacePathRef.current;
    if (!path) {
      setRepos([]);
      setSelectedRepoPathState(null);
      return;
    }

    const myId = ++requestIdRef.current;
    setIsLoading(true);

    try {
      const result = await window.snow.discoverGitRepos(path);
      if (myId === requestIdRef.current) {
        setRepos(result);
        // 自动选择：优先恢复该目录上次选中的仓库；记忆值已不在列表里
        // （仓库被删除等）或从未选过时，才沿用当前选中项或回退第一个。
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
      }
    } catch {
      if (myId === requestIdRef.current) {
        setRepos([]);
        setSelectedRepoPathState(null);
      }
    } finally {
      if (myId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    workspacePathRef.current = workspacePath ?? null;
    void fetchRepos();
  }, [workspacePath, fetchRepos]);

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

  const refresh = useCallback(() => {
    void fetchRepos();
  }, [fetchRepos]);

  return {
    repos,
    isLoading,
    selectedRepoPath,
    setSelectedRepoPath,
    refresh,
  };
};
