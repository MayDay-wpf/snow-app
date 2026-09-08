import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Accessibility,
  Activity,
  AlertCircle,
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Braces,
  Camera,
  CheckCircle2,
  Code2,
  Cookie,
  Download,
  Eraser,
  ExternalLink,
  FileText,
  Fingerprint,
  Focus,
  Gauge,
  Globe,
  Keyboard,
  Link2,
  ListChecks,
  Loader2,
  Locate,
  Lock,
  MapPin,
  MessageSquare,
  Monitor,
  MousePointer,
  MousePointerClick,
  Paperclip,
  Plus,
  Route,
  Save,
  Terminal,
  Timer,
  Upload,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type BrowserToolCallProps = {
  toolCall: ToolCallInfo;
};

type BrowserOperation =
  | "create"
  | "navigate"
  | "click"
  | "evaluate"
  | "type"
  | "screenshot"
  | "devtools"
  | "close"
  | "focus"
  | "list"
  | "wait"
  | "press_key"
  | "hover"
  | "navigate_back"
  | "navigate_forward"
  | "select_option"
  | "upload-file"
  | "back"
  | "forward";

type ParsedResult =
  | { type: "success"; data: Record<string, unknown>; images: string[] }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

type ClickedElement = {
  tagName: string;
  id: string | null;
  text: string;
  href: string | null;
};

type ConsoleMessage = {
  level: number;
  message: string;
  line: number;
  sourceId: string;
  recordedAt: string;
};

type SnapshotLink = {
  text: string;
  href: string;
};

type SnapshotData = {
  url: string;
  title: string;
  readyState: string;
  contentType: string;
  characterSet: string;
  viewport: { width: number; height: number } | null;
  documentSize: { scrollWidth: number; scrollHeight: number } | null;
  text: string;
  links: SnapshotLink[];
};

type BrowserTab = {
  instanceId: string;
  title: string;
  isActive: boolean;
};

type ScreenshotImage = {
  data: string;
  mimeType: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseArgs = (args: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** 持久化时 formatMcpToolResultForModel 把 image block 的 base64 换成占位符，
 *  并在 result 尾部追加此标签，直接 JSON.parse 整串会失败，需先剥离。 */
const INLINE_IMAGE_TAG_RE = /@@image:(data:[^@]+)@@/g;

/** 从 data URL 提取 base64 数据部分。 */
const base64FromDataUrl = (dataUrl: string): string | null => {
  const comma = dataUrl.indexOf(",");
  return comma > 0 ? dataUrl.slice(comma + 1) : null;
};

/** 剥离内联图片标签，返回剩余文本与 data URL 列表。 */
const stripInlineImageTags = (
  result: string,
): { text: string; images: string[] } => {
  const images: string[] = [];
  const text = result
    .replace(INLINE_IMAGE_TAG_RE, (_match, dataUrl: string) => {
      images.push(dataUrl);
      return "";
    })
    .trim();
  return { text, images };
};

const parseResult = (result: string | undefined): ParsedResult => {
  if (!result) {
    return { type: "empty" };
  }
  const { text, images } = stripInlineImageTags(result);
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return { type: "raw", text };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }
    return { type: "success", data: parsed, images };
  } catch {
    return { type: "raw", text };
  }
};

const getHost = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const truncateLabel = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

/** 描述 evaluate 返回值类型（用于头部 meta 摘要）。 */
const describeResultValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
};

/** 将 evaluate 的任意返回值格式化为可读文本。 */
const stringifyResultValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/** "browser-1751234567890-a1b2c3d4" -> "#a1b2c3d4"，完整 ID 放在 tooltip。 */
const shortInstanceId = (instanceId: string): string => {
  const segments = instanceId.split("-");
  const tail = segments[segments.length - 1];
  return tail ? `#${tail}` : instanceId;
};

/** 请求右侧面板切换到指定浏览器实例的 tab（RightPanel 订阅处理）。 */
const focusBrowserTab = (instanceId: string): void => {
  rightPanelEvents.emit("focus-browser-tab", { instanceId });
};

/** 请求右侧面板新建浏览器 tab（与 WebSearchToolCall 行为一致）。 */
const openInAppBrowser = (url: string): void => {
  rightPanelEvents.emit("open-browser-tab", { url });
};

/** 在系统浏览器中打开（主进程 setWindowOpenHandler 转交 shell.openExternal）。 */
const openExternalLink = (url: string): void => {
  window.open(url, "_blank");
};

const parseClickedElement = (value: unknown): ClickedElement | null => {
  if (!isRecord(value)) {
    return null;
  }
  return {
    tagName: asString(value.tagName) ?? "?",
    id: asString(value.id) ?? null,
    text: asString(value.text) ?? "",
    href: asString(value.href) ?? null,
  };
};

const parseConsoleMessages = (value: unknown): ConsoleMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((item) => ({
    level: asNumber(item.level) ?? 1,
    message: asString(item.message) ?? "",
    line: asNumber(item.line) ?? 0,
    sourceId: asString(item.sourceId) ?? "",
    recordedAt: asString(item.recordedAt) ?? "",
  }));
};

const parseSnapshot = (value: unknown): SnapshotData | null => {
  if (!isRecord(value)) {
    return null;
  }
  const viewport = isRecord(value.viewport) ? value.viewport : null;
  const documentSize = isRecord(value.document) ? value.document : null;
  const rawLinks = Array.isArray(value.links) ? value.links : [];
  return {
    url: asString(value.url) ?? "",
    title: asString(value.title) ?? "",
    readyState: asString(value.readyState) ?? "",
    contentType: asString(value.contentType) ?? "",
    characterSet: asString(value.characterSet) ?? "",
    viewport:
      viewport &&
      asNumber(viewport.width) !== undefined &&
      asNumber(viewport.height) !== undefined
        ? {
            width: asNumber(viewport.width) as number,
            height: asNumber(viewport.height) as number,
          }
        : null,
    documentSize:
      documentSize &&
      asNumber(documentSize.scrollWidth) !== undefined &&
      asNumber(documentSize.scrollHeight) !== undefined
        ? {
            scrollWidth: asNumber(documentSize.scrollWidth) as number,
            scrollHeight: asNumber(documentSize.scrollHeight) as number,
          }
        : null,
    text: asString(value.text) ?? "",
    links: rawLinks
      .filter(isRecord)
      .map((link) => ({
        text: asString(link.text) ?? "",
        href: asString(link.href) ?? "",
      }))
      .filter((link) => link.href !== ""),
  };
};

const parseBrowserTabs = (value: unknown): BrowserTab[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .filter((item) => asString(item.instanceId) !== undefined)
    .map((item) => ({
      instanceId: asString(item.instanceId) as string,
      title: asString(item.title) ?? "",
      isActive: item.isActive === true,
    }));
};

const parseScreenshotImage = (
  value: unknown,
  inlineDataUrls: string[],
): ScreenshotImage | null => {
  let image: ScreenshotImage | null = null;
  if (Array.isArray(value)) {
    for (const block of value) {
      if (
        isRecord(block) &&
        block.type === "image" &&
        typeof block.mimeType === "string"
      ) {
        let data = typeof block.data === "string" ? block.data : "";
        // 持久化后 data 为占位符：用内联标签中的 data URL 还原
        if (
          (data === "" || data === "[attached as multimodal image]") &&
          inlineDataUrls.length > 0
        ) {
          const dataUrl = inlineDataUrls.shift();
          data = dataUrl ? (base64FromDataUrl(dataUrl) ?? "") : "";
        }
        if (data) {
          image = { data, mimeType: block.mimeType };
          break;
        }
      }
    }
  }
  // content 数组缺失 image block 但存在内联标签：直接从标签还原
  if (!image && inlineDataUrls.length > 0) {
    const dataUrl = inlineDataUrls[0];
    const base64 = base64FromDataUrl(dataUrl);
    if (base64) {
      const mimeTypeMatch = /^data:([^;,]+)/.exec(dataUrl);
      image = {
        mimeType: mimeTypeMatch?.[1] ?? "image/png",
        data: base64,
      };
    }
  }
  return image;
};

const consoleLevelKey = (level: number): string => {
  if (level <= 0) return "verbose";
  if (level === 1) return "info";
  if (level === 2) return "warning";
  return "error";
};

const sourceFileName = (sourceId: string): string => {
  if (!sourceId) {
    return "";
  }
  const segments = sourceId.split("/");
  return segments[segments.length - 1] || sourceId;
};

/* ---------------- 共享子组件 ---------------- */

/** 仿浏览器地址栏：安全锁 / Globe 图标 + 协议弱化 + 剩余部分。 */
const AddressBar = ({ url }: { url: string }): React.JSX.Element => {
  const isSecure = url.startsWith("https://");
  const separatorIndex = url.indexOf("://");
  const protocol = separatorIndex >= 0 ? url.slice(0, separatorIndex + 3) : "";
  const rest = separatorIndex >= 0 ? url.slice(separatorIndex + 3) : url;
  return (
    <div className="tool-call-browser-address" title={url}>
      {isSecure ? (
        <Lock size={11} aria-hidden="true" />
      ) : (
        <Globe size={11} aria-hidden="true" />
      )}
      {protocol ? (
        <span className="tool-call-browser-address-protocol">{protocol}</span>
      ) : null}
      <span className="tool-call-browser-address-rest">{rest}</span>
    </div>
  );
};

type TagTone = "blue" | "green" | "amber" | "neutral";

const Tag = ({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: TagTone;
}): React.JSX.Element => (
  <span className={`tool-call-browser-tag tool-call-browser-tag-${tone}`}>
    {children}
  </span>
);

/** 可点击的实例 ID 徽章：点击切换到对应浏览器 tab。 */
const InstanceChip = ({
  instanceId,
}: {
  instanceId: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="tool-call-browser-instance"
      onClick={() => focusBrowserTab(instanceId)}
      title={`${instanceId}\n${t("toolCall.browser.focusTab")}`}
    >
      <Fingerprint size={10} aria-hidden="true" />
      <span>{shortInstanceId(instanceId)}</span>
    </button>
  );
};

/** 页面信息卡：标题 + 定位按钮（切换 tab）+ 外链按钮。 */
const PageCard = ({
  title,
  url,
  instanceId,
}: {
  title: string;
  url: string;
  instanceId?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const host = url ? getHost(url) : "";
  return (
    <div className="tool-call-browser-page">
      <div className="tool-call-browser-page-title">
        <Globe size={13} aria-hidden="true" />
        <span
          className="tool-call-browser-page-title-text"
          title={title || url}
        >
          {title || host}
        </span>
      </div>
      <div className="tool-call-browser-page-row">
        {instanceId ? (
          <button
            type="button"
            className="tool-call-browser-page-link"
            onClick={() => focusBrowserTab(instanceId)}
            title={`${url}\n${t("toolCall.browser.focusTab")}`}
          >
            <Locate size={10} aria-hidden="true" />
            <span>{host || shortInstanceId(instanceId)}</span>
          </button>
        ) : null}
        {url && (url.startsWith("http://") || url.startsWith("https://")) ? (
          <button
            type="button"
            className="tool-call-browser-external"
            onClick={() => openExternalLink(url)}
            title={t("toolCall.browser.openExternal")}
            aria-label={t("toolCall.browser.openExternal")}
          >
            <ExternalLink size={10} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
};

/** 单行状态条：用于 create / close / focus / devtools-open 的完成态。 */
const StatusRow = ({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children?: React.ReactNode;
}): React.JSX.Element => (
  <div className="tool-call-browser-status">
    <Icon size={13} aria-hidden="true" />
    <span className="tool-call-browser-status-label">{label}</span>
    {children}
  </div>
);

/** 等待 / 执行中占位。 */
const PendingBlock = ({
  isRunning,
  runningLabel,
  waitingLabel,
}: {
  isRunning: boolean;
  runningLabel: string;
  waitingLabel: string;
}): React.JSX.Element => (
  <div
    className={`tool-call-browser-pending ${
      isRunning ? "tool-call-browser-pending-running" : ""
    }`}
  >
    {isRunning ? (
      <Loader2
        className="tool-call-icon-spinning"
        size={14}
        aria-hidden="true"
      />
    ) : (
      <Globe size={14} aria-hidden="true" />
    )}
    <span>{isRunning ? runningLabel : waitingLabel}</span>
  </div>
);

/* ---------------- 各操作渲染 ---------------- */

const CreateView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const argUrl = asString(args?.url);
  const instanceId = asString(data?.instanceId);
  const resultUrl = asString(data?.url);
  if (!argUrl && !instanceId) {
    return null;
  }
  return (
    <>
      {argUrl ? <AddressBar url={argUrl} /> : null}
      {instanceId ? (
        <StatusRow icon={Plus} label={t("toolCall.browser.created")}>
          <InstanceChip instanceId={instanceId} />
          {resultUrl ? <Tag tone="blue">{getHost(resultUrl)}</Tag> : null}
        </StatusRow>
      ) : null}
    </>
  );
};

const NavigateView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const argUrl = asString(args?.url);
  const timeoutMs = asNumber(args?.timeoutMs);
  const instanceIdArg = asString(args?.instanceId);
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId) ?? instanceIdArg;
  if (!argUrl && !data) {
    return null;
  }
  return (
    <>
      {argUrl ? <AddressBar url={argUrl} /> : null}
      {timeoutMs !== undefined || instanceIdArg ? (
        <div className="tool-call-browser-tags">
          {timeoutMs !== undefined ? (
            <Tag>
              {t("toolCall.browser.timeout")}: {timeoutMs.toLocaleString()}ms
            </Tag>
          ) : null}
          {instanceIdArg && instanceIdArg.toLowerCase() !== "current" ? (
            <Tag>{shortInstanceId(instanceIdArg)}</Tag>
          ) : null}
        </div>
      ) : null}
      {data ? (
        <PageCard
          title={title ?? ""}
          url={resultUrl ?? argUrl ?? ""}
          instanceId={instanceId}
        />
      ) : null}
    </>
  );
};

const ClickView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const selector = asString(args?.selector);
  const text = asString(args?.text);
  const exact = args?.exact === true;
  const element = data ? parseClickedElement(data.element) : null;
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!selector && !text && !element) {
    return null;
  }
  return (
    <>
      {selector || text ? (
        <div className="tool-call-browser-target">
          <MousePointerClick size={12} aria-hidden="true" />
          {selector ? (
            <code className="tool-call-browser-target-selector">
              {selector}
            </code>
          ) : null}
          {text ? (
            <span className="tool-call-browser-target-text">"{text}"</span>
          ) : null}
          {exact ? (
            <Tag tone="amber">{t("toolCall.browser.exactMatch")}</Tag>
          ) : null}
        </div>
      ) : null}
      {element ? (
        <div className="tool-call-browser-element">
          <div className="tool-call-browser-element-head">
            <span className="tool-call-browser-element-tagname">
              <Code2 size={10} aria-hidden="true" />
              {element.tagName}
            </span>
            {element.id ? (
              <span className="tool-call-browser-element-id">
                #{element.id}
              </span>
            ) : null}
            {element.text ? (
              <span
                className="tool-call-browser-element-text"
                title={element.text}
              >
                {truncateLabel(element.text, 80)}
              </span>
            ) : null}
          </div>
          {element.href ? (
            <div className="tool-call-browser-element-href">
              <Link2 size={10} aria-hidden="true" />
              <button
                type="button"
                className="tool-call-browser-element-href-link"
                onClick={() => openInAppBrowser(element.href as string)}
                title={`${element.href}\n${t("toolCall.browser.openInApp")}`}
              >
                {element.href}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {data ? (
        <PageCard
          title={title ?? ""}
          url={resultUrl ?? ""}
          instanceId={instanceId}
        />
      ) : null}
    </>
  );
};

const EvaluateView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const expression = asString(args?.expression);
  const resultValue = data?.result;
  const error = asString(data?.error);
  const url = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!expression && resultValue === undefined && !error) {
    return null;
  }
  return (
    <>
      {expression ? (
        <div className="tool-call-browser-expression">
          <Braces size={12} aria-hidden="true" />
          <code>{expression}</code>
        </div>
      ) : null}
      {error ? (
        <div className="tool-call-error">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      {resultValue !== undefined ? (
        <section className="tool-call-section">
          <span className="tool-call-section-label">
            {t("toolCall.browser.result")}
          </span>
          <pre className="tool-call-section-pre tool-call-browser-eval-result">
            {stringifyResultValue(resultValue)}
          </pre>
        </section>
      ) : null}
      {url || instanceId ? (
        <PageCard title={title ?? ""} url={url ?? ""} instanceId={instanceId} />
      ) : null}
    </>
  );
};

const TypeView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const selector = asString(args?.selector);
  const text = asString(args?.text);
  const ref = asString(args?.ref);
  const value = asString(args?.value) ?? "";
  const submit = args?.submit === true;
  const element = data ? parseClickedElement(data.element) : null;
  const url = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!selector && !text && !ref && value === "" && !element) {
    return null;
  }
  return (
    <>
      {selector || text || ref ? (
        <div className="tool-call-browser-target">
          <Keyboard size={12} aria-hidden="true" />
          {selector ? (
            <code className="tool-call-browser-target-selector">
              {selector}
            </code>
          ) : null}
          {ref ? (
            <code className="tool-call-browser-target-selector">{ref}</code>
          ) : null}
          {text ? (
            <span className="tool-call-browser-target-text">"{text}"</span>
          ) : null}
        </div>
      ) : null}
      {value !== "" ? (
        <div className="tool-call-browser-type-value">
          <span className="tool-call-browser-type-value-label">
            {t("toolCall.browser.typedValue")}
          </span>
          <code className="tool-call-browser-type-value-text">"{value}"</code>
          {submit ? (
            <Tag tone="green">{t("toolCall.browser.submitted")}</Tag>
          ) : null}
        </div>
      ) : null}
      {element ? (
        <div className="tool-call-browser-element">
          <div className="tool-call-browser-element-head">
            <span className="tool-call-browser-element-tagname">
              <Code2 size={10} aria-hidden="true" />
              {element.tagName}
            </span>
            {element.id ? (
              <span className="tool-call-browser-element-id">
                #{element.id}
              </span>
            ) : null}
            {element.text ? (
              <span
                className="tool-call-browser-element-text"
                title={element.text}
              >
                {truncateLabel(element.text, 80)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {url || instanceId ? (
        <PageCard title={title ?? ""} url={url ?? ""} instanceId={instanceId} />
      ) : null}
    </>
  );
};

/* wait：条件等待 */
const WaitView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const time = asNumber(args?.time);
  const text = asString(args?.text);
  const textGone = asString(args?.textGone);
  const waitedMs = asNumber(data?.waitedMs);
  const url = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (time === undefined && !text && !textGone) {
    return null;
  }
  return (
    <>
      <div className="tool-call-browser-target">
        <Timer size={12} aria-hidden="true" />
        {time !== undefined ? (
          <span className="tool-call-browser-target-text">
            {t("toolCall.browser.wait.time", { values: { count: time } })}
          </span>
        ) : text ? (
          <span className="tool-call-browser-target-text">
            {t("toolCall.browser.wait.text")} "{text}"
          </span>
        ) : textGone ? (
          <span className="tool-call-browser-target-text">
            {t("toolCall.browser.wait.textGone")} "{textGone}"
          </span>
        ) : null}
      </div>
      {waitedMs !== undefined ? (
        <StatusRow
          icon={CheckCircle2}
          label={t("toolCall.browser.wait.done", {
            values: { count: waitedMs.toLocaleString() },
          })}
        />
      ) : null}
      {url || instanceId ? (
        <PageCard title={title ?? ""} url={url ?? ""} instanceId={instanceId} />
      ) : null}
    </>
  );
};

/* press_key：按键 */
const PressKeyView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const key = asString(data?.key) ?? asString(args?.key);
  const url = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!key) {
    return null;
  }
  return (
    <>
      <div className="tool-call-browser-target">
        <Keyboard size={12} aria-hidden="true" />
        <code className="tool-call-browser-target-selector">{key}</code>
      </div>
      {url || instanceId ? (
        <PageCard title={title ?? ""} url={url ?? ""} instanceId={instanceId} />
      ) : null}
    </>
  );
};

/* hover：悬停目标 + 命中元素 + 坐标 */
const HoverView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const selector = asString(args?.selector);
  const text = asString(args?.text);
  const exact = args?.exact === true;
  const element = data ? parseClickedElement(data.element) : null;
  const position = isRecord(data?.position) ? data.position : null;
  const x = asNumber(position?.x);
  const y = asNumber(position?.y);
  const url = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!selector && !text && !element) {
    return null;
  }
  return (
    <>
      {selector || text ? (
        <div className="tool-call-browser-target">
          <MousePointer size={12} aria-hidden="true" />
          {selector ? (
            <code className="tool-call-browser-target-selector">
              {selector}
            </code>
          ) : null}
          {text ? (
            <span className="tool-call-browser-target-text">"{text}"</span>
          ) : null}
          {exact ? (
            <Tag tone="amber">{t("toolCall.browser.exactMatch")}</Tag>
          ) : null}
        </div>
      ) : null}
      {element ? (
        <div className="tool-call-browser-element">
          <div className="tool-call-browser-element-head">
            <span className="tool-call-browser-element-tagname">
              <Code2 size={10} aria-hidden="true" />
              {element.tagName}
            </span>
            {element.id ? (
              <span className="tool-call-browser-element-id">
                #{element.id}
              </span>
            ) : null}
            {element.text ? (
              <span
                className="tool-call-browser-element-text"
                title={element.text}
              >
                {truncateLabel(element.text, 80)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {x !== undefined && y !== undefined ? (
        <StatusRow
          icon={MapPin}
          label={`${t("toolCall.browser.position")}: ${x}, ${y}`}
        />
      ) : null}
      {url || instanceId ? (
        <PageCard title={title ?? ""} url={url ?? ""} instanceId={instanceId} />
      ) : null}
    </>
  );
};

/* select_option：目标 + 选项值 + 选中结果 */
const SelectOptionView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const selector = asString(args?.selector);
  const text = asString(args?.text);
  const exact = args?.exact === true;
  const values = Array.isArray(args?.values) ? args.values.map(String) : [];
  const selectedOptions = Array.isArray(data?.selectedOptions)
    ? data.selectedOptions
        .filter(isRecord)
        .map((option) => ({
          value: asString(option.value) ?? "",
          text: asString(option.text) ?? "",
        }))
        .filter((option) => option.value !== "" || option.text !== "")
    : [];
  const element = data ? parseClickedElement(data.element) : null;
  const url = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!selector && !text && values.length === 0 && !element) {
    return null;
  }
  return (
    <>
      {selector || text ? (
        <div className="tool-call-browser-target">
          <ListChecks size={12} aria-hidden="true" />
          {selector ? (
            <code className="tool-call-browser-target-selector">
              {selector}
            </code>
          ) : null}
          {text ? (
            <span className="tool-call-browser-target-text">"{text}"</span>
          ) : null}
          {exact ? (
            <Tag tone="amber">{t("toolCall.browser.exactMatch")}</Tag>
          ) : null}
        </div>
      ) : null}
      {values.length > 0 ? (
        <div className="tool-call-browser-tags">
          {values.map((value, index) => (
            <Tag key={`${value}-${index}`} tone="blue">
              {value}
            </Tag>
          ))}
        </div>
      ) : null}
      {selectedOptions.length > 0 ? (
        <div className="tool-call-browser-selected">
          {selectedOptions.map((option) => (
            <span key={`${option.value}-${option.text}`}>
              {option.text || option.value}
            </span>
          ))}
        </div>
      ) : null}
      {element ? (
        <div className="tool-call-browser-element">
          <div className="tool-call-browser-element-head">
            <span className="tool-call-browser-element-tagname">
              <Code2 size={10} aria-hidden="true" />
              {element.tagName}
            </span>
            {element.id ? (
              <span className="tool-call-browser-element-id">
                #{element.id}
              </span>
            ) : null}
            {element.text ? (
              <span
                className="tool-call-browser-element-text"
                title={element.text}
              >
                {truncateLabel(element.text, 80)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {url || instanceId ? (
        <PageCard title={title ?? ""} url={url ?? ""} instanceId={instanceId} />
      ) : null}
    </>
  );
};

/* upload-file：文件列表 + 上传结果 */
const UploadFileView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const files = Array.isArray(args?.files)
    ? args.files.filter((item): item is string => typeof item === "string")
    : [];
  const uploaded = asNumber(data?.uploaded);
  const url = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (files.length === 0 && uploaded === undefined) {
    return null;
  }
  return (
    <>
      {files.length > 0 ? (
        <div className="tool-call-browser-target">
          <Paperclip size={12} aria-hidden="true" />
          <span className="tool-call-browser-target-text">
            {files.join(", ")}
          </span>
        </div>
      ) : null}
      {uploaded !== undefined ? (
        <StatusRow
          icon={CheckCircle2}
          label={t("toolCall.browser.uploadedCount", {
            values: { count: uploaded },
          })}
        />
      ) : null}
      {url || instanceId ? (
        <PageCard title={title ?? ""} url={url ?? ""} instanceId={instanceId} />
      ) : null}
    </>
  );
};

/* back / forward / navigate_back / navigate_forward：历史导航 */
const HistoryView = ({
  operation,
  data,
}: {
  operation: BrowserOperation;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const direction =
    asString(data?.direction) ??
    (operation === "back" || operation === "navigate_back"
      ? "back"
      : "forward");
  const isBack = direction === "back";
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!resultUrl && !instanceId) {
    return null;
  }
  return (
    <>
      <StatusRow
        icon={isBack ? ArrowLeft : ArrowRight}
        label={
          isBack
            ? t("toolCall.browser.historyBack")
            : t("toolCall.browser.historyForward")
        }
      >
        {resultUrl ? <Tag tone="blue">{getHost(resultUrl)}</Tag> : null}
      </StatusRow>
      <PageCard
        title={title ?? ""}
        url={resultUrl ?? ""}
        instanceId={instanceId}
      />
    </>
  );
};

const ScreenshotView = ({
  args,
  data,
  inlineImages,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
  inlineImages: string[];
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const fullPageArg = args?.fullPage !== false;
  const fullPage = data ? data.fullPage !== false : fullPageArg;
  const image = data ? parseScreenshotImage(data.content, inlineImages) : null;
  const imageSrc = image ? `data:${image.mimeType};base64,${image.data}` : null;
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);

  // Esc 关闭大图
  useEffect(() => {
    if (!isLightboxOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsLightboxOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isLightboxOpen]);

  const lightboxElement =
    isLightboxOpen && imageSrc
      ? createPortal(
          <div
            className="tool-call-imagegen-lightbox"
            onClick={() => setIsLightboxOpen(false)}
            role="presentation"
          >
            <img
              src={imageSrc}
              alt={title || resultUrl || "screenshot"}
              draggable={false}
              onClick={(event) => event.stopPropagation()}
            />
            <div
              className="tool-call-imagegen-lightbox-toolbar"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="tool-call-imagegen-lightbox-close"
                onClick={() => setIsLightboxOpen(false)}
                aria-label={t("toolCall.imagegen.close")}
              >
                ✕
              </button>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="tool-call-browser-tags">
        <Tag tone={fullPage ? "blue" : "neutral"}>
          <Camera size={10} aria-hidden="true" />
          {fullPage
            ? t("toolCall.browser.fullPage")
            : t("toolCall.browser.viewportOnly")}
        </Tag>
      </div>
      {data ? (
        <PageCard
          title={title ?? ""}
          url={resultUrl ?? ""}
          instanceId={instanceId}
        />
      ) : null}
      {image ? (
        <div className="tool-call-browser-shot">
          <img
            src={imageSrc ?? undefined}
            alt={title || resultUrl || "screenshot"}
            title={t("toolCall.computerUse.clickToZoom")}
            onClick={() => setIsLightboxOpen(true)}
            draggable={false}
          />
        </div>
      ) : null}
      {lightboxElement}
    </>
  );
};

const DevtoolsSnapshotView = ({
  snapshot,
  instanceId,
}: {
  snapshot: SnapshotData;
  instanceId?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const metaCells: Array<{ label: string; value: string }> = [
    { label: t("toolCall.browser.readyState"), value: snapshot.readyState },
    { label: t("toolCall.browser.contentType"), value: snapshot.contentType },
    ...(snapshot.viewport
      ? [
          {
            label: t("toolCall.browser.viewportSize"),
            value: `${snapshot.viewport.width} x ${snapshot.viewport.height}`,
          },
        ]
      : []),
    ...(snapshot.documentSize
      ? [
          {
            label: t("toolCall.browser.documentSize"),
            value: `${snapshot.documentSize.scrollWidth} x ${snapshot.documentSize.scrollHeight}`,
          },
        ]
      : []),
  ].filter((cell) => cell.value !== "");

  return (
    <>
      <PageCard
        title={snapshot.title}
        url={snapshot.url}
        instanceId={instanceId}
      />
      {metaCells.length > 0 ? (
        <div className="tool-call-browser-meta-grid">
          {metaCells.map((cell) => (
            <div key={cell.label} className="tool-call-browser-meta-cell">
              <span className="tool-call-browser-meta-label">{cell.label}</span>
              <span className="tool-call-browser-meta-value">{cell.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {snapshot.text ? (
        <div className="tool-call-browser-text-wrap">
          <span className="tool-call-browser-section-label">
            <FileText size={10} aria-hidden="true" />
            {t("toolCall.browser.pageText")}
          </span>
          <pre className="tool-call-browser-text">{snapshot.text}</pre>
        </div>
      ) : null}
      {snapshot.links.length > 0 ? (
        <details className="tool-call-browser-links">
          <summary>
            <Link2 size={10} aria-hidden="true" />
            {t("toolCall.browser.links")}
            <span className="tool-call-browser-links-count">
              {snapshot.links.length}
            </span>
          </summary>
          <div className="tool-call-browser-links-list">
            {snapshot.links.slice(0, 100).map((link, index) => (
              <div
                key={`${link.href}-${index}`}
                className="tool-call-browser-link-row"
              >
                <button
                  type="button"
                  className="tool-call-browser-link-text"
                  onClick={() => openInAppBrowser(link.href)}
                  title={`${link.href}\n${t("toolCall.browser.openInApp")}`}
                >
                  {link.text || getHost(link.href)}
                </button>
                <span className="tool-call-browser-link-host">
                  {getHost(link.href)}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
};

const DevtoolsConsoleView = ({
  messages,
}: {
  messages: ConsoleMessage[];
}): React.JSX.Element => {
  const { t } = useI18n();
  if (messages.length === 0) {
    return (
      <div className="tool-call-browser-empty">
        <Terminal size={14} aria-hidden="true" />
        <span>{t("toolCall.browser.noConsoleMessages")}</span>
      </div>
    );
  }
  return (
    <div className="tool-call-browser-console">
      {messages.map((item, index) => {
        const levelKey = consoleLevelKey(item.level);
        const source = sourceFileName(item.sourceId);
        return (
          <div
            key={`${item.recordedAt}-${index}`}
            className={`tool-call-browser-console-row tool-call-browser-console-${levelKey}`}
          >
            <span className="tool-call-browser-console-level">
              {t(`toolCall.browser.level.${levelKey}`)}
            </span>
            <span className="tool-call-browser-console-message">
              {item.message}
            </span>
            {source ? (
              <span className="tool-call-browser-console-source">
                {source}
                {item.line > 0 ? `:${item.line}` : ""}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

/* ===== devtools 网络调试视图（network / cookies / dialog / ax / route / storage）===== */

type NetworkRecord = {
  id: number;
  url?: string;
  method?: string;
  status?: number | string;
  resourceType?: string;
  durationMs?: number;
  requestId?: string;
  mimeType?: string;
  fromCache?: boolean;
  error?: string;
  source?: string;
};

const parseNetworkRecord = (value: unknown): NetworkRecord | null => {
  if (!isRecord(value)) {
    return null;
  }
  return {
    id: asNumber(value.id) ?? 0,
    url: asString(value.url),
    method: asString(value.method),
    status:
      typeof value.status === "number"
        ? value.status
        : (asString(value.status) ?? undefined),
    resourceType: asString(value.resourceType),
    durationMs: asNumber(value.durationMs),
    requestId: asString(value.requestId),
    mimeType: asString(value.mimeType),
    fromCache: value.fromCache === true,
    error: asString(value.error),
    source: asString(value.source),
  };
};

const methodTone = (method: string): TagTone => {
  const m = method.toUpperCase();
  if (m === "GET") return "blue";
  if (m === "POST" || m === "PUT" || m === "PATCH") return "green";
  if (m === "DELETE") return "amber";
  return "neutral";
};

const statusTone = (status: number | string | undefined): TagTone => {
  const code = typeof status === "number" ? status : Number(status);
  if (!Number.isFinite(code)) return "neutral";
  if (code < 300) return "green";
  if (code < 400) return "blue";
  if (code < 500) return "amber";
  return "neutral";
};

/** network：请求列表。 */
const DevtoolsNetworkView = ({
  data,
}: {
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const raw = Array.isArray(data?.requests) ? data.requests : [];
  const records = raw
    .map((item) => {
      const candidate =
        isRecord(item) && isRecord(item.record) ? item.record : item;
      return parseNetworkRecord(candidate);
    })
    .filter((record): record is NetworkRecord => record !== null);
  if (records.length === 0) {
    return (
      <div className="tool-call-browser-empty">
        <Activity size={14} aria-hidden="true" />
        <span>{t("toolCall.browser.noNetworkRequests")}</span>
      </div>
    );
  }
  return (
    <div className="tool-call-browser-network">
      {records.slice(0, 50).map((record) => (
        <div key={record.id} className="tool-call-browser-network-row">
          <Tag tone={methodTone(record.method ?? "")}>
            {record.method ?? "?"}
          </Tag>
          <span
            className={`tool-call-browser-network-status ${
              statusTone(record.status) === "green"
                ? "tool-call-browser-network-status-ok"
                : ""
            }`}
          >
            {record.status ?? "..."}
          </span>
          <span className="tool-call-browser-network-url" title={record.url}>
            {record.url ?? ""}
          </span>
          {record.durationMs !== undefined ? (
            <span className="tool-call-browser-network-duration">
              {record.durationMs}ms
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
};

/** Headers 键值块。 */
const HeadersBlock = ({
  label,
  headers,
}: {
  label: string;
  headers: Record<string, unknown>;
}): React.JSX.Element => (
  <section className="tool-call-section">
    <span className="tool-call-section-label">{label}</span>
    <div className="tool-call-browser-headers">
      {Object.entries(headers).map(([key, value]) => (
        <div key={key} className="tool-call-browser-headers-row">
          <code className="tool-call-browser-headers-key">{key}</code>
          <span className="tool-call-browser-headers-value">
            {Array.isArray(value) ? value.join(", ") : String(value)}
          </span>
        </div>
      ))}
    </div>
  </section>
);

/** network_detail / networkDetails：单条请求详情。 */
const DevtoolsNetworkDetailView = ({
  data,
}: {
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  if (!data) {
    return null;
  }
  if (data.found === false) {
    return (
      <div className="tool-call-error">
        <AlertCircle size={12} aria-hidden="true" />
        <span>{asString(data.error) ?? t("toolCall.browser.notFound")}</span>
      </div>
    );
  }
  const detail = isRecord(data.details)
    ? data.details
    : isRecord(data.request)
      ? data.request
      : data;
  const record = parseNetworkRecord(detail);
  const requestHeaders = isRecord(detail.requestHeaders)
    ? detail.requestHeaders
    : null;
  const responseHeaders = isRecord(detail.responseHeaders)
    ? detail.responseHeaders
    : null;
  const requestBody =
    typeof detail.requestBody === "string" ? detail.requestBody : null;
  const responseBodyRaw = isRecord(detail.responseBody)
    ? detail.responseBody
    : null;
  const responseBodyText =
    typeof responseBodyRaw?.text === "string" ? responseBodyRaw.text : null;

  return (
    <>
      {record ? (
        <div className="tool-call-browser-network-detail-head">
          <Tag tone={methodTone(record.method ?? "")}>
            {record.method ?? "?"}
          </Tag>
          <span className="tool-call-browser-network-url" title={record.url}>
            {record.url ?? ""}
          </span>
          {record.status !== undefined ? (
            <Tag tone={statusTone(record.status)}>{String(record.status)}</Tag>
          ) : null}
          {record.durationMs !== undefined ? (
            <Tag>{record.durationMs}ms</Tag>
          ) : null}
        </div>
      ) : null}
      {requestHeaders ? (
        <HeadersBlock
          label={t("toolCall.browser.requestHeaders")}
          headers={requestHeaders}
        />
      ) : null}
      {responseHeaders ? (
        <HeadersBlock
          label={t("toolCall.browser.responseHeaders")}
          headers={responseHeaders}
        />
      ) : null}
      {requestBody ? (
        <section className="tool-call-section">
          <span className="tool-call-section-label">
            {t("toolCall.browser.requestBody")}
          </span>
          <pre className="tool-call-section-pre">{requestBody}</pre>
        </section>
      ) : null}
      {responseBodyText ? (
        <section className="tool-call-section">
          <span className="tool-call-section-label">
            {t("toolCall.browser.responseBody")}
          </span>
          <pre className="tool-call-section-pre">{responseBodyText}</pre>
        </section>
      ) : null}
      {asString(detail.responseBodyError) ? (
        <div className="tool-call-browser-empty">
          <Activity size={14} aria-hidden="true" />
          <span>{detail.responseBodyError as string}</span>
        </div>
      ) : null}
    </>
  );
};

/** cookies：Cookie 列表。 */
const DevtoolsCookiesView = ({
  data,
}: {
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const raw = Array.isArray(data?.cookies) ? data.cookies : [];
  if (raw.length === 0) {
    return (
      <div className="tool-call-browser-empty">
        <Cookie size={14} aria-hidden="true" />
        <span>{t("toolCall.browser.noCookies")}</span>
      </div>
    );
  }
  const masked = data?.masked === true;
  return (
    <>
      {masked ? (
        <Tag tone="amber">{t("toolCall.browser.cookiesMasked")}</Tag>
      ) : null}
      <div className="tool-call-browser-cookies">
        {raw.slice(0, 50).map((item, index) => {
          const cookie = isRecord(item) ? item : null;
          const name = asString(cookie?.name) ?? "";
          const domain = asString(cookie?.domain) ?? "";
          const value = asString(cookie?.value);
          return (
            <div key={`${name}-${index}`} className="tool-call-browser-cookie">
              <span className="tool-call-browser-cookie-name">{name}</span>
              <span className="tool-call-browser-cookie-domain">{domain}</span>
              {value !== undefined ? (
                <code className="tool-call-browser-cookie-value">{value}</code>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
};

/** dialog：JS 对话框列表。 */
const DevtoolsDialogsView = ({
  data,
}: {
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const raw = Array.isArray(data?.dialogs) ? data.dialogs : [];
  if (raw.length === 0) {
    return (
      <div className="tool-call-browser-empty">
        <MessageSquare size={14} aria-hidden="true" />
        <span>{t("toolCall.browser.noDialogs")}</span>
      </div>
    );
  }
  return (
    <div className="tool-call-browser-dialogs">
      {raw.map((item, index) => {
        const dialog = isRecord(item) ? item : null;
        const type =
          asString(dialog?.dialogType) ?? asString(dialog?.type) ?? "?";
        const message = asString(dialog?.message) ?? "";
        return (
          <div key={index} className="tool-call-browser-dialog">
            <Tag tone="amber">{type}</Tag>
            <span className="tool-call-browser-dialog-message">{message}</span>
          </div>
        );
      })}
    </div>
  );
};

/** serializeAxTree 单行文本（`  - heading "Example Domain" [uid=e1]`）解析结果。 */
type AxTreeLine = { role: string; name: string; uid: string; depth: number };

/**
 * 解析 serializeAxTree 的文本行：
 *   `- heading "Example Domain" [uid=e1]`        -> depth 0
 *   `  - link "Learn more" [uid=e2]`             -> depth 1
 *   `  - textbox "搜索" value="abc" [uid=e3]`    -> verbose，value 忽略
 * 行首每 2 个空格 = 1 层缩进；name 内的 `\"` 反转义。
 */
const parseAxLine = (line: string): AxTreeLine | null => {
  const trimmed = line.trim();
  const depth = Math.floor((line.length - trimmed.length) / 2);
  const body = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
  if (!body) {
    return null;
  }
  // 1. 提取行尾 [uid=x]
  const uidMatch = body.match(/\[uid=([^\]]+)\]\s*$/);
  const uid = uidMatch?.[1] ?? "";
  const withoutUid = uidMatch ? body.slice(0, uidMatch.index).trimEnd() : body;
  // 2. 去掉 verbose 的 value="..."（formatNode 输出顺序固定为 role/name/value/uid）
  const valueMatch = withoutUid.match(/\s+value="((?:[^"\\]|\\.)*)"/);
  const withoutValue = valueMatch
    ? withoutUid.slice(0, valueMatch.index).trimEnd()
    : withoutUid;
  // 3. 解析 role 与 name：`"name"`（无 role）或 `role "name"` 或纯 `role`
  const bareName = withoutValue.match(/^"((?:[^"\\]|\\.)*)"/);
  if (bareName) {
    return {
      role: "",
      name: bareName[1].replace(/\\"/g, '"'),
      uid,
      depth,
    };
  }
  const roleName = withoutValue.match(/^(\S+)\s+"((?:[^"\\]|\\.)*)"/);
  if (roleName) {
    return {
      role: roleName[1],
      name: roleName[2].replace(/\\"/g, '"'),
      uid,
      depth,
    };
  }
  return { role: withoutValue.trim(), name: "", uid, depth };
};

/** ax：无障碍树统计 + 节点列表。 */
const DevtoolsAxView = ({
  data,
}: {
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  // accessibility 可能是数组（其他调用方）或 serializeAxTree 的文本树字符串。
  const tree: AxTreeLine[] = Array.isArray(data?.accessibility)
    ? (data.accessibility as unknown[])
        .map((node) => {
          if (!isRecord(node)) {
            return null;
          }
          return {
            role: asString(node.role) ?? "",
            name: asString(node.name) ?? asString(node.text) ?? "",
            uid: asString(node.uid) ?? "",
            depth: typeof node.depth === "number" ? node.depth : 0,
          } satisfies AxTreeLine;
        })
        .filter((node): node is AxTreeLine => node !== null)
    : typeof data?.accessibility === "string"
      ? data.accessibility
          .split("\n")
          .map(parseAxLine)
          .filter((node): node is AxTreeLine => node !== null)
      : [];
  const stats = isRecord(data?.stats) ? data.stats : null;
  const emitted =
    typeof stats?.emitted === "number" ? stats.emitted : tree.length;
  const truncated = stats?.truncated === true;
  return (
    <>
      {stats ? (
        <div className="tool-call-browser-tags">
          <Tag tone="blue">
            {t("toolCall.browser.axNodes", {
              values: { count: emitted },
            })}
          </Tag>
          {truncated ? (
            <Tag tone="amber">{t("toolCall.browser.axTruncated")}</Tag>
          ) : null}
        </div>
      ) : null}
      {tree.length > 0 ? (
        <div className="tool-call-browser-ax">
          {tree.slice(0, 60).map((node, index) => {
            const { role, name, uid, depth } = node;
            return (
              <div
                key={index}
                className="tool-call-browser-ax-node"
                style={{ paddingLeft: `${Math.min(depth, 8) * 12 + 4}px` }}
              >
                {role ? <Tag tone="blue">{role}</Tag> : null}
                {name ? (
                  <span className="tool-call-browser-ax-name">{name}</span>
                ) : null}
                {uid ? (
                  <code className="tool-call-browser-ax-uid">{uid}</code>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
};

const DevtoolsView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const action = asString(args?.action) ?? "snapshot";
  const maxContentLength = asNumber(args?.maxContentLength);
  const clearConsole = args?.clearConsole === true;
  const instanceId = asString(data?.instanceId);

  const snapshot =
    action === "snapshot" && data ? parseSnapshot(data.snapshot) : null;
  const messages =
    action === "console" && data ? parseConsoleMessages(data.messages) : null;
  const opened = data?.opened === true;
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);

  // 状态类 action 的统一结果行。
  const stateRow = ((): React.JSX.Element | null => {
    if (!data) {
      return null;
    }
    switch (action) {
      case "network_clear":
        return (
          <StatusRow
            icon={Eraser}
            label={t("toolCall.browser.networkCleared")}
          />
        );
      case "networkState": {
        const offline = data.state === "offline";
        return (
          <StatusRow
            icon={offline ? WifiOff : Wifi}
            label={
              offline
                ? t("toolCall.browser.networkStateOffline")
                : t("toolCall.browser.networkStateOnline")
            }
          >
            <Tag tone={offline ? "amber" : "green"}>
              {String(data.state ?? "")}
            </Tag>
          </StatusRow>
        );
      }
      case "route": {
        const pattern = asString(
          isRecord(data.rule) ? data.rule.pattern : undefined,
        );
        return (
          <StatusRow icon={Route} label={t("toolCall.browser.routeActive")}>
            {pattern ? <Tag tone="blue">{pattern}</Tag> : null}
          </StatusRow>
        );
      }
      case "routeClear":
        return (
          <StatusRow icon={Eraser} label={t("toolCall.browser.routeCleared")} />
        );
      case "storageSave": {
        const fileName = asString(
          isRecord(data.storage) ? data.storage.fileName : undefined,
        );
        return (
          <StatusRow icon={Save} label={t("toolCall.browser.storageSaved")}>
            {fileName ? <Tag tone="blue">{fileName}</Tag> : null}
          </StatusRow>
        );
      }
      case "storageRestore": {
        const fileName = asString(
          isRecord(data.storage) ? data.storage.fileName : undefined,
        );
        return (
          <StatusRow
            icon={Download}
            label={t("toolCall.browser.storageRestored")}
          >
            {fileName ? <Tag tone="blue">{fileName}</Tag> : null}
          </StatusRow>
        );
      }
      case "cookieDelete": {
        const name = asString(data.name);
        const domain = asString(data.domain);
        return (
          <StatusRow icon={Cookie} label={t("toolCall.browser.cookieDeleted")}>
            {name ? <Tag tone="blue">{name}</Tag> : null}
            {domain ? <Tag>{domain}</Tag> : null}
          </StatusRow>
        );
      }
      case "dialog": {
        const responded = isRecord(data.responded);
        return responded ? (
          <StatusRow
            icon={MessageSquare}
            label={t("toolCall.browser.dialogResponded")}
          />
        ) : null;
      }
      default:
        return null;
    }
  })();

  // 结果 JSON 兜底：仅当 action 没有专门视图且未渲染任何内容时显示。
  const hasDedicatedView =
    action === "snapshot" ||
    action === "console" ||
    action === "network" ||
    action === "network_detail" ||
    action === "networkDetails" ||
    action === "cookies" ||
    action === "dialog" ||
    action === "ax" ||
    action === "trace" ||
    action === "open" ||
    stateRow !== null;
  const fallbackText =
    action === "trace" && data
      ? JSON.stringify(data.trace ?? data, null, 2)
      : !hasDedicatedView && data
        ? JSON.stringify(data, null, 2)
        : "";

  return (
    <>
      <div className="tool-call-browser-tags">
        <Tag tone="blue">
          <Terminal size={10} aria-hidden="true" />
          {action}
        </Tag>
        {action === "snapshot" && maxContentLength !== undefined ? (
          <Tag>
            {t("toolCall.browser.maxLength")}:{" "}
            {maxContentLength.toLocaleString()}
          </Tag>
        ) : null}
        {action === "console" && clearConsole ? (
          <Tag tone="amber">{t("toolCall.browser.clearConsole")}</Tag>
        ) : null}
      </div>

      {snapshot ? (
        <DevtoolsSnapshotView snapshot={snapshot} instanceId={instanceId} />
      ) : null}
      {messages ? <DevtoolsConsoleView messages={messages} /> : null}
      {action === "network" ? <DevtoolsNetworkView data={data} /> : null}
      {action === "network_detail" || action === "networkDetails" ? (
        <DevtoolsNetworkDetailView data={data} />
      ) : null}
      {action === "cookies" ? <DevtoolsCookiesView data={data} /> : null}
      {action === "dialog" && data?.dialogs ? (
        <DevtoolsDialogsView data={data} />
      ) : null}
      {action === "ax" ? <DevtoolsAxView data={data} /> : null}
      {stateRow}
      {opened ? (
        <StatusRow icon={Monitor} label={t("toolCall.browser.devtoolsOpened")}>
          {instanceId ? <InstanceChip instanceId={instanceId} /> : null}
        </StatusRow>
      ) : null}

      {fallbackText ? (
        <section className="tool-call-section">
          <span className="tool-call-section-label">
            {t("toolCall.common.result")}
          </span>
          <pre className="tool-call-section-pre">{fallbackText}</pre>
        </section>
      ) : null}

      {action === "console" && data && resultUrl ? (
        <PageCard title={title ?? ""} url={resultUrl} instanceId={instanceId} />
      ) : null}
    </>
  );
};

const CloseFocusView = ({
  operation,
  args,
  data,
}: {
  operation: "close" | "focus";
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const instanceId = asString(data?.instanceId) ?? asString(args?.instanceId);
  if (!instanceId) {
    return null;
  }
  const done = data ? data.closed === true || data.focused === true : false;
  return (
    <StatusRow
      icon={operation === "close" ? X : Focus}
      label={
        done
          ? operation === "close"
            ? t("toolCall.browser.closed")
            : t("toolCall.browser.focused")
          : operation === "close"
            ? t("toolCall.browser.closingTarget")
            : t("toolCall.browser.focusingTarget")
      }
    >
      <InstanceChip instanceId={instanceId} />
    </StatusRow>
  );
};

const ListView = ({
  data,
}: {
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  if (!data) {
    return null;
  }
  const tabs = parseBrowserTabs(data.tabs);
  if (tabs.length === 0) {
    return (
      <div className="tool-call-browser-empty">
        <AppWindow size={14} aria-hidden="true" />
        <span>{t("toolCall.browser.noTabs")}</span>
      </div>
    );
  }
  return (
    <div className="tool-call-browser-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.instanceId}
          type="button"
          className={`tool-call-browser-tab ${
            tab.isActive ? "tool-call-browser-tab-active" : ""
          }`}
          onClick={() => focusBrowserTab(tab.instanceId)}
          title={`${tab.instanceId}\n${t("toolCall.browser.focusTab")}`}
        >
          <span
            className={`tool-call-browser-tab-dot ${
              tab.isActive ? "tool-call-browser-tab-dot-active" : ""
            }`}
            aria-hidden="true"
          />
          <span className="tool-call-browser-tab-title">
            {tab.title || getHost(tab.instanceId)}
          </span>
          {tab.isActive ? (
            <span className="tool-call-browser-tab-flag">
              {t("toolCall.browser.activeTab")}
            </span>
          ) : null}
          <span className="tool-call-browser-tab-id">
            {shortInstanceId(tab.instanceId)}
          </span>
        </button>
      ))}
    </div>
  );
};

/* ---------------- 主组件 ---------------- */

const RUNNING_LABEL_KEYS: Record<BrowserOperation, string> = {
  create: "toolCall.browser.running.create",
  navigate: "toolCall.browser.running.navigate",
  click: "toolCall.browser.running.click",
  evaluate: "toolCall.browser.running.evaluate",
  type: "toolCall.browser.running.type",
  screenshot: "toolCall.browser.running.screenshot",
  devtools: "toolCall.browser.running.devtools",
  close: "toolCall.browser.running.close",
  focus: "toolCall.browser.running.focus",
  list: "toolCall.browser.running.list",
  wait: "toolCall.browser.running.wait",
  press_key: "toolCall.browser.running.press_key",
  hover: "toolCall.browser.running.hover",
  navigate_back: "toolCall.browser.running.navigate_back",
  navigate_forward: "toolCall.browser.running.navigate_forward",
  select_option: "toolCall.browser.running.select_option",
  "upload-file": "toolCall.browser.running.upload_file",
  back: "toolCall.browser.running.back",
  forward: "toolCall.browser.running.forward",
};

export const BrowserToolCall = ({
  toolCall,
}: BrowserToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = (
    toolCall.name.startsWith("browser-")
      ? toolCall.name.slice("browser-".length)
      : toolCall.name
  ) as BrowserOperation;

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const isRunning = toolCall.status === "running";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;
  const data = parsedResult.type === "success" ? parsedResult.data : null;

  /* 头部 displayName：优先展示 URL host / 选择器 / 实例 ID 等上下文 */
  const argUrl = asString(parsedArgs?.url);
  const argSelector = asString(parsedArgs?.selector);
  const argText = asString(parsedArgs?.text);
  const argInstanceId = asString(parsedArgs?.instanceId);
  const argExpression = asString(parsedArgs?.expression);
  const argRef = asString(parsedArgs?.ref);
  const resultUrl = asString(data?.url);
  const snapshotHost = (() => {
    const snapshot =
      operation === "devtools" && data ? parseSnapshot(data.snapshot) : null;
    return snapshot?.url ? getHost(snapshot.url) : "";
  })();

  let displayName: string | undefined;
  switch (operation) {
    case "create":
      displayName = argUrl ? getHost(argUrl) : t("toolCall.browser.newTab");
      break;
    case "navigate":
      displayName = argUrl ? getHost(argUrl) : undefined;
      break;
    case "click":
      displayName = argSelector
        ? truncateLabel(argSelector, 48)
        : argText
          ? truncateLabel(`"${argText}"`, 48)
          : undefined;
      break;
    case "evaluate":
      displayName = argExpression
        ? truncateLabel(argExpression, 48)
        : undefined;
      break;
    case "type":
      displayName = argSelector
        ? truncateLabel(argSelector, 48)
        : argRef
          ? truncateLabel(argRef, 48)
          : argText
            ? truncateLabel(`"${argText}"`, 48)
            : undefined;
      break;
    case "wait": {
      const waitText = asString(parsedArgs?.text);
      const waitTextGone = asString(parsedArgs?.textGone);
      const waitTime = asNumber(parsedArgs?.time);
      displayName = waitText
        ? truncateLabel(`"${waitText}"`, 48)
        : waitTextGone
          ? truncateLabel(`"${waitTextGone}"`, 48)
          : waitTime !== undefined
            ? `${waitTime}ms`
            : undefined;
      break;
    }
    case "press_key":
      displayName = asString(parsedArgs?.key) ?? undefined;
      break;
    case "hover":
      displayName = argSelector
        ? truncateLabel(argSelector, 48)
        : argText
          ? truncateLabel(`"${argText}"`, 48)
          : undefined;
      break;
    case "select_option":
      displayName = argSelector
        ? truncateLabel(argSelector, 48)
        : argText
          ? truncateLabel(`"${argText}"`, 48)
          : undefined;
      break;
    case "upload-file": {
      const files = Array.isArray(parsedArgs?.files)
        ? parsedArgs.files.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      displayName =
        files.length > 0 ? truncateLabel(files.join(", "), 48) : undefined;
      break;
    }
    case "back":
    case "forward":
    case "navigate_back":
    case "navigate_forward":
      displayName = resultUrl ? getHost(resultUrl) : undefined;
      break;
    case "screenshot":
      displayName = resultUrl ? getHost(resultUrl) : undefined;
      break;
    case "devtools":
      displayName =
        snapshotHost || (data?.url ? getHost(String(data.url)) : "");
      displayName = displayName || undefined;
      break;
    case "close":
    case "focus": {
      const instanceId = asString(data?.instanceId) ?? argInstanceId;
      displayName = instanceId ? shortInstanceId(instanceId) : undefined;
      break;
    }
    case "list":
      displayName = t("toolCall.browser.allTabs");
      break;
  }

  /* 头部 meta 徽章：按操作给出最有信息量的摘要 */
  const meta = (() => {
    if (!data) {
      return null;
    }
    switch (operation) {
      case "navigate": {
        const title = asString(data.title);
        return title ? (
          <span className="tool-call-browser-meta">
            <FileText size={10} aria-hidden="true" />
            {truncateLabel(title, 40)}
          </span>
        ) : null;
      }
      case "click": {
        const element = parseClickedElement(data.element);
        return element ? (
          <span className="tool-call-browser-meta tool-call-browser-meta-code">
            {element.tagName}
          </span>
        ) : null;
      }
      case "evaluate": {
        if (data.result !== undefined) {
          return (
            <span className="tool-call-browser-meta tool-call-browser-meta-code">
              <Braces size={10} aria-hidden="true" />
              {describeResultValue(data.result)}
            </span>
          );
        }
        return null;
      }
      case "type": {
        const element = parseClickedElement(data.element);
        return element ? (
          <span className="tool-call-browser-meta tool-call-browser-meta-code">
            {element.tagName}
          </span>
        ) : null;
      }
      case "wait": {
        const waitedMs = asNumber(data.waitedMs);
        return waitedMs !== undefined ? (
          <span className="tool-call-browser-meta">
            <Timer size={10} aria-hidden="true" />
            {t("toolCall.browser.waitedMs", {
              values: { count: waitedMs.toLocaleString() },
            })}
          </span>
        ) : null;
      }
      case "press_key": {
        const key = asString(data.key) ?? asString(parsedArgs?.key);
        return key ? (
          <span className="tool-call-browser-meta tool-call-browser-meta-code">
            <Keyboard size={10} aria-hidden="true" />
            {key}
          </span>
        ) : null;
      }
      case "hover": {
        const element = parseClickedElement(data.element);
        return element ? (
          <span className="tool-call-browser-meta tool-call-browser-meta-code">
            {element.tagName}
          </span>
        ) : null;
      }
      case "select_option": {
        const count = Array.isArray(data.selectedOptions)
          ? data.selectedOptions.length
          : 0;
        return count > 0 ? (
          <span className="tool-call-browser-meta">
            <ListChecks size={10} aria-hidden="true" />
            {t("toolCall.browser.selectedCount", { values: { count } })}
          </span>
        ) : null;
      }
      case "upload-file": {
        const uploaded = asNumber(data.uploaded);
        return uploaded !== undefined ? (
          <span className="tool-call-browser-meta">
            <Upload size={10} aria-hidden="true" />
            {t("toolCall.browser.uploadedCount", {
              values: { count: uploaded },
            })}
          </span>
        ) : null;
      }
      case "screenshot":
        return (
          <span className="tool-call-browser-meta tool-call-browser-meta-image">
            <Camera size={10} aria-hidden="true" />
            PNG
          </span>
        );
      case "devtools": {
        const action = asString(parsedArgs?.action) ?? "snapshot";
        if (action === "console") {
          const count = parseConsoleMessages(data.messages).length;
          return (
            <span className="tool-call-browser-meta">
              <Terminal size={10} aria-hidden="true" />
              {t("toolCall.browser.messageCount", { values: { count } })}
            </span>
          );
        }
        if (action === "snapshot") {
          const snapshot = parseSnapshot(data.snapshot);
          if (snapshot) {
            return (
              <span className="tool-call-browser-meta">
                {t("toolCall.browser.charCount", {
                  values: { count: snapshot.text.length.toLocaleString() },
                })}
              </span>
            );
          }
        }
        if (action === "network") {
          const count = Array.isArray(data.requests) ? data.requests.length : 0;
          if (count > 0) {
            return (
              <span className="tool-call-browser-meta">
                <Activity size={10} aria-hidden="true" />
                {t("toolCall.browser.requestCount", { values: { count } })}
              </span>
            );
          }
        }
        if (action === "cookies") {
          const count = Array.isArray(data.cookies) ? data.cookies.length : 0;
          if (count > 0) {
            return (
              <span className="tool-call-browser-meta">
                <Cookie size={10} aria-hidden="true" />
                {t("toolCall.browser.cookieCount", { values: { count } })}
              </span>
            );
          }
        }
        if (action === "ax") {
          const stats = isRecord(data.stats) ? data.stats : null;
          const count =
            typeof stats?.emitted === "number"
              ? stats.emitted
              : Array.isArray(data.accessibility)
                ? data.accessibility.length
                : 0;
          if (count > 0) {
            return (
              <span className="tool-call-browser-meta">
                <Accessibility size={10} aria-hidden="true" />
                {t("toolCall.browser.axNodes", { values: { count } })}
              </span>
            );
          }
        }
        if (action === "networkState") {
          const offline = data.state === "offline";
          return (
            <span
              className={`tool-call-browser-meta ${
                offline ? "tool-call-browser-meta-offline" : ""
              }`}
            >
              {offline ? (
                <WifiOff size={10} aria-hidden="true" />
              ) : (
                <Wifi size={10} aria-hidden="true" />
              )}
              {offline
                ? t("toolCall.browser.networkStateOffline")
                : t("toolCall.browser.networkStateOnline")}
            </span>
          );
        }
        return null;
      }
      case "list": {
        const count = parseBrowserTabs(data.tabs).length;
        return (
          <span
            className={`tool-call-browser-meta ${
              count > 0 ? "tool-call-browser-meta-active" : ""
            }`}
          >
            <AppWindow size={10} aria-hidden="true" />
            {t("toolCall.browser.tabCount", { values: { count } })}
          </span>
        );
      }
      default:
        return null;
    }
  })();

  const renderSuccess = (): React.JSX.Element | null => {
    switch (operation) {
      case "create":
        return <CreateView args={parsedArgs} data={data} />;
      case "navigate":
        return <NavigateView args={parsedArgs} data={data} />;
      case "click":
        return <ClickView args={parsedArgs} data={data} />;
      case "evaluate":
        return <EvaluateView args={parsedArgs} data={data} />;
      case "type":
        return <TypeView args={parsedArgs} data={data} />;
      case "wait":
        return <WaitView args={parsedArgs} data={data} />;
      case "press_key":
        return <PressKeyView args={parsedArgs} data={data} />;
      case "hover":
        return <HoverView args={parsedArgs} data={data} />;
      case "select_option":
        return <SelectOptionView args={parsedArgs} data={data} />;
      case "upload-file":
        return <UploadFileView args={parsedArgs} data={data} />;
      case "back":
      case "forward":
      case "navigate_back":
      case "navigate_forward":
        return <HistoryView operation={operation} data={data} />;
      case "screenshot":
        return (
          <ScreenshotView
            args={parsedArgs}
            data={data}
            inlineImages={
              parsedResult.type === "success" ? parsedResult.images : []
            }
          />
        );
      case "devtools":
        return <DevtoolsView args={parsedArgs} data={data} />;
      case "close":
      case "focus":
        return (
          <CloseFocusView operation={operation} args={parsedArgs} data={data} />
        );
      case "list":
        return <ListView data={data} />;
      default:
        return null;
    }
  };

  /* 未完成（等待/执行中）时，click / screenshot / devtools / close / focus
     也需要展示参数，让卡片在运行期间就有内容可看。 */
  const showArgsWhilePending =
    parsedResult.type === "empty" &&
    (operation === "click" ||
      operation === "evaluate" ||
      operation === "type" ||
      operation === "wait" ||
      operation === "press_key" ||
      operation === "hover" ||
      operation === "select_option" ||
      operation === "upload-file" ||
      operation === "screenshot" ||
      operation === "devtools" ||
      operation === "close" ||
      operation === "focus" ||
      operation === "create" ||
      operation === "navigate");

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="web"
      displayName={displayName}
      displayNameTitle={
        argUrl ??
        (operation === "click" ? (argSelector ?? argText) : undefined) ??
        asString(data?.instanceId) ??
        argInstanceId
      }
      status={effectiveStatus}
      meta={meta}
      className="tool-call-browser"
    >
      <div className="tool-call-body tool-call-browser-body">
        {parsedResult.type === "success" ? renderSuccess() : null}

        {showArgsWhilePending ? renderSuccess() : null}

        {/* 错误 */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* 原始结果兜底 */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.browser.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* 等待 / 执行中 */}
        {parsedResult.type === "empty" ? (
          <PendingBlock
            isRunning={isRunning}
            runningLabel={t(RUNNING_LABEL_KEYS[operation])}
            waitingLabel={t("toolCall.browser.waiting")}
          />
        ) : null}
      </div>
    </ToolCallNode>
  );
};
