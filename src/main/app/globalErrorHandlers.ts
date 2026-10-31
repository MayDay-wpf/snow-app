import { app, crashReporter } from "electron";
import { flushLogs, snowLog } from "../../utils/snowLogger";
import { appendTrace } from "./runtimeTrace";

const REPEAT_WINDOW_MS = 5000;
const MAX_RECENT_FAILURES = 100;
const MAX_FIELD_CHARS = 4000;

const recentFailures = new Map<string, { at: number; count: number }>();

const truncate = (value: string): string =>
  value.length > MAX_FIELD_CHARS
    ? `${value.slice(0, MAX_FIELD_CHARS)}...`
    : value;

const describeError = (value: unknown): { message: string; stack: string } => {
  if (value instanceof Error) {
    return {
      message: `${value.name}: ${value.message}`,
      stack: value.stack ?? "",
    };
  }
  if (typeof value === "string") return { message: value, stack: "" };
  try {
    const serialized = JSON.stringify(value);
    return { message: serialized ?? String(value), stack: "" };
  } catch {
    return { message: String(value), stack: "" };
  }
};

const takeRepeatCount = (fingerprint: string): number | null => {
  const now = Date.now();
  const previous = recentFailures.get(fingerprint);
  if (previous && now - previous.at < REPEAT_WINDOW_MS) {
    previous.count += 1;
    return null;
  }
  if (recentFailures.size >= MAX_RECENT_FAILURES) recentFailures.clear();
  recentFailures.set(fingerprint, { at: now, count: 0 });
  return previous?.count ?? 0;
};

const reportUncaught = (origin: string, value: unknown): void => {
  try {
    const { message, stack } = describeError(value);
    const repeats = takeRepeatCount(
      `${origin}:${message}:${stack.slice(0, 200)}`,
    );
    if (repeats === null) return;
    snowLog.error({
      module: "app/globalErrorHandlers",
      func: origin,
      message: `Uncaught ${origin} in the main process`,
      error: truncate(stack ? `${message}\n${stack}` : message),
      context: JSON.stringify({
        origin,
        repeats,
        pid: process.pid,
        platform: process.platform,
        electron: process.versions.electron,
      }),
    });
    void flushLogs();
  } catch {}
};

let installed = false;

export const installGlobalErrorHandlers = (): void => {
  if (installed) return;
  installed = true;

  try {
    crashReporter.start({ uploadToServer: false, compress: true });
  } catch (error) {
    snowLog.warn({
      module: "app/globalErrorHandlers",
      func: "crashReporter.start",
      message: "Failed to start the crash reporter",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  process.on("uncaughtException", (error) => {
    reportUncaught("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    reportUncaught("unhandledRejection", reason);
  });

  app.on("child-process-gone", (_event, details) => {
    appendTrace({ ev: "child-process-gone", details });
    snowLog.error({
      module: "app/globalErrorHandlers",
      func: "child-process-gone",
      message: "Child process gone",
      context: truncate(JSON.stringify(details)),
    });
    void flushLogs();
  });
};
