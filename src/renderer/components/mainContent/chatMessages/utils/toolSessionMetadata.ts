const SESSION_AWARE_TERMINAL_TOOLS = new Set([
  "bash-terminal-execute",
  "terminal-open",
]);

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
  const injectSession =
    !!normalizedSessionId && SESSION_AWARE_TERMINAL_TOOLS.has(toolName);
  const injectAnalysisRoot =
    analysisWorkspaceRoot !== undefined &&
    (toolName.startsWith("lsp-") || toolName === "grep-search");
  if (!injectSession && !injectAnalysisRoot) {
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
    if (injectSession) {
      args.sessionId = normalizedSessionId;
    }
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
};
