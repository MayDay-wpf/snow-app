import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ListChecks,
  Loader2,
  Monitor,
  MousePointer2,
  Move,
  ScanLine,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type ComputerUseToolCallProps = {
  toolCall: ToolCallInfo;
};

type ImageBlock = {
  mimeType: string;
  data: string;
};

type ScreenshotResult = {
  image: ImageBlock | null;
  text: string | null;
  display?: number;
  imageWidth?: number;
  imageHeight?: number;
  cursorX?: number;
  cursorY?: number;
  region?: { x: number; y: number; width: number; height: number } | null;
  scale?: number;
  pixelToScreenScale?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasResultError = (result: string | undefined): boolean => {
  if (!result) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

const getResultErrorMessage = (result: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(result);
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    /* ignore */
  }
  return null;
};

/** 匹配 result 文本中追加的内联图片标签（@@image:data:...@@）。
 *  持久化时 formatMcpToolResultForModel 把 image block 的真实 base64
 *  替换为占位符并追加此标签，直接 JSON.parse 整串会失败，需先剥离。 */
const INLINE_IMAGE_TAG_RE = /@@image:(data:[^@]+)@@/g;

/** 从 data URL 提取 base64 数据部分（"data:image/jpeg;base64,..." -> "..."）。 */
const base64FromDataUrl = (dataUrl: string): string | null => {
  const comma = dataUrl.indexOf(",");
  return comma > 0 ? dataUrl.slice(comma + 1) : null;
};

/** 解析 screenshot 结果：content 数组中的 image / text block + 元数据。 */
const parseScreenshotResult = (result: string): ScreenshotResult | null => {
  // 先提取并剥离内联图片标签（真实 base64 在标签中，JSON 内是占位符）
  const inlineDataUrls: string[] = [];
  const stripped = result
    .replace(INLINE_IMAGE_TAG_RE, (_match, dataUrl: string) => {
      inlineDataUrls.push(dataUrl);
      return "";
    })
    .trim();

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed)) {
      return null;
    }
    const screenshot: ScreenshotResult = {
      image: null,
      text: null,
      region: isRecord(parsed.region)
        ? {
            x: Number(parsed.region.x),
            y: Number(parsed.region.y),
            width: Number(parsed.region.width),
            height: Number(parsed.region.height),
          }
        : null,
    };
    if (typeof parsed.display === "number") {
      screenshot.display = parsed.display;
    }
    if (isRecord(parsed.imageSize)) {
      if (typeof parsed.imageSize.width === "number") {
        screenshot.imageWidth = parsed.imageSize.width;
      }
      if (typeof parsed.imageSize.height === "number") {
        screenshot.imageHeight = parsed.imageSize.height;
      }
    }
    if (isRecord(parsed.cursor)) {
      if (typeof parsed.cursor.x === "number") {
        screenshot.cursorX = parsed.cursor.x;
      }
      if (typeof parsed.cursor.y === "number") {
        screenshot.cursorY = parsed.cursor.y;
      }
    }
    if (typeof parsed.pixelToScreenScale === "number") {
      screenshot.pixelToScreenScale = parsed.pixelToScreenScale;
    }
    if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === "image" && typeof block.mimeType === "string") {
          let data = typeof block.data === "string" ? block.data : "";
          // 持久化时真实 base64 被替换为占位符，用标签中的 data URL 还原
          if (
            (data === "" || data === "[attached as multimodal image]") &&
            inlineDataUrls.length > 0
          ) {
            const dataUrl = inlineDataUrls.shift();
            data = dataUrl ? (base64FromDataUrl(dataUrl) ?? "") : "";
          }
          if (data) {
            screenshot.image = {
              mimeType: block.mimeType,
              data,
            };
          }
        } else if (block.type === "text" && typeof block.text === "string") {
          screenshot.text = block.text;
        }
      }
    }
    // content 数组缺失 image block 但存在内联标签：直接从标签还原
    if (!screenshot.image && inlineDataUrls.length > 0) {
      const dataUrl = inlineDataUrls[0];
      const base64 = base64FromDataUrl(dataUrl);
      if (base64) {
        const mimeTypeMatch = /^data:([^;,]+)/.exec(dataUrl);
        screenshot.image = {
          mimeType: mimeTypeMatch?.[1] ?? "image/jpeg",
          data: base64,
        };
      }
    }
    return screenshot;
  } catch {
    return null;
  }
};

/** 生成 header 摘要：按工具类型展示最有信息量的参数。 */
const buildArgsSummary = (
  toolName: string,
  args: Record<string, unknown> | null,
): string => {
  if (!args) {
    return "";
  }
  const num = (key: string): number | undefined =>
    typeof args[key] === "number" ? (args[key] as number) : undefined;

  const point = (xKey: string, yKey: string): string | null => {
    const x = num(xKey);
    const y = num(yKey);
    return x !== undefined || y !== undefined
      ? `(${x ?? "?"}, ${y ?? "?"})`
      : null;
  };

  switch (toolName) {
    case "computer-use-screenshot": {
      const display = num("display");
      const hasRegion = isRecord(args.region);
      return `${display !== undefined ? `display ${display}` : ""}${hasRegion ? " · region" : ""}`.trim();
    }
    case "computer-use-mouse-move":
      return point("x", "y") ?? "";
    case "computer-use-mouse-click": {
      const button =
        typeof args.button === "string" && args.button !== "left"
          ? `${args.button} `
          : "";
      const clicks = num("clicks");
      const holdMs = num("holdMs");
      const suffix =
        holdMs && holdMs > 0
          ? ` · hold ${holdMs}ms`
          : clicks && clicks > 1
            ? ` x${clicks}`
            : "";
      return `${button}${point("x", "y") ?? "current"}${suffix}`;
    }
    case "computer-use-mouse-drag": {
      const from = point("x", "y");
      const to = point("toX", "toY");
      return `${from ? `${from} -> ` : ""}${to ?? ""}`;
    }
    case "computer-use-mouse-scroll": {
      const amount = num("amount");
      const axis = typeof args.axis === "string" ? args.axis : "vertical";
      return `${amount ?? "?"} (${axis})`;
    }
    case "computer-use-mouse-button": {
      const action = typeof args.action === "string" ? args.action : "";
      const button = typeof args.button === "string" ? args.button : "left";
      const at = point("x", "y");
      return `${action} ${button}${at ? ` @ ${at}` : ""}`;
    }
    case "computer-use-key-tap": {
      const keys = Array.isArray(args.keys) ? (args.keys as string[]) : [];
      return keys.join(" + ");
    }
    case "computer-use-key-button": {
      const action = typeof args.action === "string" ? args.action : "";
      const key = typeof args.key === "string" ? args.key : "";
      const holdMs = num("holdMs");
      return `${action} ${key}${holdMs && action === "hold" ? ` (${holdMs}ms)` : ""}`;
    }
    case "computer-use-type-text": {
      const text = typeof args.text === "string" ? args.text : "";
      const preview = text.length > 40 ? `${text.slice(0, 40)}...` : text;
      const at = point("x", "y");
      return `${preview}${at ? ` @ ${at}` : ""}`;
    }
    case "computer-use-perform-actions": {
      const actions = Array.isArray(args.actions)
        ? (args.actions as unknown[])
        : [];
      if (actions.length === 0) {
        return "";
      }
      const types = actions
        .map((item) =>
          isRecord(item) && typeof item.type === "string" ? item.type : "?",
        )
        .join(" · ");
      return `${actions.length} steps: ${types}`;
    }
    default:
      return "";
  }
};

const getToolIconName = (toolName: string) => {
  if (
    toolName === "computer-use-screenshot" ||
    toolName === "computer-use-screen-info"
  ) {
    return Monitor;
  }
  if (toolName === "computer-use-perform-actions") {
    return ListChecks;
  }
  if (
    toolName === "computer-use-key-tap" ||
    toolName === "computer-use-key-button"
  ) {
    return ScanLine;
  }
  if (toolName === "computer-use-mouse-drag") {
    return Move;
  }
  return MousePointer2;
};

export const ComputerUseToolCall = ({
  toolCall,
}: ComputerUseToolCallProps): React.JSX.Element => {
  const { t } = useI18n();

  const parsedArgs = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(toolCall.arguments);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, [toolCall.arguments]);

  const isScreenshot = toolCall.name === "computer-use-screenshot";
  const screenshotResult = useMemo(
    () =>
      isScreenshot && toolCall.result
        ? parseScreenshotResult(toolCall.result)
        : null,
    [isScreenshot, toolCall.result],
  );

  const errorMessage = toolCall.result
    ? getResultErrorMessage(toolCall.result)
    : null;
  const hasError = Boolean(errorMessage) || hasResultError(toolCall.result);
  const effectiveStatus = hasError ? "error" : toolCall.status;
  const isRunning = toolCall.status === "running";

  const badgeName = t(`toolNames.${toolCall.name}`, { defaultValue: "" });
  const argsSummary = buildArgsSummary(toolCall.name, parsedArgs);
  const Icon = getToolIconName(toolCall.name);

  // screenshot 的结果以图片为主体，文本结果仅在出错时展示
  const showResultText = !isScreenshot && toolCall.result && !hasError;

  // 点击截图放大查看（Esc / 点击背景关闭）
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const screenshotSrc = screenshotResult?.image
    ? `data:${screenshotResult.image.mimeType};base64,${screenshotResult.image.data}`
    : null;

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
    isLightboxOpen && screenshotSrc
      ? createPortal(
          <div
            className="tool-call-imagegen-lightbox"
            onClick={() => setIsLightboxOpen(false)}
            role="presentation"
          >
            <img
              src={screenshotSrc}
              alt={t("toolCall.computerUse.screenshot")}
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
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={badgeName || undefined}
      category={isScreenshot ? "image" : "generic"}
      displayName={
        argsSummary ? (
          <span className="computer-use-summary">
            <Icon size={11} aria-hidden="true" />
            <span>{argsSummary}</span>
          </span>
        ) : null
      }
      status={effectiveStatus}
      className="computer-use-tool-call"
      lazyBody={isScreenshot}
    >
      <div className="tool-call-body computer-use-body">
        {/* 参数 */}
        {parsedArgs && Object.keys(parsedArgs).length > 0 ? (
          <div className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.arguments")}
            </span>
            <pre className="tool-call-section-pre">
              {JSON.stringify(parsedArgs, null, 2)}
            </pre>
          </div>
        ) : null}

        {/* 截图预览（点击放大） */}
        {screenshotResult?.image ? (
          <div className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.computerUse.screenshot")}
            </span>
            <img
              className="computer-use-screenshot-img"
              src={screenshotSrc ?? undefined}
              alt={t("toolCall.computerUse.screenshot")}
              title={t("toolCall.computerUse.clickToZoom")}
              onClick={() => setIsLightboxOpen(true)}
            />
            <div className="computer-use-screenshot-meta">
              {screenshotResult.display !== undefined ? (
                <span>
                  {t("toolCall.computerUse.display")}:{" "}
                  {screenshotResult.display}
                </span>
              ) : null}
              {screenshotResult.imageWidth !== undefined &&
              screenshotResult.imageHeight !== undefined ? (
                <span>
                  {screenshotResult.imageWidth}x{screenshotResult.imageHeight}
                </span>
              ) : null}
              {screenshotResult.pixelToScreenScale !== undefined ? (
                <span>
                  {t("toolCall.computerUse.scale")}:{" "}
                  {screenshotResult.pixelToScreenScale.toFixed(4)}
                </span>
              ) : null}
              {screenshotResult.cursorX !== undefined &&
              screenshotResult.cursorY !== undefined ? (
                <span>
                  {t("toolCall.computerUse.cursor")}: (
                  {screenshotResult.cursorX}, {screenshotResult.cursorY})
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 换算说明（模型收到的那段 text block，用户可展开核对） */}
        {screenshotResult?.text ? (
          <div className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.computerUse.mapping")}
            </span>
            <pre className="tool-call-section-pre computer-use-mapping-text">
              {screenshotResult.text}
            </pre>
          </div>
        ) : null}

        {/* 非截图工具的结果 JSON */}
        {showResultText ? (
          <div className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.common.result")}
            </span>
            <pre className="tool-call-section-pre">{toolCall.result}</pre>
          </div>
        ) : null}

        {/* 错误 */}
        {errorMessage ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {/* 运行中 */}
        {isRunning && !screenshotResult ? (
          <div className="computer-use-pending">
            <Loader2
              className="tool-call-icon-spinning"
              size={14}
              aria-hidden="true"
            />
            <span>{t("toolCall.computerUse.running")}</span>
          </div>
        ) : null}

        {/* 截图但无图片（错误或权限缺失）：展示 badge 提示 */}
        {isScreenshot &&
        toolCall.status === "completed" &&
        !screenshotResult?.image &&
        !hasError ? (
          <div className="computer-use-pending">
            <Monitor size={14} aria-hidden="true" />
            <span>{t("toolCall.computerUse.noImage")}</span>
          </div>
        ) : null}
      </div>
      {lightboxElement}
    </ToolCallNode>
  );
};
