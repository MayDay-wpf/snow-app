import {
  ArrowUp,
  Clock,
  CornerDownRight,
  FileText,
  GitCommitHorizontal,
  GitCompare,
  Globe,
  Link2,
  MessageSquareQuote,
  MessageSquareText,
  MousePointer2,
  ScanSearch,
  Undo2,
  Wand2,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import {
  extractUrlHost,
  formatAnnotationLabel,
  formatFileChipLinesLabel,
  formatFileLinesLabel,
  formatLinesStr,
  formatWorkflowTagLabel,
  parseContentSegments,
  type ContentSegment,
} from "./fileTagUtils";
import { getFileTypeIcon } from "../../../utils/fileIcons";
import { getSkillIcon } from "../../../utils/skillIcons";

type PendingMessagesProps = {
  messages: string[];
  modes?: ("queue" | "steer")[];

  onWithdraw?: (index: number) => string | null;
  onSendNow?: (index: number) => void;
};

/**
 * 将编码后的消息内容（含 @@file/@@image/@@commit/@@change/@@text-snippet@@
 * 等标签）解析为分段并渲染：标签显示为 chip，其余为纯文本。
 */
const renderSegments = (content: string): React.ReactNode => {
  const segments = parseContentSegments(content);
  return segments.map((segment: ContentSegment, index: number) => {
    if (segment.type === "text") {
      return <span key={index}>{segment.content}</span>;
    }

    if (segment.type === "image") {
      const imgIndex = segment.tag.index ?? 0;
      const displayName =
        imgIndex > 0 ? `${segment.tag.name} #${imgIndex}` : segment.tag.name;
      return (
        <span
          key={index}
          className="user-message-file-chip image-chip"
          title={displayName}
        >
          {getFileTypeIcon(segment.tag.name, false, false, {
            size: 12,
            className: "user-message-file-chip-icon",
          })}
          <span className="user-message-file-chip-name">{displayName}</span>
        </span>
      );
    }

    if (segment.type === "commit") {
      const { tag } = segment;
      const chipTitle = `${tag.shortHash} ${tag.message} (${tag.author}, ${tag.date})`;
      return (
        <span
          key={index}
          className="user-message-file-chip commit-chip"
          title={chipTitle}
        >
          <GitCommitHorizontal
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#f05032" }}
          />
          <span className="user-message-file-chip-name">{tag.shortHash}</span>
        </span>
      );
    }

    if (segment.type === "change") {
      const { tag } = segment;
      const lastSep = Math.max(
        tag.path.lastIndexOf("/"),
        tag.path.lastIndexOf("\\"),
      );
      const changeName =
        lastSep === -1 ? tag.path : tag.path.slice(lastSep + 1);
      const chipTitle = `${tag.section === "staged" ? "Staged" : "Unstaged"} ${
        tag.status
      } ${tag.path}`;
      return (
        <span
          key={index}
          className="user-message-file-chip change-chip"
          title={chipTitle}
        >
          <GitCompare
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#f59e0b" }}
          />
          <span className="user-message-file-chip-name">{changeName}</span>
        </span>
      );
    }

    if (segment.type === "text-snippet") {
      const { tag } = segment;
      const snippetTitle = `${tag.summary} (${tag.charCount} chars)`;
      return (
        <span
          key={index}
          className="user-message-file-chip text-snippet-chip"
          title={snippetTitle}
        >
          <FileText
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#6c757d" }}
          />
          <span className="user-message-file-chip-name">{tag.summary}</span>
        </span>
      );
    }

    if (segment.type === "quote") {
      const { tag } = segment;
      const quoteTitle = `${tag.summary} (${tag.charCount} chars)`;
      return (
        <span
          key={index}
          className="user-message-file-chip quote-chip"
          title={quoteTitle}
        >
          <MessageSquareQuote
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "var(--accent-color, #4a9eff)" }}
          />
          <span className="user-message-file-chip-name">{tag.summary}</span>
        </span>
      );
    }

    if (segment.type === "review") {
      const { tag } = segment;
      const reviewTitle = `${tag.summary} (${tag.charCount} chars)`;
      return (
        <span
          key={index}
          className="user-message-file-chip review-chip"
          title={reviewTitle}
        >
          <ScanSearch
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#2ea043" }}
          />
          <span className="user-message-file-chip-name">{tag.summary}</span>
        </span>
      );
    }

    if (segment.type === "element") {
      const { tag } = segment;
      const displayName = tag.note ? `${tag.label} · ${tag.note}` : tag.label;
      const elementTitle = tag.url ? `${tag.label} (${tag.url})` : tag.label;
      return (
        <span
          key={index}
          className="user-message-file-chip element-chip"
          title={elementTitle}
        >
          <MousePointer2
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#1a73e8" }}
          />
          <span className="user-message-file-chip-name">{displayName}</span>
        </span>
      );
    }

    if (segment.type === "web") {
      const { tag } = segment;
      const host = extractUrlHost(tag.url);
      const displayName = tag.title ? `${tag.title} · ${host}` : host;
      const webTitle = `${displayName} (${tag.url})`;
      return (
        <span
          key={index}
          className="user-message-file-chip web-chip"
          title={webTitle}
        >
          <Globe
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#0f766e" }}
          />
          <span className="user-message-file-chip-name">{displayName}</span>
        </span>
      );
    }

    if (segment.type === "conversation") {
      const { tag } = segment;
      return (
        <span
          key={index}
          className="user-message-file-chip conversation-chip"
          title={tag.title}
        >
          <Link2
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "var(--accent-color, #4a9eff)" }}
          />
          <span className="user-message-file-chip-name">{tag.title}</span>
        </span>
      );
    }

    if (segment.type === "command") {
      const { tag } = segment;
      const commandTitle = `/${tag.name} (${tag.charCount} chars)`;
      return (
        <span
          key={index}
          className="user-message-file-chip command-chip"
          title={commandTitle}
        >
          <Wand2
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#0891b2" }}
          />
          <span className="user-message-file-chip-name">{`/${tag.name}`}</span>
        </span>
      );
    }

    if (segment.type === "skill") {
      const skillTitle = segment.tag.description
        ? `${segment.tag.name} - ${segment.tag.description}`
        : segment.tag.name;
      return (
        <span
          key={index}
          className="user-message-file-chip skill-chip"
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
      return (
        <span
          key={index}
          className="user-message-file-chip annotation-chip"
          title={segment.tag.content}
        >
          <MessageSquareText
            size={12}
            className="user-message-file-chip-icon"
            style={{ color: "#8b5cf6" }}
          />
          <span className="user-message-file-chip-name">
            {formatAnnotationLabel(segment.tag)}
          </span>
        </span>
      );
    }

    if (segment.type === "file-selection") {
      return (
        <span
          key={index}
          className="user-message-file-chip file-selection-chip"
          title={segment.tag.path}
        >
          {getFileTypeIcon(segment.tag.name, false, false, {
            size: 12,
            className: "user-message-file-chip-icon",
          })}
          <span className="user-message-file-chip-name">
            {formatFileLinesLabel(
              segment.tag.path,
              segment.tag.startLine,
              segment.tag.endLine,
            )}
          </span>
        </span>
      );
    }

    if (segment.type === "workflow") {
      return (
        <span
          key={index}
          className="user-message-file-chip workflow-chip"
          title={segment.tag.outline}
        >
          <Workflow size={12} className="user-message-file-chip-icon" />
          <span className="user-message-file-chip-name">
            {formatWorkflowTagLabel(segment.tag)}
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
    const displayName = chipLinesLabel
      ? `${tag.name}:${chipLinesLabel}`
      : tag.name;
    const chipTitle = linesStr ? `${tag.path}:${linesStr}` : tag.path;
    return (
      <span key={index} className="user-message-file-chip" title={chipTitle}>
        {getFileTypeIcon(tag.name, tag.isDirectory, false, {
          size: 12,
          className: "user-message-file-chip-icon",
        })}
        <span className="user-message-file-chip-name">{displayName}</span>
      </span>
    );
  });
};

export const PendingMessages = ({
  messages,
  modes,
  onWithdraw,
  onSendNow,
}: PendingMessagesProps): React.JSX.Element | null => {
  const { t } = useI18n();

  if (messages.length === 0) {
    return null;
  }

  const handleWithdraw = (index: number) => {
    if (!onWithdraw) {
      return;
    }
    const restored = onWithdraw(index);
    if (!restored) {
      return;
    }
  };

  const handleSendNow = (index: number) => {
    if (!onSendNow) {
      return;
    }
    onSendNow(index);
  };

  return (
    <div
      className="pending-messages-area"
      role="status"
      aria-live="polite"
      aria-label={t("chatInput.pendingLabel")}
    >
      <ul className="pending-messages-list">
        {messages.map((msg, index) => {
          const isSteer = modes?.[index] === "steer";
          const modeKey = `chatInput.pendingSource.user${
            isSteer ? "Steer" : "Queue"
          }`;
          const ItemIcon = isSteer ? CornerDownRight : Clock;
          return (
            <li key={index} className="pending-message-item is-user">
              <ItemIcon size={14} className="pending-message-icon" />

              <span className="pending-message-text">
                {renderSegments(msg)}
              </span>
              <span className="pending-message-mode">{t(modeKey)}</span>
              {onSendNow && (
                <button
                  type="button"
                  className="pending-message-send-now"
                  onClick={() => handleSendNow(index)}
                  aria-label={t("chatInput.interruptAndSend")}
                  title={t("chatInput.interruptAndSend")}
                >
                  <ArrowUp size={12} strokeWidth={2.25} />
                </button>
              )}
              {onWithdraw && (
                <button
                  type="button"
                  className="pending-message-withdraw"
                  onClick={() => handleWithdraw(index)}
                  aria-label={t("chatInput.withdraw")}
                  title={t("chatInput.withdraw")}
                >
                  <Undo2 size={12} strokeWidth={2.25} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
