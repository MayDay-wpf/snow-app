import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  FileText,
  GitCommitHorizontal,
  GitCompare,
  Globe,
  Link2,
  MessageSquareQuote,
  MessageSquareText,
  MousePointer2,
  ScanSearch,
  Wand2,
  Workflow,
} from "lucide-react";
import { UserMessageActions } from "./UserMessageActions";
import { HoverCopyButton } from "../../../common/HoverCopyButton";
import { HookExecutionUI } from "../toolCalls/HookExecutionUI";
import type { UserMessageProps } from "../utils/types";
import {
  extractUrlHost,
  formatAnnotationLabel,
  formatFileChipLinesLabel,
  formatFileLinesLabel,
  formatLinesStr,
  formatWorkflowTagLabel,
  parseContentSegments,
} from "../../chatInput/fileTagUtils";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import { getSkillIcon } from "../../../../utils/skillIcons";
import { useI18n } from "../../../../i18n";
import { getPromptStats, renderPromptInline } from "./PromptPreview";

const COLLAPSE_LINES = 6;

export const UserMessage = memo(
  ({
    content,
    timestamp,
    isStreaming,
    canRollback,
    isRollbackPreparing,
    onRollback,
    hookExecutions,
  }: UserMessageProps): React.JSX.Element => {
    const { t } = useI18n();
    const bodyContent = content;
    const segments = parseContentSegments(bodyContent);
    // 规模只统计纯文本，避免编码标签（图片等）虚增字数
    const stats = useMemo(
      () =>
        getPromptStats(
          parseContentSegments(bodyContent)
            .map((segment) => (segment.type === "text" ? segment.content : " "))
            .join(""),
        ),
      [bodyContent],
    );
    const [expanded, setExpanded] = useState(false);
    const [collapsible, setCollapsible] = useState(false);
    const pRef = useRef<HTMLParagraphElement>(null);
    const [imagePreview, setImagePreview] = useState<{
      url: string;
      x: number;
      y: number;
      placement: "up" | "down";
    } | null>(null);
    const [imageLightbox, setImageLightbox] = useState<string | null>(null);
    const imagePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const [textSnippetPreview, setTextSnippetPreview] = useState<{
      content: string;
      copyText?: string;
      x: number;
      y: number;
      placement: "up" | "down";
    } | null>(null);
    const textSnippetPreviewTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);

    const scheduleHideImagePreview = useCallback(() => {
      imagePreviewTimerRef.current = setTimeout(() => {
        setImagePreview(null);
      }, 200);
    }, []);

    const handleImageChipMouseMove = useCallback(
      (event: React.MouseEvent<HTMLSpanElement>, dataUrl: string) => {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const PREVIEW_MAX_W = 328;
        const PREVIEW_MAX_H = 240;
        const PREVIEW_GAP = 8;
        const halfW = PREVIEW_MAX_W / 2;
        const clampedX = Math.max(
          halfW + 4,
          Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4),
        );
        // User 消息可能位于窗口任意位置，预览不能无脑朝上：
        // 上方空间不足时改为朝下显示，避免预览被窗口顶部裁切。
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const placement: "up" | "down" =
          spaceAbove >= PREVIEW_MAX_H + PREVIEW_GAP || spaceAbove >= spaceBelow
            ? "up"
            : "down";
        setImagePreview({
          url: dataUrl,
          x: clampedX,
          y: placement === "up" ? rect.top : rect.bottom,
          placement,
        });
      },
      [],
    );

    const handleImageChipClick = useCallback((dataUrl: string) => {
      setImageLightbox(dataUrl);
      setImagePreview(null);
    }, []);

    const cancelHideTextSnippetPreview = useCallback(() => {
      if (textSnippetPreviewTimerRef.current) {
        clearTimeout(textSnippetPreviewTimerRef.current);
        textSnippetPreviewTimerRef.current = null;
      }
    }, []);

    const scheduleHideTextSnippetPreview = useCallback(() => {
      textSnippetPreviewTimerRef.current = setTimeout(() => {
        setTextSnippetPreview(null);
      }, 200);
    }, []);

    const handleTextSnippetChipMouseMove = useCallback(
      (
        event: React.MouseEvent<HTMLSpanElement>,
        snippetContent: string,
        copyText?: string,
      ) => {
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
          textSnippetPreviewTimerRef.current = null;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const PREVIEW_MAX_W = 440;
        const PREVIEW_MAX_H = 320;
        const PREVIEW_GAP = 8;
        const halfW = PREVIEW_MAX_W / 2;
        const clampedX = Math.max(
          halfW + 4,
          Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4),
        );
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const placement: "up" | "down" =
          spaceAbove >= PREVIEW_MAX_H + PREVIEW_GAP || spaceAbove >= spaceBelow
            ? "up"
            : "down";
        setTextSnippetPreview({
          content: snippetContent,
          copyText,
          x: clampedX,
          y: placement === "up" ? rect.top : rect.bottom,
          placement,
        });
      },
      [],
    );

    useEffect(() => {
      return () => {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
        }
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
        }
      };
    }, []);

    useLayoutEffect(() => {
      const el = pRef.current;
      if (!el) {
        return;
      }
      const measure = () => {
        const computedLineHeight = parseFloat(getComputedStyle(el).lineHeight);
        const lineH =
          Number.isFinite(computedLineHeight) && computedLineHeight > 0
            ? computedLineHeight
            : 21;
        const wasCollapsed = el.classList.contains(
          "user-message-text-collapsed",
        );
        if (wasCollapsed) {
          el.classList.remove("user-message-text-collapsed");
        }
        const fullHeight = el.scrollHeight;
        if (wasCollapsed) {
          el.classList.add("user-message-text-collapsed");
        }
        const nextCollapsible = fullHeight > COLLAPSE_LINES * lineH + 2;
        setCollapsible(nextCollapsible);
        if (!nextCollapsible) {
          setExpanded(false);
        }
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => {
        ro.disconnect();
      };
    }, [content]);

    const isExpanded = collapsible && expanded;
    const collapsed = collapsible && !isExpanded;

    return (
      <div className="user-message-row">
        <article className="user-message-bubble">
          <p
            ref={pRef}
            className={collapsed ? "user-message-text-collapsed" : undefined}
          >
            {segments.map((segment, index) => {
              if (segment.type === "text") {
                return (
                  <span key={index}>
                    {renderPromptInline(segment.content, `${index}-`)}
                  </span>
                );
              }

              if (segment.type === "image") {
                const imgIndex = segment.tag.index ?? 0;
                const imgDisplayName =
                  imgIndex > 0
                    ? `${segment.tag.name} #${imgIndex}`
                    : segment.tag.name;
                return (
                  <span
                    className="user-message-file-chip image-chip"
                    key={index}
                    title={segment.tag.name}
                    onMouseMove={(event) =>
                      handleImageChipMouseMove(event, segment.tag.dataUrl)
                    }
                    onMouseLeave={scheduleHideImagePreview}
                    onClick={() => handleImageChipClick(segment.tag.dataUrl)}
                  >
                    {getFileTypeIcon(segment.tag.name, false, false, {
                      size: 12,
                      className: "user-message-file-chip-icon",
                    })}
                    <span className="user-message-file-chip-name">
                      {imgDisplayName}
                    </span>
                  </span>
                );
              }

              if (segment.type === "commit") {
                const chipTitle = `${segment.tag.shortHash} ${segment.tag.message} (${segment.tag.author}, ${segment.tag.date})`;
                return (
                  <span
                    className="user-message-file-chip commit-chip"
                    key={index}
                    title={chipTitle}
                  >
                    <GitCommitHorizontal
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#f05032" }}
                    />
                    <span className="user-message-file-chip-name">
                      {segment.tag.shortHash}
                    </span>
                  </span>
                );
              }

              if (segment.type === "change") {
                const lastSep = Math.max(
                  segment.tag.path.lastIndexOf("/"),
                  segment.tag.path.lastIndexOf("\\"),
                );
                const changeName =
                  lastSep === -1
                    ? segment.tag.path
                    : segment.tag.path.slice(lastSep + 1);
                const chipTitle = `${
                  segment.tag.section === "staged" ? "Staged" : "Unstaged"
                } ${segment.tag.status} ${segment.tag.path}`;
                return (
                  <span
                    className="user-message-file-chip change-chip"
                    key={index}
                    title={chipTitle}
                  >
                    <GitCompare
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#f59e0b" }}
                    />
                    <span className="user-message-file-chip-name">
                      {changeName}
                    </span>
                  </span>
                );
              }

              if (segment.type === "text-snippet") {
                const snippetTitle = `${segment.tag.summary} (${segment.tag.charCount} chars)`;
                return (
                  <span
                    className="user-message-file-chip text-snippet-chip"
                    key={index}
                    title={snippetTitle}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(event, segment.tag.content)
                    }
                    onMouseLeave={scheduleHideTextSnippetPreview}
                  >
                    <FileText
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#6c757d" }}
                    />
                    <span className="user-message-file-chip-name">
                      {segment.tag.summary}
                    </span>
                  </span>
                );
              }

              if (segment.type === "quote") {
                const quoteTitle = `${segment.tag.summary} (${segment.tag.charCount} chars)`;
                return (
                  <span
                    className="user-message-file-chip quote-chip"
                    key={index}
                    title={quoteTitle}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(event, segment.tag.content)
                    }
                    onMouseLeave={scheduleHideTextSnippetPreview}
                  >
                    <MessageSquareQuote
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "var(--accent-color, #4a9eff)" }}
                    />
                    <span className="user-message-file-chip-name">
                      {segment.tag.summary}
                    </span>
                  </span>
                );
              }

              if (segment.type === "review") {
                const reviewTitle = `${segment.tag.summary} (${segment.tag.charCount} chars)`;
                return (
                  <span
                    className="user-message-file-chip review-chip"
                    key={index}
                    title={reviewTitle}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(
                        event,
                        segment.tag.prompt,
                        segment.tag.prompt,
                      )
                    }
                    onMouseLeave={scheduleHideTextSnippetPreview}
                  >
                    <ScanSearch
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#2ea043" }}
                    />
                    <span className="user-message-file-chip-name">
                      {segment.tag.summary}
                    </span>
                  </span>
                );
              }

              if (segment.type === "element") {
                const displayName = segment.tag.note
                  ? `${segment.tag.label} · ${segment.tag.note}`
                  : segment.tag.label;
                const elementTitle = segment.tag.url
                  ? `${segment.tag.label} (${segment.tag.url})`
                  : segment.tag.label;
                return (
                  <span
                    className="user-message-file-chip element-chip"
                    key={index}
                    title={elementTitle}
                  >
                    <MousePointer2
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#1a73e8" }}
                    />
                    <span className="user-message-file-chip-name">
                      {displayName}
                    </span>
                  </span>
                );
              }

              if (segment.type === "web") {
                const host = extractUrlHost(segment.tag.url);
                const displayName = segment.tag.title
                  ? `${segment.tag.title} · ${host}`
                  : host;
                const webTitle = `${displayName} (${segment.tag.url})`;
                return (
                  <span
                    className="user-message-file-chip web-chip"
                    key={index}
                    title={webTitle}
                  >
                    <Globe
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#0f766e" }}
                    />
                    <span className="user-message-file-chip-name">
                      {displayName}
                    </span>
                  </span>
                );
              }

              if (segment.type === "conversation") {
                const { tag } = segment;
                return (
                  <span
                    className="user-message-file-chip conversation-chip"
                    key={index}
                    title={tag.title}
                  >
                    <Link2
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "var(--accent-color, #4a9eff)" }}
                    />
                    <span className="user-message-file-chip-name">
                      {tag.title}
                    </span>
                  </span>
                );
              }

              if (segment.type === "command") {
                const commandTitle = `/${segment.tag.name} (${segment.tag.charCount} chars)`;
                return (
                  <span
                    className="user-message-file-chip command-chip"
                    key={index}
                    title={commandTitle}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(
                        event,
                        segment.tag.prompt,
                        segment.tag.prompt,
                      )
                    }
                    onMouseLeave={scheduleHideTextSnippetPreview}
                  >
                    <Wand2
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#0891b2" }}
                    />
                    <span className="user-message-file-chip-name">
                      {`/${segment.tag.name}`}
                    </span>
                  </span>
                );
              }

              if (segment.type === "skill") {
                const skillTitle = segment.tag.description
                  ? `${segment.tag.name} - ${segment.tag.description}`
                  : segment.tag.name;
                return (
                  <span
                    className="user-message-file-chip skill-chip"
                    key={index}
                    title={skillTitle}
                  >
                    {getSkillIcon(segment.tag.skillId, {
                      size: 12,
                      className: "user-message-file-chip-icon",
                      style: { color: "var(--accent-secondary)" },
                    })}
                    <span className="user-message-file-chip-name">
                      {segment.tag.name}
                    </span>
                  </span>
                );
              }

              if (segment.type === "annotation") {
                const label = formatAnnotationLabel(segment.tag);
                const annotationTitle = segment.tag.content.trim()
                  ? `${label} - ${segment.tag.content}`
                  : label;
                return (
                  <span
                    className="user-message-file-chip annotation-chip"
                    key={index}
                    title={annotationTitle}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(event, segment.tag.content)
                    }
                    onMouseLeave={scheduleHideTextSnippetPreview}
                  >
                    <MessageSquareText
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "#8b5cf6" }}
                    />
                    <span className="user-message-file-chip-name">{label}</span>
                  </span>
                );
              }

              if (segment.type === "file-selection") {
                const selectionLabel = formatFileLinesLabel(
                  segment.tag.path,
                  segment.tag.startLine,
                  segment.tag.endLine,
                );
                return (
                  <span
                    className="user-message-file-chip file-selection-chip"
                    key={index}
                    title={segment.tag.path}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(event, segment.tag.content)
                    }
                    onMouseLeave={scheduleHideTextSnippetPreview}
                  >
                    {getFileTypeIcon(segment.tag.name, false, false, {
                      size: 12,
                      className: "user-message-file-chip-icon",
                    })}
                    <span className="user-message-file-chip-name">
                      {selectionLabel}
                    </span>
                  </span>
                );
              }

              if (segment.type === "workflow") {
                const workflowStats = t("chat.message.workflowChipStats", {
                  values: {
                    nodes: segment.tag.nodeCount,
                    edges: segment.tag.edgeCount,
                  },
                });
                const workflowPreview = segment.tag.outline
                  ? `${workflowStats}\n\n${segment.tag.outline}`
                  : workflowStats;
                return (
                  <span
                    className="user-message-file-chip workflow-chip"
                    key={index}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(event, workflowPreview)
                    }
                    onMouseLeave={scheduleHideTextSnippetPreview}
                  >
                    <Workflow
                      size={12}
                      className="user-message-file-chip-icon"
                      style={{ color: "var(--accent-color, #4a9eff)" }}
                    />
                    <span className="user-message-file-chip-name">
                      {formatWorkflowTagLabel(segment.tag)}
                    </span>
                    <span className="user-message-file-chip-meta">
                      {workflowStats}
                    </span>
                  </span>
                );
              }

              const { tag } = segment;
              const linesStr =
                !tag.isDirectory && tag.lines && tag.lines.length > 0
                  ? formatLinesStr(tag.lines)
                  : "";
              const chipLinesLabel = tag.isDirectory
                ? ""
                : formatFileChipLinesLabel(tag.lines);
              const fileDisplayName = chipLinesLabel
                ? `${tag.name}:${chipLinesLabel}`
                : tag.name;
              const fileChipTitle = linesStr
                ? `${tag.path}:${linesStr}`
                : tag.path;
              return (
                <span
                  className="user-message-file-chip"
                  key={index}
                  title={fileChipTitle}
                >
                  {getFileTypeIcon(tag.name, tag.isDirectory, false, {
                    size: 12,
                    className: "user-message-file-chip-icon",
                  })}
                  <span className="user-message-file-chip-name">
                    {fileDisplayName}
                  </span>
                </span>
              );
            })}
          </p>
          {collapsible && (
            <button
              type="button"
              className="user-message-toggle"
              aria-expanded={isExpanded}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {isExpanded
                ? t("chat.message.collapse")
                : t("chat.message.expand")}
              <span className="user-message-toggle-stats">
                {t("chat.promptPreview.stats", {
                  values: { chars: stats.chars, lines: stats.lines },
                })}
              </span>
            </button>
          )}
        </article>
        {hookExecutions && hookExecutions.length > 0 ? (
          <HookExecutionUI executions={hookExecutions} />
        ) : null}
        <UserMessageActions
          content={content}
          timestamp={timestamp}
          isStreaming={isStreaming}
          canRollback={canRollback}
          isRollbackPreparing={isRollbackPreparing}
          onRollback={onRollback}
        />
        {imagePreview &&
          createPortal(
            <div
              className="image-chip-preview"
              style={{
                left: imagePreview.x,
                top: imagePreview.y,
                transform:
                  imagePreview.placement === "up"
                    ? "translate(-50%, calc(-100% - 8px))"
                    : "translate(-50%, 8px)",
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
        {textSnippetPreview &&
          createPortal(
            <div
              className="text-snippet-preview"
              style={{
                left: textSnippetPreview.x,
                top: textSnippetPreview.y,
                transform:
                  textSnippetPreview.placement === "up"
                    ? "translate(-50%, calc(-100% - 8px))"
                    : "translate(-50%, 8px)",
              }}
              onMouseEnter={cancelHideTextSnippetPreview}
              onMouseLeave={scheduleHideTextSnippetPreview}
            >
              {textSnippetPreview.copyText ? (
                <div className="text-snippet-preview-toolbar">
                  <HoverCopyButton text={textSnippetPreview.copyText} />
                </div>
              ) : null}
              <pre className="text-snippet-preview-content">
                {textSnippetPreview.content}
              </pre>
            </div>,
            document.body,
          )}
      </div>
    );
  },
);

UserMessage.displayName = "UserMessage";
