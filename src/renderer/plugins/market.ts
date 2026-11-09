import { imageProxyUrl } from "../utils/imageProxyUrl";
import type { PluginLocalizedMap } from "./types";

/** 市场分类：面板插件 / 工具插件 / 脚本插件 / OAuth 登录插件。 */
export type MarketCategory = "panel" | "tool" | "script" | "oauth";

/** 市场标签页：四个官方分类 + 社区通道（GitHub `snow-plugins` 主题检索）。 */
export type MarketTab = MarketCategory | "community";

/** 市场条目的结构化字段（与市场索引仓库 registry.json 对应）。 */
export type MarketPluginEntry = {
  id: string;
  /** 安装通道：工具插件与 OAuth 插件都按 plugin 安装，只有脚本条目走单独通道。 */
  kind: "plugin" | "script";
  category: MarketCategory;
  name: PluginLocalizedMap;
  description: PluginLocalizedMap;
  author: string;
  homepage: string;
  repo: string;
  version: string;
  tag: string;
  asset: string;
  downloadUrl: string;
  sha256: string;
  minAppVersion: string;
  privacy: string[];
  tags: string[];
  icon: string;
  /** 索引条目是否声明了官方人工审核（`verified: true`），用于区分认证徽章。 */
  verified: boolean;
};

export type MarketRegistry = {
  schemaVersion: number;
  updatedAt: string;
  plugins: MarketPluginEntry[];
};

export const PLUGIN_MARKET_REPO_URL =
  "https://github.com/MayDay-wpf/snow-plugin-store";

/** 市场条目图标来源：宿主内置图标，或可直接渲染的图片地址。 */
export type MarketIconSource =
  { kind: "lucide"; name: string } | { kind: "image"; src: string };

const LUCIDE_ICON_PREFIX = "lucide:";
const REMOTE_ICON_PATTERN = /^https?:\/\//i;
const INLINE_ICON_PATTERN = /^data:image\//i;

/**
 * 市场条目图标解析（官方索引条目与社区仓库条目共用）。
 *
 * 市场条目在安装前没有插件目录，因此不接受插件内相对路径：
 * - `lucide:Name`：宿主内置图标；
 * - `http(s)://`：转为 `img-proxy://` 代理地址（CSP 的 `img-src` 只放行该协议）；
 * - `data:image/...`：原样内联渲染；
 * - 其余（含插件内相对路径）：返回 null，由渲染层回退占位图标。
 *
 * 官方索引条目缺图标时已由 Rust 侧读取仓库 `plugin.json` 补全为绝对 raw 地址
 * （见 `native/src/plugin_market.rs`），这里仍保留相对路径的兜底。
 */
export const resolveMarketIcon = (icon: string): MarketIconSource | null => {
  const trimmed = icon.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase().startsWith(LUCIDE_ICON_PREFIX)) {
    return {
      kind: "lucide",
      name: trimmed.slice(LUCIDE_ICON_PREFIX.length).trim(),
    };
  }
  if (REMOTE_ICON_PATTERN.test(trimmed)) {
    return { kind: "image", src: imageProxyUrl(trimmed) };
  }
  if (INLINE_ICON_PATTERN.test(trimmed)) {
    return { kind: "image", src: trimmed };
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const toLocalized = (value: unknown): PluginLocalizedMap => {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { default: text } : {};
  }
  if (!isRecord(value)) {
    return {};
  }
  const result: PluginLocalizedMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      continue;
    }
    const text = item.trim();
    if (text) {
      result[key] = text;
    }
  }
  return result;
};

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
};

/** 非负整数计数：非法值一律按 0 处理。 */
const toNonNegativeCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

const MARKET_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i;

const normalizeRepoUrl = (value: string): string =>
  value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

/** 分类：kind=script 为脚本；kind=oauth 或带 oauth 标签为 OAuth 插件；kind=tool 或带 tool 标签为工具插件。 */
const resolveMarketCategory = (
  rawKind: unknown,
  tags: string[],
): MarketCategory => {
  if (rawKind === "script") {
    return "script";
  }
  if (
    rawKind === "oauth" ||
    tags.some((tag) => tag.toLowerCase() === "oauth")
  ) {
    return "oauth";
  }
  if (rawKind === "tool" || tags.some((tag) => tag.toLowerCase() === "tool")) {
    return "tool";
  }
  return "panel";
};

/** 解析市场索引文本；单个无效条目会被丢弃，不会让整份索引失败。 */
export const parseMarketRegistry = (text: string): MarketRegistry => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Invalid plugin market registry");
  }
  const rawPlugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  const plugins: MarketPluginEntry[] = [];
  for (const raw of rawPlugins) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = asTrimmedString(raw.id);
    const repo = normalizeRepoUrl(asTrimmedString(raw.repo));
    const version = asTrimmedString(raw.version);
    const sha256 = asTrimmedString(raw.sha256);
    if (
      !id ||
      !GITHUB_REPO_PATTERN.test(repo) ||
      !version ||
      !MARKET_SHA256_PATTERN.test(sha256)
    ) {
      continue;
    }
    const tags = toStringList(raw.tags);
    plugins.push({
      id,
      kind: raw.kind === "script" ? "script" : "plugin",
      category: resolveMarketCategory(raw.kind, tags),
      name: toLocalized(raw.name),
      description: toLocalized(raw.description),
      author: asTrimmedString(raw.author),
      homepage: asTrimmedString(raw.homepage),
      repo,
      version,
      tag: asTrimmedString(raw.tag),
      asset: asTrimmedString(raw.asset),
      downloadUrl: asTrimmedString(raw.downloadUrl),
      sha256: sha256.toLowerCase(),
      minAppVersion: asTrimmedString(raw.minAppVersion),
      privacy: toStringList(raw.privacy),
      tags,
      icon: asTrimmedString(raw.icon),
      verified: raw.verified === true,
    });
  }
  return {
    schemaVersion:
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
    updatedAt: asTrimmedString(parsed.updatedAt),
    plugins,
  };
};

/** 构造条目的 zip 下载直链；缺少可用分发信息时返回 null。 */
export const buildMarketDownloadUrl = (
  entry: MarketPluginEntry,
): string | null => {
  if (entry.downloadUrl.startsWith("https://")) {
    return entry.downloadUrl;
  }
  const match = GITHUB_REPO_PATTERN.exec(entry.repo);
  if (!match || !entry.tag || !entry.asset) {
    return null;
  }
  return `https://github.com/${match[1]}/${match[2]}/releases/download/${entry.tag}/${entry.asset}`;
};

/** 简单版本比较（-1 / 0 / 1）：容忍 v 前缀，非数字段按 0 处理。 */
export const compareMarketVersions = (left: string, right: string): number => {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) && part > 0 ? part : 0));
  const leftParts = parse(left);
  const rightParts = parse(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
};

/** 市场版本是否高于本地已安装版本。 */
export const hasMarketUpdate = (
  installedVersion: string,
  marketVersion: string,
): boolean => compareMarketVersions(installedVersion, marketVersion) < 0;

/** 市场条目要求的应用版本是否高于当前应用版本。 */
export const isMarketEntryTooNew = (
  entry: MarketPluginEntry,
  appVersion: string,
): boolean =>
  Boolean(entry.minAppVersion) &&
  Boolean(appVersion) &&
  compareMarketVersions(appVersion, entry.minAppVersion) < 0;

/** 下载量统计请求目标（Rust 侧按仓库 + tag 查询 Release 资产下载数）。 */
export type MarketStatsTarget = {
  id: string;
  repo: string;
  tag: string;
  asset: string;
};

/** 汇总统计请求目标：仅保留能解析出 GitHub Release 的条目。 */
export const buildMarketStatsTargets = (
  entries: MarketPluginEntry[],
): MarketStatsTarget[] =>
  entries
    .filter(
      (entry) =>
        GITHUB_REPO_PATTERN.test(entry.repo) && entry.tag.trim() !== "",
    )
    .map((entry) => ({
      id: entry.id,
      repo: entry.repo,
      tag: entry.tag,
      asset: entry.asset,
    }));

/** 解析下载量统计 JSON；解析失败或非法值一律忽略。 */
export const parseMarketStats = (text: string): Record<string, number> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.counts)) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const [id, value] of Object.entries(parsed.counts)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      counts[id] = Math.floor(value);
    }
  }
  return counts;
};

/** 计数紧凑展示：1000 以下原样，千 / 百万分别用 k / M（下载量与社区仓库星标共用）。 */
export const formatCompactCount = (count: number): string => {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1000000) {
    return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`;
  }
  return `${(count / 1000000).toFixed(1)}M`;
};

/** 社区插件通道约定的 GitHub 主题名；与 Rust `native/src/plugin_community.rs` 的 `COMMUNITY_TOPIC` 保持一致。 */
export const COMMUNITY_PLUGIN_TOPIC = "snow-plugins";

/** 社区插件主题的 GitHub 浏览地址（市场页「来源」行与空态使用）。 */
export const COMMUNITY_PLUGIN_TOPICS_URL = `https://github.com/topics/${COMMUNITY_PLUGIN_TOPIC}`;

/** 社区仓库条目（GitHub 搜索 API 结果，与 Rust 侧 `CommunityRepo` 字段一一对应）。 */
export type CommunityPluginEntry = {
  /** `owner/repo`。 */
  id: string;
  repo: string;
  owner: string;
  name: string;
  description: string;
  homepage: string;
  license: string;
  stars: number;
  forks: number;
  topics: string[];
  /** 仓库最近一次推送时间（ISO 字符串）。 */
  pushedAt: string;
  /** 仓库默认分支名（安装时用于解析提交，可为空）。 */
  defaultBranch: string;
  archived: boolean;
  /** 仓库最新 GitHub Release 的版本号（tag 去掉前导 v）；列表只收录有发行版的仓库。 */
  version: string;
  /** 最新 Release 的原始 tag（安装时固定到该不可变快照）。 */
  releaseTag: string;
  /** 最新 Release 页面地址；未声明时为空。 */
  releaseUrl: string;
  /** 最新 Release 的发布时间（ISO 字符串）。 */
  releasedAt: string;
  /**
   * 仓库默认分支 `plugin.json` 声明的 `kind`（`tool` / `oauth` / `plugin`）；
   * 空串表示未声明、没有清单或读取失败。
   */
  kind: string;
  /**
   * 仓库默认分支 `plugin.json` 声明的 `icon`（已由 Rust 侧归一化：
   * `lucide:Name` / `http(s)` / `data:image` 原样，插件内相对路径展开为仓库
   * raw 地址）；空串表示未声明或读取失败，界面回退占位图标。
   */
  icon: string;
};

export type CommunitySearchResult = {
  query: string;
  items: CommunityPluginEntry[];
  total: number;
  /** 本轮是否因限流 / 网络故障沿用缓存（true 时保留旧结果并提示原因）。 */
  limited: boolean;
  reason: string;
  fetchedAt: number;
};

/** 社区列表实际展示的条目：排除已收录到官方索引的仓库（列表与标签计数同口径）。 */
export const filterCommunityEntries = (
  entries: CommunityPluginEntry[],
  officialRepos: Iterable<string>,
): CommunityPluginEntry[] => {
  const listed = new Set(
    Array.from(officialRepos, (repo) => repo.toLowerCase()),
  );
  return listed.size === 0
    ? entries
    : entries.filter((entry) => !listed.has(entry.repo.toLowerCase()));
};

/** 解析社区检索结果 JSON；单个无效条目会被丢弃，整份无效时抛错。 */
export const parseCommunitySearch = (text: string): CommunitySearchResult => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Invalid community plugin search result");
  }
  const items: CommunityPluginEntry[] = [];
  for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = asTrimmedString(raw.id);
    const repo = normalizeRepoUrl(asTrimmedString(raw.repo));
    if (!id || !GITHUB_REPO_PATTERN.test(repo)) {
      continue;
    }
    const kind = asTrimmedString(raw.kind).toLowerCase();
    items.push({
      id,
      repo,
      owner: asTrimmedString(raw.owner),
      name: asTrimmedString(raw.name),
      description: asTrimmedString(raw.description),
      homepage: asTrimmedString(raw.homepage),
      license: asTrimmedString(raw.license),
      stars: toNonNegativeCount(raw.stars),
      forks: toNonNegativeCount(raw.forks),
      topics: toStringList(raw.topics),
      pushedAt: asTrimmedString(raw.pushedAt),
      defaultBranch: asTrimmedString(raw.defaultBranch),
      archived: raw.archived === true,
      version: asTrimmedString(raw.version),
      releaseTag: asTrimmedString(raw.releaseTag),
      releaseUrl: asTrimmedString(raw.releaseUrl),
      releasedAt: asTrimmedString(raw.releasedAt),
      kind:
        kind === "tool" || kind === "oauth" || kind === "plugin" ? kind : "",
      icon: asTrimmedString(raw.icon),
    });
  }
  return {
    query: asTrimmedString(parsed.query),
    items,
    total: toNonNegativeCount(parsed.total),
    limited: parsed.limited === true,
    reason: asTrimmedString(parsed.reason),
    fetchedAt: toNonNegativeCount(parsed.fetchedAt),
  };
};

/** 社区仓库地址与已安装插件的来源是否一致（用于展示「已安装」）。 */
export const isCommunityRepoSource = (
  repo: string,
  sourcePath: string,
): boolean =>
  normalizeRepoUrl(sourcePath).toLowerCase() ===
  normalizeRepoUrl(repo).toLowerCase();

/** 社区仓库里的一个用户脚本（勾选安装列表项）。 */
export type CommunityScriptItem = {
  /** 安装用的稳定脚本 id（文件名主干，与官方市场 kind=script 条目同一语义）。 */
  id: string;
  /** 仓库内相对路径，勾选时回传。 */
  path: string;
  name: string;
  version: string;
  description: string;
};

/** 社区来源解析结果：已装面板插件 / 已装用户脚本 / 需要勾选脚本。 */
export type CommunityResolveResult =
  | { outcome: "plugin" }
  | { outcome: "scripts"; installed: { scriptId: string; name: string }[] }
  | {
      outcome: "selection-required";
      token: string;
      items: CommunityScriptItem[];
    };

/** 解析社区来源解析结果 JSON；未知 outcome 视为解析失败。 */
export const parseCommunityResolve = (text: string): CommunityResolveResult => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Invalid community resolve result");
  }
  const outcome = asTrimmedString(parsed.outcome);
  if (outcome === "plugin") {
    return { outcome: "plugin" };
  }
  if (outcome === "scripts") {
    const installed: { scriptId: string; name: string }[] = [];
    for (const raw of Array.isArray(parsed.installed) ? parsed.installed : []) {
      if (!isRecord(raw)) {
        continue;
      }
      const scriptId = asTrimmedString(raw.scriptId);
      if (!scriptId) {
        continue;
      }
      installed.push({ scriptId, name: asTrimmedString(raw.name) });
    }
    return { outcome: "scripts", installed };
  }
  if (outcome === "selection-required") {
    const items: CommunityScriptItem[] = [];
    for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
      if (!isRecord(raw)) {
        continue;
      }
      const path = asTrimmedString(raw.path);
      if (!path) {
        continue;
      }
      items.push({
        id: asTrimmedString(raw.id),
        path,
        name: asTrimmedString(raw.name),
        version: asTrimmedString(raw.version),
        description: asTrimmedString(raw.description),
      });
    }
    return {
      outcome: "selection-required",
      token: asTrimmedString(parsed.token),
      items,
    };
  }
  throw new Error("Invalid community resolve result");
};

/** 社区仓库时间的紧凑展示（YYYY-MM-DD）：数字按秒级时间戳，字符串按 ISO 解析。 */
export const formatCommunityTime = (value: string | number): string => {
  const timestamp =
    typeof value === "number" ? value * 1000 : Date.parse(value.trim());
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};
