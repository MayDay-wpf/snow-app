import {
  memo,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Download,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Settings,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { DrawingPromptExamples } from "./DrawingPromptExamples";
import {
  imageGenErrorTitleKey,
  type ClassifiedImageGenError,
  type ImageGenErrorKind,
} from "../mainContent/chatMessages/toolCalls/imagegenUtils";
import type { DrawingGalleryItem, StreamingImageItem } from "./drawingTypes";

/** 流式预览图项。 */
export type { StreamingImageItem };

/** 画廊展示项（与工作台共享同一结构）。 */
export type CanvasGalleryItem = DrawingGalleryItem;

export type DrawingCanvasAreaProps = {
  isGenerating: boolean;
  streamingItems: StreamingImageItem[];
  count: number;
  ratio: string;
  hasError: boolean;
  errorInfo: ClassifiedImageGenError | null;
  errorIconComponent: ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }> | null;
  showErrorSettingsButton: boolean;
  onOpenImageGenSettings?: () => void;
  resultRawText: string | null;
  resultItems: CanvasGalleryItem[];
  lastDurationMs: number;
  saving: boolean;
  handleSaveAll: () => Promise<void>;
  handleSaveOne: (item: CanvasGalleryItem) => Promise<void>;
  openLightbox: (items: CanvasGalleryItem[], index: number) => void;
  showEmptyHint: boolean;
  onPickExamplePrompt: (example: string) => void;
  handleGenerate: () => Promise<void>;
  errorHintKey: (kind: ImageGenErrorKind) => string;
  renderLibraryImage: (props: {
    path?: string;
    src?: string;
    alt: string;
    onClick?: () => void;
  }) => ReactNode;
};

/**
 * 依据比例字符串映射到全局集中定义的 CSS aspect-ratio 类名，杜绝内联 style。
 */
export const getRatioClassName = (ratioStr: string): string => {
  const normalized = ratioStr.trim().replace(/[:×x]/g, "-");
  switch (normalized) {
    case "16-9":
      return "ai-drawing-ratio-16-9";
    case "9-16":
      return "ai-drawing-ratio-9-16";
    case "4-3":
      return "ai-drawing-ratio-4-3";
    case "3-4":
      return "ai-drawing-ratio-3-4";
    case "3-2":
      return "ai-drawing-ratio-3-2";
    case "2-3":
      return "ai-drawing-ratio-2-3";
    case "21-9":
      return "ai-drawing-ratio-21-9";
    case "2-1":
      return "ai-drawing-ratio-2-1";
    case "1-2":
      return "ai-drawing-ratio-1-2";
    case "5-4":
      return "ai-drawing-ratio-5-4";
    case "4-5":
      return "ai-drawing-ratio-4-5";
    case "1-1":
    default:
      return "ai-drawing-ratio-1-1";
  }
};

/**
 * 单张动态模拟渲染与骨架占位卡片。
 * 在后端生成响应前，预先渲染完整卡片形状，并以平滑优雅的极光流光、
 * 潜空间脉冲同心环与采样微动效呈现现代化 AI 绘图沉浸感。
 */
const GenerativeSkeletonCard = memo(function GenerativeSkeletonCard({
  index,
  total,
  streaming,
  ratioClass,
  t,
}: {
  index: number;
  total: number;
  streaming?: StreamingImageItem;
  ratioClass: string;
  t: (key: string, options?: { defaultValue?: string }) => string;
}): React.JSX.Element {
  const [phaseIndex, setPhaseIndex] = useState(0);

  // 动态模拟采样阶段（纯动画视觉状态切换：采样 → 合成 → 细节）
  useEffect(() => {
    const timer1 = window.setTimeout(() => setPhaseIndex(1), 2200);
    const timer2 = window.setTimeout(() => setPhaseIndex(2), 5200);
    return () => {
      window.clearTimeout(timer1);
      window.clearTimeout(timer2);
    };
  }, []);

  const phaseLabel =
    phaseIndex === 0
      ? t("rightPanel.aiDrawing.simulatingPhase1", {
          defaultValue: "潜空间采样",
        })
      : phaseIndex === 1
        ? t("rightPanel.aiDrawing.simulatingPhase2", {
            defaultValue: "结构合成",
          })
        : t("rightPanel.aiDrawing.simulatingPhase3", {
            defaultValue: "细节渲染",
          });

  const cardIndexPadded = String(index + 1).padStart(2, "0");
  const totalPadded = String(total).padStart(2, "0");

  if (streaming) {
    return (
      <div
        className={`ai-drawing-gallery-item ai-drawing-gallery-item-streaming ${ratioClass}`}
      >
        <img
          src={`data:${streaming.mimeType};base64,${streaming.data}`}
          alt={t("toolCall.imagegen.streamingPreview", {
            defaultValue: "Generating… preview",
          })}
        />
        <div className="ai-drawing-skeleton-badge">
          <span className="ai-drawing-skeleton-dot" />
          <span>{`${cardIndexPadded}/${totalPadded} · ${t("toolCall.imagegen.streamingPreview", { defaultValue: "流式预览" })}`}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`ai-drawing-gallery-item ai-drawing-skeleton-card ${ratioClass}`}
      aria-busy="true"
    >
      {/* 极光流光扫射光带 */}
      <div className="ai-drawing-skeleton-shimmer" />

      {/* 潜空间微细扫描线 */}
      <div className="ai-drawing-skeleton-scanlines" />

      {/* 潜空间凝聚中心波纹 */}
      <div className="ai-drawing-skeleton-core">
        <div className="ai-drawing-skeleton-ring ai-drawing-skeleton-ring-outer" />
        <div className="ai-drawing-skeleton-ring ai-drawing-skeleton-ring-inner" />
        <div className="ai-drawing-skeleton-sparkle">
          <Sparkles size={18} strokeWidth={1.8} />
        </div>
      </div>

      {/* 仿真阶段状态徽标 */}
      <div className="ai-drawing-skeleton-badge">
        <span className="ai-drawing-skeleton-dot" />
        <span>{`${cardIndexPadded}/${totalPadded} · ${phaseLabel}`}</span>
      </div>

      {/* 卡片底纹微光感 */}
      <div className="ai-drawing-skeleton-bottom-glow" />
    </div>
  );
});

export const DrawingCanvasArea = memo(function DrawingCanvasArea({
  isGenerating,
  streamingItems,
  count,
  ratio,
  hasError,
  errorInfo,
  errorIconComponent,
  showErrorSettingsButton,
  onOpenImageGenSettings,
  resultRawText,
  resultItems,
  lastDurationMs,
  saving,
  handleSaveAll,
  handleSaveOne,
  openLightbox,
  showEmptyHint,
  onPickExamplePrompt,
  handleGenerate,
  errorHintKey,
  renderLibraryImage,
}: DrawingCanvasAreaProps): React.JSX.Element {
  const { t } = useI18n();
  const ratioClass = getRatioClassName(ratio);

  // 1. 生成中状态：无论是否流式，瞬时渲染 count 个卡片骨架槽位，并带动态模拟渲染
  if (isGenerating) {
    const slots = Array.from({ length: Math.max(1, count) }, (_, i) => i);
    return (
      <>
        <div className="ai-drawing-status ai-drawing-status-generating">
          <Loader2 size={16} strokeWidth={1.8} className="ai-drawing-spin" />
          <span>
            {streamingItems.length > 0
              ? t("toolCall.imagegen.streamingPreview", {
                  defaultValue: "Generating… preview",
                })
              : t("rightPanel.aiDrawing.generatingDetail")}
          </span>
          {count > 1 && (
            <span className="ai-drawing-streaming-count">
              {streamingItems.length > 0
                ? `${streamingItems.length} / ${count}`
                : `${count} 张`}
            </span>
          )}
        </div>
        <div className="ai-drawing-gallery">
          {slots.map((slotIndex) => {
            const streaming = streamingItems.find(
              (item) => item.index === slotIndex,
            );
            return (
              <GenerativeSkeletonCard
                key={`skeleton-slot-${slotIndex}`}
                index={slotIndex}
                total={count}
                streaming={streaming}
                ratioClass={ratioClass}
                t={t}
              />
            );
          })}
        </div>
      </>
    );
  }

  // 2. 错误卡片状态
  if (hasError && errorInfo && errorIconComponent) {
    const Icon = errorIconComponent;
    return (
      <div className="ai-drawing-error">
        <div className="ai-drawing-error-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={1.8} />
        </div>
        <div className="ai-drawing-error-body">
          <span className="ai-drawing-error-title">
            {t(imageGenErrorTitleKey(errorInfo.kind))}
          </span>
          <span className="ai-drawing-error-hint">
            {t(errorHintKey(errorInfo.kind))}
          </span>
          <span className="ai-drawing-error-detail">{errorInfo.detail}</span>
          <div className="ai-drawing-error-actions">
            <button
              type="button"
              className="ai-drawing-error-btn ai-drawing-error-btn-retry"
              onClick={() => void handleGenerate()}
            >
              <RefreshCw size={12} strokeWidth={1.8} />
              <span>{t("rightPanel.aiDrawing.retry")}</span>
            </button>
            {showErrorSettingsButton && (
              <button
                type="button"
                className="ai-drawing-error-btn"
                onClick={onOpenImageGenSettings}
              >
                <Settings size={12} strokeWidth={1.8} />
                <span>{t("rightPanel.aiDrawing.openSettings")}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 3. 兜底错误文本
  if (resultRawText) {
    return (
      <div className="ai-drawing-error">
        <div className="ai-drawing-error-icon" aria-hidden="true">
          <XCircle size={18} strokeWidth={1.8} />
        </div>
        <div className="ai-drawing-error-body">
          <span className="ai-drawing-error-title">
            {t("toolCall.imagegen.error.fallback", {
              defaultValue: "Image generation failed",
            })}
          </span>
          <span className="ai-drawing-error-hint">
            {t(errorHintKey("fallback"))}
          </span>
          <span className="ai-drawing-error-detail">
            {resultRawText.slice(0, 600)}
          </span>
        </div>
      </div>
    );
  }

  // 4. 成品图片画廊（带 Progressive Reveal 平滑入场动效）
  if (resultItems.length > 0) {
    return (
      <>
        <div className="ai-drawing-result-header">
          <span className="ai-drawing-result-title">
            <Sparkles size={13} strokeWidth={1.8} />
            <span>
              {t("toolCall.imagegen.result", { defaultValue: "Result" })}
            </span>
            <span className="ai-drawing-history-count">
              {t("rightPanel.aiDrawing.resultCount", {
                values: { count: resultItems.length },
              })}
            </span>
            {lastDurationMs > 0 && (
              <span className="ai-drawing-result-duration">
                {t("rightPanel.aiDrawing.duration", {
                  values: { seconds: (lastDurationMs / 1000).toFixed(1) },
                })}
              </span>
            )}
          </span>
          <button
            type="button"
            className="ai-drawing-save-all-btn"
            disabled={saving}
            title={t("toolCall.imagegen.downloadAll", {
              defaultValue: "Save all",
            })}
            onClick={() => void handleSaveAll()}
          >
            {saving ? (
              <Loader2
                size={13}
                strokeWidth={1.8}
                className="ai-drawing-spin"
              />
            ) : (
              <Download size={13} strokeWidth={1.8} />
            )}
            <span>
              {t("toolCall.imagegen.downloadAll", {
                defaultValue: "Save all",
              })}
            </span>
          </button>
        </div>

        <div className="ai-drawing-gallery">
          {resultItems.map((item, itemIdx) => (
            <div
              className={`ai-drawing-gallery-item ai-drawing-card-reveal ${ratioClass}`}
              key={item.key}
            >
              {renderLibraryImage({
                path: item.path,
                src: item.path ? undefined : item.src,
                alt: t("toolCall.imagegen.generatedImage", {
                  defaultValue: "Generated image",
                }),
                onClick: () => openLightbox(resultItems, itemIdx),
              })}
              {/* 成品卡片角标序号 */}
              <div className="ai-drawing-gallery-item-badge">
                {String(itemIdx + 1).padStart(2, "0")}
              </div>
              <div className="ai-drawing-gallery-actions">
                <button
                  type="button"
                  className="ai-drawing-img-action"
                  title={t("toolCall.imagegen.zoom", {
                    defaultValue: "Zoom image",
                  })}
                  onClick={() => openLightbox(resultItems, itemIdx)}
                >
                  <ImageIcon size={13} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="ai-drawing-img-action"
                  title={t("toolCall.imagegen.download", {
                    defaultValue: "Save image",
                  })}
                  onClick={() => void handleSaveOne(item)}
                >
                  <Download size={13} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  // 5. 空状态提示
  if (showEmptyHint) {
    return (
      <div className="ai-drawing-status ai-drawing-status-empty">
        <span className="ai-drawing-empty-title">
          {t("rightPanel.aiDrawing.emptyHint")}
        </span>
        <span className="ai-drawing-empty-sub">
          {t("rightPanel.aiDrawing.emptyHintSub")}
        </span>
        <DrawingPromptExamples onPick={onPickExamplePrompt} />
      </div>
    );
  }

  return <></>;
});
