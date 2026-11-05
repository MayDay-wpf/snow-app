import { useCallback, useEffect, useRef, useState } from "react";
import { captureWebviewPage } from "./captureWebviewPage";

export type ScreenshotFeedback = "idle" | "success" | "error";

const FEEDBACK_RESET_MS = 1500;

/**
 * Hook that captures the current webview page as a full-page PNG image
 * (no scrollbar clipping) and writes it to the system clipboard via IPC
 * (clipboard:write-image).
 *
 * The actual capture logic lives in `captureWebviewPage.ts`; this hook
 * wraps it with React state for loading / success / error feedback.
 */
export const useWebviewScreenshot = (
  webviewRef: React.RefObject<Electron.WebviewTag | null>,
): {
  isCapturing: boolean;
  feedback: ScreenshotFeedback;
  /** 截图并写入剪贴板；返回是否成功，供调用方弹出结果提示 */
  captureScreenshot: () => Promise<boolean>;
} => {
  const [isCapturing, setIsCapturing] = useState(false);
  const [feedback, setFeedback] = useState<ScreenshotFeedback>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending feedback-reset timer on unmount.
  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const setFeedbackWithReset = useCallback(
    (value: ScreenshotFeedback): void => {
      setFeedback(value);
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
      if (value !== "idle") {
        resetTimerRef.current = setTimeout(() => {
          setFeedback("idle");
        }, FEEDBACK_RESET_MS);
      }
    },
    [],
  );

  const captureScreenshot = useCallback(async (): Promise<boolean> => {
    const webview = webviewRef.current;
    if (!webview || isCapturing) {
      return false;
    }

    setIsCapturing(true);
    try {
      const dataUrl = await captureWebviewPage(webview);
      await window.snow.writeImageToClipboard(dataUrl);
      setFeedbackWithReset("success");
      return true;
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
      setFeedbackWithReset("error");
      return false;
    } finally {
      setIsCapturing(false);
    }
  }, [webviewRef, isCapturing, setFeedbackWithReset]);

  return {
    isCapturing,
    feedback,
    captureScreenshot,
  };
};
