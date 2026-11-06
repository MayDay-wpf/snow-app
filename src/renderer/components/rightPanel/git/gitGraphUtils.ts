import type {
  GitCommitFile,
  GitFileStatus,
  GitLogEntry,
} from "../../../../preload";
import type { TranslateOptions } from "../../../i18n";
import { parseRefs } from "./gitGraphRefs";

/** 将提交文件（GitCommitFile）转换为 DiffTab 所需的 GitFileStatus 形状。 */
export const toGitFileStatus = (file: GitCommitFile): GitFileStatus => ({
  path: file.path,
  oldPath: null,
  indexStatus: "",
  workdirStatus: "",
  status: file.status,
});

/** 图片文件直接渲染图片而非文本 diff（文本 diff 会因二进制 --text
 *  重试产生巨大乱码 patch 而卡死）。 */
export const isImageFile = (path: string): boolean =>
  /\.(png|jpe?g|gif|bmp|webp|ico|svg|tiff?|avif)$/i.test(path);

export function formatDate(dateStr: string): string {
  return dateStr.split(" ")[0];
}

export function getCommitFileColor(status: string): string {
  if (status.startsWith("A")) return "git-status-add";
  if (status.startsWith("D")) return "git-status-delete";
  if (status.startsWith("R")) return "git-status-rename";
  return "git-status-modify";
}

export function getCommitFileLabel(status: string): string {
  if (status.startsWith("A")) return "A";
  if (status.startsWith("D")) return "D";
  if (status.startsWith("R")) return "R";
  if (status.startsWith("C")) return "C";
  if (status.startsWith("M")) return "M";
  return status.charAt(0);
}

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function isOtherWorktreePath(
  wtPath: string | null | undefined,
  repoPath: string,
): boolean {
  if (!wtPath) return false;
  return normalizePath(wtPath) !== normalizePath(repoPath);
}

export function getWorktreeFolderName(wtPath: string): string {
  const parts = wtPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || wtPath;
}

/**
 * 解析 git 输出的提交时间（`2026-10-09 16:36:32 +0800`，或 ISO 串）。
 * 解析失败返回 null，调用方回退展示原始字符串。
 */
export function parseGitDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // "2026-10-09 16:36:32 +0800" -> "2026-10-09T16:36:32+08:00"
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?$/.exec(
      trimmed,
    );
  if (match) {
    const [, datePart, timePart, offsetHour, offsetMinute] = match;
    const offset = offsetHour ? `${offsetHour}:${offsetMinute}` : "";
    const parsed = new Date(`${datePart}T${timePart}${offset}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** 相对时间单位由粗到细，命中第一个不超过差值的单位。 */
const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

/** 相对时间（如「1 小时前」），按当前界面语言本地化，含单复数处理。 */
export function formatRelativeTime(date: Date, locale: string): string {
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "long",
  });

  for (const [unit, unitSeconds] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffSeconds) >= unitSeconds || unit === "second") {
      return formatter.format(Math.round(diffSeconds / unitSeconds), unit);
    }
  }

  return formatter.format(0, "second");
}

/** 绝对时间（如「2026年10月9日 16:36」），按当前界面语言本地化。 */
export function formatAbsoluteTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** 远端托管平台：决定提交网页地址的路径规则与「打开」按钮文案。 */
export type CommitRemoteProvider =
  "github" | "gitlab" | "gitee" | "bitbucket" | "other";

export type CommitWebLink = {
  url: string;
  provider: CommitRemoteProvider;
};

type ParsedRemote = {
  host: string;
  path: string;
};

/** 解析远端地址（https / ssh / scp 三种写法）为 host + path。 */
const parseRemote = (remoteUrl: string | null): ParsedRemote | null => {
  const trimmed = remoteUrl?.trim() ?? "";
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
    } catch {
      return null;
    }
  }

  // scp 形式：git@github.com:owner/repo.git
  const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (!match) return null;
  return { host: match[1].toLowerCase(), path: match[2] };
};

/** 去掉首尾斜杠与 .git 后缀，得到 `owner/repo`。 */
const repositoryOfPath = (path: string): string =>
  path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

const providerOfHost = (host: string): CommitRemoteProvider => {
  switch (host.replace(/^www\./, "")) {
    case "github.com":
      return "github";
    case "gitlab.com":
      return "gitlab";
    case "gitee.com":
      return "gitee";
    case "bitbucket.org":
      return "bitbucket";
    default:
      return "other";
  }
};

/** 各平台的提交详情页路径（其余平台沿用 `/commit/<hash>`）。 */
const commitPathOf = (
  provider: CommitRemoteProvider,
  repository: string,
  hash: string,
): string => {
  switch (provider) {
    case "gitlab":
      return `${repository}/-/commit/${hash}`;
    case "bitbucket":
      return `${repository}/commits/${hash}`;
    default:
      return `${repository}/commit/${hash}`;
  }
};

/**
 * 由远端地址推导该提交的网页地址，并给出托管平台（决定按钮文案）。
 * 支持 https / ssh / scp 三种写法；地址无法解析时返回 null。
 */
export function getCommitWebLink(
  remoteUrl: string | null,
  hash: string,
): CommitWebLink | null {
  const remote = parseRemote(remoteUrl);
  if (!remote || !hash) return null;

  const repository = repositoryOfPath(remote.path);
  if (!repository) return null;

  const provider = providerOfHost(remote.host);
  return {
    url: `https://${remote.host}/${commitPathOf(provider, repository, hash)}`,
    provider,
  };
}

/** GitHub noreply 邮箱：`<id>+<login>@users.noreply.github.com`（新版）或
 *  `<login>@users.noreply.github.com`（旧版），两种写法都取 login。 */
const GITHUB_NOREPLY_RE = /^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/;

/**
 * 按 GitHub noreply 邮箱直接推导头像，供 API 结果返回前使用。
 * 普通邮箱由 GitHub 提交 API 反查；无法取得 GitHub 头像时不使用其他平台替代。
 */
export function getCommitAvatarUrl(
  email: string | null | undefined,
  size = 40,
): string | null {
  const noreply = GITHUB_NOREPLY_RE.exec(email?.trim().toLowerCase() ?? "");
  return noreply ? `https://github.com/${noreply[1]}.png?size=${size}` : null;
}

/** 远端平台 → 「打开」文案词条（悬停卡片底栏与提交右键菜单共用）。 */
export const REMOTE_LINK_LABEL_KEY: Record<CommitRemoteProvider, string> = {
  github: "git.tooltipOpenOnGitHub",
  gitlab: "git.tooltipOpenOnGitLab",
  gitee: "git.tooltipOpenOnRemote",
  bitbucket: "git.tooltipOpenOnRemote",
  other: "git.tooltipOpenOnRemote",
};

/**
 * 把一次提交整理成可直接落库的备忘录正文：字段标签跟随界面语言，提交说明保留
 * 原始换行（备忘录按纯文本展示）。只做文本拼接，不做任何标记语法。
 */
export function buildCommitMemoContent(
  commit: GitLogEntry,
  t: (key: string, options?: TranslateOptions) => string,
): string {
  const lines: string[] = [];

  lines.push(`${t("git.graphTooltipHash")}: ${commit.hash}`);
  lines.push(
    `${t("git.graphTooltipAuthor")}: ${commit.author}${
      commit.email ? ` <${commit.email}>` : ""
    }`,
  );
  lines.push(`${t("git.graphTooltipDate")}: ${commit.date}`);

  const refs = parseRefs(commit.refs)
    .map((ref) => ref.name)
    .join(", ");
  if (refs) {
    lines.push(`${t("git.graphTooltipRefs")}: ${refs}`);
  }
  if (commit.parents.length > 0) {
    lines.push(`${t("git.graphTooltipParents")}: ${commit.parents.join(", ")}`);
  }

  const stats = `${t("git.graphTooltipStats")}: +${commit.additions} -${commit.deletions}`;
  lines.push(
    commit.filesChanged > 0
      ? `${stats} · ${t("git.memoFiles", {
          values: { count: commit.filesChanged },
        })}`
      : stats,
  );

  lines.push("");
  lines.push(`${t("git.memoMessage")}:`);
  lines.push(
    commit.body ? `${commit.message}\n\n${commit.body}` : commit.message,
  );

  return lines.join("\n");
}
