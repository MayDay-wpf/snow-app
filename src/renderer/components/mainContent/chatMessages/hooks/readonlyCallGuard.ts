import type {
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import {
  isReadonlyActionCall,
  parseToolAction,
} from "../utils/toolActionPolicy";
import type { GitFileStatus, GitStatusResult } from "../../../../../preload";

/**
 * 具有工作区变动/写副作用的显式工具集合。
 * 覆盖文件写入、终端执行、交互式终端、子代理派发、LSP 重命名与工作流等。
 */
export const WORKSPACE_MUTATING_TOOL_NAMES = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
  "filesystem-copy",
  "bash-terminal-execute",
  "terminal-send",
  "terminal-open",
  "sub-agents-activate",
  "sub-agents-continue",
  "lsp-rename",
  "workflow-generate",
  "workflow-resume",
  "skills-skill-execute",
]);

const SESSION_BOOKKEEPING_TOOL_PREFIXES = [
  "todo-todo-manage",
  "config-",
  "user-interaction-",
  "memory-",
];

const isSessionOrConfigTool = (toolName: string): boolean =>
  SESSION_BOOKKEEPING_TOOL_PREFIXES.some(
    (prefix) => toolName === prefix || toolName.startsWith(prefix),
  );

/** 解析目标路径所属的 Git 仓库根（只读工具守卫的变动感知用）。 */
const resolveGitRepoPath = async (path: string): Promise<string> => {
  try {
    const identity = await window.snow?.gitIdentity(path);
    return identity?.repoPath ?? "";
  } catch {
    return "";
  }
};

/**
 * 判断某个工具调用是否可能对工作区造成状态变更。
 * 显式写工具、外部未知非只读工具、终端与子代理等均保守视为变动源。
 */
export const mayMutateWorkspace = (
  toolCall: ToolCallInfo,
  readonlyToolNames?: Set<string>,
): boolean => {
  if (WORKSPACE_MUTATING_TOOL_NAMES.has(toolCall.name)) {
    return true;
  }
  if (readonlyToolNames && !readonlyToolNames.has(toolCall.name)) {
    if (!isSessionOrConfigTool(toolCall.name)) {
      return true;
    }
  }
  return false;
};

export const normalizeWorkspacePath = (
  filePath: string,
  workspacePath?: string,
): string => {
  const normalizedPath =
    filePath.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
  const normalizedWorkspace = workspacePath
    ?.replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!normalizedWorkspace) {
    return normalizedPath;
  }

  const isWindowsPath = /^[a-z]:\//i.test(normalizedWorkspace);
  const comparablePath = isWindowsPath
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const comparableWorkspace = isWindowsPath
    ? normalizedWorkspace.toLowerCase()
    : normalizedWorkspace;
  if (normalizedPath === ".") {
    return "<workspace>";
  }
  if (normalizedPath.startsWith("./")) {
    return `<workspace>/${normalizedPath.slice(2)}`;
  }
  if (comparablePath === comparableWorkspace) {
    return "<workspace>";
  }
  if (comparablePath.startsWith(`${comparableWorkspace}/`)) {
    return `<workspace>/${normalizedPath.slice(normalizedWorkspace.length + 1)}`;
  }
  return normalizedPath;
};

export const resolveToAbsolutePath = (
  filePath: string,
  workspacePath?: string,
): string => {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  // Preserve home-relative paths for the native resolver; never join them to a workspace.
  if (/^(?:[a-zA-Z]:\/|\/|~(?:\/|$))/.test(normalized)) {
    return normalized;
  }
  if (!workspacePath) return normalized;
  const normalizedWorkspace = workspacePath
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const rel = normalized.replace(/^\.\//, "");
  return `${normalizedWorkspace}/${rel}`;
};

export const canonicalizeToolArguments = (
  argumentsJson: string,
  toolName?: string,
  workspacePath?: string,
): string | null => {
  try {
    const sortJson = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(sortJson);
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, sortJson(child)]),
        );
      }
      return value;
    };
    const parsed = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    if (toolName === "filesystem-read" && typeof parsed.filePath === "string") {
      parsed.filePath = normalizeWorkspacePath(parsed.filePath, workspacePath);
    }
    return JSON.stringify(sortJson(parsed));
  } catch {
    return null;
  }
};

export const isFailedToolResult = (result: string): boolean => {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed.success === false || typeof parsed.error === "string";
  } catch {
    return false;
  }
};

interface FileSnapshot {
  exists: boolean;
  size: number;
  contentLength: number;
  preview: string;
}

interface GitSnapshot {
  repoPath: string;
  branch: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  fileDigest: string;
  specificFileStatus?: string;
}

interface CallSnapshot {
  toolName: string;
  callKey: string;
  targetPath?: string;
  fileSnapshot?: FileSnapshot | null;
  gitSnapshot?: GitSnapshot | null;
  recordedAt: number;
  result: string;
}

export interface ReadonlyCallCacheItem {
  result: string;
  fromCache: boolean;
}

export interface ReadonlyCallFilterResult {
  executableToolCalls: ToolCallInfo[];
  duplicateReadonlyResults: Map<ToolCallInfo, ReadonlyCallCacheItem>;
}

export interface ReadonlyCallGuardOptions {
  workspacePath?: string;
}

/** 只读结果缓存上限（条数 / 字符量）。 */
const READONLY_CACHE_MAX_ENTRIES = 48;
const READONLY_CACHE_MAX_CHARS = 2_000_000;

export class ReadonlyCallGuard {
  private workspacePath?: string;
  private completedCalls = new Map<string, CallSnapshot>();

  constructor(options: ReadonlyCallGuardOptions = {}) {
    this.workspacePath = options.workspacePath;
  }

  public getReadonlyCallKey(toolCall: ToolCallInfo): string | null {
    // Plugin catalog and discovery depend on current settings; discovery also
    // registers tools for the next request, so cached results are not equivalent.
    if (
      toolCall.name === "toolSearch-tool-search" ||
      toolCall.name === "toolSearch-discover"
    )
      return null;
    const argumentsJson = canonicalizeToolArguments(
      toolCall.arguments,
      toolCall.name,
      this.workspacePath,
    );
    return argumentsJson === null ? null : `${toolCall.name}:${argumentsJson}`;
  }

  public isReadonlyCall(
    toolCall: ToolCallInfo,
    readonlyToolNames: Set<string>,
  ): boolean {
    if (!readonlyToolNames.has(toolCall.name)) {
      return false;
    }
    return isReadonlyActionCall(toolCall);
  }

  /**
   * 过滤工具调用：不仅基于参数匹配，更主动检测目标文件及 Git 仓库真实状态。
   * 若物理状态或 Git 状态已发生变更，则允许重新读取。
   */
  public async filterToolCalls(
    toolCalls: ToolCallInfo[],
    readonlyToolNames: Set<string>,
  ): Promise<ReadonlyCallFilterResult> {
    const duplicateReadonlyResults = new Map<
      ToolCallInfo,
      ReadonlyCallCacheItem
    >();
    const executableToolCalls: ToolCallInfo[] = [];

    for (const toolCall of toolCalls) {
      const key = this.getReadonlyCallKey(toolCall);
      if (
        key === null ||
        !this.isReadonlyCall(toolCall, readonlyToolNames) ||
        !this.completedCalls.has(key)
      ) {
        executableToolCalls.push(toolCall);
        continue;
      }

      const priorSnapshot = this.completedCalls.get(key)!;
      const isMutated = await this.checkIfTargetMutated(
        toolCall,
        priorSnapshot,
      );

      if (isMutated) {
        // 目标文件或 Git 仓库已发生真实物理变更，放行本次调用并移除陈旧快照
        this.completedCalls.delete(key);
        executableToolCalls.push(toolCall);
        continue;
      }

      // 正常只读缓存命中：直接返回此前已执行成功的真实结果，
      // 既避免重复磁盘 I/O，又保证模型获得预期数据并顺利执行后续操作。
      duplicateReadonlyResults.set(toolCall, {
        result: priorSnapshot.result,
        fromCache: true,
      });
    }

    return { executableToolCalls, duplicateReadonlyResults };
  }

  /**
   * 记录执行成功的工具调用与状态变更
   */
  public async recordToolExecutions(
    executableToolCalls: ToolCallInfo[],
    authorizationDecisions: ToolAuthorizationDecision[],
    executedToolResults: Array<
      { result: string; corrected?: boolean } | undefined
    >,
    readonlyToolNames: Set<string>,
  ): Promise<void> {
    for (let index = 0; index < executableToolCalls.length; index++) {
      const toolCall = executableToolCalls[index];
      const decision = authorizationDecisions[index];
      const executed = executedToolResults[index];
      const result = executed?.result;

      if (decision?.status !== "approved") {
        continue;
      }

      // Corrected calls ran with different arguments than the requested call;
      // caching the result under the original arguments would poison later
      // identical reads.
      if (executed?.corrected) {
        continue;
      }

      // 如果执行了可能修改工作区的工具，清空工作区文件与检索类只读缓存
      if (mayMutateWorkspace(toolCall, readonlyToolNames)) {
        this.clearWorkspaceCaches();
        continue;
      }

      // 会话级细粒度失效：todo 更新仅失效 todo-get 缓存
      if (toolCall.name === "todo-todo-manage") {
        this.clearPrefixCaches("todo-todo-manage:");
        continue;
      }
      if (
        toolCall.name === "memory-manage" &&
        !isReadonlyActionCall(toolCall)
      ) {
        this.clearPrefixCaches("memory-");
        continue;
      }
      // config-manage：写动作会使此前的读取失效；logs 结果实时变化，均不缓存。
      if (toolCall.name.startsWith("config-")) {
        if (parseToolAction(toolCall.arguments) === "logs") {
          continue;
        }
        if (!isReadonlyActionCall(toolCall)) {
          this.clearPrefixCaches("config-");
          continue;
        }
      }

      const key = this.getReadonlyCallKey(toolCall);
      if (key && result && !isFailedToolResult(result)) {
        const snapshot = await this.captureSnapshot(toolCall, key, result);
        this.rememberCall(key, snapshot);
      }
    }
  }

  /** 写入缓存并按条数/字符量淘汰最旧项，避免长 run 中整轮只读结果常驻内存。 */
  private rememberCall(key: string, snapshot: CallSnapshot): void {
    this.completedCalls.delete(key);
    this.completedCalls.set(key, snapshot);
    let totalChars = 0;
    for (const entry of this.completedCalls.values()) {
      totalChars += entry.result.length;
    }
    for (const [oldestKey, oldest] of this.completedCalls) {
      if (
        oldestKey === key ||
        (this.completedCalls.size <= READONLY_CACHE_MAX_ENTRIES &&
          totalChars <= READONLY_CACHE_MAX_CHARS)
      ) {
        break;
      }
      this.completedCalls.delete(oldestKey);
      totalChars -= oldest.result.length;
    }
  }

  public clearAll(): void {
    this.completedCalls.clear();
  }

  private clearWorkspaceCaches(): void {
    for (const [key, snapshot] of this.completedCalls.entries()) {
      if (
        snapshot.toolName === "filesystem-read" ||
        snapshot.toolName === "grep-search" ||
        snapshot.toolName === "grep-find" ||
        snapshot.toolName === "codebase-search"
      ) {
        this.completedCalls.delete(key);
      }
    }
  }

  private clearPrefixCaches(prefix: string): void {
    for (const key of this.completedCalls.keys()) {
      if (key.startsWith(prefix)) {
        this.completedCalls.delete(key);
      }
    }
  }

  /**
   * 物理及 Git 变更检测核心
   */
  private async checkIfTargetMutated(
    toolCall: ToolCallInfo,
    prior: CallSnapshot,
  ): Promise<boolean> {
    try {
      if (toolCall.name === "filesystem-read") {
        const parsed = JSON.parse(toolCall.arguments || "{}") as {
          filePath?: string;
        };
        const rawPath =
          typeof parsed.filePath === "string" ? parsed.filePath : "";
        const absPath = resolveToAbsolutePath(rawPath, this.workspacePath);
        if (!absPath) return true;

        // 1. 文件系统内容与尺寸检测
        const currentFile = await this.captureFileSnapshot(absPath);
        if (!prior.fileSnapshot || !currentFile) return true;
        if (
          prior.fileSnapshot.exists !== currentFile.exists ||
          prior.fileSnapshot.size !== currentFile.size ||
          prior.fileSnapshot.contentLength !== currentFile.contentLength ||
          prior.fileSnapshot.preview !== currentFile.preview
        ) {
          return true;
        }

        // 2. 目标文件所属 Git 仓库状态检测
        const repoPath =
          prior.gitSnapshot?.repoPath ||
          (await resolveGitRepoPath(absPath)) ||
          this.workspacePath;
        if (repoPath) {
          const currentGit = await this.captureGitSnapshot(repoPath, absPath);
          if (this.isGitMutated(prior.gitSnapshot, currentGit)) {
            return true;
          }
        }

        return false;
      }

      if (
        toolCall.name === "grep-search" ||
        toolCall.name === "grep-find" ||
        toolCall.name === "codebase-search"
      ) {
        const repoPath =
          prior.gitSnapshot?.repoPath ||
          (prior.targetPath
            ? await resolveGitRepoPath(prior.targetPath)
            : "") ||
          this.workspacePath;
        if (repoPath) {
          const currentGit = await this.captureGitSnapshot(repoPath);
          if (this.isGitMutated(prior.gitSnapshot, currentGit)) {
            return true;
          }
        }
        return false;
      }

      return false;
    } catch {
      // 若检测过程中发生任何未知异常，安全回退为已变更，避免误杀正常执行
      return true;
    }
  }

  private isGitMutated(
    prior: GitSnapshot | null | undefined,
    current: GitSnapshot | null | undefined,
  ): boolean {
    if (!prior || !current) return false;
    if (prior.branch !== current.branch) return true;
    if (prior.ahead !== current.ahead || prior.behind !== current.behind)
      return true;
    if (
      prior.stagedCount !== current.stagedCount ||
      prior.unstagedCount !== current.unstagedCount ||
      prior.untrackedCount !== current.untrackedCount
    ) {
      return true;
    }
    if (prior.fileDigest !== current.fileDigest) return true;
    if (prior.specificFileStatus !== current.specificFileStatus) return true;
    return false;
  }

  private async captureSnapshot(
    toolCall: ToolCallInfo,
    callKey: string,
    result: string,
  ): Promise<CallSnapshot> {
    const snapshot: CallSnapshot = {
      toolName: toolCall.name,
      callKey,
      recordedAt: Date.now(),
      result,
    };

    try {
      if (toolCall.name === "filesystem-read") {
        const parsed = JSON.parse(toolCall.arguments || "{}") as {
          filePath?: string;
        };
        const rawPath =
          typeof parsed.filePath === "string" ? parsed.filePath : "";
        const absPath = resolveToAbsolutePath(rawPath, this.workspacePath);
        snapshot.targetPath = absPath;
        if (absPath) {
          snapshot.fileSnapshot = await this.captureFileSnapshot(absPath);
          const repoPath =
            (await resolveGitRepoPath(absPath)) || this.workspacePath;
          if (repoPath) {
            snapshot.gitSnapshot = await this.captureGitSnapshot(
              repoPath,
              absPath,
            );
          }
        }
      } else if (
        toolCall.name === "grep-search" ||
        toolCall.name === "grep-find" ||
        toolCall.name === "codebase-search"
      ) {
        const repoPath = this.workspacePath;
        snapshot.targetPath = repoPath;
        if (repoPath) {
          snapshot.gitSnapshot = await this.captureGitSnapshot(repoPath);
        }
      }
    } catch {
      // 快照捕获失败时不阻断主流程
    }

    return snapshot;
  }

  private async captureFileSnapshot(
    absPath: string,
  ): Promise<FileSnapshot | null> {
    try {
      // An exact lookup (no project suffix search) shares native home expansion.
      const entry = await window.snow.resolveFileLink(null, absPath);
      if (!entry) return null;
      if (entry.isDirectory) {
        const entries = await window.snow.readDirectoryEntries(entry.path);
        const listing = JSON.stringify(
          entries
            .map((item) => `${item.name}${item.isDirectory ? "/" : ""}`)
            .sort(),
        );
        return {
          exists: true,
          size: entries.length,
          contentLength: listing.length,
          preview: `directory:${listing}`,
        };
      }
      const result = await window.snow.readFileContent(entry.path);
      return {
        exists: true,
        size: result.size,
        contentLength: result.content.length,
        // Compare the entire content, including same-size changes beyond the first 128 chars.
        preview: `file:${result.content}`,
      };
    } catch {
      // Unavailable is not a verified missing/unchanged target.
      return null;
    }
  }

  private async captureGitSnapshot(
    repoPath: string,
    specificFilePath?: string,
  ): Promise<GitSnapshot | null> {
    try {
      const status: GitStatusResult = await window.snow?.gitStatus(repoPath);
      if (!status || !status.isRepo) {
        return null;
      }

      let specificFileStatus: string | undefined;
      if (specificFilePath) {
        const normalizedTarget = specificFilePath
          .replace(/\\/g, "/")
          .toLowerCase();
        const normalizedRepo = repoPath
          .replace(/\\/g, "/")
          .toLowerCase()
          .replace(/\/+$/, "");
        const relPath = normalizedTarget.startsWith(`${normalizedRepo}/`)
          ? normalizedTarget.slice(normalizedRepo.length + 1)
          : normalizedTarget;

        const matched = status.files?.find((f: GitFileStatus) => {
          const p = (f.path || "").replace(/\\/g, "/").toLowerCase();
          return p === relPath || normalizedTarget.endsWith(`/${p}`);
        });
        specificFileStatus = matched
          ? `${matched.status}:${matched.workdirStatus}`
          : "clean";
      }

      const fileDigest = (status.files || [])
        .map((f: GitFileStatus) => `${f.path}:${f.status}:${f.workdirStatus}`)
        .sort()
        .join(";");

      return {
        repoPath,
        branch: status.currentBranch || "",
        ahead: status.ahead || 0,
        behind: status.behind || 0,
        stagedCount: status.stagedCount || 0,
        unstagedCount: status.unstagedCount || 0,
        untrackedCount: status.untrackedCount || 0,
        fileDigest,
        specificFileStatus,
      };
    } catch {
      return null;
    }
  }
}
