import { Copy, ExternalLink, Loader2, Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { ContextMenu } from "../../common/ContextMenu";
import { HoverCopyButton } from "../../common/HoverCopyButton";
import { TextSnippetOverlay } from "./TextSnippetOverlay";
import type { TextSnippetOverlayApi } from "./useTextSnippetOverlay";

export type ImagePreviewState = {
  url: string;
  x: number;
  y: number;
};

export type WebChipMenuState = {
  x: number;
  y: number;
  chip: HTMLElement;
  url: string;
};

export type ChipDetailsState = {
  rows: { label: string; value: string }[];
  content?: string;
  copyText?: string;
  x: number;
  y: number;
};

export type ConversationPreviewState = {
  title: string;
  /** null = 加载中；字符串 = 发送时实际注入的渲染内容 */
  content: string | null;
  /** 加载失败标记 */
  failed?: boolean;
  x: number;
  y: number;
};

type InputOverlayLayerProps = {
  imagePreview: ImagePreviewState | null;
  imageLightbox: string | null;
  setImageLightbox: Dispatch<SetStateAction<string | null>>;
  textSnippetOverlay: TextSnippetOverlayApi;
  webChipMenu: WebChipMenuState | null;
  setWebChipMenu: Dispatch<SetStateAction<WebChipMenuState | null>>;
  chipDetails: ChipDetailsState | null;
  conversationPreview: ConversationPreviewState | null;
  cancelHideChipDetails: () => void;
  scheduleHideChipDetails: () => void;
  cancelHideConversationPreview: () => void;
  scheduleHideConversationPreview: () => void;
  syncContent: () => void;
  onOpenWebChip: (url: string) => void;
};

export const InputOverlayLayer = ({
  imagePreview,
  imageLightbox,
  setImageLightbox,
  textSnippetOverlay,
  webChipMenu,
  setWebChipMenu,
  chipDetails,
  conversationPreview,
  cancelHideChipDetails,
  scheduleHideChipDetails,
  cancelHideConversationPreview,
  scheduleHideConversationPreview,
  syncContent,
  onOpenWebChip,
}: InputOverlayLayerProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <>
      {imagePreview &&
        createPortal(
          <div
            className="image-chip-preview"
            style={{
              left: imagePreview.x,
              top: imagePreview.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
          >
            <img src={imagePreview.url} alt="preview" />
          </div>,
          document.body,
        )}
      {imageLightbox &&
        createPortal(
          <div
            className="image-lightbox-overlay"
            onClick={() => setImageLightbox(null)}
          >
            <img src={imageLightbox} alt="fullscreen" />
          </div>,
          document.body,
        )}
      <TextSnippetOverlay overlay={textSnippetOverlay} />
      {chipDetails &&
        createPortal(
          <div
            className="chip-details-preview"
            style={{
              left: chipDetails.x,
              top: chipDetails.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
            onMouseEnter={cancelHideChipDetails}
            onMouseLeave={scheduleHideChipDetails}
          >
            {chipDetails.rows.length > 0 ? (
              <div className="chip-details-preview-rows">
                {chipDetails.rows.map((row) => (
                  <div className="chip-details-preview-row" key={row.label}>
                    <span className="chip-details-preview-label">
                      {row.label}
                    </span>
                    <span className="chip-details-preview-value">
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {chipDetails.content ? (
              <div className="chip-details-preview-content-wrap">
                <pre
                  className={`chip-details-preview-content${
                    chipDetails.copyText ? " has-copy" : ""
                  }`}
                >
                  {chipDetails.content}
                </pre>
                {chipDetails.copyText ? (
                  <div className="chip-details-preview-copy">
                    <HoverCopyButton text={chipDetails.copyText} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>,
          document.body,
        )}
      {conversationPreview &&
        createPortal(
          <div
            className="conversation-chip-preview"
            style={{
              left: conversationPreview.x,
              top: conversationPreview.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
            onMouseEnter={cancelHideConversationPreview}
            onMouseLeave={scheduleHideConversationPreview}
          >
            <div className="conversation-chip-preview-header">
              <span className="conversation-chip-preview-title">
                <span className="conversation-chip-preview-name">
                  {conversationPreview.title ||
                    t("chatInput.conversationPreviewUntitled", {
                      defaultValue: "未命名会话",
                    })}
                </span>
              </span>
              <span className="conversation-chip-preview-badge">
                {t("chatInput.conversationPreviewBadge", {
                  defaultValue: "引用上下文",
                })}
              </span>
            </div>
            {conversationPreview.content === null ? (
              <div className="conversation-chip-preview-status">
                <Loader2
                  size={13}
                  className="conversation-chip-preview-spinner"
                  aria-hidden="true"
                />
                {t("chatInput.conversationPreviewLoading", {
                  defaultValue: "正在加载会话内容…",
                })}
              </div>
            ) : conversationPreview.failed ? (
              <div className="conversation-chip-preview-status error">
                {t("chatInput.conversationPreviewFailed", {
                  defaultValue: "会话内容加载失败",
                })}
              </div>
            ) : conversationPreview.content.trim() ? (
              <pre className="conversation-chip-preview-content">
                {conversationPreview.content}
              </pre>
            ) : (
              <div className="conversation-chip-preview-status">
                {t("chatInput.conversationPreviewEmpty", {
                  defaultValue: "该会话暂无可注入的内容",
                })}
              </div>
            )}
            <div className="conversation-chip-preview-footer">
              {t("chatInput.conversationPreviewHint", {
                defaultValue:
                  "发送时实际注入的上下文（已清洗思考与工具细节，并按预算裁剪）",
              })}
            </div>
          </div>,
          document.body,
        )}
      {webChipMenu && (
        <ContextMenu
          x={webChipMenu.x}
          y={webChipMenu.y}
          items={[
            {
              id: "web-chip-open",
              label: t("chatInput.webChipOpen", {
                defaultValue: "打开页面",
              }),
              icon: <ExternalLink size={13} strokeWidth={1.8} />,
              onClick: () => {
                onOpenWebChip(webChipMenu.url);
                setWebChipMenu(null);
              },
            },
            {
              id: "web-chip-copy-link",
              label: t("chatInput.webChipCopyLink", {
                defaultValue: "复制链接",
              }),
              icon: <Copy size={13} strokeWidth={1.8} />,
              onClick: () => {
                void window.snow
                  .writeClipboardText(webChipMenu.url)
                  .catch(() => {});
                setWebChipMenu(null);
              },
            },
            {
              id: "web-chip-remove",
              label: t("chatInput.webChipRemove", {
                defaultValue: "移除引用",
              }),
              icon: <Trash2 size={13} strokeWidth={1.8} />,
              onClick: () => {
                webChipMenu.chip.remove();
                setWebChipMenu(null);
                syncContent();
              },
            },
          ]}
          onClose={() => setWebChipMenu(null)}
        />
      )}
    </>
  );
};
