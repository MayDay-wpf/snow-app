import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Check,
  Copy,
  Image as ImageIcon,
  Loader2,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { localImageProxyUrl } from "../../../../utils/imageProxyUrl";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { isRecord, truncateLabel } from "./imagegenUtils";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";

type ImageDescribeToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedDescribeArgs = {
  path: string;
  prompt?: string;
};

type ParsedDescribeResult =
  | { type: "success"; description: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const parseDescribeArgs = (args: string): ParsedDescribeArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !isRecord(parsed) ||
      typeof parsed.path !== "string" ||
      parsed.path.trim() === ""
    ) {
      return null;
    }
    const result: ParsedDescribeArgs = { path: parsed.path.trim() };
    if (typeof parsed.prompt === "string" && parsed.prompt.trim() !== "") {
      result.prompt = parsed.prompt.trim();
    }
    return result;
  } catch {
    return null;
  }
};

const parseDescribeResult = (
  result: string | undefined,
): ParsedDescribeResult => {
  if (!result) {
    return { type: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (
      typeof parsed.description === "string" &&
      parsed.description.trim() !== ""
    ) {
      return { type: "success", description: parsed.description.trim() };
    }
    if (typeof parsed.error === "string") {
      return {
        type: "error",
        message:
          typeof parsed.message === "string" && parsed.message.trim() !== ""
            ? parsed.message
            : parsed.error,
      };
    }
    if (typeof parsed.message === "string") {
      return { type: "error", message: parsed.message };
    }
    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const ImageDescribeToolCall = ({
  toolCall,
}: ImageDescribeToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseDescribeArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseDescribeResult(toolCall.result),
    [toolCall.result],
  );

  const path = parsedArgs?.path ?? "";
  const isRunning = toolCall.status === "running";
  const isFailed = toolCall.status === "error";
  const effectiveStatus =
    isFailed || parsedResult.type === "error" ? "error" : toolCall.status;

  // 缩略图经 img-proxy 按需读盘（不在内存缓存 data URL）；读取失败时隐藏预览。
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const thumbSrc = path && failedPath !== path ? localImageProxyUrl(path) : "";

  // 点击缩略图放大查看（Esc / 点击背景关闭）
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  useEffect(() => {
    if (!isLightboxOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsLightboxOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isLightboxOpen]);

  const description =
    parsedResult.type === "success" ? parsedResult.description : "";

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async (): Promise<void> => {
    if (description === "") {
      return;
    }
    try {
      await navigator.clipboard.writeText(description);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.warn("[imagegen] copy description failed", error);
    }
  }, [description]);

  const errorMessage =
    parsedResult.type === "error"
      ? localizeToolError(t, parsedResult.message)
      : isFailed && parsedResult.type === "raw"
        ? parsedResult.text
        : "";

  const fileName = path ? fileNameOf(path) : "";

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.imagegen.describeName")}
      category="image"
      displayName={fileName ? truncateLabel(fileName, 60) : undefined}
      displayNameTitle={path || undefined}
      displayNameDataPath={path || undefined}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span className="tool-call-imagegen-count">
            {t("toolCall.imagegen.describeChars", {
              values: { count: description.length.toLocaleString() },
            })}
          </span>
        ) : null
      }
      className="tool-call-imagegen"
    >
      <div className="tool-call-body tool-call-imagegen-body">
        {parsedArgs ? (
          <div className="tool-call-imagegen-params">
            <div className="tool-call-imagegen-param-item">
              <ImageIcon size={11} aria-hidden="true" />
              <span className="tool-call-imagegen-param-label">
                {t("toolCall.imagegen.describeImage")}
              </span>
              <code className="tool-call-imagegen-param-value">
                {parsedArgs.path}
              </code>
            </div>
            {parsedArgs.prompt ? (
              <div className="tool-call-imagegen-param-item">
                <Sparkles size={11} aria-hidden="true" />
                <span className="tool-call-imagegen-param-label">
                  {t("toolCall.imagegen.describePrompt")}
                </span>
                <code className="tool-call-imagegen-param-value">
                  {parsedArgs.prompt}
                </code>
              </div>
            ) : null}
          </div>
        ) : null}

        {thumbSrc ? (
          <div className="tool-call-imagegen-describe-preview">
            <img
              src={thumbSrc}
              alt={fileName || t("toolCall.imagegen.describeImage")}
              title={t("toolCall.computerUse.clickToZoom")}
              onClick={() => setIsLightboxOpen(true)}
              onError={() => setFailedPath(path)}
              draggable={false}
            />
          </div>
        ) : null}

        {errorMessage ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {parsedResult.type === "success" ? (
          <div className="tool-call-imagegen-describe-result">
            <div className="tool-call-imagegen-describe-head">
              <span className="tool-call-imagegen-describe-head-label">
                <ScanSearch size={11} aria-hidden="true" />
                {t("toolCall.imagegen.describeResult")}
              </span>
              <button
                type="button"
                className="tool-call-imagegen-describe-copy"
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <>
                    <Check size={11} aria-hidden="true" />
                    {t("toolCall.imagegen.describeCopied")}
                  </>
                ) : (
                  <>
                    <Copy size={11} aria-hidden="true" />
                    {t("toolCall.imagegen.describeCopy")}
                  </>
                )}
              </button>
            </div>
            <pre className="tool-call-imagegen-describe-text">
              {description}
            </pre>
          </div>
        ) : null}

        {parsedResult.type === "raw" && !isFailed ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.imagegen.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-imagegen-describe-pending${
              isRunning ? " tool-call-imagegen-describe-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <ScanSearch size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.imagegen.describeAnalyzing")
                : t("toolCall.imagegen.describeWaiting")}
            </span>
          </div>
        ) : null}
      </div>

      {isLightboxOpen && thumbSrc
        ? createPortal(
            <div
              className="tool-call-imagegen-lightbox"
              onClick={() => setIsLightboxOpen(false)}
              role="presentation"
            >
              <img
                src={thumbSrc}
                alt={fileName || t("toolCall.imagegen.describeImage")}
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
        : null}
    </ToolCallNode>
  );
};
