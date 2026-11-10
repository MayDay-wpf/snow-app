import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Keyboard,
  ListChecks,
  Loader2,
  Monitor,
  MousePointer2,
  Move,
  X,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import {
  imageBlockSrc,
  inlineImageSrc,
  stripInlineImageTags,
} from "../utils/inlineImages";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";

type ComputerUseToolCallProps = {
  toolCall: ToolCallInfo;
};

type ScreenshotResult = {
  /** 截图的 <img> 地址（data URL 或落盘路径的 img-proxy 地址）。 */
  imageSrc: string | null;
  text: string | null;
  display?: number;
  imageWidth?: number;
  imageHeight?: number;
  cursorX?: number;
  cursorY?: number;
  region?: { x: number; y: number; width: number; height: number } | null;
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

/**
 * 解析截图结果：content 数组中的 image / text block + 元数据。
 * screen 的 screenshot 结果元数据在顶层；act 的 screenshotAfter 结果元数据
 * 在 `screenshot` 字段里，两者共用同一套解析。
 */
const parseScreenshotResult = (result: string): ScreenshotResult | null => {
  const { text: stripped, values: inlineValues } = stripInlineImageTags(result);

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed)) {
      return null;
    }
    const meta = isRecord(parsed.screenshot) ? parsed.screenshot : parsed;
    const screenshot: ScreenshotResult = {
      imageSrc: null,
      text: null,
      region: isRecord(meta.region)
        ? {
            x: Number(meta.region.x),
            y: Number(meta.region.y),
            width: Number(meta.region.width),
            height: Number(meta.region.height),
          }
        : null,
    };
    if (typeof meta.display === "number") {
      screenshot.display = meta.display;
    }
    if (isRecord(meta.imageSize)) {
      if (typeof meta.imageSize.width === "number") {
        screenshot.imageWidth = meta.imageSize.width;
      }
      if (typeof meta.imageSize.height === "number") {
        screenshot.imageHeight = meta.imageSize.height;
      }
    }
    if (isRecord(meta.cursor)) {
      if (typeof meta.cursor.x === "number") {
        screenshot.cursorX = meta.cursor.x;
      }
      if (typeof meta.cursor.y === "number") {
        screenshot.cursorY = meta.cursor.y;
      }
    }
    if (typeof meta.pixelToScreenScale === "number") {
      screenshot.pixelToScreenScale = meta.pixelToScreenScale;
    }
    if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === "image") {
          screenshot.imageSrc =
            imageBlockSrc(block, inlineValues) ?? screenshot.imageSrc;
        } else if (block.type === "text" && typeof block.text === "string") {
          screenshot.text = block.text;
        }
      }
    }
    // content 数组缺失 image block 但存在内联标签：直接从标签还原
    if (!screenshot.imageSrc && inlineValues.length > 0) {
      screenshot.imageSrc = inlineImageSrc(inlineValues[0]);
    }
    return screenshot;
  } catch {
    return null;
  }
};

/** 是否属于「截图类」调用：screen 的 screenshot 动作，或 act 的 screenshotAfter。 */
const isScreenshotCall = (
  toolName: string,
  args: Record<string, unknown> | null,
): boolean => {
  if (!args) {
    return false;
  }
  if (toolName === "computer-use-screen") {
    return args.action === "screenshot";
  }
  if (toolName === "computer-use-act") {
    return args.screenshotAfter === true;
  }
  return false;
};

/** 生成 header 摘要：按 action 展示最有信息量的参数。 */
const buildArgsSummary = (
  toolName: string,
  args: Record<string, unknown> | null,
): string => {
  if (!args) {
    return "";
  }
  const num = (key: string): number | undefined =>
    typeof args[key] === "number" ? (args[key] as number) : undefined;
  const str = (key: string): string =>
    typeof args[key] === "string" ? (args[key] as string) : "";

  const point = (xKey: string, yKey: string): string | null => {
    const x = num(xKey);
    const y = num(yKey);
    return x !== undefined || y !== undefined
      ? `(${x ?? "?"}, ${y ?? "?"})`
      : null;
  };

  const action = str("action");

  if (toolName === "computer-use-screen") {
    if (action === "screenshot") {
      const display = num("display");
      const hasRegion = isRecord(args.region);
      return `${display !== undefined ? `display ${display}` : ""}${hasRegion ? " · region" : ""}`.trim();
    }
    return "info";
  }

  const button = str("button") || "left";

  switch (action) {
    case "move":
      return point("x", "y") ?? "";
    case "click": {
      const clicks = num("clicks");
      const holdMs = num("holdMs");
      const suffix =
        holdMs && holdMs > 0
          ? ` · hold ${holdMs}ms`
          : clicks && clicks > 1
            ? ` x${clicks}`
            : "";
      const btn = button !== "left" ? `${button} ` : "";
      return `${btn}${point("x", "y") ?? "current"}${suffix}`;
    }
    case "drag": {
      const from = point("x", "y");
      const to = point("toX", "toY");
      return `${from ? `${from} -> ` : ""}${to ?? ""}`;
    }
    case "scroll": {
      const amount = num("amount");
      const axis = str("axis") || "vertical";
      return `${amount ?? "?"} (${axis})`;
    }
    case "mouse-press":
    case "mouse-release": {
      const at = point("x", "y");
      return `${action === "mouse-press" ? "press" : "release"} ${button}${at ? ` @ ${at}` : ""}`;
    }
    case "key-tap": {
      const keys = Array.isArray(args.keys) ? (args.keys as string[]) : [];
      return keys.join(" + ");
    }
    case "key-press":
    case "key-release":
    case "key-hold": {
      const key = str("key");
      const holdMs = num("holdMs");
      const suffix = action === "key-hold" && holdMs ? ` (${holdMs}ms)` : "";
      return `${action.replace("key-", "")} ${key}${suffix}`;
    }
    case "type": {
      const text = str("text");
      const preview = text.length > 40 ? `${text.slice(0, 40)}...` : text;
      const at = point("x", "y");
      return `${preview}${at ? ` @ ${at}` : ""}`;
    }
    case "wait":
      return `wait ${num("ms") ?? 250}ms`;
    case "steps": {
      const steps = Array.isArray(args.actions)
        ? (args.actions as unknown[])
        : [];
      if (steps.length === 0) {
        return "";
      }
      const types = steps
        .map((item) =>
          isRecord(item) && typeof item.type === "string" ? item.type : "?",
        )
        .join(" · ");
      return `${steps.length} steps: ${types}`;
    }
    default:
      return action;
  }
};

const getToolIconName = (toolName: string, action: string) => {
  if (toolName === "computer-use-screen") {
    return Monitor;
  }
  if (action === "steps") {
    return ListChecks;
  }
  if (action.startsWith("key-")) {
    return Keyboard;
  }
  if (action === "drag") {
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

  const isScreenshot = isScreenshotCall(toolCall.name, parsedArgs);
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

  const action =
    typeof parsedArgs?.action === "string" ? parsedArgs.action : "";
  const argsSummary = buildArgsSummary(toolCall.name, parsedArgs);
  const Icon = getToolIconName(toolCall.name, action);

  // 纯截图调用以图片为主体（元数据已单独展示）；act 同截图时仍展示步骤 JSON
  const isPureScreenshot =
    isScreenshot && toolCall.name === "computer-use-screen";
  const showResultText =
    Boolean(toolCall.result) && !hasError && !isPureScreenshot;

  // 点击截图放大查看（Esc / 点击背景关闭）
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const screenshotSrc = screenshotResult?.imageSrc ?? null;

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
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <ToolCallNode
      toolName={toolCall.name}
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
        {screenshotResult && screenshotSrc ? (
          <div className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.computerUse.screenshot")}
            </span>
            <img
              className="computer-use-screenshot-img"
              src={screenshotSrc}
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

        {/* 动作结果 JSON（步骤明细、落点判定、失败原因） */}
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
            <span>{localizeToolError(t, errorMessage)}</span>
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
        !screenshotSrc &&
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
