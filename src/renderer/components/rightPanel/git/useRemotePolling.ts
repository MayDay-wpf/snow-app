import { useEffect } from "react";

const BASE_POLL_INTERVAL_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 600_000;

/**
 * Periodically runs `git fetch` against the remote so the ahead/behind
 * counts in the status snapshot stay fresh (git only reports "behind"
 * relative to the last fetched remote refs). After each successful fetch
 * `onFetched` is invoked so callers can refresh their status. Works for
 * both local repos (Rust backend) and SSH (`ssh://`) repos.
 *
 * Two guards matter more than the interval itself:
 *
 * 1. **Single flight.** A fetch against an unreachable remote can hang for
 *    minutes. `setInterval` would stack a new child process every minute on
 *    top of the hung one, and each `git fetch` spawns several helpers
 *    (`git.exe`, `git-remote-https`, the credential helper). An hour of
 *    polling then leaves hundreds of processes behind and exhausts the
 *    machine's sockets. So a new poll is only scheduled once the previous
 *    one has settled.
 * 2. **Backoff on failure.** An offline remote or a missing VPN should not be
 *    retried at full rate forever: consecutive failures grow the delay
 *    (60s → 120s → 240s → 480s → 600s cap) and a success resets it.
 *
 * Failures (offline, auth required, no remote) are ignored silently — this is
 * unattended background polling and must never surface errors.
 */
export const useRemotePolling = (
  repoPath: string | undefined | null,
  onFetched: () => void
): void => {
  useEffect(() => {
    if (!repoPath) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Grow the delay while the remote keeps failing, so an unreachable host
    // backs off instead of being hammered once a minute.
    const nextDelay = (): number =>
      Math.min(
        BASE_POLL_INTERVAL_MS * 2 ** Math.min(failures, 4),
        MAX_POLL_INTERVAL_MS
      );

    const schedule = (): void => {
      if (cancelled) {
        return;
      }
      timer = setTimeout(poll, nextDelay());
    };

    const poll = (): void => {
      if (cancelled) {
        return;
      }
      // Skip polling while the window is hidden — there is nobody to notify
      // and the next interval will catch up once visible again. While a fetch
      // is still running, wait for it instead of queueing another one.
      if (document.hidden || inFlight) {
        schedule();
        return;
      }

      inFlight = true;
      window.snow
        .gitFetch(repoPath)
        .then((result) => {
          if (cancelled) {
            return;
          }
          if (result.success) {
            failures = 0;
            onFetched();
          } else {
            failures += 1;
          }
        })
        .catch(() => {
          // Background polling never surfaces errors.
          if (!cancelled) {
            failures += 1;
          }
        })
        .finally(() => {
          inFlight = false;
          schedule();
        });
    };

    poll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [repoPath, onFetched]);
};
