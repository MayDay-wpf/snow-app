import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  FileText,
  GitCommitHorizontal,
  GitCompare,
  Globe,
  MousePointer2,
  ScanSearch,
} from "lucide-react";
import { UserMessageActions } from "./UserMessageActions";
import { HookExecutionUI } from "../toolCalls/HookExecutionUI";
import type { UserMessageProps } from "../utils/types";
import {
  extractUrlHost,
  formatLinesStr,
  parseContentSegments,
} from "../../chatInput/fileTagUtils";
import { getFileTypeIcon } from "../../../../utils/fileIcons";

const COLLAPSE_LINES = 6;

export const UserMessage = memo(
  ({
    content,
    isStreaming,
    onRollback,
    hookExecutions,
  }: UserMessageProps): React.JSX.Element => {
    const segments = parseContentSegments(content);
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
      null
    );
    const [textSnippetPreview, setTextSnippetPreview] = useState<{
      content: string;
      x: number;
      y: number;
      placement: "up" | "down";
    } | null>(null);
    const textSnippetPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null
    );

    const cancelHideImagePreview = useCallback(() => {
      if (imagePreviewTimerRef.current) {
        clearTimeout(imagePreviewTimerRef.current);
        imagePreviewTimerRef.current = null;
      }
    }, []);

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
          Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
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
      []
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
      (event: React.MouseEvent<HTMLSpanElement>, snippetContent: string) => {
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
          Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
        );
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const placement: "up" | "down" =
          spaceAbove >= PREVIEW_MAX_H + PREVIEW_GAP || spaceAbove >= spaceBelow
            ? "up"
            : "down";
        setTextSnippetPreview({
          content: snippetContent,
          x: clampedX,
          y: placement === "up" ? rect.top : rect.bottom,
          placement,
        });
      },
      []
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

    useEffect(() => {
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
        setCollapsible(el.scrollHeight > COLLAPSE_LINES * lineH + 2);
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => {
        ro.disconnect();
      };
    }, [content]);

    const collapsed = collapsible && !expanded;

    return (
      <div className="user-message-row">
        <article className="user-message-bubble">
          <p
            ref={pRef}
            className={collapsed ? "user-message-text-collapsed" : undefined}
          >
            {segments.map((segment, index) => {
              if (segment.type === "text") {
                return <span key={index}>{segment.content}</span>;
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
                  segment.tag.path.lastIndexOf("\\")
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
                      handleTextSnippetChipMouseMove(
                        event,
                        segment.tag.content
                      )
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

              if (segment.type === "review") {
                const reviewTitle = `${segment.tag.summary} (${segment.tag.charCount} chars)`;
                return (
                  <span
                    className="user-message-file-chip review-chip"
                    key={index}
                    title={reviewTitle}
                    onMouseMove={(event) =>
                      handleTextSnippetChipMouseMove(event, segment.tag.prompt)
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

              const { tag } = segment;
              const linesStr =
                !tag.isDirectory && tag.lines && tag.lines.length > 0
                  ? formatLinesStr(tag.lines)
                  : "";
              const fileDisplayName = linesStr
                ? `${tag.name}:${linesStr}`
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
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? "收起" : "展开"}
            </button>
          )}
        </article>
        {hookExecutions && hookExecutions.length > 0 ? (
          <HookExecutionUI executions={hookExecutions} />
        ) : null}
        <UserMessageActions
          content={content}
          isStreaming={isStreaming}
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
              onMouseEnter={cancelHideImagePreview}
              onMouseLeave={scheduleHideImagePreview}
              onClick={() => {
                setImageLightbox(imagePreview.url);
                setImagePreview(null);
              }}
            >
              <img src={imagePreview.url} alt="preview" />
            </div>,
            document.body
          )}
        {imageLightbox &&
          createPortal(
            <div
              className="image-lightbox-overlay"
              onClick={() => setImageLightbox(null)}
            >
              <img src={imageLightbox} alt="fullscreen" />
            </div>,
            document.body
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
              <pre className="text-snippet-preview-content">
                {textSnippetPreview.content}
              </pre>
            </div>,
            document.body
          )}
      </div>
    );
  }
);

UserMessage.displayName = "UserMessage";
