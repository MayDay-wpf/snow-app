import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatusResult } from "../../../../preload";
import { acquireGitWatch, releaseGitWatch } from "./gitWatchRegistry";

// Fallbacks used until the persisted settings load (a few ms).
const DEFAULT_REMOTE_POLL_INTERVAL_MS = 10_000;
const DEFAULT_CHANGE_DEBOUNCE_MS = 400;

type GitScanSettings = {
  maxDepth: number;
  ignoredFolders: string[];
  changeDebounceMs: number;
  remotePollIntervalMs: number;
  statusLimit: number;
  autoRefresh: boolean;
  confirmPullPush: boolean;
};

type UseGitStatusResult = {
  status: GitStatusResult | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export const useGitStatus = (
  repoPath: string | undefined | null,
): UseGitStatusResult => {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const repoPathRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const watcherDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of the last explicit refresh(). Watcher events arriving
  // shortly after an explicit refresh are suppressed because they are
  // almost always caused by our own git operations (stage/unstage/commit)
  // and the explicit refresh already fetched the correct status.
  const lastExplicitRefreshRef = useRef(0);
  // Git scan settings, loaded once from the backend.
  const settingsRef = useRef<GitScanSettings | null>(null);

  const isSshPath = (path: string): boolean => path.startsWith("ssh://");

  const fetchStatus = useCallback(async () => {
    const path = repoPathRef.current;
    if (!path) {
      setStatus(null);
      setError(null);
      return;
    }

    // Increment request ID so stale responses can be discarded
    const myId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.snow.gitStatus(path);
      // Only apply if this is still the latest request
      if (!cancelledRef.current && myId === requestIdRef.current) {
        setStatus(result);
      }
    } catch (err) {
      if (!cancelledRef.current && myId === requestIdRef.current) {
        setError(err instanceof Error ? err.message : "git.getStatusError");
      }
    } finally {
      if (!cancelledRef.current && myId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    repoPathRef.current = repoPath ?? null;

    void fetchStatus();

    // Load git scan settings (debounce / poll interval / auto-refresh).
    void window.snow
      .getGitScanSettings()
      .then((settings) => {
        settingsRef.current = settings;
      })
      .catch(() => {
        settingsRef.current = null;
      });

    const isRemote = !!repoPath && isSshPath(repoPath);

    // Remote repos have no local file watcher — poll instead.
    const pollTimer = isRemote
      ? setInterval(() => {
          if (!document.hidden) {
            void fetchStatus();
          }
        }, settingsRef.current?.remotePollIntervalMs ?? DEFAULT_REMOTE_POLL_INTERVAL_MS)
      : null;

    const autoRefresh = settingsRef.current?.autoRefresh ?? true;
    const debounceMs =
      settingsRef.current?.changeDebounceMs ?? DEFAULT_CHANGE_DEBOUNCE_MS;

    const watchedPath = repoPath && !isRemote && autoRefresh ? repoPath : null;
    if (watchedPath) {
      acquireGitWatch(watchedPath);
    }

    const unsubscribe = window.snow.onGitStatusChanged((changedRepoPath) => {
      if (
        !cancelledRef.current &&
        repoPath &&
        changedRepoPath === repoPath &&
        (settingsRef.current?.autoRefresh ?? true)
      ) {
        // If an explicit refresh happened recently, skip watcher events
        // during a short cooldown window. The explicit refresh (triggered
        // after our own stage/unstage/commit) already fetched the correct
        // status. Watcher events from the same operation arriving after
        // the refresh would cause a stale fetch that can overwrite the
        // correct state with a transient/in-progress one.
        const sinceLastRefresh = Date.now() - lastExplicitRefreshRef.current;
        if (sinceLastRefresh < 2000) {
          return;
        }

        // Debounce watcher-triggered refreshes. During operations like branch
        // checkout, many files change at once and the watcher fires mid-operation,
        // producing transient git status. Debouncing collapses these events so
        // we only fetch once the flurry settles.
        if (watcherDebounceRef.current) {
          clearTimeout(watcherDebounceRef.current);
        }
        watcherDebounceRef.current = setTimeout(() => {
          watcherDebounceRef.current = null;
          void fetchStatus();
        }, debounceMs);
      }
    });

    return () => {
      cancelledRef.current = true;
      unsubscribe();

      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (watcherDebounceRef.current) {
        clearTimeout(watcherDebounceRef.current);
        watcherDebounceRef.current = null;
      }
      if (watchedPath) {
        releaseGitWatch(watchedPath);
      }
    };
  }, [repoPath, fetchStatus]);

  const refresh = useCallback((): Promise<void> => {
    // Cancel any pending watcher-debounced refresh so the explicit
    // refresh (e.g. after stage/unstage/commit completes) takes precedence.
    if (watcherDebounceRef.current) {
      clearTimeout(watcherDebounceRef.current);
      watcherDebounceRef.current = null;
    }
    // Record this explicit refresh so watcher events arriving within
    // the cooldown window are suppressed (they are caused by our own
    // git operations and would produce stale/intermediate status).
    lastExplicitRefreshRef.current = Date.now();
    return fetchStatus();
  }, [fetchStatus]);

  return { status, isLoading, error, refresh };
};
