import { useCallback, useEffect } from "react";
import type {
  ConversationContextValue,
  ToolCallInfo,
  ToolAuthorizationDecision,
} from "../utils/conversationTypes";
import {
  appendHookExecutionToMessage,
  runHook,
} from "./hookOutcome";
import { directoryIdToPath } from "../utils/conversationHelpers";
import { PENDING_SESSION_KEY } from "../utils/conversationTypes";
import { APP_CONTROL_MODE_CHANGED_EVENT } from "../../../../hooks/useAppControl";

/**
 * 工具授权逻辑：YOLO 模式、敏感命令检查、批量授权闸门等。
 * 同轮工具调用分别显示为对话内卡片，所有授权完成前不执行。
 */
export const useToolAuthorization = (ctx: ConversationContextValue) => {
  // 保持 ref 与 state 同步
  ctx.yoloModeRef.current = ctx.yoloMode;
  ctx.planModeRef.current = ctx.planMode;
  ctx.goalModeRef.current = ctx.goalMode;

  const approveAllPendingToolAuthorizations = useCallback((): void => {
    const pendingEntries = ctx.pendingToolAuthorizationRef.current;
    if (pendingEntries.size === 0) {
      return;
    }

    const approvedAuthorizationIds: string[] = [];
    pendingEntries.forEach((entry, authorizationId) => {
      if ((entry.toolCall.sensitiveCommandMatches?.length ?? 0) > 0) {
        return;
      }

      entry.resolve({ status: "approved" });
      approvedAuthorizationIds.push(authorizationId);
    });
    approvedAuthorizationIds.forEach((authorizationId) =>
      pendingEntries.delete(authorizationId)
    );
    ctx.setPendingToolAuthorizations((current) =>
      current.filter(
        (toolCall) =>
          !toolCall.authorizationId ||
          !approvedAuthorizationIds.includes(toolCall.authorizationId)
      )
    );
  }, [ctx.pendingToolAuthorizationRef, ctx.setPendingToolAuthorizations]);

  const applyYoloMode = useCallback(
    (enabled: boolean): void => {
      ctx.yoloModeRef.current = enabled;
      ctx.setYoloModeState(enabled);
      if (enabled) {
        approveAllPendingToolAuthorizations();
      }
    },
    [ctx.yoloModeRef, ctx.setYoloModeState, approveAllPendingToolAuthorizations]
  );

  const refreshYoloMode = useCallback(async (): Promise<boolean> => {
    try {
      const enabled = await window.snow.getYoloMode();
      applyYoloMode(enabled);
      return enabled;
    } catch {
      applyYoloMode(false);
      return false;
    }
  }, [applyYoloMode]);

  // Persist the session's current mode overrides to the per-conversation
  // record. Fire-and-forget: the in-memory session ref is authoritative for
  // the running loop; the DB row is only for restoring after a restart.
  // Pending (not yet persisted) sessions skip the DB write — their mode
  // follows the session through migrateSession and is written afterwards.
  const persistSessionModes = useCallback(
    (key: string): void => {
      if (key === PENDING_SESSION_KEY) {
        return;
      }
      const ref = ctx.sessionsRefData.current.get(key);
      if (!ref) {
        return;
      }
      void window.snow.setConversationModes(
        key,
        ref.planMode,
        ref.goalMode,
        ref.goalModeTokenBudget
      );
    },
    [ctx.sessionsRefData]
  );

  const applyPlanMode = useCallback(
    (enabled: boolean): void => {
      ctx.planModeRef.current = enabled;
      ctx.setPlanModeState(enabled);
      if (!enabled) {
        // Plan Mode off = this conversation's approval is invalidated (user
        // toggle, Goal Mode mutual exclusion, or external sync). Per-session
        // scope: other conversations keep their independently approved plans,
        // including ones still executing in the background. Switching
        // conversations restores the target session's mode without going
        // through applyPlanMode, so it never clears approvals here — an
        // approved plan survives navigating away and back.
        const key =
          ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
        ctx.planApprovedSessionKeysRef.current.delete(key);
      }
    },
    [ctx.planModeRef, ctx.setPlanModeState, ctx.planApprovedSessionKeysRef]
  );

  const refreshPlanMode = useCallback(async (): Promise<boolean> => {
    // Per-conversation isolation: the session's own ref is the runtime
    // authority, falling back to the neutral default (disabled) for cold
    // sessions. Plan/Goal Mode toggles never touch the persisted global
    // settings, so there is nothing global to re-read here.
    const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
    const ref = ctx.sessionsRefData.current.get(key);
    const effective = ref?.planMode ?? ctx.globalModeDefaultsRef.current.planMode;
    applyPlanMode(effective);
    return effective;
  }, [
    applyPlanMode,
    ctx.globalModeDefaultsRef,
    ctx.activeConversationIdRef,
    ctx.sessionsRefData,
  ]);

  const applyGoalMode = useCallback(
    (enabled: boolean): void => {
      ctx.goalModeRef.current = enabled;
      ctx.setGoalModeState(enabled);
    },
    [ctx.goalModeRef, ctx.setGoalModeState]
  );

  const refreshGoalMode = useCallback(async (): Promise<boolean> => {
    // Per-conversation isolation: see refreshPlanMode. Cold sessions fall
    // back to the neutral default (disabled).
    const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
    const ref = ctx.sessionsRefData.current.get(key);
    const effective = ref?.goalMode ?? ctx.globalModeDefaultsRef.current.goalMode;
    applyGoalMode(effective);
    return effective;
  }, [
    applyGoalMode,
    ctx.globalModeDefaultsRef,
    ctx.activeConversationIdRef,
    ctx.sessionsRefData,
  ]);

  const applyGoalModeTokenBudget = useCallback(
    (budget: number): void => {
      ctx.setGoalModeTokenBudgetState(budget);
    },
    [ctx.setGoalModeTokenBudgetState]
  );

  const refreshGoalModeTokenBudget = useCallback(async (): Promise<void> => {
    // Per-conversation isolation: the session's own override wins, falling
    // back to the neutral default budget for cold sessions.
    const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
    const ref = ctx.sessionsRefData.current.get(key);
    applyGoalModeTokenBudget(
      ref?.goalModeTokenBudget ?? ctx.globalModeDefaultsRef.current.goalModeTokenBudget
    );
  }, [
    applyGoalModeTokenBudget,
    ctx.globalModeDefaultsRef,
    ctx.activeConversationIdRef,
    ctx.sessionsRefData,
  ]);

  const setGoalModeTokenBudget = useCallback(
    async (budget: number): Promise<void> => {
      try {
        applyGoalModeTokenBudget(budget);
        // Per-conversation override: the current session keeps its own
        // budget so switching chats restores the right one. The persisted
        // global default is never touched — strict per-conversation
        // isolation means other (and new) conversations must not inherit
        // this conversation's budget.
        const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
        let ref = ctx.sessionsRefData.current.get(key);
        if (!ref) {
          // A fresh new chat has no session ref yet; create one so the
          // budget survives the first send (migration to a real id).
          ctx.ensureSession(key, ctx.directoryId);
          ref = ctx.sessionsRefData.current.get(key);
        }
        if (ref) {
          ref.goalModeTokenBudget = budget;
          persistSessionModes(key);
        }
      } catch {
        // persist failure - keep current state
      }
    },
    [
      applyGoalModeTokenBudget,
      ctx.ensureSession,
      ctx.directoryId,
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
      persistSessionModes,
    ]
  );

  // 初始化：读取磁盘 YOLO 设置和永久授权工具列表
  useEffect(() => {
    let disposed = false;

    void window.snow
      .getYoloMode()
      .then((enabled) => {
        if (!disposed) {
          applyYoloMode(enabled);
        }
      })
      .catch(() => {
        if (!disposed) {
          applyYoloMode(false);
        }
      });

    // Plan/Goal Mode 是严格按会话隔离的：开关只写当前会话的 ref 和
    // 会话级 DB 记录，从不读写全局设置。因此这里无需（也不应）从
    // 磁盘加载全局模式——冷会话一律使用中性默认值（Plan/Goal 关、
    // 预算 2000000），已打开会话的模式由各自的 session ref 恢复。

    if (ctx.directoryId) {
      void window.snow
        .listToolApprovalProjectApprovedTools(ctx.directoryId)
        .then((toolNames) => {
          if (!disposed) {
            ctx.alwaysApprovedToolsRef.current = new Set(toolNames);
          }
        })
        .catch(() => {
          if (!disposed) {
            ctx.alwaysApprovedToolsRef.current = new Set();
          }
        });
    } else {
      ctx.alwaysApprovedToolsRef.current = new Set();
    }

    return () => {
      disposed = true;
    };
  }, [
    applyYoloMode,
    ctx.directoryId,
    ctx.alwaysApprovedToolsRef,
  ]);

  const setYoloMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (ctx.isUpdatingYoloMode) {
        return;
      }

      ctx.setIsUpdatingYoloMode(true);
      try {
        await window.snow.setYoloMode(enabled);
        applyYoloMode(enabled);
      } finally {
        ctx.setIsUpdatingYoloMode(false);
      }
    },
    [applyYoloMode, ctx.isUpdatingYoloMode, ctx.setIsUpdatingYoloMode]
  );

  const setPlanMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (ctx.isUpdatingPlanMode) {
        return;
      }

      ctx.setIsUpdatingPlanMode(true);
      try {
        // Strict per-conversation isolation: a toggle affects ONLY the
        // current conversation. The persisted global settings are never
        // written or mutated, so other (and new) conversations keep their
        // own modes instead of inheriting this one.
        applyPlanMode(enabled);
        const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
        let ref = ctx.sessionsRefData.current.get(key);
        if (!ref) {
          // A fresh new chat has no session ref yet; create one so the mode
          // survives the first send (migration to a real id).
          ctx.ensureSession(key, ctx.directoryId);
          ref = ctx.sessionsRefData.current.get(key);
        }
        if (ref) {
          ref.planMode = enabled;
          if (enabled) ref.goalMode = false;
          persistSessionModes(key);
        }
        // Mutual exclusion scoped to the current session: enabling Plan Mode
        // disables Goal Mode for THIS conversation only — never for other
        // conversations' stored modes, and never globally.
        if (enabled && ctx.goalModeRef.current) {
          applyGoalMode(false);
          if (ref) {
            ref.goalMode = false;
            persistSessionModes(key);
          }
        }
      } finally {
        ctx.setIsUpdatingPlanMode(false);
      }
    },
    [
      applyPlanMode,
      applyGoalMode,
      ctx.isUpdatingPlanMode,
      ctx.setIsUpdatingPlanMode,
      ctx.ensureSession,
      ctx.directoryId,
      ctx.goalModeRef,
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
      persistSessionModes,
    ]
  );

  const setGoalMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (ctx.isUpdatingGoalMode) {
        return;
      }

      ctx.setIsUpdatingGoalMode(true);
      try {
        // Strict per-conversation isolation: see setPlanMode. The persisted
        // global settings are never written or mutated.
        applyGoalMode(enabled);
        const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
        let ref = ctx.sessionsRefData.current.get(key);
        if (!ref) {
          // A fresh new chat has no session ref yet; create one so the mode
          // survives the first send (migration to a real id).
          ctx.ensureSession(key, ctx.directoryId);
          ref = ctx.sessionsRefData.current.get(key);
        }
        if (ref) {
          ref.goalMode = enabled;
          if (enabled) ref.planMode = false;
          persistSessionModes(key);
        }
        // Mutual exclusion scoped to the current session: enabling Goal Mode
        // disables Plan Mode for THIS conversation only.
        if (enabled && ctx.planModeRef.current) {
          applyPlanMode(false);
          if (ref) {
            ref.planMode = false;
            persistSessionModes(key);
          }
        }
      } finally {
        ctx.setIsUpdatingGoalMode(false);
      }
    },
    [
      applyGoalMode,
      applyPlanMode,
      ctx.isUpdatingGoalMode,
      ctx.setIsUpdatingGoalMode,
      ctx.ensureSession,
      ctx.directoryId,
      ctx.planModeRef,
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
      persistSessionModes,
    ]
  );

  const settleToolAuthorization = useCallback(
    (toolCall: ToolCallInfo, decision: ToolAuthorizationDecision): void => {
      const authorizationId = toolCall.authorizationId;
      if (!authorizationId) {
        return;
      }

      const pending =
        ctx.pendingToolAuthorizationRef.current.get(authorizationId);
      if (!pending) {
        return;
      }

      // Resolve only this tool's authorization. Rejecting one tool in a
      // parallel batch must not cascade-reject the remaining tools.
      ctx.pendingToolAuthorizationRef.current.delete(authorizationId);
      ctx.setPendingToolAuthorizations((current) =>
        current.filter((item) => item.authorizationId !== authorizationId)
      );
      pending.resolve(decision);
    },
    [ctx.pendingToolAuthorizationRef, ctx.setPendingToolAuthorizations]
  );

  /**
   * Reject pending tool authorizations, scoped to a single session when a
   * sessionKey is provided.
   *
   * The pending map is global across all conversations, so an abort in one
   * conversation must only settle the authorizations belonging to that
   * conversation — otherwise force-sending a pending message in session A
   * would silently reject a tool authorization prompt waiting in session B.
   * When sessionKey is omitted (component unmount cleanup) every pending
   * entry is rejected.
   */
  const rejectToolAuthorizations = useCallback(
    (sessionKey?: string): void => {
      const pendingEntries = ctx.pendingToolAuthorizationRef.current;
      const targetAuthorizationIds: string[] = [];
      pendingEntries.forEach((entry, authorizationId) => {
        if (
          sessionKey !== undefined &&
          entry.toolCall.authorizationConversationId !== sessionKey
        ) {
          return;
        }
        entry.resolve({
          status: "rejected",
          reason: "Tool execution interrupted",
        });
        targetAuthorizationIds.push(authorizationId);
      });
      targetAuthorizationIds.forEach((authorizationId) =>
        pendingEntries.delete(authorizationId)
      );
      if (targetAuthorizationIds.length > 0) {
        ctx.setPendingToolAuthorizations((current) =>
          current.filter(
            (toolCall) =>
              !toolCall.authorizationId ||
              !targetAuthorizationIds.includes(toolCall.authorizationId)
          )
        );
      }
    },
    [ctx.pendingToolAuthorizationRef, ctx.setPendingToolAuthorizations]
  );

  const requestToolAuthorization = useCallback(
    (
      toolCall: ToolCallInfo,
      index: number,
      conversationId: string,
      projectId?: string
    ): Promise<ToolAuthorizationDecision> => {
      if (toolCall.name === "user-interaction-askUserQuestion") {
        return Promise.resolve({ status: "approved" });
      }

      const shouldAutoApprove = () =>
        ctx.yoloModeRef.current ||
        ctx.alwaysApprovedToolsRef.current.has(toolCall.name);

      // Sensitive command check: even in YOLO mode, bash commands that match
      // the current project's merged rules must be confirmed.
      const checkSensitiveBash = async (): Promise<
        ToolAuthorizationDecision | "needs-dialog"
      > => {
        if (toolCall.name !== "bash-terminal-execute") {
          return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
        }

        let command = "";
        let isInteractive = false;
        try {
          const parsed = JSON.parse(toolCall.arguments || "{}");
          if (typeof parsed?.command === "string") {
            command = parsed.command;
          }
          if (typeof parsed?.isInteractive === "boolean") {
            isInteractive = parsed.isInteractive;
          }
        } catch {
          // ignore parse error
        }

        // Interactive commands skip the sensitive-command gate entirely
        // because the user is expected to confirm every input in the
        // interactive terminal UI — a separate confirmation dialog would
        // be redundant.
        if (isInteractive) {
          return { status: "approved" };
        }

        if (!command) {
          return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
        }

        try {
          const matches = await window.snow.checkSensitiveCommandMatch(
            command,
            projectId
          );
          if (matches.length > 0) {
            // Sensitive command detected — force authorization dialog
            // even in YOLO mode.
            const authorizationId = `${
              toolCall.callId ?? toolCall.name
            }-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const pendingToolCall: ToolCallInfo = {
              ...toolCall,
              authorizationId,
              authorizationConversationId: conversationId,
              sensitiveCommandMatches: matches,
            };

            // 通知系统：敏感命令被拦截，需要用户确认
            ctx.notifySensitiveCommandIntercepted({
              conversationId,
              directoryId:
                projectId ??
                ctx.sessionsRefData.current.get(conversationId)?.directoryId,
              toolName: toolCall.name,
            });

            return new Promise<ToolAuthorizationDecision>((resolve) => {
              ctx.pendingToolAuthorizationRef.current.set(authorizationId, {
                toolCall: pendingToolCall,
                resolve,
              });
              ctx.setPendingToolAuthorizations((current) => [
                ...current,
                pendingToolCall,
              ]);
            });
          }
        } catch {
          // If the check fails, fall through to normal authorization flow.
        }

        return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
      };

      return checkSensitiveBash().then((decision) => {
        if (decision !== "needs-dialog") {
          return decision;
        }

        // Normal authorization flow (non-YOLO, non-sensitive).
        const authorizationId = `${
          toolCall.callId ?? toolCall.name
        }-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const pendingToolCall = {
          ...toolCall,
          authorizationId,
          authorizationConversationId: conversationId,
        };

        return new Promise<ToolAuthorizationDecision>((resolve) => {
          ctx.pendingToolAuthorizationRef.current.set(authorizationId, {
            toolCall: pendingToolCall,
            resolve,
          });
          ctx.setPendingToolAuthorizations((current) => [
            ...current,
            pendingToolCall,
          ]);
        });
      });
    },
    [
      ctx.yoloModeRef,
      ctx.alwaysApprovedToolsRef,
      ctx.pendingToolAuthorizationRef,
      ctx.sessionsRefData,
      ctx.setPendingToolAuthorizations,
      ctx.notifySensitiveCommandIntercepted,
    ]
  );

  const requestToolAuthorizations = useCallback(
    async (
      toolCalls: ToolCallInfo[],
      conversationId: string,
      projectId?: string
    ): Promise<ToolAuthorizationDecision[]> => {
      // Read the persisted app setting once per tool batch so recent YOLO
      // changes take effect without querying SQLite for every tool.
      try {
        const enabled = await window.snow.getYoloMode();
        applyYoloMode(enabled);
      } catch {
        // Keep the last known in-memory state if the read fails.
      }

      // YOLO has no authorization dialog, so toolConfirmation does not run.
      // beforeToolCall remains the pre-execution policy gate in both modes.
      if (ctx.yoloModeRef.current) {
        return Promise.all(
          toolCalls.map((toolCall, index) =>
            requestToolAuthorization(toolCall, index, conversationId, projectId)
          )
        );
      }

      // Non-YOLO flow: execute toolConfirmation before showing authorization.
      const hookDecisions = await Promise.all(
        toolCalls.map(async (toolCall) => {
          try {
            const toolConfirmContext = JSON.stringify({
              toolName: toolCall.name,
              args: JSON.parse(toolCall.arguments || "{}"),
              cwd: directoryIdToPath(projectId) ?? ctx.directoryPath ?? "",
            });
            const confirmResult = await runHook(
              "toolConfirmation",
              projectId || undefined,
              toolConfirmContext
            );
            if (confirmResult) {
              ctx.updateSessionMessages(conversationId, (currentMessages) =>
                appendHookExecutionToMessage(
                  currentMessages,
                  confirmResult.record
                )
              );
              if (confirmResult.outcome.kind === "abort") {
                return {
                  status: "rejected" as const,
                  reason: confirmResult.outcome.message,
                };
              }
            }
          } catch {
            // Hook execution failed — continue with normal authorization
          }
          return null;
        })
      );

      return Promise.all(
        toolCalls.map((toolCall, index) => {
          const hookDecision = hookDecisions[index];
          if (hookDecision) {
            return Promise.resolve(hookDecision);
          }
          return requestToolAuthorization(
            toolCall,
            index,
            conversationId,
            projectId
          );
        })
      );
    },
    [applyYoloMode, requestToolAuthorization, ctx.directoryPath]
  );

  const approveToolAuthorizationAlways = useCallback(
    (toolCall: ToolCallInfo): void => {
      if (ctx.directoryId) {
        void window.snow
          .setToolApprovalProjectToolApproved(
            ctx.directoryId,
            toolCall.name,
            true
          )
          .then(() => {
            ctx.alwaysApprovedToolsRef.current.add(toolCall.name);
          })
          .catch(() => {
            // The current execution can continue even if persistence fails.
          })
          .finally(() =>
            settleToolAuthorization(toolCall, { status: "approved" })
          );
      } else {
        // No project context: skip persistence and just approve this call.
        ctx.alwaysApprovedToolsRef.current.add(toolCall.name);
        settleToolAuthorization(toolCall, { status: "approved" });
      }
    },
    [ctx.directoryId, ctx.alwaysApprovedToolsRef, settleToolAuthorization]
  );

  // 卸载时清理所有待处理授权
  useEffect(
    () => () => rejectToolAuthorizations(),
    [rejectToolAuthorizations]
  );

  // app-control-setMode writes the global settings directly; replay it
  // through the session-aware path so the active session's ref, global
  // defaults and per-conversation DB record all stay consistent. Without
  // this, an AI-driven mode switch would leave the running session's gate
  // state stale (the loop reads the session ref, not the global setting).
  useEffect(() => {
    const onModeChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{
        mode: string;
        enabled: boolean;
      }>).detail;
      if (!detail || typeof detail.enabled !== "boolean") {
        return;
      }
      if (detail.mode === "plan") {
        void setPlanMode(detail.enabled);
      } else if (detail.mode === "goal") {
        void setGoalMode(detail.enabled);
      }
    };
    window.addEventListener(APP_CONTROL_MODE_CHANGED_EVENT, onModeChanged);
    return () => {
      window.removeEventListener(APP_CONTROL_MODE_CHANGED_EVENT, onModeChanged);
    };
  }, [setPlanMode, setGoalMode]);

  return {
    approveAllPendingToolAuthorizations,
    applyYoloMode,
    refreshYoloMode,
    setYoloMode,
    applyPlanMode,
    refreshPlanMode,
    setPlanMode,
    applyGoalMode,
    refreshGoalMode,
    setGoalMode,
    applyGoalModeTokenBudget,
    refreshGoalModeTokenBudget,
    setGoalModeTokenBudget,
    settleToolAuthorization,
    rejectToolAuthorizations,
    requestToolAuthorization,
    requestToolAuthorizations,
    approveToolAuthorizationAlways,
  };
};
