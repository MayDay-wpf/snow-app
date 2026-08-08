/**
 * ImageGenGallery —— 并行 imagegen-generate 调用合并画廊。
 *
 * 上游服务商通常不支持单次调用多图（n>1 / prompts 数组），多图场景完全由
 * 并行的独立调用构成。若每个调用各自渲染成单张卡片，会纵向堆叠占用大量
 * 空间；本组件把同一轮并行调用合并为一个统一网格：
 *
 *   - 生成中：每个调用显示占位卡（序号 + loading / 流式预览），一行排开；
 *   - 完成后：图片逐个填充进网格，列数按总数分档（2-4 一张行 / 5-6 三列 /
 *     7-8 四列），整批作为一个图块占满消息可用宽度；
 *   - 失败/空结果：对应格子显示错误摘要或空占位，不影响其他格子。
 */
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
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { downloadImageSrc } from "../../../../utils/imageDownload";
import { imageProxyUrl } from "../../../../utils/imageProxyUrl";
import type { ToolCallInfo } from "../utils/conversationTypes";
import {
  columnsForCount,
  parseImageGenArgs,
  parseImageGenResult,
  truncateLabel,
  type GeneratedImage,
  type LightboxTarget,
} from "./imagegenUtils";

type ImageGenGalleryProps = {
  /** 同一轮并行的 imagegen-generate 调用（≥2 个，由 AiResponse 分组保证）。 */
  toolCalls: ToolCallInfo[];
};

/** 画廊格子：一个调用贡献一格（成功图 / 生成中占位 / 错误 / 空结果）。 */
type GallerySlot =
  | {
      kind: "image";
      key: string;
      src: string;
      /** 本地图存在；远程 URL 条目（remoteUrl）时缺省 */
      image?: GeneratedImage;
      remoteUrl?: string;
      promptLabel: string;
    }
  | {
      kind: "loading";
      key: string;
      status: "pending" | "running";
      streaming: { mimeType: string; data: string } | null;
      promptLabel: string;
    }
  | { kind: "error"; key: string; message: string; promptLabel: string }
  | { kind: "empty"; key: string; promptLabel: string };

/** 远程图加载失败（链接过期/403 等）降级占位；本地图 path 引用经 IPC 解析。 */
const uploadImageCache = new Map<string, string>();

export const ImageGenGallery = ({
  toolCalls,
}: ImageGenGalleryProps): React.JSX.Element => {
  const { t } = useI18n();
  const [lightbox, setLightbox] = useState<LightboxTarget | null>(null);
  /** 灯箱当前图片在 slots 中的索引（-1 = 未打开），同批次切换用 */
  const [lightboxIndex, setLightboxIndex] = useState(-1);

  // 图片真实宽高比探测：slotKey → ratio，加载完成后驱动卡片比例
  const [ratios, setRatios] = useState<Record<string, number>>({});

  const handleImageLoad = useCallback((slotKey: string) => {
    return (event: React.SyntheticEvent<HTMLImageElement>): void => {
      const img = event.currentTarget;
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        return;
      }
      const ratio = img.naturalWidth / img.naturalHeight;
      setRatios((prev) =>
        prev[slotKey] === ratio ? prev : { ...prev, [slotKey]: ratio }
      );
    };
  }, []);

  // 构建展示格：保持调用顺序，每个调用至少贡献一格
  const slots = useMemo<GallerySlot[]>(() => {
    const result: GallerySlot[] = [];
    for (const [callIndex, toolCall] of toolCalls.entries()) {
      const callKey =
        toolCall.interactionId || `imagegen-call-${callIndex}`;
      const promptLabel = parseImageGenArgs(toolCall.arguments)?.prompt ?? "";
      const parsedResult = parseImageGenResult(toolCall.result);

      if (parsedResult.type === "success") {
        const entries: Array<{
          key: string;
          image?: GeneratedImage;
          remoteUrl?: string;
        }> = [];
        for (const [imgIndex, image] of parsedResult.images.entries()) {
          entries.push({
            key: `${callKey}-img-${imgIndex}`,
            image,
          });
        }
        for (const [urlIndex, url] of parsedResult.remoteUrls.entries()) {
          entries.push({
            key: `${callKey}-remote-${urlIndex}`,
            remoteUrl: url,
          });
        }
        if (entries.length === 0) {
          // success 但无图（理论不可达，parseImageGenResult 保证有图才 success），兜底
          result.push({ kind: "empty", key: `${callKey}-empty`, promptLabel });
        } else {
          for (const entry of entries) {
            result.push({
              kind: "image",
              key: entry.key,
              src: "",
              image: entry.image,
              remoteUrl: entry.remoteUrl,
              promptLabel,
            });
          }
        }
      } else if (parsedResult.type === "error") {
        result.push({
          kind: "error",
          key: `${callKey}-error`,
          message: parsedResult.message,
          promptLabel,
        });
      } else if (
        toolCall.status === "pending" ||
        toolCall.status === "running"
      ) {
        const streaming = toolCall.streamingImages ?? [];
        result.push({
          kind: "loading",
          key: `${callKey}-loading`,
          status: toolCall.status,
          streaming:
            streaming.length > 0 ? streaming[streaming.length - 1] : null,
          promptLabel,
        });
      } else {
        // completed 但结果为空/无法解析（raw 兜底）：空占位
        result.push({ kind: "empty", key: `${callKey}-empty`, promptLabel });
      }
    }
    return result;
  }, [toolCalls]);

  // 图库落盘引用（image/... 前缀）→ 经 IPC 读取真实图片数据
  const libraryPaths = useMemo(() => {
    const paths: string[] = [];
    for (const slot of slots) {
      if (
        slot.kind === "image" &&
        slot.image?.path &&
        slot.image.path.startsWith("image/") &&
        !paths.includes(slot.image.path)
      ) {
        paths.push(slot.image.path);
      }
    }
    return paths;
  }, [slots]);

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

  // 远程图加载失败的记录：按 slot key 降级为占位展示
  const [failedRemotes, setFailedRemotes] = useState<Set<string>>(new Set());
  const handleRemoteError = useCallback((key: string) => {
    setFailedRemotes((prev) =>
      prev.has(key) ? prev : new Set(prev).add(key)
    );
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

  // 极端比例适配：超宽通栏展示；超窄限高展示（容器查询按真实比例计算高度）。
  // 注意：合并画廊（多格网格）不做通栏/限高特化 —— 否则超宽图会把整行撑成
  // 单列通栏、破坏并行网格；统一按中位比例在各自格子内 contain 展示。
  const figureClassName = "tool-call-imagegen-figure";
  const figureStyle =
    unifiedRatio !== null
      ? ({ "--img-ar": unifiedRatio } as React.CSSProperties)
      : undefined;

  // 灯箱：挂载到 document.body，确保 fixed 定位始终相对视口居中
  /** 同批次可切换的图片格索引（仅 kind === "image"；loading/error/empty 跳过） */
  const navigableSlots = useMemo(
    () =>
      slots
        .map((slot, index) => (slot.kind === "image" ? index : -1))
        .filter((index) => index >= 0),
    [slots]
  );

  /** 灯箱在同批次图片间切换（delta ±1），越界不响应 */
  const lightboxDelta = useCallback(
    (delta: number): void => {
      if (lightboxIndex < 0) {
        return;
      }
      const current = navigableSlots.indexOf(lightboxIndex);
      if (current < 0) {
        return;
      }
      const next = navigableSlots[current + delta];
      if (next === undefined) {
        return;
      }
      const slot = slots[next];
      if (slot.kind !== "image") {
        return;
      }
      setLightbox(
        slot.image
          ? { kind: "image", image: slot.image }
          : { kind: "remote", url: slot.remoteUrl! }
      );
      setLightboxIndex(next);
    },
    [lightboxIndex, navigableSlots, slots]
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

  // 灯箱打开时若图片数据尚未解析（path 引用），立即兜底解析
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
            disabled={
              lightboxIndex < 0 || navigableSlots.indexOf(lightboxIndex) <= 0
            }
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
              lightboxIndex < 0 ||
              navigableSlots.indexOf(lightboxIndex) >=
                navigableSlots.length - 1
            }
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
          <div
            className="tool-call-imagegen-lightbox-toolbar"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="image-library-lightbox-meta">
              {lightboxIndex >= 0 && navigableSlots.length > 0
                ? `${navigableSlots.indexOf(lightboxIndex) + 1} / ${
                    navigableSlots.length
                  }`
                : ""}
            </span>
            <button
              type="button"
              className="tool-call-imagegen-download"
              onClick={() => {
                void (async () => {
                  let src = lightboxSrc;
                  if (
                    !src &&
                    lightbox.kind === "image" &&
                    lightbox.image.path
                  ) {
                    src =
                      (await window.snow.resolveLibraryImage(
                        lightbox.image.path
                      )) ?? "";
                  }
                  if (src) {
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

  const slotCount = slots.length;

  // 生成中占位内容：有流式预览显示预览图，否则 loading 图标 + 状态文案
  const renderLoadingContent = (slot: Extract<GallerySlot, { kind: "loading" }>) =>
    slot.streaming ? (
      <img
        src={`data:${slot.streaming.mimeType};base64,${slot.streaming.data}`}
        alt={t("toolCall.imagegen.streamingPreview")}
        onLoad={handleImageLoad(slot.key)}
      />
    ) : (
      <div className="tool-call-imagegen-placeholder">
        <Loader2
          className="tool-call-icon-spinning"
          size={22}
          aria-hidden="true"
        />
        <span>
          {slot.status === "running"
            ? t("toolCall.imagegen.generating")
            : t("toolCall.imagegen.waiting")}
        </span>
      </div>
    );

  // 格子图注标签：成功显示 prompt 截断，生成中显示状态，错误显示摘要
  const slotLabel = (slot: GallerySlot): string => {
    switch (slot.kind) {
      case "loading":
        return slot.streaming
          ? t("toolCall.imagegen.streamingPreview")
          : slot.status === "running"
            ? t("toolCall.imagegen.generating")
            : t("toolCall.imagegen.waiting");
      case "error":
        return truncateLabel(slot.message, 24);
      case "empty":
        return t("toolCall.imagegen.result");
      case "image":
        return truncateLabel(slot.promptLabel, 24);
    }
  };

  return (
    <div className="tool-call-imagegen tool-call-imagegen-result tool-call-imagegen-gallery">
      <div
        className="tool-call-imagegen-grid tool-call-imagegen-gallery-grid"
        data-count={slotCount}
        style={{
          gridTemplateColumns: `repeat(${Math.max(
            2,
            columnsForCount(slotCount)
          )}, minmax(0, 1fr))`,
        }}
      >
        {slots.map((slot, index) => {
          const isImage = slot.kind === "image";
          const failed =
            isImage && slot.remoteUrl
              ? failedRemotes.has(slot.key)
              : false;
          const resolvedSrc =
            isImage && slot.image?.path
              ? (resolvedLibrary[slot.image.path] ?? "")
              : isImage && slot.image?.data
                ? `data:${slot.image.mimeType};base64,${slot.image.data}`
                : isImage && slot.remoteUrl
                  ? imageProxyUrl(slot.remoteUrl)
                  : "";
          return (
            <figure
              key={slot.key}
              className={figureClassName}
              style={figureStyle}
            >
              <button
                type="button"
                className={`tool-call-imagegen-thumb${
                  isImage ? "" : " tool-call-imagegen-thumb-static"
                }`}
                onClick={() => {
                  if (!isImage) {
                    return;
                  }
                  if (failed && slot.remoteUrl) {
                    // 链接已失效：直接打开原始 URL（浏览器可尝试重试/登录）
                    window.open(
                      slot.remoteUrl,
                      "_blank",
                      "noopener,noreferrer"
                    );
                    return;
                  }
                  slot.image
                    ? setLightbox({ kind: "image", image: slot.image })
                    : setLightbox({ kind: "remote", url: slot.remoteUrl! });
                  setLightboxIndex(index);
                }}
                title={
                  isImage ? t("toolCall.imagegen.zoom") : undefined
                }
                aria-label={
                  isImage
                    ? t("toolCall.imagegen.zoom")
                    : `${t("toolCall.imagegen.name")} ${index + 1}`
                }
              >
                {slot.kind === "image" ? (
                  failed ? (
                    <div className="tool-call-imagegen-remote-fallback">
                      <Link2 size={18} aria-hidden="true" />
                      <span>{t("toolCall.imagegen.remoteFailed")}</span>
                    </div>
                  ) : (
                    <img
                      src={resolvedSrc}
                      alt={`${t("toolCall.imagegen.generatedImage")} ${
                        index + 1
                      }`}
                      onLoad={handleImageLoad(slot.key)}
                      onError={
                        slot.remoteUrl
                          ? () => handleRemoteError(slot.key)
                          : undefined
                      }
                    />
                  )
                ) : slot.kind === "loading" ? (
                  renderLoadingContent(slot)
                ) : slot.kind === "error" ? (
                  <div className="tool-call-imagegen-placeholder">
                    <AlertCircle size={20} aria-hidden="true" />
                    <span>{truncateLabel(slot.message, 40)}</span>
                  </div>
                ) : (
                  <div className="tool-call-imagegen-placeholder">
                    <ImageIcon size={20} aria-hidden="true" />
                    <span>{t("toolCall.imagegen.result")}</span>
                  </div>
                )}
                <span className="tool-call-imagegen-badge">{index + 1}</span>
              </button>
              <figcaption className="tool-call-imagegen-figure-caption">
                <span className="tool-call-imagegen-figure-index">
                  {index + 1}
                </span>
                <span
                  className="tool-call-imagegen-figure-label"
                  title={
                    slot.kind === "image"
                      ? slot.promptLabel
                      : slot.kind === "error"
                        ? slot.message
                        : undefined
                  }
                >
                  {slotLabel(slot)}
                </span>
                <span aria-hidden="true" />
              </figcaption>
            </figure>
          );
        })}
      </div>

      {lightboxElement}
    </div>
  );
};
