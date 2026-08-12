import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { CustomSelect } from "../common/CustomSelect";
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

/** 从拖拽数据中读取图库图片 id 列表（application/json「library-images」协议）。 */
const readDraggedImageIds = (dataTransfer: DataTransfer): string[] => {
  const jsonData = dataTransfer.getData("application/json");
  if (!jsonData) {
    return [];
  }
  try {
    const parsed = JSON.parse(jsonData) as {
      type?: unknown;
      images?: unknown;
    };
    if (parsed.type !== "library-images" || !Array.isArray(parsed.images)) {
      return [];
    }
    return parsed.images
      .map((image) => (image as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
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
   * 扁平层级视图：默认直接展示「全部」图片网格，
   * 顶部相册栏（全部 / 未分类 / 相册）一键切换浏览范围。
   */
  /** 当前选中的相册：\"all\" = 全部，\"\" = 未分类，其他 = 相册 id */
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
  /** 轻量操作反馈（设为封面/发送到聊天框等，数秒后消失）。 */
  const [actionToast, setActionToast] = useState<string | null>(null);
  const actionToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  /** 相册排序拖拽中（携带的相册 id）。 */
  const [draggingAlbumId, setDraggingAlbumId] = useState<string | null>(null);
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
  const [ratioFilter, setRatioFilter] = useState<RatioFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<ImageLibraryRecord | null>(null);
  /** 灯箱详情面板是否展开（收起可避免遮挡图片） */
  const [lightboxDetailsOpen, setLightboxDetailsOpen] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<ImageLibraryRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [records, albumRecords] = await Promise.all([
        window.snow.listImageLibrary(),
        window.snow.listImageAlbums().catch(() => []),
      ]);
      setItems(records);
      setAlbums(albumRecords);
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
      // 先回填进程内缓存：组件重挂载后 dataUrls 已清空但缓存仍在，
      // 若不回填，pending 为空时 setDataUrls 不会被调用，图片会一直卡在占位符
      for (const record of items) {
        const cached = imageDataCache.get(record.relativePath);
        if (cached) {
          next[record.relativePath] = cached;
        }
      }
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

  /** 轻量操作反馈（数秒后自动消失）。 */
  const showActionToast = useCallback((text: string): void => {
    setActionToast(text);
    if (actionToastTimerRef.current) {
      clearTimeout(actionToastTimerRef.current);
    }
    actionToastTimerRef.current = setTimeout(() => setActionToast(null), 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (actionToastTimerRef.current) {
        clearTimeout(actionToastTimerRef.current);
      }
    };
  }, []);

  /** 批量复制选中图片的提示词（按选择顺序拼接，空提示词跳过）。 */
  const handleBatchCopyPrompts = useCallback(async (): Promise<void> => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    const texts = ids
      .map((id) => items.find((record) => record.id === id))
      .filter(
        (record): record is ImageLibraryRecord =>
          !!record && record.prompt.trim() !== ""
      )
      .map((record) => record.prompt.trim());
    if (texts.length === 0) {
      return;
    }
    await copyText(texts.join("\n\n"), "batch-prompts");
  }, [selectedIds, items]);

  /** 灯箱/卡片：发送当前图片到聊天输入框（异步解析 data URL 后插入 chip）。 */
  const sendToChat = useCallback(
    async (record: ImageLibraryRecord): Promise<void> => {
      const dataUrl =
        dataUrls[record.relativePath] ??
        (await window.snow.resolveLibraryImage(record.relativePath));
      if (!dataUrl) {
        return;
      }
      window.dispatchEvent(
        new CustomEvent("chat-input:insert-images", {
          detail: {
            images: [
              {
                name: record.fileName || "image.png",
                dataUrl,
              },
            ],
          },
        })
      );
      showActionToast(t("settings.imageLibrarySentToChat"));
    },
    [dataUrls, showActionToast, t]
  );

  /** 灯箱/卡片：设为绘图工作台参考图（工作台常驻监听全局事件）。 */
  const setAsReference = useCallback(
    (record: ImageLibraryRecord): void => {
      window.dispatchEvent(
        new CustomEvent("drawing:set-reference", {
          detail: {
            path: record.relativePath,
            mimeType: record.mimeType,
          },
        })
      );
      showActionToast(t("settings.imageLibraryRefSet"));
    },
    [showActionToast, t]
  );

  /** 将图片设为所在相册的手动封面。 */
  const handleSetCover = useCallback(
    async (record: ImageLibraryRecord): Promise<void> => {
      if (!record.albumId) {
        return;
      }
      try {
        const updated = await window.snow.setImageAlbumCover(
          record.albumId,
          record.id
        );
        setAlbums((prev) =>
          prev.map((album) => (album.id === updated.id ? updated : album))
        );
        showActionToast(t("settings.imageLibraryCoverSet"));
      } catch (coverError) {
        console.warn("[image-library] set album cover failed", coverError);
      }
    },
    [showActionToast, t]
  );

  /** 相册排序拖拽：把 dragging 相册移动到目标相册位置并持久化。 */
  const reorderAlbumTo = useCallback(
    (draggedId: string, targetId: string): void => {
      if (draggedId === targetId) {
        return;
      }
      const ids = albums.map((album) => album.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) {
        return;
      }
      ids.splice(from, 1);
      ids.splice(to, 0, draggedId);
      const byId = new Map(albums.map((album) => [album.id, album]));
      setAlbums(
        ids
          .map((id) => byId.get(id))
          .filter((album): album is ImageAlbumRecord => !!album)
      );
      void window.snow.reorderImageAlbums(ids).catch((error) => {
        console.warn("[image-library] reorder albums failed", error);
      });
    },
    [albums]
  );

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

  /** 批量移入相册（albumId 空 = 移出到未分类；idsOverride 供拖拽批量归类） */
  const batchMoveToAlbum = async (
    albumId: string,
    idsOverride?: string[]
  ): Promise<void> => {
    const target = albumId || null;
    const ids = idsOverride ?? [...selectedIds];
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

  // ------------------------------------------------------------------
  // 本地图片文件拖入面板 → 导入图库
  // ------------------------------------------------------------------
  const [panelDragOver, setPanelDragOver] = useState(false);

  const handlePanelDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setPanelDragOver(true);
    },
    []
  );

  const handlePanelDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        setPanelDragOver(false);
      }
    },
    []
  );

  const handlePanelDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
      event.preventDefault();
      setPanelDragOver(false);
      const files: File[] = [];
      for (let i = 0; i < event.dataTransfer.files.length; i++) {
        const file = event.dataTransfer.files.item(i);
        if (file) {
          files.push(file);
        }
      }
      if (files.length === 0) {
        return;
      }
      const entries = await window.snow.resolveDroppedFiles(files);
      const imagePaths = entries.filter(
        (entry) =>
          !entry.isDirectory &&
          /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|tiff?)$/i.test(entry.path)
      );
      if (imagePaths.length === 0) {
        return;
      }
      setImporting(true);
      try {
        const imported = await window.snow.importImageFiles(
          imagePaths.map((entry) => entry.path)
        );
        if (imported.length > 0) {
          await load();
        }
      } catch (importError) {
        console.warn("[image-library] drag import failed", importError);
        setError(
          importError instanceof Error
            ? importError.message
            : String(importError)
        );
      } finally {
        setImporting(false);
      }
    },
    [load]
  );

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
  };

  // ------------------------------------------------------------------
  // 视图：相册栏切换浏览范围（全部 / 未分类 / 相册）
  // ------------------------------------------------------------------

  /** 切换到某个浏览范围（\"all\" / \"none\" / 相册 id） */
  const openGallery = (albumId: string): void => {
    setActiveAlbum(albumId);
  };

  /** gallery 视图顶部标题（当前浏览范围名） */
  const galleryTitle = useMemo(() => {
    if (activeAlbum === "all") return t("settings.imageLibraryAlbumAll");
    if (activeAlbum === "none") return t("settings.imageLibraryAlbumNone");
    const album = albums.find((a) => a.id === activeAlbum);
    return album ? album.name : t("settings.imageLibraryAlbumNone");
  }, [activeAlbum, albums, t]);

  /** 浏览范围切换时重置增量渲染上限与滚动位置 */
  useEffect(() => {
    setVisibleLimit(60);
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeAlbum]);

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

  return (
    <div
      className={`api-settings-page image-library-page${
        panelDragOver ? " drag-over" : ""
      }`}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={(event) => void handlePanelDrop(event)}
    >
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>{t("settings.imageLibrary")}</strong>
          <span className="settings-item-description">
            {t("settings.imageLibraryDescription")}
          </span>
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
            event.stopPropagation(); // 阻止冒泡到面板根（避免触发文件导入）
            const draggedIds = readDraggedImageIds(event.dataTransfer);
            setDragOverAlbum(null);
            if (draggedIds.length > 0) {
              void batchMoveToAlbum("", draggedIds);
              return;
            }
            const draggedId = event.dataTransfer.getData("text/plain");
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
              }${draggingAlbumId === album.id ? " dragging" : ""}`}
              onClick={() => openGallery(album.id)}
              title={`${album.name} · ${album.imageCount}`}
              draggable
              onDragStart={(event) => {
                // 相册排序拖拽：自定义 MIME（与图片归类协议区分）
                event.dataTransfer.setData(
                  "application/x-snow-album",
                  album.id
                );
                event.dataTransfer.effectAllowed = "move";
                setDraggingAlbumId(album.id);
              }}
              onDragEnd={() => setDraggingAlbumId(null)}
              onDragOver={(event) => {
                // 相册排序拖拽优先（move 效果）；否则图片归类（copy 效果）
                if (event.dataTransfer.types.includes("application/x-snow-album")) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverAlbum(album.id);
                  return;
                }
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
                event.stopPropagation(); // 阻止冒泡到面板根（避免触发文件导入）
                const albumDragId = event.dataTransfer.getData(
                  "application/x-snow-album"
                );
                setDragOverAlbum(null);
                setDraggingAlbumId(null);
                if (albumDragId) {
                  // 相册排序：移动到目标位置
                  reorderAlbumTo(albumDragId, album.id);
                  return;
                }
                const draggedIds = readDraggedImageIds(event.dataTransfer);
                if (draggedIds.length > 0) {
                  void batchMoveToAlbum(album.id, draggedIds);
                  return;
                }
                const draggedId = event.dataTransfer.getData("text/plain");
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
          <CustomSelect
            value="__move"
            options={[
              {
                value: "__move",
                label: `${t("settings.imageLibraryAlbumMove")}…`,
              },
              { value: "", label: t("settings.imageLibraryAlbumNone") },
              ...albums.map((album) => ({
                value: album.id,
                label: album.name,
              })),
            ]}
            onChange={(value) => {
              if (value !== "__move") {
                void batchMoveToAlbum(value);
              }
            }}
          />
          <button
            type="button"
            className="image-library-batch-copy"
            onClick={() => void handleBatchCopyPrompts()}
            disabled={copiedKey === "batch-prompts"}
          >
            {copiedKey === "batch-prompts" ? (
              <>
                <Check size={12} aria-hidden="true" />
                {t("settings.imageLibraryCopied")}
              </>
            ) : (
              <>
                <Copy size={12} aria-hidden="true" />
                {t("settings.imageLibraryBatchCopyPrompt")}
              </>
            )}
          </button>
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

      {/* 轻量操作反馈（设为封面/发送到聊天框等） */}
      {actionToast ? (
        <div className="image-library-action-toast" role="status">
          {actionToast}
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
          <CustomSelect
            value={providerFilter}
            options={[
              { value: "all", label: t("settings.imageLibraryProviderAll") },
              ...providers.map((provider) => ({
                value: provider,
                label: provider,
              })),
            ]}
            onChange={setProviderFilter}
          />
        ) : null}
        {models.length > 1 ? (
          <CustomSelect
            value={modelFilter}
            options={[
              { value: "all", label: t("settings.imageLibraryModelAll") },
              ...models.map((model) => ({ value: model, label: model })),
            ]}
            onChange={setModelFilter}
          />
        ) : null}
        <span className="image-library-count">
          {t("settings.imageLibraryCount", {
            values: { count: filtered.length },
          })}
        </span>
        <CustomSelect
          value={sortBy}
          options={[
            { value: "newest", label: t("settings.imageLibrarySortNewest") },
            { value: "oldest", label: t("settings.imageLibrarySortOldest") },
            { value: "name", label: t("settings.imageLibrarySortName") },
          ]}
          onChange={(value) => setSortBy(value as SortBy)}
        />
      </div>

      {/* ===== 图片网格（相册栏切换浏览范围：全部 / 未分类 / 相册） ===== */}
      <div className="image-library-gallery-header">
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
              <>
                <span>{t("settings.imageLibraryEmpty")}</span>
                <span className="image-library-state-hint">
                  {t("settings.imageLibraryDragImportHint")}
                </span>
              </>
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
            <div className="image-library-grid masonry" ref={gridRef}>
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
                  draggable
                  onDragStart={(event) => {
                    // 拖拽协议：卡片在选中集中时拖拽整组（批量归类/批量发图），
                    // 否则拖拽单张。application/json 供聊天框/工作台消费，
                    // text/plain 兼容相册 chip 旧协议。
                    const dragged = selectedIds.has(record.id)
                      ? [...selectedIds]
                      : [record.id];
                    const images = dragged
                      .map((id) => items.find((r) => r.id === id))
                      .filter((r): r is ImageLibraryRecord => !!r);
                    event.dataTransfer.setData(
                      "application/json",
                      JSON.stringify({
                        type: "library-images",
                        images: images.map((r) => ({
                          id: r.id,
                          path: r.relativePath,
                          mimeType: r.mimeType,
                          name: r.relativePath.split("/").pop() ?? r.fileName,
                        })),
                      })
                    );
                    if (images.length === 1) {
                      event.dataTransfer.setData("text/plain", images[0].id);
                    }
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
                    <CustomSelect
                      value={record.albumId ?? ""}
                      options={[
                        {
                          value: "",
                          label: t("settings.imageLibraryAlbumNone"),
                        },
                        ...albums.map((album) => ({
                          value: album.id,
                          label: album.name,
                        })),
                      ]}
                      onChange={(value) => void moveToAlbum(record, value)}
                      portal
                    />
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
                  className="image-library-lightbox-action"
                  title={t("settings.imageLibrarySetAsReference")}
                  onClick={() => setAsReference(lightbox)}
                >
                  <Sparkles size={13} aria-hidden="true" />
                  {t("settings.imageLibrarySetAsReference")}
                </button>
                <button
                  type="button"
                  className="image-library-lightbox-action"
                  title={t("settings.imageLibrarySendToChat")}
                  onClick={() => void sendToChat(lightbox)}
                >
                  <Send size={13} aria-hidden="true" />
                  {t("settings.imageLibrarySendToChat")}
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
                className={`image-library-lightbox-details${
                  lightboxDetailsOpen ? "" : " collapsed"
                }`}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="image-library-lightbox-details-head">
                  <span className="image-library-lightbox-details-title">
                    {t("settings.imageLibraryDetails", {
                      defaultValue: "Details",
                    })}
                  </span>
                  <button
                    type="button"
                    className="image-library-lightbox-details-toggle"
                    onClick={() => setLightboxDetailsOpen((open) => !open)}
                    aria-expanded={lightboxDetailsOpen}
                    title={
                      lightboxDetailsOpen
                        ? t("settings.imageLibraryDetailsCollapse", {
                            defaultValue: "Collapse details",
                          })
                        : t("settings.imageLibraryDetailsExpand", {
                            defaultValue: "Expand details",
                          })
                    }
                    aria-label={
                      lightboxDetailsOpen
                        ? t("settings.imageLibraryDetailsCollapse", {
                            defaultValue: "Collapse details",
                          })
                        : t("settings.imageLibraryDetailsExpand", {
                            defaultValue: "Expand details",
                          })
                    }
                  >
                    {lightboxDetailsOpen ? (
                      <ChevronDown size={12} aria-hidden="true" />
                    ) : (
                      <ChevronUp size={12} aria-hidden="true" />
                    )}
                  </button>
                </div>
                {lightboxDetailsOpen ? (
                  <>
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
                  </>
                ) : null}
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
              id: "send-chat",
              label: t("settings.imageLibrarySendToChat"),
              icon: <Send size={12} aria-hidden="true" />,
              onClick: () => {
                setContextMenu(null);
                void sendToChat(contextMenu.record);
              },
            },
            ...(contextMenu.record.albumId
              ? [
                  {
                    id: "set-cover",
                    label: t("settings.imageLibrarySetAsCover"),
                    icon: <ImageIcon size={12} aria-hidden="true" />,
                    onClick: () => {
                      setContextMenu(null);
                      void handleSetCover(contextMenu.record);
                    },
                  },
                ]
              : []),
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
