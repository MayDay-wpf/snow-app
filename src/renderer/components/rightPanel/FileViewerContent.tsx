import {
  getCodeLanguageFromPath as getLanguageFromFileName,
  highlightCodeHtml,
} from "../../utils/syntaxHighlight";
import { isImeComposing } from "../../../shared/imeKeyboard";
import {
  AlertCircle,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  CopySlash,
  Download,
  Eye,
  FileInput,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import Editor from "react-simple-code-editor";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useKeyboardShortcutsSettings } from "../KeyboardShortcutsProvider";
import { keyToDisplay } from "../../utils/shortcutUtils";
import {
  openResolvedLocalEntry,
  openResolvedRemoteEntry,
} from "../../utils/fileLinkOpen";
import { useI18n } from "../../i18n";
import { MarkdownBlock } from "../mainContent/chatMessages/components/markdownRenderer";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import type {
  FileSelectionTag,
  FileTag,
} from "../mainContent/chatInput/fileTagUtils";
import { INSERT_FILE_TAGS_EVENT } from "../mainContent/chatInput/fileTagUtils";
import { createCodeHighlighter } from "./fileViewer/codeHighlight";
import {
  computeFoldRegions,
  countTextLines,
  createLineIndex,
  createLineMapping,
  DEFAULT_LINE_HEIGHT,
  estimateMaxColumns,
  type FoldRegion,
} from "./fileViewer/codeText";
import { useVirtualRows } from "./fileViewer/useVirtualRows";
import { rightPanelEvents } from "./rightPanelEvents";
import {
  FileReviewPanel,
  FILE_REVIEW_HIGHLIGHT_COLOR_COUNT,
  type FileReviewHighlight,
} from "./FileReviewPanel";
import {
  captureFileTextSelection,
  FILE_REVIEW_MAX_SELECTION_CHARS,
  type FileReviewDraftAnchor,
  type FileReviewLocation,
} from "./fileViewer/fileReviewAnchors";
import { FilePreviewView } from "./fileViewer/FilePreviewView";
import { formatSize } from "./fileViewer/formatSize";
import {
  PreviewUnavailable,
  type PreviewUnavailableInfo,
} from "./fileViewer/PreviewUnavailable";
import type { FileContentResult, FilePreviewResult } from "./types";

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
  /** 加载完成后自动进入编辑模式（供资源管理器双击快速编辑弹窗使用）。 */
  initialEditMode?: boolean;
  /**
   * 虚拟文件编辑模式：不读写磁盘文件，初始内容与保存均由宿主提供
   * （如用户脚本编辑器复用带行号/语法高亮的编辑体验）。
   */
  virtualSource?: {
    /** 初始内容。 */
    content: string;
    /** 初始即视为已修改（新建场景下允许直接保存）。 */
    initialDirty?: boolean;
    /** 保存回调，Promise resolve 即视为保存成功。 */
    onSave: (content: string) => Promise<void>;
  };
};

/** 文内搜索匹配数上限，避免超大文件单字符查询卡死。 */
const SEARCH_MATCH_LIMIT = 10000;
/** 视口内高亮矩形渲染上限，超出时只渲染搜索导航命中的矩形。 */
const SEARCH_MARK_RENDER_LIMIT = 2000;
/** 编辑模式下可作为初始查询的选区最大长度。 */
const SEARCH_SEED_MAX_LENGTH = 200;
/** 超过该行数视为超大文件：放弃缩进折叠（对齐 VS Code 大文件策略）。 */
const FOLD_MAX_LINES = 200000;
/** 超过该行数时把折叠计算延后到空闲时段，避免拖慢首屏。 */
const FOLD_IDLE_MIN_LINES = 20000;
/** 超过该行数或字符数时，编辑模式降级为原生 textarea（不做语法高亮）。 */
const PLAIN_EDITOR_MIN_LINES = 1500;
const PLAIN_EDITOR_MIN_CHARS = 150000;
/** 降级编辑模式行号列的视口外预渲染行数。 */
const PLAIN_GUTTER_OVERSCAN = 32;
/** 审阅面板上下结构切换阈值：与 fileReview.css 的 @container 断点一致。 */
const REVIEW_STACK_BREAKPOINT = 520;
/** 上下结构下审阅面板高度下限与正文区保留下限（px）。 */
const REVIEW_PANEL_MIN_HEIGHT = 160;
const REVIEW_BODY_MIN_HEIGHT = 160;

type SearchMatch = {
  start: number;
  end: number;
  line: number;
  lineStart: number;
};

type SearchMarkRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  isCurrent: boolean;
};

/**
 * 在单行行元素内按相对行首的偏移 [start, end) 创建 DOM Range，
 * 供 getClientRects() 取得匹配矩形（查看模式高亮层与横向滚动定位使用）。
 */
const makeRowRange = (
  row: HTMLElement,
  start: number,
  end: number,
): Range | null => {
  const range = document.createRange();
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let position = 0;
  let started = false;
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && start <= position + length) {
      range.setStart(node, Math.min(start - position, length));
      started = true;
    }
    if (started && end <= position + length) {
      range.setEnd(node, Math.min(end - position, length));
      return range;
    }
    position += length;
    node = walker.nextNode();
  }
  if (started) {
    range.setEnd(row, row.childNodes.length);
    return range;
  }
  return null;
};

type SearchLineBand = { line: number; current: boolean };

/** 行窗口 [firstLine, lastLine] 内的命中行（去重），用于整行底色。 */
const collectMatchLines = (
  matches: SearchMatch[],
  firstLine: number,
  lastLine: number,
  currentLine: number,
): SearchLineBand[] => {
  let from = matches.length;
  let lo = 0;
  let hi = matches.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].line >= firstLine) {
      from = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const bands: SearchLineBand[] = [];
  let prev = -1;
  for (let i = from; i < matches.length; i += 1) {
    const { line } = matches[i];
    if (line > lastLine) break;
    if (line === prev) continue;
    prev = line;
    bands.push({ line, current: line === currentLine });
  }
  return bands;
};

// Extracted documents and text that cannot round-trip to its original encoding
// are searchable/copyable previews, never editable source files.
const isReadOnlyPreview = (content: FileContentResult): boolean =>
  content.mimeType === "application/x-snow-document-text" ||
  content.mimeType === "application/x-snow-text-preview";

const isEditable = (content: FileContentResult): boolean =>
  !content.isBinary && !content.isImage && !isReadOnlyPreview(content);

/** Rust 预览结果转不可预览面板信息；不存在的文件不显示大小。 */
const toUnavailableInfo = (
  result: FilePreviewResult,
): PreviewUnavailableInfo => ({
  reason: result.reason || "read_failed",
  kind: result.kind,
  size: result.reason === "not_found" ? null : result.size,
  limit: result.limit,
  signature: result.signature,
  detail: result.detail,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const serializeRemoteVersion = (
  version: FileContentResult["remoteVersion"] | undefined,
): string => JSON.stringify(version ?? { exists: false });

/** 解析 markdown 链接路径：支持 `path:line` 与 `path#Lline` 行号定位。 */
const parseHrefPathWithLine = (
  raw: string,
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
  raw: string,
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
  return {
    path: sep === "\\" ? resolved.replace(/\//g, "\\") : resolved,
    line,
  };
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
  initialEditMode = false,
  virtualSource,
}: FileViewerContentProps): React.JSX.Element {
  const { t } = useI18n();
  const { registerScopedHandler } = useKeyboardShortcutsSettings();
  // 编辑器 textarea 的实例级 id：同一时刻可能存在多个 FileViewerContent
  // （右侧面板 tab 与快速编辑弹窗并存），固定 id 会导致焦点/选区互相串扰。
  const editTextareaId = useId();
  const [content, setContent] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  // 不可预览（文件缺失 / 超限 / 格式不符 / 读取失败）：显示本地化面板与可操作出口。
  const [unavailable, setUnavailable] = useState<PreviewUnavailableInfo | null>(
    null,
  );
  // 本地文件的结构化只读预览（表格 / SQLite / 幻灯片大纲 / DOCX）。
  const [preview, setPreview] = useState<FilePreviewResult | null>(null);
  const previewRef = useRef<FilePreviewResult | null>(null);
  previewRef.current = preview;
  // 结构化预览与「抽取文本」视图切换；抽取文本复用 readFileContent 的文档文本，
  // 搜索、复制与审阅标注都在抽取文本上进行。
  const [previewMode, setPreviewMode] = useState<"preview" | "text">("preview");
  const previewModeRef = useRef(previewMode);
  previewModeRef.current = previewMode;
  // 当前请求的工作表 / 数据表（null = 第一个），外部修改重载时保持不变。
  const [previewSection, setPreviewSection] = useState<string | null>(null);
  const previewSectionRef = useRef(previewSection);
  previewSectionRef.current = previewSection;
  const [loadingSection, setLoadingSection] = useState<string | null>(null);
  // DOCX 在渲染层解析失败。
  const [previewFailure, setPreviewFailure] =
    useState<PreviewUnavailableInfo | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [svgMode, setSvgMode] = useState<"image" | "code">("image");
  // Markdown 文件阅读模式：preview = 渲染预览（标题/列表/链接/代码块），
  // code = 源码视图（保留行号与文内搜索）。
  const [mdMode, setMdMode] = useState<"preview" | "code">("preview");
  const [copied, setCopied] = useState(false);
  // SSH 预览刷新（手动重新读取远端文件）进行中。
  const [refreshing, setRefreshing] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const isMarkdown = /\.(md|markdown)$/i.test(fileName);

  /** 获取当前选中的文本（编辑模式读 textarea 选区，否则读浏览器选区）。 */
  const getSelectedText = (): string => {
    if (editMode) {
      const textarea = document.getElementById(editTextareaId);
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
    null,
  );
  // 磁盘内容被外部修改、但编辑器有未保存修改时的待应用内容（提示用户重载）。
  const [externalChange, setExternalChange] =
    useState<FileContentResult | null>(null);

  const originalContentRef = useRef("");
  // 供文件变更订阅（长生命周期）读取最新状态，避免状态变化时反复重订阅。
  const contentRef = useRef<FileContentResult | null>(null);
  contentRef.current = content;
  const editModeRef = useRef(false);
  editModeRef.current = editMode;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const onDirtyChangeRef = useRef(onDirtyChange);
  // 虚拟文件源保存在 ref 中：宿主每次渲染传入的对象引用都会变化，
  // 但加载/保存只应在挂载与用户操作时读取，避免触发重复加载。
  const virtualSourceRef = useRef(virtualSource);
  virtualSourceRef.current = virtualSource;
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
  // 等待可视窗口更新后再做横向定位的命中（跳转目标行尚未渲染时使用）。
  const pendingAlignRef = useRef<SearchMatch | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchMarkRects, setSearchMarkRects] = useState<SearchMarkRect[]>([]);
  // 已收起的折叠块，以块首行号标识。
  const [foldedStarts, setFoldedStarts] = useState<Set<number>>(
    () => new Set(),
  );

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setUnavailable(null);
    setPreview(null);
    setPreviewMode("preview");
    setPreviewSection(null);
    setPreviewFailure(null);
    setTextError(null);
    setEditMode(false);
    setDirty(false);
    setSaveError(null);
    setSavedAt(false);
    setSaveGuarantee(null);
    setDraftStatus(null);
    setEditedContent("");
    setMdMode("preview");
    setFoldedStarts(new Set());
    setExternalChange(null);
    try {
      let result: FileContentResult;
      const virtual = virtualSourceRef.current;
      if (virtual) {
        result = {
          content: virtual.content,
          isBinary: false,
          isImage: false,
          isSvg: false,
          mimeType: "text/plain",
          encoding: "utf-8",
          size: new Blob([virtual.content]).size,
        };
      } else if (isSsh && sshSessionId) {
        result = await window.snow.sshReadFile(sshSessionId, filePath);
      } else {
        // 本地文件先由 Rust 判定：结构化预览 / 不可预览原因 / 继续按文本读取。
        const previewResult = await window.snow.readFilePreview(filePath);
        if (previewResult.status !== "passthrough") {
          setContent(null);
          originalContentRef.current = "";
          if (previewResult.status === "ready") {
            setPreview(previewResult);
          } else {
            setUnavailable(toUnavailableInfo(previewResult));
          }
          return;
        }
        result = await window.snow.readFileContent(filePath);
      }
      setContent(result);
      originalContentRef.current = result.content;
      // 快速编辑弹窗：加载完成后直接进入编辑模式（markdown 同步切到源码视图）。
      if (initialEditMode && isEditable(result)) {
        setEditMode(true);
        setEditedContent(result.content);
        setDirty(Boolean(virtual?.initialDirty));
        setSaveError(null);
        setSavedAt(false);
        setSaveGuarantee(null);
        if (isMarkdown) {
          setMdMode("code");
        }
      }
      if (canPersistRemoteDraft && sshSessionId && sshWorkspaceId) {
        try {
          const drafts = await window.snow.sshListRemoteDrafts(
            sshWorkspaceId,
            sshSessionId,
          );
          const draft = drafts.find((item) => item.remotePath === filePath);
          if (draft) {
            const isCurrentBaseVersion =
              draft.baseVersionJson ===
              serializeRemoteVersion(result.remoteVersion);
            setEditMode(true);
            setEditedContent(draft.content);
            setDirty(draft.content !== result.content);
            setDraftStatus(isCurrentBaseVersion ? draft.status : "conflict");
            if (!isCurrentBaseVersion) {
              setSaveError(
                t("rightPanel.fileViewerSaveConflict", {
                  defaultValue:
                    "The remote file changed. Reload it before saving your changes.",
                }),
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
      setContent(null);
      setUnavailable({
        reason: "read_failed",
        kind: "",
        size: null,
        detail: errorMessage(err),
      });
    } finally {
      setLoading(false);
    }
  }, [
    canPersistRemoteDraft,
    filePath,
    initialEditMode,
    isSsh,
    sshSessionId,
    sshWorkspaceId,
    t,
  ]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  // 结构化预览布局：预览模式，或切到抽取文本但文本尚未就绪（加载中 / 失败）。
  const showPreviewLayout =
    preview != null && (previewMode === "preview" || content == null);

  const showCodeView =
    content != null &&
    !showPreviewLayout &&
    !content.isBinary &&
    !content.isImage &&
    !editMode &&
    !(isMarkdown && mdMode === "preview") &&
    !(content.isSvg && svgMode === "image");

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewSelection, setReviewSelection] =
    useState<FileReviewDraftAnchor | null>(null);
  const [reviewCandidate, setReviewCandidate] =
    useState<FileReviewDraftAnchor | null>(null);
  // 右键那一刻的选区锚点（不限长度）：供「添加到会话」整段带走选中原文。
  const [selectionAnchor, setSelectionAnchor] =
    useState<FileReviewDraftAnchor | null>(null);
  const [reviewHighlights, setReviewHighlights] = useState<
    Record<string, FileReviewHighlight>
  >({});
  const [reviewScroll, setReviewScroll] = useState<{
    location: FileReviewLocation;
    seq: number;
  } | null>(null);
  // 左右模式的审阅面板宽度（px，拖拽分隔条实时更新；null 表示用样式默认值）。
  const [reviewPanelWidth, setReviewPanelWidth] = useState<number | null>(null);
  // 上下模式的审阅面板高度（px，同上；null 表示用样式默认值 42%）。
  const [reviewPanelHeight, setReviewPanelHeight] = useState<number | null>(
    null,
  );
  const [reviewStacked, setReviewStacked] = useState(false);
  const [reviewResizing, setReviewResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const reviewSourceKey = virtualSource
    ? ""
    : isSsh
      ? sshWorkspaceId
        ? `ssh:${sshWorkspaceId}`
        : ""
      : "local";
  const canReview = Boolean(
    reviewSourceKey && content && !content.isBinary && !content.isImage,
  );
  const reviewRepresentation =
    content?.mimeType === "application/x-snow-document-text"
      ? ("extracted-text" as const)
      : ("source" as const);

  useEffect(() => {
    setReviewOpen(false);
    setReviewSelection(null);
    setReviewCandidate(null);
    setSelectionAnchor(null);
    setReviewHighlights({});
    setReviewScroll(null);
  }, [filePath, reviewSourceKey]);
  useEffect(() => {
    setReviewSelection(null);
    setReviewCandidate(null);
    setSelectionAnchor(null);
    setReviewHighlights({});
    setReviewScroll(null);
  }, [content?.content, editMode]);

  // 文本行模型：一次扫描得到行边界，行号、折叠、虚拟窗口与搜索定位共用。
  const lineIndex = useMemo(
    () =>
      content && (showCodeView || editMode)
        ? createLineIndex(content.content)
        : null,
    [content, editMode, showCodeView],
  );
  const reviewIndex = useMemo(
    () =>
      reviewOpen && canReview && content
        ? (lineIndex ?? createLineIndex(content.content))
        : null,
    [reviewOpen, canReview, content, lineIndex],
  );
  const captureSelection = (maxChars: number): FileReviewDraftAnchor | null => {
    const root = codeContentRef.current;
    return canReview && showCodeView && root && lineIndex
      ? captureFileTextSelection(
          root,
          lineIndex,
          reviewRepresentation,
          maxChars,
        )
      : null;
  };
  const captureReview = (): FileReviewDraftAnchor | null =>
    captureSelection(FILE_REVIEW_MAX_SELECTION_CHARS);
  const captureSessionSelection = (): FileReviewDraftAnchor | null =>
    captureSelection(Number.POSITIVE_INFINITY);
  const addReview = (anchor: FileReviewDraftAnchor | null): void => {
    if (!anchor) return;
    setReviewSelection(anchor);
    setReviewOpen(true);
    setContextMenu(null);
  };
  // 右键菜单「添加到会话」：选区连同文件路径与行号编码为一个 file-selection chip
  // （只给行号时 AI 需自行读取整行，与用户实际选中的词不对应）；无选区时退回文件 chip。
  const addFileToSession = (): void => {
    setContextMenu(null);
    if (virtualSource) return;
    const anchor = selectionAnchor;
    const tags: (FileTag | FileSelectionTag)[] = anchor
      ? [
          {
            path: filePath,
            name: fileName,
            startLine: anchor.startLine,
            endLine: anchor.endLine,
            content: anchor.quote,
            representation: anchor.representation,
          },
        ]
      : [{ path: filePath, name: fileName, isDirectory: false }];
    window.dispatchEvent(
      new CustomEvent<(FileTag | FileSelectionTag)[]>(INSERT_FILE_TAGS_EVENT, {
        detail: tags,
      }),
    );
  };
  const toggleReviewHighlight = (
    id: string,
    location: FileReviewLocation,
  ): void => {
    if (reviewHighlights[id]) {
      setReviewHighlights((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setReviewHighlights((prev) => {
      const used = new Set(Object.values(prev).map((item) => item.colorIndex));
      let colorIndex = 0;
      while (
        colorIndex < FILE_REVIEW_HIGHLIGHT_COLOR_COUNT &&
        used.has(colorIndex)
      ) {
        colorIndex += 1;
      }
      if (colorIndex >= FILE_REVIEW_HIGHLIGHT_COLOR_COUNT) {
        colorIndex =
          Object.keys(prev).length % FILE_REVIEW_HIGHLIGHT_COLOR_COUNT;
      }
      return { ...prev, [id]: { location, colorIndex } };
    });
    setReviewScroll((prev) => ({ location, seq: (prev?.seq ?? 0) + 1 }));
  };

  // 组件宽度决定审阅面板是左右还是上下结构（与 fileReview.css 断点一致），
  // 拖拽方向随之切换：窄宽度下改为调整面板高度。
  // 依赖 loading/unavailable/showPreviewLayout：首屏走 loading、不可预览或结构化
  // 预览分支时根节点尚未挂载（rootRef 为空），此时建立 observer 会静默失败，
  // 导致上下结构下拖拽方向判错。
  useEffect(() => {
    if (loading || unavailable || showPreviewLayout) return;
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const apply = (width: number): void => {
      setReviewStacked(width > 0 && width <= REVIEW_STACK_BREAKPOINT);
    };
    apply(root.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      apply(entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [loading, unavailable, showPreviewLayout]);

  /**
   * 拖拽左右模式的分隔条调整审阅面板宽度：宽度取「工作区右缘 - 指针」，
   * 下限保留正文可用宽度（左侧至少 240px）。
   */
  const handleReviewResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const workspace = workspaceRef.current;
      if (!workspace || event.button !== 0) return;
      event.preventDefault();
      const rect = workspace.getBoundingClientRect();
      const minWidth = 220;
      const maxWidth = Math.max(minWidth, rect.width - 240);
      setReviewResizing(true);
      const handleMove = (moveEvent: PointerEvent): void => {
        const next = Math.min(
          maxWidth,
          Math.max(minWidth, rect.right - moveEvent.clientX),
        );
        setReviewPanelWidth(Math.round(next));
      };
      const handleEnd = (): void => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        setReviewResizing(false);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
    },
    [],
  );

  /** 上下模式的分隔条：高度取「工作区下缘 - 指针」，上下各保留下限高度。 */
  const handleReviewResizeStartY = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const workspace = workspaceRef.current;
      if (!workspace || event.button !== 0) return;
      event.preventDefault();
      const rect = workspace.getBoundingClientRect();
      const maxHeight = Math.max(
        REVIEW_PANEL_MIN_HEIGHT,
        rect.height - REVIEW_BODY_MIN_HEIGHT,
      );
      setReviewResizing(true);
      const handleMove = (moveEvent: PointerEvent): void => {
        const next = Math.min(
          maxHeight,
          Math.max(REVIEW_PANEL_MIN_HEIGHT, rect.bottom - moveEvent.clientY),
        );
        setReviewPanelHeight(Math.round(next));
      };
      const handleEnd = (): void => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        setReviewResizing(false);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
    },
    [],
  );

  // 单行行高与顶部内边距：虚拟滚动按行高换算滚动位置，测量一次即可。
  const [codeMetrics, setCodeMetrics] = useState({
    lineHeight: DEFAULT_LINE_HEIGHT,
    paddingTop: 12,
  });

  useLayoutEffect(() => {
    const element = codeScrollRef.current?.querySelector(".file-viewer-code");
    if (!(element instanceof HTMLElement)) return;
    const style = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const paddingTop = Number.parseFloat(style.paddingTop);
    setCodeMetrics((prev) => {
      const next = {
        lineHeight:
          Number.isFinite(lineHeight) && lineHeight > 0
            ? lineHeight
            : prev.lineHeight,
        paddingTop: Number.isFinite(paddingTop) ? paddingTop : prev.paddingTop,
      };
      return next.lineHeight === prev.lineHeight &&
        next.paddingTop === prev.paddingTop
        ? prev
        : next;
    });
  }, [content, editMode, showCodeView]);

  // ===== 代码折叠（缩进折叠） =====
  // 折叠区域按缩进计算；收起时区域内的行不再渲染（虚拟窗口直接跳过），
  // 行号槽与代码列共用同一可视窗口与行高，因此两侧天然对齐。
  const [foldRegions, setFoldRegions] = useState<FoldRegion[]>([]);

  useEffect(() => {
    if (!lineIndex || !showCodeView || lineIndex.total > FOLD_MAX_LINES) {
      setFoldRegions([]);
      return;
    }
    const apply = (): void => {
      setFoldRegions(computeFoldRegions(lineIndex));
    };
    if (lineIndex.total < FOLD_IDLE_MIN_LINES) {
      apply();
      return;
    }
    if (typeof window.requestIdleCallback !== "function") {
      apply();
      return;
    }
    let cancelled = false;
    const handle = window.requestIdleCallback(
      () => {
        if (!cancelled) apply();
      },
      { timeout: 800 },
    );
    return () => {
      cancelled = true;
      window.cancelIdleCallback(handle);
    };
  }, [lineIndex, showCodeView]);

  const foldByStart = useMemo(() => {
    const map = new Map<number, FoldRegion>();
    for (const region of foldRegions) {
      map.set(region.start, region);
    }
    return map;
  }, [foldRegions]);

  const collapsedRegions = useMemo(
    () => foldRegions.filter((region) => foldedStarts.has(region.start)),
    [foldRegions, foldedStarts],
  );

  const lineMapping = useMemo(
    () => createLineMapping(lineIndex?.total ?? 1, collapsedRegions),
    [lineIndex, collapsedRegions],
  );

  const { range: rowRange, syncRange } = useVirtualRows(
    codeScrollRef,
    lineMapping.total,
    codeMetrics.lineHeight,
  );

  const codeHighlighter = useMemo(
    () =>
      lineIndex && showCodeView
        ? createCodeHighlighter(lineIndex, getLanguageFromFileName(fileName))
        : null,
    [fileName, lineIndex, showCodeView],
  );

  const contentColumns = useMemo(
    () => (lineIndex && showCodeView ? estimateMaxColumns(lineIndex) : 0),
    [lineIndex, showCodeView],
  );

  // 折叠切换锚点：收起/展开后把块首行钉回原视口位置，避免滚动位置跳动。
  const foldAnchorRef = useRef<{ line: number; offset: number } | null>(null);

  const toggleFold = useCallback(
    (line: number) => {
      const scrollEl = codeScrollRef.current;
      if (scrollEl) {
        foldAnchorRef.current = {
          line,
          offset:
            codeMetrics.paddingTop +
            (lineMapping.toVisual(line) - 1) * codeMetrics.lineHeight -
            scrollEl.scrollTop,
        };
      }
      setFoldedStarts((prev) => {
        const next = new Set(prev);
        if (next.has(line)) {
          next.delete(line);
        } else {
          next.add(line);
        }
        return next;
      });
    },
    [codeMetrics.lineHeight, codeMetrics.paddingTop, lineMapping],
  );

  useLayoutEffect(() => {
    const anchor = foldAnchorRef.current;
    if (!anchor) return;
    foldAnchorRef.current = null;
    const scrollEl = codeScrollRef.current;
    if (!scrollEl) return;
    scrollEl.scrollTop = Math.max(
      0,
      codeMetrics.paddingTop +
        (lineMapping.toVisual(anchor.line) - 1) * codeMetrics.lineHeight -
        anchor.offset,
    );
    syncRange();
  }, [codeMetrics, lineMapping, syncRange]);

  /** 展开包含目标行的折叠块；返回是否需要等待重渲染后再定位。 */
  const revealLine = useCallback(
    (line: number): boolean => {
      const targets = collapsedRegions.filter(
        (region) => line > region.start && line <= region.end,
      );
      if (targets.length === 0) {
        return false;
      }
      setFoldedStarts((prev) => {
        const next = new Set(prev);
        for (const region of targets) {
          next.delete(region.start);
        }
        return next;
      });
      return true;
    },
    [collapsedRegions],
  );

  useEffect(() => {
    if (!reviewScroll || !showCodeView || !lineIndex || editMode) return;
    if (revealLine(reviewScroll.location.startLine)) return;
    const scroll = codeScrollRef.current;
    if (!scroll) return;
    const top =
      codeMetrics.paddingTop +
      (lineMapping.toVisual(reviewScroll.location.startLine) - 1) *
        codeMetrics.lineHeight;
    scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 3);
    syncRange();
  }, [
    reviewScroll,
    showCodeView,
    lineIndex,
    editMode,
    revealLine,
    lineMapping,
    codeMetrics,
    syncRange,
  ]);

  // focusLine 变化时滚动到目标行并高亮。仅在非编辑、非二进制/图片、
  // 内容已加载且行号有效时生效。每次 focusLine 变化都会重新触发，
  // 即使是同一文件的不同行点击。
  useEffect(() => {
    if (focusLine == null || focusLine < 1 || loading) {
      return;
    }
    if (!lineIndex || !showCodeView) {
      return;
    }

    const scrollEl = codeScrollRef.current;
    if (!scrollEl) {
      return;
    }

    const targetLine = Math.min(focusLine, lineIndex.total);
    // 目标行被折叠隐藏时先展开，重渲染后本效果会再次触发完成定位。
    if (revealLine(targetLine)) {
      return;
    }

    // 滚动使目标行尽量落在视口上部约 1/3 处。
    const targetTop =
      codeMetrics.paddingTop +
      (lineMapping.toVisual(targetLine) - 1) * codeMetrics.lineHeight;
    scrollEl.scrollTop = Math.max(0, targetTop - scrollEl.clientHeight / 3);
    syncRange();

    setHighlightLine(targetLine);
    const timer = window.setTimeout(() => {
      setHighlightLine(null);
    }, 2400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    codeMetrics,
    focusLine,
    lineIndex,
    lineMapping,
    loading,
    revealLine,
    showCodeView,
    syncRange,
  ]);

  const highlightCode = useCallback(
    (code: string): string =>
      highlightCodeHtml(code, getLanguageFromFileName(fileName)),
    [fileName],
  );

  const rowHeight = codeMetrics.lineHeight;
  const renderEnd = Math.min(rowRange.end, lineMapping.total);
  const spacerTop = rowRange.start * rowHeight;
  const spacerBottom = Math.max(0, (lineMapping.total - renderEnd) * rowHeight);
  const gutterWidth = `calc(${String(lineIndex?.total ?? 1).length}ch + 26px)`;
  const contentMinWidth =
    contentColumns > 0 ? `calc(${contentColumns}ch + 24px)` : undefined;

  // 查看模式代码行：只渲染可视窗口内的行（虚拟滚动），高亮 HTML 由分块缓存
  // 按需生成（未命中的行退回纯文本转义），折叠隐藏的行直接不参与渲染。
  const codeRows = useMemo(() => {
    const rows: React.JSX.Element[] = [];
    if (!lineIndex || !codeHighlighter) return rows;
    const highlights = Object.values(reviewHighlights).reverse();
    for (let visual = rowRange.start + 1; visual <= renderEnd; visual += 1) {
      const line = lineMapping.toSource(visual);
      const region = foldByStart.get(line);
      const folded = region != null && foldedStarts.has(line);
      const highlight = highlights.find(
        (item) =>
          line >= item.location.startLine && line <= item.location.endLine,
      );
      rows.push(
        <span
          key={line}
          data-line={line}
          className={`file-viewer-code-line${
            folded ? " file-viewer-code-line--folded" : ""
          }${
            highlight
              ? ` file-viewer-code-line--review-target file-review-hl-${highlight.colorIndex}`
              : ""
          }`}
          data-fold-label={
            folded && region
              ? t("rightPanel.fileFoldHiddenLines", {
                  defaultValue: "⋯ {{count}} lines",
                  values: { count: region.end - region.start },
                })
              : undefined
          }
          dangerouslySetInnerHTML={{ __html: codeHighlighter.lineHtml(line) }}
        />,
      );
    }
    return rows;
  }, [
    codeHighlighter,
    foldByStart,
    foldedStarts,
    lineIndex,
    lineMapping,
    renderEnd,
    rowRange.start,
    reviewHighlights,
    t,
  ]);

  // 查看模式行号槽：与代码列共用同一可视窗口与行高，折叠箭头固定在左侧列。
  const gutterRows = useMemo(() => {
    const rows: React.JSX.Element[] = [];
    for (let visual = rowRange.start + 1; visual <= renderEnd; visual += 1) {
      const line = lineMapping.toSource(visual);
      const region = foldByStart.get(line);
      const folded = region != null && foldedStarts.has(line);
      rows.push(
        <span key={line} data-line={line} className="file-viewer-gutter-line">
          {region ? (
            <button
              type="button"
              className={`file-viewer-fold-toggle${folded ? "" : " expanded"}`}
              tabIndex={-1}
              onClick={() => toggleFold(line)}
              title={
                folded
                  ? t("rightPanel.fileFoldExpand", {
                      defaultValue: "Expand block",
                    })
                  : t("rightPanel.fileFoldCollapse", {
                      defaultValue: "Collapse block",
                    })
              }
            >
              <ChevronRight size={12} strokeWidth={2.2} />
            </button>
          ) : null}
          <span className="file-viewer-gutter-num">{line}</span>
        </span>,
      );
    }
    return rows;
  }, [
    foldByStart,
    foldedStarts,
    lineMapping,
    renderEnd,
    rowRange.start,
    t,
    toggleFold,
  ]);

  // 空闲时预取窗口外的分块高亮，减少滚动到新区域时的同步计算。
  useEffect(() => {
    if (!codeHighlighter || !showCodeView) return;
    codeHighlighter.prefetch(rowRange.end + 1);
    codeHighlighter.prefetch(rowRange.start);
  }, [codeHighlighter, rowRange.end, rowRange.start, showCodeView]);

  // 大文件编辑：编辑器每次输入都会整篇重新高亮并重建整列行号，
  // 超过阈值时改用原生 textarea 负责输入，行号列与高亮层只渲染可视窗口。
  const plainEditor = Boolean(
    editMode &&
    lineIndex &&
    (lineIndex.total > PLAIN_EDITOR_MIN_LINES ||
      lineIndex.text.length > PLAIN_EDITOR_MIN_CHARS),
  );

  const plainTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const plainGutterRef = useRef<HTMLSpanElement | null>(null);
  const plainHighlightRef = useRef<HTMLPreElement | null>(null);
  const plainMirrorRef = useRef<HTMLDivElement | null>(null);
  const plainBandsRef = useRef<HTMLDivElement | null>(null);
  const editScrollRef = useRef<HTMLDivElement | null>(null);
  const [plainRange, setPlainRange] = useState({ start: 0, end: 0 });

  // 编辑缓冲区自身一份行索引：行号列与高亮层都以编辑中的内容为准。
  const plainIndex = useMemo(
    () => (plainEditor ? createLineIndex(editedContent) : null),
    [editedContent, plainEditor],
  );

  const plainLineCount = plainIndex?.total ?? 0;

  const plainHighlighter = useMemo(
    () =>
      plainIndex
        ? createCodeHighlighter(plainIndex, getLanguageFromFileName(fileName))
        : null,
    [fileName, plainIndex],
  );

  // 行号列与高亮层跟随 textarea 滚动：位移逐帧同步，行窗口变化才触发重渲染。
  const syncPlainView = useCallback(() => {
    const textarea = plainTextareaRef.current;
    if (!textarea) return;
    const height = codeMetrics.lineHeight;
    const scrollTop = textarea.scrollTop;
    const visible = Math.max(1, Math.ceil(textarea.clientHeight / height));
    const start = Math.max(
      0,
      Math.floor(scrollTop / height) - PLAIN_GUTTER_OVERSCAN,
    );
    const end = Math.min(
      plainLineCount,
      start + visible + PLAIN_GUTTER_OVERSCAN * 2,
    );
    const offsetY = start * height - scrollTop;
    const gutter = plainGutterRef.current;
    if (gutter) {
      gutter.style.transform = `translateY(${offsetY}px)`;
    }
    const shift = `translate(${-textarea.scrollLeft}px, ${offsetY}px)`;
    const highlight = plainHighlightRef.current;
    if (highlight) {
      highlight.style.transform = shift;
    }
    const mirror = plainMirrorRef.current;
    if (mirror) {
      mirror.style.transform = shift;
    }
    const bands = plainBandsRef.current;
    if (bands) {
      bands.style.transform = `translateY(${offsetY}px)`;
    }
    setPlainRange((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, [codeMetrics.lineHeight, plainLineCount]);

  useLayoutEffect(() => {
    if (!plainEditor) return;
    syncPlainView();
  }, [plainEditor, syncPlainView]);

  const plainLineNumbers = useMemo(() => {
    if (plainRange.end <= plainRange.start) return "";
    const parts: string[] = [];
    for (let line = plainRange.start + 1; line <= plainRange.end; line += 1) {
      parts.push(String(line));
    }
    return parts.join("\n");
  }, [plainRange.end, plainRange.start]);

  const plainHighlightRows = useMemo(() => {
    const rows: React.JSX.Element[] = [];
    if (!plainIndex || !plainHighlighter?.enabled) return rows;
    for (let line = plainRange.start + 1; line <= plainRange.end; line += 1) {
      rows.push(
        <span
          key={line}
          className="file-viewer-code-line"
          dangerouslySetInnerHTML={{ __html: plainHighlighter.lineHtml(line) }}
        />,
      );
    }
    return rows;
  }, [plainHighlighter, plainIndex, plainRange.end, plainRange.start]);

  useEffect(() => {
    if (!plainHighlighter?.enabled) return;
    plainHighlighter.prefetch(plainRange.end + 1);
  }, [plainHighlighter, plainRange.end]);

  const editLineCount = useMemo(
    () => (editMode && !plainEditor ? countTextLines(editedContent) : 0),
    [editMode, plainEditor, editedContent],
  );

  const editLineNumbers = useMemo(
    () => Array.from({ length: editLineCount }, (_, i) => i + 1).join("\n"),
    [editLineCount],
  );

  const handleCopy = useCallback(() => {
    if (!content) return;
    navigator.clipboard.writeText(content.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  /** 下载远端文件到本地：主进程弹出原生保存对话框并创建下载任务。 */
  const handleDownloadRemote = useCallback(() => {
    if (!isSsh || !sshWorkspaceId) return;
    // 用户取消保存或下载失败都不打断阅读器，静默忽略；也不触发草稿保存。
    void window.snow
      .sshTransferDownload({
        workspaceId: sshWorkspaceId,
        remotePaths: [filePath],
      })
      .catch(() => {});
  }, [filePath, isSsh, sshWorkspaceId]);

  // 虚拟滚动下行元素只覆盖可视窗口：选中全部已渲染行（如全选）复制时
  // 补齐为完整文件内容，避免复制结果被窗口截断。
  const handleCodeCopy = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!content) return;
      const contentEl = codeContentRef.current;
      const selection = window.getSelection();
      if (!contentEl || !selection || selection.rangeCount === 0) return;
      if (lineMapping.total <= renderEnd - rowRange.start) return;
      const firstRow = contentEl.firstElementChild;
      const lastRow = contentEl.lastElementChild;
      if (!firstRow || !lastRow) return;
      if (!selection.containsNode(firstRow, true)) return;
      if (!selection.containsNode(lastRow, true)) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", content.content);
    },
    [content, lineMapping, renderEnd, rowRange.start],
  );

  /**
   * 应用外部修改：原地替换内容，不重建滚动容器，滚动位置与折叠状态保留。
   * 编辑模式下同步刷新编辑器内容并尽量恢复 textarea 滚动位置。
   */
  const applyExternalContent = useCallback(
    (next: FileContentResult) => {
      const textarea = editModeRef.current
        ? document.getElementById(editTextareaId)
        : null;
      const textareaScrollTop =
        textarea instanceof HTMLTextAreaElement ? textarea.scrollTop : null;
      setContent(next);
      originalContentRef.current = next.content;
      setExternalChange(null);
      if (editModeRef.current) {
        setEditedContent(next.content);
        setDirty(false);
        setSaveError(null);
        setSavedAt(false);
        setSaveGuarantee(null);
        setDraftStatus(null);
        if (textareaScrollTop != null) {
          requestAnimationFrame(() => {
            const element = document.getElementById(editTextareaId);
            if (element instanceof HTMLTextAreaElement) {
              element.scrollTop = textareaScrollTop;
            }
          });
        }
      }
    },
    [editTextareaId],
  );

  /** 切换工作表 / 数据表：Rust 按需读取该分区，列表与结构随结果一并刷新。 */
  const handleSelectSection = useCallback(
    (name: string): void => {
      setLoadingSection(name);
      void window.snow
        .readFilePreview(filePath, name)
        .then((next) => {
          if (next.status === "ready") {
            setPreview(next);
            setPreviewSection(name);
          } else {
            setPreview(null);
            setUnavailable(toUnavailableInfo(next));
          }
        })
        .catch((err: unknown) => {
          setPreview(null);
          setUnavailable({
            reason: "read_failed",
            kind: "",
            size: null,
            detail: errorMessage(err),
          });
        })
        .finally(() => setLoadingSection(null));
    },
    [filePath],
  );

  /** DOCX 渲染失败：保留头部（可切到抽取文本），正文显示不可预览面板。 */
  const handlePreviewFailure = useCallback(
    (info: Omit<PreviewUnavailableInfo, "size">): void => {
      setPreviewFailure({ ...info, size: previewRef.current?.size ?? null });
    },
    [],
  );

  /** 切到抽取文本：首次切换时读取文档文本，之后复用缓存。 */
  const handleShowExtractedText = useCallback((): void => {
    setSearchOpen(false);
    setPreviewMode("text");
    if (contentRef.current) return;
    setTextLoading(true);
    setTextError(null);
    void window.snow
      .readFileContent(filePath)
      .then((result) => {
        setContent(result);
        originalContentRef.current = result.content;
      })
      .catch((err: unknown) => setTextError(errorMessage(err)))
      .finally(() => setTextLoading(false));
  }, [filePath]);

  const handleShowStructuredPreview = useCallback((): void => {
    setSearchOpen(false);
    setPreviewMode("preview");
  }, []);

  /**
   * SSH 手动刷新：重新读取远端文件并原地应用（仅预览模式使用）。
   * 内容未变则无操作；会话断开或文件暂不可读时保留当前内容，可稍后重试。
   */
  const handleRefreshRemote = useCallback(async (): Promise<void> => {
    if (!isSsh || !sshSessionId || refreshing) {
      return;
    }
    setRefreshing(true);
    try {
      const next = await window.snow.sshReadFile(sshSessionId, filePath);
      const current = contentRef.current;
      if (!current) {
        return;
      }
      if (next.content === current.content) {
        // 内容未变：仍同步远端版本（mtime 可能已变化），
        // 避免之后保存时因版本过期误报冲突。
        if (
          serializeRemoteVersion(next.remoteVersion) !==
          serializeRemoteVersion(current.remoteVersion)
        ) {
          setContent(next);
        }
        return;
      }
      if (editModeRef.current && dirtyRef.current) {
        // 有未保存修改时不覆盖，交由用户选择是否重载（防御性分支）。
        setExternalChange(next);
        return;
      }
      applyExternalContent(next);
    } catch {
      // 会话断开或远端文件暂不可读：保留当前内容，可稍后重试。
    } finally {
      setRefreshing(false);
    }
  }, [applyExternalContent, filePath, isSsh, refreshing, sshSessionId]);

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
        }),
      );
      if (!confirmed) {
        return;
      }
    }
    if (canPersistRemoteDraft && sshSessionId && sshWorkspaceId) {
      void window.snow
        .sshDeleteRemoteDraft(sshSessionId, sshWorkspaceId, filePath)
        .catch(() => {
          // Keep an undeleted draft recoverable if SQLite is unavailable.
        });
    }
    if (draftSnapshotRef.current) {
      draftSnapshotRef.current.dirty = false;
    }
    // 本地修改已放弃：若磁盘上有等待中的外部修改，直接应用。
    if (externalChange) {
      applyExternalContent(externalChange);
    }
    setEditMode(false);
    setDirty(false);
    setSaveError(null);
    setSavedAt(false);
    setEditedContent("");
  }, [
    applyExternalContent,
    canPersistRemoteDraft,
    dirty,
    externalChange,
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
    ],
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
    if (!dirty || saving || !content || !isEditable(content)) return;
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
      const virtual = virtualSourceRef.current;
      if (virtual) {
        await virtual.onSave(editedContent);
      } else if (isSsh) {
        if (!sshSessionId || !sshWorkspaceId || !content?.remoteVersion) {
          throw new Error(
            "Remote file save is missing its verified workspace or version",
          );
        }
        remoteSave = await window.snow.sshWriteFile(
          sshSessionId,
          filePath,
          editedContent,
          {
            workspaceId: sshWorkspaceId,
            expectedVersion: content.remoteVersion,
          },
        );
      } else {
        await window.snow.writeFileContent(filePath, editedContent);
      }
      originalContentRef.current = editedContent;
      if (draftSnapshotRef.current) {
        draftSnapshotRef.current.dirty = false;
      }
      setExternalChange(null);
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
            filePath,
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
              }),
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
      if (sawSshDisconnectRef.current && dirty && draftStatus === "pending") {
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

  // ===== 外部修改自动刷新 =====
  // 本地文件由 Rust 端 notify 监听（非轮询，写临时文件 + 改名的原子保存也能捕获），
  // 变更后只替换内容、不重建滚动容器，因此滚动位置与折叠状态保持不变。
  useEffect(() => {
    if (isSsh || virtualSourceRef.current) {
      return;
    }
    let disposed = false;
    let reading = false;
    let pending = false;

    // 读取磁盘内容并原地应用；读取期间再次收到事件则排队重读一次。
    const reloadContent = async (): Promise<void> => {
      const next = await window.snow.readFileContent(filePath);
      if (disposed) {
        return;
      }
      const current = contentRef.current;
      // 内容未变（自身保存或无关事件）时不重渲染。
      if (!current || next.content === current.content) {
        return;
      }
      if (editModeRef.current && dirtyRef.current) {
        // 有未保存修改：不覆盖，提示用户重新加载。
        setExternalChange(next);
        return;
      }
      applyExternalContent(next);
    };

    // 结构化预览：保持当前工作表 / 数据表重新生成；已缓存的抽取文本在
    // 文本视图下原地刷新，预览视图下作废，下次切换时重新抽取。
    const reloadPreview = async (): Promise<void> => {
      const next = await window.snow.readFilePreview(
        filePath,
        previewSectionRef.current,
      );
      if (disposed || next.status !== "ready") {
        return;
      }
      setPreview(next);
      setPreviewFailure(null);
      if (!contentRef.current) {
        return;
      }
      if (previewModeRef.current === "text") {
        await reloadContent();
      } else {
        setContent(null);
      }
    };

    const reload = (): void => {
      if (disposed) {
        return;
      }
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      const task = previewRef.current ? reloadPreview() : reloadContent();
      void task
        .catch(() => {
          // 文件被删除或暂时不可读：保留当前内容。
        })
        .finally(() => {
          reading = false;
          if (pending) {
            pending = false;
            reload();
          }
        });
    };

    void window.snow.watchFile(filePath).catch(() => {
      // 监听不可用（如目录权限不足）时保留手动刷新。
    });
    const unsubscribe = window.snow.onFileChanged((changedPath) => {
      if (disposed || changedPath !== filePath) {
        return;
      }
      reload();
    });
    return () => {
      disposed = true;
      unsubscribe();
      void window.snow.unwatchFile(filePath).catch(() => {
        // 取消订阅失败不影响后续清理。
      });
    };
  }, [applyExternalContent, filePath, isSsh]);

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
      // 先确认路径存在：目录在资源管理器中定位，本地 Office / PDF 等文档
      // 交给系统默认应用，其余在文件阅读器中打开。
      const focusLine = resolved.line;
      if (!isSsh) {
        void window.snow
          .resolveFileLink(null, resolved.path)
          .then((entry) => {
            if (entry) {
              openResolvedLocalEntry(entry, focusLine);
            }
          })
          .catch((error: unknown) => {
            console.error("Failed to resolve markdown file link", error);
          });
        return;
      }
      if (sshWorkspaceRoot) {
        void window.snow
          .sshResolveFileLink(sshWorkspaceRoot, resolved.path)
          .then((entry) => {
            if (entry) {
              openResolvedRemoteEntry(
                entry,
                {
                  workspacePath: sshWorkspaceRoot,
                  directoryId: sshWorkspaceId,
                  sshSessionId,
                },
                focusLine,
              );
            }
          })
          .catch((error: unknown) => {
            console.error("Failed to resolve remote markdown file link", error);
          });
        return;
      }
      rightPanelEvents.emit("open-file", {
        filePath: resolved.path,
        isSsh,
        sshSessionId,
        sshWorkspaceId,
        focusLine,
      });
    },
    [filePath, isSsh, sshSessionId, sshWorkspaceRoot, sshWorkspaceId],
  );

  // Keyboard shortcuts handled inside the editor's onKeyDown (which runs before
  // the library's own key handling): Ctrl/Cmd+S saves, Esc exits edit mode.
  // Undo/redo (Ctrl/Cmd+Z, Ctrl+Y) is handled natively by the editor library.
  // IME 组合输入（如中文候选词）期间放行给输入法：确认候选的 Enter/取消
  // 候选的 Esc 不得触发保存/退出编辑，否则候选词无法上屏。
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (isImeComposing(e)) {
        return;
      }
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
    [dirty, saving, handleSave, handleExitEditMode],
  );

  // 大文件编辑的输入增强：原生 textarea 默认 Tab 会跳出输入框、
  // 回车不带缩进，这里补上 Tab/Shift+Tab 缩进与回车保持缩进。
  const handlePlainKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isImeComposing(event)) {
        const textarea = event.currentTarget;
        const value = textarea.value;
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? start;
        const lineStart =
          start > 0 ? value.lastIndexOf("\n", start - 1) + 1 : 0;
        if (event.key === "Tab") {
          event.preventDefault();
          if (event.shiftKey) {
            const lead = /^[ \t]{1,2}/.exec(value.slice(lineStart))?.[0] ?? "";
            if (lead.length > 0) {
              textarea.setRangeText(
                "",
                lineStart,
                lineStart + lead.length,
                "preserve",
              );
              handleValueChange(textarea.value);
            }
          } else {
            textarea.setRangeText("  ", start, end, "end");
            handleValueChange(textarea.value);
          }
          return;
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          const indent =
            /^[ \t]*/.exec(value.slice(lineStart, start))?.[0] ?? "";
          if (indent.length > 0) {
            event.preventDefault();
            textarea.setRangeText(`\n${indent}`, start, end, "end");
            handleValueChange(textarea.value);
            return;
          }
        }
      }
      handleEditorKeyDown(event);
    },
    [handleEditorKeyDown, handleValueChange],
  );

  // Focus the editor when entering edit mode. No scroll syncing is needed for
  // the gutter: it lives inside `.file-viewer-edit-scroll` alongside the code,
  // so both scroll together as one piece of content.
  useEffect(() => {
    if (!editMode) return;
    const textarea = document.getElementById(editTextareaId);
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus();
    }
  }, [editMode]);

  // ===== 文内搜索逻辑 =====

  const canSearch =
    content != null &&
    !showPreviewLayout &&
    !content.isBinary &&
    !content.isImage &&
    // markdown 渲染预览没有可定位的文本节点，搜索仅源码视图可用。
    !(isMarkdown && mdMode === "preview");

  // 搜索目标：编辑模式搜 editedContent，查看模式搜已加载内容。
  const searchTarget = useMemo(() => {
    if (!canSearch || content == null) return "";
    return editMode ? editedContent : content.content;
  }, [canSearch, content, editMode, editedContent]);

  // 不区分大小写的折叠文本按内容缓存：超大文件下每次输入都折叠会明显卡顿，
  // 仅在搜索打开且存在非空查询词时才按需生成，避免打开搜索框瞬间克隆大字符串。
  const searchHaystack = useMemo(() => {
    if (!searchOpen || searchQuery.length === 0) return "";
    return searchCaseSensitive ? searchTarget : searchTarget.toLowerCase();
  }, [searchCaseSensitive, searchOpen, searchQuery.length, searchTarget]);

  const searchMatches = useMemo<SearchMatch[]>(() => {
    if (!searchOpen || searchQuery.length === 0 || searchTarget.length === 0) {
      return [];
    }
    const needle = searchCaseSensitive
      ? searchQuery
      : searchQuery.toLowerCase();
    const matches: SearchMatch[] = [];
    let from = 0;

    const activeIndex = editMode ? (plainIndex ?? lineIndex) : lineIndex;
    if (activeIndex && activeIndex.total > 0) {
      const { starts, total } = activeIndex;
      while (matches.length < SEARCH_MATCH_LIMIT) {
        const found = searchHaystack.indexOf(needle, from);
        if (found === -1) break;
        // 在 starts 上二分查找所在行号及行首位置：O(log N) 代替 O(N) 线性扫描
        let lo = 1;
        let hi = total;
        let line = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (starts[mid - 1] <= found) {
            line = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        const lineStart = starts[line - 1];
        matches.push({
          start: found,
          end: found + needle.length,
          line,
          lineStart,
        });
        from = found + needle.length;
      }
      return matches;
    }

    let lineStart = 0;
    let line = 1;
    let newline = searchTarget.indexOf("\n", lineStart);
    while (matches.length < SEARCH_MATCH_LIMIT) {
      const found = searchHaystack.indexOf(needle, from);
      if (found === -1) break;
      while (newline !== -1 && newline < found) {
        line += 1;
        lineStart = newline + 1;
        newline = searchTarget.indexOf("\n", lineStart);
      }
      matches.push({
        start: found,
        end: found + needle.length,
        line,
        lineStart,
      });
      from = found + needle.length;
    }
    return matches;
  }, [
    editMode,
    lineIndex,
    plainIndex,
    searchCaseSensitive,
    searchHaystack,
    searchOpen,
    searchQuery,
    searchTarget,
  ]);

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
      const textarea = document.getElementById(editTextareaId);
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
      shouldInterceptOpenSearch,
    );
  }, [registerScopedHandler, openLocalSearch, shouldInterceptOpenSearch]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchMarkRects([]);
    if (editMode) {
      requestAnimationFrame(() => {
        const textarea = document.getElementById(editTextareaId);
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
    [searchMatches.length],
  );

  // 搜索栏按键：容器带 data-local-shortcuts，全局快捷键引擎不介入。
  // IME 组合输入（如中文候选词）期间的 Enter/Esc 属于输入法操作，必须
  // 放行给 IME，否则候选词无法上屏（表现为无法输入中文搜索）。
  const handleSearchBarKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isImeComposing(event)) {
        return;
      }
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
    [closeSearch, goRelative],
  );

  // 匹配矩形只在可视窗口内测量：行元素按 data-line 定位，字符偏移相对行首。
  const alignMatchRow = useCallback((match: SearchMatch): boolean => {
    const scrollEl = codeScrollRef.current;
    const contentEl = codeContentRef.current;
    if (!scrollEl || !contentEl) return false;
    const row = contentEl.querySelector<HTMLElement>(
      `[data-line="${match.line}"]`,
    );
    if (!row) return false;
    const range = makeRowRange(
      row,
      match.start - match.lineStart,
      match.end - match.lineStart,
    );
    const rects = range?.getClientRects();
    if (!rects || rects.length === 0) {
      return false;
    }
    const first = rects[0];
    const scrollBox = scrollEl.getBoundingClientRect();
    // 内容可视左缘：sticky 行号钉在滚动区左缘，会遮挡其下滚过的内容。
    const gutterEl = contentEl.parentElement?.querySelector(
      ".file-viewer-line-numbers",
    );
    const contentLeft = contentEl.getBoundingClientRect().left;
    const visibleLeft =
      gutterEl instanceof HTMLElement
        ? Math.max(contentLeft, gutterEl.getBoundingClientRect().right)
        : contentLeft;
    const margin = 24;
    if (first.left < visibleLeft + margin) {
      // 匹配贴近/越过可视左缘（含被行号遮挡）：向左滚动使其距左缘 margin。
      scrollEl.scrollLeft = Math.max(
        0,
        scrollEl.scrollLeft + first.left - visibleLeft - margin,
      );
    } else if (first.right > scrollBox.right - margin) {
      // 匹配超出可视右缘：向右滚动使其距右缘 margin（上限由浏览器夹紧）。
      scrollEl.scrollLeft =
        scrollEl.scrollLeft + first.right - (scrollBox.right - margin);
    }
    return true;
  }, []);

  // 跳转后目标行可能尚未进入可视窗口：等窗口更新后补一次横向定位。
  useLayoutEffect(() => {
    const pending = pendingAlignRef.current;
    if (!pending) return;
    pendingAlignRef.current = null;
    alignMatchRow(pending);
  }, [alignMatchRow, rowRange.end, rowRange.start]);

  // 当前匹配滚动入视。编辑模式仅在显式导航时重设选区（避免覆盖用户
  // 正在编辑的光标）；查看模式始终滚动（外层滚动容器双轴定位）。
  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const match =
      searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    if (!match) return;
    // 命中落在折叠区域内：先展开，重渲染后再定位。
    if (!editMode && revealLine(match.line)) {
      return;
    }
    const navigated =
      searchNavTickRef.current !== lastHandledNavTickRef.current;
    if (navigated) {
      lastHandledNavTickRef.current = searchNavTickRef.current;
    }

    if (editMode) {
      if (!navigated) return;
      const textarea = document.getElementById(editTextareaId);
      if (!(textarea instanceof HTMLTextAreaElement)) return;
      textarea.setSelectionRange(match.start, match.end);
      const lineHeight = parseFloat(
        window.getComputedStyle(textarea).lineHeight,
      );
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      if (plainEditor) {
        textarea.scrollTop = Math.max(
          0,
          (match.line - 1) * lineHeight - textarea.clientHeight / 3,
        );
        return;
      }
      // 编辑器 textarea 自身不滚动（overflow: hidden），滚动由外层容器承担。
      const editScroller = editScrollRef.current;
      if (!editScroller) return;
      editScroller.scrollTop = Math.max(
        0,
        codeMetrics.paddingTop +
          (match.line - 1) * lineHeight -
          editScroller.clientHeight / 3,
      );
      return;
    }

    const scrollEl = codeScrollRef.current;
    if (!scrollEl) {
      return;
    }
    const applyScroll = (): void => {
      const targetTop =
        codeMetrics.paddingTop +
        (lineMapping.toVisual(match.line) - 1) * codeMetrics.lineHeight;
      scrollEl.scrollTop = Math.max(0, targetTop - scrollEl.clientHeight / 3);
    };
    applyScroll();
    syncRange();
    if (!alignMatchRow(match)) {
      pendingAlignRef.current = match;
    }
    // 虚拟窗口更新后补一次定位，避免 padding 变化/钳制吃掉目标位置。
    const frame = requestAnimationFrame(() => {
      if (codeScrollRef.current === scrollEl) {
        applyScroll();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    alignMatchRow,
    codeMetrics,
    editMode,
    editTextareaId,
    lineMapping,
    plainEditor,
    revealLine,
    searchIndex,
    searchMatches,
    searchOpen,
    syncRange,
  ]);

  // 查看模式匹配高亮层：只测量可视窗口内的行（虚拟滚动下每帧至多几十行），
  // 行元素按 data-line 取用，矩形换算为相对 .file-viewer-code 的坐标；
  // 改用 requestAnimationFrame 调度，消除同步 useLayoutEffect 触发的强制同步回流与级联重渲染。
  useEffect(() => {
    if (editMode || !searchOpen || searchMatches.length === 0) {
      setSearchMarkRects([]);
      return;
    }
    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      const layer = marksLayerRef.current;
      const contentEl = codeContentRef.current;
      if (!layer || !contentEl || searchMatches.length === 0) {
        setSearchMarkRects([]);
        return;
      }
      const preEl = contentEl.closest(".file-viewer-code");
      if (!preEl) return;
      const preRect = preEl.getBoundingClientRect();
      const current =
        searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
      if (!current) {
        setSearchMarkRects([]);
        return;
      }
      const rows = new Map<number, HTMLElement>();
      for (const child of Array.from(contentEl.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const line = Number(child.dataset.line);
        if (line > 0) rows.set(line, child);
      }
      const firstLine = lineMapping.toSource(rowRange.start + 1);
      const lastLine = lineMapping.toSource(rowRange.end);
      let from = searchMatches.length;
      let lo = 0;
      let hi = searchMatches.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (searchMatches[mid].line >= firstLine) {
          from = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      const rects: SearchMarkRect[] = [];
      for (let i = from; i < searchMatches.length; i += 1) {
        const match = searchMatches[i];
        if (match.line > lastLine) break;
        if (rects.length >= SEARCH_MARK_RENDER_LIMIT && match !== current)
          continue;
        const row = rows.get(match.line);
        if (!row) continue;
        const range = makeRowRange(
          row,
          match.start - match.lineStart,
          match.end - match.lineStart,
        );
        if (!range) continue;
        const clientRects = range.getClientRects();
        for (let j = 0; j < clientRects.length; j += 1) {
          const rect = clientRects[j];
          if (rect.width <= 0 && rect.height <= 0) continue;
          rects.push({
            left: rect.left - preRect.left,
            top: rect.top - preRect.top,
            width: rect.width,
            height: rect.height,
            isCurrent: match === current,
          });
        }
      }
      if (!cancelled) {
        setSearchMarkRects(rects);
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [
    editMode,
    lineMapping,
    rowRange.end,
    rowRange.start,
    searchIndex,
    searchMatches,
    searchOpen,
  ]);

  // 查看模式命中行整行底色：关键词横向滚出视窗时仍能感知命中所在行。
  const viewSearchBands = useMemo<SearchLineBand[]>(() => {
    if (editMode || !searchOpen || searchMatches.length === 0) return [];
    const current =
      searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    return collectMatchLines(
      searchMatches,
      lineMapping.toSource(rowRange.start + 1),
      lineMapping.toSource(rowRange.end),
      current?.line ?? -1,
    ).filter((band) => !lineMapping.isHidden(band.line));
  }, [
    editMode,
    lineMapping,
    rowRange.end,
    rowRange.start,
    searchIndex,
    searchMatches,
    searchOpen,
  ]);

  // 编辑模式匹配高亮：与编辑器同排版的透明镜像文本，命中段包 span 着色；
  // 镜像含完整文本以撑满内容宽度，命中行整行底色挂在其内。
  // 大文件编辑只镜像可视行窗口（与高亮层同步位移）。
  const editSearchMirror = useMemo(() => {
    if (!editMode || !searchOpen || searchMatches.length === 0) return null;
    let from = 0;
    let to = editedContent.length;
    let firstLine = 1;
    let lastLine = Number.MAX_SAFE_INTEGER;
    if (plainEditor) {
      if (!plainIndex || plainRange.end <= plainRange.start) return null;
      from = plainIndex.starts[plainRange.start];
      to = plainIndex.starts[Math.min(plainRange.end, plainIndex.total)];
      firstLine = plainRange.start + 1;
      lastLine = plainRange.end;
    }
    const current =
      searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    const bands = collectMatchLines(
      searchMatches,
      firstLine,
      lastLine,
      current?.line ?? -1,
    );
    if (bands.length === 0) return null;
    let first = searchMatches.length;
    let lo = 0;
    let hi = searchMatches.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (searchMatches[mid].end > from) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const nodes: React.ReactNode[] = [];
    let cursor = from;
    let marks = 0;
    for (let i = first; i < searchMatches.length; i += 1) {
      const match = searchMatches[i];
      if (match.start >= to) break;
      if (marks >= SEARCH_MARK_RENDER_LIMIT && match !== current) continue;
      const start = Math.max(match.start, cursor);
      const end = Math.min(match.end, to);
      if (end <= start) continue;
      if (start > cursor) nodes.push(editedContent.slice(cursor, start));
      nodes.push(
        <span
          key={i}
          className={`file-viewer-search-mark-inline${
            match === current ? " current" : ""
          }`}
        >
          {editedContent.slice(start, end)}
        </span>,
      );
      cursor = end;
      marks += 1;
    }
    if (cursor < to) nodes.push(editedContent.slice(cursor, to));
    return { nodes, bands, firstLine };
  }, [
    editMode,
    editedContent,
    plainEditor,
    plainIndex,
    plainRange.end,
    plainRange.start,
    searchIndex,
    searchMatches,
    searchOpen,
  ]);

  const renderSearchBands = (
    bands: SearchLineBand[],
    lineTop: (line: number) => number,
  ) =>
    bands.map((band) => (
      <div
        key={`band-${band.line}`}
        className={`file-viewer-search-line${band.current ? " current" : ""}`}
        style={{ top: lineTop(band.line), height: codeMetrics.lineHeight }}
      />
    ));

  // 镜像层挂载时补一次位移同步，否则要等下一次滚动才对齐。
  const plainMirrorMounted = plainEditor && editSearchMirror != null;
  useLayoutEffect(() => {
    if (plainMirrorMounted) syncPlainView();
  }, [plainMirrorMounted, syncPlainView]);

  const buildMenuItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (!virtualSource) {
      items.push({
        id: "add-to-session",
        label: t("rightPanel.addToConversation", {
          defaultValue: "Add to conversation",
        }),
        icon: <FileInput size={13} strokeWidth={1.8} />,
        onClick: addFileToSession,
      });
    }
    if (canReview && showCodeView && reviewCandidate) {
      const anchor = reviewCandidate;
      items.push({
        id: "file-review-add",
        label: t("fileReview.add"),
        icon: <MessageSquarePlus size={13} strokeWidth={1.8} />,
        onClick: () => addReview(anchor),
      });
    }
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
      icon: <CopySlash size={13} strokeWidth={1.8} />,
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
            filePath.lastIndexOf("\\"),
          );
          const dir = lastSep === -1 ? filePath : filePath.slice(0, lastSep);
          onOpenTerminal(dir);
        },
      });
    }
    return items;
  };

  const renderCodeBlock = () => {
    let highlightStyle: React.CSSProperties | null = null;
    if (highlightLine != null && !lineMapping.isHidden(highlightLine)) {
      highlightStyle = {
        top: `${
          codeMetrics.paddingTop +
          (lineMapping.toVisual(highlightLine) - 1) * codeMetrics.lineHeight
        }px`,
        height: `${codeMetrics.lineHeight}px`,
      };
    }
    return (
      <div
        className="file-viewer-code-scroll"
        ref={codeScrollRef}
        onMouseUp={() => setReviewCandidate(captureReview())}
        onKeyUp={() => setReviewCandidate(captureReview())}
      >
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
              {renderSearchBands(
                viewSearchBands,
                (line) =>
                  codeMetrics.paddingTop +
                  (lineMapping.toVisual(line) - 1) * codeMetrics.lineHeight,
              )}
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
          <code
            className="file-viewer-line-numbers"
            aria-hidden="true"
            style={{
              paddingTop: spacerTop,
              paddingBottom: spacerBottom,
              width: gutterWidth,
            }}
          >
            {gutterRows}
          </code>
          <code
            ref={codeContentRef}
            className="hljs file-viewer-code-content file-viewer-code-content--lines"
            style={{
              paddingTop: spacerTop,
              paddingBottom: spacerBottom,
              minWidth: contentMinWidth,
            }}
          >
            {codeRows}
          </code>
        </pre>
      </div>
    );
  };

  const renderPlainEditBlock = () => (
    <div className="file-viewer-edit-scroll file-viewer-edit-scroll--plain">
      <div className="file-viewer-code file-viewer-code--plain">
        <code
          className="file-viewer-line-numbers file-viewer-line-numbers--edit file-viewer-line-numbers--window"
          aria-hidden="true"
        >
          <span className="file-viewer-gutter-window" ref={plainGutterRef}>
            {plainLineNumbers}
          </span>
        </code>
        <div className="file-viewer-edit-layer">
          {editSearchMirror ? (
            <div
              className="file-viewer-edit-search-bands"
              ref={plainBandsRef}
              aria-hidden="true"
            >
              {renderSearchBands(
                editSearchMirror.bands,
                (line) =>
                  (line - editSearchMirror.firstLine) * codeMetrics.lineHeight,
              )}
            </div>
          ) : null}
          {editSearchMirror ? (
            <div
              className="file-viewer-edit-search-mirror file-viewer-edit-search-mirror--plain"
              ref={plainMirrorRef}
              aria-hidden="true"
            >
              {editSearchMirror.nodes}
            </div>
          ) : null}
          {plainHighlighter?.enabled ? (
            <pre
              className="hljs file-viewer-edit-highlight"
              ref={plainHighlightRef}
              aria-hidden="true"
            >
              {plainHighlightRows}
            </pre>
          ) : null}
          <textarea
            id={editTextareaId}
            ref={plainTextareaRef}
            className={`file-viewer-edit-textarea file-viewer-edit-textarea--plain${
              plainHighlighter?.enabled
                ? " file-viewer-edit-textarea--ghost"
                : ""
            }`}
            value={editedContent}
            spellCheck={false}
            wrap="off"
            onChange={(event) => handleValueChange(event.target.value)}
            onScroll={syncPlainView}
            onKeyDown={handlePlainKeyDown}
          />
        </div>
      </div>
    </div>
  );

  const renderEditBlock = () =>
    plainEditor ? (
      renderPlainEditBlock()
    ) : (
      <div className="file-viewer-edit-scroll" ref={editScrollRef}>
        <div className="file-viewer-code">
          <code
            className="file-viewer-line-numbers file-viewer-line-numbers--edit"
            aria-hidden="true"
          >
            {editLineNumbers}
          </code>
          <div className="file-viewer-editor-wrap">
            {editSearchMirror ? (
              <div
                className="file-viewer-edit-search-mirror"
                aria-hidden="true"
              >
                {renderSearchBands(
                  editSearchMirror.bands,
                  (line) => (line - 1) * codeMetrics.lineHeight,
                )}
                {editSearchMirror.nodes}
              </div>
            ) : null}
            <Editor
              value={editedContent}
              onValueChange={handleValueChange}
              highlight={highlightCode}
              onKeyDown={handleEditorKeyDown}
              textareaId={editTextareaId}
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

  const isLocalFile = !isSsh && !virtualSource;

  /** 结构化预览 / 抽取文本视图切换（仅可抽取文本的文档显示）。 */
  const renderPreviewModeToggle = (): React.JSX.Element | null =>
    preview?.textAvailable ? (
      <div className="file-viewer-svg-toggle">
        <button
          type="button"
          className={`file-viewer-toggle-btn ${
            previewMode === "preview" ? "active" : ""
          }`}
          onClick={handleShowStructuredPreview}
          title={t("rightPanel.filePreview.modePreview")}
          aria-label={t("rightPanel.filePreview.modePreview")}
        >
          <Eye size={13} />
        </button>
        <button
          type="button"
          className={`file-viewer-toggle-btn ${
            previewMode === "text" ? "active" : ""
          }`}
          onClick={handleShowExtractedText}
          title={t("rightPanel.filePreview.modeText")}
          aria-label={t("rightPanel.filePreview.modeText")}
        >
          <FileText size={13} />
        </button>
      </div>
    ) : null;

  if (unavailable) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-file-name" title={filePath}>
            {fileName}
          </span>
        </div>
        <div className="file-viewer-body">
          <PreviewUnavailable
            {...unavailable}
            fileName={fileName}
            filePath={filePath}
            local={isLocalFile}
          />
        </div>
      </div>
    );
  }

  if (showPreviewLayout && preview) {
    const activeSection =
      previewSection ??
      preview.grid?.name ??
      preview.sheets[0] ??
      preview.tables[0]?.name ??
      "";
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <span className="file-viewer-file-name" title={filePath}>
            {fileName}
          </span>
          <span className="file-viewer-file-size">
            {formatSize(preview.size)}
          </span>
          <span className="file-viewer-edit-status">
            {t("rightPanel.fileViewerReadOnlyPreview")}
          </span>
          {renderPreviewModeToggle()}
        </div>
        <div className="file-viewer-body">
          {previewMode === "text" ? (
            textError && !textLoading ? (
              <PreviewUnavailable
                reason="parse_failed"
                kind={preview.kind}
                size={preview.size}
                detail={textError}
                fileName={fileName}
                filePath={filePath}
                local={isLocalFile}
              />
            ) : (
              <div className="file-viewer-loading">
                <Loader2 className="spin" size={20} />
              </div>
            )
          ) : previewFailure ? (
            <PreviewUnavailable
              {...previewFailure}
              fileName={fileName}
              filePath={filePath}
              local={isLocalFile}
            />
          ) : (
            <FilePreviewView
              preview={preview}
              activeSection={activeSection}
              loadingSection={loadingSection}
              onSelectSection={handleSelectSection}
              onFailure={handlePreviewFailure}
            />
          )}
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
      onCopy={handleCodeCopy}
      onContextMenu={(e) => {
        // 编辑模式放行浏览器原生菜单（保留 textarea 的复制/粘贴/剪切）。
        if (
          editMode ||
          (e.target instanceof Element &&
            e.target.closest(".file-review-panel"))
        ) {
          return;
        }
        e.preventDefault();
        setReviewCandidate(captureReview());
        setSelectionAnchor(captureSessionSelection());
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
        {isReadOnlyPreview(content) ? (
          <span
            className="file-viewer-edit-status"
            title={t(
              content.mimeType === "application/x-snow-document-text"
                ? "rightPanel.fileViewerDocumentPreviewHint"
                : "rightPanel.fileViewerTextPreviewHint",
            )}
          >
            {t("rightPanel.fileViewerReadOnlyPreview")}
          </span>
        ) : null}
        {renderPreviewModeToggle()}
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
        {isSsh && sshSessionId && !editMode ? (
          <button
            type="button"
            className="file-viewer-action-btn"
            title={t("rightPanel.fileViewerRefresh", {
              defaultValue: "Refresh",
            })}
            aria-label={t("rightPanel.fileViewerRefresh", {
              defaultValue: "Refresh",
            })}
            onClick={() => void handleRefreshRemote()}
            disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 className="spin" size={13} />
            ) : (
              <RefreshCw size={13} />
            )}
          </button>
        ) : null}
        {isSsh && sshWorkspaceId ? (
          <button
            type="button"
            className="file-viewer-action-btn"
            title={t("rightPanel.downloadRemoteFileHint")}
            aria-label={t("rightPanel.downloadRemoteFile")}
            onClick={handleDownloadRemote}
          >
            <Download size={13} />
          </button>
        ) : null}
        {canReview && !editMode ? (
          <>
            <button
              type="button"
              className="file-viewer-action-btn"
              title={t("fileReview.title")}
              aria-label={t("fileReview.title")}
              aria-pressed={reviewOpen}
              onClick={() => {
                setReviewOpen(!reviewOpen);
                if (isMarkdown) setMdMode("code");
                if (reviewOpen) {
                  setReviewSelection(null);
                  setReviewHighlights({});
                  setReviewScroll(null);
                }
              }}
            >
              <MessageSquare size={13} />
            </button>
            <button
              type="button"
              className="file-viewer-action-btn"
              title={t(
                reviewCandidate ? "fileReview.add" : "fileReview.selectHint",
              )}
              aria-label={t("fileReview.add")}
              disabled={!showCodeView || !reviewCandidate}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addReview(reviewCandidate)}
            >
              <MessageSquarePlus size={13} />
            </button>
          </>
        ) : null}
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
                title={`${t("rightPanel.fileViewerSave", {
                  defaultValue: "Save",
                })} (${keyToDisplay("mod+s")})`}
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
      {externalChange ? (
        <div className="file-viewer-external-change">
          <AlertCircle size={14} />
          <span className="file-viewer-external-change-text">
            {t("rightPanel.fileViewerExternalChange", {
              defaultValue: "This file was changed on disk.",
            })}
          </span>
          <button
            type="button"
            className="file-viewer-external-reload"
            onClick={() => applyExternalContent(externalChange)}
          >
            {t("rightPanel.fileViewerExternalReload", {
              defaultValue: "Reload",
            })}
          </button>
          <button
            type="button"
            className="file-viewer-external-dismiss"
            onClick={() => setExternalChange(null)}
            title={t("rightPanel.fileViewerExternalDismiss", {
              defaultValue: "Dismiss",
            })}
          >
            <X size={13} />
          </button>
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
              onChange={(event) => {
                searchNavTickRef.current += 1;
                setSearchQuery(event.target.value);
              }}
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
      <div
        className={`file-viewer-workspace${reviewOpen && canReview && !editMode ? " file-viewer-workspace--review" : ""}${reviewResizing ? " file-viewer-workspace--resizing" : ""}`}
        ref={workspaceRef}
        style={
          {
            ...(reviewPanelWidth != null
              ? { "--file-review-panel-width": `${reviewPanelWidth}px` }
              : {}),
            ...(reviewPanelHeight != null
              ? { "--file-review-panel-height": `${reviewPanelHeight}px` }
              : {}),
          } as React.CSSProperties
        }
      >
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
                  content.content,
                )}`}
                alt={fileName}
                className="file-viewer-image"
              />
            </div>
          )}
          {isSvg && svgMode === "code" && renderCodeBlock()}
          {isBinary && (
            <PreviewUnavailable
              reason="unsupported"
              kind=""
              size={content.size}
              fileName={fileName}
              filePath={filePath}
              local={isLocalFile}
            />
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
        {reviewOpen && canReview && reviewIndex && !editMode ? (
          <>
            <div
              className={`file-review-resizer${reviewResizing ? " dragging" : ""}`}
              role="separator"
              aria-orientation={reviewStacked ? "horizontal" : "vertical"}
              onPointerDown={
                reviewStacked
                  ? handleReviewResizeStartY
                  : handleReviewResizeStart
              }
            />
            <FileReviewPanel
              key={`${reviewSourceKey}:${filePath}`}
              sourceKey={reviewSourceKey}
              filePath={filePath}
              index={reviewIndex}
              representation={reviewRepresentation}
              selection={reviewSelection}
              highlights={reviewHighlights}
              onCancelSelection={() => setReviewSelection(null)}
              onToggleLocate={(id, location) => {
                setMdMode("code");
                setSearchOpen(false);
                toggleReviewHighlight(id, location);
              }}
              onClose={() => {
                setReviewOpen(false);
                setReviewSelection(null);
                setReviewHighlights({});
                setReviewScroll(null);
              }}
            />
          </>
        ) : null}
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
