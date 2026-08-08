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
import { AnimatePresence, motion } from "motion/react";
import type {
  FileSearchAgentProgress,
  FileSearchResult,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  appleSurfaceTransition,
  useAppleThemeMotion,
} from "../../../hooks/useAppleThemeMotion";
import { getFileTypeIcon } from "../../../utils/fileIcons";
import type { FileTag } from "./fileTagUtils";

export type FileMentionPopupHandle = {
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => boolean;
};

export type FileMentionPopupProps = {
  visible: boolean;
  query: string;
  onClose: () => void;
  onSelect: (tag: FileTag) => void;
  onSelectBatch: (tags: FileTag[]) => void;
  textareaRef: RefObject<HTMLDivElement | null>;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>, tag: FileTag) => void;
  /**
   * 路径导航回调：将 @ 后的查询文本替换为相对路径并进入该目录浏览。
   * 传空字符串表示回到工作区根目录。
   */
  onNavigateTo: (relPath: string) => void;
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

const toFileTag = (entry: FileSearchResult): FileTag => ({
  path: entry.path,
  name: entry.name,
  isDirectory: entry.isDirectory,
});

const sortResults = (
  results: FileSearchResult[],
  queryLower: string,
  endsWithSlash: boolean
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
    query,
    onClose,
    onSelect,
    onSelectBatch,
    textareaRef,
    onDragStart,
    onNavigateTo,
  },
  ref
): React.JSX.Element {
  const { t } = useI18n();
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  const transition = appleSurfaceTransition(reducedMotion);
  const [activeDirectory, setActiveDirectory] =
    useState<WorkspaceDirectoryRecord | null>(null);
  const [entries, setEntries] = useState<FileSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set());
  // 自然语言搜索的 agent 执行过程（每次工具调用一条）。
  const [agentProgress, setAgentProgress] = useState<FileSearchAgentProgress[]>(
    []
  );
  const [agentError, setAgentError] = useState(false);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);
  const loadSeqRef = useRef(0);
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
        setEntries(results);
        setSelectedIndex(0);
      } catch {
        if (loadSeq === loadSeqRef.current) {
          preloadedEntriesRef.current = [];
          setEntries([]);
        }
      } finally {
        if (loadSeq === loadSeqRef.current) {
          setIsLoadingInitial(false);
        }
      }
    },
    []
  );

  const loadDirectories = useCallback(async () => {
    const loadSeq = ++loadSeqRef.current;

    try {
      const dirs = await window.snow.listWorkspaceDirectories();
      if (loadSeq !== loadSeqRef.current) {
        return;
      }

      const active = dirs.find((d) => d.isActive) ?? dirs[0] ?? null;
      setActiveDirectory(active);
      if (active) {
        await preloadRootEntries(active, loadSeq);
      } else {
        setIsLoadingInitial(false);
      }
    } catch {
      if (loadSeq === loadSeqRef.current) {
        setActiveDirectory(null);
        setIsLoadingInitial(false);
      }
    }
  }, [preloadRootEntries]);

  useEffect(() => {
    if (!visible) {
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
      ++loadSeqRef.current;
      ++searchSeqRef.current;
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [visible, loadDirectories]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const trimmed = query.trim();
    // `@?自然语言搜索词`：问号前缀表示自然语言搜索模式，交由 AI agent 查找。
    const isNaturalLanguage = trimmed.startsWith("?");

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    if (isNaturalLanguage) {
      // 取消进行中的根目录预加载，避免预加载结果覆盖 AI 搜索结果。
      ++loadSeqRef.current;
      setIsLoadingInitial(false);
      const nlQuery = trimmed.slice(1).trim();

      if (!activeDirectory || isSshPath(activeDirectory.path) || !nlQuery) {
        ++searchSeqRef.current;
        setIsSearching(false);
        setEntries([]);
        setSelectedIndex(0);
        setAgentProgress([]);
        setAgentError(false);
        lastQueryRef.current = trimmed;
        return;
      }

      if (trimmed === lastQueryRef.current) {
        return;
      }
      lastQueryRef.current = trimmed;

      setIsSearching(true);
      setAgentProgress([]);
      setAgentError(false);
      const seq = ++searchSeqRef.current;

      // AI 搜索耗时较长，防抖时间放宽。
      searchTimerRef.current = setTimeout(async () => {
        if (seq !== searchSeqRef.current) {
          return;
        }

        try {
          const results = await window.snow.searchFilesByAgent(
            nlQuery,
            activeDirectory.path,
            (chunk) => {
              if (seq !== searchSeqRef.current) {
                return;
              }
              // 只保留最近若干条，避免进度区溢出。
              setAgentProgress((prev) => [...prev.slice(-7), chunk]);
            }
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

      return () => {
        if (searchTimerRef.current) {
          clearTimeout(searchTimerRef.current);
        }
      };
    }

    if (!trimmed || !activeDirectory) {
      ++searchSeqRef.current;
      setIsSearching(false);
      if (preloadedEntriesRef.current.length > 0) {
        setEntries(preloadedEntriesRef.current);
        setSelectedIndex(0);
      }
      lastQueryRef.current = "";
      return;
    }

    if (trimmed === lastQueryRef.current) {
      return;
    }
    lastQueryRef.current = trimmed;

    setIsSearching(true);
    const seq = ++searchSeqRef.current;

    searchTimerRef.current = setTimeout(async () => {
      if (seq !== searchSeqRef.current) {
        return;
      }

      const queryLower = trimmed.toLowerCase();
      const endsWithSlash = queryLower.endsWith("/");

      try {
        const results = isSshPath(activeDirectory.path)
          ? await window.snow.searchRemoteWorkspaceFiles(activeDirectory.path, {
              query: trimmed,
              listChildren: false,
            })
          : await window.snow.searchFiles(activeDirectory.path, trimmed);

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

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [visible, query, activeDirectory]);

  // 路径导航：从查询文本解析当前浏览的路径段（用于面包屑与 ← 返回）
  const pathSegments = useMemo(() => getPathSegments(query), [query]);

  // 路径模式下（查询以 "/" 结尾，如 "src/renderer/"），后端会同时返回
  // "当前目录本身"与其子项；过滤掉目录本身，使面板呈现"已进入目录内容"的效果。
  const displayEntries = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed.endsWith("/")) {
      return entries;
    }
    const currentRel = trimmed.replace(/\/+$/, "").toLowerCase();
    const rootPath = activeDirectory?.path ?? "";
    return entries.filter((entry) => {
      const rel = getRelativePath(entry.path, rootPath).toLowerCase();
      return rel !== currentRel;
    });
  }, [entries, query, activeDirectory]);

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

  const handleSelectEntry = useCallback(
    (entry: FileSearchResult) => {
      // 目录条目：进入文件夹浏览（路径@），而不是直接插入目录引用。
      if (entry.isDirectory) {
        // 恢复输入框焦点与选区，确保父组件能正确回写 @ 路径
        textareaRef.current?.focus();
        const rootPath = activeDirectory?.path ?? "";
        const rel = getRelativePath(entry.path, rootPath);
        if (rel && rel !== entry.path) {
          onNavigateTo(rel);
        }
        return;
      }

      const checkedEntries = entries.filter((e) => checkedPaths.has(e.path));
      if (checkedEntries.length > 0 && !checkedPaths.has(entry.path)) {
        onSelectBatch([...checkedEntries.map(toFileTag), toFileTag(entry)]);
      } else if (checkedPaths.has(entry.path)) {
        onSelectBatch(checkedEntries.map(toFileTag));
      } else {
        onSelect(toFileTag(entry));
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
      activeDirectory,
    ]
  );

  const handleConfirmSelection = useCallback(() => {
    const checkedEntries = entries.filter((e) => checkedPaths.has(e.path));
    if (checkedEntries.length > 0) {
      onSelectBatch(checkedEntries.map(toFileTag));
      onClose();
      return;
    }
    const entry = displayEntries[selectedIndex];
    if (!entry) {
      return;
    }
    // Enter 直接选择（插入引用），与文件一致；进入目录请用 → 或点击。
    onSelect(toFileTag(entry));
    onClose();
  }, [
    displayEntries,
    entries,
    checkedPaths,
    selectedIndex,
    onSelect,
    onSelectBatch,
    onClose,
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

        if (displayEntries.length === 0) {
          return false;
        }

        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((prev) =>
            prev < displayEntries.length - 1 ? prev + 1 : prev
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
            const rootPath = activeDirectory?.path ?? "";
            const rel = getRelativePath(entry.path, rootPath);
            if (rel && rel !== entry.path) {
              onNavigateTo(rel);
            }
            return true;
          }
        }

        // ← 返回上级目录（移除最后一个路径段）
        if (event.key === "ArrowLeft") {
          if (pathSegments.length > 0) {
            event.preventDefault();
            onNavigateTo(pathSegments.slice(0, -1).join("/"));
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
      activeDirectory,
    ]
  );

  useEffect(() => {
    if (!selectedIndex) {
      return;
    }
    const container = listRef.current;
    if (!container) {
      return;
    }
    const selected = container.querySelector<HTMLElement>(
      `[data-mention-index="${selectedIndex}"]`
    );
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

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
      const tag = toFileTag(entry);
      if (onDragStart) {
        onDragStart(event, tag);
      } else {
        event.dataTransfer.setData("application/json", JSON.stringify(tag));
        event.dataTransfer.effectAllowed = "copy";
      }
    },
    [onDragStart]
  );

  const isNaturalLanguage = query.trim().startsWith("?");
  const naturalLanguageQuery = isNaturalLanguage
    ? query.trim().slice(1).trim()
    : "";

  const emptyText = useMemo(() => {
    if (isSearching) {
      return isNaturalLanguage
        ? t("fileMention.aiSearching")
        : t("fileMention.searching");
    }
    if (entries.length === 0) {
      if (isNaturalLanguage && agentError) {
        return t("fileMention.aiError");
      }
      if (!query || (isNaturalLanguage && !naturalLanguageQuery)) {
        return isNaturalLanguage
          ? t("fileMention.aiHint")
          : t("fileMention.typeToSearch");
      }
      return isNaturalLanguage
        ? t("fileMention.aiNoResults")
        : t("fileMention.noResults");
    }
    return t("fileMention.typeToSearch");
  }, [
    isSearching,
    entries.length,
    query,
    isNaturalLanguage,
    naturalLanguageQuery,
    agentError,
    t,
  ]);

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          animate={
            appleMotionEnabled
              ? reducedMotion
                ? { opacity: 1 }
                : { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }
              : undefined
          }
          className="file-mention-popup"
          exit={
            appleMotionEnabled
              ? reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.98, y: -4, filter: "blur(1px)" }
              : undefined
          }
          initial={
            appleMotionEnabled
              ? reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.98, y: -4, filter: "blur(1px)" }
              : false
          }
          ref={popupRef}
          data-esc-panel
          transition={appleMotionEnabled ? transition : undefined}
        >
      {pathSegments.length > 0 && (
        <div className="file-mention-breadcrumbs">
          <button
            type="button"
            className="file-mention-crumb"
            onClick={() => {
              textareaRef.current?.focus();
              onNavigateTo("");
            }}
            title={activeDirectory?.path ?? ""}
          >
            <Folder size={11} />
            <span>{activeDirectory?.name ?? "workspace"}</span>
          </button>
          {pathSegments.map((segment, index) => (
            <span className="file-mention-crumb-segment" key={index}>
              <ChevronRight size={10} className="file-mention-crumb-sep" />
              <button
                type="button"
                className="file-mention-crumb"
                onClick={() => {
                  textareaRef.current?.focus();
                  onNavigateTo(pathSegments.slice(0, index + 1).join("/"));
                }}
              >
                {segment}
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="file-mention-list" ref={listRef}>
        {isLoadingInitial ? (
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
                        {step.tool.replace("grep-search", "grep").replace(
                          "filesystem-read",
                          "read"
                        )}
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
            {(isSearching || displayEntries.length > 0) && (
              <span className="file-mention-count">
                {isSearching && <Loader2 className="spin" size={11} />}
                {displayEntries.length > 0 &&
                  t("fileMention.results", {
                    values: { count: displayEntries.length },
                  })}
                {displayEntries.length > 0 &&
                  checkedPaths.size > 0 &&
                  ` | ${t("fileMention.selected", {
                    values: { count: checkedPaths.size },
                  })}`}
              </span>
            )}
            {displayEntries.map((entry, index) => {
              const isChecked = checkedPaths.has(entry.path);
              const isSelected = selectedIndex === index;
              return (
                <div
                  key={entry.path}
                  data-mention-index={index}
                  className={`mention-entry ${isSelected ? "selected" : ""} ${
                    isChecked ? "checked" : ""
                  }`}
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
                  {entry.relativePath && (
                    <span className="mention-entry-path">
                      {entry.relativePath.replace(/\\/g, "/")}
                    </span>
                  )}
                  {entry.isDirectory && (
                    <ChevronRight
                      size={13}
                      className="mention-entry-enter"
                      aria-hidden
                    />
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
        <span className="file-mention-hint">
          <kbd>Enter</kbd> {t("fileMention.confirm")}
        </span>
        <span className="file-mention-hint">
          <kbd>Esc</kbd> {t("fileMention.close")}
        </span>
        <span className="file-mention-hint drag-hint">
          {t("fileMention.dragToInput")}
        </span>
      </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
