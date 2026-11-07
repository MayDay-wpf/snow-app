import { FolderGit2, GitBranch, GitCommitHorizontal } from "lucide-react";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import type { GitLogEntry, GitWorktreeInfo } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { imageProxyUrl } from "../../../utils/imageProxyUrl";
import { getCommitWorktrees, parseRefs } from "./gitGraphRefs";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  getCommitAvatarUrl,
  getCommitWebLink,
  parseGitDate,
  REMOTE_LINK_LABEL_KEY,
} from "./gitGraphUtils";

type CommitTooltipProps = {
  commit: GitLogEntry;
  worktrees: GitWorktreeInfo[];
  /** 仓库远端地址（优先 origin）：用于「在 GitHub 上打开」的提交链接。 */
  remoteUrl: string | null;
  /** 按作者邮箱反查到的 GitHub 头像（邮箱小写 → 地址）；可为空对象。 */
  authorAvatars: Record<string, string>;
  tooltipRef: React.RefObject<HTMLDivElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

type BodyBlock =
  | { kind: "list"; items: { text: string; depth: number }[] }
  | { kind: "text"; text: string };

/**
 * 提交正文轻量按 markdown 列表渲染：`-` / `*` / `+` 开头的行成列表项（按两空格
 * 缩进最多两级），其余非空行成段落，空行结束当前列表。正文来自 git，可能含任意
 * 用户文本，这里只做结构切分，文本一律交给 React 转义，不做 HTML 注入。
 */
const parseBodyBlocks = (body: string): BodyBlock[] => {
  const blocks: BodyBlock[] = [];
  let list: Extract<BodyBlock, { kind: "list" }> | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const item = /^([ \t]*)[-*+]\s+(.*)$/.exec(rawLine);
    if (item) {
      if (!list) {
        const created: Extract<BodyBlock, { kind: "list" }> = {
          kind: "list",
          items: [],
        };
        blocks.push(created);
        list = created;
      }
      const indent = item[1].replace(/\t/g, "  ").length;
      list.items.push({
        text: item[2],
        depth: Math.min(Math.floor(indent / 2), 2),
      });
      continue;
    }

    // 非列表行（含空行）结束当前列表。
    list = null;
    const text = rawLine.trim();
    if (text) {
      blocks.push({ kind: "text", text });
    }
  }

  return blocks;
};

export function CommitTooltip({
  commit,
  worktrees,
  remoteUrl,
  authorAvatars,
  tooltipRef,
  onMouseEnter,
  onMouseLeave,
}: CommitTooltipProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const parsedRefs = parseRefs(commit.refs);
  const commitWorktrees = getCommitWorktrees(commit, parsedRefs, worktrees);
  const commitDate = parseGitDate(commit.date);
  const relativeTime = commitDate ? formatRelativeTime(commitDate, locale) : "";
  const absoluteTime = commitDate
    ? formatAbsoluteTime(commitDate, locale)
    : commit.date;

  // 仅显示 GitHub 头像：API 反查覆盖普通邮箱，noreply 邮箱可直接推导。
  // 不再用 Gravatar、几何图案或首字母替换 GitHub 头像。
  const normalizedEmail = commit.email?.trim().toLowerCase() ?? "";
  const avatarSrc = normalizedEmail
    ? (authorAvatars[normalizedEmail] ?? getCommitAvatarUrl(commit.email))
    : null;

  const bodyBlocks = useMemo(
    () => (commit.body ? parseBodyBlocks(commit.body) : []),
    [commit.body],
  );

  const commitLink = useMemo(
    () => getCommitWebLink(remoteUrl, commit.hash),
    [remoteUrl, commit.hash],
  );

  const hasStats =
    commit.filesChanged > 0 || commit.additions > 0 || commit.deletions > 0;
  // 文件数已随 git log --shortstat 一并返回；仅个别提交（如空改动合并）缺失。
  const statsValues = {
    count: commit.filesChanged,
    insertions: commit.additions,
    deletions: commit.deletions,
  };
  // 完整句子（文件数 + 插入 + 删除）只作悬停标题与读屏文本；卡片正文改用
  // 「文件数 + 绿色 +N + 红色 -N」的紧凑标记，与工具卡片、文件变更面板一致。
  const statsSentence =
    commit.filesChanged === 1
      ? t("git.tooltipChangedFilesOne", { values: statsValues })
      : t("git.tooltipChangedFiles", { values: statsValues });
  const statsTitle =
    commit.filesChanged > 0 ? statsSentence : t("git.graphTooltipStats");

  return createPortal(
    <div
      className="git-graph-tooltip"
      ref={tooltipRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="git-graph-tooltip-arrow" aria-hidden="true" />
      <div className="git-graph-tooltip-header">
        {avatarSrc && (
          <span className="git-graph-tooltip-avatar" aria-hidden="true">
            <img
              className="git-graph-tooltip-avatar-img"
              src={imageProxyUrl(avatarSrc)}
              alt=""
            />
          </span>
        )}
        <span className="git-graph-tooltip-author">{commit.author}</span>
        <span
          className="git-graph-tooltip-time"
          title={[
            `${t("git.graphTooltipAuthor")}: ${commit.author}${
              commit.email ? ` <${commit.email}>` : ""
            }`,
            `${t("git.graphTooltipDate")}: ${commit.date}`,
          ].join("\n")}
        >
          {relativeTime ? `${relativeTime} (${absoluteTime})` : commit.date}
        </span>
      </div>
      <div className="git-graph-tooltip-message-section">
        <div className="git-graph-tooltip-subject">{commit.message}</div>
        {bodyBlocks.length > 0 && (
          <div className="git-graph-tooltip-body">
            {bodyBlocks.map((block, index) =>
              block.kind === "list" ? (
                <ul
                  key={`list-${index}`}
                  className="git-graph-tooltip-list"
                  // 嵌套层级由正文缩进决定，层级很浅且内容不可信，直接内联。
                  style={
                    block.items[0]?.depth
                      ? { paddingLeft: 16 + block.items[0].depth * 12 }
                      : undefined
                  }
                >
                  {block.items.map((item, itemIndex) => (
                    <li key={`item-${itemIndex}`}>{item.text}</li>
                  ))}
                </ul>
              ) : (
                <p
                  key={`text-${index}`}
                  className="git-graph-tooltip-paragraph"
                >
                  {block.text}
                </p>
              ),
            )}
          </div>
        )}
      </div>
      {(parsedRefs.length > 0 ||
        commitWorktrees.length > 0 ||
        commit.parents.length > 0) && (
        <div className="git-graph-tooltip-meta">
          {parsedRefs.length > 0 && (
            <span
              className="git-graph-tooltip-meta-item"
              title={t("git.graphTooltipRefs")}
            >
              <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
              {parsedRefs.map((ref) => ref.name).join(", ")}
            </span>
          )}
          {commit.parents.length > 0 && (
            <span
              className="git-graph-tooltip-meta-item git-graph-tooltip-mono"
              title={t("git.graphTooltipParents")}
            >
              <GitCommitHorizontal
                size={11}
                strokeWidth={2}
                aria-hidden="true"
              />
              {commit.parents.map((parent) => parent.slice(0, 7)).join(", ")}
            </span>
          )}
          {commitWorktrees.map((worktree) => (
            <span
              key={`tooltip-worktree-${worktree.worktreeId}`}
              className="git-graph-tooltip-meta-item"
              title={t("git.graphWorktreeTooltip", {
                values: {
                  path: worktree.worktreePath,
                  state: worktree.isDirty
                    ? t("git.worktreeDirty")
                    : t("git.graphWorktreeClean"),
                  validity: worktree.isValid
                    ? ""
                    : ` · ${t("git.graphWorktreeInvalid")}`,
                },
              })}
            >
              <FolderGit2 size={11} strokeWidth={2} aria-hidden="true" />
              {worktree.branchName ?? t("git.graphDetachedHead")}
            </span>
          ))}
        </div>
      )}
      {hasStats && (
        <div className="git-graph-tooltip-stats" title={statsTitle}>
          <span className="git-graph-stats">
            {commit.filesChanged > 0 && (
              <span className="git-graph-stats-files">
                {commit.filesChanged === 1
                  ? t("git.tooltipFilesChangedOne")
                  : t("git.tooltipFilesChanged", {
                      values: { count: commit.filesChanged },
                    })}
              </span>
            )}
            {commit.additions > 0 && (
              <span className="git-graph-stats-add">
                +{commit.additions.toLocaleString(locale)}
              </span>
            )}
            {commit.deletions > 0 && (
              <span className="git-graph-stats-del">
                -{commit.deletions.toLocaleString(locale)}
              </span>
            )}
          </span>
        </div>
      )}
      <div className="git-graph-tooltip-footer">
        <span
          className="git-graph-tooltip-hash"
          title={`${t("git.graphTooltipHash")}: ${commit.hash}`}
        >
          <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
          {commit.shortHash}
        </span>
        {commitLink && (
          <>
            <span
              className="git-graph-tooltip-footer-divider"
              aria-hidden="true"
            />
            <button
              type="button"
              className="git-graph-tooltip-link"
              onClick={() => {
                if (commitLink) {
                  window.open(commitLink.url, "_blank");
                }
              }}
            >
              {t(REMOTE_LINK_LABEL_KEY[commitLink.provider])}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
