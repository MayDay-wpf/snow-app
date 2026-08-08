import {
  CircleDot,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Hash,
  MessageSquareText,
  Tag,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  GitCommitFile,
  GitFileStatus,
  GitLogEntry,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import type { OpenDiffTabCallback } from "../types";

type GitGraphProps = {
  repoPath: string;
  /** Bump to force a full reload of the history from the first page. */
  refreshKey?: number;
  /** Fired when an initial load (mount or external refresh) settles. */
  onLoaded?: () => void;
  /** Fired when a file in an expanded commit is clicked, requesting its
      per-commit diff to be shown in the diff viewer. */
  onCommitFileSelect?: (file: GitCommitFile, hash: string) => void;
  /** Opens a commit file's diff in a new right-panel tab. */
  onOpenInTab?: OpenDiffTabCallback;
};

/** 将提交文件（GitCommitFile）转换为 DiffTab 所需的 GitFileStatus 形状。 */
const toGitFileStatus = (file: GitCommitFile): GitFileStatus => ({
  path: file.path,
  oldPath: null,
  indexStatus: "",
  workdirStatus: "",
  status: file.status,
});

// --- Types ---

interface GraphRow {
  commit: GitLogEntry;
  dotLane: number;
  topLines: number[];
  bottomLines: number[];
  curves: { from: number; to: number }[];
}

// --- Constants ---

const PAGE_SIZE = 50;
const LANE_WIDTH = 20;
const ROW_HEIGHT = 28;
const DOT_RADIUS = 4;
const LINE_WIDTH = 2;

const LANE_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
];

// --- Ordering ---

/**
 * Reorders commits so the first-parent chain is laid out first.
 *
 * `git log` guarantees children appear before parents, but its default
 * date ordering can still list a merge's SECOND-parent branch before the
 * first parent's continuation (side branches are often newer). The
 * incremental lane algorithm assigns lanes as rows are consumed, so such
 * a side branch colonizes the early lanes; when the mainline later
 * reaches the same commits it bends into a side lane and the main axis
 * ends up red instead of blue.
 *
 * This is Kahn's topological sort with a LIFO worklist: children always
 * precede parents, and among the ready commits the one that became ready
 * most recently wins — i.e. "keep following the first parent before
 * backtracking into side branches". The newest tip pops first, so the
 * whole main axis lands in lane 0 (blue) and branches fill the remaining
 * lanes.
 */
function reorderFirstParentFirst(commits: GitLogEntry[]): GitLogEntry[] {
  if (commits.length < 2) {
    return commits;
  }

  const byHash = new Map<string, GitLogEntry>();
  const childCount = new Map<string, number>();
  for (const commit of commits) {
    byHash.set(commit.hash, commit);
    childCount.set(commit.hash, 0);
  }
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (byHash.has(parent)) {
        childCount.set(parent, childCount.get(parent)! + 1);
      }
    }
  }

  // Seeds = commits no loaded row references (ref tips). Pushed in reverse
  // so the newest one (row 0) pops first.
  const stack: GitLogEntry[] = [];
  for (let i = commits.length - 1; i >= 0; i--) {
    if (childCount.get(commits[i].hash) === 0) {
      stack.push(commits[i]);
    }
  }

  const ordered: GitLogEntry[] = [];
  while (stack.length > 0) {
    const commit = stack.pop()!;
    ordered.push(commit);
    // Push parents in reverse so the FIRST parent pops next, keeping the
    // first-parent chain contiguous.
    for (let i = commit.parents.length - 1; i >= 0; i--) {
      const remaining = childCount.get(commit.parents[i]);
      if (remaining === undefined) continue; // parent beyond the loaded window
      if (remaining === 1) {
        stack.push(byHash.get(commit.parents[i])!);
      }
      childCount.set(commit.parents[i], remaining - 1);
    }
  }
  return ordered;
}

// --- Lane computation ---

function computeGraph(commits: GitLogEntry[]): {
  rows: GraphRow[];
  maxLanes: number;
} {
  const hashToLane = new Map<string, number>();
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  // The first-parent chain of the newest commit is the "main axis" and
  // must stay in lane 0. A side branch can reference a mainline commit
  // before the mainline reaches it (the branch's tail re-joins the
  // mainline deep down), parking it in a side lane; the next mainline row
  // that continues the chain then reclaims it below.
  const commitByHash = new Map(commits.map((c) => [c.hash, c]));
  const mainline = new Set<string>();
  for (
    let cur: GitLogEntry | undefined = commits[0];
    cur;
    cur = cur.parents[0] ? commitByHash.get(cur.parents[0]) : undefined
  ) {
    mainline.add(cur.hash);
  }

  for (const commit of commits) {
    let dotLane: number;
    if (hashToLane.has(commit.hash)) {
      dotLane = hashToLane.get(commit.hash)!;
      hashToLane.delete(commit.hash);
    } else {
      const freeLane = lanes.indexOf(null);
      dotLane = freeLane !== -1 ? freeLane : lanes.length;
      if (dotLane >= lanes.length) {
        lanes.push(null);
      }
    }

    const topLines: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null) {
        topLines.push(i);
      }
    }

    lanes[dotLane] = null;

    const curves: { from: number; to: number }[] = [];

    for (let p = 0; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p];
      const isFirstParent = p === 0;

      let parentLane: number;
      if (hashToLane.has(parentHash)) {
        parentLane = hashToLane.get(parentHash)!;
        // The dot is on the main axis but its first parent is parked in a
        // side lane (a branch tail referenced it earlier). Reclaim the
        // parent into lane 0 so the main axis stays straight; the parked
        // lane's line merges into lane 0 via a curve and the freed slot is
        // released for reuse.
        if (isFirstParent && mainline.has(commit.hash) && parentLane !== dotLane) {
          curves.push({ from: parentLane, to: dotLane });
          lanes[parentLane] = null;
          hashToLane.set(parentHash, dotLane);
          parentLane = dotLane;
        }
      } else {
        if (isFirstParent) {
          parentLane = dotLane;
        } else {
          const freeLane = lanes.indexOf(null);
          parentLane = freeLane !== -1 ? freeLane : lanes.length;
          if (parentLane >= lanes.length) {
            lanes.push(null);
          }
        }
        hashToLane.set(parentHash, parentLane);
      }

      lanes[parentLane] = parentHash;

      if (parentLane !== dotLane) {
        curves.push({ from: dotLane, to: parentLane });
      }
    }

    const bottomLines: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null) {
        bottomLines.push(i);
      }
    }

    rows.push({ commit, dotLane, topLines, bottomLines, curves });
  }

  return { rows, maxLanes: lanes.length };
}

// --- Helpers ---

function formatDate(dateStr: string): string {
  return dateStr.split(" ")[0];
}

function getCommitFileColor(status: string): string {
  if (status.startsWith("A")) return "git-status-add";
  if (status.startsWith("D")) return "git-status-delete";
  if (status.startsWith("R")) return "git-status-rename";
  return "git-status-modify";
}

function getCommitFileLabel(status: string): string {
  if (status.startsWith("A")) return "A";
  if (status.startsWith("D")) return "D";
  if (status.startsWith("R")) return "R";
  if (status.startsWith("C")) return "C";
  if (status.startsWith("M")) return "M";
  return status.charAt(0);
}

/** A single ref decoration attached to a commit row. */
interface ParsedRef {
  kind: "local" | "remote" | "tag";
  /** Display name: branch name, `origin/xxx` for remotes, tag name. */
  name: string;
  /** True when the checked-out HEAD points at this commit. */
  isHead: boolean;
}

const HEAD_ARROW = "HEAD -> ";
const HEADS_PREFIX = "refs/heads/";
const REMOTES_PREFIX = "refs/remotes/";
const TAGS_PREFIX = "refs/tags/";

/**
 * Parses a commit's decoration string (`%D` with `--decorate=full`, e.g.
 * "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v1") into
 * typed refs so local branches, remote-tracking branches and tags can be
 * badged distinctly. Short-form decorations (without the refs/ prefixes)
 * are tolerated as a fallback and treated as local branches.
 */
function parseRefs(refs: string): ParsedRef[] {
  const parsed: ParsedRef[] = [];
  if (!refs) {
    return parsed;
  }

  for (const rawPart of refs.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    // Detached HEAD decorates as a bare "HEAD".
    if (part === "HEAD") {
      parsed.push({ kind: "local", name: "HEAD", isHead: true });
      continue;
    }

    let body = part;
    let isHead = false;
    if (part.startsWith(HEAD_ARROW)) {
      isHead = true;
      body = part.slice(HEAD_ARROW.length).trim();
    }

    if (body.startsWith(HEADS_PREFIX)) {
      parsed.push({
        kind: "local",
        name: body.slice(HEADS_PREFIX.length),
        isHead,
      });
    } else if (body.startsWith(REMOTES_PREFIX)) {
      parsed.push({
        kind: "remote",
        name: body.slice(REMOTES_PREFIX.length),
        isHead: false,
      });
    } else if (body.startsWith(TAGS_PREFIX)) {
      parsed.push({
        kind: "tag",
        name: body.slice(TAGS_PREFIX.length),
        isHead: false,
      });
    } else if (body.startsWith("tag: ")) {
      parsed.push({ kind: "tag", name: body.slice(5).trim(), isHead: false });
    } else if (body) {
      parsed.push({ kind: "local", name: body, isHead });
    }
  }

  return parsed;
}

// --- Component ---

export const GitGraph = ({
  repoPath,
  refreshKey,
  onLoaded,
  onCommitFileSelect,
  onOpenInTab,
}: GitGraphProps): React.JSX.Element => {
  const { t } = useI18n();
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  // 当前正在查看差异的提交文件（hash + path），用于在文件列表中高亮。
  const [viewedCommitFile, setViewedCommitFile] = useState<{
    hash: string;
    path: string;
  } | null>(null);

  const loadingRef = useRef(false);
  const loadedCountRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(
    async (skip: number, isInitial: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;

      try {
        const entries = await window.snow.gitLog(repoPath, skip, PAGE_SIZE);
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
        setError(String(err));
        setHasMore(false);
      } finally {
        loadingRef.current = false;
        setIsLoading(false);
      }
    },
    [repoPath]
  );

  // Initial load + reset when repoPath changes or an external refresh
  // (refreshKey bump) is requested.
  // Uses a cancelled flag to survive React Strict Mode double-invoke.
  useEffect(() => {
    let cancelled = false;

    setCommits([]);
    setHasMore(true);
    setError(null);
    setIsLoading(true);
    setSelectedHash(null);
    setCommitFiles([]);
    setViewedCommitFile(null);
    loadedCountRef.current = 0;
    loadingRef.current = false;

    const doInitialLoad = async () => {
      if (cancelled) return;
      loadingRef.current = true;
      try {
        const entries = await window.snow.gitLog(repoPath, 0, PAGE_SIZE);
        if (cancelled) return;
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
        if (!cancelled) {
          setError(String(err));
          setHasMore(false);
        }
      } finally {
        if (!cancelled) {
          loadingRef.current = false;
          setIsLoading(false);
          onLoaded?.();
        }
      }
    };

    doInitialLoad();

    return () => {
      cancelled = true;
      loadingRef.current = false;
    };
  }, [repoPath, refreshKey, onLoaded]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    loadPage(loadedCountRef.current, false);
  }, [hasMore, loadPage]);

  // IntersectionObserver for infinite scroll.
  // The scroll container is .git-control (parent), not .git-graph itself.
  // Using viewport (null) as root works because .git-graph doesn't scroll
  // on its own — scrolling happens in the parent .git-control, which moves
  // the sentinel relative to the viewport.
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
      { rootMargin: "200px" }
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

  const { rows, maxLanes } = useMemo(
    () => computeGraph(reorderFirstParentFirst(commits)),
    [commits]
  );
  const graphWidth = Math.max(maxLanes * LANE_WIDTH, LANE_WIDTH);

  const handleRowClick = (hash: string) => {
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

  const handleRowDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, commit: GitLogEntry) => {
      const tag = {
        hash: commit.hash,
        shortHash: commit.shortHash,
        author: commit.author,
        date: commit.date,
        message: commit.message,
        repoPath,
      };
      event.dataTransfer.setData("application/json", JSON.stringify(tag));
      event.dataTransfer.effectAllowed = "copy";
    },
    [repoPath]
  );

  // Hover tooltip with the full commit details. Rendered in a portal with
  // fixed positioning so the scroll container (.git-control-scroll) cannot
  // clip it. The git panel sits on the right edge of the window, so the
  // tooltip opens to the LEFT of the cursor and only flips right when it
  // would run off the left edge of the viewport. Mousemove updates the
  // position directly on the DOM node (no re-render); only entering a
  // different commit triggers a render.
  const [hoveredCommit, setHoveredCommit] = useState<GitLogEntry | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // 提交行右键菜单：复制哈希 / 提交信息，以及展开收起提交详情。
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    commit: GitLogEntry;
  } | null>(null);
  // 提交内文件右键菜单：在新标签页打开 Diff / 复制文件路径。
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number;
    y: number;
    file: GitCommitFile;
    hash: string;
  } | null>(null);

  const positionTooltip = useCallback((clientX: number, clientY: number) => {
    const node = tooltipRef.current;
    if (!node) return;
    const margin = 12;
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = clientX - rect.width - margin;
    let top = clientY + margin;
    if (left < margin) {
      left = clientX + margin;
    }
    if (top + rect.height > vh - margin) {
      top = clientY - rect.height - margin;
    }
    if (top < margin) top = margin;
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, []);

  const showTooltip = useCallback(
    (commit: GitLogEntry, clientX: number, clientY: number) => {
      // Skip the re-render when hovering within the same commit.
      setHoveredCommit((prev) => (prev === commit ? prev : commit));
      // Position once the node is visible so getBoundingClientRect() reports
      // real dimensions for boundary detection.
      requestAnimationFrame(() => positionTooltip(clientX, clientY));
    },
    [positionTooltip]
  );

  const hideTooltip = useCallback(() => {
    setHoveredCommit(null);
  }, []);

  /** 提交行右键菜单：复制哈希 / 提交信息，以及展开收起提交详情。 */
  const buildCommitMenuItems = (commit: GitLogEntry): ContextMenuItem[] => {
    const isExpanded = selectedHash === commit.hash;
    return [
      {
        id: "copy-full-hash",
        label: t("git.copyFullHash", { defaultValue: "Copy Full Hash" }),
        icon: <Hash size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(commit.hash).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "copy-short-hash",
        label: t("git.copyShortHash", { defaultValue: "Copy Short Hash" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(commit.shortHash).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "copy-message",
        separator: true,
        label: t("git.copyCommitMessage", {
          defaultValue: "Copy Commit Message",
        }),
        icon: <MessageSquareText size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(commit.message).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "toggle-detail",
        separator: true,
        label: isExpanded
          ? t("git.hideCommitDetails", {
              defaultValue: "Hide Commit Details",
            })
          : t("git.viewCommitDetails", {
              defaultValue: "View Commit Details",
            }),
        icon: isExpanded ? (
          <EyeOff size={13} strokeWidth={1.8} />
        ) : (
          <Eye size={13} strokeWidth={1.8} />
        ),
        onClick: () => {
          setContextMenu(null);
          handleRowClick(commit.hash);
        },
      },
    ];
  };

  /** 提交内文件右键菜单：在新标签页打开 Diff / 复制文件路径。 */
  const buildCommitFileMenuItems = (
    file: GitCommitFile,
    hash: string
  ): ContextMenuItem[] => [
    {
      id: "open-diff-in-tab",
      label: t("git.openDiffInNewTab", {
        defaultValue: "Open Diff in New Tab",
      }),
      icon: <ExternalLink size={13} strokeWidth={1.8} />,
      disabled: !repoPath || !onOpenInTab,
      onClick: () => {
        setFileContextMenu(null);
        void openCommitFileDiffInTab(file, hash);
      },
    },
    {
      id: "copy-path",
      separator: true,
      label: t("git.copyPath", { defaultValue: "Copy Path" }),
      icon: <FileText size={13} strokeWidth={1.8} />,
      onClick: () => {
        setFileContextMenu(null);
        void window.snow.writeClipboardText(file.path).catch(() => {
          // 剪贴板写入失败时静默忽略。
        });
      },
    },
  ];

  /** 在新标签页打开提交内文件 Diff：先以加载态打开标签，再异步填充结果。 */
  const openCommitFileDiffInTab = async (
    file: GitCommitFile,
    hash: string
  ): Promise<void> => {
    if (!repoPath || !onOpenInTab) {
      return;
    }
    const fileStatus = toGitFileStatus(file);
    onOpenInTab(fileStatus, null, true);
    try {
      const result = await window.snow.gitCommitFileDiff(
        repoPath,
        hash,
        file.path
      );
      onOpenInTab(fileStatus, result, false);
    } catch {
      onOpenInTab(fileStatus, null, false);
    }
  };

  /** Renders one ref badge (local / remote / tag) with icon and tooltip. */
  const renderRefBadge = (ref: ParsedRef) => {
    const title =
      ref.kind === "remote"
        ? t("git.graphRemoteBranch", { defaultValue: "Remote branch" })
        : ref.kind === "tag"
          ? t("git.graphTag", { defaultValue: "Tag" })
          : ref.name === "HEAD"
            ? t("git.graphDetachedHead", { defaultValue: "Detached HEAD" })
            : ref.isHead
              ? t("git.graphCurrentBranch", { defaultValue: "Current branch" })
              : t("git.graphLocalBranch", { defaultValue: "Local branch" });
    const icon =
      ref.kind === "remote" ? (
        <Cloud size={10} strokeWidth={2} />
      ) : ref.kind === "tag" ? (
        <Tag size={10} strokeWidth={2} />
      ) : ref.name === "HEAD" ? (
        <GitCommitHorizontal size={10} strokeWidth={2} />
      ) : ref.isHead ? (
        <CircleDot size={10} strokeWidth={2} />
      ) : (
        <GitBranch size={10} strokeWidth={2} />
      );
    return (
      <span
        key={`${ref.kind}/${ref.name}`}
        className={`git-graph-ref ${ref.kind}`}
        title={title}
      >
        {icon}
        {ref.name}
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="git-graph" ref={containerRef}>
        <div className="git-graph-loading">{t("git.graphLoading")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-graph">
        <div className="git-graph-error">{t("git.graphError")}</div>
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="git-graph">
        <div className="git-graph-empty">{t("git.graphNoCommits")}</div>
      </div>
    );
  }

  return (
    <div className="git-graph" ref={containerRef}>
      {rows.map((row) => {
        const dotColor = LANE_COLORS[row.dotLane % LANE_COLORS.length];
        const isSelected = selectedHash === row.commit.hash;
        // 当前本地 HEAD 所在提交：圆点外加光环突出本地位置。
        const parsedRefs = parseRefs(row.commit.refs);
        const isHead = parsedRefs.some((ref) => ref.isHead);
        // At a branch point (curve leaving the dot), the curve leads into
        // the target lane and only reaches it at the bottom of the row.
        // If that lane had no line coming from above, drawing its vertical
        // bottom line from the dot height would make the new branch appear
        // to extend one extra segment before the curve actually joins it.
        // Skip such lines — the next row's top line continues them.
        const curveTargets = new Set(row.curves.map((c) => c.to));
        const bottomLines = row.bottomLines.filter(
          (lane) => !(curveTargets.has(lane) && !row.topLines.includes(lane))
        );
        return (
          <div key={row.commit.hash}>
            <div
              className={`git-graph-row${isSelected ? " selected" : ""}`}
              onClick={() => handleRowClick(row.commit.hash)}
              onContextMenu={(event) => {
                event.preventDefault();
                hideTooltip();
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  commit: row.commit,
                });
              }}
              draggable
              onDragStart={(event) => handleRowDragStart(event, row.commit)}
              onMouseEnter={(event) =>
                showTooltip(row.commit, event.clientX, event.clientY)
              }
              onMouseMove={(event) =>
                positionTooltip(event.clientX, event.clientY)
              }
              onMouseLeave={hideTooltip}
            >
              <svg
                className="git-graph-svg"
                width={graphWidth}
                height={ROW_HEIGHT}
              >
                {row.topLines.map((lane) => (
                  <line
                    key={`top-${lane}`}
                    x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y1={-LINE_WIDTH / 2}
                    x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y2={ROW_HEIGHT / 2}
                    stroke={LANE_COLORS[lane % LANE_COLORS.length]}
                    strokeWidth={LINE_WIDTH}
                  />
                ))}
                {bottomLines.map((lane) => (
                  <line
                    key={`bottom-${lane}`}
                    x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y1={ROW_HEIGHT / 2}
                    x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y2={ROW_HEIGHT + LINE_WIDTH / 2}
                    stroke={LANE_COLORS[lane % LANE_COLORS.length]}
                    strokeWidth={LINE_WIDTH}
                  />
                ))}
                {row.curves.map((c, i) => {
                  const fromX = c.from * LANE_WIDTH + LANE_WIDTH / 2;
                  const toX = c.to * LANE_WIDTH + LANE_WIDTH / 2;
                  return (
                    <path
                      key={`curve-${i}`}
                      d={`M ${fromX},${ROW_HEIGHT / 2} C ${fromX},${
                        ROW_HEIGHT * 0.75
                      } ${toX},${ROW_HEIGHT * 0.75} ${toX},${
                        ROW_HEIGHT + LINE_WIDTH / 2
                      }`}
                      fill="none"
                      stroke={LANE_COLORS[c.to % LANE_COLORS.length]}
                      strokeWidth={LINE_WIDTH}
                    />
                  );
                })}
                {isHead && (
                  <circle
                    cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
                    cy={ROW_HEIGHT / 2}
                    r={DOT_RADIUS + 3}
                    fill="none"
                    stroke="var(--accent-blue-text)"
                    strokeWidth={1.5}
                  />
                )}
                <circle
                  cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
                  cy={ROW_HEIGHT / 2}
                  r={DOT_RADIUS}
                  fill={dotColor}
                  stroke="var(--bg-primary)"
                  strokeWidth={2}
                />
              </svg>
              <div className="git-graph-info">
                <span className="git-graph-hash">{row.commit.shortHash}</span>
                <span className="git-graph-message" title={row.commit.message}>
                  {row.commit.message}
                </span>
                {parsedRefs.length > 0 && (
                  <span className="git-graph-refs">
                    {parsedRefs.map(renderRefBadge)}
                  </span>
                )}
                <span className="git-graph-meta">
                  <span className="git-graph-author">{row.commit.author}</span>
                  <span className="git-graph-date">
                    {formatDate(row.commit.date)}
                  </span>
                </span>
              </div>
            </div>
            {isSelected && (
              <div
                className="git-graph-detail"
                style={{ paddingLeft: graphWidth + 20 }}
              >
                {/* Extend the lanes that continue below this row through the
                    expanded detail area so the graph columns stay visually
                    continuous instead of being cut off by the detail panel. */}
                <svg
                  className="git-graph-detail-lines"
                  width={graphWidth}
                  height="100%"
                >
                  {bottomLines.map((lane) => (
                    <line
                      key={`detail-${lane}`}
                      x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
                      y1="0%"
                      x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
                      y2="100%"
                      stroke={LANE_COLORS[lane % LANE_COLORS.length]}
                      strokeWidth={LINE_WIDTH}
                    />
                  ))}
                </svg>
                {commitFiles.length > 0 ? (
                  <div className="git-graph-detail-files">
                    {commitFiles.map((file, i) => {
                      const isViewed =
                        viewedCommitFile?.hash === row.commit.hash &&
                        viewedCommitFile.path === file.path;
                      return (
                        <div
                          key={i}
                          className={`git-graph-detail-file${
                            isViewed ? " active" : ""
                          }`}
                          onClick={() => {
                            setViewedCommitFile({
                              hash: row.commit.hash,
                              path: file.path,
                            });
                            onCommitFileSelect?.(file, row.commit.hash);
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            hideTooltip();
                            setFileContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              file,
                              hash: row.commit.hash,
                            });
                          }}
                          title={t("git.viewCommitFileDiff", {
                            defaultValue: "View File Diff in This Commit",
                          })}
                        >
                          <span
                            className={`git-file-status ${getCommitFileColor(
                              file.status
                            )}`}
                          >
                            {getCommitFileLabel(file.status)}
                          </span>
                          <span
                            className="git-graph-detail-path"
                            title={file.path}
                          >
                            {file.path}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : isLoadingFiles ? (
                  <span className="git-graph-detail-loading">
                    {t("git.graphLoading")}
                  </span>
                ) : (
                  <span className="git-graph-detail-empty">
                    {t("git.graphNoCommits")}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {/* Sentinel is always rendered so the ref can bind; visibility is
          controlled by hasMore to avoid an invisible 1px div at the end. */}
      <div
        ref={sentinelRef}
        className="git-graph-sentinel"
        style={{ display: hasMore ? "block" : "none" }}
      />
      {createPortal(
        hoveredCommit ? (
          <div className="git-graph-tooltip" ref={tooltipRef}>
            <div className="git-graph-tooltip-row">
              <span className="git-graph-tooltip-label">
                {t("git.graphTooltipHash")}
              </span>
              <span className="git-graph-tooltip-value git-graph-tooltip-mono">
                {hoveredCommit.hash}
              </span>
            </div>
            <div className="git-graph-tooltip-row">
              <span className="git-graph-tooltip-label">
                {t("git.graphTooltipAuthor")}
              </span>
              <span className="git-graph-tooltip-value">
                {hoveredCommit.author}
                {hoveredCommit.email
                  ? ` <${hoveredCommit.email}>`
                  : ""}
              </span>
            </div>
            <div className="git-graph-tooltip-row">
              <span className="git-graph-tooltip-label">
                {t("git.graphTooltipDate")}
              </span>
              <span className="git-graph-tooltip-value">
                {hoveredCommit.date}
              </span>
            </div>
            {hoveredCommit.refs && (
              <div className="git-graph-tooltip-row">
                <span className="git-graph-tooltip-label">
                  {t("git.graphTooltipRefs")}
                </span>
                <span className="git-graph-tooltip-value">
                  {parseRefs(hoveredCommit.refs)
                    .map((ref) => ref.name)
                    .join(", ")}
                </span>
              </div>
            )}
            {hoveredCommit.parents.length > 0 && (
              <div className="git-graph-tooltip-row">
                <span className="git-graph-tooltip-label">
                  {t("git.graphTooltipParents")}
                </span>
                <span className="git-graph-tooltip-value git-graph-tooltip-mono">
                  {hoveredCommit.parents.join(", ")}
                </span>
              </div>
            )}
            <div className="git-graph-tooltip-divider" />
            <div className="git-graph-tooltip-message">
              {hoveredCommit.message}
            </div>
          </div>
        ) : null,
        document.body
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildCommitMenuItems(contextMenu.commit)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {fileContextMenu && (
        <ContextMenu
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          items={buildCommitFileMenuItems(
            fileContextMenu.file,
            fileContextMenu.hash
          )}
          onClose={() => setFileContextMenu(null)}
        />
      )}
    </div>
  );
};
