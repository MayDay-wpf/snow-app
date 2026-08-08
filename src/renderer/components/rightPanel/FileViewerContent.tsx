import hljs from "highlight.js";
import {
  AlertCircle,
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Eye,
  FileText,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Save,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import Editor from "react-simple-code-editor";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useKeyboardShortcutsSettings } from "../KeyboardShortcutsProvider";
import { useI18n } from "../../i18n";
import { MarkdownBlock } from "../mainContent/chatMessages/components/markdownRenderer";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { rightPanelEvents } from "./rightPanelEvents";
import type { FileContentResult } from "./types";

type FileViewerContentProps = {
  filePath: string;
  fileName: string;
  isSsh: boolean;
  sshSessionId?: string | null;
  sshWorkspaceRoot?: string;
  sshWorkspaceId?: string;
  focusLine?: number;
  onDirtyChange?: (dirty: boolean) => void;
  /** 在文件所在目录打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
};

const EDITOR_TEXTAREA_ID = "file-viewer-editor-textarea";

/** 文内搜索匹配数上限，避免超大文件单字符查询卡死。 */
const SEARCH_MATCH_LIMIT = 10000;
/** 查看模式高亮矩形渲染上限，超过时只渲染当前匹配。 */
const SEARCH_MARK_RENDER_LIMIT = 2000;
/** 编辑模式下可作为初始查询的选区最大长度。 */
const SEARCH_SEED_MAX_LENGTH = 200;

type SearchMatch = { start: number; end: number; line: number };

type SearchMarkRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  isCurrent: boolean;
};

/**
 * 在 root 的文本节点上按字符偏移 [start, end) 创建 DOM Range，
 * 供 getClientRects() 取得匹配文本的渲染矩形（查看模式高亮层与
 * 横向滚动定位使用）。root 的 textContent 必须与搜索目标一致。
 */
const makeTextRange = (
  root: HTMLElement,
  start: number,
  end: number
): Range | null => {
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  let started = false;
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && start <= position + length) {
      range.setStart(node, start - position);
      started = true;
    }
    if (started && end <= position + length) {
      range.setEnd(node, end - position);
      return range;
    }
    position += length;
    node = walker.nextNode();
  }
  return null;
};

const escapeHtml = (str: string): string =>
  str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const getLanguageFromFileName = (fileName: string): string => {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    htm: "xml",
    xml: "xml",
    svg: "xml",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    cfg: "ini",
    sql: "sql",
    graphql: "graphql",
    gql: "graphql",
    lua: "lua",
    r: "r",
    dart: "dart",
    vue: "xml",
    svelte: "xml",
    dockerfile: "dockerfile",
    makefile: "makefile",
    diff: "diff",
    patch: "diff",
  };
  return map[ext] ?? "";
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isEditable = (content: FileContentResult): boolean =>
  !content.isBinary && !content.isImage;

const serializeRemoteVersion = (
  version: FileContentResult["remoteVersion"] | undefined
): string => JSON.stringify(version ?? { exists: false });

/** 解析 markdown 链接路径：支持 `path:line` 与 `path#Lline` 行号定位。 */
const parseHrefPathWithLine = (
  raw: string
): { path: string; line?: number } => {
  // 冒号后必须为纯数字，避免误伤 Windows 盘符（C:\foo）。
  const hashMatch = raw.match(/^(.+?)#L(\d+)$/i);
  if (hashMatch) {
    return { path: hashMatch[1], line: parseInt(hashMatch[2], 10) };
  }
  const lineMatch = raw.match(/^(.+):(\d+)$/);
  if (lineMatch) {
    return { path: lineMatch[1], line: parseInt(lineMatch[2], 10) };
  }
  return { path: raw };
};

/**
 * 将 markdown 链接路径解析为可打开文件的绝对路径（基于当前文件所在目录）。
 * 支持 Windows 盘符 / POSIX 绝对路径 / SSH 路径 / 相对路径（含 ./ 与 ../）。
 */
const resolveHrefPath = (
  baseFilePath: string,
  raw: string
): { path: string; line?: number } | null => {
  const { path: hrefPath, line } = parseHrefPathWithLine(raw);
  if (!hrefPath) {
    return null;
  }
  // 绝对路径（Windows 盘符 / POSIX / SSH 风格）直接使用。
  if (
    /^[a-zA-Z]:[\\/]/.test(hrefPath) ||
    hrefPath.startsWith("/") ||
    hrefPath.startsWith("\\")
  ) {
    return { path: hrefPath, line };
  }
  // 相对路径：基于当前文件所在目录解析（统一归一化分隔符处理 ./ 与 ../）。
  const sep = baseFilePath.includes("\\") ? "\\" : "/";
  const normSep = "/";
  const dir = baseFilePath.replace(/\\/g, normSep).replace(/[^/]+$/, "");
  const parts = `${dir}${hrefPath.replace(/\\/g, normSep)}`.split(normSep);
  const root = parts[0] === "" ? normSep : "";
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  const joined = stack.join(normSep);
  const resolved = `${root}${joined}`;
  return { path: sep === "\\" ? resolved.replace(/\//g, "\\") : resolved, line };
};

export function FileViewerContent({
  filePath,
  fileName,
  isSsh,
  sshSessionId,
  sshWorkspaceRoot,
  sshWorkspaceId,
  focusLine,
  onDirtyChange,
  onOpenTerminal,
}: FileViewerContentProps): React.JSX.Element {
  const { t } = useI18n();
  const { registerScopedHandler } = useKeyboardShortcutsSettings();
  const [content, setContent] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [svgMode, setSvgMode] = useState<"image" | "code">("image");
  // Markdown 文件阅读模式：preview = 渲染预览（标题/列表/链接/代码块），
  // code = 源码视图（保留行号与文内搜索）。
  const [mdMode, setMdMode] = useState<"preview" | "code">("preview");
  const [copied, setCopied] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const isMarkdown = /\.(md|markdown)$/i.test(fileName);

  /** 获取当前选中的文本（编辑模式读 textarea 选区，否则读浏览器选区）。 */
  const getSelectedText = (): string => {
    if (editMode) {
      const textarea = document.getElementById(EDITOR_TEXTAREA_ID);
      if (textarea instanceof HTMLTextAreaElement) {
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? 0;
        return textarea.value.slice(start, end);
      }
      return "";
    }
    return window.getSelection()?.toString() ?? "";
  };

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);
  const [saveGuarantee, setSaveGuarantee] = useState<
    "strong_atomic" | "atomic_best_effort" | "compatibility" | null
  >(null);
  const [draftStatus, setDraftStatus] = useState<"pending" | "conflict" | null>(
    null
  );

  const originalContentRef = useRef("");
  const onDirtyChangeRef = useRef(onDirtyChange);
  const draftSnapshotRef = useRef<{
    profileId: string;
    workspaceId: string;
    remotePath: string;
    baseVersionJson: string;
    content: string;
    dirty: boolean;
    status: "pending" | "conflict";
  } | null>(null);
  const sawSshDisconnectRef = useRef(false);

  const canPersistRemoteDraft =
    isSsh &&
    typeof sshSessionId === "string" &&
    sshSessionId.startsWith("ssh-profile:") &&
    Boolean(sshWorkspaceId);

  // 代码视图滚动容器与高亮行相关状态。focusLine 由外部
  // （搜索结果点击行）传入，加载完内容后滚动到该行并临时高亮。
  const codeScrollRef = useRef<HTMLDivElement | null>(null);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);

  // ===== 文内搜索（Ctrl/Cmd+F）相关 =====
  // 文件区持有焦点时 openSearch 快捷键被接管为文内搜索（scoped 拦截），
  // 失焦后自动回落到全局聚合搜索。RightPanel 为 keep-alive 多实例共存，
  // 只有持有焦点的实例会拦截。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const codeContentRef = useRef<HTMLElement | null>(null);
  const marksLayerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // 锚点：打开搜索时记录光标位置，首个命中落在锚点附近；null 表示未设置。
  const searchAnchorRef = useRef<number | null>(null);
  // 导航时钟：仅显式导航（打开/上一个/下一个）时才在编辑模式重设选区，
  // 避免用户在 textarea 中编辑时不断覆盖其光标。
  const searchNavTickRef = useRef(0);
  const lastHandledNavTickRef = useRef(0);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchMarkRects, setSearchMarkRects] = useState<SearchMarkRect[]>([]);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEditMode(false);
    setDirty(false);
    setSaveError(null);
    setSavedAt(false);
    setSaveGuarantee(null);
    setDraftStatus(null);
    setEditedContent("");
    setMdMode("preview");
    try {
      let result: FileContentResult;
      if (isSsh && sshSessionId) {
        result = await window.snow.sshReadFile(sshSessionId, filePath);
      } else {
        result = await window.snow.readFileContent(filePath);
      }
      setContent(result);
      originalContentRef.current = result.content;
      if (canPersistRemoteDraft && sshSessionId && sshWorkspaceId) {
        try {
          const drafts = await window.snow.sshListRemoteDrafts(
            sshWorkspaceId,
            sshSessionId
          );
          const draft = drafts.find((item) => item.remotePath === filePath);
          if (draft) {
            const isCurrentBaseVersion =
              draft.baseVersionJson === serializeRemoteVersion(result.remoteVersion);
            setEditMode(true);
            setEditedContent(draft.content);
            setDirty(draft.content !== result.content);
            setDraftStatus(isCurrentBaseVersion ? draft.status : "conflict");
            if (!isCurrentBaseVersion) {
              setSaveError(
                t("rightPanel.fileViewerSaveConflict", {
                  defaultValue:
                    "The remote file changed. Reload it before saving your changes.",
                })
              );
              void window.snow.sshUpsertRemoteDraft({
                ...draft,
                status: "conflict",
              });
            }
          }
        } catch {
          // A draft lookup must not make a readable remote file unavailable.
        }
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("rightPanel.fileViewerLoadError", {
              defaultValue: "Failed to load file",
            })
      );
    } finally {
      setLoading(false);
    }
  }, [
    canPersistRemoteDraft,
    filePath,
    isSsh,
    sshSessionId,
    sshWorkspaceId,
    t,
  ]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  // focusLine 变化时滚动到目标行并高亮。仅在非编辑、非二进制/图片、
  // 内容已加载且行号有效时生效。每次 focusLine 变化都会重新触发，
  // 即使是同一文件的不同行点击。
  useEffect(() => {
    if (
      focusLine == null ||
      focusLine < 1 ||
      loading ||
      !content ||
      content.isBinary ||
      content.isImage ||
      editMode
    ) {
      return;
    }

    const scrollEl = codeScrollRef.current;
    if (!scrollEl) {
      return;
    }

    // 测量单行高度：取 .file-viewer-code 的 line-height 计算值。
    const codeEl = scrollEl.querySelector(".file-viewer-code");
    if (!codeEl) {
      return;
    }
    const style = window.getComputedStyle(codeEl);
    const lineHeight = parseFloat(style.lineHeight);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      return;
    }

    const lineCount = content.content.split("\n").length;
    const targetLine = Math.min(focusLine, lineCount);
    const targetTop = paddingTop + (targetLine - 1) * lineHeight;

    // 滚动使目标行尽量落在视口上部约 1/3 处。
    const viewportH = scrollEl.clientHeight;
    scrollEl.scrollTop = Math.max(0, targetTop - viewportH / 3);

    setHighlightLine(targetLine);
    const timer = window.setTimeout(() => {
      setHighlightLine(null);
    }, 2400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [focusLine, loading, content, editMode]);

  const highlightCode = useCallback(
    (code: string): string => {
      const lang = getLanguageFromFileName(fileName);
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, {
            language: lang,
            ignoreIllegals: true,
          }).value;
        } catch {
          return escapeHtml(code);
        }
      }
      return escapeHtml(code);
    },
    [fileName]
  );

  const highlightedCode = useMemo(() => {
    if (!content || content.isImage || content.isBinary)
      return { html: "", lineCount: 0 };
    return {
      html: highlightCode(content.content),
      lineCount: content.content.split("\n").length,
    };
  }, [content, highlightCode]);

  const viewLineNumbers = useMemo(
    () =>
      Array.from({ length: highlightedCode.lineCount }, (_, i) => i + 1).join(
        "\n"
      ),
    [highlightedCode.lineCount]
  );

  const editLineCount = useMemo(
    () => (editMode ? editedContent.split("\n").length : 0),
    [editMode, editedContent]
  );

  const editLineNumbers = useMemo(
    () => Array.from({ length: editLineCount }, (_, i) => i + 1).join("\n"),
    [editLineCount]
  );

  const handleCopy = useCallback(() => {
    if (!content) return;
    navigator.clipboard.writeText(content.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  const handleEnterEditMode = useCallback(() => {
    if (!content || !isEditable(content)) return;
    // 编辑基于源码：markdown 预览模式下自动切回源码视图。
    if (isMarkdown) {
      setMdMode("code");
    }
    setEditMode(true);
    setEditedContent(content.content);
    setDirty(false);
    setSaveError(null);
    setSavedAt(false);
    setSaveGuarantee(null);
  }, [content, isMarkdown]);

  const handleExitEditMode = useCallback(() => {
    if (dirty) {
      const confirmed = window.confirm(
        t("rightPanel.fileViewerDiscardConfirm", {
          defaultValue:
            "You have unsaved changes. Discard them and leave edit mode?",
        })
      );
      if (!confirmed) {
        return;
      }
    }
    if (canPersistRemoteDraft && sshSessionId && sshWorkspaceId) {
      void window.snow.sshDeleteRemoteDraft(
        sshSessionId,
        sshWorkspaceId,
        filePath
      ).catch(() => {
        // Keep an undeleted draft recoverable if SQLite is unavailable.
      });
    }
    if (draftSnapshotRef.current) {
      draftSnapshotRef.current.dirty = false;
    }
    setEditMode(false);
    setDirty(false);
    setSaveError(null);
    setSavedAt(false);
    setEditedContent("");
  }, [
    canPersistRemoteDraft,
    dirty,
    filePath,
    sshSessionId,
    sshWorkspaceId,
    t,
  ]);

  const handleValueChange = useCallback((next: string) => {
    setEditedContent(next);
    const isDirty = next !== originalContentRef.current;
    setDirty(isDirty);
    if (!isDirty) {
      setSaveError(null);
      setSavedAt(false);
      setDraftStatus(null);
    } else {
      setDraftStatus("pending");
    }
  }, []);

  const persistRemoteDraft = useCallback(
    async (status: "pending" | "conflict"): Promise<void> => {
      if (!canPersistRemoteDraft || !sshSessionId || !sshWorkspaceId) {
        return;
      }
      await window.snow.sshUpsertRemoteDraft({
        profileId: sshSessionId,
        workspaceId: sshWorkspaceId,
        remotePath: filePath,
        baseVersionJson: serializeRemoteVersion(content?.remoteVersion),
        content: editedContent,
        status,
      });
      if (draftSnapshotRef.current) {
        draftSnapshotRef.current.status = status;
      }
      setDraftStatus(status);
    },
    [
      canPersistRemoteDraft,
      content?.remoteVersion,
      editedContent,
      filePath,
      sshSessionId,
      sshWorkspaceId,
    ]
  );

  useEffect(() => {
    if (!dirty || !canPersistRemoteDraft) {
      return;
    }
    const timer = window.setTimeout(() => {
      void persistRemoteDraft("pending").catch(() => {
        // The editor remains dirty; the final unmount flush retries this write.
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [canPersistRemoteDraft, dirty, persistRemoteDraft]);

  useEffect(() => {
    draftSnapshotRef.current =
      canPersistRemoteDraft && sshSessionId && sshWorkspaceId
        ? {
            profileId: sshSessionId,
            workspaceId: sshWorkspaceId,
            remotePath: filePath,
            baseVersionJson: serializeRemoteVersion(content?.remoteVersion),
            content: editedContent,
            dirty,
            status: draftStatus ?? "pending",
          }
        : null;
  }, [
    canPersistRemoteDraft,
    content?.remoteVersion,
    draftStatus,
    dirty,
    editedContent,
    filePath,
    sshSessionId,
    sshWorkspaceId,
  ]);

  useEffect(() => {
    return () => {
      const draft = draftSnapshotRef.current;
      if (!draft?.dirty) {
        return;
      }
      void window.snow.sshUpsertRemoteDraft({
        ...draft,
        status: draft.status,
      });
    };
  }, []);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    setSavedAt(false);
    setSaveGuarantee(null);
    try {
      let remoteSave:
        | {
            guarantee: "strong_atomic" | "atomic_best_effort" | "compatibility";
            version: NonNullable<FileContentResult["remoteVersion"]>;
          }
        | undefined;
      if (isSsh) {
        if (!sshSessionId || !sshWorkspaceId || !content?.remoteVersion) {
          throw new Error("Remote file save is missing its verified workspace or version");
        }
        remoteSave = await window.snow.sshWriteFile(
          sshSessionId,
          filePath,
          editedContent,
          {
            workspaceId: sshWorkspaceId,
            expectedVersion: content.remoteVersion,
          }
        );
      } else {
        await window.snow.writeFileContent(filePath, editedContent);
      }
      originalContentRef.current = editedContent;
      if (draftSnapshotRef.current) {
        draftSnapshotRef.current.dirty = false;
      }
      setDirty(false);
      setSavedAt(true);
      setSaveGuarantee(remoteSave?.guarantee ?? null);
      window.setTimeout(() => setSavedAt(false), 2000);
      if (content) {
        setContent({
          ...content,
          content: editedContent,
          size: new Blob([editedContent]).size,
          remoteVersion: remoteSave?.version ?? content.remoteVersion,
        });
      }
      if (canPersistRemoteDraft && sshSessionId && sshWorkspaceId) {
        try {
          await window.snow.sshDeleteRemoteDraft(
            sshSessionId,
            sshWorkspaceId,
            filePath
          );
        } catch {
          // The remote write is already durable. A stale local draft is
          // recoverable and must not turn that successful save into an error.
        }
        setDraftStatus(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setSaveError(
        /\[SSH_FILE_CONFLICT\]/.test(message)
          ? t("rightPanel.fileViewerSaveConflict", {
              defaultValue:
                "The remote file changed. Reload it before saving your changes.",
            })
          : message ||
              t("rightPanel.fileViewerSaveError", {
                defaultValue: "Failed to save file",
              })
      );
      if (/\[SSH_FILE_CONFLICT\]/.test(message)) {
        void persistRemoteDraft("conflict").catch(() => {
          // Preserve the editor even when local draft persistence is unavailable.
        });
      }
    } finally {
      setSaving(false);
    }
  }, [
    dirty,
    saving,
    isSsh,
    sshSessionId,
    sshWorkspaceRoot,
    filePath,
    editedContent,
    content,
    canPersistRemoteDraft,
    persistRemoteDraft,
    t,
    sshWorkspaceId,
  ]);

  useEffect(() => {
    if (!canPersistRemoteDraft || !sshSessionId) {
      return;
    }
    return window.snow.onSshProfileConnection((connection) => {
      if (connection.profileId !== sshSessionId) {
        return;
      }
      if (connection.status !== "connected") {
        sawSshDisconnectRef.current = true;
        return;
      }
      if (
        sawSshDisconnectRef.current &&
        dirty &&
        draftStatus === "pending"
      ) {
        sawSshDisconnectRef.current = false;
        void handleSave();
      } else if (connection.status === "connected") {
        sawSshDisconnectRef.current = false;
      }
    });
  }, [canPersistRemoteDraft, dirty, draftStatus, handleSave, sshSessionId]);

  useEffect(() => {
    sawSshDisconnectRef.current = false;
  }, [sshSessionId]);

  // Markdown 预览中点击文件链接（相对路径/绝对路径）：解析为绝对路径后
  // 通过 open-file 事件在右侧面板新建文件阅读器 tab，替代 Electron 默认
  // 导航（渲染进程导航到相对 URL 会导致黑屏）。
  const handleFileLinkClick = useCallback(
    (href: string) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(href);
      } catch {
        decoded = href;
      }
      const resolved = resolveHrefPath(filePath, decoded);
      if (!resolved) {
        return;
      }
      rightPanelEvents.emit("open-file", {
        filePath: resolved.path,
        isSsh,
        sshSessionId: isSsh ? sshSessionId : undefined,
        sshWorkspaceRoot: isSsh ? sshWorkspaceRoot : undefined,
        sshWorkspaceId: isSsh ? sshWorkspaceId : undefined,
        focusLine: resolved.line,
      });
    },
    [filePath, isSsh, sshSessionId]
  );

  // Keyboard shortcuts handled inside the editor's onKeyDown (which runs before
  // the library's own key handling): Ctrl/Cmd+S saves, Esc exits edit mode.
  // Undo/redo (Ctrl/Cmd+Z, Ctrl+Y) is handled natively by the editor library.
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (dirty && !saving) {
          void handleSave();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        handleExitEditMode();
      }
    },
    [dirty, saving, handleSave, handleExitEditMode]
  );

  // Focus the editor when entering edit mode. No scroll syncing is needed for
  // the gutter: it lives inside `.file-viewer-edit-scroll` alongside the code,
  // so both scroll together as one piece of content.
  useEffect(() => {
    if (!editMode) return;
    const textarea = document.getElementById(EDITOR_TEXTAREA_ID);
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus();
    }
  }, [editMode]);

  // ===== 文内搜索逻辑 =====

  const canSearch =
    content != null &&
    !content.isBinary &&
    !content.isImage &&
    // markdown 渲染预览没有可定位的文本节点，搜索仅源码视图可用。
    !(isMarkdown && mdMode === "preview");

  // 搜索目标：编辑模式搜 editedContent，查看模式搜已加载内容。
  const searchTarget = useMemo(() => {
    if (!canSearch || content == null) return "";
    return editMode ? editedContent : content.content;
  }, [canSearch, content, editMode, editedContent]);

  const searchMatches = useMemo<SearchMatch[]>(() => {
    if (!searchOpen || searchQuery.length === 0 || searchTarget.length === 0) {
      return [];
    }
    const haystack = searchCaseSensitive
      ? searchTarget
      : searchTarget.toLowerCase();
    const needle = searchCaseSensitive
      ? searchQuery
      : searchQuery.toLowerCase();
    // 行起始偏移表，用于二分反查匹配所在行号。
    const lineStarts: number[] = [0];
    for (let i = 0; i < searchTarget.length; i += 1) {
      if (searchTarget[i] === "\n") lineStarts.push(i + 1);
    }
    const matches: SearchMatch[] = [];
    let from = 0;
    while (matches.length < SEARCH_MATCH_LIMIT) {
      const found = haystack.indexOf(needle, from);
      if (found === -1) break;
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= found) lo = mid;
        else hi = mid - 1;
      }
      matches.push({ start: found, end: found + needle.length, line: lo + 1 });
      from = found + needle.length;
    }
    return matches;
  }, [searchOpen, searchQuery, searchCaseSensitive, searchTarget]);

  // 匹配集变化：有锚点则落在锚点后第一个命中，否则夹紧当前索引。
  useEffect(() => {
    if (searchMatches.length === 0) {
      setSearchIndex(0);
      return;
    }
    const anchor = searchAnchorRef.current;
    if (anchor != null) {
      searchAnchorRef.current = null;
      const anchored = searchMatches.findIndex((m) => m.end > anchor);
      setSearchIndex(anchored === -1 ? 0 : anchored);
      return;
    }
    setSearchIndex((prev) => (prev >= searchMatches.length ? 0 : prev));
  }, [searchMatches]);

  const focusSearchInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }, []);

  // 作用域接管的局部 handler：打开（或重新聚焦）文内搜索。
  // 编辑模式下若 textarea 存在短单行选区，以其作为初始查询。
  const openLocalSearch = useCallback(() => {
    // markdown 预览模式无行号/文本节点定位，打开搜索时自动切回源码视图。
    if (isMarkdown && mdMode !== "code") {
      setMdMode("code");
    }
    if (editMode) {
      const textarea = document.getElementById(EDITOR_TEXTAREA_ID);
      if (textarea instanceof HTMLTextAreaElement) {
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? 0;
        searchAnchorRef.current = start;
        if (end > start && end - start <= SEARCH_SEED_MAX_LENGTH) {
          const selected = textarea.value.slice(start, end);
          if (!selected.includes("\n")) {
            setSearchQuery(selected);
          }
        }
      }
    } else {
      searchAnchorRef.current = null;
    }
    searchNavTickRef.current += 1;
    setSearchOpen(true);
    focusSearchInput();
  }, [editMode, focusSearchInput, isMarkdown, mdMode]);

  // 拦截条件：焦点位于本文件查看器内（含搜索栏自身）。
  const shouldInterceptOpenSearch = useCallback(() => {
    const root = rootRef.current;
    const active = document.activeElement;
    return root != null && active != null && root.contains(active);
  }, []);

  useEffect(() => {
    return registerScopedHandler(
      "openSearch",
      openLocalSearch,
      shouldInterceptOpenSearch
    );
  }, [registerScopedHandler, openLocalSearch, shouldInterceptOpenSearch]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchMarkRects([]);
    if (editMode) {
      requestAnimationFrame(() => {
        const textarea = document.getElementById(EDITOR_TEXTAREA_ID);
        if (textarea instanceof HTMLTextAreaElement) {
          textarea.focus();
        }
      });
    }
  }, [editMode]);

  const goRelative = useCallback(
    (delta: number) => {
      if (searchMatches.length === 0) return;
      searchNavTickRef.current += 1;
      setSearchIndex((prev) => {
        const total = searchMatches.length;
        return (prev + delta + total) % total;
      });
    },
    [searchMatches.length]
  );

  // 搜索栏按键：容器带 data-local-shortcuts，全局快捷键引擎不介入。
  const handleSearchBarKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        goRelative(event.shiftKey ? -1 : 1);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        searchInputRef.current?.select();
      }
    },
    [closeSearch, goRelative]
  );

  // 当前匹配滚动入视。编辑模式仅在显式导航时重设选区（避免覆盖用户
  // 正在编辑的光标）；查看模式始终滚动（纵向外层容器 + 横向内层代码区）。
  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const match =
      searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    if (!match) return;
    const navigated =
      searchNavTickRef.current !== lastHandledNavTickRef.current;
    if (navigated) {
      lastHandledNavTickRef.current = searchNavTickRef.current;
    }

    if (editMode) {
      if (!navigated) return;
      const textarea = document.getElementById(EDITOR_TEXTAREA_ID);
      if (!(textarea instanceof HTMLTextAreaElement)) return;
      textarea.setSelectionRange(match.start, match.end);
      const lineHeight = parseFloat(
        window.getComputedStyle(textarea).lineHeight
      );
      if (Number.isFinite(lineHeight) && lineHeight > 0) {
        textarea.scrollTop = Math.max(
          0,
          (match.line - 1) * lineHeight - textarea.clientHeight / 3
        );
      }
      return;
    }

    const scrollEl = codeScrollRef.current;
    const codeEl = scrollEl?.querySelector(".file-viewer-code") ?? null;
    if (scrollEl && codeEl) {
      const style = window.getComputedStyle(codeEl);
      const lineHeight = parseFloat(style.lineHeight);
      const paddingTop = parseFloat(style.paddingTop) || 0;
      if (Number.isFinite(lineHeight) && lineHeight > 0) {
        const targetTop = paddingTop + (match.line - 1) * lineHeight;
        scrollEl.scrollTop = Math.max(0, targetTop - scrollEl.clientHeight / 3);
      }
    }
    const contentEl = codeContentRef.current;
    if (contentEl) {
      const range = makeTextRange(contentEl, match.start, match.end);
      const rects = range?.getClientRects();
      if (rects && rects.length > 0) {
        const first = rects[0];
        const box = contentEl.getBoundingClientRect();
        const x = first.left - box.left + contentEl.scrollLeft;
        const margin = 24;
        if (x < contentEl.scrollLeft + margin) {
          contentEl.scrollLeft = Math.max(0, x - margin);
        } else if (
          x + first.width >
          contentEl.scrollLeft + contentEl.clientWidth - margin
        ) {
          contentEl.scrollLeft =
            x + first.width - contentEl.clientWidth + margin;
        }
      }
    }
  }, [searchOpen, searchMatches, searchIndex, editMode]);

  // 查看模式匹配高亮层：用 Range 取每个匹配文本的渲染矩形，换算为相对
  // .file-viewer-code 的坐标；内层代码区横向滚动由层 transform 实时补偿。
  useLayoutEffect(() => {
    if (editMode || !searchOpen) {
      setSearchMarkRects([]);
      return;
    }
    const layer = marksLayerRef.current;
    const contentEl = codeContentRef.current;
    if (!layer || !contentEl || searchMatches.length === 0) {
      setSearchMarkRects([]);
      return;
    }
    const preEl = contentEl.closest(".file-viewer-code");
    if (!preEl) return;
    const preRect = preEl.getBoundingClientRect();
    const scrollLeft = contentEl.scrollLeft;
    const current =
      searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    if (!current) {
      setSearchMarkRects([]);
      return;
    }
    const list =
      searchMatches.length <= SEARCH_MARK_RENDER_LIMIT
        ? searchMatches
        : [current];
    const rects: SearchMarkRect[] = [];
    for (const match of list) {
      const range = makeTextRange(contentEl, match.start, match.end);
      if (!range) continue;
      const clientRects = range.getClientRects();
      for (let i = 0; i < clientRects.length; i += 1) {
        const r = clientRects[i];
        if (r.width <= 0 && r.height <= 0) continue;
        rects.push({
          left: r.left - preRect.left + scrollLeft,
          top: r.top - preRect.top,
          width: r.width,
          height: r.height,
          isCurrent: match === current,
        });
      }
    }
    layer.style.transform = `translateX(${-scrollLeft}px)`;
    setSearchMarkRects(rects);
  }, [
    searchOpen,
    editMode,
    searchMatches,
    searchIndex,
    highlightedCode,
    svgMode,
  ]);

  const handleCodeContentScroll = useCallback(
    (event: React.UIEvent<HTMLElement>) => {
      const layer = marksLayerRef.current;
      if (layer) {
        const scrollLeft = (event.currentTarget as HTMLElement).scrollLeft;
        layer.style.transform = `translateX(${-scrollLeft}px)`;
      }
    },
    []
  );

  const buildMenuItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    const selected = getSelectedText().trim();
    if (selected) {
      items.push({
        id: "copy",
        label: t("rightPanel.copy", { defaultValue: "Copy" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(selected).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      });
    }
    items.push({
      id: "copy-path",
      label: t("rightPanel.copyPath", { defaultValue: "Copy Path" }),
      icon: <Copy size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        void window.snow.writeClipboardText(filePath).catch(() => {
          // 剪贴板写入失败时静默忽略。
        });
      },
    });
    if (onOpenTerminal && !isSsh) {
      items.push({
        id: "open-terminal",
        label: t("rightPanel.openInTerminal", {
          defaultValue: "Open in Terminal",
        }),
        icon: <TerminalIcon size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          const lastSep = Math.max(
            filePath.lastIndexOf("/"),
            filePath.lastIndexOf("\\")
          );
          const dir = lastSep === -1 ? filePath : filePath.slice(0, lastSep);
          onOpenTerminal(dir);
        },
      });
    }
    return items;
  };

  const renderCodeBlock = () => {
    const { html } = highlightedCode;
    // 计算高亮条位置。lineHeight 在 effect 中也测量过，这里为渲染
    // 重新取一次（此时 DOM 已存在）。若取不到则不渲染高亮条。
    let highlightStyle: React.CSSProperties | null = null;
    if (highlightLine != null && codeScrollRef.current) {
      const codeEl = codeScrollRef.current.querySelector(".file-viewer-code");
      if (codeEl) {
        const style = window.getComputedStyle(codeEl);
        const lineHeight = parseFloat(style.lineHeight);
        const paddingTop = parseFloat(style.paddingTop) || 0;
        if (Number.isFinite(lineHeight) && lineHeight > 0) {
          highlightStyle = {
            top: `${paddingTop + (highlightLine - 1) * lineHeight}px`,
            height: `${lineHeight}px`,
          };
        }
      }
    }
    return (
      <div className="file-viewer-code-scroll" ref={codeScrollRef}>
        <pre className="file-viewer-code">
          {highlightStyle ? (
            <span
              className="file-viewer-line-highlight"
              style={highlightStyle}
              aria-hidden="true"
            />
          ) : null}
          {searchOpen && !editMode ? (
            <div
              className="file-viewer-search-marks"
              ref={marksLayerRef}
              aria-hidden="true"
            >
              {searchMarkRects.map((rect, i) => (
                <div
                  key={i}
                  className={`file-viewer-search-mark${
                    rect.isCurrent ? " current" : ""
                  }`}
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              ))}
            </div>
          ) : null}
          <code className="file-viewer-line-numbers" aria-hidden="true">
            {viewLineNumbers}
          </code>
          <code
            ref={codeContentRef}
            className="hljs file-viewer-code-content"
            onScroll={handleCodeContentScroll}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </pre>
      </div>
    );
  };

  const renderEditBlock = () => (
    <div className="file-viewer-edit-scroll">
      <div className="file-viewer-code">
        <code
          className="file-viewer-line-numbers file-viewer-line-numbers--edit"
          aria-hidden="true"
        >
          {editLineNumbers}
        </code>
        <div className="file-viewer-editor-wrap">
          <Editor
            value={editedContent}
            onValueChange={handleValueChange}
            highlight={highlightCode}
            onKeyDown={handleEditorKeyDown}
            textareaId={EDITOR_TEXTAREA_ID}
            textareaClassName="file-viewer-edit-textarea"
            preClassName="hljs"
            padding={{ top: 0, right: 14, bottom: 0, left: 10 }}
            tabSize={2}
            insertSpaces
            spellCheck={false}
            style={{ minWidth: "max-content" }}
          />
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-file-name" title={filePath}>
            {fileName}
          </span>
        </div>
        <div className="file-viewer-loading">
          <Loader2 className="spin" size={20} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-file-name" title={filePath}>
            {fileName}
          </span>
        </div>
        <div className="file-viewer-error">
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-file-name" title={filePath}>
            {fileName}
          </span>
        </div>
        <div className="file-viewer-empty">
          <FileText size={20} />
          <span>
            {t("rightPanel.fileViewerEmpty", {
              defaultValue: "No content to display",
            })}
          </span>
        </div>
      </div>
    );
  }

  const isSvg = content.isSvg;
  const isImage = content.isImage;
  const isBinary = content.isBinary && !isImage;
  const canEdit = isEditable(content);

  return (
    <div
      className="file-viewer"
      ref={rootRef}
      tabIndex={-1}
      onContextMenu={(e) => {
        // 编辑模式放行浏览器原生菜单（保留 textarea 的复制/粘贴/剪切）。
        if (editMode) {
          return;
        }
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="file-viewer-header">
        <span className="file-viewer-file-name" title={filePath}>
          {fileName}
        </span>
        <span className="file-viewer-file-size">
          {formatSize(content.size)}
        </span>
        {editMode ? (
          <span
            className={`file-viewer-edit-status ${dirty ? "dirty" : ""} ${
              savedAt ? "saved" : ""
            }`}
          >
            {dirty
              ? t("rightPanel.fileViewerUnsaved", {
                  defaultValue: "Unsaved",
                })
              : savedAt
              ? saveGuarantee === "strong_atomic"
                ? t("rightPanel.fileViewerSavedStrongAtomic", {
                    defaultValue: "Saved (strong atomic)",
                  })
                : saveGuarantee === "atomic_best_effort"
                ? t("rightPanel.fileViewerSavedAtomicBestEffort", {
                    defaultValue: "Saved (atomic best effort)",
                  })
                : saveGuarantee === "compatibility"
                ? t("rightPanel.fileViewerSavedCompatibility", {
                    defaultValue: "Saved (compatibility mode)",
                  })
                : t("rightPanel.fileViewerSaved", {
                    defaultValue: "Saved",
                  })
              : t("rightPanel.fileViewerEditing", {
                  defaultValue: "Editing",
                })}
          </span>
        ) : null}
        {editMode && draftStatus ? (
          <span
            className={`file-viewer-draft-status ${draftStatus}`}
            title={
              draftStatus === "conflict"
                ? t("rightPanel.fileViewerDraftConflict", {
                    defaultValue: "Remote changes require review before saving",
                  })
                : t("rightPanel.fileViewerDraftPending", {
                    defaultValue: "Draft pending remote sync",
                  })
            }
          >
            {draftStatus === "conflict"
              ? t("rightPanel.fileViewerDraftConflict", {
                  defaultValue: "Draft conflict",
                })
              : t("rightPanel.fileViewerDraftPending", {
                  defaultValue: "Draft pending",
                })}
          </span>
        ) : null}
        {isSvg && (
          <div className="file-viewer-svg-toggle">
            <button
              type="button"
              className={`file-viewer-toggle-btn ${
                svgMode === "image" ? "active" : ""
              }`}
              onClick={() => setSvgMode("image")}
              title={t("rightPanel.svgImageMode", {
                defaultValue: "View as image",
              })}
            >
              <ImageIcon size={13} />
            </button>
            <button
              type="button"
              className={`file-viewer-toggle-btn ${
                svgMode === "code" ? "active" : ""
              }`}
              onClick={() => setSvgMode("code")}
              title={t("rightPanel.svgCodeMode", {
                defaultValue: "View as code",
              })}
            >
              <Code2 size={13} />
            </button>
          </div>
        )}
        {isMarkdown && !editMode && (
          <div className="file-viewer-svg-toggle">
            <button
              type="button"
              className={`file-viewer-toggle-btn ${
                mdMode === "preview" ? "active" : ""
              }`}
              onClick={() => {
                setSearchOpen(false);
                setMdMode("preview");
              }}
              title={t("rightPanel.mdPreviewMode", {
                defaultValue: "Render preview",
              })}
            >
              <Eye size={13} />
            </button>
            <button
              type="button"
              className={`file-viewer-toggle-btn ${
                mdMode === "code" ? "active" : ""
              }`}
              onClick={() => {
                setSearchOpen(false);
                setMdMode("code");
              }}
              title={t("rightPanel.mdSourceMode", {
                defaultValue: "View source",
              })}
            >
              <Code2 size={13} />
            </button>
          </div>
        )}
        {!content.isBinary && (
          <button
            type="button"
            className={`file-viewer-copy-btn ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            title={t("rightPanel.copy", { defaultValue: "Copy" })}
          >
            <Copy size={13} />
          </button>
        )}
        {canEdit ? (
          editMode ? (
            <>
              <button
                type="button"
                className="file-viewer-action-btn"
                onClick={handleExitEditMode}
                disabled={saving}
                title={t("rightPanel.fileViewerExitEdit", {
                  defaultValue: "Exit edit mode (Esc)",
                })}
              >
                <Eye size={13} />
              </button>
              <button
                type="button"
                className={`file-viewer-save-btn ${dirty ? "dirty" : ""}`}
                onClick={handleSave}
                disabled={!dirty || saving}
                title={t("rightPanel.fileViewerSave", {
                  defaultValue: "Save (Ctrl+S)",
                })}
              >
                {saving ? (
                  <Loader2 className="spin" size={13} />
                ) : (
                  <Save size={13} />
                )}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="file-viewer-action-btn"
              onClick={handleEnterEditMode}
              title={t("rightPanel.fileViewerEdit", {
                defaultValue: "Edit file",
              })}
            >
              <Pencil size={13} />
            </button>
          )
        ) : null}
      </div>
      {saveError ? (
        <div className="file-viewer-save-error">
          <AlertCircle size={14} />
          <span>{saveError}</span>
        </div>
      ) : null}
      {searchOpen && canSearch ? (
        <div
          className="file-viewer-search-bar"
          data-local-shortcuts
          onKeyDown={handleSearchBarKeyDown}
        >
          <div className="file-viewer-search-input-wrap">
            <Search size={13} className="file-viewer-search-input-icon" />
            <input
              ref={searchInputRef}
              className="file-viewer-search-input"
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("rightPanel.fileSearchPlaceholder", {
                defaultValue: "Search in file",
              })}
              spellCheck={false}
              autoFocus
            />
          </div>
          <button
            type="button"
            className={`file-viewer-search-case${
              searchCaseSensitive ? " active" : ""
            }`}
            onClick={() => setSearchCaseSensitive((prev) => !prev)}
            title={t("rightPanel.fileSearchMatchCase", {
              defaultValue: "Match case",
            })}
          >
            <CaseSensitive size={14} />
          </button>
          <span
            className={`file-viewer-search-count${
              searchQuery.length > 0 && searchMatches.length === 0
                ? " no-result"
                : ""
            }`}
          >
            {searchQuery.length > 0
              ? searchMatches.length === 0
                ? t("rightPanel.fileSearchNoResult", {
                    defaultValue: "No results",
                  })
                : `${searchIndex + 1}/${
                    searchMatches.length >= SEARCH_MATCH_LIMIT
                      ? `${SEARCH_MATCH_LIMIT}+`
                      : searchMatches.length
                  }`
              : ""}
          </span>
          <button
            type="button"
            className="file-viewer-action-btn"
            onClick={() => goRelative(-1)}
            disabled={searchMatches.length === 0}
            title={t("rightPanel.fileSearchPrevious", {
              defaultValue: "Previous match (Shift+Enter)",
            })}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className="file-viewer-action-btn"
            onClick={() => goRelative(1)}
            disabled={searchMatches.length === 0}
            title={t("rightPanel.fileSearchNext", {
              defaultValue: "Next match (Enter)",
            })}
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className="file-viewer-action-btn"
            onClick={closeSearch}
            title={t("rightPanel.fileSearchClose", {
              defaultValue: "Close search (Esc)",
            })}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      <div className="file-viewer-body">
        {isImage && !isSvg && (
          <div className="file-viewer-image-container">
            <img
              src={`data:${content.mimeType};base64,${content.content}`}
              alt={fileName}
              className="file-viewer-image"
            />
          </div>
        )}
        {isSvg && svgMode === "image" && (
          <div className="file-viewer-image-container">
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(
                content.content
              )}`}
              alt={fileName}
              className="file-viewer-image"
            />
          </div>
        )}
        {isSvg && svgMode === "code" && renderCodeBlock()}
        {isBinary && (
          <div className="file-viewer-binary">
            <ImageIcon size={32} />
            <span>
              {t("rightPanel.binaryFile", {
                defaultValue: "Binary file",
              })}
            </span>
          </div>
        )}
        {!content.isBinary && !isImage && editMode && renderEditBlock()}
        {!content.isBinary &&
          !isImage &&
          !editMode &&
          isMarkdown &&
          mdMode === "preview" && (
            <MarkdownBlock
              className="file-viewer-markdown ai-message"
              content={content.content}
              onFileLinkClick={handleFileLinkClick}
            />
          )}
        {!content.isBinary &&
          !isImage &&
          !editMode &&
          !(isMarkdown && mdMode === "preview") &&
          renderCodeBlock()}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
