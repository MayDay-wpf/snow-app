import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  loadTaskSnapshots,
  taskSnapshotFingerprint,
  type TaskSnapshot,
} from "../hooks/taskHistory";
import type { Locale } from "../../../../../shared/locale";
import { useI18n } from "../../../../i18n";
import { loadPluginMessages } from "../../../../plugins/manifest";
import { createPluginApi } from "../../../../plugins/pluginApi";
import {
  scopePluginMessageFooterApi,
  type PluginMessageFooterContext,
  type PluginMessageFooterMount,
} from "../../../../plugins/pluginMessageFooter";
import {
  injectPluginStyles,
  loadLucideIcons,
  loadPluginModule,
} from "../../../../plugins/pluginRuntime";
import { pluginStore, usePluginStore } from "../../../../plugins/pluginStore";
import type {
  PluginMessageFooterDefinition,
  PluginView,
} from "../../../../plugins/types";
import { useChatConversationContext } from "./ChatConversationContext";

const TASK_HISTORY_REFRESH_DEBOUNCE_MS = 150;
export const TASK_FOOTER_PENDING_ATTRIBUTE = "data-snow-task-footer-pending";

// Keep diagnostics searchable without logging plugin errors, paths or file data.
const logFooterDiagnostic = (
  level: "INFO" | "WARN",
  conversationId: string,
  phase: string,
  details: Record<string, string | number | boolean>,
): void => {
  try {
    void window.snow
      .writeLog(level, {
        module: "plugins/messageFooter",
        func: "PluginMessageFooters",
        message: "Message footer lifecycle",
        context: JSON.stringify({
          conversation_id: conversationId,
          phase,
          ...details,
        }),
      })
      .catch(() => {});
  } catch {
    // Diagnostics must not change the mount or history lifecycle.
  }
};

const PluginMessageFooter = ({
  plugin,
  footer,
  locale,
  identity,
  identityRef,
  conversationId,
  messageId,
  directoryId,
  task,
}: {
  plugin: PluginView;
  footer: PluginMessageFooterDefinition;
  locale: Locale;
  identity: string;
  identityRef: RefObject<string | null>;
  conversationId: string;
  messageId: string;
  directoryId: string | undefined;
  task?: TaskSnapshot;
}): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (footer.taskHistory)
      host.setAttribute(TASK_FOOTER_PENDING_ATTRIBUTE, "");
    const controller = new AbortController();
    const { signal } = controller;
    const container = document.createElement("div");
    container.dataset.pluginMessageFooter = footer.id;
    let cleanup: (() => void) | undefined;
    let removeStyles: (() => void) | undefined;
    let disposed = false;
    const isCurrent = (): boolean =>
      !disposed &&
      identityRef.current === identity &&
      pluginStore.getById(plugin.pluginId) === plugin &&
      plugin.enabled &&
      plugin.renderMode === "esm" &&
      plugin.messageFooters.includes(footer);
    const check = (): void => {
      if (!isCurrent() || signal.aborted)
        throw new DOMException("Footer context expired", "AbortError");
    };
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      host.removeAttribute(TASK_FOOTER_PENDING_ATTRIBUTE);
      controller.abort();
      try {
        cleanup?.();
      } catch {
        console.warn("Plugin footer cleanup failed");
      } finally {
        try {
          removeStyles?.();
        } finally {
          container.replaceChildren();
          container.remove();
        }
      }
    };
    // Invalidate immediately on record replacement; do not wait for React effects.
    const unsubscribeStore = pluginStore.subscribe(() => {
      if (!isCurrent()) dispose();
    });
    const context: PluginMessageFooterContext = Object.freeze({
      slot: "message-footer",
      conversationId,
      messageId,
      directoryId,
      ...(task ? { task } : {}),
    });
    void (async () => {
      let phase = "messages";
      try {
        check();
        const messages = await loadPluginMessages(plugin, locale, signal);
        check();
        phase = "icons";
        const icons = await loadLucideIcons();
        check();
        phase = "api";
        const sourceApi = await createPluginApi({
          plugin,
          locale,
          messages,
          icons,
        });
        check();
        const api = scopePluginMessageFooterApi(
          sourceApi,
          context,
          signal,
          isCurrent,
        );
        phase = "module";
        const module = await loadPluginModule({
          plugin,
          entry: footer.entry,
          api,
          locale,
          signal,
          isCurrent,
        });
        check();
        phase = "styles";
        const styles = await injectPluginStyles(plugin, signal, isCurrent);
        // A late style result is still owned and must be released before throwing.
        removeStyles = styles;
        if (disposed) styles();
        check();
        phase = "export";
        const mount = module[footer.exportName];
        if (typeof mount !== "function")
          throw new Error("Missing footer mount export");
        host.appendChild(container);
        phase = "mount";
        const result = (mount as PluginMessageFooterMount)(
          container,
          api,
          context,
          signal,
        );
        cleanup =
          typeof result === "function" ? result : result?.unmount?.bind(result);
        // A mount may synchronously change the store and invalidate itself.
        if (disposed) {
          try {
            cleanup?.();
          } finally {
            container.replaceChildren();
            container.remove();
          }
        }
        check();
        host.removeAttribute(TASK_FOOTER_PENDING_ATTRIBUTE);
        logFooterDiagnostic("INFO", conversationId, "mounted", {
          pluginId: plugin.pluginId,
          footerId: footer.id,
          messageId,
          hasTask: !!task,
          fileRecordCount: task?.records.length ?? 0,
          coverageCount: task?.coverage.length ?? 0,
          unavailableCoverageCount:
            task?.coverage.filter((record) => record.coverage === "unavailable")
              .length ?? 0,
          concurrentCoverageCount:
            task?.coverage.filter((record) =>
              record.reasons.includes("concurrent-execution"),
            ).length ?? 0,
        });
      } catch {
        if (!signal.aborted && isCurrent()) {
          console.warn(
            "Plugin message footer failed",
            plugin.pluginId,
            footer.id,
          );
          logFooterDiagnostic("WARN", conversationId, "mount-failed", {
            failedAt: phase,
            pluginId: plugin.pluginId,
            footerId: footer.id,
            messageId,
          });
        }
        dispose();
      }
    })();
    return () => {
      unsubscribeStore();
      dispose();
    };
  }, [
    plugin,
    footer,
    locale,
    identity,
    identityRef,
    conversationId,
    messageId,
    directoryId,
    task,
  ]);
  return <div ref={hostRef} style={{ display: "contents" }} />;
};

/** A formal, business-neutral slot for the latest completed assistant reply. */
export const PluginMessageFooters = ({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}): React.JSX.Element | null => {
  const conversation = useChatConversationContext();
  const { locale } = useI18n();
  const { plugins, status: pluginStatus } = usePluginStore();
  const identityRef = useRef<string | null>(null);
  useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);
  const message = conversation.messages.find((item) => item.id === messageId);
  const taskIdentity = JSON.stringify([
    conversationId,
    messageId,
    message?.responseId,
  ]);
  const [loadedTask, setLoadedTask] = useState<{
    identity: string;
    plugins: PluginView[];
    snapshot?: TaskSnapshot;
    fingerprint: string;
  }>();
  const [failedTaskIdentity, setFailedTaskIdentity] = useState<string>();
  // Never expose a previous reply's snapshot while a new identity is loading.
  const task =
    loadedTask?.identity === taskIdentity ? loadedTask.snapshot : undefined;
  const hasTaskFooters = plugins.some(
    (plugin) =>
      plugin.enabled &&
      plugin.renderMode === "esm" &&
      plugin.messageFooters.some((footer) => footer.taskHistory),
  );
  const hasLegacyFooters = plugins.some(
    (plugin) =>
      plugin.enabled &&
      plugin.renderMode === "esm" &&
      plugin.messageFooters.some((footer) => !footer.taskHistory),
  );
  const lastMessage = conversation.messages.findLast(
    (message) => message.role !== "tool",
  );
  const legacyEligible =
    conversation.activeConversationId === conversationId &&
    !conversation.isStreaming &&
    !conversation.isPaused &&
    !conversation.isAborting &&
    lastMessage?.role === "assistant" &&
    lastMessage.id === messageId &&
    lastMessage.status !== "sending";
  useEffect(() => {
    if (!hasTaskFooters) return;
    let disposed = false;
    let generation = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      const current = ++generation;
      void loadTaskSnapshots(conversationId)
        .then((snapshots) => {
          if (disposed || current !== generation) return;
          const next =
            snapshots.get(`message:${messageId}`) ??
            (message?.responseId
              ? snapshots.get(`response:${message.responseId}`)
              : undefined);
          const fingerprint = taskSnapshotFingerprint(next);
          // A stable task ID does not prove the extraction result is unchanged
          // after a host logic update. Keep the mount only for identical evidence.
          setLoadedTask((previous) =>
            previous?.identity === taskIdentity &&
            previous.plugins === plugins &&
            previous.fingerprint === fingerprint
              ? previous
              : {
                  identity: taskIdentity,
                  plugins,
                  snapshot: next,
                  fingerprint,
                },
          );
          if (legacyEligible && !next)
            logFooterDiagnostic("INFO", conversationId, "no-task-snapshot", {
              messageId,
              snapshotKeys: snapshots.size,
            });
        })
        .catch(() => {
          // Preserve only an already fixed snapshot of this same reply.
          // A different identity stays hidden; never fall back to cumulative data.
          if (!disposed && current === generation) {
            setFailedTaskIdentity(taskIdentity);
            console.warn("Task history unavailable");
            logFooterDiagnostic("WARN", conversationId, "history-load-failed", {
              messageId,
            });
          }
        });
    };
    const schedule = (immediate: boolean): void => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (immediate) {
        run();
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        run();
      }, TASK_HISTORY_REFRESH_DEBOUNCE_MS);
    };
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === conversationId)
        schedule(false);
    };
    window.addEventListener("agent-task-history-updated", changed);
    schedule(true);
    return () => {
      disposed = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      window.removeEventListener("agent-task-history-updated", changed);
    };
    // Plugin replacement and run completion must retry an initially failed read,
    // even when the contribution's taskHistory boolean has not changed.
  }, [
    conversationId,
    messageId,
    message?.responseId,
    taskIdentity,
    hasTaskFooters,
    plugins,
    legacyEligible,
  ]);
  const directoryId = conversation.conversationDirectoryId;
  const identity = JSON.stringify([
    conversationId,
    messageId,
    directoryId,
    task?.id,
    locale,
  ]);
  const eligible =
    conversation.activeConversationId === conversationId &&
    message?.role === "assistant" &&
    message.status !== "sending" &&
    ((hasTaskFooters && !!task) || (hasLegacyFooters && legacyEligible));
  identityRef.current = eligible ? identity : null;
  const waitingForTask =
    conversation.activeConversationId === conversationId &&
    message?.role === "assistant" &&
    message.status !== "sending" &&
    (pluginStatus === "idle" ||
      pluginStatus === "loading" ||
      (hasTaskFooters &&
        loadedTask?.identity !== taskIdentity &&
        failedTaskIdentity !== taskIdentity));
  if (!eligible && !waitingForTask) return null;
  const enabled = plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.renderMode === "esm" &&
      plugin.messageFooters.length > 0,
  );
  return (
    <>
      {waitingForTask && (
        <span hidden {...{ [TASK_FOOTER_PENDING_ATTRIBUTE]: "" }} />
      )}
      {eligible &&
        enabled.flatMap((plugin) =>
          plugin.messageFooters
            .filter((footer) => (footer.taskHistory ? !!task : legacyEligible))
            .map((footer) => (
              <PluginMessageFooter
                key={`${plugin.pluginId}:${footer.id}`}
                plugin={plugin}
                footer={footer}
                locale={locale}
                identity={identity}
                identityRef={identityRef}
                conversationId={conversationId}
                messageId={messageId}
                directoryId={directoryId}
                task={footer.taskHistory ? task : undefined}
              />
            )),
        )}
    </>
  );
};
