import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  ScanSearch,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { Modal } from "../../../common/Modal";
import type { GitLogEntry, GitStatusResult } from "../../../../../preload";
import { encodeReviewTag, type ReviewTag } from "../fileTagUtils";

type ReviewPanelProps = {
  /** Whether the panel is visible. Controlled by the /review command. */
  open: boolean;
  /** Conversation working directory (used as the git repository path). */
  workDir: string;
  /** Called with the encoded review tag (`@@review:...@@`) when the user confirms. */
  onStartReview: (prompt: string) => void;
  onClose: () => void;
};

// 提交记录分页大小，滚动到底部时按页追加加载。
const COMMIT_PAGE_SIZE = 20;

// 单个 diff 注入提示词的最大字符数，超出部分截断并提示 AI 自行查看。
const MAX_DIFF_CHARS = 40_000;
// 提示词中所有 diff 的总预算，防止一次性把上下文撑爆。
const MAX_TOTAL_DIFF_CHARS = 180_000;

const statusLabel = (file: {
  status: string;
  oldPath: string | null;
  path: string;
}): string => {
  if (file.oldPath) {
    return `${file.status} ${file.oldPath} -> ${file.path}`;
  }
  return `${file.status} ${file.path}`;
};

export const ReviewPanel = ({
  open,
  workDir,
  onStartReview,
  onClose,
}: ReviewPanelProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  // 提交记录无限滚动：是否还有更多、是否正在加载下一页。
  const [hasMoreCommits, setHasMoreCommits] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // 同步锁：IntersectionObserver 可能连续触发，用 ref 立即生效防止并发分页请求。
  const loadingMoreRef = useRef(false);
  const commitsListRef = useRef<HTMLUListElement>(null);
  const commitsSentinelRef = useRef<HTMLLIElement>(null);

  const loadGitData = useCallback(async (): Promise<void> => {
    if (!workDir) {
      setStatus(null);
      setCommits([]);
      setHasMoreCommits(false);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const [statusResult, logEntries] = await Promise.all([
        window.snow.gitStatus(workDir),
        window.snow.gitLog(workDir, 0, COMMIT_PAGE_SIZE),
      ]);
      setStatus(statusResult);
      setCommits(logEntries);
      setHasMoreCommits(logEntries.length >= COMMIT_PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [workDir]);

  // 滚动到提交列表底部时按页追加加载（无限滚动）。
  const loadMoreCommits = useCallback(async (): Promise<void> => {
    if (!workDir || !hasMoreCommits || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const next = await window.snow.gitLog(
        workDir,
        commits.length,
        COMMIT_PAGE_SIZE,
      );
      setCommits((prev) => {
        const seen = new Set(prev.map((commit) => commit.hash));
        const merged = [
          ...prev,
          ...next.filter((commit) => !seen.has(commit.hash)),
        ];
        return merged;
      });
      setHasMoreCommits(next.length >= COMMIT_PAGE_SIZE);
    } catch {
      setHasMoreCommits(false);
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [commits.length, hasMoreCommits, workDir]);

  // 观察提交列表底部的哨兵元素，进入视口即触发加载下一页。
  useEffect(() => {
    const sentinel = commitsSentinelRef.current;
    const root = commitsListRef.current;
    if (!sentinel || !root || !hasMoreCommits) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreCommits();
        }
      },
      { root, rootMargin: "48px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreCommits, loadMoreCommits]);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setInstructions("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void loadGitData();
  }, [open, loadVersion, loadGitData]);

  // 已暂存：与 GitControl 的划分保持一致 —— index 列为状态字符
  // （非空格、非未跟踪标记 ?、非空）。
  const stagedFiles = useMemo(
    () =>
      (status?.files ?? []).filter(
        (file) =>
          file.indexStatus !== " " &&
          file.indexStatus !== "?" &&
          file.indexStatus !== "",
      ),
    [status],
  );

  // 工作区变更：与 GitControl 的划分保持一致 —— 未跟踪（?）或
  // workdir 列有修改状态。
  const unstagedFiles = useMemo(
    () =>
      (status?.files ?? []).filter(
        (file) =>
          file.workdirStatus === "?" ||
          (file.workdirStatus !== " " && file.workdirStatus !== ""),
      ),
    [status],
  );

  const toggle = useCallback((key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback((keys: string[]): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (allSelected) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  }, []);

  const selectedCount = selected.size;
  const isRepo = status?.isRepo ?? true;

  const buildPrompt = async (): Promise<string> => {
    const selectedStaged = stagedFiles.filter((file) =>
      selected.has(`staged:${file.path}`),
    );
    const selectedUnstaged = unstagedFiles.filter((file) =>
      selected.has(`unstaged:${file.path}`),
    );
    const selectedCommits = commits.filter((commit) =>
      selected.has(`commit:${commit.hash}`),
    );

    // 并行拉取所有选中项的 diff（Rust 后端生成）。
    const [stagedDiffs, unstagedDiffs, commitDiffs] = await Promise.all([
      Promise.all(
        selectedStaged.map(async (file) => ({
          file,
          diff: await window.snow.gitFileDiff(workDir, file.path, true),
        })),
      ),
      Promise.all(
        selectedUnstaged.map(async (file) => ({
          file,
          diff: await window.snow.gitFileDiff(workDir, file.path, false),
        })),
      ),
      Promise.all(
        selectedCommits.map(async (commit) => ({
          commit,
          diff: await window.snow.gitCommitDiff(workDir, commit.hash),
        })),
      ),
    ]);

    const lines: string[] = [];
    let totalChars = 0;
    let truncated = false;

    const appendDiff = (header: string, content: string): boolean => {
      const block = `${header}\n\`\`\`diff\n${content.trimEnd()}\n\`\`\`\n`;
      if (totalChars + block.length > MAX_TOTAL_DIFF_CHARS) {
        truncated = true;
        lines.push(`${header}\n${t("chat.review.promptDiffOmitted")}\n`);
        return false;
      }
      totalChars += block.length;
      lines.push(block);
      return true;
    };

    const diffBody = (content: string, isBinary: boolean): string => {
      if (isBinary || content.startsWith("Binary file")) {
        return t("chat.review.promptBinary");
      }
      if (content.length > MAX_DIFF_CHARS) {
        truncated = true;
        return `${content.slice(0, MAX_DIFF_CHARS)}\n... (${t(
          "chat.review.promptDiffTruncated",
        )})`;
      }
      return content;
    };

    lines.push(t("chat.review.promptHeader"));
    lines.push(t("chat.review.promptRule"));
    lines.push(t("chat.review.promptFocus"));
    lines.push(t("chat.review.promptSeverity"));
    lines.push(t("chat.review.promptSummary"));
    lines.push("");
    lines.push(`${t("chat.review.promptRepo")}: ${workDir}`);
    if (status?.currentBranch) {
      lines.push(`${t("chat.review.promptBranch")}: ${status.currentBranch}`);
    }
    lines.push("");

    if (selectedStaged.length > 0) {
      lines.push(`## ${t("chat.review.sectionStaged")}`);
      for (const { file, diff } of stagedDiffs) {
        appendDiff(
          `- ${statusLabel(file)}`,
          diffBody(diff.content, diff.isBinary),
        );
      }
      lines.push("");
    }

    if (selectedUnstaged.length > 0) {
      lines.push(`## ${t("chat.review.sectionUnstaged")}`);
      for (const { file, diff } of unstagedDiffs) {
        appendDiff(
          `- ${statusLabel(file)}`,
          diffBody(diff.content, diff.isBinary),
        );
      }
      lines.push("");
    }

    if (selectedCommits.length > 0) {
      lines.push(`## ${t("chat.review.sectionCommits")}`);
      for (const { commit, diff } of commitDiffs) {
        appendDiff(
          `- ${commit.shortHash} ${commit.date} - ${commit.message}（${commit.author}）`,
          diffBody(diff.content, diff.isBinary),
        );
      }
      lines.push("");
    }

    if (instructions.trim()) {
      lines.push(`## ${t("chat.review.promptUserNote")}`);
      lines.push(instructions.trim());
      lines.push("");
    }

    if (truncated) {
      lines.push(t("chat.review.promptTruncated"));
      lines.push("");
    }

    lines.push(t("chat.review.promptEnd"));
    return lines.join("\n");
  };

  const handleStart = async (): Promise<void> => {
    if (selected.size === 0 || isSending || !workDir) return;
    setIsSending(true);
    try {
      const prompt = await buildPrompt();
      // 完整 prompt 编码为 review 标签发送：消息渲染为 chip（避免渲染
      // 海量 diff 文本节点），Rust 后端在请求 AI 时再展开为完整内容。
      const summaryBase = t("chat.review.tagSummary", {
        values: { count: selected.size },
      });
      const summary = status?.currentBranch
        ? `${summaryBase} · ${status.currentBranch}`
        : summaryBase;
      const tag: ReviewTag = {
        prompt,
        summary,
        charCount: prompt.length,
        branch: status?.currentBranch,
        repoPath: workDir,
      };
      onStartReview(encodeReviewTag(tag));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSending(false);
    }
  };

  const renderFileRow = (
    key: string,
    file: {
      status: string;
      oldPath: string | null;
      path: string;
      workdirStatus: string;
    },
    kind: "staged" | "unstaged",
  ): React.JSX.Element => {
    const checked = selected.has(key);
    const isUntracked = file.workdirStatus.trim() === "?";
    return (
      <li
        className={`review-file-row${checked ? " is-selected" : ""}`}
        key={key}
        onClick={() => toggle(key)}
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle(key);
          }
        }}
      >
        <span className={`review-check${checked ? " is-checked" : ""}`}>
          {checked ? <Check size={12} strokeWidth={2.6} /> : null}
        </span>
        <span className="review-file-path" title={file.path}>
          {file.path}
        </span>
        <span
          className={`review-kind is-${
            isUntracked
              ? "untracked"
              : kind === "staged"
                ? "staged"
                : "unstaged"
          }`}
        >
          {isUntracked ? "U" : file.status}
        </span>
      </li>
    );
  };

  const renderCommitRow = (commit: GitLogEntry): React.JSX.Element => {
    const key = `commit:${commit.hash}`;
    const checked = selected.has(key);
    return (
      <li
        className={`review-commit-row${checked ? " is-selected" : ""}`}
        key={key}
        onClick={() => toggle(key)}
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle(key);
          }
        }}
      >
        <span className={`review-check${checked ? " is-checked" : ""}`}>
          {checked ? <Check size={12} strokeWidth={2.6} /> : null}
        </span>
        <GitCommitHorizontal size={13} className="review-commit-icon" />
        <span className="review-commit-hash">{commit.shortHash}</span>
        <span className="review-commit-message" title={commit.message}>
          {commit.message}
        </span>
        <span className="review-commit-author">{commit.author}</span>
        <span className="review-commit-date">{commit.date}</span>
      </li>
    );
  };

  const renderSection = (
    title: string,
    items: React.JSX.Element[],
    keys: string[],
    emptyText: string,
    options?: {
      listClassName?: string;
      listRef?: React.Ref<HTMLUListElement>;
      footer?: React.ReactNode;
    },
  ): React.JSX.Element => (
    <section className="review-section">
      <div className="review-section-header">
        <span className="review-section-title">{title}</span>
        {items.length > 0 ? (
          <button
            type="button"
            className="review-select-all"
            onClick={() => toggleAll(keys)}
          >
            {t("chat.review.selectAll")}
          </button>
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul
          className={`review-list${options?.listClassName ? ` ${options.listClassName}` : ""}`}
          ref={options?.listRef}
        >
          {items}
          {options?.footer}
        </ul>
      ) : (
        <div className="review-section-empty">{emptyText}</div>
      )}
    </section>
  );

  const hasNoContent =
    !isLoading &&
    stagedFiles.length === 0 &&
    unstagedFiles.length === 0 &&
    commits.length === 0;

  return (
    <Modal
      className="review-modal"
      closeLabel={t("chat.review.close")}
      closeOnEscape
      description={t("chat.review.description")}
      onClose={onClose}
      open={open}
      size="large"
      title={t("chat.review.title")}
      footer={
        <div className="review-footer">
          <span className="review-selected-count">
            {t("chat.review.selectedCount", {
              values: { count: selectedCount },
            })}
          </span>
          <button
            type="button"
            className="review-start-btn"
            disabled={selected.size === 0 || isSending || !isRepo}
            onClick={() => void handleStart()}
          >
            {isSending ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <ScanSearch size={14} />
            )}
            {t("chat.review.startReview")}
          </button>
        </div>
      }
    >
      <div className="review-body">
        {!workDir ? (
          <div className="review-empty">
            <span className="review-empty-title">
              {t("chat.review.notRepo")}
            </span>
            <span className="review-empty-hint">
              {t("chat.review.notRepoHint")}
            </span>
          </div>
        ) : isLoading ? (
          <div className="review-loading">
            <Loader2 size={18} className="spin" />
            <span>{t("chat.review.loading")}</span>
          </div>
        ) : error ? (
          <div className="review-error">
            <CircleAlert size={15} />
            <span>{error}</span>
            <button
              type="button"
              className="review-retry-btn"
              onClick={() => setLoadVersion((v) => v + 1)}
            >
              <RefreshCw size={12} />
              {t("chat.review.refresh")}
            </button>
          </div>
        ) : !isRepo ? (
          <div className="review-empty">
            <span className="review-empty-title">
              {t("chat.review.notRepo")}
            </span>
            <span className="review-empty-hint">
              {t("chat.review.notRepoHint")}
            </span>
          </div>
        ) : hasNoContent ? (
          <div className="review-empty">
            <span className="review-empty-title">{t("chat.review.empty")}</span>
          </div>
        ) : (
          <div className="review-content">
            <div className="review-toolbar">
              <span className="review-branch">
                {status?.currentBranch
                  ? `${t("chat.review.promptBranch")}: ${status.currentBranch}`
                  : workDir}
              </span>
              <button
                type="button"
                className="review-refresh-btn"
                onClick={() => setLoadVersion((v) => v + 1)}
              >
                <RefreshCw size={12} />
                {t("chat.review.refresh")}
              </button>
            </div>

            {renderSection(
              t("chat.review.sectionStaged"),
              stagedFiles.map((file) =>
                renderFileRow(`staged:${file.path}`, file, "staged"),
              ),
              stagedFiles.map((file) => `staged:${file.path}`),
              t("chat.review.noStaged"),
            )}

            {renderSection(
              t("chat.review.sectionUnstaged"),
              unstagedFiles.map((file) =>
                renderFileRow(`unstaged:${file.path}`, file, "unstaged"),
              ),
              unstagedFiles.map((file) => `unstaged:${file.path}`),
              t("chat.review.noUnstaged"),
            )}

            {renderSection(
              t("chat.review.sectionCommits"),
              commits.map((commit) => renderCommitRow(commit)),
              commits.map((commit) => `commit:${commit.hash}`),
              t("chat.review.noCommits"),
              {
                listClassName: "is-commits",
                listRef: commitsListRef,
                footer:
                  hasMoreCommits || isLoadingMore ? (
                    <li className="review-load-more" ref={commitsSentinelRef}>
                      {isLoadingMore ? (
                        <Loader2 size={13} className="spin" />
                      ) : null}
                      <span>{t("chat.review.loadingMore")}</span>
                    </li>
                  ) : commits.length > COMMIT_PAGE_SIZE ? (
                    <li className="review-load-more is-done">
                      <span>{t("chat.review.allLoaded")}</span>
                    </li>
                  ) : undefined,
              },
            )}

            <div className="review-instructions">
              <label
                className="review-instructions-label"
                htmlFor="review-instructions"
              >
                {t("chat.review.instructionsLabel")}
              </label>
              <textarea
                id="review-instructions"
                className="review-instructions-input"
                placeholder={t("chat.review.instructionsPlaceholder")}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={3}
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
