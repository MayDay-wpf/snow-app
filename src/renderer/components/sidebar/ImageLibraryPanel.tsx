import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FolderCog,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { FormDialog } from "../common/FormDialog";
import { ContextMenu } from "../common/ContextMenu";
import type { ContextMenuItem } from "../common/ContextMenu";
import type {
  ImageAlbumRecord,
  ImageLibraryRecord,
} from "../../../preload";

type RatioFilter = "all" | "landscape" | "square" | "portrait";
type TimeFilter = "all" | "today" | "7d" | "30d";
type SortBy = "newest" | "oldest" | "name";

/** data URL → Blob（不走 fetch：CSP connect-src 不允许 data:） */
const dataUrlToBlob = (dataUrl: string): Blob => {
  const [header, base64] = dataUrl.split(",");
  const mimeType =
    /^data:([^;]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

/** 图片 data URL 进程内缓存，避免重复 IPC */
const imageDataCache = new Map<string, string>();

const saveBlob = async (dataUrl: string, filename: string): Promise<void> => {
  const blob = dataUrlToBlob(dataUrl);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const ratioKind = (record: ImageLibraryRecord): RatioFilter => {
  if (!record.width || !record.height) return "all";
  const ratio = record.width / record.height;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
};

/** 字节数 → 人类可读大小 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

type ImageLibraryPanelProps = {
  onClose: () => void;
};

export const ImageLibraryPanel = ({
  onClose,
}: ImageLibraryPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [items, setItems] = useState<ImageLibraryRecord[]>([]);
  const [albums, setAlbums] = useState<ImageAlbumRecord[]>([]);
  /**
   * 两级视图模式：
   * - "overview"：相册卡片墙（按相册级别展示，默认进入）
   * - "gallery"：当前相册/全部/未分类的图片网格
   */
  const [viewMode, setViewMode] = useState<"overview" | "gallery">("overview");
  /** 当前选中的相册："all" = 全部，"" = 未分类，其他 = 相册 id */
  const [activeAlbum, setActiveAlbum] = useState<string>("all");
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  /** 正在重命名的相册（null = 未在重命名） */
  const [renamingAlbum, setRenamingAlbum] = useState<ImageAlbumRecord | null>(
    null
  );
  const [renameAlbumName, setRenameAlbumName] = useState("");
  /** 新建/重命名相册对话框内联错误提示 */
  const [albumError, setAlbumError] = useState("");
  /** 新建/重命名提交中（防重复提交） */
  const [albumBusy, setAlbumBusy] = useState(false);
  const createAlbumInputRef = useRef<HTMLInputElement | null>(null);
  const renameAlbumInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingAlbumDelete, setPendingAlbumDelete] =
    useState<ImageAlbumRecord | null>(null);
  /** 搜索关键词（匹配文件名 / prompt / 模型 / 服务商） */
  const [searchQuery, setSearchQuery] = useState("");
  /** 排序方式：最新优先 / 最早优先 / 按名称 */
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  /** 已选中的图片 id 集合（批量操作） */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** 批量删除确认弹窗开关 */
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false);
  /** 图片卡片右键菜单 */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    record: ImageLibraryRecord;
  } | null>(null);
  /** 相册封面 dataUrl 缓存（key = albumId） */
  const [albumCovers, setAlbumCovers] = useState<Record<string, string>>({});
  /** 最近一次复制成功的标识（用于"已复制"反馈） */
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedKeyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  /** 手动导入图片中 */
  const [importing, setImporting] = useState(false);
  /** 拖拽悬停的目标相册（null = 无；"none" = 未分类） */
  const [dragOverAlbum, setDragOverAlbum] = useState<string | null>(null);
  /** 增量渲染上限（滚动到底加载更多） */
  const [visibleLimit, setVisibleLimit] = useState(60);
  /** 网格滚动容器（用于滚动增量渲染） */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** 网格容器（用于估算列数） */
  const gridRef = useRef<HTMLDivElement | null>(null);
  /** 卡片 DOM 引用（键盘导航 focus 用） */
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [root, setRoot] = useState("");
  const [customDir, setCustomDir] = useState("");
  const [changingDir, setChangingDir] = useState(false);
  const [ratioFilter, setRatioFilter] = useState<RatioFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<ImageLibraryRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<ImageLibraryRecord | null>(null);
  /** 待确认迁移的目标目录（null 表示无待确认迁移） */
  const [pendingMigration, setPendingMigration] = useState<{
    target: string;
    dirLabel: string;
  } | null>(null);
  /** 迁移进度（null 表示未在迁移） */
  const [migration, setMigration] = useState<{
    total: number;
    copied: number;
  } | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  /** 用户请求取消迁移（chunk 循环之间检查） */
  const migrationCancelledRef = useRef(false);
  /** 组件卸载时若迁移仍进行中，触发回滚 */
  const migrationActiveRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [records, rootPath, savedDir, albumRecords] = await Promise.all([
        window.snow.listImageLibrary(),
        window.snow.getImageLibraryRoot().catch(() => ""),
        window.snow.getImageLibraryDir().catch(() => ""),
        window.snow.listImageAlbums().catch(() => []),
      ]);
      setItems(records);
      setAlbums(albumRecords);
      setRoot(rootPath);
      setCustomDir(savedDir);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 批量解析缩略图 data URL（带缓存；6 路并发，避免大图库串行拉取卡顿）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      const pending = items.filter(
        (record) => !imageDataCache.has(record.relativePath)
      );
      let cursor = 0;
      const workerCount = Math.min(6, Math.max(1, pending.length));
      const worker = async (): Promise<void> => {
        while (!cancelled) {
          const idx = cursor++;
          if (idx >= pending.length) return;
          const record = pending[idx];
          try {
            const dataUrl = await window.snow.resolveLibraryImage(
              record.relativePath
            );
            if (dataUrl) {
              imageDataCache.set(record.relativePath, dataUrl);
              next[record.relativePath] = dataUrl;
            }
          } catch {
            // 单张失败不中断
          }
        }
      };
      await Promise.all(
        Array.from({ length: workerCount }, () => worker())
      );
      if (!cancelled && Object.keys(next).length > 0) {
        setDataUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  // 批量解析相册封面（复用图片 dataUrl 缓存；封面变化时自动重拉）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const album of albums) {
        if (cancelled || !album.coverPath) continue;
        const cached = imageDataCache.get(album.coverPath);
        if (cached) {
          next[album.id] = cached;
          continue;
        }
        try {
          const dataUrl = await window.snow.resolveLibraryImage(
            album.coverPath
          );
          if (dataUrl) {
            imageDataCache.set(album.coverPath, dataUrl);
            next[album.id] = dataUrl;
          }
        } catch {
          // 单张失败不中断
        }
      }
      if (!cancelled) {
        setAlbumCovers((prev) => {
          const albumIds = new Set(albums.map((a) => a.id));
          const merged = { ...prev, ...next };
          for (const id of Object.keys(merged)) {
            if (!albumIds.has(id)) delete merged[id];
          }
          return merged;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [albums]);

  const models = useMemo(
    () => [...new Set(items.map((item) => item.model).filter(Boolean))].sort(),
    [items]
  );
  const providers = useMemo(
    () =>
      [...new Set(items.map((item) => item.provider).filter(Boolean))].sort(),
    [items]
  );

  const filtered = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const keyword = searchQuery.trim().toLowerCase();
    const matched = items.filter((item) => {
      // 搜索：文件名 / prompt / 模型 / 服务商 模糊匹配
      if (keyword) {
        const haystack = [
          item.fileName,
          item.prompt,
          item.model,
          item.provider,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(keyword)) {
          return false;
        }
      }
      // 相册过滤："all" = 全部；"" = 未分类；其他 = 指定相册
      if (activeAlbum === "none") {
        if (item.albumId !== null) {
          return false;
        }
      } else if (activeAlbum !== "all" && item.albumId !== activeAlbum) {
        return false;
      }
      if (ratioFilter !== "all" && ratioKind(item) !== ratioFilter) {
        return false;
      }
      if (modelFilter !== "all" && item.model !== modelFilter) {
        return false;
      }
      if (providerFilter !== "all" && item.provider !== providerFilter) {
        return false;
      }
      if (timeFilter !== "all") {
        const created = new Date(item.createdAt.replace(" ", "T")).getTime();
        const limit =
          timeFilter === "today"
            ? todayStart.getTime()
            : timeFilter === "7d"
            ? now - 7 * dayMs
            : now - 30 * dayMs;
        if (!Number.isFinite(created) || created < limit) {
          return false;
        }
      }
      return true;
    });
    if (sortBy === "oldest") {
      return [...matched].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      );
    }
    if (sortBy === "name") {
      return [...matched].sort((a, b) =>
        a.fileName.localeCompare(b.fileName, undefined, { numeric: true })
      );
    }
    return matched; // newest：后端已按 created_at DESC 返回
  }, [
    items,
    activeAlbum,
    ratioFilter,
    timeFilter,
    modelFilter,
    providerFilter,
    searchQuery,
    sortBy,
  ]);

  // ------------------------------------------------------------------
  // 相册操作
  // ------------------------------------------------------------------

  /** 打开「新建相册」对话框（重置输入与错误） */
  const openCreateAlbum = (): void => {
    setNewAlbumName("");
    setAlbumError("");
    setCreatingAlbum(true);
  };

  const closeCreateAlbum = (): void => {
    if (albumBusy) return;
    setCreatingAlbum(false);
    setNewAlbumName("");
    setAlbumError("");
  };

  const confirmCreateAlbum = async (): Promise<void> => {
    const name = newAlbumName.trim();
    if (!name) return;
    setAlbumBusy(true);
    try {
      const album = await window.snow.createImageAlbum(name);
      setAlbums((prev) => [album, ...prev]);
      setNewAlbumName("");
      setCreatingAlbum(false);
      setAlbumError("");
      // 创建成功后直接进入该相册的图片视图
      setActiveAlbum(album.id);
      setViewMode("gallery");
    } catch (albumError) {
      console.warn("[image-library] create album failed", albumError);
      setAlbumError(
        albumError instanceof Error ? albumError.message : String(albumError)
      );
    } finally {
      setAlbumBusy(false);
    }
  };

  /** 打开「重命名相册」对话框（预填当前名称） */
  const startRenameAlbum = (album: ImageAlbumRecord): void => {
    setRenamingAlbum(album);
    setRenameAlbumName(album.name);
    setAlbumError("");
  };

  const closeRenameAlbum = (): void => {
    if (albumBusy) return;
    setRenamingAlbum(null);
    setRenameAlbumName("");
    setAlbumError("");
  };

  const confirmRenameAlbum = async (): Promise<void> => {
    const album = renamingAlbum;
    const name = renameAlbumName.trim();
    if (!album || !name) {
      return;
    }
    setAlbumBusy(true);
    try {
      const updated = await window.snow.renameImageAlbum(album.id, name);
      setAlbums((prev) =>
        prev.map((item) => (item.id === album.id ? updated : item))
      );
      setRenamingAlbum(null);
      setRenameAlbumName("");
      setAlbumError("");
    } catch (renameError) {
      console.warn("[image-library] rename album failed", renameError);
      setAlbumError(
        renameError instanceof Error ? renameError.message : String(renameError)
      );
    } finally {
      setAlbumBusy(false);
    }
  };

  const confirmDeleteAlbum = async (): Promise<void> => {
    const album = pendingAlbumDelete;
    if (!album) {
      return;
    }
    setPendingAlbumDelete(null);
    try {
      await window.snow.deleteImageAlbum(album.id);
      setAlbums((prev) => prev.filter((item) => item.id !== album.id));
      // 相册内图片置为未分类，同步本地状态
      setItems((prev) =>
        prev.map((item) =>
          item.albumId === album.id ? { ...item, albumId: null } : item
        )
      );
      if (activeAlbum === album.id) {
        setActiveAlbum("all");
        // 删除的是当前浏览的相册 → 回到相册卡片墙
        setViewMode("overview");
      }
    } catch (deleteError) {
      console.warn("[image-library] delete album failed", deleteError);
    }
  };

  /** 移动图片到相册（value 为空 = 未分类） */
  const moveToAlbum = async (
    record: ImageLibraryRecord,
    albumId: string
  ): Promise<void> => {
    const target = albumId || null;
    if (target === record.albumId) {
      return;
    }
    try {
      await window.snow.setImageAlbum(record.id, target);
      setItems((prev) =>
        prev.map((item) =>
          item.id === record.id ? { ...item, albumId: target } : item
        )
      );
      // 刷新相册计数与封面（懒刷新：移入/移出后重新拉取相册列表）
      const albumRecords = await window.snow
        .listImageAlbums()
        .catch(() => null);
      if (albumRecords) {
        setAlbums(albumRecords);
      }
    } catch (moveError) {
      console.warn("[image-library] move image failed", moveError);
    }
  };

  // ------------------------------------------------------------------
  // 搜索 / 选择 / 批量操作
  // ------------------------------------------------------------------

  /** 复制文本到剪贴板（带"已复制"反馈） */
  const copyText = async (text: string, key: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 降级方案：临时 textarea + execCommand
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopiedKey(key);
    if (copiedKeyTimerRef.current) {
      clearTimeout(copiedKeyTimerRef.current);
    }
    copiedKeyTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
  };

  /** 单选 / Ctrl 点选切换；Shift 为范围连选（基于当前过滤+排序结果） */
  const toggleSelect = (
    record: ImageLibraryRecord,
    shiftKey: boolean
  ): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey) {
        // 范围选择：从最后选中的一项到当前项（含端点）
        const currentIndex = filtered.findIndex((r) => r.id === record.id);
        if (currentIndex < 0) return prev;
        let anchorIndex = -1;
        for (let i = filtered.length - 1; i >= 0; i--) {
          if (next.has(filtered[i].id)) {
            anchorIndex = i;
            break;
          }
        }
        if (anchorIndex < 0) {
          next.add(record.id);
          return next;
        }
        const [from, to] =
          anchorIndex < currentIndex
            ? [anchorIndex, currentIndex]
            : [currentIndex, anchorIndex];
        for (let i = from; i <= to; i++) {
          next.add(filtered[i].id);
        }
        return next;
      }
      if (next.has(record.id)) {
        next.delete(record.id);
      } else {
        next.add(record.id);
      }
      return next;
    });
  };

  /** 全选 / 取消全选（作用于当前过滤结果） */
  const toggleSelectAll = (): void => {
    setSelectedIds((prev) => {
      if (filtered.length > 0 && prev.size === filtered.length) {
        return new Set();
      }
      return new Set(filtered.map((r) => r.id));
    });
  };

  const clearSelection = (): void => {
    setSelectedIds(new Set());
  };

  /** 批量移入相册（albumId 空 = 移出到未分类） */
  const batchMoveToAlbum = async (albumId: string): Promise<void> => {
    const target = albumId || null;
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    try {
      await Promise.all(ids.map((id) => window.snow.setImageAlbum(id, target)));
      setItems((prev) =>
        prev.map((item) =>
          ids.includes(item.id) ? { ...item, albumId: target } : item
        )
      );
      const albumRecords = await window.snow
        .listImageAlbums()
        .catch(() => null);
      if (albumRecords) {
        setAlbums(albumRecords);
      }
      clearSelection();
    } catch (moveError) {
      console.warn("[image-library] batch move failed", moveError);
    }
  };

  /** 批量删除（逐个删除，任一失败不中断其余） */
  const confirmBatchDelete = async (): Promise<void> => {
    const ids = [...selectedIds];
    setPendingBatchDelete(false);
    try {
      for (const id of ids) {
        const record = items.find((r) => r.id === id);
        if (record) {
          imageDataCache.delete(record.relativePath);
        }
        await window.snow.deleteImageLibraryImage(id);
      }
      setItems((prev) => prev.filter((item) => !ids.includes(item.id)));
      if (lightbox && ids.includes(lightbox.id)) {
        setLightbox(null);
      }
      clearSelection();
    } catch (deleteError) {
      console.warn("[image-library] batch delete failed", deleteError);
    }
  };

  /** 打开图片右键菜单 */
  const openContextMenu = (
    event: React.MouseEvent,
    record: ImageLibraryRecord
  ): void => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, record });
  };

  // ------------------------------------------------------------------
  // 导入 / 拖拽归类 / 键盘导航 / 滚动增量
  // ------------------------------------------------------------------

  /** 手动导入图片：选择文件 → 复制进图库并写索引 → 刷新列表 */
  const handleImport = async (): Promise<void> => {
    const selected = await window.snow.selectImageFiles(
      t("settings.imageLibrarySelectImages")
    );
    if (!selected || selected.length === 0) {
      return;
    }
    setImporting(true);
    try {
      const imported = await window.snow.importImageFiles(selected);
      if (imported.length > 0) {
        await load();
      }
    } catch (importError) {
      console.warn("[image-library] import failed", importError);
      setError(
        importError instanceof Error ? importError.message : String(importError)
      );
    } finally {
      setImporting(false);
    }
  };

  /** 估算网格列数（键盘上下导航用） */
  const getColumnCount = (): number => {
    const grid = gridRef.current;
    const card = grid?.querySelector<HTMLElement>(".image-library-card");
    if (!grid || !card) {
      return 1;
    }
    const gap = 12;
    const step = card.offsetWidth + gap;
    return Math.max(1, Math.floor((grid.clientWidth + gap) / step));
  };

  /** 滚动到底部附近时加载下一批（增量渲染） */
  const handleContentScroll = (): void => {
    const el = contentRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) {
      setVisibleLimit((prev) => Math.min(prev + 60, filtered.length));
    }
  };

  /** 过滤/排序条件变化时重置增量渲染上限 */
  useEffect(() => {
    setVisibleLimit(60);
  }, [
    searchQuery,
    activeAlbum,
    ratioFilter,
    timeFilter,
    modelFilter,
    providerFilter,
    sortBy,
  ]);

  /** 卡片键盘导航（方向键移动焦点 / Delete 删除） */
  const handleCardKeyDown = (
    event: React.KeyboardEvent,
    record: ImageLibraryRecord
  ): void => {
    const index = filtered.findIndex((r) => r.id === record.id);
    if (index < 0) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      setLightbox(record);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      requestDelete(record);
      return;
    }
    const move = (target: number): void => {
      if (target >= 0 && target < filtered.length) {
        cardRefs.current.get(filtered[target].id)?.focus();
      }
    };
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(index - 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(index + getColumnCount());
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(index - getColumnCount());
    }
  };

  /** 请求删除图片（弹出确认对话框）。 */
  const requestDelete = (record: ImageLibraryRecord): void => {
    setPendingDeletion(record);
  };

  /** 确认删除图片。 */
  const confirmDelete = async (): Promise<void> => {
    const record = pendingDeletion;
    if (!record) {
      return;
    }
    setPendingDeletion(null);
    setDeletingId(record.id);
    try {
      await window.snow.deleteImageLibraryImage(record.id);
      imageDataCache.delete(record.relativePath);
      setItems((prev) => prev.filter((item) => item.id !== record.id));
      // 若该图处于选中集（批量模式），同步清理避免脏计数
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(record.id);
        return next;
      });
      if (lightbox?.id === record.id) {
        setLightbox(null);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownload = async (record: ImageLibraryRecord): Promise<void> => {
    const dataUrl =
      dataUrls[record.relativePath] ??
      (await window.snow.resolveLibraryImage(record.relativePath));
    if (!dataUrl) {
      return;
    }
    await saveBlob(
      dataUrl,
      record.fileName || record.relativePath.split("/").pop() || "image.png"
    );
  };

  /** 切换目录后刷新根路径与缩略图缓存。 */
  const applyNewRoot = async (target: string): Promise<void> => {
    setCustomDir(target);
    const newRoot = await window.snow.getImageLibraryRoot().catch(() => "");
    setRoot(newRoot);
    imageDataCache.clear();
    setDataUrls({});
  };

  /** 图库为空时直接切换目录（无需迁移）。 */
  const switchDirDirect = async (target: string): Promise<void> => {
    setChangingDir(true);
    try {
      await window.snow.setImageLibraryDir(target);
      await applyNewRoot(target);
    } finally {
      setChangingDir(false);
    }
  };

  /** 确认迁移：prepare → 分批复制 → commit；取消则回滚。 */
  const confirmMigration = async (): Promise<void> => {
    const pending = pendingMigration;
    if (!pending) {
      return;
    }
    setPendingMigration(null);
    migrationCancelledRef.current = false;
    migrationActiveRef.current = true;
    setChangingDir(true);
    try {
      const total = await window.snow.prepareImageLibraryMigration(
        pending.target
      );
      if (total === 0) {
        // 无需迁移（目标与当前相同或图库为空）：直接切换
        await window.snow.setImageLibraryDir(pending.target);
        await applyNewRoot(pending.target);
        return;
      }
      setMigration({ total, copied: 0 });
      let done = false;
      while (!done) {
        if (migrationCancelledRef.current) {
          break;
        }
        const progress = await window.snow.migrateImageLibraryChunk();
        setMigration({ total: progress.total, copied: progress.copied });
        done = progress.done;
      }
      if (migrationCancelledRef.current) {
        // 用户取消：删除已复制文件，保持旧目录
        setRollingBack(true);
        await window.snow.rollbackImageLibraryMigration();
        return;
      }
      await window.snow.commitImageLibraryMigration();
      await applyNewRoot(pending.target);
    } catch (migrationError) {
      // 出错自动回滚，保持旧目录
      try {
        await window.snow.rollbackImageLibraryMigration();
      } catch {
        // 回滚失败不阻断错误提示
      }
      setError(
        migrationError instanceof Error
          ? migrationError.message
          : String(migrationError)
      );
    } finally {
      setRollingBack(false);
      setMigration(null);
      migrationActiveRef.current = false;
      setChangingDir(false);
      await load();
    }
  };

  const cancelMigration = (): void => {
    migrationCancelledRef.current = true;
  };

  const handleChangeDir = async (): Promise<void> => {
    const selected = await window.snow.selectImageDirectory(
      t("settings.imageLibrarySelectDir")
    );
    if (!selected) return;
    if (items.length > 0) {
      // 已有图片：先确认再迁移
      setPendingMigration({ target: selected, dirLabel: selected });
      return;
    }
    await switchDirDirect(selected);
  };

  const handleResetDir = async (): Promise<void> => {
    if (items.length > 0) {
      // 已有图片：先确认再迁移回默认目录
      setPendingMigration({
        target: "",
        dirLabel: t("settings.imageLibraryDefaultDir"),
      });
      return;
    }
    await switchDirDirect("");
  };

  const lightboxDataUrl = lightbox ? dataUrls[lightbox.relativePath] ?? "" : "";
  /** 灯箱图片在过滤结果中的位置（-1 = 不在结果中） */
  const lightboxIndex = lightbox
    ? filtered.findIndex((r) => r.id === lightbox.id)
    : -1;

  /** 灯箱内前后切换（越界不响应） */
  const showLightboxDelta = (delta: number): void => {
    if (!lightbox) return;
    const index = filtered.findIndex((r) => r.id === lightbox.id);
    if (index < 0) return;
    const nextIndex = index + delta;
    if (nextIndex >= 0 && nextIndex < filtered.length) {
      setLightbox(filtered[nextIndex]);
    }
  };

  /** 重置全部搜索/筛选条件（保留排序） */
  const clearFilters = (): void => {
    setSearchQuery("");
    setActiveAlbum("all");
    setRatioFilter("all");
    setTimeFilter("all");
    setModelFilter("all");
    setProviderFilter("all");
    // 条件清空后回到相册卡片墙（从「无匹配」空态操作时体验更连贯）
    setViewMode("overview");
  };

  // ------------------------------------------------------------------
  // 两级视图：相册卡片墙（overview） / 图片网格（gallery）
  // ------------------------------------------------------------------

  /** 是否展示相册卡片墙（默认视图；输入搜索词时强制进入图片网格看结果） */
  const showOverview =
    viewMode === "overview" && searchQuery.trim().length === 0;

  /** 打开某个相册的图片网格视图（albumId："all" / "none" / 相册 id） */
  const openGallery = (albumId: string): void => {
    setActiveAlbum(albumId);
    setViewMode("gallery");
  };

  /** 相册墙「全部」卡片封面：最新一张图片的缩略图 */
  const allCover = useMemo(() => {
    const newest = items[0];
    return newest ? dataUrls[newest.relativePath] ?? "" : "";
  }, [items, dataUrls]);

  /** 相册墙「未分类」卡片封面：未分类图片中最新一张的缩略图 */
  const noneCover = useMemo(() => {
    for (const item of items) {
      if (item.albumId === null) {
        const url = dataUrls[item.relativePath];
        if (url) return url;
      }
    }
    return "";
  }, [items, dataUrls]);

  /** 未分类图片数量 */
  const noneCount = useMemo(
    () => items.filter((item) => item.albumId === null).length,
    [items]
  );

  /** gallery 视图顶部标题（当前浏览范围名） */
  const galleryTitle = useMemo(() => {
    if (activeAlbum === "all") return t("settings.imageLibraryAlbumAll");
    if (activeAlbum === "none") return t("settings.imageLibraryAlbumNone");
    const album = albums.find((a) => a.id === activeAlbum);
    return album ? album.name : t("settings.imageLibraryAlbumNone");
  }, [activeAlbum, albums, t]);

  /** 视图切换时重置增量渲染上限与滚动位置 */
  useEffect(() => {
    setVisibleLimit(60);
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [viewMode, activeAlbum]);

  useEffect(() => {
    if (!lightbox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightbox(null);
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // 在当前过滤+排序结果内前后切换
        const index = filtered.findIndex((r) => r.id === lightbox.id);
        if (index < 0) return;
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const nextIndex = index + delta;
        if (nextIndex >= 0 && nextIndex < filtered.length) {
          setLightbox(filtered[nextIndex]);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox, filtered]);

  // Esc 退出选择模式（灯箱未打开时）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedIds.size > 0 && !lightbox) {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds.size, lightbox]);

  // 迁移进行中关闭面板：触发回滚，避免遗留未完成的迁移日志
  useEffect(() => {
    return () => {
      if (migrationActiveRef.current) {
        void window.snow.rollbackImageLibraryMigration().catch(() => {});
      }
    };
  }, []);

  return (
    <div className="api-settings-page image-library-page">
      <div className="api-settings-page-header">
        <div className="image-library-title-row">
          <span className="image-library-title-icon">
            <ImageIcon size={16} strokeWidth={2} aria-hidden="true" />
          </span>
          <div className="api-settings-title-group">
            <strong>{t("settings.imageLibrary")}</strong>
            <span className="settings-item-description">
              {t("settings.imageLibraryDescription")}
            </span>
          </div>
        </div>
        <div className="image-library-actions">
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => void handleImport()}
            disabled={importing}
            title={t("settings.imageLibraryImport")}
            aria-label={t("settings.imageLibraryImport")}
          >
            {importing ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={15}
                strokeWidth={1.8}
              />
            ) : (
              <Upload size={15} strokeWidth={1.8} />
            )}
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => void load()}
            title={t("settings.imageLibraryRefresh")}
            aria-label={t("settings.imageLibraryRefresh")}
          >
            <RefreshCw size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={onClose}
            aria-label={t("toolCall.imagegen.close")}
            title={t("toolCall.imagegen.close")}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {root ? (
        <div className="image-library-root-bar" title={root}>
          {changingDir ? (
            <Loader2
              size={12}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
          ) : (
            <FolderOpen size={12} aria-hidden="true" />
          )}
          <span className="image-library-root-path">{root}</span>
          <button
            type="button"
            className="image-library-root-action"
            onClick={() => void handleChangeDir()}
            disabled={changingDir}
            title={t("settings.imageLibraryChangeDir")}
          >
            <FolderCog size={11} aria-hidden="true" />
            <span>{t("settings.imageLibraryChangeDir")}</span>
          </button>
          {customDir ? (
            <button
              type="button"
              className="image-library-root-action"
              onClick={() => void handleResetDir()}
              disabled={changingDir}
              title={t("settings.imageLibraryResetDir")}
            >
              <X size={11} aria-hidden="true" />
              <span>{t("settings.imageLibraryResetDir")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 相册栏 */}
      <div className="image-library-albums">
        <button
          type="button"
          className={`image-library-album-chip${
            activeAlbum === "all" ? " active" : ""
          }`}
          onClick={() => openGallery("all")}
        >
          <ImageIcon size={12} aria-hidden="true" />
          {t("settings.imageLibraryAlbumAll")}
        </button>
        <button
          type="button"
          className={`image-library-album-chip${
            activeAlbum === "none" ? " active" : ""
          }${dragOverAlbum === "none" ? " drag-over" : ""}`}
          onClick={() => openGallery("none")}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("text/plain")) return;
            event.preventDefault();
            setDragOverAlbum("none");
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragOverAlbum((prev) => (prev === "none" ? null : prev));
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const draggedId = event.dataTransfer.getData("text/plain");
            setDragOverAlbum(null);
            const record = items.find((r) => r.id === draggedId);
            if (record && record.albumId !== null) {
              void moveToAlbum(record, "");
            }
          }}
        >
          <FolderOpen size={12} aria-hidden="true" />
          {t("settings.imageLibraryAlbumNone")}
        </button>
        {albums.map((album) => (
          <span
            key={album.id}
            className={`image-library-album-chip-wrap${
              activeAlbum === album.id ? " active" : ""
            }`}
          >
            <button
              type="button"
              className={`image-library-album-chip${
                dragOverAlbum === album.id ? " drag-over" : ""
              }`}
              onClick={() => openGallery(album.id)}
              title={`${album.name} · ${album.imageCount}`}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("text/plain")) return;
                event.preventDefault();
                setDragOverAlbum(album.id);
              }}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null
                  )
                ) {
                  setDragOverAlbum((prev) =>
                    prev === album.id ? null : prev
                  );
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId = event.dataTransfer.getData("text/plain");
                setDragOverAlbum(null);
                const record = items.find((r) => r.id === draggedId);
                if (record && record.albumId !== album.id) {
                  void moveToAlbum(record, album.id);
                }
              }}
            >
              {albumCovers[album.id] ? (
                <img
                  className="image-library-album-chip-cover"
                  src={albumCovers[album.id]}
                  alt=""
                />
              ) : (
                <FolderOpen size={12} aria-hidden="true" />
              )}
              <span className="image-library-album-chip-name">
                {album.name}
              </span>
              <span className="image-library-album-chip-count">
                {album.imageCount}
              </span>
            </button>
            <span className="image-library-album-chip-actions">
              <button
                type="button"
                title={t("settings.imageLibraryAlbumRename")}
                aria-label={t("settings.imageLibraryAlbumRename")}
                onClick={() => startRenameAlbum(album)}
              >
                <Pencil size={10} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="danger"
                title={t("settings.imageLibraryAlbumDelete")}
                aria-label={t("settings.imageLibraryAlbumDelete")}
                onClick={() => setPendingAlbumDelete(album)}
              >
                <Trash2 size={10} aria-hidden="true" />
              </button>
            </span>
          </span>
        ))}
        <button
          type="button"
          className="image-library-album-add"
          onClick={openCreateAlbum}
          title={t("settings.imageLibraryAlbumCreate")}
        >
          <FolderPlus size={12} aria-hidden="true" />
          {t("settings.imageLibraryAlbumCreate")}
        </button>
      </div>

      {migration ? (
        <div className="image-library-migrate-bar" role="status">
          <div className="image-library-migrate-info">
            <Loader2
              size={12}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
            <span>
              {rollingBack
                ? t("settings.imageLibraryMigrateRollingBack")
                : t("settings.imageLibraryMigrateProgress", {
                    values: {
                      current: migration.copied,
                      total: migration.total,
                    },
                  })}
            </span>
            {!rollingBack ? (
              <button
                type="button"
                className="image-library-migrate-cancel"
                onClick={cancelMigration}
              >
                {t("settings.cancel", { defaultValue: "Cancel" })}
              </button>
            ) : null}
          </div>
          <div className="image-library-migrate-progress-bar">
            <div
              className="image-library-migrate-progress-fill"
              style={{
                width: `${
                  migration.total > 0
                    ? Math.min(
                        100,
                        Math.round((migration.copied / migration.total) * 100)
                      )
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {/* 批量操作工具栏（有选中图片时显示） */}
      {selectedIds.size > 0 ? (
        <div className="image-library-batch-bar" role="toolbar">
          <button
            type="button"
            className="image-library-batch-close"
            onClick={clearSelection}
            title={t("settings.imageLibraryClearSelection")}
            aria-label={t("settings.imageLibraryClearSelection")}
          >
            <X size={12} aria-hidden="true" />
          </button>
          <span className="image-library-batch-count">
            {t("settings.imageLibrarySelectedCount", {
              values: { count: selectedIds.size },
            })}
          </span>
          <button
            type="button"
            className="image-library-batch-select-all"
            onClick={toggleSelectAll}
          >
            {selectedIds.size === filtered.length && filtered.length > 0
              ? t("settings.imageLibraryClearSelection")
              : t("settings.imageLibrarySelectAll")}
          </button>
          <select
            className="image-library-select"
            value="__move"
            onChange={(event) => {
              if (event.target.value !== "__move") {
                void batchMoveToAlbum(event.target.value);
              }
            }}
            aria-label={t("settings.imageLibraryAlbumMove")}
          >
            <option value="__move" disabled>
              {t("settings.imageLibraryAlbumMove")}…
            </option>
            <option value="">{t("settings.imageLibraryAlbumNone")}</option>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>
                {album.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="image-library-batch-delete"
            onClick={() => setPendingBatchDelete(true)}
          >
            <Trash2 size={12} aria-hidden="true" />
            {t("settings.imageLibraryBatchDelete")}
          </button>
        </div>
      ) : null}

      <div className="image-library-toolbar">
        <div className="image-library-search">
          <Search size={12} aria-hidden="true" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              // 输入搜索词时进入图片网格视图展示结果
              if (event.target.value.trim()) {
                setViewMode("gallery");
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchQuery("");
              }
            }}
            placeholder={t("settings.imageLibrarySearchPlaceholder")}
            aria-label={t("settings.imageLibrarySearchPlaceholder")}
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              title={t("settings.imageLibrarySearchClear")}
              aria-label={t("settings.imageLibrarySearchClear")}
            >
              <X size={10} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {/* 相册卡片墙视图下只保留搜索框，筛选仅对图片网格有意义 */}
        {!showOverview ? (
          <>
        <div className="image-library-filter-group">
          {(
            [
              ["all", t("settings.imageLibraryFilterAll")],
              ["landscape", t("settings.imageLibraryFilterLandscape")],
              ["square", t("settings.imageLibraryFilterSquare")],
              ["portrait", t("settings.imageLibraryFilterPortrait")],
            ] as [RatioFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`image-library-filter-btn${
                ratioFilter === value ? " active" : ""
              }`}
              onClick={() => setRatioFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="image-library-filter-group">
          {(
            [
              ["all", t("settings.imageLibraryTimeAll")],
              ["today", t("settings.imageLibraryTimeToday")],
              ["7d", t("settings.imageLibraryTime7d")],
              ["30d", t("settings.imageLibraryTime30d")],
            ] as [TimeFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`image-library-filter-btn${
                timeFilter === value ? " active" : ""
              }`}
              onClick={() => setTimeFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {providers.length > 1 ? (
          <select
            className="image-library-select"
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
            aria-label={t("toolCall.imagegen.provider")}
          >
            <option value="all">{t("settings.imageLibraryProviderAll")}</option>
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        ) : null}
        {models.length > 1 ? (
          <select
            className="image-library-select"
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
            aria-label={t("toolCall.imagegen.model")}
          >
            <option value="all">{t("settings.imageLibraryModelAll")}</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : null}
        <span className="image-library-count">
          {t("settings.imageLibraryCount", {
            values: { count: filtered.length },
          })}
        </span>
        <select
          className="image-library-select"
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as SortBy)}
          aria-label={t("settings.imageLibrarySort")}
        >
          <option value="newest">
            {t("settings.imageLibrarySortNewest")}
          </option>
          <option value="oldest">
            {t("settings.imageLibrarySortOldest")}
          </option>
          <option value="name">{t("settings.imageLibrarySortName")}</option>
        </select>
          </>
        ) : null}
      </div>

      {showOverview ? (
        /* ===================== 相册卡片墙（按相册级别展示） ===================== */
        <div
          className="image-library-content"
          ref={contentRef}
          onScroll={handleContentScroll}
        >
          {loading ? (
            <div className="image-library-state" role="status">
              <Loader2
                className="tool-call-icon-spinning"
                size={20}
                aria-hidden="true"
              />
              <span>{t("common.loading")}</span>
            </div>
          ) : error ? (
            <div className="image-library-state">
              <span className="tool-call-error">{error}</span>
            </div>
          ) : (
            <div className="image-library-albums-view">
              <div className="image-library-albums-head">
                <span className="image-library-albums-title">
                  {t("settings.imageLibraryAlbums")}
                </span>
                <span className="image-library-albums-count">
                  {t("settings.imageLibraryCount", {
                    values: { count: items.length },
                  })}
                </span>
              </div>
              {items.length === 0 ? (
                <div className="image-library-state">
                  <span className="image-library-state-icon">
                    <ImageIcon size={26} aria-hidden="true" />
                  </span>
                  <span>{t("settings.imageLibraryEmpty")}</span>
                  <button
                    type="button"
                    className="image-library-album-card add compact"
                    onClick={openCreateAlbum}
                  >
                    <FolderPlus size={16} aria-hidden="true" />
                    <span className="image-library-album-card-name">
                      {t("settings.imageLibraryAlbumCreate")}
                    </span>
                  </button>
                </div>
              ) : (
                <div className="image-library-album-grid">
                  {/* 全部图片 */}
                  <button
                    type="button"
                    className="image-library-album-card"
                    onClick={() => openGallery("all")}
                    title={t("settings.imageLibraryAlbumAll")}
                  >
                    <span className="image-library-album-card-cover">
                      {allCover ? (
                        <img src={allCover} alt="" />
                      ) : (
                        <ImageIcon size={22} aria-hidden="true" />
                      )}
                    </span>
                    <span className="image-library-album-card-info">
                      <span className="image-library-album-card-name">
                        {t("settings.imageLibraryAlbumAll")}
                      </span>
                      <span className="image-library-album-card-count">
                        {items.length}
                      </span>
                    </span>
                  </button>
                  {/* 未分类 */}
                  <button
                    type="button"
                    className="image-library-album-card"
                    onClick={() => openGallery("none")}
                    title={t("settings.imageLibraryAlbumNone")}
                  >
                    <span className="image-library-album-card-cover">
                      {noneCover ? (
                        <img src={noneCover} alt="" />
                      ) : (
                        <FolderOpen size={22} aria-hidden="true" />
                      )}
                    </span>
                    <span className="image-library-album-card-info">
                      <span className="image-library-album-card-name">
                        {t("settings.imageLibraryAlbumNone")}
                      </span>
                      <span className="image-library-album-card-count">
                        {noneCount}
                      </span>
                    </span>
                  </button>
                  {/* 用户相册 */}
                  {albums.map((album) => (
                    <span
                      key={album.id}
                      className="image-library-album-card-wrap"
                    >
                      <button
                        type="button"
                        className="image-library-album-card"
                        onClick={() => openGallery(album.id)}
                        title={`${album.name} · ${album.imageCount}`}
                      >
                        <span className="image-library-album-card-cover">
                          {albumCovers[album.id] ? (
                            <img src={albumCovers[album.id]} alt="" />
                          ) : (
                            <FolderOpen size={22} aria-hidden="true" />
                          )}
                        </span>
                        <span className="image-library-album-card-info">
                          <span className="image-library-album-card-name">
                            {album.name}
                          </span>
                          <span className="image-library-album-card-count">
                            {album.imageCount}
                          </span>
                        </span>
                      </button>
                      <span className="image-library-album-card-actions">
                        <button
                          type="button"
                          title={t("settings.imageLibraryAlbumRename")}
                          aria-label={t("settings.imageLibraryAlbumRename")}
                          onClick={() => startRenameAlbum(album)}
                        >
                          <Pencil size={11} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="danger"
                          title={t("settings.imageLibraryAlbumDelete")}
                          aria-label={t("settings.imageLibraryAlbumDelete")}
                          onClick={() => setPendingAlbumDelete(album)}
                        >
                          <Trash2 size={11} aria-hidden="true" />
                        </button>
                      </span>
                    </span>
                  ))}
                  {/* 新建相册 */}
                  <button
                    type="button"
                    className="image-library-album-card add"
                    onClick={openCreateAlbum}
                    title={t("settings.imageLibraryAlbumCreate")}
                  >
                    <span className="image-library-album-card-cover">
                      <FolderPlus size={22} aria-hidden="true" />
                    </span>
                    <span className="image-library-album-card-info">
                      <span className="image-library-album-card-name">
                        {t("settings.imageLibraryAlbumCreate")}
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* ===================== 图片网格视图（面包屑 + 工具栏 + 网格） ===================== */}
          <div className="image-library-gallery-header">
            <button
              type="button"
              className="image-library-back-btn"
              onClick={() => setViewMode("overview")}
              title={t("settings.imageLibraryAlbums")}
            >
              <ChevronLeft size={13} aria-hidden="true" />
              {t("settings.imageLibraryAlbums")}
            </button>
            <span className="image-library-gallery-title">
              {galleryTitle}
            </span>
            <span className="image-library-gallery-count">
              {t("settings.imageLibraryCount", {
                values: { count: filtered.length },
              })}
            </span>
          </div>

      <div
        className="image-library-content"
        ref={contentRef}
        onScroll={handleContentScroll}
      >
        {loading ? (
          <div className="image-library-state" role="status">
            <Loader2
              className="tool-call-icon-spinning"
              size={20}
              aria-hidden="true"
            />
            <span>{t("common.loading")}</span>
          </div>
        ) : error ? (
          <div className="image-library-state">
            <span className="tool-call-error">{error}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="image-library-state">
            <span className="image-library-state-icon">
              <ImageIcon size={26} aria-hidden="true" />
            </span>
            {items.length === 0 ? (
              <span>{t("settings.imageLibraryEmpty")}</span>
            ) : (
              <>
                <span>{t("settings.imageLibraryEmptyFiltered")}</span>
                <span className="image-library-state-hint">
                  {t("settings.imageLibraryEmptyFilteredHint")}
                </span>
                <button
                  type="button"
                  className="image-library-state-clear"
                  onClick={clearFilters}
                >
                  <X size={11} aria-hidden="true" />
                  {t("settings.imageLibraryClearFilters")}
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="image-library-grid" ref={gridRef}>
            {filtered.slice(0, visibleLimit).map((record) => {
              const src = dataUrls[record.relativePath];
              const selected = selectedIds.has(record.id);
              return (
                <div
                  key={record.id}
                  className={`image-library-card${
                    selected ? " selected" : ""
                  }`}
                  role="button"
                  tabIndex={0}
                  ref={(element) => {
                    cardRefs.current.set(record.id, element);
                  }}
                  onClick={() => setLightbox(record)}
                  onKeyDown={(event) => handleCardKeyDown(event, record)}
                  onContextMenu={(event) => openContextMenu(event, record)}
                  draggable={selectedIds.size === 0}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", record.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  title={record.prompt || record.fileName}
                >
                  <span
                    className={`image-library-card-check${
                      selected ? " checked" : ""
                    }`}
                    role="checkbox"
                    aria-checked={selected}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleSelect(record, event.shiftKey);
                    }}
                  >
                    {selected ? (
                      <Check size={10} aria-hidden="true" />
                    ) : null}
                  </span>
                  {src ? (
                    <img src={src} alt={record.prompt || record.fileName} />
                  ) : (
                    <div className="image-library-card-placeholder">
                      <Loader2
                        className="tool-call-icon-spinning"
                        size={16}
                        aria-hidden="true"
                      />
                    </div>
                  )}
                  <div className="image-library-card-meta">
                    <span className="image-library-card-model">
                      {record.model || record.provider || "—"}
                    </span>
                    <span className="image-library-card-date">
                      {record.createdAt}
                    </span>
                  </div>
                  <div
                    className="image-library-card-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <select
                      className="image-library-card-album-select"
                      value={record.albumId ?? ""}
                      onChange={(event) =>
                        void moveToAlbum(record, event.target.value)
                      }
                      onClick={(event) => event.stopPropagation()}
                      title={t("settings.imageLibraryAlbumMove")}
                      aria-label={t("settings.imageLibraryAlbumMove")}
                    >
                      <option value="">
                        {t("settings.imageLibraryAlbumNone")}
                      </option>
                      {albums.map((album) => (
                        <option key={album.id} value={album.id}>
                          {album.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="image-library-card-btn"
                      onClick={() => void handleDownload(record)}
                      title={t("toolCall.imagegen.download")}
                      aria-label={t("toolCall.imagegen.download")}
                    >
                      <Download size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="image-library-card-btn danger"
                      onClick={() => requestDelete(record)}
                      disabled={deletingId === record.id}
                      title={t("settings.imageLibraryDelete")}
                      aria-label={t("settings.imageLibraryDelete")}
                    >
                      {deletingId === record.id ? (
                        <Loader2
                          className="tool-call-icon-spinning"
                          size={12}
                          aria-hidden="true"
                        />
                      ) : (
                        <Trash2 size={12} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
            </div>
            <div className="image-library-load-more" role="status">
              {visibleLimit < filtered.length ? (
                <>
                  <Loader2
                    className="tool-call-icon-spinning"
                    size={12}
                    aria-hidden="true"
                  />
                  {t("settings.imageLibraryLoadedCount", {
                    values: { loaded: visibleLimit, total: filtered.length },
                  })}
                </>
              ) : (
                <span>{t("settings.imageLibraryAllLoaded")}</span>
              )}
            </div>
          </>
        )}
      </div>
        </>
      )}

      {lightbox && lightboxDataUrl
        ? createPortal(
            <div
              className="tool-call-imagegen-lightbox"
              onClick={() => setLightbox(null)}
              role="presentation"
            >
              <button
                type="button"
                className="image-library-lightbox-nav prev"
                onClick={(event) => {
                  event.stopPropagation();
                  showLightboxDelta(-1);
                }}
                aria-label={t("settings.imageLibraryPrev")}
                title={t("settings.imageLibraryPrev")}
                disabled={lightboxIndex <= 0}
              >
                <ChevronLeft size={22} aria-hidden="true" />
              </button>
              <img
                key={lightbox.id}
                src={lightboxDataUrl}
                alt={lightbox.prompt || lightbox.fileName}
                onClick={(event) => event.stopPropagation()}
              />
              <button
                type="button"
                className="image-library-lightbox-nav next"
                onClick={(event) => {
                  event.stopPropagation();
                  showLightboxDelta(1);
                }}
                aria-label={t("settings.imageLibraryNext")}
                title={t("settings.imageLibraryNext")}
                disabled={lightboxIndex < 0 || lightboxIndex >= filtered.length - 1}
              >
                <ChevronRight size={22} aria-hidden="true" />
              </button>
              <div
                className="tool-call-imagegen-lightbox-toolbar"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="image-library-lightbox-meta">
                  {lightboxIndex >= 0
                    ? `${lightboxIndex + 1} / ${filtered.length} · `
                    : ""}
                  {lightbox.model ? `${lightbox.model} · ` : ""}
                  {lightbox.provider ? `${lightbox.provider} · ` : ""}
                  {lightbox.createdAt}
                </span>
                <button
                  type="button"
                  className="tool-call-imagegen-download"
                  onClick={() => void handleDownload(lightbox)}
                >
                  <Download size={13} aria-hidden="true" />
                  {t("toolCall.imagegen.download")}
                </button>
                <button
                  type="button"
                  className="tool-call-imagegen-lightbox-close"
                  onClick={() => setLightbox(null)}
                  aria-label={t("toolCall.imagegen.close")}
                >
                  ✕
                </button>
              </div>
              <div
                className="image-library-lightbox-details"
                onClick={(event) => event.stopPropagation()}
              >
                {lightbox.prompt ? (
                  <div className="image-library-lightbox-prompt">
                    <div className="image-library-lightbox-detail-row">
                      <span className="image-library-lightbox-detail-label">
                        {t("settings.imageLibraryPrompt")}
                      </span>
                      <button
                        type="button"
                        className="image-library-lightbox-copy"
                        onClick={() => void copyText(lightbox.prompt, "prompt")}
                      >
                        {copiedKey === "prompt" ? (
                          <>
                            <Check size={11} aria-hidden="true" />
                            {t("settings.imageLibraryCopied")}
                          </>
                        ) : (
                          <>
                            <Copy size={11} aria-hidden="true" />
                            {t("settings.imageLibraryCopyPrompt")}
                          </>
                        )}
                      </button>
                    </div>
                    <p className="image-library-lightbox-prompt-text">
                      {lightbox.prompt}
                    </p>
                  </div>
                ) : null}
                <div className="image-library-lightbox-detail-grid">
                  <span className="image-library-lightbox-detail-label">
                    {t("settings.imageLibrarySize")}
                  </span>
                  <span>
                    {lightbox.width && lightbox.height
                      ? `${lightbox.width} × ${lightbox.height}`
                      : "—"}
                  </span>
                  <span className="image-library-lightbox-detail-label">
                    {t("settings.imageLibraryFileSize")}
                  </span>
                  <span>{formatBytes(lightbox.sizeBytes)}</span>
                  <span className="image-library-lightbox-detail-label">
                    {t("settings.imageLibraryFileName")}
                  </span>
                  <span className="image-library-lightbox-file-name">
                    {lightbox.fileName}
                  </span>
                  <span className="image-library-lightbox-detail-label">
                    {t("settings.imageLibraryAlbumLabel")}
                  </span>
                  <span>
                    {albums.find((a) => a.id === lightbox.albumId)?.name ??
                      t("settings.imageLibraryAlbumNone")}
                  </span>
                </div>
                <div className="image-library-lightbox-nav-hint">
                  ←/→ {t("settings.imageLibraryNavHint")}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              id: "download",
              label: t("toolCall.imagegen.download"),
              icon: <Download size={12} aria-hidden="true" />,
              onClick: () => {
                setContextMenu(null);
                void handleDownload(contextMenu.record);
              },
            },
            {
              id: "copy-prompt",
              label: t("settings.imageLibraryCopyPrompt"),
              icon: <Copy size={12} aria-hidden="true" />,
              onClick: () => {
                setContextMenu(null);
                void copyText(contextMenu.record.prompt, "context-prompt");
              },
            },
            {
              id: "copy-name",
              label: t("settings.imageLibraryCopyFileName"),
              icon: <FileText size={12} aria-hidden="true" />,
              onClick: () => {
                setContextMenu(null);
                void copyText(contextMenu.record.fileName, "context-name");
              },
            },
            {
              id: "delete",
              label: t("settings.imageLibraryDelete"),
              icon: <Trash2 size={12} aria-hidden="true" />,
              danger: true,
              separator: true,
              onClick: () => {
                setContextMenu(null);
                requestDelete(contextMenu.record);
              },
            },
          ]}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDeletion !== null}
        title={t("settings.imageLibraryDeleteTitle", {
          defaultValue: "Delete image",
        })}
        message={t("settings.imageLibraryDeleteConfirm", {
          defaultValue:
            "Delete this image? It will also be removed from the conversation.",
        })}
        confirmLabel={t("settings.imageLibraryDelete", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDeletion(null)}
        variant="danger"
      />

      <ConfirmDialog
        open={pendingMigration !== null}
        title={t("settings.imageLibraryMigrateTitle", {
          defaultValue: "Migrate images",
        })}
        message={t("settings.imageLibraryMigrateConfirm", {
          defaultValue: "Migrate images to the new directory?",
          values: {
            count: items.length,
            dir: pendingMigration?.dirLabel ?? "",
          },
        })}
        confirmLabel={t("settings.imageLibraryMigrateStart", {
          defaultValue: "Start migration",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmMigration()}
        onCancel={() => setPendingMigration(null)}
      />

      <ConfirmDialog
        open={pendingAlbumDelete !== null}
        title={t("settings.imageLibraryAlbumDeleteTitle", {
          defaultValue: "Delete album",
        })}
        message={t("settings.imageLibraryAlbumDeleteConfirm", {
          defaultValue:
            'Delete album "{{name}}"? Its {{count}} image(s) will be kept (moved to Uncategorized).',
          values: {
            name: pendingAlbumDelete?.name ?? "",
            count: pendingAlbumDelete?.imageCount ?? 0,
          },
        })}
        confirmLabel={t("settings.imageLibraryAlbumDelete", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmDeleteAlbum()}
        onCancel={() => setPendingAlbumDelete(null)}
        variant="danger"
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={pendingBatchDelete}
        title={t("settings.imageLibraryBatchDeleteTitle", {
          defaultValue: "Delete selected images",
        })}
        message={t("settings.imageLibraryBatchDeleteConfirm", {
          defaultValue:
            "Delete the {{count}} selected image(s)? They will also be removed from conversations.",
          values: { count: selectedIds.size },
        })}
        confirmLabel={t("settings.imageLibraryBatchDelete", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmBatchDelete()}
        onCancel={() => setPendingBatchDelete(false)}
        variant="danger"
      />

      {/* 新建相册对话框 */}
      <FormDialog
        open={creatingAlbum}
        title={t("settings.imageLibraryAlbumCreate", {
          defaultValue: "New album",
        })}
        confirmLabel={t("common.confirm", { defaultValue: "Confirm" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        closeLabel={t("common.close", { defaultValue: "Close" })}
        confirmDisabled={!newAlbumName.trim()}
        isSubmitting={albumBusy}
        initialFocusRef={createAlbumInputRef}
        onConfirm={() => void confirmCreateAlbum()}
        onCancel={closeCreateAlbum}
      >
        <label className="form-dialog-field">
          <span className="form-dialog-label">
            {t("settings.imageLibraryAlbumNameLabel", {
              defaultValue: "Album name",
            })}
          </span>
          <input
            ref={createAlbumInputRef}
            className="form-dialog-input"
            disabled={albumBusy}
            maxLength={120}
            onChange={(event) => setNewAlbumName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void confirmCreateAlbum();
              }
            }}
            placeholder={t("settings.imageLibraryAlbumNewPlaceholder", {
              defaultValue: "Album name, Enter to confirm",
            })}
            value={newAlbumName}
          />
        </label>
        {albumError ? (
          <span className="form-dialog-error">{albumError}</span>
        ) : null}
      </FormDialog>

      {/* 重命名相册对话框 */}
      <FormDialog
        open={renamingAlbum !== null}
        title={t("settings.imageLibraryAlbumRename", {
          defaultValue: "Rename album",
        })}
        confirmLabel={t("common.confirm", { defaultValue: "Confirm" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        closeLabel={t("common.close", { defaultValue: "Close" })}
        confirmDisabled={!renameAlbumName.trim()}
        isSubmitting={albumBusy}
        initialFocusRef={renameAlbumInputRef}
        onConfirm={() => void confirmRenameAlbum()}
        onCancel={closeRenameAlbum}
      >
        <label className="form-dialog-field">
          <span className="form-dialog-label">
            {t("settings.imageLibraryAlbumNameLabel", {
              defaultValue: "Album name",
            })}
          </span>
          <input
            ref={renameAlbumInputRef}
            className="form-dialog-input"
            disabled={albumBusy}
            maxLength={120}
            onChange={(event) => setRenameAlbumName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void confirmRenameAlbum();
              }
            }}
            value={renameAlbumName}
          />
        </label>
        {albumError ? (
          <span className="form-dialog-error">{albumError}</span>
        ) : null}
      </FormDialog>
    </div>
  );
};
