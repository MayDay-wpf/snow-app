import {
  ArrowUp,
  Clock,
  FileText,
  GitCommitHorizontal,
  GitCompare,
  Globe,
  MousePointer2,
  ScanSearch,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import {
  extractUrlHost,
  formatLinesStr,
  parseContentSegments,
  type ContentSegment,
} from "./fileTagUtils";
import { getFileTypeIcon } from "../../../utils/fileIcons";

type PendingMessagesProps = {
  messages: string[];
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
        tag.path.lastIndexOf("\\")
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

    const { tag } = segment;
    const linesStr =
      !tag.isDirectory && tag.lines && tag.lines.length > 0
        ? formatLinesStr(tag.lines)
        : "";
    const displayName = linesStr ? `${tag.name}:${linesStr}` : tag.name;
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
    <div className="pending-messages-area" role="status" aria-live="polite">
      <div className="pending-messages-header">
        <Clock size={12} className="pending-messages-icon" />
        <span>{t("chatInput.pendingLabel")}</span>
      </div>
      <ul className="pending-messages-list">
        {messages.map((msg, index) => (
          <li key={index} className="pending-message-item">
            <span className="pending-message-text">{renderSegments(msg)}</span>
            {onSendNow && (
              <button
                type="button"
                className="pending-message-send-now"
                onClick={() => handleSendNow(index)}
                aria-label={t("chatInput.sendNow")}
                title={t("chatInput.sendNow")}
              >
                <ArrowUp size={12} />
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
                <Trash2 size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
