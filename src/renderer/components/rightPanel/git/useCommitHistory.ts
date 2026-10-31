import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { GitCommitFile, GitLogEntry } from "../../../../preload";
import { ROW_HEIGHT } from "./gitGraphLayout";

const PAGE_SIZE = 50;
/** 增量刷新最多向前扫描的提交数；超过（新提交过多）则退回整体重载。 */
const INCREMENTAL_MAX_COMMITS = 200;

export function useCommitHistory(
  repoPath: string,
  branch?: string | null,
  refreshKey?: number,
) {
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  // 当前选中的提交文件（hash + path），用于在文件列表中高亮。
  const [viewedCommitFile, setViewedCommitFile] = useState<{
    hash: string;
    path: string;
  } | null>(null);

  const loadingRef = useRef(false);
  const loadedCountRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 已加载提交的镜像：增量刷新需要拿它取锚点，但不能把 commits 放进
  // useCallback 依赖（否则列表一变回调就重建）。
  const commitsRef = useRef<GitLogEntry[]>([]);
  // 增量前插前记录的内容高度：渲染后按高度差补偿滚动偏移，视口不跳动。
  const scrollAnchorHeightRef = useRef<number | null>(null);
  // 数据世代：整体重载（切换仓库 / 分支）时自增，让并发中的增量合并结果作废。
  const generationRef = useRef(0);

  const loadPage = useCallback(
    async (skip: number, isInitial: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      // 分页请求在途时可能发生仓库 / 分支切换（整体重载会让世代自增）：响应
      // 返回后必须比对世代，否则上一仓库的条目会被追加进新仓库的列表，并把
      // 旧仓库的 offset 写进分页游标。整体重载自己会收尾 loading 状态，这里
      // 不能再动 loadingRef / isLoading，否则会提前解除新仓库的加载态。
      const generation = generationRef.current;

      try {
        const entries = await window.snow.gitLog(repoPath, skip, PAGE_SIZE);
        if (generationRef.current !== generation) return;
        if (entries.length < PAGE_SIZE) {
          setHasMore(false);
        }
        if (entries.length > 0) {
          if (isInitial) {
            setCommits(entries);
          } else {
            setCommits((prev) => [...prev, ...entries]);
          }
          loadedCountRef.current = skip + entries.length;
        } else {
          setHasMore(false);
        }
      } catch (err) {
        if (generationRef.current !== generation) return;
        setError(String(err));
        setHasMore(false);
      } finally {
        if (generationRef.current === generation) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [repoPath],
  );

  /** 从第一页整体重载：切换仓库 / 分支，以及增量刷新找不到锚点时的兜底。 */
  const reloadFromStart = useCallback(
    async (isCancelled: () => boolean): Promise<void> => {
      generationRef.current += 1;
      // 旧列表整体作废，滚动偏移一并归零：否则切换仓库后视口仍停在旧列表的
      // 位置（新仓库首屏直接落在底部，sentinel 立刻可见还会连锁触发分页）。
      const scroller = containerRef.current?.parentElement;
      if (scroller) {
        scroller.scrollTop = 0;
      }
      setCommits([]);
      setHasMore(true);
      setError(null);
      setIsLoading(true);
      setSelectedHash(null);
      setCommitFiles([]);
      setViewedCommitFile(null);
      loadedCountRef.current = 0;
      loadingRef.current = true;
      try {
        const entries = await window.snow.gitLog(repoPath, 0, PAGE_SIZE);
        if (isCancelled()) return;
        if (entries.length < PAGE_SIZE) {
          setHasMore(false);
        }
        if (entries.length > 0) {
          setCommits(entries);
          loadedCountRef.current = entries.length;
        } else {
          setHasMore(false);
        }
      } catch (err) {
        if (!isCancelled()) {
          setError(String(err));
          setHasMore(false);
        }
      } finally {
        if (!isCancelled()) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [repoPath],
  );

  // 切换仓库或分支：清空后整体重载。分支切换必须整体重载——提交图只包含
  // 当前分支可达的提交，增量合并无法移除旧分支独有的提交。`branch` 由
  // git status 异步回报：从「未知」到已知只是首次登记（挂载与仓库切换时的
  // 首屏加载取的就是当前 HEAD 的数据），不触发重载。cancelled 标记用于
  // 抵御 React Strict Mode 的双次调用（第一次的结果被丢弃）。
  const loadedBranchRef = useRef<string | null>(null);

  // 切换仓库：上一仓库的分支记录作废，等新仓库的分支到位再比较。
  useEffect(() => {
    loadedBranchRef.current = null;
  }, [repoPath]);

  useEffect(() => {
    let cancelled = false;
    loadingRef.current = false;
    void reloadFromStart(() => cancelled);
    return () => {
      cancelled = true;
      loadingRef.current = false;
    };
  }, [reloadFromStart]);

  useEffect(() => {
    const branchName = branch || null;
    if (branchName === null) {
      return;
    }
    const previous = loadedBranchRef.current;
    loadedBranchRef.current = branchName;
    if (previous === null || previous === branchName) {
      return;
    }

    let cancelled = false;
    loadingRef.current = false;
    void reloadFromStart(() => cancelled);
    return () => {
      cancelled = true;
      loadingRef.current = false;
    };
  }, [branch, reloadFromStart]);

  /**
   * 增量刷新：只拉取「已加载的最新提交」（锚点）之上的新提交并前插，同时用
   * 同一批数据刷新锚点及其后已加载提交的引用徽章与推送状态（推送会移动
   * origin/* 这类远端跟踪分支，并使本地提交转为已推送）。找不到锚点
   * （rebase / amend / force push 改写了历史）或新增提交超过上限时，退回整体重载。
   */
  const refreshIncrementally = useCallback(
    async (isCancelled: () => boolean): Promise<void> => {
      const generation = generationRef.current;
      const loaded = commitsRef.current;
      const anchorHash = loaded[0]?.hash;
      if (!anchorHash) {
        await reloadFromStart(isCancelled);
        return;
      }

      const scanned: GitLogEntry[] = [];
      let newCount = -1;
      try {
        while (newCount === -1 && scanned.length < INCREMENTAL_MAX_COMMITS) {
          const page = await window.snow.gitLog(
            repoPath,
            scanned.length,
            PAGE_SIZE,
          );
          if (isCancelled()) return;
          if (page.length === 0) break;
          for (let i = 0; i < page.length; i++) {
            if (page[i].hash === anchorHash) {
              newCount = scanned.length;
              // 锚点及其后同页条目都是已加载提交，用最新数据刷新引用徽章与推送状态。
              for (let j = i; j < page.length; j++) {
                scanned.push(page[j]);
              }
              break;
            }
            scanned.push(page[i]);
          }
          if (newCount === -1 && page.length < PAGE_SIZE) break;
        }
      } catch {
        // 取数失败：保持现状，等下次刷新。
        return;
      }

      if (newCount === -1) {
        await reloadFromStart(isCancelled);
        return;
      }

      const freshMeta = new Map<
        string,
        { refs: string; pushed: boolean; behind: boolean }
      >();
      for (let i = newCount; i < scanned.length; i++) {
        freshMeta.set(scanned[i].hash, {
          refs: scanned[i].refs,
          pushed: scanned[i].pushed,
          behind: scanned[i].behind,
        });
      }
      const isSameMeta = (
        commit: GitLogEntry,
        fresh: { refs: string; pushed: boolean; behind: boolean },
      ): boolean =>
        fresh.refs === commit.refs &&
        fresh.pushed === commit.pushed &&
        fresh.behind === commit.behind;
      const metaChanged = loaded.some((commit) => {
        const fresh = freshMeta.get(commit.hash);
        return fresh !== undefined && !isSameMeta(commit, fresh);
      });
      if (newCount === 0 && !metaChanged) {
        return;
      }
      // 扫描期间若发生过整体重载（切换仓库 / 分支），本次合并已失效。
      if (generationRef.current !== generation) {
        return;
      }

      if (newCount > 0) {
        scrollAnchorHeightRef.current =
          containerRef.current?.offsetHeight ?? null;
        loadedCountRef.current += newCount;
      }
      setCommits((prev) => {
        const merged = prev.map((commit) => {
          const fresh = freshMeta.get(commit.hash);
          if (fresh === undefined) {
            return commit;
          }
          return isSameMeta(commit, fresh) ? commit : { ...commit, ...fresh };
        });
        return newCount > 0
          ? [...scanned.slice(0, newCount), ...merged]
          : merged;
      });
    },
    [repoPath, reloadFromStart],
  );

  useEffect(() => {
    commitsRef.current = commits;
  }, [commits]);

  // 外部刷新（提交 / 推送 / 拉取 / 手动刷新）：增量合并，保住滚动位置与展开
  // 的提交详情；只有历史被改写时才整体重载。
  const handledRefreshKeyRef = useRef(0);
  useEffect(() => {
    if (!refreshKey || handledRefreshKeyRef.current === refreshKey) {
      return;
    }
    handledRefreshKeyRef.current = refreshKey;
    let cancelled = false;
    void refreshIncrementally(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refreshKey, refreshIncrementally]);

  // 前插补偿：用户已向下滚动时按内容高度差推回滚动位置（视口内容保持不动）；
  // 停留在顶部附近时不做补偿，让新提交直接出现在视野里。
  useLayoutEffect(() => {
    const before = scrollAnchorHeightRef.current;
    if (before === null) {
      return;
    }
    scrollAnchorHeightRef.current = null;
    const scroller = containerRef.current?.parentElement;
    if (!scroller) {
      return;
    }
    const delta = (containerRef.current?.offsetHeight ?? before) - before;
    if (delta > 0 && scroller.scrollTop > ROW_HEIGHT) {
      scroller.scrollTop += delta;
    }
  }, [commits]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    loadPage(loadedCountRef.current, false);
  }, [hasMore, loadPage]);

  // IntersectionObserver for infinite scroll.
  // The scroll container is the panel pane (.git-panel-graph), not
  // .git-graph itself. Using viewport (null) as root works because
  // .git-graph doesn't scroll on its own — scrolling happens in the pane,
  // which moves the sentinel relative to the viewport.
  //
  // IMPORTANT: this effect must re-run after the initial loading completes,
  // because the sentinel is only rendered in the non-loading branch. During
  // the first run (isLoading=true) the sentinel is not in the DOM yet.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, isLoading, commits.length]);

  // Fetch commit files when a commit is selected.
  // NOTE: commitFiles is cleared synchronously in handleRowClick (not here)
  // to prevent stale files from the previously selected commit flashing for
  // one frame before this effect runs. useEffect fires AFTER render, so
  // clearing here would render with selectedHash=B but commitFiles=A's data.
  useEffect(() => {
    if (!selectedHash || !repoPath) return;
    let cancelled = false;
    setIsLoadingFiles(true);

    window.snow
      .gitCommitFiles(repoPath, selectedHash)
      .then((files) => {
        if (!cancelled) {
          setCommitFiles(files);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommitFiles([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingFiles(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedHash, repoPath]);

  const handleRowClick = (hash: string): void => {
    setSelectedHash((prev) => {
      if (prev === hash) {
        // Collapsing: no need to touch commitFiles, detail unmounts.
        return null;
      }
      // Expanding a (possibly different) commit: clear stale files and enter
      // loading synchronously in the same batched render so the detail panel
      // shows the loading state immediately instead of the previous commit's
      // file list for one frame.
      setCommitFiles([]);
      setIsLoadingFiles(true);
      return hash;
    });
  };

  const selectCommitFile = useCallback((hash: string, path: string): void => {
    setViewedCommitFile({ hash, path });
  }, []);

  return {
    commits,
    isLoading,
    hasMore,
    error,
    selectedHash,
    commitFiles,
    isLoadingFiles,
    viewedCommitFile,
    selectCommitFile,
    containerRef,
    sentinelRef,
    handleRowClick,
    reload: reloadFromStart,
  };
}
