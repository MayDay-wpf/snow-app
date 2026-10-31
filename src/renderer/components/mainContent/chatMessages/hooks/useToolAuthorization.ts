import { useCallback, useEffect } from "react";
import { useI18n } from "../../../../i18n";
import type {
  ConversationContextValue,
  ToolCallInfo,
  ToolAuthorizationDecision,
} from "../utils/conversationTypes";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";
import {
  directoryIdToPath,
  hasValidConversationWorktree,
  updateFirstMatchingToolCall,
} from "../utils/conversationHelpers";
import {
  PENDING_SESSION_KEY,
  isPendingSessionKey,
} from "../utils/conversationTypes";
import { APP_CONTROL_MODE_CHANGED_EVENT } from "../../../../hooks/useAppControl";
import { writeRendererLog } from "../../../../utils/rendererLog";
import { buildSensitiveCommandContext } from "../utils/sensitiveCommandContext";

/** 敏感命令复核日志里命令文本的最大长度（超出截断）。 */
const SENSITIVE_COMMAND_LOG_MAX_CHARS = 200;

/** 判定里的风险等级（provider 未给出时为空，不写字段，UI 不显示徽标）。 */
const pickSeverity = (decision: {
  severity?: string | null;
  severityScore?: number | null;
}): { severity?: string; severityScore?: number } => ({
  ...(decision.severity ? { severity: decision.severity } : {}),
  ...(typeof decision.severityScore === "number"
    ? { severityScore: decision.severityScore }
    : {}),
});

/** 会话上下文使用情况（开关关闭时不写字段，UI 不显示）。 */
const pickContextUsage = (decision: {
  contextEnabled?: boolean;
  contextMessages?: number;
  contextTruncated?: boolean;
  contextEmpty?: boolean;
}): {
  contextMessages?: number;
  contextTruncated?: boolean;
  contextEmpty?: boolean;
} =>
  decision.contextEnabled
    ? {
        contextMessages: decision.contextMessages ?? 0,
        contextTruncated: decision.contextTruncated === true,
        contextEmpty: decision.contextEmpty === true,
      }
    : {};

/** 权限面板增删项目级免审批工具后派发，授权流程据此重新加载合并列表。 */
export const TOOL_APPROVALS_CHANGED_EVENT = "tool-approvals:changed";

/** MCP 面板手动启用 Browser / App Control / Terminal Control 服务（精简模式
 *  自动关闭）后派发，会话层据此重新读取精简模式状态。 */
export const LITE_MODE_CHANGED_EVENT = "lite-mode:changed";

/** 待授权项的会话归属 key：授权请求发生时的会话 key（可能是新会话槽位）。 */
const authorizationSessionKey = (
  ctx: ConversationContextValue,
  toolCall: ToolCallInfo,
): string =>
  toolCall.authorizationConversationId ||
  ctx.activeSessionKeyRef.current ||
  PENDING_SESSION_KEY;

/**
 * 把一条待授权项记入「按会话隔离」的镜像。会话面板据此渲染自己会话的授权卡片；
 * 主视图仍读 pendingToolAuthorizations（当前激活会话的切片）。
 */
const addPendingAuthorizationMirror = (
  ctx: ConversationContextValue,
  toolCall: ToolCallInfo,
): void => {
  const key = authorizationSessionKey(ctx, toolCall);
  ctx.setPendingToolAuthorizationsBySession((prev) => ({
    ...prev,
    [key]: [...(prev[key] ?? []), toolCall],
  }));
};

/** 从「按会话隔离」的镜像中移除若干待授权项（按 authorizationId 匹配）。 */
const removePendingAuthorizationMirror = (
  ctx: ConversationContextValue,
  authorizationIds: string[],
): void => {
  if (authorizationIds.length === 0) {
    return;
  }
  const ids = new Set(authorizationIds);
  ctx.setPendingToolAuthorizationsBySession((prev) => {
    let changed = false;
    const next: Record<string, ToolCallInfo[]> = {};
    for (const [key, entries] of Object.entries(prev)) {
      const kept = entries.filter(
        (entry) => !entry.authorizationId || !ids.has(entry.authorizationId),
      );
      if (kept.length !== entries.length) {
        changed = true;
      }
      if (kept.length > 0) {
        next[key] = kept;
      }
    }
    return changed ? next : prev;
  });
};

/**
 * 工具授权逻辑：YOLO 模式、敏感命令检查、批量授权闸门等。
 * 同轮工具调用分别显示为对话内卡片，所有授权完成前不执行。
 */
export const useToolAuthorization = (ctx: ConversationContextValue) => {
  const { t } = useI18n();

  // 保持 ref 与 state 同步
  ctx.yoloModeRef.current = ctx.yoloMode;
  ctx.goalModeRef.current = ctx.goalMode;
  ctx.worktreeModeRef.current = ctx.worktreeMode;
  ctx.workflowModeRef.current = ctx.workflowMode;

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
      pendingEntries.delete(authorizationId),
    );
    removePendingAuthorizationMirror(ctx, approvedAuthorizationIds);
    ctx.setPendingToolAuthorizations((current) =>
      current.filter(
        (toolCall) =>
          !toolCall.authorizationId ||
          !approvedAuthorizationIds.includes(toolCall.authorizationId),
      ),
    );
  }, [
    ctx.pendingToolAuthorizationRef,
    ctx.setPendingToolAuthorizations,
    ctx.setPendingToolAuthorizationsBySession,
  ]);

  const applyYoloMode = useCallback(
    (enabled: boolean): void => {
      ctx.yoloModeRef.current = enabled;
      ctx.setYoloModeState(enabled);
      if (enabled) {
        approveAllPendingToolAuthorizations();
      }
    },
    [
      ctx.yoloModeRef,
      ctx.setYoloModeState,
      approveAllPendingToolAuthorizations,
    ],
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

  const applyLiteMode = useCallback(
    (enabled: boolean): void => {
      ctx.setLiteModeState(enabled);
    },
    [ctx.setLiteModeState],
  );

  const refreshLiteMode = useCallback(async (): Promise<boolean> => {
    try {
      const enabled = await window.snow.getLiteMode();
      applyLiteMode(enabled);
      return enabled;
    } catch {
      applyLiteMode(false);
      return false;
    }
  }, [applyLiteMode]);

  const setLiteMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (ctx.isUpdatingLiteMode) {
        return;
      }

      ctx.setIsUpdatingLiteMode(true);
      try {
        await window.snow.setLiteMode(enabled);
        applyLiteMode(enabled);
      } finally {
        ctx.setIsUpdatingLiteMode(false);
      }
    },
    [applyLiteMode, ctx.isUpdatingLiteMode, ctx.setIsUpdatingLiteMode],
  );

  // 模式（Goal/WorkTree/WorkFlow）只保存在内存 session ref 中，内存态是
  // 运行时权威；切换模式本身不再写库，选择随下一次发送统一落库
  // （useAgentLoop 的 persistConversationSelection），避免"只切了一下"就写库。
  // 会话面板可传入目标会话 key：此时只改该会话的 ref，不动主视图的显示态。

  /** 目标会话是否就是主视图当前激活会话（只有它是时才同步显示态）。 */
  const isActiveSessionKey = useCallback(
    (key: string): boolean =>
      key === (ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY),
    [ctx.activeSessionKeyRef],
  );

  const applyGoalMode = useCallback(
    (enabled: boolean, syncDisplay = true): void => {
      if (!syncDisplay) {
        return;
      }
      ctx.goalModeRef.current = enabled;
      ctx.setGoalModeState(enabled);
    },
    [ctx.goalModeRef, ctx.setGoalModeState],
  );

  const refreshGoalMode = useCallback(
    async (sessionKey?: string): Promise<boolean> => {
      // Per-conversation isolation: the session's own ref is the runtime
      // authority, falling back to the neutral default (disabled) for cold
      // sessions. Mode toggles never touch the persisted global settings, so
      // there is nothing global to re-read here.
      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const ref = ctx.sessionsRefData.current.get(key);
      const effective =
        ref?.goalMode ?? ctx.globalModeDefaultsRef.current.goalMode;
      applyGoalMode(effective, isActiveSessionKey(key));
      return effective;
    },
    [
      applyGoalMode,
      isActiveSessionKey,
      ctx.globalModeDefaultsRef,
      ctx.sessionsRefData,
    ],
  );

  const applyWorktreeMode = useCallback(
    (enabled: boolean, syncDisplay = true): void => {
      if (!syncDisplay) {
        return;
      }
      ctx.worktreeModeRef.current = enabled;
      ctx.setWorktreeModeState(enabled);
    },
    [ctx.worktreeModeRef, ctx.setWorktreeModeState],
  );

  const refreshWorktreeMode = useCallback(
    async (sessionKey?: string): Promise<boolean> => {
      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const ref = ctx.sessionsRefData.current.get(key);
      const effective =
        ref?.worktreeMode ?? ctx.globalModeDefaultsRef.current.worktreeMode;
      applyWorktreeMode(effective, isActiveSessionKey(key));
      return effective;
    },
    [
      applyWorktreeMode,
      isActiveSessionKey,
      ctx.globalModeDefaultsRef,
      ctx.sessionsRefData,
    ],
  );

  const applyWorkflowMode = useCallback(
    (enabled: boolean, syncDisplay = true): void => {
      if (!syncDisplay) {
        return;
      }
      ctx.workflowModeRef.current = enabled;
      ctx.setWorkflowModeState(enabled);
    },
    [ctx.workflowModeRef, ctx.setWorkflowModeState],
  );

  const refreshWorkflowMode = useCallback(
    async (sessionKey?: string): Promise<boolean> => {
      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const ref = ctx.sessionsRefData.current.get(key);
      const effective =
        ref?.workflowMode ?? ctx.globalModeDefaultsRef.current.workflowMode;
      applyWorkflowMode(effective, isActiveSessionKey(key));
      return effective;
    },
    [
      applyWorkflowMode,
      isActiveSessionKey,
      ctx.globalModeDefaultsRef,
      ctx.sessionsRefData,
    ],
  );

  const applyGoalModeTokenBudget = useCallback(
    (budget: number, syncDisplay = true): void => {
      if (!syncDisplay) {
        return;
      }
      ctx.setGoalModeTokenBudgetState(budget);
    },
    [ctx.setGoalModeTokenBudgetState],
  );

  const refreshGoalModeTokenBudget = useCallback(
    async (sessionKey?: string): Promise<void> => {
      // Per-conversation isolation: the session's own override wins, falling
      // back to the neutral default budget for cold sessions.
      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const ref = ctx.sessionsRefData.current.get(key);
      applyGoalModeTokenBudget(
        ref?.goalModeTokenBudget ??
          ctx.globalModeDefaultsRef.current.goalModeTokenBudget,
        isActiveSessionKey(key),
      );
    },
    [
      applyGoalModeTokenBudget,
      isActiveSessionKey,
      ctx.globalModeDefaultsRef,
      ctx.sessionsRefData,
    ],
  );

  const setGoalModeTokenBudget = useCallback(
    async (budget: number, sessionKey?: string): Promise<void> => {
      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      applyGoalModeTokenBudget(budget, isActiveSessionKey(key));
      // Per-conversation override: the current session keeps its own budget so
      // switching chats restores the right one. 只改内存态，随下一次发送落库，
      // 全局默认值不受影响（其他/新建会话不继承本会话的预算）。
      let ref = ctx.sessionsRefData.current.get(key);
      if (!ref) {
        // A fresh new chat has no session ref yet; create one so the
        // budget survives the first send (migration to a real id).
        ctx.ensureSession(key, ctx.directoryId);
        ref = ctx.sessionsRefData.current.get(key);
      }
      if (ref) {
        ref.goalModeTokenBudget = budget;
      }
    },
    [
      applyGoalModeTokenBudget,
      isActiveSessionKey,
      ctx.ensureSession,
      ctx.directoryId,
      ctx.sessionsRefData,
    ],
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

    void window.snow
      .getLiteMode()
      .then((enabled) => {
        if (!disposed) {
          applyLiteMode(enabled);
        }
      })
      .catch(() => {
        if (!disposed) {
          applyLiteMode(false);
        }
      });

    // Goal Mode 等模式开关严格按会话隔离：开关只写当前会话的 ref 和
    // 会话级 DB 记录，从不读写全局设置。因此这里无需（也不应）从
    // 磁盘加载全局模式——冷会话一律使用中性默认值（模式全关、
    // 预算 2000000），已打开会话的模式由各自的 session ref 恢复。

    // 历史遗留工具名别名：MCP server "bash" 的内部工具名是 `terminal-execute`，
    // 暴露给模型的完整名是 `bash-terminal-execute`；早期文档示例与旧配置可能
    // 写入内部名或 `mcp__bash__terminal-execute` 形式。授权判定用的是完整名
    // （见 shouldAutoApprove），因此这里统一归一化，避免既有免确认条目静默失效。
    // 只做精确别名映射，不做模糊匹配，不扩大授权范围。
    const ALWAYS_APPROVED_TOOL_ALIASES: Record<string, string> = {
      "terminal-execute": "bash-terminal-execute",
      "mcp__bash__terminal-execute": "bash-terminal-execute",
    };

    const normalizeApprovedToolName = (name: string): string =>
      ALWAYS_APPROVED_TOOL_ALIASES[name] ?? name;

    // 免审批列表 = 全局 permissions.alwaysApprovedTools（~/.snow/
    // permissions.json，对所有项目生效）∪ 项目级授权（应用 DB）。
    const loadApprovedTools = (): void => {
      const globalPromise = window.snow
        .getAlwaysApprovedTools()
        .catch(() => [] as string[]);
      if (ctx.directoryId) {
        void Promise.all([
          globalPromise,
          window.snow
            .listToolApprovalProjectApprovedTools(ctx.directoryId)
            .catch(() => [] as string[]),
        ]).then(([globalNames, projectNames]) => {
          if (!disposed) {
            ctx.alwaysApprovedToolsRef.current = new Set([
              ...globalNames.map(normalizeApprovedToolName),
              ...projectNames.map(normalizeApprovedToolName),
            ]);
          }
        });
      } else {
        void globalPromise.then((globalNames) => {
          if (!disposed) {
            ctx.alwaysApprovedToolsRef.current = new Set(
              globalNames.map(normalizeApprovedToolName),
            );
          }
        });
      }
    };

    loadApprovedTools();

    const onToolApprovalsChanged = (): void => loadApprovedTools();
    window.addEventListener(
      TOOL_APPROVALS_CHANGED_EVENT,
      onToolApprovalsChanged,
    );

    // 用户在 MCP 面板手动重新启用 Browser / App Control 服务时，Rust 侧
    // 会自动关闭精简模式；这里重新读取持久化状态以保持 UI 同步。
    const onLiteModeChanged = (): void => {
      void refreshLiteMode();
    };
    window.addEventListener(LITE_MODE_CHANGED_EVENT, onLiteModeChanged);

    return () => {
      disposed = true;
      window.removeEventListener(
        TOOL_APPROVALS_CHANGED_EVENT,
        onToolApprovalsChanged,
      );
      window.removeEventListener(LITE_MODE_CHANGED_EVENT, onLiteModeChanged);
    };
  }, [
    applyYoloMode,
    applyLiteMode,
    refreshLiteMode,
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
    [applyYoloMode, ctx.isUpdatingYoloMode, ctx.setIsUpdatingYoloMode],
  );

  const setGoalMode = useCallback(
    async (enabled: boolean, sessionKey?: string): Promise<void> => {
      if (ctx.isUpdatingGoalMode) {
        return;
      }

      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const syncDisplay = isActiveSessionKey(key);
      ctx.setIsUpdatingGoalMode(true);
      try {
        applyGoalMode(enabled, syncDisplay);
        let ref = ctx.sessionsRefData.current.get(key);
        if (!ref) {
          ctx.ensureSession(key, ctx.directoryId);
          ref = ctx.sessionsRefData.current.get(key);
        }
        if (ref) {
          ref.goalMode = enabled;
          if (enabled) {
            ref.worktreeMode = false;
            ref.workflowMode = false;
            applyWorktreeMode(false, syncDisplay);
            applyWorkflowMode(false, syncDisplay);
          }
        }
      } finally {
        ctx.setIsUpdatingGoalMode(false);
      }
    },
    [
      applyGoalMode,
      applyWorktreeMode,
      applyWorkflowMode,
      isActiveSessionKey,
      ctx.isUpdatingGoalMode,
      ctx.setIsUpdatingGoalMode,
      ctx.ensureSession,
      ctx.directoryId,
      ctx.sessionsRefData,
    ],
  );

  const setWorktreeMode = useCallback(
    async (enabled: boolean, sessionKey?: string): Promise<void> => {
      if (ctx.isUpdatingWorktreeMode) {
        return;
      }

      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const syncDisplay = isActiveSessionKey(key);
      ctx.setIsUpdatingWorktreeMode(true);
      try {
        // 已有会话必须先绑定工作树再开启，否则发送时会 fail-closed
        if (enabled && !isPendingSessionKey(key)) {
          const directoryId =
            ctx.sessionsRefData.current.get(key)?.directoryId ??
            ctx.directoryId;
          const bound = await hasValidConversationWorktree(
            key,
            directoryId,
          ).catch(() => false);
          if (!bound) {
            if (syncDisplay) {
              ctx.setWorktreeModeNotice(t("git.worktreesBindRequiredHint"));
            }
            return;
          }
          if (
            sessionKey === undefined &&
            ctx.activeSessionKeyRef.current !== key
          ) {
            return;
          }
        }
        applyWorktreeMode(enabled, syncDisplay);
        let ref = ctx.sessionsRefData.current.get(key);
        if (!ref) {
          ctx.ensureSession(key, ctx.directoryId);
          ref = ctx.sessionsRefData.current.get(key);
        }
        if (ref) {
          ref.worktreeMode = enabled;
          if (enabled) {
            ref.goalMode = false;
            ref.workflowMode = false;
            applyGoalMode(false, syncDisplay);
            applyWorkflowMode(false, syncDisplay);
          }
        }
      } finally {
        ctx.setIsUpdatingWorktreeMode(false);
      }
    },
    [
      applyWorktreeMode,
      applyGoalMode,
      applyWorkflowMode,
      isActiveSessionKey,
      ctx.isUpdatingWorktreeMode,
      ctx.setIsUpdatingWorktreeMode,
      ctx.setWorktreeModeNotice,
      ctx.ensureSession,
      ctx.directoryId,
      ctx.sessionsRefData,
      t,
    ],
  );

  const setWorkflowMode = useCallback(
    async (enabled: boolean, sessionKey?: string): Promise<void> => {
      if (ctx.isUpdatingWorkflowMode) {
        return;
      }

      const key =
        sessionKey ?? ctx.activeSessionKeyRef.current ?? PENDING_SESSION_KEY;
      const syncDisplay = isActiveSessionKey(key);
      ctx.setIsUpdatingWorkflowMode(true);
      try {
        applyWorkflowMode(enabled, syncDisplay);
        let ref = ctx.sessionsRefData.current.get(key);
        if (!ref) {
          ctx.ensureSession(key, ctx.directoryId);
          ref = ctx.sessionsRefData.current.get(key);
        }
        if (ref) {
          ref.workflowMode = enabled;
          // WorkFlow Mode is mutually exclusive with Goal / WorkTree.
          if (enabled) {
            ref.goalMode = false;
            ref.worktreeMode = false;
            applyGoalMode(false, syncDisplay);
            applyWorktreeMode(false, syncDisplay);
          }
        }
      } finally {
        ctx.setIsUpdatingWorkflowMode(false);
      }
    },
    [
      applyWorkflowMode,
      applyGoalMode,
      applyWorktreeMode,
      isActiveSessionKey,
      ctx.isUpdatingWorkflowMode,
      ctx.setIsUpdatingWorkflowMode,
      ctx.ensureSession,
      ctx.directoryId,
      ctx.sessionsRefData,
    ],
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
      removePendingAuthorizationMirror(ctx, [authorizationId]);
      ctx.setPendingToolAuthorizations((current) =>
        current.filter((item) => item.authorizationId !== authorizationId),
      );

      // 敏感命令的决策模型判定只存在于待授权项上（拦截提示里展示），
      // 结算时回写到工具卡片，让用户在卡片上也能看到判定与置信度。
      const decisionInfo = toolCall.sensitiveCommandDecision;
      // 托管拒绝转人工复核（「拒绝时仍让我确认」）：用户确认执行即覆盖了
      // 模型判定，卡片据此区分「模型拒绝但用户已确认」。
      const isDenyReview = Boolean(
        toolCall.sensitiveCommandDelegated &&
        decisionInfo &&
        !decisionInfo.allow &&
        !decisionInfo.error,
      );
      const isDenyOverridden = isDenyReview && decision.status === "approved";
      if (decisionInfo) {
        ctx.updateSessionMessages(
          toolCall.authorizationConversationId ?? "",
          (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.toolCalls
                ? {
                    ...currentMessage,
                    toolCalls: updateFirstMatchingToolCall(
                      currentMessage.toolCalls,
                      toolCall,
                      ["pending", "running"],
                      (currentToolCall) => ({
                        ...currentToolCall,
                        sensitiveCommandMatches:
                          toolCall.sensitiveCommandMatches,
                        sensitiveCommandDecision: decisionInfo,
                        ...(isDenyOverridden
                          ? { sensitiveCommandDenyOverridden: true }
                          : {}),
                      }),
                    ),
                  }
                : currentMessage,
            ),
        );
      }

      // 记录用户对模型拒绝的复核结果，便于统计「模型拒绝但用户放行」的比例，
      // 反推是模型提示词过于保守还是敏感规则写得太宽。命令文本截断避免日志过长。
      if (isDenyReview && decisionInfo) {
        let command = "";
        try {
          const parsed = JSON.parse(toolCall.arguments || "{}");
          if (typeof parsed?.command === "string") {
            command = parsed.command;
          }
        } catch {
          // ignore parse error
        }
        writeRendererLog("INFO", {
          module: "sensitive_command",
          func: "settleToolAuthorization",
          message: isDenyOverridden
            ? "Decision model deny overridden by user"
            : "Decision model deny upheld by user",
          context: JSON.stringify({
            ruleIds: (toolCall.sensitiveCommandMatches ?? []).map(
              (match) => match.commandId,
            ),
            model: decisionInfo.modelName,
            reason: decisionInfo.reason,
            confidence: decisionInfo.confidence,
            severity: decisionInfo.severity ?? null,
            severityScore: decisionInfo.severityScore ?? null,
            userChoice: decision.status,
            command:
              command.length > SENSITIVE_COMMAND_LOG_MAX_CHARS
                ? `${command.slice(0, SENSITIVE_COMMAND_LOG_MAX_CHARS)}...`
                : command,
          }),
        });
      }

      pending.resolve(decision);
    },
    [
      ctx.pendingToolAuthorizationRef,
      ctx.setPendingToolAuthorizations,
      ctx.setPendingToolAuthorizationsBySession,
      ctx.updateSessionMessages,
    ],
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
        pendingEntries.delete(authorizationId),
      );
      if (targetAuthorizationIds.length > 0) {
        removePendingAuthorizationMirror(ctx, targetAuthorizationIds);
        ctx.setPendingToolAuthorizations((current) =>
          current.filter(
            (toolCall) =>
              !toolCall.authorizationId ||
              !targetAuthorizationIds.includes(toolCall.authorizationId),
          ),
        );
      }
    },
    [
      ctx.pendingToolAuthorizationRef,
      ctx.setPendingToolAuthorizations,
      ctx.setPendingToolAuthorizationsBySession,
    ],
  );

  /**
   * 命中敏感规则后请决策模型判定该命令是否可直接放行（辅助 / 托管）。
   *
   * 未启用辅助、未命中规则时返回 null，调用方保持原有的拦截提示流程。
   * 决策模型不可用或请求失败时返回带 error 的判定：同样回退人工确认，但拦截
   * 提示会明确告诉用户「决策模型不可用，已回退人工确认」——辅助功能不改变
   * 安全闸门的默认行为，也不再静默吞掉失败。
   */
  const requestSensitiveCommandDecision = useCallback(
    (
      command: string,
      projectId: string | undefined,
      workingDirectory: string,
      description: string,
      conversationContext: string,
    ) =>
      window.snow
        .evaluateSensitiveCommandDecision(
          command,
          projectId,
          workingDirectory || undefined,
          description || undefined,
          conversationContext,
        )
        .catch((error: unknown) => ({
          allow: false,
          reason: "unclear",
          confidence: 0,
          severity: null,
          severityScore: null,
          delegate: false,
          askOnDeny: false,
          modelName: "",
          contextEnabled: false,
          error: error instanceof Error ? error.message : String(error),
        })),
    [],
  );

  // Preparation never publishes a pending authorization. Only the returned
  // confirmation function may do so, after the caller enters its waiting state.
  const prepareToolAuthorization = useCallback(
    (
      toolCall: ToolCallInfo,
      index: number,
      conversationId: string,
      projectId?: string,
    ): Promise<
      ToolAuthorizationDecision | (() => Promise<ToolAuthorizationDecision>)
    > => {
      if (
        toolCall.name === "user-interaction-askUserQuestion" ||
        toolCall.name === "sub-agents-sendMessage" ||
        toolCall.name === "sub-agents-continue"
      ) {
        // Internal sub-agent communication tools are always auto-approved:
        // they are pure message-passing between teammates of the same
        // session and must never block on a user confirmation dialog.
        return Promise.resolve({ status: "approved" });
      }

      const shouldAutoApprove = () =>
        ctx.yoloModeRef.current ||
        ctx.alwaysApprovedToolsRef.current.has(toolCall.name);

      // Sensitive command check: even in YOLO mode, bash commands that match
      // the current project's merged rules must be confirmed.
      const checkSensitiveBash = async (): Promise<
        | ToolAuthorizationDecision
        | (() => Promise<ToolAuthorizationDecision>)
        | "needs-dialog"
      > => {
        if (toolCall.name !== "bash-terminal-execute") {
          return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
        }

        let command = "";
        let description = "";
        let workingDirectory = "";
        try {
          const parsed = JSON.parse(toolCall.arguments || "{}");
          if (typeof parsed?.command === "string") {
            command = parsed.command;
          }
          if (typeof parsed?.description === "string") {
            description = parsed.description;
          }
          if (typeof parsed?.workingDirectory === "string") {
            workingDirectory = parsed.workingDirectory;
          }
        } catch {
          // ignore parse error
        }

        // Interactive commands are checked the same way as regular ones: the
        // isInteractive flag is model-controlled and must not be allowed to
        // bypass the sensitive-command gate (the Rust side enforces this too).
        // The flag only changes how the terminal session is presented.
        if (!command) {
          return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
        }

        try {
          const matches = await window.snow.checkSensitiveCommandMatch(
            command,
            projectId,
          );
          if (matches.length > 0) {
            // 风险判定需要上下文：命令自身的说明 + 实际执行目录（工具没给时
            // 回落到项目目录）。只看命令文本容易把所有规则命中都判成风险。
            // 会话片段只在设置开启时由 Rust 使用，关闭时被忽略。
            const decision = await requestSensitiveCommandDecision(
              command,
              projectId,
              workingDirectory || directoryIdToPath(projectId) || "",
              description,
              buildSensitiveCommandContext(
                ctx.sessionsRef.current[conversationId]?.messages ?? [],
                toolCall,
              ),
            );

            // 托管模式：判定直接生效，不再弹拦截提示 —— 允许则放行（等价于
            // 用户点了「确认执行」）；拒绝则只拒绝这条命令并把模型的理由交回
            // AI，AI 流程继续（模型可换一种做法），任何情况下都不中断会话。
            // 决策模型不可用（error）时判定无效，必须回退人工确认。
            // 开启「拒绝时仍让我确认」（askOnDeny）时，托管拒绝不直接生效，
            // 而是落到下方的人工确认，由用户复核模型的拒绝后决定是否执行。
            const isDenyReview = Boolean(
              decision?.delegate &&
              !decision.error &&
              !decision.allow &&
              decision.askOnDeny,
            );
            if (decision?.delegate && !decision.error && !isDenyReview) {
              // 判定不经过拦截提示，直接回写到工具卡片上，让用户能看到
              // 这条命令是被决策模型放行/拒绝的、置信度与理由。
              const delegatedDecision = {
                allow: decision.allow,
                reason: decision.reason,
                confidence: decision.confidence,
                ...pickSeverity(decision),
                ...pickContextUsage(decision),
                modelName: decision.modelName,
              };
              ctx.updateSessionMessages(conversationId, (currentMessages) =>
                currentMessages.map((currentMessage) =>
                  currentMessage.toolCalls
                    ? {
                        ...currentMessage,
                        toolCalls: updateFirstMatchingToolCall(
                          currentMessage.toolCalls,
                          toolCall,
                          ["pending", "running"],
                          (currentToolCall) => ({
                            ...currentToolCall,
                            sensitiveCommandMatches: matches,
                            sensitiveCommandDecision: delegatedDecision,
                            sensitiveCommandDelegated: true,
                          }),
                        ),
                      }
                    : currentMessage,
                ),
              );

              if (decision.allow) {
                return {
                  status: "approved",
                  sensitiveCommandConfirmed: true,
                  sensitiveCommandDecision: delegatedDecision,
                  sensitiveCommandDelegated: true,
                };
              }

              return {
                status: "rejected",
                reasonForModel: true,
                sensitiveCommandDecision: delegatedDecision,
                sensitiveCommandDelegated: true,
                reason: t("sensitiveCommand.decisionRejectedReason", {
                  values: {
                    model: decision.modelName,
                    reason: t(
                      `sensitiveCommand.decision.reason.${decision.reason}`,
                      { defaultValue: decision.reason },
                    ),
                  },
                  defaultValue:
                    "Rejected by the decision model ({{model}}): {{reason}}",
                }),
              };
            }

            // 敏感命令检测到 —— 强制授权对话框，即使 YOLO 模式也要确认。
            const authorizationId = `${
              toolCall.callId ?? toolCall.name
            }-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const pendingToolCall: ToolCallInfo = {
              ...toolCall,
              authorizationId,
              authorizationConversationId: conversationId,
              sensitiveCommandMatches: matches,
              // 托管拒绝转人工复核：拦截提示据此标注「你正在覆盖模型判定」，
              // 结算时据此记录覆盖行为。
              ...(isDenyReview ? { sensitiveCommandDelegated: true } : {}),
              // 非托管时判定只作为建议，连同拦截提示一起展示给用户；决策模型
              // 不可用时展示回退原因。
              ...(decision
                ? {
                    sensitiveCommandDecision: {
                      allow: decision.allow,
                      reason: decision.reason,
                      confidence: decision.confidence,
                      ...pickSeverity(decision),
                      ...pickContextUsage(decision),
                      modelName: decision.modelName,
                      ...(decision.error ? { error: decision.error } : {}),
                    },
                  }
                : {}),
            };

            return () => {
              if (
                ctx.sessionsRefData.current.get(conversationId)
                  ?.isAbortRequested
              ) {
                return Promise.resolve({
                  status: "rejected",
                  reason: "Tool execution interrupted",
                });
              }

              // Notify only when confirmation actually starts, outside the
              // sensitive-check catch so waiting failures cannot auto-approve.
              ctx.notifySensitiveCommandIntercepted({
                conversationId,
                directoryId:
                  projectId ??
                  ctx.sessionsRefData.current.get(conversationId)?.directoryId,
                toolName: toolCall.name,
              });

              return new Promise<ToolAuthorizationDecision>((resolve) => {
                if (
                  ctx.sessionsRefData.current.get(conversationId)
                    ?.isAbortRequested
                ) {
                  resolve({
                    status: "rejected",
                    reason: "Tool execution interrupted",
                  });
                  return;
                }
                ctx.pendingToolAuthorizationRef.current.set(authorizationId, {
                  toolCall: pendingToolCall,
                  resolve,
                });
                addPendingAuthorizationMirror(ctx, pendingToolCall);
                ctx.setPendingToolAuthorizations((current) => [
                  ...current,
                  pendingToolCall,
                ]);
              });
            };
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

        return () =>
          new Promise<ToolAuthorizationDecision>((resolve) => {
            if (
              ctx.sessionsRefData.current.get(conversationId)?.isAbortRequested
            ) {
              resolve({
                status: "rejected",
                reason: "Tool execution interrupted",
              });
              return;
            }
            ctx.pendingToolAuthorizationRef.current.set(authorizationId, {
              toolCall: pendingToolCall,
              resolve,
            });
            addPendingAuthorizationMirror(ctx, pendingToolCall);
            ctx.setPendingToolAuthorizations((current) => [
              ...current,
              pendingToolCall,
            ]);
          });
      });
    },
    [
      t,
      requestSensitiveCommandDecision,
      ctx.yoloModeRef,
      ctx.alwaysApprovedToolsRef,
      ctx.pendingToolAuthorizationRef,
      ctx.sessionsRefData,
      ctx.sessionsRef,
      ctx.setPendingToolAuthorizations,
      ctx.notifySensitiveCommandIntercepted,
    ],
  );

  // Keep the single-tool API eager; batch callers use preparation directly.
  const requestToolAuthorization = useCallback(
    async (
      toolCall: ToolCallInfo,
      index: number,
      conversationId: string,
      projectId?: string,
    ): Promise<ToolAuthorizationDecision> => {
      const prepared = await prepareToolAuthorization(
        toolCall,
        index,
        conversationId,
        projectId,
      );
      if (ctx.sessionsRefData.current.get(conversationId)?.isAbortRequested) {
        return { status: "rejected", reason: "Tool execution interrupted" };
      }
      return typeof prepared === "function" ? prepared() : prepared;
    },
    [prepareToolAuthorization, ctx.sessionsRefData],
  );

  const requestToolAuthorizations = useCallback(
    async (
      toolCalls: ToolCallInfo[],
      conversationId: string,
      projectId?: string,
      waitForConfirmation?: (
        confirm: () => Promise<ToolAuthorizationDecision[]>,
      ) => Promise<ToolAuthorizationDecision[]>,
    ): Promise<ToolAuthorizationDecision[]> => {
      // Read the persisted app setting once per tool batch so recent YOLO
      // changes take effect without querying SQLite for every tool.
      try {
        const enabled = await window.snow.getYoloMode();
        applyYoloMode(enabled);
      } catch {
        // Keep the last known in-memory state if the read fails.
      }

      // Preserve YOLO's toolConfirmation bypass, but still prepare sensitive
      // commands: they may require a dialog even with YOLO enabled.
      // beforeToolCall remains the pre-execution policy gate in both modes.
      const skipToolConfirmation = ctx.yoloModeRef.current;

      // Non-YOLO flow: execute toolConfirmation before showing authorization.
      const hookDecisions = await Promise.all(
        toolCalls.map(async (toolCall) => {
          if (skipToolConfirmation) return null;
          try {
            const toolConfirmContext = JSON.stringify({
              toolName: toolCall.name,
              args: JSON.parse(toolCall.arguments || "{}"),
              cwd: directoryIdToPath(projectId) ?? ctx.directoryPath ?? "",
            });
            const confirmResult = await runHook(
              "toolConfirmation",
              projectId || undefined,
              toolConfirmContext,
            );
            if (confirmResult) {
              ctx.updateSessionMessages(conversationId, (currentMessages) =>
                appendHookExecutionToMessage(
                  currentMessages,
                  confirmResult.record,
                ),
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
        }),
      );

      const prepared = await Promise.all(
        toolCalls.map((toolCall, index) => {
          const hookDecision = hookDecisions[index];
          if (hookDecision) {
            return Promise.resolve(hookDecision);
          }
          return prepareToolAuthorization(
            toolCall,
            index,
            conversationId,
            projectId,
          );
        }),
      );
      if (ctx.sessionsRefData.current.get(conversationId)?.isAbortRequested) {
        return toolCalls.map(() => ({
          status: "rejected",
          reason: "Tool execution interrupted",
        }));
      }

      // Publish all cards together and preserve tool order. The wrapper spans
      // the entire batch, so the slot is reacquired only after every decision.
      const confirm = () =>
        Promise.all(
          prepared.map((decision) =>
            typeof decision === "function" ? decision() : decision,
          ),
        );
      if (
        waitForConfirmation &&
        prepared.some((decision) => typeof decision === "function")
      ) {
        // Intentionally outside all preparation catches: cancellation and
        // persistence failures must propagate, never fall back to approval.
        return waitForConfirmation(confirm);
      }
      return confirm();
    },
    [
      applyYoloMode,
      prepareToolAuthorization,
      ctx.directoryPath,
      ctx.sessionsRefData,
    ],
  );

  const approveToolAuthorizationAlways = useCallback(
    (toolCall: ToolCallInfo): void => {
      if (ctx.directoryId) {
        void window.snow
          .setToolApprovalProjectToolApproved(
            ctx.directoryId,
            toolCall.name,
            true,
          )
          .then(() => {
            ctx.alwaysApprovedToolsRef.current.add(toolCall.name);
          })
          .catch(() => {
            // The current execution can continue even if persistence fails.
          })
          .finally(() =>
            settleToolAuthorization(toolCall, { status: "approved" }),
          );
      } else {
        // No project context: skip persistence and just approve this call.
        ctx.alwaysApprovedToolsRef.current.add(toolCall.name);
        settleToolAuthorization(toolCall, { status: "approved" });
      }
    },
    [ctx.directoryId, ctx.alwaysApprovedToolsRef, settleToolAuthorization],
  );

  // 卸载时清理所有待处理授权
  useEffect(() => () => rejectToolAuthorizations(), [rejectToolAuthorizations]);

  // app-control-setMode writes the global settings directly; replay it
  // through the session-aware path so the active session's ref, global
  // defaults and per-conversation DB record all stay consistent. Without
  // this, an AI-driven mode switch would leave the running session's gate
  // state stale (the loop reads the session ref, not the global setting).
  useEffect(() => {
    const onModeChanged = (event: Event): void => {
      const detail = (
        event as CustomEvent<{
          mode: string;
          enabled: boolean;
        }>
      ).detail;
      if (!detail || typeof detail.enabled !== "boolean") {
        return;
      }
      if (detail.mode === "goal") {
        void setGoalMode(detail.enabled);
      } else if (detail.mode === "worktree") {
        void setWorktreeMode(detail.enabled);
      }
    };
    window.addEventListener(APP_CONTROL_MODE_CHANGED_EVENT, onModeChanged);
    return () => {
      window.removeEventListener(APP_CONTROL_MODE_CHANGED_EVENT, onModeChanged);
    };
  }, [setGoalMode, setWorktreeMode]);

  return {
    approveAllPendingToolAuthorizations,
    applyYoloMode,
    refreshYoloMode,
    setYoloMode,
    applyLiteMode,
    refreshLiteMode,
    setLiteMode,
    applyGoalMode,
    refreshGoalMode,
    setGoalMode,
    applyWorktreeMode,
    refreshWorktreeMode,
    setWorktreeMode,
    applyWorkflowMode,
    refreshWorkflowMode,
    setWorkflowMode,
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
