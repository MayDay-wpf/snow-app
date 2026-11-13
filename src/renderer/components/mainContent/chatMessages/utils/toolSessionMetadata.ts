/** 需要注入会话 ID 的终端调用：bash 全部动作，terminal-manage 仅 open。 */
const isSessionAwareTerminalCall = (
  toolName: string,
  args: Record<string, unknown>,
): boolean =>
  toolName === "bash-terminal-execute" ||
  (toolName === "terminal-manage" &&
    typeof args.action === "string" &&
    args.action.trim() === "open");

/**
 * Attach Snow-owned session metadata after model arguments have been parsed.
 * Invalid JSON is left untouched so the normal tool validation path reports it.
 */
export const injectSessionIdIntoToolArgs = (
  toolName: string,
  argsJson: string,
  sessionId: string | undefined,
  analysisWorkspaceRoot?: string,
): string => {
  const normalizedSessionId = sessionId?.trim();
  const maybeInjectSession =
    !!normalizedSessionId &&
    (toolName === "bash-terminal-execute" || toolName === "terminal-manage");
  const injectAnalysisRoot =
    analysisWorkspaceRoot !== undefined &&
    (toolName.startsWith("lsp-") || toolName === "grep-search");
  if (!maybeInjectSession && !injectAnalysisRoot) {
    return argsJson;
  }

  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return argsJson;
    }
    const args = parsed as Record<string, unknown>;
    // Preserve explicit values (including invalid ones) for backend validation.
    // Never derive projectId from model arguments or from the analysis root.
    if (injectAnalysisRoot && !Object.hasOwn(args, "workspaceRoot")) {
      args.workspaceRoot = analysisWorkspaceRoot;
    }
    if (maybeInjectSession && isSessionAwareTerminalCall(toolName, args)) {
      args.sessionId = normalizedSessionId;
    }
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
};
