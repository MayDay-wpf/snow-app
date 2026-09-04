import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  Link2,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import {
  downloadImageSrc,
  extensionForBlob,
  saveBlobToFile,
  srcToBlob,
} from "../../../../utils/imageDownload";
import { imageProxyUrl } from "../../../../utils/imageProxyUrl";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { getErrorMessage } from "../utils/conversationHelpers";
import { ToolCallNode } from "./shared/ToolCallNode";
import { useChatConversationContext } from "../components/ChatConversationContext";
import {
  classifyImageGenError,
  columnsForCount,
  imageGenErrorTitleKey,
  IMG_TALL_RATIO,
  IMG_WIDE_RATIO,
  parseImageGenArgs,
  parseImageGenResult,
  truncateLabel,
  type GalleryItem,
  type LightboxTarget,
} from "./imagegenUtils";

type ImageGenToolCallProps = {
  toolCall: ToolCallInfo;
};

/**
 * 参考图路径（绝对磁盘路径或 upload/ 相对路径）→ data URL 的进程内缓存。
 * path 引用（纯文本主模型场景的 [Reference image #N ...] 块）需要经主进程
 * 读取文件，同一图片在历史消息中会反复渲染，缓存避免重复 IPC。
 */
const uploadImageCache = new Map<string, string>();

/** 失败重试状态：组件内自持，不写回会话（避免与 agent loop 状态机竞争）。 */
type RetryState =
  | { status: "idle" }
  | {
      status: "running";
      streamingImages: NonNullable<ToolCallInfo["streamingImages"]>;
    }
  | { status: "done"; result: string }
  | { status: "failed"; error: string };

export const ImageGenToolCall = ({
  toolCall,
}: ImageGenToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const [lightbox, setLightbox] = useState<LightboxTarget | null>(null);
  /** 灯箱当前图片在 galleryItems 中的索引（-1 = 未打开），同批次切换用 */
  const [lightboxIndex, setLightboxIndex] = useState(-1);

  // ------------------------------------------------------------------
  // 通用重跑通道：重试 / 变体 / 以图为参考重生成共用。
  // 复用 mcp:call-tool 以指定参数执行，流式 partial_image 实时预览，
  // 结果覆盖展示（组件内 state，不写回会话）。
  // ------------------------------------------------------------------
  const [retry, setRetry] = useState<RetryState>({ status: "idle" });
  /** 变体生成时实际注入的 seed（供展示与复制） */
  const [lastSeed, setLastSeed] = useState<number | null>(null);

  const handleGenerate = useCallback(
    async (argsJson: string, seedInfo?: { seed: number }): Promise<void> => {
      setRetry({ status: "running", streamingImages: [] });
      if (seedInfo) {
        setLastSeed(seedInfo.seed);
      }
      try {
        const result = await window.snow.callMcpTool(
          toolCall.name,
          argsJson,
          undefined, // projectId：生图不依赖会话目录
          undefined, // checkpointIds
          undefined, // checkpointWorkDir
          undefined, // sensitiveAuthorizationToken
          (chunk) => {
            if (chunk.stream !== "imagegen") {
              return;
            }
            try {
              const parsed: unknown = JSON.parse(chunk.data);
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                (parsed as Record<string, unknown>).type === "partial_image" &&
                typeof (parsed as Record<string, unknown>).data === "string" &&
                typeof (parsed as Record<string, unknown>).mimeType ===
                  "string" &&
                typeof (parsed as Record<string, unknown>).index === "number"
              ) {
                const image = {
                  index: (parsed as { index: number }).index,
                  mimeType: (parsed as { mimeType: string }).mimeType,
                  data: (parsed as { data: string }).data,
                };
                setRetry((prev) => {
                  if (prev.status !== "running") {
                    return prev;
                  }
                  const list = prev.streamingImages;
                  const existing = list.findIndex(
                    (item) => item.index === image.index
                  );
                  const next =
                    existing >= 0
                      ? list.map((item, i) => (i === existing ? image : item))
                      : [...list, image].sort((a, b) => a.index - b.index);
                  return { status: "running", streamingImages: next };
                });
              }
            } catch {
              // 忽略无法解析的 chunk
            }
          },
          toolCall.interactionId, // 沿用原调用 ID，chunk 路由到同一卡片
          undefined, // subAgentAllowedTools
          false, // planMode：生图不涉及写门
          false // planApproved
        );
        setRetry({ status: "done", result });
      } catch (error) {
        setRetry({ status: "failed", error: getErrorMessage(error) });
      }
    },
    [toolCall.name, toolCall.interactionId]
  );

  /** 失败重试：完全相同参数重跑 */
  const handleRetry = useCallback((): void => {
    void handleGenerate(toolCall.arguments);
  }, [handleGenerate, toolCall.arguments]);

  /** 变体生成：同参数注入随机 seed，得到不同结果 */
  const handleVariant = useCallback((): void => {
    try {
      const args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
      const seed = Math.floor(Math.random() * 2_147_483_647);
      void handleGenerate(JSON.stringify({ ...args, seed }), { seed });
    } catch {
      // 参数解析失败时退化为普通重跑
      void handleGenerate(toolCall.arguments);
    }
  }, [handleGenerate, toolCall.arguments]);

  /** 以某张结果图为参考重生成（轻量图生图工作台） */
  const [refEdit, setRefEdit] = useState<{
    item: GalleryItem;
    prompt: string;
  } | null>(null);

  const handleRegenerateWithRef = useCallback((): void => {
    if (!refEdit?.item.image) {
      setRefEdit(null);
      return;
    }
    try {
      const args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
      const image = refEdit.item.image;
      const reference = image.path
        ? { path: image.path, mimeType: image.mimeType }
        : { data: image.data, mimeType: image.mimeType };
      const next = {
        ...args,
        prompt: refEdit.prompt.trim() || (args.prompt as string) || "",
        images: [reference],
        // 参考图场景禁用逐请求分组与多图，避免与 images 冲突
        requestImages: undefined,
        n: 1,
        prompts: undefined,
      };
      void handleGenerate(JSON.stringify(next));
      setRefEdit(null);
    } catch {
      setRefEdit(null);
    }
  }, [refEdit, toolCall.arguments, handleGenerate]);

  /** 复制完整参数 JSON（供复用/排查） */
  const [copiedArgs, setCopiedArgs] = useState(false);
  const handleCopyArgs = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(toolCall.arguments);
      setCopiedArgs(true);
      window.setTimeout(() => setCopiedArgs(false), 1500);
    } catch (error) {
      console.warn("[imagegen] copy args failed", error);
    }
  }, [toolCall.arguments]);

  // ------------------------------------------------------------------
  // 生成队列可视：统计当前会话内正在运行的生图任务数，
  // pending 卡片据此展示排队提示（maxConcurrentImages 由应用侧管理）。
  // ------------------------------------------------------------------
  const { sessions, activeConversationId } = useChatConversationContext();
  const runningImageGenCount = useMemo(() => {
    if (!activeConversationId) {
      return 0;
    }
    const session = sessions[activeConversationId];
    if (!session?.messages) {
      return 0;
    }
    let count = 0;
    for (const message of session.messages) {
      for (const call of message.toolCalls ?? []) {
        if (call.name === "imagegen-generate" && call.status === "running") {
          count += 1;
        }
      }
    }
    return count;
  }, [sessions, activeConversationId]);


  // ------------------------------------------------------------------
  // 批量下载：优先一次选择目录写入全部（showDirectoryPicker），
  // 回退为逐张保存（每张弹一次原生保存框）。
  // ------------------------------------------------------------------

  // 图片真实宽高比探测：index → width/height，加载完成后驱动卡片比例
  const [ratios, setRatios] = useState<Record<number, number>>({});

  const handleImageLoad = useCallback((index: number) => {
    return (event: React.SyntheticEvent<HTMLImageElement>): void => {
      const img = event.currentTarget;
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        return;
      }
      const ratio = img.naturalWidth / img.naturalHeight;
      setRatios((prev) =>
        prev[index] === ratio ? prev : { ...prev, [index]: ratio }
      );
    };
  }, []);

  // 同批并行生成的图片统一展示比例：取已加载比例的中位数，避免个别图抖动
  const unifiedRatio = useMemo(() => {
    const values = Object.values(ratios).filter(
      (value) => Number.isFinite(value) && value > 0
    );
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [ratios]);

  // 极端比例适配：超宽通栏展示；超窄限高展示（容器查询按真实比例计算高度）
  const figureClassName = `tool-call-imagegen-figure${
    unifiedRatio !== null && unifiedRatio > IMG_WIDE_RATIO
      ? " tool-call-imagegen-figure-wide"
      : unifiedRatio !== null && unifiedRatio < IMG_TALL_RATIO
      ? " tool-call-imagegen-figure-tall"
      : ""
  }`;
  const figureStyle =
    unifiedRatio !== null
      ? ({ "--img-ar": unifiedRatio } as React.CSSProperties)
      : undefined;

  const parsedArgs = useMemo(
    () => parseImageGenArgs(toolCall.arguments),
    [toolCall.arguments]
  );

  // 实际使用的 seed：变体注入的 seed 优先，其次原参数中的 seed
  const displayedSeed = useMemo(() => {
    if (lastSeed !== null) {
      return lastSeed;
    }
    return parsedArgs?.seed !== undefined ? parsedArgs.seed : null;
  }, [lastSeed, parsedArgs]);
  // 重试中：忽略旧失败结果回到生成中视图；重试成功：用新结果覆盖展示。
  const effectiveResult =
    retry.status === "running"
      ? undefined
      : retry.status === "done"
      ? retry.result
      : toolCall.result;
  const parsedResult = useMemo(
    () => parseImageGenResult(effectiveResult),
    [effectiveResult]
  );

  // 收集 path 引用参考图（无内联 data 的项），挂载后经主进程读取真实缩略图
  const referencePaths = useMemo(() => {
    const paths: string[] = [];
    for (const image of parsedArgs?.images ?? []) {
      if (!image.data && image.path && !paths.includes(image.path)) {
        paths.push(image.path);
      }
    }
    return paths;
  }, [parsedArgs]);

  const [resolvedRefs, setResolvedRefs] = useState<Record<string, string>>({});

  // 收集图库落盘引用（image/... 前缀），挂载后经 IPC 读取真实图片数据
  const libraryPaths = useMemo(() => {
    const paths: string[] = [];
    if (parsedResult.type === "success") {
      for (const image of parsedResult.images) {
        if (
          image.path &&
          image.path.startsWith("image/") &&
          !paths.includes(image.path)
        ) {
          paths.push(image.path);
        }
      }
    }
    return paths;
  }, [parsedResult]);

  const [resolvedLibrary, setResolvedLibrary] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (libraryPaths.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const path of libraryPaths) {
        if (cancelled) {
          return;
        }
        const cached = uploadImageCache.get(path);
        if (cached) {
          next[path] = cached;
          continue;
        }
        let dataUrl: string | null = null;
        try {
          dataUrl = await window.snow.resolveLibraryImage(path);
        } catch (error) {
          console.warn(
            "[imagegen] resolveLibraryImage failed for",
            path,
            error
          );
        }
        if (cancelled) {
          return;
        }
        if (dataUrl) {
          uploadImageCache.set(path, dataUrl);
          next[path] = dataUrl;
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setResolvedLibrary((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryPaths]);

  useEffect(() => {
    if (referencePaths.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const path of referencePaths) {
        if (cancelled) {
          return;
        }
        const cached = uploadImageCache.get(path);
        if (cached) {
          next[path] = cached;
          continue;
        }
        let dataUrl: string | null = null;
        try {
          dataUrl = await window.snow.resolveUploadImage(path);
        } catch (error) {
          // IPC 失败（如主进程未注册 handler / native 未就绪）不应中断其余
          // 参考图的解析；记录日志便于排查，当前项回退为占位展示。
          console.warn("[imagegen] resolveUploadImage failed for", path, error);
        }
        if (cancelled) {
          return;
        }
        if (dataUrl) {
          uploadImageCache.set(path, dataUrl);
          next[path] = dataUrl;
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setResolvedRefs((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [referencePaths]);

  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  // 流式预览：重试中优先用重试的实时图，否则用会话里已记录的
  const streamingImages =
    retry.status === "running"
      ? retry.streamingImages
      : (toolCall.streamingImages ?? []);

  // 画廊统一展示项：本地图片（data / path）+ 远程 URL。
  // 远程图经 img-proxy:// 代理加载（CSP 放行、主进程转发、无 CORS 限制），
  // 与本地图同规格展示；链接失效时降级为占位（原始链接列表仍保留兜底）。
  const galleryItems = useMemo<GalleryItem[]>(() => {
    if (parsedResult.type !== "success") {
      return [];
    }
    const items: GalleryItem[] = [];
    for (const image of parsedResult.images) {
      items.push({
        key: image.path ?? `img-${image.data.length}`,
        src: image.path
          ? (resolvedLibrary[image.path] ?? "")
          : `data:${image.mimeType};base64,${image.data}`,
        image,
      });
    }
    for (const url of parsedResult.remoteUrls) {
      items.push({
        key: `remote-${url}`,
        src: imageProxyUrl(url),
        remoteUrl: url,
      });
    }
    return items;
  }, [parsedResult, resolvedLibrary]);

  const [downloadingAll, setDownloadingAll] = useState(false);

  const handleDownloadAll = useCallback(async (): Promise<void> => {
    if (downloadingAll || galleryItems.length === 0) {
      return;
    }
    setDownloadingAll(true);
    try {
      // 1. 收集全部 Blob：单张失败跳过，不中断其余
      const blobs: Blob[] = [];
      for (const item of galleryItems) {
        try {
          let src = item.src;
          if (!src && item.image?.path) {
            src =
              (await window.snow.resolveLibraryImage(item.image.path)) ?? "";
          }
          if (src) {
            blobs.push(await srcToBlob(src));
          }
        } catch (error) {
          console.warn("[imagegen] downloadAll failed for", item.key, error);
        }
      }
      if (blobs.length === 0) {
        return;
      }
      const base = `snow-app-${Date.now()}`;

      // 2. 优先：一次选目录批量写入
      const pickDirectory = (
        window as unknown as {
          showDirectoryPicker?: () => Promise<{
            getFileHandle: (
              name: string,
              opts: { create: boolean }
            ) => Promise<{
              createWritable: () => Promise<{
                write: (blob: Blob) => Promise<void>;
                close: () => Promise<void>;
              }>;
            }>;
          }>;
        }
      ).showDirectoryPicker;
      if (typeof pickDirectory === "function") {
        const dir = await pickDirectory();
        for (let i = 0; i < blobs.length; i++) {
          const fileHandle = await dir.getFileHandle(
            `${base}-${i + 1}.${extensionForBlob(blobs[i])}`,
            { create: true }
          );
          const writable = await fileHandle.createWritable();
          await writable.write(blobs[i]);
          await writable.close();
        }
      } else {
        // 3. 回退：逐张保存（每张一次原生保存框）
        for (let i = 0; i < blobs.length; i++) {
          await saveBlobToFile(
            blobs[i],
            `${base}-${i + 1}.${extensionForBlob(blobs[i])}`
          );
        }
      }
    } catch (error) {
      console.warn("[imagegen] downloadAll failed", error);
    } finally {
      setDownloadingAll(false);
    }
  }, [galleryItems, downloadingAll]);

  // 远程图加载失败（链接过期/403 等）的记录：按 key 降级为占位展示
  const [failedRemotes, setFailedRemotes] = useState<Set<string>>(new Set());
  const handleRemoteError = useCallback((key: string) => {
    setFailedRemotes((prev) =>
      prev.has(key) ? prev : new Set(prev).add(key)
    );
  }, []);

  const prompt = parsedArgs?.prompt ?? "";
  const imageCount =
    parsedResult.type === "success" ? parsedResult.imageCount : 0;

  // 参考图展示来源：requestImages（逐请求独立参考图）时展示第 1 组并注明
  // 总组数，否则展示顶层 images（所有请求共用）
  const hasRequestImages =
    parsedArgs?.requestImages !== undefined &&
    parsedArgs.requestImages.length > 0;
  const refImages = hasRequestImages
    ? parsedArgs!.requestImages![0]
    : parsedArgs?.images;
  const refGroupCount = hasRequestImages
    ? parsedArgs!.requestImages!.length
    : 0;

  // 生图参数区（提示词 / 参数标签 / 参考图）：生成中与完成后共用，
  // 生成中即展示本次请求的意图，不再等生成完成才可见。
  const paramsBlock = parsedArgs ? (
    <div className="tool-call-imagegen-params">
      <div className="tool-call-imagegen-param-item">
        <Sparkles size={11} aria-hidden="true" />
        <span className="tool-call-imagegen-param-label">
          {parsedArgs.prompts && parsedArgs.prompts.length > 1
            ? t("toolCall.imagegen.prompts", {
                values: { count: parsedArgs.prompts.length },
              })
            : t("toolCall.imagegen.prompt")}
        </span>
        {parsedArgs.prompts && parsedArgs.prompts.length > 1 ? (
          <div className="tool-call-imagegen-param-value tool-call-imagegen-prompts">
            {parsedArgs.prompts.map((item, index) => (
              <div
                key={`${index}-${item}`}
                className="tool-call-imagegen-prompts-item"
              >
                <span className="tool-call-imagegen-prompts-index">
                  {index + 1}
                </span>
                <code>{item}</code>
              </div>
            ))}
          </div>
        ) : (
          <code className="tool-call-imagegen-param-value">
            {parsedArgs.prompts?.[0] ?? parsedArgs.prompt}
          </code>
        )}
      </div>

      {parsedArgs.model ||
      parsedArgs.size ||
      parsedArgs.quality ||
      parsedArgs.outputCompression !== undefined ||
      parsedArgs.n !== undefined ||
      parsedArgs.provider ||
      parsedArgs.personGeneration ||
      parsedArgs.webSearch === true ||
      parsedArgs.stream === true ||
      parsedArgs.inputFidelity ||
      parsedArgs.background ||
      parsedArgs.moderation ||
      parsedArgs.seed !== undefined ||
      parsedArgs.thinkingLevel ||
      parsedArgs.imageSearch === true ? (
        <div className="tool-call-imagegen-param-tags">
          {parsedArgs.provider ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.provider")}: {parsedArgs.provider}
            </span>
          ) : null}
          {parsedArgs.model ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.model")}: {parsedArgs.model}
            </span>
          ) : null}
          {parsedArgs.size ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.size")}: {parsedArgs.size}
            </span>
          ) : null}
          {parsedArgs.quality ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.quality")}: {parsedArgs.quality}
            </span>
          ) : null}
          {parsedArgs.outputCompression !== undefined ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.outputCompression")}:{" "}
              {parsedArgs.outputCompression}%
            </span>
          ) : null}
          {parsedArgs.personGeneration ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.personGeneration")}:{" "}
              {parsedArgs.personGeneration}
            </span>
          ) : null}
          {parsedArgs.webSearch === true ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.webSearch")}
            </span>
          ) : null}
          {parsedArgs.stream === true ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.streaming")}
            </span>
          ) : null}
          {parsedArgs.n !== undefined && parsedArgs.n > 1 ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.countParam", {
                values: { count: parsedArgs.n },
              })}
            </span>
          ) : null}
          {parsedArgs.inputFidelity ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.inputFidelity")}:{" "}
              {parsedArgs.inputFidelity}
            </span>
          ) : null}
          {parsedArgs.background ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.background")}: {parsedArgs.background}
            </span>
          ) : null}
          {parsedArgs.moderation ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.moderation")}: {parsedArgs.moderation}
            </span>
          ) : null}
          {parsedArgs.seed !== undefined ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.seed")}: {parsedArgs.seed}
            </span>
          ) : null}
          {parsedArgs.thinkingLevel ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.thinkingLevel")}:{" "}
              {parsedArgs.thinkingLevel}
            </span>
          ) : null}
          {parsedArgs.imageSearch === true ? (
            <span className="tool-call-imagegen-param-tag">
              {t("toolCall.imagegen.imageSearch")}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 参考图（图生图）：requestImages 时展示第 1 组并注明总组数，
          否则展示顶层 images（所有请求共用） */}
      {refImages && refImages.length > 0 ? (
        <div className="tool-call-imagegen-refs">
          <span className="tool-call-imagegen-refs-label">
            <ImageIcon size={10} aria-hidden="true" />
            {t("toolCall.imagegen.refImages", {
              values: { count: refImages.length },
            })}
            {refGroupCount > 0
              ? ` · ${t("toolCall.imagegen.refGroups", {
                  values: { count: refGroupCount },
                })}`
              : ""}
          </span>
          <div className="tool-call-imagegen-refs-grid">
            {refImages.map((image, index) => {
              const src = image.data
                ? `data:${image.mimeType};base64,${image.data}`
                : image.path
                ? resolvedRefs[image.path] ?? ""
                : "";
              return (
                <div
                  key={`${index}-${image.path ?? image.data.length}`}
                  className="tool-call-imagegen-ref-thumb"
                  title={image.path ?? undefined}
                >
                  {src ? (
                    <img
                      src={src}
                      alt={`${t("toolCall.imagegen.refImage")} ${index + 1}`}
                    />
                  ) : (
                    <span className="tool-call-imagegen-ref-placeholder">
                      <ImageIcon size={14} aria-hidden="true" />
                      {index + 1}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  ) : null;

  // Rust 端部分失败时会在 contentPreview 末尾追加 "X/Y parallel requests
  // failed: <原因>"；该字段默认只给模型看，这里仅在部分失败时向用户
  // 展示失败摘要，正常 summary 不展示。
  const partialFailureNote = useMemo(() => {
    if (parsedResult.type !== "success") {
      return "";
    }
    const preview = parsedResult.contentPreview ?? "";
    const failedMatch = preview.match(
      /(\d+\/\d+ parallel requests failed: [\s\S]*)$/
    );
    return failedMatch ? failedMatch[1] : "";
  }, [parsedResult]);

  // 失败原因分类：本地化标题（i18n）+ 原始英文详情（后端完整消息）。
  const classifiedError = useMemo(
    () =>
      parsedResult.type === "error"
        ? classifyImageGenError(parsedResult.message)
        : null,
    [parsedResult]
  );

  // 灯箱：挂载到 document.body，确保 fixed 定位始终相对视口，
  // 无论页面滚动到何处都保持水平 + 垂直居中。
  /** 灯箱在同批次图片间切换（delta ±1），越界不响应 */
  const lightboxDelta = useCallback(
    (delta: number): void => {
      if (lightboxIndex < 0) {
        return;
      }
      const next = lightboxIndex + delta;
      if (next < 0 || next >= galleryItems.length) {
        return;
      }
      const item = galleryItems[next];
      setLightbox(
        item.image
          ? { kind: "image", image: item.image }
          : { kind: "remote", url: item.remoteUrl! }
      );
      setLightboxIndex(next);
    },
    [lightboxIndex, galleryItems]
  );

  /** 关闭灯箱（同时重置切换索引） */
  const closeLightbox = useCallback(() => {
    setLightbox(null);
    setLightboxIndex(-1);
  }, []);

  const lightboxSrc = lightbox
    ? lightbox.kind === "remote"
      ? imageProxyUrl(lightbox.url)
      : lightbox.image.path
        ? resolvedLibrary[lightbox.image.path] ?? ""
        : `data:${lightbox.image.mimeType};base64,${lightbox.image.data}`
    : "";

  // 灯箱打开时若图片数据尚未解析（path 引用），立即兜底解析，
  // 避免 src 为空导致破图图标闪烁
  useEffect(() => {
    if (lightbox?.kind !== "image" || !lightbox.image.path) {
      return;
    }
    const targetPath = lightbox.image.path;
    if (resolvedLibrary[targetPath]) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const dataUrl = await window.snow.resolveLibraryImage(targetPath);
        if (!cancelled && dataUrl) {
          setResolvedLibrary((prev) => ({ ...prev, [targetPath]: dataUrl }));
        }
      } catch (error) {
        console.warn(
          "[imagegen] resolveLibraryImage failed for lightbox",
          targetPath,
          error
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    lightbox?.kind,
    lightbox?.kind === "image" ? lightbox.image.path : undefined,
    resolvedLibrary,
  ]);

  // Esc 关闭灯箱；方向键在同批次图片间上下/左右切换
  useEffect(() => {
    if (!lightbox) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeLightbox();
      } else if (
        event.key === "ArrowUp" ||
        event.key === "ArrowLeft"
      ) {
        event.preventDefault();
        lightboxDelta(-1);
      } else if (
        event.key === "ArrowDown" ||
        event.key === "ArrowRight"
      ) {
        event.preventDefault();
        lightboxDelta(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox, lightboxDelta, closeLightbox]);

  const lightboxElement = lightbox
    ? createPortal(
        <div
          className="tool-call-imagegen-lightbox"
          onClick={closeLightbox}
          role="presentation"
        >
          <button
            type="button"
            className="image-library-lightbox-nav prev"
            onClick={(event) => {
              event.stopPropagation();
              lightboxDelta(-1);
            }}
            aria-label={t("toolCall.imagegen.prev")}
            title={t("toolCall.imagegen.prev")}
            disabled={lightboxIndex <= 0}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          {lightboxSrc ? (
            <img
              key={lightboxIndex}
              src={lightboxSrc}
              alt={t("toolCall.imagegen.generatedImage")}
              draggable={false}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <div
              className="tool-call-imagegen-lightbox-loading"
              role="status"
            >
              <Loader2
                className="tool-call-icon-spinning"
                size={28}
                aria-hidden="true"
              />
              <span>{t("common.loading")}</span>
            </div>
          )}
          <button
            type="button"
            className="image-library-lightbox-nav next"
            onClick={(event) => {
              event.stopPropagation();
              lightboxDelta(1);
            }}
            aria-label={t("toolCall.imagegen.next")}
            title={t("toolCall.imagegen.next")}
            disabled={
              lightboxIndex < 0 || lightboxIndex >= galleryItems.length - 1
            }
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
          <div
            className="tool-call-imagegen-lightbox-toolbar"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="image-library-lightbox-meta">
              {lightboxIndex >= 0 && galleryItems.length > 0
                ? `${lightboxIndex + 1} / ${galleryItems.length}`
                : ""}
            </span>
            <button
              type="button"
              className="tool-call-imagegen-download"
              onClick={() => {
                void (async () => {
                  let src = lightboxSrc;
                  if (!src && lightbox.kind === "image" && lightbox.image.path) {
                    src =
                      (await window.snow.resolveLibraryImage(
                        lightbox.image.path
                      )) ?? "";
                  }
                  if (src) {
                    // data URL / http(s) / img-proxy:// 统一由工具函数解析为 Blob 保存
                    await downloadImageSrc(src);
                  }
                })().catch((error) => {
                  console.error("[imagegen] save image failed:", error);
                });
              }}
              title={t("toolCall.imagegen.download")}
              aria-label={t("toolCall.imagegen.download")}
            >
              <Download size={13} aria-hidden="true" />
              {t("toolCall.imagegen.download")}
            </button>
            <button
              type="button"
              className="tool-call-imagegen-lightbox-close"
              onClick={closeLightbox}
              aria-label={t("toolCall.imagegen.close")}
            >
              ✕
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  // 成功且有图片（本地或远程 URL）：直接以相框画廊展示，不再渲染工具卡片头部
  if (parsedResult.type === "success" && galleryItems.length > 0) {
    const resultImageCount = galleryItems.length;
    // 并行生成的多张图共享同一宽度：按数量分档列数（见 columnsForCount），
    // 整批作为一个图块占满消息可用宽度，而非每张图独立小列
    const gridStyle =
      resultImageCount > 1
        ? ({
            gridTemplateColumns: `repeat(${columnsForCount(
              resultImageCount
            )}, minmax(0, 1fr))`,
          } as React.CSSProperties)
        : undefined;
    return (
      <div className="tool-call-imagegen tool-call-imagegen-result">
        <div className="tool-call-imagegen-toolbar">
          <span className="tool-call-imagegen-toolbar-count">
            <ImageIcon size={11} aria-hidden="true" />
            {t("toolCall.imagegen.count", {
              values: { count: resultImageCount },
            })}
            {displayedSeed !== null ? (
              <button
                type="button"
                className="tool-call-imagegen-seed"
                title={`${t("toolCall.imagegen.seed")}: ${displayedSeed} · ${t(
                  "toolCall.imagegen.seedCopy"
                )}`}
                onClick={() => {
                  void navigator.clipboard.writeText(String(displayedSeed));
                }}
              >
                {t("toolCall.imagegen.seed")}: {displayedSeed}
              </button>
            ) : null}
          </span>
          <span className="tool-call-imagegen-toolbar-actions">
            <button
              type="button"
              className="tool-call-imagegen-download-all"
              onClick={handleVariant}
              disabled={retry.status === "running"}
            >
              <Sparkles size={12} aria-hidden="true" />
              {t("toolCall.imagegen.variant")}
            </button>
            <button
              type="button"
              className="tool-call-imagegen-download-all"
              onClick={() => void handleCopyArgs()}
            >
              <Link2 size={12} aria-hidden="true" />
              {copiedArgs
                ? t("toolCall.imagegen.argsCopied")
                : t("toolCall.imagegen.copyArgs")}
            </button>
            <button
              type="button"
              className="tool-call-imagegen-download-all"
              onClick={() => void handleDownloadAll()}
              disabled={downloadingAll}
            >
              <Download size={12} aria-hidden="true" />
              {downloadingAll
                ? t("toolCall.imagegen.saving")
                : t("toolCall.imagegen.downloadAll")}
            </button>
          </span>
        </div>
        <div
          className={`tool-call-imagegen-grid${
            resultImageCount === 1 ? " tool-call-imagegen-grid-single" : ""
          }`}
          style={gridStyle}
        >
          {galleryItems.map((item, index) => {
            const failed = Boolean(
              item.remoteUrl && failedRemotes.has(item.key)
            );
            return (
              <figure
                key={item.key}
                className={figureClassName}
                style={figureStyle}
              >
                <button
                  type="button"
                  className="tool-call-imagegen-thumb"
                  onClick={() => {
                    if (failed && item.remoteUrl) {
                      // 链接已失效：直接打开原始 URL（浏览器可尝试重试/登录）
                      window.open(item.remoteUrl, "_blank", "noopener,noreferrer");
                      return;
                    }
                    item.image
                      ? setLightbox({ kind: "image", image: item.image })
                      : setLightbox({ kind: "remote", url: item.remoteUrl! });
                    setLightboxIndex(index);
                  }}
                  title={t("toolCall.imagegen.zoom")}
                  aria-label={t("toolCall.imagegen.zoom")}
                >
                  {failed ? (
                    <div className="tool-call-imagegen-remote-fallback">
                      <Link2 size={18} aria-hidden="true" />
                      <span>{t("toolCall.imagegen.remoteFailed")}</span>
                    </div>
                  ) : (
                    <img
                      src={item.src}
                      alt={`${t("toolCall.imagegen.generatedImage")} ${
                        index + 1
                      }`}
                      onLoad={handleImageLoad(index)}
                      onError={
                        item.remoteUrl
                          ? () => handleRemoteError(item.key)
                          : undefined
                      }
                    />
                  )}
                  {resultImageCount > 1 ? (
                    <span className="tool-call-imagegen-badge">{index + 1}</span>
                  ) : null}
                </button>
                {item.image ? (
                  <button
                    type="button"
                    className="tool-call-imagegen-figure-edit"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRefEdit({
                        item,
                        prompt: parsedArgs?.prompt ?? "",
                      });
                    }}
                    title={t("toolCall.imagegen.refEdit")}
                    aria-label={t("toolCall.imagegen.refEdit")}
                  >
                    <ImageIcon size={11} aria-hidden="true" />
                  </button>
                ) : null}
              </figure>
            );
          })}
        </div>

        {parsedResult.remoteUrls.length > 0 ? (
          <div className="tool-call-imagegen-remote">
            <span className="tool-call-imagegen-remote-label">
              <Link2 size={10} aria-hidden="true" />
              {t("toolCall.imagegen.remoteUrls")}
            </span>
            {parsedResult.remoteUrls.map((url, index) => (
              <a
                key={url}
                className="tool-call-imagegen-remote-link"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {truncateLabel(url, 80)}
                {index + 1 < parsedResult.remoteUrls.length ? " · " : ""}
              </a>
            ))}
          </div>
        ) : null}

        {/* 部分失败：n 张中有失败时展示失败摘要（正常 summary 不展示） */}
        {partialFailureNote ? (
          <div
            className="tool-call-imagegen-partial-warning"
            role="alert"
            title={partialFailureNote}
          >
            <AlertCircle size={12} aria-hidden="true" />
            <span>
              {t("toolCall.imagegen.partialFailed")} {partialFailureNote}
            </span>
          </div>
        ) : null}

        {/* 以图为参考重生成（轻量图生图工作台） */}
        {refEdit ? (
          <div className="tool-call-imagegen-edit-panel">
            <span className="tool-call-imagegen-edit-title">
              {t("toolCall.imagegen.refEditTitle")}
            </span>
            <div className="tool-call-imagegen-edit-row">
              <div className="tool-call-imagegen-edit-thumb">
                {refEdit.item.src ? (
                  <img src={refEdit.item.src} alt="" />
                ) : (
                  <ImageIcon size={16} aria-hidden="true" />
                )}
              </div>
              <textarea
                value={refEdit.prompt}
                onChange={(event) =>
                  setRefEdit({ ...refEdit, prompt: event.target.value })
                }
                placeholder={t("toolCall.imagegen.editPromptPlaceholder")}
                rows={2}
              />
            </div>
            <div className="tool-call-imagegen-edit-actions">
              <button
                type="button"
                className="tool-call-imagegen-edit-go"
                onClick={handleRegenerateWithRef}
                disabled={retry.status === "running"}
              >
                <Sparkles size={12} aria-hidden="true" />
                {t("toolCall.imagegen.regenerate")}
              </button>
              <button
                type="button"
                className="tool-call-imagegen-edit-cancel"
                onClick={() => setRefEdit(null)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : null}

        {lightboxElement}
      </div>
    );
  }

  // 生成中（等待/执行/流式预览）：参数区 + 实时预览同框展示，
  // 提示词 / 参考图 / 参数标签不再等生成完成才可见
  const isGenerating =
    !hasError &&
    (toolCall.status === "pending" ||
      toolCall.status === "running" ||
      retry.status === "running");
  if (isGenerating && parsedResult.type !== "success") {
    const latestStream =
      streamingImages.length > 0
        ? streamingImages[streamingImages.length - 1]
        : null;
    return (
      <div className="tool-call-imagegen tool-call-imagegen-result">
        {paramsBlock}
        <div className="tool-call-imagegen-grid tool-call-imagegen-grid-single">
          <figure className={figureClassName} style={figureStyle}>
            <div className="tool-call-imagegen-thumb tool-call-imagegen-thumb-static">
              {latestStream ? (
                <img
                  src={`data:${latestStream.mimeType};base64,${latestStream.data}`}
                  alt={t("toolCall.imagegen.streamingPreview")}
                  onLoad={handleImageLoad(0)}
                />
              ) : (
                <div className="tool-call-imagegen-placeholder">
                  <Loader2
                    className="tool-call-icon-spinning"
                    size={22}
                    aria-hidden="true"
                  />
                  <span>
                    {toolCall.status === "pending" &&
                    runningImageGenCount > 0
                      ? t("toolCall.imagegen.queued", {
                          values: { count: runningImageGenCount },
                        })
                      : toolCall.status === "running"
                      ? t("toolCall.imagegen.generating")
                      : t("toolCall.imagegen.waiting")}
                  </span>
                </div>
              )}
            </div>
            <figcaption className="tool-call-imagegen-figure-caption">
              <span className="tool-call-imagegen-figure-index">
                {streamingImages.length > 0 ? streamingImages.length : "…"}
              </span>
              <span className="tool-call-imagegen-figure-label">
                {latestStream
                  ? t("toolCall.imagegen.streamingPreview")
                  : toolCall.status === "pending" &&
                    runningImageGenCount > 0
                  ? t("toolCall.imagegen.queued", {
                      values: { count: runningImageGenCount },
                    })
                  : toolCall.status === "running"
                  ? t("toolCall.imagegen.generating")
                  : t("toolCall.imagegen.waiting")}
              </span>
              <span aria-hidden="true" />
            </figcaption>
          </figure>
        </div>
      </div>
    );
  }

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.imagegen.name")}
      category="image"
      displayName={prompt ? truncateLabel(prompt, 60) : undefined}
      displayNameTitle={prompt || undefined}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span className="tool-call-imagegen-count">
            <ImageIcon size={10} aria-hidden="true" />
            {t("toolCall.imagegen.count", {
              values: { count: imageCount },
            })}
          </span>
        ) : null
      }
      className="tool-call-imagegen"
    >
      <div className="tool-call-body tool-call-imagegen-body">
        {/* 生图参数（生成中与完成后共用，见上方 paramsBlock） */}
        {paramsBlock}

        {/* 错误：本地化标题 + 原始英文详情（保留后端完整消息与修复建议）；
            重试失败时优先展示重试的错误 */}
        {retry.status === "failed" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span className="tool-call-error-summary">
              <span className="tool-call-error-title">
                {t(
                  imageGenErrorTitleKey(
                    classifyImageGenError(retry.error).kind
                  )
                )}
              </span>
              <span className="tool-call-error-detail">{retry.error}</span>
            </span>
          </div>
        ) : parsedResult.type === "error" && classifiedError ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span className="tool-call-error-summary">
              <span className="tool-call-error-title">
                {t(imageGenErrorTitleKey(classifiedError.kind))}
              </span>
              {classifiedError.detail ? (
                <span className="tool-call-error-detail">
                  {classifiedError.detail}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        {/* 重试：失败后一键用相同参数重新生成 */}
        {retry.status === "failed" || parsedResult.type === "error" ? (
          <button
            type="button"
            className="tool-call-imagegen-retry"
            onClick={() => void handleRetry()}
            disabled={retry.status === "running"}
          >
            <RotateCcw size={12} aria-hidden="true" />
            {retry.status === "running"
              ? t("toolCall.imagegen.retrying")
              : t("toolCall.imagegen.retry")}
          </button>
        ) : null}

        {/* 远程图片链接（兼容返回 url 的端点） */}
        {parsedResult.type === "success" &&
        parsedResult.remoteUrls.length > 0 ? (
          <div className="tool-call-imagegen-remote">
            <span className="tool-call-imagegen-remote-label">
              <Link2 size={10} aria-hidden="true" />
              {t("toolCall.imagegen.remoteUrls")}
            </span>
            {parsedResult.remoteUrls.map((url, index) => (
              <a
                key={url}
                className="tool-call-imagegen-remote-link"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {truncateLabel(url, 80)}
                {index + 1 < parsedResult.remoteUrls.length ? " · " : ""}
              </a>
            ))}
          </div>
        ) : null}

        {/* 原始结果兜底 */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.imagegen.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}
      </div>

      {lightboxElement}
    </ToolCallNode>
  );
};
