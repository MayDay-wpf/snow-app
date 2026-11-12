import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import type { NativeBridge } from "../../native/types";
import {
  normalizeSystemPromptItem,
  readSnowCliSystemPromptConfig,
} from "../../settings/systemPromptSettings";
import {
  normalizeCustomHeaderScheme,
  readSnowCliCustomHeadersConfig,
} from "../../settings/customHeadersSettings";
import {
  deleteSnowCliMcpServerConfig,
  deleteSnowCliProjectMcpServerConfig,
  normalizeMcpServerConfig,
  normalizeProjectMcpServerConfig,
  readSnowCliMcpConfig,
} from "../../settings/mcpSettings";
import { normalizeLspServerConfig } from "../../settings/lspSettings";
import {
  normalizeProjectSensitiveCommandConfig,
  normalizeSensitiveCommandConfig,
  readSnowCliSensitiveCommandConfig,
} from "../../settings/sensitiveCommandSettings";
import { normalizeSubAgentConfig } from "../../settings/subAgentSettings";
import { normalizeCustomCommand } from "../../settings/customCommandSettings";
import type {
  HookConfigInput,
  HookScope,
  RegisteredModelKind,
} from "../../native/types";

const requireProjectId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Project id is required");
  }
  return value.trim();
};

const readOptionalProjectId = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeHookConfig = (item: unknown): HookConfigInput => {
  if (!item || typeof item !== "object") {
    throw new Error("Hook config must be an object");
  }
  const raw = item as Record<string, unknown>;
  const hookType = typeof raw.hookType === "string" ? raw.hookType.trim() : "";
  if (!hookType) {
    throw new Error("Hook type is required");
  }
  const scope = typeof raw.scope === "string" ? raw.scope.trim() : "";
  if (scope !== "global" && scope !== "project") {
    throw new Error("Hook scope must be 'global' or 'project'");
  }
  const rulesJson = typeof raw.rulesJson === "string" ? raw.rulesJson : "";
  if (!rulesJson.trim()) {
    throw new Error("Hook rules JSON is required");
  }
  const projectId =
    typeof raw.projectId === "string" && raw.projectId.trim()
      ? raw.projectId.trim()
      : undefined;
  if (scope === "project" && !projectId) {
    throw new Error("Project id is required for project scope hooks");
  }
  return {
    hookType,
    scope: scope as HookScope,
    projectId,
    rulesJson,
  };
};

/** 模型连接自检的入参：渲染层传入表单对象，这里只取需要的字段。 */
const readTestInput = (item: unknown): Record<string, unknown> => {
  if (!item || typeof item !== "object") {
    throw new Error("Model test input must be an object");
  }
  return item as Record<string, unknown>;
};

const readTestText = (raw: Record<string, unknown>, key: string): string =>
  typeof raw[key] === "string" ? (raw[key] as string).trim() : "";

const readTestCount = (raw: Record<string, unknown>, key: string): number => {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
};

/** 模型注册表的入参：结构与类型由这里收窄，取值校验交给 Rust。 */
const readModelInput = (item: unknown): Record<string, unknown> => {
  if (!item || typeof item !== "object") {
    throw new Error("Model input must be an object");
  }
  return item as Record<string, unknown>;
};

const readModelEnabled = (raw: Record<string, unknown>): boolean =>
  raw.enabled !== false;

const readModelKind = (kind: unknown): RegisteredModelKind => {
  if (kind !== "embedding" && kind !== "reranking" && kind !== "decision") {
    throw new Error("Model kind must be embedding, reranking or decision");
  }
  return kind;
};

const readModelId = (modelId: unknown): string => {
  if (typeof modelId !== "string" || !modelId.trim()) {
    throw new Error("Model id is required");
  }
  return modelId.trim();
};

export const registerConfigHandlers = (native: NativeBridge): void => {
  ipcMain.handle("lsp-resource-policy:get", async () =>
    JSON.parse(await native.getLspResourcePolicy()),
  );
  ipcMain.handle("lsp-resource-policy:set", async (_event, value: unknown) => {
    // Rust validates types, ranges and unknown fields before any persistence.
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("LSP resource policy must be an object");
    }
    await native.setLspResourcePolicy(JSON.stringify(value));
    return JSON.parse(await native.getLspResourcePolicy());
  });
  // ===== System Prompts =====
  ipcMain.handle("system-prompts:list", () => native.listSystemPrompts());
  ipcMain.handle("system-prompts:upsert", async (_event, item: unknown) => {
    await native.upsertSystemPrompt(normalizeSystemPromptItem(item));
    return native.listSystemPrompts();
  });
  ipcMain.handle("system-prompts:delete", async (_event, promptId: unknown) => {
    if (typeof promptId !== "string" || !promptId.trim()) {
      throw new Error("Prompt ID is required");
    }
    await native.deleteSystemPrompt(promptId.trim());
    return native.listSystemPrompts();
  });
  ipcMain.handle("system-prompts:import-snow-cli", () =>
    readSnowCliSystemPromptConfig(native),
  );

  // ===== Custom Header Schemes =====
  ipcMain.handle("custom-header-schemes:list", () =>
    native.listCustomHeaderSchemes(),
  );
  ipcMain.handle(
    "custom-header-schemes:upsert",
    async (_event, item: unknown) => {
      await native.upsertCustomHeaderScheme(normalizeCustomHeaderScheme(item));
      return native.listCustomHeaderSchemes();
    },
  );
  ipcMain.handle(
    "custom-header-schemes:delete",
    async (_event, schemeId: unknown) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) {
        throw new Error("Custom header scheme ID is required");
      }
      await native.deleteCustomHeaderScheme(schemeId.trim());
      return native.listCustomHeaderSchemes();
    },
  );
  ipcMain.handle("custom-header-schemes:import-snow-cli", () =>
    readSnowCliCustomHeadersConfig(native),
  );

  // ===== Custom Commands =====
  ipcMain.handle("custom-commands:list", (_event, projectId: unknown) =>
    native.listCustomCommands(readOptionalProjectId(projectId)),
  );
  ipcMain.handle("custom-commands:upsert", async (_event, item: unknown) => {
    await native.upsertCustomCommand(normalizeCustomCommand(item));
  });
  ipcMain.handle(
    "custom-commands:delete",
    async (_event, commandId: unknown) => {
      if (typeof commandId !== "string" || !commandId.trim()) {
        throw new Error("Custom command id is required");
      }
      await native.deleteCustomCommand(commandId.trim());
    },
  );

  // ===== MCP Server Configs =====
  ipcMain.handle("mcp-server-configs:list", () =>
    native.listMcpServerConfigs(),
  );
  ipcMain.handle("mcp-server-configs:upsert", async (_event, item: unknown) => {
    await native.upsertMcpServerConfig(normalizeMcpServerConfig(item));
    return native.listMcpServerConfigs();
  });
  ipcMain.handle(
    "mcp-server-configs:delete",
    async (_event, serverId: unknown) => {
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("MCP server ID is required");
      }
      const normalizedServerId = serverId.trim();
      const existing = (await native.listMcpServerConfigs()).find(
        (item) => item.serverId === normalizedServerId,
      );
      if (existing?.source === "snow-cli") {
        deleteSnowCliMcpServerConfig(existing.name);
      }
      await native.deleteMcpServerConfig(normalizedServerId);
      return native.listMcpServerConfigs();
    },
  );
  ipcMain.handle("mcp-server-configs:import-snow-cli", () =>
    readSnowCliMcpConfig(native),
  );

  // ===== LSP Server Configs =====
  ipcMain.handle("lsp-server-configs:list", () =>
    native.listLspServerConfigs(),
  );
  ipcMain.handle("lsp-server-configs:upsert", async (_event, item: unknown) => {
    await native.upsertLspServerConfig(normalizeLspServerConfig(item));
    return native.listLspServerConfigs();
  });
  ipcMain.handle("lsp-server-configs:delete", async (_event, lang: unknown) => {
    if (typeof lang !== "string" || !lang.trim()) {
      throw new Error("Language is required");
    }
    await native.deleteLspServerConfig(lang.trim());
    return native.listLspServerConfigs();
  });
  ipcMain.handle(
    "project-lsp-server-configs:list",
    (_event, projectId: unknown) => {
      const normalizedProjectId = requireProjectId(projectId);
      return native.listProjectLspServerConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "project-lsp-server-configs:upsert",
    async (_event, projectId: unknown, item: unknown) => {
      const normalizedProjectId = requireProjectId(projectId);
      await native.upsertProjectLspServerConfig(
        normalizedProjectId,
        normalizeLspServerConfig(item),
      );
      // 返回 effective 合并视图（全局 + 项目覆盖），UI 直接刷新为项目生效配置。
      return native.listEffectiveLspServerConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "project-lsp-server-configs:delete",
    async (_event, projectId: unknown, lang: unknown) => {
      const normalizedProjectId = requireProjectId(projectId);
      if (typeof lang !== "string" || !lang.trim()) {
        throw new Error("Language is required");
      }
      await native.deleteProjectLspServerConfig(
        normalizedProjectId,
        lang.trim(),
      );
      // 返回 effective 合并视图（全局 + 项目覆盖），UI 直接刷新为项目生效配置。
      return native.listEffectiveLspServerConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "lsp-server-configs:effective:list",
    (_event, projectId: unknown) =>
      native.listEffectiveLspServerConfigs(
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined,
      ),
  );
  ipcMain.handle("lsp-server-configs:probe", (_event, projectId: unknown) =>
    native.probeLspServerCommands(
      typeof projectId === "string" && projectId.trim()
        ? projectId.trim()
        : undefined,
    ),
  );
  // 技术栈检测：扫描项目根目录（纯文件系统，无副作用）。
  ipcMain.handle("lsp-project-stack:detect", (_event, projectRoot: unknown) => {
    if (typeof projectRoot !== "string" || !projectRoot.trim()) {
      throw new Error("Project root is required");
    }
    return native.detectProjectStack(projectRoot.trim());
  });
  // 会话运行时状态快照：前端状态徽章轮询用（不触发会话创建/回收）。
  // 可选 projectId：传入时只返回该项目根下的会话（徽章按当前项目过滤）。
  ipcMain.handle("lsp-session-statuses:list", (_event, projectId: unknown) =>
    native.listLspSessionStatuses(
      typeof projectId === "string" && projectId.trim()
        ? projectId.trim()
        : undefined,
    ),
  );
  // 手动启动（预热）指定项目和语言的 LSP 会话
  ipcMain.handle(
    "lsp-session:start",
    (_event, projectId: unknown, lang: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project ID is required to start LSP session");
      }
      if (typeof lang !== "string" || !lang.trim()) {
        throw new Error("Language is required to start LSP session");
      }
      return native.startLspSession(projectId.trim(), lang.trim());
    },
  );
  // 手动停止指定项目和语言的 LSP 会话
  ipcMain.handle(
    "lsp-session:stop",
    (_event, projectId: unknown, lang: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project ID is required to stop LSP session");
      }
      if (typeof lang !== "string" || !lang.trim()) {
        throw new Error("Language is required to stop LSP session");
      }
      return native.stopLspSession(projectId.trim(), lang.trim());
    },
  );
  // 手动重启指定项目和语言的 LSP 会话，可选清空持久化诊断缓存
  ipcMain.handle(
    "lsp-session:restart",
    (_event, projectId: unknown, lang: unknown, clearCache: unknown) => {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new Error("Project ID is required to restart LSP session");
      }
      if (typeof lang !== "string" || !lang.trim()) {
        throw new Error("Language is required to restart LSP session");
      }
      return native.restartLspSession(
        projectId.trim(),
        lang.trim(),
        typeof clearCache === "boolean" ? clearCache : true,
      );
    },
  );
  // Exact physical-session management; never route to project-prefix APIs.
  ipcMain.handle(
    "lsp-session:manage-exact",
    async (_event, target: unknown, action: unknown) => {
      if (action !== "stop" && action !== "restart") {
        throw new Error("LSP action must be 'stop' or 'restart'");
      }
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new Error("LSP session target must be an object");
      }
      const raw = target as Record<string, unknown>;
      if (
        typeof raw.lang !== "string" ||
        !raw.lang.trim() ||
        raw.lang.includes("\0")
      ) {
        throw new Error("LSP target language is required");
      }
      if (
        typeof raw.projectRoot !== "string" ||
        !raw.projectRoot.trim() ||
        raw.projectRoot.includes("\0") ||
        !isAbsolute(raw.projectRoot) ||
        (process.platform === "win32"
          ? !win32.isAbsolute(raw.projectRoot) ||
            !/^(?:[a-z]:[\\/]|\\\\\?\\[a-z]:[\\/])/i.test(raw.projectRoot)
          : raw.projectRoot.startsWith("//"))
      ) {
        throw new Error("LSP target root must be a local absolute path");
      }
      if (
        typeof raw.expectedPid !== "number" ||
        !Number.isSafeInteger(raw.expectedPid) ||
        raw.expectedPid <= 0 ||
        raw.expectedPid > 0xffffffff ||
        typeof raw.expectedRestartCount !== "number" ||
        !Number.isSafeInteger(raw.expectedRestartCount) ||
        raw.expectedRestartCount < 0 ||
        raw.expectedRestartCount > 0xffffffff
      ) {
        throw new Error(
          "LSP target requires a positive PID and non-negative restart count (u32 integers)",
        );
      }
      const result = await native.manageLspSession(
        JSON.stringify({
          lang: raw.lang.trim(),
          projectRoot: raw.projectRoot,
          expectedPid: raw.expectedPid,
          expectedRestartCount: raw.expectedRestartCount,
        }),
        action,
      );
      if (action === "stop") return null;
      if (!result)
        throw new Error("LSP restart did not return a session status");
      return result;
    },
  );
  // 安装语言服务器：执行配置表中的 installCommand。
  // 兼容项目覆盖模式与全局继承模式，确保无论当前处于全局还是项目页签均能正确解析 installCommand；
  // 补充常用 bin PATH 环境变量提高跨平台包管理器执行兼容性；
  // 输出截断（32KB）防长安装日志撑爆内存。不设超时（全局安装可能耗时数分钟）。
  ipcMain.handle(
    "lsp-server-configs:install",
    async (_event, projectId: unknown, lang: unknown) => {
      if (typeof lang !== "string" || !lang.trim()) {
        throw new Error("Language is required");
      }
      const normalizedLang = lang.trim();
      const hasProjectId =
        typeof projectId === "string" && projectId.trim().length > 0;
      // 优先获取有效生效配置（若有 projectId 则包含项目级覆盖和全局继承项）
      const records = hasProjectId
        ? await native.listEffectiveLspServerConfigs(
            (projectId as string).trim(),
          )
        : await native.listLspServerConfigs();
      const record = records.find((item) => item.lang === normalizedLang);
      let installCommand = record?.installCommand?.trim();

      // 如果有效配置中未配 installCommand，项目模式下尝试回退全局配置兜底
      if (!installCommand && hasProjectId) {
        const globalRecords = await native.listLspServerConfigs();
        const globalRecord = globalRecords.find(
          (item) => item.lang === normalizedLang,
        );
        installCommand = globalRecord?.installCommand?.trim();
      }

      if (!installCommand) {
        throw new Error(
          `No install command configured for language "${normalizedLang}"`,
        );
      }

      // 补充常用环境变量 PATH，确保 pip、npm、cargo、brew 等命令在 GUI 进程中能够被正确调用
      const home = process.env.HOME || process.env.USERPROFILE || "";
      const pathSep = process.platform === "win32" ? ";" : ":";
      const extraPaths =
        process.platform === "win32"
          ? [
              process.env.APPDATA ? `${process.env.APPDATA}\\npm` : "",
              home ? `${home}\\.cargo\\bin` : "",
              home ? `${home}\\go\\bin` : "",
            ].filter(Boolean)
          : [
              home ? `${home}/.local/bin` : "",
              home ? `${home}/.npm-global/bin` : "",
              home ? `${home}/.cargo/bin` : "",
              home ? `${home}/go/bin` : "",
              "/usr/local/bin",
              "/opt/homebrew/bin",
              "/home/linuxbrew/.linuxbrew/bin",
            ].filter(Boolean);

      const currentPath = process.env.PATH || "";
      const pathSet = new Set(currentPath.split(pathSep).filter(Boolean));
      const neededPaths = extraPaths.filter((p) => !pathSet.has(p));
      const augmentedPath =
        neededPaths.length > 0
          ? `${currentPath}${pathSep}${neededPaths.join(pathSep)}`
          : currentPath;

      return await new Promise<{
        command: string;
        output: string;
        exitCode: number | null;
      }>((resolve, reject) => {
        const child = spawn(installCommand, {
          shell: true,
          windowsHide: true,
          env: {
            ...process.env,
            PATH: augmentedPath,
          },
        });
        let output = "";
        const append = (chunk: Buffer): void => {
          output += chunk.toString();
          if (output.length > 32 * 1024) {
            output = output.slice(-32 * 1024);
          }
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("error", (error) => reject(error));
        child.on("close", (code) =>
          resolve({ command: installCommand, output, exitCode: code }),
        );
      });
    },
  );
  ipcMain.handle("project-mcp-server-configs:list", (_event, projectId) => {
    const normalizedProjectId = requireProjectId(projectId);
    return native.listProjectMcpServerConfigs(normalizedProjectId);
  });
  ipcMain.handle(
    "project-mcp-server-configs:upsert",
    async (_event, projectId, item) => {
      const normalizedProjectId = requireProjectId(projectId);
      await native.upsertProjectMcpServerConfig(
        normalizedProjectId,
        normalizeProjectMcpServerConfig(item),
      );
      return native.listProjectMcpServerConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "project-mcp-server-configs:delete",
    async (_event, projectId, serverId) => {
      const normalizedProjectId = requireProjectId(projectId);
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("MCP server ID is required");
      }
      const normalizedServerId = serverId.trim();
      const existing = (
        await native.listProjectMcpServerConfigs(normalizedProjectId)
      ).find((item) => item.serverId === normalizedServerId);
      if (existing?.source === "snow-cli") {
        await deleteSnowCliProjectMcpServerConfig(
          native,
          normalizedProjectId,
          existing.name,
        );
      }
      await native.deleteProjectMcpServerConfig(
        normalizedProjectId,
        normalizedServerId,
      );
      return native.listProjectMcpServerConfigs(normalizedProjectId);
    },
  );

  // ===== Sub-agent Configs =====
  /** 可选字符串参数归一化：空白字符串一律视为未提供。 */
  const normalizeOptionalText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  ipcMain.handle("sub-agent-configs:list", (_event, projectId: unknown) =>
    native.listSubAgentConfigs(normalizeOptionalText(projectId)),
  );
  ipcMain.handle(
    "sub-agent-configs:get",
    async (_event, agentId: unknown, projectId: unknown) => {
      if (typeof agentId !== "string" || !agentId.trim()) {
        throw new Error("Agent ID is required to get sub-agent config");
      }
      return native.getSubAgentConfig(
        agentId.trim(),
        normalizeOptionalText(projectId),
      );
    },
  );
  ipcMain.handle(
    "sub-agent-configs:upsert",
    async (_event, projectId: unknown, item: unknown) => {
      const normalizedProjectId = normalizeOptionalText(projectId);
      const normalized = normalizeSubAgentConfig({
        ...(typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {}),
        projectId: normalizedProjectId,
      });
      const apiConfigs = await native.listApiConfigs();
      if (
        normalized.configProfile &&
        !apiConfigs.some(
          (config) => config.profileName === normalized.configProfile,
        )
      ) {
        throw new Error("Selected sub-agent API profile does not exist");
      }
      // toolsJson 的格式/通配符/保留名/项目内存在性由 Rust upsert 统一校验。
      await native.upsertSubAgentConfig(normalized);
      return native.listSubAgentConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "sub-agent-configs:delete",
    async (_event, agentId: unknown, projectId: unknown) => {
      if (typeof agentId !== "string" || !agentId.trim()) {
        throw new Error("Sub-agent ID is required");
      }

      const normalizedAgentId = agentId.trim();
      const normalizedProjectId = normalizeOptionalText(projectId);
      const existing = await native.listSubAgentConfigs(normalizedProjectId);
      if (
        existing.some(
          (item) => item.agentId === normalizedAgentId && item.builtin,
        )
      ) {
        throw new Error("Built-in sub-agents cannot be deleted");
      }

      await native.deleteSubAgentConfig(normalizedAgentId, normalizedProjectId);
      return native.listSubAgentConfigs(normalizedProjectId);
    },
  );

  // ===== Sensitive Command Configs =====
  ipcMain.handle("sensitive-command-configs:list", () =>
    native.listSensitiveCommandConfigs(),
  );
  ipcMain.handle(
    "sensitive-command-configs:upsert",
    async (_event, item: unknown) => {
      await native.upsertSensitiveCommandConfig(
        normalizeSensitiveCommandConfig(item),
      );
      return native.listSensitiveCommandConfigs();
    },
  );
  ipcMain.handle(
    "sensitive-command-configs:delete",
    async (_event, commandId: unknown) => {
      if (typeof commandId !== "string" || !commandId.trim()) {
        throw new Error("Sensitive command ID is required");
      }

      await native.deleteSensitiveCommandConfig(commandId.trim());
      return native.listSensitiveCommandConfigs();
    },
  );
  ipcMain.handle("sensitive-command-configs:import-snow-cli", () =>
    readSnowCliSensitiveCommandConfig(native),
  );
  ipcMain.handle("sensitive-command-configs:reset", async () => {
    await native.resetSensitiveCommandConfigs();
    return native.listSensitiveCommandConfigs();
  });

  ipcMain.handle(
    "project-sensitive-command-configs:list",
    (_event, projectId) => {
      const normalizedProjectId = requireProjectId(projectId);
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "project-sensitive-command-configs:set-enabled",
    async (_event, projectId, commandId, enabled) => {
      const normalizedProjectId = requireProjectId(projectId);
      if (typeof commandId !== "string" || !commandId.trim()) {
        throw new Error("Sensitive command ID is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Sensitive command enabled state must be a boolean");
      }

      await native.setProjectSensitiveCommandEnabled(
        normalizedProjectId,
        commandId.trim(),
        enabled,
      );
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "project-sensitive-command-configs:upsert",
    async (_event, projectId, item) => {
      const normalizedProjectId = requireProjectId(projectId);
      await native.upsertProjectSensitiveCommandConfig(
        normalizedProjectId,
        normalizeProjectSensitiveCommandConfig(item),
      );
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    },
  );
  ipcMain.handle(
    "project-sensitive-command-configs:delete",
    async (_event, projectId, commandId) => {
      const normalizedProjectId = requireProjectId(projectId);
      if (typeof commandId !== "string" || !commandId.trim()) {
        throw new Error("Sensitive command ID is required");
      }

      await native.deleteProjectSensitiveCommandConfig(
        normalizedProjectId,
        commandId.trim(),
      );
      return native.listProjectSensitiveCommandConfigs(normalizedProjectId);
    },
  );

  ipcMain.handle(
    "sensitive-command-configs:check-tool",
    async (
      _event,
      toolName: unknown,
      argsJson: unknown,
      projectId: unknown,
    ) => {
      if (typeof toolName !== "string" || !toolName.trim()) {
        return null;
      }
      return native.checkToolSensitiveOperation(
        toolName,
        typeof argsJson === "string" ? argsJson : "{}",
        normalizeOptionalText(projectId),
      );
    },
  );

  // 决策模型辅助：命中敏感规则时判定是否可直接放行（返回 null = 未启用 /
  // 未命中规则；决策模型不可用或请求失败时返回带 error 的记录，渲染层回退
  // 原有确认流程并提示原因）。workingDirectory 与 description 是风险判定的
  // 上下文：命令在哪个目录执行、模型自己的意图说明。matchedRules 是预检查
  // 已确认的命中项（含间接脚本内容与内置诊断），交给后端直接使用。
  ipcMain.handle(
    "sensitive-command-configs:evaluate-decision",
    (
      _event,
      command: unknown,
      projectId: unknown,
      workingDirectory: unknown,
      description: unknown,
      conversationContext: unknown,
      matchedRules: unknown,
    ) => {
      if (typeof command !== "string" || !command.trim()) {
        return Promise.resolve(null);
      }
      return native.evaluateSensitiveCommandDecision(
        // 原文下发：规则锚点与命中高亮都基于未裁剪的命令文本。
        command,
        normalizeOptionalText(projectId),
        normalizeOptionalText(workingDirectory),
        normalizeOptionalText(description),
        // 结构由 Rust 校验，非法时返回带 error 的记录（回退人工确认）；
        // 非字符串也序列化交给 Rust 判定，不静默丢弃。
        conversationContext === undefined || conversationContext === null
          ? undefined
          : typeof conversationContext === "string"
            ? conversationContext
            : JSON.stringify(conversationContext),
        typeof matchedRules === "string" ? matchedRules : undefined,
      );
    },
  );

  // 偏好学习：记录 / 计数 / 清空用户在敏感命令拦截提示中的选择。
  ipcMain.handle(
    "sensitive-command-feedback:record",
    (_event, feedbackJson: unknown) => {
      if (typeof feedbackJson !== "string" || !feedbackJson.trim()) {
        return Promise.resolve(false);
      }
      return native.recordSensitiveCommandFeedback(feedbackJson);
    },
  );
  ipcMain.handle("sensitive-command-feedback:count", () =>
    native.getSensitiveCommandFeedbackCount(),
  );
  ipcMain.handle("sensitive-command-feedback:clear", () =>
    native.clearSensitiveCommandFeedback(),
  );

  // 决策 / 嵌入 / 重排模型连接自检：配置页传入当前表单值（可未保存），
  // Rust 发送最小请求、持久化结果并把失败写入系统日志。
  ipcMain.handle("model-health:test-decision", (_event, input: unknown) => {
    const raw = readTestInput(input);
    return native.testDecisionModelConnection({
      id: readTestText(raw, "id"),
      baseUrl: readTestText(raw, "baseUrl"),
      baseUrlMode: readTestText(raw, "baseUrlMode"),
      provider: readTestText(raw, "provider"),
      apiKey: readTestText(raw, "apiKey"),
      model: readTestText(raw, "model"),
    });
  });
  ipcMain.handle("model-health:test-embedding", (_event, input: unknown) => {
    const raw = readTestInput(input);
    return native.testEmbeddingConnection({
      id: readTestText(raw, "id"),
      embeddingType: readTestText(raw, "embeddingType"),
      modelName: readTestText(raw, "modelName"),
      baseUrl: readTestText(raw, "baseUrl"),
      apiKey: readTestText(raw, "apiKey"),
      dimensions: readTestCount(raw, "dimensions"),
    });
  });
  ipcMain.handle("model-health:test-reranking", (_event, input: unknown) => {
    const raw = readTestInput(input);
    return native.testRerankingConnection({
      id: readTestText(raw, "id"),
      modelName: readTestText(raw, "modelName"),
      baseUrl: readTestText(raw, "baseUrl"),
      apiKey: readTestText(raw, "apiKey"),
    });
  });
  ipcMain.handle("model-health:get-snapshot", () =>
    native.getModelHealthSnapshot(),
  );

  // ===== 模型注册表（嵌入 / 重排 / 决策模型表） =====
  ipcMain.handle("model-registry:list-embedding", () =>
    native.listEmbeddingModels(),
  );
  ipcMain.handle(
    "model-registry:upsert-embedding",
    (_event, input: unknown) => {
      const raw = readModelInput(input);
      return native.upsertEmbeddingModel({
        id: readTestText(raw, "id"),
        name: readTestText(raw, "name"),
        embeddingType: readTestText(raw, "embeddingType"),
        modelName: readTestText(raw, "modelName"),
        baseUrl: readTestText(raw, "baseUrl"),
        apiKey: readTestText(raw, "apiKey"),
        dimensions: readTestCount(raw, "dimensions"),
        contextLength: readTestCount(raw, "contextLength"),
        enabled: readModelEnabled(raw),
      });
    },
  );
  ipcMain.handle("model-registry:list-reranking", () =>
    native.listRerankingModels(),
  );
  ipcMain.handle(
    "model-registry:upsert-reranking",
    (_event, input: unknown) => {
      const raw = readModelInput(input);
      return native.upsertRerankingModel({
        id: readTestText(raw, "id"),
        name: readTestText(raw, "name"),
        modelName: readTestText(raw, "modelName"),
        baseUrl: readTestText(raw, "baseUrl"),
        apiKey: readTestText(raw, "apiKey"),
        contextLength: readTestCount(raw, "contextLength"),
        enabled: readModelEnabled(raw),
      });
    },
  );
  ipcMain.handle("model-registry:list-decision", () =>
    native.listDecisionModels(),
  );
  ipcMain.handle("model-registry:upsert-decision", (_event, input: unknown) => {
    const raw = readModelInput(input);
    return native.upsertDecisionModel({
      id: readTestText(raw, "id"),
      name: readTestText(raw, "name"),
      provider: readTestText(raw, "provider"),
      baseUrl: readTestText(raw, "baseUrl"),
      baseUrlMode: readTestText(raw, "baseUrlMode"),
      model: readTestText(raw, "model"),
      apiKey: readTestText(raw, "apiKey"),
      enabled: readModelEnabled(raw),
    });
  });
  ipcMain.handle(
    "model-registry:delete",
    (_event, kind: unknown, modelId: unknown) =>
      native.deleteRegisteredModel(readModelKind(kind), readModelId(modelId)),
  );
  ipcMain.handle(
    "model-registry:set-enabled",
    (_event, kind: unknown, modelId: unknown, enabled: unknown) =>
      native.setRegisteredModelEnabled(
        readModelKind(kind),
        readModelId(modelId),
        enabled === true,
      ),
  );

  // ===== Hook Configs =====
  ipcMain.handle(
    "hook-configs:list",
    (_event, scope: unknown, projectId: unknown) => {
      if (
        typeof scope !== "string" ||
        (scope !== "global" && scope !== "project")
      ) {
        throw new Error("Hook scope must be 'global' or 'project'");
      }
      const normalizedProjectId =
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined;
      if (scope === "project" && !normalizedProjectId) {
        throw new Error("Project id is required for project scope hooks");
      }
      return native.listHookConfigs(scope, normalizedProjectId);
    },
  );
  ipcMain.handle("hook-configs:upsert", async (_event, item: unknown) => {
    await native.upsertHookConfig(normalizeHookConfig(item));
    return;
  });
  ipcMain.handle(
    "hook-configs:delete",
    async (_event, hookType: unknown, scope: unknown, projectId: unknown) => {
      if (typeof hookType !== "string" || !hookType.trim()) {
        throw new Error("Hook type is required");
      }
      if (
        typeof scope !== "string" ||
        (scope !== "global" && scope !== "project")
      ) {
        throw new Error("Hook scope must be 'global' or 'project'");
      }
      const normalizedProjectId =
        typeof projectId === "string" && projectId.trim()
          ? projectId.trim()
          : undefined;
      if (scope === "project" && !normalizedProjectId) {
        throw new Error("Project id is required for project scope hooks");
      }
      await native.deleteHookConfig(
        hookType.trim(),
        scope,
        normalizedProjectId,
      );
      return;
    },
  );

  ipcMain.handle("hooks:execute", async (_event, input: unknown) => {
    if (!input || typeof input !== "object") {
      throw new Error("Hook execute input must be an object");
    }
    const raw = input as Record<string, unknown>;
    const hookType =
      typeof raw.hookType === "string" ? raw.hookType.trim() : "";
    if (!hookType) {
      throw new Error("Hook type is required");
    }
    const projectId =
      typeof raw.projectId === "string" && raw.projectId.trim()
        ? raw.projectId.trim()
        : undefined;
    const contextJson =
      typeof raw.contextJson === "string" ? raw.contextJson : "{}";
    return native.executeHooks({ hookType, projectId, contextJson });
  });
};
