import { useCallback, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useI18n } from "../../../i18n";
import {
  type ChipDetailsState,
  type ConversationPreviewState,
  type ImagePreviewState,
  type WebChipMenuState,
} from "./InputOverlayLayer";
import { base64ToUtf8, type ChangeTag, type CommitTag } from "./fileTagUtils";
import {
  useTextSnippetOverlay,
  type TextSnippetOverlayApi,
} from "./useTextSnippetOverlay";
import { rightPanelEvents } from "../../rightPanel/rightPanelEvents";

/**
 * 会话 chip 悬停预览缓存：避免短时间内反复悬停重复查库渲染。
 * TTL 较短，保证被引用会话新增消息后预览能较快刷新。
 */
type ConversationPreviewCacheEntry = { content: string; at: number };
const conversationPreviewCache = new Map<
  string,
  ConversationPreviewCacheEntry
>();
const CONVERSATION_PREVIEW_CACHE_TTL_MS = 30_000;
/** 悬停防抖：停留片刻才发起加载，鼠标快速掠过不触发。 */
const CONVERSATION_PREVIEW_HOVER_DELAY_MS = 120;
/** 预览浮层宽度（与 styles.css 的 .conversation-chip-preview width 一致），用于水平定位钳制。 */
const CONVERSATION_PREVIEW_WIDTH = 460;

/** 读取会话 chip 的 conversationId；非会话 chip 或数据非法返回 null。 */
const readConversationChipId = (chip: HTMLElement): string | null => {
  if (chip.dataset.conversationTag !== "true") {
    return null;
  }
  try {
    const data = JSON.parse(chip.dataset.conversationData ?? "{}") as {
      conversationId?: string;
    };
    return typeof data.conversationId === "string" &&
      data.conversationId.trim().length > 0
      ? data.conversationId.trim()
      : null;
  } catch {
    return null;
  }
};

type UseChipInteractionsOptions = {
  textareaRef: RefObject<HTMLDivElement | null>;
  syncContent: () => void;
};

export type ChipInteractionsResult = {
  imagePreview: ImagePreviewState | null;
  setImagePreview: Dispatch<SetStateAction<ImagePreviewState | null>>;
  imageLightbox: string | null;
  setImageLightbox: Dispatch<SetStateAction<string | null>>;
  /** 片段 chip 的悬停预览与点击编辑（与提问卡片等复用同一 hook 与浮层）。 */
  textSnippetOverlay: TextSnippetOverlayApi;
  webChipMenu: WebChipMenuState | null;
  setWebChipMenu: Dispatch<SetStateAction<WebChipMenuState | null>>;
  chipDetails: ChipDetailsState | null;
  conversationPreview: ConversationPreviewState | null;
  showImagePreview: (event: React.MouseEvent<HTMLDivElement>) => void;
  scheduleHideImagePreview: () => void;
  handleImageChipClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  showChipDetails: (event: React.MouseEvent<HTMLDivElement>) => void;
  scheduleHideChipDetails: () => void;
  cancelHideChipDetails: () => void;
  showConversationPreview: (event: React.MouseEvent<HTMLDivElement>) => void;
  scheduleHideConversationPreview: () => void;
  cancelHideConversationPreview: () => void;
  handleChipRemove: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleWebChipClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleWebChipContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
};

export const useChipInteractions = ({
  textareaRef,
  syncContent,
}: UseChipInteractionsOptions): ChipInteractionsResult => {
  const { t } = useI18n();
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(
    null,
  );
  const imagePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [imageLightbox, setImageLightbox] = useState<string | null>(null);
  // 片段 chip 的悬停预览与点击编辑走共用 hook（提问卡片复用同一套）。
  const textSnippetOverlay = useTextSnippetOverlay({
    containerRef: textareaRef,
    onChange: syncContent,
  });
  const [webChipMenu, setWebChipMenu] = useState<WebChipMenuState | null>(null);
  const [chipDetails, setChipDetails] = useState<ChipDetailsState | null>(null);
  const chipDetailsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [conversationPreview, setConversationPreview] =
    useState<ConversationPreviewState | null>(null);
  /** 隐藏延迟计时器（与其他浮层一致，给鼠标移入浮层留缓冲）。 */
  const conversationPreviewHideTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  /** 悬停防抖计时器：停留足够时间才展示加载态并发起请求。 */
  const conversationPreviewShowTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  /** 当前悬停的会话 chip；异步请求返回时用它校验结果是否仍应展示。 */
  const conversationPreviewChipRef = useRef<HTMLElement | null>(null);
  /** 当前展示中的预览所属 conversationId（chip 被删除时据此精确匹配并立即隐藏）。 */
  const conversationPreviewShownIdRef = useRef<string | null>(null);

  /** 展示预览并记录其所属会话 id，与 setConversationPreview 配套使用。 */
  const applyConversationPreview = useCallback(
    (conversationId: string, state: ConversationPreviewState) => {
      conversationPreviewShownIdRef.current = conversationId;
      setConversationPreview(state);
    },
    [],
  );

  const showImagePreview = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-image-tag='true']",
      ) as HTMLElement | null;
      if (!chip) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }
      const dataUrl = chip.dataset.imageDataUrl;
      if (!dataUrl) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }
      if (imagePreviewTimerRef.current) {
        clearTimeout(imagePreviewTimerRef.current);
        imagePreviewTimerRef.current = null;
      }
      const rect = chip.getBoundingClientRect();
      const halfW = 328 / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4),
      );
      setImagePreview({ url: dataUrl, x: clampedX, y: rect.top });
    },
    [],
  );

  const scheduleHideImagePreview = useCallback(() => {
    imagePreviewTimerRef.current = setTimeout(() => {
      setImagePreview(null);
    }, 200);
  }, []);

  // 预览浮窗不接收指针（避免盖住上方各行 chip），点击 chip 本身打开大图
  const handleImageChipClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-image-tag='true']",
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const dataUrl = chip.dataset.imageDataUrl;
      if (!dataUrl) {
        return;
      }
      if (imagePreviewTimerRef.current) {
        clearTimeout(imagePreviewTimerRef.current);
        imagePreviewTimerRef.current = null;
      }
      setImagePreview(null);
      setImageLightbox(dataUrl);
    },
    [textareaRef],
  );

  const handleWebChipClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-web-tag='true']",
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.webData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as { url?: string };
        if (parsed.url) {
          rightPanelEvents.emit("open-browser-tab", { url: parsed.url });
        }
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef],
  );

  const handleWebChipContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-web-tag='true']",
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.webData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as { url?: string };
        if (!parsed.url) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setWebChipMenu({
          x: event.clientX,
          y: event.clientY,
          chip,
          url: parsed.url,
        });
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef],
  );

  const showChipDetails = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-file-selection-tag='true'],[data-file-tag='true'],[data-commit-tag='true'],[data-change-tag='true'],[data-review-tag='true'],[data-element-tag='true'],[data-web-tag='true'],[data-command-tag='true'],[data-annotation-tag='true']",
      ) as HTMLElement | null;
      const clear = (): void => {
        if (chipDetailsTimerRef.current) {
          clearTimeout(chipDetailsTimerRef.current);
          chipDetailsTimerRef.current = null;
        }
        setChipDetails(null);
      };
      if (!chip) {
        clear();
        return;
      }
      const rows: { label: string; value: string }[] = [];
      let content: string | undefined;
      let copyText: string | undefined;
      try {
        if (chip.dataset.annotationTag === "true") {
          const data = JSON.parse(chip.dataset.annotationData ?? "{}") as {
            filePath?: string;
            startLine?: number;
            endLine?: number;
            quote?: string;
            content?: string;
          };
          if (data.filePath) {
            rows.push({
              label: t("chatInput.chipDetailsFile"),
              value: data.filePath,
            });
          }
          if (typeof data.startLine === "number" && data.startLine > 0) {
            rows.push({
              label: t("chatInput.chipDetailsLines"),
              value:
                typeof data.endLine === "number" &&
                data.endLine > data.startLine
                  ? `L${data.startLine}-L${data.endLine}`
                  : `L${data.startLine}`,
            });
          }
          const annotationContent = data.content
            ? base64ToUtf8(data.content)
            : "";
          if (annotationContent.trim()) {
            content = annotationContent;
            copyText = annotationContent;
          }
        } else if (chip.dataset.fileSelectionTag === "true") {
          const data = JSON.parse(chip.dataset.fileSelectionData ?? "{}") as {
            path?: string;
            startLine?: number;
            endLine?: number;
            content?: string;
          };
          if (data.path) {
            rows.push({
              label: t("chatInput.chipDetailsFile"),
              value: data.path,
            });
          }
          if (typeof data.startLine === "number" && data.startLine > 0) {
            rows.push({
              label: t("chatInput.chipDetailsLines"),
              value:
                typeof data.endLine === "number" &&
                data.endLine > data.startLine
                  ? `L${data.startLine}-L${data.endLine}`
                  : `L${data.startLine}`,
            });
          }
          const selectionContent = data.content
            ? base64ToUtf8(data.content)
            : "";
          if (selectionContent.trim()) {
            content = selectionContent;
            copyText = selectionContent;
          }
        } else if (chip.dataset.fileTag === "true") {
          const path = chip.dataset.filePath ?? "";
          const isDir = chip.dataset.fileIsDir === "true";
          const lines = chip.dataset.fileLines;
          rows.push({
            label: t(
              isDir
                ? "chatInput.chipDetailsFolder"
                : "chatInput.chipDetailsFile",
            ),
            value: path,
          });
          if (lines) {
            rows.push({ label: t("chatInput.chipDetailsLines"), value: lines });
          }
        } else if (chip.dataset.commitTag === "true") {
          const data = JSON.parse(
            chip.dataset.commitData ?? "{}",
          ) as Partial<CommitTag>;
          rows.push({
            label: t("chatInput.chipDetailsCommit"),
            value: data.shortHash ?? "",
          });
          rows.push({
            label: t("chatInput.chipDetailsAuthor"),
            value: data.author ?? "",
          });
          if (data.date) {
            rows.push({
              label: t("chatInput.chipDetailsDate"),
              value: data.date,
            });
          }
          if (data.repoPath) {
            rows.push({
              label: t("chatInput.chipDetailsRepo"),
              value: data.repoPath,
            });
          }
          if (data.message) {
            content = data.message;
          }
        } else if (chip.dataset.changeTag === "true") {
          const data = JSON.parse(
            chip.dataset.changeData ?? "{}",
          ) as Partial<ChangeTag>;
          const sectionLabel =
            data.section === "staged"
              ? t("chatInput.chipDetailsStaged")
              : t("chatInput.chipDetailsUnstaged");
          rows.push({
            label: t("chatInput.chipDetailsSection"),
            value: data.status
              ? `${sectionLabel} · ${data.status}`
              : sectionLabel,
          });
          rows.push({
            label: t("chatInput.chipDetailsPath"),
            value: data.path ?? "",
          });
          if (data.repoPath) {
            rows.push({
              label: t("chatInput.chipDetailsRepo"),
              value: data.repoPath,
            });
          }
        } else if (chip.dataset.reviewTag === "true") {
          const data = JSON.parse(chip.dataset.reviewData ?? "{}") as {
            prompt?: string;
            summary?: string;
            charCount?: number;
            branch?: string;
            repoPath?: string;
          };
          rows.push({
            label: t("chatInput.chipDetailsSummary"),
            value: data.summary ?? "",
          });
          if (typeof data.charCount === "number") {
            rows.push({
              label: t("chatInput.chipDetailsChars"),
              value: String(data.charCount),
            });
          }
          if (data.branch) {
            rows.push({
              label: t("chatInput.chipDetailsBranch"),
              value: data.branch,
            });
          }
          if (data.repoPath) {
            rows.push({
              label: t("chatInput.chipDetailsRepo"),
              value: data.repoPath,
            });
          }
          if (data.prompt) {
            content = base64ToUtf8(data.prompt);
            copyText = content;
          }
        } else if (chip.dataset.commandTag === "true") {
          // 命令 chip 只预览 prompt 本体，不显示元信息行（卡片更紧凑）。
          const data = JSON.parse(chip.dataset.commandData ?? "{}") as {
            prompt?: string;
          };
          if (data.prompt) {
            content = base64ToUtf8(data.prompt);
            copyText = content;
          }
        } else if (chip.dataset.elementTag === "true") {
          const data = JSON.parse(chip.dataset.elementData ?? "{}") as {
            url?: string;
            tag?: string;
            label?: string;
            text?: string;
            note?: string;
            domTree?: string;
          };
          rows.push({
            label: t("chatInput.chipDetailsTag"),
            value: data.label ?? "",
          });
          if (data.tag) {
            rows.push({
              label: t("chatInput.chipDetailsType"),
              value: data.tag,
            });
          }
          if (data.url) {
            rows.push({
              label: t("chatInput.chipDetailsUrl"),
              value: data.url,
            });
          }
          if (data.note) {
            rows.push({
              label: t("chatInput.chipDetailsNote"),
              value: base64ToUtf8(data.note),
            });
          }
          // 内容区（可滚动）显示元素文本与 DOM 层级树：树为多行结构文本，
          // 放在行式元信息里会撑破卡片高度，故与文本共用内容区。
          const elementText = data.text ? base64ToUtf8(data.text) : "";
          const domTree = data.domTree ? base64ToUtf8(data.domTree) : "";
          content =
            [elementText, domTree].filter(Boolean).join("\n\n") || undefined;
        } else if (chip.dataset.webTag === "true") {
          const data = JSON.parse(chip.dataset.webData ?? "{}") as {
            url?: string;
            title?: string;
          };
          rows.push({
            label: t("chatInput.chipDetailsUrl"),
            value: data.url ?? "",
          });
          if (data.title) {
            rows.push({
              label: t("chatInput.chipDetailsTitle"),
              value: data.title,
            });
          }
        }
      } catch {
        clear();
        return;
      }
      if (rows.length === 0 && !content) {
        clear();
        return;
      }
      if (chipDetailsTimerRef.current) {
        clearTimeout(chipDetailsTimerRef.current);
        chipDetailsTimerRef.current = null;
      }
      const rect = chip.getBoundingClientRect();
      const halfW = 420 / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4),
      );
      setChipDetails({ rows, content, copyText, x: clampedX, y: rect.top });
    },
    [t],
  );

  const scheduleHideChipDetails = useCallback(() => {
    chipDetailsTimerRef.current = setTimeout(() => {
      setChipDetails(null);
    }, 200);
  }, []);

  const cancelHideChipDetails = useCallback(() => {
    if (chipDetailsTimerRef.current) {
      clearTimeout(chipDetailsTimerRef.current);
      chipDetailsTimerRef.current = null;
    }
  }, []);

  const hideConversationPreview = useCallback(() => {
    if (conversationPreviewHideTimerRef.current) {
      clearTimeout(conversationPreviewHideTimerRef.current);
      conversationPreviewHideTimerRef.current = null;
    }
    if (conversationPreviewShowTimerRef.current) {
      clearTimeout(conversationPreviewShowTimerRef.current);
      conversationPreviewShowTimerRef.current = null;
    }
    conversationPreviewChipRef.current = null;
    conversationPreviewShownIdRef.current = null;
    setConversationPreview(null);
  }, []);

  const handleChipRemove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const removeBtn = target.closest("[data-chip-remove='true']");
      if (!removeBtn) {
        return;
      }
      const chip = removeBtn.closest(".file-chip") as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      // 被删除的 chip 若正在悬停预览（或其预览浮层仍在展示），
      // 删除后必须立即隐藏浮层，而不是走 200ms 延迟隐藏。
      const removedConversationId = readConversationChipId(chip);
      const previewBelongsToChip =
        chip === conversationPreviewChipRef.current ||
        (removedConversationId !== null &&
          conversationPreviewShownIdRef.current === removedConversationId);
      chip.remove();
      syncContent();
      if (previewBelongsToChip) {
        hideConversationPreview();
      }
    },
    [hideConversationPreview, syncContent, textareaRef],
  );

  const scheduleHideConversationPreview = useCallback(() => {
    if (conversationPreviewHideTimerRef.current) {
      return;
    }
    conversationPreviewHideTimerRef.current = setTimeout(() => {
      conversationPreviewHideTimerRef.current = null;
      hideConversationPreview();
    }, 200);
  }, [hideConversationPreview]);

  const cancelHideConversationPreview = useCallback(() => {
    if (conversationPreviewHideTimerRef.current) {
      clearTimeout(conversationPreviewHideTimerRef.current);
      conversationPreviewHideTimerRef.current = null;
    }
  }, []);

  /**
   * 悬停会话 chip 时预览「发送时实际注入的上下文内容」。
   *
   * 内容由 Rust 后端 previewConversationAttachment 渲染（与请求组装共用
   * 清洗与预算逻辑，所见即所得）。因内容需查库渲染，展示是异步的：
   * 悬停防抖 -> 加载态浮层 -> 填充内容；结果按 conversationId 缓存 30s。
   */
  const showConversationPreview = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-conversation-tag='true']",
      ) as HTMLElement | null;
      if (!chip) {
        // 悬停点不在会话 chip 上：取消尚未开始的加载；已显示的浮层给
        // 200ms 缓冲（允许鼠标移入浮层继续阅读），到期自动隐藏。
        if (conversationPreviewShowTimerRef.current) {
          clearTimeout(conversationPreviewShowTimerRef.current);
          conversationPreviewShowTimerRef.current = null;
        }
        if (conversationPreviewChipRef.current) {
          conversationPreviewChipRef.current = null;
          scheduleHideConversationPreview();
        }
        return;
      }
      if (chip === conversationPreviewChipRef.current) {
        // 同一 chip 内移动：保持浮层与进行中的加载。
        cancelHideConversationPreview();
        return;
      }

      // 切换到新 chip：放弃上一个 chip 未完成的状态。
      cancelHideConversationPreview();
      if (conversationPreviewShowTimerRef.current) {
        clearTimeout(conversationPreviewShowTimerRef.current);
        conversationPreviewShowTimerRef.current = null;
      }
      conversationPreviewChipRef.current = chip;

      const rawData = chip.dataset.conversationData;
      if (!rawData) {
        hideConversationPreview();
        return;
      }
      let parsed: { conversationId?: string; title?: string };
      try {
        parsed = JSON.parse(rawData) as typeof parsed;
      } catch {
        hideConversationPreview();
        return;
      }
      const conversationId =
        typeof parsed.conversationId === "string"
          ? parsed.conversationId.trim()
          : "";
      if (!conversationId) {
        hideConversationPreview();
        return;
      }
      let title = "";
      if (typeof parsed.title === "string" && parsed.title.length > 0) {
        try {
          title = base64ToUtf8(parsed.title);
        } catch {
          title = "";
        }
      }
      const anchor = (): { x: number; y: number } => {
        const rect = chip.getBoundingClientRect();
        const halfW = CONVERSATION_PREVIEW_WIDTH / 2;
        const clampedX = Math.max(
          halfW + 4,
          Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4),
        );
        return { x: clampedX, y: rect.top };
      };

      const cached = conversationPreviewCache.get(conversationId);
      if (
        cached &&
        Date.now() - cached.at < CONVERSATION_PREVIEW_CACHE_TTL_MS
      ) {
        const { x, y } = anchor();
        applyConversationPreview(conversationId, {
          title,
          content: cached.content,
          x,
          y,
        });
        return;
      }

      const targetChip = chip;
      conversationPreviewShowTimerRef.current = setTimeout(() => {
        conversationPreviewShowTimerRef.current = null;
        if (conversationPreviewChipRef.current !== targetChip) {
          return;
        }
        const { x, y } = anchor();
        applyConversationPreview(conversationId, {
          title,
          content: null,
          x,
          y,
        });
        window.snow
          .previewConversationAttachment(conversationId)
          .then((content) => {
            conversationPreviewCache.set(conversationId, {
              content,
              at: Date.now(),
            });
            if (conversationPreviewChipRef.current !== targetChip) {
              return;
            }
            const pos = anchor();
            applyConversationPreview(conversationId, {
              title,
              content,
              x: pos.x,
              y: pos.y,
            });
          })
          .catch(() => {
            if (conversationPreviewChipRef.current !== targetChip) {
              return;
            }
            const pos = anchor();
            applyConversationPreview(conversationId, {
              title,
              content: "",
              failed: true,
              x: pos.x,
              y: pos.y,
            });
          });
      }, CONVERSATION_PREVIEW_HOVER_DELAY_MS);
    },
    [
      cancelHideConversationPreview,
      hideConversationPreview,
      scheduleHideConversationPreview,
    ],
  );

  return {
    imagePreview,
    setImagePreview,
    imageLightbox,
    setImageLightbox,
    textSnippetOverlay,
    webChipMenu,
    setWebChipMenu,
    chipDetails,
    conversationPreview,
    showImagePreview,
    scheduleHideImagePreview,
    handleImageChipClick,
    showChipDetails,
    scheduleHideChipDetails,
    cancelHideChipDetails,
    showConversationPreview,
    scheduleHideConversationPreview,
    cancelHideConversationPreview,
    handleChipRemove,
    handleWebChipClick,
    handleWebChipContextMenu,
  };
};
