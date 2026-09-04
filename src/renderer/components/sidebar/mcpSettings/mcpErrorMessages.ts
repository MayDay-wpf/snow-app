/**
 * MCP 服务器错误消息的本地化分类与映射。
 *
 * Rust native 侧返回的错误消息是面向开发者的英文技术细节（例如
 * "Failed to initialize external MCP stdio server DBX: connection closed:
 * discover response"）。这里根据已知错误模式将原始消息归类，并映射为
 * 用户可读的 i18n 提示；未匹配的模式回退到通用失败提示并保留原始消息，
 * 便于用户向开发者反馈。
 */

type McpTranslate = (
  key: string,
  options?: {
    defaultValue?: string;
    values?: Record<string, string | number>;
  }
) => string;

const extractDetail = (message: string, prefix: string): string => {
  const detail = message.slice(prefix.length).trim();
  return detail.startsWith(":") ? detail.slice(1).trim() : detail;
};

/**
 * 将 native 侧 MCP 错误消息转换为友好的本地化提示。
 *
 * 返回的字符串为 i18n 分类提示；对于未识别的错误，在通用提示后追加
 * 原始错误消息，保留诊断信息。
 */
export const formatMcpError = (error: unknown, t: McpTranslate): string => {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  if (!message) {
    return t("settings.mcpFetchToolsError", {
      defaultValue: "Failed to fetch MCP tools",
    });
  }

  // 协议握手阶段连接被关闭：服务器可能不支持新版 MCP 协议（2026-07-28
  // 无状态协议的 discover 握手），旧服务器收到 discover 请求后直接退出。
  if (message.includes("connection closed: discover response")) {
    return t("settings.mcpErrorProtocolIncompatible", {
      defaultValue:
        "MCP server may not support the current protocol. Try updating the server or its SDK.",
    });
  }

  // stdio 子进程无法启动（命令不存在、路径错误、权限不足等）。
  if (message.includes("Failed to start external MCP server")) {
    const detail = extractDetail(message, "Failed to start external MCP server");
    return t("settings.mcpErrorStartFailed", {
      defaultValue: "Failed to start the MCP server process. Check the command and arguments.",
      values: detail ? { detail } : undefined,
    });
  }

  // stdio 初始化握手失败（连接建立但协议协商未完成）。
  if (message.includes("Failed to initialize external MCP stdio server")) {
    const detail = extractDetail(
      message,
      "Failed to initialize external MCP stdio server"
    );
    return t("settings.mcpErrorInitializeFailed", {
      defaultValue:
        "Failed to initialize the MCP server connection. The server may not be compatible.",
      values: detail ? { detail } : undefined,
    });
  }

  // HTTP 传输连接失败。
  if (message.includes("Failed to connect external MCP HTTP server")) {
    const detail = extractDetail(message, "Failed to connect external MCP HTTP server");
    return t("settings.mcpErrorHttpConnectFailed", {
      defaultValue: "Failed to connect to the MCP HTTP server. Check the URL and network.",
      values: detail ? { detail } : undefined,
    });
  }

  // 配置缺少必需字段。
  if (message.includes("has no command")) {
    return t("settings.mcpErrorMissingCommand", {
      defaultValue: "This MCP server has no command configured.",
    });
  }
  if (message.includes("has no URL")) {
    return t("settings.mcpErrorMissingUrl", {
      defaultValue: "This MCP server has no URL configured.",
    });
  }

  // 配置已被删除或不再存在。
  if (message.includes("is no longer configured")) {
    return t("settings.mcpErrorNotConfigured", {
      defaultValue: "This MCP server is no longer configured. Re-add it to continue.",
    });
  }

  // 工具列表加载失败（进程已启动但 tools/list 调用失败）。
  if (message.includes("External MCP tools/list failed")) {
    const detail = extractDetail(message, "External MCP tools/list failed");
    return t("settings.mcpErrorListToolsFailed", {
      defaultValue: "Failed to fetch the tool list from the MCP server.",
      values: detail ? { detail } : undefined,
    });
  }

  // 配置加载失败（数据库读取错误）。
  if (message.includes("Failed to load external MCP server configs")) {
    const detail = extractDetail(message, "Failed to load external MCP server configs");
    return t("settings.mcpErrorLoadConfigsFailed", {
      defaultValue: "Failed to load MCP server configurations.",
      values: detail ? { detail } : undefined,
    });
  }

  // 配置 JSON 格式非法。
  if (message.includes("Invalid external MCP")) {
    return t("settings.mcpErrorInvalidConfigJson", {
      defaultValue: "The MCP server configuration contains invalid JSON values.",
    });
  }

  // 兜底：通用失败提示 + 原始错误消息。
  return t("settings.mcpFetchToolsErrorDetail", {
    defaultValue: "Failed to fetch MCP tools: {{detail}}",
    values: { detail: message },
  });
};
