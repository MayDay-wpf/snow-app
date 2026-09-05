import type { BrowserWindow } from "electron";

const SCHEDULED_TASK_WAKEUP_CHANNEL = "scheduled-tasks:wakeup";
const SCHEDULED_TASK_WAKEUP_INTERVAL_MS = 1_000;

/**
 * Wakes the renderer scheduler from the Electron main process. Main-process
 * timers are not throttled when the window is unfocused, minimized, covered or
 * hidden in the tray; the renderer remains responsible for executing the AI
 * Loop and persisting the resulting task state.
 */
export const startScheduledTaskWakeup = (window: BrowserWindow): (() => void) => {
  const timer = setInterval(() => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(SCHEDULED_TASK_WAKEUP_CHANNEL);
  }, SCHEDULED_TASK_WAKEUP_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return () => clearInterval(timer);
};
