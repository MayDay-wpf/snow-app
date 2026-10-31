import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Folder,
  Loader2,
} from "lucide-react";
import {
  forwardRef,
  useImperativeHandle,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  FileSearchAgentProgress,
  FileSearchResult,
  ProjectCollectionRecord,
  SkillDefinition,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { getFileTypeIcon } from "../../../utils/fileIcons";
import { getSkillIcon } from "../../../utils/skillIcons";
import type { FileTag, SkillTag } from "./fileTagUtils";

export type FileMentionPopupHandle = {
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => boolean;
};

export type FileMentionPopupProps = {
  visible: boolean;
  query: string;
  onClose: () => void;
  onSelect: (tag: FileTag | SkillTag) => void;
  onSelectBatch: (tags: (FileTag | SkillTag)[]) => void;
  textareaRef: RefObject<HTMLDivElement | null>;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>, tag: FileTag) => void;
  /**
   * 当前会话所属项目 id（可选）。用于 `@!` 技能搜索模式时
   * 获取项目级可用 Skills 列表。
   */
  projectId?: string;
  /**
   * 路径导航回调：将 @ 后的查询文本替换为相对路径并进入该目录浏览。
   * 传空字符串表示回到工作区根目录。
   */
  onNavigateTo: (relPath: string) => void;
  style?: React.CSSProperties;
  portal?: boolean;
};

const isSshPath = (path: string): boolean => path.startsWith("ssh://");

/** 与 Rust 端 file_search_agent 的 MAX_AGENT_ROUNDS 保持一致。 */
const MAX_AGENT_ROUNDS = 10;

// 统一为 "/" 分隔后再比较：Rust 端在 Windows 上返回反斜杠路径，
// 而 @ 查询文本与路径段均使用 "/"。
const normalizePath = (p: string): string =>
  p.replace(/\\/g, "/").replace(/\/+$/, "");

const getRelativePath = (path: string, rootPath: string): string => {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedPath = normalizePath(path);

  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
};

/** 解析项目所属关联项目组（合集）的本地成员根；不足两个根时不算关联。 */
const resolveLinkedProjectDirectories = (
  directories: WorkspaceDirectoryRecord[],
  active: WorkspaceDirectoryRecord | null,
  collections: ProjectCollectionRecord[],
): WorkspaceDirectoryRecord[] => {
  if (!active || active.kind !== "local") {
    return [];
  }

  const collection = collections.find((item) =>
    item.linkedDirectoryIds.includes(active.directoryId),
  );
  if (!collection) {
    return [];
  }

  const linkedIds = new Set(collection.linkedDirectoryIds);
  const roots = directories.filter(
    (directory) =>
      linkedIds.has(directory.directoryId) &&
      directory.kind === "local" &&
      directory.path.trim().length > 0,
  );

  return roots.length > 1 ? roots : [];
};

/** 按绝对路径前缀匹配条目所属的关联项目根，最长前缀优先。 */
const resolveEntryRoot = (
  roots: WorkspaceDirectoryRecord[],
  entryPath: string,
): WorkspaceDirectoryRecord | null => {
  const target = normalizePath(entryPath).toLowerCase();
  let matched: WorkspaceDirectoryRecord | null = null;
  let matchedLength = 0;

  for (const root of roots) {
    const rootPath = normalizePath(root.path).toLowerCase();
    if (
      rootPath.length > matchedLength &&
      (target === rootPath || target.startsWith(`${rootPath}/`))
    ) {
      matched = root;
      matchedLength = rootPath.length;
    }
  }

  return matched;
};

/** 兄弟根的相对路径带「目录名/」前缀；徽章已标明项目，展示时去掉该前缀。 */
const stripRootNamePrefix = (
  relativePath: string,
  rootName: string,
): string => {
  const normalized = relativePath.replace(/\\/g, "/");
  const prefix = `${rootName}/`;

  return normalized.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalized.slice(prefix.length)
    : normalized;
};

type DirectoryScope = {
  /** 尚未选定目录时的列表过滤词 */
  filter: string;
  /** 已选定的工作目录（查询含「/」且名称可解析时） */
  directory: WorkspaceDirectoryRecord | null;
  /** 选定目录后、相对该目录的查询文本 */
  inner: string;
};

/** `@:` 目录 token：去掉空白字符，避免 @ 查询被空格截断。 */
const getDirectoryToken = (directory: WorkspaceDirectoryRecord): string =>
  directory.name.replace(/\s+/g, "") || directory.directoryId;

/** 解析 `@:工作目录/剩余查询`：未带「/」或名称无法解析时仍处于目录选择状态。 */
const resolveDirectoryScope = (
  directories: WorkspaceDirectoryRecord[],
  query: string,
): DirectoryScope | null => {
  const trimmed = query.trim();
  if (!trimmed.startsWith(":")) {
    return null;
  }

  const rest = trimmed.slice(1);
  const slashIndex = rest.indexOf("/");
  const nameToken = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  const token = nameToken.toLowerCase();
  const directory =
    slashIndex > 0 && token.length > 0
      ? (directories.find(
          (item) => getDirectoryToken(item).toLowerCase() === token,
        ) ?? null)
      : null;

  return {
    filter: nameToken,
    directory,
    inner: directory ? rest.slice(slashIndex + 1) : "",
  };
};

/**
 * 从 @ 查询文本中提取路径段：最后一个 "/" 之前的部分按 "/" 拆分。
 * 例如 "src/renderer/App" → ["src", "renderer"]，"src/" → ["src"]。
 * 用于面包屑导航与 ← 返回上级。
 */
const getPathSegments = (query: string): string[] => {
  const trimmed = query.trim().replace(/^\/+/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    return [];
  }
  return trimmed
    .slice(0, lastSlash)
    .split("/")
    .filter((segment) => segment.length > 0);
};

const toFileTag = (entry: FileSearchResult, withLines = false): FileTag => {
  const lines =
    withLines && !entry.isDirectory
      ? entry.lineMatches.map((match) => match.line)
      : [];
  const tag: FileTag = {
    path: entry.path,
    name: entry.name,
    isDirectory: entry.isDirectory,
  };
  if (lines.length > 0) {
    tag.lines = lines;
  }
  return tag;
};

const toSkillTag = (skill: SkillDefinition): SkillTag => ({
  skillId: skill.id,
  name: skill.name,
  description: skill.description,
  location: skill.location,
});

const sortResults = (
  results: FileSearchResult[],
  queryLower: string,
  endsWithSlash: boolean,
): FileSearchResult[] => {
  return results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    if (endsWithSlash) {
      return a.name.localeCompare(b.name);
    }
    const aExact = a.name.toLowerCase() === queryLower;
    const bExact = b.name.toLowerCase() === queryLower;
    if (aExact !== bExact) {
      return aExact ? -1 : 1;
    }
    const aStarts = a.name.toLowerCase().startsWith(queryLower);
    const bStarts = b.name.toLowerCase().startsWith(queryLower);
    if (aStarts !== bStarts) {
      return aStarts ? -1 : 1;
    }
    const aNameMatch = a.matchedName ? 0 : 1;
    const bNameMatch = b.matchedName ? 0 : 1;
    if (aNameMatch !== bNameMatch) {
      return aNameMatch - bNameMatch;
    }
    return a.name.localeCompare(b.name);
  });
};

export const FileMentionPopup = forwardRef<
  FileMentionPopupHandle,
  FileMentionPopupProps
>(function FileMentionPopup(
  {
    visible,
    query: propQuery,
    onClose,
    onSelect,
    onSelectBatch,
    textareaRef,
    onDragStart,
    onNavigateTo,
    projectId,
    style,
    portal,
  },
  ref,
): React.JSX.Element | null {
  const { t } = useI18n();
  const [isClosing, setIsClosing] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);
  const [lastQuery, setLastQuery] = useState(propQuery);
  const query = visible ? propQuery : lastQuery;

  if (visible !== prevVisible) {
    setPrevVisible(visible);
    setIsClosing(!visible);
  }

  useEffect(() => {
    if (!isClosing) {
      return;
    }
    const timer = window.setTimeout(() => setIsClosing(false), 160);
    return () => window.clearTimeout(timer);
  }, [isClosing]);

  useEffect(() => {
    if (visible) {
      setLastQuery(propQuery);
    }
  }, [visible, propQuery]);
  const [directories, setDirectories] = useState<WorkspaceDirectoryRecord[]>(
    [],
  );
  const [collections, setCollections] = useState<ProjectCollectionRecord[]>([]);
  const [activeDirectory, setActiveDirectory] =
    useState<WorkspaceDirectoryRecord | null>(null);
  const [entries, setEntries] = useState<FileSearchResult[]>([]);
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [skillError, setSkillError] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [isAgentPending, setIsAgentPending] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set());
  // 自然语言搜索的 agent 执行过程（每次工具调用一条）。
  const [agentProgress, setAgentProgress] = useState<FileSearchAgentProgress[]>(
    [],
  );
  const [agentError, setAgentError] = useState(false);
  // `@!技能关键词`：感叹号前缀表示 Skills 搜索模式。
  const isSkillMode = query.trim().startsWith("!");
  const skillQuery = isSkillMode ? query.trim().slice(1).trim() : "";
  const isContentMode = query.trim().startsWith("@");
  const contentQuery = isContentMode ? query.trim().slice(1).trim() : "";
  // 关联项目组（合集）的本地成员根：未关联的项目不提供 `@:目录` 指令。
  const linkedDirectories = useMemo(
    () =>
      resolveLinkedProjectDirectories(
        directories,
        activeDirectory,
        collections,
      ),
    [activeDirectory, collections, directories],
  );
  // `@:工作目录/`：冒号前缀进入工作目录选择模式，选定后在该目录内搜索。
  const directoryScope = useMemo(
    () =>
      linkedDirectories.length > 0
        ? resolveDirectoryScope(linkedDirectories, query)
        : null,
    [linkedDirectories, query],
  );
  const scopedDirectory = directoryScope?.directory ?? null;
  const searchRoot = scopedDirectory ?? activeDirectory;
  const searchQuery = directoryScope
    ? directoryScope.inner.trim()
    : query.trim();
  // `@:项目/` 显式限定了关联项目组的某个成员：搜索只覆盖该根目录，不再并入
  // 组内其他项目；普通 `@` 搜索保持「一次覆盖关联项目组全部根」的行为。
  const includeLinkedRoots = scopedDirectory ? false : undefined;
  // 关联状态签名：断开关联 / 重新关联后，即使查询词不变也要重算搜索结果，
  // 避免弹窗停留在旧的关联范围上。
  const linkedSignature = useMemo(
    () =>
      linkedDirectories
        .map((directory) => directory.directoryId)
        .sort()
        .join(","),
    [linkedDirectories],
  );

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);
  const loadSeqRef = useRef(0);
  const directorySeqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const lastQueryRef = useRef("");
  const preloadedEntriesRef = useRef<FileSearchResult[]>([]);

  const preloadRootEntries = useCallback(
    async (dir: WorkspaceDirectoryRecord, loadSeq: number): Promise<void> => {
      try {
        const rawEntries = isSshPath(dir.path)
          ? await window.snow.searchRemoteWorkspaceFiles(dir.path, {
              query: "",
              listChildren: true,
            })
          : await window.snow.readDirectoryEntries(dir.path);

        if (loadSeq !== loadSeqRef.current) {
          return;
        }

        const results: FileSearchResult[] = rawEntries
          .filter((entry) => !entry.name.startsWith("."))
          .slice(0, 50)
          .map((entry) => ({
            path: entry.path,
            relativePath: getRelativePath(entry.path, dir.path),
            name: entry.name,
            isDirectory: entry.isDirectory,
            matchedName: true,
            lineMatches: [],
          }));
        preloadedEntriesRef.current = results;
        // 已有搜索在进行（如 @ 后立即粘贴查询词）时只缓存根目录列表，
        // 不覆盖搜索结果；查询清空后再由搜索 effect 回填。
        if (lastQueryRef.current === "") {
          setEntries(results);
          setSelectedIndex(0);
        }
      } catch {
        if (loadSeq === loadSeqRef.current) {
          preloadedEntriesRef.current = [];
          if (lastQueryRef.current === "") {
            setEntries([]);
          }
        }
      } finally {
        if (loadSeq === loadSeqRef.current) {
          setIsLoadingInitial(false);
        }
      }
    },
    [],
  );

  const loadDirectories = useCallback(async () => {
    const loadSeq = ++directorySeqRef.current;

    try {
      const [dirs, projectCollections] = await Promise.all([
        window.snow.listWorkspaceDirectories(),
        window.snow.listProjectCollections().catch(() => []),
      ]);
      if (loadSeq !== directorySeqRef.current) {
        return;
      }

      const active = dirs.find((d) => d.isActive) ?? dirs[0] ?? null;
      setDirectories(dirs);
      setCollections(projectCollections);
      setActiveDirectory(active);
      if (!active) {
        setIsLoadingInitial(false);
      }
    } catch {
      if (loadSeq === directorySeqRef.current) {
        setActiveDirectory(null);
        setIsLoadingInitial(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      ++directorySeqRef.current;
      ++loadSeqRef.current;
      ++searchSeqRef.current;
      return;
    }

    setIsLoadingInitial(true);
    preloadedEntriesRef.current = [];
    void loadDirectories();
    setEntries([]);
    setSelectedIndex(0);
    setCheckedPaths(new Set());
    lastQueryRef.current = "";

    return () => {
      ++directorySeqRef.current;
      ++loadSeqRef.current;
      ++searchSeqRef.current;
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [visible, loadDirectories]);

  // 项目列表 / 关联状态变更时重新拉取，避免弹窗停留在旧的关联结果上。
  useEffect(() => {
    if (!visible) {
      return;
    }

    return window.snow.onWorkspaceDirectoryListChanged(() => {
      void loadDirectories();
    });
  }, [visible, loadDirectories]);

  // 搜索根变化（打开弹窗、@: 切换工作目录）时重新预加载其根目录列表。
  useEffect(() => {
    if (!visible || !searchRoot) {
      return;
    }

    setIsLoadingInitial(true);
    setEntries([]);
    setSelectedIndex(0);
    setCheckedPaths(new Set());
    preloadedEntriesRef.current = [];
    const loadSeq = ++loadSeqRef.current;
    void preloadRootEntries(searchRoot, loadSeq);
  }, [visible, searchRoot?.directoryId, preloadRootEntries]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const rawTrimmed = query.trim();
    // `@?自然语言搜索词`：问号前缀表示自然语言搜索模式，交由 AI agent 查找；
    // `@:工作目录/` 模式下前缀作用于所选目录内的查询文本。
    const isNaturalLanguage = searchQuery.startsWith("?");
    // `@!技能关键词`：感叹号前缀表示 Skills 搜索模式，列出已启用的技能。
    const isSkillMode = rawTrimmed.startsWith("!");
    const searchKey = `${searchRoot?.directoryId ?? ""}\n${linkedSignature}\n${searchQuery}`;
    // 只在真正发起新搜索前替换防抖定时器：依赖变化但查询未变的重跑（如目录
    // 列表异步加载完成刷新了 searchRoot 引用）若取消已排队的搜索，会因去重
    // 而不再重发——@ 后一次性粘贴的查询词就永远不会被搜索。过期的回调由
    // searchSeqRef 拦截，弹窗关闭时由打开/关闭 effect 统一清理定时器。
    const clearPendingSearch = (): void => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };

    if (isSkillMode) {
      // 取消进行中的根目录预加载，避免预加载结果干扰技能列表。
      ++loadSeqRef.current;
      setIsLoadingInitial(false);
      const skillQuery = rawTrimmed.slice(1).trim();

      if (rawTrimmed === lastQueryRef.current) {
        return;
      }
      lastQueryRef.current = rawTrimmed;

      setSkills([]);
      setSkillError(false);
      setIsSearching(true);
      const seq = ++searchSeqRef.current;

      clearPendingSearch();
      searchTimerRef.current = setTimeout(async () => {
        if (seq !== searchSeqRef.current) {
          return;
        }
        try {
          const all = await window.snow.listAvailableSkills(projectId);
          if (seq !== searchSeqRef.current) {
            return;
          }
          const enabled = all.filter((s) => s.enabled);
          const q = skillQuery.toLowerCase();
          const filtered = q
            ? enabled.filter(
                (s) =>
                  s.name.toLowerCase().includes(q) ||
                  s.description.toLowerCase().includes(q) ||
                  s.id.toLowerCase().includes(q),
              )
            : enabled;
          setSkills(filtered);
          setIsSearching(false);
          setSelectedIndex(0);
        } catch (error) {
          console.error("Failed to load skills:", error);
          if (seq === searchSeqRef.current) {
            setSkillError(true);
            setIsSearching(false);
          }
        }
      }, 150);
      return;
    }

    if (isContentMode) {
      ++loadSeqRef.current;
      setIsLoadingInitial(false);

      if (!searchRoot || isSshPath(searchRoot.path) || !contentQuery) {
        ++searchSeqRef.current;
        setIsSearching(false);
        setIsAgentPending(false);
        setEntries([]);
        setSelectedIndex(0);
        setAgentProgress([]);
        setAgentError(false);
        lastQueryRef.current = "";
        return;
      }

      if (searchKey === lastQueryRef.current) {
        return;
      }
      lastQueryRef.current = searchKey;

      setIsSearching(true);
      const seq = ++searchSeqRef.current;

      clearPendingSearch();
      searchTimerRef.current = setTimeout(async () => {
        if (seq !== searchSeqRef.current) {
          return;
        }

        try {
          const results = await window.snow.searchFileContents(
            searchRoot.path,
            contentQuery,
            includeLinkedRoots,
          );

          if (seq !== searchSeqRef.current) {
            return;
          }

          setEntries(results);
          setIsSearching(false);
          setSelectedIndex(0);
        } catch {
          if (seq === searchSeqRef.current) {
            setEntries([]);
            setIsSearching(false);
          }
        }
      }, 150);
    }

    // `@:` 目录模式：尚未选定工作目录时只展示目录选择列表，不执行搜索。
    if (directoryScope && !scopedDirectory) {
      ++searchSeqRef.current;
      setIsSearching(false);
      setIsAgentPending(false);
      setAgentProgress([]);
      setAgentError(false);
      setEntries([]);
      setSelectedIndex(0);
      lastQueryRef.current = "";
      return;
    }

    if (isNaturalLanguage) {
      // 取消进行中的根目录预加载，避免预加载结果覆盖 AI 搜索结果。
      ++loadSeqRef.current;
      setIsLoadingInitial(false);
      const nlQuery = searchQuery.slice(1).trim();

      if (!searchRoot || isSshPath(searchRoot.path) || !nlQuery) {
        ++searchSeqRef.current;
        setIsSearching(false);
        setIsAgentPending(false);
        setEntries([]);
        setSelectedIndex(0);
        setAgentProgress([]);
        setAgentError(false);
        lastQueryRef.current = "";
        return;
      }

      if (searchKey === lastQueryRef.current) {
        return;
      }
      lastQueryRef.current = searchKey;

      setIsSearching(false);
      setIsAgentPending(true);
      setAgentProgress([]);
      setAgentError(false);
      const seq = ++searchSeqRef.current;

      // AI 搜索耗时较长，防抖时间放宽。
      clearPendingSearch();
      searchTimerRef.current = setTimeout(async () => {
        if (seq !== searchSeqRef.current) {
          return;
        }

        setIsAgentPending(false);
        setIsSearching(true);

        try {
          const results = await window.snow.searchFilesByAgent(
            nlQuery,
            searchRoot.path,
            (chunk) => {
              if (seq !== searchSeqRef.current) {
                return;
              }
              // 只保留最近若干条，避免进度区溢出。
              setAgentProgress((prev) => [...prev.slice(-7), chunk]);
            },
            includeLinkedRoots,
          );

          if (seq !== searchSeqRef.current) {
            return;
          }

          setEntries(results);
          setIsSearching(false);
          setSelectedIndex(0);
        } catch {
          if (seq === searchSeqRef.current) {
            setEntries([]);
            setIsSearching(false);
            setAgentError(true);
          }
        }
      }, 400);
    }

    if (!searchQuery || !searchRoot) {
      ++searchSeqRef.current;
      setIsSearching(false);
      if (preloadedEntriesRef.current.length > 0) {
        setEntries(preloadedEntriesRef.current);
        setSelectedIndex(0);
      }
      lastQueryRef.current = "";
      return;
    }

    if (searchKey === lastQueryRef.current) {
      return;
    }
    lastQueryRef.current = searchKey;

    // 根目录预加载可能仍在进行：结束骨架屏，改为展示搜索中状态。
    setIsLoadingInitial(false);
    setIsSearching(true);
    const seq = ++searchSeqRef.current;

    clearPendingSearch();
    searchTimerRef.current = setTimeout(async () => {
      if (seq !== searchSeqRef.current) {
        return;
      }

      const queryLower = searchQuery.toLowerCase();
      const endsWithSlash = queryLower.endsWith("/");

      try {
        const results = isSshPath(searchRoot.path)
          ? await window.snow.searchRemoteWorkspaceFiles(searchRoot.path, {
              query: searchQuery,
              listChildren: false,
            })
          : await window.snow.searchFiles(
              searchRoot.path,
              searchQuery,
              includeLinkedRoots,
            );

        if (seq !== searchSeqRef.current) {
          return;
        }

        setEntries(sortResults(results, queryLower, endsWithSlash));
        setIsSearching(false);
        setSelectedIndex(0);
      } catch {
        if (seq === searchSeqRef.current) {
          setEntries([]);
          setIsSearching(false);
        }
      }
    }, 150);
  }, [
    visible,
    query,
    searchQuery,
    searchRoot,
    directoryScope,
    scopedDirectory,
    includeLinkedRoots,
    linkedSignature,
    projectId,
    isContentMode,
    contentQuery,
  ]);

  // 路径导航：从查询文本解析当前浏览的路径段（用于面包屑与 ← 返回）
  const pathSegments = useMemo(
    () => getPathSegments(directoryScope ? directoryScope.inner : query),
    [directoryScope, query],
  );

  // 路径模式下（查询以 "/" 结尾，如 "src/renderer/"），后端会同时返回
  // "当前目录本身"与其子项；过滤掉目录本身，使面板呈现"已进入目录内容"的效果。
  const displayEntries = useMemo(() => {
    if (isContentMode || !searchQuery.endsWith("/")) {
      return entries;
    }
    const currentRel = searchQuery.replace(/\/+$/, "").toLowerCase();
    const rootPath = searchRoot?.path ?? "";
    return entries.filter((entry) => {
      const rel = getRelativePath(entry.path, rootPath).toLowerCase();
      return rel !== currentRel;
    });
  }, [entries, searchQuery, searchRoot, isContentMode]);

  // `@:` 目录模式下尚未选定目录时，列出关联项目组的成员目录。
  const directoryOptions = useMemo(() => {
    if (!directoryScope || directoryScope.directory) {
      return [];
    }
    const keyword = directoryScope.filter.trim().toLowerCase();
    if (!keyword) {
      return linkedDirectories;
    }
    return linkedDirectories.filter(
      (item) =>
        item.name.toLowerCase().includes(keyword) ||
        item.path.toLowerCase().includes(keyword),
    );
  }, [linkedDirectories, directoryScope]);
  const isDirectoryPicker = Boolean(
    directoryScope && !directoryScope.directory,
  );
  // 计数只统计当前模式的列表，避免残留的文件结果叠加显示。
  const activeResultCount = isSkillMode
    ? skills.length
    : isDirectoryPicker
      ? directoryOptions.length
      : displayEntries.length;

  const toggleCheck = useCallback((entry: FileSearchResult) => {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      return next;
    });
  }, []);

  // 目录模式下的导航目标：保留 @: 前缀，避免把查询回写成普通路径。
  const buildNavigateTarget = useCallback(
    (relative: string): string => {
      if (!scopedDirectory) {
        return relative;
      }
      const token = getDirectoryToken(scopedDirectory);
      return relative ? `:${token}/${relative}` : `:${token}`;
    },
    [scopedDirectory],
  );

  const handleSelectDirectory = useCallback(
    (directory: WorkspaceDirectoryRecord) => {
      textareaRef.current?.focus();
      onNavigateTo(`:${getDirectoryToken(directory)}`);
    },
    [onNavigateTo, textareaRef],
  );

  const handleSelectEntry = useCallback(
    (entry: FileSearchResult) => {
      // 目录条目：进入文件夹浏览（路径@），而不是直接插入目录引用。
      if (entry.isDirectory) {
        // 恢复输入框焦点与选区，确保父组件能正确回写 @ 路径
        textareaRef.current?.focus();
        const rootPath = searchRoot?.path ?? "";
        const rel = getRelativePath(entry.path, rootPath);
        if (rel && rel !== entry.path) {
          onNavigateTo(buildNavigateTarget(rel));
        }
        return;
      }

      const checkedEntries = entries.filter((e) => checkedPaths.has(e.path));
      if (checkedEntries.length > 0 && !checkedPaths.has(entry.path)) {
        onSelectBatch([
          ...checkedEntries.map((e) => toFileTag(e, isContentMode)),
          toFileTag(entry, isContentMode),
        ]);
      } else if (checkedPaths.has(entry.path)) {
        onSelectBatch(checkedEntries.map((e) => toFileTag(e, isContentMode)));
      } else {
        onSelect(toFileTag(entry, isContentMode));
      }
      onClose();
    },
    [
      entries,
      checkedPaths,
      onSelect,
      onSelectBatch,
      onClose,
      onNavigateTo,
      searchRoot,
      buildNavigateTarget,
      isContentMode,
    ],
  );

  const handleConfirmSelection = useCallback(() => {
    if (isSkillMode) {
      const skill = skills[selectedIndex];
      if (!skill) {
        return;
      }
      onSelect(toSkillTag(skill));
      onClose();
      return;
    }
    if (isDirectoryPicker) {
      const directory = directoryOptions[selectedIndex];
      if (directory) {
        handleSelectDirectory(directory);
      }
      return;
    }
    const checkedEntries = entries.filter((e) => checkedPaths.has(e.path));
    if (checkedEntries.length > 0) {
      onSelectBatch(checkedEntries.map((e) => toFileTag(e, isContentMode)));
      onClose();
      return;
    }
    const entry = displayEntries[selectedIndex];
    if (!entry) {
      return;
    }
    // Enter 直接选择（插入引用），与文件一致；进入目录请用 → 或点击。
    onSelect(toFileTag(entry, isContentMode));
    onClose();
  }, [
    displayEntries,
    entries,
    checkedPaths,
    selectedIndex,
    isSkillMode,
    skills,
    isDirectoryPicker,
    directoryOptions,
    handleSelectDirectory,
    onSelect,
    onSelectBatch,
    onClose,
    isContentMode,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>): boolean => {
        const nativeEvent = event.nativeEvent;
        const isComposing =
          nativeEvent.isComposing ||
          (nativeEvent as unknown as { keyCode?: number }).keyCode === 229;

        if (isComposing) {
          return false;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return true;
        }

        // Skills 模式：仅支持上下选择与 Enter 确认。
        if (isSkillMode) {
          if (skills.length === 0) {
            return false;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedIndex((prev) =>
              prev < skills.length - 1 ? prev + 1 : prev,
            );
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            handleConfirmSelection();
            return true;
          }
          return false;
        }

        // 目录选择模式：上下选择工作目录，Enter / → 进入该目录。
        if (isDirectoryPicker) {
          if (directoryOptions.length === 0) {
            return false;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedIndex((prev) =>
              prev < directoryOptions.length - 1 ? prev + 1 : prev,
            );
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
            return true;
          }
          if (event.key === "Enter" || event.key === "ArrowRight") {
            event.preventDefault();
            const directory = directoryOptions[selectedIndex];
            if (directory) {
              handleSelectDirectory(directory);
            }
            return true;
          }
          return false;
        }

        if (displayEntries.length === 0) {
          return false;
        }

        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((prev) =>
            prev < displayEntries.length - 1 ? prev + 1 : prev,
          );
          return true;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          return true;
        }

        // → 进入选中的目录（路径导航）
        if (event.key === "ArrowRight") {
          const entry = displayEntries[selectedIndex];
          if (entry?.isDirectory) {
            event.preventDefault();
            const rootPath = searchRoot?.path ?? "";
            const rel = getRelativePath(entry.path, rootPath);
            if (rel && rel !== entry.path) {
              onNavigateTo(buildNavigateTarget(rel));
            }
            return true;
          }
        }

        // ← 返回上级目录（移除最后一个路径段）
        if (event.key === "ArrowLeft") {
          if (pathSegments.length > 0) {
            event.preventDefault();
            onNavigateTo(
              buildNavigateTarget(pathSegments.slice(0, -1).join("/")),
            );
            return true;
          }
          if (scopedDirectory) {
            event.preventDefault();
            onNavigateTo(":");
            return true;
          }
        }

        if (event.key === " ") {
          event.preventDefault();
          if (displayEntries[selectedIndex]) {
            toggleCheck(displayEntries[selectedIndex]);
          }
          return true;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          handleConfirmSelection();
          return true;
        }

        return false;
      },
    }),
    [
      displayEntries,
      entries,
      selectedIndex,
      toggleCheck,
      handleConfirmSelection,
      onClose,
      pathSegments,
      onNavigateTo,
      searchRoot,
      buildNavigateTarget,
      scopedDirectory,
      isSkillMode,
      skills,
      isDirectoryPicker,
      directoryOptions,
      handleSelectDirectory,
    ],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }
    const container = listRef.current;
    if (!container) {
      return;
    }
    const selected = container.querySelector<HTMLElement>(
      `[data-mention-index="${selectedIndex}"]`,
    );
    if (!selected) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const itemRect = selected.getBoundingClientRect();
    if (itemRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - itemRect.top;
    } else if (itemRect.bottom > containerRect.bottom) {
      container.scrollTop += itemRect.bottom - containerRect.bottom;
    }
  }, [
    selectedIndex,
    visible,
    displayEntries.length,
    skills.length,
    directoryOptions.length,
    isDirectoryPicker,
  ]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const handleDocumentPointerDown = (event: MouseEvent) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleDocumentPointerDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentPointerDown);
    };
  }, [visible, onClose, textareaRef]);

  const handleEntryDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, entry: FileSearchResult) => {
      const tag = toFileTag(entry, isContentMode);
      if (onDragStart) {
        onDragStart(event, tag);
      } else {
        event.dataTransfer.setData("application/json", JSON.stringify(tag));
        event.dataTransfer.effectAllowed = "copy";
      }
    },
    [onDragStart, isContentMode],
  );

  const isNaturalLanguage = searchQuery.startsWith("?");
  const naturalLanguageQuery = isNaturalLanguage
    ? searchQuery.slice(1).trim()
    : "";

  const emptyText = useMemo(() => {
    if (isSearching) {
      return isNaturalLanguage
        ? t("fileMention.aiSearching")
        : t("fileMention.searching");
    }
    if (entries.length === 0) {
      if (isContentMode) {
        return contentQuery
          ? t("fileMention.contentNoResults")
          : t("fileMention.contentHint");
      }
      if (isNaturalLanguage && agentError) {
        return t("fileMention.aiError");
      }
      if (!searchQuery || (isNaturalLanguage && !naturalLanguageQuery)) {
        return isNaturalLanguage
          ? t("fileMention.aiHint")
          : t("fileMention.typeToSearch");
      }
      if (isNaturalLanguage && isAgentPending) {
        return t("fileMention.aiPending");
      }
      return isNaturalLanguage
        ? t("fileMention.aiNoResults")
        : t("fileMention.noResults");
    }
    return t("fileMention.typeToSearch");
  }, [
    isSearching,
    entries.length,
    searchQuery,
    isNaturalLanguage,
    naturalLanguageQuery,
    agentError,
    isAgentPending,
    isContentMode,
    contentQuery,
    t,
  ]);

  const popup =
    visible || isClosing ? (
      <div
        className={`file-mention-popup${isClosing ? " is-closing" : ""}`}
        ref={popupRef}
        style={style}
        data-esc-panel
      >
        {!isSkillMode && (pathSegments.length > 0 || scopedDirectory) && (
          <div className="file-mention-breadcrumbs">
            <button
              type="button"
              className="file-mention-crumb"
              onClick={() => {
                textareaRef.current?.focus();
                onNavigateTo(scopedDirectory ? ":" : "");
              }}
              title={searchRoot?.path ?? ""}
            >
              <Folder size={11} />
              <span>{searchRoot?.name ?? "workspace"}</span>
            </button>
            {pathSegments.map((segment, index) => (
              <span className="file-mention-crumb-segment" key={index}>
                <ChevronRight size={10} className="file-mention-crumb-sep" />
                <button
                  type="button"
                  className="file-mention-crumb"
                  onClick={() => {
                    textareaRef.current?.focus();
                    onNavigateTo(
                      buildNavigateTarget(
                        pathSegments.slice(0, index + 1).join("/"),
                      ),
                    );
                  }}
                >
                  {segment}
                </button>
              </span>
            ))}
          </div>
        )}
        {(isSkillMode || activeResultCount > 0) && (
          <span className="file-mention-count">
            {isSearching && !isSkillMode && displayEntries.length > 0 && (
              <Loader2 className="spin" size={11} />
            )}
            {isSkillMode && t("settings.skillsEnabledCount")}
            {isSkillMode && activeResultCount > 0 && " · "}
            {activeResultCount > 0 &&
              t("fileMention.results", {
                values: { count: activeResultCount },
              })}
            {!isSkillMode &&
              !isDirectoryPicker &&
              checkedPaths.size > 0 &&
              ` | ${t("fileMention.selected", {
                values: { count: checkedPaths.size },
              })}`}
          </span>
        )}
        <div className="file-mention-list" ref={listRef}>
          {isSkillMode ? (
            isSearching && skills.length === 0 ? (
              <div className="file-mention-empty">
                <Loader2 className="spin" size={14} />
                <span>{t("fileMention.skillSearching")}</span>
              </div>
            ) : skillError || skills.length === 0 ? (
              <div className="file-mention-empty">
                <span>
                  {skillError
                    ? t("settings.skillsLoadError")
                    : skillQuery
                      ? t("fileMention.skillNoResults")
                      : t("fileMention.skillEmpty")}
                </span>
              </div>
            ) : (
              skills.map((skill, index) => {
                const isSelected = selectedIndex === index;
                return (
                  <div
                    key={skill.id}
                    data-mention-index={index}
                    className={`mention-entry ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      onSelect(toSkillTag(skill));
                      onClose();
                    }}
                    title={skill.description}
                  >
                    <span className="mention-entry-check" />
                    {getSkillIcon(skill.id, {
                      size: 14,
                      className: "mention-entry-icon",
                    })}
                    <span className="mention-entry-name">{skill.name}</span>
                    <span className="mention-entry-path">
                      {skill.description || skill.id}
                    </span>
                  </div>
                );
              })
            )
          ) : isDirectoryPicker ? (
            directoryOptions.length > 0 ? (
              directoryOptions.map((directory, index) => {
                const isSelected = selectedIndex === index;
                const isActiveDirectory =
                  directory.directoryId === activeDirectory?.directoryId;
                return (
                  <div
                    key={directory.directoryId}
                    data-mention-index={index}
                    className={`mention-entry ${isSelected ? "selected" : ""}`}
                    onClick={() => handleSelectDirectory(directory)}
                    title={directory.path}
                  >
                    <span className="mention-entry-check" />
                    <Folder size={14} className="mention-entry-icon" />
                    <span className="mention-entry-name">{directory.name}</span>
                    {isActiveDirectory && (
                      <span className="mention-entry-root">
                        {t("fileMention.currentDirectory")}
                      </span>
                    )}
                    <span className="mention-entry-path">{directory.path}</span>
                  </div>
                );
              })
            ) : (
              <div className="file-mention-empty">
                <span>{t("fileMention.directoryNoResults")}</span>
              </div>
            )
          ) : isLoadingInitial ? (
            <div className="file-mention-skeleton">
              {Array.from({ length: 6 }, (_, i) => (
                <div className="mention-skeleton-item" key={i}>
                  <div className="mention-skeleton-icon" />
                  <div className="mention-skeleton-line" />
                </div>
              ))}
              <div className="file-mention-empty">
                <Loader2 className="spin" size={14} />
                <span>{t("fileMention.loading")}</span>
              </div>
            </div>
          ) : isSearching && entries.length === 0 ? (
            isNaturalLanguage ? (
              <div className="file-mention-agent">
                <div className="file-mention-agent-header">
                  <Loader2 className="spin" size={12} />
                  <span>{t("fileMention.aiSearching")}</span>
                </div>
                {agentProgress.length > 0 && (
                  <div className="file-mention-agent-steps">
                    {agentProgress.map((step, index) => (
                      <div className="agent-step" key={index}>
                        <span className="agent-step-round">
                          {step.round}/{MAX_AGENT_ROUNDS}
                        </span>
                        <span className="agent-step-tool">
                          {step.tool
                            .replace("grep-search", "grep")
                            .replace("filesystem-read", "read")}
                        </span>
                        <span className="agent-step-detail">
                          {step.resultPreview}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="file-mention-empty">
                <Loader2 className="spin" size={14} />
                <span>{emptyText}</span>
              </div>
            )
          ) : entries.length === 0 ? (
            <div className="file-mention-empty">
              <span>{emptyText}</span>
            </div>
          ) : (
            <>
              {displayEntries.map((entry, index) => {
                const isChecked = checkedPaths.has(entry.path);
                const isSelected = selectedIndex === index;
                const rootLabel = resolveEntryRoot(
                  linkedDirectories,
                  entry.path,
                );
                const displayPath = rootLabel
                  ? stripRootNamePrefix(entry.relativePath, rootLabel.name)
                  : entry.relativePath.replace(/\\/g, "/");
                const showLines = isContentMode && entry.lineMatches.length > 0;
                return (
                  <div
                    key={entry.path}
                    data-mention-index={index}
                    className={`mention-entry ${isSelected ? "selected" : ""} ${
                      isChecked ? "checked" : ""
                    } ${showLines ? "has-lines" : ""}`}
                    draggable
                    onDragStart={(e) => handleEntryDragStart(e, entry)}
                    onClick={() => handleSelectEntry(entry)}
                    title={entry.path}
                  >
                    <span className="mention-entry-check">
                      {isChecked && <Check size={13} />}
                    </span>
                    {getFileTypeIcon(entry.name, entry.isDirectory, false, {
                      size: 14,
                      className: "mention-entry-icon",
                    })}
                    <span className="mention-entry-name">{entry.name}</span>
                    {rootLabel && (
                      <span className="mention-entry-root">
                        {rootLabel.name}
                      </span>
                    )}
                    {displayPath && (
                      <span className="mention-entry-path">{displayPath}</span>
                    )}
                    {entry.isDirectory && (
                      <ChevronRight
                        size={13}
                        className="mention-entry-enter"
                        aria-hidden
                      />
                    )}
                    {showLines && (
                      <span className="mention-entry-lines">
                        {entry.lineMatches.slice(0, 3).map((match) => (
                          <span
                            className="mention-entry-line"
                            key={match.line}
                            title={`${entry.path}:${match.line}`}
                          >
                            <span className="mention-entry-line-number">
                              {match.line}
                            </span>
                            <span className="mention-entry-line-text">
                              {match.text.trim()}
                            </span>
                          </span>
                        ))}
                        {entry.lineMatches.length > 3 && (
                          <span className="mention-entry-line-more">
                            {t("fileMention.moreMatches", {
                              values: { count: entry.lineMatches.length - 3 },
                            })}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div className="file-mention-footer">
          <span className="file-mention-hint">
            <kbd className="mention-kbd-icon">
              <ArrowUp size={10} />
            </kbd>
            <kbd className="mention-kbd-icon">
              <ArrowDown size={10} />
            </kbd>{" "}
            {t("fileMention.navigate")}
          </span>
          {!isSkillMode && (
            <>
              <span className="file-mention-hint">
                <kbd className="mention-kbd-icon">
                  <ArrowRight size={10} />
                </kbd>{" "}
                {t("fileMention.enter")}
              </span>
              <span className="file-mention-hint">
                <kbd className="mention-kbd-icon">
                  <ArrowLeft size={10} />
                </kbd>{" "}
                {t("fileMention.back")}
              </span>
              <span className="file-mention-hint">
                <kbd>Space</kbd> {t("fileMention.check")}
              </span>
            </>
          )}
          <span className="file-mention-hint">
            <kbd>Enter</kbd> {t("fileMention.confirm")}
          </span>
          <span className="file-mention-hint">
            <kbd>Esc</kbd> {t("fileMention.close")}
          </span>
          {!isSkillMode && (
            <span className="file-mention-hint drag-hint">
              {t("fileMention.dragToInput")}
            </span>
          )}
        </div>
      </div>
    ) : null;

  return portal && popup ? createPortal(popup, document.body) : popup;
});
