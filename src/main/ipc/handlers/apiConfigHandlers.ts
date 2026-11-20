import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import type {
  ApiModelsConfig,
  ModelConfigTransferKind,
  NativeBridge,
  ResponsesApiStreamChunk,
} from "../../native/types";
import {
  normalizeApiConfigInput,
  toApiConfigInput,
} from "../../settings/apiConfigs";
import { readSnowCliCodebaseSettings } from "../../settings/codebaseSettings";
import { readSnowCliProxyConfig } from "../../settings/proxyBrowserSettings";
import { readSnowCliProfiles } from "../../snowCli/profiles";
import { syncOAuthPlugins } from "../../oauthPlugins/oauthPluginHost";
import { safeSend } from "../../utils/safeSend";

/** 同名冲突处理策略：覆盖既有配置 / 另存为新副本。 */
const IMPORT_CONFLICT_STRATEGIES = ["overwrite", "duplicate"] as const;
type ImportConflictStrategy = (typeof IMPORT_CONFLICT_STRATEGIES)[number];

const isImportConflictStrategy = (
  value: unknown,
): value is ImportConflictStrategy =>
  typeof value === "string" &&
  IMPORT_CONFLICT_STRATEGIES.includes(value as ImportConflictStrategy);

/** 校验渲染层传来的待导出配置名列表，去重去空。 */
const normalizeExportProfileNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error("Profile names must be an array");
  }

  const names = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (names.length === 0) {
    throw new Error("At least one API profile must be selected to export");
  }

  return Array.from(new Set(names));
};

/** 校验渲染层传来的排序名单：非空字符串数组，去重去空。 */
const normalizeOrderedProfileNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error("Ordered profile names must be an array");
  }

  const names = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (names.length === 0) {
    throw new Error("At least one API profile is required for reordering");
  }

  return Array.from(new Set(names));
};

/** 读取导入文件文本；失败时抛出带上下文的错误。 */
const readImportFileContent = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read API config import file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/** 非 LLM 配置迁移类别（图像渠道 / 决策 / 嵌入 / 重排）。 */
const MODEL_TRANSFER_KINDS: readonly ModelConfigTransferKind[] = [
  "imagegen",
  "decision",
  "embedding",
  "reranking",
];

const readModelTransferKind = (value: unknown): ModelConfigTransferKind => {
  if (
    typeof value === "string" &&
    MODEL_TRANSFER_KINDS.includes(value as ModelConfigTransferKind)
  ) {
    return value as ModelConfigTransferKind;
  }
  throw new Error(`Unsupported config transfer kind: ${String(value)}`);
};

const normalizeExportIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error("Item ids must be an array");
  }
  const ids = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (ids.length === 0) {
    throw new Error("At least one item must be selected to export");
  }
  return Array.from(new Set(ids));
};

const pickWindowFor = (
  event: Electron.IpcMainInvokeEvent,
): BrowserWindow | null => BrowserWindow.fromWebContents(event.sender);

/** 校验渲染层传来的模型清单查询配置。 */
const normalizeApiModelsConfig = (value: unknown): ApiModelsConfig => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("API model config is required");
  }

  const source = value as Partial<Record<keyof ApiModelsConfig, unknown>>;
  return {
    baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "",
    baseUrlMode:
      typeof source.baseUrlMode === "string" ? source.baseUrlMode : "auto",
    apiKey: typeof source.apiKey === "string" ? source.apiKey : "",
    requestMethod:
      typeof source.requestMethod === "string" ? source.requestMethod : "chat",
    customHeaderSchemeId:
      typeof source.customHeaderSchemeId === "string"
        ? source.customHeaderSchemeId
        : "",
    // OAuth 渠道的 configJson 原样透传：Rust 据此识别 provider 并拉取订阅账号模型。
    configJson:
      typeof source.configJson === "string" && source.configJson.trim()
        ? source.configJson
        : undefined,
    profileName:
      typeof source.profileName === "string" && source.profileName.trim()
        ? source.profileName.trim()
        : undefined,
  };
};

export const registerApiConfigHandlers = (native: NativeBridge): void => {
  ipcMain.handle("api-configs:list", () => native.listApiConfigs());
  ipcMain.handle("api-configs:retry-defaults", () => native.getRetryDefaults());
  // OAuth 登录：Rust 侧负责 PKCE、本机回调监听与 token 交换，主进程只做参数校验。
  // 列表前先同步插件 provider，保证启停 / 安装插件后立即可见。
  ipcMain.handle("api-configs:oauth-providers", async () => {
    await syncOAuthPlugins();
    return native.listOAuthProviders();
  });
  ipcMain.handle(
    "api-configs:oauth-start",
    async (
      _event,
      provider: unknown,
      advancedModel: unknown,
      basicModel: unknown,
    ) => {
      if (typeof provider !== "string" || !provider.trim()) {
        throw new Error("OAuth provider is required");
      }
      return native.startOAuthLogin(
        provider.trim(),
        typeof advancedModel === "string" ? advancedModel : undefined,
        typeof basicModel === "string" ? basicModel : undefined,
      );
    },
  );
  ipcMain.handle(
    "api-configs:oauth-status",
    async (_event, sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("OAuth session id is required");
      }
      return native.getOAuthLoginStatus(sessionId.trim());
    },
  );
  ipcMain.handle(
    "api-configs:oauth-callback",
    async (_event, sessionId: unknown, callbackUrl: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("OAuth session id is required");
      }
      if (typeof callbackUrl !== "string" || !callbackUrl.trim()) {
        throw new Error("OAuth callback URL is required");
      }
      return native.submitOAuthCallback(sessionId.trim(), callbackUrl.trim());
    },
  );
  // 自定义面板自行完成登录后提交令牌集合。
  ipcMain.handle(
    "api-configs:oauth-submit-tokens",
    async (_event, sessionId: unknown, tokens: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("OAuth session id is required");
      }
      if (
        typeof tokens !== "object" ||
        tokens === null ||
        Array.isArray(tokens)
      ) {
        throw new Error("OAuth token set is required");
      }
      return native.submitOAuthLoginTokens(
        sessionId.trim(),
        JSON.stringify(tokens),
      );
    },
  );
  ipcMain.handle(
    "api-configs:oauth-cancel",
    async (_event, sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("OAuth session id is required");
      }
      return native.cancelOAuthLogin(sessionId.trim());
    },
  );
  ipcMain.handle(
    "api-configs:oauth-quota",
    async (_event, profileName: unknown) => {
      if (typeof profileName !== "string" || !profileName.trim()) {
        throw new Error("Profile name is required");
      }
      return native.getOAuthQuota(profileName.trim());
    },
  );
  ipcMain.handle("api-configs:upsert", async (_event, config: unknown) => {
    await native.upsertApiConfig(normalizeApiConfigInput(config));
    return native.listApiConfigs();
  });
  ipcMain.handle("api-configs:delete", async (_event, profileName: unknown) => {
    if (typeof profileName !== "string" || !profileName.trim()) {
      throw new Error("Profile name is required");
    }

    await native.deleteApiConfig(profileName.trim());
    return native.listApiConfigs();
  });
  ipcMain.handle(
    "api-configs:reorder",
    async (_event, orderedNames: unknown) => {
      await native.reorderApiConfigs(
        normalizeOrderedProfileNames(orderedNames),
      );
      return native.listApiConfigs();
    },
  );
  ipcMain.handle("api-configs:import-snow-cli", async () => {
    const profiles = readSnowCliProfiles();
    const existingConfigs = await native.listApiConfigs();
    const isFirstSync = !existingConfigs.some(
      (config) => config.source === "snow-cli",
    );

    if (isFirstSync) {
      // 首次同步：沿用 Snow CLI 的激活状态
      for (const profile of profiles) {
        await native.upsertApiConfig(toApiConfigInput(profile));
      }
    } else {
      // 增量同步：仅同步配置数据，保留应用内当前激活的 profile
      const activeProfileName =
        existingConfigs.find((config) => config.isActive)?.profileName ?? null;

      for (const profile of profiles) {
        const input = toApiConfigInput(profile);
        await native.upsertApiConfig({
          ...input,
          isActive: profile.name === activeProfileName,
        });
      }
    }

    return {
      importedCount: profiles.length,
      configs: await native.listApiConfigs(),
    };
  });

  // ===== 配置批量迁移（导出 / 导入）=====
  // Rust 负责迁移文档的构造、解析与落库；主进程只负责文件对话框与文件读写。
  ipcMain.handle(
    "api-configs:export-file",
    async (event, profileNames: unknown) => {
      const names = normalizeExportProfileNames(profileNames);
      const { content, exportedCount } = await native.exportApiConfigs(names);

      const options: Electron.SaveDialogOptions = {
        title: "Export API profiles",
        defaultPath: `snow-api-configs-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const result = browserWindow
        ? await dialog.showSaveDialog(browserWindow, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        return { canceled: true, filePath: "", exportedCount: 0 };
      }

      await writeFile(result.filePath, content, "utf-8");
      return { canceled: false, filePath: result.filePath, exportedCount };
    },
  );

  ipcMain.handle("api-configs:pick-import-file", async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: "Import API profiles",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const result = browserWindow
      ? await dialog.showOpenDialog(browserWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: "", preview: null };
    }

    const filePath = result.filePaths[0];
    const preview = await native.inspectApiConfigImport(
      await readImportFileContent(filePath),
    );
    return { canceled: false, filePath, preview };
  });

  ipcMain.handle(
    "api-configs:import-file",
    async (_event, filePath: unknown, conflictStrategy: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("Import file path is required");
      }
      if (!isImportConflictStrategy(conflictStrategy)) {
        throw new Error(
          `Unsupported API config import strategy: ${String(conflictStrategy)}`,
        );
      }

      const outcome = await native.importApiConfigs(
        await readImportFileContent(filePath.trim()),
        conflictStrategy,
      );

      return { outcome, configs: await native.listApiConfigs() };
    },
  );

  // 图像渠道 / 决策 / 嵌入 / 重排配置迁移：文档构造、冲突判定与落库都在 Rust。
  ipcMain.handle(
    "model-configs:export-file",
    async (event, kind: unknown, ids: unknown) => {
      const transferKind = readModelTransferKind(kind);
      const { content, exportedCount } = await native.exportModelConfigs(
        transferKind,
        normalizeExportIds(ids),
      );

      const options: Electron.SaveDialogOptions = {
        title: "Export configs",
        defaultPath: `snow-${transferKind}-configs-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const browserWindow = pickWindowFor(event);
      const result = browserWindow
        ? await dialog.showSaveDialog(browserWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { canceled: true, filePath: "", exportedCount: 0 };
      }

      await writeFile(result.filePath, content, "utf-8");
      return { canceled: false, filePath: result.filePath, exportedCount };
    },
  );

  ipcMain.handle(
    "model-configs:pick-import-file",
    async (event, kind: unknown) => {
      const transferKind = readModelTransferKind(kind);
      const options: Electron.OpenDialogOptions = {
        title: "Import configs",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const browserWindow = pickWindowFor(event);
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, filePath: "", preview: null };
      }

      const filePath = result.filePaths[0];
      const preview = await native.inspectModelConfigImport(
        transferKind,
        await readImportFileContent(filePath),
      );
      return { canceled: false, filePath, preview };
    },
  );

  ipcMain.handle(
    "model-configs:import-file",
    async (
      _event,
      kind: unknown,
      filePath: unknown,
      conflictStrategy: unknown,
    ) => {
      const transferKind = readModelTransferKind(kind);
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("Import file path is required");
      }
      if (!isImportConflictStrategy(conflictStrategy)) {
        throw new Error(
          `Unsupported import strategy: ${String(conflictStrategy)}`,
        );
      }
      return native.importModelConfigs(
        transferKind,
        await readImportFileContent(filePath.trim()),
        conflictStrategy,
      );
    },
  );

  ipcMain.handle("api-models:fetch", async () => {
    try {
      const models = await native.fetchAvailableModels();
      return models;
    } catch (error) {
      throw error;
    }
  });
  ipcMain.handle(
    "api-models:fetch-for-config",
    async (_event, config: unknown) =>
      native.fetchAvailableModelsForConfig(normalizeApiModelsConfig(config)),
  );

  // 解析模型上下文 / 输出上限：渠道模型清单优先，缺失部分由 Rust 查询公共规格源。
  ipcMain.handle(
    "api-models:resolve-limits",
    async (_event, config: unknown, modelId: unknown) => {
      const normalizedConfig = normalizeApiModelsConfig(config);
      if (typeof modelId !== "string" || !modelId.trim()) {
        return null;
      }
      return native.resolveModelLimitsForConfig(
        normalizedConfig,
        modelId.trim(),
      );
    },
  );

  // 切换模型后同步档案的上下文 / 输出上限；空模型名直接返回当前列表。
  ipcMain.handle(
    "api-configs:sync-model-limits",
    async (_event, profileName: unknown, modelId: unknown) => {
      if (typeof profileName !== "string" || !profileName.trim()) {
        throw new Error("API profile name is required");
      }
      if (typeof modelId !== "string" || !modelId.trim()) {
        return native.listApiConfigs();
      }
      return native.syncApiProfileModelLimits(
        profileName.trim(),
        modelId.trim(),
      );
    },
  );

  ipcMain.handle("proxy-browser-settings:import-snow-cli", () =>
    readSnowCliProxyConfig(native),
  );

  ipcMain.handle("codebase-settings:import-snow-cli", () =>
    readSnowCliCodebaseSettings(native),
  );

  // ===== AI theme palette generation =====
  ipcMain.handle(
    "theme:generate-palette",
    async (
      event,
      imagePath: unknown,
      profileName: unknown,
      streamId: unknown,
    ) => {
      if (typeof imagePath !== "string" || !imagePath.trim()) {
        throw new Error("Image path is required");
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Stream ID is required");
      }

      const normalizedStreamId = streamId.trim();
      const normalizedProfileName =
        typeof profileName === "string" ? profileName.trim() : "";

      return await native.generateThemePalette(
        imagePath.trim(),
        normalizedProfileName,
        (chunk: ResponsesApiStreamChunk) => {
          safeSend(event.sender, "theme:generate-palette:chunk", {
            streamId: normalizedStreamId,
            chunk,
          });
        },
        normalizedStreamId,
      );
    },
  );

  // ===== AI character card generation (IM chat style) =====
  ipcMain.handle(
    "theme:generate-character-card",
    async (
      event,
      imagePath: unknown,
      profileName: unknown,
      language: unknown,
      streamId: unknown,
    ) => {
      if (typeof imagePath !== "string" || !imagePath.trim()) {
        throw new Error("Image path is required");
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Stream ID is required");
      }

      const normalizedStreamId = streamId.trim();
      const normalizedProfileName =
        typeof profileName === "string" ? profileName.trim() : "";
      const normalizedLanguage =
        typeof language === "string" ? language.trim() : "";

      return await native.generateCharacterCard(
        imagePath.trim(),
        normalizedProfileName,
        normalizedLanguage,
        (chunk: ResponsesApiStreamChunk) => {
          safeSend(event.sender, "theme:generate-character-card:chunk", {
            streamId: normalizedStreamId,
            chunk,
          });
        },
        normalizedStreamId,
      );
    },
  );
};
